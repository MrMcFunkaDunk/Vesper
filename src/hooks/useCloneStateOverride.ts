import { useCallback, useEffect, useState } from "react";

type CloneStateMap = Record<number, "Alpha" | "Omega">;

const STORAGE_KEY = "vesper-clone-state-overrides";

function readStorage(): CloneStateMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CloneStateMap) : {};
  } catch {
    return {};
  }
}

/**
 * ESI has no Alpha/Omega field anywhere - the effective clone state shown is
 * the auto-detected value from the backend (skill-cap based, see
 * detect_clone_state in esi.rs) unless the user has manually overridden it
 * for that character, persisted here the same way sidebar color overrides are.
 */
export function useCloneStateOverride() {
  const [overrides, setOverrides] = useState<CloneStateMap>(() => readStorage());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }, [overrides]);

  const setOverride = useCallback((characterId: number, state: "Alpha" | "Omega") => {
    setOverrides((prev) => ({ ...prev, [characterId]: state }));
  }, []);

  const clearOverride = useCallback((characterId: number) => {
    setOverrides((prev) => {
      if (!(characterId in prev)) return prev;
      const next = { ...prev };
      delete next[characterId];
      return next;
    });
  }, []);

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
    [],
  );

  return { overrides, setOverride, clearOverride, cycleOverride };
}
