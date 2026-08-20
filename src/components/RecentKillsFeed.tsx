import { useEffect, useState } from "react";
import { RefreshCw, Skull } from "lucide-react";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { useShowNpcKills } from "../hooks/useShowNpcKills";
import { useSecurityBandFilters } from "../hooks/useSecurityBandFilters";
import { Pager, PAGE_SIZE, SecurityBandFilterBar } from "./killboardShared";
import { formatSecondsAgo, killSecurityBand } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

interface RecentKillsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

function RecentKillsFeed({
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
}: RecentKillsFeedProps) {
  const { kills, loading, lastUpdated, refreshCount, refresh } = useRecentActivity();
  const [showNpcKills, setShowNpcKills] = useShowNpcKills();
  const [securityFilters, toggleSecurityFilter] = useSecurityBandFilters();
  const [page, setPage] = useState(1);
  const [, forceTick] = useState(0);
  const filteredKills = kills.filter(
    (k) => (showNpcKills || !k.npc) && securityFilters[killSecurityBand(k.system_security, k.system_name)],
  );
  const pageCount = Math.max(1, Math.ceil(filteredKills.length / PAGE_SIZE));
  const pagedKills = filteredKills.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Ticks once a second purely to force the "Updated Xs ago" text below to
  // recompute, so a working feed is visibly obvious even between fetches.
  useEffect(() => {
    const tickInterval = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(tickInterval);
  }, []);

  // A filter change can shrink the list out from under whatever page was
  // showing - reset to page 1 rather than land on a now-empty page.
  useEffect(() => {
    setPage(1);
  }, [showNpcKills, securityFilters]);

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

      <div className="kills-feed">
        {loading && filteredKills.length === 0 ? (
          <p className="detail-empty">Loading recent activity...</p>
        ) : filteredKills.length === 0 ? (
          <p className="detail-empty">No recent kills found.</p>
        ) : (
          <>
            <KillFeedTable
              kills={pagedKills}
              onSelectKill={onSelectKill}
              onSelectCharacter={onSelectCharacter}
              onSelectSystem={onSelectSystem}
              onSelectCorporation={onSelectCorporation}
              onSelectAlliance={onSelectAlliance}
            />
            <Pager page={page} pageCount={pageCount} onChange={setPage} />
          </>
        )}
      </div>
    </>
  );
}

export default RecentKillsFeed;
