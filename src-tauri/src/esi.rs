use crate::auth::{self, sso::SsoConfig};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ESI_BASE: &str = "https://esi.evetech.net/latest";

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
    let response = client
        .get(format!("{ESI_BASE}{path}"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| EsiError::Failed(format!("ESI request failed: {e}")))?;

    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(EsiError::MissingScope);
    }
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(EsiError::Failed(format!("ESI {status} on {path}: {text}")));
    }

    response
        .json::<T>()
        .await
        .map_err(|e| EsiError::Failed(format!("failed to parse ESI response from {path}: {e}")))
}

async fn public_get<T: DeserializeOwned>(client: &reqwest::Client, path: &str) -> Result<T, String> {
    let response = client
        .get(format!("{ESI_BASE}{path}"))
        .send()
        .await
        .map_err(|e| format!("ESI request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("ESI {status} on {path}: {text}"));
    }
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to parse ESI response from {path}: {e}"))
}

#[derive(Deserialize)]
struct SkillsResponse {
    total_sp: i64,
}

#[derive(Deserialize)]
struct SkillQueueEntry {
    skill_id: i64,
    queue_position: i32,
    finish_date: Option<String>,
}

#[derive(Deserialize)]
struct LocationResponse {
    solar_system_id: i64,
}

#[derive(Deserialize)]
struct ShipResponse {
    ship_type_id: i64,
}

#[derive(Deserialize)]
struct CharacterPublicInfo {
    corporation_id: i64,
    alliance_id: Option<i64>,
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
    pub ship_type_name: Option<String>,
    pub system_name: Option<String>,
    pub corporation_name: Option<String>,
    pub alliance_name: Option<String>,
    pub needs_reauth: bool,
}

async fn resolve_names(client: &reqwest::Client, ids: Vec<i64>) -> HashMap<i64, String> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let result = client
        .post(format!("{ESI_BASE}/universe/names/"))
        .json(&ids)
        .send()
        .await;

    let Ok(response) = result else { return HashMap::new() };
    if !response.status().is_success() {
        return HashMap::new();
    }
    match response.json::<Vec<UniverseName>>().await {
        Ok(names) => names.into_iter().map(|n| (n.id, n.name)).collect(),
        Err(_) => HashMap::new(),
    }
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
    //
    // Any failure to get a usable token here (no stored entry, a failed
    // refresh) is treated the same as a missing scope: the fix is the same
    // "sign in again" action, so it should produce the same needs_reauth
    // card rather than a hard error with no actionable button.
    let access_token = match auth::ensure_fresh_token(client, config, character_id).await {
        Ok(()) => auth::keychain::load_tokens(character_id).ok().flatten().map(|t| t.access_token),
        Err(_) => None,
    };
    let Some(access_token) = access_token else {
        return Ok(CharacterOverview { character_id, needs_reauth: true, ..Default::default() });
    };
    let access_token = access_token.as_str();

    let mut overview = CharacterOverview { character_id, ..Default::default() };
    let mut lookup_ids: Vec<i64> = Vec::new();
    let mut current_skill_id: Option<i64> = None;
    let mut system_id: Option<i64> = None;
    let mut ship_type_id: Option<i64> = None;

    match authorized_get::<f64>(client, access_token, &format!("/characters/{character_id}/wallet/")).await {
        Ok(v) => overview.isk_balance = Some(v),
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match authorized_get::<SkillsResponse>(client, access_token, &format!("/characters/{character_id}/skills/")).await {
        Ok(v) => overview.total_sp = Some(v.total_sp),
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match authorized_get::<Vec<SkillQueueEntry>>(client, access_token, &format!("/characters/{character_id}/skillqueue/"))
        .await
    {
        Ok(entries) => {
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

    match authorized_get::<LocationResponse>(client, access_token, &format!("/characters/{character_id}/location/")).await
    {
        Ok(v) => {
            system_id = Some(v.solar_system_id);
            lookup_ids.push(v.solar_system_id);
        }
        Err(EsiError::MissingScope) => overview.needs_reauth = true,
        Err(EsiError::Failed(e)) => return Err(e),
    }

    match authorized_get::<ShipResponse>(client, access_token, &format!("/characters/{character_id}/ship/")).await {
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

    let names = resolve_names(client, lookup_ids).await;

    overview.training_skill_name = current_skill_id.and_then(|id| names.get(&id).cloned());
    overview.system_name = system_id.and_then(|id| names.get(&id).cloned());
    overview.ship_type_name = ship_type_id.and_then(|id| names.get(&id).cloned());
    overview.corporation_name = names.get(&public_info.corporation_id).cloned();
    overview.alliance_name = public_info.alliance_id.and_then(|id| names.get(&id).cloned());

    Ok(overview)
}
