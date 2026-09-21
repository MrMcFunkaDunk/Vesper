import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Radar,
  Wallet,
  Orbit,
  Mail,
  Settings,
  Map as MapIcon,
  Factory,
  Wrench,
  Calendar as CalendarIcon,
  Waypoints,
  Users,
  Pickaxe,
  Star,
  ArrowLeft,
} from "lucide-react";
import Wordmark from "./Wordmark";
import ColorPickerMenu from "./ColorPickerMenu";
import TechnicalLabel from "./premium/TechnicalLabel";
import { useTheme, isPremiumTheme } from "../hooks/useTheme";
import { SIDEBAR_PALETTE } from "../lib/palettes";
import { useColorOverrides } from "../hooks/useColorOverrides";
import { useNavOrder } from "../hooks/useNavOrder";
import { useDragReorder } from "../hooks/useDragReorder";
import { useFavouritePages } from "../hooks/useFavouritePages";
import { useIsWindows } from "../hooks/usePlatform";
import { splitFavouriteId, subTabLabel } from "../lib/subTabs";
import dashboardIcon from "../assets/sidebar-icons/dashboard.png";
import killsIntelIcon from "../assets/sidebar-icons/kills-intel.png";
import walletMarketIcon from "../assets/sidebar-icons/wallet-market.png";
import mailIcon from "../assets/sidebar-icons/mail.png";
import settingsIcon from "../assets/sidebar-icons/settings.png";
import planetaryIndustryIcon from "../assets/sidebar-icons/planetary-industry.png";
import mapIcon from "../assets/sidebar-icons/map.png";
import industryIcon from "../assets/sidebar-icons/industry.png";
import fittingsFleetsIcon from "../assets/sidebar-icons/fittings-fleets.png";
import calendarIcon from "../assets/sidebar-icons/calendar.png";
import pathWormholeFinderIcon from "../assets/sidebar-icons/path-wormhole-finder.png";
import multiboxingIcon from "../assets/sidebar-icons/multiboxing.png";
import miningIcon from "../assets/sidebar-icons/mining.png";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Custom sidebar artwork, overrides `icon` in the nav list when set. */
  image?: string;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    image: dashboardIcon,
    description:
      "A quick overview once you're logged in, with summary widgets from the modules below.",
  },
  {
    id: "kills",
    label: "Killboard",
    icon: Radar,
    image: killsIntelIcon,
    description:
      "Recent killmail activity from zKillboard for the systems and regions you care about.",
  },
  {
    id: "map",
    label: "Map, Gate & Intel Check",
    icon: MapIcon,
    image: mapIcon,
    description:
      "A searchable map of New Eden with live kill activity, plus gate-camp checking and local/D-Scan intel tools, so you can see where the action is and plan routes around it.",
  },
  {
    id: "path-wormhole-finder",
    label: "Path & Wormhole Tracker",
    icon: Waypoints,
    image: pathWormholeFinderIcon,
    description: "Plot routes across New Eden including wormhole connections, not just stargates.",
  },
  {
    id: "wallet",
    label: "Wallet & Market",
    icon: Wallet,
    image: walletMarketIcon,
    description:
      "Character wallet balance and recent transactions, pulled live from ESI.",
  },
  {
    id: "planetary",
    label: "Planetary Industry",
    icon: Orbit,
    image: planetaryIndustryIcon,
    description:
      "Which planet types yield which raw materials, and the full P0-P4 production chain for any commodity - a planning reference, not a live colony view.",
  },
  {
    id: "mail",
    label: "Mail",
    icon: Mail,
    image: mailIcon,
    description: "A read-only view of your EVE mail inbox.",
  },
  {
    id: "industry",
    label: "Industry",
    icon: Factory,
    image: industryIcon,
    description:
      "Blueprint ME/TE tracking, build-cost calculation, and job planning - our own take on what Fuzzwork, Adam4EVE, and RavWorks each do.",
  },
  {
    id: "mining",
    label: "Mining",
    icon: Pickaxe,
    image: miningIcon,
    description:
      "What's actually worth mining right now (ore.cerlestes.de-style per-m³ value tables) plus a real record of what you've already pulled from ESI's mining ledger.",
  },
  {
    id: "fittings-fleets",
    label: "Fitting",
    icon: Wrench,
    image: fittingsFleetsIcon,
    description: "An in-app fit builder with saved fits and fleet composition tooling.",
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarIcon,
    image: calendarIcon,
    description: "Upcoming in-game events and fleet ops.",
  },
  {
    id: "multiboxing",
    label: "Multiboxing",
    icon: Users,
    image: multiboxingIcon,
    description: "Live thumbnail previews of every running EVE client, with click-to-switch - opens as its own floating window.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    image: settingsIcon,
    description: "Manage logged-in characters, granted scopes, and app preferences.",
  },
];

/** Subsystem channel codes for the premium "control rack" nav treatment -
 * decorative categorization, not a restructure of the list itself. The
 * sidebar already lets a pilot freely drag any item into any position
 * (useNavOrder/useDragReorder) and that has to keep working exactly as it
 * does today, so this doesn't group items under section headers (which
 * would either fight a user's own custom order or have to ignore it) -
 * each item just carries a small fixed category tag alongside its live
 * position number, both of which stay correct no matter how the list gets
 * reordered. */
const NAV_CHANNEL_CODE: Record<string, string> = {
  dashboard: "CMD",
  kills: "CBT",
  map: "NAV",
  "path-wormhole-finder": "NAV",
  wallet: "LOG",
  planetary: "LOG",
  mail: "COM",
  industry: "LOG",
  mining: "LOG",
  "fittings-fleets": "CBT",
  calendar: "OPS",
  multiboxing: "OPS",
  settings: "SYS",
};

interface SidebarProps {
  activeId: string;
  /** Which internal tab is showing on whichever multi-tab page is active -
   * used only to highlight the right row in the Favourites view when a
   * sub-tab (rather than a whole page) is the current one. */
  activeSubTab?: string | null;
  onSelect: (id: string) => void;
}

interface ContextMenuState {
  navId: string;
  x: number;
  y: number;
}

function Sidebar({ activeId, activeSubTab, onSelect }: SidebarProps) {
  const { colors, setColor, resetColor } = useColorOverrides("vesper.colors.sidebar");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [version, setVersion] = useState("");
  const [theme] = useTheme();
  const premium = isPremiumTheme(theme);
  const { favouriteIds, reorderFavourites } = useFavouritePages();
  /** Not persisted (unlike favouriteIds itself) - this is a transient view
   * toggle, always starting back on "show everything" the next time the
   * app opens, the same way a filter/search box wouldn't stay applied
   * across a restart either. */
  const [showingFavourites, setShowingFavourites] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const defaultIds = NAV_ITEMS.map((item) => item.id);
  const { order, setOrder } = useNavOrder(defaultIds);
  const { draggingId, setItemRef, handlePointerDown, handlePointerMove, handlePointerUp, consumeJustDragged } =
    useDragReorder(order, setOrder);
  /** A second, independent drag-reorder instance for the Favourites view -
   * it reorders favouriteIds itself rather than the main nav order, so
   * dragging a starred page/tab around only changes where it sits in the
   * Favourites list, never the pilot's main All Pages order. */
  const {
    draggingId: favDraggingId,
    setItemRef: setFavItemRef,
    handlePointerDown: handleFavPointerDown,
    handlePointerMove: handleFavPointerMove,
    handlePointerUp: handleFavPointerUp,
    consumeJustDragged: consumeFavJustDragged,
  } = useDragReorder(favouriteIds, reorderFavourites);

  const orderedItems = order
    .map((id) => NAV_ITEMS.find((item) => item.id === id))
    .filter((item): item is NavItem => Boolean(item));
  /** Settings always anchors the very bottom of the nav list, right above
   * the version footer, and never takes part in drag-reordering - it's the
   * one page you always need a reliable way back to (turning Favourites off
   * again, managing characters, etc.), so it can't end up buried in the
   * middle of the list. Rendered as its own fixed row below, not through
   * this array. */
  const isWindows = useIsWindows();
  const draggableItems = orderedItems.filter((item) => item.id !== "settings" && (isWindows || item.id !== "multiboxing"));
  const settingsItem = orderedItems.find((item) => item.id === "settings");

  interface FavouriteRow {
    id: string;
    pageId: string;
    subTabId: string | null;
    label: string;
    icon: LucideIcon;
    image?: string;
  }

  /** One combined, drag-reorderable list for the Favourites view - whole
   * pages and sub-tab favourites ("wallet.lpstore") side by side, in
   * whatever order the pilot starred or dragged them into, rather than two
   * separately-rendered, unreorderable groups. */
  const favouriteRows: FavouriteRow[] = favouriteIds
    .map((id): FavouriteRow | null => {
      const { pageId, subTabId } = splitFavouriteId(id);
      const parent = NAV_ITEMS.find((item) => item.id === pageId);
      if (!parent) return null;
      return {
        id,
        pageId,
        subTabId,
        label: subTabId ? subTabLabel(pageId, subTabId) ?? subTabId : parent.label,
        icon: parent.icon,
        image: parent.image,
      };
    })
    .filter((row): row is FavouriteRow => row !== null);

  return (
    <aside className="sidebar">
      <div className="brand">
        <Wordmark />
        <span className="brand-subtitle">Capsuleer Operations System</span>
        <TechnicalLabel>SUBSYS.RACK / DECK 01</TechnicalLabel>
      </div>
      <div className="brand-divider" />
      <div className="sidebar-favourites-bar">
        {showingFavourites ? (
          <button type="button" className="sidebar-favourites-back" onClick={() => setShowingFavourites(false)}>
            <ArrowLeft size={14} strokeWidth={2} />
            All Pages
          </button>
        ) : (
          <button
            type="button"
            className="sidebar-favourites-toggle"
            onClick={() => setShowingFavourites(true)}
            title="Show just the pages you've starred from their own header"
          >
            <Star size={14} strokeWidth={2} />
            Favourites
            {favouriteIds.length > 0 && <span className="sidebar-favourites-count">{favouriteIds.length}</span>}
          </button>
        )}
      </div>
      {showingFavourites && favouriteIds.length === 0 && (
        <p className="sidebar-favourites-empty">No favourites yet - star a page from its own header (next to the title) to add it here.</p>
      )}
      <nav className="nav">
        {showingFavourites
          ? favouriteRows.map((row, index) => {
              const Icon = row.icon;
              const isActive = row.subTabId != null ? row.pageId === activeId && row.subTabId === activeSubTab : row.pageId === activeId;
              const customColor = row.subTabId == null ? colors[row.pageId] : undefined;
              const isDragging = favDraggingId === row.id;
              return (
                <button
                  key={row.id}
                  ref={setFavItemRef(row.id)}
                  type="button"
                  className={`nav-item${isActive ? " nav-item-active" : ""}${isDragging ? " nav-item-dragging" : ""}`}
                  style={customColor ? { color: customColor } : undefined}
                  onClick={() => {
                    if (consumeFavJustDragged()) return;
                    onSelect(row.id);
                  }}
                  onContextMenu={
                    row.subTabId == null
                      ? (e) => {
                          e.preventDefault();
                          setContextMenu({ navId: row.pageId, x: e.clientX, y: e.clientY });
                        }
                      : undefined
                  }
                  onPointerDown={handleFavPointerDown(row.id)}
                  onPointerMove={handleFavPointerMove}
                  onPointerUp={handleFavPointerUp}
                >
                  {premium && (
                    <span className="nav-item-channel">
                      {String(index + 1).padStart(2, "0")}
                      <span className="nav-item-channel-code">{NAV_CHANNEL_CODE[row.pageId] ?? "GEN"}</span>
                    </span>
                  )}
                  {row.image ? (
                    <img src={row.image} alt="" className="nav-item-icon-img" />
                  ) : (
                    <Icon size={18} strokeWidth={1.75} />
                  )}
                  <span>{row.label}</span>
                </button>
              );
            })
          : draggableItems.map((item, index) => {
              const Icon = item.icon;
              const isActive = item.id === activeId;
              const customColor = colors[item.id];
              const isDragging = draggingId === item.id;
              return (
                <button
                  key={item.id}
                  ref={setItemRef(item.id)}
                  type="button"
                  className={`nav-item${isActive ? " nav-item-active" : ""}${isDragging ? " nav-item-dragging" : ""}`}
                  style={customColor ? { color: customColor } : undefined}
                  onClick={() => {
                    if (consumeJustDragged()) return;
                    onSelect(item.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ navId: item.id, x: e.clientX, y: e.clientY });
                  }}
                  onPointerDown={handlePointerDown(item.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  {/* Channel number (live position, always correct no matter how
                      the list gets dragged around) + a fixed subsystem code -
                      the "numbered equipment channel" identity from the premium
                      nav-rack brief, without restructuring the actual
                      drag-to-reorder list into fixed sections (see
                      NAV_CHANNEL_CODE's own comment for why). Premium-only:
                      standard themes keep the exact nav item markup they
                      always had. */}
                  {premium && (
                    <span className="nav-item-channel">
                      {String(index + 1).padStart(2, "0")}
                      <span className="nav-item-channel-code">{NAV_CHANNEL_CODE[item.id] ?? "GEN"}</span>
                    </span>
                  )}
                  {item.image ? (
                    <img src={item.image} alt="" className="nav-item-icon-img" />
                  ) : (
                    <Icon size={18} strokeWidth={1.75} />
                  )}
                  <span>{item.label}</span>
                </button>
              );
            })}
      </nav>
      {/* Settings sits in its own fixed zone below the scrollable nav list,
         never mixed in among the draggable/favouritable rows above it -
         same spot in both the all-pages and Favourites views, since it's
         rendered here rather than inside either of those lists. */}
      {settingsItem && (
        <div className="sidebar-settings-anchor">
          <button
            key={settingsItem.id}
            type="button"
            className={`nav-item${settingsItem.id === activeId ? " nav-item-active" : ""}`}
            style={colors[settingsItem.id] ? { color: colors[settingsItem.id] } : undefined}
            onClick={() => onSelect(settingsItem.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ navId: settingsItem.id, x: e.clientX, y: e.clientY });
            }}
          >
            {premium && (
              <span className="nav-item-channel">
                {String(NAV_ITEMS.length).padStart(2, "0")}
                <span className="nav-item-channel-code">{NAV_CHANNEL_CODE[settingsItem.id] ?? "GEN"}</span>
              </span>
            )}
            {settingsItem.image ? (
              <img src={settingsItem.image} alt="" className="nav-item-icon-img" />
            ) : (
              <settingsItem.icon size={18} strokeWidth={1.75} />
            )}
            <span>{settingsItem.label}</span>
          </button>
        </div>
      )}
      <div className="sidebar-footer">
        <TechnicalLabel>VES//NAV-02</TechnicalLabel>
        {version && `v${version}`}
        {/* import.meta.env.DEV is Vite's own dev-vs-production build flag -
           true under `tauri dev`/`vite`, false in whatever `tauri build`
           actually ships - so this never needs manually toggling on or off
           per release; a real build is automatically never marked DEV. */}
        {import.meta.env.DEV && <span className="sidebar-dev-badge">DEV</span>}
      </div>
      {contextMenu && (
        <ColorPickerMenu
          x={contextMenu.x}
          y={contextMenu.y}
          palette={SIDEBAR_PALETTE}
          value={colors[contextMenu.navId]}
          onSelect={(hex) => setColor(contextMenu.navId, hex)}
          onReset={() => resetColor(contextMenu.navId)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
}

export default Sidebar;
