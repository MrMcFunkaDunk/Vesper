import { invoke } from "@tauri-apps/api/core";

export interface ScoutConnection {
  id: string;
  wh_type: string;
  max_ship_size: string;
  expires_at: string;
  remaining_hours: number;
  out_system_name: string;
  out_signature: string;
  in_system_id: number;
  in_system_name: string;
  in_system_class: string;
  in_region_id: number;
  in_region_name: string;
  in_signature: string;
}

/** Live Thera/Turnur wormhole connections from EvE-Scout/Signal Cartel's
 * public tracking service - confirmed signatures only. */
export function getScoutConnections(systemName: "Thera" | "Turnur"): Promise<ScoutConnection[]> {
  return invoke("get_scout_connections", { systemName });
}
