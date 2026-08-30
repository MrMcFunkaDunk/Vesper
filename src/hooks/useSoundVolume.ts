import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.proximity.soundVolume";

/** Volume for the proximity alert sound, 0-1. Defaults to 0.5, not 1 - the
 * bundled alert clip was mixed loud enough to be heard over EVE itself, so
 * full volume through actual speakers/headset is startlingly loud the first
 * time it fires. */
export function useSoundVolume() {
  return usePersistentState<number>(STORAGE_KEY, 0.5);
}
