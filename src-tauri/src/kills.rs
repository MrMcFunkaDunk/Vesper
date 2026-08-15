use crate::esi::{self, ESI_BASE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

const ZKILLBOARD_BASE: &str = "https://zkillboard.com/api";

/// zKillboard's own single-killmail lookup (`/killID/{id}/`) is a short-
/// lived cache that frequently misses even very recent kills - confirmed
/// live, including the single freshest kill in a busy system. But every
/// list endpoint (systemID or category) already returns the complete
/// killmail (attackers, victim, items, zkb metadata), so caching what a
/// kill list just fetched means a click-through never needs that flaky
/// lookup at all for anything the user could have actually clicked.
static KILL_CACHE: LazyLock<Mutex<HashMap<i64, ZkbKillmail>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
    damage_done: i64,
    #[serde(default)]
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
/// asks callers not to hammer their server), then hands off to enrich_kills.
pub async fn fetch_recent_kills(client: &reqwest::Client, system_ids: &[i64]) -> Result<Vec<KillEntry>, String> {
    let mut raw: Vec<ZkbKillmail> = Vec::new();
    for &system_id in system_ids {
        raw.extend(fetch_system_kills(client, system_id).await?);
    }
    Ok(enrich_kills(client, raw).await)
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
const RECENT_ACTIVITY_QUEUE_ID: &str = "vesper-capsuleer-ops-activity";
const TRACKED_SYSTEMS_QUEUE_ID: &str = "vesper-capsuleer-ops-tracked";

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
    let raw = poll_live_kills(client, RECENT_ACTIVITY_QUEUE_ID).await?;
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
