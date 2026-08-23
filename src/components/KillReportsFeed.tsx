import { useEffect, useState } from "react";
import { queryKillReports, type KillEntry, type KillReportCategory } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { Pager, PAGE_SIZE } from "./killboardShared";
import KillFeedTable from "./KillFeedTable";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

interface KillReportsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

const CATEGORIES: { id: KillReportCategory; label: string; hint: string }[] = [
  { id: "top_kills", label: "Top Kills (5b+)", hint: "Kills worth 5 billion ISK or more" },
  { id: "big_kills", label: "Big Kills (10b+)", hint: "Kills worth 10 billion ISK or more" },
  { id: "capitals", label: "Capitals", hint: "Titans, Supercarriers, Carriers, Dreadnoughts, FAXes, Lancer Dreadnoughts" },
  { id: "structures", label: "Structures", hint: "Citadels, Engineering Complexes, Refineries, and other Upwell/mobile structures" },
  { id: "abyssal", label: "Abyssal", hint: "Kills inside an Abyssal Deadspace pocket" },
  { id: "abyssal_pvp", label: "Abyssal PvP", hint: "Abyssal kills involving another player, not just NPCs" },
  { id: "awox", label: "Awox", hint: "The final blow came from the victim's own corp or alliance" },
  {
    id: "ganked",
    label: "Ganked",
    hint: "The attacker who did this was later killed by CONCORD for it - needs VESPER's local kill history to have seen both kills",
  },
  { id: "solo", label: "Solo", hint: "Only one player involved on the attacking side" },
];

/** zKillboard-style kill classification filters, backed by VESPER's own
 * locally-recorded kill history (kill_history.rs) - verified feasible
 * category-by-category against zKillboard's own open-source repo before
 * building, rather than guessed. */
function KillReportsFeed({ onSelectKill, onSelectCharacter, onSelectSystem, onSelectCorporation, onSelectAlliance }: KillReportsFeedProps) {
  const [category, setCategory] = useState<KillReportCategory>("top_kills");
  const [kills, setKills] = useState<KillEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const reportError = useErrorReporter();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(1);
    queryKillReports(category)
      .then((results) => {
        if (!cancelled) setKills(results);
      })
      .catch((err) => {
        if (!cancelled) {
          reportError(`Failed to load "${category}" kill report: ${String(err)}`);
          setKills([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, reportError]);

  const active = CATEGORIES.find((c) => c.id === category)!;
  const pageCount = Math.max(1, Math.ceil((kills?.length ?? 0) / PAGE_SIZE));
  const paged = (kills ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <div className="kill-report-categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`kill-report-chip${category === c.id ? " kill-report-chip-active" : ""}`}
            onClick={() => setCategory(c.id)}
            title={c.hint}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="settings-section-hint">{active.hint}</p>

      <div className="kills-feed">
        {loading && !kills ? (
          <p className="detail-empty">Loading {active.label}...</p>
        ) : !kills || kills.length === 0 ? (
          <p className="detail-empty">
            No kills found for {active.label} yet - VESPER's local kill history only covers what it's seen since the recorder started.
          </p>
        ) : (
          <>
            <KillFeedTable
              kills={paged}
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

export default KillReportsFeed;
