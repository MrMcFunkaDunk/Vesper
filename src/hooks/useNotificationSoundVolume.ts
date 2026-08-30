import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.notificationCenter.soundVolume";

/** Volume for the notification-bell ping, 0-1. Separate from
 * useSoundVolume (the proximity alert) - the two fire for very different
 * reasons and shouldn't be forced to share one slider. Defaults to 0.5,
 * same starting point as the proximity alert, but this one is meant to
 * cut through at full volume rather than staying deliberately dampened. */
export function useNotificationSoundVolume() {
  return usePersistentState<number>(STORAGE_KEY, 0.5);
}
