use crate::auth::{self, sso::SsoConfig};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const ESI_BASE: &str = "https://esi.evetech.net/latest";

/// Tranquility itself times out ESI every so often - especially right after
/// daily downtime while the server is still stabilizing - surfacing as a
/// 502/503/504 from the gateway rather than anything wrong with the request.
/// A couple of short retries ride out that blip instead of surfacing a hard
/// error for something that clears up in a few seconds.
const RETRY_DELAYS_MS: [u64; 2] = [800, 2000];

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_GATEWAY | reqwest::StatusCode::SERVICE_UNAVAILABLE | reqwest::StatusCode::GATEWAY_TIMEOUT
    )
}

/// Sleeps for the next retry delay and returns true, or returns false once
/// attempts are exhausted so the caller falls through to its normal
/// success/failure handling.
async fn retry_delay(attempt: usize) -> bool {
    let Some(&ms) = RETRY_DELAYS_MS.get(attempt) else { return false };
    tokio::time::sleep(Duration::from_millis(ms)).await;
    true
}

enum EsiError {
    /// The character's stored token doesn't have the scope this endpoint needs.
    MissingScope,
    Failed(String),
}

impl From<String> for EsiError {
    fn from(value: String) -> Self {
        EsiError::Failed(value)
    }
}

async fn authorized_get<T: DeserializeOwned>(
    client: &reqwest::Client,
    access_token: &str,
    path: &str,
) -> Result<T, EsiError> {
    let mut attempt = 0;
    loop {
        let response = match client.get(format!("{ESI_BASE}{path}")).bearer_auth(access_token).send().await {
            Ok(r) => r,
            Err(e) => {
                if retry_delay(attempt).await {
                    attempt += 1;
                    continue;
                }
                return Err(EsiError::Failed(format!("ESI request failed: {e}")));
            }
        };

        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err(EsiError::MissingScope);
        }
        if is_retryable_status(response.status()) && retry_delay(attempt).await {
            attempt += 1;
            continue;
        }
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(EsiError::Failed(format!("ESI {status} on {path}: {text}")));
        }

        return response
            .json::<T>()
            .await
            .map_err(|e| EsiError::Failed(format!("failed to parse ESI response from {path}: {e}")));
    }
}

/// Same contract as authorized_get, but for ESI's paginated character
/// endpoints (assets, wallet transactions) that can run into the thousands
/// for an active character. Fetches page 1 to learn the real page count
/// from the `X-Pages` header, then the rest concurrently.
async fn authorized_get_paginated<T: DeserializeOwned>(
    client: &reqwest::Client,
    access_token: &str,
    path: &str,
) -> Result<Vec<T>, EsiError> {
    async fn fetch_page<T: DeserializeOwned>(
        client: &reqwest::Client,
        access_token: &str,
        path: &str,
        page: u32,
    ) -> Result<(Vec<T>, u32), EsiError> {
        let separator = if path.contains('?') { '&' } else { '?' };
        let url = format!("{ESI_BASE}{path}{separator}page={page}");
        let mut attempt = 0;
        loop {
            let response = match client.get(&url).bearer_auth(access_token).send().await {
                Ok(r) => r,
                Err(e) => {
                    if retry_delay(attempt).await {
                        attempt += 1;
                        continue;
                    }
                    return Err(EsiError::Failed(format!("ESI request failed: {e}")));
                }
            };
            if matches!(response.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
                return Err(EsiError::MissingScope);
            }
            if is_retryable_status(response.status()) && retry_delay(attempt).await {
                attempt += 1;
                continue;
            }
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(EsiError::Failed(format!("ESI {status} on {path}: {text}")));
            }
            let total_pages = response
                .headers()
                .get("x-pages")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(1);
            let items = response
                .json::<Vec<T>>()
                .await
                .map_err(|e| EsiError::Failed(format!("failed to parse ESI response from {path}: {e}")))?;
            return Ok((items, total_pages));
        }
    }

    let (mut all, total_pages) = fetch_page::<T>(client, access_token, path, 1).await?;
    if total_pages > 1 {
        let rest =
            futures::future::join_all((2..=total_pages).map(|p| fetch_page::<T>(client, access_token, path, p))).await;
        for r in rest {
            let (items, _) = r?;
            all.extend(items);
        }
    }
    Ok(all)
}

pub(crate) async fn public_get<T: DeserializeOwned>(client: &reqwest::Client, path: &str) -> Result<T, String> {
    let mut attempt = 0;
    loop {
        let response = match client.get(format!("{ESI_BASE}{path}")).send().await {
            Ok(r) => r,
            Err(e) => {
                if retry_delay(attempt).await {
                    attempt += 1;
                    continue;
                }
                return Err(format!("ESI request failed: {e}"));
            }
        };

        if is_retryable_status(response.status()) && retry_delay(attempt).await {
            attempt += 1;
            continue;
        }
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("ESI {status} on {path}: {text}"));
        }
        return response
            .json::<T>()
            .await
            .map_err(|e| format!("failed to parse ESI response from {path}: {e}"));
    }
}

/// Same contract as `public_get`, but for public endpoints that paginate
/// (e.g. `/markets/{region_id}/orders/`, which can run to a dozen+ pages for
/// a busy hub region). Mirrors `authorized_get_paginated` minus the bearer
/// token, since these endpoints need no scope.
pub(crate) async fn public_get_paginated<T: DeserializeOwned>(client: &reqwest::Client, path: &str) -> Result<Vec<T>, String> {
    async fn fetch_page<T: DeserializeOwned>(client: &reqwest::Client, path: &str, page: u32) -> Result<(Vec<T>, u32), String> {
        let separator = if path.contains('?') { '&' } else { '?' };
        let url = format!("{ESI_BASE}{path}{separator}page={page}");
        let mut attempt = 0;
        loop {
            let response = match client.get(&url).send().await {
                Ok(r) => r,
                Err(e) => {
                    if retry_delay(attempt).await {
                        attempt += 1;
                        continue;
                    }
                    return Err(format!("ESI request failed: {e}"));
                }
            };
            if is_retryable_status(response.status()) && retry_delay(attempt).await {
                attempt += 1;
                continue;
            }
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(format!("ESI {status} on {path}: {text}"));
            }
            let total_pages = response
                .headers()
                .get("x-pages")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(1);
            let items = response
                .json::<Vec<T>>()
                .await
                .map_err(|e| format!("failed to parse ESI response from {path}: {e}"))?;
            return Ok((items, total_pages));
        }
    }

    let (mut all, total_pages) = fetch_page::<T>(client, path, 1).await?;
    if total_pages > 1 {
        let rest = futures::future::join_all((2..=total_pages).map(|p| fetch_page::<T>(client, path, p))).await;
        for r in rest {
            let (items, _) = r?;
            all.extend(items);
        }
    }
    Ok(all)
}

#[derive(Deserialize)]
struct EsiStatus {
    players: i64,
}

#[derive(Serialize)]
pub struct ServerStatus {
    pub online: bool,
    pub players: Option<i64>,
}

/// Tranquility itself has no "up/down" flag in ESI - a successful response
/// from /status/ (a public, unauthenticated endpoint) means the server is up;
/// a failure (including during the daily downtime window) just means it's
/// down. Never surfaces as an error to the frontend - "we couldn't reach it"
/// and "it's down" look the same from here, which is exactly the info this
/// badge needs to show.
pub async fn fetch_server_status(client: &reqwest::Client) -> ServerStatus {
    match public_get::<EsiStatus>(client, "/status/").await {
        Ok(status) => ServerStatus { online: true, players: Some(status.players) },
        Err(_) => ServerStatus { online: false, players: None },
    }
}

#[derive(Deserialize)]
struct EsiCostIndexEntry {
    activity: String,
    cost_index: f64,
}

#[derive(Deserialize)]
struct EsiIndustrySystem {
    solar_system_id: i64,
    cost_indices: Vec<EsiCostIndexEntry>,
}

#[derive(Serialize, Clone)]
pub struct SystemCostIndices {
    pub solar_system_id: i64,
    /// Keyed by ESI's own activity strings ("manufacturing", "reaction",
    /// "invention", "copying", "researching_material_efficiency",
    /// "researching_time_efficiency", "reverse_engineering") - verified live
    /// against ESI's own OpenAPI schema this session, not guessed.
    pub indices: HashMap<String, f64>,
}

/// Public, no auth - but a genuinely large payload (every solar system with
/// industry activity, thousands of rows) that ESI itself only refreshes
/// hourly (x-cache-age: 3600 per its own OpenAPI spec), so this is cached
/// in memory for the same hour rather than re-fetched per calculator use.
static COST_INDEX_CACHE: LazyLock<Mutex<Option<(i64, Vec<SystemCostIndices>)>>> = LazyLock::new(|| Mutex::new(None));
const COST_INDEX_CACHE_SECONDS: i64 = 3600;

pub async fn fetch_industry_system_cost_indices(client: &reqwest::Client) -> Result<Vec<SystemCostIndices>, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    if let Some((cached_at, cached)) = COST_INDEX_CACHE.lock().unwrap().clone() {
        if now - cached_at < COST_INDEX_CACHE_SECONDS {
            return Ok(cached);
        }
    }

    let raw: Vec<EsiIndustrySystem> = public_get(client, "/industry/systems/").await?;
    let result: Vec<SystemCostIndices> = raw
        .into_iter()
        .map(|s| SystemCostIndices {
            solar_system_id: s.solar_system_id,
            indices: s.cost_indices.into_iter().map(|c| (c.activity, c.cost_index)).collect(),
        })
        .collect();

    *COST_INDEX_CACHE.lock().unwrap() = Some((now, result.clone()));
    Ok(result)
}

/// Any failure to get a usable token (no stored entry, a failed refresh) is
/// treated the same as a missing scope by callers: the fix is the same
/// "sign in again" action, so it should produce the same needs_reauth
/// result rather than a hard error with no actionable button.
pub(crate) async fn get_access_token(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Option<String> {
    match auth::ensure_fresh_token(client, config, character_id).await {
        Ok(()) => auth::keychain::load_tokens(character_id).ok().flatten().map(|t| t.access_token),
        Err(_) => None,
    }
}


#[derive(Deserialize)]
struct SkillsResponse {
    total_sp: i64,
    skills: Vec<SkillItem>,
}

#[derive(Deserialize)]
struct SkillItem {
    skill_id: i64,
    trained_skill_level: i32,
    /// "The active skill level (can differ from trained due to alpha status
    /// and/or active expert systems)" - ESI's own field description. This is
    /// the load-bearing signal for clone-state detection below.
    active_skill_level: i32,
    skillpoints_in_skill: i64,
}

#[derive(Deserialize)]
struct SkillQueueEntry {
    skill_id: i64,
    queue_position: i32,
    #[serde(default)]
    finished_level: i32,
    #[serde(default)]
    start_date: Option<String>,
    finish_date: Option<String>,
    #[serde(default)]
    level_start_sp: Option<i64>,
    #[serde(default)]
    level_end_sp: Option<i64>,
    #[serde(default)]
    training_start_sp: Option<i64>,
}

#[derive(Deserialize)]
struct LocationResponse {
    solar_system_id: i64,
    #[serde(default)]
    station_id: Option<i64>,
    #[serde(default)]
    structure_id: Option<i64>,
}

#[derive(Deserialize)]
struct ShipResponse {
    ship_type_id: i64,
}

#[derive(Deserialize)]
struct CharacterPublicInfo {
    corporation_id: i64,
    alliance_id: Option<i64>,
    gender: String,
    race_id: i64,
    bloodline_id: i64,
    security_status: f64,
}

#[derive(Deserialize)]
struct UniverseName {
    id: i64,
    name: String,
}

#[derive(Serialize, Default)]
pub struct CharacterOverview {
    pub character_id: i64,
    pub isk_balance: Option<f64>,
    pub total_sp: Option<i64>,
    pub training_skill_name: Option<String>,
    pub training_finish_date: Option<String>,
    pub queue_length: Option<i32>,
    pub queue_ends_at: Option<String>,
    /// "Alpha" / "Omega" / None if undetermined - see detect_clone_state.
    pub clone_state: Option<String>,
    pub ship_type_name: Option<String>,
    pub gender: Option<String>,
    pub race_name: Option<String>,
    pub bloodline_name: Option<String>,
    pub security_status: Option<f64>,
    pub region_name: Option<String>,
    pub constellation_name: Option<String>,
    /// Station or structure name the character is currently docked at - None
    /// while in open space, not just unresolved.
    pub docked_at_name: Option<String>,
    pub system_name: Option<String>,
    pub corporation_name: Option<String>,
    pub alliance_name: Option<String>,
    pub needs_reauth: bool,
}

async fn resolve_names_chunk(client: &reqwest::Client, ids: &[i64]) -> HashMap<i64, String> {
    let mut attempt = 0;
    loop {
        let result = client.post(format!("{ESI_BASE}/universe/names/")).json(ids).send().await;
        let response = match result {
            Ok(r) => r,
            Err(_) => {
                if retry_delay(attempt).await {
                    attempt += 1;
                    continue;
                }
                return HashMap::new();
            }
        };

        if is_retryable_status(response.status()) && retry_delay(attempt).await {
            attempt += 1;
            continue;
        }
        if !response.status().is_success() {
            return HashMap::new();
        }
        return match response.json::<Vec<UniverseName>>().await {
            Ok(names) => names.into_iter().map(|n| (n.id, n.name)).collect(),
            Err(_) => HashMap::new(),
        };
    }
}

/// /universe/names/ rejects its ENTIRE batch (400, "failed to coerce value...
/// into type integer (format: int32)") if even one id in it doesn't fit an
/// int32 - confirmed live against a real structure id. Player structures use
/// ids far beyond that range, so silently dropping anything too large here
/// stops one citadel id from wiping out every legitimate name in the same
/// chunk. Structure names need resolve_names_with_structures instead, which
/// resolves these via an authorized per-id call.
const MAX_SAFE_NAME_ID: i64 = i32::MAX as i64;

pub(crate) async fn resolve_names(client: &reqwest::Client, ids: Vec<i64>) -> HashMap<i64, String> {
    // ESI rejects the whole batch with 400 if it contains any duplicate id
    // ("'ids' items are not all unique"), which a caller building this list
    // per-kill/per-entry across many rows will naturally produce (e.g. the
    // same system id repeated once per kill in that system).
    let mut ids = ids;
    ids.retain(|&id| id > 0 && id <= MAX_SAFE_NAME_ID);
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    // ESI caps this endpoint at 1000 ids per call - a heavy asset list alone
    // can easily have more unique type/location ids than that.
    let chunks: Vec<&[i64]> = ids.chunks(1000).collect();
    let results = futures::future::join_all(chunks.into_iter().map(|chunk| resolve_names_chunk(client, chunk))).await;
    let mut merged = HashMap::new();
    for r in results {
        merged.extend(r);
    }
    merged
}

#[derive(Deserialize, Serialize, Clone)]
pub(crate) struct StructureInfo {
    pub(crate) name: String,
    pub(crate) solar_system_id: i64,
    pub(crate) owner_id: i64,
}

/// A structure's name is only visible via ESI to a character with CURRENT
/// docking/observer access there - access that assets can easily outlive
/// (corp role changes, structure ownership changes). Once resolved while
/// access exists, the name is worth keeping forever rather than re-asking
/// ESI every session (which would just re-fail the moment access is lost).
/// Persisted to disk for exactly that reason - an in-memory-only cache
/// forgets everything on every restart and re-fights the same 403 forever.
fn structure_cache_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    let dir = base.join("com.barrymillard.eveonlinecompanion");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("structure_names_cache.json"))
}

fn load_structure_cache_from_disk() -> HashMap<i64, StructureInfo> {
    let Some(path) = structure_cache_path() else { return HashMap::new() };
    let Ok(data) = std::fs::read_to_string(&path) else { return HashMap::new() };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_structure_cache_to_disk(cache: &HashMap<i64, StructureInfo>) {
    let Some(path) = structure_cache_path() else { return };
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, json);
    }
}

/// One shared cache for both name and system_id, keyed by structure id -
/// previously name resolution and region resolution each independently
/// called /universe/structures/{id}/ for the SAME structure, doubling the
/// authorized calls needed and doubling the chance either one hits a
/// transient failure while the other succeeds.
static STRUCTURE_INFO_CACHE: LazyLock<Mutex<HashMap<i64, StructureInfo>>> = LazyLock::new(|| Mutex::new(load_structure_cache_from_disk()));

pub(crate) async fn fetch_structure_info(client: &reqwest::Client, access_token: &str, structure_id: i64) -> Option<StructureInfo> {
    if let Some(info) = STRUCTURE_INFO_CACHE.lock().unwrap().get(&structure_id).cloned() {
        return Some(info);
    }
    let info =
        authorized_get::<StructureInfo>(client, access_token, &format!("/universe/structures/{structure_id}/")).await.ok()?;
    let snapshot = {
        let mut cache = STRUCTURE_INFO_CACHE.lock().unwrap();
        cache.insert(structure_id, info.clone());
        cache.clone()
    };
    save_structure_cache_to_disk(&snapshot);
    Some(info)
}

/// Fallback for a location that failed to resolve - past MAX_SAFE_NAME_ID
/// it's almost certainly a player structure the character has no current
/// docking/observer access to (a hard game-design limitation: assets can
/// outlive access to the structure holding them, e.g. after a corp/role
/// change), which ESI will never reveal the name of for anyone lacking it.
/// Keeps the id in the label rather than a single generic string so that
/// several different unresolved structures don't visually collapse into one
/// indistinguishable bucket.
fn location_fallback_name(id: i64) -> String {
    if id > MAX_SAFE_NAME_ID {
        format!("Unknown Structure #{id}")
    } else {
        format!("Location #{id}")
    }
}

/// resolve_names, extended to also resolve player structures (any id beyond
/// MAX_SAFE_NAME_ID) via an authorized per-id call instead of dropping them.
/// Only resolves for structures the character has docking/observer access to
/// - anything else 403s and just falls back to a raw id placeholder rather
/// than failing the whole tab.
pub(crate) async fn resolve_names_with_structures(client: &reqwest::Client, access_token: &str, ids: Vec<i64>) -> HashMap<i64, String> {
    let (small, large): (Vec<i64>, Vec<i64>) = ids.into_iter().partition(|&id| id <= MAX_SAFE_NAME_ID);
    let mut names = resolve_names(client, small).await;

    let mut unique_large = large;
    unique_large.sort_unstable();
    unique_large.dedup();
    for chunk in unique_large.chunks(TYPE_DETAIL_CONCURRENCY) {
        let results = futures::future::join_all(
            chunk.iter().map(|&id| async move { (id, fetch_structure_info(client, access_token, id).await) }),
        )
        .await;
        for (id, info) in results {
            if let Some(info) = info {
                names.insert(id, info.name);
            }
        }
    }
    names
}

/// Market orders are public data (no character scope needed to fetch them),
/// but their location_id can be a player structure, which does need an
/// authorized token to name - same requirement Assets/Contracts/etc already
/// hit. Any currently connected character works here since this is just
/// borrowing a valid token to look a structure up, not acting as that
/// character; the caller doesn't need to be "the active" one.
pub async fn resolve_market_locations(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
    location_ids: Vec<i64>,
) -> HashMap<i64, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return HashMap::new();
    };
    resolve_names_with_structures(client, &access_token, location_ids).await
}

/// Shared shape for the two pieces of universal (never-changes-per-character)
/// static data this app needs from a type's dogma sheet: a skill's rank
/// (attribute 275) and an implant's slot + attribute bonus (331 / 175-179).
/// Neither ESI nor this app bundles CCP's SDE, so these are resolved live and
/// cached forever per type_id, mirroring kills.rs's KILL_CACHE pattern.
#[derive(Deserialize)]
struct EsiTypeDogma {
    group_id: i64,
    #[serde(default)]
    dogma_attributes: Vec<EsiDogmaAttribute>,
}

#[derive(Deserialize)]
struct EsiDogmaAttribute {
    attribute_id: i64,
    value: f64,
}

#[derive(Deserialize)]
struct EsiGroupInfo {
    name: String,
}

/// Per-skill max training level allowed on an Alpha clone. ESI has no
/// Alpha/Omega field anywhere (confirmed against the full OpenAPI spec) - this
/// is CCP's own clone-state skill data, mirrored by a community SDE host and
/// used the same way by EVEMon's own "auto-detect" account status feature.
/// Not an ESI endpoint, so it's fetched and cached separately, once per
/// process lifetime like everything else here.
const ALPHA_CLONE_STATES_URL: &str = "https://sde.hoboleaks.space/tq/clonestates.json";

#[derive(Deserialize)]
struct CloneStateGroup {
    #[serde(default)]
    skills: HashMap<String, i64>,
}

static ALPHA_SKILL_LIMITS: LazyLock<Mutex<Option<HashMap<i64, i64>>>> = LazyLock::new(|| Mutex::new(None));

async fn fetch_alpha_skill_limits(client: &reqwest::Client) -> HashMap<i64, i64> {
    if let Some(cached) = ALPHA_SKILL_LIMITS.lock().unwrap().clone() {
        return cached;
    }
    let raw: HashMap<String, CloneStateGroup> = match client.get(ALPHA_CLONE_STATES_URL).send().await {
        Ok(r) => r.json().await.unwrap_or_default(),
        Err(_) => HashMap::new(),
    };
    let mut merged: HashMap<i64, i64> = HashMap::new();
    for group in raw.values() {
        for (skill_id_str, &level) in &group.skills {
            if let Ok(skill_id) = skill_id_str.parse::<i64>() {
                merged.entry(skill_id).and_modify(|v| *v = (*v).max(level)).or_insert(level);
            }
        }
    }
    *ALPHA_SKILL_LIMITS.lock().unwrap() = Some(merged.clone());
    merged
}

/// Determines clone state from a character's own skill list: any skill whose
/// active level exceeds its Alpha cap proves Omega outright (Alpha physically
/// cannot reach that level); short of that, any skill currently held below
/// its trained level is being capped by something, and alpha status is by far
/// the most common cause. No definitive signal either way just means unknown
/// - deliberately not guessing further, unlike EVEMon's own fuzzier
/// training-rate fallback which its source comments admit false-triggers.
fn detect_clone_state(skills: &[SkillItem], alpha_limits: &HashMap<i64, i64>) -> Option<&'static str> {
    for skill in skills {
        if let Some(&limit) = alpha_limits.get(&skill.skill_id) {
            if skill.active_skill_level as i64 > limit {
                return Some("Omega");
            }
        }
    }
    if skills.iter().any(|s| s.active_skill_level < s.trained_skill_level) {
        return Some("Alpha");
    }
    None
}

const SKILL_RANK_ATTRIBUTE_ID: i64 = 275;
const SKILL_PRIMARY_ATTRIBUTE_ID: i64 = 180;
const SKILL_SECONDARY_ATTRIBUTE_ID: i64 = 181;
/// The 5 real attributes, as referenced by a skill's primaryAttribute(180)/
/// secondaryAttribute(181) dogma values - a *different* id space from the
/// implant-bonus ids (175-179, see ATTRIBUTE_BONUS_IDS) even though both
/// represent the same 5 attributes. Verified live against ESI (not guessed):
/// /dogma/attributes/{164..168}/ display_name, cross-checked against
/// Gunnery's (type 3300) real primary/secondary (167 Perception/168
/// Willpower, rank 1) matching known game data.
const SKILL_ATTRIBUTE_REF_IDS: [(i64, &str); 5] =
    [(164, "Charisma"), (165, "Intelligence"), (166, "Memory"), (167, "Perception"), (168, "Willpower")];

fn attribute_ref_name(value: f64) -> Option<String> {
    SKILL_ATTRIBUTE_REF_IDS.iter().find(|(id, _)| *id == value as i64).map(|(_, name)| name.to_string())
}

/// (requiredSkillN, requiredSkillNLevel) dogma attribute id pairs, N=1..6 -
/// verified live against ESI (not guessed): Caldari Battlecruiser (type
/// 33096) carries 182=3327 (Spaceship Command) / 277=3 and 183=3334
/// (Caldari Cruiser) / 278=3, matching its known real prerequisites
/// (Spaceship Command III + Caldari Cruiser III). Slots 3-6 confirmed by
/// their /dogma/attributes/{id}/ display names (requiredSkill3..6,
/// requiredSkill3..6Level) - the id sequence isn't linear (182-184, then
/// 1285/1289/1290 for skill/1286/1287/1288 for level, with skill3Level
/// oddly at 279 instead of adjacent to 184), so each pair was checked
/// individually rather than assumed to follow a pattern.
const SKILL_PREREQ_IDS: [(i64, i64); 6] = [(182, 277), (183, 278), (184, 279), (1285, 1286), (1289, 1287), (1290, 1288)];

#[derive(Clone)]
struct SkillInfo {
    group_name: String,
    rank: i64,
    primary_attribute: Option<String>,
    secondary_attribute: Option<String>,
    /// (prerequisite skill_id, required level) pairs.
    prerequisites: Vec<(i64, i64)>,
}

static SKILL_INFO_CACHE: LazyLock<Mutex<HashMap<i64, SkillInfo>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static GROUP_NAME_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch_group_name(client: &reqwest::Client, group_id: i64) -> Option<String> {
    if let Some(name) = GROUP_NAME_CACHE.lock().unwrap().get(&group_id).cloned() {
        return Some(name);
    }
    let group = public_get::<EsiGroupInfo>(client, &format!("/universe/groups/{group_id}/")).await.ok()?;
    GROUP_NAME_CACHE.lock().unwrap().insert(group_id, group.name.clone());
    Some(group.name)
}

/// Bulk group_id -> display name resolution (e.g. "Frigate", "Battleship")
/// for zKillboard's per-ship-class stats breakdown - same cache as every
/// other group-name lookup in this file, so once the ~80 or so ship
/// classes that actually see kills have been resolved once, every later
/// character/corp/alliance stats fetch reads from cache instead of
/// re-hitting ESI.
pub(crate) async fn resolve_group_names(client: &reqwest::Client, group_ids: &[i64]) -> HashMap<i64, String> {
    let mut unique: Vec<i64> = group_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let mut merged = HashMap::new();
    for chunk in unique.chunks(TYPE_DETAIL_CONCURRENCY) {
        let results = futures::future::join_all(chunk.iter().map(|&id| async move { (id, fetch_group_name(client, id).await) })).await;
        merged.extend(results.into_iter().filter_map(|(id, name)| name.map(|n| (id, n))));
    }
    merged
}

async fn fetch_skill_info(client: &reqwest::Client, skill_id: i64) -> Option<SkillInfo> {
    if let Some(info) = SKILL_INFO_CACHE.lock().unwrap().get(&skill_id).cloned() {
        return Some(info);
    }
    let detail = public_get::<EsiTypeDogma>(client, &format!("/universe/types/{skill_id}/")).await.ok()?;
    let rank = detail
        .dogma_attributes
        .iter()
        .find(|a| a.attribute_id == SKILL_RANK_ATTRIBUTE_ID)
        .map(|a| a.value as i64)
        .unwrap_or(1);
    let primary_attribute = detail
        .dogma_attributes
        .iter()
        .find(|a| a.attribute_id == SKILL_PRIMARY_ATTRIBUTE_ID)
        .and_then(|a| attribute_ref_name(a.value));
    let secondary_attribute = detail
        .dogma_attributes
        .iter()
        .find(|a| a.attribute_id == SKILL_SECONDARY_ATTRIBUTE_ID)
        .and_then(|a| attribute_ref_name(a.value));
    let prerequisites: Vec<(i64, i64)> = SKILL_PREREQ_IDS
        .iter()
        .filter_map(|(skill_attr, level_attr)| {
            let skill_id = detail.dogma_attributes.iter().find(|a| a.attribute_id == *skill_attr)?.value as i64;
            let level = detail.dogma_attributes.iter().find(|a| a.attribute_id == *level_attr).map(|a| a.value as i64).unwrap_or(1);
            Some((skill_id, level))
        })
        .collect();
    let group_name = fetch_group_name(client, detail.group_id).await.unwrap_or_else(|| "Unknown".to_string());
    let info = SkillInfo { group_name, rank, primary_attribute, secondary_attribute, prerequisites };
    SKILL_INFO_CACHE.lock().unwrap().insert(skill_id, info.clone());
    Some(info)
}

/// Resolves every unique skill_id's rank/group, each already-cached lookup
/// returning instantly so only unseen skill_ids hit ESI. Chunked rather than
/// one giant join_all since this also backs fetch_all_skills (~450 published
/// skills game-wide on a cold cache) - a single burst that size risks
/// connection-pool/timeout trouble on a home connection.
const TYPE_DETAIL_CONCURRENCY: usize = 40;

async fn fetch_skill_infos(client: &reqwest::Client, skill_ids: &[i64]) -> HashMap<i64, SkillInfo> {
    let mut unique: Vec<i64> = skill_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let mut merged = HashMap::new();
    for chunk in unique.chunks(TYPE_DETAIL_CONCURRENCY) {
        let results = futures::future::join_all(chunk.iter().map(|&id| async move { (id, fetch_skill_info(client, id).await) })).await;
        merged.extend(results.into_iter().filter_map(|(id, info)| info.map(|i| (id, i))));
    }
    merged
}

/// The in-game "Skill" category - every published skill in EVE lives under
/// one of its ~50 groups. EveLens ships this as bundled SDE data; this app
/// has no SDE pipeline, so it's resolved live once and cached for the life
/// of the process (see ALL_SKILLS_CACHE), matching every other universal
/// static-data cache in this file.
const SKILL_CATEGORY_ID: i64 = 16;

#[derive(Deserialize)]
struct EsiCategoryInfo {
    #[serde(default, rename = "groups")]
    group_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct EsiGroupTypes {
    name: String,
    #[serde(default)]
    types: Vec<i64>,
    #[serde(default)]
    published: bool,
}

#[derive(Serialize, Clone)]
pub struct SkillPrerequisite {
    pub skill_id: i64,
    pub skill_name: String,
    pub level: i64,
}

#[derive(Serialize, Clone)]
pub struct AllSkillEntry {
    pub skill_id: i64,
    pub name: String,
    pub group_name: String,
    pub rank: i64,
    /// "Charisma"/"Intelligence"/"Memory"/"Perception"/"Willpower" - needed
    /// for training-time math (SP/hour = primary*60 + secondary*30). None
    /// for a small number of non-trainable/placeholder skill-group entries
    /// that carry no attribute dogma at all.
    pub primary_attribute: Option<String>,
    pub secondary_attribute: Option<String>,
    pub prerequisites: Vec<SkillPrerequisite>,
}

static ALL_SKILLS_CACHE: LazyLock<Mutex<Option<Vec<AllSkillEntry>>>> = LazyLock::new(|| Mutex::new(None));

/// Fetches every published skill in the game, grouped and ranked - the
/// "everything" side of the Skills tab's Trained Only toggle. Public data,
/// no character or auth needed; the first call across the whole app session
/// pays for the full walk (category -> ~50 groups -> ~450 types -> names +
/// ranks), every call after that returns instantly from cache.
pub async fn fetch_all_skills(client: &reqwest::Client) -> Result<Vec<AllSkillEntry>, String> {
    if let Some(cached) = ALL_SKILLS_CACHE.lock().unwrap().clone() {
        return Ok(cached);
    }

    let category = public_get::<EsiCategoryInfo>(client, &format!("/universe/categories/{SKILL_CATEGORY_ID}/")).await?;
    let group_results = futures::future::join_all(category.group_ids.iter().map(|&id| async move {
        let detail = public_get::<EsiGroupTypes>(client, &format!("/universe/groups/{id}/")).await;
        (id, detail)
    }))
    .await;

    let mut type_to_group: HashMap<i64, String> = HashMap::new();
    for (group_id, detail) in group_results {
        let Ok(detail) = detail else { continue };
        if !detail.published {
            continue;
        }
        GROUP_NAME_CACHE.lock().unwrap().insert(group_id, detail.name.clone());
        for type_id in detail.types {
            type_to_group.insert(type_id, detail.name.clone());
        }
    }

    let all_ids: Vec<i64> = type_to_group.keys().copied().collect();
    let names = resolve_names(client, all_ids.clone()).await;
    let skill_infos = fetch_skill_infos(client, &all_ids).await;

    let mut entries: Vec<AllSkillEntry> = all_ids
        .into_iter()
        .filter_map(|id| {
            let name = names.get(&id)?.clone();
            let group_name = type_to_group.get(&id)?.clone();
            let info = skill_infos.get(&id);
            let rank = info.map(|i| i.rank).unwrap_or(1);
            // Falls back to a placeholder name rather than dropping the
            // entry entirely - `names` only covers published/catalogued
            // skills, but an unpublished skill can still legitimately be
            // someone's real prerequisite. Silently vanishing it would break
            // the auto-insert-prerequisites feature (a plan entry the
            // frontend never learns it needs) with no error anywhere.
            let prerequisites = info
                .map(|i| {
                    i.prerequisites
                        .iter()
                        .map(|(prereq_id, level)| SkillPrerequisite {
                            skill_id: *prereq_id,
                            skill_name: names.get(prereq_id).cloned().unwrap_or_else(|| format!("Skill #{prereq_id}")),
                            level: *level,
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AllSkillEntry {
                skill_id: id,
                name,
                group_name,
                rank,
                primary_attribute: info.and_then(|i| i.primary_attribute.clone()),
                secondary_attribute: info.and_then(|i| i.secondary_attribute.clone()),
                prerequisites,
            })
        })
        .collect();
    entries.sort_by(|a, b| a.group_name.cmp(&b.group_name).then_with(|| a.name.cmp(&b.name)));

    *ALL_SKILLS_CACHE.lock().unwrap() = Some(entries.clone());
    Ok(entries)
}

/// The five attribute-enhancer dogma attributes, corrected against ESI's own
/// /dogma/attributes/{id}/ display names after an initial guess (175=Perception
/// etc.) proved wrong when tested against a known Perception implant.
const ATTRIBUTE_BONUS_IDS: [(i64, &str); 5] =
    [(175, "Charisma"), (176, "Intelligence"), (177, "Memory"), (178, "Perception"), (179, "Willpower")];
const IMPLANT_SLOT_ATTRIBUTE_ID: i64 = 331;

#[derive(Clone)]
struct ImplantInfo {
    slot: i64,
    bonus_text: Option<String>,
    /// Which of the 5 attributes this implant boosts, and by how much - the
    /// same dogma lookup bonus_text already does, just kept structured
    /// (rather than pre-formatted into text) so callers can sum bonuses per
    /// attribute for an effective-value calculation, not just display them.
    attribute: Option<String>,
    bonus: Option<i64>,
}

static IMPLANT_INFO_CACHE: LazyLock<Mutex<HashMap<i64, ImplantInfo>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch_implant_info(client: &reqwest::Client, type_id: i64) -> Option<ImplantInfo> {
    if let Some(info) = IMPLANT_INFO_CACHE.lock().unwrap().get(&type_id).cloned() {
        return Some(info);
    }
    let detail = public_get::<EsiTypeDogma>(client, &format!("/universe/types/{type_id}/")).await.ok()?;
    let slot = detail
        .dogma_attributes
        .iter()
        .find(|a| a.attribute_id == IMPLANT_SLOT_ATTRIBUTE_ID)
        .map(|a| a.value as i64)
        .unwrap_or(0);
    let matched = ATTRIBUTE_BONUS_IDS.iter().find_map(|(attr_id, label)| {
        detail
            .dogma_attributes
            .iter()
            .find(|a| a.attribute_id == *attr_id && a.value > 0.0)
            .map(|a| (*label, a.value as i64))
    });
    let bonus_text = matched.map(|(label, value)| format!("+{value} {label}"));
    let info = ImplantInfo { slot, bonus_text, attribute: matched.map(|(label, _)| label.to_string()), bonus: matched.map(|(_, value)| value) };
    IMPLANT_INFO_CACHE.lock().unwrap().insert(type_id, info.clone());
    Some(info)
}

async fn fetch_implant_infos(client: &reqwest::Client, type_ids: &[i64]) -> HashMap<i64, ImplantInfo> {
    let mut unique: Vec<i64> = type_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let results =
        futures::future::join_all(unique.iter().map(|&id| async move { (id, fetch_implant_info(client, id).await) })).await;
    results.into_iter().filter_map(|(id, info)| info.map(|i| (id, i))).collect()
}

/// Any item's group name (e.g. "Cruiser", "Ammo & Charges") - the Assets
/// tab's "Group" grouping mode, distinct from SKILL_INFO_CACHE only in that
/// it doesn't also need rank, so it skips the dogma_attributes work.
static ITEM_GROUP_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch_item_group_name(client: &reqwest::Client, type_id: i64) -> Option<String> {
    if let Some(name) = ITEM_GROUP_CACHE.lock().unwrap().get(&type_id).cloned() {
        return Some(name);
    }
    let detail = public_get::<EsiTypeDogma>(client, &format!("/universe/types/{type_id}/")).await.ok()?;
    let group_name = fetch_group_name(client, detail.group_id).await?;
    ITEM_GROUP_CACHE.lock().unwrap().insert(type_id, group_name.clone());
    Some(group_name)
}

async fn fetch_item_group_names(client: &reqwest::Client, type_ids: &[i64]) -> HashMap<i64, String> {
    let mut unique: Vec<i64> = type_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let mut merged = HashMap::new();
    for chunk in unique.chunks(TYPE_DETAIL_CONCURRENCY) {
        let results = futures::future::join_all(chunk.iter().map(|&id| async move { (id, fetch_item_group_name(client, id).await) })).await;
        merged.extend(results.into_iter().filter_map(|(id, name)| name.map(|n| (id, n))));
    }
    merged
}

#[derive(Deserialize)]
struct EsiStationInfo {
    system_id: i64,
}

#[derive(Deserialize)]
struct EsiSystemInfo {
    constellation_id: i64,
}

#[derive(Deserialize)]
struct EsiConstellationInfo {
    name: String,
    region_id: i64,
}

static SYSTEM_REGION_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SYSTEM_CONSTELLATION_NAME_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LOCATION_REGION_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch_region_for_system(client: &reqwest::Client, system_id: i64) -> Option<String> {
    if let Some(region) = SYSTEM_REGION_CACHE.lock().unwrap().get(&system_id).cloned() {
        return Some(region);
    }
    let system = public_get::<EsiSystemInfo>(client, &format!("/universe/systems/{system_id}/")).await.ok()?;
    let constellation =
        public_get::<EsiConstellationInfo>(client, &format!("/universe/constellations/{}/", system.constellation_id)).await.ok()?;
    SYSTEM_CONSTELLATION_NAME_CACHE.lock().unwrap().insert(system_id, constellation.name.clone());
    let region = public_get::<EsiGroupInfo>(client, &format!("/universe/regions/{}/", constellation.region_id)).await.ok()?.name;
    SYSTEM_REGION_CACHE.lock().unwrap().insert(system_id, region.clone());
    Some(region)
}

/// Piggybacks on fetch_region_for_system, which already walks system ->
/// constellation -> region and caches the constellation name as a side
/// effect - this just reads that cache (populating it first if needed).
async fn fetch_constellation_for_system(client: &reqwest::Client, system_id: i64) -> Option<String> {
    if let Some(name) = SYSTEM_CONSTELLATION_NAME_CACHE.lock().unwrap().get(&system_id).cloned() {
        return Some(name);
    }
    fetch_region_for_system(client, system_id).await?;
    SYSTEM_CONSTELLATION_NAME_CACHE.lock().unwrap().get(&system_id).cloned()
}

/// Resolves an asset's top-level location (station or player structure) to
/// its region name. Stations are public; structures need the character's own
/// token and only resolve if they're on that structure's access list -
/// unresolvable ones fall back to "Unknown Region" for that call, but that
/// failure is deliberately NOT cached (only real resolutions are): a
/// structure that fails now (missing scope, ACL, transient error) can
/// legitimately succeed on a later attempt, and this cache lives for the
/// whole process lifetime - caching the failure would permanently freeze
/// "Unknown Region" for that id even after whatever caused it is fixed.
async fn fetch_location_region(client: &reqwest::Client, access_token: &str, location_id: i64) -> String {
    if let Some(region) = LOCATION_REGION_CACHE.lock().unwrap().get(&location_id).cloned() {
        return region;
    }
    // Player structures always use ids far beyond a station's range - skip
    // the guaranteed-404 station lookup for those rather than needlessly
    // burning ESI's shared per-app error budget (which throttles every
    // endpoint, not just this one, once exceeded).
    let system_id = if location_id <= MAX_SAFE_NAME_ID {
        if let Ok(station) = public_get::<EsiStationInfo>(client, &format!("/universe/stations/{location_id}/")).await {
            Some(station.system_id)
        } else {
            fetch_structure_info(client, access_token, location_id).await.map(|s| s.solar_system_id)
        }
    } else {
        fetch_structure_info(client, access_token, location_id).await.map(|s| s.solar_system_id)
    };
    let Some(sid) = system_id else {
        return "Unknown Region".to_string();
    };
    let Some(region) = fetch_region_for_system(client, sid).await else {
        return "Unknown Region".to_string();
    };
    LOCATION_REGION_CACHE.lock().unwrap().insert(location_id, region.clone());
    region
}

async fn fetch_location_regions(client: &reqwest::Client, access_token: &str, location_ids: &[i64]) -> HashMap<i64, String> {
    let mut unique: Vec<i64> = location_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let mut merged = HashMap::new();
    for chunk in unique.chunks(TYPE_DETAIL_CONCURRENCY) {
        let results =
            futures::future::join_all(chunk.iter().map(|&id| async move { (id, fetch_location_region(client, access_token, id).await) }))
                .await;
        merged.extend(results);
    }
    merged
}

/// Walks an asset's location_id up through parent assets (a module sitting
/// in a ship's cargo, a ship sitting in a container in a hangar) until it
/// reaches an id that isn't itself another asset in this same list - that's
/// the real station/structure the whole stack ultimately lives in. Capped
/// depth guards against any unexpected cycle in the data.
fn resolve_root_location(item_locations: &HashMap<i64, i64>, mut location_id: i64) -> i64 {
    let mut depth = 0;
    while let Some(&parent) = item_locations.get(&location_id) {
        location_id = parent;
        depth += 1;
        if depth > 12 {
            break;
        }
    }
    location_id
}

#[derive(Deserialize)]
struct EsiRace {
    race_id: i64,
    name: String,
}

#[derive(Deserialize)]
struct EsiBloodline {
    bloodline_id: i64,
    name: String,
}

static RACE_NAMES_CACHE: LazyLock<Mutex<Option<HashMap<i64, String>>>> = LazyLock::new(|| Mutex::new(None));
static BLOODLINE_NAMES_CACHE: LazyLock<Mutex<Option<HashMap<i64, String>>>> = LazyLock::new(|| Mutex::new(None));

/// Races and bloodlines aren't resolvable via /universe/names/ (that endpoint
/// only covers characters/corporations/alliances/stations/systems/
/// constellations/regions/types/factions) - each is its own small, full-list,
/// no-scope-needed endpoint, fetched and cached once for the process lifetime.
async fn fetch_race_name(client: &reqwest::Client, race_id: i64) -> Option<String> {
    if let Some(cached) = RACE_NAMES_CACHE.lock().unwrap().clone() {
        return cached.get(&race_id).cloned();
    }
    let races = public_get::<Vec<EsiRace>>(client, "/universe/races/").await.ok()?;
    let map: HashMap<i64, String> = races.into_iter().map(|r| (r.race_id, r.name)).collect();
    let result = map.get(&race_id).cloned();
    *RACE_NAMES_CACHE.lock().unwrap() = Some(map);
    result
}

async fn fetch_bloodline_name(client: &reqwest::Client, bloodline_id: i64) -> Option<String> {
    if let Some(cached) = BLOODLINE_NAMES_CACHE.lock().unwrap().clone() {
        return cached.get(&bloodline_id).cloned();
    }
    let bloodlines = public_get::<Vec<EsiBloodline>>(client, "/universe/bloodlines/").await.ok()?;
    let map: HashMap<i64, String> = bloodlines.into_iter().map(|b| (b.bloodline_id, b.name)).collect();
    let result = map.get(&bloodline_id).cloned();
    *BLOODLINE_NAMES_CACHE.lock().unwrap() = Some(map);
    result
}

pub async fn fetch_character_overview(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterOverview, String> {
    // Refresh once for the whole overview, not once per endpoint below - EVE SSO
    // rotates the refresh token on each use, so firing several refreshes for the
    // same character concurrently (e.g. across a Promise.all of multiple
    // characters, each doing several endpoint calls) races and corrupts the
    // stored token.
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterOverview { character_id, needs_reauth: true, ..Default::default() });
    };
    let access_token = access_token.as_str();

    let mut overview = CharacterOverview { character_id, ..Default::default() };
    let mut lookup_ids: Vec<i64> = Vec::new();
    let mut current_skill_id: Option<i64> = None;
    let mut system_id: Option<i64> = None;
    let mut ship_type_id: Option<i64> = None;
    let mut docked_id: Option<i64> = None;

    // Wallet, skills, skill queue, location, ship and PLEX are all
    // independent ESI reads once the token is in hand - previously awaited
    // one after another, turning six round trips into six times the
    // latency. Fire them concurrently instead; each branch stays
    // self-contained (e.g. the region/constellation name lookups that
    // depend on the location result are awaited inside that same branch)
    // so none of them need another branch's result.
    let wallet_url = format!("/characters/{character_id}/wallet/");
    let skills_url = format!("/characters/{character_id}/skills/");
    let queue_url = format!("/characters/{character_id}/skillqueue/");
    let location_url = format!("/characters/{character_id}/location/");
    let ship_url = format!("/characters/{character_id}/ship/");

    let (wallet_result, skills_result, queue_result, location_result, ship_result) = futures::join!(
        authorized_get::<f64>(client, access_token, &wallet_url),
        async {
            let v = authorized_get::<SkillsResponse>(client, access_token, &skills_url).await?;
            let alpha_limits = fetch_alpha_skill_limits(client).await;
            let clone_state = detect_clone_state(&v.skills, &alpha_limits).map(|s| s.to_string());
            Ok::<_, EsiError>((v.total_sp, clone_state))
        },
        authorized_get::<Vec<SkillQueueEntry>>(client, access_token, &queue_url),
        async {
            let v = authorized_get::<LocationResponse>(client, access_token, &location_url).await?;
            let region_name = fetch_region_for_system(client, v.solar_system_id).await;
            let constellation_name = fetch_constellation_for_system(client, v.solar_system_id).await;
            Ok::<_, EsiError>((v, region_name, constellation_name))
        },
        authorized_get::<ShipResponse>(client, access_token, &ship_url),
    );

    match wallet_result {
        Ok(v) => overview.isk_balance = Some(v),
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match skills_result {
        Ok((total_sp, clone_state)) => {
            overview.total_sp = Some(total_sp);
            overview.clone_state = clone_state;
        }
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match queue_result {
        Ok(entries) => {
            overview.queue_length = Some(entries.len() as i32);
            overview.queue_ends_at = entries
                .iter()
                .filter(|e| e.finish_date.is_some())
                .max_by_key(|e| e.queue_position)
                .and_then(|e| e.finish_date.clone());
            if let Some(entry) = entries.into_iter().filter(|e| e.finish_date.is_some()).min_by_key(|e| e.queue_position)
            {
                current_skill_id = Some(entry.skill_id);
                overview.training_finish_date = entry.finish_date;
                lookup_ids.push(entry.skill_id);
            }
        }
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match location_result {
        Ok((v, region_name, constellation_name)) => {
            system_id = Some(v.solar_system_id);
            lookup_ids.push(v.solar_system_id);
            overview.region_name = region_name;
            overview.constellation_name = constellation_name;
            docked_id = v.station_id.or(v.structure_id);
            if let Some(id) = docked_id {
                lookup_ids.push(id);
            }
        }
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match ship_result {
        Ok(v) => {
            ship_type_id = Some(v.ship_type_id);
            lookup_ids.push(v.ship_type_id);
        }
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    // Public data - no scope required, so a failure here is a real error rather
    // than a "needs re-auth" case.
    let public_info = public_get::<CharacterPublicInfo>(client, &format!("/characters/{character_id}/")).await?;
    lookup_ids.push(public_info.corporation_id);
    if let Some(alliance_id) = public_info.alliance_id {
        lookup_ids.push(alliance_id);
    }

    overview.gender = Some(public_info.gender);
    overview.security_status = Some(public_info.security_status);
    overview.race_name = fetch_race_name(client, public_info.race_id).await;
    overview.bloodline_name = fetch_bloodline_name(client, public_info.bloodline_id).await;

    // Docked location can be a player structure, hence the structure-aware
    // resolver here rather than plain resolve_names.
    let names = resolve_names_with_structures(client, access_token, lookup_ids).await;

    overview.training_skill_name = current_skill_id.and_then(|id| names.get(&id).cloned());
    overview.system_name = system_id.and_then(|id| names.get(&id).cloned());
    overview.ship_type_name = ship_type_id.and_then(|id| names.get(&id).cloned());
    overview.corporation_name = names.get(&public_info.corporation_id).cloned();
    overview.alliance_name = public_info.alliance_id.and_then(|id| names.get(&id).cloned());
    overview.docked_at_name = docked_id.and_then(|id| names.get(&id).cloned());

    Ok(overview)
}

#[derive(Serialize, Default, Clone)]
pub struct CharacterLocation {
    pub character_id: i64,
    pub solar_system_id: Option<i64>,
    pub solar_system_name: Option<String>,
    pub ship_type_id: Option<i64>,
    pub ship_type_name: Option<String>,
    pub needs_reauth: bool,
}

/// A character's current solar system + ship hull, polled periodically for
/// the Path & Wormhole Finder's live-location tracking. Both come from a
/// single access-token fetch (not two independent get_access_token calls)
/// for the same reason fetch_character_overview does it this way - EVE SSO
/// rotates the refresh token on each use, so two independent refreshes for
/// the same character racing each other can corrupt the stored token.
pub async fn fetch_character_location(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterLocation, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterLocation { character_id, needs_reauth: true, ..Default::default() });
    };
    let access_token = access_token.as_str();

    let mut result = CharacterLocation { character_id, ..Default::default() };
    let mut lookup_ids: Vec<i64> = Vec::new();
    let mut system_id: Option<i64> = None;
    let mut ship_type_id: Option<i64> = None;

    // Independent endpoints once the token is in hand - fetch concurrently
    // rather than one after another, same reasoning as fetch_character_overview.
    let location_url = format!("/characters/{character_id}/location/");
    let ship_url = format!("/characters/{character_id}/ship/");
    let (location_result, ship_result) = futures::join!(
        authorized_get::<LocationResponse>(client, access_token, &location_url),
        authorized_get::<ShipResponse>(client, access_token, &ship_url),
    );

    match location_result {
        Ok(v) => {
            system_id = Some(v.solar_system_id);
            lookup_ids.push(v.solar_system_id);
        }
        Err(EsiError::MissingScope) => result.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match ship_result {
        Ok(v) => {
            ship_type_id = Some(v.ship_type_id);
            lookup_ids.push(v.ship_type_id);
        }
        Err(EsiError::MissingScope) => result.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    let names = resolve_names(client, lookup_ids).await;
    result.solar_system_id = system_id;
    result.solar_system_name = system_id.and_then(|id| names.get(&id).cloned());
    result.ship_type_id = ship_type_id;
    result.ship_type_name = ship_type_id.and_then(|id| names.get(&id).cloned());
    Ok(result)
}

#[derive(Serialize)]
pub struct SkillEntry {
    pub skill_id: i64,
    pub name: String,
    pub group_name: String,
    pub rank: i64,
    pub trained_level: i32,
    pub skillpoints: i64,
}

#[derive(Serialize, Default)]
pub struct CharacterSkills {
    pub total_sp: Option<i64>,
    pub skills: Vec<SkillEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_skills(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterSkills, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterSkills { needs_reauth: true, ..Default::default() });
    };

    let raw = match authorized_get::<SkillsResponse>(
        client,
        &access_token,
        &format!("/characters/{character_id}/skills/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterSkills { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let ids: Vec<i64> = raw.skills.iter().map(|s| s.skill_id).collect();
    let names = resolve_names(client, ids.clone()).await;
    let skill_infos = fetch_skill_infos(client, &ids).await;

    let mut skills: Vec<SkillEntry> = raw
        .skills
        .into_iter()
        .map(|s| {
            let info = skill_infos.get(&s.skill_id);
            SkillEntry {
                skill_id: s.skill_id,
                name: names.get(&s.skill_id).cloned().unwrap_or_else(|| format!("Type #{}", s.skill_id)),
                group_name: info.map(|i| i.group_name.clone()).unwrap_or_else(|| "Unknown".to_string()),
                rank: info.map(|i| i.rank).unwrap_or(1),
                trained_level: s.trained_skill_level,
                skillpoints: s.skillpoints_in_skill,
            }
        })
        .collect();
    skills.sort_by(|a, b| a.group_name.cmp(&b.group_name).then_with(|| a.name.cmp(&b.name)));

    Ok(CharacterSkills { total_sp: Some(raw.total_sp), skills, needs_reauth: false })
}

#[derive(Serialize)]
pub struct SkillQueueItem {
    pub skill_id: i64,
    pub skill_name: String,
    pub queue_position: i32,
    pub finished_level: i32,
    pub start_date: Option<String>,
    pub finish_date: Option<String>,
    pub level_start_sp: Option<i64>,
    pub level_end_sp: Option<i64>,
    pub training_start_sp: Option<i64>,
}

#[derive(Serialize, Default)]
pub struct CharacterSkillQueue {
    pub items: Vec<SkillQueueItem>,
    pub needs_reauth: bool,
}

/// The full training queue (every skill lined up, not just the one
/// currently training) - the overview above only ever looks at the single
/// active entry for its dashboard summary.
pub async fn fetch_character_skill_queue(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterSkillQueue, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterSkillQueue { needs_reauth: true, ..Default::default() });
    };

    let raw = match authorized_get::<Vec<SkillQueueEntry>>(
        client,
        &access_token,
        &format!("/characters/{character_id}/skillqueue/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterSkillQueue { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let ids: Vec<i64> = raw.iter().map(|e| e.skill_id).collect();
    let names = resolve_names(client, ids).await;

    let mut items: Vec<SkillQueueItem> = raw
        .into_iter()
        .map(|e| SkillQueueItem {
            skill_id: e.skill_id,
            skill_name: names.get(&e.skill_id).cloned().unwrap_or_else(|| format!("Type #{}", e.skill_id)),
            queue_position: e.queue_position,
            finished_level: e.finished_level,
            start_date: e.start_date,
            finish_date: e.finish_date,
            level_start_sp: e.level_start_sp,
            level_end_sp: e.level_end_sp,
            training_start_sp: e.training_start_sp,
        })
        .collect();
    items.sort_by_key(|e| e.queue_position);

    Ok(CharacterSkillQueue { items, needs_reauth: false })
}

#[derive(Deserialize)]
struct CorpHistoryEntry {
    corporation_id: i64,
    #[serde(default)]
    is_deleted: bool,
    start_date: String,
}

#[derive(Serialize)]
pub struct EmploymentEntry {
    pub corporation_id: i64,
    pub corporation_name: String,
    pub start_date: String,
    pub is_deleted: bool,
}

/// Corp history is public data - no scope, works for any character, not
/// just the logged-in ones. Sorted most recent first.
pub async fn fetch_character_employment_history(client: &reqwest::Client, character_id: i64) -> Result<Vec<EmploymentEntry>, String> {
    let raw: Vec<CorpHistoryEntry> =
        public_get(client, &format!("/characters/{character_id}/corporationhistory/")).await?;
    let ids: Vec<i64> = raw.iter().map(|e| e.corporation_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<EmploymentEntry> = raw
        .into_iter()
        .map(|e| EmploymentEntry {
            corporation_id: e.corporation_id,
            corporation_name: names
                .get(&e.corporation_id)
                .cloned()
                .unwrap_or_else(|| format!("Corporation #{}", e.corporation_id)),
            start_date: e.start_date,
            is_deleted: e.is_deleted,
        })
        .collect();
    entries.sort_by(|a, b| b.start_date.cmp(&a.start_date));
    Ok(entries)
}

// --- Remaining EveLens-style character tabs ---
//
// Every fetch below follows the same shape as fetch_character_skill_queue
// above: no token / MissingScope -> needs_reauth: true (never a hard
// error, since the fix is always "sign in again" and the frontend already
// knows how to render that state); otherwise fetch, resolve display names
// for whatever ids need them, sort into a sensible default order.

/// EVE's industry activity ids are fixed, stable constants - not something
/// ESI resolves a display name for, so mapped by hand.
fn industry_activity_name(activity_id: i64) -> &'static str {
    match activity_id {
        1 => "Manufacturing",
        3 => "Time Efficiency Research",
        4 => "Material Efficiency Research",
        5 => "Copying",
        7 => "Reverse Engineering",
        8 => "Invention",
        9 => "Reaction",
        _ => "Unknown",
    }
}

#[derive(Deserialize)]
struct EsiHomeLocation {
    location_id: i64,
}

#[derive(Deserialize)]
struct EsiJumpClone {
    jump_clone_id: i64,
    location_id: i64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    implants: Vec<i64>,
}

#[derive(Deserialize)]
struct EsiClonesResponse {
    #[serde(default)]
    home_location: Option<EsiHomeLocation>,
    jump_clones: Vec<EsiJumpClone>,
}

#[derive(Serialize)]
pub struct ImplantEntry {
    pub type_id: i64,
    pub name: String,
    pub slot: i64,
    pub bonus_text: Option<String>,
    pub attribute: Option<String>,
    pub bonus: Option<i64>,
}

#[derive(Serialize)]
pub struct JumpCloneEntry {
    pub jump_clone_id: i64,
    pub name: Option<String>,
    pub location_name: String,
    pub implants: Vec<ImplantEntry>,
}

#[derive(Serialize, Default)]
pub struct CharacterClones {
    pub home_location_name: Option<String>,
    pub active_implants: Vec<ImplantEntry>,
    pub jump_clones: Vec<JumpCloneEntry>,
    pub needs_reauth: bool,
}

/// Just the home station/structure id, without the full clones+implants
/// fetch fetch_character_clones does - used by the map's home-base portrait
/// pins, which only need to know where to place a marker. Best-effort: no
/// token, missing scope, or no home location set all just mean no pin for
/// that character rather than an error.
pub async fn fetch_character_home_location_id(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Option<i64> {
    let access_token = get_access_token(client, config, character_id).await?;
    let raw = authorized_get::<EsiClonesResponse>(client, &access_token, &format!("/characters/{character_id}/clones/"))
        .await
        .ok()?;
    raw.home_location.map(|h| h.location_id)
}

pub async fn fetch_character_clones(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterClones, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterClones { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<EsiClonesResponse>(client, &access_token, &format!("/characters/{character_id}/clones/")).await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterClones { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    // Needs its own scope (esi-clones.read_implants.v1), separate from the
    // jump clones scope above - a character that hasn't reconnected since
    // this was added just shows no active-clone implants rather than losing
    // the whole tab, since jump clone data is still perfectly usable without it.
    let active_implant_ids: Vec<i64> =
        authorized_get::<Vec<i64>>(client, &access_token, &format!("/characters/{character_id}/implants/"))
            .await
            .unwrap_or_default();

    let mut lookup_ids: Vec<i64> = Vec::new();
    if let Some(home) = &raw.home_location {
        lookup_ids.push(home.location_id);
    }
    for jc in &raw.jump_clones {
        lookup_ids.push(jc.location_id);
        lookup_ids.extend(&jc.implants);
    }
    lookup_ids.extend(&active_implant_ids);
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut implant_ids: Vec<i64> = raw.jump_clones.iter().flat_map(|jc| jc.implants.iter().copied()).collect();
    implant_ids.extend(&active_implant_ids);
    implant_ids.sort_unstable();
    implant_ids.dedup();
    let implant_infos = fetch_implant_infos(client, &implant_ids).await;

    let mut active_implants: Vec<ImplantEntry> = active_implant_ids
        .iter()
        .map(|id| {
            let info = implant_infos.get(id);
            ImplantEntry {
                type_id: *id,
                name: names.get(id).cloned().unwrap_or_else(|| format!("Implant #{id}")),
                slot: info.map(|i| i.slot).unwrap_or(0),
                bonus_text: info.and_then(|i| i.bonus_text.clone()),
                attribute: info.and_then(|i| i.attribute.clone()),
                bonus: info.and_then(|i| i.bonus),
            }
        })
        .collect();
    active_implants.sort_by_key(|i| i.slot);

    let jump_clones = raw
        .jump_clones
        .into_iter()
        .map(|jc| {
            let mut implants: Vec<ImplantEntry> = jc
                .implants
                .iter()
                .map(|id| {
                    let info = implant_infos.get(id);
                    ImplantEntry {
                        type_id: *id,
                        name: names.get(id).cloned().unwrap_or_else(|| format!("Implant #{id}")),
                        slot: info.map(|i| i.slot).unwrap_or(0),
                        bonus_text: info.and_then(|i| i.bonus_text.clone()),
                        attribute: info.and_then(|i| i.attribute.clone()),
                        bonus: info.and_then(|i| i.bonus),
                    }
                })
                .collect();
            implants.sort_by_key(|i| i.slot);
            JumpCloneEntry {
                jump_clone_id: jc.jump_clone_id,
                name: jc.name,
                location_name: names.get(&jc.location_id).cloned().unwrap_or_else(|| location_fallback_name(jc.location_id)),
                implants,
            }
        })
        .collect();

    Ok(CharacterClones {
        home_location_name: raw.home_location.and_then(|h| names.get(&h.location_id).cloned()),
        active_implants,
        jump_clones,
        needs_reauth: false,
    })
}

#[derive(Deserialize)]
struct EsiAttributesResponse {
    charisma: i64,
    intelligence: i64,
    memory: i64,
    perception: i64,
    willpower: i64,
    bonus_remaps: i64,
    last_remap_date: Option<String>,
    accrued_remap_cooldown_date: Option<String>,
}

/// A character's 5 base attributes as ESI reports them - these are already
/// the post-remap base values (17 + whatever remap points were spent, per
/// EveConstants.CharacterBaseAttributePoints/SpareAttributePointsOnRemap in
/// EVEMon's source - not raw un-remapped 17s). Implant bonuses are separate
/// (see ImplantEntry.attribute/bonus from fetch_character_clones) since ESI's
/// attributes endpoint doesn't fold them in.
#[derive(Serialize, Default)]
pub struct CharacterAttributes {
    pub charisma: i64,
    pub intelligence: i64,
    pub memory: i64,
    pub perception: i64,
    pub willpower: i64,
    pub bonus_remaps: i64,
    pub last_remap_date: Option<String>,
    pub accrued_remap_cooldown_date: Option<String>,
    pub needs_reauth: bool,
}

/// Same auth pattern as fetch_character_clones: shares the skills scope
/// (esi-skills.read_skills.v1) already granted for the Skills/Queue tabs per
/// ESI's own endpoint grouping, so no new reconnect is expected - but if
/// that grouping assumption is ever wrong for some account, a missing-scope
/// response degrades to needs_reauth like every other tab, not a hard error.
pub async fn fetch_character_attributes(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterAttributes, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterAttributes { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<EsiAttributesResponse>(client, &access_token, &format!("/characters/{character_id}/attributes/"))
        .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterAttributes { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    Ok(CharacterAttributes {
        charisma: raw.charisma,
        intelligence: raw.intelligence,
        memory: raw.memory,
        perception: raw.perception,
        willpower: raw.willpower,
        bonus_remaps: raw.bonus_remaps,
        last_remap_date: raw.last_remap_date,
        accrued_remap_cooldown_date: raw.accrued_remap_cooldown_date,
        needs_reauth: false,
    })
}

#[derive(Deserialize)]
struct EsiResearchAgent {
    agent_id: i64,
    points_per_day: f64,
    remainder_points: f64,
    skill_type_id: i64,
    started_at: String,
}

#[derive(Serialize)]
pub struct ResearchAgentEntry {
    pub agent_id: i64,
    pub agent_name: String,
    pub skill_type_id: i64,
    pub skill_name: String,
    pub points_per_day: f64,
    pub current_points: f64,
    pub started_at: String,
}

#[derive(Serialize, Default)]
pub struct CharacterResearch {
    pub entries: Vec<ResearchAgentEntry>,
    pub needs_reauth: bool,
}

/// R&D agent research points - distinct from corp loyalty points (the LP
/// tab). Verified live against ESI's own OpenAPI spec (not guessed):
/// GET /characters/{id}/agents_research/, scope
/// esi-characters.read_agents_research.v1 - a scope no existing character
/// has yet, so this shows needs_reauth for everyone until they reconnect,
/// same as any other newly-added scope in this app's history.
pub async fn fetch_character_research(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterResearch, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterResearch { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiResearchAgent>>(client, &access_token, &format!("/characters/{character_id}/agents_research/"))
        .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterResearch { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.iter().map(|a| a.agent_id).collect();
    lookup_ids.extend(raw.iter().map(|a| a.skill_type_id));
    let names = resolve_names(client, lookup_ids).await;

    let entries = raw
        .into_iter()
        .map(|a| ResearchAgentEntry {
            agent_id: a.agent_id,
            agent_name: names.get(&a.agent_id).cloned().unwrap_or_else(|| format!("Agent #{}", a.agent_id)),
            skill_type_id: a.skill_type_id,
            skill_name: names.get(&a.skill_type_id).cloned().unwrap_or_else(|| format!("Skill #{}", a.skill_type_id)),
            points_per_day: a.points_per_day,
            current_points: a.remainder_points,
            started_at: a.started_at,
        })
        .collect();
    Ok(CharacterResearch { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiFwKillsOrPoints {
    yesterday: i64,
    last_week: i64,
    total: i64,
}

#[derive(Deserialize)]
struct EsiCharacterFwStats {
    // Confirmed live (not just per the OpenAPI spec, which marks these
    // "required" but is wrong here): a character who has never enlisted in
    // FW gets a response with ONLY kills/victory_points - current_rank,
    // highest_rank, faction_id, and enlisted_on are all absent, not zeroed.
    #[serde(default)]
    current_rank: Option<i64>,
    #[serde(default)]
    highest_rank: Option<i64>,
    #[serde(default)]
    enlisted_on: Option<String>,
    #[serde(default)]
    faction_id: Option<i64>,
    kills: EsiFwKillsOrPoints,
    victory_points: EsiFwKillsOrPoints,
}

#[derive(Serialize, Clone, Default)]
pub struct FwTally {
    pub yesterday: i64,
    pub last_week: i64,
    pub total: i64,
}

#[derive(Serialize, Default)]
pub struct CharacterFwStats {
    pub enlisted: bool,
    pub faction_name: Option<String>,
    pub enlisted_on: Option<String>,
    pub current_rank: Option<i64>,
    pub highest_rank: Option<i64>,
    pub kills: FwTally,
    pub victory_points: FwTally,
    pub needs_reauth: bool,
}

/// Verified live against ESI's own OpenAPI spec (not guessed, and not just
/// trusted from EVEMon's older/incomplete swagger client, which doesn't even
/// list this route - cross-checked against EveLens' current endpoint
/// reference too): GET /characters/{id}/fw/stats/, scope
/// esi-characters.read_fw_stats.v1. faction_id/enlisted_on are absent
/// (not merely zero/empty) when the character has never enlisted in FW.
pub async fn fetch_character_fw_stats(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterFwStats, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterFwStats { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<EsiCharacterFwStats>(client, &access_token, &format!("/characters/{character_id}/fw/stats/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterFwStats { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let faction_name = match raw.faction_id {
        Some(id) => resolve_names(client, vec![id]).await.get(&id).cloned(),
        None => None,
    };

    Ok(CharacterFwStats {
        enlisted: raw.faction_id.is_some(),
        faction_name,
        enlisted_on: raw.enlisted_on,
        current_rank: raw.current_rank,
        highest_rank: raw.highest_rank,
        kills: FwTally { yesterday: raw.kills.yesterday, last_week: raw.kills.last_week, total: raw.kills.total },
        victory_points: FwTally {
            yesterday: raw.victory_points.yesterday,
            last_week: raw.victory_points.last_week,
            total: raw.victory_points.total,
        },
        needs_reauth: false,
    })
}

#[derive(Deserialize)]
struct EsiStanding {
    from_id: i64,
    from_type: String,
    standing: f64,
}

#[derive(Serialize)]
pub struct StandingEntry {
    pub from_name: String,
    pub from_type: String,
    pub standing: f64,
}

#[derive(Serialize, Default)]
pub struct CharacterStandings {
    pub entries: Vec<StandingEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_standings(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterStandings, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterStandings { needs_reauth: true, ..Default::default() });
    };
    let raw =
        match authorized_get::<Vec<EsiStanding>>(client, &access_token, &format!("/characters/{character_id}/standings/")).await {
            Ok(v) => v,
            Err(EsiError::MissingScope) => return Ok(CharacterStandings { needs_reauth: true, ..Default::default() }),
            Err(EsiError::Failed(e)) => return Err(e),
        };
    let ids: Vec<i64> = raw.iter().map(|s| s.from_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<StandingEntry> = raw
        .into_iter()
        .map(|s| StandingEntry {
            from_name: names.get(&s.from_id).cloned().unwrap_or_else(|| format!("#{}", s.from_id)),
            from_type: s.from_type,
            standing: s.standing,
        })
        .collect();
    entries.sort_by(|a, b| b.standing.partial_cmp(&a.standing).unwrap_or(std::cmp::Ordering::Equal));
    Ok(CharacterStandings { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiContact {
    contact_id: i64,
    contact_type: String,
    standing: f64,
    #[serde(default)]
    is_watched: Option<bool>,
    #[serde(default)]
    is_blocked: Option<bool>,
}

#[derive(Serialize)]
pub struct ContactEntry {
    pub contact_id: i64,
    pub contact_name: String,
    pub contact_type: String,
    pub standing: f64,
    pub is_watched: bool,
    pub is_blocked: bool,
}

#[derive(Serialize, Default)]
pub struct CharacterContacts {
    pub entries: Vec<ContactEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_contacts(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterContacts, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterContacts { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get_paginated::<EsiContact>(client, &access_token, &format!("/characters/{character_id}/contacts/"))
        .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterContacts { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    let ids: Vec<i64> = raw.iter().map(|c| c.contact_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<ContactEntry> = raw
        .into_iter()
        .map(|c| ContactEntry {
            contact_id: c.contact_id,
            contact_name: names.get(&c.contact_id).cloned().unwrap_or_else(|| format!("#{}", c.contact_id)),
            contact_type: c.contact_type,
            standing: c.standing,
            is_watched: c.is_watched.unwrap_or(false),
            is_blocked: c.is_blocked.unwrap_or(false),
        })
        .collect();
    entries.sort_by(|a, b| b.standing.partial_cmp(&a.standing).unwrap_or(std::cmp::Ordering::Equal));
    Ok(CharacterContacts { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiMedal {
    title: String,
    description: String,
    corporation_id: i64,
    date: String,
    reason: String,
    status: String,
}

#[derive(Serialize)]
pub struct MedalEntry {
    pub title: String,
    pub description: String,
    pub corporation_name: String,
    pub date: String,
    pub reason: String,
    pub status: String,
}

#[derive(Serialize, Default)]
pub struct CharacterMedals {
    pub entries: Vec<MedalEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_medals(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterMedals, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterMedals { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiMedal>>(client, &access_token, &format!("/characters/{character_id}/medals/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterMedals { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    let ids: Vec<i64> = raw.iter().map(|m| m.corporation_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<MedalEntry> = raw
        .into_iter()
        .map(|m| MedalEntry {
            title: m.title,
            description: m.description,
            corporation_name: names.get(&m.corporation_id).cloned().unwrap_or_else(|| format!("Corporation #{}", m.corporation_id)),
            date: m.date,
            reason: m.reason,
            status: m.status,
        })
        .collect();
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(CharacterMedals { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiLoyaltyPoints {
    corporation_id: i64,
    loyalty_points: i64,
}

#[derive(Serialize)]
pub struct LoyaltyEntry {
    pub corporation_name: String,
    pub loyalty_points: i64,
}

#[derive(Serialize, Default)]
pub struct CharacterLoyalty {
    pub entries: Vec<LoyaltyEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_loyalty(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterLoyalty, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterLoyalty { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiLoyaltyPoints>>(client, &access_token, &format!("/characters/{character_id}/loyalty/points/"))
        .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterLoyalty { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    let ids: Vec<i64> = raw.iter().map(|l| l.corporation_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<LoyaltyEntry> = raw
        .into_iter()
        .map(|l| LoyaltyEntry {
            corporation_name: names.get(&l.corporation_id).cloned().unwrap_or_else(|| format!("Corporation #{}", l.corporation_id)),
            loyalty_points: l.loyalty_points,
        })
        .collect();
    entries.sort_by(|a, b| b.loyalty_points.cmp(&a.loyalty_points));
    Ok(CharacterLoyalty { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiAsset {
    item_id: i64,
    type_id: i64,
    quantity: i64,
    location_id: i64,
    location_flag: String,
}

#[derive(Serialize)]
pub struct AssetEntry {
    pub item_id: i64,
    pub type_id: i64,
    pub type_name: String,
    pub group_name: String,
    pub region_name: String,
    pub quantity: i64,
    pub location_name: String,
    pub location_flag: String,
}

#[derive(Serialize, Default)]
pub struct CharacterAssets {
    pub entries: Vec<AssetEntry>,
    pub needs_reauth: bool,
}

/// Assets are the one character list that can genuinely run into the
/// thousands, hence the paginated fetch. Not every location_id resolves -
/// a lot of them are other assets in this same list (a container sitting
/// in a hangar), which /universe/names/ has no concept of - those just
/// fall back to a raw id rather than failing the whole tab.
pub async fn fetch_character_assets(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterAssets, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterAssets { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get_paginated::<EsiAsset>(client, &access_token, &format!("/characters/{character_id}/assets/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterAssets { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let type_ids: Vec<i64> = raw.iter().map(|a| a.type_id).collect();
    let group_names = fetch_item_group_names(client, &type_ids).await;

    // Container/ship-nested assets have a location_id that's actually another
    // asset's item_id, not a real station/structure - walk each up to its
    // real root location before resolving a name or region for it. Also
    // sidesteps a real ESI quirk: /universe/names/ rejects its whole batch if
    // it contains even one id it can't categorize (nested item_ids qualify),
    // which would otherwise blank out every other item's name too.
    let item_locations: HashMap<i64, i64> = raw.iter().map(|a| (a.item_id, a.location_id)).collect();
    let root_locations: Vec<i64> = raw.iter().map(|a| resolve_root_location(&item_locations, a.location_id)).collect();
    let regions = fetch_location_regions(client, &access_token, &root_locations).await;

    let mut lookup_ids = type_ids.clone();
    lookup_ids.extend(root_locations.iter().copied());
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut entries: Vec<AssetEntry> = raw
        .into_iter()
        .zip(root_locations)
        .map(|(a, root_location)| AssetEntry {
            item_id: a.item_id,
            type_id: a.type_id,
            type_name: names.get(&a.type_id).cloned().unwrap_or_else(|| format!("Type #{}", a.type_id)),
            group_name: group_names.get(&a.type_id).cloned().unwrap_or_else(|| "Unknown".to_string()),
            region_name: regions.get(&root_location).cloned().unwrap_or_else(|| "Unknown Region".to_string()),
            quantity: a.quantity,
            location_name: names.get(&root_location).cloned().unwrap_or_else(|| location_fallback_name(root_location)),
            location_flag: a.location_flag,
        })
        .collect();
    entries.sort_by(|a, b| a.type_name.cmp(&b.type_name));
    Ok(CharacterAssets { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiOrder {
    order_id: i64,
    type_id: i64,
    location_id: i64,
    #[serde(default)]
    is_buy_order: Option<bool>,
    price: f64,
    volume_remain: i64,
    volume_total: i64,
    issued: String,
    duration: i64,
    range: String,
    /// Only present on /orders/history/ entries ("cancelled"/"expired") -
    /// the active-orders endpoint has no such field, so this stays None there
    /// and status falls back to "Active" below.
    #[serde(default)]
    state: Option<String>,
}

#[derive(Serialize)]
pub struct MarketOrderEntry {
    pub order_id: i64,
    pub type_id: i64,
    pub type_name: String,
    pub location_name: String,
    pub is_buy_order: bool,
    pub price: f64,
    pub volume_remain: i64,
    pub volume_total: i64,
    pub issued: String,
    pub duration: i64,
    pub range: String,
    pub status: String,
}

#[derive(Serialize, Default)]
pub struct CharacterMarketOrders {
    pub entries: Vec<MarketOrderEntry>,
    pub needs_reauth: bool,
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// EveLens only ever shows active orders (it lets closed ones linger client-side
/// for a few days rather than calling a history endpoint at all). This goes a
/// step further and also fetches /orders/history/ so past orders never just
/// vanish - a history hiccup only drops the history rows, never the active ones.
pub async fn fetch_character_market_orders(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterMarketOrders, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterMarketOrders { needs_reauth: true, ..Default::default() });
    };
    let active = match authorized_get::<Vec<EsiOrder>>(client, &access_token, &format!("/characters/{character_id}/orders/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterMarketOrders { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    let history = authorized_get_paginated::<EsiOrder>(client, &access_token, &format!("/characters/{character_id}/orders/history/"))
        .await
        .unwrap_or_default();

    let mut raw: Vec<(EsiOrder, bool)> = active.into_iter().map(|o| (o, true)).collect();
    raw.extend(history.into_iter().map(|o| (o, false)));

    let mut lookup_ids: Vec<i64> = raw.iter().map(|(o, _)| o.type_id).collect();
    lookup_ids.extend(raw.iter().map(|(o, _)| o.location_id));
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut entries: Vec<MarketOrderEntry> = raw
        .into_iter()
        .map(|(o, is_active)| MarketOrderEntry {
            order_id: o.order_id,
            type_id: o.type_id,
            type_name: names.get(&o.type_id).cloned().unwrap_or_else(|| format!("Type #{}", o.type_id)),
            location_name: names.get(&o.location_id).cloned().unwrap_or_else(|| location_fallback_name(o.location_id)),
            is_buy_order: o.is_buy_order.unwrap_or(false),
            price: o.price,
            volume_remain: o.volume_remain,
            volume_total: o.volume_total,
            issued: o.issued,
            duration: o.duration,
            range: o.range,
            status: if is_active { "Active".to_string() } else { o.state.as_deref().map(capitalize).unwrap_or_else(|| "Closed".to_string()) },
        })
        .collect();
    entries.sort_by(|a, b| b.issued.cmp(&a.issued));
    Ok(CharacterMarketOrders { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiContract {
    contract_id: i64,
    issuer_id: i64,
    #[serde(default)]
    assignee_id: Option<i64>,
    #[serde(rename = "type")]
    contract_type: String,
    status: String,
    #[serde(default)]
    title: Option<String>,
    date_issued: String,
    date_expired: String,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    reward: Option<f64>,
    #[serde(default)]
    start_location_id: Option<i64>,
    #[serde(default)]
    end_location_id: Option<i64>,
}

#[derive(Serialize)]
pub struct ContractEntry {
    pub contract_id: i64,
    pub issuer_name: String,
    pub assignee_name: Option<String>,
    pub contract_type: String,
    pub status: String,
    pub title: Option<String>,
    pub date_issued: String,
    pub date_expired: String,
    pub price: Option<f64>,
    pub reward: Option<f64>,
    pub start_location_name: Option<String>,
    pub end_location_name: Option<String>,
}

#[derive(Serialize, Default)]
pub struct CharacterContracts {
    pub entries: Vec<ContractEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_contracts(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterContracts, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterContracts { needs_reauth: true, ..Default::default() });
    };
    let raw =
        match authorized_get_paginated::<EsiContract>(client, &access_token, &format!("/characters/{character_id}/contracts/"))
            .await
        {
            Ok(v) => v,
            Err(EsiError::MissingScope) => return Ok(CharacterContracts { needs_reauth: true, ..Default::default() }),
            Err(EsiError::Failed(e)) => return Err(e),
        };

    let mut lookup_ids: Vec<i64> = raw.iter().map(|c| c.issuer_id).collect();
    lookup_ids.extend(raw.iter().filter_map(|c| c.assignee_id).filter(|&id| id != 0));
    lookup_ids.extend(raw.iter().filter_map(|c| c.start_location_id));
    lookup_ids.extend(raw.iter().filter_map(|c| c.end_location_id));
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut entries: Vec<ContractEntry> = raw
        .into_iter()
        .map(|c| ContractEntry {
            contract_id: c.contract_id,
            issuer_name: names.get(&c.issuer_id).cloned().unwrap_or_else(|| format!("#{}", c.issuer_id)),
            assignee_name: c.assignee_id.filter(|&id| id != 0).and_then(|id| names.get(&id).cloned()),
            contract_type: c.contract_type,
            status: c.status,
            title: c.title.filter(|t| !t.is_empty()),
            date_issued: c.date_issued,
            date_expired: c.date_expired,
            price: c.price,
            reward: c.reward,
            start_location_name: c.start_location_id.and_then(|id| names.get(&id).cloned()),
            end_location_name: c.end_location_id.and_then(|id| names.get(&id).cloned()),
        })
        .collect();
    entries.sort_by(|a, b| b.date_issued.cmp(&a.date_issued));
    Ok(CharacterContracts { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiContractItem {
    #[serde(default)]
    is_included: bool,
    quantity: i64,
    #[serde(default)]
    runs: Option<i32>,
    type_id: i64,
}

#[derive(Serialize)]
pub struct ContractItemEntry {
    pub type_id: i64,
    pub type_name: String,
    pub quantity: i64,
    pub is_included: bool,
    pub runs: Option<i32>,
}

/// Item list for one of a character's own item_exchange/auction contracts.
/// Courier contracts (and expired/deleted ones) 400 or 404 here - that's a
/// "nothing to show" case, not a real error, so it collapses to an empty list
/// rather than surfacing an error to the UI.
pub async fn fetch_contract_items(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
    contract_id: i64,
) -> Result<Vec<ContractItemEntry>, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(Vec::new());
    };
    let raw: Vec<EsiContractItem> = match authorized_get(
        client,
        &access_token,
        &format!("/characters/{character_id}/contracts/{contract_id}/items/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(Vec::new()),
        Err(EsiError::Failed(_)) => return Ok(Vec::new()),
    };
    let lookup_ids: Vec<i64> = raw.iter().map(|i| i.type_id).collect();
    let names = resolve_names(client, lookup_ids).await;
    let mut entries: Vec<ContractItemEntry> = raw
        .into_iter()
        .map(|i| ContractItemEntry {
            type_id: i.type_id,
            type_name: names.get(&i.type_id).cloned().unwrap_or_else(|| format!("Type #{}", i.type_id)),
            quantity: i.quantity,
            is_included: i.is_included,
            runs: i.runs,
        })
        .collect();
    entries.sort_by(|a, b| b.quantity.cmp(&a.quantity));
    Ok(entries)
}

#[derive(Deserialize)]
struct EsiPublicContract {
    contract_id: i64,
    #[serde(default)]
    collateral: f64,
    date_expired: String,
    date_issued: String,
    #[serde(default)]
    days_to_complete: i64,
    #[serde(default)]
    end_location_id: Option<i64>,
    issuer_corporation_id: i64,
    issuer_id: i64,
    #[serde(default)]
    price: f64,
    #[serde(default)]
    reward: f64,
    #[serde(default)]
    start_location_id: Option<i64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "type")]
    contract_type: String,
    #[serde(default)]
    volume: f64,
}

#[derive(Serialize, Clone)]
pub struct PublicContractEntry {
    pub contract_id: i64,
    pub contract_type: String,
    pub title: Option<String>,
    pub price: f64,
    pub reward: f64,
    pub collateral: f64,
    pub volume: f64,
    pub days_to_complete: i64,
    pub date_issued: String,
    pub date_expired: String,
    pub issuer_name: String,
    pub issuer_corporation_name: String,
    pub start_location_name: Option<String>,
    pub end_location_name: Option<String>,
}

/// Every public (item_exchange/courier/auction) contract in a region -
/// confirmed live via `/contracts/public/{region_id}/`, no auth needed for
/// the listing itself. Location names DO need a token if either end is a
/// player structure (same docking-access nuance as everywhere else this
/// app resolves structure names) - best-effort: with a token, structures
/// resolve too; without one, only NPC stations/normal entities do and a
/// structure location just falls back to its raw id.
pub async fn fetch_public_contracts(
    client: &reqwest::Client,
    region_id: i64,
    access_token: Option<&str>,
) -> Result<Vec<PublicContractEntry>, String> {
    let raw: Vec<EsiPublicContract> = public_get_paginated(client, &format!("/contracts/public/{region_id}/")).await?;

    let mut lookup_ids: Vec<i64> = raw.iter().map(|c| c.issuer_id).collect();
    lookup_ids.extend(raw.iter().map(|c| c.issuer_corporation_id));
    lookup_ids.extend(raw.iter().filter_map(|c| c.start_location_id));
    lookup_ids.extend(raw.iter().filter_map(|c| c.end_location_id));

    let names = match access_token {
        Some(token) => resolve_names_with_structures(client, token, lookup_ids).await,
        None => resolve_names(client, lookup_ids).await,
    };

    let mut entries: Vec<PublicContractEntry> = raw
        .into_iter()
        .map(|c| PublicContractEntry {
            contract_id: c.contract_id,
            contract_type: c.contract_type,
            title: c.title.filter(|t| !t.is_empty()),
            price: c.price,
            reward: c.reward,
            collateral: c.collateral,
            volume: c.volume,
            days_to_complete: c.days_to_complete,
            date_issued: c.date_issued,
            date_expired: c.date_expired,
            issuer_name: names.get(&c.issuer_id).cloned().unwrap_or_else(|| format!("#{}", c.issuer_id)),
            issuer_corporation_name: names
                .get(&c.issuer_corporation_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", c.issuer_corporation_id)),
            start_location_name: c.start_location_id.and_then(|id| names.get(&id).cloned()),
            end_location_name: c.end_location_id.and_then(|id| names.get(&id).cloned()),
        })
        .collect();
    entries.sort_by(|a, b| b.date_issued.cmp(&a.date_issued));
    Ok(entries)
}

#[derive(Deserialize)]
struct EsiCalendarEvent {
    event_id: i64,
    event_date: String,
    title: String,
    importance: i64,
    event_response: String,
}

#[derive(Serialize, Clone)]
pub struct CalendarEventSummary {
    pub event_id: i64,
    pub event_date: String,
    pub title: String,
    pub importance: i64,
    pub event_response: String,
}

#[derive(Serialize, Default)]
pub struct CharacterCalendar {
    pub entries: Vec<CalendarEventSummary>,
    pub needs_reauth: bool,
}

/// ESI's calendar list returns "the next 50 chronological events from now" -
/// plenty for an upcoming-events view without needing the from_event cursor
/// pagination for a typical character's calendar load.
pub async fn fetch_character_calendar(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterCalendar, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterCalendar { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiCalendarEvent>>(client, &access_token, &format!("/characters/{character_id}/calendar/"))
        .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterCalendar { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut entries: Vec<CalendarEventSummary> = raw
        .into_iter()
        .map(|e| CalendarEventSummary {
            event_id: e.event_id,
            event_date: e.event_date,
            title: e.title,
            importance: e.importance,
            event_response: e.event_response,
        })
        .collect();
    entries.sort_by(|a, b| a.event_date.cmp(&b.event_date));
    Ok(CharacterCalendar { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiCalendarEventDetail {
    event_id: i64,
    date: String,
    title: String,
    text: String,
    duration: i64,
    importance: i64,
    response: String,
    owner_id: i64,
    owner_name: String,
    owner_type: String,
}

#[derive(Serialize)]
pub struct CalendarEventDetail {
    pub event_id: i64,
    pub date: String,
    pub title: String,
    pub text: String,
    pub duration: i64,
    pub importance: i64,
    pub response: String,
    pub owner_id: i64,
    pub owner_name: String,
    pub owner_type: String,
}

pub async fn fetch_calendar_event_detail(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
    event_id: i64,
) -> Result<CalendarEventDetail, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Err("This character needs to reconnect to view calendar events.".to_string());
    };
    let e = match authorized_get::<EsiCalendarEventDetail>(
        client,
        &access_token,
        &format!("/characters/{character_id}/calendar/{event_id}/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Err("This character needs to reconnect to view calendar events.".to_string()),
        Err(EsiError::Failed(err)) => return Err(err),
    };
    Ok(CalendarEventDetail {
        event_id: e.event_id,
        date: e.date,
        title: e.title,
        text: mail_body_to_text(&e.text),
        duration: e.duration,
        importance: e.importance,
        response: e.response,
        owner_id: e.owner_id,
        owner_name: e.owner_name,
        owner_type: e.owner_type,
    })
}

#[derive(Deserialize)]
struct EsiIndustryJob {
    job_id: i64,
    activity_id: i64,
    blueprint_type_id: i64,
    #[serde(default)]
    product_type_id: Option<i64>,
    station_id: i64,
    status: String,
    runs: i64,
    start_date: String,
    end_date: String,
}

#[derive(Serialize)]
pub struct IndustryJobEntry {
    pub job_id: i64,
    pub activity_name: String,
    pub blueprint_type_name: String,
    pub product_type_name: Option<String>,
    pub station_name: String,
    pub status: String,
    pub runs: i64,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Serialize, Default)]
pub struct CharacterIndustryJobs {
    pub entries: Vec<IndustryJobEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_industry_jobs(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterIndustryJobs, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterIndustryJobs { needs_reauth: true, ..Default::default() });
    };
    // include_completed=true so finished jobs stay visible until delivered,
    // matching what a player expects to see, not just currently-running ones.
    let raw = match authorized_get::<Vec<EsiIndustryJob>>(
        client,
        &access_token,
        &format!("/characters/{character_id}/industry/jobs/?include_completed=true"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterIndustryJobs { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.iter().map(|j| j.blueprint_type_id).collect();
    lookup_ids.extend(raw.iter().filter_map(|j| j.product_type_id));
    lookup_ids.extend(raw.iter().map(|j| j.station_id));
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut entries: Vec<IndustryJobEntry> = raw
        .into_iter()
        .map(|j| IndustryJobEntry {
            job_id: j.job_id,
            activity_name: industry_activity_name(j.activity_id).to_string(),
            blueprint_type_name: names
                .get(&j.blueprint_type_id)
                .cloned()
                .unwrap_or_else(|| format!("Type #{}", j.blueprint_type_id)),
            product_type_name: j.product_type_id.and_then(|id| names.get(&id).cloned()),
            station_name: names.get(&j.station_id).cloned().unwrap_or_else(|| location_fallback_name(j.station_id)),
            status: j.status,
            runs: j.runs,
            start_date: j.start_date,
            end_date: j.end_date,
        })
        .collect();
    entries.sort_by(|a, b| b.start_date.cmp(&a.start_date));
    Ok(CharacterIndustryJobs { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiTransaction {
    transaction_id: i64,
    date: String,
    type_id: i64,
    location_id: i64,
    quantity: i64,
    unit_price: f64,
    client_id: i64,
    is_buy: bool,
}

#[derive(Serialize)]
pub struct TransactionEntry {
    pub transaction_id: i64,
    pub date: String,
    pub type_id: i64,
    pub type_name: String,
    pub location_name: String,
    pub quantity: i64,
    pub unit_price: f64,
    pub client_name: String,
    pub is_buy: bool,
}

#[derive(Serialize, Default)]
pub struct CharacterTransactions {
    pub entries: Vec<TransactionEntry>,
    pub needs_reauth: bool,
}

/// Just the most recent batch (ESI returns up to ~2500 in one call, cursor-
/// paginated via a `from_id` param for anything older) - a full backward
/// walk isn't worth it for what's meant to be a "recent activity" tab.
pub async fn fetch_character_transactions(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterTransactions, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterTransactions { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiTransaction>>(
        client,
        &access_token,
        &format!("/characters/{character_id}/wallet/transactions/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterTransactions { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.iter().map(|t| t.type_id).collect();
    lookup_ids.extend(raw.iter().map(|t| t.location_id));
    lookup_ids.extend(raw.iter().map(|t| t.client_id));
    let names = resolve_names_with_structures(client, &access_token, lookup_ids).await;

    let mut entries: Vec<TransactionEntry> = raw
        .into_iter()
        .map(|t| TransactionEntry {
            transaction_id: t.transaction_id,
            date: t.date,
            type_id: t.type_id,
            type_name: names.get(&t.type_id).cloned().unwrap_or_else(|| format!("Type #{}", t.type_id)),
            location_name: names.get(&t.location_id).cloned().unwrap_or_else(|| location_fallback_name(t.location_id)),
            quantity: t.quantity,
            unit_price: t.unit_price,
            client_name: names.get(&t.client_id).cloned().unwrap_or_else(|| format!("#{}", t.client_id)),
            is_buy: t.is_buy,
        })
        .collect();
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(CharacterTransactions { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiWalletJournalEntry {
    id: i64,
    date: String,
    ref_type: String,
    #[serde(default)]
    amount: Option<f64>,
    #[serde(default)]
    balance: Option<f64>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    first_party_id: Option<i64>,
    #[serde(default)]
    second_party_id: Option<i64>,
}

#[derive(Serialize)]
pub struct WalletJournalEntry {
    pub id: i64,
    pub date: String,
    pub ref_type: String,
    pub amount: f64,
    pub balance: Option<f64>,
    pub description: String,
    pub first_party_name: Option<String>,
    pub second_party_name: Option<String>,
}

#[derive(Serialize, Default)]
pub struct CharacterWalletJournal {
    pub entries: Vec<WalletJournalEntry>,
    pub needs_reauth: bool,
}

/// The full wallet ledger (bounties, contracts, insurance, taxes, market
/// transactions, everything) - a broader, different data source than
/// Transactions, which is market buy/sell trades only. This is what EveLens'
/// "Wallet" tab actually shows (it's not a balance card or a chart there).
pub async fn fetch_character_wallet_journal(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterWalletJournal, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterWalletJournal { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get_paginated::<EsiWalletJournalEntry>(
        client,
        &access_token,
        &format!("/characters/{character_id}/wallet/journal/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterWalletJournal { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.iter().filter_map(|e| e.first_party_id).filter(|&id| id != 0).collect();
    lookup_ids.extend(raw.iter().filter_map(|e| e.second_party_id).filter(|&id| id != 0));
    let names = resolve_names(client, lookup_ids).await;

    let mut entries: Vec<WalletJournalEntry> = raw
        .into_iter()
        .map(|e| WalletJournalEntry {
            id: e.id,
            date: e.date,
            ref_type: e.ref_type,
            amount: e.amount.unwrap_or(0.0),
            balance: e.balance,
            description: e.reason.filter(|r| !r.is_empty()).or(e.description).unwrap_or_default(),
            first_party_name: e.first_party_id.filter(|&id| id != 0).and_then(|id| names.get(&id).cloned()),
            second_party_name: e.second_party_id.filter(|&id| id != 0).and_then(|id| names.get(&id).cloned()),
        })
        .collect();
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(CharacterWalletJournal { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiMailHeader {
    mail_id: i64,
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    is_read: Option<bool>,
}

#[derive(Serialize)]
pub struct MailEntry {
    pub mail_id: i64,
    pub from_name: String,
    pub subject: String,
    pub timestamp: Option<String>,
    pub is_read: bool,
}

#[derive(Serialize, Default)]
pub struct CharacterMail {
    pub entries: Vec<MailEntry>,
    pub needs_reauth: bool,
}

/// Just the most recent ~50 (ESI's default page, cursor-paginated via
/// `last_mail_id` for older) - same "recent activity" reasoning as
/// transactions above, and mail bodies aren't fetched at all here, only
/// headers, matching what a first pass at this tab needs.
pub async fn fetch_character_mail(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterMail, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterMail { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiMailHeader>>(client, &access_token, &format!("/characters/{character_id}/mail/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterMail { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let ids: Vec<i64> = raw.iter().filter_map(|m| m.from).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<MailEntry> = raw
        .into_iter()
        .map(|m| MailEntry {
            mail_id: m.mail_id,
            from_name: m.from.and_then(|id| names.get(&id).cloned()).unwrap_or_else(|| "Unknown".to_string()),
            subject: m.subject.filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".to_string()),
            timestamp: m.timestamp,
            is_read: m.is_read.unwrap_or(true),
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(CharacterMail { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiMailRecipient {
    recipient_id: i64,
}

#[derive(Deserialize)]
struct EsiMailBody {
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    recipients: Vec<EsiMailRecipient>,
}

#[derive(Serialize, Default)]
pub struct MailDetail {
    pub mail_id: i64,
    pub from_name: String,
    pub subject: String,
    pub timestamp: Option<String>,
    pub body_text: String,
    pub recipient_names: Vec<String>,
    pub needs_reauth: bool,
}

/// EVE mail bodies are raw, player-authored markup (<br>, <font>, <a
/// href="showinfo:...">, <loc> item/character links) that ESI does not
/// sanitize - rendering that directly as HTML in the app's webview would let
/// any sender inject arbitrary script into a context that has Tauri IPC
/// access. Stripping every tag down to plain text sidesteps that risk
/// entirely rather than trying to sanitize markup we'd need to keep re-auditing.
fn mail_body_to_text(html: &str) -> String {
    let normalized = html.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n");
    let mut result = String::with_capacity(normalized.len());
    let mut in_tag = false;
    for ch in normalized.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

/// A single mail's full body, fetched on demand when the user clicks into a
/// message from the Mail tab's list - the list itself only ever loads headers.
pub async fn fetch_mail_detail(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
    mail_id: i64,
) -> Result<MailDetail, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(MailDetail { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<EsiMailBody>(client, &access_token, &format!("/characters/{character_id}/mail/{mail_id}/")).await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(MailDetail { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.from.into_iter().collect();
    lookup_ids.extend(raw.recipients.iter().map(|r| r.recipient_id));
    let names = resolve_names(client, lookup_ids).await;

    Ok(MailDetail {
        mail_id,
        from_name: raw.from.and_then(|id| names.get(&id).cloned()).unwrap_or_else(|| "Unknown".to_string()),
        subject: raw.subject.filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".to_string()),
        timestamp: raw.timestamp,
        body_text: mail_body_to_text(&raw.body.unwrap_or_default()),
        recipient_names: raw
            .recipients
            .iter()
            .map(|r| names.get(&r.recipient_id).cloned().unwrap_or_else(|| format!("#{}", r.recipient_id)))
            .collect(),
        needs_reauth: false,
    })
}

/// Splits an ESI notification type's PascalCase code ("StructureUnderAttack")
/// into readable words ("Structure Under Attack") - there's no ESI-provided
/// display name for these, only the raw enum value.
fn humanize_notification_type(raw: &str) -> String {
    let mut result = String::with_capacity(raw.len() + 8);
    for (i, ch) in raw.trim().chars().enumerate() {
        if i > 0 && ch.is_uppercase() {
            result.push(' ');
        }
        result.push(ch);
    }
    result
}

#[derive(Deserialize)]
struct EsiNotification {
    notification_id: i64,
    sender_id: i64,
    #[serde(rename = "type")]
    notification_type: String,
    timestamp: String,
    #[serde(default)]
    is_read: Option<bool>,
}

#[derive(Serialize)]
pub struct NotificationEntry {
    pub notification_id: i64,
    pub sender_name: String,
    pub notification_type: String,
    pub timestamp: String,
    pub is_read: bool,
}

#[derive(Serialize, Default)]
pub struct CharacterNotifications {
    pub entries: Vec<NotificationEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_notifications(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterNotifications, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterNotifications { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiNotification>>(
        client,
        &access_token,
        &format!("/characters/{character_id}/notifications/"),
    )
    .await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterNotifications { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let ids: Vec<i64> = raw.iter().map(|n| n.sender_id).collect();
    let names = resolve_names(client, ids).await;

    let mut entries: Vec<NotificationEntry> = raw
        .into_iter()
        .map(|n| NotificationEntry {
            notification_id: n.notification_id,
            sender_name: names.get(&n.sender_id).cloned().unwrap_or_else(|| "EVE System".to_string()),
            notification_type: humanize_notification_type(&n.notification_type),
            timestamp: n.timestamp,
            is_read: n.is_read.unwrap_or(true),
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(CharacterNotifications { entries, needs_reauth: false })
}

#[derive(Deserialize)]
struct EsiPlanet {
    planet_id: i64,
    solar_system_id: i64,
    planet_type: String,
    upgrade_level: i64,
    num_pins: i64,
    last_update: String,
}

#[derive(Serialize)]
pub struct PlanetEntry {
    pub planet_name: String,
    pub solar_system_name: String,
    pub planet_type: String,
    pub upgrade_level: i64,
    pub num_pins: i64,
    pub last_update: String,
}

#[derive(Serialize, Default)]
pub struct CharacterPlanets {
    pub entries: Vec<PlanetEntry>,
    pub needs_reauth: bool,
}

pub async fn fetch_character_planets(client: &reqwest::Client, config: &SsoConfig, character_id: i64) -> Result<CharacterPlanets, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterPlanets { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiPlanet>>(client, &access_token, &format!("/characters/{character_id}/planets/")).await {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterPlanets { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };

    let mut lookup_ids: Vec<i64> = raw.iter().map(|p| p.planet_id).collect();
    lookup_ids.extend(raw.iter().map(|p| p.solar_system_id));
    let names = resolve_names(client, lookup_ids).await;

    let mut entries: Vec<PlanetEntry> = raw
        .into_iter()
        .map(|p| PlanetEntry {
            planet_name: names.get(&p.planet_id).cloned().unwrap_or_else(|| format!("Planet #{}", p.planet_id)),
            solar_system_name: names
                .get(&p.solar_system_id)
                .cloned()
                .unwrap_or_else(|| format!("System #{}", p.solar_system_id)),
            planet_type: p.planet_type,
            upgrade_level: p.upgrade_level,
            num_pins: p.num_pins,
            last_update: p.last_update,
        })
        .collect();
    entries.sort_by(|a, b| a.solar_system_name.cmp(&b.solar_system_name));
    Ok(CharacterPlanets { entries, needs_reauth: false })
}

/// Same contract as authorized_get, but for the one write call this app
/// makes (pushing a fit to a character's in-game Fittings browser) -
/// everything else ESI-facing here is read-only.
async fn authorized_post<B: Serialize + ?Sized, T: DeserializeOwned>(
    client: &reqwest::Client,
    access_token: &str,
    path: &str,
    body: &B,
) -> Result<T, EsiError> {
    let mut attempt = 0;
    loop {
        let response = match client.post(format!("{ESI_BASE}{path}")).bearer_auth(access_token).json(body).send().await {
            Ok(r) => r,
            Err(e) => {
                if retry_delay(attempt).await {
                    attempt += 1;
                    continue;
                }
                return Err(EsiError::Failed(format!("ESI request failed: {e}")));
            }
        };
        if matches!(response.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
            return Err(EsiError::MissingScope);
        }
        if is_retryable_status(response.status()) && retry_delay(attempt).await {
            attempt += 1;
            continue;
        }
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(EsiError::Failed(format!("ESI {status} on {path}: {text}")));
        }
        return response
            .json::<T>()
            .await
            .map_err(|e| EsiError::Failed(format!("failed to parse ESI response from {path}: {e}")));
    }
}

#[derive(Deserialize)]
struct EsiFittingItem {
    type_id: i64,
    flag: String,
    quantity: i64,
}

#[derive(Deserialize)]
struct EsiFitting {
    fitting_id: i64,
    name: String,
    description: String,
    ship_type_id: i64,
    items: Vec<EsiFittingItem>,
}

#[derive(Serialize, Clone)]
pub struct FitItemEntry {
    pub type_id: i64,
    pub flag: String,
    pub quantity: i64,
}

#[derive(Serialize, Clone)]
pub struct CharacterFittingEntry {
    pub fitting_id: i64,
    pub name: String,
    pub description: String,
    pub ship_type_id: i64,
    pub items: Vec<FitItemEntry>,
}

#[derive(Serialize, Default)]
pub struct CharacterFittings {
    pub entries: Vec<CharacterFittingEntry>,
    pub needs_reauth: bool,
}

/// A character's own saved in-game fits - not paginated, ESI returns the
/// whole list in one call (typically a few dozen at most).
pub async fn fetch_character_fittings(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<CharacterFittings, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Ok(CharacterFittings { needs_reauth: true, ..Default::default() });
    };
    let raw = match authorized_get::<Vec<EsiFitting>>(client, &access_token, &format!("/characters/{character_id}/fittings/")).await
    {
        Ok(v) => v,
        Err(EsiError::MissingScope) => return Ok(CharacterFittings { needs_reauth: true, ..Default::default() }),
        Err(EsiError::Failed(e)) => return Err(e),
    };
    let entries = raw
        .into_iter()
        .map(|f| CharacterFittingEntry {
            fitting_id: f.fitting_id,
            name: f.name,
            description: f.description,
            ship_type_id: f.ship_type_id,
            items: f.items.into_iter().map(|i| FitItemEntry { type_id: i.type_id, flag: i.flag, quantity: i.quantity }).collect(),
        })
        .collect();
    Ok(CharacterFittings { entries, needs_reauth: false })
}

#[derive(Serialize)]
struct EsiFittingItemPayload {
    type_id: i64,
    flag: String,
    quantity: i64,
}

#[derive(Serialize)]
struct EsiFittingPayload {
    name: String,
    description: String,
    ship_type_id: i64,
    items: Vec<EsiFittingItemPayload>,
}

#[derive(Deserialize)]
struct EsiFittingCreated {
    fitting_id: i64,
}

/// Pushes a fit directly into a character's in-game Fittings browser -
/// this is the actual "send to character" mechanism (ESI's real write
/// endpoint), no copy/paste through the client needed. Requires
/// esi-fittings.write_fittings.v1.
pub async fn create_character_fitting(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
    name: &str,
    description: &str,
    ship_type_id: i64,
    items: &[FitItemEntry],
) -> Result<i64, String> {
    let Some(access_token) = get_access_token(client, config, character_id).await else {
        return Err("This character needs to reconnect to send fits in-game.".to_string());
    };
    let payload = EsiFittingPayload {
        name: name.to_string(),
        description: description.to_string(),
        ship_type_id,
        items: items.iter().map(|i| EsiFittingItemPayload { type_id: i.type_id, flag: i.flag.clone(), quantity: i.quantity }).collect(),
    };
    match authorized_post::<EsiFittingPayload, EsiFittingCreated>(
        client,
        &access_token,
        &format!("/characters/{character_id}/fittings/"),
        &payload,
    )
    .await
    {
        Ok(v) => Ok(v.fitting_id),
        Err(EsiError::MissingScope) => Err("This character needs to reconnect to send fits in-game.".to_string()),
        Err(EsiError::Failed(e)) => Err(e),
    }
}
