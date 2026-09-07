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

/** Just the hub city name ("Jita") for a trade-hub region - unlike
 * regionLabelWithHub's combined "The Forge (Jita)" form, this is for a
 * plain 5-way trade-hub picker where showing the underlying region name
 * at all is more confusing than useful (nobody thinks of Jita as "The
 * Forge"). Falls back to the region's own name for anything that isn't
 * one of the five hubs. */
export function tradeHubName(regionName: string): string {
  return TRADE_HUB_BY_REGION[regionName]?.hub ?? regionName;
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

export interface FwSystemStatus {
  solar_system_id: number;
  owner_faction_id: number;
  occupier_faction_id: number;
  /** Can flip to the occupier right now - ESI's own richer "captured" /
   * "contested" / "uncontested" / "vs_multiple" enum collapsed to this one
   * boolean since that's the only distinction the map filter cares about. */
  contested: boolean;
  victory_points: number;
  victory_points_threshold: number;
}

/** The four faction-warfare empire factions - a fixed, decades-stable set,
 * so hardcoded here rather than costing an ESI name-resolution round trip
 * for values that never change. Colors match the same faction palette
 * TRADE_HUB_BY_REGION already uses, so a system's FW ring and its region's
 * hub color (when it happens to be a hub region too) never clash. */
const FW_FACTIONS: Record<number, { name: string; color: string }> = {
  500001: { name: "Caldari State", color: "#4A9FE0" },
  500002: { name: "Minmatar Republic", color: "#E0574A" },
  500003: { name: "Amarr Empire", color: "#E0B84A" },
  500004: { name: "Gallente Federation", color: "#52C77E" },
};

export function fwFactionName(factionId: number): string {
  return FW_FACTIONS[factionId]?.name ?? "Unknown Faction";
}

export function fwFactionColor(factionId: number): string {
  return FW_FACTIONS[factionId]?.color ?? "#9aa5ad";
}

/** The same four factions as a list, for anything that wants to render a
 * key/legend rather than look one up by id. */
export const FW_FACTION_LIST: { id: number; name: string; color: string }[] = Object.entries(FW_FACTIONS).map(
  ([id, f]) => ({ id: Number(id), ...f }),
);

/** Live faction-warfare status for every warzone system - which faction
 * occupies it and whether it's actively contested (can flip). Its own
 * fetch, polled independently of the main map payload since front lines
 * move constantly, the same reason kill heat is a separate fetch too. */
export function getFwSystems(): Promise<FwSystemStatus[]> {
  return invoke("get_fw_systems");
}

export interface SovEntry {
  system_id: number;
  alliance_id: number | null;
  corporation_id: number | null;
  faction_id: number | null;
}

/** Live null-sec sovereignty ownership for every system that has any -
 * which alliance/corp (or NPC faction, for FW-adjacent space) holds it.
 * Public ESI, one call for the whole universe. */
export function getSovereigntyMap(): Promise<SovEntry[]> {
  return invoke("get_sovereignty_map");
}

export interface SovStructureStatus {
  solar_system_id: number;
  alliance_id: number | null;
  vulnerability_occupancy_level: number | null;
  vulnerable_start_time: string | null;
  vulnerable_end_time: string | null;
}

/** Whether a sov structure's reinforcement/vulnerability window is open
 * right now - a plain Date comparison against the current time, so this
 * never needs re-fetching just because the clock ticked forward. */
export function isSovVulnerableNow(status: SovStructureStatus, now: number = Date.now()): boolean {
  if (!status.vulnerable_start_time || !status.vulnerable_end_time) return false;
  const start = Date.parse(status.vulnerable_start_time);
  const end = Date.parse(status.vulnerable_end_time);
  return now >= start && now <= end;
}

/** Live vulnerability windows for every null-sec TCU/iHub - see
 * getSovereigntyMap for ownership alone; this is "can it actually be
 * reinforced right now". */
export function getSovStructures(): Promise<SovStructureStatus[]> {
  return invoke("get_sov_structures");
}

export interface IncursionSystem {
  system_id: number;
  faction_name: string;
  is_staging: boolean;
  has_boss: boolean;
  state: string;
}

/** Every system currently infested by a live Sansha incursion, including
 * which one is the staging system. Public ESI (plus a faction-name
 * resolve), already flattened one row per system rather than one row per
 * incursion+its system list. */
export function getIncursions(): Promise<IncursionSystem[]> {
  return invoke("get_incursions");
}

export interface SystemActivityCounts {
  system_id: number;
  ship_kills: number;
  npc_kills: number;
  pod_kills: number;
  ship_jumps: number;
}

/** Live last-hour ship-jump and NPC-kill counts for every system - the
 * "Traffic" and "NPC Activity" heat map modes read this; player ship kills
 * come from VESPER's own richer local kill-history recorder instead (see
 * getSystemKillHeat), not this ESI aggregate, since that's a better real-
 * time source for the same thing. */
export function getSystemActivity(): Promise<SystemActivityCounts[]> {
  return invoke("get_system_activity");
}

/** A stable, distinct color per arbitrary numeric id (alliance/corporation
 * ids number in the tens of thousands, so no fixed palette like
 * FW_FACTIONS works here) - the same "hash the id into a hue" trick every
 * sov-map tool uses, so the same alliance always gets the same color across
 * a session and between sessions, without needing to know or resolve its
 * name just to color it. */
export function colorForId(id: number): string {
  const hue = (id * 2654435761) % 360;
  return `hsl(${hue < 0 ? hue + 360 : hue}, 62%, 52%)`;
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
