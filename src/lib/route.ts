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
