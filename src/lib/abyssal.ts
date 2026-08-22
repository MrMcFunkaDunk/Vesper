import { invoke } from "@tauri-apps/api/core";

export interface AbyssalRolledAttribute {
  name: string;
  value: number;
  base_value: number;
  unit: string | null;
}

export interface AbyssalValueResult {
  source_type_id: number;
  mutator_type_id: number;
  /** MutaMarket occasionally has no estimate yet for a very rare roll -
   * still worth showing the rolled attributes even without a number. */
  estimated_value: number | null;
  rolled_attributes: AbyssalRolledAttribute[];
}

/** Checks whether one specific owned item (a real item_id, not just a
 * type_id) is a mutated/abyssal item, and if so estimates its ISK value
 * via MutaMarket - a community-run, machine-learning estimate, not a
 * guaranteed sell price. Returns null for the (vast majority) of items
 * that simply aren't mutated at all. */
export function checkAbyssalValue(typeId: number, itemId: number): Promise<AbyssalValueResult | null> {
  return invoke("check_abyssal_value", { typeId, itemId });
}
