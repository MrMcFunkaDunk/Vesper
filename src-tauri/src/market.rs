use crate::esi::{public_get, public_get_paginated};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};
use tauri::Manager;

/// Same Fuzzwork SDE CSV mirror the map sync uses (see map.rs), pulling the
/// two tables needed for a browsable, searchable market catalog: every item
/// type (name + which market category it lives under) and the market
/// category tree itself. invTypes.csv is the big one (~20MB, ~110k rows,
/// most of it description text we don't keep) but it's still a one-time
/// background sync cached in local SQLite, same tradeoff already accepted
/// for the map data.
const TYPES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invTypes.csv";
const MARKET_GROUPS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invMarketGroups.csv";
/// Blueprint/reaction job data (materials, products, time) and reprocessing
/// yields - same Fuzzwork SDE mirror as the two above. Row counts confirmed
/// live before committing to this: ~19k/36k/6k/47k/1k rows respectively,
/// well within the scale invTypes.csv (~110k) already established as fine
/// for a one-time background sync.
const ACTIVITY_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/industryActivity.csv";
const ACTIVITY_MATERIALS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/industryActivityMaterials.csv";
const ACTIVITY_PRODUCTS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/industryActivityProducts.csv";
const ACTIVITY_PROBABILITIES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/industryActivityProbabilities.csv";
const REPROCESSING_MATERIALS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invTypeMaterials.csv";

#[derive(Deserialize)]
struct TypeRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "typeName")]
    type_name: String,
    #[serde(rename = "published")]
    published: i32,
    #[serde(rename = "marketGroupID")]
    market_group_id: Option<i64>,
    #[serde(rename = "volume")]
    volume: Option<f64>,
    #[serde(rename = "mass")]
    mass: Option<f64>,
    /// Reprocessing lot size (e.g. 100 for Veldspar) - only whole multiples
    /// of this quantity can be reprocessed, with any remainder discarded.
    #[serde(rename = "portionSize")]
    portion_size: Option<i64>,
}

/// CCP's own SDE industryActivity ids - fixed, not tool-specific (verified
/// this session against a real SDE-importing reference: Manufacturing=1,
/// Copying=5, Invention=8, Reactions=11; ME research=4 and TE research=3
/// confirmed the same way).
pub const ACTIVITY_MANUFACTURING: i64 = 1;
pub const ACTIVITY_RESEARCH_TE: i64 = 3;
pub const ACTIVITY_RESEARCH_ME: i64 = 4;
pub const ACTIVITY_COPYING: i64 = 5;
pub const ACTIVITY_INVENTION: i64 = 8;
pub const ACTIVITY_REACTION: i64 = 11;

#[derive(Deserialize)]
struct ActivityRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "activityID")]
    activity_id: i64,
    #[serde(rename = "time")]
    time_seconds: i64,
}

#[derive(Deserialize)]
struct ActivityMaterialRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "activityID")]
    activity_id: i64,
    #[serde(rename = "materialTypeID")]
    material_type_id: i64,
    #[serde(rename = "quantity")]
    quantity: i64,
}

#[derive(Deserialize)]
struct ActivityProductRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "activityID")]
    activity_id: i64,
    #[serde(rename = "productTypeID")]
    product_type_id: i64,
    #[serde(rename = "quantity")]
    quantity: i64,
}

#[derive(Deserialize)]
struct ActivityProbabilityRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "activityID")]
    activity_id: i64,
    #[serde(rename = "productTypeID")]
    product_type_id: i64,
    #[serde(rename = "probability")]
    probability: f64,
}

#[derive(Deserialize)]
struct ReprocessingMaterialRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "materialTypeID")]
    material_type_id: i64,
    #[serde(rename = "quantity")]
    quantity: i64,
}

#[derive(Deserialize)]
struct MarketGroupRow {
    #[serde(rename = "marketGroupID")]
    market_group_id: i64,
    #[serde(rename = "parentGroupID")]
    parent_group_id: Option<i64>,
    #[serde(rename = "marketGroupName")]
    market_group_name: String,
    #[serde(rename = "hasTypes")]
    has_types: i32,
    #[serde(rename = "iconID")]
    icon_id: Option<i64>,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("market.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS types (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            market_group_id INTEGER,
            volume REAL NOT NULL DEFAULT 0,
            mass REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_types_market_group ON types (market_group_id);
        CREATE TABLE IF NOT EXISTS market_groups (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER,
            name TEXT NOT NULL,
            has_types INTEGER NOT NULL,
            icon_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS activities (
            type_id INTEGER NOT NULL,
            activity_id INTEGER NOT NULL,
            time_seconds INTEGER NOT NULL,
            PRIMARY KEY (type_id, activity_id)
        );
        CREATE TABLE IF NOT EXISTS activity_materials (
            type_id INTEGER NOT NULL,
            activity_id INTEGER NOT NULL,
            material_type_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_materials ON activity_materials (type_id, activity_id);
        CREATE TABLE IF NOT EXISTS activity_products (
            type_id INTEGER NOT NULL,
            activity_id INTEGER NOT NULL,
            product_type_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_products ON activity_products (type_id, activity_id);
        CREATE INDEX IF NOT EXISTS idx_activity_products_by_product ON activity_products (product_type_id);
        CREATE TABLE IF NOT EXISTS activity_probabilities (
            type_id INTEGER NOT NULL,
            activity_id INTEGER NOT NULL,
            product_type_id INTEGER NOT NULL,
            probability REAL NOT NULL,
            PRIMARY KEY (type_id, activity_id, product_type_id)
        );
        CREATE TABLE IF NOT EXISTS reprocessing_materials (
            type_id INTEGER NOT NULL,
            material_type_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reprocessing_materials ON reprocessing_materials (type_id);",
    )
    .map_err(|e| format!("failed to create market tables: {e}"))?;
    // Installs synced before a later column was added have a table from the
    // older CREATE TABLE above, which "IF NOT EXISTS" leaves untouched. Add
    // whatever's missing rather than erroring - the actual values get
    // backfilled by the resync ensure_synced's migration check triggers.
    let _ = conn.execute("ALTER TABLE types ADD COLUMN volume REAL NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE market_groups ADD COLUMN icon_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN mass REAL NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN portion_size INTEGER NOT NULL DEFAULT 1", []);
    Ok(())
}

/// True if the local cache predates the `volume`, `icon_id`, or `mass`
/// columns and needs a full resync to backfill real values (ensure_schema's
/// ALTER TABLE only adds the column itself - it can't retroactively know
/// each row's actual value without redownloading the CSVs).
fn needs_migration(conn: &rusqlite::Connection) -> bool {
    let types_total: i64 = conn.query_row("SELECT COUNT(*) FROM types", [], |row| row.get(0)).unwrap_or(0);
    let types_with_volume: i64 =
        conn.query_row("SELECT COUNT(*) FROM types WHERE volume != 0", [], |row| row.get(0)).unwrap_or(0);
    let types_with_mass: i64 =
        conn.query_row("SELECT COUNT(*) FROM types WHERE mass != 0", [], |row| row.get(0)).unwrap_or(0);
    let groups_total: i64 = conn.query_row("SELECT COUNT(*) FROM market_groups", [], |row| row.get(0)).unwrap_or(0);
    let groups_with_icon: i64 =
        conn.query_row("SELECT COUNT(*) FROM market_groups WHERE icon_id IS NOT NULL", [], |row| row.get(0)).unwrap_or(0);
    let activities_total: i64 = conn.query_row("SELECT COUNT(*) FROM activities", [], |row| row.get(0)).unwrap_or(0);
    (types_total > 0 && (types_with_volume == 0 || types_with_mass == 0))
        || (groups_total > 0 && groups_with_icon == 0)
        || (types_total > 0 && activities_total == 0)
}

/// Shared by every domain module (map, PI, market) that syncs its reference
/// data from a Fuzzwork SDE CSV mirror - was copy-pasted identically in each
/// of those three files before this became the one canonical copy.
pub(crate) async fn download_csv(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().await.map_err(|e| format!("failed to download {url}: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("{url} returned {status}"));
    }
    response.text().await.map_err(|e| format!("failed to read response body from {url}: {e}"))
}

/// Replaces the whole local catalog from freshly-downloaded CSVs inside one
/// transaction, same crash-safety reasoning as map.rs's import. Only
/// published items with a market group are kept - unpublished/non-tradeable
/// rows (SKINs, blueprints copies, deprecated items, etc.) would just be
/// search-result noise for a market tool.
fn import_market_data(conn: &mut rusqlite::Connection, types_csv: &str, groups_csv: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch("DELETE FROM types; DELETE FROM market_groups;")
        .map_err(|e| format!("failed to clear market tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare("INSERT INTO types (id, name, market_group_id, volume, mass, portion_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(|e| format!("failed to prepare types insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(types_csv.as_bytes());
        for result in reader.deserialize::<TypeRow>() {
            let Ok(row) = result else { continue };
            if row.published == 0 || row.market_group_id.is_none() {
                continue;
            }
            let _ = stmt.execute(rusqlite::params![
                row.type_id,
                row.type_name,
                row.market_group_id,
                row.volume.unwrap_or(0.0),
                row.mass.unwrap_or(0.0),
                row.portion_size.unwrap_or(1)
            ]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO market_groups (id, parent_id, name, has_types, icon_id) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(|e| format!("failed to prepare market_groups insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(groups_csv.as_bytes());
        for result in reader.deserialize::<MarketGroupRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![
                row.market_group_id,
                row.parent_group_id,
                row.market_group_name,
                row.has_types,
                row.icon_id,
            ]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit market catalog: {e}"))
}

/// Blueprint/reaction/reprocessing data doesn't filter by published/market
/// group the way import_market_data does - a reaction intermediate or an
/// NPC-only material still needs to appear correctly in a BOM even if it
/// wouldn't be shown as its own browsable market listing. Any material/
/// product id that ends up missing from `types` (filtered out there) just
/// falls back to a "Type #id" placeholder at query time rather than being
/// excluded here too.
fn import_industry_data(
    conn: &mut rusqlite::Connection,
    activity_csv: &str,
    materials_csv: &str,
    products_csv: &str,
    probabilities_csv: &str,
    reprocessing_csv: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch(
        "DELETE FROM activities; DELETE FROM activity_materials; DELETE FROM activity_products;
         DELETE FROM activity_probabilities; DELETE FROM reprocessing_materials;",
    )
    .map_err(|e| format!("failed to clear industry tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO activities (type_id, activity_id, time_seconds) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare activities insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(activity_csv.as_bytes());
        for result in reader.deserialize::<ActivityRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.activity_id, row.time_seconds]);
        }
    }
    {
        let mut stmt = tx
            .prepare("INSERT INTO activity_materials (type_id, activity_id, material_type_id, quantity) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("failed to prepare activity_materials insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(materials_csv.as_bytes());
        for result in reader.deserialize::<ActivityMaterialRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.activity_id, row.material_type_id, row.quantity]);
        }
    }
    {
        let mut stmt = tx
            .prepare("INSERT INTO activity_products (type_id, activity_id, product_type_id, quantity) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("failed to prepare activity_products insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(products_csv.as_bytes());
        for result in reader.deserialize::<ActivityProductRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.activity_id, row.product_type_id, row.quantity]);
        }
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO activity_probabilities (type_id, activity_id, product_type_id, probability) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("failed to prepare activity_probabilities insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(probabilities_csv.as_bytes());
        for result in reader.deserialize::<ActivityProbabilityRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.activity_id, row.product_type_id, row.probability]);
        }
    }
    {
        let mut stmt = tx
            .prepare("INSERT INTO reprocessing_materials (type_id, material_type_id, quantity) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare reprocessing_materials insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(reprocessing_csv.as_bytes());
        for result in reader.deserialize::<ReprocessingMaterialRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.material_type_id, row.quantity]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit industry data: {e}"))
}

pub(crate) async fn ensure_synced(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
            ensure_schema(&conn)?;
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM types", [], |row| row.get(0)).unwrap_or(0);
            Ok(count == 0 || needs_migration(&conn))
        })
        .await
        .map_err(|e| format!("market database task failed: {e}"))??
    };

    if needs_sync {
        let (types_csv, groups_csv, activity_csv, materials_csv, products_csv, probabilities_csv, reprocessing_csv) = futures::try_join!(
            download_csv(client, TYPES_CSV_URL),
            download_csv(client, MARKET_GROUPS_CSV_URL),
            download_csv(client, ACTIVITY_CSV_URL),
            download_csv(client, ACTIVITY_MATERIALS_CSV_URL),
            download_csv(client, ACTIVITY_PRODUCTS_CSV_URL),
            download_csv(client, ACTIVITY_PROBABILITIES_CSV_URL),
            download_csv(client, REPROCESSING_MATERIALS_CSV_URL),
        )?;

        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
            import_market_data(&mut conn, &types_csv, &groups_csv)?;
            import_industry_data(&mut conn, &activity_csv, &materials_csv, &products_csv, &probabilities_csv, &reprocessing_csv)
        })
        .await
        .map_err(|e| format!("market import task failed: {e}"))??;
    }

    Ok(path)
}

/// Forces a full re-download of the market/industry reference catalog -
/// clears the `types` table (the same "is this synced yet" signal
/// ensure_synced already checks via `count == 0`) so the very next
/// ensure_synced call thinks it's starting cold and redownloads all 7 CSVs
/// fresh. Scoped to market.sqlite only, which holds nothing but
/// redownloadable SDE data - a user's wormhole chains/signatures live in
/// the entirely separate wormholes.sqlite and can't be reached from here.
pub async fn force_resync(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let path = db_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        conn.execute("DELETE FROM types", []).map_err(|e| format!("failed to clear market cache: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("market database task failed: {e}"))??;

    ensure_synced(app, client).await?;
    Ok(())
}

/// A ship hull's real static mass in kg, for the wormhole rolling
/// calculator's "Use my ship" button - a static SDE column, not a live ESI
/// call (mass never changes for a given hull, so this is cheap to look up
/// on demand rather than re-fetched on every location poll tick).
pub async fn get_type_mass(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<Option<f64>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<f64>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        match conn.query_row("SELECT mass FROM types WHERE id = ?1", [type_id], |row| row.get::<_, f64>(0)) {
            Ok(mass) => Ok(Some(mass)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("failed to query type mass: {e}")),
        }
    })
    .await
    .map_err(|e| format!("type mass task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct TypeSearchMatch {
    pub id: i64,
    pub name: String,
    pub market_group_id: Option<i64>,
    pub volume: f64,
}

/// Fast local typeahead for item names - the same "sync once, query SQLite"
/// pattern as map::search_systems, so Market Browser/Price Checker/Screener
/// don't need an ESI round trip (or ESI's name-only-exact-match /universe/ids/)
/// on every keystroke.
pub async fn search_types(app: tauri::AppHandle, client: &reqwest::Client, query: String) -> Result<Vec<TypeSearchMatch>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSearchMatch>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let pattern = format!("%{trimmed}%");
        let mut stmt = conn
            .prepare(
                "SELECT id, name, market_group_id, volume FROM types WHERE name LIKE ?1 \
                 ORDER BY (name NOT LIKE ?2), length(name), name LIMIT 25",
            )
            .map_err(|e| format!("failed to query types: {e}"))?;
        let prefix_pattern = format!("{trimmed}%");
        let rows = stmt
            .query_map(rusqlite::params![pattern, prefix_pattern], |row| {
                Ok(TypeSearchMatch { id: row.get(0)?, name: row.get(1)?, market_group_id: row.get(2)?, volume: row.get(3)? })
            })
            .map_err(|e| format!("failed to query types: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read type row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("type search task failed: {e}"))?
}

/// Falls back to "Type #id" for anything import_market_data's published/
/// market-group filter left out of `types` - a reaction intermediate or
/// NPC-only material shouldn't break the whole BOM display just because it
/// isn't independently browsable on the market.
fn type_name_or_placeholder(conn: &rusqlite::Connection, type_id: i64) -> String {
    conn.query_row("SELECT name FROM types WHERE id = ?1", [type_id], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| format!("Type #{type_id}"))
}

/// Blueprints/reaction formulas that resolved out of a plain type search
/// - filtered to type_ids that actually have manufacturing or reaction
/// activity data, so this only ever returns things actually buildable.
pub async fn search_blueprints(app: tauri::AppHandle, client: &reqwest::Client, query: String) -> Result<Vec<TypeSearchMatch>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSearchMatch>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let pattern = format!("%{trimmed}%");
        let prefix_pattern = format!("{trimmed}%");
        let mut stmt = conn
            .prepare(
                "SELECT id, name, market_group_id, volume FROM types
                 WHERE name LIKE ?1 AND id IN (
                     SELECT DISTINCT type_id FROM activities WHERE activity_id IN (?3, ?4)
                 )
                 ORDER BY (name NOT LIKE ?2), length(name), name LIMIT 25",
            )
            .map_err(|e| format!("failed to query blueprints: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![pattern, prefix_pattern, ACTIVITY_MANUFACTURING, ACTIVITY_REACTION], |row| {
                Ok(TypeSearchMatch { id: row.get(0)?, name: row.get(1)?, market_group_id: row.get(2)?, volume: row.get(3)? })
            })
            .map_err(|e| format!("failed to query blueprints: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read blueprint row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("blueprint search task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct MaterialLine {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
}

#[derive(Serialize, Clone)]
pub struct ActivityInfo {
    pub time_seconds: i64,
    pub materials: Vec<MaterialLine>,
    pub products: Vec<MaterialLine>,
}

#[derive(Serialize, Clone)]
pub struct InventionOutcome {
    pub product_type_id: i64,
    pub product_name: String,
    pub quantity: i64,
    pub probability: f64,
}

#[derive(Serialize, Clone)]
pub struct InventionInfo {
    pub time_seconds: i64,
    pub materials: Vec<MaterialLine>,
    pub outcomes: Vec<InventionOutcome>,
}

#[derive(Serialize)]
pub struct BlueprintDetail {
    pub type_id: i64,
    pub name: String,
    pub manufacturing: Option<ActivityInfo>,
    pub reaction: Option<ActivityInfo>,
    pub copying: Option<ActivityInfo>,
    pub research_me: Option<ActivityInfo>,
    pub research_te: Option<ActivityInfo>,
    pub invention: Option<InventionInfo>,
}

fn fetch_activity_info(conn: &rusqlite::Connection, type_id: i64, activity_id: i64) -> Result<Option<ActivityInfo>, String> {
    let time_seconds: Option<i64> = conn
        .query_row("SELECT time_seconds FROM activities WHERE type_id = ?1 AND activity_id = ?2", [type_id, activity_id], |row| {
            row.get(0)
        })
        .ok();
    let Some(time_seconds) = time_seconds else { return Ok(None) };

    let mut materials = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT material_type_id, quantity FROM activity_materials WHERE type_id = ?1 AND activity_id = ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([type_id, activity_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (material_type_id, quantity) = row.map_err(|e| e.to_string())?;
            materials.push(MaterialLine { type_id: material_type_id, name: type_name_or_placeholder(conn, material_type_id), quantity });
        }
    }

    let mut products = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT product_type_id, quantity FROM activity_products WHERE type_id = ?1 AND activity_id = ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([type_id, activity_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (product_type_id, quantity) = row.map_err(|e| e.to_string())?;
            products.push(MaterialLine { type_id: product_type_id, name: type_name_or_placeholder(conn, product_type_id), quantity });
        }
    }

    Ok(Some(ActivityInfo { time_seconds, materials, products }))
}

fn fetch_invention_info(conn: &rusqlite::Connection, type_id: i64) -> Result<Option<InventionInfo>, String> {
    let Some(base) = fetch_activity_info(conn, type_id, ACTIVITY_INVENTION)? else { return Ok(None) };

    let mut outcomes = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT p.product_type_id, p.quantity, COALESCE(pr.probability, 0)
             FROM activity_products p
             LEFT JOIN activity_probabilities pr
               ON pr.type_id = p.type_id AND pr.activity_id = p.activity_id AND pr.product_type_id = p.product_type_id
             WHERE p.type_id = ?1 AND p.activity_id = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([type_id, ACTIVITY_INVENTION], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (product_type_id, quantity, probability) = row.map_err(|e| e.to_string())?;
        outcomes.push(InventionOutcome {
            product_type_id,
            product_name: type_name_or_placeholder(conn, product_type_id),
            quantity,
            probability,
        });
    }

    Ok(Some(InventionInfo { time_seconds: base.time_seconds, materials: base.materials, outcomes }))
}

/// Every activity (manufacturing/reaction/copying/ME research/TE research/
/// invention) this type_id has data for - a plain item with no blueprint
/// data at all returns all-None fields rather than an error, so the
/// frontend can use one call to check "is this even a blueprint" too.
pub async fn get_blueprint_detail(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<BlueprintDetail, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<BlueprintDetail, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        Ok(BlueprintDetail {
            type_id,
            name: type_name_or_placeholder(&conn, type_id),
            manufacturing: fetch_activity_info(&conn, type_id, ACTIVITY_MANUFACTURING)?,
            reaction: fetch_activity_info(&conn, type_id, ACTIVITY_REACTION)?,
            copying: fetch_activity_info(&conn, type_id, ACTIVITY_COPYING)?,
            research_me: fetch_activity_info(&conn, type_id, ACTIVITY_RESEARCH_ME)?,
            research_te: fetch_activity_info(&conn, type_id, ACTIVITY_RESEARCH_TE)?,
            invention: fetch_invention_info(&conn, type_id)?,
        })
    })
    .await
    .map_err(|e| format!("blueprint detail task failed: {e}"))?
}

/// Reverse lookup: which blueprint/reaction (if any) produces this material
/// as its output - the core operation BOM recursion needs to decide whether
/// a material is itself buildable or a raw/bought input. Manufacturing is
/// checked before reaction since nothing in the SDE produces the same
/// product type via both.
pub async fn find_blueprint_for_product(app: tauri::AppHandle, client: &reqwest::Client, product_type_id: i64) -> Result<Option<i64>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<i64>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let result: Option<i64> = conn
            .query_row(
                "SELECT type_id FROM activity_products WHERE product_type_id = ?1 AND activity_id IN (?2, ?3) LIMIT 1",
                rusqlite::params![product_type_id, ACTIVITY_MANUFACTURING, ACTIVITY_REACTION],
                |row| row.get(0),
            )
            .ok();
        Ok(result)
    })
    .await
    .map_err(|e| format!("blueprint-for-product task failed: {e}"))?
}

#[derive(Serialize)]
pub struct ReprocessingInfo {
    pub type_id: i64,
    pub name: String,
    pub portion_size: i64,
    pub materials: Vec<MaterialLine>,
}

pub async fn get_reprocessing_materials(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<ReprocessingInfo, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ReprocessingInfo, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let portion_size: i64 =
            conn.query_row("SELECT portion_size FROM types WHERE id = ?1", [type_id], |row| row.get(0)).unwrap_or(1);
        let mut materials = Vec::new();
        let mut stmt = conn
            .prepare("SELECT material_type_id, quantity FROM reprocessing_materials WHERE type_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([type_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            let (material_type_id, quantity) = row.map_err(|e| e.to_string())?;
            materials.push(MaterialLine { type_id: material_type_id, name: type_name_or_placeholder(&conn, material_type_id), quantity });
        }
        Ok(ReprocessingInfo { type_id, name: type_name_or_placeholder(&conn, type_id), portion_size, materials })
    })
    .await
    .map_err(|e| format!("reprocessing materials task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct MarketGroupNode {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub has_types: bool,
    pub icon_id: Option<i64>,
}

/// The full market category tree (a few thousand small rows) - cheap enough
/// to send whole and let the frontend assemble parent/child nesting, same
/// approach as get_map_data returning flat systems/jumps.
pub async fn get_market_groups(app: tauri::AppHandle, client: &reqwest::Client) -> Result<Vec<MarketGroupNode>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<MarketGroupNode>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id, parent_id, name, has_types, icon_id FROM market_groups ORDER BY name")
            .map_err(|e| format!("failed to query market_groups: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let has_types: i64 = row.get(3)?;
                Ok(MarketGroupNode {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    name: row.get(2)?,
                    has_types: has_types != 0,
                    icon_id: row.get(4)?,
                })
            })
            .map_err(|e| format!("failed to query market_groups: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read market_group row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("market group task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct TypeSummary {
    pub id: i64,
    pub name: String,
}

/// The items filed directly under one leaf market group (e.g. "Standard
/// Frigates"), for Market Browser's category-tree navigation.
pub async fn get_market_group_types(
    app: tauri::AppHandle,
    client: &reqwest::Client,
    market_group_id: i64,
) -> Result<Vec<TypeSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id, name FROM types WHERE market_group_id = ?1 ORDER BY name")
            .map_err(|e| format!("failed to query types: {e}"))?;
        let rows = stmt
            .query_map([market_group_id], |row| Ok(TypeSummary { id: row.get(0)?, name: row.get(1)? }))
            .map_err(|e| format!("failed to query types: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read type row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("market group types task failed: {e}"))?
}

#[derive(Deserialize)]
struct EsiTypeDetail {
    #[serde(default)]
    description: String,
}

/// An item's flavor-text description - ESI's `/universe/types/{id}/`
/// `description` field. Not stored in the local `types` table (that only
/// keeps name/market_group_id/volume, see ensure_schema), so this is a
/// live fetch, cached in-memory for the life of the process the same way
/// esi.rs's SKILL_INFO_CACHE caches other static SDE lookups that never
/// change mid-session.
static TYPE_DESCRIPTION_CACHE: LazyLock<Mutex<HashMap<i64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn fetch_item_description(client: &reqwest::Client, type_id: i64) -> String {
    if let Some(cached) = TYPE_DESCRIPTION_CACHE.lock().unwrap().get(&type_id).cloned() {
        return cached;
    }
    let description =
        public_get::<EsiTypeDetail>(client, &format!("/universe/types/{type_id}/")).await.map(|d| d.description).unwrap_or_default();
    TYPE_DESCRIPTION_CACHE.lock().unwrap().insert(type_id, description.clone());
    description
}

// --- Public ESI market data (no OAuth scope needed - region orders/history
// and global prices are all open endpoints) -------------------------------

#[derive(Deserialize, Serialize, Clone)]
pub struct MarketOrder {
    pub order_id: i64,
    pub is_buy_order: bool,
    pub price: f64,
    pub volume_remain: i64,
    pub volume_total: i64,
    pub min_volume: i32,
    pub duration: i32,
    pub issued: String,
    pub location_id: i64,
    pub system_id: i64,
    pub range: String,
}

/// Every open order for one item in one region (both buy and sell sides -
/// ESI's order_type=all filters server-side, still paginated for busy hubs
/// like Jita/The Forge which can run a dozen+ pages for a single item).
pub async fn fetch_region_orders(client: &reqwest::Client, region_id: i64, type_id: i64) -> Result<Vec<MarketOrder>, String> {
    public_get_paginated::<MarketOrder>(client, &format!("/markets/{region_id}/orders/?order_type=all&type_id={type_id}")).await
}

/// Just the lowest sell-order price for one item in one region - for
/// callers (Industry tab's shopping list, priced per trade hub) that only
/// need "what would this cost me right now", not the full two-sided order
/// book fetch_region_orders returns. order_type=sell halves the pages ESI
/// has to paginate through for busy hub items (minerals in Jita etc.),
/// and only the minimum price crosses back into Rust->JS, not every order.
const SELL_MIN_CACHE_TTL: Duration = Duration::from_secs(45);
const SELL_MIN_RESOLVE_CONCURRENCY: usize = 10;

static SELL_MIN_CACHE: LazyLock<Mutex<HashMap<(i64, i64), (Option<f64>, SystemTime)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cheapest region sell-order price for one item, cached briefly (45s) so
/// repeated Industry "Calculate" presses while tweaking ME/TE/runs/hub don't
/// re-hit ESI for materials whose price hasn't meaningfully changed.
pub async fn fetch_region_sell_min(client: &reqwest::Client, region_id: i64, type_id: i64) -> Result<Option<f64>, String> {
    let key = (region_id, type_id);
    if let Some((price, fetched_at)) = SELL_MIN_CACHE.lock().unwrap().get(&key).copied() {
        if fetched_at.elapsed().unwrap_or(Duration::MAX) < SELL_MIN_CACHE_TTL {
            return Ok(price);
        }
    }
    let orders = public_get_paginated::<MarketOrder>(client, &format!("/markets/{region_id}/orders/?order_type=sell&type_id={type_id}")).await?;
    let price = orders.into_iter().map(|o| o.price).fold(None, |min, price| match min {
        None => Some(price),
        Some(m) if price < m => Some(price),
        Some(m) => Some(m),
    });
    SELL_MIN_CACHE.lock().unwrap().insert(key, (price, SystemTime::now()));
    Ok(price)
}

/// Bulk variant for Industry's build-tree pricing: one IPC call for a whole
/// material list instead of one per material. Bounded concurrency keeps a
/// large BOM from firing dozens of simultaneous ESI requests; the per-item
/// cache above means repeat calls for materials that haven't changed are
/// nearly free. Silently drops any material ESI failed to price rather than
/// failing the whole batch over one bad type_id.
pub async fn fetch_region_sell_min_prices(client: &reqwest::Client, region_id: i64, type_ids: Vec<i64>) -> HashMap<i64, f64> {
    stream::iter(type_ids)
        .map(|type_id| async move {
            let price = fetch_region_sell_min(client, region_id, type_id).await.ok().flatten();
            price.map(|p| (type_id, p))
        })
        .buffer_unordered(SELL_MIN_RESOLVE_CONCURRENCY)
        .filter_map(|result| async move { result })
        .collect()
        .await
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MarketHistoryPoint {
    pub date: String,
    pub average: f64,
    pub highest: f64,
    pub lowest: f64,
    pub order_count: i64,
    pub volume: i64,
}

/// Daily price/volume history for one item in one region - typically a full
/// year or more of data in a single (non-paginated) response.
pub async fn fetch_region_history(client: &reqwest::Client, region_id: i64, type_id: i64) -> Result<Vec<MarketHistoryPoint>, String> {
    public_get::<Vec<MarketHistoryPoint>>(client, &format!("/markets/{region_id}/history/?type_id={type_id}")).await
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MarketPrice {
    pub type_id: i64,
    pub adjusted_price: Option<f64>,
    pub average_price: Option<f64>,
}

static GLOBAL_PRICES_CACHE: LazyLock<Mutex<Option<(Vec<MarketPrice>, SystemTime)>>> = LazyLock::new(|| Mutex::new(None));
/// EVE-wide prices drift slowly - a 15 minute cache means every feature that
/// reads this (Industry, Market Browser, Appraisal, Fittings, Screener) gets
/// a shared, recently-fresh snapshot instead of each one re-fetching from
/// ESI, while still not going stale for the length of a session like the
/// previous unconditional-forever cache did.
const GLOBAL_PRICES_TTL: Duration = Duration::from_secs(15 * 60);

/// EVE-wide average/adjusted price per item type. Used as Price Checker's
/// fallback valuation for items with no live order book in the chosen region
/// (or as a fast first estimate before drilling into real orders).
pub async fn fetch_market_prices(client: &reqwest::Client) -> Result<Vec<MarketPrice>, String> {
    if let Some((cached, fetched_at)) = GLOBAL_PRICES_CACHE.lock().unwrap().clone() {
        if fetched_at.elapsed().unwrap_or(Duration::MAX) < GLOBAL_PRICES_TTL {
            return Ok(cached);
        }
    }
    let prices = public_get::<Vec<MarketPrice>>(client, "/markets/prices/").await?;
    *GLOBAL_PRICES_CACHE.lock().unwrap() = Some((prices.clone(), SystemTime::now()));
    Ok(prices)
}
