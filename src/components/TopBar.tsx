import { useEffect, useState } from "react";
import { getServerStatus, type Session } from "../lib/eve";
import StatusChip from "./StatusChip";

interface TopBarProps {
  title: string;
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

function ServerStatusBadge() {
  const [status, setStatus] = useState<{ online: boolean; players: number | null } | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      getServerStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus({ online: false, players: null });
        });
    }
    poll();
    const id = setInterval(poll, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="server-status-badge">
      <StatusChip
        label="Tranquility"
        value={status == null ? "..." : status.online ? "Online" : "Offline"}
        tone={status == null ? "neutral" : status.online ? "online" : "danger"}
      />
      <span className="server-status-line">
        {status?.players != null && (
          <>
            <span className="server-status-players">{new Intl.NumberFormat("en-US").format(status.players)} online</span>
            <span> · </span>
          </>
        )}
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
      </span>
    </div>
  );
}

function TopBar({ title, session, onSwitch, onAdd, onLogout }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const active =
    session.characters.find((c) => c.id === session.active_character_id) ??
    session.characters[0];

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-right">
        <ServerStatusBadge />
        <EveTimeClock />
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
      </div>
    </header>
  );
}

export default TopBar;
