import { useCallback } from "react";
import { usePersistentState } from "./usePersistentState";

type CloneStateMap = Record<number, "Alpha" | "Omega">;

const STORAGE_KEY = "vesper-clone-state-overrides";

/**
 * ESI has no Alpha/Omega field anywhere - the effective clone state shown is
 * the auto-detected value from the backend (skill-cap based, see
 * detect_clone_state in esi.rs) unless the user has manually overridden it
 * for that character, persisted here the same way sidebar color overrides are.
 */
export function useCloneStateOverride() {
  const [overrides, setOverrides] = usePersistentState<CloneStateMap>(STORAGE_KEY, {});

  const setOverride = useCallback(
    (characterId: number, state: "Alpha" | "Omega") => {
      setOverrides((prev) => ({ ...prev, [characterId]: state }));
    },
    [setOverrides],
  );

  const clearOverride = useCallback(
    (characterId: number) => {
      setOverrides((prev) => {
        if (!(characterId in prev)) return prev;
        const next = { ...prev };
        delete next[characterId];
        return next;
      });
    },
    [setOverrides],
  );

  const cycleOverride = useCallback(
    (characterId: number, autoDetected: string | null) => {
      setOverrides((prev) => {
        const current = prev[characterId] ?? autoDetected ?? null;
        const next = { ...prev };
        if (current === "Alpha") {
          next[characterId] = "Omega";
        } else if (current === "Omega") {
          delete next[characterId];
        } else {
          next[characterId] = "Alpha";
        }
        return next;
      });
    },
    [setOverrides],
  );

  return { overrides, setOverride, clearOverride, cycleOverride };
}
