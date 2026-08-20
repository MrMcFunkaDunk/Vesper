import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.settings.reduceMotion";

/** Suppresses VESPER's own decorative animations (skill-queue training
 * pulse, proximity-alert flash) - not a replacement for the OS-level
 * prefers-reduced-motion media query (already respected where used), this
 * is an explicit in-app override for someone who wants it off regardless of
 * their system setting. Applies via a data attribute on <body> so any
 * component's CSS can gate on it without prop-drilling the flag. */
export function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, String(reduceMotion));
      } catch {
        // Not worth surfacing - worst case the preference doesn't persist.
      }
    }
    document.body.dataset.reduceMotion = String(reduceMotion);
  }, [reduceMotion]);

  return [reduceMotion, setReduceMotion] as const;
}
