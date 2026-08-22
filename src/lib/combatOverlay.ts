import { invoke } from "@tauri-apps/api/core";

export function isCombatOverlayOpen(): Promise<boolean> {
  return invoke("is_combat_overlay_open");
}

/** Opens a small always-on-top native window showing live DPS out/in, rep
 * out/in, and cap-out figures - read straight from EVE's own combat log
 * (Gamelogs), following whichever client most recently had combat
 * activity. Independent of VESPER's own window, so it stays visible over
 * the game client. */
export function openCombatOverlay(): Promise<void> {
  return invoke("open_combat_overlay");
}

export function closeCombatOverlay(): Promise<void> {
  return invoke("close_combat_overlay");
}
