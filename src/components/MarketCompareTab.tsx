import { useEffect, useMemo, useState } from "react";
import { searchMarketTypes, getRegionMarketOrders, resolveMarketLocations, type TypeSearchMatch, type MarketOrder } from "../lib/market";
import { weightedPercentilePrice } from "../lib/mining";
import { TRADE_HUB_REGIONS, tradeHubName } from "../lib/map";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import type { SessionCharacter } from "../lib/eve";

interface RegionPriceRow {
  regionId: number;
  regionName: string;
  price: number | null;
}

/** One order from any of the 5 hubs, tagged with which hub it came from -
 * the whole point of the top-20 lists below is that a single ranked list
 * spanning all 5 hubs can mix them freely (e.g. the first 5 best sells all
 * sitting in Jita, the next 2 actually cheaper out of Hek). */
interface RankedOrder {
  order: MarketOrder;
  regionId: number;
  regionName: string;
}

const TOP_ORDER_LIMIT = 20;

const PRICE_BASES = [
  { id: "min", label: "Sell Min" },
  { id: "p90", label: "90th Percentile" },
  { id: "p98", label: "98th Percentile" },
] as const;
type PriceBasisId = (typeof PRICE_BASES)[number]["id"];

interface MarketCompareTabProps {
  characters: SessionCharacter[];
}

function MarketCompareTab({ characters }: MarketCompareTabProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  const [priceBasis, setPriceBasis] = useState<PriceBasisId>("min");
  const [orderBooks, setOrderBooks] = useState<Map<number, MarketOrder[]> | null>(null);
  const [locationNames, setLocationNames] = useState<Record<number, string>>({});

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMarketTypes(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Full order books for all 5 hubs, fetched once per selected item -
  // unconditionally now, since the top-20 sell/buy lists need every
  // individual order regardless of which price basis the hub summary
  // table is showing (there's no cheaper partial fetch that still covers
  // both views). Toggling the price basis afterwards just re-walks this
  // same already-fetched data (see weightedPercentilePrice) rather than
  // re-hitting ESI for all 5 regions again.
  useEffect(() => {
    setOrderBooks(null);
    if (!selected) return;
    let cancelled = false;
    Promise.all(
      TRADE_HUB_REGIONS.map(async (h): Promise<readonly [number, MarketOrder[]]> => [h.regionId, await getRegionMarketOrders(h.regionId, selected.id).catch(() => [])]),
    ).then((results) => {
      if (!cancelled) setOrderBooks(new Map(results));
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const rows: RegionPriceRow[] | null = useMemo(() => {
    if (!orderBooks) return null;
    return TRADE_HUB_REGIONS.map((h) => {
      const book = orderBooks.get(h.regionId) ?? [];
      if (priceBasis === "min") {
        const sellPrices = book.filter((o) => !o.is_buy_order).map((o) => o.price);
        return { regionId: h.regionId, regionName: h.regionName, price: sellPrices.length > 0 ? Math.min(...sellPrices) : null };
      }
      const percentile = priceBasis === "p98" ? 98 : 90;
      return { regionId: h.regionId, regionName: h.regionName, price: weightedPercentilePrice(book, percentile, "sell") };
    });
  }, [orderBooks, priceBasis]);

  const priced = rows?.filter((r) => r.price != null) ?? [];
  const cheapest = priced.length > 0 ? Math.min(...priced.map((r) => r.price!)) : null;

  const sorted = useSortableRows(
    rows ?? [],
    {
      regionName: (r) => r.regionName,
      price: (r) => r.price,
      diff: (r) => (r.price != null && cheapest != null && cheapest > 0 ? ((r.price - cheapest) / cheapest) * 100 : null),
    },
    "price",
    "asc",
  );

  /** The best 20 sell orders (cheapest first - what you'd actually buy at)
   * and best 20 buy orders (highest first - what you'd actually sell into)
   * across all 5 hubs combined, each still tagged with its own hub so two
   * orders at the same price from different hubs stay distinguishable. */
  const { topSells, topBuys } = useMemo(() => {
    if (!orderBooks) return { topSells: [] as RankedOrder[], topBuys: [] as RankedOrder[] };
    const all: RankedOrder[] = [];
    for (const h of TRADE_HUB_REGIONS) {
      for (const order of orderBooks.get(h.regionId) ?? []) {
        all.push({ order, regionId: h.regionId, regionName: h.regionName });
      }
    }
    const topSells = all
      .filter((r) => !r.order.is_buy_order)
      .sort((a, b) => a.order.price - b.order.price)
      .slice(0, TOP_ORDER_LIMIT);
    const topBuys = all
      .filter((r) => r.order.is_buy_order)
      .sort((a, b) => b.order.price - a.order.price)
      .slice(0, TOP_ORDER_LIMIT);
    return { topSells, topBuys };
  }, [orderBooks]);

  useEffect(() => {
    const ids = [...new Set([...topSells, ...topBuys].map((r) => r.order.location_id))];
    if (ids.length === 0 || characters.length === 0) {
      setLocationNames({});
      return;
    }
    let cancelled = false;
    resolveMarketLocations(characters[0].id, ids)
      .then((names) => {
        if (!cancelled) setLocationNames(names);
      })
      .catch(() => {
        if (!cancelled) setLocationNames({});
      });
    return () => {
      cancelled = true;
    };
  }, [topSells, topBuys, characters]);

  function stationName(order: MarketOrder): string {
    return locationNames[order.location_id] ?? `Station #${order.location_id}`;
  }

  function renderOrderTable(title: string, orders: RankedOrder[], priceClass: string) {
    return (
      <div className="market-browser-book">
        <p className="wh-side-label">{title}</p>
        {orders.length === 0 ? (
          <p className="detail-empty">No orders found.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="data-table-numeric">#</th>
                  <th className="data-table-numeric">Price</th>
                  <th>Trade Hub</th>
                  <th>Station</th>
                  <th className="data-table-numeric">Volume</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((r, i) => (
                  <tr key={r.order.order_id}>
                    <td className="data-table-numeric">{i + 1}</td>
                    <td className={`data-table-numeric ${priceClass}`}>{formatIsk(r.order.price)}</td>
                    <td>{tradeHubName(r.regionName)}</td>
                    <td>{stationName(r.order)}</td>
                    <td className="data-table-numeric">{r.order.volume_remain.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search any item to compare across trade hubs..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelected(s);
                    setQuery(s.name);
                    setSuggestionsOpen(false);
                  }}
                >
                  <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="settings-section-hint">
          Compares across VESPER's 5 major trade hubs - the same set every other region picker in the app already
          uses, rather than every real region (deep-nullsec markets are thin enough that a full 24+ region sweep
          wouldn't add much here).
        </p>
        {selected && (
          <label className="wh-field-label">
            Price Basis
            <select className="industry-field-input" value={priceBasis} onChange={(e) => setPriceBasis(e.target.value as PriceBasisId)}>
              {PRICE_BASES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {selected && (
        <div className="industry-results-panel">
          <p className="wh-side-label">
            {selected.name} - {PRICE_BASES.find((b) => b.id === priceBasis)?.label} Sell Price by Trade Hub
          </p>
          {!rows ? (
            <p className="detail-empty">Loading prices...</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="Trade Hub" sortKey="regionName" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} defaultDir="asc" />
                    <SortableTh
                      label={PRICE_BASES.find((b) => b.id === priceBasis)?.label ?? "Price"}
                      sortKey="price"
                      activeKey={sorted.sortKey}
                      dir={sorted.sortDir}
                      onSort={sorted.sort}
                      numeric
                      defaultDir="asc"
                    />
                    <SortableTh label="vs. Cheapest" sortKey="diff" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric defaultDir="asc" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.rows.map((r) => {
                    const diff = r.price != null && cheapest != null && cheapest > 0 ? ((r.price - cheapest) / cheapest) * 100 : null;
                    return (
                      <tr key={r.regionId}>
                        <td>{tradeHubName(r.regionName)}</td>
                        <td className="data-table-numeric market-stat-value-isk">{r.price != null ? formatIsk(r.price) : "No orders"}</td>
                        <td className={`data-table-numeric${diff != null && diff > 0 ? " wallet-amount-negative" : diff === 0 ? " wallet-amount-positive" : ""}`}>
                          {diff != null ? `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%` : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="wh-side-label">Top {TOP_ORDER_LIMIT} Orders Across All Trade Hubs</p>
          {!orderBooks ? (
            <p className="detail-empty">Loading orders...</p>
          ) : (
            <div className="market-browser-books">
              {renderOrderTable(`Best Sell Orders (Buy From Here)`, topSells, "wallet-amount-negative")}
              {renderOrderTable(`Best Buy Orders (Sell To Here)`, topBuys, "wallet-amount-positive")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MarketCompareTab;
