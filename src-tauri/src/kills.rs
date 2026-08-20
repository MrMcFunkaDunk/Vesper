use crate::esi::{self, ESI_BASE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const ZKILLBOARD_BASE: &str = "https://zkillboard.com/api";

/// zKillboard's own single-killmail lookup (`/killID/{id}/`) is a short-
/// lived cache that frequently misses even very recent kills - confirmed
/// live, including the single freshest kill in a busy system. But every
/// list endpoint (systemID or category) already returns the complete
/// killmail (attackers, victim, items, zkb metadata), so caching what a
/// kill list just fetched means a click-through never needs that flaky
/// lookup at all for anything the user could have actually clicked.
static KILL_CACHE: LazyLock<Mutex<HashMap<i64, ZkbKillmail>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) struct SystemInfo {
    pub(crate) security_status: f64,
    pub(crate) region_name: String,
}

#[derive(Deserialize)]
struct EsiSystem {
    security_status: f64,
    constellation_id: i64,
}

#[derive(Deserialize)]
struct EsiConstellation {
    region_id: i64,
}

#[derive(Deserialize)]
struct EsiRegion {
    name: String,
}

/// Security status and region aren't in the batched /universe/names/ lookup,
/// so a system's info takes its own three-hop chain (system -> constellation
/// -> region). Best-effort: any failed hop just leaves the kill without this
/// extra context rather than failing the whole feed.
pub(crate) async fn fetch_system_info(client: &reqwest::Client, system_id: i64) -> Option<SystemInfo> {
    let system: EsiSystem = esi::public_get(client, &format!("/universe/systems/{system_id}/")).await.ok()?;
    let constellation: EsiConstellation =
        esi::public_get(client, &format!("/universe/constellations/{}/", system.constellation_id)).await.ok()?;
    let region: EsiRegion =
        esi::public_get(client, &format!("/universe/regions/{}/", constellation.region_id)).await.ok()?;
    Some(SystemInfo { security_status: system.security_status, region_name: region.name })
}

#[derive(Deserialize)]
struct EsiTypeInfo {
    group_id: i64,
}

#[derive(Deserialize)]
struct EsiGroupInfo {
    category_id: i64,
}

/// EVE's "Charge" category (ammo, crystals, scripts, etc). Fixed, stable id.
const CHARGE_CATEGORY_ID: i64 = 8;

/// Whether an item type is a charge (ammo/crystal/script) rather than a
/// fitted module. A killmail records a turret's loaded charge at the same
/// flag as the turret itself, and quantity alone doesn't reliably tell them
/// apart (frequency crystals sit at qty 1, same as the module), so this
/// checks the type's real category via its group. Best-effort: a failed
/// lookup falls back to treating it as a module.
async fn fetch_is_charge(client: &reqwest::Client, type_id: i64) -> (i64, bool) {
    let is_charge = async {
        let type_info: EsiTypeInfo = esi::public_get(client, &format!("/universe/types/{type_id}/")).await.ok()?;
        let group_info: EsiGroupInfo =
            esi::public_get(client, &format!("/universe/groups/{}/", type_info.group_id)).await.ok()?;
        Some(group_info.category_id == CHARGE_CATEGORY_ID)
    }
    .await
    .unwrap_or(false);
    (type_id, is_charge)
}

/// Classifies every unique item type on a killmail as charge or module,
/// fetched concurrently since it's a 2-hop ESI lookup per type.
async fn classify_charges(client: &reqwest::Client, type_ids: &[i64]) -> HashMap<i64, bool> {
    let mut unique = type_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    futures::future::join_all(unique.iter().map(|&id| fetch_is_charge(client, id))).await.into_iter().collect()
}

/// zKillboard mirrors the full ESI killmail shape (attackers/victim/items/
/// etc.) alongside its own "zkb" metadata (value, labels), so a kill's
/// details come entirely from this one call - no separate ESI killmail
/// lookup needed, just name resolution for the IDs it returns. Used for
/// both the list endpoint and the single-killmail detail endpoint, which
/// return the same shape.
#[derive(Deserialize, Clone)]
struct ZkbKillmail {
    killmail_id: i64,
    killmail_time: String,
    solar_system_id: i64,
    #[serde(default)]
    attackers: Vec<ZkbAttacker>,
    victim: ZkbVictim,
    #[serde(default)]
    zkb: ZkbMeta,
}

#[derive(Deserialize, Clone)]
struct ZkbAttacker {
    character_id: Option<i64>,
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
    ship_type_id: Option<i64>,
    #[serde(default)]
    weapon_type_id: Option<i64>,
    #[serde(default)]
    damage_done: i64,
    #[serde(default)]
    final_blow: bool,
}

#[derive(Deserialize, Clone)]
struct ZkbPosition {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Deserialize, Clone)]
struct ZkbVictim {
    character_id: Option<i64>,
    corporation_id: Option<i64>,
    alliance_id: Option<i64>,
    ship_type_id: i64,
    #[serde(default)]
    damage_taken: i64,
    #[serde(default)]
    items: Vec<ZkbItem>,
    #[serde(default)]
    position: Option<ZkbPosition>,
}

#[derive(Deserialize, Clone)]
struct ZkbItem {
    item_type_id: i64,
    #[serde(default)]
    flag: i32,
    #[serde(default)]
    quantity_destroyed: i64,
    #[serde(default)]
    quantity_dropped: i64,
}

#[derive(Deserialize, Clone, Default)]
struct ZkbMeta {
    #[serde(rename = "totalValue", default)]
    total_value: f64,
    #[serde(rename = "destroyedValue", default)]
    destroyed_value: f64,
    #[serde(rename = "droppedValue", default)]
    dropped_value: f64,
    #[serde(default)]
    npc: bool,
    #[serde(default)]
    solo: bool,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    points: i64,
    /// The structure/station/stargate item id nearest the kill - zKillboard
    /// always includes this (verified live: for a kill fought at a
    /// stargate this is exactly that gate's ESI stargate_id, and
    /// zKillboard's own `/kills/locationID/{id}/` modifier accepts it
    /// directly), so tracking "kills at this gate" is just reusing the
    /// existing area-kills fetch with this id, no distance math needed.
    #[serde(rename = "locationID", default)]
    location_id: i64,
}

/// Maps a killmail item's inventory `flag` to the slot group the fit-wheel
/// renders it in. These flag ranges are fixed EVE inventory-position ids
/// (unrelated to the SDE), stable since forever: HiSlot0-7 = 27-34,
/// MedSlot0-7 = 19-26, LoSlot0-7 = 11-18, RigSlot0-7 = 92-99,
/// SubSystemSlot0-7 = 125-132 (folded into "rig" for wheel layout since
/// T3 cruisers are rare enough not to warrant a sixth arc), DroneBay = 87,
/// Cargo = 5. Everything else (fuel bay, ore hold, etc.) is just "other".
fn slot_group(flag: i32) -> &'static str {
    match flag {
        27..=34 => "high",
        19..=26 => "mid",
        11..=18 => "low",
        92..=99 | 125..=132 => "rig",
        87 => "drone",
        5 => "cargo",
        _ => "other",
    }
}

#[derive(Serialize, Clone)]
pub struct KillEntry {
    pub killmail_id: i64,
    pub time: String,
    pub system_id: i64,
    pub system_name: String,
    pub system_security: Option<f64>,
    pub region_name: Option<String>,
    /// The structure/station/stargate id nearest the kill - see ZkbMeta::location_id.
    pub location_id: i64,
    pub victim_character_id: Option<i64>,
    pub victim_character_name: Option<String>,
    pub victim_corporation_id: Option<i64>,
    pub victim_corporation_name: Option<String>,
    pub victim_alliance_id: Option<i64>,
    pub victim_alliance_name: Option<String>,
    pub ship_type_id: i64,
    pub ship_type_name: String,
    pub total_value: f64,
    pub npc: bool,
    pub solo: bool,
    pub attacker_count: usize,
    pub final_blow_character_id: Option<i64>,
    pub final_blow_character_name: Option<String>,
    pub final_blow_corporation_id: Option<i64>,
    pub final_blow_corporation_name: Option<String>,
    pub final_blow_alliance_id: Option<i64>,
    pub final_blow_alliance_name: Option<String>,
}

/// Kills for one watched system, most recent first, capped so a busy hub
/// system doesn't drag a huge history (and a huge name-resolution batch)
/// into what's meant to be a "recent activity" feed.
const KILLS_PER_SYSTEM: usize = 25;

async fn fetch_system_kills(client: &reqwest::Client, system_id: i64) -> Result<Vec<ZkbKillmail>, String> {
    let url = format!("{ZKILLBOARD_BASE}/kills/systemID/{system_id}/");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for system {system_id}"));
    }

    let mut kills: Vec<ZkbKillmail> = response
        .json()
        .await
        .map_err(|e| format!("failed to parse zKillboard response: {e}"))?;
    kills.truncate(KILLS_PER_SYSTEM);
    Ok(kills)
}

/// Fetches recent kills for every watched system (sequentially - zKillboard
/// asks callers not to hammer their server), then hands off to enrich_kills.
/// A single system's fetch failing (a wormhole with no data, a transient
/// blip) just skips that system rather than discarding the whole batch -
/// with a long enough system_ids list this used to mean one bad system
/// could wipe out every other tracked system's kills too.
pub async fn fetch_recent_kills(client: &reqwest::Client, system_ids: &[i64]) -> Result<Vec<KillEntry>, String> {
    let mut raw: Vec<ZkbKillmail> = Vec::new();
    for &system_id in system_ids {
        if let Ok(kills) = fetch_system_kills(client, system_id).await {
            raw.extend(kills);
        }
    }
    Ok(enrich_kills(client, raw).await)
}

async fn fetch_system_kills_page(client: &reqwest::Client, system_id: i64, page: i64) -> Result<Vec<ZkbKillmail>, String> {
    let url = if page > 1 {
        format!("{ZKILLBOARD_BASE}/kills/systemID/{system_id}/page/{page}/")
    } else {
        format!("{ZKILLBOARD_BASE}/kills/systemID/{system_id}/")
    };
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for system {system_id}"));
    }

    response.json().await.map_err(|e| format!("failed to parse zKillboard response: {e}"))
}

/// A single system's own killboard history, one real zKillboard page (200
/// killmails) at a time - distinct from fetch_recent_kills above, which
/// stays capped at KILLS_PER_SYSTEM for the live Tracked Systems watchlist
/// (a "what's happening now across everything I'm watching" merge, not a
/// history browser). This is what backs the dedicated per-system killboard
/// page, matching zKillboard's own system pages paging back through full
/// history rather than stopping after the first ~25 rows.
pub async fn fetch_system_kills_history(client: &reqwest::Client, system_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_system_kills_page(client, system_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

/// Days since 1970-01-01 for a proleptic Gregorian (y, m, d) - Howard
/// Hinnant's well-known constant-time civil-calendar algorithm. Used only to
/// turn a killmail_time string into a comparable Unix timestamp without
/// pulling in a date/time crate for one comparison (Cargo.toml's tokio
/// dependency has no calendar-math feature enabled, and nothing else in
/// this project needs one).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses zKillboard/ESI's fixed-width "YYYY-MM-DDTHH:MM:SSZ" timestamp
/// format into Unix seconds - shared beyond this module (e.g. wars.rs's
/// war `finished` dates use the exact same ESI timestamp format).
pub(crate) fn parse_iso_unix(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + min * 60 + sec)
}

const KILL_HISTORY_WINDOW_SECS: i64 = 48 * 3600;
/// Safety cap on how many zKillboard pages (200 killmails each) one 48h
/// history fetch will page through - stops a system with years of history
/// from being paged back through entirely just because it's currently very
/// busy. Systems that hit this cap show a partial (undercounted) graph
/// rather than the fetch hanging or erroring.
const KILL_HISTORY_PAGE_CAP: i64 = 8;

#[derive(Serialize, Clone)]
pub struct KillHistoryPoint {
    pub time: String,
    pub npc: bool,
    pub ship_type_id: i64,
}

/// Real 48h kill history for the Stats popup's activity graphs, paging back
/// through zKillboard's actual per-system history - unlike the live ESI 1h
/// snapshot used elsewhere, this has genuine retroactive depth so a graph
/// is immediately meaningful the first time a system's popup is opened, no
/// waiting required (contrast with jumps, which have no historical source
/// at all - see map::run_jump_history_sampler). Skips enrich_kills entirely
/// since the graphs only bucket by hour and classify ship/npc/pod, not the
/// full name-resolved detail a kill list needs.
pub async fn fetch_system_kill_history_48h(client: &reqwest::Client, system_id: i64) -> Result<Vec<KillHistoryPoint>, String> {
    let cutoff = now_unix() - KILL_HISTORY_WINDOW_SECS;
    let mut points = Vec::new();
    for page in 1..=KILL_HISTORY_PAGE_CAP {
        let raw = match fetch_system_kills_page(client, system_id, page).await {
            Ok(raw) => raw,
            Err(e) if page == 1 => return Err(e),
            Err(_) => break,
        };
        if raw.is_empty() {
            break;
        }
        let page_len = raw.len();
        let mut hit_cutoff = false;
        for kill in raw {
            let Some(t) = parse_iso_unix(&kill.killmail_time) else { continue };
            if t < cutoff {
                hit_cutoff = true;
                continue;
            }
            points.push(KillHistoryPoint { time: kill.killmail_time, npc: kill.zkb.npc, ship_type_id: kill.victim.ship_type_id });
        }
        if hit_cutoff || page_len < 200 {
            break;
        }
    }
    Ok(points)
}

/// A constellation or region covers many systems, so the feed is naturally
/// busier than one system's - a slightly larger cap than KILLS_PER_SYSTEM
/// keeps the drill-down killboard meaningful without pulling an unbounded
/// history through name resolution.
const KILLS_PER_AREA: usize = 60;

/// Raw fetch, one zKillboard page (200 killmails) at a time - no truncation
/// here, since callers decide for themselves whether they want the full
/// page (a dedicated, user-paginated Kills/Losses tab) or just a capped
/// slice of page 1 (a live "recent activity" feed like constellation/
/// region/location, which was never meant to page back through history).
async fn fetch_area_kills_kind(client: &reqwest::Client, kind: &str, modifier: &str, id: i64, page: i64) -> Result<Vec<ZkbKillmail>, String> {
    let url = if page > 1 {
        format!("{ZKILLBOARD_BASE}/{kind}/{modifier}/{id}/page/{page}/")
    } else {
        format!("{ZKILLBOARD_BASE}/{kind}/{modifier}/{id}/")
    };
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for {modifier} {id}"));
    }

    response.json().await.map_err(|e| format!("failed to parse zKillboard response: {e}"))
}

/// Page-1-only, capped to KILLS_PER_AREA - for the live "recent activity"
/// feeds (constellation/region/location) that were never meant to page back
/// through full history, unlike the dedicated per-entity Kills/Losses tabs.
async fn fetch_area_kills(client: &reqwest::Client, modifier: &str, id: i64) -> Result<Vec<ZkbKillmail>, String> {
    let mut kills = fetch_area_kills_kind(client, "kills", modifier, id, 1).await?;
    kills.truncate(KILLS_PER_AREA);
    Ok(kills)
}

/// Every recent kill anywhere in a constellation in one zKillboard call -
/// far cheaper than fetching each member system separately and merging
/// client-side, and it's exactly the modifier zKillboard's own site uses
/// for a constellation's killboard page.
pub async fn fetch_constellation_kills(client: &reqwest::Client, constellation_id: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills(client, "constellationID", constellation_id).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same as fetch_constellation_kills, scoped to a whole region.
pub async fn fetch_region_kills(client: &reqwest::Client, region_id: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills(client, "regionID", region_id).await?;
    Ok(enrich_kills(client, raw).await)
}

/// A constellation's own killboard history, one real zKillboard page at a
/// time - distinct from fetch_constellation_kills above, which stays capped
/// for the live Tracked Systems watchlist. Backs the dedicated constellation
/// killboard page's full-history pagination, same reasoning as
/// fetch_system_kills_history.
pub async fn fetch_constellation_kills_history(client: &reqwest::Client, constellation_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "kills", "constellationID", constellation_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same as fetch_constellation_kills_history, scoped to a whole region.
pub async fn fetch_region_kills_history(client: &reqwest::Client, region_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "kills", "regionID", region_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same shape again, scoped to a corporation, one zKillboard page (200
/// killmails) at a time - zKillboard's corporationID modifier follows the
/// exact same "every recent kill this entity was involved in" contract as
/// constellation/region, but this is the dedicated Kills tab's full-history
/// fetch, not the capped area feed above.
pub async fn fetch_corporation_kills(client: &reqwest::Client, corporation_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "kills", "corporationID", corporation_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same shape again, scoped to an alliance.
pub async fn fetch_alliance_kills(client: &reqwest::Client, alliance_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "kills", "allianceID", alliance_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// A corporation's own losses (its members as victims) - zKillboard exposes
/// this as a genuinely distinct "/losses/" path prefix, not a client-side
/// filter of the mixed kills feed above, verified live: "/losses/
/// corporationID/{id}/" returns only killmails where the corp is the
/// victim's corporation, the same real separation fetch_character_losses
/// already relies on for characters.
pub async fn fetch_corporation_losses(client: &reqwest::Client, corporation_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "losses", "corporationID", corporation_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same as fetch_corporation_losses, scoped to an alliance.
pub async fn fetch_alliance_losses(client: &reqwest::Client, alliance_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills_kind(client, "losses", "allianceID", alliance_id, page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Kills at one specific location (stargate/station/structure item id) -
/// backs "track this gate": zKillboard's own locationID kills modifier,
/// verified against real data to match exactly the stargate ids ESI
/// hands out (see KillDetail::location_id), so no distance computation
/// is needed here at all, unlike the single-killmail nearest-gate lookup.
pub async fn fetch_location_kills(client: &reqwest::Client, location_id: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_area_kills(client, "locationID", location_id).await?;
    Ok(enrich_kills(client, raw).await)
}

/// A trimmed-down view of a killmail with exactly what gate-camp analysis
/// needs (position to match against a stargate, ship/weapon type ids to
/// classify as smartbomb/interdictor/capital/citadel/bubble) - deliberately
/// not the full KillEntry shape, since this is only ever consumed by the
/// route module's classification logic, never rendered directly.
pub(crate) struct RawGateKill {
    pub(crate) time: String,
    pub(crate) position: Option<(f64, f64, f64)>,
    pub(crate) attacker_ship_type_ids: Vec<i64>,
    pub(crate) attacker_weapon_type_ids: Vec<i64>,
    pub(crate) victim_ship_type_id: i64,
}

/// Same source as fetch_recent_kills (one system's recent kills from
/// zKillboard) but without the name-resolution/enrichment pass, since gate
/// analysis only needs positions and type ids, not display strings.
pub(crate) async fn fetch_raw_gate_kills(client: &reqwest::Client, system_id: i64) -> Result<Vec<RawGateKill>, String> {
    let kills = fetch_system_kills(client, system_id).await?;
    Ok(kills
        .into_iter()
        .map(|k| RawGateKill {
            time: k.killmail_time,
            position: k.victim.position.map(|p| (p.x, p.y, p.z)),
            attacker_ship_type_ids: k.attackers.iter().filter_map(|a| a.ship_type_id).collect(),
            attacker_weapon_type_ids: k.attackers.iter().filter_map(|a| a.weapon_type_id).collect(),
            victim_ship_type_id: k.victim.ship_type_id,
        })
        .collect())
}

/// zKillboard paginates every kills/losses list at 200 killmails per page
/// (verified live: page 2 returns genuinely older kills, and the first page
/// past an entity's actual history returns an empty array rather than an
/// error) - trusting that page size instead of an arbitrary smaller cap
/// means a character/corp/alliance's full history is reachable the same way
/// zKillboard's own site pages through it, not silently cut off after the
/// first ~50 rows.
async fn fetch_character_kills_raw(client: &reqwest::Client, character_id: i64, kind: &str, page: i64) -> Result<Vec<ZkbKillmail>, String> {
    let url = if page > 1 {
        format!("{ZKILLBOARD_BASE}/{kind}/characterID/{character_id}/page/{page}/")
    } else {
        format!("{ZKILLBOARD_BASE}/{kind}/characterID/{character_id}/")
    };
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for character {character_id}"));
    }

    response.json().await.map_err(|e| format!("failed to parse zKillboard response: {e}"))
}

/// A character's own kills, one zKillboard page (200 killmails) at a time -
/// a personal killboard, not scoped to any watchlist. This is a lookup/
/// history view rather than a live monitor, so zKillboard's up-to-an-hour
/// CDN cache on this endpoint (same as the system/category ones) isn't a
/// real problem here the way it was for the "Most Recent Kills" feed.
pub async fn fetch_character_kills(client: &reqwest::Client, character_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_character_kills_raw(client, character_id, "kills", page).await?;
    Ok(enrich_kills(client, raw).await)
}

/// Same as fetch_character_kills but for the character's own losses.
pub async fn fetch_character_losses(client: &reqwest::Client, character_id: i64, page: i64) -> Result<Vec<KillEntry>, String> {
    let raw = fetch_character_kills_raw(client, character_id, "losses", page).await?;
    Ok(enrich_kills(client, raw).await)
}

#[derive(Deserialize)]
struct EsiPublicCharacter {
    name: String,
    corporation_id: i64,
    #[serde(default)]
    alliance_id: Option<i64>,
    #[serde(default)]
    security_status: Option<f64>,
    #[serde(default)]
    birthday: String,
}

#[derive(Deserialize)]
struct EsiCorporationTicker {
    ticker: String,
}

#[derive(Deserialize)]
struct EsiAllianceTicker {
    ticker: String,
}

#[derive(Serialize)]
pub struct CharacterProfile {
    pub character_id: i64,
    pub character_name: String,
    pub corporation_id: i64,
    pub corporation_name: Option<String>,
    pub corporation_ticker: Option<String>,
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub alliance_ticker: Option<String>,
    pub security_status: Option<f64>,
    pub birthday: String,
}

/// Public character info (no auth needed) for the header of a personal
/// killboard page - works for any character, not just the ones logged in.
pub async fn fetch_character_profile(client: &reqwest::Client, character_id: i64) -> Result<CharacterProfile, String> {
    let info: EsiPublicCharacter = esi::public_get(client, &format!("/characters/{character_id}/")).await?;

    let mut lookup_ids = vec![info.corporation_id];
    if let Some(id) = info.alliance_id {
        lookup_ids.push(id);
    }
    let names = esi::resolve_names(client, lookup_ids).await;

    let corporation_ticker = esi::public_get::<EsiCorporationTicker>(client, &format!("/corporations/{}/", info.corporation_id))
        .await
        .ok()
        .map(|c| c.ticker);
    let alliance_ticker = match info.alliance_id {
        Some(id) => esi::public_get::<EsiAllianceTicker>(client, &format!("/alliances/{id}/")).await.ok().map(|a| a.ticker),
        None => None,
    };

    Ok(CharacterProfile {
        character_id,
        character_name: info.name,
        corporation_id: info.corporation_id,
        corporation_name: names.get(&info.corporation_id).cloned(),
        corporation_ticker,
        alliance_id: info.alliance_id,
        alliance_name: info.alliance_id.and_then(|id| names.get(&id).cloned()),
        alliance_ticker,
        security_status: info.security_status,
        birthday: info.birthday,
    })
}

#[derive(Deserialize)]
struct EsiCorporationInfo {
    name: String,
    ticker: String,
    #[serde(default)]
    alliance_id: Option<i64>,
    #[serde(default)]
    member_count: i64,
    #[serde(default)]
    date_founded: Option<String>,
    #[serde(default)]
    ceo_id: Option<i64>,
    #[serde(default)]
    creator_id: Option<i64>,
    #[serde(default)]
    tax_rate: f64,
    #[serde(default)]
    war_eligible: bool,
    #[serde(default)]
    home_station_id: Option<i64>,
}

#[derive(Serialize)]
pub struct CorporationProfile {
    pub corporation_id: i64,
    pub corporation_name: String,
    pub corporation_ticker: String,
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub alliance_ticker: Option<String>,
    pub member_count: i64,
    pub date_founded: Option<String>,
    pub ceo_id: Option<i64>,
    pub ceo_name: Option<String>,
    pub founder_id: Option<i64>,
    pub founder_name: Option<String>,
    pub tax_rate: f64,
    pub war_eligible: bool,
    pub home_station_id: Option<i64>,
    pub home_station_name: Option<String>,
}

/// Public corporation info (no auth needed) for the header of a
/// corporation killboard page, mirroring fetch_character_profile. Every
/// extra field here (tax_rate/war_eligible/home_station_id/creator_id) is a
/// real, verified field on ESI's public /corporations/{id}/ response - "war
/// eligible" is the closest ESI gets to war info, since the actual wars-list
/// endpoint CCP used to expose has been removed from the API entirely.
pub async fn fetch_corporation_profile(client: &reqwest::Client, corporation_id: i64) -> Result<CorporationProfile, String> {
    let info: EsiCorporationInfo = esi::public_get(client, &format!("/corporations/{corporation_id}/")).await?;

    let mut lookup_ids = Vec::new();
    if let Some(id) = info.ceo_id {
        lookup_ids.push(id);
    }
    if let Some(id) = info.creator_id {
        lookup_ids.push(id);
    }
    if let Some(id) = info.alliance_id {
        lookup_ids.push(id);
    }
    if let Some(id) = info.home_station_id {
        lookup_ids.push(id);
    }
    let names = esi::resolve_names(client, lookup_ids).await;

    let alliance_ticker = match info.alliance_id {
        Some(id) => esi::public_get::<EsiAllianceTicker>(client, &format!("/alliances/{id}/")).await.ok().map(|a| a.ticker),
        None => None,
    };

    Ok(CorporationProfile {
        corporation_id,
        corporation_name: info.name,
        corporation_ticker: info.ticker,
        alliance_id: info.alliance_id,
        alliance_name: info.alliance_id.and_then(|id| names.get(&id).cloned()),
        alliance_ticker,
        member_count: info.member_count,
        date_founded: info.date_founded,
        ceo_id: info.ceo_id,
        ceo_name: info.ceo_id.and_then(|id| names.get(&id).cloned()),
        founder_id: info.creator_id,
        founder_name: info.creator_id.and_then(|id| names.get(&id).cloned()),
        tax_rate: info.tax_rate,
        war_eligible: info.war_eligible,
        home_station_id: info.home_station_id,
        home_station_name: info.home_station_id.and_then(|id| names.get(&id).cloned()),
    })
}

#[derive(Deserialize)]
struct EsiAllianceInfo {
    name: String,
    ticker: String,
    #[serde(default)]
    date_founded: Option<String>,
    #[serde(default)]
    executor_corporation_id: Option<i64>,
    #[serde(default)]
    creator_id: Option<i64>,
}

#[derive(Serialize)]
pub struct AllianceProfile {
    pub alliance_id: i64,
    pub alliance_name: String,
    pub alliance_ticker: String,
    pub date_founded: Option<String>,
    pub executor_corporation_id: Option<i64>,
    pub executor_corporation_name: Option<String>,
    pub founder_id: Option<i64>,
    pub founder_name: Option<String>,
}

/// Public alliance info (no auth needed) for the header of an alliance
/// killboard page, mirroring fetch_character_profile. Alliances have no
/// tax_rate/home_station/war_eligible of their own on ESI (those are
/// corp-level fields) - only the executor corp and founder are available.
pub async fn fetch_alliance_profile(client: &reqwest::Client, alliance_id: i64) -> Result<AllianceProfile, String> {
    let info: EsiAllianceInfo = esi::public_get(client, &format!("/alliances/{alliance_id}/")).await?;

    let mut lookup_ids = Vec::new();
    if let Some(id) = info.executor_corporation_id {
        lookup_ids.push(id);
    }
    if let Some(id) = info.creator_id {
        lookup_ids.push(id);
    }
    let names = esi::resolve_names(client, lookup_ids).await;

    Ok(AllianceProfile {
        alliance_id,
        alliance_name: info.name,
        alliance_ticker: info.ticker,
        date_founded: info.date_founded,
        executor_corporation_id: info.executor_corporation_id,
        executor_corporation_name: info.executor_corporation_id.and_then(|id| names.get(&id).cloned()),
        founder_id: info.creator_id,
        founder_name: info.creator_id.and_then(|id| names.get(&id).cloned()),
    })
}

#[derive(Deserialize)]
struct EsiCorporationSummaryInfo {
    name: String,
    ticker: String,
    #[serde(default)]
    member_count: i64,
    #[serde(default)]
    ceo_id: Option<i64>,
}

#[derive(Serialize, Clone)]
pub struct AllianceMemberCorp {
    pub corporation_id: i64,
    pub corporation_name: String,
    pub corporation_ticker: String,
    pub member_count: i64,
    pub ceo_id: Option<i64>,
    pub ceo_name: Option<String>,
}

/// How many member-corp detail lookups run concurrently when resolving an
/// alliance's Corps tab - a large alliance can have 600+ member corps, so
/// this needs the same chunked-concurrency treatment as bulk type/skill
/// lookups elsewhere rather than one unbounded join_all.
const CORP_DETAIL_CONCURRENCY: usize = 40;

/// Every corporation in an alliance, with enough detail for the Corps tab
/// (zKillboard shows this only on alliance pages, not corporation pages,
/// since a corporation has no sub-corporations of its own) - backed by
/// ESI's public /alliances/{id}/corporations/ list plus a per-corp detail
/// fetch for name/ticker/member_count/CEO.
pub async fn fetch_alliance_corporations(client: &reqwest::Client, alliance_id: i64) -> Result<Vec<AllianceMemberCorp>, String> {
    let corp_ids: Vec<i64> = esi::public_get(client, &format!("/alliances/{alliance_id}/corporations/")).await?;

    let mut details: Vec<(i64, EsiCorporationSummaryInfo)> = Vec::with_capacity(corp_ids.len());
    for chunk in corp_ids.chunks(CORP_DETAIL_CONCURRENCY) {
        let results = futures::future::join_all(chunk.iter().map(|&id| async move {
            let info = esi::public_get::<EsiCorporationSummaryInfo>(client, &format!("/corporations/{id}/")).await;
            (id, info)
        }))
        .await;
        details.extend(results.into_iter().filter_map(|(id, info)| info.ok().map(|info| (id, info))));
    }

    let ceo_ids: Vec<i64> = details.iter().filter_map(|(_, info)| info.ceo_id).collect();
    let ceo_names = esi::resolve_names(client, ceo_ids).await;

    let mut corps: Vec<AllianceMemberCorp> = details
        .into_iter()
        .map(|(id, info)| AllianceMemberCorp {
            corporation_id: id,
            corporation_name: info.name,
            corporation_ticker: info.ticker,
            member_count: info.member_count,
            ceo_id: info.ceo_id,
            ceo_name: info.ceo_id.and_then(|id| ceo_names.get(&id).cloned()),
        })
        .collect();
    corps.sort_by(|a, b| b.member_count.cmp(&a.member_count));
    Ok(corps)
}

const TITAN_GROUP_ID: i64 = 30;
const SUPERCARRIER_GROUP_ID: i64 = 659;

/// zKillboard's public kills API hard-caps pastSeconds at 7 days - verified
/// live, a longer value returns "pastSeconds is limited to a max of 7 days".
/// zKillboard's own site shows a 3-month Supers window, but that's their
/// private cached database, not anything reachable through this API - this
/// is a real, honestly-scoped 7-day view rather than a faked longer one.
const SUPERS_WINDOW_SECONDS: i64 = 604_800;

#[derive(Serialize, Clone)]
pub struct SuperKillEntry {
    pub character_id: i64,
    pub character_name: String,
    pub kills: i64,
}

#[derive(Serialize, Default)]
pub struct SupersReport {
    pub titans: Vec<SuperKillEntry>,
    pub supercarriers: Vec<SuperKillEntry>,
}

async fn fetch_group_kills_raw(client: &reqwest::Client, modifier: &str, id: i64, group_id: i64) -> Result<Vec<ZkbKillmail>, String> {
    let url = format!("{ZKILLBOARD_BASE}/kills/{modifier}/{id}/groupID/{group_id}/pastSeconds/{SUPERS_WINDOW_SECONDS}/");
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for {modifier} {id} groupID {group_id}"));
    }
    response.json().await.map_err(|e| format!("failed to parse zKillboard response: {e}"))
}

/// Tallies kills-per-character among attackers matching this entity, sorted
/// most kills first. The "/kills/" path (as opposed to "/losses/") already
/// scopes results to kills this entity's side got, but attackers on a fleet
/// kill include every participant regardless of corp/alliance, so this still
/// filters to attackers actually belonging to the entity before crediting -
/// otherwise an ally's pilot on the same killmail would get counted too.
fn tally_super_kills(raw: &[ZkbKillmail], modifier: &str, id: i64) -> Vec<(i64, i64)> {
    let mut counts: HashMap<i64, i64> = HashMap::new();
    for kill in raw {
        for attacker in &kill.attackers {
            let belongs = match modifier {
                "allianceID" => attacker.alliance_id == Some(id),
                _ => attacker.corporation_id == Some(id),
            };
            if belongs {
                if let Some(char_id) = attacker.character_id {
                    *counts.entry(char_id).or_insert(0) += 1;
                }
            }
        }
    }
    let mut v: Vec<(i64, i64)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v
}

/// Which of this entity's characters got kills on enemy Titans/Supercarriers
/// in the last 7 days - matches zKillboard's own "Intel - Supers" tab,
/// scoped to a real window instead of their unreachable 3-month cache (see
/// SUPERS_WINDOW_SECONDS). Shared by corporation and alliance pages via the
/// same "corporationID"/"allianceID" modifier convention as fetch_area_kills.
pub async fn fetch_supers(client: &reqwest::Client, modifier: &str, id: i64) -> Result<SupersReport, String> {
    let titan_raw = fetch_group_kills_raw(client, modifier, id, TITAN_GROUP_ID).await.unwrap_or_default();
    let super_raw = fetch_group_kills_raw(client, modifier, id, SUPERCARRIER_GROUP_ID).await.unwrap_or_default();

    let titan_counts = tally_super_kills(&titan_raw, modifier, id);
    let super_counts = tally_super_kills(&super_raw, modifier, id);

    let mut all_char_ids: Vec<i64> = titan_counts.iter().chain(super_counts.iter()).map(|(char_id, _)| *char_id).collect();
    all_char_ids.sort_unstable();
    all_char_ids.dedup();
    let names = esi::resolve_names(client, all_char_ids).await;

    let to_entries = |counts: Vec<(i64, i64)>| -> Vec<SuperKillEntry> {
        counts
            .into_iter()
            .map(|(char_id, kills)| SuperKillEntry {
                character_id: char_id,
                character_name: names.get(&char_id).cloned().unwrap_or_else(|| "Unknown".to_string()),
                kills,
            })
            .collect()
    };

    Ok(SupersReport { titans: to_entries(titan_counts), supercarriers: to_entries(super_counts) })
}

/// A metric+rank pair type combo used throughout zKillboard's `rankings`
/// block - these double as both the deserialize target for zKillboard's
/// camelCase JSON and the serialize target sent to the frontend (plain
/// Rust field names, snake_case), verified against a real response from
/// `/api/stats/characterID/{id}/` rather than guessed at.
#[derive(Deserialize, Serialize, Clone, Default)]
pub struct RankMetrics {
    #[serde(rename(deserialize = "shipsDestroyed"), default)]
    pub ships_destroyed: i64,
    #[serde(rename(deserialize = "shipsLost"), default)]
    pub ships_lost: i64,
    #[serde(rename(deserialize = "iskDestroyed"), default)]
    pub isk_destroyed: f64,
    #[serde(rename(deserialize = "iskLost"), default)]
    pub isk_lost: f64,
    #[serde(rename(deserialize = "pointsDestroyed"), default)]
    pub points_destroyed: i64,
    #[serde(rename(deserialize = "pointsLost"), default)]
    pub points_lost: i64,
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct RankNumbers {
    #[serde(default)]
    pub overall: i64,
    #[serde(rename(deserialize = "shipsDestroyed"), default)]
    pub ships_destroyed: i64,
    #[serde(rename(deserialize = "shipsLost"), default)]
    pub ships_lost: i64,
    #[serde(rename(deserialize = "iskDestroyed"), default)]
    pub isk_destroyed: i64,
    #[serde(rename(deserialize = "iskLost"), default)]
    pub isk_lost: i64,
    #[serde(rename(deserialize = "pointsDestroyed"), default)]
    pub points_destroyed: i64,
    #[serde(rename(deserialize = "pointsLost"), default)]
    pub points_lost: i64,
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct RankingWindow {
    #[serde(default)]
    pub metrics: RankMetrics,
    #[serde(default)]
    pub ranks: RankNumbers,
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct RankingPeriod {
    #[serde(default)]
    pub all: RankingWindow,
    #[serde(default)]
    pub solo: RankingWindow,
}

/// zKillboard's own alltime/recent(90d)/weekly(7d) ranking windows, each
/// split into "all" and "solo-only" - matches the Alltime/Recent 90d/
/// Weekly 7d toggle over the stats table.
#[derive(Deserialize, Serialize, Clone, Default)]
pub struct Rankings {
    #[serde(default)]
    pub alltime: RankingPeriod,
    #[serde(default)]
    pub recent: RankingPeriod,
    #[serde(default)]
    pub weekly: RankingPeriod,
}

/// One row of a "Top N" list (top characters/corporations/alliances/
/// ships/systems/locations killed) - zKillboard's topLists entries carry
/// several type-specific fields (shipTypeID, solarSystemID, etc.) but
/// every type also carries this common id/name/kills/isk quartet, which
/// is all a generic "Top" tab needs regardless of category.
#[derive(Deserialize, Serialize, Clone, Default)]
pub struct TopListEntry {
    #[serde(default)]
    pub kills: i64,
    #[serde(default)]
    pub isk: f64,
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct TopList {
    #[serde(rename(deserialize = "type"), default)]
    pub list_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub values: Vec<TopListEntry>,
}

#[derive(Deserialize, Default)]
struct ZkbLabelStats {
    #[serde(rename = "shipsDestroyed", default)]
    ships_destroyed: i64,
}

/// One zKillboard "label" turned into a display-ready trophy, e.g. the
/// "capital" label with shipsDestroyed: 453 becomes the "Capital Kills"
/// trophy showing 453. zKillboard doesn't expose a discrete trophies list -
/// its own site computes these from the same label breakdown returned here.
#[derive(Serialize, Clone)]
pub struct TrophyBadge {
    pub label: String,
    pub ships_destroyed: i64,
}

#[derive(Deserialize, Default)]
struct ZkbCharacterStats {
    #[serde(rename = "shipsLost", default)]
    ships_lost: i64,
    #[serde(rename = "shipsDestroyed", default)]
    ships_destroyed: i64,
    #[serde(rename = "pointsLost", default)]
    points_lost: i64,
    #[serde(rename = "pointsDestroyed", default)]
    points_destroyed: i64,
    #[serde(rename = "iskLost", default)]
    isk_lost: f64,
    #[serde(rename = "iskDestroyed", default)]
    isk_destroyed: f64,
    #[serde(rename = "soloKills", default)]
    solo_kills: i64,
    #[serde(rename = "soloLosses", default)]
    solo_losses: i64,
    #[serde(rename = "dangerRatio", default)]
    danger_ratio: i64,
    #[serde(rename = "gangRatio", default)]
    gang_ratio: i64,
    #[serde(rename = "soloRatio", default)]
    solo_ratio: f64,
    #[serde(rename = "avgGangSize", default)]
    avg_gang_size: f64,
    #[serde(default)]
    labels: HashMap<String, ZkbLabelStats>,
    #[serde(rename = "topLists", default)]
    top_lists: Vec<TopList>,
    #[serde(default)]
    rankings: Rankings,
    #[serde(default)]
    groups: HashMap<i64, ZkbGroupStats>,
    #[serde(default)]
    months: HashMap<String, ZkbMonthStats>,
}

#[derive(Deserialize, Default, Clone)]
struct ZkbGroupStats {
    #[serde(rename = "shipsDestroyed", default)]
    ships_destroyed: i64,
    #[serde(rename = "shipsLost", default)]
    ships_lost: i64,
}

#[derive(Deserialize, Default, Clone)]
struct ZkbMonthStats {
    #[serde(default)]
    year: i64,
    #[serde(default)]
    month: i64,
    #[serde(rename = "shipsDestroyed", default)]
    ships_destroyed: i64,
    #[serde(rename = "pointsDestroyed", default)]
    points_destroyed: i64,
    #[serde(rename = "iskDestroyed", default)]
    isk_destroyed: f64,
    #[serde(rename = "shipsLost", default)]
    ships_lost: i64,
    #[serde(rename = "pointsLost", default)]
    points_lost: i64,
    #[serde(rename = "iskLost", default)]
    isk_lost: f64,
}

/// A killed/lost breakdown for one ship class (zKillboard's "groups" -
/// keyed by SDE ship group id, e.g. Frigate/Battleship/Capsule), turned
/// into a display-ready row by resolving the group id to its name via
/// ESI - matches the "Killed"/"Lost" ship-class tables on zKillboard's
/// Trophies and Stats tabs.
#[derive(Serialize, Clone)]
pub struct ShipClassStats {
    pub group_id: i64,
    pub group_name: String,
    pub ships_destroyed: i64,
    pub ships_lost: i64,
}

/// One month of a character/corp/alliance's kill/loss history - matches
/// zKillboard's Stats tab "Monthly History" table.
#[derive(Serialize, Clone)]
pub struct MonthlyStats {
    pub year: i64,
    pub month: i64,
    pub ships_destroyed: i64,
    pub points_destroyed: i64,
    pub isk_destroyed: f64,
    pub ships_lost: i64,
    pub points_lost: i64,
    pub isk_lost: f64,
}

#[derive(Serialize, Default)]
pub struct CharacterStats {
    pub ships_destroyed: i64,
    pub ships_lost: i64,
    pub points_destroyed: i64,
    pub points_lost: i64,
    pub isk_destroyed: f64,
    pub isk_lost: f64,
    pub solo_kills: i64,
    pub solo_losses: i64,
    pub danger_ratio: i64,
    /// zKillboard's "% of kills made as part of a group" - matches
    /// localthreat.xyz's "Group" column, a signal for whether this pilot
    /// usually brings friends.
    pub gang_ratio: i64,
    pub solo_ratio: f64,
    pub avg_gang_size: f64,
    pub trophies: Vec<TrophyBadge>,
    pub top_lists: Vec<TopList>,
    pub rankings: Rankings,
    pub ship_classes: Vec<ShipClassStats>,
    pub monthly: Vec<MonthlyStats>,
}

/// zKillboard's all-time aggregate stats for an entity (ships/points/isk
/// destroyed vs lost, danger ratio, solo counts) - a different endpoint
/// from the kills/losses lists, redirects to a sub-path so this relies on
/// reqwest's default redirect-following. Best-effort: an entity with no
/// killboard history at all returns defaults rather than an error. Shared
/// by character/corporation/alliance stats - zKillboard's stats endpoint
/// takes the same modifier convention as its kills endpoint (see
/// fetch_area_kills), just with a different id space.
async fn fetch_zkb_stats(client: &reqwest::Client, modifier: &str, id: i64) -> Result<CharacterStats, String> {
    let url = format!("{ZKILLBOARD_BASE}/stats/{modifier}/{id}/");
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for {modifier} stats {id}"));
    }

    let stats: ZkbCharacterStats = response.json().await.unwrap_or_default();

    let mut trophies: Vec<TrophyBadge> = stats
        .labels
        .into_iter()
        .filter(|(_, s)| s.ships_destroyed > 0)
        .map(|(label, s)| TrophyBadge { label, ships_destroyed: s.ships_destroyed })
        .collect();
    trophies.sort_by(|a, b| b.ships_destroyed.cmp(&a.ships_destroyed));

    let group_ids: Vec<i64> = stats.groups.keys().copied().collect();
    let group_names = esi::resolve_group_names(client, &group_ids).await;
    let mut ship_classes: Vec<ShipClassStats> = stats
        .groups
        .into_iter()
        .filter_map(|(id, s)| {
            let name = group_names.get(&id)?.clone();
            Some(ShipClassStats { group_id: id, group_name: name, ships_destroyed: s.ships_destroyed, ships_lost: s.ships_lost })
        })
        .collect();
    ship_classes.sort_by(|a, b| a.group_name.cmp(&b.group_name));

    let mut monthly: Vec<MonthlyStats> = stats
        .months
        .into_values()
        .map(|m| MonthlyStats {
            year: m.year,
            month: m.month,
            ships_destroyed: m.ships_destroyed,
            points_destroyed: m.points_destroyed,
            isk_destroyed: m.isk_destroyed,
            ships_lost: m.ships_lost,
            points_lost: m.points_lost,
            isk_lost: m.isk_lost,
        })
        .collect();
    monthly.sort_by(|a, b| (b.year, b.month).cmp(&(a.year, a.month)));

    Ok(CharacterStats {
        ships_destroyed: stats.ships_destroyed,
        ships_lost: stats.ships_lost,
        points_destroyed: stats.points_destroyed,
        points_lost: stats.points_lost,
        isk_destroyed: stats.isk_destroyed,
        isk_lost: stats.isk_lost,
        solo_kills: stats.solo_kills,
        solo_losses: stats.solo_losses,
        danger_ratio: stats.danger_ratio,
        gang_ratio: stats.gang_ratio,
        solo_ratio: stats.solo_ratio,
        avg_gang_size: stats.avg_gang_size,
        trophies,
        top_lists: stats.top_lists,
        rankings: stats.rankings,
        ship_classes,
        monthly,
    })
}

pub async fn fetch_character_stats(client: &reqwest::Client, character_id: i64) -> Result<CharacterStats, String> {
    fetch_zkb_stats(client, "characterID", character_id).await
}

pub async fn fetch_corporation_stats(client: &reqwest::Client, corporation_id: i64) -> Result<CharacterStats, String> {
    fetch_zkb_stats(client, "corporationID", corporation_id).await
}

pub async fn fetch_alliance_stats(client: &reqwest::Client, alliance_id: i64) -> Result<CharacterStats, String> {
    fetch_zkb_stats(client, "allianceID", alliance_id).await
}

/// Same "sync many names to IDs" job as search_system, but batched (ESI
/// accepts up to 500 per call) and scoped to the `characters` bucket of the
/// response instead of `systems` - this is what turns a pasted Local
/// channel list (or fleet roster, or contract list) into character IDs.
#[derive(Deserialize, Default)]
struct UniverseIdsCharactersResponse {
    #[serde(default)]
    characters: Vec<UniverseIdEntry>,
}

async fn resolve_character_names(client: &reqwest::Client, names: &[String]) -> HashMap<String, i64> {
    let mut result = HashMap::new();
    for chunk in names.chunks(500) {
        let response = match client.post(format!("{ESI_BASE}/universe/ids/")).json(chunk).send().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        if let Ok(parsed) = response.json::<UniverseIdsCharactersResponse>().await {
            for entry in parsed.characters {
                result.insert(entry.name, entry.id);
            }
        }
    }
    result
}

/// Concurrency cap for the per-character profile+stats fan-out below,
/// matching esi.rs's TYPE_DETAIL_CONCURRENCY convention - a busy system's
/// Local can run to 100+ pilots, and firing that many ESI+zKillboard
/// requests all at once isn't polite (or reliable).
const INTEL_CHECK_CONCURRENCY: usize = 40;

#[derive(Serialize, Clone)]
pub struct IntelEntry {
    pub character_id: i64,
    pub character_name: String,
    pub corporation_id: i64,
    pub corporation_name: Option<String>,
    pub corporation_ticker: Option<String>,
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub alliance_ticker: Option<String>,
    pub security_status: Option<f64>,
    pub ships_destroyed: i64,
    pub ships_lost: i64,
    pub danger_ratio: i64,
    pub gang_ratio: i64,
    pub isk_destroyed: f64,
    pub isk_lost: f64,
    pub solo_kills: i64,
    pub solo_ratio: f64,
}

#[derive(Serialize)]
pub struct IntelCheckResult {
    pub entries: Vec<IntelEntry>,
    /// Names that didn't resolve to an exact character - typically a typo
    /// in the paste, a punctuation-only local-channel artifact, or (rarely)
    /// a character that's been deleted/renamed since being seen in local.
    pub unresolved: Vec<String>,
}

/// The core of the "local threat" check: takes whatever was pasted from
/// EVE's Local chat member list, resolves every name, and pulls each
/// pilot's public affiliation plus zKillboard's danger-ratio stats so the
/// frontend can flag anyone worth worrying about before undocking into them.
pub async fn check_intel(client: &reqwest::Client, names: Vec<String>) -> IntelCheckResult {
    let mut unique: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    unique.sort();
    unique.dedup();

    let resolved = resolve_character_names(client, &unique).await;
    let unresolved: Vec<String> = unique.iter().filter(|n| !resolved.contains_key(n.as_str())).cloned().collect();

    let mut entries = Vec::with_capacity(resolved.len());
    let pairs: Vec<(String, i64)> = resolved.into_iter().collect();
    for chunk in pairs.chunks(INTEL_CHECK_CONCURRENCY) {
        let results = futures::future::join_all(chunk.iter().map(|(name, id)| {
            let name = name.clone();
            let id = *id;
            async move {
                let profile = fetch_character_profile(client, id).await.ok()?;
                let stats = fetch_character_stats(client, id).await.unwrap_or_default();
                Some(IntelEntry {
                    character_id: id,
                    character_name: name,
                    corporation_id: profile.corporation_id,
                    corporation_name: profile.corporation_name,
                    corporation_ticker: profile.corporation_ticker,
                    alliance_id: profile.alliance_id,
                    alliance_name: profile.alliance_name,
                    alliance_ticker: profile.alliance_ticker,
                    security_status: profile.security_status,
                    ships_destroyed: stats.ships_destroyed,
                    ships_lost: stats.ships_lost,
                    danger_ratio: stats.danger_ratio,
                    gang_ratio: stats.gang_ratio,
                    isk_destroyed: stats.isk_destroyed,
                    isk_lost: stats.isk_lost,
                    solo_kills: stats.solo_kills,
                    solo_ratio: stats.solo_ratio,
                })
            }
        }))
        .await;
        entries.extend(results.into_iter().flatten());
    }

    IntelCheckResult { entries, unresolved }
}

const RECENT_ACTIVITY_CATEGORIES: [&str; 4] = ["highsec", "lowsec", "nullsec", "w-space"];
const KILLS_PER_CATEGORY: usize = 20;
const RECENT_ACTIVITY_LIMIT: usize = 60;

async fn fetch_category_kills(client: &reqwest::Client, category: &str) -> Result<Vec<ZkbKillmail>, String> {
    let url = format!("{ZKILLBOARD_BASE}/kills/{category}/");
    let response = client.get(&url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for category {category}"));
    }

    let mut kills: Vec<ZkbKillmail> = response
        .json()
        .await
        .map_err(|e| format!("failed to parse zKillboard response: {e}"))?;
    kills.truncate(KILLS_PER_CATEGORY);
    Ok(kills)
}

/// A one-off snapshot of kills across all of New Eden, not scoped to a
/// watchlist. Merges several of zKillboard's region-category endpoints,
/// fetched concurrently. Good for an immediate first screenful, but these
/// endpoints sit behind an up-to-1-hour Cloudflare cache (confirmed via
/// response headers - Cache-Control: max-age=3600), so re-fetching this on
/// a timer doesn't actually get fresher data no matter how often it's
/// called. Real live updates come from poll_recent_activity below instead.
/// A category that fails to load is just left out rather than failing the
/// whole feed.
pub async fn fetch_recent_activity(client: &reqwest::Client) -> Result<Vec<KillEntry>, String> {
    let results =
        futures::future::join_all(RECENT_ACTIVITY_CATEGORIES.iter().map(|&category| fetch_category_kills(client, category)))
            .await;

    let mut raw: Vec<ZkbKillmail> = Vec::new();
    for result in results {
        if let Ok(kills) = result {
            raw.extend(kills);
        }
    }
    raw.sort_by(|a, b| b.killmail_time.cmp(&a.killmail_time));
    raw.truncate(RECENT_ACTIVITY_LIMIT);

    Ok(enrich_kills(client, raw).await)
}

const KILLMAIL_STREAM_BASE: &str = "https://killmail.stream";
const TRACKED_SYSTEMS_QUEUE_ID: &str = "vesper-capsuleer-ops-tracked";

/// Randomized once per app launch (not a fixed constant like
/// TRACKED_SYSTEMS_QUEUE_ID above) so every fresh start of the app gets its
/// own brand-new queue on killmail.stream's server, with nothing already
/// queued up on it. A fixed queue ID here meant the very first poll after
/// the app had been closed for a while came back with everything that had
/// happened across all of New Eden in the meantime - potentially a large
/// backlog needing enrichment before anything reached the UI, which is
/// exactly the "takes a while to connect" delay on startup. Starting fresh
/// each launch trades that backlog (kills during the time the app was
/// closed) for an effectively instant live connection every time - the
/// initial fetch_recent_activity snapshot already covers the "what have I
/// missed" need on its own.
static RECENT_ACTIVITY_QUEUE_ID: LazyLock<String> = LazyLock::new(|| {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("vesper-capsuleer-ops-activity-{suffix}")
});

/// killmail.stream is a maintained, RedisQ-compatible live killmail feed.
/// zKillboard's own RedisQ (zkillredisq.stream) resolves to a sinkhole IP
/// through every DNS path tried, including a neutral public DoH resolver,
/// which rules out a local/network block - it's evidently retired rather
/// than something to route around. /poll/{queueID} long-polls up to 60s
/// and returns every new killmail (same shape as zKillboard's own API)
/// since the last call for that queue, so a client just needs to keep
/// calling it in a loop to get genuinely live kills - no fixed interval
/// needed, and no risk of hammering a cache that can't move faster anyway.
async fn poll_live_kills(client: &reqwest::Client, queue_id: &str) -> Result<Vec<ZkbKillmail>, String> {
    let url = format!("{KILLMAIL_STREAM_BASE}/poll/{queue_id}");
    let response = client.get(&url).send().await.map_err(|e| format!("killmail.stream request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("killmail.stream returned {status}"));
    }

    // Parsed one element at a time rather than as a single Vec<ZkbKillmail>:
    // killmail.stream aggregates from multiple sources, so a very fresh
    // kill can arrive with an incomplete zkb block before zKillboard has
    // finished enriching it. Deserializing the whole batch atomically means
    // one such entry fails every kill in that response; skipping just the
    // entries that don't parse keeps the rest.
    let raw_entries: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("failed to parse killmail.stream response: {e}"))?;
    Ok(raw_entries.into_iter().filter_map(|entry| serde_json::from_value::<ZkbKillmail>(entry).ok()).collect())
}

/// One long-poll cycle of the live, unfiltered New Eden kill stream.
pub async fn poll_recent_activity(client: &reqwest::Client) -> Result<Vec<KillEntry>, String> {
    let raw = poll_live_kills(client, &RECENT_ACTIVITY_QUEUE_ID).await?;
    Ok(enrich_kills(client, raw).await)
}

/// One long-poll cycle of the same live stream, filtered to the watched
/// systems - a distinct queueID from poll_recent_activity so the two
/// consumers each get their own independent position in the stream. Most
/// calls will filter down to nothing to enrich at all, which is normal.
pub async fn poll_tracked_systems(client: &reqwest::Client, system_ids: &[i64]) -> Result<Vec<KillEntry>, String> {
    let raw = poll_live_kills(client, TRACKED_SYSTEMS_QUEUE_ID).await?;
    let matching: Vec<ZkbKillmail> = raw.into_iter().filter(|k| system_ids.contains(&k.solar_system_id)).collect();
    Ok(enrich_kills(client, matching).await)
}

/// Sorts newest-first, resolves system security/region for every unique
/// system involved, then resolves every victim/ship/system/final-blow-
/// attacker name in a single batched ESI call before building KillEntry.
async fn enrich_kills(client: &reqwest::Client, mut raw: Vec<ZkbKillmail>) -> Vec<KillEntry> {
    raw.sort_by(|a, b| b.killmail_time.cmp(&a.killmail_time));

    {
        let mut cache = KILL_CACHE.lock().unwrap();
        for kill in &raw {
            cache.insert(kill.killmail_id, kill.clone());
        }
    }

    let mut unique_systems: Vec<i64> = raw.iter().map(|k| k.solar_system_id).collect();
    unique_systems.sort_unstable();
    unique_systems.dedup();
    let mut system_info: HashMap<i64, SystemInfo> = HashMap::new();
    for system_id in unique_systems {
        if let Some(info) = fetch_system_info(client, system_id).await {
            system_info.insert(system_id, info);
        }
    }

    let mut lookup_ids: Vec<i64> = Vec::new();
    for kill in &raw {
        lookup_ids.push(kill.solar_system_id);
        lookup_ids.push(kill.victim.ship_type_id);
        if let Some(id) = kill.victim.character_id {
            lookup_ids.push(id);
        }
        if let Some(id) = kill.victim.corporation_id {
            lookup_ids.push(id);
        }
        if let Some(id) = kill.victim.alliance_id {
            lookup_ids.push(id);
        }
        if let Some(final_blow) = kill.attackers.iter().find(|a| a.final_blow) {
            if let Some(id) = final_blow.character_id {
                lookup_ids.push(id);
            }
            if let Some(id) = final_blow.corporation_id {
                lookup_ids.push(id);
            }
            if let Some(id) = final_blow.alliance_id {
                lookup_ids.push(id);
            }
        }
    }
    let names = esi::resolve_names(client, lookup_ids).await;

    raw.into_iter()
        .map(|kill| {
            let final_blow = kill.attackers.iter().find(|a| a.final_blow);
            let info = system_info.get(&kill.solar_system_id);
            KillEntry {
                killmail_id: kill.killmail_id,
                time: kill.killmail_time,
                system_id: kill.solar_system_id,
                system_name: names.get(&kill.solar_system_id).cloned().unwrap_or_default(),
                system_security: info.map(|i| i.security_status),
                region_name: info.map(|i| i.region_name.clone()),
                location_id: kill.zkb.location_id,
                victim_character_id: kill.victim.character_id,
                victim_character_name: kill.victim.character_id.and_then(|id| names.get(&id).cloned()),
                victim_corporation_id: kill.victim.corporation_id,
                victim_corporation_name: kill.victim.corporation_id.and_then(|id| names.get(&id).cloned()),
                victim_alliance_id: kill.victim.alliance_id,
                victim_alliance_name: kill.victim.alliance_id.and_then(|id| names.get(&id).cloned()),
                ship_type_id: kill.victim.ship_type_id,
                ship_type_name: names
                    .get(&kill.victim.ship_type_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Type #{}", kill.victim.ship_type_id)),
                total_value: kill.zkb.total_value,
                npc: kill.zkb.npc,
                solo: kill.zkb.solo,
                attacker_count: kill.attackers.len(),
                final_blow_character_id: final_blow.and_then(|a| a.character_id),
                final_blow_character_name: final_blow
                    .and_then(|a| a.character_id)
                    .and_then(|id| names.get(&id).cloned()),
                final_blow_corporation_id: final_blow.and_then(|a| a.corporation_id),
                final_blow_corporation_name: final_blow
                    .and_then(|a| a.corporation_id)
                    .and_then(|id| names.get(&id).cloned()),
                final_blow_alliance_id: final_blow.and_then(|a| a.alliance_id),
                final_blow_alliance_name: final_blow
                    .and_then(|a| a.alliance_id)
                    .and_then(|id| names.get(&id).cloned()),
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct KillItemEntry {
    pub item_type_id: i64,
    pub item_type_name: String,
    pub flag: i32,
    pub slot_group: String,
    pub is_charge: bool,
    pub quantity_destroyed: i64,
    pub quantity_dropped: i64,
}

#[derive(Serialize)]
pub struct InsuranceLevel {
    pub name: String,
    pub cost: f64,
    pub payout: f64,
}

#[derive(Deserialize)]
struct EsiInsuranceEntry {
    type_id: i64,
    levels: Vec<EsiInsuranceLevel>,
}

#[derive(Deserialize)]
struct EsiInsuranceLevel {
    name: String,
    cost: f64,
    payout: f64,
}

/// ESI's insurance-prices endpoint isn't filterable by type - it always
/// returns every insurable hull in one list - so this fetches the whole
/// thing and picks out the one ship. Best-effort: structures/deployables
/// and anything ESI fails to return just leave the killmail without an
/// insurance table rather than failing the whole detail fetch.
pub async fn fetch_insurance_levels(client: &reqwest::Client, ship_type_id: i64) -> Vec<InsuranceLevel> {
    let Ok(entries) = esi::public_get::<Vec<EsiInsuranceEntry>>(client, "/insurance/prices/").await else {
        return Vec::new();
    };
    entries
        .into_iter()
        .find(|e| e.type_id == ship_type_id)
        .map(|e| e.levels.into_iter().map(|l| InsuranceLevel { name: l.name, cost: l.cost, payout: l.payout }).collect())
        .unwrap_or_default()
}

/// Every type_id ESI has insurance data for - the search box in the
/// Insurance calculator uses this to filter down to insurable ships only,
/// since the local item-type search otherwise has no notion of "is this a
/// ship" and would suggest any item (modules, minerals, etc.) just as readily.
pub async fn fetch_insurable_ship_ids(client: &reqwest::Client) -> Vec<i64> {
    let Ok(entries) = esi::public_get::<Vec<EsiInsuranceEntry>>(client, "/insurance/prices/").await else {
        return Vec::new();
    };
    entries.into_iter().map(|e| e.type_id).collect()
}

#[derive(Serialize)]
pub struct KillAttackerEntry {
    pub character_id: Option<i64>,
    pub character_name: Option<String>,
    pub corporation_id: Option<i64>,
    pub corporation_name: Option<String>,
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub ship_type_name: Option<String>,
    pub damage_done: i64,
    pub final_blow: bool,
}

#[derive(Serialize)]
pub struct KillDetail {
    pub killmail_id: i64,
    pub time: String,
    pub system_id: i64,
    pub system_name: String,
    pub system_security: Option<f64>,
    pub region_name: Option<String>,
    /// Nearest stargate to where the kill happened, e.g. "Stargate (New
    /// Caldari)" - None when the killmail carries no position (very old
    /// kills, some NPC kills) or the system has no gates at all.
    pub location_name: Option<String>,
    pub location_distance_m: Option<f64>,
    /// The nearest gate's ESI stargate_id - used by "track this gate" to
    /// build a tracked entry whose id matches zKillboard's zkb.locationID
    /// for real kills at that gate.
    pub location_id: Option<i64>,
    pub victim_character_id: Option<i64>,
    pub victim_character_name: Option<String>,
    pub victim_corporation_id: Option<i64>,
    pub victim_corporation_name: Option<String>,
    pub victim_alliance_id: Option<i64>,
    pub victim_alliance_name: Option<String>,
    pub ship_type_id: i64,
    pub ship_type_name: String,
    pub total_value: f64,
    pub destroyed_value: f64,
    pub dropped_value: f64,
    pub npc: bool,
    pub solo: bool,
    pub points: i64,
    pub damage_taken: i64,
    pub hash: String,
    pub insurance: Vec<InsuranceLevel>,
    pub items: Vec<KillItemEntry>,
    pub attackers: Vec<KillAttackerEntry>,
}

/// Fetches one killmail's full detail - the attackers involved and every
/// item destroyed/dropped. Prefers whatever a list fetch already cached
/// (see KILL_CACHE) since that's exactly the same data and doesn't depend
/// on zKillboard's single-killmail endpoint, which is unreliable enough to
/// miss even a kill that appeared in a list moments ago. Only falls back
/// to that live lookup when the kill isn't cached (e.g. app just started).
pub async fn fetch_kill_detail(client: &reqwest::Client, killmail_id: i64) -> Result<KillDetail, String> {
    let cached = KILL_CACHE.lock().unwrap().get(&killmail_id).cloned();
    let kill = match cached {
        Some(kill) => kill,
        None => {
            let url = format!("{ZKILLBOARD_BASE}/killID/{killmail_id}/");
            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("zKillboard request failed: {e}"))?;

            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("zKillboard returned {status} for killmail {killmail_id}"));
            }

            let kills: Vec<ZkbKillmail> = response
                .json()
                .await
                .map_err(|e| format!("failed to parse zKillboard response: {e}"))?;
            kills
                .into_iter()
                .next()
                .ok_or_else(|| "zKillboard has no record of this killmail".to_string())?
        }
    };

    let mut lookup_ids: Vec<i64> = vec![kill.solar_system_id, kill.victim.ship_type_id];
    if let Some(id) = kill.victim.character_id {
        lookup_ids.push(id);
    }
    if let Some(id) = kill.victim.corporation_id {
        lookup_ids.push(id);
    }
    if let Some(id) = kill.victim.alliance_id {
        lookup_ids.push(id);
    }
    for item in &kill.victim.items {
        lookup_ids.push(item.item_type_id);
    }
    for attacker in &kill.attackers {
        if let Some(id) = attacker.character_id {
            lookup_ids.push(id);
        }
        if let Some(id) = attacker.corporation_id {
            lookup_ids.push(id);
        }
        if let Some(id) = attacker.alliance_id {
            lookup_ids.push(id);
        }
        if let Some(id) = attacker.ship_type_id {
            lookup_ids.push(id);
        }
    }
    let names = esi::resolve_names(client, lookup_ids).await;
    let system_info = fetch_system_info(client, kill.solar_system_id).await;
    let insurance = fetch_insurance_levels(client, kill.victim.ship_type_id).await;
    let (location_name, location_distance_m, location_id) = match kill.victim.position {
        Some(pos) => {
            let gates = crate::route::fetch_system_gates(client, kill.solar_system_id).await;
            match crate::route::nearest_gate((pos.x, pos.y, pos.z), &gates) {
                Some((name, dist, id)) => (Some(name), Some(dist), Some(id)),
                None => (None, None, None),
            }
        }
        None => (None, None, None),
    };
    let item_type_ids: Vec<i64> = kill.victim.items.iter().map(|i| i.item_type_id).collect();
    let is_charge_by_type = classify_charges(client, &item_type_ids).await;

    let mut attackers: Vec<KillAttackerEntry> = kill
        .attackers
        .iter()
        .map(|a| KillAttackerEntry {
            character_id: a.character_id,
            character_name: a.character_id.and_then(|id| names.get(&id).cloned()),
            corporation_id: a.corporation_id,
            corporation_name: a.corporation_id.and_then(|id| names.get(&id).cloned()),
            alliance_id: a.alliance_id,
            alliance_name: a.alliance_id.and_then(|id| names.get(&id).cloned()),
            ship_type_name: a.ship_type_id.and_then(|id| names.get(&id).cloned()),
            damage_done: a.damage_done,
            final_blow: a.final_blow,
        })
        .collect();
    attackers.sort_by(|a, b| b.damage_done.cmp(&a.damage_done));

    let items: Vec<KillItemEntry> = kill
        .victim
        .items
        .iter()
        .map(|item| KillItemEntry {
            item_type_id: item.item_type_id,
            item_type_name: names
                .get(&item.item_type_id)
                .cloned()
                .unwrap_or_else(|| format!("Type #{}", item.item_type_id)),
            flag: item.flag,
            slot_group: slot_group(item.flag).to_string(),
            is_charge: is_charge_by_type.get(&item.item_type_id).copied().unwrap_or(false),
            quantity_destroyed: item.quantity_destroyed,
            quantity_dropped: item.quantity_dropped,
        })
        .collect();

    Ok(KillDetail {
        killmail_id: kill.killmail_id,
        time: kill.killmail_time,
        system_id: kill.solar_system_id,
        system_name: names.get(&kill.solar_system_id).cloned().unwrap_or_default(),
        system_security: system_info.as_ref().map(|i| i.security_status),
        region_name: system_info.map(|i| i.region_name),
        location_name,
        location_distance_m,
        location_id,
        victim_character_id: kill.victim.character_id,
        victim_character_name: kill.victim.character_id.and_then(|id| names.get(&id).cloned()),
        victim_corporation_id: kill.victim.corporation_id,
        victim_corporation_name: kill.victim.corporation_id.and_then(|id| names.get(&id).cloned()),
        victim_alliance_id: kill.victim.alliance_id,
        victim_alliance_name: kill.victim.alliance_id.and_then(|id| names.get(&id).cloned()),
        ship_type_id: kill.victim.ship_type_id,
        ship_type_name: names
            .get(&kill.victim.ship_type_id)
            .cloned()
            .unwrap_or_else(|| format!("Type #{}", kill.victim.ship_type_id)),
        total_value: kill.zkb.total_value,
        destroyed_value: kill.zkb.destroyed_value,
        dropped_value: kill.zkb.dropped_value,
        npc: kill.zkb.npc,
        solo: kill.zkb.solo,
        points: kill.zkb.points,
        damage_taken: kill.victim.damage_taken,
        hash: kill.zkb.hash,
        insurance,
        items,
        attackers,
    })
}

#[derive(Deserialize)]
struct UniverseIdsResponse {
    #[serde(default)]
    systems: Vec<UniverseIdEntry>,
}

#[derive(Deserialize)]
struct UniverseIdEntry {
    id: i64,
    name: String,
}

#[derive(Serialize)]
pub struct SystemMatch {
    pub id: i64,
    pub name: String,
    pub security: f64,
}

/// Resolves an exact solar system name to its ID. ESI's /universe/ids/ only
/// matches exact names (no fuzzy/partial search available without the SDE),
/// so the caller needs to type the system's real name. This is only the
/// fallback path for a name the live typeahead (map::search_systems) didn't
/// already resolve, so the extra hop for security_status is rare in practice.
pub async fn search_system(client: &reqwest::Client, name: &str) -> Result<Option<SystemMatch>, String> {
    let response = client
        .post(format!("{ESI_BASE}/universe/ids/"))
        .json(&[name])
        .send()
        .await
        .map_err(|e| format!("ESI request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("ESI returned {status} resolving system name"));
    }

    let parsed: UniverseIdsResponse = response
        .json()
        .await
        .map_err(|e| format!("failed to parse ESI response: {e}"))?;

    let Some(system) = parsed.systems.into_iter().next() else { return Ok(None) };
    let security = esi::public_get::<EsiSystem>(client, &format!("/universe/systems/{}/", system.id))
        .await
        .map(|s| s.security_status)
        .unwrap_or(0.0);
    Ok(Some(SystemMatch { id: system.id, name: system.name, security }))
}

#[derive(Serialize)]
pub struct CharacterMatch {
    pub id: i64,
    pub name: String,
}

/// Resolves an exact character name to its ID via ESI - the fallback for
/// when the user hits Enter/Search directly rather than picking one of
/// search_characters_live's suggestions (e.g. pasting a name that scrolled
/// off the suggestion list). Reuses the same /universe/ids/ endpoint and
/// characters-bucket response shape as resolve_character_names.
pub async fn search_character(client: &reqwest::Client, name: &str) -> Result<Option<CharacterMatch>, String> {
    let response = client
        .post(format!("{ESI_BASE}/universe/ids/"))
        .json(&[name])
        .send()
        .await
        .map_err(|e| format!("ESI request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("ESI returned {status} resolving character name"));
    }

    let parsed: UniverseIdsCharactersResponse = response
        .json()
        .await
        .map_err(|e| format!("failed to parse ESI response: {e}"))?;

    Ok(parsed.characters.into_iter().next().map(|c| CharacterMatch { id: c.id, name: c.name }))
}

#[derive(Deserialize)]
struct ZkbAutocompleteEntry {
    id: i64,
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

const CHARACTER_SEARCH_SUGGESTIONS: usize = 8;
const ENTITY_SEARCH_SUGGESTIONS: usize = 8;

/// Shared fetch behind search_characters_live/search_entities_live -
/// zKillboard's own site search (verified live:
/// `https://zkillboard.com/autocomplete/{query}/`, the same endpoint their
/// search bar uses - confirmed it does real partial/prefix matching down
/// to 2 characters, unlike ESI's exact-name-only /universe/ids/). Returns
/// every entity type it knows about (items, ships, systems, corporations,
/// alliances, characters, locations) in one mixed list - callers filter
/// down to whichever type(s) they need.
async fn fetch_autocomplete_entries(client: &reqwest::Client, query: &str) -> Result<Vec<ZkbAutocompleteEntry>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // zKillboard requires BOTH no leading double-slash AND a trailing slash
    // after the query itself (confirmed live: "/autocomplete/{q}" alone
    // 404s, only "/autocomplete/{q}/" returns 200) - pushing an extra empty
    // segment after the query is what adds that trailing slash while still
    // routing the query itself through path_segments_mut's percent-encoding
    // (names can contain spaces, apostrophes, non-ASCII characters).
    let mut url = reqwest::Url::parse("https://zkillboard.com/autocomplete").map_err(|e| e.to_string())?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "failed to build autocomplete URL".to_string())?;
        segments.push(trimmed);
        segments.push("");
    }

    let response = client.get(url).send().await.map_err(|e| format!("zKillboard request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("zKillboard returned {status} for autocomplete search"));
    }

    Ok(response.json().await.unwrap_or_default())
}

/// Live as-you-type character suggestions for the Kills & Intel character
/// search box.
pub async fn search_characters_live(client: &reqwest::Client, query: &str) -> Result<Vec<CharacterMatch>, String> {
    let entries = fetch_autocomplete_entries(client, query).await?;
    Ok(entries
        .into_iter()
        .filter(|e| e.entry_type == "character")
        .take(CHARACTER_SEARCH_SUGGESTIONS)
        .map(|e| CharacterMatch { id: e.id, name: e.name })
        .collect())
}

#[derive(Serialize, Clone)]
pub struct EntityMatch {
    pub id: i64,
    pub name: String,
    pub is_alliance: bool,
}

/// Live as-you-type corporation/alliance suggestions (confirmed live: the
/// same autocomplete endpoint returns "corporation" and "alliance" typed
/// entries alongside characters) - for pages like Wars that search
/// directly by corp/alliance name rather than proxying through a
/// character.
pub async fn search_entities_live(client: &reqwest::Client, query: &str) -> Result<Vec<EntityMatch>, String> {
    let entries = fetch_autocomplete_entries(client, query).await?;
    Ok(entries
        .into_iter()
        .filter_map(|e| match e.entry_type.as_str() {
            "alliance" => Some(EntityMatch { id: e.id, name: e.name, is_alliance: true }),
            "corporation" => Some(EntityMatch { id: e.id, name: e.name, is_alliance: false }),
            _ => None,
        })
        .take(ENTITY_SEARCH_SUGGESTIONS)
        .collect())
}
