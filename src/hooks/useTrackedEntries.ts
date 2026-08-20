import { useEffect, useRef, useState } from "react";
import { entryKey, type TrackedEntry } from "../lib/kills";

const STORAGE_KEY = "vesper.kills.trackedEntries";
/** Superseded system-only watchlist format, kept only to migrate existing
 * users' saved lists over once rather than losing them. */
const LEGACY_STORAGE_KEY = "vesper.kills.watchedSystems";

function readStorage(): TrackedEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TrackedEntry[];
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { id: number; name: string; security: number }[];
      return legacy.map((s) => ({ type: "system" as const, id: s.id, name: s.name, security: s.security, systemIds: [s.id] }));
    }
    return [];
  } catch {
    return [];
  }
}

/** Persists the tracked list for Kills & Intel - systems, constellations,
 * or whole regions, each carrying its own precomputed list of member
 * system ids so the feed never needs to re-expand a constellation/region
 * to know what to poll. */
export function useTrackedEntries() {
  const [entries, setEntries] = useState<TrackedEntry[]>(() => readStorage());

  // WebView2's localStorage can still be mid-hydration on the very first
  // script tick after a cold app launch, so the readStorage() call above can
  // race and come back empty even though real data is on disk. Skipping the
  // write-back on mount means a lost race just shows a briefly-empty list
  // instead of permanently overwriting the real data with that empty read -
  // only a genuine user action (add/remove/reorder) persists after that.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }, [entries]);

  function addEntry(entry: TrackedEntry) {
    setEntries((prev) => (prev.some((e) => e.type === entry.type && e.id === entry.id) ? prev : [...prev, entry]));
  }

  function removeEntry(type: TrackedEntry["type"], id: number) {
    setEntries((prev) => prev.filter((e) => !(e.type === type && e.id === id)));
  }

  /** Applies a user drag reorder - orderedKeys is the full entryKey list in
   * its new order. */
  function reorderEntries(orderedKeys: string[]) {
    setEntries((prev) => {
      const byKey = new Map(prev.map((e) => [entryKey(e), e]));
      return orderedKeys.map((key) => byKey.get(key)).filter((e): e is TrackedEntry => e !== undefined);
    });
  }

  return { entries, addEntry, removeEntry, reorderEntries };
}
