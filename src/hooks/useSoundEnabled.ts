import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.proximity.soundEnabled";

/** Whether the proximity alert sound plays when a kill lands nearby - the red
 * flash always happens regardless, this only gates the audio on top of it.
 * Defaults to on, matching the sound's existing out-of-the-box behavior. */
export function useSoundEnabled() {
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, String(soundEnabled));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [soundEnabled]);

  return [soundEnabled, setSoundEnabled] as const;
}
