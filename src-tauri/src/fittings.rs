use crate::auth::sso::SsoConfig;
use crate::esi::{self, FitItemEntry};
use crate::market;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("fittings.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS fits (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ship_type_id INTEGER NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            purpose TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            items TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL DEFAULT 'local',
            esi_character_id INTEGER,
            esi_fitting_id INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fits_ship ON fits (ship_type_id);
        CREATE INDEX IF NOT EXISTS idx_fits_esi ON fits (esi_character_id, esi_fitting_id);",
    )
    .map_err(|e| format!("failed to create fittings tables: {e}"))?;
    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// A random local id for a new fit - hex rather than a UUID crate dependency,
/// same "just enough randomness, no new dependency" approach as the PKCE
/// state generator already used for the SSO flow.
fn new_fit_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FitItem {
    pub type_id: i64,
    pub flag: String,
    pub quantity: i64,
}

#[derive(Serialize, Clone)]
pub struct FitDetail {
    pub id: String,
    pub name: String,
    pub ship_type_id: i64,
    pub description: String,
    pub purpose: String,
    pub tags: Vec<String>,
    pub items: Vec<FitItem>,
    pub source: String,
    pub esi_character_id: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct FitInput {
    pub id: Option<String>,
    pub name: String,
    pub ship_type_id: i64,
    pub description: String,
    pub purpose: String,
    pub tags: Vec<String>,
    pub items: Vec<FitItem>,
}

fn row_to_detail(row: &rusqlite::Row) -> rusqlite::Result<FitDetail> {
    let tags_json: String = row.get("tags")?;
    let items_json: String = row.get("items")?;
    Ok(FitDetail {
        id: row.get("id")?,
        name: row.get("name")?,
        ship_type_id: row.get("ship_type_id")?,
        description: row.get("description")?,
        purpose: row.get("purpose")?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        items: serde_json::from_str(&items_json).unwrap_or_default(),
        source: row.get("source")?,
        esi_character_id: row.get("esi_character_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const DETAIL_COLUMNS: &str =
    "id, name, ship_type_id, description, purpose, tags, items, source, esi_character_id, created_at, updated_at";

/// Returns full fit detail (items included) for every saved fit, not just a
/// lightweight summary - this is a local sqlite read of a personal library
/// (realistically dozens of entries, not thousands), so there's no real cost
/// to giving the frontend everything in one call instead of a separate
/// per-card detail fetch for every card it wants to show a cost/module count on.
pub async fn list_fits(app: tauri::AppHandle) -> Result<Vec<FitDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FitDetail>, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let mut stmt = conn
            .prepare(&format!("SELECT {DETAIL_COLUMNS} FROM fits ORDER BY updated_at DESC"))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], row_to_detail).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_fit(app: tauri::AppHandle, id: String) -> Result<FitDetail, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FitDetail, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.query_row(&format!("SELECT {DETAIL_COLUMNS} FROM fits WHERE id = ?1"), [&id], row_to_detail)
            .map_err(|e| format!("fit not found: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Creates a new local fit, or updates an existing one if `input.id` is set.
/// Editing an ESI-synced fit detaches it from that sync (becomes a local
/// copy) rather than silently rewriting what's supposed to mirror the
/// character's actual in-game fitting.
pub async fn save_fit(app: tauri::AppHandle, input: FitInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let now = now_unix();
        let tags_json = serde_json::to_string(&input.tags).map_err(|e| e.to_string())?;
        let items_json = serde_json::to_string(&input.items).map_err(|e| e.to_string())?;
        let id = input.id.unwrap_or_else(new_fit_id);
        conn.execute(
            "INSERT INTO fits (id, name, ship_type_id, description, purpose, tags, items, source, esi_character_id, esi_fitting_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'local', NULL, NULL, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                ship_type_id = excluded.ship_type_id,
                description = excluded.description,
                purpose = excluded.purpose,
                tags = excluded.tags,
                items = excluded.items,
                source = 'local',
                esi_character_id = NULL,
                esi_fitting_id = NULL,
                updated_at = excluded.updated_at",
            rusqlite::params![id, input.name, input.ship_type_id, input.description, input.purpose, tags_json, items_json, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_fit(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM fits WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pulls a character's real in-game fits from ESI and mirrors them into the
/// local library tagged source='esi' - stale entries (fits ESI no longer
/// reports for this character, e.g. deleted in-game) are removed so the
/// mirror stays accurate rather than accumulating ghosts.
pub async fn sync_character_fittings(
    app: tauri::AppHandle,
    client: reqwest::Client,
    config: SsoConfig,
    character_id: i64,
) -> Result<usize, String> {
    let result = esi::fetch_character_fittings(&client, &config, character_id).await?;
    if result.needs_reauth {
        return Err("This character needs to reconnect to sync fittings.".to_string());
    }
    let count = result.entries.len();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let now = now_unix();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM fits WHERE source = 'esi' AND esi_character_id = ?1", [character_id])
            .map_err(|e| e.to_string())?;
        for entry in &result.entries {
            let items: Vec<FitItem> =
                entry.items.iter().map(|i| FitItem { type_id: i.type_id, flag: i.flag.clone(), quantity: i.quantity }).collect();
            let items_json = serde_json::to_string(&items).map_err(|e| e.to_string())?;
            let id = format!("esi-{character_id}-{}", entry.fitting_id);
            tx.execute(
                "INSERT INTO fits (id, name, ship_type_id, description, purpose, tags, items, source, esi_character_id, esi_fitting_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '', '[]', ?5, 'esi', ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    ship_type_id = excluded.ship_type_id,
                    description = excluded.description,
                    items = excluded.items,
                    updated_at = excluded.updated_at",
                rusqlite::params![id, entry.name, entry.ship_type_id, entry.description, items_json, character_id, entry.fitting_id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(count)
}

/// Pushes a saved fit straight into a character's in-game Fittings browser
/// via ESI's write endpoint - no copy/paste through the client needed.
pub async fn send_fit_to_character(
    app: tauri::AppHandle,
    client: reqwest::Client,
    config: SsoConfig,
    character_id: i64,
    fit_id: String,
) -> Result<i64, String> {
    let fit = get_fit(app, fit_id).await?;
    let items: Vec<FitItemEntry> = fit.items.iter().map(|i| FitItemEntry { type_id: i.type_id, flag: i.flag.clone(), quantity: i.quantity }).collect();
    esi::create_character_fitting(&client, &config, character_id, &fit.name, &fit.description, fit.ship_type_id, &items).await
}

/// Ship + every module/rig/drone/cargo item's average market price, summed -
/// an estimate, not a live buy-order quote (matches how the rest of this app
/// values things elsewhere, e.g. the Appraisal tool).
pub async fn get_fit_cost(app: tauri::AppHandle, client: reqwest::Client, fit_id: String) -> Result<f64, String> {
    let fit = get_fit(app, fit_id).await?;
    let prices = market::fetch_market_prices(&client).await?;
    let price_by_id: std::collections::HashMap<i64, f64> =
        prices.into_iter().filter_map(|p| p.average_price.map(|price| (p.type_id, price))).collect();
    let mut total = price_by_id.get(&fit.ship_type_id).copied().unwrap_or(0.0);
    for item in &fit.items {
        total += price_by_id.get(&item.type_id).copied().unwrap_or(0.0) * item.quantity as f64;
    }
    Ok(total)
}

/// (sort_group, slot_index) - the standard EFT ordering: Low, Mid, High, Rig,
/// SubSystem, then Drones and Cargo at the end. Slot index is parsed off the
/// flag's trailing digits (`LoSlot3` -> 3) so modules land in the same slot
/// order the character actually fitted them in.
fn flag_sort_key(flag: &str) -> (u8, u32) {
    let (prefix, group) = if let Some(n) = flag.strip_prefix("LoSlot") {
        (n, 0)
    } else if let Some(n) = flag.strip_prefix("MedSlot") {
        (n, 1)
    } else if let Some(n) = flag.strip_prefix("HiSlot") {
        (n, 2)
    } else if let Some(n) = flag.strip_prefix("RigSlot") {
        (n, 3)
    } else if let Some(n) = flag.strip_prefix("SubSystemSlot") {
        (n, 4)
    } else if flag == "DroneBay" {
        ("", 5)
    } else if flag == "FighterBay" {
        ("", 6)
    } else if flag == "Cargo" {
        ("", 7)
    } else if let Some(n) = flag.strip_prefix("ServiceSlot") {
        (n, 8)
    } else {
        ("", 9)
    };
    (group, prefix.parse().unwrap_or(0))
}

/// The standard EFT text format every EVE fitting tool reads - pasted
/// directly into the in-game Fitting window's "Import fit" dialog. This is
/// the actual "send to character" mechanism EVE Workbench and every other
/// fit site use; ESI's direct write push (send_fit_to_character) is the
/// zero-copy-paste alternative this app also offers.
pub async fn export_fit_eft(app: tauri::AppHandle, client: reqwest::Client, fit_id: String) -> Result<String, String> {
    let fit = get_fit(app, fit_id).await?;
    let mut lookup_ids: Vec<i64> = vec![fit.ship_type_id];
    lookup_ids.extend(fit.items.iter().map(|i| i.type_id));
    let names = esi::resolve_names(&client, lookup_ids).await;
    let ship_name = names.get(&fit.ship_type_id).cloned().unwrap_or_else(|| format!("Type #{}", fit.ship_type_id));

    let mut items: Vec<&FitItem> = fit.items.iter().collect();
    items.sort_by_key(|i| flag_sort_key(&i.flag));

    let mut out = format!("[{}, {}]\n", ship_name, fit.name);
    let mut last_group: Option<u8> = None;
    for item in &items {
        let (group, _) = flag_sort_key(&item.flag);
        if last_group != Some(group) {
            out.push('\n');
            last_group = Some(group);
        }
        let name = names.get(&item.type_id).cloned().unwrap_or_else(|| format!("Type #{}", item.type_id));
        if group >= 5 {
            out.push_str(&format!("{} x{}\n", name, item.quantity));
        } else {
            for _ in 0..item.quantity.max(1) {
                out.push_str(&name);
                out.push('\n');
            }
        }
    }
    Ok(out.trim_end().to_string())
}

/// EVE's compact DNA fit string (`shipTypeID:typeID;qty:typeID;qty:...::`) -
/// a secondary export alongside EFT, used by some in-game "Show Info" style
/// links. Best-effort: EFT via clipboard (or the direct ESI push) is the
/// primary, fully-reliable "send to game" path.
pub async fn export_fit_dna(app: tauri::AppHandle, fit_id: String) -> Result<String, String> {
    let fit = get_fit(app, fit_id).await?;
    let mut out = format!("{}:", fit.ship_type_id);
    for item in &fit.items {
        out.push_str(&format!("{};{}:", item.type_id, item.quantity));
    }
    out.push_str(":");
    Ok(out)
}
