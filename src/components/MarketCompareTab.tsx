import { useEffect, useMemo, useState } from "react";
import { searchMarketTypes, getRegionSellMinPrice, getRegionMarketOrders, type TypeSearchMatch, type MarketOrder } from "../lib/market";
import { weightedPercentilePrice } from "../lib/mining";
import { TRADE_HUB_REGIONS } from "../lib/map";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";

interface RegionPriceRow {
  regionId: number;
  regionName: string;
  price: number | null;
}

const PRICE_BASES = [
  { id: "min", label: "Sell Min" },
  { id: "p90", label: "90th Percentile" },
  { id: "p98", label: "98th Percentile" },
] as const;
type PriceBasisId = (typeof PRICE_BASES)[number]["id"];

function MarketCompareTab() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  const [priceBasis, setPriceBasis] = useState<PriceBasisId>("min");
  const [minRows, setMinRows] = useState<RegionPriceRow[] | null>(null);
  const [orderBooks, setOrderBooks] = useState<Map<number, MarketOrder[]> | null>(null);

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

  // Sell-min prices don't depend on priceBasis at all, so they're fetched
  // once per selected item via the same targeted call this always used.
  useEffect(() => {
    setMinRows(null);
    setOrderBooks(null);
    if (!selected) return;
    let cancelled = false;
    Promise.all(
      TRADE_HUB_REGIONS.map(
        async (h): Promise<RegionPriceRow> => ({
          regionId: h.regionId,
          regionName: h.regionName,
          price: await getRegionSellMinPrice(h.regionId, selected.id).catch(() => null),
        }),
      ),
    ).then((results) => {
      if (!cancelled) setMinRows(results);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Full order books are only needed for the percentile modes, and only
  // fetched once per selected item - lazily, so switching straight to a
  // percentile basis fetches them, but staying on "Sell Min" never pays
  // for it. Once fetched they're cached here, so toggling between 90th
  // and 98th afterwards just re-walks the same already-fetched orders
  // (see weightedPercentilePrice) instead of re-hitting ESI for all 5
  // regions again.
  useEffect(() => {
    if (!selected || priceBasis === "min" || orderBooks) return;
    let cancelled = false;
    Promise.all(
      TRADE_HUB_REGIONS.map(async (h): Promise<readonly [number, MarketOrder[]]> => [h.regionId, await getRegionMarketOrders(h.regionId, selected.id).catch(() => [])]),
    ).then((results) => {
      if (!cancelled) setOrderBooks(new Map(results));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, priceBasis, orderBooks]);

  const rows: RegionPriceRow[] | null = useMemo(() => {
    if (priceBasis === "min") return minRows;
    if (!orderBooks) return null;
    const percentile = priceBasis === "p98" ? 98 : 90;
    return TRADE_HUB_REGIONS.map((h) => ({
      regionId: h.regionId,
      regionName: h.regionName,
      price: weightedPercentilePrice(orderBooks.get(h.regionId) ?? [], percentile, "sell"),
    }));
  }, [priceBasis, minRows, orderBooks]);

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
                        <td>{r.regionName}</td>
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
        </div>
      )}
    </div>
  );
}

export default MarketCompareTab;
