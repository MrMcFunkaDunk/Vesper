use crate::{auth, characters, config, esi, kills, map, route};
use serde::Serialize;
use tauri::{AppHandle, State};

pub struct AppState {
    pub http_client: reqwest::Client,
}

fn portrait_url(id: i64) -> String {
    format!("https://images.evetech.net/characters/{id}/portrait?size=128")
}

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    state: State<'_, AppState>,
    scopes: Vec<String>,
) -> Result<(), String> {
    let config = config::load()?;
    let outcome = auth::login(&state.http_client, &config, scopes).await?;

    characters::upsert_character(
        &app,
        characters::CharacterRecord {
            id: outcome.character_id,
            name: outcome.character_name,
            scopes: outcome.scopes,
            added_at: now_unix(),
        },
    )?;
    characters::set_active(&app, outcome.character_id)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_login() {
    auth::cancel_login();
}

#[tauri::command]
pub async fn get_server_status(state: State<'_, AppState>) -> Result<esi::ServerStatus, String> {
    Ok(esi::fetch_server_status(&state.http_client).await)
}

#[derive(Serialize)]
pub struct SessionCharacter {
    pub id: i64,
    pub name: String,
    pub scopes: Vec<String>,
    pub portrait_url: String,
}

#[derive(Serialize)]
pub struct Session {
    pub characters: Vec<SessionCharacter>,
    pub active_character_id: Option<i64>,
}

#[tauri::command]
pub async fn get_session(app: AppHandle, state: State<'_, AppState>) -> Result<Session, String> {
    let (records, active_id) = characters::list_characters(&app)?;
    let config = config::load()?;

    let mut out = Vec::with_capacity(records.len());
    for record in records {
        // Best-effort silent refresh; a failure here (e.g. revoked token) still
        // lets the character show up, just without a guaranteed-fresh session.
        let _ = auth::ensure_fresh_token(&state.http_client, &config, record.id).await;
        out.push(SessionCharacter {
            id: record.id,
            name: record.name,
            scopes: record.scopes,
            portrait_url: portrait_url(record.id),
        });
    }

    Ok(Session { characters: out, active_character_id: active_id })
}

#[tauri::command]
pub fn set_active_character(app: AppHandle, id: i64) -> Result<(), String> {
    characters::set_active(&app, id)
}

#[tauri::command]
pub fn logout_character(app: AppHandle, id: i64) -> Result<(), String> {
    auth::keychain::delete_tokens(id)?;
    characters::remove_character(&app, id)
}

#[tauri::command]
pub async fn get_character_overview(
    state: State<'_, AppState>,
    id: i64,
) -> Result<esi::CharacterOverview, String> {
    let config = config::load()?;
    esi::fetch_character_overview(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_skills(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterSkills, String> {
    let config = config::load()?;
    esi::fetch_character_skills(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_all_skills(state: State<'_, AppState>) -> Result<Vec<esi::AllSkillEntry>, String> {
    esi::fetch_all_skills(&state.http_client).await
}

#[tauri::command]
pub async fn get_character_skill_queue(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterSkillQueue, String> {
    let config = config::load()?;
    esi::fetch_character_skill_queue(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_employment_history(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<esi::EmploymentEntry>, String> {
    esi::fetch_character_employment_history(&state.http_client, id).await
}

#[tauri::command]
pub async fn get_character_clones(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterClones, String> {
    let config = config::load()?;
    esi::fetch_character_clones(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_standings(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterStandings, String> {
    let config = config::load()?;
    esi::fetch_character_standings(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_contacts(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterContacts, String> {
    let config = config::load()?;
    esi::fetch_character_contacts(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_medals(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMedals, String> {
    let config = config::load()?;
    esi::fetch_character_medals(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_loyalty(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterLoyalty, String> {
    let config = config::load()?;
    esi::fetch_character_loyalty(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_assets(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterAssets, String> {
    let config = config::load()?;
    esi::fetch_character_assets(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_market_orders(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMarketOrders, String> {
    let config = config::load()?;
    esi::fetch_character_market_orders(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_contracts(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterContracts, String> {
    let config = config::load()?;
    esi::fetch_character_contracts(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_industry_jobs(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterIndustryJobs, String> {
    let config = config::load()?;
    esi::fetch_character_industry_jobs(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_transactions(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterTransactions, String> {
    let config = config::load()?;
    esi::fetch_character_transactions(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_wallet_journal(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterWalletJournal, String> {
    let config = config::load()?;
    esi::fetch_character_wallet_journal(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_mail(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMail, String> {
    let config = config::load()?;
    esi::fetch_character_mail(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_mail_detail(state: State<'_, AppState>, id: i64, mail_id: i64) -> Result<esi::MailDetail, String> {
    let config = config::load()?;
    esi::fetch_mail_detail(&state.http_client, &config, id, mail_id).await
}

#[tauri::command]
pub async fn get_character_notifications(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterNotifications, String> {
    let config = config::load()?;
    esi::fetch_character_notifications(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_planets(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterPlanets, String> {
    let config = config::load()?;
    esi::fetch_character_planets(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn search_system(state: State<'_, AppState>, name: String) -> Result<Option<kills::SystemMatch>, String> {
    kills::search_system(&state.http_client, &name).await
}

#[tauri::command]
pub async fn get_recent_kills(
    state: State<'_, AppState>,
    system_ids: Vec<i64>,
) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_recent_kills(&state.http_client, &system_ids).await
}

#[tauri::command]
pub async fn get_kill_detail(state: State<'_, AppState>, killmail_id: i64) -> Result<kills::KillDetail, String> {
    kills::fetch_kill_detail(&state.http_client, killmail_id).await
}

#[tauri::command]
pub async fn get_recent_activity_kills(state: State<'_, AppState>) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_recent_activity(&state.http_client).await
}

#[tauri::command]
pub async fn poll_recent_activity_kills(state: State<'_, AppState>) -> Result<Vec<kills::KillEntry>, String> {
    kills::poll_recent_activity(&state.http_client).await
}

#[tauri::command]
pub async fn poll_tracked_system_kills(
    state: State<'_, AppState>,
    system_ids: Vec<i64>,
) -> Result<Vec<kills::KillEntry>, String> {
    kills::poll_tracked_systems(&state.http_client, &system_ids).await
}

#[tauri::command]
pub async fn get_character_profile(state: State<'_, AppState>, character_id: i64) -> Result<kills::CharacterProfile, String> {
    kills::fetch_character_profile(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn get_character_kills(state: State<'_, AppState>, character_id: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_character_kills(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn get_character_losses(state: State<'_, AppState>, character_id: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_character_losses(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn get_character_stats(state: State<'_, AppState>, character_id: i64) -> Result<kills::CharacterStats, String> {
    kills::fetch_character_stats(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn get_map_data(app: AppHandle, state: State<'_, AppState>) -> Result<map::MapData, String> {
    map::get_map_data(app, &state.http_client).await
}

#[tauri::command]
pub async fn search_systems_live(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<map::SystemSearchMatch>, String> {
    map::search_systems(app, &state.http_client, query).await
}

#[tauri::command]
pub async fn plan_gate_check(
    state: State<'_, AppState>,
    waypoints: Vec<i64>,
    avoid: Vec<i64>,
    flag: String,
) -> Result<route::GateCheckResult, String> {
    route::plan_gate_check(&state.http_client, &waypoints, &avoid, &flag).await
}

#[tauri::command]
pub async fn get_gate_activity(state: State<'_, AppState>, system_ids: Vec<i64>) -> Result<Vec<route::GateKillEvent>, String> {
    Ok(route::get_gate_activity(&state.http_client, &system_ids).await)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
