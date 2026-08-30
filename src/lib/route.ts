import { invoke } from "@tauri-apps/api/core";

export type RoutePreference = "shortest" | "secure" | "insecure";

export interface GateCheckSystem {
  id: number;
  name: string;
  security: number;
  region_name: string;
}

export interface GateCheckResult {
  systems: GateCheckSystem[];
}

/** Plans a route through every waypoint in order, avoiding any listed systems, using ESI's own public pathfinder. */
export function planGateCheck(waypoints: number[], avoid: number[], flag: RoutePreference): Promise<GateCheckResult> {
  return invoke("plan_gate_check", { waypoints, avoid, flag });
}

export interface GateKillEvent {
  system_id: number;
  time: string;
  /** Null if this kill didn't happen near any stargate in the system. */
  gate_name: string | null;
  /** The gate's own ESI stargate id, alongside gate_name - lets the UI make "X kills at the Y gate" clickable. */
  gate_id: number | null;
  smartbomb: boolean;
  interdictor: boolean;
  capital: boolean;
  citadel: boolean;
  mobile_bubble: boolean;
}

/** Recent kills for every given system, matched to the nearest stargate and classified for smartbombs/HICs-dictors/capitals/citadels/mobile bubbles. Not time-filtered - the caller narrows to "last hour" itself. */
export function getGateActivity(systemIds: number[]): Promise<GateKillEvent[]> {
  return invoke("get_gate_activity", { systemIds });
}

export interface LikelyGateCamp {
  origin_system_id: number;
  origin_system_name: string;
  origin_security: number;
  gate_location_id: number;
  /** ESI always names a stargate after its destination system, so this doubles as "which system does this gate lead to". */
  gate_name: string;
  destination_system_id: number | null;
  destination_security: number | null;
  kills_last_hour: number;
  pods_last_hour: number;
  last_kill_time: string;
}

/** New Eden-wide "what's likely camped right now" board - every stargate with a recorded kill in the last hour, ranked by kill count, from the local kill-history store. Matches eve-gatecheck.space's own "Current (likely) gatecamps" list. */
export function getLikelyGateCamps(): Promise<LikelyGateCamp[]> {
  return invoke("get_likely_gate_camps");
}
