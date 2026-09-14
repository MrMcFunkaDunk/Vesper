import { useEffect, useState } from "react";
import { RefreshCw, Skull } from "lucide-react";
import KillFeedTable from "./KillFeedTable";
import { SecurityBandFilterBar } from "./killboardShared";
import {
  getCharacterKills,
  getCharacterLosses,
  getCorporationKills,
  getCorporationLosses,
  getAllianceKills,
  getAllianceLosses,
  type KillEntry,
} from "../lib/kills";
import type { TrackedEntity } from "../lib/trackedEntities";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useShowNpcKills } from "../hooks/useShowNpcKills";
import { useSecurityBandFilters } from "../hooks/useSecurityBandFilters";
import { killSecurityBand } from "../lib/format";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

/** How far back the tracked-list feed looks - the one number the pilot
 * actually asked for, kept as a named constant rather than scattered
 * arithmetic. */
const LOOKBACK_DAYS = 30;

/** Safety cap on how many zKillboard pages (200 killmails each) get pulled
 * per entity per feed before giving up on reaching the cutoff - protects
 * against an extremely active alliance turning one tab load into dozens of
 * requests. 5 pages (1000 killmails) comfortably covers 30 days for
 * anything short of a supercapital blob's own killboard. */
const MAX_PAGES_PER_FEED = 5;

type OutcomeEntry = KillEntry & { outcome: "kill" | "loss" };

type OutcomeFilter = "all" | "kill" | "loss";

/** Pages through one entity's kills or losses until either the feed runs
 * out or a whole page's entries are already older than the cutoff -
 * zKillboard returns newest-first, so once the last (oldest) row on a page
 * is past the window there's nothing more recent left to find. */
async function fetchWithinWindow(fetchPage: (page: number) => Promise<KillEntry[]>, cutoff: number): Promise<KillEntry[]> {
  const results: KillEntry[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_FEED; page++) {
    const batch = await fetchPage(page);
    if (batch.length === 0) break;
    results.push(...batch);
    const oldest = batch[batch.length - 1];
    if (new Date(oldest.time).getTime() < cutoff) break;
  }
  return results.filter((k) => new Date(k.time).getTime() >= cutoff);
}

function fetchersFor(entity: TrackedEntity) {
  if (entity.kind === "character") {
    return { kills: (p: number) => getCharacterKills(entity.entity_id, p), losses: (p: number) => getCharacterLosses(entity.entity_id, p) };
  }
  if (entity.kind === "corporation") {
    return { kills: (p: number) => getCorporationKills(entity.entity_id, p), losses: (p: number) => getCorporationLosses(entity.entity_id, p) };
  }
  return { kills: (p: number) => getAllianceKills(entity.entity_id, p), losses: (p: number) => getAllianceLosses(entity.entity_id, p) };
}

interface TrackedEntityActivityFeedProps {
  entities: TrackedEntity[];
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

/** Every kill and loss involving anyone on the tracked list, merged into one
 * feed - a character and their corp/alliance can both be tracked at once, so
 * the same killmail could otherwise show up twice; deduped by killmail id,
 * keeping one row per kill regardless of how many tracked entities it
 * matched. */
function TrackedEntityActivityFeed({
  entities,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
}: TrackedEntityActivityFeedProps) {
  const [feed, setFeed] = useState<OutcomeEntry[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncToken, setSyncToken] = useState(0);
  const reportError = useErrorReporter();
  const [showNpcKills, setShowNpcKills] = useShowNpcKills();
  const [securityFilters, toggleSecurityFilter] = useSecurityBandFilters();
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");

  useEffect(() => {
    if (entities.length === 0) {
      setFeed([]);
      return;
    }
    let cancelled = false;
    // A manual re-sync (syncToken bump) keeps whatever's already on screen
    // and just shows the spinner, rather than blanking the table back to
    // "Loading..." the way switching the tracked list itself does.
    if (syncToken === 0) setFeed(null);
    setSyncing(true);
    const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    Promise.all(
      entities.map(async (entity) => {
        const { kills, losses } = fetchersFor(entity);
        const [killResults, lossResults] = await Promise.all([
          fetchWithinWindow(kills, cutoff).catch(() => []),
          fetchWithinWindow(losses, cutoff).catch(() => []),
        ]);
        return [
          ...killResults.map((k): OutcomeEntry => ({ ...k, outcome: "kill" })),
          ...lossResults.map((k): OutcomeEntry => ({ ...k, outcome: "loss" })),
        ];
      }),
    )
      .then((groups) => {
        if (cancelled) return;
        const byId = new Map<number, OutcomeEntry>();
        for (const group of groups) {
          for (const entry of group) {
            if (!byId.has(entry.killmail_id)) byId.set(entry.killmail_id, entry);
          }
        }
        setFeed([...byId.values()].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()));
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load tracked-list activity: ${String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, syncToken]);

  const visibleFeed = (feed ?? [])
    .filter((k) => outcomeFilter === "all" || k.outcome === outcomeFilter)
    .filter((k) => showNpcKills || !k.npc)
    .filter((k) => securityFilters[killSecurityBand(k.system_security, k.system_name)]);

  return (
    <div className="tracked-activity-feed">
      <p className="kills-feed-section-title">Kills &amp; Losses - Last {LOOKBACK_DAYS} Days</p>
      <div className="kills-watchlist-actions">
        <button type="button" className="kills-sync-btn" onClick={() => setSyncToken((n) => n + 1)} disabled={syncing || entities.length === 0}>
          <RefreshCw size={13} strokeWidth={2} className={syncing ? "kills-sync-spinning" : ""} />
          {syncing ? "Syncing..." : "Sync"}
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
        <div className="tracked-outcome-filter">
          <button
            type="button"
            className={`tracked-outcome-btn${outcomeFilter === "all" ? " tracked-outcome-btn-active" : ""}`}
            onClick={() => setOutcomeFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`tracked-outcome-btn tracked-outcome-btn-kill${outcomeFilter === "kill" ? " tracked-outcome-btn-active" : ""}`}
            onClick={() => setOutcomeFilter("kill")}
            title="Only show kills"
          >
            Kills
          </button>
          <button
            type="button"
            className={`tracked-outcome-btn tracked-outcome-btn-loss${outcomeFilter === "loss" ? " tracked-outcome-btn-active" : ""}`}
            onClick={() => setOutcomeFilter("loss")}
            title="Only show deaths"
          >
            Deaths
          </button>
        </div>
      </div>
      {feed === null ? (
        <p className="detail-empty">Loading activity for your tracked list...</p>
      ) : visibleFeed.length === 0 ? (
        <p className="detail-empty">
          {feed.length === 0
            ? `No kills or losses for your tracked list in the last ${LOOKBACK_DAYS} days.`
            : "Nothing matches the current filters."}
        </p>
      ) : (
        <KillFeedTable
          kills={visibleFeed}
          onSelectKill={onSelectKill}
          onSelectCharacter={onSelectCharacter}
          onSelectSystem={onSelectSystem}
          onSelectCorporation={onSelectCorporation}
          onSelectAlliance={onSelectAlliance}
          outcomeFor={(k) => (k as OutcomeEntry).outcome}
        />
      )}
    </div>
  );
}

export default TrackedEntityActivityFeed;
