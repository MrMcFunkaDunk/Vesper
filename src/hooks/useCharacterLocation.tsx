import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getCharacterLocation } from "../lib/eve";
import { listChains } from "../lib/wormholes";
import { useErrorReporter } from "./useErrorReporter";

const POLL_INTERVAL_MS = 10_000;
/** How often to check whether this poll is even needed yet, while idle -
 * much slower than the real poll since "does an auto-map chain exist" or
 * "is the Wormhole Finder open" rarely changes. */
const IDLE_CHECK_INTERVAL_MS = 30_000;

/** Bumped by any component that needs live location right now (the Wormhole
 * Finder page, while open) regardless of whether auto-mapping is configured
 * - lets CharacterLocationProvider's poll idle for everyone else instead of
 * running a permanent 10s ESI poll for the whole session just in case. */
let activeDemand = 0;

/** Call from any component that reads useCharacterLocation() outside of
 * auto-mapping - registers that live polling is needed while mounted. */
export function useCharacterLocationDemand() {
  useEffect(() => {
    activeDemand++;
    return () => {
      activeDemand--;
    };
  }, []);
}

interface CharacterLocationState {
  systemId: number | null;
  systemName: string | null;
  shipTypeId: number | null;
  shipTypeName: string | null;
  loading: boolean;
  needsReauth: boolean;
}

const EMPTY_STATE: CharacterLocationState = {
  systemId: null,
  systemName: null,
  shipTypeId: null,
  shipTypeName: null,
  loading: false,
  needsReauth: false,
};

const CharacterLocationContext = createContext<CharacterLocationState | null>(null);

/**
 * The active character's live current system + ship, from a background poll
 * kept in a provider so it keeps updating for the whole session regardless
 * of which tab is open - the Path & Wormhole Finder's auto-pathing and
 * auto-map-building both depend on this still running while the user is on
 * a different page, since that page fully unmounts on tab switch.
 *
 * Deliberately separate from useLocationTracking.tsx, which is a manual,
 * character-agnostic "where am I" tracker the user sets by hand (driving
 * TopBar's search box and proximity-kill-alerts) - this hook is real
 * ESI-backed live location for one specific character and never touches
 * that existing manual state.
 */
export function useCharacterLocation(): CharacterLocationState {
  const ctx = useContext(CharacterLocationContext);
  if (!ctx) {
    throw new Error("useCharacterLocation must be used within a CharacterLocationProvider");
  }
  return ctx;
}

interface CharacterLocationProviderProps {
  characterId: number | null;
  children: ReactNode;
}

export function CharacterLocationProvider({ characterId, children }: CharacterLocationProviderProps) {
  const [state, setState] = useState<CharacterLocationState>(EMPTY_STATE);
  const reportError = useErrorReporter();

  useEffect(() => {
    if (characterId == null) {
      setState(EMPTY_STATE);
      return;
    }
    let active = true;

    async function hasAutoMapChain(): Promise<boolean> {
      try {
        const chains = await listChains();
        return chains.some((c) => c.auto_map_enabled);
      } catch {
        return false;
      }
    }

    async function waitUntilNeeded() {
      // Nothing needs live location except wormhole auto-mapping (in the
      // background) and the Wormhole Finder page itself (while open) - so
      // this stays idle, checking in only occasionally, instead of running
      // a permanent 10s ESI poll for the whole session regardless of
      // whether either is ever actually used.
      while (active) {
        if (activeDemand > 0 || (await hasAutoMapChain())) return;
        await new Promise((resolve) => setTimeout(resolve, IDLE_CHECK_INTERVAL_MS));
      }
    }

    async function pollLoop() {
      await waitUntilNeeded();
      if (!active) return;
      setState((prev) => ({ ...prev, loading: true }));
      while (active) {
        try {
          const loc = await getCharacterLocation(characterId!);
          if (!active) break;
          setState({
            systemId: loc.solar_system_id,
            systemName: loc.solar_system_name,
            shipTypeId: loc.ship_type_id,
            shipTypeName: loc.ship_type_name,
            loading: false,
            needsReauth: loc.needs_reauth,
          });
        } catch (err) {
          if (!active) break;
          reportError(`Failed to poll character location: ${String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    pollLoop();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  return <CharacterLocationContext.Provider value={state}>{children}</CharacterLocationContext.Provider>;
}
