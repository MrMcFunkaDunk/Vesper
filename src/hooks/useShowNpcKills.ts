import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.kills.showNpcKills";

/** Whether NPC-only kills (CONCORD, faction police, mission rats, etc.)
 * show in kill feeds - shared across Tracked Systems and Most Recent Kills
 * so the choice doesn't reset when switching between them. Defaults to
 * showing everything, matching the feed's existing behavior. */
export function useShowNpcKills() {
  const [showNpcKills, setShowNpcKills] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });

  // Skip the write-back on mount - see useTrackedEntries for why a cold
  // WebView2 start can read stale/empty and shouldn't immediately re-persist
  // that as ground truth.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, String(showNpcKills));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [showNpcKills]);

  return [showNpcKills, setShowNpcKills] as const;
}
