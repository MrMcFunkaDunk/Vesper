import { invoke } from "@tauri-apps/api/core";

export interface WarParty {
  id: number;
  is_alliance: boolean;
}

export interface WarSummary {
  id: number;
  aggressor: WarParty | null;
  defender: WarParty | null;
  allies: WarParty[];
  declared: string;
  started: string | null;
  retracted: string | null;
  finished: string | null;
  mutual: boolean;
  open_for_allies: boolean;
}

/** Active wars touching a corporation or alliance, from a locally-synced
 * recent window (ESI has no corp/alliance -> wars lookup at all, so this
 * is a best-effort recent scan, not an exhaustive historical index). */
export function getWarsForEntity(entityId: number): Promise<WarSummary[]> {
  return invoke("get_wars_for_entity", { entityId });
}

/** A single war's full record, fetched live (works even for a war outside
 * the locally-synced recent window). */
export function getWarDetail(warId: number): Promise<WarSummary> {
  return invoke("get_war_detail", { warId });
}

/** Bulk id->name lookup for arbitrary entities (corporations, alliances,
 * characters, ...) - keys come back as strings since they round-tripped
 * through a JSON object. */
export function resolveEntityNames(ids: number[]): Promise<Record<string, string>> {
  return invoke("resolve_entity_names", { ids });
}
