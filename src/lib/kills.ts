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
  victim_character_id: number | null;
  victim_character_name: string | null;
  victim_corporation_name: string | null;
  ship_type_id: number;
  ship_type_name: string;
  total_value: number;
  npc: boolean;
  solo: boolean;
}

export function searchSystem(name: string): Promise<SystemMatch | null> {
  return invoke("search_system", { name });
}

export function getRecentKills(systemIds: number[]): Promise<KillEntry[]> {
  return invoke("get_recent_kills", { systemIds });
}
