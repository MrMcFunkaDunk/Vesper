import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getRecentActivityKills, pollRecentActivityKills, mergeKillFeeds, type KillEntry } from "../lib/kills";
import { useErrorReporter } from "./useErrorReporter";

const POLL_RETRY_DELAY_MS = 5_000;

interface RecentActivityState {
  kills: KillEntry[];
  loading: boolean;
  lastUpdated: string | null;
  refreshCount: number;
  refresh: () => void;
}

const RecentActivityContext = createContext<RecentActivityState | null>(null);

/**
 * The live "Most Recent Kills" feed, kept in a provider at the app root
 * (not owned by the Kills & Intel screen) so it keeps streaming for the
 * whole session - switching tabs, drilling into a kill, or leaving Kills &
 * Intel entirely no longer stops it. Whatever screen reads this always
 * sees the most up-to-date state the moment it's opened.
 */
export function useRecentActivity(): RecentActivityState {
  const ctx = useContext(RecentActivityContext);
  if (!ctx) {
    throw new Error("useRecentActivity must be used within a RecentActivityProvider");
  }
  return ctx;
}

interface RecentActivityProviderProps {
  children: ReactNode;
}

export function RecentActivityProvider({ children }: RecentActivityProviderProps) {
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const reportError = useErrorReporter();

  async function loadSnapshot() {
    try {
      const results = await getRecentActivityKills();
      setKills((prev) => mergeKillFeeds(prev, results));
      setLastUpdated(new Date().toISOString());
      setRefreshCount((n) => n + 1);
    } catch (err) {
      reportError(`Failed to load recent kills: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function pollLoop() {
      while (active) {
        try {
          const incoming = await pollRecentActivityKills();
          if (!active) break;
          if (incoming.length > 0) {
            setKills((prev) => mergeKillFeeds(prev, incoming));
            setLastUpdated(new Date().toISOString());
            setRefreshCount((n) => n + 1);
          }
          setLoading(false);
        } catch (err) {
          if (!active) break;
          reportError(`Live kill stream error: ${String(err)}`);
          await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS));
        }
      }
    }

    loadSnapshot();
    pollLoop();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RecentActivityContext.Provider value={{ kills, loading, lastUpdated, refreshCount, refresh: loadSnapshot }}>
      {children}
    </RecentActivityContext.Provider>
  );
}
