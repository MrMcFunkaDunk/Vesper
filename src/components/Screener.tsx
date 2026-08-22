import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { getMapData, type MapData } from "../lib/map";
import { getMarketGroups, getMarketGroupTypes, getRegionMarketOrders, type MarketGroupNode, type TypeSummary } from "../lib/market";
import { formatIsk } from "../lib/format";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";

/** Caps how many items in a category get scanned per run - a big leaf
 * category can hold hundreds of types, and each one costs a live ESI order
 * lookup (two, in hauling mode - one per region). Keeping this small
 * enough to stay fast and polite to ESI. */
const MAX_SCAN_ITEMS = 50;

type ScreenerMode = "spread" | "hauling";

interface Opportunity {
  typeId: number;
  name: string;
  bestSell: number;
  bestBuy: number;
  marginPct: number;
  sellVolume: number;
}

interface HaulingOpportunity {
  typeId: number;
  name: string;
  volume: number;
  sourceBuyPrice: number;
  sourceAvailable: number;
  destSellPrice: number;
  destBuyPrice: number;
  profitPerUnit: number;
  profitPerM3: number | null;
}

function Screener() {
  const [defaultTradeHub] = useDefaultTradeHub();
  const [mode, setMode] = useState<ScreenerMode>("spread");
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [regionId, setRegionId] = useState(defaultTradeHub);
  const [sourceRegionId, setSourceRegionId] = useState(defaultTradeHub);
  const [destRegionId, setDestRegionId] = useState(defaultTradeHub);
  const [marketGroups, setMarketGroups] = useState<MarketGroupNode[] | null>(null);
  const [groupPath, setGroupPath] = useState<MarketGroupNode[]>([]);
  const [groupTypes, setGroupTypes] = useState<TypeSummary[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [haulingResults, setHaulingResults] = useState<HaulingOpportunity[] | null>(null);

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

  async function scanSpread() {
    if (!groupTypes || groupTypes.length === 0) return;
    setScanning(true);
    setResults(null);
    setHaulingResults(null);
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

  /** For each item: buy cheap sell orders at the source, haul, then list a
   * sell order at the destination undercutting what's there - the same
   * "retail arbitrage" comparison evetrade/Eve-flipper use, not just the
   * instant-buy-order price (which understates the real margin). The
   * destination's best buy order is also shown as a same-day alternative
   * for anyone who'd rather sell instantly than wait to be undercut. */
  async function scanHauling() {
    if (!groupTypes || groupTypes.length === 0) return;
    setScanning(true);
    setResults(null);
    setHaulingResults(null);
    const subset = groupTypes.slice(0, MAX_SCAN_ITEMS);
    setScannedCount(subset.length);
    try {
      const scanned = await Promise.all(
        subset.map(async (t): Promise<HaulingOpportunity | null> => {
          try {
            const [sourceOrders, destOrders] = await Promise.all([
              getRegionMarketOrders(sourceRegionId, t.id),
              getRegionMarketOrders(destRegionId, t.id),
            ]);
            const sourceSells = sourceOrders.filter((o) => !o.is_buy_order);
            const destSells = destOrders.filter((o) => !o.is_buy_order);
            const destBuys = destOrders.filter((o) => o.is_buy_order);
            if (sourceSells.length === 0 || destSells.length === 0) return null;
            const sourceBuyPrice = Math.min(...sourceSells.map((o) => o.price));
            const sourceAvailable = sourceSells.reduce((sum, o) => sum + o.volume_remain, 0);
            const destSellPrice = Math.min(...destSells.map((o) => o.price));
            const destBuyPrice = destBuys.length > 0 ? Math.max(...destBuys.map((o) => o.price)) : 0;
            const profitPerUnit = destSellPrice - sourceBuyPrice;
            if (profitPerUnit <= 0) return null;
            const profitPerM3 = t.volume > 0 ? profitPerUnit / t.volume : null;
            return {
              typeId: t.id,
              name: t.name,
              volume: t.volume,
              sourceBuyPrice,
              sourceAvailable,
              destSellPrice,
              destBuyPrice,
              profitPerUnit,
              profitPerM3,
            };
          } catch {
            return null;
          }
        }),
      );
      const opportunities = scanned
        .filter((o): o is HaulingOpportunity => o != null)
        .sort((a, b) => (b.profitPerM3 ?? b.profitPerUnit) - (a.profitPerM3 ?? a.profitPerUnit));
      setHaulingResults(opportunities);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="screener">
      <div className="kills-tabs">
        <button type="button" className={`kills-tab ${mode === "spread" ? "kills-tab-active" : ""}`} onClick={() => setMode("spread")}>
          Same-Region Spread
        </button>
        <button type="button" className={`kills-tab ${mode === "hauling" ? "kills-tab-active" : ""}`} onClick={() => setMode("hauling")}>
          Inter-Region Hauling
        </button>
      </div>

      <div className="market-browser-toolbar">
        {mode === "spread" ? (
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
        ) : (
          <>
            <label className="wh-field-label">
              From
              <select className="market-region-select" value={sourceRegionId} onChange={(e) => setSourceRegionId(Number(e.target.value))}>
                {(mapData?.regions ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="wh-field-label">
              To
              <select className="market-region-select" value={destRegionId} onChange={(e) => setDestRegionId(Number(e.target.value))}>
                {(mapData?.regions ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
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
        <button
          type="button"
          className="kills-sync-btn"
          onClick={mode === "spread" ? scanSpread : scanHauling}
          disabled={scanning || !groupTypes || (mode === "hauling" && sourceRegionId === destRegionId)}
        >
          {scanning
            ? `Scanning ${scannedCount} items...`
            : `Scan "${currentGroup.name}" (${Math.min(groupTypes?.length ?? 0, MAX_SCAN_ITEMS)} of ${groupTypes?.length ?? 0} items)`}
        </button>
      )}
      {mode === "hauling" && currentGroup?.has_types && sourceRegionId === destRegionId && (
        <p className="detail-empty">Pick two different regions to compare.</p>
      )}

      {mode === "spread" && results && (
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

      {mode === "hauling" && haulingResults && (
        <div className="wallet-market-body">
          <p className="settings-section-hint">
            Buy price at the source region vs. what you could list at (undercutting the destination's current lowest
            sell order) - the standard hauling arbitrage margin, not just an instant-buy-order flip. "Instant Sell"
            shows the destination's best buy order as a same-day alternative to listing your own. Route risk (gate
            camps, contraband restrictions, price moves in transit) isn't modeled - use judgment.
          </p>
          {haulingResults.length === 0 ? (
            <p className="detail-empty">No profitable hauls found in this category between these regions right now.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="data-table-numeric">Buy @ Source</th>
                    <th className="data-table-numeric">Available</th>
                    <th className="data-table-numeric">List @ Dest</th>
                    <th className="data-table-numeric">Instant Sell @ Dest</th>
                    <th className="data-table-numeric">Profit/Unit</th>
                    <th className="data-table-numeric">m³</th>
                    <th className="data-table-numeric">Profit/m³</th>
                  </tr>
                </thead>
                <tbody>
                  {haulingResults.map((o) => (
                    <tr key={o.typeId}>
                      <td>{o.name}</td>
                      <td className="data-table-numeric">{formatIsk(o.sourceBuyPrice)}</td>
                      <td className="data-table-numeric">{o.sourceAvailable.toLocaleString()}</td>
                      <td className="data-table-numeric">{formatIsk(o.destSellPrice)}</td>
                      <td className="data-table-numeric">{o.destBuyPrice > 0 ? formatIsk(o.destBuyPrice) : "—"}</td>
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(o.profitPerUnit)}</td>
                      <td className="data-table-numeric">{o.volume.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-positive">
                        {o.profitPerM3 != null ? formatIsk(o.profitPerM3) : "—"}
                      </td>
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
