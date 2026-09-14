export interface PieSlice {
  label: string;
  value: number;
}

interface PieChartWithLegendProps {
  slices: PieSlice[];
  /** Formats each legend row's trailing value - ISK, a unit count, whatever
   * the caller's slices actually measure. Defaults to a plain thousands-grouped number. */
  formatValue?: (value: number) => string;
  size?: number;
}

/** A fixed categorical palette rather than theme tokens - these colors only
 * ever need to stay distinguishable from each other around a ring, not
 * carry any of this app's usual semantic meaning (danger/warning/etc), so a
 * hardcoded set that reads well in both light and dark keeps this simple.
 * The literal label "Other" always renders in the trailing muted grey,
 * matching the "top N + everything else" bucketing convention callers use. */
const PALETTE = ["#5b9bd5", "#e07a3f", "#5fbf8a", "#c95d5d", "#9b7fd4", "#d4b04a", "#4fb3bf", "#d4749b"];
const OTHER_COLOR = "#7a7f8c";

function colorFor(label: string, index: number): string {
  if (label === "Other") return OTHER_COLOR;
  return PALETTE[index % PALETTE.length];
}

/** A pie with its legend listed beside it (colored dot + label + value + %)
 * rather than crammed as labels on the slices themselves - the layout
 * EveConsole's own Market Overview uses, and far more readable than a
 * traditional pie legend once there are more than 3-4 categories. Callers
 * are expected to have already bucketed anything past the top handful of
 * categories into a trailing "Other" slice - this component just draws
 * whatever slices it's given. */
function PieChartWithLegend({ slices, formatValue = (v) => v.toLocaleString(), size = 140 }: PieChartWithLegendProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) {
    return <p className="detail-empty">No data to chart yet.</p>;
  }

  const radius = size / 2;
  const cx = radius;
  const cy = radius;

  let cumulative = 0;
  const rows = slices.map((slice, i) => {
    const fraction = slice.value / total;
    const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
    cumulative += fraction;
    const endAngle = cumulative * 2 * Math.PI - Math.PI / 2;
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    // A slice covering (essentially) the whole pie can't be drawn as one
    // arc back to its own start point - split it into two half-circle arcs
    // instead of letting the path collapse to nothing.
    const isFullCircle = fraction > 0.9999;
    const d = isFullCircle
      ? `M ${cx},${cy - radius} A ${radius},${radius} 0 1 1 ${cx - 0.01},${cy - radius} Z`
      : `M ${cx},${cy} L ${x1},${y1} A ${radius},${radius} 0 ${largeArc} 1 ${x2},${y2} Z`;
    return { d, color: colorFor(slice.label, i), label: slice.label, value: slice.value, pct: fraction * 100 };
  });

  return (
    <div className="pie-chart-with-legend">
      <svg viewBox={`0 0 ${size} ${size}`} className="pie-chart-svg">
        {rows.map((r, i) => (
          <path key={i} d={r.d} fill={r.color} />
        ))}
      </svg>
      <ul className="pie-chart-legend">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="pie-chart-legend-dot" style={{ background: r.color }} />
            <span className="pie-chart-legend-label">{r.label}</span>
            <span className="pie-chart-legend-value">{formatValue(r.value)}</span>
            <span className="pie-chart-legend-pct">{r.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default PieChartWithLegend;
