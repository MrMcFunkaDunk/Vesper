import { useState, type FormEvent } from "react";
import { Plus, X, RefreshCw } from "lucide-react";
import { searchSystem, getRecentKills, type KillEntry } from "../lib/kills";
import { useWatchedSystems } from "../hooks/useWatchedSystems";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk, formatRelativeTime } from "../lib/format";

function KillsIntel() {
  const { systems, addSystem, removeSystem } = useWatchedSystems();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const reportError = useErrorReporter();

  async function handleAddSystem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = query.trim();
    if (!name) return;
    setSearching(true);
    try {
      const match = await searchSystem(name);
      if (!match) {
        reportError(`No solar system found named "${name}". This needs an exact match - check the spelling.`);
        return;
      }
      addSystem(match);
      setQuery("");
    } catch (err) {
      reportError(`System lookup failed: ${String(err)}`);
    } finally {
      setSearching(false);
    }
  }

  async function handleSync() {
    if (systems.length === 0) return;
    setSyncing(true);
    try {
      const results = await getRecentKills(systems.map((s) => s.id));
      setKills(results);
      setHasSynced(true);
    } catch (err) {
      reportError(`Failed to load kills: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header">
          <p className="eyebrow">Kills & Intel</p>
          <h2>Recent Activity</h2>
        </div>

        <div className="kills-watchlist">
          <form className="kills-add-form" onSubmit={handleAddSystem}>
            <input
              type="text"
              placeholder="Add a system to watch (exact name, e.g. Jita)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={searching}
            />
            <button type="submit" disabled={searching || !query.trim()}>
              <Plus size={14} strokeWidth={2} />
              {searching ? "Searching..." : "Add"}
            </button>
          </form>

          <div className="kills-watched-chips">
            {systems.length === 0 ? (
              <span className="kills-watched-empty">No systems watched yet.</span>
            ) : (
              systems.map((system) => (
                <span key={system.id} className="kills-watched-chip">
                  {system.name}
                  <button
                    type="button"
                    onClick={() => removeSystem(system.id)}
                    aria-label={`Stop watching ${system.name}`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              ))
            )}
          </div>

          <button
            type="button"
            className="kills-sync-btn"
            onClick={handleSync}
            disabled={syncing || systems.length === 0}
          >
            <RefreshCw size={13} strokeWidth={2} className={syncing ? "kills-sync-spinning" : ""} />
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>

        <div className="kills-feed">
          {systems.length === 0 ? (
            <p className="detail-empty">Add a system above to start watching for activity.</p>
          ) : !hasSynced ? (
            <p className="detail-empty">Click Sync to pull recent kills for your watched systems.</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills in your watched systems.</p>
          ) : (
            <div className="kills-table">
              {kills.map((kill) => (
                <div key={kill.killmail_id} className="kills-row">
                  <span className="kills-time">{formatRelativeTime(kill.time)}</span>
                  <div className="kills-victim-cell">
                    {kill.victim_character_id && (
                      <img
                        className="kills-portrait"
                        src={`https://images.evetech.net/characters/${kill.victim_character_id}/portrait?size=32`}
                        alt=""
                      />
                    )}
                    <span className="kills-victim">
                      {kill.victim_character_name ?? "Unknown"}
                      {kill.victim_corporation_name ? ` (${kill.victim_corporation_name})` : ""}
                    </span>
                  </div>
                  <div className="kills-ship-cell">
                    <img
                      className="kills-ship-icon"
                      src={`https://images.evetech.net/types/${kill.ship_type_id}/icon?size=32`}
                      alt=""
                    />
                    <span className="kills-ship">{kill.ship_type_name}</span>
                  </div>
                  <span className="kills-value">{formatIsk(kill.total_value)}</span>
                  <span className="kills-system">{kill.system_name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default KillsIntel;
