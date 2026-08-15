import { useEffect, useState, type FormEvent } from "react";
import { Plus, X, RefreshCw } from "lucide-react";
import {
  searchSystem,
  getRecentKills,
  pollTrackedSystemKills,
  mergeKillFeeds,
  type KillEntry,
  type SystemMatch,
} from "../lib/kills";
import { useWatchedSystems } from "../hooks/useWatchedSystems";
import { useErrorReporter } from "../hooks/useErrorReporter";
import KillFeedTable from "./KillFeedTable";

const POLL_RETRY_DELAY_MS = 5_000;

interface TrackedSystemsFeedProps {
  onSelectKill: (killmailId: number) => void;
}

function TrackedSystemsFeed({ onSelectKill }: TrackedSystemsFeedProps) {
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

  async function loadSnapshot(watched: SystemMatch[]) {
    setSyncing(true);
    try {
      const results = await getRecentKills(watched.map((s) => s.id));
      setKills((prev) => mergeKillFeeds(prev, results));
      setHasSynced(true);
    } catch (err) {
      reportError(`Failed to load kills: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  // The snapshot above is a one-off pull from zKillboard's REST API for
  // immediate content (it's CDN-cached up to an hour, so on its own it
  // can't serve as a live feed). Real live updates come from this
  // continuous long-poll loop against killmail.stream instead, filtered
  // server-side to these watched systems. Restarts whenever the watchlist
  // changes so the filter always matches what's currently on screen.
  useEffect(() => {
    if (systems.length === 0) return;
    let active = true;
    const systemIds = systems.map((s) => s.id);

    async function pollLoop() {
      while (active) {
        try {
          const incoming = await pollTrackedSystemKills(systemIds);
          if (!active) break;
          if (incoming.length > 0) {
            setKills((prev) => mergeKillFeeds(prev, incoming));
            setHasSynced(true);
          }
        } catch (err) {
          if (!active) break;
          reportError(`Live kill stream error: ${String(err)}`);
          await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS));
        }
      }
    }

    loadSnapshot(systems);
    pollLoop();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems]);

  return (
    <>
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
          onClick={() => loadSnapshot(systems)}
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
          <p className="detail-empty">Loading recent kills for your watched systems...</p>
        ) : kills.length === 0 ? (
          <p className="detail-empty">No recent kills in your watched systems.</p>
        ) : (
          <KillFeedTable kills={kills} onSelectKill={onSelectKill} />
        )}
      </div>
    </>
  );
}

export default TrackedSystemsFeed;
