import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.proximity.soundEnabled";

/** Whether the proximity alert sound plays when a kill lands nearby - the red
 * flash always happens regardless, this only gates the audio on top of it.
 * Defaults to on, matching the sound's existing out-of-the-box behavior. */
export function useSoundEnabled() {
  return usePersistentState<boolean>(STORAGE_KEY, true);
}
