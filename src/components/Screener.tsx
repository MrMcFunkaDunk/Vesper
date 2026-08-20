import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { getMapData, type MapData } from "../lib/map";
import { getMarketGroups, getMarketGroupTypes, getRegionMarketOrders, type MarketGroupNode, type TypeSummary } from "../lib/market";
import { formatIsk } from "../lib/format";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";

/** Caps how many items in a category get scanned per run - a big leaf
 * category can hold hundreds of types, and each one costs a live ESI order
 * lookup. Keeping this small enough to stay fast and polite to ESI. */
const MAX_SCAN_ITEMS = 50;

interface Opportunity {
  typeId: number;
  name: string;
  bestSell: number;
  bestBuy: number;
  marginPct: number;
  sellVolume: number;
}

function Screener() {
  const [defaultTradeHub] = useDefaultTradeHub();
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [regionId, setRegionId] = useState(defaultTradeHub);
  const [marketGroups, setMarketGroups] = useState<MarketGroupNode[] | null>(null);
  const [groupPath, setGroupPath] = useState<MarketGroupNode[]>([]);
  const [groupTypes, setGroupTypes] = useState<TypeSummary[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [results, setResults] = useState<Opportunity[] | null>(null);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
    getMarketGroups().then(setMarketGroups).catch(() => {});
  }, []);

  useEffect(() => {
    const currentGroup = groupPath[groupPath.length - 1];
    if (!currentGroup || !currentGroup.has_types) {
      setGroupTypes(null);
      return;
    }
    getMarketGroupTypes(currentGroup.id)
      .then(setGroupTypes)
      .catch(() => setGroupTypes([]));
  }, [groupPath]);

  const topLevelGroups = useMemo(
    () => (marketGroups ?? []).filter((g) => g.parent_id == null).sort((a, b) => a.name.localeCompare(b.name)),
    [marketGroups],
  );
  const currentGroup = groupPath[groupPath.length - 1] ?? null;
  const childGroups = useMemo(
    () =>
      (marketGroups ?? [])
        .filter((g) => g.parent_id === (currentGroup ? currentGroup.id : null))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [marketGroups, currentGroup],
  );

  async function scan() {
    if (!groupTypes || groupTypes.length === 0) return;
    setScanning(true);
    setResults(null);
    const subset = groupTypes.slice(0, MAX_SCAN_ITEMS);
    setScannedCount(subset.length);
    try {
      const scanned = await Promise.all(
        subset.map(async (t): Promise<Opportunity | null> => {
          try {
            const orders = await getRegionMarketOrders(regionId, t.id);
            const sells = orders.filter((o) => !o.is_buy_order);
            const buys = orders.filter((o) => o.is_buy_order);
            if (sells.length === 0 || buys.length === 0) return null;
            const bestSell = Math.min(...sells.map((o) => o.price));
            const bestBuy = Math.max(...buys.map((o) => o.price));
            const marginPct = ((bestSell - bestBuy) / bestSell) * 100;
            if (marginPct <= 0) return null;
            const sellVolume = sells.reduce((sum, o) => sum + o.volume_remain, 0);
            return { typeId: t.id, name: t.name, bestSell, bestBuy, marginPct, sellVolume };
          } catch {
            return null;
          }
        }),
      );
      const opportunities = scanned.filter((o): o is Opportunity => o != null).sort((a, b) => b.marginPct - a.marginPct);
      setResults(opportunities);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="screener">
      <div className="market-browser-toolbar">
        <select className="market-region-select" value={regionId} onChange={(e) => setRegionId(Number(e.target.value))}>
          {(mapData?.regions ?? [])
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>

      <div className="market-browser-breadcrumb">
        <button type="button" onClick={() => setGroupPath([])} disabled={groupPath.length === 0}>
          All Categories
        </button>
        {groupPath.map((g, i) => (
          <span key={g.id} className="market-browser-crumb">
            <ChevronRight size={12} strokeWidth={2} />
            <button type="button" onClick={() => setGroupPath(groupPath.slice(0, i + 1))} disabled={i === groupPath.length - 1}>
              {g.name}
            </button>
          </span>
        ))}
      </div>

      <div className="market-browser-tree-list screener-group-list">
        {(groupPath.length === 0 ? topLevelGroups : childGroups).map((g) => (
          <button key={g.id} type="button" className="market-browser-tree-item" onClick={() => setGroupPath([...groupPath, g])}>
            {g.name}
            <ChevronRight size={13} strokeWidth={2} />
          </button>
        ))}
      </div>

      {currentGroup?.has_types && (
        <button type="button" className="kills-sync-btn" onClick={scan} disabled={scanning || !groupTypes}>
          {scanning
            ? `Scanning ${scannedCount} items...`
            : `Scan "${currentGroup.name}" (${Math.min(groupTypes?.length ?? 0, MAX_SCAN_ITEMS)} of ${groupTypes?.length ?? 0} items)`}
        </button>
      )}

      {results && (
        <div className="wallet-market-body">
          {results.length === 0 ? (
            <p className="detail-empty">No tradable spread found in this category right now - try a different one.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="data-table-numeric">Buy at</th>
                    <th className="data-table-numeric">Sell at</th>
                    <th className="data-table-numeric">Margin</th>
                    <th className="data-table-numeric">Sell Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((o) => (
                    <tr key={o.typeId}>
                      <td>{o.name}</td>
                      <td className="data-table-numeric">{formatIsk(o.bestBuy)}</td>
                      <td className="data-table-numeric">{formatIsk(o.bestSell)}</td>
                      <td className="data-table-numeric wallet-amount-positive">{o.marginPct.toFixed(1)}%</td>
                      <td className="data-table-numeric">{o.sellVolume.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Screener;
