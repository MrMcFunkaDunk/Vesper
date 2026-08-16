import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus, X, RefreshCw } from "lucide-react";
import { searchSystem } from "../lib/kills";
import { searchSystemsLive, type SystemSearchMatch } from "../lib/map";
import { useTrackedSystemsActivity } from "../hooks/useTrackedSystemsActivity";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatSecurity, securityBand } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import type { SystemSummary } from "./SystemKillboard";

interface TrackedSystemsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
}

function TrackedSystemsFeed({ onSelectKill, onSelectCharacter, onSelectSystem }: TrackedSystemsFeedProps) {
  const { systems, addSystem, removeSystem, kills, syncing, hasSynced, sync } = useTrackedSystemsActivity();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<SystemSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const reportError = useErrorReporter();

  // Live suggestions as the user types, debounced so every keystroke doesn't
  // fire its own lookup - a fast local prefix match against the same SDE
  // systems table the map uses, not an ESI round trip.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSystemsLive(trimmed)
        .then((results) => {
          if (cancelled) return;
          setSuggestions(results);
          setSuggestionsOpen(results.length > 0);
          setHighlightIndex(0);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function pickSuggestion(match: SystemSearchMatch) {
    addSystem(match);
    setQuery("");
    setSuggestions([]);
    setSuggestionsOpen(false);
  }

  async function handleAddSystem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (suggestionsOpen && suggestions[highlightIndex]) {
      pickSuggestion(suggestions[highlightIndex]);
      return;
    }
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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!suggestionsOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setSuggestionsOpen(false);
    }
  }

  return (
    <>
      <div className="kills-watchlist">
        <form className="kills-add-form" onSubmit={handleAddSystem}>
          <div className="kills-add-combobox">
            <input
              type="text"
              placeholder="Add a system to watch (e.g. Jita)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
              onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
              disabled={searching}
            />
            {suggestionsOpen && (
              <div className="gatecheck-slot-results kills-add-suggestions">
                {suggestions.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    className={i === highlightIndex ? "kills-add-suggestion-active" : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSuggestion(s)}
                  >
                    <span className={`kills-security kills-security-${securityBand(s.security)}`}>
                      {formatSecurity(s.security)}
                    </span>
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <KillFeedTable kills={kills} onSelectKill={onSelectKill} onSelectCharacter={onSelectCharacter} onSelectSystem={onSelectSystem} />
        )}
      </div>
    </>
  );
}

export default TrackedSystemsFeed;
