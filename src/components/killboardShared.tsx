import { formatIsk } from "../lib/format";
import { searchSystem, type KillEntry, type TopList, type TopListEntry } from "../lib/kills";
import type { SecurityBandFilters } from "../hooks/useSecurityBandFilters";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { MarketItemRef } from "./MarketBrowser";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const PAGE_SIZE = 10;

export function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtRank(rank: number): string {
  return rank > 0 ? `#${fmtNum(rank)}` : "—";
}

export function corpLogoUrl(id: number, size: 64 | 128 = 64): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=${size}`;
}

export function allianceLogoUrl(id: number, size: 64 | 128 = 64): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=${size}`;
}

interface PagerProps {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}

/** Page-number pager matching zKillboard's own "« 1 2 3 4 »" control. */
export function Pager({ page, pageCount, onChange }: PagerProps) {
  if (pageCount <= 1) return null;
  const nums = Array.from({ length: pageCount }, (_, i) => i + 1).slice(0, 6);
  return (
    <div className="kills-pager">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        «
      </button>
      {nums.map((n) => (
        <button key={n} type="button" className={n === page ? "kills-pager-active" : ""} onClick={() => onChange(n)}>
          {n}
        </button>
      ))}
      {pageCount > nums.length && <span className="kills-pager-ellipsis">…</span>}
      <button type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        »
      </button>
    </div>
  );
}

const SECURITY_BAND_OPTIONS: { key: keyof SecurityBandFilters; label: string; className: string }[] = [
  { key: "highsec", label: "High", className: "kills-secband-high" },
  { key: "lowsec", label: "Low", className: "kills-secband-low" },
  { key: "nullsec", label: "Null", className: "kills-secband-null" },
  { key: "wspace", label: "W-Space", className: "kills-secband-wspace" },
];

interface SecurityBandFilterBarProps {
  filters: SecurityBandFilters;
  onToggle: (band: keyof SecurityBandFilters) => void;
}

/** Four independent on/off toggles (highsec/lowsec/nullsec/w-space) - real,
 * documented zKillboard API filter parameters, applied client-side here
 * since every KillEntry already carries what's needed to bucket it. Shared
 * between Recent Kills and Tracked Systems so the same small button row
 * doesn't drift between the two. */
export function SecurityBandFilterBar({ filters, onToggle }: SecurityBandFilterBarProps) {
  return (
    <div className="kills-secband-bar">
      {SECURITY_BAND_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`kills-secband-btn ${opt.className}${filters[opt.key] ? "" : " kills-secband-off"}`}
          onClick={() => onToggle(opt.key)}
          title={filters[opt.key] ? `Hide ${opt.label} kills` : `Show ${opt.label} kills`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

interface TopShowcaseProps {
  items: KillEntry[];
  variant: "kill" | "loss";
  onSelectKill: (killmailId: number) => void;
}

/** "Most Valuable Kills/Losses - All Time" showcase strip, matching
 * zKillboard's own Overview/Kills/Losses tab header cards. */
export function TopShowcase({ items, variant, onSelectKill }: TopShowcaseProps) {
  if (items.length === 0) return null;
  return (
    <>
      <p className="kills-feed-section-title">Most Valuable {variant === "kill" ? "Kills" : "Losses"} - All Time</p>
      <div className="top-kills-showcase">
        {items.map((k) => (
          <button
            key={k.killmail_id}
            type="button"
            className={`top-kill-card${variant === "loss" ? " top-kill-card-loss" : ""}`}
            onClick={() => onSelectKill(k.killmail_id)}
          >
            <img className="top-kill-card-ship" src={`https://images.evetech.net/types/${k.ship_type_id}/render?size=128`} alt="" />
            <span className="top-kill-card-value">{formatIsk(k.total_value)}</span>
            <span className="top-kill-card-name">
              {variant === "kill" ? (k.victim_character_name ?? k.ship_type_name) : (k.final_blow_character_name ?? k.ship_type_name)}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

const SIDEBAR_ROWS = 5;

interface TopListsSidebarProps {
  topLists: TopList[];
  onSelectCharacter: (characterId: number) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectItem: (item: MarketItemRef) => void;
}

/** Persistent "Top Characters/Corporations/Ships/Systems/Locations" panel
 * shown alongside a corp/alliance's Overview/Kills/Solo/Losses tabs,
 * matching zKillboard's own killboard sidebar. Deliberately drops the
 * "Top Alliances" list zKillboard's raw topLists carries - on a corp or
 * alliance page that list is almost entirely the page's own alliance, not
 * useful intel - and caps each panel to a handful of rows since this is a
 * compact sidebar, not the full Top tab. "Top Locations" rows aren't
 * clickable - there's no killboard view for a single station/structure yet,
 * only for systems/corps/alliances/characters/items. */
export function TopListsSidebar({ topLists, onSelectCharacter, onSelectCorporation, onSelectSystem, onSelectItem }: TopListsSidebarProps) {
  const lists = topLists.filter((t) => t.list_type !== "alliance");
  if (lists.length === 0) return null;

  function handleSelect(listType: string, v: TopListEntry) {
    if (v.id == null || !v.name) return;
    if (listType === "character") onSelectCharacter(v.id);
    else if (listType === "corporation") onSelectCorporation({ id: v.id, name: v.name });
    else if (listType === "shipType") onSelectItem({ id: v.id, name: v.name });
    else if (listType === "solarSystem") {
      // Top-list entries only carry the generic id/name/kills/isk quartet,
      // not the security/region a SystemSummary needs - resolved with a
      // real lookup rather than guessing 0, since a wrong security value
      // here would also get persisted if the user then tracks the system.
      searchSystem(v.name).then((match) => {
        if (match) onSelectSystem({ id: match.id, name: match.name, security: match.security, regionName: null });
      });
    }
  }

  return (
    <aside className="kills-top-sidebar">
      {lists.map((t) => (
        <div key={t.list_type} className="kills-top-sidebar-panel">
          <p className="kills-top-sidebar-title">{t.title}</p>
          {t.values.length === 0 ? (
            <p className="detail-empty">No data.</p>
          ) : (
            <table className="kills-top-sidebar-table">
              <tbody>
                {t.values.slice(0, SIDEBAR_ROWS).map((v, i) => {
                  const clickable = v.id != null && v.name && ["character", "corporation", "shipType", "solarSystem"].includes(t.list_type);
                  return (
                    <tr key={v.id ?? i}>
                      <td className="kills-top-sidebar-name">
                        {clickable ? (
                          <span
                            className="kills-system-clickable"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSelect(t.list_type, v)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleSelect(t.list_type, v);
                              }
                            }}
                          >
                            {v.name ?? "Unknown"}
                          </span>
                        ) : (
                          v.name ?? "Unknown"
                        )}
                      </td>
                      <td className="kills-top-sidebar-kills">{v.kills}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </aside>
  );
}
