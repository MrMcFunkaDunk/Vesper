import { createContext, useContext, type ReactNode } from "react";
import { usePersistentState } from "./usePersistentState";
import { useNotificationSoundVolume } from "./useNotificationSoundVolume";
import { playNotificationPing } from "../lib/sound";

const STORAGE_KEY = "vesper.notificationCenter";
/** Bounds how many notifications pile up in localStorage - old ones fall off
 * the end rather than growing forever across a long-running session. */
const MAX_NOTIFICATIONS = 100;

export interface NotificationItem {
  id: string;
  title: string;
  message?: string;
  /** Opened (via the opener plugin) when this notification is clicked, in
   * addition to marking it read - e.g. a new-update notification linking
   * straight to that release's GitHub page. Mutually exclusive with
   * killmailId in practice (nothing sets both) - omitted, a notification
   * just marks itself read on click, same as before either existed. */
  url?: string;
  /** Navigates to this killmail's own detail view in-app (Kills & Intel)
   * when clicked, in addition to marking it read - e.g. a tracked-entity
   * kill/death notification. Handled separately from `url` above since this
   * is in-app React navigation, not something the opener plugin can do. */
  killmailId?: number;
  /** ISO timestamp. */
  time: string;
  read: boolean;
}

interface NotificationCenterState {
  notifications: NotificationItem[];
  unreadCount: number;
  addNotification: (title: string, message?: string, url?: string, killmailId?: number) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

const NotificationCenterContext = createContext<NotificationCenterState | null>(null);

/**
 * A general-purpose in-app notification feed - the bell in the top bar.
 * Separate from the OS desktop-notification preferences (useNotificationPreferences),
 * which fire native popups; this is a persistent, in-app history of the same
 * kind of events (and anything else worth flagging) that stays readable after
 * the moment has passed. Empty today - features push into it as they're built.
 */
export function useNotificationCenter(): NotificationCenterState {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotificationCenter must be used within a NotificationCenterProvider");
  }
  return ctx;
}

export function NotificationCenterProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = usePersistentState<NotificationItem[]>(STORAGE_KEY, []);
  const [notificationVolume] = useNotificationSoundVolume();

  function addNotification(title: string, message?: string, url?: string, killmailId?: number) {
    const item: NotificationItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      message,
      url,
      killmailId,
      time: new Date().toISOString(),
      read: false,
    };
    setNotifications((prev) => [item, ...prev].slice(0, MAX_NOTIFICATIONS));
    playNotificationPing(notificationVolume);
  }

  function markRead(id: string) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }

  function clear() {
    setNotifications([]);
  }

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationCenterContext.Provider value={{ notifications, unreadCount, addNotification, markRead, markAllRead, clear }}>
      {children}
    </NotificationCenterContext.Provider>
  );
}
