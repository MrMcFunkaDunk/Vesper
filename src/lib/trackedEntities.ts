import { invoke } from "@tauri-apps/api/core";

export type TrackedEntityKind = "character" | "corporation" | "alliance";

export interface TrackedEntity {
  entity_id: number;
  entity_name: string;
  kind: TrackedEntityKind;
}

export interface TrackedEntitiesSettings {
  entities: TrackedEntity[];
}

export function getTrackedEntities(): Promise<TrackedEntitiesSettings> {
  return invoke("get_tracked_entities");
}

export function addTrackedEntity(entityId: number, entityName: string, kind: TrackedEntityKind): Promise<TrackedEntitiesSettings> {
  return invoke("add_tracked_entity", { entityId, entityName, kind });
}

export function removeTrackedEntity(entityId: number, kind: TrackedEntityKind): Promise<TrackedEntitiesSettings> {
  return invoke("remove_tracked_entity", { entityId, kind });
}

/** Payload of the "tracked-player-event" Tauri event, emitted from the
 * backend's live kill history recorder whenever a tracked character,
 * corporation, or alliance appears as a kill's victim or one of its
 * attackers. */
export interface TrackedEntityEvent {
  tracked_entity_name: string;
  tracked_entity_kind: TrackedEntityKind;
  subject_character_name: string | null;
  event: "killed" | "died";
  other_name: string | null;
  ship_type_name: string;
  system_name: string;
  total_value: number;
  killmail_id: number;
}
