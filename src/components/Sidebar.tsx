import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Radar,
  Wallet,
  Orbit,
  Mail,
  UserSearch,
  Settings,
  Map as MapIcon,
  Factory,
  Wrench,
  Calendar as CalendarIcon,
  Waypoints,
  Users,
  Pickaxe,
} from "lucide-react";
import Wordmark from "./Wordmark";
import ColorPickerMenu from "./ColorPickerMenu";
import TechnicalLabel from "./premium/TechnicalLabel";
import { useTheme, isPremiumTheme } from "../hooks/useTheme";
import { SIDEBAR_PALETTE } from "../lib/palettes";
import { useColorOverrides } from "../hooks/useColorOverrides";
import { useNavOrder } from "../hooks/useNavOrder";
import { useDragReorder } from "../hooks/useDragReorder";
import dashboardIcon from "../assets/sidebar-icons/dashboard.png";
import killsIntelIcon from "../assets/sidebar-icons/kills-intel.png";
import walletMarketIcon from "../assets/sidebar-icons/wallet-market.png";
import mailIcon from "../assets/sidebar-icons/mail.png";
import intelCheckIcon from "../assets/sidebar-icons/intel-check.png";
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
    label: "Kills & Intel",
    icon: Radar,
    image: killsIntelIcon,
    description:
      "Recent killmail activity from zKillboard for the systems and regions you care about.",
  },
  {
    id: "map",
    label: "Map & Gate Checker",
    icon: MapIcon,
    image: mapIcon,
    description:
      "A searchable map of New Eden with live kill activity, so you can see where the action is and plan routes around it.",
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
    id: "intel-check",
    label: "Intel Check",
    icon: UserSearch,
    image: intelCheckIcon,
    description: "Paste a chat list and look up affiliations for everyone in it.",
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
  "intel-check": "CBT",
  industry: "LOG",
  mining: "LOG",
  "fittings-fleets": "CBT",
  calendar: "OPS",
  multiboxing: "OPS",
  settings: "SYS",
};

interface SidebarProps {
  activeId: string;
  onSelect: (id: string) => void;
}

interface ContextMenuState {
  navId: string;
  x: number;
  y: number;
}

function Sidebar({ activeId, onSelect }: SidebarProps) {
  const { colors, setColor, resetColor } = useColorOverrides("vesper.colors.sidebar");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [version, setVersion] = useState("");
  const [theme] = useTheme();
  const premium = isPremiumTheme(theme);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const defaultIds = NAV_ITEMS.map((item) => item.id);
  const { order, setOrder } = useNavOrder(defaultIds);
  const { draggingId, setItemRef, handlePointerDown, handlePointerMove, handlePointerUp, consumeJustDragged } =
    useDragReorder(order, setOrder);

  const orderedItems = order
    .map((id) => NAV_ITEMS.find((item) => item.id === id))
    .filter((item): item is NavItem => Boolean(item));

  return (
    <aside className="sidebar">
      <div className="brand">
        <Wordmark />
        <span className="brand-subtitle">Capsuleer Operations System</span>
        <TechnicalLabel>SUBSYS.RACK / DECK 01</TechnicalLabel>
      </div>
      <div className="brand-divider" />
      <nav className="nav">
        {orderedItems.map((item, index) => {
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
      <div className="sidebar-footer">
        <TechnicalLabel>VES//NAV-02</TechnicalLabel>
        {version && `v${version}`}
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
