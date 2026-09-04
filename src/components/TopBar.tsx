import { useEffect, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { getServerStatus, type Session } from "../lib/eve";
import { searchSystemsLive, type SystemSearchMatch } from "../lib/map";
import { useLocationTracking, type ProximityRadius } from "../hooks/useLocationTracking";
import StatusChip from "./StatusChip";
import HelpBadge from "./HelpBadge";
import NotificationBell from "./NotificationBell";
import { HELP_CONTENT } from "../lib/helpContent";

interface TopBarProps {
  title: string;
  activeId: string;
  session: Session;
  onSwitch: (id: number) => void;
  onAdd: () => void;
  onLogout: (id: number) => void;
}

/** EVE's in-game clock is always UTC, no timezone offset - shown so time-sensitive
 * things (skill queue finishes, market order expiry) can be read against it directly. */
function EveTimeClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="eve-time-clock">
      <span className="eve-time-label">EVE Time</span>
      <span className="eve-time-value">
        {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())}
      </span>
    </div>
  );
}

/** EVE's daily downtime is a fixed, well-known schedule (11:00 UTC, ~30min) -
 * not something ESI exposes, so this is just computed from the clock. */
function nextDowntime(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function timeUntilDowntime(now: Date): string {
  const diffMs = nextDowntime(now).getTime() - now.getTime();
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Once Tranquility's own login server is back up, ESI (the API this badge
 * actually checks) can lag several minutes behind before it stops 503ing
 * with "maintenance mode" - a real, separate CCP-side delay, not something
 * we can shortcut. This just makes sure recovery is *noticed* fast once ESI
 * genuinely does come back, by checking far more often while offline than
 * once things are healthy. */
const SERVER_STATUS_POLL_ONLINE_MS = 60000;
const SERVER_STATUS_POLL_OFFLINE_MS = 15000;

/** Shared by ServerStatusBadge and CapsuleersOnlineBadge so both boxes read
 * off one poll instead of each hitting the server-status endpoint on its
 * own timer. */
function useServerStatus() {
  const [status, setStatus] = useState<{ online: boolean; players: number | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    function scheduleNext(online: boolean) {
      timeoutId = setTimeout(poll, online ? SERVER_STATUS_POLL_ONLINE_MS : SERVER_STATUS_POLL_OFFLINE_MS);
    }

    function poll() {
      getServerStatus()
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          scheduleNext(s.online);
        })
        .catch(() => {
          if (cancelled) return;
          setStatus({ online: false, players: null });
          scheduleNext(false);
        });
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);

  return status;
}

function ServerStatusBadge() {
  const status = useServerStatus();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="server-status-badge">
      <StatusChip
        label="Tranquility"
        value={status == null ? "..." : status.online ? "Online" : "Offline"}
        tone={status == null ? "neutral" : status.online ? "online" : "danger"}
      />
      <span className="status-chip-sep">·</span>
      <span
        className={(() => {
          const msLeft = nextDowntime(now).getTime() - now.getTime();
          if (msLeft < 300000) return "server-status-downtime-soon server-status-downtime-critical";
          if (msLeft < 3600000) return "server-status-downtime-soon";
          return undefined;
        })()}
      >
        Downtime in {timeUntilDowntime(now)}
      </span>
    </div>
  );
}

/** Split out of ServerStatusBadge into its own box - same server-status poll
 * (via useServerStatus), just its own chip so it can sit between the Server
 * and Connected boxes instead of crowding onto one line with the downtime
 * countdown. */
function CapsuleersOnlineBadge() {
  const status = useServerStatus();
  return (
    <div className="capsuleers-online-badge">
      <span className="capsuleers-online-count">{status?.players != null ? new Intl.NumberFormat("en-US").format(status.players) : "..."}</span>
      <span className="capsuleers-online-label">Capsuleers Online</span>
    </div>
  );
}

export const RADIUS_OPTIONS: { value: ProximityRadius; label: string }[] = [
  { value: 0, label: "Here" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 5, label: "5" },
  { value: 7, label: "7" },
  { value: 9, label: "9" },
  { value: "region", label: "Region" },
];

/** Shared by both radius pickers (here and MapView's own) so the tooltip
 * wording can't drift between them. */
export function radiusTitle(value: ProximityRadius): string {
  if (value === "region") return "Track the whole region";
  if (value === 0) return "Track only this system - no neighbors";
  return `Track ${value} jumps out`;
}

/** Lets the pilot say "I'm here" - a manually-set current system that drives
 * the proximity kill scan (Map ticker highlight + app-wide flash). Sits next
 * to the server status badge so it's always visible/settable regardless of
 * which page is open. */
function LocationTracker() {
  const { currentSystem, setCurrentSystem, radius, setRadius } = useLocationTracking();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SystemSearchMatch[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setResults([]);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    searchSystemsLive(trimmed)
      .then((matches) => {
        if (!cancelled) setResults(matches);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  function pickSystem(system: SystemSearchMatch) {
    setCurrentSystem({ id: system.id, name: system.name });
    setQuery("");
    setResults([]);
  }

  return (
    <div className="location-tracker" ref={containerRef}>
      {currentSystem ? (
        <div className="location-tracker-current">
          <MapPin size={13} strokeWidth={2} />
          <span>{currentSystem.name}</span>
          <button
            type="button"
            className="location-tracker-clear"
            onClick={() => setCurrentSystem(null)}
            aria-label="Clear tracked location"
            title="Clear tracked location"
          >
            <X size={12} strokeWidth={2} />
          </button>
          <div className="location-tracker-radius">
            {RADIUS_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`location-tracker-radius-btn${radius === option.value ? " location-tracker-radius-active" : ""}`}
                onClick={() => setRadius(option.value)}
                title={radiusTitle(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="location-tracker-search">
          <MapPin size={13} strokeWidth={2} />
          <input
            type="text"
            name="location-search"
            placeholder="Set my location..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <div className="location-tracker-results">
              {results.map((system) => (
                <button key={system.id} type="button" onClick={() => pickSystem(system)}>
                  {system.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TopBar({ title, activeId, session, onSwitch, onAdd, onLogout }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const active =
    session.characters.find((c) => c.id === session.active_character_id) ??
    session.characters[0];
  const helpContent = HELP_CONTENT[activeId];

  return (
    <header className="topbar">
      <div className="topbar-title-group">
        <h1 className="topbar-title">{title}</h1>
        {helpContent && <HelpBadge content={helpContent} />}
      </div>
      <div className="topbar-right">
        <LocationTracker />
        <ServerStatusBadge />
        <CapsuleersOnlineBadge />
        <div className="account-menu">
          <button
            type="button"
            className="account-trigger"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {active ? (
              <>
                <img className="account-portrait" src={active.portrait_url} alt="" />
                <StatusChip label={active.name} value="Connected" tone="online" />
              </>
            ) : (
              <StatusChip label="Session" value="Offline" tone="neutral" />
            )}
          </button>
          {menuOpen && (
            <div className="account-panel">
              {session.characters.map((character) => (
                <div key={character.id} className="account-row">
                  <button
                    type="button"
                    className={`account-row-select${
                      character.id === session.active_character_id ? " account-row-active" : ""
                    }`}
                    onClick={() => {
                      onSwitch(character.id);
                      setMenuOpen(false);
                    }}
                  >
                    <img className="account-portrait" src={character.portrait_url} alt="" />
                    <span>{character.name}</span>
                  </button>
                  <button
                    type="button"
                    className="account-row-logout"
                    onClick={() => onLogout(character.id)}
                  >
                    Log out
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="account-add"
                onClick={() => {
                  onAdd();
                  setMenuOpen(false);
                }}
              >
                + Add character
              </button>
            </div>
          )}
        </div>
        <EveTimeClock />
        <NotificationBell />
      </div>
    </header>
  );
}

export default TopBar;
