use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::Manager;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("wormholes.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chains (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            auto_map_enabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chain_systems (
            id TEXT PRIMARY KEY,
            chain_id TEXT NOT NULL,
            system_id INTEGER NOT NULL,
            system_name TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            is_origin INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chain_systems_chain ON chain_systems (chain_id);
        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            chain_id TEXT NOT NULL,
            from_chain_system_id TEXT NOT NULL,
            to_chain_system_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'wormhole',
            wormhole_type TEXT NOT NULL DEFAULT 'Unknown',
            mass_status TEXT NOT NULL DEFAULT 'fresh',
            is_eol INTEGER NOT NULL DEFAULT 0,
            eol_flagged_at INTEGER,
            first_seen_at INTEGER,
            from_signature_id TEXT,
            to_signature_id TEXT,
            flag_icon TEXT,
            flag_color TEXT,
            flag_note TEXT NOT NULL DEFAULT '',
            flag_blink INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_connections_chain ON connections (chain_id);
        CREATE INDEX IF NOT EXISTS idx_connections_from ON connections (from_chain_system_id);
        CREATE INDEX IF NOT EXISTS idx_connections_to ON connections (to_chain_system_id);
        CREATE TABLE IF NOT EXISTS signatures (
            id TEXT PRIMARY KEY,
            chain_id TEXT NOT NULL,
            chain_system_id TEXT NOT NULL,
            sig_id TEXT NOT NULL,
            sig_type TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            signal_strength TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'unknown',
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_signatures_chain_system ON signatures (chain_system_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_signatures_unique ON signatures (chain_system_id, sig_id);
        CREATE TABLE IF NOT EXISTS chain_structures (
            id TEXT PRIMARY KEY,
            chain_id TEXT NOT NULL,
            chain_system_id TEXT NOT NULL,
            eve_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            structure_type TEXT NOT NULL DEFAULT 'unknown',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chain_structures_chain_system ON chain_structures (chain_system_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_structures_unique ON chain_structures (chain_system_id, eve_id);
        CREATE TABLE IF NOT EXISTS mass_log (
            id TEXT PRIMARY KEY,
            chain_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            character_name TEXT NOT NULL DEFAULT '',
            ship_type_name TEXT NOT NULL DEFAULT '',
            mass_kg REAL NOT NULL,
            hot INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mass_log_connection ON mass_log (connection_id);
        CREATE INDEX IF NOT EXISTS idx_mass_log_chain ON mass_log (chain_id);",
    )
    .map_err(|e| format!("failed to create wormhole tables: {e}"))?;

    // Columns added after this feature's initial ship this session - SQLite
    // has no "ADD COLUMN IF NOT EXISTS", so these are tried unconditionally
    // and any "duplicate column" failure (already migrated) is ignored, same
    // idiom market.rs already uses for its own post-ship columns.
    let _ = conn.execute("ALTER TABLE chains ADD COLUMN auto_map_enabled INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'wormhole'", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN first_seen_at INTEGER", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN flag_icon TEXT", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN flag_color TEXT", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN flag_note TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE connections ADD COLUMN flag_blink INTEGER NOT NULL DEFAULT 0", []);
    conn.execute("UPDATE connections SET first_seen_at = created_at WHERE first_seen_at IS NULL", [])
        .map_err(|e| format!("failed to backfill connections.first_seen_at: {e}"))?;
    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Hex rather than a UUID crate dependency, same approach as fittings.rs's
/// new_fit_id and the SSO PKCE state generator.
fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Clone)]
pub struct ChainSummary {
    pub id: String,
    pub name: String,
    pub system_count: i64,
    pub auto_map_enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
pub struct ChainSystem {
    pub id: String,
    pub system_id: i64,
    pub system_name: String,
    pub x: f64,
    pub y: f64,
    pub is_origin: bool,
    pub notes: String,
}

#[derive(Serialize, Clone)]
pub struct Signature {
    pub id: String,
    pub chain_system_id: String,
    pub sig_id: String,
    pub sig_type: String,
    pub name: String,
    pub signal_strength: String,
    pub kind: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

/// A player-owned structure manually registered for a chain system, pasted
/// from the in-game Overview - ESI's public structure list only covers
/// known/scannable space, so it can't see a citadel sitting in unscanned
/// J-space. Unlike signatures, nothing here decays or gets swept
/// automatically; a structure stays until someone deletes it.
#[derive(Serialize, Clone)]
pub struct ChainStructure {
    pub id: String,
    pub chain_system_id: String,
    pub eve_id: i64,
    pub name: String,
    pub structure_type: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone)]
pub struct Connection {
    pub id: String,
    pub from_chain_system_id: String,
    pub to_chain_system_id: String,
    /// "wormhole" | "stargate" - a stargate connection is auto-added by
    /// live-location tracking for a plain gate hop, kept purely as a
    /// breadcrumb of the route in and out of known space; none of the
    /// wormhole-specific fields below (type/mass/EOL/rolling calc) apply to it.
    pub kind: String,
    pub wormhole_type: String,
    pub mass_status: String,
    pub is_eol: bool,
    pub eol_flagged_at: Option<i64>,
    pub first_seen_at: i64,
    pub from_signature_id: Option<String>,
    pub to_signature_id: Option<String>,
    /// Computed at read time: true when `from_signature_id`/`to_signature_id`
    /// is set but no longer resolves to a live row in `signatures` - the
    /// connection stays on the chain but renders as visually severed rather
    /// than being silently deleted alongside the signature.
    pub from_signature_broken: bool,
    pub to_signature_broken: bool,
    pub flag_icon: Option<String>,
    pub flag_color: Option<String>,
    pub flag_note: String,
    pub flag_blink: bool,
    pub notes: String,
}

#[derive(Serialize, Clone)]
pub struct MassLogEntry {
    pub id: String,
    pub connection_id: String,
    pub character_name: String,
    pub ship_type_name: String,
    pub mass_kg: f64,
    pub hot: bool,
    pub source: String,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct ChainDetail {
    pub id: String,
    pub name: String,
    pub auto_map_enabled: bool,
    pub systems: Vec<ChainSystem>,
    pub connections: Vec<Connection>,
    pub signatures: Vec<Signature>,
    pub structures: Vec<ChainStructure>,
    pub mass_log_entries: Vec<MassLogEntry>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct ChainSystemInput {
    pub id: Option<String>,
    pub system_id: i64,
    pub system_name: String,
    pub x: f64,
    pub y: f64,
    pub is_origin: bool,
    pub notes: String,
}

#[derive(Deserialize)]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub from_chain_system_id: String,
    pub to_chain_system_id: String,
    pub kind: String,
    pub wormhole_type: String,
    pub mass_status: String,
    pub is_eol: bool,
    pub from_signature_id: Option<String>,
    pub to_signature_id: Option<String>,
    pub flag_icon: Option<String>,
    pub flag_color: Option<String>,
    pub flag_note: String,
    pub flag_blink: bool,
    pub notes: String,
}

#[derive(Deserialize)]
pub struct MassLogInput {
    pub connection_id: String,
    pub character_name: String,
    pub ship_type_name: String,
    pub mass_kg: f64,
    pub hot: bool,
    pub source: String,
}

#[derive(Deserialize)]
pub struct SignatureInput {
    pub id: Option<String>,
    pub chain_system_id: String,
    pub sig_id: String,
    pub sig_type: String,
    pub name: String,
    pub signal_strength: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ParsedSignature {
    pub sig_id: String,
    pub kind: String,
    pub sig_type: String,
    pub signal_strength: String,
}

#[derive(Serialize)]
pub struct ImportSignaturesResult {
    pub imported: i64,
    pub updated: i64,
    pub missing_sig_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ParsedStructure {
    pub eve_id: i64,
    pub name: String,
    pub structure_type: String,
}

#[derive(Serialize)]
pub struct ImportStructuresResult {
    pub imported: i64,
    pub updated: i64,
}

fn touch_chain(conn: &rusqlite::Connection, chain_id: &str) -> Result<(), String> {
    conn.execute("UPDATE chains SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_unix(), chain_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_chains(app: tauri::AppHandle) -> Result<Vec<ChainSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ChainSummary>, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.name, c.created_at, c.updated_at, c.auto_map_enabled,
                        (SELECT COUNT(*) FROM chain_systems s WHERE s.chain_id = c.id) AS system_count
                 FROM chains c ORDER BY c.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ChainSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    auto_map_enabled: row.get::<_, i64>(4)? != 0,
                    system_count: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_chain(app: tauri::AppHandle, chain_id: String) -> Result<ChainDetail, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ChainDetail, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;

        let (name, created_at, updated_at, auto_map_enabled): (String, i64, i64, bool) = conn
            .query_row(
                "SELECT name, created_at, updated_at, auto_map_enabled FROM chains WHERE id = ?1",
                [&chain_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0)),
            )
            .map_err(|e| format!("chain not found: {e}"))?;

        let mut systems = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, system_id, system_name, x, y, is_origin, notes
                     FROM chain_systems WHERE chain_id = ?1 ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    Ok(ChainSystem {
                        id: row.get(0)?,
                        system_id: row.get(1)?,
                        system_name: row.get(2)?,
                        x: row.get(3)?,
                        y: row.get(4)?,
                        is_origin: row.get::<_, i64>(5)? != 0,
                        notes: row.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                systems.push(row.map_err(|e| e.to_string())?);
            }
        }

        let mut signatures = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, chain_system_id, sig_id, sig_type, name, signal_strength, kind, first_seen_at, last_seen_at
                     FROM signatures WHERE chain_id = ?1 ORDER BY sig_id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    Ok(Signature {
                        id: row.get(0)?,
                        chain_system_id: row.get(1)?,
                        sig_id: row.get(2)?,
                        sig_type: row.get(3)?,
                        name: row.get(4)?,
                        signal_strength: row.get(5)?,
                        kind: row.get(6)?,
                        first_seen_at: row.get(7)?,
                        last_seen_at: row.get(8)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                signatures.push(row.map_err(|e| e.to_string())?);
            }
        }
        let live_signature_ids: HashSet<&str> = signatures.iter().map(|s| s.id.as_str()).collect();

        let mut structures = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, chain_system_id, eve_id, name, structure_type, created_at
                     FROM chain_structures WHERE chain_id = ?1 ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    Ok(ChainStructure {
                        id: row.get(0)?,
                        chain_system_id: row.get(1)?,
                        eve_id: row.get(2)?,
                        name: row.get(3)?,
                        structure_type: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                structures.push(row.map_err(|e| e.to_string())?);
            }
        }

        let mut connections = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, from_chain_system_id, to_chain_system_id, kind, wormhole_type, mass_status, is_eol,
                            eol_flagged_at, first_seen_at, from_signature_id, to_signature_id,
                            flag_icon, flag_color, flag_note, flag_blink, notes
                     FROM connections WHERE chain_id = ?1 ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    let from_signature_id: Option<String> = row.get(9)?;
                    let to_signature_id: Option<String> = row.get(10)?;
                    Ok((
                        Connection {
                            id: row.get(0)?,
                            from_chain_system_id: row.get(1)?,
                            to_chain_system_id: row.get(2)?,
                            kind: row.get(3)?,
                            wormhole_type: row.get(4)?,
                            mass_status: row.get(5)?,
                            is_eol: row.get::<_, i64>(6)? != 0,
                            eol_flagged_at: row.get(7)?,
                            first_seen_at: row.get(8)?,
                            from_signature_broken: false,
                            to_signature_broken: false,
                            from_signature_id,
                            to_signature_id,
                            flag_icon: row.get(11)?,
                            flag_color: row.get(12)?,
                            flag_note: row.get(13)?,
                            flag_blink: row.get::<_, i64>(14)? != 0,
                            notes: row.get(15)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (mut conn_row,) = row.map_err(|e| e.to_string())?;
                conn_row.from_signature_broken =
                    conn_row.from_signature_id.as_deref().is_some_and(|id| !live_signature_ids.contains(id));
                conn_row.to_signature_broken =
                    conn_row.to_signature_id.as_deref().is_some_and(|id| !live_signature_ids.contains(id));
                connections.push(conn_row);
            }
        }

        let mut mass_log_entries = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, character_name, ship_type_name, mass_kg, hot, source, created_at
                     FROM mass_log WHERE chain_id = ?1 ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    Ok(MassLogEntry {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        character_name: row.get(2)?,
                        ship_type_name: row.get(3)?,
                        mass_kg: row.get(4)?,
                        hot: row.get::<_, i64>(5)? != 0,
                        source: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                mass_log_entries.push(row.map_err(|e| e.to_string())?);
            }
        }

        Ok(ChainDetail {
            id: chain_id,
            name,
            auto_map_enabled,
            systems,
            connections,
            signatures,
            structures,
            mass_log_entries,
            created_at,
            updated_at,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn create_chain(app: tauri::AppHandle, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = new_id();
        let now = now_unix();
        conn.execute(
            "INSERT INTO chains (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![id, name, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn rename_chain(app: tauri::AppHandle, chain_id: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute(
            "UPDATE chains SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![name, now_unix(), chain_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn set_chain_auto_map(app: tauri::AppHandle, chain_id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute(
            "UPDATE chains SET auto_map_enabled = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![enabled, now_unix(), chain_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cascades across all six tables for this chain in one transaction.
pub async fn delete_chain(app: tauri::AppHandle, chain_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM mass_log WHERE chain_id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chain_structures WHERE chain_id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM signatures WHERE chain_id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM connections WHERE chain_id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chain_systems WHERE chain_id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chains WHERE id = ?1", [&chain_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn upsert_chain_system(app: tauri::AppHandle, chain_id: String, input: ChainSystemInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = input.id.unwrap_or_else(new_id);
        let now = now_unix();
        conn.execute(
            "INSERT INTO chain_systems (id, chain_id, system_id, system_name, x, y, is_origin, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                system_id = excluded.system_id,
                system_name = excluded.system_name,
                x = excluded.x,
                y = excluded.y,
                is_origin = excluded.is_origin,
                notes = excluded.notes",
            rusqlite::params![id, chain_id, input.system_id, input.system_name, input.x, input.y, input.is_origin, input.notes, now],
        )
        .map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cascades: this system's own signatures and structures, and any connection
/// touching it as either endpoint (a wormhole connection makes no sense with
/// one end removed, unlike a signature deletion which just severs a link).
pub async fn delete_chain_system(app: tauri::AppHandle, chain_id: String, chain_system_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM signatures WHERE chain_system_id = ?1", [&chain_system_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chain_structures WHERE chain_system_id = ?1", [&chain_system_id]).map_err(|e| e.to_string())?;
        // Must run before the connections delete below - mass_log is keyed by
        // connection_id, so once those connection rows are gone there's
        // nothing left to join against and these entries would be orphaned.
        tx.execute(
            "DELETE FROM mass_log WHERE connection_id IN (
                SELECT id FROM connections WHERE from_chain_system_id = ?1 OR to_chain_system_id = ?1
            )",
            [&chain_system_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM connections WHERE from_chain_system_id = ?1 OR to_chain_system_id = ?1",
            [&chain_system_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chain_systems WHERE id = ?1", [&chain_system_id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE chains SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_unix(), chain_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn upsert_connection(app: tauri::AppHandle, chain_id: String, input: ConnectionInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = input.id.unwrap_or_else(new_id);
        let now = now_unix();
        let eol_flagged_at: Option<i64> = if input.is_eol { Some(now) } else { None };
        conn.execute(
            "INSERT INTO connections (id, chain_id, from_chain_system_id, to_chain_system_id, kind, wormhole_type, mass_status,
                                       is_eol, eol_flagged_at, first_seen_at, from_signature_id, to_signature_id,
                                       flag_icon, flag_color, flag_note, flag_blink, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
             ON CONFLICT(id) DO UPDATE SET
                from_chain_system_id = excluded.from_chain_system_id,
                to_chain_system_id = excluded.to_chain_system_id,
                kind = excluded.kind,
                wormhole_type = excluded.wormhole_type,
                mass_status = excluded.mass_status,
                is_eol = excluded.is_eol,
                eol_flagged_at = CASE
                    WHEN excluded.is_eol = 1 AND connections.is_eol = 0 THEN excluded.eol_flagged_at
                    WHEN excluded.is_eol = 0 THEN NULL
                    ELSE connections.eol_flagged_at
                END,
                from_signature_id = excluded.from_signature_id,
                to_signature_id = excluded.to_signature_id,
                flag_icon = excluded.flag_icon,
                flag_color = excluded.flag_color,
                flag_note = excluded.flag_note,
                flag_blink = excluded.flag_blink,
                notes = excluded.notes,
                updated_at = excluded.updated_at",
            rusqlite::params![
                id,
                chain_id,
                input.from_chain_system_id,
                input.to_chain_system_id,
                input.kind,
                input.wormhole_type,
                input.mass_status,
                input.is_eol,
                eol_flagged_at,
                now,
                input.from_signature_id,
                input.to_signature_id,
                input.flag_icon,
                input.flag_color,
                input.flag_note,
                input.flag_blink,
                input.notes,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_connection(app: tauri::AppHandle, chain_id: String, connection_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM mass_log WHERE connection_id = ?1", [&connection_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM connections WHERE id = ?1", [&connection_id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE chains SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_unix(), chain_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn upsert_signature(app: tauri::AppHandle, chain_id: String, input: SignatureInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = input.id.unwrap_or_else(new_id);
        let now = now_unix();
        conn.execute(
            "INSERT INTO signatures (id, chain_id, chain_system_id, sig_id, sig_type, name, signal_strength, kind, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(chain_system_id, sig_id) DO UPDATE SET
                sig_type = excluded.sig_type,
                name = excluded.name,
                signal_strength = excluded.signal_strength,
                kind = excluded.kind,
                last_seen_at = excluded.last_seen_at",
            rusqlite::params![
                id,
                chain_id,
                input.chain_system_id,
                input.sig_id,
                input.sig_type,
                input.name,
                input.signal_strength,
                input.kind,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bulk-upserts a pasted d-scan/probe-scan result for one system. Never
/// deletes sigs that are missing from this paste (a partial scan shouldn't
/// silently erase sigs the player just didn't rescan) - those are reported
/// back in `missing_sig_ids` for the user to review and delete by hand.
pub async fn import_signatures(
    app: tauri::AppHandle,
    chain_id: String,
    chain_system_id: String,
    signatures: Vec<ParsedSignature>,
) -> Result<ImportSignaturesResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportSignaturesResult, String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let now = now_unix();

        let mut existing_sig_ids: HashSet<String> = HashSet::new();
        {
            let mut stmt = conn
                .prepare("SELECT sig_id FROM signatures WHERE chain_system_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&chain_system_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for row in rows {
                existing_sig_ids.insert(row.map_err(|e| e.to_string())?);
            }
        }

        let mut imported = 0i64;
        let mut updated = 0i64;
        let pasted_sig_ids: HashSet<String> = signatures.iter().map(|s| s.sig_id.clone()).collect();

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for sig in &signatures {
            if existing_sig_ids.contains(&sig.sig_id) {
                updated += 1;
            } else {
                imported += 1;
            }
            tx.execute(
                "INSERT INTO signatures (id, chain_id, chain_system_id, sig_id, sig_type, name, signal_strength, kind, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, ?8)
                 ON CONFLICT(chain_system_id, sig_id) DO UPDATE SET
                    sig_type = excluded.sig_type,
                    signal_strength = excluded.signal_strength,
                    kind = excluded.kind,
                    last_seen_at = excluded.last_seen_at",
                rusqlite::params![new_id(), chain_id, chain_system_id, sig.sig_id, sig.sig_type, sig.signal_strength, sig.kind, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE chains SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now, chain_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        let missing_sig_ids: Vec<String> = existing_sig_ids.difference(&pasted_sig_ids).cloned().collect();
        Ok(ImportSignaturesResult { imported, updated, missing_sig_ids })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_signature(app: tauri::AppHandle, chain_id: String, signature_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM signatures WHERE id = ?1", [&signature_id]).map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bulk-upserts a pasted in-game Overview list of player-owned structures for
/// one system. Unlike import_signatures, nothing here is reported as
/// "missing" - a structure a corp built stays valid until someone actually
/// removes it, there's no decay concept to sweep for.
pub async fn import_structures(
    app: tauri::AppHandle,
    chain_id: String,
    chain_system_id: String,
    structures: Vec<ParsedStructure>,
) -> Result<ImportStructuresResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportStructuresResult, String> {
        let mut conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let now = now_unix();

        let mut existing_eve_ids: HashSet<i64> = HashSet::new();
        {
            let mut stmt = conn
                .prepare("SELECT eve_id FROM chain_structures WHERE chain_system_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&chain_system_id], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
            for row in rows {
                existing_eve_ids.insert(row.map_err(|e| e.to_string())?);
            }
        }

        let mut imported = 0i64;
        let mut updated = 0i64;

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for structure in &structures {
            if existing_eve_ids.contains(&structure.eve_id) {
                updated += 1;
            } else {
                imported += 1;
            }
            tx.execute(
                "INSERT INTO chain_structures (id, chain_id, chain_system_id, eve_id, name, structure_type, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(chain_system_id, eve_id) DO UPDATE SET
                    name = excluded.name,
                    structure_type = excluded.structure_type",
                rusqlite::params![new_id(), chain_id, chain_system_id, structure.eve_id, structure.name, structure.structure_type, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE chains SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now, chain_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(ImportStructuresResult { imported, updated })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_chain_structure(app: tauri::AppHandle, chain_id: String, structure_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM chain_structures WHERE id = ?1", [&structure_id]).map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn upsert_mass_log(app: tauri::AppHandle, chain_id: String, input: MassLogInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        let id = new_id();
        conn.execute(
            "INSERT INTO mass_log (id, chain_id, connection_id, character_name, ship_type_name, mass_kg, hot, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                id,
                chain_id,
                input.connection_id,
                input.character_name,
                input.ship_type_name,
                input.mass_kg,
                input.hot,
                input.source,
                now_unix()
            ],
        )
        .map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo: deletes a specific log row the frontend already has, not a
/// "most recent" lookup query - avoids any race with a concurrent write.
pub async fn delete_mass_log_entry(app: tauri::AppHandle, chain_id: String, entry_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM mass_log WHERE id = ?1", [&entry_id]).map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reset: clears every logged pass for one connection.
pub async fn clear_mass_log(app: tauri::AppHandle, chain_id: String, connection_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM mass_log WHERE connection_id = ?1", [&connection_id]).map_err(|e| e.to_string())?;
        touch_chain(&conn, &chain_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct RouteHop {
    pub kind: String,
    pub connection_id: Option<String>,
}

#[derive(Serialize)]
pub struct RouteStep {
    pub system_id: i64,
    pub system_name: String,
    pub via: Option<RouteHop>,
}

/// Shortest path from `origin_system_id` to `destination_system_id` over the
/// normal stargate network (read straight from map.sqlite, self-syncing it
/// first if empty - same lazy-sync entry point get_map_data uses) plus this
/// chain's wormhole connections layered in as extra edges. Unweighted BFS,
/// same "shortest" semantics as ESI's own route endpoint - mass/EOL status
/// isn't considered, matching this feature's deliberately non-physics-model
/// scope (a critical-mass or EOL wormhole is still a valid hop, just as Gate
/// Check doesn't avoid low-sec by default).
pub async fn find_chain_route(
    app: tauri::AppHandle,
    client: reqwest::Client,
    chain_id: String,
    origin_system_id: i64,
    destination_system_id: i64,
) -> Result<Vec<RouteStep>, String> {
    let map_db_path = crate::map::ensure_synced(&app, &client).await?;
    let wh_db_path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<RouteStep>, String> {
        let map_conn = rusqlite::Connection::open(&map_db_path).map_err(|e| e.to_string())?;
        let mut adjacency: HashMap<i64, Vec<i64>> = HashMap::new();
        {
            let mut stmt = map_conn.prepare("SELECT from_id, to_id FROM jumps").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                adjacency.entry(row.0).or_default().push(row.1);
                adjacency.entry(row.1).or_default().push(row.0);
            }
        }

        let wh_conn = rusqlite::Connection::open(&wh_db_path).map_err(|e| e.to_string())?;
        ensure_schema(&wh_conn)?;
        // (connection_id, kind) - kind is the connection's own "wormhole"/
        // "stargate" tag, not inferred, since a tracked chain can now
        // include auto-added stargate hops (breadcrumbing the route in and
        // out of known space) alongside real wormholes.
        let mut edge_connection: HashMap<(i64, i64), (String, String)> = HashMap::new();
        {
            let mut stmt = wh_conn
                .prepare(
                    "SELECT c.id, c.kind, fs.system_id, ts.system_id
                     FROM connections c
                     JOIN chain_systems fs ON fs.id = c.from_chain_system_id
                     JOIN chain_systems ts ON ts.id = c.to_chain_system_id
                     WHERE c.chain_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&chain_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (conn_id, kind, from_sys, to_sys) = row.map_err(|e| e.to_string())?;
                adjacency.entry(from_sys).or_default().push(to_sys);
                adjacency.entry(to_sys).or_default().push(from_sys);
                edge_connection.insert((from_sys, to_sys), (conn_id.clone(), kind.clone()));
                edge_connection.insert((to_sys, from_sys), (conn_id, kind));
            }
        }

        let mut visited: HashSet<i64> = HashSet::from([origin_system_id]);
        let mut parent: HashMap<i64, i64> = HashMap::new();
        let mut frontier = vec![origin_system_id];
        let mut found = origin_system_id == destination_system_id;
        while !frontier.is_empty() && !found {
            let mut next = Vec::new();
            for system_id in frontier {
                for &neighbor in adjacency.get(&system_id).into_iter().flatten() {
                    if visited.insert(neighbor) {
                        parent.insert(neighbor, system_id);
                        if neighbor == destination_system_id {
                            found = true;
                        }
                        next.push(neighbor);
                    }
                }
            }
            frontier = next;
        }
        if !found {
            return Err("No route found between these systems with the current chain.".to_string());
        }

        let mut path = vec![destination_system_id];
        let mut current = destination_system_id;
        while current != origin_system_id {
            let prev = *parent.get(&current).ok_or("route reconstruction failed")?;
            path.push(prev);
            current = prev;
        }
        path.reverse();

        let mut names: HashMap<i64, String> = HashMap::new();
        {
            let placeholders = path.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT id, name FROM systems WHERE id IN ({placeholders})");
            let mut stmt = map_conn.prepare(&sql).map_err(|e| e.to_string())?;
            let params: Vec<&dyn rusqlite::ToSql> = path.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let rows = stmt
                .query_map(params.as_slice(), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                names.insert(row.0, row.1);
            }
        }

        let mut steps = Vec::with_capacity(path.len());
        for (i, &system_id) in path.iter().enumerate() {
            let via = if i == 0 {
                None
            } else {
                let prev = path[i - 1];
                match edge_connection.get(&(prev, system_id)) {
                    Some((conn_id, kind)) => Some(RouteHop { kind: kind.clone(), connection_id: Some(conn_id.clone()) }),
                    None => Some(RouteHop { kind: "stargate".to_string(), connection_id: None }),
                }
            };
            steps.push(RouteStep {
                system_id,
                system_name: names.get(&system_id).cloned().unwrap_or_else(|| format!("System #{system_id}")),
                via,
            });
        }
        Ok(steps)
    })
    .await
    .map_err(|e| e.to_string())?
}
