import { useEffect, useRef, useState } from "react";
import { backupSetting } from "../lib/settingsBackup";

const STORAGE_KEY = "vesper.gatecheck.savedRoutes";

export interface SavedRouteSystem {
  id: number;
  name: string;
  security: number;
}

export interface SavedRoute {
  id: string;
  name: string;
  systems: SavedRouteSystem[];
}

function readStorage(): SavedRoute[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedRoute[]) : [];
  } catch {
    return [];
  }
}

/** Persists Gate Check's bookmarked journeys (e.g. "Audaerne <-> Slays" for
 * a regular back-and-forth commute) so they don't need re-picking every
 * time - each can be loaded forward or reversed. */
export function useSavedRoutes() {
  const [routes, setRoutes] = useState<SavedRoute[]>(() => readStorage());

  // Skip the write-back on mount - see useTrackedEntries for why a cold
  // WebView2 start can read stale/empty and shouldn't immediately re-persist
  // that as ground truth.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const serialized = JSON.stringify(routes);
    localStorage.setItem(STORAGE_KEY, serialized);
    backupSetting(STORAGE_KEY, serialized);
  }, [routes]);

  function addRoute(route: SavedRoute) {
    setRoutes((prev) => [...prev, route]);
  }

  function removeRoute(id: string) {
    setRoutes((prev) => prev.filter((r) => r.id !== id));
  }

  return { routes, addRoute, removeRoute };
}
