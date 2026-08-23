import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TrackedEntityEvent } from "../lib/trackedEntities";
import { formatIsk } from "../lib/format";
import { useNotificationCenter } from "./useNotificationCenter";
import { useToast } from "./useToast";
import { readNotificationPreferences } from "./useNotificationPreferences";
import { notify } from "../lib/notifications";

function describe(e: TrackedEntityEvent): { title: string; message: string } {
  const who = e.tracked_entity_kind === "character" ? e.tracked_entity_name : (e.subject_character_name ?? e.tracked_entity_name);
  const context = e.tracked_entity_kind === "character" ? "" : ` (${e.tracked_entity_name})`;

  if (e.event === "died") {
    const killer = e.other_name ? ` by ${e.other_name}` : "";
    return {
      title: `Vesper: ${who} has died${context}`,
      message: `Lost a ${e.ship_type_name} in ${e.system_name}${killer} - ${formatIsk(e.total_value)}`,
    };
  }
  const victim = e.other_name ?? "someone";
  return {
    title: `Vesper: ${who} has killed${context}`,
    message: `Killed ${victim}'s ${e.ship_type_name} in ${e.system_name} - ${formatIsk(e.total_value)}`,
  };
}

/**
 * Background listener for the backend's "tracked-player-event" emissions
 * (a tracked character, corporation, or alliance appearing as a kill's
 * victim or an attacker, matched server-side against the live killmail
 * stream). Fans one event out to all three surfaces the user asked for:
 * the persistent bell, a 10s toast, and (gated on the existing notification
 * preferences, like every other native alert in the app) a desktop
 * notification.
 */
export function useTrackedEntityEvents() {
  const { addNotification } = useNotificationCenter();
  const { showToast } = useToast();

  useEffect(() => {
    const unlistenPromise = listen<TrackedEntityEvent>("tracked-player-event", (e) => {
      const { title, message } = describe(e.payload);
      addNotification(title, message);
      showToast(title, message);
      const prefs = readNotificationPreferences();
      if (prefs.enabled && prefs.trackedPlayerKills) {
        notify(title, message);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Renders nothing - exists purely to call useTrackedEntityEvents from a
 * JSX position at the App.tsx shell, mirroring SkillQueueWatchEffect. */
export function TrackedEntityEventsEffect() {
  useTrackedEntityEvents();
  return null;
}
