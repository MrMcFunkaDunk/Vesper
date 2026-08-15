import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getRecentActivityKills, pollRecentActivityKills, mergeKillFeeds, type KillEntry } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatSecondsAgo } from "../lib/format";
import KillFeedTable from "./KillFeedTable";

const POLL_RETRY_DELAY_MS = 5_000;

interface RecentKillsFeedProps {
  onSelectKill: (killmailId: number) => void;
}

function RecentKillsFeed({ onSelectKill }: RecentKillsFeedProps) {
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [, forceTick] = useState(0);
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

  // The snapshot above is a one-off pull from zKillboard's REST API for
  // immediate content on open (it's CDN-cached up to an hour, so it can't
  // serve as a live feed on its own). Actual live updates come from this
  // continuous long-poll loop against killmail.stream instead - each call
  // waits server-side for up to ~60s and returns whatever's genuinely new,
  // so there's no fixed interval to tune; it's just always listening.
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
  }, []);

  // Ticks once a second purely to force the "Updated Xs ago" text below to
  // recompute, so a working refresh is visibly obvious even between fetches.
  useEffect(() => {
    const tickInterval = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(tickInterval);
  }, []);

  return (
    <>
      <div className="kills-watchlist kills-live-bar">
        <div className="kills-live-status">
          <span className="kills-live-dot" />
          <span>Live across New Eden — highsec, lowsec, nullsec, w-space</span>
        </div>
        {lastUpdated && (
          <span className="kills-live-updated" title={`Refreshed ${refreshCount} time${refreshCount === 1 ? "" : "s"}`}>
            Updated {formatSecondsAgo(lastUpdated)}
          </span>
        )}
        <button type="button" className="kills-sync-btn" onClick={loadSnapshot} disabled={loading}>
          <RefreshCw size={13} strokeWidth={2} className={loading ? "kills-sync-spinning" : ""} />
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div className="kills-feed">
        {loading && kills.length === 0 ? (
          <p className="detail-empty">Loading recent activity...</p>
        ) : kills.length === 0 ? (
          <p className="detail-empty">No recent kills found.</p>
        ) : (
          <KillFeedTable kills={kills} onSelectKill={onSelectKill} />
        )}
      </div>
    </>
  );
}

export default RecentKillsFeed;
