use crate::esi::public_get;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
struct EsiFaction {
    faction_id: i64,
    name: String,
}

/// ESI's generic /universe/names/ resolver doesn't cover NPC faction ids -
/// confirmed against eve-nexum's real implementation, which uses this same
/// dedicated bulk endpoint rather than the names resolver for exactly this
/// reason. Best-effort: a failed fetch just means "Unknown" faction names,
/// not a broken threat list.
async fn fetch_faction_names(client: &reqwest::Client) -> HashMap<i64, String> {
    match public_get::<Vec<EsiFaction>>(client, "/universe/factions/").await {
        Ok(list) => list.into_iter().map(|f| (f.faction_id, f.name)).collect(),
        Err(_) => HashMap::new(),
    }
}

#[derive(Deserialize)]
struct EsiIncursion {
    faction_id: i64,
    has_boss: bool,
    infested_solar_systems: Vec<i64>,
    staging_solar_system_id: i64,
    state: String,
}

#[derive(Serialize, Clone)]
pub struct IncursionSystem {
    pub system_id: i64,
    pub faction_name: String,
    pub is_staging: bool,
    pub has_boss: bool,
    pub state: String,
}

pub async fn fetch_incursions(client: &reqwest::Client) -> Result<Vec<IncursionSystem>, String> {
    let raw: Vec<EsiIncursion> = public_get(client, "/incursions/").await?;
    let factions = fetch_faction_names(client).await;
    let mut result = Vec::new();
    for inc in raw {
        let faction_name = factions.get(&inc.faction_id).cloned().unwrap_or_else(|| "Unknown".to_string());
        for &system_id in &inc.infested_solar_systems {
            result.push(IncursionSystem {
                system_id,
                faction_name: faction_name.clone(),
                is_staging: system_id == inc.staging_solar_system_id,
                has_boss: inc.has_boss,
                state: inc.state.clone(),
            });
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
struct WarzoneSolarSystem {
    id: i64,
}

#[derive(Deserialize)]
struct WarzoneInsurgencyEntry {
    #[serde(rename = "solarSystem")]
    solar_system: WarzoneSolarSystem,
}

#[derive(Deserialize)]
struct WarzoneCampaign {
    state: String,
    #[serde(rename = "pirateFactionId")]
    pirate_faction_id: i64,
    insurgencies: Vec<WarzoneInsurgencyEntry>,
}

#[derive(Serialize, Clone)]
pub struct InsurgencySystem {
    pub system_id: i64,
    pub faction_name: String,
}

/// Insurgencies aren't an ESI concept at all - confirmed against eve-nexum's
/// real implementation, this is CCP's public (undocumented, but open) web
/// warzone API, not the ESI base URL.
pub async fn fetch_insurgencies(client: &reqwest::Client) -> Result<Vec<InsurgencySystem>, String> {
    let response = client
        .get("https://www.eveonline.com/api/warzone/insurgency")
        .send()
        .await
        .map_err(|e| format!("insurgency request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("insurgency API returned {}", response.status()));
    }
    let campaigns: Vec<WarzoneCampaign> =
        response.json().await.map_err(|e| format!("failed to parse insurgency response: {e}"))?;
    let factions = fetch_faction_names(client).await;

    let mut result = Vec::new();
    for campaign in campaigns {
        if campaign.state != "ACTIVE" {
            continue;
        }
        let faction_name = factions.get(&campaign.pirate_faction_id).cloned().unwrap_or_else(|| "Unknown".to_string());
        for ins in campaign.insurgencies {
            result.push(InsurgencySystem { system_id: ins.solar_system.id, faction_name: faction_name.clone() });
        }
    }
    Ok(result)
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SovEntry {
    pub system_id: i64,
    pub alliance_id: Option<i64>,
    pub corporation_id: Option<i64>,
    pub faction_id: Option<i64>,
}

pub async fn fetch_sovereignty_map(client: &reqwest::Client) -> Result<Vec<SovEntry>, String> {
    public_get(client, "/sovereignty/map/").await
}

#[derive(Serialize)]
pub struct NearestThreatResult {
    pub system_id: i64,
    pub jumps: i32,
}

/// Unweighted BFS from `origin_system_id` outward over the stargate network,
/// stopping at the first target it reaches - since BFS explores in order of
/// increasing depth, that's guaranteed to be the nearest one. Reads
/// map.sqlite directly (self-syncing it first if empty), same approach
/// wormholes.rs's find_chain_route already uses rather than piping the whole
/// jump graph over IPC.
pub async fn find_nearest_threat(
    app: tauri::AppHandle,
    client: reqwest::Client,
    origin_system_id: i64,
    target_system_ids: Vec<i64>,
) -> Result<Option<NearestThreatResult>, String> {
    let map_db_path = crate::map::ensure_synced(&app, &client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<NearestThreatResult>, String> {
        let targets: HashSet<i64> = target_system_ids.into_iter().collect();
        if targets.contains(&origin_system_id) {
            return Ok(Some(NearestThreatResult { system_id: origin_system_id, jumps: 0 }));
        }
        if targets.is_empty() {
            return Ok(None);
        }

        let conn = rusqlite::Connection::open(&map_db_path).map_err(|e| e.to_string())?;
        let mut adjacency: HashMap<i64, Vec<i64>> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT from_id, to_id FROM jumps").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                adjacency.entry(row.0).or_default().push(row.1);
                adjacency.entry(row.1).or_default().push(row.0);
            }
        }

        let mut visited: HashSet<i64> = HashSet::from([origin_system_id]);
        let mut frontier = vec![origin_system_id];
        let mut depth = 0i32;
        while !frontier.is_empty() {
            depth += 1;
            let mut next = Vec::new();
            for system_id in frontier {
                for &neighbor in adjacency.get(&system_id).into_iter().flatten() {
                    if visited.insert(neighbor) {
                        if targets.contains(&neighbor) {
                            return Ok(Some(NearestThreatResult { system_id: neighbor, jumps: depth }));
                        }
                        next.push(neighbor);
                    }
                }
            }
            frontier = next;
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}
