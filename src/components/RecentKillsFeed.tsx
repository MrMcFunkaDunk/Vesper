import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { formatSecondsAgo } from "../lib/format";
import KillFeedTable from "./KillFeedTable";

interface RecentKillsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
}

function RecentKillsFeed({ onSelectKill, onSelectCharacter }: RecentKillsFeedProps) {
  const { kills, loading, lastUpdated, refreshCount, refresh } = useRecentActivity();
  const [, forceTick] = useState(0);

  // Ticks once a second purely to force the "Updated Xs ago" text below to
  // recompute, so a working feed is visibly obvious even between fetches.
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
        <button type="button" className="kills-sync-btn" onClick={refresh} disabled={loading}>
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
          <KillFeedTable kills={kills} onSelectKill={onSelectKill} onSelectCharacter={onSelectCharacter} />
        )}
      </div>
    </>
  );
}

export default RecentKillsFeed;
