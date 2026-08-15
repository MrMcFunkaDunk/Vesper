import { useState, type FormEvent } from "react";
import { Plus, X, RefreshCw } from "lucide-react";
import { searchSystem } from "../lib/kills";
import { useTrackedSystemsActivity } from "../hooks/useTrackedSystemsActivity";
import { useErrorReporter } from "../hooks/useErrorReporter";
import KillFeedTable from "./KillFeedTable";

interface TrackedSystemsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
}

function TrackedSystemsFeed({ onSelectKill, onSelectCharacter }: TrackedSystemsFeedProps) {
  const { systems, addSystem, removeSystem, kills, syncing, hasSynced, sync } = useTrackedSystemsActivity();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
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

        <button type="button" className="kills-sync-btn" onClick={sync} disabled={syncing || systems.length === 0}>
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
          <KillFeedTable kills={kills} onSelectKill={onSelectKill} onSelectCharacter={onSelectCharacter} />
        )}
      </div>
    </>
  );
}

export default TrackedSystemsFeed;
