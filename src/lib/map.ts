import { invoke } from "@tauri-apps/api/core";

export interface MapSystem {
  id: number;
  name: string;
  region_id: number;
  constellation_id: number;
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

/** The five major NPC-station trade hubs, keyed by the region that contains
 * them - so a region picker can label e.g. "The Forge (Jita)" without the
 * user needing to know EVE geography by heart, and color it by the hub's
 * owning empire faction so the handful of hub rows jump out at a glance
 * amongst ~90 otherwise-identical grey region names. */
const TRADE_HUB_BY_REGION: Record<string, { hub: string; color: string }> = {
  "The Forge": { hub: "Jita", color: "#4A9FE0" }, // Caldari State
  Domain: { hub: "Amarr", color: "#E0B84A" }, // Amarr Empire
  "Sinq Laison": { hub: "Dodixie", color: "#52C77E" }, // Gallente Federation
  Heimatar: { hub: "Rens", color: "#E0574A" }, // Minmatar Republic
  Metropolis: { hub: "Hek", color: "#E0574A" }, // Minmatar Republic
};

/** "The Forge (Jita)" for a trade-hub region, otherwise just the region's own name unchanged. */
export function regionLabelWithHub(regionName: string): string {
  const entry = TRADE_HUB_BY_REGION[regionName];
  return entry ? `${regionName} (${entry.hub})` : regionName;
}

/** The owning faction's brand color for a trade-hub region's row, or undefined for every other region (left at the default text color). */
export function regionHubColor(regionName: string): string | undefined {
  return TRADE_HUB_BY_REGION[regionName]?.color;
}

/** The five trade-hub regions with their real ids, for pages that want a
 * quick-pick shortlist (Market Browser, Appraisal) ahead of a full "every
 * other region" picker - one canonical id/name pairing so neither page's
 * shortlist can drift out of sync with the other. */
export const TRADE_HUB_REGIONS: { regionId: number; regionName: string }[] = [
  { regionId: 10000002, regionName: "The Forge" },
  { regionId: 10000043, regionName: "Domain" },
  { regionId: 10000032, regionName: "Sinq Laison" },
  { regionId: 10000030, regionName: "Heimatar" },
  { regionId: 10000042, regionName: "Metropolis" },
];

export interface MapConstellation {
  id: number;
  name: string;
  region_id: number;
}

export interface SystemServices {
  system_id: number;
  services: string[];
}

export interface MapData {
  systems: MapSystem[];
  jumps: MapJump[];
  regions: MapRegion[];
  constellations: MapConstellation[];
  system_services: SystemServices[];
  industry_system_ids: number[];
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

export interface StationInfo {
  id: number;
  name: string;
  services: string[];
}

export interface CelestialInfo {
  id: number;
  name: string;
  kind: string;
  orbit_id: number | null;
}

export interface NearestSystem {
  id: number;
  name: string;
  jumps: number;
}

export interface SystemDetail {
  id: number;
  name: string;
  region_id: number;
  region_name: string;
  constellation_id: number;
  constellation_name: string;
  security: number;
  planet_count: number;
  moon_count: number;
  ship_jumps_1h: number;
  ship_kills_1h: number;
  npc_kills_1h: number;
  pod_kills_1h: number;
  celestials: CelestialInfo[];
  stations: StationInfo[];
  player_structures: PlayerStructureInfo[];
  nearest_nullsec: NearestSystem | null;
  nearest_lowsec: NearestSystem | null;
}

/** DOTLAN-style system detail: static facts + celestials + stations from the
 * local cache, live jump/kill snapshots from ESI, and nearest 0.0/lowsec via
 * a jump-graph BFS. */
export function getSystemDetail(systemId: number): Promise<SystemDetail> {
  return invoke("get_system_detail", { systemId });
}

export interface CharacterHomeSystem {
  character_id: number;
  system_id: number | null;
}

/** Each character's home station resolved to a system id, for the map's
 * home-base portrait pins. Best-effort per character - no token, no scope,
 * or a player-owned structure home (not in the local NPC stations table)
 * all just mean system_id: null for that one. */
export function getCharacterHomeSystems(characterIds: number[]): Promise<CharacterHomeSystem[]> {
  return invoke("get_character_home_systems", { characterIds });
}

export interface PlayerStructureInfo {
  id: number;
  name: string;
  system_id: number;
  owner_corporation_id: number;
  owner_corporation_name: string | null;
  owner_corporation_ticker: string | null;
  owner_alliance_id: number | null;
  owner_alliance_name: string | null;
  owner_alliance_ticker: string | null;
}

/** Every public player-owned structure (citadels, engineering complexes,
 * refineries, Ansiblex gates, etc.) with its system and owning corp/alliance -
 * synced at most once a day server-side since these rarely move. */
export function getPlayerStructures(): Promise<PlayerStructureInfo[]> {
  return invoke("get_player_structures");
}

export interface JumpHistoryPoint {
  sampled_at: number;
  ship_jumps: number;
}

/** Locally-accumulated jump history for a system - unlike kills, ESI has no
 * historical jumps endpoint at all, so this only has data from whenever the
 * app's background sampler started running onward. Starts empty (or short)
 * right after a fresh install and fills in the longer the app stays open. */
export function getSystemJumpHistory(systemId: number): Promise<JumpHistoryPoint[]> {
  return invoke("get_system_jump_history", { systemId });
}

export interface SystemPosition {
  system_id: number;
  x: number;
  y: number;
  z: number;
}

/** Real 3D positions (meters) for a batch of systems - distinct from
 * MapSystem's x/y, which are the flattened DOTLAN-style map projection used
 * for on-screen layout, not real distances. Used by the Capital Route
 * planner's light-year jump math. */
export function getSystemPositions(ids: number[]): Promise<SystemPosition[]> {
  return invoke("get_system_positions", { ids });
}
