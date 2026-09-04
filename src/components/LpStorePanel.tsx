import { useEffect, useMemo, useState } from "react";
import { getCharacterLoyalty, type CharacterLoyalty } from "../lib/eve";
import { getLoyaltyStoreOffers, type LoyaltyStoreOffer } from "../lib/loyalty";
import { getMarketPrices } from "../lib/market";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";

interface LpStorePanelProps {
  characterId: number | null;
}

interface RankedOffer extends LoyaltyStoreOffer {
  rewardValue: number;
  requiredValue: number;
  totalCost: number;
  profit: number;
  iskPerLp: number;
}

/** LP stores need LP + ISK + (sometimes) specific turned-in items - all
 * three factor into whether an offer is actually worth taking, not just
 * its raw LP price. Reward/required-item values come from the same
 * EVE-wide average price the rest of the app already uses as its
 * fallback valuation, since LP-store items don't always have a live
 * regional order book (some are faction-only, rarely traded). */
function LpStorePanel({ characterId }: LpStorePanelProps) {
  const reportError = useErrorReporter();
  const [loyalty, setLoyalty] = useState<CharacterLoyalty | null>(null);
  const [selectedCorpId, setSelectedCorpId] = useState<number | null>(null);
  const [offers, setOffers] = useState<LoyaltyStoreOffer[] | null>(null);
  const [loadingOffers, setLoadingOffers] = useState(false);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const [query, setQuery] = useState("");

  useEffect(() => {
    setLoyalty(null);
    setSelectedCorpId(null);
    setOffers(null);
    if (characterId == null) return;
    let cancelled = false;
    getCharacterLoyalty(characterId)
      .then((result) => {
        if (cancelled) return;
        setLoyalty(result);
        if (result.entries.length === 1) setSelectedCorpId(result.entries[0].corporation_id);
      })
      .catch((err) => reportError(`Failed to load loyalty points: ${String(err)}`));
    return () => {
      cancelled = true;
    };
  }, [characterId, reportError]);

  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setOffers(null);
    if (selectedCorpId == null) return;
    let cancelled = false;
    setLoadingOffers(true);
    getLoyaltyStoreOffers(selectedCorpId)
      .then((result) => {
        if (!cancelled) setOffers(result);
      })
      .catch((err) => reportError(`Failed to load the LP store: ${String(err)}`))
      .finally(() => {
        if (!cancelled) setLoadingOffers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCorpId, reportError]);

  const rankedOffers = useMemo<RankedOffer[]>(() => {
    if (!offers) return [];
    const valueFor = (typeId: number) => prices.get(typeId) ?? 0;
    const ranked = offers.map((o) => {
      const rewardValue = valueFor(o.type_id) * o.quantity;
      const requiredValue = o.required_items.reduce((sum, r) => sum + valueFor(r.type_id) * r.quantity, 0);
      const totalCost = o.isk_cost + requiredValue;
      const profit = rewardValue - totalCost;
      return { ...o, rewardValue, requiredValue, totalCost, profit, iskPerLp: o.lp_cost > 0 ? profit / o.lp_cost : 0 };
    });
    ranked.sort((a, b) => b.iskPerLp - a.iskPerLp);
    return ranked;
  }, [offers, prices]);

  const filteredOffers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rankedOffers;
    return rankedOffers.filter((o) => o.type_name.toLowerCase().includes(q));
  }, [rankedOffers, query]);

  const sortedOffers = useSortableRows(filteredOffers, {
    type_name: (o) => o.type_name,
    lp_cost: (o) => o.lp_cost,
    isk_cost: (o) => o.isk_cost,
    reward_value: (o) => o.rewardValue,
    isk_per_lp: (o) => o.iskPerLp,
  }, "isk_per_lp");

  if (characterId == null) {
    return <p className="detail-empty">Pick a character to see their loyalty points and LP stores.</p>;
  }
  if (!loyalty) {
    return <p className="detail-empty">Loading loyalty points...</p>;
  }
  if (loyalty.needs_reauth) {
    return <p className="detail-empty">Sign in again to unlock loyalty points for this character.</p>;
  }
  if (loyalty.entries.length === 0) {
    return <p className="detail-empty">No loyalty points earned with any corporation yet.</p>;
  }

  return (
    <div className="lp-store-panel">
      <div className="skill-filter-pills">
        {loyalty.entries.map((l) => (
          <button
            key={l.corporation_id}
            type="button"
            className={`skill-filter-pill${selectedCorpId === l.corporation_id ? " skill-filter-pill-active" : ""}`}
            onClick={() => setSelectedCorpId(l.corporation_id)}
          >
            {l.corporation_name} <span className="lp-store-pill-count">{l.loyalty_points.toLocaleString()} LP</span>
          </button>
        ))}
      </div>

      {selectedCorpId == null ? (
        <p className="detail-empty">Pick a corporation above to browse its LP store.</p>
      ) : loadingOffers || !offers ? (
        <p className="detail-empty">Loading LP store...</p>
      ) : offers.length === 0 ? (
        <p className="detail-empty">This corporation has no LP store offers.</p>
      ) : (
        <>
          <input
            type="text"
            className="contracts-search-input"
            placeholder="Filter items..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="settings-section-hint">
            Ranked by estimated ISK profit per LP spent (reward value minus ISK cost and any turned-in items' value,
            all priced at EVE-wide average - a rough guide, not a guaranteed sell price).
          </p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Item" sortKey="type_name" activeKey={sortedOffers.sortKey} dir={sortedOffers.sortDir} onSort={sortedOffers.sort} />
                  <SortableTh label="LP Cost" sortKey="lp_cost" activeKey={sortedOffers.sortKey} dir={sortedOffers.sortDir} onSort={sortedOffers.sort} numeric />
                  <SortableTh label="ISK Cost" sortKey="isk_cost" activeKey={sortedOffers.sortKey} dir={sortedOffers.sortDir} onSort={sortedOffers.sort} numeric />
                  <th>Turn In</th>
                  <SortableTh label="Reward Value" sortKey="reward_value" activeKey={sortedOffers.sortKey} dir={sortedOffers.sortDir} onSort={sortedOffers.sort} numeric />
                  <SortableTh label="ISK / LP" sortKey="isk_per_lp" activeKey={sortedOffers.sortKey} dir={sortedOffers.sortDir} onSort={sortedOffers.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sortedOffers.rows.map((o) => (
                  <tr key={o.offer_id}>
                    <td>
                      <span className="asset-item-cell">
                        <img src={typeIconUrl(o.type_id, 32, o.type_name)} alt="" className="asset-item-icon" />
                        {o.type_name}
                        {o.quantity > 1 ? ` x${o.quantity}` : ""}
                      </span>
                    </td>
                    <td className="data-table-numeric">{o.lp_cost.toLocaleString()}</td>
                    <td className="data-table-numeric wallet-amount-negative">{formatIsk(o.isk_cost)}</td>
                    <td>
                      {o.required_items.length === 0
                        ? "—"
                        : o.required_items.map((r) => `${r.type_name}${r.quantity > 1 ? ` x${r.quantity}` : ""}`).join(", ")}
                    </td>
                    <td className="data-table-numeric wallet-amount-positive">{formatIsk(o.rewardValue)}</td>
                    <td className={`data-table-numeric ${o.iskPerLp >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>
                      {formatIsk(o.iskPerLp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default LpStorePanel;
