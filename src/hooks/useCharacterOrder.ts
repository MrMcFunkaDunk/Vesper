import { useEffect, useRef, useState } from "react";
import { backupSetting } from "../lib/settingsBackup";

const STORAGE_KEY = "vesper.dashboard.characterOrder";

function readOrder(defaultIds: number[]): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultIds;
    const stored = JSON.parse(raw) as number[];
    // Keep the stored order for characters still logged in, then append any
    // newly-added character that isn't in it yet - so a freshly-added
    // character always shows up (at the end) rather than vanishing because
    // an old saved order doesn't know about it.
    const known = new Set(defaultIds);
    const cleaned = stored.filter((id) => known.has(id));
    const missing = defaultIds.filter((id) => !cleaned.includes(id));
    return [...cleaned, ...missing];
  } catch {
    return defaultIds;
  }
}

/** Persists the Dashboard's user-chosen character-card order to
 * localStorage - the "arrange your layout" control for the character grid,
 * the same drag-to-reorder pattern the Sidebar's own nav list already
 * uses. Keyed by character id (stable across sessions/logins), not
 * position, so re-ordering survives adding or removing a character. */
export function useCharacterOrder(defaultIds: number[]) {
  const [order, setOrder] = useState<number[]>(() => readOrder(defaultIds));

  // Skip the write-back on mount - see useTrackedEntries for why a cold
  // WebView2 start can read stale/empty and shouldn't immediately re-persist
  // that as ground truth.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const serialized = JSON.stringify(order);
    localStorage.setItem(STORAGE_KEY, serialized);
    backupSetting(STORAGE_KEY, serialized);
  }, [order]);

  return { order, setOrder };
}
