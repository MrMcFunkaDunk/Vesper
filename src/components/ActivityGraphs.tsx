import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { getSystemKillHistory, type KillHistoryPoint } from "../lib/kills";
import { getSystemJumpHistory, type JumpHistoryPoint } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";

/** The Capsule's type id (confirmed live via ESI) - a kill counts as a "pod
 * kill" when the victim's ship was this. */
const CAPSULE_TYPE_ID = 670;
const HOUR_BUCKETS = 48;
const GRAPH_WIDTH = 480;
const GRAPH_HEIGHT = 132;
/** Chart-area padding, asymmetric on purpose: left/bottom leave room for
 * axis labels, top leaves room for the hover pill and peak marker so
 * neither ever clips against the SVG edge. */
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 22;
const PAD_BOTTOM = 20;
/** Kill history is a live zKillboard pagination fetch (not a cheap local
 * read like jump history), so this stays a background poll rather than
 * anything faster - matches the Dashboard's own periodic-refresh cadence
 * rather than the kill feed's near-real-time long-poll stream, since an
 * hour-bucketed graph wouldn't visibly benefit from sub-minute updates
 * anyway. */
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

/** 48 hour-bucket start times (unix seconds), oldest to newest, ending at
 * the current hour - the shared x-axis every graph below buckets onto. */
function buildHourBuckets(): number[] {
  const nowHourStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const buckets: number[] = [];
  for (let i = HOUR_BUCKETS - 1; i >= 0; i--) {
    buckets.push(nowHourStart - i * 3600);
  }
  return buckets;
}

function formatBucketTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Rounds a value up to a "clean" axis-label number (1/2/5 x a power of
 * ten) - the same convention every real charting library uses so gridline
 * labels read as round numbers instead of whatever the actual max happens
 * to be. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** Smooth cubic-bezier path through a point series (uniform Catmull-Rom,
 * tension 1/6 - the standard conversion) instead of a jagged polyline, so
 * the curve reads as one continuous shape rather than a connect-the-dots
 * zigzag. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** Evenly-spaced relative-hour tick labels across the 48h window, rather
 * than cramming 48 absolute clock times along a 480px axis. */
const X_TICK_INDICES = [0, 12, 24, 36, 47];
const X_TICK_LABELS = ["-48h", "-36h", "-24h", "-12h", "Now"];

interface SparklineProps {
  label: string;
  values: number[];
  bucketStarts: number[];
  color: string;
  glowColor: string;
}

/** A single 48h activity graph - smooth gradient-filled curve, glowing
 * stroke, y-axis gridlines/labels, x-axis relative-hour ticks, a permanent
 * peak marker, and a floating value readout that follows the hovered
 * point. */
function Sparkline({ label, values, bucketStarts, color, glowColor }: SparklineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const instanceId = useId();

  const max = niceMax(Math.max(0, ...values));
  const innerWidth = GRAPH_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = GRAPH_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = innerWidth / Math.max(1, values.length - 1);
  const toX = (i: number) => PAD_LEFT + i * stepX;
  const toY = (v: number) => PAD_TOP + innerHeight - (v / max) * innerHeight;
  const baseline = PAD_TOP + innerHeight;

  const points = values.map((v, i) => ({ x: toX(i), y: toY(v) }));
  const linePath = smoothPath(points);
  const barWidth = Math.max(1.5, stepX * 0.55);

  const total = values.reduce((a, b) => a + b, 0);
  const peakIdx = total > 0 ? values.reduce((best, v, i) => (v > values[best] ? i : best), 0) : null;

  function handleMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * GRAPH_WIDTH;
    const idx = Math.round((x - PAD_LEFT) / stepX);
    setHoverIdx(Math.min(values.length - 1, Math.max(0, idx)));
  }

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  // Clamp the floating pill so it never clips past the left/right edges of
  // the chart, however close to either side the hovered point sits.
  const pillWidth = 58;
  const pillX = hoverPoint ? Math.min(GRAPH_WIDTH - PAD_RIGHT - pillWidth, Math.max(PAD_LEFT, hoverPoint.x - pillWidth / 2)) : 0;

  return (
    <div className="activity-graph">
      <div className="activity-graph-header">
        <span className="activity-graph-label">{label}</span>
        <span className="activity-graph-total">{total.toLocaleString()} / 48h</span>
      </div>
      <svg
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        preserveAspectRatio="none"
        className="activity-graph-svg"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={`fill-${instanceId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.85} />
            <stop offset="100%" stopColor={color} stopOpacity={0.05} />
          </linearGradient>
          <filter id={`glow-${instanceId}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Y-axis gridlines + labels - max and midpoint only, baseline implied at 0. */}
        {[1, 0.5].map((frac) => (
          <g key={frac}>
            <line
              x1={PAD_LEFT}
              x2={GRAPH_WIDTH - PAD_RIGHT}
              y1={PAD_TOP + innerHeight * (1 - frac)}
              y2={PAD_TOP + innerHeight * (1 - frac)}
              className="activity-graph-gridline"
            />
            <text x={PAD_LEFT - 6} y={PAD_TOP + innerHeight * (1 - frac)} className="activity-graph-axis-label" textAnchor="end" dominantBaseline="middle">
              {Math.round(max * frac).toLocaleString()}
            </text>
          </g>
        ))}
        <line x1={PAD_LEFT} x2={GRAPH_WIDTH - PAD_RIGHT} y1={baseline} y2={baseline} className="activity-graph-gridline" />
        <text x={PAD_LEFT - 6} y={baseline} className="activity-graph-axis-label" textAnchor="end" dominantBaseline="middle">
          0
        </text>

        {/* X-axis relative-hour ticks. */}
        {X_TICK_INDICES.map((idx, i) => (
          <text key={idx} x={toX(idx)} y={GRAPH_HEIGHT - 5} className="activity-graph-axis-label" textAnchor={i === 0 ? "start" : i === X_TICK_INDICES.length - 1 ? "end" : "middle"}>
            {X_TICK_LABELS[i]}
          </text>
        ))}

        {/* Skyline bars, one per hour bucket - the smooth glow line above
            traces the same values as a trend line riding along their tops. */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={p.x - barWidth / 2}
            y={p.y}
            width={barWidth}
            height={Math.max(0, baseline - p.y)}
            rx={barWidth * 0.3}
            fill={`url(#fill-${instanceId})`}
            opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
          />
        ))}
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" filter={`url(#glow-${instanceId})`} />

        {/* Permanent peak marker - visible even without hovering, the "here's the interesting bit" callout. */}
        {peakIdx != null && hoverIdx !== peakIdx && (
          <g className="activity-graph-peak">
            <circle cx={points[peakIdx].x} cy={points[peakIdx].y} r={7} style={{ fill: glowColor }} />
            <circle cx={points[peakIdx].x} cy={points[peakIdx].y} r={2.5} style={{ fill: color }} />
          </g>
        )}

        {hoverPoint && hoverIdx != null && (
          <>
            <line x1={hoverPoint.x} x2={hoverPoint.x} y1={PAD_TOP} y2={baseline} className="activity-graph-scanline" />
            <circle cx={hoverPoint.x} cy={hoverPoint.y} r={8} style={{ fill: glowColor }} />
            <circle cx={hoverPoint.x} cy={hoverPoint.y} r={3} style={{ fill: color }} />
            <g transform={`translate(${pillX}, ${Math.max(2, hoverPoint.y - 24)})`}>
              <rect className="activity-graph-pill" width={pillWidth} height={18} rx={4} />
              <text x={pillWidth / 2} y={9} className="activity-graph-pill-text" textAnchor="middle" dominantBaseline="middle">
                {values[hoverIdx].toLocaleString()}
              </text>
            </g>
          </>
        )}
      </svg>
      {hoverIdx != null ? (
        <div className="activity-graph-tooltip">
          {formatBucketTime(bucketStarts[hoverIdx])} — {values[hoverIdx].toLocaleString()} {label.toLowerCase()}
        </div>
      ) : (
        <div className="activity-graph-tooltip activity-graph-tooltip-muted">Hover the graph for exact values</div>
      )}
    </div>
  );
}

interface ActivityGraphsProps {
  systemId: number;
}

/** 48h activity graphs: Jumps/NPC Kills/Ship Kills/Pod Kills, each a
 * scannable sparkline. Kills have real retroactive depth (zKillboard pages
 * back through actual history), but jumps have no historical ESI endpoint
 * at all - that graph only has data from whenever this app's background
 * sampler started running, and is short (or empty) right after a fresh
 * install. */
function ActivityGraphs({ systemId }: ActivityGraphsProps) {
  const [killPoints, setKillPoints] = useState<KillHistoryPoint[] | null>(null);
  const [jumpPoints, setJumpPoints] = useState<JumpHistoryPoint[] | null>(null);
  const reportError = useErrorReporter();

  // Live, like the kill feed - re-polls in the background for as long as the
  // Stats popup stays open, rather than only ever fetching once on mount.
  // The initial fetch reports failures (the user is actively waiting on
  // it); background ticks fail silently, same convention Dashboard.tsx uses
  // for its own periodic refresh, so a transient zKillboard hiccup doesn't
  // pop an error toast while someone's just glancing at a graph.
  useEffect(() => {
    let cancelled = false;
    setKillPoints(null);
    setJumpPoints(null);

    function fetchKills(reportOnError: boolean) {
      getSystemKillHistory(systemId)
        .then((points) => {
          if (!cancelled) setKillPoints(points);
        })
        .catch((err) => {
          if (reportOnError) reportError(`Failed to load kill history: ${String(err)}`);
        });
    }
    function fetchJumps(reportOnError: boolean) {
      getSystemJumpHistory(systemId)
        .then((points) => {
          if (!cancelled) setJumpPoints(points);
        })
        .catch((err) => {
          if (reportOnError) reportError(`Failed to load jump history: ${String(err)}`);
        });
    }

    fetchKills(true);
    fetchJumps(true);
    const interval = setInterval(() => {
      fetchKills(false);
      fetchJumps(false);
    }, ACTIVITY_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [systemId]);

  // Recomputed on every render (not memoized) rather than pinned to
  // whenever the effect above last ran, so the bucket window - and which
  // bucket is "now" - stays correct for as long as the popup stays open.
  const buckets = buildHourBuckets();

  const bucketed = useMemo(() => {
    if (killPoints == null || jumpPoints == null) return null;
    const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

    const shipKills = new Array(buckets.length).fill(0);
    const npcKills = new Array(buckets.length).fill(0);
    const podKills = new Array(buckets.length).fill(0);
    for (const point of killPoints) {
      const t = Math.floor(new Date(point.time).getTime() / 1000);
      const idx = bucketIndex.get(Math.floor(t / 3600) * 3600);
      if (idx === undefined) continue;
      shipKills[idx] += 1;
      if (point.npc) npcKills[idx] += 1;
      if (point.ship_type_id === CAPSULE_TYPE_ID) podKills[idx] += 1;
    }

    // Jump samples are already rolling "last hour" counts taken every 15
    // minutes, so bucketing means keeping the latest sample per hour, not
    // summing (summing would quadruple-count each jump).
    const jumps = new Array(buckets.length).fill(0);
    const latestAt = new Array(buckets.length).fill(-1);
    for (const point of jumpPoints) {
      const idx = bucketIndex.get(Math.floor(point.sampled_at / 3600) * 3600);
      if (idx === undefined) continue;
      if (point.sampled_at > latestAt[idx]) {
        latestAt[idx] = point.sampled_at;
        jumps[idx] = point.ship_jumps;
      }
    }

    return { shipKills, npcKills, podKills, jumps, hasJumpData: jumpPoints.length > 0 };
  }, [killPoints, jumpPoints, buckets]);

  if (bucketed === null) {
    return <p className="detail-empty">Loading activity graphs...</p>;
  }

  return (
    <div className="activity-graphs">
      <Sparkline label="Jumps" values={bucketed.jumps} bucketStarts={buckets} color="var(--accent)" glowColor="rgba(111, 195, 217, 0.55)" />
      {!bucketed.hasJumpData && (
        <p className="activity-graph-note">
          No jump history yet - ESI has no historical jumps data, so this builds up from scratch the longer the app stays running.
        </p>
      )}
      <Sparkline label="NPC Kills" values={bucketed.npcKills} bucketStarts={buckets} color="var(--warning)" glowColor="rgba(224, 168, 92, 0.55)" />
      <Sparkline label="Ship Kills" values={bucketed.shipKills} bucketStarts={buckets} color="var(--danger)" glowColor="rgba(224, 104, 95, 0.55)" />
      <Sparkline label="Pod Kills" values={bucketed.podKills} bucketStarts={buckets} color="var(--isk)" glowColor="rgba(255, 184, 69, 0.55)" />
    </div>
  );
}

export default ActivityGraphs;
