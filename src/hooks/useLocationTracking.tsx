import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getMapData, type MapData } from "../lib/map";
import { getCharacterLocation } from "../lib/eve";
import { useRecentActivity } from "./useRecentActivity";
import { useErrorReporter } from "./useErrorReporter";
import { readNotificationPreferences } from "./useNotificationPreferences";
import { notify } from "../lib/notifications";
import { isTransientServerError } from "../lib/overviewCache";

/** 0 means "just this system, no neighbors" - systemsWithinJumps below
 * already handles it correctly (its BFS loop simply never runs), so it's a
 * real radius value, not a special case threaded through separately. */
export type ProximityRadius = 0 | 1 | 2 | 3 | 5 | 7 | 9 | "region";

const CURRENT_SYSTEM_KEY = "vesper.location.currentSystem";
const RADIUS_KEY = "vesper.location.radius";
const LIVE_TRACKING_CHARACTER_KEY = "vesper.location.liveTrackingCharacterId";
/** Same cadence useCharacterLocation.tsx's own ESI poll already uses for
 * the active character's live position - no reason for this one (a
 * possibly-different, explicitly chosen character) to check any more or
 * less often. */
const LIVE_TRACKING_POLL_MS = 10_000;
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

function readLiveTrackingCharacterId(): number | null {
  try {
    const raw = localStorage.getItem(LIVE_TRACKING_CHARACTER_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function readRadius(): ProximityRadius {
  try {
    const raw = localStorage.getItem(RADIUS_KEY);
    // Nothing stored yet (fresh install) - fall through to the default 5,
    // not 0. Number(null) is 0, which would otherwise silently masquerade
    // as a deliberately-chosen "just my system" setting.
    if (raw === null) return 5;
    if (raw === "region") return "region";
    const n = Number(raw);
    if (n === 0 || n === 1 || n === 2 || n === 3 || n === 5 || n === 7 || n === 9) return n;
    return 5;
  } catch {
    return 5;
  }
}

interface LocationTrackingState {
  /** The tracked current system - either set by hand, or (while
   * liveTrackingCharacterId is set) kept in sync automatically with that
   * character's real in-game location. */
  currentSystem: CurrentSystem | null;
  /** Sets currentSystem by hand and stops live tracking, if it was on - a
   * manual pick is always treated as "I want to drive this myself now". */
  setCurrentSystem: (system: CurrentSystem | null) => void;
  /** Which logged-in character's live ESI location currentSystem is
   * following, or null while in plain manual mode. Switching this (e.g.
   * from one character to another, or to null to stop) is the "track live"
   * feature - currentSystem then follows that character automatically as
   * they move, jump to jump, until switched back to manual or cleared. */
  liveTrackingCharacterId: number | null;
  setLiveTrackingCharacterId: (characterId: number | null) => void;
  /** True once a live-tracked character's location poll comes back needing
   * a fresh EVE SSO login (the scope was never granted, or the token's
   * gone stale) - lets the picker surface that instead of just silently
   * never updating. */
  liveTrackingNeedsReauth: boolean;
  radius: ProximityRadius;
  setRadius: (radius: ProximityRadius) => void;
  /** Every system id within `radius` gate-jumps of currentSystem (or the whole region), including currentSystem itself. Empty when no location is set. */
  radiusSystemIds: Set<number>;
  /** Killmail ids that arrived while inside radiusSystemIds - drives the ticker's red highlight. */
  alertKillIds: Set<number>;
  /** Increments once per batch of newly-arrived proximity kills - consumed by the app-wide flash overlay to trigger its pulse animation. */
  pulseToken: number;
  /** Whether the batch that produced the CURRENT pulseToken value included a
   * kill in the exact current system ("system") or only ones elsewhere
   * within the tracked radius ("nearby") - "system" wins if a batch has
   * both. Consumed by the flash overlay to pick red vs amber. */
  pulseSeverity: "system" | "nearby";
  /** Increments once per batch of newly-arrived proximity kills, same
   * trigger as pulseToken - consumed by the app-wide overlay to play an
   * alert sound. */
  soundToken: number;
  /** Gate-jump distance from currentSystem to every system reachable via
   * stargates (no wormhole legs, matching the map's own jump graph) - a
   * single BFS out from currentSystem rather than one walk per lookup, so
   * any consumer (e.g. Local Threat's "how far is that kill from me" line)
   * can do an O(1) lookup per system instead of re-walking the graph
   * itself. Empty when no location is set; a system with no entry here is
   * either currentSystem's own component has no gate route to it (a
   * wormhole system) or the map hasn't loaded yet. */
  jumpDistances: Map<number, number>;
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
  const [liveTrackingCharacterId, setLiveTrackingCharacterIdState] = useState<number | null>(() => readLiveTrackingCharacterId());
  const [liveTrackingNeedsReauth, setLiveTrackingNeedsReauth] = useState(false);
  const [radius, setRadius] = useState<ProximityRadius>(() => readRadius());
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [alertKillIds, setAlertKillIds] = useState<Set<number>>(new Set());
  const [pulseToken, setPulseToken] = useState(0);
  const [pulseSeverity, setPulseSeverity] = useState<"system" | "nearby">("nearby");
  const [soundToken, setSoundToken] = useState(0);
  const seenKillIdsRef = useRef<Set<number> | null>(null);
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();
  // Mirrors `kills` for setCurrentSystem to read without needing `kills`
  // itself in its dependency array - kills updates on every poll tick, and a
  // callback that closed over it directly would get a new identity that
  // often, which would in turn make the context value below rebuild just as
  // often even though nothing consumers actually care about changed.
  const killsRef = useRef(kills);
  killsRef.current = kills;
  // Lets the live-tracking poll loop below (whose effect only depends on
  // liveTrackingCharacterId, so it doesn't restart every time the system
  // changes) always compare against the latest currentSystem without being
  // torn down and recreated on every jump.
  const currentSystemRef = useRef(currentSystem);
  currentSystemRef.current = currentSystem;

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

  const liveTrackingHydrated = useRef(false);
  useEffect(() => {
    if (!liveTrackingHydrated.current) {
      liveTrackingHydrated.current = true;
      return;
    }
    if (liveTrackingCharacterId != null) localStorage.setItem(LIVE_TRACKING_CHARACTER_KEY, String(liveTrackingCharacterId));
    else localStorage.removeItem(LIVE_TRACKING_CHARACTER_KEY);
  }, [liveTrackingCharacterId]);

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

  /** Full BFS out from currentSystem, one pass, recording the depth every
   * reachable system was first found at - unlike radiusSystemIds above
   * (which stops at the chosen alert radius), this keeps going until the
   * whole reachable graph is covered, since a consumer might want the
   * distance to a system far outside the alert radius (e.g. "how far was
   * that kill from me", not "is it close enough to alert on"). */
  const jumpDistances = useMemo(() => {
    const distances = new Map<number, number>();
    if (!currentSystem) return distances;
    distances.set(currentSystem.id, 0);
    let frontier = [currentSystem.id];
    let depth = 0;
    while (frontier.length > 0) {
      depth++;
      const next: number[] = [];
      for (const systemId of frontier) {
        for (const neighbor of adjacency.get(systemId) ?? []) {
          if (!distances.has(neighbor)) {
            distances.set(neighbor, depth);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return distances;
  }, [currentSystem, adjacency]);

  useEffect(() => {
    if (seenKillIdsRef.current === null) {
      // First snapshot - just remember what's already there so the whole
      // existing feed doesn't burst into alerts the moment a location is set.
      seenKillIdsRef.current = new Set(kills.map((k) => k.killmail_id));
      return;
    }
    const newlyAlerted: number[] = [];
    // Same-system beats nearby the moment even one qualifying kill shows up -
    // a batch that's part "just outside" and part "right here" is still,
    // overall, a "right here" alert.
    let sawSameSystem = false;
    // kills is sorted newest-first, so the first id already in seenKillIdsRef
    // marks the boundary of what's been scanned before - everything after it
    // is guaranteed already-seen too, no need to keep walking the rest.
    for (const kill of kills) {
      if (seenKillIdsRef.current.has(kill.killmail_id)) break;
      seenKillIdsRef.current.add(kill.killmail_id);
      if (radiusSystemIds.has(kill.system_id)) {
        newlyAlerted.push(kill.killmail_id);
        if (currentSystem && kill.system_id === currentSystem.id) sawSameSystem = true;
      }
    }
    if (newlyAlerted.length === 0) return;
    // Sound and the desktop notification now fire on the exact same
    // radiusSystemIds match as the ticker highlight/screen flash below -
    // previously sound was hardcoded to a fixed 1-jump range regardless of
    // the chosen radius, which was a confusing split now that the radius
    // picker is front-and-center on the Map screen instead of tucked away
    // in the top bar. One radius, one meaning, for every alert type.
    setSoundToken((n) => n + 1);
    setPulseSeverity(sawSameSystem ? "system" : "nearby");
    const prefs = readNotificationPreferences();
    if (prefs.enabled && prefs.proximityKills && currentSystem) {
      notify(
        "Proximity Kill Alert",
        sawSameSystem ? `A kill just landed in ${currentSystem.name} - your own system.` : `A kill just landed near ${currentSystem.name}.`,
      );
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

  /** Shared by both the manual setter below and the live-tracking poll -
   * applies a new currentSystem and resets the proximity-alert "already
   * seen" bookkeeping, since a genuine location change means kills already
   * in the feed shouldn't retroactively count as "just happened near me". */
  const applyCurrentSystem = useCallback((system: CurrentSystem | null) => {
    setCurrentSystemState(system);
    seenKillIdsRef.current = new Set(killsRef.current.map((k) => k.killmail_id));
    setAlertKillIds(new Set());
  }, []);

  const setCurrentSystem = useCallback(
    (system: CurrentSystem | null) => {
      // A manual pick always means "I want to drive this myself now" - stop
      // following whichever character's live location was driving it before.
      setLiveTrackingCharacterIdState(null);
      applyCurrentSystem(system);
    },
    [applyCurrentSystem],
  );

  const setLiveTrackingCharacterId = useCallback((characterId: number | null) => {
    setLiveTrackingNeedsReauth(false);
    setLiveTrackingCharacterIdState(characterId);
  }, []);

  // While a character is selected for live tracking, poll their real ESI
  // location and keep currentSystem following it - runs independently of
  // useCharacterLocation.tsx's own poll (which only ever follows whichever
  // character is the app's "active" one), since the pilot picking who to
  // follow here is deliberately not tied to that.
  useEffect(() => {
    if (liveTrackingCharacterId == null) return;
    let active = true;

    async function pollLoop() {
      while (active) {
        try {
          const loc = await getCharacterLocation(liveTrackingCharacterId!);
          if (!active) break;
          if (loc.needs_reauth) {
            setLiveTrackingNeedsReauth(true);
          } else if (loc.solar_system_id != null && loc.solar_system_name != null) {
            setLiveTrackingNeedsReauth(false);
            if (currentSystemRef.current?.id !== loc.solar_system_id) {
              applyCurrentSystem({ id: loc.solar_system_id, name: loc.solar_system_name });
            }
          }
        } catch (err) {
          if (!active) break;
          // A 429 from ESI here is expected and self-resolving (the next
          // tick 10s later just tries again) - the same "don't alarm the
          // user over something that isn't their problem" treatment
          // Dashboard.tsx already gives a transient gateway timeout, not
          // something worth a System Error modal every single poll.
          if (!isTransientServerError(String(err))) {
            reportError(`Failed to poll live-tracked character's location: ${String(err)}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, LIVE_TRACKING_POLL_MS));
      }
    }

    pollLoop();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTrackingCharacterId, applyCurrentSystem]);

  // Without this, the provider re-renders on every kills poll tick (kills
  // isn't even part of the context value, just used internally) and handed
  // every consumer a brand-new object each time, making them all eligible to
  // re-render regardless of whether anything they read actually changed.
  const value = useMemo(
    () => ({
      currentSystem,
      setCurrentSystem,
      liveTrackingCharacterId,
      setLiveTrackingCharacterId,
      liveTrackingNeedsReauth,
      radius,
      setRadius,
      radiusSystemIds,
      alertKillIds,
      pulseToken,
      pulseSeverity,
      soundToken,
      jumpDistances,
    }),
    [
      currentSystem,
      setCurrentSystem,
      liveTrackingCharacterId,
      setLiveTrackingCharacterId,
      liveTrackingNeedsReauth,
      radius,
      setRadius,
      radiusSystemIds,
      alertKillIds,
      pulseToken,
      pulseSeverity,
      soundToken,
      jumpDistances,
    ],
  );

  return (
    <LocationTrackingContext.Provider value={value}>
      {children}
    </LocationTrackingContext.Provider>
  );
}
