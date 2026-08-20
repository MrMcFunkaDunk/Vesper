import { useEffect, useRef } from "react";
import { getCharacterSkillQueue } from "../lib/eve";
import { readNotificationPreferences } from "./useNotificationPreferences";
import { notify } from "../lib/notifications";

/** Skill queues don't change fast enough to need a tight poll - unlike
 * character location (10s) or kills (near-real-time), this only needs to
 * catch "queue emptied" or "dropped below the warning threshold" sometime
 * within a reasonable window, not to the second. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface CharacterRef {
  id: number;
  name: string;
}

interface QueueSnapshot {
  length: number;
  /** Finish time of the last queued item, i.e. when the whole queue empties - null if nothing is queued. */
  finishDateMs: number | null;
}

/**
 * Global background poll over every logged-in character's skill queue,
 * firing a desktop notification on two transitions: the queue just went
 * from non-empty to empty, or the remaining queued time just crossed below
 * the configured warning threshold. Compares against the previous poll's
 * snapshot rather than just "currently true" so it fires once per
 * transition, not on every single poll tick while the condition holds.
 * No global poll for this existed before - CharacterDetail.tsx only fetches
 * a queue when that character's own Queue tab is open, so this is the one
 * new piece of always-on background tracking notifications need.
 */
export function useSkillQueueWatch(characters: CharacterRef[]) {
  const snapshotsRef = useRef<Map<number, QueueSnapshot>>(new Map());
  const charactersKey = characters.map((c) => c.id).join(",");

  useEffect(() => {
    if (characters.length === 0) return;
    let active = true;

    async function pollOnce() {
      const prefs = readNotificationPreferences();
      for (const character of characters) {
        if (!active) return;
        try {
          const queue = await getCharacterSkillQueue(character.id);
          if (queue.needs_reauth) continue;

          const length = queue.items.length;
          const lastItem = queue.items[queue.items.length - 1];
          const finishDateMs = lastItem?.finish_date ? new Date(lastItem.finish_date).getTime() : null;

          const prevSnapshot = snapshotsRef.current.get(character.id);
          snapshotsRef.current.set(character.id, { length, finishDateMs });

          // First time seeing this character's queue (app just started, or
          // this character was just added) - only establishes a baseline,
          // nothing to compare against yet, so no notification either way.
          if (!prefs.enabled || !prevSnapshot) continue;

          if (prefs.skillQueueEmpty && length === 0 && prevSnapshot.length > 0) {
            notify("Skill Queue Empty", `${character.name}'s skill queue has finished training.`);
          }

          if (prefs.skillQueueLowHours != null && finishDateMs != null) {
            const hoursLeft = (finishDateMs - Date.now()) / 3_600_000;
            const prevHoursLeft = prevSnapshot.finishDateMs != null ? (prevSnapshot.finishDateMs - Date.now()) / 3_600_000 : null;
            const justCrossed = hoursLeft < prefs.skillQueueLowHours && (prevHoursLeft == null || prevHoursLeft >= prefs.skillQueueLowHours);
            if (justCrossed) {
              notify("Skill Queue Running Low", `${character.name} has less than ${prefs.skillQueueLowHours}h of training queued.`);
            }
          }
        } catch {
          // Best-effort - one character's failed fetch shouldn't block the rest or crash the poller.
        }
      }
    }

    async function loop() {
      while (active) {
        await pollOnce();
        if (!active) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    loop();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charactersKey]);
}

/** Renders nothing - exists purely to call useSkillQueueWatch from a JSX
 * position at the App.tsx shell, mirroring ChainAutoMappingEffect. */
export function SkillQueueWatchEffect({ characters }: { characters: CharacterRef[] }) {
  useSkillQueueWatch(characters);
  return null;
}
