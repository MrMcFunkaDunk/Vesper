import { invoke } from "@tauri-apps/api/core";

export interface PiMaterial {
  type_id: number;
  name: string;
  /** "P0".."P4" - derived from the recipe graph itself on the backend. */
  tier: string;
}

export interface PiSchematicMaterial {
  type_id: number;
  quantity: number;
}

export interface PiSchematic {
  id: number;
  name: string;
  cycle_time: number;
  inputs: PiSchematicMaterial[];
  outputs: PiSchematicMaterial[];
}

export interface PiPlanetType {
  name: string;
  p0_type_ids: number[];
}

export interface PiData {
  materials: PiMaterial[];
  schematics: PiSchematic[];
  planet_types: PiPlanetType[];
}

/** The full static PI production graph (planet types, P0-P4 materials, and
 * every schematic's inputs/outputs) - fetched once and cached by the
 * backend's own local SQLite sync, not re-fetched per interaction. */
export function getPiData(): Promise<PiData> {
  return invoke("get_pi_data");
}
