use crate::esi;
use crate::kills;
use crate::market;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// How many player structures resolve at once - ESI requires a real
/// authorized call per structure (no bulk endpoint), so this bounds request
/// concurrency to something polite rather than firing off ~900 at once.
const STRUCTURE_RESOLVE_CONCURRENCY: usize = 15;
/// Player structures rarely move or get renamed, so a full resync only
/// happens about once a day rather than every time the map or stats popup
/// is opened.
const STRUCTURE_RESYNC_INTERVAL_SECS: i64 = 24 * 3600;

/// ESI's /universe/system_jumps/ only ever reports the last hour, with no
/// historical endpoint anywhere (confirmed live) - unlike kills, which
/// zKillboard can page back through, a 48h jumps graph has no retroactive
/// source and has to be built forward from a live sampler that starts
/// accumulating the moment the app launches. A system viewed for the first
/// time (or right after a fresh install) just shows a short graph that
/// fills in the more the app stays running.
const JUMP_HISTORY_SAMPLE_INTERVAL_SECS: u64 = 15 * 60;
const JUMP_HISTORY_RETENTION_SECS: i64 = 48 * 3600;

/// Fuzzwork's per-table SDE CSV exports - a community mirror of CCP's
/// official Static Data Export, widely used by EVE third-party tools for
/// exactly this purpose. Downloading these three small tables (~3MB total)
/// instead of the full SDE dump (150MB+, most of it item/blueprint data we
/// don't need) keeps this a one-time, lightweight sync rather than
/// something that needs bundling or heavy infrastructure.
const SYSTEMS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystems.csv";
const JUMPS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystemJumps.csv";
const REGIONS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapRegions.csv";
const CONSTELLATIONS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapConstellations.csv";
// NPC station -> operation -> service chain (DOTLAN-style map key icons:
// Refinery, Factory, Cloning, Office Rental, etc). Confirmed live that ESI
// has no bulk "station services by system" endpoint, but the SDE encodes
// exactly this: every station has an operationID, and staOperationServices
// maps that to the service names in staServices - a one-time sync, same as
// the rest of this table, rather than needing a live call per station.
const STA_STATIONS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/staStations.csv";
const STA_OPERATION_SERVICES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/staOperationServices.csv";
const STA_SERVICES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/staServices.csv";
// Every celestial object in New Eden (stars, planets, moons, belts,
// stargates) for the System Stats popup's Celestials tab. This is the SDE's
// largest single table (~80MB) since it covers the whole universe including
// w-space, but it's still a one-time sync like everything else here -
// filtered down at import time to just the groupIDs actually shown (see
// CELESTIAL_GROUP_IDS), so the resulting local table is a small fraction of
// that raw size.
const MAP_DENORMALIZE_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/mapDenormalize.csv";
const INV_GROUPS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv";
/// Sun, Planet, Moon, Asteroid Belt (two distinct groupIDs cover this), Stargate.
const CELESTIAL_GROUP_IDS: [i64; 6] = [6, 7, 8, 9, 4430, 10];

#[derive(Deserialize)]
struct SystemRow {
    #[serde(rename = "regionID")]
    region_id: i64,
    #[serde(rename = "constellationID")]
    constellation_id: i64,
    #[serde(rename = "solarSystemID")]
    solar_system_id: i64,
    #[serde(rename = "solarSystemName")]
    solar_system_name: String,
    security: f64,
    #[serde(rename = "position2Dx")]
    position_2d_x: f64,
    #[serde(rename = "position2Dy")]
    position_2d_y: f64,
    /// The system's real 3D position in meters (distinct from the
    /// position2Dx/y DOTLAN-style map projection above) - needed for
    /// genuine light-year jump-range math, since the flattened 2D
    /// projection distorts real distances between systems.
    x: f64,
    y: f64,
    z: f64,
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

#[derive(Deserialize)]
struct StationRow {
    #[serde(rename = "stationID")]
    station_id: i64,
    #[serde(rename = "stationName")]
    station_name: String,
    #[serde(rename = "operationID")]
    operation_id: i64,
    #[serde(rename = "solarSystemID")]
    solar_system_id: i64,
}

#[derive(Deserialize)]
struct DenormalizeRow {
    #[serde(rename = "itemID")]
    item_id: i64,
    #[serde(rename = "groupID")]
    group_id: i64,
    #[serde(rename = "solarSystemID")]
    solar_system_id: Option<i64>,
    #[serde(rename = "orbitID")]
    orbit_id: Option<i64>,
    #[serde(rename = "itemName")]
    item_name: Option<String>,
}

#[derive(Deserialize)]
struct GroupRow {
    #[serde(rename = "groupID")]
    group_id: i64,
    #[serde(rename = "groupName")]
    group_name: String,
}

#[derive(Deserialize)]
struct OperationServiceRow {
    #[serde(rename = "operationID")]
    operation_id: i64,
    #[serde(rename = "serviceID")]
    service_id: i64,
}

#[derive(Deserialize)]
struct ServiceRow {
    #[serde(rename = "serviceID")]
    service_id: i64,
    #[serde(rename = "serviceName")]
    service_name: String,
}

/// A player-owned Upwell structure with an industry service slot (Refinery
/// or Engineering Complex class). Public and live via ESI, unlike its exact
/// enabled services - reading those needs docking-level corp auth we don't
/// have, so this only tells us presence, not which services are toggled on.
#[derive(Deserialize)]
struct IndustryFacility {
    solar_system_id: i64,
}

#[derive(Deserialize)]
struct SystemJumpsEntry {
    system_id: i64,
    ship_jumps: i64,
}

#[derive(Deserialize)]
struct SystemKillsEntry {
    system_id: i64,
    ship_kills: i64,
    npc_kills: i64,
    pod_kills: i64,
}

#[derive(Deserialize)]
struct ConstellationRow {
    #[serde(rename = "regionID")]
    region_id: i64,
    #[serde(rename = "constellationID")]
    constellation_id: i64,
    #[serde(rename = "constellationName")]
    constellation_name: String,
}

#[derive(Serialize, Clone)]
pub struct MapSystem {
    pub id: i64,
    pub name: String,
    pub region_id: i64,
    pub constellation_id: i64,
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

#[derive(Serialize, Clone)]
pub struct MapConstellation {
    pub id: i64,
    pub name: String,
    pub region_id: i64,
}

#[derive(Serialize, Clone)]
pub struct SystemServices {
    pub system_id: i64,
    pub services: Vec<String>,
}

#[derive(Serialize)]
pub struct MapData {
    pub systems: Vec<MapSystem>,
    pub jumps: Vec<MapJump>,
    pub regions: Vec<MapRegion>,
    pub constellations: Vec<MapConstellation>,
    pub system_services: Vec<SystemServices>,
    /// Systems containing at least one player-owned industry structure
    /// (Refinery/Engineering Complex class) - live from ESI, not part of the
    /// SDE sync since these come and go as players anchor/unanchor them.
    pub industry_system_ids: Vec<i64>,
}

#[derive(Serialize, Clone)]
pub struct StationInfo {
    pub id: i64,
    pub name: String,
    pub services: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct CelestialInfo {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub orbit_id: Option<i64>,
}

#[derive(Serialize)]
pub struct NearestSystem {
    pub id: i64,
    pub name: String,
    pub jumps: i32,
}

#[derive(Serialize)]
pub struct SystemDetail {
    pub id: i64,
    pub name: String,
    pub region_id: i64,
    pub region_name: String,
    pub constellation_id: i64,
    pub constellation_name: String,
    pub security: f64,
    pub planet_count: i64,
    pub moon_count: i64,
    pub ship_jumps_1h: i64,
    pub ship_kills_1h: i64,
    pub npc_kills_1h: i64,
    pub pod_kills_1h: i64,
    pub celestials: Vec<CelestialInfo>,
    pub stations: Vec<StationInfo>,
    pub player_structures: Vec<PlayerStructureInfo>,
    pub nearest_nullsec: Option<NearestSystem>,
    pub nearest_lowsec: Option<NearestSystem>,
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
            constellation_id INTEGER NOT NULL DEFAULT 0,
            security REAL NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            real_x REAL NOT NULL DEFAULT 0,
            real_y REAL NOT NULL DEFAULT 0,
            real_z REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS jumps (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS regions (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS constellations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS system_services (system_id INTEGER NOT NULL, service TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_id INTEGER NOT NULL, operation_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS celestials (item_id INTEGER PRIMARY KEY, system_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, orbit_id INTEGER);
        CREATE TABLE IF NOT EXISTS operation_services (operation_id INTEGER NOT NULL, service TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS player_structures (id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS player_structures_meta (synced_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS jump_history (system_id INTEGER NOT NULL, sampled_at INTEGER NOT NULL, ship_jumps INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_jump_history_system_time ON jump_history(system_id, sampled_at);
        CREATE TABLE IF NOT EXISTS structure_owners (
            corporation_id INTEGER PRIMARY KEY,
            corporation_name TEXT NOT NULL,
            corporation_ticker TEXT NOT NULL,
            alliance_id INTEGER,
            alliance_name TEXT,
            alliance_ticker TEXT
        );",
    )
    .map_err(|e| format!("failed to create map tables: {e}"))?;
    // Installs synced before structure ownership was tracked have a
    // player_structures table from the older CREATE TABLE above - add the
    // column if it's missing. Real corporation ids are never 0, so any row
    // still at the default is old data sync_player_structures's needs_sync
    // check treats as needing a fresh resync.
    let _ = conn.execute("ALTER TABLE player_structures ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0", []);
    // Installs synced before constellation support was added have a systems
    // table from the older CREATE TABLE above, which "IF NOT EXISTS" leaves
    // untouched - add the column if it's missing rather than erroring. The
    // actual constellation_id values get backfilled by the resync
    // needs_migration triggers below.
    let _ = conn.execute("ALTER TABLE systems ADD COLUMN constellation_id INTEGER NOT NULL DEFAULT 0", []);
    // Installs synced before real 3D coordinates were tracked (only the
    // flattened position2Dx/y map-projection columns existed) - add the
    // columns if missing; the real values get backfilled by the
    // needs_migration resync trigger below, same as constellation_id.
    let _ = conn.execute("ALTER TABLE systems ADD COLUMN real_x REAL NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE systems ADD COLUMN real_y REAL NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE systems ADD COLUMN real_z REAL NOT NULL DEFAULT 0", []);
    Ok(())
}

/// True if the local cache predates constellation_id, system_services,
/// celestials/stations, or real 3D coordinates, and needs a full resync to
/// backfill them.
fn needs_migration(conn: &rusqlite::Connection) -> bool {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM systems", [], |row| row.get(0)).unwrap_or(0);
    let with_constellation: i64 =
        conn.query_row("SELECT COUNT(*) FROM systems WHERE constellation_id != 0", [], |row| row.get(0)).unwrap_or(0);
    // No real system in New Eden sits exactly at the coordinate origin, so
    // an all-zero real_x/y/z across every row is a reliable "never
    // populated" signal, same reasoning as with_constellation above.
    let with_real_coords: i64 = conn
        .query_row("SELECT COUNT(*) FROM systems WHERE real_x != 0 OR real_y != 0 OR real_z != 0", [], |row| row.get(0))
        .unwrap_or(0);
    let services_count: i64 = conn.query_row("SELECT COUNT(*) FROM system_services", [], |row| row.get(0)).unwrap_or(0);
    let celestials_count: i64 = conn.query_row("SELECT COUNT(*) FROM celestials", [], |row| row.get(0)).unwrap_or(0);
    let op_services_count: i64 = conn.query_row("SELECT COUNT(*) FROM operation_services", [], |row| row.get(0)).unwrap_or(0);
    total > 0
        && (with_constellation == 0 || with_real_coords == 0 || services_count == 0 || celestials_count == 0 || op_services_count == 0)
}

/// Replaces the whole local map cache from freshly-downloaded CSVs, inside
/// one transaction so a crash or network failure mid-import leaves the
/// previous (or empty) state intact rather than a half-populated table.
/// Rows that fail to parse (e.g. a wormhole system with no normal-space
/// security value) are just skipped rather than failing the whole import.
fn import_map_data(
    conn: &mut rusqlite::Connection,
    systems_csv: &str,
    jumps_csv: &str,
    regions_csv: &str,
    constellations_csv: &str,
    stations_csv: &str,
    operation_services_csv: &str,
    services_csv: &str,
    denormalize_csv: &str,
    groups_csv: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch(
        "DELETE FROM systems; DELETE FROM jumps; DELETE FROM regions; DELETE FROM constellations;
         DELETE FROM system_services; DELETE FROM stations; DELETE FROM celestials; DELETE FROM operation_services;",
    )
    .map_err(|e| format!("failed to clear map tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO systems (id, name, region_id, constellation_id, security, x, y, real_x, real_y, real_z) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| format!("failed to prepare systems insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(systems_csv.as_bytes());
        for result in reader.deserialize::<SystemRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![
                row.solar_system_id,
                row.solar_system_name,
                row.region_id,
                row.constellation_id,
                row.security,
                row.position_2d_x,
                row.position_2d_y,
                row.x,
                row.y,
                row.z,
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

    {
        let mut stmt = tx
            .prepare("INSERT INTO constellations (id, name, region_id) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare constellations insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(constellations_csv.as_bytes());
        for result in reader.deserialize::<ConstellationRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.constellation_id, row.constellation_name, row.region_id]);
        }
    }

    {
        let mut service_names: HashMap<i64, String> = HashMap::new();
        let mut reader = csv::Reader::from_reader(services_csv.as_bytes());
        for result in reader.deserialize::<ServiceRow>() {
            let Ok(row) = result else { continue };
            service_names.insert(row.service_id, row.service_name);
        }

        let mut operation_services: HashMap<i64, Vec<i64>> = HashMap::new();
        let mut reader = csv::Reader::from_reader(operation_services_csv.as_bytes());
        for result in reader.deserialize::<OperationServiceRow>() {
            let Ok(row) = result else { continue };
            operation_services.entry(row.operation_id).or_default().push(row.service_id);
        }

        // Kept per-operation (not just aggregated per-system like below) so
        // the System Stats popup's Locations tab can say exactly which
        // station has which service, not just that the system has one
        // somewhere.
        {
            let mut op_stmt = tx
                .prepare("INSERT INTO operation_services (operation_id, service) VALUES (?1, ?2)")
                .map_err(|e| format!("failed to prepare operation_services insert: {e}"))?;
            for (operation_id, service_ids) in &operation_services {
                for service_id in service_ids {
                    if let Some(name) = service_names.get(service_id) {
                        let _ = op_stmt.execute(rusqlite::params![operation_id, name]);
                    }
                }
            }
        }

        // Deduped in memory first (many stations in the same system share an
        // operation type, e.g. every "Caldari Navy Assembly Plant") so the
        // table only holds one row per distinct (system, service) pair.
        let mut pairs: HashSet<(i64, String)> = HashSet::new();
        let mut station_stmt = tx
            .prepare("INSERT INTO stations (id, name, system_id, operation_id) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("failed to prepare stations insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(stations_csv.as_bytes());
        for result in reader.deserialize::<StationRow>() {
            let Ok(row) = result else { continue };
            let _ = station_stmt.execute(rusqlite::params![
                row.station_id,
                row.station_name,
                row.solar_system_id,
                row.operation_id
            ]);
            let Some(service_ids) = operation_services.get(&row.operation_id) else { continue };
            for service_id in service_ids {
                if let Some(name) = service_names.get(service_id) {
                    pairs.insert((row.solar_system_id, name.clone()));
                }
            }
        }
        drop(station_stmt);

        let mut stmt = tx
            .prepare("INSERT INTO system_services (system_id, service) VALUES (?1, ?2)")
            .map_err(|e| format!("failed to prepare system_services insert: {e}"))?;
        for (system_id, service) in pairs {
            let _ = stmt.execute(rusqlite::params![system_id, service]);
        }
    }

    {
        let mut group_names: HashMap<i64, String> = HashMap::new();
        let mut reader = csv::Reader::from_reader(groups_csv.as_bytes());
        for result in reader.deserialize::<GroupRow>() {
            let Ok(row) = result else { continue };
            group_names.insert(row.group_id, row.group_name);
        }

        let mut stmt = tx
            .prepare("INSERT INTO celestials (item_id, system_id, name, kind, orbit_id) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(|e| format!("failed to prepare celestials insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(denormalize_csv.as_bytes());
        for result in reader.deserialize::<DenormalizeRow>() {
            let Ok(row) = result else { continue };
            if !CELESTIAL_GROUP_IDS.contains(&row.group_id) {
                continue;
            }
            let Some(system_id) = row.solar_system_id else { continue };
            let Some(name) = row.item_name.filter(|n| !n.is_empty()) else { continue };
            let Some(kind) = group_names.get(&row.group_id) else { continue };
            let _ = stmt.execute(rusqlite::params![row.item_id, system_id, name, kind, row.orbit_id]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit map data: {e}"))
}

fn read_map_data(conn: &rusqlite::Connection) -> Result<MapData, String> {
    let mut systems = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, region_id, constellation_id, security, x, y FROM systems")
            .map_err(|e| format!("failed to query systems: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MapSystem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    region_id: row.get(2)?,
                    constellation_id: row.get(3)?,
                    security: row.get(4)?,
                    x: row.get(5)?,
                    y: row.get(6)?,
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

    let mut constellations = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, region_id FROM constellations")
            .map_err(|e| format!("failed to query constellations: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok(MapConstellation { id: row.get(0)?, name: row.get(1)?, region_id: row.get(2)? }))
            .map_err(|e| format!("failed to read constellations: {e}"))?;
        for row in rows.flatten() {
            constellations.push(row);
        }
    }

    let mut system_services_map: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT system_id, service FROM system_services")
            .map_err(|e| format!("failed to query system_services: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("failed to read system_services: {e}"))?;
        for row in rows.flatten() {
            system_services_map.entry(row.0).or_default().push(row.1);
        }
    }
    let system_services: Vec<SystemServices> = system_services_map
        .into_iter()
        .map(|(system_id, services)| SystemServices { system_id, services })
        .collect();

    Ok(MapData { systems, jumps, regions, constellations, system_services, industry_system_ids: Vec::new() })
}

/// Ensures the local SQLite cache is populated, syncing it from Fuzzwork's
/// SDE CSV exports first if empty (first run, or the app data directory was
/// cleared). Returns the DB path once ready. Shared by get_map_data and
/// search_systems so both benefit from the same one-time sync.
pub(crate) async fn ensure_synced(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            ensure_schema(&conn)?;
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM systems", [], |row| row.get(0)).unwrap_or(0);
            Ok(count == 0 || needs_migration(&conn))
        })
        .await
        .map_err(|e| format!("map database task failed: {e}"))??
    };

    if needs_sync {
        let (
            (systems_csv, jumps_csv, regions_csv, constellations_csv),
            (stations_csv, operation_services_csv, services_csv),
            (denormalize_csv, groups_csv),
        ) = futures::future::try_join3(
            futures::future::try_join4(
                market::download_csv(client, SYSTEMS_CSV_URL),
                market::download_csv(client, JUMPS_CSV_URL),
                market::download_csv(client, REGIONS_CSV_URL),
                market::download_csv(client, CONSTELLATIONS_CSV_URL),
            ),
            futures::future::try_join3(
                market::download_csv(client, STA_STATIONS_CSV_URL),
                market::download_csv(client, STA_OPERATION_SERVICES_CSV_URL),
                market::download_csv(client, STA_SERVICES_CSV_URL),
            ),
            futures::future::try_join(market::download_csv(client, MAP_DENORMALIZE_CSV_URL), market::download_csv(client, INV_GROUPS_CSV_URL)),
        )
        .await?;

        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            import_map_data(
                &mut conn,
                &systems_csv,
                &jumps_csv,
                &regions_csv,
                &constellations_csv,
                &stations_csv,
                &operation_services_csv,
                &services_csv,
                &denormalize_csv,
                &groups_csv,
            )
        })
        .await
        .map_err(|e| format!("map import task failed: {e}"))??;
    }

    Ok(path)
}

/// Every system with at least one player-owned industry structure
/// (Refinery/Engineering Complex class) - live from ESI since these come and
/// go, unlike the SDE-backed NPC station services. Best-effort: a failed
/// fetch just means no industry markers this load, not a broken map.
async fn fetch_industry_system_ids(client: &reqwest::Client) -> Vec<i64> {
    let facilities: Vec<IndustryFacility> =
        esi::public_get(client, "/industry/facilities/").await.unwrap_or_default();
    let mut ids: Vec<i64> = facilities.into_iter().map(|f| f.solar_system_id).collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Live ship-jump count per system for the last hour - the whole-universe
/// list is one call, no per-system endpoint exists, so callers filter for
/// the one system they need out of this. Best-effort: a failed fetch just
/// means a zero shown rather than a broken detail popup.
async fn fetch_system_jumps(client: &reqwest::Client) -> HashMap<i64, i64> {
    let entries: Vec<SystemJumpsEntry> = esi::public_get(client, "/universe/system_jumps/").await.unwrap_or_default();
    entries.into_iter().map(|e| (e.system_id, e.ship_jumps)).collect()
}

/// Live ship/NPC/pod kill counts per system for the last hour, same
/// whole-universe-in-one-call shape as fetch_system_jumps.
async fn fetch_system_kills(client: &reqwest::Client) -> HashMap<i64, (i64, i64, i64)> {
    let entries: Vec<SystemKillsEntry> = esi::public_get(client, "/universe/system_kills/").await.unwrap_or_default();
    entries.into_iter().map(|e| (e.system_id, (e.ship_kills, e.npc_kills, e.pod_kills))).collect()
}

/// Loads the universe map (systems/jumps/regions/station services) from the
/// local SQLite cache, plus a live industry-facility fetch. SQLite access is
/// blocking, so it's kept off the async runtime via spawn_blocking.
pub async fn get_map_data(app: tauri::AppHandle, client: &reqwest::Client) -> Result<MapData, String> {
    let path = ensure_synced(&app, client).await?;
    let read_future = async {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<MapData, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            read_map_data(&conn)
        })
        .await
        .map_err(|e| format!("map read task failed: {e}"))?
    };
    let (data_result, industry_system_ids) = futures::future::join(read_future, fetch_industry_system_ids(client)).await;
    let mut data = data_result?;
    data.industry_system_ids = industry_system_ids;
    Ok(data)
}

#[derive(Serialize, Clone)]
pub struct SystemSearchMatch {
    pub id: i64,
    pub name: String,
    pub security: f64,
}

/// Resolves an NPC station id to the system it's in, via the same stations
/// table synced for the map key icons. Player-owned Upwell structure ids
/// (a character's home can be either) aren't in this table at all - those
/// return None rather than making an extra authorized per-structure ESI
/// call, since most characters' home station is an NPC station anyway.
pub async fn resolve_station_system(app: &tauri::AppHandle, client: &reqwest::Client, station_id: i64) -> Option<i64> {
    let path = ensure_synced(app, client).await.ok()?;
    tauri::async_runtime::spawn_blocking(move || -> Option<i64> {
        let conn = rusqlite::Connection::open(&path).ok()?;
        conn.query_row("SELECT system_id FROM stations WHERE id = ?1", [station_id], |row| row.get(0)).ok()
    })
    .await
    .ok()?
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

#[derive(Serialize, Clone)]
pub struct SystemPosition {
    pub system_id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Real 3D positions (meters) for a batch of systems - the light-year jump
/// range/fuel/fatigue math the Capital Route planner runs needs true
/// straight-line distance through space, not the flattened position2Dx/y
/// map projection everything else in this file uses for on-screen layout.
pub async fn get_system_positions(app: tauri::AppHandle, client: &reqwest::Client, ids: Vec<i64>) -> Result<Vec<SystemPosition>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SystemPosition>, String> {
        let mut results = Vec::new();
        if ids.is_empty() {
            return Ok(results);
        }
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!("SELECT id, real_x, real_y, real_z FROM systems WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to query system positions: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok(SystemPosition { system_id: row.get(0)?, x: row.get(1)?, y: row.get(2)?, z: row.get(3)? })
            })
            .map_err(|e| format!("failed to query system positions: {e}"))?;
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read system position row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("system positions task failed: {e}"))?
}

/// Breadth-first search outward from originId over the jump graph for the
/// nearest system matching `predicate` (a security-band check) - used for
/// the System Stats popup's "nearest 0.0" / "nearest lowsec" routes, the
/// same kind of graph walk as useLocationTracking's jump-radius scan on the
/// frontend, just run once server-side against a specific target instead of
/// a whole radius.
fn find_nearest(
    origin_id: i64,
    security_by_system: &HashMap<i64, f64>,
    adjacency: &HashMap<i64, Vec<i64>>,
    predicate: impl Fn(f64) -> bool,
) -> Option<(i64, i32)> {
    let mut visited: HashSet<i64> = HashSet::from([origin_id]);
    let mut frontier = vec![origin_id];
    let mut depth = 0;
    while !frontier.is_empty() {
        for &system_id in &frontier {
            if depth > 0 {
                if let Some(&security) = security_by_system.get(&system_id) {
                    if predicate(security) {
                        return Some((system_id, depth));
                    }
                }
            }
        }
        let mut next = Vec::new();
        for system_id in frontier {
            for &neighbor in adjacency.get(&system_id).into_iter().flatten() {
                if visited.insert(neighbor) {
                    next.push(neighbor);
                }
            }
        }
        frontier = next;
        depth += 1;
    }
    None
}

fn build_system_detail(conn: &rusqlite::Connection, system_id: i64) -> Result<SystemDetail, String> {
    let (name, region_id, constellation_id, security): (String, i64, i64, f64) = conn
        .query_row("SELECT name, region_id, constellation_id, security FROM systems WHERE id = ?1", [system_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("system not found: {e}"))?;

    let region_name: String =
        conn.query_row("SELECT name FROM regions WHERE id = ?1", [region_id], |row| row.get(0)).unwrap_or_default();
    let constellation_name: String = conn
        .query_row("SELECT name FROM constellations WHERE id = ?1", [constellation_id], |row| row.get(0))
        .unwrap_or_default();

    let mut celestials = Vec::new();
    let mut planet_count = 0i64;
    let mut moon_count = 0i64;
    {
        let mut stmt = conn
            .prepare("SELECT item_id, name, kind, orbit_id FROM celestials WHERE system_id = ?1 ORDER BY kind, name")
            .map_err(|e| format!("failed to query celestials: {e}"))?;
        let rows = stmt
            .query_map([system_id], |row| {
                Ok(CelestialInfo { id: row.get(0)?, name: row.get(1)?, kind: row.get(2)?, orbit_id: row.get(3)? })
            })
            .map_err(|e| format!("failed to read celestials: {e}"))?;
        for row in rows.flatten() {
            match row.kind.as_str() {
                "Planet" => planet_count += 1,
                "Moon" => moon_count += 1,
                _ => {}
            }
            celestials.push(row);
        }
    }

    let mut stations = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, operation_id FROM stations WHERE system_id = ?1 ORDER BY name")
            .map_err(|e| format!("failed to query stations: {e}"))?;
        let station_rows: Vec<(i64, String, i64)> = stmt
            .query_map([system_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("failed to read stations: {e}"))?
            .flatten()
            .collect();

        let mut services_stmt = conn
            .prepare("SELECT service FROM operation_services WHERE operation_id = ?1")
            .map_err(|e| format!("failed to query operation_services: {e}"))?;
        for (id, name, operation_id) in station_rows {
            let services: Vec<String> = services_stmt
                .query_map([operation_id], |row| row.get(0))
                .map_err(|e| format!("failed to read operation_services: {e}"))?
                .flatten()
                .collect();
            stations.push(StationInfo { id, name, services });
        }
    }

    let mut player_structures = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.name, s.system_id, s.owner_id, o.corporation_name, o.corporation_ticker, o.alliance_id, o.alliance_name, o.alliance_ticker
                 FROM player_structures s
                 LEFT JOIN structure_owners o ON o.corporation_id = s.owner_id
                 WHERE s.system_id = ?1 ORDER BY s.name",
            )
            .map_err(|e| format!("failed to query player_structures: {e}"))?;
        let rows = stmt
            .query_map([system_id], |row| {
                Ok(PlayerStructureInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    system_id: row.get(2)?,
                    owner_corporation_id: row.get(3)?,
                    owner_corporation_name: row.get(4)?,
                    owner_corporation_ticker: row.get(5)?,
                    owner_alliance_id: row.get(6)?,
                    owner_alliance_name: row.get(7)?,
                    owner_alliance_ticker: row.get(8)?,
                })
            })
            .map_err(|e| format!("failed to read player_structures: {e}"))?;
        for row in rows.flatten() {
            player_structures.push(row);
        }
    }

    let mut security_by_system: HashMap<i64, f64> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT id, security FROM systems").map_err(|e| format!("failed to query systems: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))
            .map_err(|e| format!("failed to read systems: {e}"))?;
        for row in rows.flatten() {
            security_by_system.insert(row.0, row.1);
        }
    }

    let mut adjacency: HashMap<i64, Vec<i64>> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT from_id, to_id FROM jumps").map_err(|e| format!("failed to query jumps: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|e| format!("failed to read jumps: {e}"))?;
        for row in rows.flatten() {
            adjacency.entry(row.0).or_default().push(row.1);
            adjacency.entry(row.1).or_default().push(row.0);
        }
    }

    // NearestSystem needs the system's name too - resolved via a second pass
    // rather than threading name lookups through find_nearest itself.
    let resolve_name = |id: i64| -> String {
        conn.query_row("SELECT name FROM systems WHERE id = ?1", [id], |row| row.get(0)).unwrap_or_default()
    };
    let nearest_nullsec = find_nearest(system_id, &security_by_system, &adjacency, |sec| sec <= 0.0)
        .map(|(id, jumps)| NearestSystem { id, name: resolve_name(id), jumps });
    let nearest_lowsec = find_nearest(system_id, &security_by_system, &adjacency, |sec| sec > 0.0 && sec < 0.45)
        .map(|(id, jumps)| NearestSystem { id, name: resolve_name(id), jumps });

    Ok(SystemDetail {
        id: system_id,
        name,
        region_id,
        region_name,
        constellation_id,
        constellation_name,
        security,
        planet_count,
        moon_count,
        ship_jumps_1h: 0,
        ship_kills_1h: 0,
        npc_kills_1h: 0,
        pod_kills_1h: 0,
        celestials,
        stations,
        player_structures,
        nearest_nullsec,
        nearest_lowsec,
    })
}

/// Full DOTLAN-style system detail: static facts + celestials + stations
/// from the local cache, live jump/kill snapshots from ESI, and nearest
/// 0.0/lowsec computed via a BFS over the same jump graph the map uses.
pub async fn get_system_detail(app: tauri::AppHandle, client: &reqwest::Client, system_id: i64) -> Result<SystemDetail, String> {
    let path = ensure_synced(&app, client).await?;

    let read_future = async {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<SystemDetail, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            build_system_detail(&conn, system_id)
        })
        .await
        .map_err(|e| format!("system detail task failed: {e}"))?
    };
    let live_future = futures::future::join(fetch_system_jumps(client), fetch_system_kills(client));

    let (detail_result, (jumps_map, kills_map)) = futures::future::join(read_future, live_future).await;
    let mut detail = detail_result?;
    detail.ship_jumps_1h = jumps_map.get(&system_id).copied().unwrap_or(0);
    let (ship_kills, npc_kills, pod_kills) = kills_map.get(&system_id).copied().unwrap_or((0, 0, 0));
    detail.ship_kills_1h = ship_kills;
    detail.npc_kills_1h = npc_kills;
    detail.pod_kills_1h = pod_kills;
    Ok(detail)
}

#[derive(Serialize, Clone)]
pub struct PlayerStructureInfo {
    pub id: i64,
    pub name: String,
    pub system_id: i64,
    pub owner_corporation_id: i64,
    pub owner_corporation_name: Option<String>,
    pub owner_corporation_ticker: Option<String>,
    pub owner_alliance_id: Option<i64>,
    pub owner_alliance_name: Option<String>,
    pub owner_alliance_ticker: Option<String>,
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[derive(Serialize, Clone)]
pub struct JumpHistoryPoint {
    pub sampled_at: i64,
    pub ship_jumps: i64,
}

/// Snapshots the whole-universe live jump counts into jump_history, then
/// prunes anything older than the 48h window. One ESI call covers every
/// system, so this stores every system's count each sample rather than just
/// ones someone has looked at - the marginal storage cost is trivial and it
/// means a system's graph already has data the first time its Stats popup
/// is opened, as long as the app has been running.
async fn sample_jump_history(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let path = db_path(app)?;
    let jumps_map = fetch_system_jumps(client).await;
    if jumps_map.is_empty() {
        return Ok(());
    }
    let sampled_at = now_unix();
    let cutoff = sampled_at - JUMP_HISTORY_RETENTION_SECS;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
        {
            let mut stmt = tx
                .prepare("INSERT INTO jump_history (system_id, sampled_at, ship_jumps) VALUES (?1, ?2, ?3)")
                .map_err(|e| format!("failed to prepare jump_history insert: {e}"))?;
            for (system_id, ship_jumps) in &jumps_map {
                let _ = stmt.execute(rusqlite::params![system_id, sampled_at, ship_jumps]);
            }
        }
        tx.execute("DELETE FROM jump_history WHERE sampled_at < ?1", [cutoff])
            .map_err(|e| format!("failed to prune jump_history: {e}"))?;
        tx.commit().map_err(|e| format!("failed to commit jump_history: {e}"))
    })
    .await
    .map_err(|e| format!("jump history sample task failed: {e}"))?
}

/// Runs for the lifetime of the app (spawned once from lib.rs's setup hook):
/// samples immediately on launch, then every JUMP_HISTORY_SAMPLE_INTERVAL_SECS.
/// Best-effort - a single failed sample (ESI hiccup, etc) is silently
/// skipped rather than killing the loop, matching this module's existing
/// "a failed fetch just means a gap, not a crash" style.
pub async fn run_jump_history_sampler(app: tauri::AppHandle, client: reqwest::Client) {
    loop {
        let _ = sample_jump_history(&app, &client).await;
        tokio::time::sleep(std::time::Duration::from_secs(JUMP_HISTORY_SAMPLE_INTERVAL_SECS)).await;
    }
}

/// Reads back one system's accumulated jump history for the Stats popup's
/// 48h graph. Not gated behind ensure_synced (no CSV sync needed) - just
/// ensure_schema, since a fresh install's db may not have the table yet if
/// the sampler hasn't ticked once.
pub async fn get_jump_history(app: tauri::AppHandle, system_id: i64) -> Result<Vec<JumpHistoryPoint>, String> {
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<JumpHistoryPoint>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        ensure_schema(&conn)?;
        let cutoff = now_unix() - JUMP_HISTORY_RETENTION_SECS;
        let mut stmt = conn
            .prepare("SELECT sampled_at, ship_jumps FROM jump_history WHERE system_id = ?1 AND sampled_at >= ?2 ORDER BY sampled_at")
            .map_err(|e| format!("failed to query jump_history: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![system_id, cutoff], |row| {
                Ok(JumpHistoryPoint { sampled_at: row.get(0)?, ship_jumps: row.get(1)? })
            })
            .map_err(|e| format!("failed to read jump_history: {e}"))?;
        Ok(rows.flatten().collect())
    })
    .await
    .map_err(|e| format!("jump history read task failed: {e}"))?
}

/// Resyncs the local player_structures cache if it's empty or older than
/// STRUCTURE_RESYNC_INTERVAL_SECS. Confirmed live (see the diag test that
/// used to live in esi.rs) that resolving a structure from ESI's public
/// /universe/structures/ list works with ANY logged-in character's token,
/// not specifically one with docking history there - so a single valid
/// token is enough to resolve the whole public list.
async fn sync_player_structures(app: &tauri::AppHandle, client: &reqwest::Client, access_token: &str) -> Result<(), String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
            ensure_schema(&conn)?;
            let synced_at: Option<i64> =
                conn.query_row("SELECT synced_at FROM player_structures_meta ORDER BY synced_at DESC LIMIT 1", [], |row| row.get(0)).ok();
            // Real corporation ids are never 0 - any row still at the
            // owner_id column's default means this local cache predates
            // ownership tracking and needs an immediate resync regardless
            // of how fresh synced_at looks.
            let has_legacy_rows: bool = conn
                .query_row("SELECT COUNT(*) FROM player_structures WHERE owner_id = 0", [], |row| row.get::<_, i64>(0))
                .unwrap_or(0)
                > 0;
            Ok(match synced_at {
                Some(t) => has_legacy_rows || now_unix() - t > STRUCTURE_RESYNC_INTERVAL_SECS,
                None => true,
            })
        })
        .await
        .map_err(|e| format!("player structures check task failed: {e}"))??
    };
    if !needs_sync {
        return Ok(());
    }

    let structure_ids: Vec<i64> = esi::public_get(client, "/universe/structures/").await.unwrap_or_default();

    let resolved: Vec<(i64, String, i64, i64)> = stream::iter(structure_ids)
        .map(|structure_id| async move {
            esi::fetch_structure_info(client, access_token, structure_id)
                .await
                .map(|info| (structure_id, info.name, info.solar_system_id, info.owner_id))
        })
        .buffer_unordered(STRUCTURE_RESOLVE_CONCURRENCY)
        .filter_map(|result| async move { result })
        .collect()
        .await;

    let mut owner_ids: Vec<i64> = resolved.iter().map(|(_, _, _, owner_id)| *owner_id).collect();
    owner_ids.sort_unstable();
    owner_ids.dedup();

    // Corp/alliance name+ticker for every distinct structure owner - reuses
    // the same profile fetch the Corporation Killboard page uses rather
    // than a second corp-info fetch path, even though it resolves more
    // (CEO, tax rate, etc.) than these markers actually need.
    let owner_profiles: Vec<kills::CorporationProfile> = stream::iter(owner_ids)
        .map(|corporation_id| async move { kills::fetch_corporation_profile(client, corporation_id).await.ok() })
        .buffer_unordered(STRUCTURE_RESOLVE_CONCURRENCY)
        .filter_map(|result| async move { result })
        .collect()
        .await;

    let synced_at = now_unix();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
        tx.execute_batch("DELETE FROM player_structures; DELETE FROM player_structures_meta; DELETE FROM structure_owners;")
            .map_err(|e| format!("failed to clear player_structures: {e}"))?;
        {
            let mut stmt = tx
                .prepare("INSERT INTO player_structures (id, name, system_id, owner_id) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| format!("failed to prepare player_structures insert: {e}"))?;
            for (id, name, system_id, owner_id) in resolved {
                let _ = stmt.execute(rusqlite::params![id, name, system_id, owner_id]);
            }
        }
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO structure_owners (corporation_id, corporation_name, corporation_ticker, alliance_id, alliance_name, alliance_ticker)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|e| format!("failed to prepare structure_owners insert: {e}"))?;
            for profile in owner_profiles {
                let _ = stmt.execute(rusqlite::params![
                    profile.corporation_id,
                    profile.corporation_name,
                    profile.corporation_ticker,
                    profile.alliance_id,
                    profile.alliance_name,
                    profile.alliance_ticker,
                ]);
            }
        }
        tx.execute("INSERT INTO player_structures_meta (synced_at) VALUES (?1)", [synced_at])
            .map_err(|e| format!("failed to record player_structures sync time: {e}"))?;
        tx.commit().map_err(|e| format!("failed to commit player_structures: {e}"))
    })
    .await
    .map_err(|e| format!("player structures import task failed: {e}"))?
}

/// Every public player-owned structure (citadels, engineering complexes,
/// refineries, Ansiblex gates, etc. with public docking) with its system and
/// owning corp/alliance - synced at most once a day since these rarely
/// move. Best-effort: if no character has a usable token, returns whatever
/// is already cached (empty on a first-ever run with no login yet).
pub async fn get_player_structures(
    app: tauri::AppHandle,
    client: &reqwest::Client,
    access_token: Option<&str>,
) -> Result<Vec<PlayerStructureInfo>, String> {
    let path = ensure_synced(&app, client).await?;
    if let Some(token) = access_token {
        sync_player_structures(&app, client, token).await?;
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PlayerStructureInfo>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open map database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.name, s.system_id, s.owner_id, o.corporation_name, o.corporation_ticker, o.alliance_id, o.alliance_name, o.alliance_ticker
                 FROM player_structures s
                 LEFT JOIN structure_owners o ON o.corporation_id = s.owner_id",
            )
            .map_err(|e| format!("failed to query player_structures: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PlayerStructureInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    system_id: row.get(2)?,
                    owner_corporation_id: row.get(3)?,
                    owner_corporation_name: row.get(4)?,
                    owner_corporation_ticker: row.get(5)?,
                    owner_alliance_id: row.get(6)?,
                    owner_alliance_name: row.get(7)?,
                    owner_alliance_ticker: row.get(8)?,
                })
            })
            .map_err(|e| format!("failed to read player_structures: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read player_structures row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("player structures read task failed: {e}"))?
}
