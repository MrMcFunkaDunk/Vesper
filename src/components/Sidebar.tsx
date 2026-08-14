import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Radar,
  Wallet,
  Orbit,
  Mail,
  UserSearch,
  Settings,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    description:
      "A quick overview once you're logged in, with summary widgets from the modules below.",
  },
  {
    id: "kills",
    label: "Kills & Intel",
    icon: Radar,
    description:
      "Recent killmail activity from zKillboard for the systems and regions you care about.",
  },
  {
    id: "wallet",
    label: "Wallet & Market",
    icon: Wallet,
    description:
      "Character wallet balance and recent transactions, pulled live from ESI.",
  },
  {
    id: "planetary",
    label: "Planetary Interaction",
    icon: Orbit,
    description:
      "Your colonies at a glance, with warnings when an extractor or factory needs attention.",
  },
  {
    id: "mail",
    label: "Mail",
    icon: Mail,
    description: "A read-only view of your EVE mail inbox.",
  },
  {
    id: "intel-check",
    label: "Intel Check",
    icon: UserSearch,
    description: "Paste a chat list and look up affiliations for everyone in it.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    description: "Manage logged-in characters, granted scopes, and app preferences.",
  },
];

interface SidebarProps {
  activeId: string;
  onSelect: (id: string) => void;
}

function Sidebar({ activeId, onSelect }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">EC</span>
        <span className="brand-name">EVE Companion</span>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item${isActive ? " nav-item-active" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={18} strokeWidth={1.75} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">v0.1.0 · dev build</div>
    </aside>
  );
}

export default Sidebar;
