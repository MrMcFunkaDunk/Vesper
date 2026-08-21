import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.kills.showNpcKills";

/** Whether NPC-only kills (CONCORD, faction police, mission rats, etc.)
 * show in kill feeds - shared across Tracked Systems and Most Recent Kills
 * so the choice doesn't reset when switching between them. Defaults to
 * showing everything, matching the feed's existing behavior. */
export function useShowNpcKills() {
  return usePersistentState<boolean>(STORAGE_KEY, true);
}
