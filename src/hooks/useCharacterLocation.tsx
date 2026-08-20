import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getCharacterLocation } from "../lib/eve";
import { useErrorReporter } from "./useErrorReporter";

const POLL_INTERVAL_MS = 10_000;

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
    setState((prev) => ({ ...prev, loading: true }));

    async function pollLoop() {
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
