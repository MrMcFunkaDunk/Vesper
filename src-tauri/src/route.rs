use crate::esi::{self, ESI_BASE};
use crate::kills::{self, RawGateKill, SystemInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One leg of a route: ESI's own public pathfinder, no auth needed. `flag`
/// is one of "shortest" | "secure" | "insecure" (ESI's own vocabulary,
/// verified live against the endpoint - matches the Shortest/Secure/
/// Unsecure choice the gate-check UI offers). Systems in `avoid` are
/// excluded from consideration entirely, not just deprioritized.
async fn get_route(client: &reqwest::Client, origin: i64, destination: i64, avoid: &[i64], flag: &str) -> Result<Vec<i64>, String> {
    let mut query: Vec<(&str, String)> = vec![("flag", flag.to_string())];
    for &id in avoid {
        query.push(("avoid", id.to_string()));
    }

    let response = client
        .get(format!("{ESI_BASE}/route/{origin}/{destination}/"))
        .query(&query)
        .send()
        .await
        .map_err(|e| format!("ESI request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("ESI returned {status} planning a route from {origin} to {destination} - the two systems may not be connected (e.g. across a wormhole-only gap) or one may be unreachable while avoiding the requested systems"));
    }

    response.json::<Vec<i64>>().await.map_err(|e| format!("failed to parse ESI route response: {e}"))
}

/// Stitches together a route through every waypoint in order (A -> B -> C
/// becomes leg A->B followed by leg B->C), dropping each leg's duplicate
/// boundary system so the combined path doesn't repeat a system where two
/// legs meet.
async fn plan_route(client: &reqwest::Client, waypoints: &[i64], avoid: &[i64], flag: &str) -> Result<Vec<i64>, String> {
    if waypoints.len() < 2 {
        return Err("need at least two systems to plan a route".to_string());
    }

    let mut full_route: Vec<i64> = Vec::new();
    for pair in waypoints.windows(2) {
        let leg = get_route(client, pair[0], pair[1], avoid, flag).await?;
        if full_route.is_empty() {
            full_route.extend(leg);
        } else {
            full_route.extend(leg.into_iter().skip(1));
        }
    }
    Ok(full_route)
}

#[derive(Serialize)]
pub struct GateCheckSystem {
    pub id: i64,
    pub name: String,
    pub security: f64,
    pub region_name: String,
}

#[derive(Serialize)]
pub struct GateCheckResult {
    pub systems: Vec<GateCheckSystem>,
}

/// Plans the full route, then enriches every system on it with its name,
/// security status and region. Live kill/danger data is a separate call
/// (get_gate_activity) so the frontend can refresh that half independently.
pub async fn plan_gate_check(
    client: &reqwest::Client,
    waypoints: &[i64],
    avoid: &[i64],
    flag: &str,
) -> Result<GateCheckResult, String> {
    let route_ids = plan_route(client, waypoints, avoid, flag).await?;

    let names = esi::resolve_names(client, route_ids.clone()).await;
    let infos: Vec<Option<SystemInfo>> =
        futures::future::join_all(route_ids.iter().map(|&id| kills::fetch_system_info(client, id))).await;

    let systems = route_ids
        .into_iter()
        .zip(infos)
        .map(|(id, info)| {
            let info = info.unwrap_or(SystemInfo { security_status: 0.0, region_name: String::new() });
            GateCheckSystem {
                id,
                name: names.get(&id).cloned().unwrap_or_default(),
                security: info.security_status,
                region_name: info.region_name,
            }
        })
        .collect();

    Ok(GateCheckResult { systems })
}

// --- Gate-camp danger classification ---
//
// Every group id below was verified live against ESI/the SDE rather than
// guessed (see universe/groups/{id} and invTypes.csv), since a wrong id
// here would silently mislabel exactly the "is this safe" signal the
// whole feature exists for:
//   72         Smart Bomb
//   541, 894   Interdictor, Heavy Interdiction Cruiser
//   30, 485, 4594, 547, 659, 1538, 5120
//              Titan, Dreadnought, Lancer Dreadnought, Carrier,
//              Supercarrier, Force Auxiliary, Command Carrier
//   1657       Citadel (Astrahus/Fortizar/Keepstar family)
//   361        Mobile Warp Disruptor (an anchored bubble, not a ship)
const SMART_BOMB_GROUP: i64 = 72;
const INTERDICTOR_GROUPS: [i64; 2] = [541, 894];
const CAPITAL_GROUPS: [i64; 7] = [30, 485, 4594, 547, 659, 1538, 5120];
const CITADEL_GROUP: i64 = 1657;
const MOBILE_BUBBLE_GROUP: i64 = 361;

/// A kill's position is attributed to the nearest stargate if it's within
/// this many meters of it. Generous enough to cover a fight drifting off
/// the exact gate coordinates during a camp, tight enough that a kill from
/// somewhere else in the system (a belt, a station, deep space) isn't
/// misattributed - real inter-celestial distances in a system are normally
/// many orders of magnitude larger than this.
const GATE_PROXIMITY_METERS: f64 = 1_000_000.0;

#[derive(Deserialize)]
struct EsiTypeGroup {
    group_id: i64,
}

async fn fetch_type_group(client: &reqwest::Client, type_id: i64) -> Option<i64> {
    esi::public_get::<EsiTypeGroup>(client, &format!("/universe/types/{type_id}/")).await.ok().map(|t| t.group_id)
}

/// Resolves every unique type id's group in one concurrent batch - shared
/// across ship types (attacker and victim) and weapon types alike, since
/// they're all looked up the same way.
async fn resolve_type_groups(client: &reqwest::Client, type_ids: &[i64]) -> HashMap<i64, i64> {
    let mut unique = type_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    futures::future::join_all(unique.iter().map(|&id| async move { (id, fetch_type_group(client, id).await) }))
        .await
        .into_iter()
        .filter_map(|(id, group)| group.map(|g| (id, g)))
        .collect()
}

struct GateInfo {
    name: String,
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Deserialize)]
struct EsiSystemGates {
    #[serde(default)]
    stargates: Vec<i64>,
}

#[derive(Deserialize)]
struct EsiStargatePosition {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Deserialize)]
struct EsiStargate {
    name: String,
    position: EsiStargatePosition,
}

/// ESI names a stargate "Stargate (Destination)" - the destination system
/// name is exactly what a traveler wants to see ("the Poinen gate"), not
/// the word "Stargate" repeated for every row.
fn gate_display_name(raw: &str) -> String {
    raw.strip_prefix("Stargate (").and_then(|s| s.strip_suffix(')')).unwrap_or(raw).to_string()
}

async fn fetch_system_gates(client: &reqwest::Client, system_id: i64) -> Vec<GateInfo> {
    let Ok(system) = esi::public_get::<EsiSystemGates>(client, &format!("/universe/systems/{system_id}/")).await else {
        return Vec::new();
    };
    let gates = futures::future::join_all(system.stargates.iter().map(|&id| async move {
        let url = format!("/universe/stargates/{id}/");
        esi::public_get::<EsiStargate>(client, &url).await
    }))
    .await;
    gates
        .into_iter()
        .filter_map(Result::ok)
        .map(|g| GateInfo { name: gate_display_name(&g.name), x: g.position.x, y: g.position.y, z: g.position.z })
        .collect()
}

fn nearest_gate_name(position: (f64, f64, f64), gates: &[GateInfo]) -> Option<String> {
    let (px, py, pz) = position;
    gates
        .iter()
        .map(|g| {
            let dist = ((g.x - px).powi(2) + (g.y - py).powi(2) + (g.z - pz).powi(2)).sqrt();
            (g, dist)
        })
        .filter(|(_, dist)| *dist <= GATE_PROXIMITY_METERS)
        .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(g, _)| g.name.clone())
}

#[derive(Serialize)]
pub struct GateKillEvent {
    pub system_id: i64,
    pub time: String,
    /// None if the kill didn't happen near any stargate in the system (no
    /// position on the killmail, or too far from every gate to attribute).
    pub gate_name: Option<String>,
    pub smartbomb: bool,
    pub interdictor: bool,
    pub capital: bool,
    pub citadel: bool,
    pub mobile_bubble: bool,
}

/// The live danger half of a gate check: recent kills for every system on
/// the route, matched to whichever stargate they happened next to and
/// classified for the specific threats the legend calls out. Time
/// filtering ("last hour") is left to the frontend, same as everywhere
/// else kill data flows through this app.
pub async fn get_gate_activity(client: &reqwest::Client, system_ids: &[i64]) -> Vec<GateKillEvent> {
    let mut raw_by_system: Vec<(i64, RawGateKill)> = Vec::new();
    for &system_id in system_ids {
        if let Ok(kills) = kills::fetch_raw_gate_kills(client, system_id).await {
            raw_by_system.extend(kills.into_iter().map(|k| (system_id, k)));
        }
    }

    if raw_by_system.is_empty() {
        return Vec::new();
    }

    let mut systems_with_kills: Vec<i64> = raw_by_system.iter().map(|(id, _)| *id).collect();
    systems_with_kills.sort_unstable();
    systems_with_kills.dedup();
    let gates_by_system: HashMap<i64, Vec<GateInfo>> = HashMap::from_iter(
        futures::future::join_all(systems_with_kills.iter().map(|&id| async move { (id, fetch_system_gates(client, id).await) }))
            .await,
    );

    let mut all_type_ids: Vec<i64> = Vec::new();
    for (_, kill) in &raw_by_system {
        all_type_ids.extend(&kill.attacker_ship_type_ids);
        all_type_ids.extend(&kill.attacker_weapon_type_ids);
        all_type_ids.push(kill.victim_ship_type_id);
    }
    let type_groups = resolve_type_groups(client, &all_type_ids).await;

    raw_by_system
        .into_iter()
        .map(|(system_id, kill)| {
            let gates = gates_by_system.get(&system_id).map(Vec::as_slice).unwrap_or(&[]);
            let gate_name = kill.position.and_then(|p| nearest_gate_name(p, gates));

            let attacker_groups: Vec<i64> = kill
                .attacker_ship_type_ids
                .iter()
                .chain(kill.attacker_weapon_type_ids.iter())
                .filter_map(|id| type_groups.get(id).copied())
                .collect();
            let victim_group = type_groups.get(&kill.victim_ship_type_id).copied();

            GateKillEvent {
                system_id,
                time: kill.time,
                gate_name,
                smartbomb: attacker_groups.contains(&SMART_BOMB_GROUP),
                interdictor: attacker_groups.iter().any(|g| INTERDICTOR_GROUPS.contains(g)),
                capital: attacker_groups.iter().any(|g| CAPITAL_GROUPS.contains(g)),
                citadel: attacker_groups.contains(&CITADEL_GROUP),
                mobile_bubble: victim_group == Some(MOBILE_BUBBLE_GROUP),
            }
        })
        .collect()
}
