use crate::market;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::Manager;

/// Same Fuzzwork SDE CSV mirror map.rs/market.rs already sync from - these
/// two tables are the entire P1-P4 production graph (which materials
/// combine into which product, in what quantities). ESI's own
/// `/universe/schematics/{id}/` endpoint was checked live and only returns
/// a name and cycle_time, no materials at all, so the SDE is the only real
/// source for the recipe data itself.
const PLANET_SCHEMATICS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/planetSchematics.csv";
const PLANET_SCHEMATICS_TYPE_MAP_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/planetSchematicsTypeMap.csv";

#[derive(Deserialize)]
struct SchematicRow {
    #[serde(rename = "schematicID")]
    schematic_id: i64,
    #[serde(rename = "schematicName")]
    schematic_name: String,
    #[serde(rename = "cycleTime")]
    cycle_time: i64,
}

#[derive(Deserialize)]
struct SchematicTypeMapRow {
    #[serde(rename = "schematicID")]
    schematic_id: i64,
    #[serde(rename = "typeID")]
    type_id: i64,
    quantity: i64,
    #[serde(rename = "isInput")]
    is_input: i64,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("pi.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pi_schematics (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            cycle_time INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pi_schematic_materials (
            schematic_id INTEGER NOT NULL,
            type_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            is_input INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pi_materials_schematic ON pi_schematic_materials (schematic_id);",
    )
    .map_err(|e| format!("failed to create PI tables: {e}"))?;
    Ok(())
}

fn import_pi_data(conn: &mut rusqlite::Connection, schematics_csv: &str, materials_csv: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch("DELETE FROM pi_schematics; DELETE FROM pi_schematic_materials;")
        .map_err(|e| format!("failed to clear PI tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare("INSERT INTO pi_schematics (id, name, cycle_time) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare schematics insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(schematics_csv.as_bytes());
        for result in reader.deserialize::<SchematicRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.schematic_id, row.schematic_name, row.cycle_time]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO pi_schematic_materials (schematic_id, type_id, quantity, is_input) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("failed to prepare materials insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(materials_csv.as_bytes());
        for result in reader.deserialize::<SchematicTypeMapRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.schematic_id, row.type_id, row.quantity, row.is_input]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit PI data: {e}"))
}

async fn ensure_synced(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open PI database: {e}"))?;
            ensure_schema(&conn)?;
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM pi_schematics", [], |row| row.get(0)).unwrap_or(0);
            Ok(count == 0)
        })
        .await
        .map_err(|e| format!("PI database task failed: {e}"))??
    };

    if needs_sync {
        let (schematics_csv, materials_csv) = futures::future::try_join(
            market::download_csv(client, PLANET_SCHEMATICS_CSV_URL),
            market::download_csv(client, PLANET_SCHEMATICS_TYPE_MAP_CSV_URL),
        )
        .await?;

        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open PI database: {e}"))?;
            import_pi_data(&mut conn, &schematics_csv, &materials_csv)
        })
        .await
        .map_err(|e| format!("PI import task failed: {e}"))??;
    }

    Ok(path)
}

/// Which P0 raw materials each of the 8 planet types yields - not present
/// anywhere in the SDE (confirmed: fuzzwork's dump has no such table; this
/// is baked-in game mechanics, not queryable schema data). Directly
/// observed from EVE OS's own Planetary Industry Visualizer (the reference
/// this feature is matching) by selecting each of the 8 planet types in
/// turn and recording its 5 highlighted P0 materials - cross-checked
/// internally consistent: exactly 8x5=40 planet/P0 pairs, covering all 15
/// P0 materials with no gaps.
const PLANET_P0_NAMES: &[(&str, &[&str])] = &[
    ("Barren", &["Microorganisms", "Base Metals", "Aqueous Liquids", "Noble Metals", "Carbon Compounds"]),
    ("Gas", &["Base Metals", "Aqueous Liquids", "Ionic Solutions", "Noble Gas", "Reactive Gas"]),
    ("Ice", &["Microorganisms", "Aqueous Liquids", "Heavy Metals", "Planktic Colonies", "Noble Gas"]),
    ("Lava", &["Base Metals", "Heavy Metals", "Non-CS Crystals", "Felsic Magma", "Suspended Plasma"]),
    ("Oceanic", &["Microorganisms", "Aqueous Liquids", "Planktic Colonies", "Complex Organisms", "Carbon Compounds"]),
    ("Plasma", &["Base Metals", "Noble Metals", "Heavy Metals", "Non-CS Crystals", "Suspended Plasma"]),
    ("Storm", &["Base Metals", "Aqueous Liquids", "Suspended Plasma", "Ionic Solutions", "Noble Gas"]),
    ("Temperate", &["Microorganisms", "Aqueous Liquids", "Complex Organisms", "Carbon Compounds", "Autotrophs"]),
];

#[derive(Serialize, Clone)]
pub struct PiMaterial {
    pub type_id: i64,
    pub name: String,
    /// "P0".."P4" - derived structurally from the recipe graph itself
    /// (a material with no schematic producing it is P0; otherwise one
    /// tier above the highest-tier input its schematic consumes), not
    /// from any external tier label.
    pub tier: String,
}

#[derive(Serialize, Clone)]
pub struct PiSchematicMaterial {
    pub type_id: i64,
    pub quantity: i64,
}

#[derive(Serialize, Clone)]
pub struct PiSchematic {
    pub id: i64,
    pub name: String,
    pub cycle_time: i64,
    pub inputs: Vec<PiSchematicMaterial>,
    pub outputs: Vec<PiSchematicMaterial>,
}

#[derive(Serialize, Clone)]
pub struct PiPlanetType {
    pub name: String,
    pub p0_type_ids: Vec<i64>,
}

#[derive(Serialize)]
pub struct PiData {
    pub materials: Vec<PiMaterial>,
    pub schematics: Vec<PiSchematic>,
    pub planet_types: Vec<PiPlanetType>,
}

/// Depth-first, memoized: a material's tier is one above the deepest tier
/// among its own schematic's inputs, with "no schematic produces this" as
/// the P0 base case. depth is only a cycle guard - the real graph never
/// goes past P0->P1->P2->P3->P4 (4 hops).
fn resolve_tier(
    type_id: i64,
    output_of: &HashMap<i64, i64>,
    schematic_inputs: &HashMap<i64, Vec<i64>>,
    cache: &mut HashMap<i64, u8>,
    depth: u8,
) -> u8 {
    if let Some(&t) = cache.get(&type_id) {
        return t;
    }
    if depth > 8 {
        return 0;
    }
    let Some(&schematic_id) = output_of.get(&type_id) else {
        cache.insert(type_id, 0);
        return 0;
    };
    let inputs = schematic_inputs.get(&schematic_id).cloned().unwrap_or_default();
    let max_input_tier = inputs.iter().map(|&i| resolve_tier(i, output_of, schematic_inputs, cache, depth + 1)).max().unwrap_or(0);
    let tier = max_input_tier + 1;
    cache.insert(type_id, tier);
    tier
}

/// The full static PI production graph, sent whole (a few hundred small
/// rows) so the frontend visualizer can do all the click-to-highlight
/// dependency-chain traversal locally, matching how EVE OS's own tool
/// behaves - no per-click round trip needed since none of this data
/// changes without a game patch.
pub async fn get_pi_data(app: tauri::AppHandle, client: &reqwest::Client) -> Result<PiData, String> {
    let (market_path, pi_path) =
        futures::future::try_join(market::ensure_synced(&app, client), ensure_synced(&app, client)).await?;

    tauri::async_runtime::spawn_blocking(move || -> Result<PiData, String> {
        let pi_conn = rusqlite::Connection::open(&pi_path).map_err(|e| format!("failed to open PI database: {e}"))?;

        let mut schematics: HashMap<i64, (String, i64)> = HashMap::new();
        {
            let mut stmt = pi_conn
                .prepare("SELECT id, name, cycle_time FROM pi_schematics")
                .map_err(|e| format!("failed to query pi_schematics: {e}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
                .map_err(|e| format!("failed to query pi_schematics: {e}"))?;
            for row in rows {
                let (id, name, cycle_time) = row.map_err(|e| format!("failed to read schematic row: {e}"))?;
                schematics.insert(id, (name, cycle_time));
            }
        }

        let mut materials_by_schematic: Vec<(i64, i64, i64, i64)> = Vec::new();
        {
            let mut stmt = pi_conn
                .prepare("SELECT schematic_id, type_id, quantity, is_input FROM pi_schematic_materials")
                .map_err(|e| format!("failed to query pi_schematic_materials: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
                })
                .map_err(|e| format!("failed to query pi_schematic_materials: {e}"))?;
            for row in rows {
                materials_by_schematic.push(row.map_err(|e| format!("failed to read material row: {e}"))?);
            }
        }

        // Every distinct type id referenced anywhere in the recipe graph,
        // plus the P0s named in PLANET_P0_NAMES once resolved to ids below -
        // this is the full set of items the visualizer needs names/tiers for.
        let mut all_type_ids: HashSet<i64> = materials_by_schematic.iter().map(|&(_, tid, _, _)| tid).collect();

        let market_conn = rusqlite::Connection::open(&market_path).map_err(|e| format!("failed to open market database: {e}"))?;

        let mut planet_types: Vec<PiPlanetType> = Vec::new();
        for &(planet_name, p0_names) in PLANET_P0_NAMES {
            let mut p0_type_ids = Vec::new();
            for &p0_name in p0_names {
                let id: Option<i64> = market_conn
                    .query_row("SELECT id FROM types WHERE name = ?1 LIMIT 1", [p0_name], |row| row.get(0))
                    .ok();
                if let Some(id) = id {
                    p0_type_ids.push(id);
                    all_type_ids.insert(id);
                }
            }
            planet_types.push(PiPlanetType { name: planet_name.to_string(), p0_type_ids });
        }

        let mut output_of: HashMap<i64, i64> = HashMap::new();
        let mut schematic_inputs: HashMap<i64, Vec<i64>> = HashMap::new();
        for &(sid, tid, _qty, is_input) in &materials_by_schematic {
            if is_input == 1 {
                schematic_inputs.entry(sid).or_default().push(tid);
            } else {
                output_of.insert(tid, sid);
            }
        }

        let mut tier_cache: HashMap<i64, u8> = HashMap::new();
        for &type_id in &all_type_ids {
            resolve_tier(type_id, &output_of, &schematic_inputs, &mut tier_cache, 0);
        }

        let mut names: HashMap<i64, String> = HashMap::new();
        {
            let ids: Vec<i64> = all_type_ids.iter().copied().collect();
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT id, name FROM types WHERE id IN ({placeholders})");
            let mut stmt = market_conn.prepare(&sql).map_err(|e| format!("failed to query type names: {e}"))?;
            let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let rows = stmt
                .query_map(params.as_slice(), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("failed to query type names: {e}"))?;
            for row in rows {
                let (id, name) = row.map_err(|e| format!("failed to read type name row: {e}"))?;
                names.insert(id, name);
            }
        }

        let materials: Vec<PiMaterial> = all_type_ids
            .into_iter()
            .filter_map(|type_id| {
                let name = names.get(&type_id)?.clone();
                let tier = format!("P{}", tier_cache.get(&type_id).copied().unwrap_or(0));
                Some(PiMaterial { type_id, name, tier })
            })
            .collect();

        let mut schematic_list: Vec<PiSchematic> = Vec::new();
        for (id, (name, cycle_time)) in schematics {
            let inputs: Vec<PiSchematicMaterial> = materials_by_schematic
                .iter()
                .filter(|&&(sid, _, _, is_input)| sid == id && is_input == 1)
                .map(|&(_, tid, qty, _)| PiSchematicMaterial { type_id: tid, quantity: qty })
                .collect();
            let outputs: Vec<PiSchematicMaterial> = materials_by_schematic
                .iter()
                .filter(|&&(sid, _, _, is_input)| sid == id && is_input == 0)
                .map(|&(_, tid, qty, _)| PiSchematicMaterial { type_id: tid, quantity: qty })
                .collect();
            schematic_list.push(PiSchematic { id, name, cycle_time, inputs, outputs });
        }
        schematic_list.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(PiData { materials, schematics: schematic_list, planet_types })
    })
    .await
    .map_err(|e| format!("PI data task failed: {e}"))?
}
