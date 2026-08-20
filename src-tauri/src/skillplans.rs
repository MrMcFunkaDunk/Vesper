use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("skillplans.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            character_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plans_character ON plans (character_id);
        CREATE TABLE IF NOT EXISTS plan_entries (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            skill_id INTEGER NOT NULL,
            level INTEGER NOT NULL,
            priority INTEGER NOT NULL DEFAULT 3,
            notes TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL,
            is_prerequisite INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_entries_plan ON plan_entries (plan_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_entries_unique ON plan_entries (plan_id, skill_id, level);",
    )
    .map_err(|e| format!("failed to create skill plan tables: {e}"))?;
    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Clone)]
pub struct PlanSummary {
    pub id: String,
    pub name: String,
    pub entry_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
pub struct PlanEntry {
    pub id: String,
    pub skill_id: i64,
    pub level: i64,
    pub priority: i64,
    pub notes: String,
    pub sort_order: i64,
    pub is_prerequisite: bool,
}

#[derive(Serialize)]
pub struct PlanDetail {
    pub id: String,
    pub name: String,
    pub entries: Vec<PlanEntry>,
}

#[derive(Deserialize)]
pub struct NewPlanEntry {
    pub skill_id: i64,
    pub level: i64,
    pub is_prerequisite: bool,
}

fn touch_plan(conn: &rusqlite::Connection, plan_id: &str) -> Result<(), String> {
    conn.execute("UPDATE plans SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_unix(), plan_id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_plans(app: tauri::AppHandle, character_id: i64) -> Result<Vec<PlanSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PlanSummary>, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, p.created_at, p.updated_at,
                        (SELECT COUNT(*) FROM plan_entries e WHERE e.plan_id = p.id) AS entry_count
                 FROM plans p WHERE p.character_id = ?1 ORDER BY p.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([character_id], |row| {
                Ok(PlanSummary { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)?, entry_count: row.get(4)? })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_plan(app: tauri::AppHandle, plan_id: String) -> Result<PlanDetail, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<PlanDetail, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let name: String =
            conn.query_row("SELECT name FROM plans WHERE id = ?1", [&plan_id], |row| row.get(0)).map_err(|e| format!("plan not found: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, skill_id, level, priority, notes, sort_order, is_prerequisite
                 FROM plan_entries WHERE plan_id = ?1 ORDER BY sort_order",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&plan_id], |row| {
                Ok(PlanEntry {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    level: row.get(2)?,
                    priority: row.get(3)?,
                    notes: row.get(4)?,
                    sort_order: row.get(5)?,
                    is_prerequisite: row.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        let entries = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(PlanDetail { id: plan_id, name, entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn create_plan(app: tauri::AppHandle, character_id: i64, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = new_id();
        let now = now_unix();
        conn.execute(
            "INSERT INTO plans (id, character_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![id, character_id, name, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn rename_plan(app: tauri::AppHandle, plan_id: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("UPDATE plans SET name = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![name, now_unix(), plan_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_plan(app: tauri::AppHandle, plan_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM plan_entries WHERE plan_id = ?1", [&plan_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM plans WHERE id = ?1", [&plan_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bulk-adds entries (a deliberately-planned skill plus however many
/// auto-inserted prerequisite levels the frontend worked out are missing) in
/// one transaction, appended after whatever's already in the plan. Entries
/// that already exist (same skill_id+level) are silently skipped rather than
/// erroring - adding a skill whose prerequisite is already planned elsewhere
/// in the plan is the normal case, not a conflict.
pub async fn add_plan_entries(app: tauri::AppHandle, plan_id: String, entries: Vec<NewPlanEntry>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let next_sort: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_entries WHERE plan_id = ?1", [&plan_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (i, entry) in entries.iter().enumerate() {
            tx.execute(
                "INSERT INTO plan_entries (id, plan_id, skill_id, level, priority, notes, sort_order, is_prerequisite, created_at)
                 VALUES (?1, ?2, ?3, ?4, 3, '', ?5, ?6, ?7)
                 ON CONFLICT(plan_id, skill_id, level) DO NOTHING",
                rusqlite::params![new_id(), plan_id, entry.skill_id, entry.level, next_sort + i as i64, entry.is_prerequisite, now_unix()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE plans SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_unix(), plan_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn update_plan_entry(
    app: tauri::AppHandle,
    plan_id: String,
    entry_id: String,
    priority: i64,
    notes: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("UPDATE plan_entries SET priority = ?1, notes = ?2 WHERE id = ?3", rusqlite::params![priority, notes, entry_id])
            .map_err(|e| e.to_string())?;
        touch_plan(&conn, &plan_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Persists a full reordering of the plan's entries at once (drag-and-drop
/// reorder) - simpler than incremental position math, and every entry's
/// position is naturally known client-side after a drag anyway.
pub async fn reorder_plan_entries(app: tauri::AppHandle, plan_id: String, entry_ids_in_order: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (i, entry_id) in entry_ids_in_order.iter().enumerate() {
            tx.execute("UPDATE plan_entries SET sort_order = ?1 WHERE id = ?2", rusqlite::params![i as i64, entry_id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        touch_plan(&conn, &plan_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_plan_entry(app: tauri::AppHandle, plan_id: String, entry_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM plan_entries WHERE id = ?1", [&entry_id]).map_err(|e| e.to_string())?;
        touch_plan(&conn, &plan_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
