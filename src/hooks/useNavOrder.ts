import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.sidebar.order";

function readOrder(defaultIds: string[]): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultIds;
    const stored = JSON.parse(raw) as string[];
    // Keep the stored order for ids that still exist, then append any new
    // ids (a module added later) that aren't in it yet - so an old saved
    // order never drops or crashes on a nav item it doesn't know about.
    const known = new Set(defaultIds);
    const cleaned = stored.filter((id) => known.has(id));
    const missing = defaultIds.filter((id) => !cleaned.includes(id));
    return [...cleaned, ...missing];
  } catch {
    return defaultIds;
  }
}

/** Persists the sidebar's user-chosen nav item order to localStorage. */
export function useNavOrder(defaultIds: string[]) {
  const [order, setOrder] = useState<string[]>(() => readOrder(defaultIds));

  // Skip the write-back on mount - see useTrackedEntries for why a cold
  // WebView2 start can read stale/empty and shouldn't immediately re-persist
  // that as ground truth.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  }, [order]);

  return { order, setOrder };
}
