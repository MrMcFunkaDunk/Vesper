use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Fuzzwork's per-table SDE CSV exports - a community mirror of CCP's
/// official Static Data Export, widely used by EVE third-party tools for
/// exactly this purpose. Downloading these three small tables (~3MB total)
/// instead of the full SDE dump (150MB+, most of it item/blueprint data we
/// don't need) keeps this a one-time, lightweight sync rather than
/// something that needs bundling or heavy infrastructure.
const SYSTEMS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystems.csv";
const JUMPS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystemJumps.csv";
const REGIONS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapRegions.csv";

#[derive(Deserialize)]
struct SystemRow {
    #[serde(rename = "regionID")]
    region_id: i64,
    #[serde(rename = "solarSystemID")]
    solar_system_id: i64,
    #[serde(rename = "solarSystemName")]
    solar_system_name: String,
    security: f64,
    #[serde(rename = "position2Dx")]
    position_2d_x: f64,
    #[serde(rename = "position2Dy")]
    position_2d_y: f64,
}

#[derive(Deserialize)]
struct JumpRow {
    #[serde(rename = "fromSolarSystemID")]
    from_solar_system_id: i64,
    #[serde(rename = "toSolarSystemID")]
    to_solar_system_id: i64,
}

#[derive(Deserialize)]
struct RegionRow {
    #[serde(rename = "regionID")]
    region_id: i64,
    #[serde(rename = "regionName")]
    region_name: String,
}

#[derive(Serialize, Clone)]
pub struct MapSystem {
    pub id: i64,
    pub name: String,
    pub region_id: i64,
    pub security: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct MapJump {
    pub from: i64,
    pub to: i64,
}

#[derive(Serialize, Clone)]
pub struct MapRegion {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize)]
pub struct MapData {
    pub systems: Vec<MapSystem>,
    pub jumps: Vec<MapJump>,
    pub regions: Vec<MapRegion>,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("map.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS systems (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            region_id INTEGER NOT NULL,
            security REAL NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jumps (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS regions (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    )
    .map_err(|e| format!("failed to create map tables: {e}"))
}

async fn download_csv(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().await.map_err(|e| format!("failed to download {url}: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("{url} returned {status}"));
    }
    response.text().await.map_err(|e| format!("failed to read response body from {url}: {e}"))
}

/// Replaces the whole local map cache from freshly-downloaded CSVs, inside
/// one transaction so a crash or network failure mid-import leaves the
/// previous (or empty) state intact rather than a half-populated table.
/// Rows that fail to parse (e.g. a wormhole system with no normal-space
/// security value) are just skipped rather than failing the whole import.
fn import_map_data(conn: &mut rusqlite::Connection, systems_csv: &str, jumps_csv: &str, regions_csv: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch("DELETE FROM systems; DELETE FROM jumps; DELETE FROM regions;")
        .map_err(|e| format!("failed to clear map tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare("INSERT INTO systems (id, name, region_id, security, x, y) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(|e| format!("failed to prepare systems insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(systems_csv.as_bytes());
        for result in reader.deserialize::<SystemRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![
                row.solar_system_id,
                row.solar_system_name,
                row.region_id,
                row.security,
                row.position_2d_x,
                row.position_2d_y,
            ]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO jumps (from_id, to_id) VALUES (?1, ?2)")
            .map_err(|e| format!("failed to prepare jumps insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(jumps_csv.as_bytes());
        for result in reader.deserialize::<JumpRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.from_solar_system_id, row.to_solar_system_id]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO regions (id, name) VALUES (?1, ?2)")
            .map_err(|e| format!("failed to prepare regions insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(regions_csv.as_bytes());
        for result in reader.deserialize::<RegionRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.region_id, row.region_name]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit map data: {e}"))
}

fn read_map_data(conn: &rusqlite::Connection) -> Result<MapData, String> {
    let mut systems = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, region_id, security, x, y FROM systems")
            .map_err(|e| format!("failed to query systems: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MapSystem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    region_id: row.get(2)?,
                    security: row.get(3)?,
                    x: row.get(4)?,
                    y: row.get(5)?,
                })
            })
            .map_err(|e| format!("failed to read systems: {e}"))?;
        for row in rows.flatten() {
            systems.push(row);
        }
    }

    let mut jumps = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT from_id, to_id FROM jumps").map_err(|e| format!("failed to query jumps: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok(MapJump { from: row.get(0)?, to: row.get(1)? }))
            .map_err(|e| format!("failed to read jumps: {e}"))?;
        for row in rows.flatten() {
            jumps.push(row);
        }
    }

    let mut regions = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, name FROM regions").map_err(|e| format!("failed to query regions: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok(MapRegion { id: row.get(0)?, name: row.get(1)? }))
            .map_err(|e| format!("failed to read regions: {e}"))?;
        for row in rows.flatten() {
            regions.push(row);
        }
    }

    Ok(MapData { systems, jumps, regions })
}

/// Ensures the local SQLite cache is populated, syncing it from Fuzzwork's
/// SDE CSV exports first if empty (first run, or the app data directory was
/// cleared). Returns the DB path once ready. Shared by get_map_data and
/// search_systems so both benefit from the same one-time sync.
async fn ensure_synced(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            ensure_schema(&conn)?;
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM systems", [], |row| row.get(0)).unwrap_or(0);
            Ok(count == 0)
        })
        .await
        .map_err(|e| format!("map database task failed: {e}"))??
    };

    if needs_sync {
        let (systems_csv, jumps_csv, regions_csv) = futures::future::try_join3(
            download_csv(client, SYSTEMS_CSV_URL),
            download_csv(client, JUMPS_CSV_URL),
            download_csv(client, REGIONS_CSV_URL),
        )
        .await?;

        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            import_map_data(&mut conn, &systems_csv, &jumps_csv, &regions_csv)
        })
        .await
        .map_err(|e| format!("map import task failed: {e}"))??;
    }

    Ok(path)
}

/// Loads the universe map (systems/jumps/regions) from the local SQLite
/// cache. SQLite access is blocking, so it's kept off the async runtime via
/// spawn_blocking.
pub async fn get_map_data(app: tauri::AppHandle, client: &reqwest::Client) -> Result<MapData, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<MapData, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        read_map_data(&conn)
    })
    .await
    .map_err(|e| format!("map read task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct SystemSearchMatch {
    pub id: i64,
    pub name: String,
    pub security: f64,
}

/// Live typeahead search for adding a Tracked System - a fast local prefix
/// match against the same SDE-derived systems table the map uses, unlike
/// ESI's /universe/ids/ which only matches exact names (see kills::search_system).
pub async fn search_systems(app: tauri::AppHandle, client: &reqwest::Client, query: String) -> Result<Vec<SystemSearchMatch>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SystemSearchMatch>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        let pattern = format!("{trimmed}%");
        let mut stmt = conn
            .prepare("SELECT id, name, security FROM systems WHERE name LIKE ?1 ORDER BY name LIMIT 15")
            .map_err(|e| format!("failed to query systems: {e}"))?;
        let rows = stmt
            .query_map([&pattern], |row| Ok(SystemSearchMatch { id: row.get(0)?, name: row.get(1)?, security: row.get(2)? }))
            .map_err(|e| format!("failed to query systems: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read system row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("system search task failed: {e}"))?
}
