use crate::{auth, characters, config, esi};
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

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
