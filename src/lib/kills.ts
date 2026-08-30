import { invoke } from "@tauri-apps/api/core";

export interface SystemMatch {
  id: number;
  name: string;
  security: number;
}

export type TrackedEntryType = "system" | "constellation" | "region" | "gate";

/** One row of the tracked list - a system, constellation, or whole region.
 * systemIds is precomputed at add-time (from the already-loaded map data)
 * so polling/snapshot fetches never need to re-expand a constellation or
 * region into its member systems - they just flatten every entry's
 * systemIds into one list and reuse the existing per-system kill fetch. */
export interface TrackedEntry {
  type: TrackedEntryType;
  id: number;
  name: string;
  /** Only meaningful for type "system" - used to color-code its chip. */
  security?: number;
  systemIds: number[];
}

/** Stable identity for a tracked entry - used both as a React key and as
 * the id space for persisting/reordering the tracked list. */
export function entryKey(entry: TrackedEntry): string {
  return `${entry.type}:${entry.id}`;
}

export interface KillEntry {
  killmail_id: number;
  time: string;
  system_id: number;
  system_name: string;
  system_security: number | null;
  region_name: string | null;
  location_id: number;
  victim_character_id: number | null;
  victim_character_name: string | null;
  victim_corporation_id: number | null;
  victim_corporation_name: string | null;
  victim_alliance_id: number | null;
  victim_alliance_name: string | null;
  ship_type_id: number;
  ship_type_name: string;
  total_value: number;
  npc: boolean;
  solo: boolean;
  attacker_count: number;
  final_blow_character_id: number | null;
  final_blow_character_name: string | null;
  final_blow_corporation_id: number | null;
  final_blow_corporation_name: string | null;
  final_blow_alliance_id: number | null;
  final_blow_alliance_name: string | null;
  victim_faction_id: number | null;
  victim_faction_name: string | null;
  awox: boolean;
  war_id: number | null;
  attackers: KillAttacker[];
}

export interface KillAttacker {
  character_id: number | null;
  character_name: string | null;
  corporation_id: number | null;
  corporation_name: string | null;
  alliance_id: number | null;
  alliance_name: string | null;
  faction_id: number | null;
  faction_name: string | null;
  ship_type_id: number | null;
  ship_type_name: string | null;
  final_blow: boolean;
}

export type SlotGroup = "high" | "mid" | "low" | "rig" | "drone" | "cargo" | "other";

export interface KillItemEntry {
  item_type_id: number;
  item_type_name: string;
  flag: number;
  slot_group: SlotGroup;
  is_charge: boolean;
  quantity_destroyed: number;
  quantity_dropped: number;
}

export interface InsuranceLevel {
  name: string;
  cost: number;
  payout: number;
}

export interface KillAttackerEntry {
  character_id: number | null;
  character_name: string | null;
  corporation_id: number | null;
  corporation_name: string | null;
  alliance_id: number | null;
  alliance_name: string | null;
  ship_type_name: string | null;
  damage_done: number;
  final_blow: boolean;
}

export interface KillDetail {
  killmail_id: number;
  time: string;
  system_id: number;
  system_name: string;
  system_security: number | null;
  region_name: string | null;
  location_name: string | null;
  location_distance_m: number | null;
  location_id: number | null;
  victim_character_id: number | null;
  victim_character_name: string | null;
  victim_corporation_id: number | null;
  victim_corporation_name: string | null;
  victim_alliance_id: number | null;
  victim_alliance_name: string | null;
  ship_type_id: number;
  ship_type_name: string;
  total_value: number;
  destroyed_value: number;
  dropped_value: number;
  npc: boolean;
  solo: boolean;
  points: number;
  damage_taken: number;
  hash: string;
  insurance: InsuranceLevel[];
  items: KillItemEntry[];
  attackers: KillAttackerEntry[];
}

export function searchSystem(name: string): Promise<SystemMatch | null> {
  return invoke("search_system", { name });
}

export interface CharacterMatch {
  id: number;
  name: string;
}

/** Exact-name character lookup (ESI) - the Enter/Search fallback for a name that didn't come from picking a searchCharactersLive suggestion. */
export function searchCharacter(name: string): Promise<CharacterMatch | null> {
  return invoke("search_character", { name });
}

/** Live as-you-type character suggestions, backed by zKillboard's own site search (real partial/prefix matching, unlike ESI). */
export function searchCharactersLive(query: string): Promise<CharacterMatch[]> {
  return invoke("search_characters_live", { query });
}

export interface EntityMatch {
  id: number;
  name: string;
  is_alliance: boolean;
}

/** Live as-you-type corporation/alliance suggestions - same zKillboard
 * autocomplete search as searchCharactersLive, filtered to the other two
 * entity types it returns. */
export function searchEntitiesLive(query: string): Promise<EntityMatch[]> {
  return invoke("search_entities_live", { query });
}

export function getRecentKills(systemIds: number[]): Promise<KillEntry[]> {
  return invoke("get_recent_kills", { systemIds });
}

export function getRecentActivityKills(): Promise<KillEntry[]> {
  return invoke("get_recent_activity_kills");
}

export interface SystemKillHeat {
  system_id: number;
  system_name: string;
  region_name: string;
  kill_count: number;
  last_kill_time: string;
}

/** Real per-system kill counts for the last rolling hour, queried straight
 * off the local kill-history store with no size cap - unlike the live
 * ticker feed (mergeKillFeeds' MAX_LIVE_KILLS caps that at 150 kills New
 * Eden-wide), this can't silently undercount a busy system just because a
 * lot happened elsewhere in the same hour. Backs the Map's heat glow,
 * hover-tooltip kill count, and Top Active panel. */
export function getSystemKillHeat(): Promise<SystemKillHeat[]> {
  return invoke("get_system_kill_heat");
}

/** The zKillboard-style "Kill Reports" filters, backed by VESPER's own
 * locally-recorded kill history (see kill_history.rs) rather than the live
 * feed alone - "ganked" in particular only exists because of this local
 * history, since it's a retroactive check against a later kill. */
export type KillReportCategory =
  | "top_kills"
  | "big_kills"
  | "capitals"
  | "structures"
  | "abyssal"
  | "abyssal_pvp"
  | "awox"
  | "ganked"
  | "solo";

export function queryKillReports(category: KillReportCategory): Promise<KillEntry[]> {
  return invoke("query_kill_reports", { category });
}

export interface RankingEntry {
  id: number;
  name: string;
  count: number;
}

export interface KillTopStats {
  total_kills: number;
  killer_characters: RankingEntry[];
  killer_corporations: RankingEntry[];
  killer_alliances: RankingEntry[];
  killer_factions: RankingEntry[];
  killer_ships: RankingEntry[];
  killer_groups: RankingEntry[];
  loser_characters: RankingEntry[];
  loser_corporations: RankingEntry[];
  loser_alliances: RankingEntry[];
  loser_factions: RankingEntry[];
  loser_ships: RankingEntry[];
  loser_groups: RankingEntry[];
  top_systems: RankingEntry[];
  top_regions: RankingEntry[];
}

/** Top characters/corporations/alliances/factions/ships/groups on both the
 * killing and losing side, plus top systems/regions, over a rolling window -
 * VESPER's equivalent of zKillboard's "Top Killers in the Last Hour" page.
 * Only reflects kills VESPER's own history recorder has actually seen, so
 * it fills in more completely the longer the app has been running. */
export function getKillTopStats(windowMinutes: number): Promise<KillTopStats> {
  return invoke("get_kill_top_stats", { windowMinutes });
}

export interface KillHistoryBackfillProgress {
  running: boolean;
  days_total: number;
  days_done: number;
  kills_recorded: number;
  current_date: string;
  error: string | null;
  done: boolean;
}

/** Backfills the last 30 days of kill history from zKillboard's own bulk
 * daily dumps, so Kill Reports/Top Stats have a rolling 30-day window
 * immediately instead of waiting a real month for the live recorder to
 * accumulate it. Runs in the background - a no-op if already running. */
export function startKillHistoryBackfill(): Promise<void> {
  return invoke("start_kill_history_backfill");
}

export function getKillHistoryBackfillProgress(): Promise<KillHistoryBackfillProgress | null> {
  return invoke("get_kill_history_backfill_progress");
}

export function getKillDetail(killmailId: number): Promise<KillDetail> {
  return invoke("get_kill_detail", { killmailId });
}

export interface KillHistoryPoint {
  time: string;
  npc: boolean;
  ship_type_id: number;
}

/** Real 48h kill history for a system, sourced from zKillboard's actual
 * paginated history (not a live sampler) - see the backend for why this can
 * be retroactive while jumps (getSystemJumpHistory in lib/map.ts) can't. */
export function getSystemKillHistory(systemId: number): Promise<KillHistoryPoint[]> {
  return invoke("get_system_kill_history", { systemId });
}

/** One long-poll cycle (server-side wait up to ~60s) of the live, unfiltered New Eden kill stream. Call again immediately after each result to keep streaming. */
export function pollRecentActivityKills(): Promise<KillEntry[]> {
  return invoke("poll_recent_activity_kills");
}

/** Same live stream as pollRecentActivityKills, filtered to the given systems. */
export function pollTrackedSystemKills(systemIds: number[]): Promise<KillEntry[]> {
  return invoke("poll_tracked_system_kills", { systemIds });
}

export interface CharacterProfile {
  character_id: number;
  character_name: string;
  corporation_id: number;
  corporation_name: string | null;
  corporation_ticker: string | null;
  alliance_id: number | null;
  alliance_name: string | null;
  alliance_ticker: string | null;
  security_status: number | null;
  birthday: string;
}

export interface RankMetrics {
  ships_destroyed: number;
  ships_lost: number;
  isk_destroyed: number;
  isk_lost: number;
  points_destroyed: number;
  points_lost: number;
}

export interface RankNumbers {
  overall: number;
  ships_destroyed: number;
  ships_lost: number;
  isk_destroyed: number;
  isk_lost: number;
  points_destroyed: number;
  points_lost: number;
}

export interface RankingWindow {
  metrics: RankMetrics;
  ranks: RankNumbers;
}

export interface RankingPeriod {
  all: RankingWindow;
  solo: RankingWindow;
}

/** zKillboard's own alltime/recent(90d)/weekly(7d) ranking windows. */
export interface Rankings {
  alltime: RankingPeriod;
  recent: RankingPeriod;
  weekly: RankingPeriod;
}

export interface TopListEntry {
  kills: number;
  isk: number;
  id: number | null;
  name: string | null;
}

export interface TopList {
  list_type: string;
  title: string;
  values: TopListEntry[];
}

export interface TrophyBadge {
  label: string;
  ships_destroyed: number;
}

export interface ShipClassStats {
  group_id: number;
  group_name: string;
  ships_destroyed: number;
  ships_lost: number;
}

export interface MonthlyStats {
  year: number;
  month: number;
  ships_destroyed: number;
  points_destroyed: number;
  isk_destroyed: number;
  ships_lost: number;
  points_lost: number;
  isk_lost: number;
}

export interface CharacterStats {
  ships_destroyed: number;
  ships_lost: number;
  points_destroyed: number;
  points_lost: number;
  isk_destroyed: number;
  isk_lost: number;
  solo_kills: number;
  solo_losses: number;
  danger_ratio: number;
  gang_ratio: number;
  solo_ratio: number;
  avg_gang_size: number;
  trophies: TrophyBadge[];
  top_lists: TopList[];
  rankings: Rankings;
  ship_classes: ShipClassStats[];
  monthly: MonthlyStats[];
}

export function getCharacterProfile(characterId: number): Promise<CharacterProfile> {
  return invoke("get_character_profile", { characterId });
}

/** zKillboard paginates at 200 killmails per page (verified live) - page is
 * 1-indexed, and a page past the entity's real history returns []. */
export function getCharacterKills(characterId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_character_kills", { characterId, page });
}

export function getCharacterLosses(characterId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_character_losses", { characterId, page });
}

export function getCharacterStats(characterId: number): Promise<CharacterStats> {
  return invoke("get_character_stats", { characterId });
}

export function getCorporationKills(corporationId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_corporation_kills", { corporationId, page });
}

export function getAllianceKills(allianceId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_alliance_kills", { allianceId, page });
}

export function getCorporationLosses(corporationId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_corporation_losses", { corporationId, page });
}

export function getAllianceLosses(allianceId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_alliance_losses", { allianceId, page });
}

/** Kills at one specific location (a stargate's own ESI item id, e.g. from
 * KillDetail.location_id) - backs "track this gate". */
export function getLocationKills(locationId: number): Promise<KillEntry[]> {
  return invoke("get_location_kills", { locationId });
}

export interface GateSummary {
  id: number;
  name: string;
}

/** Every stargate in a system - backs the "search for a gate to track" flow: pick a system, then pick one of its gates. */
export function getSystemGates(systemId: number): Promise<GateSummary[]> {
  return invoke("get_system_gates", { systemId });
}

export interface CorporationProfile {
  corporation_id: number;
  corporation_name: string;
  corporation_ticker: string;
  alliance_id: number | null;
  alliance_name: string | null;
  alliance_ticker: string | null;
  member_count: number;
  date_founded: string | null;
  ceo_id: number | null;
  ceo_name: string | null;
  founder_id: number | null;
  founder_name: string | null;
  tax_rate: number;
  war_eligible: boolean;
  home_station_id: number | null;
  home_station_name: string | null;
}

export function getCorporationProfile(corporationId: number): Promise<CorporationProfile> {
  return invoke("get_corporation_profile", { corporationId });
}

export interface AllianceProfile {
  alliance_id: number;
  alliance_name: string;
  alliance_ticker: string;
  date_founded: string | null;
  executor_corporation_id: number | null;
  executor_corporation_name: string | null;
  founder_id: number | null;
  founder_name: string | null;
}

export function getAllianceProfile(allianceId: number): Promise<AllianceProfile> {
  return invoke("get_alliance_profile", { allianceId });
}

export function getCorporationStats(corporationId: number): Promise<CharacterStats> {
  return invoke("get_corporation_stats", { corporationId });
}

export function getAllianceStats(allianceId: number): Promise<CharacterStats> {
  return invoke("get_alliance_stats", { allianceId });
}

export interface AllianceMemberCorp {
  corporation_id: number;
  corporation_name: string;
  corporation_ticker: string;
  member_count: number;
  ceo_id: number | null;
  ceo_name: string | null;
}

/** Every corporation in an alliance - backs the alliance-only Corps tab (a corporation has no sub-corps of its own). */
export function getAllianceCorporations(allianceId: number): Promise<AllianceMemberCorp[]> {
  return invoke("get_alliance_corporations", { allianceId });
}

export interface SuperKillEntry {
  character_id: number;
  character_name: string;
  kills: number;
}

/** Titan/Supercarrier kills in the last 7 days - zKillboard's own public API caps pastSeconds at 7 days, so this is a real, honestly-scoped window rather than their cached 3-month one. */
export interface SupersReport {
  titans: SuperKillEntry[];
  supercarriers: SuperKillEntry[];
}

export function getCorporationSupers(corporationId: number): Promise<SupersReport> {
  return invoke("get_corporation_supers", { corporationId });
}

export function getAllianceSupers(allianceId: number): Promise<SupersReport> {
  return invoke("get_alliance_supers", { allianceId });
}

export interface IntelEntry {
  character_id: number;
  character_name: string;
  corporation_id: number;
  corporation_name: string | null;
  corporation_ticker: string | null;
  alliance_id: number | null;
  alliance_name: string | null;
  alliance_ticker: string | null;
  security_status: number | null;
  ships_destroyed: number;
  ships_lost: number;
  danger_ratio: number;
  gang_ratio: number;
  isk_destroyed: number;
  isk_lost: number;
  solo_kills: number;
  solo_ratio: number;
}

export interface IntelCheckResult {
  entries: IntelEntry[];
  unresolved: string[];
}

/** Resolves a pasted list of character names (e.g. copied straight from EVE's
 * Local chat member list) to their public affiliation + zKillboard danger stats. */
export function checkIntel(names: string[]): Promise<IntelCheckResult> {
  return invoke("check_intel", { names });
}

/** Cost/payout per insurance tier for a ship type - a calculator, not a policy
 * tracker, since ESI has no endpoint for a character's actual active policies. */
export function getInsuranceLevels(shipTypeId: number): Promise<InsuranceLevel[]> {
  return invoke("get_insurance_levels", { shipTypeId });
}

/** Every type_id ESI has insurance data for - used to filter the ship search
 * in the Insurance calculator down to actual insurable hulls. */
export function listInsurableShipIds(): Promise<number[]> {
  return invoke("list_insurable_ship_ids");
}

export function getConstellationKills(constellationId: number): Promise<KillEntry[]> {
  return invoke("get_constellation_kills", { constellationId });
}

export function getRegionKills(regionId: number): Promise<KillEntry[]> {
  return invoke("get_region_kills", { regionId });
}

/** Full-history, paginated versions of the above - back the dedicated
 * System/Constellation/Region killboard pages (matches zKillboard's own
 * pages paging all the way back through history), distinct from
 * getRecentKills/getConstellationKills/getRegionKills which stay capped for
 * the live Tracked Systems watchlist. */
export function getSystemKillsHistory(systemId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_system_kills_history", { systemId, page });
}

export function getConstellationKillsHistory(constellationId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_constellation_kills_history", { constellationId, page });
}

export function getRegionKillsHistory(regionId: number, page: number = 1): Promise<KillEntry[]> {
  return invoke("get_region_kills_history", { regionId, page });
}

export const MAX_LIVE_KILLS = 150;

/** Cap for the Tracked Systems feed specifically. That feed merges several
 * independently-fetched sources (up to 25 kills per system, 60 per
 * constellation/region), so a busy tracked region can easily flood the feed
 * with recent kills - a shared 150-item newest-first cap would let it crowd
 * out genuinely recent kills from quieter tracked systems entirely. This is
 * high enough that the per-source fetch caps are the real limit in
 * practice, not this one. */
export const MAX_TRACKED_KILLS = 1000;

/** Merges newly-arrived kills into an existing feed, deduping by killmail_id and keeping newest-first, capped so a long session doesn't grow the list forever. */
export function mergeKillFeeds(existing: KillEntry[], incoming: KillEntry[], cap: number = MAX_LIVE_KILLS): KillEntry[] {
  const byId = new Map<number, KillEntry>();
  for (const kill of existing) byId.set(kill.killmail_id, kill);
  for (const kill of incoming) byId.set(kill.killmail_id, kill);
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, cap);
}
