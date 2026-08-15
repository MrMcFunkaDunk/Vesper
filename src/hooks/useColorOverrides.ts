import { useCallback, useEffect, useState } from "react";

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

  useEffect(() => {
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

  return { colors, setColor, resetColor };
}
