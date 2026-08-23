use crate::kills::{self, KillEntry};
use crate::map;
use crate::market;
use crate::route::CAPITAL_GROUPS;
use chrono::{Duration, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::Manager;

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
            final_blow INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_kha_killmail ON kill_history_attackers(killmail_id);
        CREATE INDEX IF NOT EXISTS idx_kha_character_time ON kill_history_attackers(character_id, killmail_time);
        CREATE INDEX IF NOT EXISTS idx_kha_time ON kill_history_attackers(killmail_time);",
    )
    .map_err(|e| format!("failed to create kill history tables: {e}"))
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
        let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open kill history database: {e}"))?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;

        let mut concord_kill_ids = Vec::new();

        {
            let mut kill_stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO kill_history (
                        killmail_id, killmail_time, solar_system_id, system_name, region_id, region_name,
                        security_status, location_id, victim_character_id, victim_character_name,
                        victim_corporation_id, victim_corporation_name, victim_alliance_id, victim_alliance_name,
                        victim_faction_id, victim_faction_name, ship_type_id, ship_type_name, ship_group_id,
                        ship_group_name, ship_category_id, total_value, attacker_count, final_blow_character_id,
                        final_blow_character_name, final_blow_corporation_id, final_blow_corporation_name,
                        final_blow_alliance_id, final_blow_alliance_name, npc, solo, awox, ganked, war_id
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,0,?33)",
                )
                .map_err(|e| format!("failed to prepare kill_history insert: {e}"))?;
            let mut attacker_stmt = tx
                .prepare(
                    "INSERT INTO kill_history_attackers (
                        killmail_id, killmail_time, character_id, character_name, corporation_id, corporation_name,
                        alliance_id, alliance_name, faction_id, faction_name, ship_type_id, ship_type_name,
                        ship_group_id, ship_group_name, final_blow
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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
        let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open kill history database: {e}"))?;
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
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open kill history database: {e}"))?;
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

fn row_to_kill_entry(row: &rusqlite::Row) -> rusqlite::Result<KillEntry> {
    Ok(KillEntry {
        killmail_id: row.get("killmail_id")?,
        time: row.get("killmail_time")?,
        system_id: row.get("solar_system_id")?,
        system_name: row.get("system_name")?,
        system_security: row.get("security_status")?,
        region_name: row.get("region_name")?,
        location_id: row.get("location_id")?,
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
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open kill history database: {e}"))?;
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
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open kill history database: {e}"))?;
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

    for day_offset in (0..BACKFILL_DAYS).rev() {
        let date = (Utc::now() - Duration::days(day_offset)).format("%Y%m%d").to_string();
        if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
            p.current_date = date.clone();
        }

        match backfill_one_day(&app, &client, &date).await {
            Ok(count) => {
                if let Some(p) = BACKFILL_PROGRESS.lock().unwrap().as_mut() {
                    p.days_done += 1;
                    p.kills_recorded += count;
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

    let mut total = 0i64;
    for chunk in values.chunks(BACKFILL_CHUNK_SIZE) {
        let batch = kills::enrich_raw_killmail_batch(client, chunk.to_vec()).await;
        total += batch.len() as i64;
        record_kills(app, client, batch).await?;
    }
    Ok(total)
}
