//! A plain-file mirror of the frontend's own localStorage-backed settings
//! (theme, favourites, saved location, industry defaults, gate-camp
//! favourites, etc. - see usePersistentState.ts and every hook that calls
//! into it, plus a handful of hooks that manage localStorage directly).
//!
//! Real incident this exists to guard against: a user's entire settings
//! set (theme, favourites, tracked location, industry setup) came back
//! empty after an in-app update, with no reproducible code-level cause
//! found - localStorage lives inside the WebView2 profile, which is
//! outside VESPER's own control and can be reset by things this app has
//! no visibility into (a WebView2 runtime update, an installer directory
//! mismatch, OS-level cleanup tooling). A plain JSON file under VESPER's
//! own app-data folder, written on every settings change and re-read once
//! at startup to backfill anything localStorage is missing, survives all
//! of that - it's a completely separate storage mechanism from whatever
//! WebView2 itself does with its profile.
//!
//! Deliberately a generic string-keyed bag (mirroring whatever key/raw-JSON-
//! string pairs the frontend already uses for localStorage) rather than a
//! typed struct per setting - the whole point is to cover every current AND
//! future localStorage-backed setting through one shared choke point,
//! without this file needing a matching new field every time a new setting
//! is added on the frontend.
use std::collections::HashMap;
use std::path::PathBuf;

fn backup_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = tauri::Manager::path(app).app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("settings_backup.json"))
}

pub fn load_backup(app: &tauri::AppHandle) -> HashMap<String, String> {
    let Ok(path) = backup_path(app) else { return HashMap::new() };
    let Ok(contents) = std::fs::read_to_string(&path) else { return HashMap::new() };
    serde_json::from_str(&contents).unwrap_or_default()
}

/// Same atomic temp-file + rename pattern multibox.rs/tracked_entities.rs
/// use, so a reader never observes a half-written file.
fn write_backup(app: &tauri::AppHandle, bag: &HashMap<String, String>) -> Result<(), String> {
    let path = backup_path(app)?;
    let contents = serde_json::to_string_pretty(bag).map_err(|e| format!("could not serialize settings backup: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(|e| format!("could not write settings backup: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("could not save settings backup: {e}"))
}

/// Read-modify-write on the whole bag for one key - settings changes are
/// infrequent enough (a theme pick, a favourite toggle) that this is never
/// a hot path, so there's no need for anything more clever than the same
/// pattern add_tracked_entity already uses.
pub fn set_entry(app: &tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let mut bag = load_backup(app);
    bag.insert(key, value);
    write_backup(app, &bag)
}
