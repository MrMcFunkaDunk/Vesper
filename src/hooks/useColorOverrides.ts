import { useCallback, useEffect, useRef, useState } from "react";

type ColorMap = Record<string, string>;

function readStorage(key: string): ColorMap {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ColorMap) : {};
  } catch {
    return {};
  }
}

/**
 * Persists per-item color overrides (e.g. sidebar icon colors) to
 * localStorage under `storageKey`, so different palettes (sidebar today,
 * others later) can't collide with each other.
 */
export function useColorOverrides(storageKey: string) {
  const [colors, setColors] = useState<ColorMap>(() => readStorage(storageKey));

  // Skip the write-back on mount - see useTrackedEntries for why a cold
  // WebView2 start can read stale/empty and shouldn't immediately re-persist
  // that as ground truth.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(colors));
  }, [storageKey, colors]);

  const setColor = useCallback((id: string, hex: string) => {
    setColors((prev) => ({ ...prev, [id]: hex }));
  }, []);

  const resetColor = useCallback((id: string) => {
    setColors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setColors({});
  }, []);

  return { colors, setColor, resetColor, resetAll };
}
