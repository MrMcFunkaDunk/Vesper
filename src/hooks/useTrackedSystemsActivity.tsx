import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getRecentKills, pollTrackedSystemKills, mergeKillFeeds, type KillEntry, type SystemMatch } from "../lib/kills";
import { useWatchedSystems } from "./useWatchedSystems";
import { useErrorReporter } from "./useErrorReporter";

const POLL_RETRY_DELAY_MS = 5_000;

interface TrackedSystemsState {
  systems: SystemMatch[];
  addSystem: (system: SystemMatch) => void;
  removeSystem: (id: number) => void;
  kills: KillEntry[];
  syncing: boolean;
  hasSynced: boolean;
  sync: () => void;
}

const TrackedSystemsContext = createContext<TrackedSystemsState | null>(null);

/**
 * The watchlist and its live feed, kept in a provider at the app root (not
 * owned by the Kills & Intel screen) so it keeps streaming for the whole
 * session regardless of which tab or page is currently showing. This is
 * also the single owner of useWatchedSystems - it must not be called
 * again elsewhere, or the watchlist would exist as two independent copies
 * of state that drift out of sync with each other.
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
  const { systems, addSystem, removeSystem } = useWatchedSystems();
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const reportError = useErrorReporter();

  async function loadSnapshot(watched: SystemMatch[]) {
    if (watched.length === 0) return;
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
    <TrackedSystemsContext.Provider
      value={{ systems, addSystem, removeSystem, kills, syncing, hasSynced, sync: () => loadSnapshot(systems) }}
    >
      {children}
    </TrackedSystemsContext.Provider>
  );
}
