import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useNotificationCenter } from "../hooks/useNotificationCenter";
import { formatSecondsAgo } from "../lib/format";

/** The notification bell in the top bar - a general-purpose in-app feed,
 * separate from OS desktop notifications. Empty today; features push into
 * it via useNotificationCenter().addNotification(...) as they're built. */
function NotificationBell() {
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
                  onClick={() => markRead(n.id)}
                >
                  <span className="notification-bell-item-title">{n.title}</span>
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
