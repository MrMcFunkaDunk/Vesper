import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  getTrackedEntities,
  addTrackedEntity,
  removeTrackedEntity,
  type TrackedEntity,
  type TrackedEntityKind,
} from "../lib/trackedEntities";
import { useErrorReporter } from "./useErrorReporter";

interface TrackedEntitiesState {
  entities: TrackedEntity[];
  loading: boolean;
  isTracked: (entityId: number, kind: TrackedEntityKind) => boolean;
  toggle: (entityId: number, entityName: string, kind: TrackedEntityKind) => void;
}

const TrackedEntitiesContext = createContext<TrackedEntitiesState | null>(null);

/**
 * Shared, app-wide tracked-entity list (characters/corporations/alliances
 * to get kill/death alerts for) - backed by the Rust side's
 * tracked_entities.json, not localStorage, since the backend's kill history
 * recorder is what actually matches live kills against this list. A single
 * fetch on mount, kept in sync in-memory from here on so a "Track" button on
 * a killboard page and the Settings panel's list never drift apart within
 * one running session.
 */
export function useTrackedEntities(): TrackedEntitiesState {
  const ctx = useContext(TrackedEntitiesContext);
  if (!ctx) {
    throw new Error("useTrackedEntities must be used within a TrackedEntitiesProvider");
  }
  return ctx;
}

export function TrackedEntitiesProvider({ children }: { children: ReactNode }) {
  const [entities, setEntities] = useState<TrackedEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const reportError = useErrorReporter();

  useEffect(() => {
    getTrackedEntities()
      .then((s) => setEntities(s.entities))
      .catch((err) => reportError(`Failed to load tracked players/corps/alliances: ${String(err)}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isTracked(entityId: number, kind: TrackedEntityKind): boolean {
    return entities.some((e) => e.entity_id === entityId && e.kind === kind);
  }

  function toggle(entityId: number, entityName: string, kind: TrackedEntityKind) {
    const action = isTracked(entityId, kind) ? removeTrackedEntity(entityId, kind) : addTrackedEntity(entityId, entityName, kind);
    action.then((s) => setEntities(s.entities)).catch((err) => reportError(`Failed to update tracking for ${entityName}: ${String(err)}`));
  }

  return <TrackedEntitiesContext.Provider value={{ entities, loading, isTracked, toggle }}>{children}</TrackedEntitiesContext.Provider>;
}
