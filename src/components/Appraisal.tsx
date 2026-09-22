import { useEffect, useState, type ClipboardEvent } from "react";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import { getMapData, regionHubColor, regionLabelWithHub, type MapData } from "../lib/map";
import { searchMarketTypes, getRegionMarketOrders, type MarketOrder } from "../lib/market";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";

interface TradeHub {
  regionName: string;
  regionId: number;
  stationId: number;
}

/** The paste box's height grows with however many lines were pasted,
 * rather than sitting at a fixed size the user has to manually drag open
 * for a big fit or cargo list - capped so one genuinely huge paste (a
 * few-hundred-line multibuy list) doesn't stretch the box past what's
 * actually useful on screen. */
const MIN_TEXTAREA_ROWS = 8;
const MAX_TEXTAREA_ROWS = 30;

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
  /** Set when `name` ends in a bare number that might actually have been
   * meant as a quantity rather than part of the real item name - plenty of
   * real items ("Navy Cap Booster 400" chief among them) end in one. Only
   * tried as a fallback, once resolving against the real market shows
   * `name` on its own isn't a real item - see appraise()'s resolution
   * step below. */
  altName?: string;
  altQuantity?: number;
}

/** EVE's own conventions are unambiguous about quantity: an explicit
 * "x20"/"×20" suffix (fit or multi-buy paste) or a dedicated tab-delimited
 * column (inventory copy, handled by the caller before this runs) - never
 * a bare trailing number. So the primary read of anything else is the
 * full text as one item, quantity 1; when it ends in a bare number, an
 * alternate "maybe that was actually meant as a quantity" reading is
 * attached too, for the caller to try only once the primary text turns
 * out not to resolve to a real item. */
function parseCandidate(text: string): ParsedLine {
  const xMatch = text.match(/^(.*?)\s*[x×]\s*([\d,]+)$/i);
  if (xMatch) {
    return { name: xMatch[1].trim(), quantity: parseInt(xMatch[2].replace(/,/g, ""), 10) };
  }
  const result: ParsedLine = { name: text, quantity: 1 };
  const trailingNumberMatch = text.match(/^(.*?)\s+([\d,]{1,12})$/);
  if (trailingNumberMatch) {
    result.altName = trailingNumberMatch[1].trim();
    result.altQuantity = parseInt(trailingNumberMatch[2].replace(/,/g, ""), 10);
  }
  return result;
}

/** Splits any comma-joined "Module Name, Charge Name" line - EVE's Fitting
 * window pastes a fitted module together with whatever charge is loaded in
 * it as one line instead of the usual one-item-per-line format - onto its
 * own two lines.
 *
 * Gated on ", " (comma immediately followed by a space) rather than a bare
 * comma - EVE's own thousands-grouping ("1,234,567") never has a space
 * after the comma, so this only ever fires on a real item separator, not a
 * large bare quantity. */
function splitCommaLines(lines: string[]): string[] {
  return lines.flatMap((raw) => {
    const line = raw.trim();
    if (!line || /^\[.*\]$/.test(line) || !line.includes(", ")) return [raw];
    const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [raw];
  });
}

/** Cleans up a chunk of just-pasted text into one line per item, regardless
 * of where it came from: splits comma-joined module/charge lines (see
 * splitCommaLines) and drops every blank line - EVE's own Fitting window
 * paste leaves one between every fitting slot group, which is meaningless
 * once this is just a flat item list. Only ever run against a whole pasted
 * chunk (see the textarea's onPaste below), never live against every
 * keystroke - trimming a line the user is still in the middle of typing
 * would eat the trailing space right after they type it. */
function normalizePastedText(text: string): string {
  return splitCommaLines(text.split("\n"))
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** Handles EVE's various copy-paste formats: tab-separated inventory copy
 * (includes a quantity column), EFT fit paste ("[Rifter, Fit Name]" header
 * + one module per line), "Name x12", or a bare item name per line
 * (quantity 1, aggregated with any other bare mention of the same item).
 * Splits comma-joined lines itself rather than relying on the textarea's
 * onPaste handler having already cleaned them up - drag-and-drop text, a
 * programmatic paste, or any other way text lands in the box that doesn't
 * fire a paste event should still appraise correctly, even if the box
 * itself doesn't visibly reformat until the next actual paste. */
function parsePastedList(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of splitCommaLines(text.split("\n"))) {
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

    lines.push(parseCandidate(line));
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
  const sortedRows = useSortableRows(rows ?? [], {
    name: (r) => r.name,
    quantity: (r) => r.quantity,
    sellUnit: (r) => r.sellUnit ?? 0,
    buyUnit: (r) => r.buyUnit ?? 0,
    sellTotal: (r) => r.sellTotal,
    buyTotal: (r) => r.buyTotal,
  });
  const [appraising, setAppraising] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
  }, []);

  const activeHub = TRADE_HUBS.find((h) => h.regionId === regionId) ?? { regionId, stationId: null as number | null };

  function handleClear() {
    setText("");
    setRows(null);
    setCopied(false);
  }

  /** Normalizes just the pasted chunk in place - splitting comma-joined
   * lines and dropping blank ones - rather than letting the browser insert
   * it verbatim, so the box immediately shows a clean list regardless of
   * what was copied or where from. Handled manually (not via onChange)
   * because normalizing on every keystroke would trim a trailing space the
   * moment it's typed, making it impossible to type a multi-word name. */
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;
    e.preventDefault();
    const target = e.currentTarget;
    const before = text.slice(0, target.selectionStart);
    const after = text.slice(target.selectionEnd);
    setText(before + normalizePastedText(pasted) + after);
  }

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
          if (exact) return { line, match: exact };

          // The primary text alone isn't a real item - if it ends in a bare
          // number that might have been meant as a quantity, check the
          // market for the stripped name before giving up on this line
          // entirely. Only actually switches to that reading if it finds a
          // real item there; otherwise keeps the primary (fuzzy-or-none)
          // result exactly as before.
          if (line.altName != null) {
            const altMatches = await searchMarketTypes(line.altName).catch(() => []);
            const altExact = altMatches.find((m) => m.name.toLowerCase() === line.altName!.toLowerCase());
            const altLine = { name: line.altName, quantity: line.altQuantity! };
            if (altExact) return { line: altLine, match: altExact };
            if (!matches[0] && altMatches[0]) return { line: altLine, match: altMatches[0] };
          }

          return { line, match: matches[0] ?? null };
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
            const sellWalk = walkBook(sellBook, item.quantity);
            const buyWalk = walkBook(buyBook, item.quantity);
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
        onPaste={handlePaste}
        rows={Math.min(MAX_TEXTAREA_ROWS, Math.max(MIN_TEXTAREA_ROWS, text.split("\n").length + 1))}
      />

      <div className="appraisal-actions">
        <button type="button" className="kills-sync-btn" onClick={appraise} disabled={appraising || !text.trim()}>
          {appraising ? "Appraising..." : "Appraise"}
        </button>
        <button type="button" className="detail-back" onClick={handleClear} disabled={appraising || (!text && !rows)}>
          Clear
        </button>
      </div>

      {rows && (
        <>
          {rows.length === 0 ? (
            <p className="detail-empty">Nothing to appraise - paste a list above.</p>
          ) : (
            <>
              <div className="market-browser-stats appraisal-summary">
                <div className="market-stat-card">
                  <span className="market-stat-label">Total Sell Value</span>
                  <span className="market-stat-value wallet-amount-negative">{formatIsk(totalSell)}</span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Total Buy Value</span>
                  <span className="market-stat-value wallet-amount-positive">{formatIsk(totalBuy)}</span>
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
                        <SortableTh label="Item" sortKey="name" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} />
                        <SortableTh label="Qty" sortKey="quantity" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} numeric />
                        <SortableTh label="Sell Unit" sortKey="sellUnit" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} numeric />
                        <SortableTh label="Buy Unit" sortKey="buyUnit" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} numeric />
                        <SortableTh label="Sell Total" sortKey="sellTotal" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} numeric />
                        <th className="data-table-numeric">Split</th>
                        <SortableTh label="Buy Total" sortKey="buyTotal" activeKey={sortedRows.sortKey} dir={sortedRows.sortDir} onSort={sortedRows.sort} numeric />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.rows.map((r, i) => (
                        <tr key={i}>
                          <td>
                            <span className="asset-item-cell">
                              {r.typeId != null && <img className="asset-item-icon" src={typeIconUrl(r.typeId, 32, r.name)} alt="" />}
                              {r.name}
                              {r.typeId == null && <span className="data-table-tag data-table-tag-danger">unresolved</span>}
                              {r.typeId != null && r.sellFilled < r.quantity && (
                                <span className="data-table-tag data-table-tag-neutral" title="Not enough sell-order depth to fill the full quantity">
                                  thin liquidity
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="data-table-numeric">{r.quantity.toLocaleString()}</td>
                          <td className="data-table-numeric wallet-amount-negative">{r.sellUnit != null ? formatIsk(r.sellUnit) : "—"}</td>
                          <td className="data-table-numeric wallet-amount-positive">{r.buyUnit != null ? formatIsk(r.buyUnit) : "—"}</td>
                          <td className="data-table-numeric wallet-amount-negative">{formatIsk(r.sellTotal)}</td>
                          <td className="data-table-numeric market-stat-value-isk">{formatIsk(splitTotal(r.sellTotal, r.buyTotal))}</td>
                          <td className="data-table-numeric wallet-amount-positive">{formatIsk(r.buyTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="appraisal-footer">
                  <p className="price-checker-total">
                    Sell: <span className="wallet-amount-negative">{formatIsk(totalSell)}</span> · Buy:{" "}
                    <span className="wallet-amount-positive">{formatIsk(totalBuy)}</span>
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
