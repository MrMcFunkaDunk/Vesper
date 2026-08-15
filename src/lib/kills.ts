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

export function getKillDetail(killmailId: number): Promise<KillDetail> {
  return invoke("get_kill_detail", { killmailId });
}
