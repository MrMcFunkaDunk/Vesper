import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getMarketGroups, getMarketGroupTypes, getMarketPrices, type MarketGroupNode } from "../lib/market";
import { getBlueprintDetail, findBlueprintForProduct } from "../lib/industry";
import { formatIsk, typeIconUrl } from "../lib/format";
import { formatDuration } from "./IndustryPage";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";

interface LeafGroup {
  id: number;
  label: string;
}

/** Every leaf market category (has_types - a real shopping-list group, not
 * a folder of sub-categories), labeled with its full ancestor path so
 * "Ammunition" in the search box can tell "Ammunition & Charges › Advanced
 * Drone Ammunition" apart from "... › Projectile Ammo". */
function buildLeafGroups(groups: MarketGroupNode[]): LeafGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  function pathFor(group: MarketGroupNode): string {
    const path: string[] = [group.name];
    let current = group;
    while (current.parent_id != null) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      path.unshift(parent.name);
      current = parent;
    }
    return path.join(" › ");
  }
  return groups
    .filter((g) => g.has_types)
    .map((g) => ({ id: g.id, label: pathFor(g) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

interface OpportunityRow {
  typeId: number;
  name: string;
  buildCost: number;
  sellRevenue: number;
  margin: number;
  marginPct: number;
  timeSeconds: number;
  profitPerHour: number;
}

/** Caps one scan to a sane number of ESI/SDE lookups - a leaf category
 * rarely has more than this many distinct items anyway, and this keeps a
 * single "search and scan" action from turning into hundreds of blueprint
 * lookups if it ever does. */
const MAX_SCAN_ITEMS = 60;

/** A market-wide-ish profitability scan, one category at a time - build
 * cost (unresearched ME0 materials, priced at the current EVE-wide average)
 * versus estimated sell revenue, ranked by profit per manufacturing hour.
 * Deliberately shallow compared to the Production Calculator's own full
 * recursive BOM + real ME/TE/system-cost-index job-cost math: this is a
 * "where should I even look" scanner across many items at once, not a
 * precise quote for one - open the item in Production for the real number
 * once something here looks promising. */
function IndustryOpportunitiesTab() {
  const [leafGroups, setLeafGroups] = useState<LeafGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<LeafGroup | null>(null);
  const [rows, setRows] = useState<OpportunityRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const reportError = useErrorReporter();

  useEffect(() => {
    getMarketGroups()
      .then((groups) => setLeafGroups(buildLeafGroups(groups)))
      .catch((err) => reportError(`Failed to load market categories: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const suggestions = useMemo(() => {
    if (!leafGroups) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return leafGroups.filter((g) => g.label.toLowerCase().includes(q)).slice(0, 20);
  }, [leafGroups, query]);

  async function runScan(group: LeafGroup) {
    setSelectedGroup(group);
    setQuery("");
    setRows(null);
    setScanning(true);
    setSkipped(0);
    try {
      const [items, prices] = await Promise.all([getMarketGroupTypes(group.id), getMarketPrices()]);
      const priceById = new Map(prices.map((p) => [p.type_id, p.average_price ?? p.adjusted_price ?? 0]));
      const capped = items.slice(0, MAX_SCAN_ITEMS);
      let skippedCount = items.length - capped.length;

      const results = await Promise.all(
        capped.map(async (item): Promise<OpportunityRow | null> => {
          try {
            const blueprintId = await findBlueprintForProduct(item.id);
            if (blueprintId == null) return null;
            const detail = await getBlueprintDetail(blueprintId);
            const activity = detail.manufacturing;
            if (!activity || activity.materials.length === 0) return null;
            const outputQty = activity.products.find((p) => p.type_id === item.id)?.quantity ?? 1;
            const buildCost = activity.materials.reduce((sum, m) => sum + m.quantity * (priceById.get(m.type_id) ?? 0), 0);
            const sellPrice = priceById.get(item.id) ?? 0;
            if (buildCost <= 0 || sellPrice <= 0) return null;
            const sellRevenue = sellPrice * outputQty;
            const margin = sellRevenue - buildCost;
            const hours = activity.time_seconds / 3600;
            return {
              typeId: item.id,
              name: item.name,
              buildCost,
              sellRevenue,
              margin,
              marginPct: (margin / buildCost) * 100,
              timeSeconds: activity.time_seconds,
              profitPerHour: hours > 0 ? margin / hours : margin,
            };
          } catch {
            skippedCount += 1;
            return null;
          }
        }),
      );

      setRows(results.filter((r): r is OpportunityRow => r !== null));
      setSkipped(skippedCount);
    } catch (err) {
      reportError(`Failed to scan for opportunities: ${String(err)}`);
      setRows([]);
    } finally {
      setScanning(false);
    }
  }

  const sorted = useSortableRows(
    rows ?? [],
    {
      name: (r) => r.name,
      buildCost: (r) => r.buildCost,
      sellRevenue: (r) => r.sellRevenue,
      margin: (r) => r.margin,
      marginPct: (r) => r.marginPct,
      timeSeconds: (r) => r.timeSeconds,
      profitPerHour: (r) => r.profitPerHour,
    },
    "profitPerHour",
  );

  return (
    <div className="industry-opportunities">
      <p className="wh-page-subtitle">
        A build-cost-vs-sell-price scan across one market category at a time, ranked by profit per manufacturing hour - build cost uses
        unresearched (ME 0) material quantities at the current EVE-wide average price, and sell price is that same average for the
        product, so treat this as "where to look next", not a firm quote. Search for a category to scan it.
      </p>
      <div className="kills-add-combobox industry-opportunities-search">
        <input
          type="text"
          placeholder='Search a market category, e.g. "Ammunition" or "Frigates"...'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {suggestions.length > 0 && (
          <div className="gatecheck-slot-results kills-add-suggestions">
            {suggestions.map((g) => (
              <button key={g.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runScan(g)}>
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedGroup && (
        <div className="industry-opportunities-header">
          <span className="industry-opportunities-header-label">{selectedGroup.label}</span>
          <button
            type="button"
            className="industry-build-parent-header-refresh"
            onClick={() => runScan(selectedGroup)}
            disabled={scanning}
            title="Re-scan this category"
          >
            <RefreshCw size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {scanning ? (
        <p className="detail-empty">Scanning {selectedGroup?.label}...</p>
      ) : rows && rows.length === 0 ? (
        <p className="detail-empty">Nothing manufacturable and priced was found in this category.</p>
      ) : rows ? (
        <>
          {skipped > 0 && (
            <p className="activity-graph-note">
              {skipped} item{skipped === 1 ? "" : "s"} in this category skipped (past the {MAX_SCAN_ITEMS}-item scan cap, or missing blueprint/price data).
            </p>
          )}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Item" sortKey="name" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                  <SortableTh label="Build Cost" sortKey="buildCost" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                  <SortableTh label="Sell Price" sortKey="sellRevenue" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                  <SortableTh label="Margin" sortKey="margin" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                  <SortableTh label="Margin %" sortKey="marginPct" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                  <SortableTh label="Build Time" sortKey="timeSeconds" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                  <SortableTh label="Profit / Hour" sortKey="profitPerHour" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sorted.rows.map((r) => (
                  <tr key={r.typeId}>
                    <td>
                      <span className="asset-item-cell">
                        <img className="asset-item-icon" src={typeIconUrl(r.typeId, 32, r.name)} alt="" />
                        {r.name}
                      </span>
                    </td>
                    <td className="data-table-numeric">{formatIsk(r.buildCost)}</td>
                    <td className="data-table-numeric">{formatIsk(r.sellRevenue)}</td>
                    <td className={`data-table-numeric ${r.margin >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>{formatIsk(r.margin)}</td>
                    <td className={`data-table-numeric ${r.marginPct >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>{r.marginPct.toFixed(1)}%</td>
                    <td className="data-table-numeric">{formatDuration(r.timeSeconds)}</td>
                    <td className="data-table-numeric">{formatIsk(r.profitPerHour)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="detail-empty">Search for a category above to scan it for build-vs-sell opportunities.</p>
      )}
    </div>
  );
}

export default IndustryOpportunitiesTab;
