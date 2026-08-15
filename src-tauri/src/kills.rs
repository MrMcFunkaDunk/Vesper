use crate::esi::{self, ESI_BASE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ZKILLBOARD_BASE: &str = "https://zkillboard.com/api";

struct SystemInfo {
    security_status: f64,
    region_name: String,
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
async fn fetch_system_info(client: &reqwest::Client, system_id: i64) -> Option<SystemInfo> {
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
    zkb: ZkbMeta,
}

#[derive(Deserialize, Clone)]
struct ZkbAttacker {
    character_id: Option<i64>,
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
    ship_type_id: Option<i64>,
    damage_done: i64,
    final_blow: bool,
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
}

#[derive(Deserialize, Clone)]
struct ZkbItem {
    item_type_id: i64,
    flag: i32,
    #[serde(default)]
    quantity_destroyed: i64,
    #[serde(default)]
    quantity_dropped: i64,
}

#[derive(Deserialize, Clone)]
struct ZkbMeta {
    #[serde(rename = "totalValue")]
    total_value: f64,
    #[serde(rename = "destroyedValue")]
    destroyed_value: f64,
    #[serde(rename = "droppedValue")]
    dropped_value: f64,
    npc: bool,
    solo: bool,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    points: i64,
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
/// asks callers not to hammer their server), merges and sorts them newest
/// first, then resolves every victim/ship/system/final-blow-attacker name
/// in a single batched ESI call.
pub async fn fetch_recent_kills(client: &reqwest::Client, system_ids: &[i64]) -> Result<Vec<KillEntry>, String> {
    let mut raw: Vec<ZkbKillmail> = Vec::new();
    for &system_id in system_ids {
        raw.extend(fetch_system_kills(client, system_id).await?);
    }
    raw.sort_by(|a, b| b.killmail_time.cmp(&a.killmail_time));

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

    Ok(raw
        .into_iter()
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
        .collect())
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
async fn fetch_insurance_levels(client: &reqwest::Client, ship_type_id: i64) -> Vec<InsuranceLevel> {
    let Ok(entries) = esi::public_get::<Vec<EsiInsuranceEntry>>(client, "/insurance/prices/").await else {
        return Vec::new();
    };
    entries
        .into_iter()
        .find(|e| e.type_id == ship_type_id)
        .map(|e| e.levels.into_iter().map(|l| InsuranceLevel { name: l.name, cost: l.cost, payout: l.payout }).collect())
        .unwrap_or_default()
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
    pub system_name: String,
    pub system_security: Option<f64>,
    pub region_name: Option<String>,
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
/// item destroyed/dropped - via zKillboard's single-killmail endpoint.
/// Only reliable for kills still in zKillboard's short-term cache, which a
/// kill just pulled from the recent-activity feed always is.
pub async fn fetch_kill_detail(client: &reqwest::Client, killmail_id: i64) -> Result<KillDetail, String> {
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
    let kill = kills
        .into_iter()
        .next()
        .ok_or_else(|| "zKillboard has no record of this killmail".to_string())?;

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
        system_name: names.get(&kill.solar_system_id).cloned().unwrap_or_default(),
        system_security: system_info.as_ref().map(|i| i.security_status),
        region_name: system_info.map(|i| i.region_name),
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
