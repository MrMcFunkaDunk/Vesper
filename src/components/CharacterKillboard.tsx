import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  getCharacterProfile,
  getCharacterKills,
  getCharacterLosses,
  getCharacterStats,
  type CharacterProfile,
  type CharacterStats,
  type KillEntry,
} from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { usePaginatedKillFeed } from "../hooks/usePaginatedKillFeed";
import { formatIsk } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import EntityStatsPanel from "./EntityStatsPanel";
import SkeletonRows from "./SkeletonRows";
import { Pager, TopShowcase, TopListsSidebar, corpLogoUrl, allianceLogoUrl, fmtNum, fmtRank, MONTH_NAMES, PAGE_SIZE } from "./killboardShared";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";
import type { MarketItemRef } from "./MarketBrowser";
import BackToMapButton from "./BackToMapButton";
import TrackEntityButton from "./TrackEntityButton";

type KillboardTab = "overview" | "kills" | "solo" | "losses" | "trophies" | "top" | "ranks" | "stats";

const TAB_LABELS: Record<KillboardTab, string> = {
  overview: "Overview",
  kills: "Kills",
  solo: "Solo",
  losses: "Losses",
  trophies: "Trophies",
  top: "Top",
  ranks: "Ranks",
  stats: "Stats",
};

const TAB_ORDER: KillboardTab[] = ["overview", "kills", "solo", "losses", "trophies", "top", "ranks", "stats"];

/** Maps zKillboard's raw stat "labels" to display names for the Trophies
 * tab. Category (cat:*) and faction-warfare (fw:*) labels are left out -
 * without a local category-id/faction-id lookup they'd show as bare
 * numbers, less legible than the rest of the badges. */
const TROPHY_LABELS: Record<string, string> = {
  solo: "Solo Kills",
  capital: "Capital Kills",
  awox: "Awoxes",
  concord: "CONCORDed",
  ganked: "Ganks",
  bigisk: "1B+ ISK Kills",
  extremeisk: "10B+ ISK Kills",
  "isk:1b+": "1B+ ISK Kills",
  "isk:5b+": "5B+ ISK Kills",
  "isk:10b+": "10B+ ISK Kills",
  "isk:100b+": "100B+ ISK Kills",
  "loc:highsec": "Highsec Kills",
  "loc:lowsec": "Lowsec Kills",
  "loc:nullsec": "Nullsec Kills",
  "loc:w-space": "Wormhole Kills",
  "tz:eu": "EU Timezone Kills",
  "tz:ru": "RU Timezone Kills",
  "tz:us": "US Timezone Kills",
  "tz:use": "US East Kills",
  "tz:usw": "US West Kills",
  "tz:au": "AU Timezone Kills",
  "#:1": "Solo (1 Attacker)",
  "#:2+": "2+ Man Gangs",
  "#:5+": "5+ Man Gangs",
  "#:10+": "10+ Man Gangs",
  "#:25+": "25+ Man Fleets",
  "#:50+": "50+ Man Fleets",
  "#:100+": "100+ Man Fleets",
  "#:1000+": "1000+ Man Fleets",
};

function trophyLabel(key: string): string | null {
  if (key.startsWith("cat:") || key.startsWith("fw:") || key === "pvp" || key === "atShip") return null;
  return TROPHY_LABELS[key] ?? key;
}

/** Which raw label keys go in the Trophies tab's "General" panel (location
 * and gang-size breakdowns) vs "Special" panel (notable kill types). */
const GENERAL_LABEL_KEYS = [
  "solo",
  "#:1",
  "#:2+",
  "#:5+",
  "#:10+",
  "#:25+",
  "#:50+",
  "#:100+",
  "#:1000+",
  "loc:highsec",
  "loc:lowsec",
  "loc:nullsec",
  "loc:w-space",
];
const SPECIAL_LABEL_KEYS = ["capital", "awox", "concord", "ganked", "bigisk", "extremeisk", "isk:1b+", "isk:5b+", "isk:10b+", "isk:100b+"];

const SIDEBAR_TABS: KillboardTab[] = ["overview", "kills", "solo", "losses"];

interface OverviewEntry extends KillEntry {
  outcome: "kill" | "loss";
}

interface CharacterKillboardProps {
  characterId: number;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  onSelectItem: (item: MarketItemRef) => void;
  breadcrumb: ReactNode;
  onLabelReady?: (label: string) => void;
  onGoToMap: () => void;
}

function CharacterKillboard({
  characterId,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  onSelectItem,
  breadcrumb,
  onLabelReady,
  onGoToMap,
}: CharacterKillboardProps) {
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [stats, setStats] = useState<CharacterStats | null>(null);
  const [tab, setTab] = useState<KillboardTab>("overview");
  const [page, setPage] = useState(1);
  const [copiedEveWho, setCopiedEveWho] = useState(false);
  const reportError = useErrorReporter();

  const { items: kills, exhausted: killsExhausted, ensureLoadedThrough: ensureKillsLoaded } = usePaginatedKillFeed(
    (p) => getCharacterKills(characterId, p),
    characterId,
  );
  const { items: losses, exhausted: lossesExhausted, ensureLoadedThrough: ensureLossesLoaded } = usePaginatedKillFeed(
    (p) => getCharacterLosses(characterId, p),
    characterId,
  );

  function copyEveWhoLink() {
    if (!profile) return;
    navigator.clipboard
      .writeText(`https://evewho.com/character/${profile.character_id}`)
      .then(() => {
        setCopiedEveWho(true);
        setTimeout(() => setCopiedEveWho(false), 1500);
      })
      .catch((err) => reportError(`Couldn't copy to clipboard: ${String(err)}`));
  }

  useEffect(() => {
    setProfile(null);
    setStats(null);
    setTab("overview");
    setPage(1);

    getCharacterProfile(characterId)
      .then((p) => {
        setProfile(p);
        onLabelReady?.(p.character_name);
      })
      .catch((err) => reportError(`Failed to load character profile: ${String(err)}`));

    getCharacterStats(characterId)
      .then(setStats)
      .catch((err) => reportError(`Failed to load character stats: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

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

  const soloFeed = useMemo(
    () => overviewFeed.filter((k) => k.solo),
    [overviewFeed],
  );

  const topKills = useMemo(
    () => (kills ?? []).slice().sort((a, b) => b.total_value - a.total_value).slice(0, 3),
    [kills],
  );
  const topLosses = useMemo(
    () => (losses ?? []).slice().sort((a, b) => b.total_value - a.total_value).slice(0, 3),
    [losses],
  );

  // Page counts leave one extra clickable page beyond what's currently
  // loaded whenever the underlying zKillboard feed isn't known to be
  // exhausted yet, so the pager's next/last buttons stay enabled and
  // clicking them triggers ensureLoadedThrough to fetch further real
  // history instead of looking like the feed already ends there.
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

  const shipClassesKilled = (stats?.ship_classes ?? []).filter((s) => s.ships_destroyed > 0);
  const shipClassesLost = (stats?.ship_classes ?? []).filter((s) => s.ships_lost > 0);

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
        {breadcrumb}

        <div className="kills-nav-buttons">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          <BackToMapButton onClick={onGoToMap} />
        </div>

        {!profile ? (
          <p className="detail-empty">Loading character...</p>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-avatar">
                <img
                  className="detail-portrait"
                  src={`https://images.evetech.net/characters/${profile.character_id}/portrait?size=128`}
                  alt=""
                />
                <div className="detail-logo-stack">
                  <img
                    className="detail-logo"
                    src={corpLogoUrl(profile.corporation_id)}
                    alt=""
                    title={profile.corporation_name ?? undefined}
                  />
                  {profile.alliance_id && (
                    <img
                      className="detail-logo"
                      src={allianceLogoUrl(profile.alliance_id)}
                      alt=""
                      title={profile.alliance_name ?? undefined}
                    />
                  )}
                </div>
              </div>
              <div className="detail-identity">
                <div className="detail-identity-title-row">
                  <h2>{profile.character_name}</h2>
                  <TrackEntityButton entityId={profile.character_id} entityName={profile.character_name} kind="character" />
                </div>
                <span className="detail-corp">
                  {profile.corporation_name ? (
                    <span
                      className="kills-system-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectCorporation({ id: profile.corporation_id, name: profile.corporation_name! })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectCorporation({ id: profile.corporation_id, name: profile.corporation_name! });
                        }
                      }}
                    >
                      {profile.corporation_name}
                    </span>
                  ) : (
                    "—"
                  )}
                  {profile.corporation_ticker ? ` [${profile.corporation_ticker}]` : ""}
                  {profile.alliance_name && profile.alliance_id ? (
                    <>
                      {" • "}
                      <span
                        className="kills-system-clickable"
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectAlliance({ id: profile.alliance_id!, name: profile.alliance_name! })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectAlliance({ id: profile.alliance_id!, name: profile.alliance_name! });
                          }
                        }}
                      >
                        {profile.alliance_name}
                      </span>
                    </>
                  ) : (
                    ""
                  )}
                  {profile.alliance_ticker ? ` <${profile.alliance_ticker}>` : ""}
                </span>
                <div className="detail-stats-row">
                  {profile.security_status != null && (
                    <span
                      className={
                        profile.security_status >= 0 ? "character-security-positive" : "character-security-negative"
                      }
                    >
                      Sec. Status: {profile.security_status.toFixed(2)}
                    </span>
                  )}
                  {profile.birthday && (
                    <>
                      <span className="detail-stats-sep">//</span>
                      <span>Since {new Date(profile.birthday).toLocaleDateString([], { timeZone: "UTC" })}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="kill-export-row">
              <button type="button" className="kill-export-btn" onClick={copyEveWhoLink}>
                <ExternalLink size={13} strokeWidth={2} />
                {copiedEveWho ? "Copied" : "Copy EVEWho Link"}
              </button>
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
              {tab === "overview" ? (
                wrapWithSidebar(
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
              ) : tab === "kills" ? (
                wrapWithSidebar(
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
              ) : tab === "solo" ? (
                wrapWithSidebar(
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
              ) : tab === "losses" ? (
                wrapWithSidebar(
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
              ) : tab === "trophies" ? (
                !stats ? (
                  <SkeletonRows count={4} height={64} />
                ) : (
                  <div className="trophy-section-grid">
                    <div className="trophy-panel">
                      <p className="trophy-panel-title">General</p>
                      <table className="trophy-panel-table">
                        <tbody>
                          <tr>
                            <td>Total Kills</td>
                            <td className="data-table-numeric character-stats-destroyed">{fmtNum(stats.ships_destroyed)}</td>
                          </tr>
                          <tr>
                            <td>Total Losses</td>
                            <td className="data-table-numeric character-stats-lost">{fmtNum(stats.ships_lost)}</td>
                          </tr>
                          {stats.trophies
                            .filter((t) => GENERAL_LABEL_KEYS.includes(t.label))
                            .map((t) => (
                              <tr key={t.label}>
                                <td>{trophyLabel(t.label)}</td>
                                <td className="data-table-numeric character-stats-destroyed">{fmtNum(t.ships_destroyed)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="trophy-panel">
                      <p className="trophy-panel-title">Special</p>
                      {(() => {
                        const rows = stats.trophies.filter((t) => SPECIAL_LABEL_KEYS.includes(t.label));
                        return rows.length === 0 ? (
                          <p className="detail-empty">None recorded.</p>
                        ) : (
                          <table className="trophy-panel-table">
                            <tbody>
                              {rows.map((t) => (
                                <tr key={t.label}>
                                  <td>{trophyLabel(t.label)}</td>
                                  <td className="data-table-numeric character-stats-destroyed">{fmtNum(t.ships_destroyed)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        );
                      })()}
                    </div>

                    <div className="trophy-panel">
                      <p className="trophy-panel-title">Killed</p>
                      {shipClassesKilled.length === 0 ? (
                        <p className="detail-empty">None recorded.</p>
                      ) : (
                        <table className="trophy-panel-table">
                          <tbody>
                            {shipClassesKilled.map((s) => (
                              <tr key={s.group_id}>
                                <td>{s.group_name}</td>
                                <td className="data-table-numeric character-stats-destroyed">{fmtNum(s.ships_destroyed)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div className="trophy-panel">
                      <p className="trophy-panel-title">Lost</p>
                      {shipClassesLost.length === 0 ? (
                        <p className="detail-empty">None recorded.</p>
                      ) : (
                        <table className="trophy-panel-table">
                          <tbody>
                            {shipClassesLost.map((s) => (
                              <tr key={s.group_id}>
                                <td>{s.group_name}</td>
                                <td className="data-table-numeric character-stats-lost">{fmtNum(s.ships_lost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )
              ) : tab === "top" ? (
                !stats || stats.top_lists.length === 0 ? (
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
              ) : tab === "ranks" ? (
                !stats ? (
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
              ) : tab === "stats" ? (
                !stats ? (
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
              ) : null}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default CharacterKillboard;
