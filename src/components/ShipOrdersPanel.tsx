import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getRegionMarketOrders, resolveMarketLocations, type MarketOrder } from "../lib/market";
import { formatIsk } from "../lib/format";
import type { SessionCharacter } from "../lib/eve";

interface ShipOrdersPanelProps {
  typeId: number;
  typeName: string;
  regionId: number;
  hubName: string;
  characters: SessionCharacter[];
  onClose: () => void;
}

/** The Ship Scanner's "how many are actually in each of those orders"
 * drill-down - a scan only keeps best sell/buy + a raw order count per
 * hull (returning every order for every hull x hub scanned would bloat a
 * big scan's response for data almost nobody drills into), so this fetches
 * the one order book being inspected fresh, on click, the same
 * getRegionMarketOrders call Market Browser's own order book already uses. */
function ShipOrdersPanel({ typeId, typeName, regionId, hubName, characters, onClose }: ShipOrdersPanelProps) {
  const [orders, setOrders] = useState<MarketOrder[] | null>(null);
  const [locationNames, setLocationNames] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    setOrders(null);
    getRegionMarketOrders(regionId, typeId)
      .then((result) => {
        if (!cancelled) setOrders(result);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [regionId, typeId]);

  useEffect(() => {
    if (!orders || orders.length === 0 || characters.length === 0) {
      setLocationNames({});
      return;
    }
    let cancelled = false;
    const ids = [...new Set(orders.map((o) => o.location_id))];
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
  }, [orders, characters]);

  function stationName(order: MarketOrder): string {
    return locationNames[order.location_id] ?? `Station #${order.location_id}`;
  }

  const sellOrders = (orders ?? []).filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
  const buyOrders = (orders ?? []).filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);

  return (
    <div className="ship-fit-backdrop" onClick={onClose}>
      <div className="ship-fit-modal ship-orders-modal" onClick={(e) => e.stopPropagation()}>
        <div className="system-stats-header">
          <div>
            <h3>{typeName}</h3>
            <p className="system-stats-subtitle">
              {hubName} - {orders ? `${orders.length} open order${orders.length === 1 ? "" : "s"}` : "Loading..."}
            </p>
          </div>
          <button type="button" className="system-stats-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="system-stats-body">
          {!orders ? (
            <p className="detail-empty">Loading orders...</p>
          ) : orders.length === 0 ? (
            <p className="detail-empty">No open orders found.</p>
          ) : (
            <div className="market-browser-books">
              <div className="market-browser-book">
                <p className="wh-side-label">Sellers ({sellOrders.length})</p>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="data-table-numeric">Price</th>
                        <th className="data-table-numeric">Qty</th>
                        <th>Station</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellOrders.map((o) => (
                        <tr key={o.order_id}>
                          <td className="data-table-numeric wallet-amount-negative">{formatIsk(o.price)}</td>
                          <td className="data-table-numeric">{o.volume_remain.toLocaleString()}</td>
                          <td>{stationName(o)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="market-browser-book">
                <p className="wh-side-label">Buyers ({buyOrders.length})</p>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="data-table-numeric">Price</th>
                        <th className="data-table-numeric">Qty</th>
                        <th>Station</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buyOrders.map((o) => (
                        <tr key={o.order_id}>
                          <td className="data-table-numeric wallet-amount-positive">{formatIsk(o.price)}</td>
                          <td className="data-table-numeric">{o.volume_remain.toLocaleString()}</td>
                          <td>{stationName(o)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShipOrdersPanel;
