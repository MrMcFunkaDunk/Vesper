import { TrendingUp, TrendingDown } from "lucide-react";

export interface GainerLoserItem {
  typeId: number;
  name: string;
  changePct: number;
}

interface GainersLosersPanelProps {
  items: GainerLoserItem[];
  limit?: number;
}

/** Two-column gainers/losers split, eveboosters.com's own Trade Report
 * layout - every row reuses the existing wallet-amount-positive/-negative
 * tokens rather than inventing new ones. Takes the already-computed
 * changePct list from whatever screen is watching prices over a period (see
 * MarketHistoryTab, the first caller) rather than fetching or deriving
 * anything itself. */
function GainersLosersPanel({ items, limit = 5 }: GainersLosersPanelProps) {
  const sorted = [...items].sort((a, b) => b.changePct - a.changePct);
  const gainers = sorted.filter((i) => i.changePct > 0).slice(0, limit);
  const losers = sorted
    .filter((i) => i.changePct < 0)
    .slice(-limit)
    .reverse();

  return (
    <div className="gainers-losers-panel">
      <div className="gainers-losers-column">
        <div className="gainers-losers-column-header gainers-losers-column-header-up">
          <TrendingUp size={14} strokeWidth={2} />
          Gainers
        </div>
        {gainers.length === 0 ? (
          <p className="detail-empty">Nothing up over this period.</p>
        ) : (
          gainers.map((item) => (
            <div key={item.typeId} className="gainers-losers-row">
              <span className="gainers-losers-row-name">{item.name}</span>
              <span className="wallet-amount-positive">
                +{item.changePct.toFixed(1)}%
              </span>
            </div>
          ))
        )}
      </div>
      <div className="gainers-losers-column">
        <div className="gainers-losers-column-header gainers-losers-column-header-down">
          <TrendingDown size={14} strokeWidth={2} />
          Losers
        </div>
        {losers.length === 0 ? (
          <p className="detail-empty">Nothing down over this period.</p>
        ) : (
          losers.map((item) => (
            <div key={item.typeId} className="gainers-losers-row">
              <span className="gainers-losers-row-name">{item.name}</span>
              <span className="wallet-amount-negative">
                {item.changePct.toFixed(1)}%
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default GainersLosersPanel;
