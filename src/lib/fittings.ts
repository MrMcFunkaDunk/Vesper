import { invoke } from "@tauri-apps/api/core";

export interface FitItem {
  type_id: number;
  flag: string;
  quantity: number;
}

export interface Fit {
  id: string;
  name: string;
  ship_type_id: number;
  description: string;
  purpose: string;
  tags: string[];
  items: FitItem[];
  source: "local" | "esi";
  esi_character_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface FitInput {
  id: string | null;
  name: string;
  ship_type_id: number;
  description: string;
  purpose: string;
  tags: string[];
  items: FitItem[];
}

/** Every saved fit (local + ESI-synced), full item detail included - a
 * personal library, realistically dozens of entries, so one bulk read. */
export function listFits(): Promise<Fit[]> {
  return invoke("list_fits");
}

export function getFit(id: string): Promise<Fit> {
  return invoke("get_fit", { id });
}

/** Creates a new local fit (input.id null) or updates an existing one. */
export function saveFit(input: FitInput): Promise<string> {
  return invoke("save_fit", { input });
}

export function deleteFit(id: string): Promise<void> {
  return invoke("delete_fit", { id });
}

/** Mirrors a character's real in-game fits into the local library. */
export function syncCharacterFittings(characterId: number): Promise<number> {
  return invoke("sync_character_fittings", { characterId });
}

/** Pushes a fit straight into a character's in-game Fittings browser via
 * ESI's write endpoint - no copy/paste needed. Returns the new fitting_id. */
export function sendFitToCharacter(characterId: number, fitId: string): Promise<number> {
  return invoke("send_fit_to_character", { characterId, fitId });
}

export function getFitCost(fitId: string): Promise<number> {
  return invoke("get_fit_cost", { fitId });
}

/** Standard EFT fit text - paste into EVE's in-game "Import Fitting" dialog. */
export function exportFitEft(fitId: string): Promise<string> {
  return invoke("export_fit_eft", { fitId });
}

export function exportFitDna(fitId: string): Promise<string> {
  return invoke("export_fit_dna", { fitId });
}
