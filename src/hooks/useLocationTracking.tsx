import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getMapData, type MapData } from "../lib/map";
import { useRecentActivity } from "./useRecentActivity";
import { useErrorReporter } from "./useErrorReporter";
import { readNotificationPreferences } from "./useNotificationPreferences";
import { notify } from "../lib/notifications";

export type ProximityRadius = 1 | 2 | 3 | 5 | 7 | 9 | "region";

const CURRENT_SYSTEM_KEY = "vesper.location.currentSystem";
const RADIUS_KEY = "vesper.location.radius";
/** Caps how many past alerted kills stay flagged in the ticker - well above
 * the ticker's own display limit, just enough to avoid the set growing
 * forever over a long session. */
const ALERT_HISTORY_LIMIT = 200;

export interface CurrentSystem {
  id: number;
  name: string;
}

function readCurrentSystem(): CurrentSystem | null {
  try {
    const raw = localStorage.getItem(CURRENT_SYSTEM_KEY);
    return raw ? (JSON.parse(raw) as CurrentSystem) : null;
  } catch {
    return null;
  }
}

function readRadius(): ProximityRadius {
  try {
    const raw = localStorage.getItem(RADIUS_KEY);
    if (raw === "region") return "region";
    const n = Number(raw);
    if (n === 1 || n === 2 || n === 3 || n === 5 || n === 7 || n === 9) return n;
    return 5;
  } catch {
    return 5;
  }
}

interface LocationTrackingState {
  /** The character's manually-set current system, or null if location tracking is off. */
  currentSystem: CurrentSystem | null;
  setCurrentSystem: (system: CurrentSystem | null) => void;
  radius: ProximityRadius;
  setRadius: (radius: ProximityRadius) => void;
  /** Every system id within `radius` gate-jumps of currentSystem (or the whole region), including currentSystem itself. Empty when no location is set. */
  radiusSystemIds: Set<number>;
  /** Killmail ids that arrived while inside radiusSystemIds - drives the ticker's red highlight. */
  alertKillIds: Set<number>;
  /** Increments once per batch of newly-arrived proximity kills - consumed by the app-wide flash overlay to trigger its pulse animation. */
  pulseToken: number;
  /** Increments only when a newly-arrived kill lands in the current system or
   * one jump away - a fixed, tighter tier than the user's chosen radius, so
   * "close" always means close regardless of how wide the visual radius is
   * set. Consumed by the app-wide overlay to trigger an alert sound. */
  soundToken: number;
}

const LocationTrackingContext = createContext<LocationTrackingState | null>(null);

/**
 * Tracks the character's manually-set current system and flags any live kill
 * that lands within a configurable jump radius (or the whole region) of it -
 * a Rift-style proximity alert. Lives at the app root (not owned by the Map
 * screen) so the background scan and the resulting ticker highlight / flash
 * keep working no matter which page is active.
 */
export function useLocationTracking(): LocationTrackingState {
  const ctx = useContext(LocationTrackingContext);
  if (!ctx) {
    throw new Error("useLocationTracking must be used within a LocationTrackingProvider");
  }
  return ctx;
}

interface LocationTrackingProviderProps {
  children: ReactNode;
}

function addEdge(adjacency: Map<number, number[]>, from: number, to: number) {
  const list = adjacency.get(from);
  if (list) list.push(to);
  else adjacency.set(from, [to]);
}

/** Every system reachable from originId within maxJumps gate hops (inclusive), via breadth-first search over the map's jump graph. */
function systemsWithinJumps(originId: number, maxJumps: number, adjacency: Map<number, number[]>): Set<number> {
  const visited = new Set<number>([originId]);
  let frontier = [originId];
  for (let depth = 0; depth < maxJumps && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const systemId of frontier) {
      for (const neighbor of adjacency.get(systemId) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

export function LocationTrackingProvider({ children }: LocationTrackingProviderProps) {
  const [currentSystem, setCurrentSystemState] = useState<CurrentSystem | null>(() => readCurrentSystem());
  const [radius, setRadius] = useState<ProximityRadius>(() => readRadius());
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [alertKillIds, setAlertKillIds] = useState<Set<number>>(new Set());
  const [pulseToken, setPulseToken] = useState(0);
  const [soundToken, setSoundToken] = useState(0);
  const seenKillIdsRef = useRef<Set<number> | null>(null);
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();

  useEffect(() => {
    getMapData()
      .then(setMapData)
      .catch((err) => reportError(`Failed to load map data for location tracking: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skip the write-back on mount for both settings - see useTrackedEntries
  // for why a cold WebView2 start can read stale/empty and shouldn't
  // immediately re-persist that as ground truth.
  const currentHydrated = useRef(false);
  useEffect(() => {
    if (!currentHydrated.current) {
      currentHydrated.current = true;
      return;
    }
    if (currentSystem) localStorage.setItem(CURRENT_SYSTEM_KEY, JSON.stringify(currentSystem));
    else localStorage.removeItem(CURRENT_SYSTEM_KEY);
  }, [currentSystem]);

  const radiusHydrated = useRef(false);
  useEffect(() => {
    if (!radiusHydrated.current) {
      radiusHydrated.current = true;
      return;
    }
    localStorage.setItem(RADIUS_KEY, String(radius));
  }, [radius]);

  const adjacency = useMemo(() => {
    const map = new Map<number, number[]>();
    if (!mapData) return map;
    for (const jump of mapData.jumps) {
      addEdge(map, jump.from, jump.to);
      addEdge(map, jump.to, jump.from);
    }
    return map;
  }, [mapData]);

  const radiusSystemIds = useMemo(() => {
    if (!currentSystem || !mapData) return new Set<number>();
    if (radius === "region") {
      const origin = mapData.systems.find((s) => s.id === currentSystem.id);
      if (!origin) return new Set<number>([currentSystem.id]);
      return new Set(mapData.systems.filter((s) => s.region_id === origin.region_id).map((s) => s.id));
    }
    return systemsWithinJumps(currentSystem.id, radius, adjacency);
  }, [currentSystem, radius, mapData, adjacency]);

  useEffect(() => {
    if (seenKillIdsRef.current === null) {
      // First snapshot - just remember what's already there so the whole
      // existing feed doesn't burst into alerts the moment a location is set.
      seenKillIdsRef.current = new Set(kills.map((k) => k.killmail_id));
      return;
    }
    const newlyAlerted: number[] = [];
    for (const kill of kills) {
      if (seenKillIdsRef.current.has(kill.killmail_id)) continue;
      seenKillIdsRef.current.add(kill.killmail_id);
      if (radiusSystemIds.has(kill.system_id)) newlyAlerted.push(kill.killmail_id);
    }
    if (newlyAlerted.length === 0) return;
    // Sound and the desktop notification now fire on the exact same
    // radiusSystemIds match as the ticker highlight/screen flash below -
    // previously sound was hardcoded to a fixed 1-jump range regardless of
    // the chosen radius, which was a confusing split now that the radius
    // picker is front-and-center on the Map screen instead of tucked away
    // in the top bar. One radius, one meaning, for every alert type.
    setSoundToken((n) => n + 1);
    const prefs = readNotificationPreferences();
    if (prefs.enabled && prefs.proximityKills && currentSystem) {
      notify("Proximity Kill Alert", `A kill just landed near ${currentSystem.name}.`);
    }
    setAlertKillIds((prev) => {
      const next = new Set(prev);
      for (const id of newlyAlerted) next.add(id);
      if (next.size > ALERT_HISTORY_LIMIT) {
        const overflow = next.size - ALERT_HISTORY_LIMIT;
        let dropped = 0;
        for (const id of next) {
          if (dropped >= overflow) break;
          next.delete(id);
          dropped++;
        }
      }
      return next;
    });
    setPulseToken((n) => n + 1);
  }, [kills, radiusSystemIds]);

  function setCurrentSystem(system: CurrentSystem | null) {
    setCurrentSystemState(system);
    // A newly-set location shouldn't retroactively flag kills already
    // sitting in the feed as "just happened near me" - only kills arriving
    // from here on should trigger an alert.
    seenKillIdsRef.current = new Set(kills.map((k) => k.killmail_id));
    setAlertKillIds(new Set());
  }

  return (
    <LocationTrackingContext.Provider
      value={{ currentSystem, setCurrentSystem, radius, setRadius, radiusSystemIds, alertKillIds, pulseToken, soundToken }}
    >
      {children}
    </LocationTrackingContext.Provider>
  );
}
