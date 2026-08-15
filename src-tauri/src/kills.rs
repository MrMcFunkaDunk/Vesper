use crate::esi::{self, ESI_BASE};
use serde::{Deserialize, Serialize};

const ZKILLBOARD_BASE: &str = "https://zkillboard.com/api";

/// zKillboard mirrors the full ESI killmail shape (attackers/victim/etc.)
/// alongside its own "zkb" metadata (value, labels), so a kill's details
/// come entirely from this one call - no separate ESI killmail lookup
/// needed, just name resolution for the IDs it returns.
#[derive(Deserialize)]
struct ZkbKillmail {
    killmail_id: i64,
    killmail_time: String,
    solar_system_id: i64,
    victim: ZkbVictim,
    zkb: ZkbMeta,
}

#[derive(Deserialize)]
struct ZkbVictim {
    character_id: Option<i64>,
    corporation_id: Option<i64>,
    ship_type_id: i64,
}

#[derive(Deserialize)]
struct ZkbMeta {
    #[serde(rename = "totalValue")]
    total_value: f64,
    npc: bool,
    solo: bool,
}

#[derive(Serialize, Clone)]
pub struct KillEntry {
    pub killmail_id: i64,
    pub time: String,
    pub system_id: i64,
    pub system_name: String,
    pub victim_character_id: Option<i64>,
    pub victim_character_name: Option<String>,
    pub victim_corporation_name: Option<String>,
    pub ship_type_id: i64,
    pub ship_type_name: String,
    pub total_value: f64,
    pub npc: bool,
    pub solo: bool,
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
/// asks callers not to hammer their server), merges and sorts them newest
/// first, then resolves every victim/ship/system name in a single batched
/// ESI call.
pub async fn fetch_recent_kills(client: &reqwest::Client, system_ids: &[i64]) -> Result<Vec<KillEntry>, String> {
    let mut raw: Vec<ZkbKillmail> = Vec::new();
    for &system_id in system_ids {
        raw.extend(fetch_system_kills(client, system_id).await?);
    }
    raw.sort_by(|a, b| b.killmail_time.cmp(&a.killmail_time));

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
    }
    let names = esi::resolve_names(client, lookup_ids).await;

    Ok(raw
        .into_iter()
        .map(|kill| KillEntry {
            killmail_id: kill.killmail_id,
            time: kill.killmail_time,
            system_id: kill.solar_system_id,
            system_name: names.get(&kill.solar_system_id).cloned().unwrap_or_default(),
            victim_character_id: kill.victim.character_id,
            victim_character_name: kill.victim.character_id.and_then(|id| names.get(&id).cloned()),
            victim_corporation_name: kill.victim.corporation_id.and_then(|id| names.get(&id).cloned()),
            ship_type_id: kill.victim.ship_type_id,
            ship_type_name: names
                .get(&kill.victim.ship_type_id)
                .cloned()
                .unwrap_or_else(|| format!("Type #{}", kill.victim.ship_type_id)),
            total_value: kill.zkb.total_value,
            npc: kill.zkb.npc,
            solo: kill.zkb.solo,
        })
        .collect())
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
}

/// Resolves an exact solar system name to its ID. ESI's /universe/ids/ only
/// matches exact names (no fuzzy/partial search available without the SDE),
/// so the caller needs to type the system's real name.
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

    Ok(parsed.systems.into_iter().next().map(|s| SystemMatch { id: s.id, name: s.name }))
}
