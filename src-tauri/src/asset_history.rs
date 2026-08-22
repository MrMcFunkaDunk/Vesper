//! One ISK-value snapshot per character per UTC day, so the Assets tab can
//! show a value-over-time trend - assets themselves are a live ESI pull
//! with no history of their own, so this is VESPER's own small local log,
//! written whenever the Assets tab is actually viewed (piggybacking on
//! the valuation CharacterDetail.tsx already computes for C3, not a new
//! background poller).
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("asset_history.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS asset_snapshots (
            character_id INTEGER NOT NULL,
            snapshot_date TEXT NOT NULL,
            total_value REAL NOT NULL,
            PRIMARY KEY (character_id, snapshot_date)
        );",
    )
    .map_err(|e| format!("failed to create asset_history tables: {e}"))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

/// Days-since-epoch -> (year, month, day), civil calendar, UTC - Howard
/// Hinnant's well-known constant-time algorithm, used here purely to avoid
/// pulling in a date/time crate for the one thing needed: "what UTC
/// calendar day is it today," to key one row per day.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d)
}

fn today_utc_date_string() -> String {
    let (y, m, d) = civil_from_days(now_unix() / 86400);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Serialize, Clone)]
pub struct AssetSnapshot {
    pub snapshot_date: String,
    pub total_value: f64,
}

/// One row per character per day - viewing the Assets tab again later the
/// same day just overwrites today's row rather than accumulating
/// duplicate same-day snapshots.
pub fn record_snapshot(app: &tauri::AppHandle, character_id: i64, total_value: f64) -> Result<(), String> {
    let conn = rusqlite::Connection::open(db_path(app)?).map_err(|e| format!("failed to open asset history database: {e}"))?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO asset_snapshots (character_id, snapshot_date, total_value) VALUES (?1, ?2, ?3)
         ON CONFLICT(character_id, snapshot_date) DO UPDATE SET total_value = excluded.total_value",
        rusqlite::params![character_id, today_utc_date_string(), total_value],
    )
    .map_err(|e| format!("failed to record asset snapshot: {e}"))?;
    Ok(())
}

pub fn get_history(app: &tauri::AppHandle, character_id: i64) -> Result<Vec<AssetSnapshot>, String> {
    let conn = rusqlite::Connection::open(db_path(app)?).map_err(|e| format!("failed to open asset history database: {e}"))?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare("SELECT snapshot_date, total_value FROM asset_snapshots WHERE character_id = ?1 ORDER BY snapshot_date")
        .map_err(|e| format!("failed to query asset history: {e}"))?;
    let rows = stmt
        .query_map([character_id], |row| Ok(AssetSnapshot { snapshot_date: row.get(0)?, total_value: row.get(1)? }))
        .map_err(|e| format!("failed to query asset history: {e}"))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("failed to read asset history row: {e}"))?);
    }
    Ok(result)
}
