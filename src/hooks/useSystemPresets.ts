import { usePersistentState } from "./usePersistentState";

export interface SystemPreset {
  systemId: number;
  systemName: string;
  hubRegionId: number;
  /** StructureTier's own values ("npc_station" | "engineering_complex"), stored loosely to avoid importing a component-local type - the reader narrows it the same defensive way industryDefaults.production.structure already is. */
  structure: string;
  facilityTax: number;
  /** Structure owner's job-cost role bonus, as entered (e.g. 3 for -3%) - manual for now, see IndustryPage.tsx's job cost panel. */
  structureRoleBonusPct: number;
  /** Whether to apply the flat Alpha-clone job-cost surcharge - manual for now, same reasoning as structureRoleBonusPct. */
  isAlphaClone: boolean;
}

const STORAGE_KEY = "vesper.industry.systemPresets";

/** Per-system saved facility setups for the Industry Production calculator -
 * everywhere you actually build from (Alsottobier, Jita, wherever) can be
 * picked from a list with its own Trade Hub/facility tax/structure role
 * bonus/structure type/Alpha status restored exactly, independent of
 * whichever blueprint happens to be selected right now. Deliberately doesn't
 * carry anything blueprint-specific (runs/ME/TE/the blueprint itself) - a
 * saved system is a place you build, not a build, so loading one never
 * disturbs whatever item you're currently calculating. One saved setup per
 * system, keyed by system id - saving again for the same system overwrites
 * its previous setup rather than duplicating. */
export function useSystemPresets() {
  const [presets, setPresets] = usePersistentState<SystemPreset[]>(STORAGE_KEY, []);

  function isSystemPreset(systemId: number): boolean {
    return presets.some((p) => p.systemId === systemId);
  }

  function saveSystemPreset(preset: SystemPreset) {
    setPresets((prev) => [...prev.filter((p) => p.systemId !== preset.systemId), preset]);
  }

  function removeSystemPreset(systemId: number) {
    setPresets((prev) => prev.filter((p) => p.systemId !== systemId));
  }

  return { presets, isSystemPreset, saveSystemPreset, removeSystemPreset };
}
