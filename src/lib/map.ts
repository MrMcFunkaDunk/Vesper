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

export interface SystemSearchMatch {
  id: number;
  name: string;
  security: number;
}

/** Live prefix search against the local systems cache (same data as the map) - unlike
 * the exact-match-only ESI lookup, this returns every system starting with the query. */
export function searchSystemsLive(query: string): Promise<SystemSearchMatch[]> {
  return invoke("search_systems_live", { query });
}
