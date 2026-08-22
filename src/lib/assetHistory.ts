import { invoke } from "@tauri-apps/api/core";

export interface AssetSnapshot {
  snapshot_date: string;
  total_value: number;
}

/** Records today's total asset ISK value for a character - viewing the
 * Assets tab again later the same day just overwrites today's row rather
 * than piling up duplicates. */
export function recordAssetSnapshot(characterId: number, totalValue: number): Promise<void> {
  return invoke("record_asset_snapshot", { characterId, totalValue });
}

/** Every recorded snapshot for a character, oldest first - starts empty
 * and grows a day at a time as the Assets tab gets viewed. */
export function getAssetHistory(characterId: number): Promise<AssetSnapshot[]> {
  return invoke("get_asset_history", { characterId });
}
