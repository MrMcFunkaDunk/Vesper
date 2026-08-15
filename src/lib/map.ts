import { invoke } from "@tauri-apps/api/core";

export interface MapSystem {
  id: number;
  name: string;
  region_id: number;
  security: number;
  x: number;
  y: number;
}

export interface MapJump {
  from: number;
  to: number;
}

export interface MapRegion {
  id: number;
  name: string;
}

export interface MapData {
  systems: MapSystem[];
  jumps: MapJump[];
  regions: MapRegion[];
}

/** Loads the universe map from the local SDE cache, syncing it from a community CSV mirror on first use if empty. */
export function getMapData(): Promise<MapData> {
  return invoke("get_map_data");
}
