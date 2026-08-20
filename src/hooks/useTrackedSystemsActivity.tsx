import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  getRecentKills,
  getConstellationKills,
  getRegionKills,
  getLocationKills,
  pollTrackedSystemKills,
  mergeKillFeeds,
  MAX_TRACKED_KILLS,
  type KillEntry,
  type TrackedEntry,
} from "../lib/kills";
import { useTrackedEntries } from "./useTrackedEntries";
import { useErrorReporter } from "./useErrorReporter";

const POLL_RETRY_DELAY_MS = 5_000;

interface TrackedSystemsState {
  entries: TrackedEntry[];
  addEntry: (entry: TrackedEntry) => void;
  removeEntry: (type: TrackedEntry["type"], id: number) => void;
  reorderEntries: (orderedKeys: string[]) => void;
  kills: KillEntry[];
  syncing: boolean;
  hasSynced: boolean;
  sync: () => void;
}

const TrackedSystemsContext = createContext<TrackedSystemsState | null>(null);

/**
 * The tracked list (systems, constellations, and/or whole regions) and its
 * live feed, kept in a provider at the app root (not owned by the Kills &
 * Intel screen) so it keeps streaming for the whole session regardless of
 * which tab or page is currently showing. This is also the single owner of
 * useTrackedEntries - it must not be called again elsewhere, or the tracked
 * list would exist as two independent copies of state that drift out of
 * sync with each other.
 */
export function useTrackedSystemsActivity(): TrackedSystemsState {
  const ctx = useContext(TrackedSystemsContext);
  if (!ctx) {
    throw new Error("useTrackedSystemsActivity must be used within a TrackedSystemsProvider");
  }
  return ctx;
}

interface TrackedSystemsProviderProps {
  children: ReactNode;
}

export function TrackedSystemsProvider({ children }: TrackedSystemsProviderProps) {
  const { entries, addEntry, removeEntry, reorderEntries } = useTrackedEntries();
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const reportError = useErrorReporter();

  // A constellation/region entry already carries every system id it covers
  // (computed once when it was added), so tracking many entry types at once
  // is just a matter of flattening them into one deduped list here - the
  // actual kill fetch/poll functions stay unchanged, still just "give me a
  // list of system ids".
  function flattenSystemIds(list: TrackedEntry[]): number[] {
    return [...new Set(list.flatMap((e) => e.systemIds))];
  }

  // The one-time snapshot fetch uses each entry's own best-fit endpoint
  // rather than flattening everything to a system_ids list: a region can
  // easily cover 100+ systems, and fetch_recent_kills does one zKillboard
  // call per system - flattening a tracked region into that list turned
  // "load my tracked kills" into a hundred-plus sequential requests, slow
  // enough to time out in practice. zKillboard's own regionID/
  // constellationID endpoints cover the whole area in a single call.
  // Fetching every entry independently (rather than one combined call) also
  // means one entry failing can't wipe out every other tracked entry's
  // kills - each is reported and merged on its own.
  async function loadSnapshot(watched: TrackedEntry[]) {
    if (watched.length === 0) return;
    setSyncing(true);
    try {
      const results = await Promise.allSettled(
        watched.map((entry) => {
          if (entry.type === "constellation") return getConstellationKills(entry.id);
          if (entry.type === "region") return getRegionKills(entry.id);
          if (entry.type === "gate") return getLocationKills(entry.id);
          return getRecentKills(entry.systemIds);
        }),
      );
      const merged = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        reportError(`Failed to load kills for ${failed} tracked ${failed === 1 ? "entry" : "entries"}.`);
      }
      setKills((prev) => mergeKillFeeds(prev, merged, MAX_TRACKED_KILLS));
      setHasSynced(true);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    const systemIds = flattenSystemIds(entries);
    if (systemIds.length === 0) return;
    let active = true;

    async function pollLoop() {
      while (active) {
        try {
          const incoming = await pollTrackedSystemKills(systemIds);
          if (!active) break;
          if (incoming.length > 0) {
            setKills((prev) => mergeKillFeeds(prev, incoming, MAX_TRACKED_KILLS));
            setHasSynced(true);
          }
        } catch (err) {
          if (!active) break;
          reportError(`Live kill stream error: ${String(err)}`);
          await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS));
        }
      }
    }

    loadSnapshot(entries);
    pollLoop();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  return (
    <TrackedSystemsContext.Provider
      value={{ entries, addEntry, removeEntry, reorderEntries, kills, syncing, hasSynced, sync: () => loadSnapshot(entries) }}
    >
      {children}
    </TrackedSystemsContext.Provider>
  );
}
