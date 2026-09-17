import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getCategoryGroupsByMeta, scanShipMarket, type GroupSummary, type ShipScanHub, type ShipScanShip, type ShipScanResult } from "../lib/market";
import { TRADE_HUB_REGIONS, tradeHubName, regionHubColor } from "../lib/map";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import ShipOrdersPanel from "./ShipOrdersPanel";
import type { SessionCharacter } from "../lib/eve";

/// The Ship category id (categoryID 6 in the SDE) - types.group_id under
/// this category is the real hull-size class (Frigate, Cruiser, Battleship,
/// etc.), already resolved into a browsable group list by the same
/// getCategoryGroups call the Item Database uses for every other category.
const SHIP_CATEGORY_ID = 6;

/// CCP's own meta-group ids, verified against the local SDE before building
/// this: Navy Issue AND pirate-faction hulls (Gila, Vigilant, Stratios,
/// Vexor Navy Issue) share id 4 - there's no separate "pirate" id, so
/// "Faction / Pirate" is genuinely one bucket, not two combined here.
const META_LEVELS: { id: number | null; label: string }[] = [
  { id: null, label: "All Tech Levels" },
  { id: 1, label: "Tech I" },
  { id: 2, label: "Tech II" },
  { id: 14, label: "Tech III" },
  { id: 4, label: "Faction / Pirate" },
  { id: 3, label: "Storyline" },
];

const DAY_OPTIONS = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 14, label: "Last 14 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

function metaBadge(metaGroupId: number | null): { label: string; className: string } {
  switch (metaGroupId) {
    case 1:
      return { label: "T1", className: "data-table-tag-neutral" };
    case 2:
      return { label: "T2", className: "data-table-tag-accent" };
    case 14:
      return { label: "T3", className: "" };
    case 4:
      return { label: "FACTION", className: "data-table-tag-warning" };
    case 3:
      return { label: "STORY", className: "data-table-tag-danger" };
    default:
      return { label: "—", className: "data-table-tag-neutral" };
  }
}

interface HubTableProps {
  hub: ShipScanHub;
  onSelectShip: (ship: ShipScanShip) => void;
}

function HubTable({ hub, onSelectShip }: HubTableProps) {
  const sorted = useSortableRows(
    hub.ships,
    {
      type_name: (s) => s.type_name,
      volume_sold: (s) => s.volume_sold,
      sell_order_count: (s) => s.sell_order_count,
      best_sell: (s) => s.best_sell,
      best_buy: (s) => s.best_buy,
    },
    "volume_sold",
    "desc",
  );
  const regionName = TRADE_HUB_REGIONS.find((h) => h.regionId === hub.region_id)?.regionName ?? "";
  const color = regionHubColor(regionName);

  return (
    <div className="ship-scan-hub" style={color ? { borderLeftColor: color } : undefined}>
      <p className="ship-scan-hub-header" style={color ? { color } : undefined}>
        {tradeHubName(regionName)}
      </p>
      {hub.ships.length === 0 ? (
        <p className="detail-empty">No sales data found.</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Ship" sortKey="type_name" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} defaultDir="asc" />
                <SortableTh label="Vol Sold" sortKey="volume_sold" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                <SortableTh label="Sell Orders" sortKey="sell_order_count" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                <SortableTh label="Best Sell" sortKey="best_sell" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric defaultDir="asc" />
                <SortableTh label="Best Buy" sortKey="best_buy" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((s) => {
                const badge = metaBadge(s.meta_group_id);
                return (
                  <tr key={s.type_id} className="ship-scan-row" onClick={() => onSelectShip(s)} title={`See every open order for ${s.type_name}`}>
                    <td>
                      <span className="asset-item-cell">
                        <img className="asset-item-icon" src={typeIconUrl(s.type_id, 32, s.type_name)} alt="" />
                        {s.type_name}
                        <span className={`data-table-tag ${badge.className}`}>{badge.label}</span>
                      </span>
                    </td>
                    <td className="data-table-numeric">{s.volume_sold.toLocaleString()}</td>
                    <td className="data-table-numeric">{s.sell_order_count.toLocaleString()}</td>
                    <td className="data-table-numeric wallet-amount-negative">{s.best_sell != null ? formatIsk(s.best_sell) : "—"}</td>
                    <td className="data-table-numeric wallet-amount-positive">{s.best_buy != null ? formatIsk(s.best_buy) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/// A per-ship-class market scanner across VESPER's 5 major trade hubs -
/// pick a hull class (Cruiser, Battleship, ...) and a tech level (Tech I/II/
/// III, Faction/Pirate, Storyline), and see the top N best-selling hulls in
/// that bucket in each hub side by side, with best sell/buy and open order
/// counts. A manual "Initiate Scan" rather than a live view: a big class
/// across all 5 hubs is genuinely a lot of ESI calls (hulls x hubs, orders
/// + history each), so it only runs when asked, same reasoning as Industry
/// Opportunities' own capped scan.
interface ShipScannerTabProps {
  characters: SessionCharacter[];
}

function ShipScannerTab({ characters }: ShipScannerTabProps) {
  const [shipGroups, setShipGroups] = useState<GroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [metaGroupId, setMetaGroupId] = useState<number | null>(4);
  const [days, setDays] = useState(7);
  const [topN, setTopN] = useState(10);
  const [result, setResult] = useState<ShipScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [viewingOrders, setViewingOrders] = useState<{ ship: ShipScanShip; regionId: number; hubName: string } | null>(null);
  const reportError = useErrorReporter();

  // Re-fetched whenever the tech level changes, not just once on mount -
  // each group's hull count here only reflects hulls at that meta level
  // (e.g. Cruiser might be 10 hulls under Faction/Pirate but 20 under Tech
  // I), so picking a tech level first genuinely changes what "how many
  // hulls can I search" means before a scan ever runs.
  useEffect(() => {
    let cancelled = false;
    getCategoryGroupsByMeta(SHIP_CATEGORY_ID, metaGroupId)
      .then((groups) => {
        if (cancelled) return;
        setShipGroups(groups);
        setGroupId((prev) => (prev != null && groups.some((g) => g.id === prev) ? prev : groups.find((g) => g.name === "Cruiser")?.id ?? groups[0]?.id ?? null));
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load ship classes: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaGroupId]);

  const selectedGroup = useMemo(() => shipGroups?.find((g) => g.id === groupId) ?? null, [shipGroups, groupId]);
  const selectedMeta = META_LEVELS.find((m) => m.id === metaGroupId) ?? META_LEVELS[0];
  const selectedDays = DAY_OPTIONS.find((d) => d.days === days) ?? DAY_OPTIONS[1];

  async function runScan() {
    if (groupId == null) return;
    setScanning(true);
    setResult(null);
    try {
      const scanResult = await scanShipMarket(
        groupId,
        metaGroupId,
        TRADE_HUB_REGIONS.map((h) => h.regionId),
        days,
        Math.max(1, topN),
      );
      setResult(scanResult);
    } catch (err) {
      reportError(`Ship scan failed: ${String(err)}`);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel ship-scan-params">
        <div className="ship-scan-fields">
          <label className="wh-field-label">
            Tech Level
            <select className="industry-field-input" value={metaGroupId ?? ""} onChange={(e) => setMetaGroupId(e.target.value === "" ? null : Number(e.target.value))}>
              {META_LEVELS.map((m) => (
                <option key={m.label} value={m.id ?? ""}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wh-field-label">
            Ship Class
            <select
              className="industry-field-input"
              value={groupId ?? ""}
              onChange={(e) => setGroupId(Number(e.target.value))}
              disabled={!shipGroups}
            >
              {(shipGroups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.item_count} hull{g.item_count === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </label>
          <label className="wh-field-label">
            Volume Period
            <select className="industry-field-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_OPTIONS.map((d) => (
                <option key={d.days} value={d.days}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wh-field-label">
            Top N Ships
            <input
              type="number"
              className="industry-field-input"
              min={1}
              max={30}
              value={topN}
              onChange={(e) => setTopN(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
          <button type="button" className="kills-sync-btn ship-scan-btn" onClick={runScan} disabled={scanning || groupId == null}>
            <RefreshCw size={14} strokeWidth={2} className={scanning ? "spin" : undefined} />
            {scanning ? "Scanning..." : "Initiate Scan"}
          </button>
        </div>
        <p className="settings-section-hint">
          Scans across VESPER's 5 major trade hubs - the same set the rest of the app uses. A big class across all 5
          hubs means a lot of ESI calls (every hull x every hub, orders + history each), so this runs on demand
          rather than staying live.
        </p>
        {result && (
          <p className="ship-scan-status">
            Scan complete - {result.feeds_processed} market feeds processed for {result.hull_count} hull
            {result.hull_count === 1 ? "" : "s"}.
          </p>
        )}
      </div>

      {result && (
        <div className="industry-results-panel">
          <p className="wh-side-label">
            {selectedGroup?.name ?? "Ships"} · {selectedMeta.label} · Top {topN} by Vol · {selectedDays.label}
          </p>
          <div className="ship-scan-hubs">
            {result.hubs.map((hub) => (
              <HubTable
                key={hub.region_id}
                hub={hub}
                onSelectShip={(ship) =>
                  setViewingOrders({
                    ship,
                    regionId: hub.region_id,
                    hubName: tradeHubName(TRADE_HUB_REGIONS.find((h) => h.regionId === hub.region_id)?.regionName ?? ""),
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      {viewingOrders && (
        <ShipOrdersPanel
          typeId={viewingOrders.ship.type_id}
          typeName={viewingOrders.ship.type_name}
          regionId={viewingOrders.regionId}
          hubName={viewingOrders.hubName}
          characters={characters}
          onClose={() => setViewingOrders(null)}
        />
      )}
    </div>
  );
}

export default ShipScannerTab;
