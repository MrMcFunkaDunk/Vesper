import { useEffect, useRef, useState } from "react";
import { TRADE_HUB_REGIONS } from "../lib/map";

const STORAGE_KEY = "vesper.settings.defaultTradeHub";

function readDefault(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = Number(raw);
    return TRADE_HUB_REGIONS.some((h) => h.regionId === n) ? n : TRADE_HUB_REGIONS[0].regionId;
  } catch {
    return TRADE_HUB_REGIONS[0].regionId;
  }
}

/** The trade hub region every market-pricing screen (Industry, Market
 * Browser, Screener, Wallet contracts) seeds as its initial selection, so
 * switching hubs once in Settings doesn't mean re-picking it on every page. */
export function useDefaultTradeHub() {
  const [regionId, setRegionId] = useState<number>(() => readDefault());

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, String(regionId));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [regionId]);

  return [regionId, setRegionId] as const;
}
