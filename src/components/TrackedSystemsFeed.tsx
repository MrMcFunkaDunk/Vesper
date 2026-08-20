import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus, X, RefreshCw, Skull, Hexagon, Globe2, DoorOpen } from "lucide-react";
import { searchSystem, entryKey, getSystemGates, type TrackedEntry, type GateSummary } from "../lib/kills";
import { searchSystemsLive, type SystemSearchMatch } from "../lib/map";
import { useTrackedSystemsActivity } from "../hooks/useTrackedSystemsActivity";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useShowNpcKills } from "../hooks/useShowNpcKills";
import { useSecurityBandFilters } from "../hooks/useSecurityBandFilters";
import { useDragReorder } from "../hooks/useDragReorder";
import { formatSecurity, securityBand, securityColor, killSecurityBand } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import { SecurityBandFilterBar } from "./killboardShared";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

interface TrackedSystemsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

function TrackedSystemsFeed({
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
}: TrackedSystemsFeedProps) {
  const { entries, addEntry, removeEntry, reorderEntries, kills, syncing, hasSynced, sync } = useTrackedSystemsActivity();
  const { draggingId, setItemRef, handlePointerDown, handlePointerMove, handlePointerUp, consumeJustDragged } =
    useDragReorder(
      entries.map(entryKey),
      reorderEntries,
      "wrap",
    );
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<SystemSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // "Gate" mode reuses the same system typeahead below to find the *source*
  // system first, then lists that system's own gates to pick from - a gate
  // name alone ("Stargate (New Caldari)") isn't unique across New Eden, so
  // there's no way to search for one directly without a system context.
  const [addMode, setAddMode] = useState<"system" | "gate">("system");
  const [gateSystemPick, setGateSystemPick] = useState<SystemSearchMatch | null>(null);
  const [gateOptions, setGateOptions] = useState<GateSummary[]>([]);
  const [loadingGates, setLoadingGates] = useState(false);
  // Selecting an entry narrows the feed to just its system(s) - it's a
  // single active filter, not a multi-select union, so picking a new one
  // always replaces whatever was selected before rather than adding to it.
  const [activeFilterKey, setActiveFilterKey] = useState<string | null>(null);
  const [showNpcKills, setShowNpcKills] = useShowNpcKills();
  const [securityFilters, toggleSecurityFilter] = useSecurityBandFilters();
  const reportError = useErrorReporter();

  function toggleFilter(entry: TrackedEntry) {
    const key = entryKey(entry);
    setActiveFilterKey((prev) => (prev === key ? null : key));
  }

  function handleRemoveEntry(entry: TrackedEntry) {
    removeEntry(entry.type, entry.id);
    setActiveFilterKey((prev) => (prev === entryKey(entry) ? null : prev));
  }

  // No chip selected means "show everything I'm tracking" (the original
  // behavior) - selecting one narrows the feed to just that entry's
  // system(s), e.g. to check a specific route system - or a whole
  // constellation/region you're running missions through - without digging
  // through everything else being tracked.
  const activeEntry = entries.find((e) => entryKey(e) === activeFilterKey) ?? null;
  const filteredKills = kills
    .filter((k) => {
      if (!activeEntry) return true;
      // A gate entry's systemIds is just its one home system - filtering by
      // that would show every kill in the whole system, not just the ones
      // at this specific gate, so match on location_id instead.
      if (activeEntry.type === "gate") return k.location_id === activeEntry.id;
      return activeEntry.systemIds.includes(k.system_id);
    })
    .filter((k) => showNpcKills || !k.npc)
    .filter((k) => securityFilters[killSecurityBand(k.system_security, k.system_name)]);

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

  function addSystemEntry(match: SystemSearchMatch | { id: number; name: string; security: number }) {
    addEntry({ type: "system", id: match.id, name: match.name, security: match.security, systemIds: [match.id] });
  }

  function pickSuggestion(match: SystemSearchMatch) {
    if (addMode === "gate") {
      pickGateSystem(match);
      return;
    }
    addSystemEntry(match);
    setQuery("");
    setSuggestions([]);
    setSuggestionsOpen(false);
  }

  async function pickGateSystem(match: SystemSearchMatch) {
    setQuery("");
    setSuggestions([]);
    setSuggestionsOpen(false);
    setGateSystemPick(match);
    setLoadingGates(true);
    try {
      setGateOptions(await getSystemGates(match.id));
    } catch (err) {
      reportError(`Failed to load gates for ${match.name}: ${String(err)}`);
      setGateOptions([]);
    } finally {
      setLoadingGates(false);
    }
  }

  function pickGate(gate: GateSummary) {
    if (!gateSystemPick) return;
    addEntry({ type: "gate", id: gate.id, name: gate.name, systemIds: [gateSystemPick.id] });
    setGateSystemPick(null);
    setGateOptions([]);
  }

  function switchAddMode(mode: "system" | "gate") {
    setAddMode(mode);
    setGateSystemPick(null);
    setGateOptions([]);
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
      if (addMode === "gate") {
        await pickGateSystem(match);
      } else {
        addSystemEntry(match);
        setQuery("");
      }
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
        <div className="kills-add-mode-toggle">
          <button
            type="button"
            className={addMode === "system" ? "kills-add-mode-active" : ""}
            onClick={() => switchAddMode("system")}
          >
            System
          </button>
          <button
            type="button"
            className={addMode === "gate" ? "kills-add-mode-active" : ""}
            onClick={() => switchAddMode("gate")}
          >
            Gate
          </button>
        </div>
        <form className="kills-add-form" onSubmit={handleAddSystem}>
          <div className="kills-add-combobox">
            <input
              type="text"
              placeholder={addMode === "gate" ? "Search a system to find its gates (e.g. Jita)" : "Add a system to watch (e.g. Jita)"}
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
                    <span className="kills-security" style={{ color: securityColor(s.security) }}>
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
            {searching ? "Searching..." : addMode === "gate" ? "Find Gates" : "Add"}
          </button>
        </form>
        {addMode === "gate" ? (
          gateSystemPick && (
            <div className="kills-gate-picker">
              <div className="kills-gate-picker-header">
                <span>Pick a gate in {gateSystemPick.name}</span>
                <button
                  type="button"
                  className="kills-gate-picker-cancel"
                  onClick={() => {
                    setGateSystemPick(null);
                    setGateOptions([]);
                  }}
                  aria-label="Cancel gate pick"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
              {loadingGates ? (
                <p className="kills-gate-picker-empty">Loading gates...</p>
              ) : gateOptions.length === 0 ? (
                <p className="kills-gate-picker-empty">No gates found in this system.</p>
              ) : (
                <div className="kills-gate-picker-list">
                  {gateOptions.map((gate) => {
                    const tracked = entries.some((e) => e.type === "gate" && e.id === gate.id);
                    return (
                      <button
                        key={gate.id}
                        type="button"
                        className="kills-gate-picker-option"
                        disabled={tracked}
                        onClick={() => pickGate(gate)}
                      >
                        <DoorOpen size={12} strokeWidth={2} />
                        {gate.name}
                        {tracked ? " (tracked)" : ""}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )
        ) : (
          <p className="kills-add-hint">
            Tracking a constellation or region? Open it from a system's header (Constellation/Region links) and use the +
            Track button there.
          </p>
        )}

        <div className="kills-watched-chips">
          {entries.length === 0 ? (
            <span className="kills-watched-empty">Nothing tracked yet.</span>
          ) : (
            entries.map((entry) => {
              const key = entryKey(entry);
              const active = key === activeFilterKey;
              const dragging = key === draggingId;
              // System chips are colored by security band; constellation and
              // region chips each get their own fixed color instead (see
              // .kills-watched-chip-constellation/-region) so the two read
              // as distinct at a glance rather than sharing one neutral tone.
              const band = entry.type === "system" ? securityBand(entry.security ?? 0) : entry.type;
              return (
                <span
                  key={key}
                  ref={setItemRef(key)}
                  className={`kills-watched-chip kills-watched-chip-${band}${active ? " kills-watched-chip-active" : ""}${dragging ? " kills-watched-chip-dragging" : ""}`}
                >
                  <button
                    type="button"
                    className="kills-watched-chip-toggle"
                    onClick={() => {
                      if (consumeJustDragged()) return;
                      toggleFilter(entry);
                    }}
                    onPointerDown={handlePointerDown(key)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    aria-pressed={active}
                    title={active ? `Showing only ${entry.name} - click to show everything tracked` : `Show only ${entry.name}`}
                  >
                    {entry.type === "system" ? (
                      <span className="kills-security" style={{ color: securityColor(entry.security ?? 0) }}>
                        {formatSecurity(entry.security ?? 0)}
                      </span>
                    ) : entry.type === "constellation" ? (
                      <Hexagon size={12} strokeWidth={2} />
                    ) : entry.type === "region" ? (
                      <Globe2 size={12} strokeWidth={2} />
                    ) : (
                      <DoorOpen size={12} strokeWidth={2} />
                    )}
                    {entry.name}
                  </button>
                  <button
                    type="button"
                    className="kills-watched-chip-remove"
                    onClick={() => {
                      if (consumeJustDragged()) return;
                      handleRemoveEntry(entry);
                    }}
                    aria-label={`Stop tracking ${entry.name}`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              );
            })
          )}
        </div>

        <div className="kills-watchlist-actions">
          <button type="button" className="kills-sync-btn" onClick={sync} disabled={syncing || entries.length === 0}>
            <RefreshCw size={13} strokeWidth={2} className={syncing ? "kills-sync-spinning" : ""} />
            {syncing ? "Syncing..." : "Sync"}
          </button>
          <button
            type="button"
            className={`kills-sync-btn${showNpcKills ? "" : " kills-npc-toggle-off"}`}
            onClick={() => setShowNpcKills(!showNpcKills)}
            title={showNpcKills ? "Hide NPC-only kills" : "Show NPC-only kills"}
          >
            <Skull size={13} strokeWidth={2} />
            NPC Kills: {showNpcKills ? "On" : "Off"}
          </button>
          <SecurityBandFilterBar filters={securityFilters} onToggle={toggleSecurityFilter} />
        </div>
      </div>

      <div className="kills-feed">
        {entries.length === 0 ? (
          <p className="detail-empty">Add a system above (or track a constellation/region from its page) to start watching for activity.</p>
        ) : !hasSynced ? (
          <p className="detail-empty">Loading recent kills for your tracked list...</p>
        ) : filteredKills.length === 0 ? (
          <p className="detail-empty">
            {activeFilterKey === null ? "No recent kills in your tracked list." : "No recent kills in the selected entry."}
          </p>
        ) : (
          <KillFeedTable
            kills={filteredKills}
            onSelectKill={onSelectKill}
            onSelectCharacter={onSelectCharacter}
            onSelectSystem={onSelectSystem}
            onSelectCorporation={onSelectCorporation}
            onSelectAlliance={onSelectAlliance}
          />
        )}
      </div>
    </>
  );
}

export default TrackedSystemsFeed;
