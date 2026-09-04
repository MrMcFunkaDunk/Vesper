import { useState } from "react";
import type { CharacterStats } from "../lib/kills";
import { formatIsk, formatPercent } from "../lib/format";
import { fmtRank } from "./killboardShared";
import { useTheme, isPremiumTheme } from "../hooks/useTheme";
import ScreenHousing from "./premium/ScreenHousing";
import TelemetryRail from "./premium/TelemetryRail";

interface EntityStatsPanelProps {
  stats: CharacterStats;
}

type TimeWindow = "alltime" | "recent" | "weekly";

const WINDOW_LABELS: Record<TimeWindow, string> = {
  alltime: "Alltime",
  recent: "Recent 90d",
  weekly: "Weekly 7d",
};

/** The Ships/Points/ISK destroyed-vs-lost table (with rank per metric,
 * switchable across zKillboard's Alltime/Recent 90d/Weekly 7d ranking
 * windows) plus the Dangerous/Snuggly ratio bar - the same zKillboard-
 * style stats block shown on character, corporation, and alliance
 * killboard pages alike (zKillboard's stats endpoint returns the
 * identical shape for all three entity types). */
function EntityStatsPanel({ stats }: EntityStatsPanelProps) {
  const [theme] = useTheme();
  const [window, setWindow] = useState<TimeWindow>("alltime");
  const { metrics, ranks } = stats.rankings[window].all;
  const snuggly = 100 - stats.danger_ratio;
  const premium = isPremiumTheme(theme);

  const header = (
    <div className="entity-stats-header">
      <p className="eyebrow">Stats</p>
      <div className="entity-stats-window-toggle">
        {(Object.keys(WINDOW_LABELS) as TimeWindow[]).map((w) => (
          <button
            key={w}
            type="button"
            className={`entity-stats-window-btn ${window === w ? "entity-stats-window-active" : ""}`}
            onClick={() => setWindow(w)}
          >
            {WINDOW_LABELS[w]}
          </button>
        ))}
      </div>
    </div>
  );

  // The window-toggle/stats table/danger bar are identical either way - all
  // three already pick up the shared premium retrofits (button physics,
  // hard-edged pill tracks, monospace readouts) with no changes here. Only
  // the outer frame (a plain panel vs. a console housing) and the closing
  // summary row (plain "//"-joined text vs. a telemetry rail - the same
  // real numbers, just read as instrument output) differ.
  const body = (
    <>
      <div className="character-stats-table character-stats-table-ranked">
        <div className="character-stats-row character-stats-row-ranked character-stats-header">
          <span />
          <span>Destroyed</span>
          <span>Rank</span>
          <span>Lost</span>
          <span>Rank</span>
          <span>Eff.</span>
        </div>
        <div className="character-stats-row character-stats-row-ranked">
          <span className="character-stats-label">Ships</span>
          <span className="character-stats-destroyed">{metrics.ships_destroyed}</span>
          <span className="character-stats-rank">{fmtRank(ranks.ships_destroyed)}</span>
          <span className="character-stats-lost">{metrics.ships_lost}</span>
          <span className="character-stats-rank">{fmtRank(ranks.ships_lost)}</span>
          <span>{formatPercent(metrics.ships_destroyed, metrics.ships_destroyed + metrics.ships_lost)}</span>
        </div>
        <div className="character-stats-row character-stats-row-ranked">
          <span className="character-stats-label">Points</span>
          <span className="character-stats-destroyed">{metrics.points_destroyed}</span>
          <span className="character-stats-rank">{fmtRank(ranks.points_destroyed)}</span>
          <span className="character-stats-lost">{metrics.points_lost}</span>
          <span className="character-stats-rank">{fmtRank(ranks.points_lost)}</span>
          <span>{formatPercent(metrics.points_destroyed, metrics.points_destroyed + metrics.points_lost)}</span>
        </div>
        <div className="character-stats-row character-stats-row-ranked">
          <span className="character-stats-label">ISK</span>
          <span className="character-stats-destroyed">{formatIsk(metrics.isk_destroyed)}</span>
          <span className="character-stats-rank">{fmtRank(ranks.isk_destroyed)}</span>
          <span className="character-stats-lost">{formatIsk(metrics.isk_lost)}</span>
          <span className="character-stats-rank">{fmtRank(ranks.isk_lost)}</span>
          <span>{formatPercent(metrics.isk_destroyed, metrics.isk_destroyed + metrics.isk_lost)}</span>
        </div>
      </div>

      <div className="entity-danger-bar">
        <div className="entity-danger-bar-track">
          <div className="entity-danger-bar-fill" style={{ width: `${stats.danger_ratio}%` }} />
        </div>
        <div className="entity-danger-bar-labels">
          <span className="entity-danger-label-danger">{stats.danger_ratio}% Dangerous</span>
          <span className="entity-danger-label-snuggly">{snuggly}% Snuggly</span>
        </div>
      </div>
    </>
  );

  if (premium) {
    return (
      <ScreenHousing title="Combat Stats" className="entity-stats-panel-premium">
        {header}
        {body}
        <TelemetryRail
          items={[
            { label: "Overall Rank", value: fmtRank(ranks.overall) },
            { label: "Solo Kills", value: String(stats.solo_kills) },
            { label: "Solo Losses", value: String(stats.solo_losses) },
            { label: "Avg Gang Size", value: stats.avg_gang_size.toFixed(1) },
          ]}
        />
      </ScreenHousing>
    );
  }

  return (
    <div className="detail-panel">
      {header}
      {body}
      <div className="character-stats-extra">
        <span>Overall Rank: {fmtRank(ranks.overall)}</span>
        <span className="detail-stats-sep">//</span>
        <span>Solo Kills: {stats.solo_kills}</span>
        <span className="detail-stats-sep">//</span>
        <span>Solo Losses: {stats.solo_losses}</span>
        <span className="detail-stats-sep">//</span>
        <span>Avg Gang Size: {stats.avg_gang_size.toFixed(1)}</span>
      </div>
    </div>
  );
}

export default EntityStatsPanel;
