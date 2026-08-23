import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getKillTopStats, type KillTopStats, type RankingEntry } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatSecondsAgo, typeIconUrl } from "../lib/format";
import { corpLogoUrl, allianceLogoUrl } from "./killboardShared";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

type RankingImageKind = "character" | "corporation" | "alliance" | "ship";

function rankingImageUrl(kind: RankingImageKind, id: number): string {
  switch (kind) {
    case "character":
      return `https://images.evetech.net/characters/${id}/portrait?size=64`;
    case "corporation":
      return corpLogoUrl(id);
    case "alliance":
      return allianceLogoUrl(id);
    case "ship":
      return typeIconUrl(id, 64);
  }
}

interface TopKillStatsFeedProps {
  onSelectCharacter: (characterId: number) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

const WINDOW_MINUTES = 60;
const REFRESH_MS = 60_000;

function RankingCard({
  title,
  entries,
  imageKind,
  onSelect,
}: {
  title: string;
  entries: RankingEntry[];
  imageKind?: RankingImageKind;
  onSelect?: (entry: RankingEntry) => void;
}) {
  return (
    <div className="kill-stats-card">
      <p className="kill-stats-card-title">{title}</p>
      {entries.length === 0 ? (
        <p className="kill-stats-card-empty">No data yet</p>
      ) : (
        <ol className="kill-stats-card-list">
          {entries.map((e, i) => (
            <li key={e.id ?? i}>
              <span className="kill-stats-rank">{i + 1}</span>
              {imageKind && e.id !== 0 && (
                <img className="kill-stats-avatar" src={rankingImageUrl(imageKind, e.id)} alt="" />
              )}
              {onSelect && e.id !== 0 ? (
                <button type="button" className="kill-stats-name-link" onClick={() => onSelect(e)}>
                  {e.name || `#${e.id}`}
                </button>
              ) : (
                <span className="kill-stats-name">{e.name || `#${e.id}`}</span>
              )}
              <span className="kill-stats-count">{e.count}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** VESPER's equivalent of zKillboard's "Top Killers in the Last Hour" page -
 * see TopStatsResult in kill_history.rs for exactly what each ranking
 * represents and why some zKillboard categories (Top Locations, a spotlight
 * on a single hot system) were simplified or dropped. */
function TopKillStatsFeed({ onSelectCharacter, onSelectCorporation, onSelectAlliance }: TopKillStatsFeedProps) {
  const [stats, setStats] = useState<KillTopStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const reportError = useErrorReporter();

  function load() {
    setLoading(true);
    getKillTopStats(WINDOW_MINUTES)
      .then((result) => {
        setStats(result);
        setLastUpdated(new Date().toISOString());
      })
      .catch((err) => reportError(`Failed to load top kill stats: ${String(err)}`))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !stats) {
    return <p className="detail-empty">Loading the last hour's activity...</p>;
  }
  if (!stats) {
    return <p className="detail-empty">No data available.</p>;
  }

  return (
    <div className="kill-stats-page">
      <div className="kills-watchlist kills-live-bar">
        <div className="kills-live-status">
          <span className="kills-live-dot" />
          <span>{stats.total_kills} kills in the last hour</span>
        </div>
        {lastUpdated && <span className="kills-live-updated">Updated {formatSecondsAgo(lastUpdated)}</span>}
        <button type="button" className="kills-sync-btn" onClick={load} disabled={loading}>
          <RefreshCw size={13} strokeWidth={2} className={loading ? "kills-sync-spinning" : ""} />
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <p className="settings-section-hint">
        Only reflects kills VESPER's own history recorder has seen since it started running - this fills in more
        completely the longer the app has been open.
      </p>

      <p className="kill-stats-section-title">Top Killers</p>
      <div className="kill-stats-grid">
        <RankingCard title="Characters" entries={stats.killer_characters} imageKind="character" onSelect={(e) => onSelectCharacter(e.id)} />
        <RankingCard
          title="Corporations"
          entries={stats.killer_corporations}
          imageKind="corporation"
          onSelect={(e) => onSelectCorporation({ id: e.id, name: e.name })}
        />
        <RankingCard
          title="Alliances"
          entries={stats.killer_alliances}
          imageKind="alliance"
          onSelect={(e) => onSelectAlliance({ id: e.id, name: e.name })}
        />
        <RankingCard title="Factions" entries={stats.killer_factions} />
        <RankingCard title="Ships" entries={stats.killer_ships} imageKind="ship" />
        <RankingCard title="Groups" entries={stats.killer_groups} />
      </div>

      <p className="kill-stats-section-title">Top Losers</p>
      <div className="kill-stats-grid">
        <RankingCard title="Characters" entries={stats.loser_characters} imageKind="character" onSelect={(e) => onSelectCharacter(e.id)} />
        <RankingCard
          title="Corporations"
          entries={stats.loser_corporations}
          imageKind="corporation"
          onSelect={(e) => onSelectCorporation({ id: e.id, name: e.name })}
        />
        <RankingCard
          title="Alliances"
          entries={stats.loser_alliances}
          imageKind="alliance"
          onSelect={(e) => onSelectAlliance({ id: e.id, name: e.name })}
        />
        <RankingCard title="Factions" entries={stats.loser_factions} />
        <RankingCard title="Ships" entries={stats.loser_ships} imageKind="ship" />
        <RankingCard title="Groups" entries={stats.loser_groups} />
      </div>

      <p className="kill-stats-section-title">Where It Happened</p>
      <div className="kill-stats-grid">
        <RankingCard title="Systems" entries={stats.top_systems} />
        <RankingCard title="Regions" entries={stats.top_regions} />
      </div>
    </div>
  );
}

export default TopKillStatsFeed;
