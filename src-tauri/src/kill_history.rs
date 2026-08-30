use crate::kills::{self, KillEntry};
use crate::map;
use crate::market;
use crate::route::CAPITAL_GROUPS;
use chrono::{Duration, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

/// zKillboard's own real region-id bands and thresholds for these
/// classifications - verified live against their open-source repo
/// (zKillboard/zKillboard, classes/MongoFilter.php + cron/3.queueProcess.php)
/// rather than guessed, since a wrong id here would silently mislabel every
/// kill in that category.
const ABYSSAL_REGION_MIN: i64 = 12_000_000;
const ABYSSAL_REGION_MAX: i64 = 13_000_000;
const HIGHSEC_MIN_SECURITY: f64 = 0.45;
/// EVE's "Structure" item category (Citadels, Engineering Complexes,
/// Refineries, and other Upwell/mobile structures) - broader than route.rs's
/// CITADEL_GROUP, which only covers the Astrahus/Fortizar/Keepstar family.
const STRUCTURE_CATEGORY_ID: i64 = 65;
/// CONCORD's NPC corporation id - verified live via ESI (/corporations/1000125/).
const CONCORD_CORPORATION_ID: i64 = 1_000_125;
/// How far back (same system) to look for the original gank a CONCORD
/// response kill was punishing. zKillboard's own cron uses killID proximity
/// (within 200 killIDs) rather than a fixed time window, since it has a
/// monotonic sequence to compare against; VESPER's local store only has
/// timestamps, so a time window is the direct substitute - generous enough
/// to cover the seconds-to-low-minutes it typically takes CONCORD to
/// respond, without matching an unrelated kill from hours earlier.
const GANK_LOOKBACK_MINUTES: i64 = 15;
/// Matches zKillboard's own noise filter - a gank worth flagging destroyed
/// at least this much value.
const GANK_MIN_VALUE: f64 = 1_000_000.0;
/// How long a kill stays in the local history before being pruned - bounds
/// the database's size for a recorder that runs continuously in the
/// background for as long as the app is open.
const RETENTION_DAYS: i64 = 30;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("kill_history.sqlite"))
}

/// Every read/write against this database goes through here rather than a
/// bare rusqlite::Connection::open - this file has many independent
/// spawn_blocking tasks (the always-running live recorder, the startup
/// backfill, the manual 30-day backfill, and every query_* function below)
/// that can genuinely open a connection at the same moment. SQLite's
/// default journal mode holds an exclusive lock for the whole duration of
/// a write and fails any concurrent writer immediately (confirmed live:
/// "database is locked" silently dropped an entire backfill day the first
/// time the startup backfill ran alongside the live recorder) - WAL mode
/// lets readers and a writer coexist, and a busy_timeout makes a genuine
/// writer-vs-writer collision retry for a few seconds instead of failing
/// on the spot.
fn open_db(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("failed to open kill history database: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| format!("failed to set WAL journal mode: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| format!("failed to set busy timeout: {e}"))?;
    Ok(conn)
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kill_history (
            killmail_id INTEGER PRIMARY KEY,
            killmail_time TEXT NOT NULL,
            solar_system_id INTEGER NOT NULL,
            system_name TEXT NOT NULL DEFAULT '',
            region_id INTEGER NOT NULL DEFAULT 0,
            region_name TEXT NOT NULL DEFAULT '',
            security_status REAL NOT NULL DEFAULT 0,
            location_id INTEGER NOT NULL DEFAULT 0,
            pos_x REAL,
            pos_y REAL,
            pos_z REAL,
            victim_character_id INTEGER,
            victim_character_name TEXT,
            victim_corporation_id INTEGER,
            victim_corporation_name TEXT,
            victim_alliance_id INTEGER,
            victim_alliance_name TEXT,
            victim_faction_id INTEGER,
            victim_faction_name TEXT,
            ship_type_id INTEGER NOT NULL,
            ship_type_name TEXT NOT NULL,
            ship_group_id INTEGER NOT NULL DEFAULT 0,
            ship_group_name TEXT NOT NULL DEFAULT '',
            ship_category_id INTEGER NOT NULL DEFAULT 0,
            total_value REAL NOT NULL DEFAULT 0,
            attacker_count INTEGER NOT NULL DEFAULT 0,
            final_blow_character_id INTEGER,
            final_blow_character_name TEXT,
            final_blow_corporation_id INTEGER,
            final_blow_corporation_name TEXT,
            final_blow_alliance_id INTEGER,
            final_blow_alliance_name TEXT,
            npc INTEGER NOT NULL DEFAULT 0,
            solo INTEGER NOT NULL DEFAULT 0,
            awox INTEGER NOT NULL DEFAULT 0,
            ganked INTEGER NOT NULL DEFAULT 0,
            war_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_kill_history_time ON kill_history(killmail_time);
        CREATE INDEX IF NOT EXISTS idx_kill_history_system_time ON kill_history(solar_system_id, killmail_time);
        CREATE TABLE IF NOT EXISTS kill_history_attackers (
            killmail_id INTEGER NOT NULL,
            killmail_time TEXT NOT NULL,
            character_id INTEGER,
            character_name TEXT,
            corporation_id INTEGER,
            corporation_name TEXT,
            alliance_id INTEGER,
            alliance_name TEXT,
            faction_id INTEGER,
            faction_name TEXT,
            ship_type_id INTEGER,
            ship_type_name TEXT,
            ship_group_id INTEGER,
            ship_group_name TEXT,
            weapon_type_id INTEGER,
            final_blow INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_kha_killmail ON kill_history_attackers(killmail_id);
        CREATE INDEX IF NOT EXISTS idx_kha_character_time ON kill_history_attackers(character_id, killmail_time);
        CREATE INDEX IF NOT EXISTS idx_kha_time ON kill_history_attackers(killmail_time);",
    )
    .map_err(|e| format!("failed to create kill history tables: {e}"))?;

    // Migration: pos_x/pos_y/pos_z and weapon_type_id were added after this
    // schema's original release, for the gate-camp checker's local kill
    // store (see route.rs::get_gate_activity). ALTER TABLE errors on a
    // database that already has the column ("duplicate column name"), which
    // is the expected steady-state after the first run past this point -
    // any other failure here would already have surfaced from the CREATE
    // TABLE statements above, so ignoring the error is safe.
    let _ = conn.execute("ALTER TABLE kill_history ADD COLUMN pos_x REAL", []);
    let _ = conn.execute("ALTER TABLE kill_history ADD COLUMN pos_y REAL", []);
    let _ = conn.execute("ALTER TABLE kill_history ADD COLUMN pos_z REAL", []);
    let _ = conn.execute("ALTER TABLE kill_history_attackers ADD COLUMN weapon_type_id INTEGER", []);
    Ok(())
}

/// A ship's classification (group/category), resolved locally so the
/// continuously-running recorder never needs a live ESI call per kill.
fn classify(
    type_id: i64,
    classifications: &HashMap<i64, market::ShipClassification>,
) -> (i64, String, i64) {
    match classifications.get(&type_id) {
        Some(c) => (c.group_id, c.group_name.clone(), c.category_id),
        None => (0, String::new(), 0),
    }
}

/// Rookie ships, shuttles, and capsules - zKillboard's own isSolo()/isAwox()
/// exclude these victim ship groups entirely (verified live against their
/// source), since losing one of these barely counts as a real kill either way.
const ROOKIE_SHUTTLE_CAPSULE_GROUPS: [i64; 3] = [29, 31, 237];

/// Computes total_value/npc/solo/awox for a kill that has none of them,
/// because it came from zKillboard's bulk history dumps rather than the
/// live-enriched stream. Mirrors zKillboard's own isSolo()/isAwox() logic
/// (verified live against their source) as closely as the data available
/// here allows - `npc` uses a simpler "victim has no character" rule
/// rather than their fuller edge-case handling, since it only feeds the
/// "Abyssal PvP" filter here, not a standalone category.
fn compute_classification(
    kill: &KillEntry,
    classifications: &HashMap<i64, market::ShipClassification>,
    prices: &HashMap<i64, f64>,
) -> (f64, bool, bool, bool) {
    let npc = kill.victim_character_id.is_none();

    let mut total_value = prices.get(&kill.ship_type_id).copied().unwrap_or(0.0);
    for item in &kill.items {
        let unit_price = prices.get(&item.item_type_id).copied().unwrap_or(0.0);
        total_value += unit_price * (item.quantity_destroyed + item.quantity_dropped) as f64;
    }

    let victim_category_id = classifications.get(&kill.ship_type_id).map(|c| c.category_id).unwrap_or(0);
    let victim_group_id = classifications.get(&kill.ship_type_id).map(|c| c.group_id).unwrap_or(0);
    let mut solo = !ROOKIE_SHUTTLE_CAPSULE_GROUPS.contains(&victim_group_id) && victim_category_id == 6;
    if solo {
        let mut num_players = 0;
        for attacker in &kill.attackers {
            if attacker.character_id.is_some() {
                num_players += 1;
            }
            let attacker_category_id = attacker.ship_type_id.and_then(|id| classifications.get(&id)).map(|c| c.category_id);
            if attacker_category_id == Some(STRUCTURE_CATEGORY_ID) {
                solo = false;
                break;
            }
        }
        if solo {
            solo = num_players == 1;
        }
    }

    let mut awox = false;
    if !ROOKIE_SHUTTLE_CAPSULE_GROUPS.contains(&victim_group_id) {
        if let Some(victim_corp) = kill.victim_corporation_id.filter(|&id| id > 0) {
            if let Some(final_blow) = kill.attackers.iter().find(|a| a.final_blow) {
                if let Some(fb_corp) = final_blow.corporation_id {
                    awox = fb_corp > 1_999_999 && fb_corp == victim_corp;
                }
            }
        }
    }

    (total_value, npc, solo, awox)
}

#[cfg(test)]
mod compute_classification_tests {
    use super::*;
    use crate::kills::{KillAttacker, KillmailItem};
    use crate::market::ShipClassification;

    const SHIP_CATEGORY_ID: i64 = 6;
    const VICTIM_SHIP_TYPE: i64 = 600;
    const ATTACKER_SHIP_TYPE: i64 = 601;
    const STRUCTURE_SHIP_TYPE: i64 = 700;

    fn attacker(character_id: Option<i64>, corporation_id: Option<i64>, final_blow: bool, ship_type_id: Option<i64>) -> KillAttacker {
        KillAttacker {
            character_id,
            character_name: None,
            corporation_id,
            corporation_name: None,
            alliance_id: None,
            alliance_name: None,
            faction_id: None,
            faction_name: None,
            ship_type_id,
            ship_type_name: None,
            weapon_type_id: None,
            final_blow,
        }
    }

    fn base_kill() -> KillEntry {
        KillEntry {
            killmail_id: 1,
            time: "2026-08-20T00:00:00Z".to_string(),
            system_id: 1,
            system_name: "Test".to_string(),
            system_security: Some(0.5),
            region_name: None,
            location_id: 0,
            victim_character_id: Some(100),
            victim_character_name: None,
            victim_corporation_id: Some(2_000_001),
            victim_corporation_name: None,
            victim_alliance_id: None,
            victim_alliance_name: None,
            ship_type_id: VICTIM_SHIP_TYPE,
            ship_type_name: "Test Ship".to_string(),
            total_value: 0.0,
            npc: false,
            solo: false,
            attacker_count: 0,
            final_blow_character_id: None,
            final_blow_character_name: None,
            final_blow_corporation_id: None,
            final_blow_corporation_name: None,
            final_blow_alliance_id: None,
            final_blow_alliance_name: None,
            victim_faction_id: None,
            victim_faction_name: None,
            awox: false,
            zkb_provided: false,
            war_id: None,
            attackers: Vec::new(),
            items: Vec::new(),
            position: None,
        }
    }

    fn classifications() -> HashMap<i64, ShipClassification> {
        let mut m = HashMap::new();
        m.insert(VICTIM_SHIP_TYPE, ShipClassification { group_id: 26, group_name: "Frigate".to_string(), category_id: SHIP_CATEGORY_ID });
        m.insert(ATTACKER_SHIP_TYPE, ShipClassification { group_id: 25, group_name: "Cruiser".to_string(), category_id: SHIP_CATEGORY_ID });
        m.insert(STRUCTURE_SHIP_TYPE, ShipClassification { group_id: 1657, group_name: "Citadel".to_string(), category_id: STRUCTURE_CATEGORY_ID });
        m
    }

    #[test]
    fn one_real_attacker_is_solo() {
        let mut kill = base_kill();
        kill.attackers = vec![attacker(Some(200), Some(3_000_001), true, Some(ATTACKER_SHIP_TYPE))];
        let (_, npc, solo, awox) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(!npc);
        assert!(solo, "exactly one real attacker should be solo");
        assert!(!awox);
    }

    #[test]
    fn two_real_attackers_is_not_solo() {
        let mut kill = base_kill();
        kill.attackers = vec![
            attacker(Some(200), Some(3_000_001), true, Some(ATTACKER_SHIP_TYPE)),
            attacker(Some(201), Some(3_000_002), false, Some(ATTACKER_SHIP_TYPE)),
        ];
        let (_, _, solo, _) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(!solo, "two real attackers should not be solo");
    }

    #[test]
    fn structure_attacker_disqualifies_solo() {
        let mut kill = base_kill();
        kill.attackers = vec![attacker(Some(200), Some(3_000_001), true, Some(STRUCTURE_SHIP_TYPE))];
        let (_, _, solo, _) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(!solo, "a structure on the killmail should disqualify solo, even with one real attacker");
    }

    #[test]
    fn final_blow_from_victims_own_corp_is_awox() {
        let mut kill = base_kill();
        kill.victim_corporation_id = Some(3_000_001);
        kill.attackers = vec![attacker(Some(200), Some(3_000_001), true, Some(ATTACKER_SHIP_TYPE))];
        let (_, _, _, awox) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(awox, "final blow from the victim's own corp should be awox");
    }

    #[test]
    fn final_blow_from_npc_corp_is_not_awox_even_if_matching() {
        // Corp ids at or below 1,999,999 are NPC corps - matching there
        // should never count as awox (mirrors zKillboard's own guard).
        let mut kill = base_kill();
        kill.victim_corporation_id = Some(1_000_001);
        kill.attackers = vec![attacker(Some(200), Some(1_000_001), true, Some(ATTACKER_SHIP_TYPE))];
        let (_, _, _, awox) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(!awox);
    }

    #[test]
    fn victim_with_no_character_is_npc() {
        let mut kill = base_kill();
        kill.victim_character_id = None;
        let (_, npc, _, _) = compute_classification(&kill, &classifications(), &HashMap::new());
        assert!(npc);
    }

    #[test]
    fn total_value_sums_hull_and_items() {
        let mut kill = base_kill();
        kill.items = vec![
            KillmailItem { item_type_id: 900, quantity_destroyed: 2, quantity_dropped: 1 },
            KillmailItem { item_type_id: 901, quantity_destroyed: 0, quantity_dropped: 4 },
        ];
        let mut prices = HashMap::new();
        prices.insert(VICTIM_SHIP_TYPE, 1_000_000.0);
        prices.insert(900, 100_000.0);
        prices.insert(901, 5_000.0);
        let (total_value, _, _, _) = compute_classification(&kill, &classifications(), &prices);
        // hull 1,000,000 + item 900: 3 units * 100,000 + item 901: 4 units * 5,000
        assert_eq!(total_value, 1_000_000.0 + 300_000.0 + 20_000.0);
    }
}

/// Records a batch of already-enriched kills (with full attacker lists) into
/// the local history, resolving region/security and ship classifications in
/// bulk first, then runs the retroactive "ganked" correlation check and
/// prunes anything older than RETENTION_DAYS.
pub async fn record_kills(app: &tauri::AppHandle, client: &reqwest::Client, kills: Vec<KillEntry>) -> Result<(), String> {
    if kills.is_empty() {
        return Ok(());
    }

    let mut system_ids: Vec<i64> = kills.iter().map(|k| k.system_id).collect();
    system_ids.sort_unstable();
    system_ids.dedup();
    let system_rows = map::get_systems_region_security(app.clone(), client, system_ids).await?;
    let system_by_id: HashMap<i64, (i64, f64)> =
        system_rows.into_iter().map(|s| (s.system_id, (s.region_id, s.security))).collect();

    let mut type_ids: Vec<i64> = Vec::new();
    for kill in &kills {
        type_ids.push(kill.ship_type_id);
        for attacker in &kill.attackers {
            if let Some(id) = attacker.ship_type_id {
                type_ids.push(id);
            }
        }
    }
    type_ids.sort_unstable();
    type_ids.dedup();
    let classifications = market::get_ship_classifications(app.clone(), client, type_ids).await?;

    // zKillboard's bulk daily history dumps (used by the backfill) carry raw
    // ESI killmail data only - no zkb block, so no pre-computed value/npc/
    // solo/awox at all. Only fetched when at least one kill in this batch
    // actually needs it, so the live recorder's normal path (every kill
    // already zkb-enriched) never pays for this.
    let prices: HashMap<i64, f64> = if kills.iter().any(|k| !k.zkb_provided) {
        market::fetch_market_prices(client)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.average_price.or(p.adjusted_price).map(|price| (p.type_id, price)))
            .collect()
    } else {
        HashMap::new()
    };

    let path = db_path(app)?;
    let concord_kill_ids: Vec<i64> = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<i64>, String> {
        let mut conn = open_db(&path)?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;

        let mut concord_kill_ids = Vec::new();

        {
            let mut kill_stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO kill_history (
                        killmail_id, killmail_time, solar_system_id, system_name, region_id, region_name,
                        security_status, location_id, pos_x, pos_y, pos_z, victim_character_id, victim_character_name,
                        victim_corporation_id, victim_corporation_name, victim_alliance_id, victim_alliance_name,
                        victim_faction_id, victim_faction_name, ship_type_id, ship_type_name, ship_group_id,
                        ship_group_name, ship_category_id, total_value, attacker_count, final_blow_character_id,
                        final_blow_character_name, final_blow_corporation_id, final_blow_corporation_name,
                        final_blow_alliance_id, final_blow_alliance_name, npc, solo, awox, ganked, war_id
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,0,?36)",
                )
                .map_err(|e| format!("failed to prepare kill_history insert: {e}"))?;
            let mut attacker_stmt = tx
                .prepare(
                    "INSERT INTO kill_history_attackers (
                        killmail_id, killmail_time, character_id, character_name, corporation_id, corporation_name,
                        alliance_id, alliance_name, faction_id, faction_name, ship_type_id, ship_type_name,
                        ship_group_id, ship_group_name, weapon_type_id, final_blow
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                )
                .map_err(|e| format!("failed to prepare kill_history_attackers insert: {e}"))?;

            for kill in &kills {
                let (region_id, security) = system_by_id.get(&kill.system_id).copied().unwrap_or((0, 0.0));
                let (ship_group_id, ship_group_name, ship_category_id) = classify(kill.ship_type_id, &classifications);
                let (total_value, npc, solo, awox) = if kill.zkb_provided {
                    (kill.total_value, kill.npc, kill.solo, kill.awox)
                } else {
                    compute_classification(kill, &classifications, &prices)
                };

                let changed = kill_stmt
                    .execute(rusqlite::params![
                        kill.killmail_id,
                        kill.time,
                        kill.system_id,
                        kill.system_name,
                        region_id,
                        kill.region_name,
                        security,
                        kill.location_id,
                        kill.position.map(|(x, _, _)| x),
                        kill.position.map(|(_, y, _)| y),
                        kill.position.map(|(_, _, z)| z),
                        kill.victim_character_id,
                        kill.victim_character_name,
                        kill.victim_corporation_id,
                        kill.victim_corporation_name,
                        kill.victim_alliance_id,
                        kill.victim_alliance_name,
                        kill.victim_faction_id,
                        kill.victim_faction_name,
                        kill.ship_type_id,
                        kill.ship_type_name,
                        ship_group_id,
                        ship_group_name,
                        ship_category_id,
                        total_value,
                        kill.attacker_count as i64,
                        kill.final_blow_character_id,
                        kill.final_blow_character_name,
                        kill.final_blow_corporation_id,
                        kill.final_blow_corporation_name,
                        kill.final_blow_alliance_id,
                        kill.final_blow_alliance_name,
                        npc as i64,
                        solo as i64,
                        awox as i64,
                        kill.war_id,
                    ])
                    .map_err(|e| format!("failed to insert kill_history row: {e}"))?;

                if changed == 0 {
                    // Already recorded (e.g. re-delivered by the stream) -
                    // skip re-inserting attackers too.
                    continue;
                }

                let mut has_concord = false;
                for attacker in &kill.attackers {
                    let (a_group_id, a_group_name, _) = attacker
                        .ship_type_id
                        .map(|id| classify(id, &classifications))
                        .unwrap_or((0, String::new(), 0));
                    if attacker.corporation_id == Some(CONCORD_CORPORATION_ID) {
                        has_concord = true;
                    }
                    attacker_stmt
                        .execute(rusqlite::params![
                            kill.killmail_id,
                            kill.time,
                            attacker.character_id,
                            attacker.character_name,
                            attacker.corporation_id,
                            attacker.corporation_name,
                            attacker.alliance_id,
                            attacker.alliance_name,
                            attacker.faction_id,
                            attacker.faction_name,
                            attacker.ship_type_id,
                            attacker.ship_type_name,
                            a_group_id,
                            a_group_name,
                            attacker.weapon_type_id,
                            attacker.final_blow as i64,
                        ])
                        .map_err(|e| format!("failed to insert kill_history_attackers row: {e}"))?;
                }

                if has_concord && security >= HIGHSEC_MIN_SECURITY {
                    concord_kill_ids.push(kill.killmail_id);
                }
            }
        }

        tx.commit().map_err(|e| format!("failed to commit kill history batch: {e}"))?;
        Ok(concord_kill_ids)
    })
    .await
    .map_err(|e| format!("kill history record task failed: {e}"))??;

    if !concord_kill_ids.is_empty() {
        mark_ganked(app, concord_kill_ids).await?;
    }

    prune(app).await?;
    Ok(())
}

/// For each newly-recorded kill where CONCORD is among the attackers (in
/// highsec), the victim of that kill is the "ganker" CONCORD just punished.
/// Looks back through the same system's recent history for a kill where
/// that same character appeared as an attacker - not itself already a
/// CONCORD response - and retroactively marks it "ganked". Mirrors
/// zKillboard's own cron/9.ganked.php logic (verified live against their
/// source), substituting a time window for their killID-proximity check.
async fn mark_ganked(app: &tauri::AppHandle, concord_kill_ids: Vec<i64>) -> Result<(), String> {
    let path = db_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_db(&path)?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;

        for concord_kill_id in concord_kill_ids {
            let ganger_and_time: Option<(Option<i64>, String)> = tx
                .query_row(
                    "SELECT victim_character_id, killmail_time FROM kill_history WHERE killmail_id = ?1",
                    [concord_kill_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            let Some((Some(ganker_character_id), concord_time)) = ganger_and_time else { continue };

            let system_id: i64 = tx
                .query_row("SELECT solar_system_id FROM kill_history WHERE killmail_id = ?1", [concord_kill_id], |row| row.get(0))
                .unwrap_or(0);

            let mut stmt = tx
                .prepare(
                    "SELECT DISTINCT a.killmail_id FROM kill_history_attackers a
                     JOIN kill_history k ON k.killmail_id = a.killmail_id
                     WHERE a.character_id = ?1 AND k.solar_system_id = ?2
                       AND a.killmail_time < ?3
                       AND datetime(a.killmail_time) >= datetime(?3, ?4)
                       AND k.total_value >= ?5 AND k.awox = 0 AND k.ganked = 0",
                )
                .map_err(|e| format!("failed to prepare gank candidate query: {e}"))?;
            let lookback = format!("-{GANK_LOOKBACK_MINUTES} minutes");
            let candidates: Vec<i64> = stmt
                .query_map(rusqlite::params![ganker_character_id, system_id, concord_time, lookback, GANK_MIN_VALUE], |row| row.get(0))
                .map_err(|e| format!("failed to query gank candidates: {e}"))?
                .flatten()
                .collect();

            for candidate_id in candidates {
                let already_concorded: bool = tx
                    .query_row(
                        "SELECT COUNT(*) FROM kill_history_attackers WHERE killmail_id = ?1 AND corporation_id = ?2",
                        rusqlite::params![candidate_id, CONCORD_CORPORATION_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(|c| c > 0)
                    .unwrap_or(false);
                if already_concorded {
                    continue;
                }
                tx.execute("UPDATE kill_history SET ganked = 1 WHERE killmail_id = ?1", [candidate_id])
                    .map_err(|e| format!("failed to mark kill as ganked: {e}"))?;
            }
        }

        tx.commit().map_err(|e| format!("failed to commit ganked updates: {e}"))
    })
    .await
    .map_err(|e| format!("ganked correlation task failed: {e}"))?
}

async fn prune(app: &tauri::AppHandle) -> Result<(), String> {
    let path = db_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = open_db(&path)?;
        let cutoff = format!("-{RETENTION_DAYS} days");
        conn.execute(
            "DELETE FROM kill_history_attackers WHERE datetime(killmail_time) < datetime('now', ?1)",
            [&cutoff],
        )
        .map_err(|e| format!("failed to prune kill_history_attackers: {e}"))?;
        conn.execute("DELETE FROM kill_history WHERE datetime(killmail_time) < datetime('now', ?1)", [&cutoff])
            .map_err(|e| format!("failed to prune kill_history: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("kill history prune task failed: {e}"))?
}

/// Runs for the lifetime of the app (spawned once from lib.rs's setup hook):
/// long-polls the same unfiltered live kill stream every other consumer
/// uses, but on its own fixed queue so it can catch up on anything missed
/// while the app was closed. Best-effort - a single failed poll is logged
/// and retried rather than killing the loop.
pub async fn run_kill_history_recorder(app: tauri::AppHandle, client: reqwest::Client) {
    loop {
        match kills::poll_kill_history(&client).await {
            Ok(new_kills) if !new_kills.is_empty() => {
                emit_tracked_player_events(&app, &new_kills);
                if let Err(e) = record_kills(&app, &client, new_kills).await {
                    eprintln!("kill history record error: {e}");
                }
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("kill history poll error: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct TrackedEntityEvent {
    tracked_entity_name: String,
    tracked_entity_kind: crate::tracked_entities::TrackedEntityKind,
    /// The actual character on the killmail - the tracked entity itself for
    /// a character track, or whichever member of the tracked corp/alliance
    /// was actually involved for a corp/alliance track.
    subject_character_name: Option<String>,
    event: &'static str,
    other_name: Option<String>,
    ship_type_name: String,
    system_name: String,
    total_value: f64,
    killmail_id: i64,
}

/// Checks every kill in this poll tick against the user's tracked-entity
/// list (characters, corporations, and alliances) and emits one event per
/// match - the live killmail stream this recorder already consumes for
/// every kill in New Eden is the only place that can answer "was a tracked
/// entity involved" without a separate, redundant poll of the same
/// firehose. Emits straight to the frontend (bell + toast + native
/// notification, all frontend-side) rather than persisting anything
/// server-side - this is a live alert, not history.
fn emit_tracked_player_events(app: &tauri::AppHandle, kills: &[KillEntry]) {
    use crate::tracked_entities::TrackedEntityKind;

    let tracked = crate::tracked_entities::load_tracked_entities(app);
    if tracked.entities.is_empty() {
        return;
    }
    for kill in kills {
        for entity in &tracked.entities {
            let is_victim = match entity.kind {
                TrackedEntityKind::Character => kill.victim_character_id == Some(entity.entity_id),
                TrackedEntityKind::Corporation => kill.victim_corporation_id == Some(entity.entity_id),
                TrackedEntityKind::Alliance => kill.victim_alliance_id == Some(entity.entity_id),
            };
            let attacker = kill.attackers.iter().find(|a| match entity.kind {
                TrackedEntityKind::Character => a.character_id == Some(entity.entity_id),
                TrackedEntityKind::Corporation => a.corporation_id == Some(entity.entity_id),
                TrackedEntityKind::Alliance => a.alliance_id == Some(entity.entity_id),
            });
            if !is_victim && attacker.is_none() {
                continue;
            }
            let event = if is_victim {
                TrackedEntityEvent {
                    tracked_entity_name: entity.entity_name.clone(),
                    tracked_entity_kind: entity.kind,
                    subject_character_name: kill.victim_character_name.clone(),
                    event: "died",
                    other_name: kill.final_blow_character_name.clone(),
                    ship_type_name: kill.ship_type_name.clone(),
                    system_name: kill.system_name.clone(),
                    total_value: kill.total_value,
                    killmail_id: kill.killmail_id,
                }
            } else {
                let attacker = attacker.expect("attacker is Some in this branch");
                TrackedEntityEvent {
                    tracked_entity_name: entity.entity_name.clone(),
                    tracked_entity_kind: entity.kind,
                    subject_character_name: attacker.character_name.clone(),
                    event: "killed",
                    other_name: kill.victim_character_name.clone(),
                    ship_type_name: attacker.ship_type_name.clone().unwrap_or_default(),
                    system_name: kill.system_name.clone(),
                    total_value: kill.total_value,
                    killmail_id: kill.killmail_id,
                }
            };
            let _ = app.emit("tracked-player-event", event);
        }
    }
}

fn row_to_kill_entry(row: &rusqlite::Row) -> rusqlite::Result<KillEntry> {
    Ok(KillEntry {
        killmail_id: row.get("killmail_id")?,
        time: row.get("killmail_time")?,
        system_id: row.get("solar_system_id")?,
        system_name: row.get("system_name")?,
        system_security: row.get("security_status")?,
        region_name: row.get("region_name")?,
        location_id: row.get("location_id")?,
        position: match (row.get::<_, Option<f64>>("pos_x")?, row.get::<_, Option<f64>>("pos_y")?, row.get::<_, Option<f64>>("pos_z")?) {
            (Some(x), Some(y), Some(z)) => Some((x, y, z)),
            _ => None,
        },
        victim_character_id: row.get("victim_character_id")?,
        victim_character_name: row.get("victim_character_name")?,
        victim_corporation_id: row.get("victim_corporation_id")?,
        victim_corporation_name: row.get("victim_corporation_name")?,
        victim_alliance_id: row.get("victim_alliance_id")?,
        victim_alliance_name: row.get("victim_alliance_name")?,
        victim_faction_id: row.get("victim_faction_id")?,
        victim_faction_name: row.get("victim_faction_name")?,
        ship_type_id: row.get("ship_type_id")?,
        ship_type_name: row.get("ship_type_name")?,
        total_value: row.get("total_value")?,
        npc: row.get::<_, i64>("npc")? != 0,
        solo: row.get::<_, i64>("solo")? != 0,
        awox: row.get::<_, i64>("awox")? != 0,
        war_id: row.get("war_id")?,
        attacker_count: row.get::<_, i64>("attacker_count")? as usize,
        final_blow_character_id: row.get("final_blow_character_id")?,
        final_blow_character_name: row.get("final_blow_character_name")?,
        final_blow_corporation_id: row.get("final_blow_corporation_id")?,
        final_blow_corporation_name: row.get("final_blow_corporation_name")?,
        final_blow_alliance_id: row.get("final_blow_alliance_id")?,
        final_blow_alliance_name: row.get("final_blow_alliance_name")?,
        zkb_provided: true,
        attackers: Vec::new(),
        items: Vec::new(),
    })
}

const KILL_REPORT_LIMIT: i64 = 100;

/// The zKillboard-style "Kill Reports" filters this mirrors - verified
/// feasible (or not) against their own source before building:
///   top_kills / big_kills - plain ISK thresholds, already have the value.
///   capitals / structures - ship group/category, resolved locally.
///   abyssal / abyssal_pvp - region-id band (+ not-NPC for the PvP variant).
///   awox / solo - already flagged per-kill by zKillboard's own feed.
///   ganked - the one category needing this whole local history store,
///     since it's a retroactive cross-kill correlation, not a per-kill flag.
pub async fn query_kill_reports(app: tauri::AppHandle, category: String) -> Result<Vec<KillEntry>, String> {
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<KillEntry>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let capital_placeholders = vec!["?"; CAPITAL_GROUPS.len()].join(",");
        let where_clause = match category.as_str() {
            "top_kills" => "total_value >= 5000000000".to_string(),
            "big_kills" => "total_value >= 10000000000".to_string(),
            "capitals" => format!("ship_group_id IN ({capital_placeholders})"),
            "structures" => format!("ship_category_id = {STRUCTURE_CATEGORY_ID}"),
            "abyssal" => format!("region_id >= {ABYSSAL_REGION_MIN} AND region_id < {ABYSSAL_REGION_MAX}"),
            "abyssal_pvp" => format!("region_id >= {ABYSSAL_REGION_MIN} AND region_id < {ABYSSAL_REGION_MAX} AND npc = 0"),
            "awox" => "awox = 1".to_string(),
            "solo" => "solo = 1".to_string(),
            "ganked" => "ganked = 1".to_string(),
            other => return Err(format!("unknown kill report category: {other}")),
        };

        let sql = format!("SELECT * FROM kill_history WHERE {where_clause} ORDER BY killmail_time DESC LIMIT {KILL_REPORT_LIMIT}");
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to query kill reports: {e}"))?;
        let rows = if category == "capitals" {
            stmt.query_map(rusqlite::params_from_iter(CAPITAL_GROUPS.iter()), row_to_kill_entry)
        } else {
            stmt.query_map([], row_to_kill_entry)
        }
        .map_err(|e| format!("failed to query kill reports: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read kill report row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("kill report query task failed: {e}"))?
}

/// Cap on how many locally-recorded kills get merged into a system's
/// killboard page 1 - generous enough to cover a genuinely busy system's
/// last few hours without turning "recent" into "the whole day".
const SYSTEM_KILLS_LOCAL_LIMIT: i64 = 100;

/// One system's recent kills straight from the local store - always as
/// fresh as the live killmail.stream connection every other live feature
/// already trusts, unlike a fresh REST call to zKillboard's own systemID
/// endpoint (kills::fetch_system_kills_history), which carries their
/// documented up-to-an-hour CDN cache and, confirmed live, can run
/// considerably staler than that for a system that isn't queried often.
/// Merged into page 1 of the killboard rather than replacing it outright -
/// see commands::get_system_kills_history - since this store only goes
/// back as far as this session's recorder has been running (plus whatever
/// the optional 30-day backfill covered), while REST still has the deeper
/// history a system's full killboard page implies.
pub async fn get_system_kills_local(app: &tauri::AppHandle, system_id: i64) -> Result<Vec<KillEntry>, String> {
    let path = db_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<KillEntry>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let mut stmt = conn
            .prepare("SELECT * FROM kill_history WHERE solar_system_id = ?1 ORDER BY killmail_time DESC LIMIT ?2")
            .map_err(|e| format!("failed to prepare system kills query: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![system_id, SYSTEM_KILLS_LOCAL_LIMIT], row_to_kill_entry)
            .map_err(|e| format!("failed to query system kills: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read system kills row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("system kills query task failed: {e}"))?
}

/// Same shape as get_system_kills_local, scoped to one specific gate
/// (location_id) instead of a whole system - backs the in-app Gate
/// Killboard page, merged with a live zKillboard REST call the same way
/// get_system_kills_history's page 1 already is (see commands::
/// get_location_kills) - confirmed live this was still needed: the Gate
/// Killboard was still reading straight off zKillboard's REST endpoint
/// with no local-store merge at all, showing a last-kill time visibly
/// behind what was actually happening at the gate.
pub async fn get_gate_kills_local(app: &tauri::AppHandle, location_id: i64) -> Result<Vec<KillEntry>, String> {
    let path = db_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<KillEntry>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let mut stmt = conn
            .prepare("SELECT * FROM kill_history WHERE location_id = ?1 ORDER BY killmail_time DESC LIMIT ?2")
            .map_err(|e| format!("failed to prepare gate kills query: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![location_id, SYSTEM_KILLS_LOCAL_LIMIT], row_to_kill_entry)
            .map_err(|e| format!("failed to query gate kills: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("failed to read gate kills row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("gate kills query task failed: {e}"))?
}

/// How far back the gate-camp checker's own local read looks - deliberately
/// shorter than RETENTION_DAYS' general 30-day window, since a camp that
/// happened hours ago says nothing useful about a route check right now.
/// Matches gatecamp.space's own stated retention (their FAQ: "kills older
/// than 6 hours are dropped from the store") - the frontend narrows this
/// further for display (see route.rs's get_gate_activity doc comment), same
/// contract as before this switched away from a live per-check zKillboard
/// REST call.
const GATE_ACTIVITY_WINDOW_MINUTES: i64 = 360;

/// Gate-camp kill data straight from this local, continuously-updated store
/// instead of a live zKillboard REST call per system on the route - that
/// REST endpoint (kills::fetch_raw_gate_kills) carries zKillboard's own
/// documented up-to-an-hour CDN cache, exactly the staleness a route check
/// exists to warn against. This store is fed by the same always-running
/// live killmail.stream connection every other live feature already
/// trusts (run_kill_history_recorder), so a check here reflects whatever's
/// actually been recorded so far - honest and immediate, same "fills in
/// over time" caveat as Top Stats above if the app hasn't been open long.
pub async fn get_gate_kills_for_systems(app: &tauri::AppHandle, system_ids: &[i64]) -> Result<Vec<(i64, kills::RawGateKill)>, String> {
    if system_ids.is_empty() {
        return Ok(Vec::new());
    }
    let path = db_path(app)?;
    let system_ids = system_ids.to_vec();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(i64, kills::RawGateKill)>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let cutoff = (Utc::now() - Duration::minutes(GATE_ACTIVITY_WINDOW_MINUTES)).to_rfc3339();
        let placeholders = vec!["?"; system_ids.len()].join(",");
        let sql = format!(
            "SELECT killmail_id, killmail_time, solar_system_id, pos_x, pos_y, pos_z, ship_type_id FROM kill_history
             WHERE solar_system_id IN ({placeholders}) AND datetime(killmail_time) >= datetime(?)
             ORDER BY killmail_time DESC"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = system_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        params.push(&cutoff);

        struct GateKillRow {
            killmail_id: i64,
            time: String,
            system_id: i64,
            position: Option<(f64, f64, f64)>,
            victim_ship_type_id: i64,
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to prepare gate kills query: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let (x, y, z): (Option<f64>, Option<f64>, Option<f64>) = (row.get(3)?, row.get(4)?, row.get(5)?);
                Ok(GateKillRow {
                    killmail_id: row.get(0)?,
                    time: row.get(1)?,
                    system_id: row.get(2)?,
                    position: match (x, y, z) {
                        (Some(x), Some(y), Some(z)) => Some((x, y, z)),
                        _ => None,
                    },
                    victim_ship_type_id: row.get(6)?,
                })
            })
            .map_err(|e| format!("failed to query gate kills: {e}"))?;

        let mut kill_rows = Vec::new();
        for row in rows {
            kill_rows.push(row.map_err(|e| format!("failed to read gate kill row: {e}"))?);
        }

        let mut attacker_stmt = conn
            .prepare("SELECT ship_type_id, weapon_type_id FROM kill_history_attackers WHERE killmail_id = ?1")
            .map_err(|e| format!("failed to prepare gate kill attacker query: {e}"))?;

        let mut results = Vec::with_capacity(kill_rows.len());
        for row in kill_rows {
            let attacker_rows = attacker_stmt
                .query_map([row.killmail_id], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)))
                .map_err(|e| format!("failed to query attackers for killmail {}: {e}", row.killmail_id))?;

            let mut attacker_ship_type_ids = Vec::new();
            let mut attacker_weapon_type_ids = Vec::new();
            for attacker in attacker_rows {
                let (ship_type_id, weapon_type_id) = attacker.map_err(|e| format!("failed to read gate kill attacker row: {e}"))?;
                if let Some(id) = ship_type_id {
                    attacker_ship_type_ids.push(id);
                }
                if let Some(id) = weapon_type_id {
                    attacker_weapon_type_ids.push(id);
                }
            }

            results.push((
                row.system_id,
                kills::RawGateKill {
                    killmail_id: row.killmail_id,
                    time: row.time,
                    position: row.position,
                    attacker_ship_type_ids,
                    attacker_weapon_type_ids,
                    victim_ship_type_id: row.victim_ship_type_id,
                },
            ));
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("gate kills query task failed: {e}"))?
}

/// EVE's "Capsule" ship group id - verified live via ESI
/// (/universe/groups/29/ -> {"name":"Capsule","types":[670,33328]}), not
/// guessed. Reused here (rather than kills::ROOKIE_SHUTTLE_CAPSULE_GROUPS,
/// which bundles Capsule with Shuttle/Rookie ship for a different purpose)
/// since the pod count on this board specifically means "how many capsules"
/// - matching eve-gatecheck.space's own "(N pods)" annotation - not
/// "how many throwaway hulls of any kind".
const CAPSULE_GROUP_ID: i64 = 29;

/// How far back the Likely Gate Camps board looks - matches its own "Kills
/// (1h)" column and GateCheck's RECENT_WINDOW_MS, so a gate that's gone
/// quiet for the last hour drops off the board on its own.
const LIKELY_CAMPS_WINDOW_MINUTES: i64 = 60;
/// Caps the board at the busiest gates - a genuinely quiet night might have
/// only a handful of entries, a busy one could have hundreds of distinct
/// gates with at least one kill; this keeps the ESI resolution pass below
/// bounded regardless.
const LIKELY_CAMPS_LIMIT: i64 = 50;

#[derive(Serialize, Clone)]
pub struct LikelyGateCamp {
    pub origin_system_id: i64,
    pub origin_system_name: String,
    pub origin_security: f64,
    pub gate_location_id: i64,
    /// ESI always names a stargate after its destination system, so this
    /// doubles as "which system does this gate lead to" - no separate
    /// destination-name field needed.
    pub gate_name: String,
    pub destination_system_id: Option<i64>,
    pub destination_security: Option<f64>,
    pub kills_last_hour: i64,
    pub pods_last_hour: i64,
    pub last_kill_time: String,
}

struct RawLikelyCampKill {
    solar_system_id: i64,
    system_name: String,
    security_status: f64,
    position: (f64, f64, f64),
    ship_group_id: i64,
    killmail_time: String,
}

struct LikelyCampAgg {
    origin_system_id: i64,
    origin_system_name: String,
    origin_security: f64,
    gate_name: String,
    destination_system_id: i64,
    kills: i64,
    pods: i64,
    last_kill_time: String,
}

/// New Eden-wide "what's likely camped right now" board, matching
/// eve-gatecheck.space's own /eve/spooky.php page - every stargate with at
/// least one recorded kill in the last hour, ranked by kill count. Only
/// possible because of the local kill-history store this session added:
/// zKillboard's REST API has no "every kill in New Eden, right now"
/// modifier at all, so a live per-system scan the way GateCheck's route
/// check works would mean querying every system in the game - the local
/// store (fed continuously by the same live killmail.stream connection
/// every other live feature trusts) turns this into one aggregate query
/// instead.
///
/// Attribution uses the exact same method as GateCheck (route::
/// nearest_gate_name: each kill's own victim position matched against its
/// system's real stargate coordinates, within GATE_PROXIMITY_METERS) -
/// this used to group by zKillboard's own location_id instead, which
/// disagreed with GateCheck often enough to be confusing (two different
/// methods answering "is this at a gate" will naturally give two different
/// answers). Sharing one method means the two screens now agree on the
/// same kill by construction.
pub async fn get_likely_gate_camps(app: tauri::AppHandle, client: reqwest::Client) -> Result<Vec<LikelyGateCamp>, String> {
    let path = db_path(&app)?;
    let rows: Vec<RawLikelyCampKill> = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<RawLikelyCampKill>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let mut stmt = conn
            .prepare(
                "SELECT solar_system_id, system_name, security_status, pos_x, pos_y, pos_z, ship_group_id, killmail_time
                 FROM kill_history
                 WHERE datetime(killmail_time) >= datetime('now', ?1)
                   AND pos_x IS NOT NULL AND pos_y IS NOT NULL AND pos_z IS NOT NULL",
            )
            .map_err(|e| format!("failed to prepare likely-camps query: {e}"))?;
        let window = format!("-{LIKELY_CAMPS_WINDOW_MINUTES} minutes");
        let mapped = stmt
            .query_map(rusqlite::params![window], |row| {
                let (x, y, z): (f64, f64, f64) = (row.get(3)?, row.get(4)?, row.get(5)?);
                Ok(RawLikelyCampKill {
                    solar_system_id: row.get(0)?,
                    system_name: row.get(1)?,
                    security_status: row.get(2)?,
                    position: (x, y, z),
                    ship_group_id: row.get(6)?,
                    killmail_time: row.get(7)?,
                })
            })
            .map_err(|e| format!("failed to query likely camps: {e}"))?;

        let mut results = Vec::new();
        for row in mapped {
            results.push(row.map_err(|e| format!("failed to read likely-camps row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("likely-camps query task failed: {e}"))??;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // Every distinct system's gates, fetched once each (cached forever
    // after the first time - see route::fetch_system_gates), so a busy
    // hour spread across many systems doesn't repeat the same ESI lookups
    // on every 60-second refresh.
    let mut system_ids: Vec<i64> = rows.iter().map(|r| r.solar_system_id).collect();
    system_ids.sort_unstable();
    system_ids.dedup();
    let gates_by_system: HashMap<i64, Vec<crate::route::GateInfo>> = HashMap::from_iter(
        futures::future::join_all(system_ids.iter().map(|&id| {
            let client = client.clone();
            async move { (id, crate::route::fetch_system_gates(&client, id).await) }
        }))
        .await,
    );

    // Resolve each kill to its nearest gate (within 100km) and aggregate by
    // the gate's own ESI stargate id - a kill that isn't within range of
    // any gate in its system simply isn't a gate-camp kill and is dropped,
    // the same as GateCheck's own attribution.
    let mut by_gate: HashMap<i64, LikelyCampAgg> = HashMap::new();
    for row in &rows {
        let gates = gates_by_system.get(&row.solar_system_id).map(Vec::as_slice).unwrap_or(&[]);
        let Some(gate) = crate::route::nearest_gate_name(row.position, gates) else { continue };
        let entry = by_gate.entry(gate.id).or_insert_with(|| LikelyCampAgg {
            origin_system_id: row.solar_system_id,
            origin_system_name: row.system_name.clone(),
            origin_security: row.security_status,
            gate_name: gate.name.clone(),
            destination_system_id: gate.destination_system_id,
            kills: 0,
            pods: 0,
            last_kill_time: row.killmail_time.clone(),
        });
        entry.kills += 1;
        if row.ship_group_id == CAPSULE_GROUP_ID {
            entry.pods += 1;
        }
        // ISO 8601 timestamps sort lexicographically the same as
        // chronologically, so a plain string comparison is a valid max().
        if row.killmail_time > entry.last_kill_time {
            entry.last_kill_time = row.killmail_time.clone();
        }
    }

    let mut aggregated: Vec<(i64, LikelyCampAgg)> = by_gate.into_iter().collect();
    aggregated.sort_by(|a, b| b.1.kills.cmp(&a.1.kills));
    aggregated.truncate(LIKELY_CAMPS_LIMIT as usize);

    // Destination security is the one remaining per-row ESI lookup -
    // bounded to at most LIKELY_CAMPS_LIMIT calls since it only runs on the
    // final, already-ranked gates, never on every raw kill.
    let resolved = futures::future::join_all(aggregated.into_iter().map(|(gate_id, agg)| {
        let client = client.clone();
        async move {
            let destination = kills::fetch_system_info(&client, agg.destination_system_id).await;
            LikelyGateCamp {
                origin_system_id: agg.origin_system_id,
                origin_system_name: agg.origin_system_name,
                origin_security: agg.origin_security,
                gate_location_id: gate_id,
                gate_name: agg.gate_name,
                destination_system_id: Some(agg.destination_system_id),
                destination_security: destination.map(|i| i.security_status),
                kills_last_hour: agg.kills,
                pods_last_hour: agg.pods,
                last_kill_time: agg.last_kill_time,
            }
        }
    }))
    .await;

    Ok(resolved)
}

const SYSTEM_HEAT_WINDOW_MINUTES: i64 = 60;

#[derive(Serialize, Clone)]
pub struct SystemKillHeat {
    pub system_id: i64,
    pub system_name: String,
    pub region_name: String,
    pub kill_count: i64,
    pub last_kill_time: String,
}

/// Real per-system kill counts for the rolling last hour, straight from the
/// local store with no size cap. The Map's heat glow, hover-tooltip kill
/// count, and Top Active panel used to be computed client-side from the
/// same feed the kill ticker uses (mergeKillFeeds' MAX_LIVE_KILLS caps that
/// at 150 kills New Eden-wide) - fine for a scrolling ticker, but it means
/// any hour with more than 150 kills anywhere in the game silently starves
/// busy systems of their true count well before HEAT_WINDOW_MS's 60-minute
/// cutoff would naturally age them out. That's the same class of bug the
/// gate-camp board and route check already had fixed this session (a
/// size-capped feed standing in for "everything that happened, un-capped"),
/// fixed here the same way get_likely_gate_camps fixes it: query the whole
/// local table directly instead of trusting how much of it survived a
/// shared global cap.
pub async fn get_system_kill_heat(app: tauri::AppHandle) -> Result<Vec<SystemKillHeat>, String> {
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SystemKillHeat>, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT solar_system_id, system_name, region_name,
                        COUNT(*) as kill_count, MAX(killmail_time) as last_kill_time
                 FROM kill_history
                 WHERE datetime(killmail_time) >= datetime('now', ?1)
                 GROUP BY solar_system_id",
            )
            .map_err(|e| format!("failed to prepare system-heat query: {e}"))?;
        let window = format!("-{SYSTEM_HEAT_WINDOW_MINUTES} minutes");
        let mapped = stmt
            .query_map(rusqlite::params![window], |row| {
                Ok(SystemKillHeat {
                    system_id: row.get(0)?,
                    system_name: row.get(1)?,
                    region_name: row.get(2)?,
                    kill_count: row.get(3)?,
                    last_kill_time: row.get(4)?,
                })
            })
            .map_err(|e| format!("failed to query system heat: {e}"))?;

        let mut results = Vec::new();
        for row in mapped {
            results.push(row.map_err(|e| format!("failed to read system-heat row: {e}"))?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("system-heat query task failed: {e}"))?
}

#[derive(Serialize, Clone, Default)]
pub struct RankingEntry {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

#[derive(Serialize, Default)]
pub struct TopStatsResult {
    pub total_kills: i64,
    pub killer_characters: Vec<RankingEntry>,
    pub killer_corporations: Vec<RankingEntry>,
    pub killer_alliances: Vec<RankingEntry>,
    pub killer_factions: Vec<RankingEntry>,
    pub killer_ships: Vec<RankingEntry>,
    pub killer_groups: Vec<RankingEntry>,
    pub loser_characters: Vec<RankingEntry>,
    pub loser_corporations: Vec<RankingEntry>,
    pub loser_alliances: Vec<RankingEntry>,
    pub loser_factions: Vec<RankingEntry>,
    pub loser_ships: Vec<RankingEntry>,
    pub loser_groups: Vec<RankingEntry>,
    pub top_systems: Vec<RankingEntry>,
    pub top_regions: Vec<RankingEntry>,
}

const TOP_STATS_RANK_LIMIT: i64 = 10;

fn rank_query(
    conn: &rusqlite::Connection,
    table: &str,
    id_col: &str,
    name_col: &str,
    time_col: &str,
    cutoff: &str,
    extra_where: &str,
) -> Result<Vec<RankingEntry>, String> {
    let sql = format!(
        "SELECT {id_col}, {name_col}, COUNT(*) AS c FROM {table} \
         WHERE datetime({time_col}) >= datetime(?1) AND {id_col} IS NOT NULL {extra_where} \
         GROUP BY {id_col} ORDER BY c DESC LIMIT {TOP_STATS_RANK_LIMIT}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("failed to prepare ranking query ({table}.{id_col}): {e}"))?;
    let rows = stmt
        .query_map([cutoff], |row| {
            Ok(RankingEntry { id: row.get(0)?, name: row.get::<_, Option<String>>(1)?.unwrap_or_default(), count: row.get(2)? })
        })
        .map_err(|e| format!("failed to run ranking query ({table}.{id_col}): {e}"))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("failed to read ranking row ({table}.{id_col}): {e}"))?);
    }
    Ok(results)
}

/// Top characters/corporations/alliances/factions/ships/groups on both the
/// killing and losing side, plus top systems/regions, over a rolling
/// window - VESPER's equivalent of zKillboard's "Top Killers in the Last
/// Hour" page. Accuracy improves the longer the app has been running: it
/// only reflects kills seen since this session's history recorder started
/// (plus whatever backlog its fixed queue caught up on), same "fills in
/// over time" honesty as the map's jump-history graph.
pub async fn get_top_stats(app: tauri::AppHandle, window_minutes: i64) -> Result<TopStatsResult, String> {
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<TopStatsResult, String> {
        let conn = open_db(&path)?;
        ensure_schema(&conn)?;

        let cutoff = (Utc::now() - Duration::minutes(window_minutes)).to_rfc3339();
        let total_kills: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kill_history WHERE datetime(killmail_time) >= datetime(?1)",
                [&cutoff],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(TopStatsResult {
            total_kills,
            killer_characters: rank_query(&conn, "kill_history_attackers", "character_id", "character_name", "killmail_time", &cutoff, "")?,
            killer_corporations: rank_query(&conn, "kill_history_attackers", "corporation_id", "corporation_name", "killmail_time", &cutoff, "")?,
            killer_alliances: rank_query(&conn, "kill_history_attackers", "alliance_id", "alliance_name", "killmail_time", &cutoff, "")?,
            killer_factions: rank_query(&conn, "kill_history_attackers", "faction_id", "faction_name", "killmail_time", &cutoff, "")?,
            killer_ships: rank_query(&conn, "kill_history_attackers", "ship_type_id", "ship_type_name", "killmail_time", &cutoff, "")?,
            killer_groups: rank_query(&conn, "kill_history_attackers", "ship_group_id", "ship_group_name", "killmail_time", &cutoff, "AND ship_group_id != 0")?,
            loser_characters: rank_query(&conn, "kill_history", "victim_character_id", "victim_character_name", "killmail_time", &cutoff, "")?,
            loser_corporations: rank_query(&conn, "kill_history", "victim_corporation_id", "victim_corporation_name", "killmail_time", &cutoff, "")?,
            loser_alliances: rank_query(&conn, "kill_history", "victim_alliance_id", "victim_alliance_name", "killmail_time", &cutoff, "")?,
            loser_factions: rank_query(&conn, "kill_history", "victim_faction_id", "victim_faction_name", "killmail_time", &cutoff, "")?,
            loser_ships: rank_query(&conn, "kill_history", "ship_type_id", "ship_type_name", "killmail_time", &cutoff, "")?,
            loser_groups: rank_query(&conn, "kill_history", "ship_group_id", "ship_group_name", "killmail_time", &cutoff, "AND ship_group_id != 0")?,
            top_systems: rank_query(&conn, "kill_history", "solar_system_id", "system_name", "killmail_time", &cutoff, "")?,
            top_regions: rank_query(&conn, "kill_history", "region_id", "region_name", "killmail_time", &cutoff, "AND region_id != 0")?,
        })
    })
    .await
    .map_err(|e| format!("top stats query task failed: {e}"))?
}

/// zKillboard publishes a full daily bulk dump of every killmail it's ever
/// seen (verified live - the r2z2.zkillboard.com/history/raw/ endpoint,
/// documented on their own wiki) - the real "all of zKillboard's history"
/// mechanism. The complete archive goes back to December 2007 and totals
/// roughly 95 million killmails (~150-200GB raw, ~15-25GB once stored
/// locally) - far more than a one-time desktop backfill should attempt by
/// default. This only ever pulls a bounded, recent window.
const HISTORY_RAW_URL_BASE: &str = "https://r2z2.zkillboard.com/history/raw";
/// The 30 most recent COMPLETE days - starts at yesterday, not today (see
/// run_startup_backfill's own doc comment for why: zKillboard only
/// publishes a day's bulk dump once that day is actually over, so
/// including today would just be a guaranteed 404 every run).
const BACKFILL_DAYS: i64 = 30;
/// Kept well under ESI's 1000-id-per-name-lookup cap even after a whole
/// day's worth of attacker/victim/ship ids collapse into unique ids -
/// bounds memory and keeps each round of enrichment+recording a
/// manageable chunk rather than one giant multi-thousand-kill batch.
const BACKFILL_CHUNK_SIZE: usize = 500;

#[derive(Serialize, Clone, Default)]
pub struct BackfillProgress {
    pub running: bool,
    pub days_total: i64,
    pub days_done: i64,
    pub kills_recorded: i64,
    pub current_date: String,
    pub error: Option<String>,
    pub done: bool,
}

static BACKFILL_PROGRESS: LazyLock<Mutex<Option<BackfillProgress>>> = LazyLock::new(|| Mutex::new(None));

/// Current backfill status, for the frontend to poll while it runs - None
/// if a backfill has never been started this session.
pub fn get_backfill_progress() -> Option<BackfillProgress> {
    BACKFILL_PROGRESS.lock().unwrap().clone()
}

fn is_backfill_running() -> bool {
    BACKFILL_PROGRESS.lock().unwrap().as_ref().map(|p| p.running).unwrap_or(false)
}

/// One-time backfill of the last BACKFILL_DAYS days from zKillboard's bulk
/// history dumps, so Kill Reports/Top Stats have a rolling 30-day window
/// worth of data immediately instead of waiting a real month for the live
/// recorder to accumulate it. Runs in the background - poll
/// get_backfill_progress for status. A no-op if already running.
pub async fn start_backfill(app: tauri::AppHandle, client: reqwest::Client) {
    if is_backfill_running() {
        return;
    }
    *BACKFILL_PROGRESS.lock().unwrap() =
        Some(BackfillProgress { running: true, days_total: BACKFILL_DAYS, ..Default::default() });

    for day_offset in (1..=BACKFILL_DAYS).rev() {
        let date = (Utc::now() - Duration::days(day_offset)).format("%Y%m%d").to_string();
        if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
            p.current_date = date.clone();
        }

        match backfill_one_day(&app, &client, &date).await {
            Ok(_count) => {
                // kills_recorded is already updated live, per chunk, inside
                // backfill_one_day - not added again here - so the progress
                // bar moves during a slow day instead of only jumping once
                // the whole day (which can be many chunks) finishes.
                if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
                    p.days_done += 1;
                }
            }
            Err(e) => {
                eprintln!("kill history backfill error on {date}: {e}");
                if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
                    p.days_done += 1;
                    p.error = Some(format!("{date}: {e}"));
                }
            }
        }
    }

    if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
        p.running = false;
        p.done = true;
    }
}

async fn backfill_one_day(app: &tauri::AppHandle, client: &reqwest::Client, date: &str) -> Result<i64, String> {
    let url = format!("{HISTORY_RAW_URL_BASE}/{date}.json");
    let response = client.get(&url).send().await.map_err(|e| format!("history request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("history endpoint returned {status}"));
    }
    // Keyed by killmail_id string ("137849738": {...}), not a JSON array -
    // verified live against a real day's dump before writing this.
    let raw_map: HashMap<String, serde_json::Value> =
        response.json().await.map_err(|e| format!("failed to parse history response: {e}"))?;
    let values: Vec<serde_json::Value> = raw_map.into_values().collect();

    // Priming kills::fetch_system_info's cache from the local map database
    // up front means the enrichment below (which resolves every kill's
    // system security/region by system id) never falls through to ESI's
    // live system->constellation->region chain for this day's kills - a
    // single day of EVE-wide kills can span hundreds of distinct systems,
    // and doing that chain live, uncached, one system at a time, is what
    // was making the backfill look hung (confirmed live: several minutes
    // per day just resolving systems, not an actual stall).
    let mut day_system_ids: Vec<i64> = values.iter().filter_map(|v| v.get("solar_system_id").and_then(|s| s.as_i64())).collect();
    day_system_ids.sort_unstable();
    day_system_ids.dedup();
    if let Ok(name_info) = map::get_systems_name_info(app, client, day_system_ids).await {
        kills::prime_system_info_cache(
            name_info
                .into_iter()
                .map(|i| (i.system_id, kills::SystemInfo { security_status: i.security_status, region_name: i.region_name }))
                .collect(),
        );
    }

    let mut total = 0i64;
    for chunk in values.chunks(BACKFILL_CHUNK_SIZE) {
        let batch = kills::enrich_raw_killmail_batch(client, chunk.to_vec()).await;
        let batch_len = batch.len() as i64;
        record_kills(app, client, batch).await?;
        total += batch_len;
        if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
            p.kills_recorded += batch_len;
        }
    }
    Ok(total)
}

/// How many of the most recent COMPLETE days the automatic startup
/// backfill covers - 1 (yesterday's dump) plus the always-running live
/// recorder's own coverage of today (from launch onward) already
/// guarantees at least a full 24h of real coverage. Deliberately excludes
/// today (day_offset 0): zKillboard's bulk dump for a given date is only
/// published once that day has actually finished, so requesting today's
/// dump 404s unconditionally, every single launch, until day rollover -
/// confirmed live. A mid-day gap from being closed for part of today (as
/// opposed to yesterday or earlier) isn't something this bulk-dump
/// mechanism can close at all - there is no bulk dump for a day still in
/// progress - only a live per-system/gate REST re-check could, which is
/// exactly the staleness-prone path this session moved everything away
/// from.
const STARTUP_BACKFILL_DAYS: i64 = 1;

/// Runs once automatically on every launch (spawned from lib.rs's setup
/// hook, alongside run_kill_history_recorder, not after it) in two stages,
/// deliberately sequenced rather than run together: a fast pass over just
/// the last couple of days first, so the data a pilot actually acts on
/// right now (GateCheck, Tracked Systems) is trustworthy as early into the
/// launch as possible, THEN the full 30-day historical pass automatically
/// behind it, so deep history fills in too without ever requiring a manual
/// trigger - recent-correctness first, historical-completeness second, not
/// racing each other for the same network/database at once.
///
/// This closes a real trust gap, confirmed live: GateCheck and the Tracked
/// Systems killboard both silently read "no kills" for a system that
/// genuinely had recent kills on zKillboard, because the local store had
/// nothing recorded from before the app was last opened - for a feature a
/// pilot uses to decide whether a gate is safe to jump through, "quiet
/// because nothing happened" and "quiet because we haven't looked yet"
/// must never be indistinguishable. The always-running live recorder
/// (started in the same breath as this) already covers everything from
/// this moment forward; the two stages here cover everything before it.
///
/// Skips both stages if a backfill (this one from a previous launch that's
/// still running, or someone manually re-triggering start_backfill from
/// Settings) is already in progress, rather than running two bulk-history
/// passes over each other.
pub async fn run_startup_backfill(app: tauri::AppHandle, client: reqwest::Client) {
    if is_backfill_running() {
        return;
    }
    for day_offset in (1..=STARTUP_BACKFILL_DAYS).rev() {
        let date = (Utc::now() - Duration::days(day_offset)).format("%Y%m%d").to_string();
        if let Err(e) = backfill_one_day(&app, &client, &date).await {
            eprintln!("startup backfill error on {date}: {e}");
        }
    }
    start_backfill(app, client).await;
}
