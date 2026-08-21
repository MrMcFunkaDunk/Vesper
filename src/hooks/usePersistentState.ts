import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * localStorage-backed React state, factoring out the pattern that was
 * hand-rolled independently in over a dozen hooks across this app: read once
 * on mount, skip the write-back on the very first effect run (a cold
 * WebView2 start can read stale/empty and shouldn't immediately re-persist
 * that as ground truth - see useTrackedEntries for the original incident
 * this guard exists for), then persist every change after that.
 *
 * `sanitize` runs on whatever was read (freshly parsed, or the default if
 * nothing was stored / parsing failed) - for a hook like useDefaultTradeHub
 * that needs to reject a stored value that's no longer valid.
 */
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  sanitize?: (value: T) => T,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw === null ? defaultValue : (JSON.parse(raw) as T);
      return sanitize ? sanitize(parsed) : parsed;
    } catch {
      return defaultValue;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
    // key is expected stable for a given hook instance - only value changes matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return [value, setValue] as const;
}
