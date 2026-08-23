use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Character, corporation, or alliance ids all come from overlapping ESI id
/// ranges, so an entity is only uniquely identified by (id, kind) together -
/// never id alone.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackedEntityKind {
    Character,
    Corporation,
    Alliance,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackedEntity {
    pub entity_id: i64,
    pub entity_name: String,
    pub kind: TrackedEntityKind,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TrackedEntitiesSettings {
    pub entities: Vec<TrackedEntity>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = tauri::Manager::path(app).app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("tracked_entities.json"))
}

pub fn load_tracked_entities(app: &tauri::AppHandle) -> TrackedEntitiesSettings {
    let Ok(path) = settings_path(app) else { return TrackedEntitiesSettings::default() };
    let Ok(contents) = std::fs::read_to_string(&path) else { return TrackedEntitiesSettings::default() };
    serde_json::from_str(&contents).unwrap_or_default()
}

/// Same atomic temp-file + rename pattern multibox.rs/characters.rs use, so
/// a reader never observes a half-written file.
fn save_tracked_entities(app: &tauri::AppHandle, settings: &TrackedEntitiesSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let contents = serde_json::to_string_pretty(settings).map_err(|e| format!("could not serialize tracked entities: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(|e| format!("could not write tracked entities: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("could not save tracked entities: {e}"))
}

pub fn add_tracked_entity(
    app: &tauri::AppHandle,
    entity_id: i64,
    entity_name: String,
    kind: TrackedEntityKind,
) -> Result<TrackedEntitiesSettings, String> {
    let mut settings = load_tracked_entities(app);
    if !settings.entities.iter().any(|e| e.entity_id == entity_id && e.kind == kind) {
        settings.entities.push(TrackedEntity { entity_id, entity_name, kind });
    }
    save_tracked_entities(app, &settings)?;
    Ok(settings)
}

pub fn remove_tracked_entity(app: &tauri::AppHandle, entity_id: i64, kind: TrackedEntityKind) -> Result<TrackedEntitiesSettings, String> {
    let mut settings = load_tracked_entities(app);
    settings.entities.retain(|e| !(e.entity_id == entity_id && e.kind == kind));
    save_tracked_entities(app, &settings)?;
    Ok(settings)
}
