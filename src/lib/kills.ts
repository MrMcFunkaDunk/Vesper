import { invoke } from "@tauri-apps/api/core";

export interface SystemMatch {
  id: number;
  name: string;
}

export interface KillEntry {
  killmail_id: number;
  time: string;
  system_id: number;
  system_name: string;
  system_security: number | null;
  region_name: string | null;
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

export function getRecentKills(systemIds: number[]): Promise<KillEntry[]> {
  return invoke("get_recent_kills", { systemIds });
}

export function getRecentActivityKills(): Promise<KillEntry[]> {
  return invoke("get_recent_activity_kills");
}

export function getKillDetail(killmailId: number): Promise<KillDetail> {
  return invoke("get_kill_detail", { killmailId });
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
}

export function getCharacterProfile(characterId: number): Promise<CharacterProfile> {
  return invoke("get_character_profile", { characterId });
}

export function getCharacterKills(characterId: number): Promise<KillEntry[]> {
  return invoke("get_character_kills", { characterId });
}

export function getCharacterLosses(characterId: number): Promise<KillEntry[]> {
  return invoke("get_character_losses", { characterId });
}

export function getCharacterStats(characterId: number): Promise<CharacterStats> {
  return invoke("get_character_stats", { characterId });
}

export const MAX_LIVE_KILLS = 150;

/** Merges newly-arrived kills into an existing feed, deduping by killmail_id and keeping newest-first, capped so a long session doesn't grow the list forever. */
export function mergeKillFeeds(existing: KillEntry[], incoming: KillEntry[], cap: number = MAX_LIVE_KILLS): KillEntry[] {
  const byId = new Map<number, KillEntry>();
  for (const kill of existing) byId.set(kill.killmail_id, kill);
  for (const kill of incoming) byId.set(kill.killmail_id, kill);
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, cap);
}
