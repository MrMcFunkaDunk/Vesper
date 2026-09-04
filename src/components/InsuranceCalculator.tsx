import { useEffect, useState } from "react";
import { searchMarketTypes, type TypeSearchMatch } from "../lib/market";
import { getInsuranceLevels, listInsurableShipIds, type InsuranceLevel } from "../lib/kills";
import { formatIsk, typeIconUrl } from "../lib/format";

/** ESI has no endpoint anywhere for a character's actual active insurance
 * policies (confirmed live against the full ESI spec) - only this public
 * cost/payout table per ship type. So this is framed as a calculator
 * ("what would insuring this ship cost right now"), not a policy tracker. */
function InsuranceCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedShip, setSelectedShip] = useState<TypeSearchMatch | null>(null);
  const [levels, setLevels] = useState<InsuranceLevel[] | null>(null);
  const [loading, setLoading] = useState(false);
  // The local item-type search has no notion of "is this a ship" - it'll
  // happily suggest modules, minerals, anything - so this fetches the exact
  // set ESI actually has insurance data for, once, and filters against it.
  const [insurableIds, setInsurableIds] = useState<Set<number> | null>(null);

  useEffect(() => {
    listInsurableShipIds()
      .then((ids) => setInsurableIds(new Set(ids)))
      .catch(() => setInsurableIds(new Set()));
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !insurableIds) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMarketTypes(trimmed)
        .then((results) => {
          if (cancelled) return;
          const shipsOnly = results.filter((r) => insurableIds.has(r.id));
          setSuggestions(shipsOnly);
          setSuggestionsOpen(shipsOnly.length > 0);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, insurableIds]);

  function pickShip(ship: TypeSearchMatch) {
    setSelectedShip(ship);
    setQuery(ship.name);
    setSuggestionsOpen(false);
    setLevels(null);
    setLoading(true);
    getInsuranceLevels(ship.id)
      .then(setLevels)
      .catch(() => setLevels([]))
      .finally(() => setLoading(false));
  }

  return (
    <div className="insurance-calculator">
      <p className="intel-check-hint">
        Search for a ship to see its current insurance cost and payout per tier - a calculator, not a tracker of your
        actual policies (ESI doesn't expose those).
      </p>

      <div className="kills-add-combobox market-browser-search">
        <input
          type="text"
          placeholder="Search for a ship (e.g. Raven, Rifter)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (selectedShip) setSelectedShip(null);
          }}
          onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
          onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
        />
        {suggestionsOpen && (
          <div className="gatecheck-slot-results kills-add-suggestions">
            {suggestions.map((s) => (
              <button key={s.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickShip(s)}>
                <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {!selectedShip ? (
        <p className="detail-empty">Search for a ship above to see its insurance tiers.</p>
      ) : loading ? (
        <p className="detail-empty">Loading insurance levels...</p>
      ) : !levels || levels.length === 0 ? (
        <p className="detail-empty">No insurance data found for {selectedShip.name} - it may not be an insurable hull.</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Level</th>
                <th className="data-table-numeric">Cost</th>
                <th className="data-table-numeric">Payout</th>
                <th className="data-table-numeric">Net Payout</th>
              </tr>
            </thead>
            <tbody>
              {[...levels]
                .sort((a, b) => a.payout - b.payout)
                .map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td className="data-table-numeric wallet-amount-negative">{formatIsk(l.cost)}</td>
                    <td className="data-table-numeric wallet-amount-positive">{formatIsk(l.payout)}</td>
                    <td className={`data-table-numeric ${l.payout - l.cost >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}`}>
                      {formatIsk(l.payout - l.cost)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default InsuranceCalculator;
