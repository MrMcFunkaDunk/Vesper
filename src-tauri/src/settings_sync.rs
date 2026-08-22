//! Syncs EVE's own local client settings files between characters -
//! e.g. copy one character's overview/UI-layout/keybinds onto every
//! other character so they all end up identical. Adapted directly from
//! `eve-settings-manager` (a tool the user already relies on daily for
//! this exact task, read in full before building this): EVE stores
//! settings as `core_char_<charID>.dat` (per character) and
//! `core_user_<userID>.dat` (per account) inside `settings_<Profile>`
//! folders under `%LOCALAPPDATA%\CCP\EVE\<server>\`. The "sync" itself
//! is a raw byte-for-byte file copy, not a parse/merge - CCP's `.dat`
//! format is an internal serialization nobody needs to understand to
//! safely replace one character's file with another's, and copying the
//! whole file is exactly what the reference tool does too.
//!
//! Backups (both the single-file kind and the whole-profile kind) are
//! tracked in one unified `meta.json` sidecar under VESPER's own app-data
//! folder, mirroring the reference tool's `backup.ts` design - every
//! backup, whether made explicitly by the user or automatically before a
//! sync overwrite, shows up in the same list with an entry that knows
//! where its own copy lives and where it restores back to.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize, Clone)]
pub struct EveServerFolder {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct EveSettingsProfile {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct EveSettingsFile {
    /// "char" or "user" - which of EVE's two settings-file kinds this is.
    pub file_type: String,
    /// The numeric character or account id parsed straight from the filename.
    pub id: String,
    pub path: String,
    pub modified_at: i64,
}

#[derive(Serialize, Clone)]
pub struct SyncResult {
    pub dest_path: String,
    /// Where the destination's pre-sync contents were backed up to, if
    /// it existed - None only when the destination file didn't exist yet.
    pub backup_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BackupEntry {
    pub id: String,
    /// "file" (one core_*.dat) or "profile" (every .dat in a settings_* folder).
    pub kind: String,
    pub display_name: String,
    /// Where this entry restores back to - a single file path for "file",
    /// a settings_* profile folder path for "profile".
    pub source_path: String,
    /// Where VESPER's own copy lives - a single file for "file", a folder for "profile".
    pub backup_path: String,
    pub created_at: i64,
    pub file_count: usize,
}

/// EVE's own settings folder - a different application's data than
/// VESPER's own app_local_data_dir, so this reads the real
/// %LOCALAPPDATA%\CCP\EVE path directly rather than anything Tauri
/// manages. Path convention confirmed by reading eve-settings-manager's
/// own source, not guessed.
pub fn default_eve_settings_path() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let path = PathBuf::from(local_app_data).join("CCP").join("EVE");
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn modified_at_unix(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn new_backup_id() -> String {
    let millis = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{millis}-{:06x}", rand::random::<u32>() & 0xFF_FFFF)
}

/// A server folder is any subdirectory that actually contains at least
/// one settings_* profile - real folder names vary
/// (c_tranquility/_tq_tranquility/c_serenity/etc. across launcher
/// versions), so this checks structure rather than matching a fixed
/// name list.
pub fn list_servers(base_path: &str) -> Result<Vec<EveServerFolder>, String> {
    let entries = std::fs::read_dir(base_path).map_err(|e| format!("failed to read EVE settings folder: {e}"))?;
    let mut servers = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let has_profile = std::fs::read_dir(&path)
            .map(|it| it.flatten().any(|e| e.file_name().to_string_lossy().starts_with("settings_")))
            .unwrap_or(false);
        if has_profile {
            servers.push(EveServerFolder { name: entry.file_name().to_string_lossy().to_string(), path: path.to_string_lossy().to_string() });
        }
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(servers)
}

pub fn list_profiles(server_path: &str) -> Result<Vec<EveSettingsProfile>, String> {
    let entries = std::fs::read_dir(server_path).map_err(|e| format!("failed to read server folder: {e}"))?;
    let mut profiles = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if let Some(name) = file_name.strip_prefix("settings_") {
                profiles.push(EveSettingsProfile { name: name.to_string(), path: path.to_string_lossy().to_string() });
            }
        }
    }
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

/// Parses "core_char_12345678.dat" / "core_user_12345678.dat" into
/// (file_type, id) - None for anything else in the folder (EVE keeps
/// other files alongside these, e.g. cache/log files, which aren't
/// settings and shouldn't show up as sync candidates).
fn parse_settings_filename(file_name: &str) -> Option<(&'static str, String)> {
    if let Some(rest) = file_name.strip_prefix("core_char_").and_then(|s| s.strip_suffix(".dat")) {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return Some(("char", rest.to_string()));
        }
    }
    if let Some(rest) = file_name.strip_prefix("core_user_").and_then(|s| s.strip_suffix(".dat")) {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return Some(("user", rest.to_string()));
        }
    }
    None
}

pub fn list_settings_files(profile_path: &str) -> Result<Vec<EveSettingsFile>, String> {
    let entries = std::fs::read_dir(profile_path).map_err(|e| format!("failed to read profile folder: {e}"))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some((file_type, id)) = parse_settings_filename(&file_name) else { continue };
        files.push(EveSettingsFile {
            file_type: file_type.to_string(),
            id,
            modified_at: modified_at_unix(&path),
            path: path.to_string_lossy().to_string(),
        });
    }
    files.sort_by(|a, b| (&a.file_type, &a.id).cmp(&(&b.file_type, &b.id)));
    Ok(files)
}

fn backups_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    let root = dir.join("settings_backups");
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create backups directory: {e}"))?;
    Ok(root)
}

fn meta_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(backups_root(app)?.join("meta.json"))
}

fn read_meta(app: &tauri::AppHandle) -> Vec<BackupEntry> {
    let Ok(path) = meta_path(app) else { return Vec::new() };
    let Ok(contents) = std::fs::read_to_string(&path) else { return Vec::new() };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn write_meta(app: &tauri::AppHandle, entries: &[BackupEntry]) -> Result<(), String> {
    let path = meta_path(app)?;
    let contents = serde_json::to_string_pretty(entries).map_err(|e| format!("could not serialize backup metadata: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(|e| format!("could not write backup metadata: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("could not save backup metadata: {e}"))
}

/// All tracked backups, newest first.
pub fn list_backups(app: &tauri::AppHandle) -> Vec<BackupEntry> {
    let mut entries = read_meta(app);
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    entries
}

/// Snapshots one settings file into VESPER's own app-data backups folder,
/// tracked in the shared meta.json list. Used both for the explicit
/// per-row "back up this file" action and internally by `sync_settings_file`
/// before it overwrites a destination.
pub fn create_file_backup(app: &tauri::AppHandle, source_path: &str, display_name: Option<String>) -> Result<BackupEntry, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("source settings file not found".to_string());
    }
    let file_name = source.file_name().ok_or("invalid source path")?.to_string_lossy().to_string();
    let id = new_backup_id();
    let files_dir = backups_root(app)?.join("files");
    std::fs::create_dir_all(&files_dir).map_err(|e| format!("could not create backups directory: {e}"))?;
    let backup_path = files_dir.join(format!("{id}_{file_name}"));
    std::fs::copy(&source, &backup_path).map_err(|e| format!("failed to back up {file_name}: {e}"))?;

    let entry = BackupEntry {
        id,
        kind: "file".to_string(),
        display_name: display_name.unwrap_or_else(|| file_name.clone()),
        source_path: source_path.to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
        created_at: now_unix(),
        file_count: 1,
    };
    let mut entries = read_meta(app);
    entries.push(entry.clone());
    write_meta(app, &entries)?;
    Ok(entry)
}

/// Snapshots every `.dat` file in a whole settings profile folder at
/// once - the "Backup Profile" action.
pub fn create_profile_backup(app: &tauri::AppHandle, profile_path: &str, display_name: Option<String>) -> Result<BackupEntry, String> {
    let profile = PathBuf::from(profile_path);
    if !profile.is_dir() {
        return Err("profile folder not found".to_string());
    }
    let profile_name = profile.file_name().ok_or("invalid profile path")?.to_string_lossy().to_string();
    let id = new_backup_id();
    let backup_dir = backups_root(app)?.join("profiles").join(&id);
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("could not create backup folder: {e}"))?;

    let mut file_count = 0usize;
    for entry in std::fs::read_dir(&profile).map_err(|e| format!("failed to read profile folder: {e}"))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("dat") {
            let dest = backup_dir.join(entry.file_name());
            std::fs::copy(&path, &dest).map_err(|e| format!("failed to back up {}: {e}", entry.file_name().to_string_lossy()))?;
            file_count += 1;
        }
    }

    let entry = BackupEntry {
        id,
        kind: "profile".to_string(),
        display_name: display_name.unwrap_or_else(|| format!("{profile_name} (full profile)")),
        source_path: profile_path.to_string(),
        backup_path: backup_dir.to_string_lossy().to_string(),
        created_at: now_unix(),
        file_count,
    };
    let mut entries = read_meta(app);
    entries.push(entry.clone());
    write_meta(app, &entries)?;
    Ok(entry)
}

/// Copies a tracked backup's contents back to where it came from.
pub fn restore_backup(app: &tauri::AppHandle, backup_id: &str) -> Result<(), String> {
    let entries = read_meta(app);
    let entry = entries.iter().find(|e| e.id == backup_id).ok_or("backup not found")?;
    match entry.kind.as_str() {
        "file" => {
            let dest = PathBuf::from(&entry.source_path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("could not recreate destination folder: {e}"))?;
            }
            std::fs::copy(&entry.backup_path, &dest).map_err(|e| format!("failed to restore backup: {e}"))?;
        }
        "profile" => {
            let dest_dir = PathBuf::from(&entry.source_path);
            std::fs::create_dir_all(&dest_dir).map_err(|e| format!("could not recreate profile folder: {e}"))?;
            let backup_dir = PathBuf::from(&entry.backup_path);
            for file in std::fs::read_dir(&backup_dir).map_err(|e| format!("failed to read backup folder: {e}"))?.flatten() {
                let dest = dest_dir.join(file.file_name());
                std::fs::copy(file.path(), &dest).map_err(|e| format!("failed to restore {}: {e}", file.file_name().to_string_lossy()))?;
            }
        }
        other => return Err(format!("unknown backup kind: {other}")),
    }
    Ok(())
}

/// Deletes a tracked backup's own copy (never touches the original file
/// it was backed up from) and removes it from the list.
pub fn delete_backup(app: &tauri::AppHandle, backup_id: &str) -> Result<(), String> {
    let mut entries = read_meta(app);
    let Some(pos) = entries.iter().position(|e| e.id == backup_id) else {
        return Err("backup not found".to_string());
    };
    let entry = entries.remove(pos);
    match entry.kind.as_str() {
        "file" => {
            let _ = std::fs::remove_file(&entry.backup_path);
        }
        "profile" => {
            let _ = std::fs::remove_dir_all(&entry.backup_path);
        }
        _ => {}
    }
    write_meta(app, &entries)
}

/// Copies one settings file's raw bytes onto one or more destination
/// paths, backing up each destination first if it already exists - each
/// such auto-backup is tracked the same way as an explicit one, so it
/// shows up in the Backups list rather than being invisible.
pub fn sync_settings_file(app: &tauri::AppHandle, source_path: &str, dest_paths: Vec<String>) -> Result<Vec<SyncResult>, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("source settings file not found".to_string());
    }
    let mut results = Vec::new();
    for dest_path in dest_paths {
        let dest = PathBuf::from(&dest_path);
        let backup_path = if dest.is_file() {
            let file_name = dest.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let entry = create_file_backup(app, &dest_path, Some(format!("Auto-backup before sync - {file_name}")))?;
            Some(entry.backup_path)
        } else {
            None
        };
        std::fs::copy(&source, &dest).map_err(|e| format!("failed to sync settings to {dest_path}: {e}"))?;
        results.push(SyncResult { dest_path, backup_path });
    }
    Ok(results)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

/// Guards every profile-folder mutation against operating on something
/// that isn't actually a `settings_*` folder, since these functions do
/// full-folder renames/deletes.
fn require_settings_profile_dir(profile_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(profile_path);
    let is_profile_dir = path.file_name().map(|f| f.to_string_lossy().starts_with("settings_")).unwrap_or(false);
    if !is_profile_dir || !path.is_dir() {
        return Err("not a recognized EVE settings profile folder".to_string());
    }
    Ok(path)
}

pub fn create_profile(server_path: &str, name: &str) -> Result<EveSettingsProfile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("profile name can't be empty".to_string());
    }
    let path = PathBuf::from(server_path).join(format!("settings_{name}"));
    if path.exists() {
        return Err(format!("a profile named \"{name}\" already exists"));
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("failed to create profile folder: {e}"))?;
    Ok(EveSettingsProfile { name: name.to_string(), path: path.to_string_lossy().to_string() })
}

pub fn rename_profile(profile_path: &str, new_name: &str) -> Result<EveSettingsProfile, String> {
    let path = require_settings_profile_dir(profile_path)?;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("profile name can't be empty".to_string());
    }
    let parent = path.parent().ok_or("invalid profile path")?;
    let new_path = parent.join(format!("settings_{new_name}"));
    if new_path.exists() {
        return Err(format!("a profile named \"{new_name}\" already exists"));
    }
    std::fs::rename(&path, &new_path).map_err(|e| format!("failed to rename profile: {e}"))?;
    Ok(EveSettingsProfile { name: new_name.to_string(), path: new_path.to_string_lossy().to_string() })
}

pub fn duplicate_profile(profile_path: &str, new_name: &str) -> Result<EveSettingsProfile, String> {
    let path = require_settings_profile_dir(profile_path)?;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("profile name can't be empty".to_string());
    }
    let parent = path.parent().ok_or("invalid profile path")?;
    let new_path = parent.join(format!("settings_{new_name}"));
    if new_path.exists() {
        return Err(format!("a profile named \"{new_name}\" already exists"));
    }
    copy_dir_recursive(&path, &new_path).map_err(|e| format!("failed to duplicate profile: {e}"))?;
    Ok(EveSettingsProfile { name: new_name.to_string(), path: new_path.to_string_lossy().to_string() })
}

pub fn delete_profile(profile_path: &str) -> Result<(), String> {
    let path = require_settings_profile_dir(profile_path)?;
    std::fs::remove_dir_all(&path).map_err(|e| format!("failed to delete profile: {e}"))
}
