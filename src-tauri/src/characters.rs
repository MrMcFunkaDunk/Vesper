use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterRecord {
    pub id: i64,
    pub name: String,
    pub scopes: Vec<String>,
    pub added_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CharacterIndex {
    active_character_id: Option<i64>,
    characters: Vec<CharacterRecord>,
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("characters.json"))
}

fn load_index(app: &tauri::AppHandle) -> Result<CharacterIndex, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(CharacterIndex::default());
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("could not read character list: {e}"))?;
    serde_json::from_str(&contents).map_err(|e| format!("could not parse character list: {e}"))
}

fn save_index(app: &tauri::AppHandle, index: &CharacterIndex) -> Result<(), String> {
    let path = index_path(app)?;
    let contents = serde_json::to_string_pretty(index)
        .map_err(|e| format!("could not serialize character list: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("could not write character list: {e}"))
}

pub fn upsert_character(app: &tauri::AppHandle, record: CharacterRecord) -> Result<(), String> {
    let mut index = load_index(app)?;
    match index.characters.iter_mut().find(|c| c.id == record.id) {
        Some(existing) => *existing = record,
        None => index.characters.push(record),
    }
    if index.active_character_id.is_none() {
        index.active_character_id = index.characters.first().map(|c| c.id);
    }
    save_index(app, &index)
}

pub fn list_characters(app: &tauri::AppHandle) -> Result<(Vec<CharacterRecord>, Option<i64>), String> {
    let index = load_index(app)?;
    Ok((index.characters, index.active_character_id))
}

pub fn set_active(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let mut index = load_index(app)?;
    if !index.characters.iter().any(|c| c.id == id) {
        return Err("unknown character".to_string());
    }
    index.active_character_id = Some(id);
    save_index(app, &index)
}

pub fn remove_character(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let mut index = load_index(app)?;
    index.characters.retain(|c| c.id != id);
    if index.active_character_id == Some(id) {
        index.active_character_id = index.characters.first().map(|c| c.id);
    }
    save_index(app, &index)
}
