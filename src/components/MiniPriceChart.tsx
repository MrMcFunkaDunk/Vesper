import { formatIsk } from "../lib/format";
import type { MarketHistoryPoint } from "../lib/market";

interface MiniPriceChartProps {
  points: MarketHistoryPoint[];
  name: string;
}

/** Compact price-history chart for a grid of many items at once - same
 * hand-rolled SVG line+area approach as MarketBrowser.tsx's own
 * PriceHistoryChart (no charting library dependency), just sized down and
 * without that one's fixed 90-day slice, since the caller already slices
 * to whatever timeframe is selected. Reuses the exact same
 * .market-history-area/.market-history-line classes so a mini chart here
 * and the full one on the Market Browser's own History tab read as the
 * same visual language. */
function MiniPriceChart({ points, name }: MiniPriceChartProps) {
  if (points.length < 2) {
    return (
      <div className="mini-price-chart">
        <p className="mini-price-chart-name">{name}</p>
        <p className="detail-empty">Not enough history yet.</p>
      </div>
    );
  }

  const width = 280;
  const height = 90;
  const padding = 4;
  const values = points.map((p) => p.average);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - padding * 2) / (points.length - 1);
  const toY = (v: number) => height - padding - ((v - min) / range) * (height - padding * 2);
  const linePoints = points.map((p, i) => `${padding + i * stepX},${toY(p.average)}`).join(" ");
  const areaPoints = `${padding},${height - padding} ${linePoints} ${padding + (points.length - 1) * stepX},${height - padding}`;

  const first = points[0].average;
  const last = points[points.length - 1].average;
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

  return (
    <div className="mini-price-chart">
      <p className="mini-price-chart-name">{name}</p>
      <div className="mini-price-chart-header">
        <span className="isk" title={`Price ranged from ${formatIsk(min)} to ${formatIsk(max)} over this period`}>
          {formatIsk(min)} – {formatIsk(max)}
        </span>
        <span
          className={changePct >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}
          title="Net change from the start to the end of this period"
        >
          {changePct >= 0 ? "+" : ""}
          {changePct.toFixed(1)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="mini-price-chart-svg">
        <polygon points={areaPoints} className="market-history-area" />
        <polyline points={linePoints} className="market-history-line" />
      </svg>
    </div>
  );
}

export default MiniPriceChart;
