import type { ReactNode } from "react";
import FavouriteTabButton from "./FavouriteTabButton";

export interface PageTabDef {
  id: string;
  label: string;
}

interface PageTabBarProps {
  /** NAV_ITEMS id this tab bar belongs to, e.g. "wallet" - passed straight
   * through to each tab's own FavouriteTabButton so it favourites
   * "wallet.<tabId>" rather than just the tab id in isolation. */
  pageId: string;
  tabs: PageTabDef[];
  activeTab: string;
  onSelect: (id: string) => void;
  /** Extra content docked to the end of the row, e.g. a HelpBadge. */
  trailing?: ReactNode;
  /** Extra class for page-specific quirks (e.g. Map's flex-shrink:0 wrapper). */
  className?: string;
}

/** The one shared tab-switcher for every multi-tab top-level page (Wallet &
 * Market, Industry, Mining, Map, Killboard, Planetary Industry, Fitting) -
 * a single implementation so all of them stay the same size and spacing
 * instead of drifting apart the way 7 independently hand-rolled tab rows
 * did. Every tab gets its own favourite star right beside it (not just the
 * currently-active tab), so which tabs are starred is visible at a glance
 * and any of them can be favourited without switching to it first. */
function PageTabBar({ pageId, tabs, activeTab, onSelect, trailing, className }: PageTabBarProps) {
  return (
    <div className={`page-tab-row${className ? ` ${className}` : ""}`}>
      {tabs.map((t) => (
        <span key={t.id} className="page-tab-pair">
          <button
            type="button"
            className={`kills-tab ${t.id === activeTab ? "kills-tab-active" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
          <FavouriteTabButton pageId={pageId} tabId={t.id} />
        </span>
      ))}
      {trailing && <span className="page-tab-trailing">{trailing}</span>}
    </div>
  );
}

export default PageTabBar;
