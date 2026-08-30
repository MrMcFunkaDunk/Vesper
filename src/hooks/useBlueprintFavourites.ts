import { usePersistentState } from "./usePersistentState";

export interface BlueprintFavourite {
  typeId: number;
  name: string;
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
  /** StructureTier's own values ("npc_station" | "engineering_complex"), stored loosely to avoid importing a component-local type - the reader narrows it the same defensive way industryDefaults.production.structure already is. */
  structure: string;
  facilityTax: number;
  /** Structure owner's job-cost role bonus, as entered (e.g. 3 for -3%) - manual for now, see IndustryPage.tsx's job cost panel. */
  structureRoleBonusPct: number;
  /** Whether to apply the flat Alpha-clone job-cost surcharge - manual for now, same reasoning as structureRoleBonusPct. */
  isAlphaClone: boolean;
  hubRegionId: number;
  systemId: number | null;
  systemName: string | null;
}

const STORAGE_KEY = "vesper.industry.blueprintFavourites";

/** Per-blueprint saved setups for the Industry Production calculator - a
 * blueprint you build often can be picked from a list with every input
 * (runs/ME/TE/structure/facility tax/trade hub/system) restored exactly as
 * it was left, instead of retyping the same setup every time. One saved
 * setup per blueprint, keyed by type_id - saving again for the same
 * blueprint overwrites its previous setup rather than duplicating. */
export function useBlueprintFavourites() {
  const [favourites, setFavourites] = usePersistentState<BlueprintFavourite[]>(STORAGE_KEY, []);

  function isFavourite(typeId: number): boolean {
    return favourites.some((f) => f.typeId === typeId);
  }

  function saveFavourite(favourite: BlueprintFavourite) {
    setFavourites((prev) => [...prev.filter((f) => f.typeId !== favourite.typeId), favourite]);
  }

  function removeFavourite(typeId: number) {
    setFavourites((prev) => prev.filter((f) => f.typeId !== typeId));
  }

  return { favourites, isFavourite, saveFavourite, removeFavourite };
}
