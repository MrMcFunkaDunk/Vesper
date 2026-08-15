import { useEffect, useState } from "react";
import type { SystemMatch } from "../lib/kills";

const STORAGE_KEY = "vesper.kills.watchedSystems";

function readStorage(): SystemMatch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SystemMatch[]) : [];
  } catch {
    return [];
  }
}

/** Persists the list of solar systems the Kills & Intel feed watches. */
export function useWatchedSystems() {
  const [systems, setSystems] = useState<SystemMatch[]>(() => readStorage());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(systems));
  }, [systems]);

  function addSystem(system: SystemMatch) {
    setSystems((prev) => (prev.some((s) => s.id === system.id) ? prev : [...prev, system]));
  }

  function removeSystem(id: number) {
    setSystems((prev) => prev.filter((s) => s.id !== id));
  }

  return { systems, addSystem, removeSystem };
}
