import { useEffect, useRef, useState } from "react";
import { Bell, ExternalLink, Skull } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNotificationCenter } from "../hooks/useNotificationCenter";
import { formatSecondsAgo } from "../lib/format";

interface NotificationBellProps {
  /** Navigates to a killmail's own detail view in Kills & Intel - passed
   * down from App.tsx's own handleOpenKillmail, the same navigation every
   * other "open this kill" click (map ticker rows, killboard tables, etc.)
   * already goes through. Optional only so nothing breaks if this bell is
   * ever mounted somewhere that hasn't wired it up yet - every notification
   * with a killmailId set is expected to have this in practice. */
  onOpenKillmail?: (killmailId: number) => void;
}

/** The notification bell in the top bar - a general-purpose in-app feed,
 * separate from OS desktop notifications. Empty today; features push into
 * it via useNotificationCenter().addNotification(...) as they're built. */
function NotificationBell({ onOpenKillmail }: NotificationBellProps) {
  const { notifications, unreadCount, markRead, markAllRead } = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="notification-bell" ref={containerRef}>
      <button type="button" className="notification-bell-trigger" onClick={() => setOpen((v) => !v)} title="Notifications">
        <Bell size={16} strokeWidth={2} />
        {unreadCount > 0 && <span className="notification-bell-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-bell-panel">
          <div className="notification-bell-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className="notification-bell-mark-all" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p className="notification-bell-empty">No notifications yet.</p>
          ) : (
            <div className="notification-bell-list">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`notification-bell-item${n.read ? "" : " notification-bell-item-unread"}`}
                  onClick={() => {
                    markRead(n.id);
                    if (n.killmailId != null) onOpenKillmail?.(n.killmailId);
                    // openUrl throws if the URL is somehow malformed - not
                    // worth a whole error-reporter round trip over a
                    // notification click, so just swallow it silently.
                    else if (n.url) openUrl(n.url).catch(() => {});
                  }}
                >
                  <span className="notification-bell-item-title">
                    {n.title}
                    {n.killmailId != null ? (
                      <Skull size={11} strokeWidth={2} className="notification-bell-item-link-icon" />
                    ) : (
                      n.url && <ExternalLink size={11} strokeWidth={2} className="notification-bell-item-link-icon" />
                    )}
                  </span>
                  {n.message && <span className="notification-bell-item-message">{n.message}</span>}
                  <span className="notification-bell-item-time">{formatSecondsAgo(n.time)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
