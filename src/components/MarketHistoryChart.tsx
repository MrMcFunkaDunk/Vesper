import { useId, useMemo, useState, type MouseEvent } from "react";
import { formatIsk } from "../lib/format";
import type { MarketHistoryPoint } from "../lib/market";

const WIDTH = 760;
const HEIGHT = 240;
const PAD_LEFT = 56;
const PAD_RIGHT = 56;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;

/** Rounds a value up to a "clean" axis-label number (1/2/5 x a power of
 * ten), same convention ActivityGraphs.tsx's sparklines use, so gridline
 * labels read as round numbers instead of whatever the actual max happens
 * to be. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

type ChartMode = "chart" | "grid";

interface MarketHistoryChartProps {
  points: MarketHistoryPoint[];
  /** How many trailing days to plot/list - the caller decides the window
   * (Market Browser's item panel has always shown a fixed 90 days). */
  days?: number;
}

/** Item price history the way EveConsole's own Item Browser shows it -
 * Average/High/Low on a left ISK axis over a Volume bar series on a right
 * secondary axis, instead of just an average-price area fill. A Chart/Grid
 * toggle flips the same data into a plain sortable-by-eye table for anyone
 * who wants exact numbers rather than a picture of them. */
function MarketHistoryChart({ points, days = 90 }: MarketHistoryChartProps) {
  const [mode, setMode] = useState<ChartMode>("chart");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const instanceId = useId();

  const recent = useMemo(() => points.slice(-days), [points, days]);

  if (recent.length < 2) {
    return <p className="detail-empty">Not enough history to chart yet.</p>;
  }

  const iskMax = niceMax(Math.max(...recent.map((p) => p.highest)));
  const volumeMax = niceMax(Math.max(...recent.map((p) => p.volume)));
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = innerWidth / (recent.length - 1);
  const toX = (i: number) => PAD_LEFT + i * stepX;
  const toIskY = (v: number) => PAD_TOP + innerHeight - (v / iskMax) * innerHeight;
  const toVolumeY = (v: number) => PAD_TOP + innerHeight - (v / volumeMax) * innerHeight;
  const baseline = PAD_TOP + innerHeight;
  const barWidth = Math.max(1.5, stepX * 0.6);

  const avgPoints = recent.map((p, i) => `${toX(i)},${toIskY(p.average)}`).join(" ");
  const highPoints = recent.map((p, i) => `${toX(i)},${toIskY(p.highest)}`).join(" ");
  const lowPoints = recent.map((p, i) => `${toX(i)},${toIskY(p.lowest)}`).join(" ");
  const areaPoints = `${toX(0)},${baseline} ${avgPoints} ${toX(recent.length - 1)},${baseline}`;

  const tickCount = Math.min(6, recent.length);
  const tickIndices = Array.from({ length: tickCount }, (_, i) => Math.round((i * (recent.length - 1)) / (tickCount - 1)));

  function handleMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const idx = Math.round((x - PAD_LEFT) / stepX);
    setHoverIdx(Math.min(recent.length - 1, Math.max(0, idx)));
  }

  const hovered = hoverIdx != null ? recent[hoverIdx] : null;

  return (
    <div className="market-history-chart">
      <div className="market-history-chart-toolbar">
        <div className="market-history-legend">
          <span className="market-history-legend-item">
            <span className="market-history-swatch" style={{ background: "var(--accent)" }} />
            Average
          </span>
          <span className="market-history-legend-item">
            <span className="market-history-swatch" style={{ background: "var(--success)" }} />
            High
          </span>
          <span className="market-history-legend-item">
            <span className="market-history-swatch" style={{ background: "var(--danger)" }} />
            Low
          </span>
          <span className="market-history-legend-item">
            <span className="market-history-swatch market-history-swatch-volume" />
            Volume
          </span>
        </div>
        <div className="market-history-mode-toggle">
          <button type="button" className={mode === "chart" ? "market-history-mode-active" : ""} onClick={() => setMode("chart")}>
            Chart
          </button>
          <button type="button" className={mode === "grid" ? "market-history-mode-active" : ""} onClick={() => setMode("grid")}>
            Grid
          </button>
        </div>
      </div>

      {mode === "chart" ? (
        <>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="market-history-svg"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id={`market-history-fill-${instanceId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* Left (ISK) axis gridlines/labels - max and midpoint, baseline implied at 0. */}
            {[1, 0.5, 0].map((frac) => (
              <g key={frac}>
                <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={PAD_TOP + innerHeight * (1 - frac)} y2={PAD_TOP + innerHeight * (1 - frac)} className="market-history-gridline" />
                <text x={PAD_LEFT - 8} y={PAD_TOP + innerHeight * (1 - frac)} className="market-history-axis-label" textAnchor="end" dominantBaseline="middle">
                  {formatIsk(iskMax * frac)}
                </text>
                <text x={WIDTH - PAD_RIGHT + 8} y={PAD_TOP + innerHeight * (1 - frac)} className="market-history-axis-label market-history-axis-label-volume" textAnchor="start" dominantBaseline="middle">
                  {Math.round(volumeMax * frac).toLocaleString()}
                </text>
              </g>
            ))}

            {/* X-axis date ticks. */}
            {tickIndices.map((idx, i) => (
              <text
                key={idx}
                x={toX(idx)}
                y={HEIGHT - 6}
                className="market-history-axis-label"
                textAnchor={i === 0 ? "start" : i === tickIndices.length - 1 ? "end" : "middle"}
              >
                {recent[idx].date}
              </text>
            ))}

            {/* Volume bars, riding the secondary right-hand axis. */}
            {recent.map((p, i) => (
              <rect
                key={i}
                x={toX(i) - barWidth / 2}
                y={toVolumeY(p.volume)}
                width={barWidth}
                height={Math.max(0, baseline - toVolumeY(p.volume))}
                className="market-history-volume-bar"
                opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.5}
              />
            ))}

            <polygon points={areaPoints} fill={`url(#market-history-fill-${instanceId})`} />
            <polyline points={highPoints} className="market-history-line market-history-line-high" />
            <polyline points={lowPoints} className="market-history-line market-history-line-low" />
            <polyline points={avgPoints} className="market-history-line market-history-line-avg" />

            {hovered && hoverIdx != null && (
              <line x1={toX(hoverIdx)} x2={toX(hoverIdx)} y1={PAD_TOP} y2={baseline} className="market-history-scanline" />
            )}
          </svg>
          <div className="market-history-hover-readout">
            {hovered ? (
              <>
                <span>{hovered.date}</span>
                <span>
                  Avg <strong className="isk">{formatIsk(hovered.average)}</strong>
                </span>
                <span>
                  High <strong className="isk">{formatIsk(hovered.highest)}</strong>
                </span>
                <span>
                  Low <strong className="isk">{formatIsk(hovered.lowest)}</strong>
                </span>
                <span>
                  Volume <strong>{hovered.volume.toLocaleString()}</strong>
                </span>
              </>
            ) : (
              <span className="market-history-hover-readout-muted">Hover the chart for exact values</span>
            )}
          </div>
        </>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="data-table-numeric">Average</th>
                <th className="data-table-numeric">High</th>
                <th className="data-table-numeric">Low</th>
                <th className="data-table-numeric">Volume</th>
                <th className="data-table-numeric">Orders</th>
              </tr>
            </thead>
            <tbody>
              {[...recent].reverse().map((p) => (
                <tr key={p.date}>
                  <td>{p.date}</td>
                  <td className="data-table-numeric">{formatIsk(p.average)}</td>
                  <td className="data-table-numeric">{formatIsk(p.highest)}</td>
                  <td className="data-table-numeric">{formatIsk(p.lowest)}</td>
                  <td className="data-table-numeric">{p.volume.toLocaleString()}</td>
                  <td className="data-table-numeric">{p.order_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default MarketHistoryChart;
