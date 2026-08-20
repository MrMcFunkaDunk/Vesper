import { useEffect, useRef, useState } from "react";
import { ensureNotificationPermission } from "../lib/notifications";

const STORAGE_KEY = "vesper.settings.notifications";

export interface NotificationPreferences {
  /** Master switch - off means no notification ever fires regardless of the
   * per-event toggles below, and gates whether the OS permission prompt has
   * been requested at all. */
  enabled: boolean;
  proximityKills: boolean;
  autoMapJumps: boolean;
  skillQueueEmpty: boolean;
  /** Hours-remaining threshold that triggers a "queue running low" warning - null disables the check entirely. */
  skillQueueLowHours: number | null;
}

const DEFAULT_PREFS: NotificationPreferences = {
  enabled: false,
  proximityKills: true,
  autoMapJumps: true,
  skillQueueEmpty: true,
  skillQueueLowHours: 24,
};

function readPrefs(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NotificationPreferences>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Per-event desktop-notification preferences, gated behind a master
 * `enabled` toggle that requests the OS permission the first time it's
 * switched on (evemon/eve-nexum/eve-tools-suite all use this same
 * master-plus-per-event shape). Everything defaults ON except the master
 * switch itself, so opting in immediately gets the full set rather than
 * needing every checkbox ticked one at a time. */
export function useNotificationPreferences() {
  const [prefs, setPrefs] = useState<NotificationPreferences>(() => readPrefs());
  const [permissionDenied, setPermissionDenied] = useState(false);

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [prefs]);

  async function setEnabled(next: boolean) {
    if (!next) {
      setPrefs((prev) => ({ ...prev, enabled: false }));
      return;
    }
    const granted = await ensureNotificationPermission();
    setPermissionDenied(!granted);
    setPrefs((prev) => ({ ...prev, enabled: granted }));
  }

  function update<K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  }

  return { prefs, setEnabled, update, permissionDenied };
}

/** Reads straight from localStorage rather than the hook, for the handful
 * of always-mounted background effects (proximity alerts, auto-map jumps)
 * that need a quick "should I fire?" check without holding their own
 * subscribed hook state - those already re-render on their own triggers
 * (a new kill, a new jump), so a live-reactive value isn't needed and a
 * plain read keeps them from re-rendering every time any preference changes. */
export function readNotificationPreferences(): NotificationPreferences {
  return readPrefs();
}
