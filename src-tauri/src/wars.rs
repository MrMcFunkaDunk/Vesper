use crate::esi;
use crate::kills::parse_iso_unix;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// ESI has no corp/alliance -> wars lookup at all (confirmed live) -
/// `/wars/` only returns descending war IDs with a `max_war_id` cursor, no
/// filter param, ~2000 ids per page. This bounds how many pages of that
/// list get walked back through during a sync. `get_wars_for_entity`
/// awaits the sync before reading, so this directly sets how long a
/// first-ever open of the Wars page blocks for - kept at 1 page (~2000
/// wars, roughly 30-45s at WAR_RESOLVE_CONCURRENCY) rather than the
/// smoother-in-theory 3 pages, which measured out to 1.5-2 minutes of dead
/// air with no progress indicator. Active wars are inherently recent in
/// practice (an old war that's still technically un-finished after being
/// buried under thousands of newer, finished ones is a real but rare edge
/// case this deliberately doesn't chase).
const WARS_SYNC_PAGES: usize = 1;
const WAR_RESOLVE_CONCURRENCY: usize = 15;
const WARS_RESYNC_INTERVAL_SECS: i64 = 24 * 3600;

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("could not resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data directory: {e}"))?;
    Ok(dir.join("wars.sqlite"))
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wars (
            id INTEGER PRIMARY KEY,
            aggressor_id INTEGER,
            aggressor_is_alliance INTEGER NOT NULL,
            defender_id INTEGER,
            defender_is_alliance INTEGER NOT NULL,
            allies_json TEXT NOT NULL,
            declared TEXT NOT NULL,
            started TEXT,
            retracted TEXT,
            finished TEXT,
            mutual INTEGER NOT NULL,
            open_for_allies INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wars_meta (synced_at INTEGER NOT NULL);",
    )
    .map_err(|e| format!("failed to create wars tables: {e}"))
}

#[derive(Deserialize)]
struct WarParticipant {
    #[serde(default)]
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
}

impl WarParticipant {
    /// A war participant is always either a corporation or an alliance,
    /// never both - collapse the two optional ESI fields into one id +
    /// which kind it is.
    fn resolve(&self) -> Option<(i64, bool)> {
        if let Some(id) = self.alliance_id {
            Some((id, true))
        } else {
            self.corporation_id.map(|id| (id, false))
        }
    }
}

#[derive(Deserialize)]
struct EsiWar {
    id: i64,
    aggressor: WarParticipant,
    defender: WarParticipant,
    #[serde(default)]
    allies: Vec<WarParticipant>,
    declared: String,
    #[serde(default)]
    started: Option<String>,
    #[serde(default)]
    retracted: Option<String>,
    #[serde(default)]
    finished: Option<String>,
    mutual: bool,
    open_for_allies: bool,
}

#[derive(Serialize, Clone, Deserialize)]
pub struct WarParty {
    pub id: i64,
    pub is_alliance: bool,
}

#[derive(Serialize, Clone)]
pub struct WarSummary {
    pub id: i64,
    pub aggressor: Option<WarParty>,
    pub defender: Option<WarParty>,
    pub allies: Vec<WarParty>,
    pub declared: String,
    pub started: Option<String>,
    pub retracted: Option<String>,
    pub finished: Option<String>,
    pub mutual: bool,
    pub open_for_allies: bool,
}

async fn fetch_war_ids_page(client: &reqwest::Client, max_war_id: Option<i64>) -> Result<Vec<i64>, String> {
    let path = match max_war_id {
        Some(id) => format!("/wars/?max_war_id={id}"),
        None => "/wars/".to_string(),
    };
    esi::public_get(client, &path).await
}

async fn fetch_war_detail(client: &reqwest::Client, war_id: i64) -> Option<EsiWar> {
    esi::public_get(client, &format!("/wars/{war_id}/")).await.ok()
}

/// Resyncs the local wars cache if it's empty or older than
/// WARS_RESYNC_INTERVAL_SECS - same "at most once a day, always read from
/// local cache" shape as map::sync_player_structures.
async fn sync_wars(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let path = db_path(app)?;

    let needs_sync = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open wars database: {e}"))?;
            ensure_schema(&conn)?;
            let synced_at: Option<i64> =
                conn.query_row("SELECT synced_at FROM wars_meta ORDER BY synced_at DESC LIMIT 1", [], |row| row.get(0)).ok();
            Ok(match synced_at {
                Some(t) => now_unix() - t > WARS_RESYNC_INTERVAL_SECS,
                None => true,
            })
        })
        .await
        .map_err(|e| format!("wars check task failed: {e}"))??
    };
    if !needs_sync {
        return Ok(());
    }

    let mut war_ids: Vec<i64> = Vec::new();
    let mut cursor: Option<i64> = None;
    for _ in 0..WARS_SYNC_PAGES {
        let page = match fetch_war_ids_page(client, cursor).await {
            Ok(page) => page,
            Err(_) => break,
        };
        let Some(oldest) = page.iter().min().copied() else { break };
        war_ids.extend(page);
        cursor = Some(oldest);
    }
    war_ids.sort_unstable();
    war_ids.dedup();

    let resolved: Vec<EsiWar> = stream::iter(war_ids)
        .map(|id| async move { fetch_war_detail(client, id).await })
        .buffer_unordered(WAR_RESOLVE_CONCURRENCY)
        .filter_map(|result| async move { result })
        .collect()
        .await;

    let synced_at = now_unix();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open wars database: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("sqlite transaction failed: {e}"))?;
        tx.execute_batch("DELETE FROM wars; DELETE FROM wars_meta;")
            .map_err(|e| format!("failed to clear wars: {e}"))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO wars (id, aggressor_id, aggressor_is_alliance, defender_id, defender_is_alliance, allies_json, declared, started, retracted, finished, mutual, open_for_allies)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                )
                .map_err(|e| format!("failed to prepare wars insert: {e}"))?;
            for war in &resolved {
                let (aggressor_id, aggressor_is_alliance) =
                    war.aggressor.resolve().map(|(id, a)| (Some(id), a)).unwrap_or((None, false));
                let (defender_id, defender_is_alliance) =
                    war.defender.resolve().map(|(id, a)| (Some(id), a)).unwrap_or((None, false));
                let allies: Vec<WarParty> =
                    war.allies.iter().filter_map(|a| a.resolve()).map(|(id, is_alliance)| WarParty { id, is_alliance }).collect();
                let allies_json = serde_json::to_string(&allies).unwrap_or_else(|_| "[]".to_string());
                let _ = stmt.execute(rusqlite::params![
                    war.id,
                    aggressor_id,
                    aggressor_is_alliance,
                    defender_id,
                    defender_is_alliance,
                    allies_json,
                    war.declared,
                    war.started,
                    war.retracted,
                    war.finished,
                    war.mutual,
                    war.open_for_allies,
                ]);
            }
        }
        tx.execute("INSERT INTO wars_meta (synced_at) VALUES (?1)", [synced_at])
            .map_err(|e| format!("failed to record wars sync time: {e}"))?;
        tx.commit().map_err(|e| format!("failed to commit wars: {e}"))
    })
    .await
    .map_err(|e| format!("wars import task failed: {e}"))?
}

fn row_to_war(row: &rusqlite::Row) -> rusqlite::Result<WarSummary> {
    let allies_json: String = row.get(5)?;
    let allies: Vec<WarParty> = serde_json::from_str(&allies_json).unwrap_or_default();
    let aggressor_id: Option<i64> = row.get(1)?;
    let aggressor_is_alliance: bool = row.get(2)?;
    let defender_id: Option<i64> = row.get(3)?;
    let defender_is_alliance: bool = row.get(4)?;
    Ok(WarSummary {
        id: row.get(0)?,
        aggressor: aggressor_id.map(|id| WarParty { id, is_alliance: aggressor_is_alliance }),
        defender: defender_id.map(|id| WarParty { id, is_alliance: defender_is_alliance }),
        allies,
        declared: row.get(6)?,
        started: row.get(7)?,
        retracted: row.get(8)?,
        finished: row.get(9)?,
        mutual: row.get(10)?,
        open_for_allies: row.get(11)?,
    })
}

/// Every currently-active war (no `finished` date, or one in the future)
/// touching the given corporation or alliance id, from the locally-synced
/// window - see WARS_SYNC_PAGES for the "recent, not exhaustive" caveat.
pub async fn get_wars_for_entity(app: tauri::AppHandle, client: &reqwest::Client, entity_id: i64) -> Result<Vec<WarSummary>, String> {
    sync_wars(&app, client).await?;
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<WarSummary>, String> {
        let conn = rusqlite::Connection::open(&path).map_err(|e| format!("failed to open wars database: {e}"))?;
        let like_pattern = format!("%\"id\":{entity_id},%");
        let mut stmt = conn
            .prepare(
                "SELECT id, aggressor_id, aggressor_is_alliance, defender_id, defender_is_alliance, allies_json, declared, started, retracted, finished, mutual, open_for_allies
                 FROM wars
                 WHERE aggressor_id = ?1 OR defender_id = ?1 OR allies_json LIKE ?2
                 ORDER BY declared DESC",
            )
            .map_err(|e| format!("failed to query wars: {e}"))?;
        let rows = stmt.query_map(rusqlite::params![entity_id, like_pattern], row_to_war).map_err(|e| format!("failed to read wars: {e}"))?;
        let now = now_unix();
        let mut results = Vec::new();
        for war in rows.flatten() {
            let is_active = match &war.finished {
                None => true,
                Some(f) => parse_iso_unix(f).map(|t| t > now).unwrap_or(true),
            };
            if is_active {
                results.push(war);
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("wars read task failed: {e}"))?
}

/// A single war's full record, live from ESI (not the local cache) so a
/// direct link to a specific war always resolves even if it fell outside
/// the synced recent-window.
pub async fn get_war_detail(client: &reqwest::Client, war_id: i64) -> Result<WarSummary, String> {
    let war = fetch_war_detail(client, war_id).await.ok_or_else(|| format!("war {war_id} not found"))?;
    let aggressor = war.aggressor.resolve().map(|(id, is_alliance)| WarParty { id, is_alliance });
    let defender = war.defender.resolve().map(|(id, is_alliance)| WarParty { id, is_alliance });
    let allies = war.allies.iter().filter_map(|a| a.resolve()).map(|(id, is_alliance)| WarParty { id, is_alliance }).collect();
    Ok(WarSummary {
        id: war.id,
        aggressor,
        defender,
        allies,
        declared: war.declared,
        started: war.started,
        retracted: war.retracted,
        finished: war.finished,
        mutual: war.mutual,
        open_for_allies: war.open_for_allies,
    })
}
