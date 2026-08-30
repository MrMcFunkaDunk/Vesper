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
/// Item groups/categories (distinct from invMarketGroups.csv above, which is
/// the market browser's own category tree) - groupID+categoryID is what
/// actually identifies "this type is a Ship" (categoryID 6), and groupID
/// distinguishes Frigate/Cruiser/Interceptor/etc. Confirmed live before
/// committing to this, same as every other SDE source here.
const INV_GROUPS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv";
/// CCP's own type -> parent-type + meta-group mapping (Tech I/II/III,
/// Faction, Officer, etc.) - this is the exact data that answers "which T1
/// hull does this T2 variant come from," so the Ship Tree's branch lines
/// use CCP's real relationships rather than a guessed-at heuristic.
const META_TYPES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invMetaTypes.csv";
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
/// Category name table (Ship=6, Module=7, Charge=8, Blueprint=9, Drone=18,
/// Implant=20, Structure=65, ...) - the parent of invGroups.csv's
/// categoryID column, needed for the Item Database's category home page.
const INV_CATEGORIES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/invCategories.csv";
/// CCP's own attribute name/display-name/unit table (e.g. attribute 14 is
/// "hiSlots" internally, "High Slots" for display) - confirmed live
/// against this exact mirror before committing to it.
const DGM_ATTRIBUTE_TYPES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/dgmAttributeTypes.csv";
/// Every type's actual attribute values (powergrid, CPU, slot counts,
/// damage, etc.) - the data an item detail page and the Fit Builder's
/// real slot counts/PG/CPU both need. ~16MB, same order of magnitude as
/// invTypes.csv, one-time sync cost.
const DGM_TYPE_ATTRIBUTES_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/dgmTypeAttributes.csv";
/// Which dogma effects a type has - used only to derive which slot list
/// (Hi/Mid/Low/Rig/Subsystem/Service) a module belongs to, via 6 fixed
/// effect ids (see slot_type_for_effect below). Neither dgmTypeAttributes
/// nor invTypes carries this - it's a distinct SDE table.
const DGM_TYPE_EFFECTS_CSV_URL: &str = "https://www.fuzzwork.co.uk/dump/latest/csv/dgmTypeEffects.csv";

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
    #[serde(rename = "groupID")]
    group_id: Option<i64>,
    /// 1=Caldari, 2=Minmatar, 4=Amarr, 8=Gallente, plus separate ids for
    /// ORE/pirate factions/etc. - null for most non-ship items.
    #[serde(rename = "raceID")]
    race_id: Option<i64>,
    /// CCP's own curated Ship Tree grouping - the same data that drives the
    /// in-game Ship Tree window's layout.
    #[serde(rename = "shipTreeGroupID")]
    ship_tree_group_id: Option<i64>,
    /// chrFactions id - e.g. 500001=Caldari State, 500010=Guristas Pirates,
    /// 500016=Servant Sisters of EVE. Set on ordinary empire hulls too (a
    /// Merlin's factionID is Caldari State), so this is the real dimension
    /// the in-game Ship Tree's faction sidebar groups by - raceID alone
    /// only yields ~9 buckets since it lumps every pirate faction together.
    #[serde(rename = "factionID")]
    faction_id: Option<i64>,
}

#[derive(Deserialize)]
struct ItemGroupRow {
    #[serde(rename = "groupID")]
    group_id: i64,
    #[serde(rename = "categoryID")]
    category_id: i64,
    #[serde(rename = "groupName")]
    group_name: String,
}

#[derive(Deserialize)]
struct CategoryRow {
    #[serde(rename = "categoryID")]
    category_id: i64,
    #[serde(rename = "categoryName")]
    category_name: String,
    #[serde(rename = "iconID")]
    icon_id: Option<i64>,
    #[serde(rename = "published")]
    published: i32,
}

#[derive(Deserialize)]
struct DgmAttributeTypeRow {
    #[serde(rename = "attributeID")]
    attribute_id: i64,
    #[serde(rename = "attributeName")]
    name: String,
    /// Resolved display text (not a localization key) - some rows (e.g.
    /// isOnline) have this empty, which the Item Database's attribute
    /// list filters out at query time rather than here.
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "unitID")]
    unit_id: Option<i64>,
    #[serde(rename = "iconID")]
    icon_id: Option<i64>,
    #[serde(rename = "highIsGood")]
    high_is_good: Option<i32>,
    #[serde(rename = "published")]
    published: Option<i32>,
}

#[derive(Deserialize)]
struct DgmTypeAttributeRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "attributeID")]
    attribute_id: i64,
    /// A row has either valueInt or valueFloat meaningfully set, never
    /// both - coalesced into one column at import time.
    #[serde(rename = "valueInt")]
    value_int: Option<i64>,
    #[serde(rename = "valueFloat")]
    value_float: Option<f64>,
}

#[derive(Deserialize)]
struct DgmTypeEffectRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    #[serde(rename = "effectID")]
    effect_id: i64,
}

/// The 6 fixed dogma effect ids that mean "this module lives in this slot
/// list" - verified against PYFA's own bundled real SDE dump
/// (staticdata/fsd_built/dogmaeffects.0.json), not guessed. Nothing else
/// in the SDE encodes this relationship.
fn slot_type_for_effect(effect_id: i64) -> Option<&'static str> {
    match effect_id {
        11 => Some("low"),
        12 => Some("high"),
        13 => Some("mid"),
        2663 => Some("rig"),
        3772 => Some("subsystem"),
        6306 => Some("service"),
        _ => None,
    }
}

#[derive(Deserialize)]
struct MetaTypeRow {
    #[serde(rename = "typeID")]
    type_id: i64,
    /// The T1 (or lower-meta) hull this one is based on - e.g. an
    /// Interceptor's parent is its race's Tech I Frigate. None for baseline
    /// Tech I hulls, which have no parent.
    #[serde(rename = "parentTypeID")]
    parent_type_id: Option<i64>,
    /// 1=Tech I, 2=Tech II, 3=Storyline, 4=Faction, 5=Officer, 14=Tech III,
    /// 15=ORE, others for event/abyssal variants.
    #[serde(rename = "metaGroupID")]
    meta_group_id: Option<i64>,
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
        CREATE TABLE IF NOT EXISTS item_groups (
            id INTEGER PRIMARY KEY,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_item_groups_category ON item_groups (category_id);
        CREATE TABLE IF NOT EXISTS meta_types (
            type_id INTEGER PRIMARY KEY,
            parent_type_id INTEGER,
            meta_group_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_meta_types_parent ON meta_types (parent_type_id);
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
        CREATE INDEX IF NOT EXISTS idx_reprocessing_materials ON reprocessing_materials (type_id);
        CREATE TABLE IF NOT EXISTS item_categories (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            icon_id INTEGER,
            published INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS dgm_attribute_types (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            unit_id INTEGER,
            icon_id INTEGER,
            high_is_good INTEGER NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS dgm_type_attributes (
            type_id INTEGER NOT NULL,
            attribute_id INTEGER NOT NULL,
            value REAL NOT NULL,
            PRIMARY KEY (type_id, attribute_id)
        );",
    )
    .map_err(|e| format!("failed to create market tables: {e}"))?;
    // Installs synced before a later column was added have a table from the
    // older CREATE TABLE above, which "IF NOT EXISTS" leaves untouched. Add
    // whatever's missing rather than erroring - the actual values get
    // backfilled by the resync ensure_synced's migration check triggers.
    let _ = conn.execute("ALTER TABLE types ADD COLUMN volume REAL NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE market_groups ADD COLUMN icon_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN group_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN race_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN ship_tree_group_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN faction_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE types ADD COLUMN slot_type TEXT", []);
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
    let item_groups_total: i64 = conn.query_row("SELECT COUNT(*) FROM item_groups", [], |row| row.get(0)).unwrap_or(0);
    let types_with_group: i64 =
        conn.query_row("SELECT COUNT(*) FROM types WHERE group_id IS NOT NULL", [], |row| row.get(0)).unwrap_or(0);
    let types_with_faction: i64 =
        conn.query_row("SELECT COUNT(*) FROM types WHERE faction_id IS NOT NULL", [], |row| row.get(0)).unwrap_or(0);
    let item_categories_total: i64 =
        conn.query_row("SELECT COUNT(*) FROM item_categories", [], |row| row.get(0)).unwrap_or(0);
    let dgm_attribute_types_total: i64 =
        conn.query_row("SELECT COUNT(*) FROM dgm_attribute_types", [], |row| row.get(0)).unwrap_or(0);
    let types_with_null_market_group: i64 =
        conn.query_row("SELECT COUNT(*) FROM types WHERE market_group_id IS NULL", [], |row| row.get(0)).unwrap_or(0);
    (types_total > 0 && (types_with_volume == 0 || types_with_mass == 0))
        || (groups_total > 0 && groups_with_icon == 0)
        || (types_total > 0 && activities_total == 0)
        || (types_total > 0 && (item_groups_total == 0 || types_with_group == 0))
        || (types_total > 0 && types_with_faction == 0)
        || (types_total > 0 && item_categories_total == 0)
        || (types_total > 0 && dgm_attribute_types_total == 0)
        || (types_total > 0 && types_with_null_market_group == 0)
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
/// published items are kept - unpublished/deprecated rows (SKINs,
/// blueprint copies, etc.) would just be search-result noise. Unlike the
/// original version of this function, a missing market_group_id no longer
/// excludes a row - Structures and some Implants are real, published,
/// browsable items with no market-group listing, and the Item Database
/// needs to show them too. Nothing downstream assumes market_group_id is
/// non-null (it's already Option<i64> everywhere it's read).
fn import_market_data(
    conn: &mut rusqlite::Connection,
    types_csv: &str,
    groups_csv: &str,
    item_groups_csv: &str,
    meta_types_csv: &str,
    item_categories_csv: &str,
    type_effects_csv: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch(
        "DELETE FROM types; DELETE FROM market_groups; DELETE FROM item_groups; \
         DELETE FROM meta_types; DELETE FROM item_categories;",
    )
    .map_err(|e| format!("failed to clear market tables: {e}"))?;

    // Only used to derive slot_type below (see slot_type_for_effect) - not
    // stored as its own table, since nothing else needs a type's full
    // effect list, just which of the 6 known slot-defining effects it has.
    let mut slot_type_by_type_id: HashMap<i64, &'static str> = HashMap::new();
    {
        let mut reader = csv::Reader::from_reader(type_effects_csv.as_bytes());
        for result in reader.deserialize::<DgmTypeEffectRow>() {
            let Ok(row) = result else { continue };
            if let Some(slot) = slot_type_for_effect(row.effect_id) {
                slot_type_by_type_id.insert(row.type_id, slot);
            }
        }
    }

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO types (id, name, market_group_id, volume, mass, portion_size, group_id, race_id, ship_tree_group_id, faction_id, slot_type) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|e| format!("failed to prepare types insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(types_csv.as_bytes());
        for result in reader.deserialize::<TypeRow>() {
            let Ok(row) = result else { continue };
            if row.published == 0 {
                continue;
            }
            let _ = stmt.execute(rusqlite::params![
                row.type_id,
                row.type_name,
                row.market_group_id,
                row.volume.unwrap_or(0.0),
                row.mass.unwrap_or(0.0),
                row.portion_size.unwrap_or(1),
                row.group_id,
                row.race_id,
                row.ship_tree_group_id,
                row.faction_id,
                slot_type_by_type_id.get(&row.type_id).copied(),
            ]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO item_groups (id, category_id, name) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare item_groups insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(item_groups_csv.as_bytes());
        for result in reader.deserialize::<ItemGroupRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.group_id, row.category_id, row.group_name]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO item_categories (id, name, icon_id, published) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("failed to prepare item_categories insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(item_categories_csv.as_bytes());
        for result in reader.deserialize::<CategoryRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.category_id, row.category_name, row.icon_id, row.published]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO meta_types (type_id, parent_type_id, meta_group_id) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare meta_types insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(meta_types_csv.as_bytes());
        for result in reader.deserialize::<MetaTypeRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![row.type_id, row.parent_type_id, row.meta_group_id]);
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

/// Attribute values/definitions don't filter by published/market group
/// either, same reasoning as import_industry_data - an unpublished type
/// can still be someone's fitted module's real parent reference, and
/// dgm_attribute_types rows are filtered for display at query time
/// (published=1 AND display_name != ''), not at import time.
fn import_dogma_data(conn: &mut rusqlite::Connection, attribute_types_csv: &str, type_attributes_csv: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
    tx.execute_batch("DELETE FROM dgm_attribute_types; DELETE FROM dgm_type_attributes;")
        .map_err(|e| format!("failed to clear dogma tables: {e}"))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO dgm_attribute_types (id, name, display_name, unit_id, icon_id, high_is_good, published) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| format!("failed to prepare dgm_attribute_types insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(attribute_types_csv.as_bytes());
        for result in reader.deserialize::<DgmAttributeTypeRow>() {
            let Ok(row) = result else { continue };
            let _ = stmt.execute(rusqlite::params![
                row.attribute_id,
                row.name,
                row.display_name.unwrap_or_default(),
                row.unit_id,
                row.icon_id,
                row.high_is_good.unwrap_or(0),
                row.published.unwrap_or(0),
            ]);
        }
    }

    {
        let mut stmt = tx
            .prepare("INSERT INTO dgm_type_attributes (type_id, attribute_id, value) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("failed to prepare dgm_type_attributes insert: {e}"))?;
        let mut reader = csv::Reader::from_reader(type_attributes_csv.as_bytes());
        for result in reader.deserialize::<DgmTypeAttributeRow>() {
            let Ok(row) = result else { continue };
            let value = row.value_float.or(row.value_int.map(|v| v as f64)).unwrap_or(0.0);
            let _ = stmt.execute(rusqlite::params![row.type_id, row.attribute_id, value]);
        }
    }

    tx.commit().map_err(|e| format!("failed to commit dogma data: {e}"))
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
        let (
            (types_csv, groups_csv, item_groups_csv, meta_types_csv),
            (activity_csv, materials_csv, products_csv, probabilities_csv, reprocessing_csv),
            (item_categories_csv, type_effects_csv, dgm_attribute_types_csv, dgm_type_attributes_csv),
        ) = futures::try_join!(
            futures::future::try_join4(
                download_csv(client, TYPES_CSV_URL),
                download_csv(client, MARKET_GROUPS_CSV_URL),
                download_csv(client, INV_GROUPS_CSV_URL),
                download_csv(client, META_TYPES_CSV_URL),
            ),
            futures::future::try_join5(
                download_csv(client, ACTIVITY_CSV_URL),
                download_csv(client, ACTIVITY_MATERIALS_CSV_URL),
                download_csv(client, ACTIVITY_PRODUCTS_CSV_URL),
                download_csv(client, ACTIVITY_PROBABILITIES_CSV_URL),
                download_csv(client, REPROCESSING_MATERIALS_CSV_URL),
            ),
            futures::future::try_join4(
                download_csv(client, INV_CATEGORIES_CSV_URL),
                download_csv(client, DGM_TYPE_EFFECTS_CSV_URL),
                download_csv(client, DGM_ATTRIBUTE_TYPES_CSV_URL),
                download_csv(client, DGM_TYPE_ATTRIBUTES_CSV_URL),
            ),
        )?;

        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
            import_market_data(
                &mut conn,
                &types_csv,
                &groups_csv,
                &item_groups_csv,
                &meta_types_csv,
                &item_categories_csv,
                &type_effects_csv,
            )?;
            import_industry_data(&mut conn, &activity_csv, &materials_csv, &products_csv, &probabilities_csv, &reprocessing_csv)?;
            import_dogma_data(&mut conn, &dgm_attribute_types_csv, &dgm_type_attributes_csv)
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
    /// "high"/"mid"/"low"/"rig"/"subsystem"/"service", or None for
    /// anything that isn't a fittable module (ships, drones, charges,
    /// cargo-only items) - lets the Fit Builder's item browser know which
    /// slot list a double-clicked item belongs in.
    pub slot_type: Option<String>,
}

// --- Item Database (category -> group -> item grid -> item detail),
// replacing the earlier ReactFlow Ship Tree - a general browser across
// every EVE item category, not just ships, matching db.evetools.org's own
// drill-down structure. -----------------------------------------------

#[derive(Serialize, Clone)]
pub struct CategorySummary {
    pub id: i64,
    pub name: String,
    pub icon_id: Option<i64>,
    pub item_count: i64,
}

/// Every published item category that actually has at least one published
/// item in it (categories with zero items - e.g. some purely-internal
/// ones - aren't worth a browsable tile).
pub async fn get_item_categories(app: tauri::AppHandle, client: &reqwest::Client) -> Result<Vec<CategorySummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CategorySummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.name, c.icon_id, COUNT(t.id) AS item_count \
                 FROM item_categories c \
                 JOIN item_groups g ON g.category_id = c.id \
                 JOIN types t ON t.group_id = g.id \
                 WHERE c.published = 1 \
                 GROUP BY c.id \
                 HAVING item_count > 0 \
                 ORDER BY c.name",
            )
            .map_err(|e| format!("failed to query item categories: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CategorySummary { id: row.get(0)?, name: row.get(1)?, icon_id: row.get(2)?, item_count: row.get(3)? })
            })
            .map_err(|e| format!("failed to query item categories: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read category row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("item categories task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct GroupSummary {
    pub id: i64,
    pub name: String,
    pub item_count: i64,
}

/// Every group under one category (e.g. under Ship: Frigate, Cruiser,
/// Assault Frigate, ...) that has at least one published item.
pub async fn get_category_groups(app: tauri::AppHandle, client: &reqwest::Client, category_id: i64) -> Result<Vec<GroupSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<GroupSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT g.id, g.name, COUNT(t.id) AS item_count \
                 FROM item_groups g \
                 JOIN types t ON t.group_id = g.id \
                 WHERE g.category_id = ?1 \
                 GROUP BY g.id \
                 HAVING item_count > 0 \
                 ORDER BY g.name",
            )
            .map_err(|e| format!("failed to query category groups: {e}"))?;
        let rows = stmt
            .query_map([category_id], |row| Ok(GroupSummary { id: row.get(0)?, name: row.get(1)?, item_count: row.get(2)? }))
            .map_err(|e| format!("failed to query category groups: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read group row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("category groups task failed: {e}"))?
}

/// Every item filed directly under one leaf group - same query shape as
/// get_market_group_types, just keyed by item group instead of market
/// group so it also covers items with no market listing at all.
pub async fn get_group_items(app: tauri::AppHandle, client: &reqwest::Client, group_id: i64) -> Result<Vec<TypeSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id, name, slot_type, volume FROM types WHERE group_id = ?1 ORDER BY name")
            .map_err(|e| format!("failed to query group items: {e}"))?;
        let rows = stmt
            .query_map([group_id], |row| {
                Ok(TypeSummary { id: row.get(0)?, name: row.get(1)?, slot_type: row.get(2)?, volume: row.get(3)? })
            })
            .map_err(|e| format!("failed to query group items: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read item row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("group items task failed: {e}"))?
}

/// Every T1 blueprint group with at least one blueprint that actually has
/// invention data (activity_id = ACTIVITY_INVENTION) - the Invention tab's
/// browsable picker. Deliberately not get_category_groups(9): the plain
/// Blueprint category also holds T2/T3/faction/capital blueprint groups
/// (and mixed groups where only some members are T1) that have no
/// invention recipe at all, so a raw category browse would dead-end on
/// "has no invention data" for a lot of what it shows. This filters that
/// out at the source instead.
pub async fn get_inventable_blueprint_groups(app: tauri::AppHandle, client: &reqwest::Client) -> Result<Vec<GroupSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<GroupSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT g.id, g.name, COUNT(DISTINCT t.id) AS item_count \
                 FROM item_groups g \
                 JOIN types t ON t.group_id = g.id \
                 JOIN activities a ON a.type_id = t.id AND a.activity_id = ?1 \
                 GROUP BY g.id \
                 ORDER BY g.name",
            )
            .map_err(|e| format!("failed to query inventable blueprint groups: {e}"))?;
        let rows = stmt
            .query_map([ACTIVITY_INVENTION], |row| Ok(GroupSummary { id: row.get(0)?, name: row.get(1)?, item_count: row.get(2)? }))
            .map_err(|e| format!("failed to query inventable blueprint groups: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read group row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("inventable blueprint groups task failed: {e}"))?
}

/// Every blueprint within one group that actually has invention data -
/// same filtering reasoning as get_inventable_blueprint_groups, applied
/// one level down so every item this returns is a safe pick.
pub async fn get_inventable_blueprints_in_group(app: tauri::AppHandle, client: &reqwest::Client, group_id: i64) -> Result<Vec<TypeSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT t.id, t.name, t.slot_type, t.volume \
                 FROM types t \
                 JOIN activities a ON a.type_id = t.id AND a.activity_id = ?1 \
                 WHERE t.group_id = ?2 \
                 ORDER BY t.name",
            )
            .map_err(|e| format!("failed to query inventable blueprints: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![ACTIVITY_INVENTION, group_id], |row| {
                Ok(TypeSummary { id: row.get(0)?, name: row.get(1)?, slot_type: row.get(2)?, volume: row.get(3)? })
            })
            .map_err(|e| format!("failed to query inventable blueprints: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read blueprint row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("inventable blueprints task failed: {e}"))?
}

/// Every blueprint group with at least one blueprint that has ME or TE
/// research data - the Research tab's browsable picker. Unlike the
/// invention/reprocessing pickers this is a much broader net (ME/TE
/// research applies to essentially every manufacturable blueprint, T1
/// through capital - reactions are the one activity that never gets it,
/// confirmed by industryMath.ts's own reaction-ME provenance notes), but
/// the same "confirm against real recipe data, not the whole category"
/// reasoning still applies: category 9 alone would also surface a
/// handful of legacy/unpublished blueprint rows that only exist in the
/// raw SDE activity dump with no corresponding `types` row at all (no
/// name to show), which this filters out by construction.
pub async fn get_researchable_blueprint_groups(app: tauri::AppHandle, client: &reqwest::Client) -> Result<Vec<GroupSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<GroupSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT g.id, g.name, COUNT(DISTINCT t.id) AS item_count \
                 FROM item_groups g \
                 JOIN types t ON t.group_id = g.id \
                 JOIN activities a ON a.type_id = t.id AND a.activity_id IN (?1, ?2) \
                 GROUP BY g.id \
                 ORDER BY g.name",
            )
            .map_err(|e| format!("failed to query researchable blueprint groups: {e}"))?;
        let rows = stmt
            .query_map([ACTIVITY_RESEARCH_ME, ACTIVITY_RESEARCH_TE], |row| {
                Ok(GroupSummary { id: row.get(0)?, name: row.get(1)?, item_count: row.get(2)? })
            })
            .map_err(|e| format!("failed to query researchable blueprint groups: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read group row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("researchable blueprint groups task failed: {e}"))?
}

/// Every blueprint within one group that has ME or TE research data -
/// same filtering reasoning as get_researchable_blueprint_groups.
pub async fn get_researchable_blueprints_in_group(app: tauri::AppHandle, client: &reqwest::Client, group_id: i64) -> Result<Vec<TypeSummary>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TypeSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT t.id, t.name, t.slot_type, t.volume \
                 FROM types t \
                 JOIN activities a ON a.type_id = t.id AND a.activity_id IN (?1, ?2) \
                 WHERE t.group_id = ?3 \
                 ORDER BY t.name",
            )
            .map_err(|e| format!("failed to query researchable blueprints: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![ACTIVITY_RESEARCH_ME, ACTIVITY_RESEARCH_TE, group_id], |row| {
                Ok(TypeSummary { id: row.get(0)?, name: row.get(1)?, slot_type: row.get(2)?, volume: row.get(3)? })
            })
            .map_err(|e| format!("failed to query researchable blueprints: {e}"))?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read blueprint row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("researchable blueprints task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct AttributeValue {
    pub attribute_id: i64,
    pub name: String,
    pub value: f64,
    pub unit_id: Option<i64>,
    pub high_is_good: bool,
}

#[derive(Serialize, Clone)]
pub struct ItemDetail {
    pub type_id: i64,
    pub name: String,
    pub group_id: i64,
    pub group_name: String,
    pub category_id: i64,
    pub category_name: String,
    pub attributes: Vec<AttributeValue>,
}

/// One item's full detail page: name, group/category breadcrumb, and
/// every displayable dogma attribute (powergrid, CPU, damage, etc.).
/// Flavor text is a separate, already-existing live ESI call
/// (get_item_description) rather than folded in here, so this stays a
/// pure local-cache read.
pub async fn get_item_detail(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<ItemDetail, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ItemDetail, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let (name, group_id, group_name, category_id, category_name) = conn
            .query_row(
                "SELECT t.name, g.id, g.name, c.id, c.name \
                 FROM types t \
                 JOIN item_groups g ON g.id = t.group_id \
                 JOIN item_categories c ON c.id = g.category_id \
                 WHERE t.id = ?1",
                [type_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?)),
            )
            .map_err(|e| format!("failed to query item detail: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT dta.attribute_id, dat.display_name, dta.value, dat.unit_id, dat.high_is_good \
                 FROM dgm_type_attributes dta \
                 JOIN dgm_attribute_types dat ON dat.id = dta.attribute_id \
                 WHERE dta.type_id = ?1 AND dat.published = 1 AND dat.display_name != '' \
                 ORDER BY dat.display_name",
            )
            .map_err(|e| format!("failed to query item attributes: {e}"))?;
        let rows = stmt
            .query_map([type_id], |row| {
                let high_is_good: i64 = row.get(4)?;
                Ok(AttributeValue {
                    attribute_id: row.get(0)?,
                    name: row.get(1)?,
                    value: row.get(2)?,
                    unit_id: row.get(3)?,
                    high_is_good: high_is_good != 0,
                })
            })
            .map_err(|e| format!("failed to query item attributes: {e}"))?;
        let mut attributes = Vec::new();
        for row in rows {
            attributes.push(row.map_err(|e| format!("failed to read attribute row: {e}"))?);
        }

        Ok(ItemDetail { type_id, name, group_id, group_name, category_id, category_name, attributes })
    })
    .await
    .map_err(|e| format!("item detail task failed: {e}"))?
}

// --- Fit Builder resource math - dogma attribute ids verified against
// PYFA's own bundled real SDE dump, not guessed. Ship-side capacities vs.
// module/item-side consumption of the same resource. ------------------

const ATTR_POWER_OUTPUT: i64 = 11;
const ATTR_CPU_OUTPUT: i64 = 48;
const ATTR_CALIBRATION: i64 = 1132;
const ATTR_DRONE_BAY: i64 = 283;
const ATTR_DRONE_BANDWIDTH: i64 = 1271;
const ATTR_HI_SLOTS: i64 = 14;
const ATTR_MED_SLOTS: i64 = 13;
const ATTR_LOW_SLOTS: i64 = 12;
const ATTR_RIG_SLOTS: i64 = 1137;
const ATTR_SUBSYSTEM_SLOTS: i64 = 1367;
const ATTR_POWER_USED: i64 = 30;
const ATTR_CPU_USED: i64 = 50;
const ATTR_CALIBRATION_USED: i64 = 1153;
const ATTR_DRONE_BANDWIDTH_USED: i64 = 1272;
/// (skill-type-id attribute, required-level attribute) pairs - verified
/// directly against the synced dgm_attribute_types table before trusting
/// these (not guessed from memory), the same discipline used for the ship
/// stat/resource attribute IDs above. requiredSkill4/5/6 exist for the rare
/// item needing more than 3 prerequisite skills.
const REQUIRED_SKILL_ATTR_PAIRS: [(i64, i64); 6] = [(182, 277), (183, 278), (184, 279), (1285, 1286), (1289, 1287), (1290, 1288)];

#[derive(Serialize, Clone, Default)]
pub struct ShipStats {
    pub hi_slots: i64,
    pub mid_slots: i64,
    pub low_slots: i64,
    pub rig_slots: i64,
    pub subsystem_slots: i64,
    pub power_output: f64,
    pub cpu_output: f64,
    pub calibration: f64,
    pub drone_bay_volume: f64,
    pub drone_bandwidth: f64,
}

/// A ship's real slot counts and resource capacities, straight from its
/// own dgm_type_attributes row - what the Fit Builder's fixed-count slot
/// list and Resources sidebar are both built from, replacing the old
/// unbounded "append another slot" model.
pub async fn get_ship_stats(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<ShipStats, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ShipStats, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT attribute_id, value FROM dgm_type_attributes WHERE type_id = ?1")
            .map_err(|e| format!("failed to query ship stats: {e}"))?;
        let rows = stmt
            .query_map([type_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))
            .map_err(|e| format!("failed to query ship stats: {e}"))?;
        let mut stats = ShipStats::default();
        for row in rows {
            let (attribute_id, value) = row.map_err(|e| format!("failed to read ship stat row: {e}"))?;
            match attribute_id {
                ATTR_HI_SLOTS => stats.hi_slots = value as i64,
                ATTR_MED_SLOTS => stats.mid_slots = value as i64,
                ATTR_LOW_SLOTS => stats.low_slots = value as i64,
                ATTR_RIG_SLOTS => stats.rig_slots = value as i64,
                ATTR_SUBSYSTEM_SLOTS => stats.subsystem_slots = value as i64,
                ATTR_POWER_OUTPUT => stats.power_output = value,
                ATTR_CPU_OUTPUT => stats.cpu_output = value,
                ATTR_CALIBRATION => stats.calibration = value,
                ATTR_DRONE_BAY => stats.drone_bay_volume = value,
                ATTR_DRONE_BANDWIDTH => stats.drone_bandwidth = value,
                _ => {}
            }
        }
        Ok(stats)
    })
    .await
    .map_err(|e| format!("ship stats task failed: {e}"))?
}

#[derive(Serialize, Clone, Default)]
pub struct ItemResourceCost {
    pub power: f64,
    pub cpu: f64,
    pub calibration: f64,
    pub drone_bandwidth: f64,
    pub volume: f64,
}

/// Bulk sibling for a whole fit's worth of items at once - same
/// "one round trip, not one per line item" reasoning as
/// get_region_sell_min_prices. `volume` comes straight from `types`
/// (already synced for every item, used elsewhere for cargo math too),
/// not from dogma attributes.
pub async fn get_item_resource_costs(
    app: tauri::AppHandle,
    client: &reqwest::Client,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, ItemResourceCost>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<HashMap<i64, ItemResourceCost>, String> {
        let mut results: HashMap<i64, ItemResourceCost> = HashMap::new();
        if type_ids.is_empty() {
            return Ok(results);
        }
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let placeholders = vec!["?"; type_ids.len()].join(",");

        let attrs_sql = format!(
            "SELECT type_id, attribute_id, value FROM dgm_type_attributes \
             WHERE type_id IN ({placeholders}) AND attribute_id IN ({ATTR_POWER_USED}, {ATTR_CPU_USED}, {ATTR_CALIBRATION_USED}, {ATTR_DRONE_BANDWIDTH_USED})",
        );
        let mut stmt = conn.prepare(&attrs_sql).map_err(|e| format!("failed to query item resource costs: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(type_ids.iter()), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?))
            })
            .map_err(|e| format!("failed to query item resource costs: {e}"))?;
        for row in rows {
            let (type_id, attribute_id, value) = row.map_err(|e| format!("failed to read resource cost row: {e}"))?;
            let entry = results.entry(type_id).or_default();
            match attribute_id {
                ATTR_POWER_USED => entry.power = value,
                ATTR_CPU_USED => entry.cpu = value,
                ATTR_CALIBRATION_USED => entry.calibration = value,
                ATTR_DRONE_BANDWIDTH_USED => entry.drone_bandwidth = value,
                _ => {}
            }
        }

        let volume_sql = format!("SELECT id, volume FROM types WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&volume_sql).map_err(|e| format!("failed to query item volumes: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(type_ids.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))
            .map_err(|e| format!("failed to query item volumes: {e}"))?;
        for row in rows {
            let (type_id, volume) = row.map_err(|e| format!("failed to read item volume row: {e}"))?;
            results.entry(type_id).or_default().volume = volume;
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("item resource cost task failed: {e}"))?
}

/// Verified live against ESI's own dogma attribute descriptions (not
/// guessed) before use in the Capital Route planner:
///   867  jumpDriveRange            "Range in light years the ship can maximum jump to"
///   868  jumpDriveConsumptionAmount "Number of units it consumes per light year"
///   866  jumpDriveConsumptionType   the isotope item type_id burned per jump
/// Fuel use is a flat per-hull rate from these attributes - EVE's jump
/// drive rework years ago moved off a mass-based formula, confirmed by the
/// attribute's own description text having no mention of mass at all.
const ATTR_JUMP_RANGE: i64 = 867;
const ATTR_JUMP_FUEL_PER_LY: i64 = 868;
const ATTR_JUMP_FUEL_TYPE: i64 = 866;

#[derive(Serialize, Clone)]
pub struct JumpDriveInfo {
    pub base_range_ly: f64,
    pub fuel_per_ly: f64,
    pub fuel_type_id: i64,
}

/// None if the type has no jump drive at all (jumpDriveRange missing or
/// zero) - most ships, so the caller can show a clear "not jump capable"
/// state rather than a route with zero range.
pub async fn get_jump_drive_info(app: tauri::AppHandle, client: &reqwest::Client, type_id: i64) -> Result<Option<JumpDriveInfo>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<JumpDriveInfo>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT attribute_id, value FROM dgm_type_attributes WHERE type_id = ?1")
            .map_err(|e| format!("failed to query jump drive info: {e}"))?;
        let rows = stmt
            .query_map([type_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))
            .map_err(|e| format!("failed to query jump drive info: {e}"))?;
        let mut base_range_ly = 0.0;
        let mut fuel_per_ly = 0.0;
        let mut fuel_type_id = 0i64;
        for row in rows {
            let (attribute_id, value) = row.map_err(|e| format!("failed to read jump drive attribute row: {e}"))?;
            match attribute_id {
                ATTR_JUMP_RANGE => base_range_ly = value,
                ATTR_JUMP_FUEL_PER_LY => fuel_per_ly = value,
                ATTR_JUMP_FUEL_TYPE => fuel_type_id = value as i64,
                _ => {}
            }
        }
        if base_range_ly <= 0.0 {
            return Ok(None);
        }
        Ok(Some(JumpDriveInfo { base_range_ly, fuel_per_ly, fuel_type_id }))
    })
    .await
    .map_err(|e| format!("jump drive info task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct ShipClassification {
    pub group_id: i64,
    pub group_name: String,
    pub category_id: i64,
}

/// Group/category for a batch of type ids, straight from the local SDE
/// cache (types.group_id joined against item_groups) - no live ESI call
/// needed, unlike route.rs's per-kill gate-camp classification. Used by
/// the kill history recorder to classify ships as capitals/structures for
/// every kill in the live stream, where a live call per hull would be far
/// too slow for a continuously-running background task.
pub async fn get_ship_classifications(
    app: tauri::AppHandle,
    client: &reqwest::Client,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, ShipClassification>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<HashMap<i64, ShipClassification>, String> {
        let mut results = HashMap::new();
        if type_ids.is_empty() {
            return Ok(results);
        }
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let placeholders = vec!["?"; type_ids.len()].join(",");
        let sql = format!(
            "SELECT t.id, t.group_id, g.name, g.category_id \
             FROM types t JOIN item_groups g ON g.id = t.group_id \
             WHERE t.id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to query ship classifications: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(type_ids.iter()), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?))
            })
            .map_err(|e| format!("failed to query ship classifications: {e}"))?;
        for row in rows {
            let (type_id, group_id, group_name, category_id) = row.map_err(|e| format!("failed to read ship classification row: {e}"))?;
            results.insert(type_id, ShipClassification { group_id, group_name, category_id });
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("ship classification task failed: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct SkillRequirement {
    pub skill_type_id: i64,
    pub skill_name: String,
    pub level: i32,
}

/// Every prerequisite skill (and required level) for a batch of items at
/// once - a ship hull, every fitted module, a whole doctrine's worth of
/// hulls, whatever the caller has on hand. Reads the same dgm_type_attributes
/// table the Fit Builder's slot counts and resource costs already come from.
pub async fn get_skill_requirements_bulk(
    app: tauri::AppHandle,
    client: &reqwest::Client,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<SkillRequirement>>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<HashMap<i64, Vec<SkillRequirement>>, String> {
        let mut result: HashMap<i64, Vec<SkillRequirement>> = HashMap::new();
        if type_ids.is_empty() {
            return Ok(result);
        }
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let placeholders = vec!["?"; type_ids.len()].join(",");

        let attrs_sql = format!("SELECT type_id, attribute_id, value FROM dgm_type_attributes WHERE type_id IN ({placeholders})");
        let mut stmt = conn.prepare(&attrs_sql).map_err(|e| format!("failed to query skill requirements: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(type_ids.iter()), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?))
            })
            .map_err(|e| format!("failed to query skill requirements: {e}"))?;

        let mut per_type: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        for row in rows {
            let (type_id, attribute_id, value) = row.map_err(|e| format!("failed to read skill requirement row: {e}"))?;
            per_type.entry(type_id).or_default().insert(attribute_id, value);
        }

        let mut skill_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for attrs in per_type.values() {
            for (skill_attr, _) in REQUIRED_SKILL_ATTR_PAIRS {
                if let Some(v) = attrs.get(&skill_attr) {
                    skill_ids.insert(*v as i64);
                }
            }
        }

        let mut skill_names: HashMap<i64, String> = HashMap::new();
        if !skill_ids.is_empty() {
            let ids: Vec<i64> = skill_ids.into_iter().collect();
            let name_placeholders = vec!["?"; ids.len()].join(",");
            let name_sql = format!("SELECT id, name FROM types WHERE id IN ({name_placeholders})");
            let mut name_stmt = conn.prepare(&name_sql).map_err(|e| format!("failed to query skill names: {e}"))?;
            let name_rows = name_stmt
                .query_map(rusqlite::params_from_iter(ids.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("failed to query skill names: {e}"))?;
            for row in name_rows {
                let (id, name) = row.map_err(|e| format!("failed to read skill name row: {e}"))?;
                skill_names.insert(id, name);
            }
        }

        for (type_id, attrs) in per_type {
            let mut reqs = Vec::new();
            for (skill_attr, level_attr) in REQUIRED_SKILL_ATTR_PAIRS {
                let Some(skill_id_f) = attrs.get(&skill_attr) else { continue };
                let skill_type_id = *skill_id_f as i64;
                let level = attrs.get(&level_attr).copied().unwrap_or(1.0) as i32;
                let skill_name = skill_names.get(&skill_type_id).cloned().unwrap_or_else(|| format!("Skill #{skill_type_id}"));
                reqs.push(SkillRequirement { skill_type_id, skill_name, level });
            }
            if !reqs.is_empty() {
                result.insert(type_id, reqs);
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("skill requirement task failed: {e}"))?
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
                "SELECT id, name, market_group_id, volume, slot_type FROM types WHERE name LIKE ?1 \
                 ORDER BY (name NOT LIKE ?2), length(name), name LIMIT 25",
            )
            .map_err(|e| format!("failed to query types: {e}"))?;
        let prefix_pattern = format!("{trimmed}%");
        let rows = stmt
            .query_map(rusqlite::params![pattern, prefix_pattern], |row| {
                Ok(TypeSearchMatch {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    market_group_id: row.get(2)?,
                    volume: row.get(3)?,
                    slot_type: row.get(4)?,
                })
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
                Ok(TypeSearchMatch { id: row.get(0)?, name: row.get(1)?, market_group_id: row.get(2)?, volume: row.get(3)?, slot_type: None })
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
    /// "high"/"mid"/"low"/"rig"/"subsystem"/"service", or None - same
    /// meaning as TypeSearchMatch.slot_type, used by the Fit Builder's
    /// market-group browser panel to know which slot list to add to.
    pub slot_type: Option<String>,
    /// m3 per unit - needed for the Screener's cargo-space/profit-per-m3
    /// hauling comparison.
    pub volume: f64,
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
            .prepare("SELECT id, name, slot_type, volume FROM types WHERE market_group_id = ?1 ORDER BY name")
            .map_err(|e| format!("failed to query types: {e}"))?;
        let rows = stmt
            .query_map([market_group_id], |row| {
                Ok(TypeSummary { id: row.get(0)?, name: row.get(1)?, slot_type: row.get(2)?, volume: row.get(3)? })
            })
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

/// Exact-name -> type_id lookup against the already-synced types table -
/// the reverse of every other name resolver in this file, needed for
/// D-Scan's paste-parser (EVE's clipboard format gives item type *names*
/// as plain text, not ids, so this is how a pasted "Rifter" gets an icon).
/// Names with no match (e.g. celestial bodies like "Moon" or "Sun" aren't
/// in the SDE's item list at all) are simply absent from the result.
pub async fn resolve_type_ids_by_name(app: tauri::AppHandle, client: &reqwest::Client, names: Vec<String>) -> Result<HashMap<String, i64>, String> {
    let path = ensure_synced(&app, client).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<HashMap<String, i64>, String> {
        let mut result = HashMap::new();
        if names.is_empty() {
            return Ok(result);
        }
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open market database: {e}"))?;
        let placeholders = vec!["?"; names.len()].join(",");
        let sql = format!("SELECT id, name FROM types WHERE name IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to query type names: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(names.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("failed to query type names: {e}"))?;
        for row in rows {
            let (id, name) = row.map_err(|e| format!("failed to read type name row: {e}"))?;
            result.insert(name, id);
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("type name resolution task failed: {e}"))?
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
