import { TRADE_HUB_REGIONS } from "../lib/map";
import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.settings.defaultTradeHub";

/** The trade hub region every market-pricing screen (Industry, Market
 * Browser, Screener, Wallet contracts) seeds as its initial selection, so
 * switching hubs once in Settings doesn't mean re-picking it on every page. */
export function useDefaultTradeHub() {
  return usePersistentState<number>(STORAGE_KEY, TRADE_HUB_REGIONS[0].regionId, (regionId) =>
    TRADE_HUB_REGIONS.some((h) => h.regionId === regionId) ? regionId : TRADE_HUB_REGIONS[0].regionId,
  );
}
