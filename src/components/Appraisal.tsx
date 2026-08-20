import { useEffect, useState } from "react";
import { getMapData, regionHubColor, regionLabelWithHub, type MapData } from "../lib/map";
import { searchMarketTypes, getRegionMarketOrders, type MarketOrder } from "../lib/market";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";

interface TradeHub {
  regionName: string;
  regionId: number;
  stationId: number;
}

/** The five classic trade hubs every EVE trader knows by name - matching
 * janice.e-351.com's default station-level pricing instead of averaging
 * across an entire region's worth of scattered, illiquid orders. Labeled and
 * colored via the same regionLabelWithHub/regionHubColor helpers the Market
 * Browser's region picker uses, so "The Forge (Jita)" and its faction color
 * stay identical everywhere in the app rather than drifting out of sync. */
const TRADE_HUBS: TradeHub[] = [
  { regionName: "The Forge", regionId: 10000002, stationId: 60003760 },
  { regionName: "Domain", regionId: 10000043, stationId: 60008494 },
  { regionName: "Sinq Laison", regionId: 10000032, stationId: 60011866 },
  { regionName: "Heimatar", regionId: 10000030, stationId: 60004588 },
  { regionName: "Metropolis", regionId: 10000042, stationId: 60005686 },
];

interface ParsedLine {
  name: string;
  quantity: number;
}

/** Handles EVE's various copy-paste formats: tab-separated inventory copy
 * (includes a quantity column), EFT fit paste ("[Rifter, Fit Name]" header
 * + one module per line), "Name x12", or a bare item name per line
 * (quantity 1, aggregated with any other bare mention of the same item). */
function parsePastedList(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\[.*\]$/.test(line)) continue;

    const tabParts = line.split("\t").map((p) => p.trim());
    if (tabParts.length >= 2) {
      const qty = parseInt(tabParts[1].replace(/,/g, ""), 10);
      if (!Number.isNaN(qty)) {
        lines.push({ name: tabParts[0], quantity: qty });
        continue;
      }
    }

    const xMatch = line.match(/^(.*?)\s*[x×]\s*([\d,]+)$/i);
    if (xMatch) {
      lines.push({ name: xMatch[1].trim(), quantity: parseInt(xMatch[2].replace(/,/g, ""), 10) });
      continue;
    }

    const trailingNumberMatch = line.match(/^(.*?)\s+([\d,]{1,12})$/);
    if (trailingNumberMatch) {
      lines.push({ name: trailingNumberMatch[1].trim(), quantity: parseInt(trailingNumberMatch[2].replace(/,/g, ""), 10) });
      continue;
    }

    lines.push({ name: line, quantity: 1 });
  }
  return lines;
}

/** Consumes orders best-price-first until `quantity` is filled (or the book
 * runs dry), returning the real cost to actually move that much volume -
 * not just best-order-price times quantity, which overstates liquidity for
 * anything beyond a single order's size. This is the core of what makes an
 * "appraisal" more honest than a plain price check. */
function walkBook(orders: MarketOrder[], quantity: number): { filled: number; total: number } {
  let remaining = quantity;
  let total = 0;
  let filled = 0;
  for (const o of orders) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, o.volume_remain);
    total += take * o.price;
    filled += take;
    remaining -= take;
  }
  return { filled, total };
}

interface AppraisalRow {
  typeId: number | null;
  name: string;
  quantity: number;
  volume: number;
  sellUnit: number | null;
  buyUnit: number | null;
  sellTotal: number;
  buyTotal: number;
  sellFilled: number;
  buyFilled: number;
}

/** The midpoint between what you'd realize selling and what it'd cost to
 * rebuy - same "Jita split" definition as the Market Browser's Split Price
 * stat, just applied to this row/list's own sell and buy totals. */
function splitTotal(sellTotal: number, buyTotal: number): number {
  return (sellTotal + buyTotal) / 2;
}

function Appraisal() {
  const [mapData, setMapData] = useState<MapData | null>(null);
  // Same two-permanent-dropdown pattern as the Market Browser's region
  // pickers: Trade Hubs vs All Other Regions, mutually exclusive, each with
  // its own "touched" flag purely for its own closed-state placeholder text.
  // Station-level pricing for the 5 real hubs falls out naturally below -
  // regionId can only ever land on a hub id via the Trade Hubs list (the
  // other list excludes them), so no extra state is needed to track which
  // picker was used.
  const [defaultTradeHub] = useDefaultTradeHub();
  const [regionId, setRegionId] = useState(defaultTradeHub);
  const [hubTouched, setHubTouched] = useState(false);
  const [otherRegionTouched, setOtherRegionTouched] = useState(false);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<AppraisalRow[] | null>(null);
  const [appraising, setAppraising] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
  }, []);

  const activeHub = TRADE_HUBS.find((h) => h.regionId === regionId) ?? { regionId, stationId: null as number | null };

  async function appraise() {
    const parsed = parsePastedList(text).slice(0, 300);
    if (parsed.length === 0) {
      setRows([]);
      return;
    }
    setAppraising(true);
    setCopied(false);
    try {
      const resolved = await Promise.all(
        parsed.map(async (line) => {
          const matches = await searchMarketTypes(line.name).catch(() => []);
          const exact = matches.find((m) => m.name.toLowerCase() === line.name.toLowerCase());
          return { line, match: exact ?? matches[0] ?? null };
        }),
      );

      const byKey = new Map<string, { typeId: number | null; name: string; quantity: number; volume: number }>();
      for (const { line, match } of resolved) {
        const key = match ? `t:${match.id}` : `u:${line.name.toLowerCase()}`;
        const existing = byKey.get(key);
        if (existing) existing.quantity += line.quantity;
        else byKey.set(key, { typeId: match?.id ?? null, name: match?.name ?? line.name, quantity: line.quantity, volume: match?.volume ?? 0 });
      }

      const priced = await Promise.all(
        [...byKey.values()].map(async (item): Promise<AppraisalRow> => {
          if (item.typeId == null) {
            return { ...item, sellUnit: null, buyUnit: null, sellTotal: 0, buyTotal: 0, sellFilled: 0, buyFilled: 0 };
          }
          try {
            const orders = await getRegionMarketOrders(activeHub.regionId, item.typeId);
            const sellSideAll = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
            const buySideAll = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
            const sellSide = activeHub.stationId ? sellSideAll.filter((o) => o.location_id === activeHub.stationId) : sellSideAll;
            const buySide = activeHub.stationId ? buySideAll.filter((o) => o.location_id === activeHub.stationId) : buySideAll;
            // No local liquidity at the chosen station falls back to the
            // whole region rather than reporting a false zero.
            const buyBook = buySide.length > 0 ? buySide : buySideAll;
            const sellBook = sellSide.length > 0 ? sellSide : sellSideAll;
            const sellWalk = walkBook(buyBook, item.quantity);
            const buyWalk = walkBook(sellBook, item.quantity);
            return {
              ...item,
              sellUnit: sellWalk.filled > 0 ? sellWalk.total / sellWalk.filled : null,
              buyUnit: buyWalk.filled > 0 ? buyWalk.total / buyWalk.filled : null,
              sellTotal: sellWalk.total,
              buyTotal: buyWalk.total,
              sellFilled: sellWalk.filled,
              buyFilled: buyWalk.filled,
            };
          } catch {
            return { ...item, sellUnit: null, buyUnit: null, sellTotal: 0, buyTotal: 0, sellFilled: 0, buyFilled: 0 };
          }
        }),
      );
      setRows(priced);
    } finally {
      setAppraising(false);
    }
  }

  function copySummary() {
    if (!rows) return;
    const lines = rows.map(
      (r) => `${r.name}\t${r.quantity}\t${r.sellUnit != null ? r.sellUnit.toFixed(2) : "-"}\t${r.buyUnit != null ? r.buyUnit.toFixed(2) : "-"}`,
    );
    const totalSell = rows.reduce((sum, r) => sum + r.sellTotal, 0);
    const totalBuy = rows.reduce((sum, r) => sum + r.buyTotal, 0);
    const summary = [
      "Item\tQty\tSell Unit\tBuy Unit",
      ...lines,
      "",
      `Total Sell Value: ${formatIsk(totalSell)}`,
      `Total Buy Value: ${formatIsk(totalBuy)}`,
    ].join("\n");
    navigator.clipboard
      .writeText(summary)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  const totalSell = (rows ?? []).reduce((sum, r) => sum + r.sellTotal, 0);
  const totalBuy = (rows ?? []).reduce((sum, r) => sum + r.buyTotal, 0);
  const totalVolume = (rows ?? []).reduce((sum, r) => sum + r.volume * r.quantity, 0);
  const totalUnits = (rows ?? []).reduce((sum, r) => sum + r.quantity, 0);
  const unresolvedCount = (rows ?? []).filter((r) => r.typeId == null).length;

  return (
    <div className="appraisal">
      <div className="market-browser-toolbar">
        <select
          className="market-region-select"
          value={hubTouched ? regionId : ""}
          onChange={(e) => {
            setRegionId(Number(e.target.value));
            setHubTouched(true);
            setOtherRegionTouched(false);
          }}
        >
          <option value="" disabled hidden>
            Trade Hubs
          </option>
          {TRADE_HUBS.map((hub) => (
            <option key={hub.regionName} value={hub.regionId} style={{ color: regionHubColor(hub.regionName) }}>
              {regionLabelWithHub(hub.regionName)}
            </option>
          ))}
        </select>
        <select
          className="market-region-select"
          value={otherRegionTouched ? regionId : ""}
          onChange={(e) => {
            setRegionId(Number(e.target.value));
            setOtherRegionTouched(true);
            setHubTouched(false);
          }}
        >
          <option value="" disabled hidden>
            All Other Regions
          </option>
          {(mapData?.regions ?? [])
            .filter((r) => !TRADE_HUBS.some((hub) => hub.regionId === r.id))
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>

      <textarea
        className="price-checker-input"
        placeholder={"Paste anything - inventory copy, an EFT fit, a contract list, or plain item names, one per line."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
      />

      <button type="button" className="kills-sync-btn" onClick={appraise} disabled={appraising || !text.trim()}>
        {appraising ? "Appraising..." : "Appraise"}
      </button>

      {rows && (
        <>
          {rows.length === 0 ? (
            <p className="detail-empty">Nothing to appraise - paste a list above.</p>
          ) : (
            <>
              <div className="market-browser-stats appraisal-summary">
                <div className="market-stat-card">
                  <span className="market-stat-label">Total Sell Value</span>
                  <span className="market-stat-value wallet-amount-positive">{formatIsk(totalSell)}</span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Total Buy Value</span>
                  <span className="market-stat-value wallet-amount-negative">{formatIsk(totalBuy)}</span>
                </div>
                <div className="market-stat-card" title="The midpoint between Total Sell Value and Total Buy Value - the fair price for handing this whole list off in a single direct trade.">
                  <span className="market-stat-label">Split</span>
                  <span className="market-stat-value market-stat-value-isk">{formatIsk(splitTotal(totalSell, totalBuy))}</span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Total Volume</span>
                  <span className="market-stat-value">{totalVolume.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³</span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Items</span>
                  <span className="market-stat-value">
                    {rows.length} ({totalUnits.toLocaleString()} units)
                  </span>
                </div>
              </div>

              <div className="wallet-market-body">
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="data-table-numeric">Qty</th>
                        <th className="data-table-numeric">Sell Unit</th>
                        <th className="data-table-numeric">Buy Unit</th>
                        <th className="data-table-numeric">Sell Total</th>
                        <th className="data-table-numeric">Split</th>
                        <th className="data-table-numeric">Buy Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td>
                            <span className="asset-item-cell">
                              {r.typeId != null && <img className="asset-item-icon" src={typeIconUrl(r.typeId, 32, r.name)} alt="" />}
                              {r.name}
                              {r.typeId == null && <span className="data-table-tag data-table-tag-danger">unresolved</span>}
                              {r.typeId != null && r.sellFilled < r.quantity && (
                                <span className="data-table-tag data-table-tag-neutral" title="Not enough buy-order depth to fill the full quantity">
                                  thin liquidity
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="data-table-numeric">{r.quantity.toLocaleString()}</td>
                          <td className="data-table-numeric wallet-amount-positive">{r.sellUnit != null ? formatIsk(r.sellUnit) : "—"}</td>
                          <td className="data-table-numeric wallet-amount-negative">{r.buyUnit != null ? formatIsk(r.buyUnit) : "—"}</td>
                          <td className="data-table-numeric wallet-amount-positive">{formatIsk(r.sellTotal)}</td>
                          <td className="data-table-numeric market-stat-value-isk">{formatIsk(splitTotal(r.sellTotal, r.buyTotal))}</td>
                          <td className="data-table-numeric wallet-amount-negative">{formatIsk(r.buyTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="appraisal-footer">
                  <p className="price-checker-total">
                    Sell: <span className="wallet-amount-positive">{formatIsk(totalSell)}</span> · Buy:{" "}
                    <span className="wallet-amount-negative">{formatIsk(totalBuy)}</span>
                    {unresolvedCount > 0 && ` · ${unresolvedCount} item(s) couldn't be matched`}
                  </p>
                  <button type="button" className="gatecheck-save-button" onClick={copySummary}>
                    {copied ? "Copied!" : "Copy Summary"}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default Appraisal;
