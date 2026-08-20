import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  getAllianceCorporations,
  getAllianceKills,
  getAllianceLosses,
  getAllianceProfile,
  getAllianceStats,
  getAllianceSupers,
  type AllianceMemberCorp,
  type KillEntry,
  type AllianceProfile,
  type CharacterStats,
  type SupersReport,
} from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { usePaginatedKillFeed } from "../hooks/usePaginatedKillFeed";
import { formatIsk } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import EntityStatsPanel from "./EntityStatsPanel";
import SkeletonRows from "./SkeletonRows";
import BackToMapButton from "./BackToMapButton";
import { Pager, TopShowcase, TopListsSidebar, allianceLogoUrl, fmtNum, fmtRank, MONTH_NAMES, PAGE_SIZE } from "./killboardShared";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { MarketItemRef } from "./MarketBrowser";

export interface AllianceSummary {
  id: number;
  name: string;
}

type KillboardTab = "overview" | "kills" | "solo" | "losses" | "top" | "ranks" | "stats" | "supers" | "corps";

const TAB_LABELS: Record<KillboardTab, string> = {
  overview: "Overview",
  kills: "Kills",
  solo: "Solo",
  losses: "Losses",
  top: "Top",
  ranks: "Ranks",
  stats: "Stats",
  supers: "Supers",
  corps: "Corps",
};

const TAB_ORDER: KillboardTab[] = ["overview", "kills", "solo", "losses", "top", "ranks", "stats", "supers", "corps"];

const SIDEBAR_TABS: KillboardTab[] = ["overview", "kills", "solo", "losses"];

interface OverviewEntry extends KillEntry {
  outcome: "kill" | "loss";
}

interface AllianceKillboardProps {
  alliance: AllianceSummary;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  onSelectItem: (item: MarketItemRef) => void;
  rootLabel: string;
  onGoHome: () => void;
  onGoToMap: () => void;
}

function AllianceKillboard({
  alliance,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  onSelectItem,
  rootLabel,
  onGoHome,
  onGoToMap,
}: AllianceKillboardProps) {
  const [profile, setProfile] = useState<AllianceProfile | null>(null);
  const [stats, setStats] = useState<CharacterStats | null>(null);
  const [tab, setTab] = useState<KillboardTab>("overview");
  const [supers, setSupers] = useState<SupersReport | null>(null);
  const [corps, setCorps] = useState<AllianceMemberCorp[] | null>(null);
  const [corpQuery, setCorpQuery] = useState("");
  const [page, setPage] = useState(1);
  const reportError = useErrorReporter();

  const { items: kills, exhausted: killsExhausted, ensureLoadedThrough: ensureKillsLoaded } = usePaginatedKillFeed(
    (p) => getAllianceKills(alliance.id, p),
    alliance.id,
  );
  const { items: losses, exhausted: lossesExhausted, ensureLoadedThrough: ensureLossesLoaded } = usePaginatedKillFeed(
    (p) => getAllianceLosses(alliance.id, p),
    alliance.id,
  );

  useEffect(() => {
    setProfile(null);
    setStats(null);
    setSupers(null);
    setCorps(null);
    setCorpQuery("");
    setTab("overview");
    setPage(1);

    getAllianceProfile(alliance.id)
      .then(setProfile)
      .catch((err) => reportError(`Failed to load alliance profile: ${String(err)}`));
    getAllianceStats(alliance.id)
      .then(setStats)
      .catch((err) => reportError(`Failed to load alliance stats: ${String(err)}`));
    getAllianceSupers(alliance.id)
      .then(setSupers)
      .catch((err) => reportError(`Failed to load supers for ${alliance.name}: ${String(err)}`));
    getAllianceCorporations(alliance.id)
      .then(setCorps)
      .catch((err) => reportError(`Failed to load member corporations for ${alliance.name}: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alliance.id]);

  useEffect(() => {
    setPage(1);
  }, [tab]);

  const overviewFeed: OverviewEntry[] = useMemo(() => {
    const merged: OverviewEntry[] = [
      ...(kills ?? []).map((k) => ({ ...k, outcome: "kill" as const })),
      ...(losses ?? []).map((k) => ({ ...k, outcome: "loss" as const })),
    ];
    merged.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return merged;
  }, [kills, losses]);

  const soloFeed = useMemo(() => overviewFeed.filter((k) => k.solo), [overviewFeed]);

  const topKills = useMemo(() => (kills ?? []).slice().sort((a, b) => b.total_value - a.total_value).slice(0, 3), [kills]);
  const topLosses = useMemo(() => (losses ?? []).slice().sort((a, b) => b.total_value - a.total_value).slice(0, 3), [losses]);

  const pagedOverview = overviewFeed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const overviewExhausted = killsExhausted && lossesExhausted;
  const overviewPageCount = Math.max(1, Math.ceil(overviewFeed.length / PAGE_SIZE) + (overviewExhausted ? 0 : 1));
  const pagedKills = (kills ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const killsPageCount = Math.max(1, Math.ceil((kills ?? []).length / PAGE_SIZE) + (killsExhausted ? 0 : 1));
  const pagedLosses = (losses ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const lossesPageCount = Math.max(1, Math.ceil((losses ?? []).length / PAGE_SIZE) + (lossesExhausted ? 0 : 1));

  async function changeOverviewPage(p: number) {
    await Promise.all([ensureKillsLoaded(p * PAGE_SIZE), ensureLossesLoaded(p * PAGE_SIZE)]);
    setPage(p);
  }

  async function changeKillsPage(p: number) {
    await ensureKillsLoaded(p * PAGE_SIZE);
    setPage(p);
  }

  async function changeLossesPage(p: number) {
    await ensureLossesLoaded(p * PAGE_SIZE);
    setPage(p);
  }

  const monthGroups = useMemo(() => {
    const monthlyList = stats?.monthly ?? [];
    const groups: { year: number; rows: typeof monthlyList }[] = [];
    for (const m of monthlyList) {
      const last = groups[groups.length - 1];
      if (last && last.year === m.year) last.rows.push(m);
      else groups.push({ year: m.year, rows: [m] });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  const totalMembers = useMemo(() => (corps ?? []).reduce((sum, c) => sum + c.member_count, 0), [corps]);

  const filteredCorps = useMemo(() => {
    const q = corpQuery.trim().toLowerCase();
    if (!q) return corps ?? [];
    return (corps ?? []).filter(
      (c) => c.corporation_name.toLowerCase().includes(q) || c.corporation_ticker.toLowerCase().includes(q),
    );
  }, [corps, corpQuery]);
  const pagedCorps = filteredCorps.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const corpsPageCount = Math.max(1, Math.ceil(filteredCorps.length / PAGE_SIZE));

  const sidebar = stats ? (
    <TopListsSidebar
      topLists={stats.top_lists}
      onSelectCharacter={onSelectCharacter}
      onSelectCorporation={onSelectCorporation}
      onSelectSystem={onSelectSystem}
      onSelectItem={onSelectItem}
    />
  ) : null;
  const wrapWithSidebar = (content: React.ReactNode) =>
    SIDEBAR_TABS.includes(tab) ? (
      <div className="kills-feed-with-sidebar">
        <div>{content}</div>
        {sidebar}
      </div>
    ) : (
      content
    );

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header kills-header-breadcrumb">
          <p className="eyebrow">Kills & Intel</p>
          <h2
            className="kills-breadcrumb-link"
            role="button"
            tabIndex={0}
            onClick={onGoHome}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onGoHome();
              }
            }}
          >
            {rootLabel}
          </h2>
        </div>

        <div className="kills-nav-buttons">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          <BackToMapButton onClick={onGoToMap} />
        </div>

        {!profile ? (
          <p className="detail-empty">Loading alliance...</p>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-avatar">
                <img className="detail-portrait" src={allianceLogoUrl(profile.alliance_id, 128)} alt="" />
              </div>
              <div className="detail-identity">
                <h2>
                  {profile.alliance_name}
                  {profile.alliance_ticker ? ` <${profile.alliance_ticker}>` : ""}
                </h2>
                <div className="detail-stats-row">
                  {profile.executor_corporation_name && (
                    <span>
                      Executor:{" "}
                      <span
                        className="kills-system-clickable"
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          onSelectCorporation({
                            id: profile.executor_corporation_id!,
                            name: profile.executor_corporation_name ?? "",
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectCorporation({
                              id: profile.executor_corporation_id!,
                              name: profile.executor_corporation_name ?? "",
                            });
                          }
                        }}
                      >
                        {profile.executor_corporation_name}
                      </span>
                    </span>
                  )}
                  {profile.founder_name && (
                    <>
                      <span className="detail-stats-sep">//</span>
                      <span>
                        Founder:{" "}
                        <span
                          className="kills-system-clickable"
                          role="button"
                          tabIndex={0}
                          onClick={() => onSelectCharacter(profile.founder_id!)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSelectCharacter(profile.founder_id!);
                            }
                          }}
                        >
                          {profile.founder_name}
                        </span>
                      </span>
                    </>
                  )}
                  {profile.date_founded && (
                    <>
                      <span className="detail-stats-sep">//</span>
                      <span>Founded {new Date(profile.date_founded).toLocaleDateString([], { timeZone: "UTC" })}</span>
                    </>
                  )}
                  {corps && (
                    <>
                      <span className="detail-stats-sep">//</span>
                      <span>{fmtNum(totalMembers)} members</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {stats && <EntityStatsPanel stats={stats} />}

            <div className="kills-tabs">
              {TAB_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`kills-tab ${tab === t ? "kills-tab-active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
            </div>

            <div className="kills-feed">
              {tab === "overview"
                ? wrapWithSidebar(
                    <>
                      <TopShowcase items={topKills} variant="kill" onSelectKill={onSelectKill} />
                      <h3 className="kills-feed-heading">Kills</h3>
                      {kills === null && losses === null ? (
                        <SkeletonRows />
                      ) : overviewFeed.length === 0 ? (
                        <p className="detail-empty">No activity recorded.</p>
                      ) : (
                        <>
                          <KillFeedTable
                            kills={pagedOverview}
                            onSelectKill={onSelectKill}
                            onSelectCharacter={onSelectCharacter}
                            onSelectSystem={onSelectSystem}
                            onSelectCorporation={onSelectCorporation}
                            onSelectAlliance={onSelectAlliance}
                            outcomeFor={(k) => (k as OverviewEntry).outcome}
                          />
                          <Pager page={page} pageCount={overviewPageCount} onChange={changeOverviewPage} />
                        </>
                      )}
                    </>,
                  )
                : tab === "kills"
                ? wrapWithSidebar(
                    <>
                      <TopShowcase items={topKills} variant="kill" onSelectKill={onSelectKill} />
                      <h3 className="kills-feed-heading">Kills</h3>
                      {kills === null ? (
                        <SkeletonRows />
                      ) : kills.length === 0 ? (
                        <p className="detail-empty">No kills recorded.</p>
                      ) : (
                        <>
                          <KillFeedTable
                            kills={pagedKills}
                            onSelectKill={onSelectKill}
                            onSelectCharacter={onSelectCharacter}
                            onSelectSystem={onSelectSystem}
                            onSelectCorporation={onSelectCorporation}
                            onSelectAlliance={onSelectAlliance}
                            outcomeFor={() => "kill"}
                          />
                          <Pager page={page} pageCount={killsPageCount} onChange={changeKillsPage} />
                        </>
                      )}
                    </>,
                  )
                : tab === "solo"
                ? wrapWithSidebar(
                    soloFeed.length === 0 ? (
                      <p className="detail-empty">No solo activity recorded.</p>
                    ) : (
                      <KillFeedTable
                        kills={soloFeed}
                        onSelectKill={onSelectKill}
                        onSelectCharacter={onSelectCharacter}
                        onSelectSystem={onSelectSystem}
                        onSelectCorporation={onSelectCorporation}
                        onSelectAlliance={onSelectAlliance}
                        outcomeFor={(k) => (k as OverviewEntry).outcome}
                      />
                    ),
                  )
                : tab === "losses"
                ? wrapWithSidebar(
                    <>
                      <TopShowcase items={topLosses} variant="loss" onSelectKill={onSelectKill} />
                      <h3 className="kills-feed-heading">Losses</h3>
                      {losses === null ? (
                        <SkeletonRows />
                      ) : losses.length === 0 ? (
                        <p className="detail-empty">No losses recorded.</p>
                      ) : (
                        <>
                          <KillFeedTable
                            kills={pagedLosses}
                            onSelectKill={onSelectKill}
                            onSelectCharacter={onSelectCharacter}
                            onSelectSystem={onSelectSystem}
                            onSelectCorporation={onSelectCorporation}
                            onSelectAlliance={onSelectAlliance}
                            outcomeFor={() => "loss"}
                          />
                          <Pager page={page} pageCount={lossesPageCount} onChange={changeLossesPage} />
                        </>
                      )}
                    </>,
                  )
                : tab === "top"
                ? !stats || stats.top_lists.length === 0 ? (
                    <p className="detail-empty">No top-list data recorded.</p>
                  ) : (
                    <div className="top-lists-grid">
                      {stats.top_lists.map((t) => (
                        <div key={t.list_type} className="top-list-panel">
                          <p className="top-list-panel-title">{t.title}</p>
                          {t.values.length === 0 ? (
                            <p className="detail-empty">No data.</p>
                          ) : (
                            <div className="top-list-panel-scroll">
                              <table className="data-table">
                                <thead>
                                  <tr>
                                    <th>#</th>
                                    <th>Name</th>
                                    <th className="data-table-numeric">Kills</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {t.values.map((v, i) => (
                                    <tr key={v.id ?? i}>
                                      <td>{i + 1}</td>
                                      <td>{v.name ?? "Unknown"}</td>
                                      <td className="data-table-numeric">{v.kills}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                : tab === "ranks"
                ? !stats ? (
                    <SkeletonRows count={3} height={64} />
                  ) : (
                    <>
                      <div className="ranks-headline-row">
                        {(["weekly", "recent", "alltime"] as const).map((w) => (
                          <div key={w} className="ranks-headline-card">
                            <p className="eyebrow">{w === "weekly" ? "7 Day Rank" : w === "recent" ? "90 Day Rank" : "Alltime Rank"}</p>
                            <div className="ranks-headline-number">{fmtRank(stats.rankings[w].all.ranks.overall)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="data-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Window</th>
                              <th className="data-table-numeric">Overall</th>
                              <th className="data-table-numeric">Ships Destroyed</th>
                              <th className="data-table-numeric">Ships Lost</th>
                              <th className="data-table-numeric">ISK Destroyed</th>
                              <th className="data-table-numeric">ISK Lost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(["alltime", "recent", "weekly"] as const).map((w) => {
                              const r = stats.rankings[w].all.ranks;
                              const windowLabel = w === "alltime" ? "Alltime" : w === "recent" ? "Recent 90d" : "Weekly 7d";
                              return (
                                <tr key={w}>
                                  <td>{windowLabel}</td>
                                  <td className="data-table-numeric">{fmtRank(r.overall)}</td>
                                  <td className="data-table-numeric character-stats-destroyed">{fmtRank(r.ships_destroyed)}</td>
                                  <td className="data-table-numeric character-stats-lost">{fmtRank(r.ships_lost)}</td>
                                  <td className="data-table-numeric character-stats-destroyed">{fmtRank(r.isk_destroyed)}</td>
                                  <td className="data-table-numeric character-stats-lost">{fmtRank(r.isk_lost)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )
                : tab === "stats"
                ? !stats ? (
                    <SkeletonRows count={4} height={64} />
                  ) : (
                    <>
                      <p className="kills-feed-section-title">Summary</p>
                      <div className="data-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Ship Class</th>
                              <th className="data-table-numeric">Killed</th>
                              <th className="data-table-numeric">Lost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stats.ship_classes.map((s) => (
                              <tr key={s.group_id}>
                                <td>{s.group_name}</td>
                                <td className="data-table-numeric character-stats-destroyed">{s.ships_destroyed > 0 ? fmtNum(s.ships_destroyed) : "—"}</td>
                                <td className="data-table-numeric character-stats-lost">{s.ships_lost > 0 ? fmtNum(s.ships_lost) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <p className="kills-feed-section-title kills-feed-section-title-spaced">Monthly History</p>
                      <div className="data-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Month</th>
                              <th className="data-table-numeric">Kills</th>
                              <th className="data-table-numeric">Points</th>
                              <th className="data-table-numeric">ISK</th>
                              <th className="data-table-numeric">Losses</th>
                              <th className="data-table-numeric">Points</th>
                              <th className="data-table-numeric">ISK</th>
                              <th className="data-table-numeric">Efficiency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthGroups.map((g) => (
                              <Fragment key={g.year}>
                                <tr className="kills-year-divider-row">
                                  <td colSpan={8}>{g.year}</td>
                                </tr>
                                {g.rows.map((m) => {
                                  const totalIsk = m.isk_destroyed + m.isk_lost;
                                  const efficiency = totalIsk > 0 ? (m.isk_destroyed / totalIsk) * 100 : 100;
                                  return (
                                    <tr key={`${m.year}-${m.month}`}>
                                      <td>{MONTH_NAMES[m.month - 1]}</td>
                                      <td className="data-table-numeric character-stats-destroyed">{m.ships_destroyed > 0 ? fmtNum(m.ships_destroyed) : "—"}</td>
                                      <td className="data-table-numeric character-stats-destroyed">{m.points_destroyed > 0 ? fmtNum(m.points_destroyed) : "—"}</td>
                                      <td className="data-table-numeric character-stats-destroyed">{m.isk_destroyed > 0 ? formatIsk(m.isk_destroyed) : "—"}</td>
                                      <td className="data-table-numeric character-stats-lost">{m.ships_lost > 0 ? fmtNum(m.ships_lost) : "—"}</td>
                                      <td className="data-table-numeric character-stats-lost">{m.points_lost > 0 ? fmtNum(m.points_lost) : "—"}</td>
                                      <td className="data-table-numeric character-stats-lost">{m.isk_lost > 0 ? formatIsk(m.isk_lost) : "—"}</td>
                                      <td className={`data-table-numeric ${efficiency >= 50 ? "character-stats-destroyed" : "character-stats-lost"}`}>
                                        {efficiency.toFixed(1)}%
                                      </td>
                                    </tr>
                                  );
                                })}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )
                : tab === "supers"
                ? !supers ? (
                    <SkeletonRows count={4} height={40} />
                  ) : (
                    <>
                      <p className="kills-feed-section-title">Intel - Supers (Last 7 Days)</p>
                      <div className="top-lists-grid">
                        <div className="top-list-panel">
                          <p className="top-list-panel-title">Titans</p>
                          {supers.titans.length === 0 ? (
                            <p className="detail-empty">No data.</p>
                          ) : (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Character</th>
                                  <th className="data-table-numeric">Kills</th>
                                </tr>
                              </thead>
                              <tbody>
                                {supers.titans.map((s) => (
                                  <tr key={s.character_id}>
                                    <td>
                                      <span
                                        className="kills-system-clickable"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => onSelectCharacter(s.character_id)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            onSelectCharacter(s.character_id);
                                          }
                                        }}
                                      >
                                        {s.character_name}
                                      </span>
                                    </td>
                                    <td className="data-table-numeric character-stats-destroyed">{s.kills}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                        <div className="top-list-panel">
                          <p className="top-list-panel-title">Supercarriers</p>
                          {supers.supercarriers.length === 0 ? (
                            <p className="detail-empty">No data.</p>
                          ) : (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Character</th>
                                  <th className="data-table-numeric">Kills</th>
                                </tr>
                              </thead>
                              <tbody>
                                {supers.supercarriers.map((s) => (
                                  <tr key={s.character_id}>
                                    <td>
                                      <span
                                        className="kills-system-clickable"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => onSelectCharacter(s.character_id)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            onSelectCharacter(s.character_id);
                                          }
                                        }}
                                      >
                                        {s.character_name}
                                      </span>
                                    </td>
                                    <td className="data-table-numeric character-stats-destroyed">{s.kills}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </>
                  )
                : tab === "corps"
                ? !corps ? (
                    <SkeletonRows count={6} height={40} />
                  ) : (
                    <>
                      <div className="kills-corps-search">
                        <input
                          type="text"
                          placeholder="Search member corporations..."
                          value={corpQuery}
                          onChange={(e) => setCorpQuery(e.target.value)}
                        />
                      </div>
                      {filteredCorps.length === 0 ? (
                        <p className="detail-empty">No member corporations found.</p>
                      ) : (
                        <>
                          <div className="data-table-wrap">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Ticker</th>
                                  <th>Corporation</th>
                                  <th className="data-table-numeric">Members</th>
                                  <th>CEO</th>
                                </tr>
                              </thead>
                              <tbody>
                                {pagedCorps.map((c) => (
                                  <tr key={c.corporation_id}>
                                    <td>[{c.corporation_ticker}]</td>
                                    <td>
                                      <span
                                        className="kills-system-clickable"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => onSelectCorporation({ id: c.corporation_id, name: c.corporation_name })}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            onSelectCorporation({ id: c.corporation_id, name: c.corporation_name });
                                          }
                                        }}
                                      >
                                        {c.corporation_name}
                                      </span>
                                    </td>
                                    <td className="data-table-numeric">{fmtNum(c.member_count)}</td>
                                    <td>
                                      {c.ceo_name ? (
                                        <span
                                          className="kills-system-clickable"
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => onSelectCharacter(c.ceo_id!)}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                              e.preventDefault();
                                              onSelectCharacter(c.ceo_id!);
                                            }
                                          }}
                                        >
                                          {c.ceo_name}
                                        </span>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <Pager page={page} pageCount={corpsPageCount} onChange={setPage} />
                        </>
                      )}
                    </>
                  )
                : null}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default AllianceKillboard;
