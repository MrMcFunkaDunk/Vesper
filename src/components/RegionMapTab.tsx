import { useEffect, useMemo, useState } from "react";
import { getMapData, getSovereigntyMap, type MapData, type SovEntry } from "../lib/map";
import { resolveEntityNames } from "../lib/wars";
import { useErrorReporter } from "../hooks/useErrorReporter";

const WIDTH = 900;
const HEIGHT = 640;
const PADDING = 36;
const UNCLAIMED_COLOR = "#5a5f6b";
const PALETTE = ["#c95d5d", "#5b9bd5", "#5fbf8a", "#e07a3f", "#9b7fd4", "#d4b04a", "#4fb3bf", "#d4749b"];

interface RegionNode {
  id: number;
  name: string;
  x: number;
  y: number;
  systemCount: number;
  ownerId: number | null;
}

interface RegionEdge {
  a: number;
  b: number;
}

/** Same "average of its own systems' real universe coordinates" approach
 * MapView.tsx already uses for constellation centers, one level up - a
 * region's node position here is genuine EVE geography, not a synthetic
 * force-directed layout, so this map's shape actually matches New Eden. */
function computeRegionNodes(mapData: MapData, sov: SovEntry[]): { nodes: RegionNode[]; edges: RegionEdge[] } {
  const sums = new Map<number, { sumX: number; sumY: number; count: number }>();
  for (const s of mapData.systems) {
    const entry = sums.get(s.region_id) ?? { sumX: 0, sumY: 0, count: 0 };
    entry.sumX += s.x;
    entry.sumY += s.y;
    entry.count += 1;
    sums.set(s.region_id, entry);
  }

  const sovBySystem = new Map(sov.map((e) => [e.system_id, e]));
  const ownerCounts = new Map<number, Map<number, number>>();
  for (const s of mapData.systems) {
    const allianceId = sovBySystem.get(s.id)?.alliance_id;
    if (allianceId == null) continue;
    const byAlliance = ownerCounts.get(s.region_id) ?? new Map<number, number>();
    byAlliance.set(allianceId, (byAlliance.get(allianceId) ?? 0) + 1);
    ownerCounts.set(s.region_id, byAlliance);
  }
  const dominantOwner = new Map<number, number>();
  for (const [regionId, byAlliance] of ownerCounts) {
    let best: number | null = null;
    let bestCount = 0;
    for (const [allianceId, count] of byAlliance) {
      if (count > bestCount) {
        best = allianceId;
        bestCount = count;
      }
    }
    if (best != null) dominantOwner.set(regionId, best);
  }

  const nodes: RegionNode[] = mapData.regions
    .map((region) => {
      const sum = sums.get(region.id);
      if (!sum || sum.count === 0) return null;
      return {
        id: region.id,
        name: region.name,
        x: sum.sumX / sum.count,
        y: sum.sumY / sum.count,
        systemCount: sum.count,
        ownerId: dominantOwner.get(region.id) ?? null,
      };
    })
    .filter((n): n is RegionNode => n !== null);

  const regionBySystem = new Map(mapData.systems.map((s) => [s.id, s.region_id]));
  const edgeKeys = new Set<string>();
  const edges: RegionEdge[] = [];
  for (const jump of mapData.jumps) {
    const a = regionBySystem.get(jump.from);
    const b = regionBySystem.get(jump.to);
    if (a == null || b == null || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ a, b });
  }

  return { nodes, edges };
}

/** Assigns each alliance a stable, distinguishable color - the top
 * handful (by how many regions they dominate) get their own palette
 * color, matching the pie-chart-with-legend convention elsewhere in this
 * app; everyone past that shares the map's own muted "unclaimed" grey
 * rather than the legend growing to dozens of near-identical entries. */
function buildOwnerColors(nodes: RegionNode[]): { colorByOwner: Map<number, string>; topOwners: { id: number; count: number }[] } {
  const regionCountByOwner = new Map<number, number>();
  for (const node of nodes) {
    if (node.ownerId == null) continue;
    regionCountByOwner.set(node.ownerId, (regionCountByOwner.get(node.ownerId) ?? 0) + 1);
  }
  const topOwners = [...regionCountByOwner.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, PALETTE.length);
  const colorByOwner = new Map(topOwners.map((o, i) => [o.id, PALETTE[i]]));
  return { colorByOwner, topOwners };
}

/** A region-level overview of New Eden, laid out from real system
 * coordinates and colored by which alliance holds the most systems in each
 * region - a higher-altitude, "who controls what" companion to the
 * tactical system map, not a replacement for it. */
function RegionMapTab() {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [sov, setSov] = useState<SovEntry[]>([]);
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    getMapData()
      .then(setMapData)
      .catch((err) => reportError(`Failed to load the universe map: ${String(err)}`));
    // Sovereignty is a nice-to-have overlay, not core to the map rendering
    // at all - a failed fetch just leaves every region "Unclaimed/NPC"
    // rather than blocking the map itself.
    getSovereigntyMap()
      .then(setSov)
      .catch(() => setSov([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const computed = useMemo(() => (mapData ? computeRegionNodes(mapData, sov) : null), [mapData, sov]);
  const owners = useMemo(() => (computed ? buildOwnerColors(computed.nodes) : null), [computed]);

  useEffect(() => {
    if (!owners || owners.topOwners.length === 0) return;
    resolveEntityNames(owners.topOwners.map((o) => o.id))
      .then(setOwnerNames)
      .catch(() => {});
  }, [owners]);

  if (!mapData || !computed || !owners) {
    return <p className="detail-empty">Loading region map...</p>;
  }

  const xs = computed.nodes.map((n) => n.x);
  const ys = computed.nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const innerWidth = WIDTH - PADDING * 2;
  const innerHeight = HEIGHT - PADDING * 2;
  // Flip Y to match MapView's own "north up" convention (universe Y grows
  // downward relative to how the in-game map and every derived view here
  // already orient themselves).
  const toX = (x: number) => PADDING + ((x - minX) / rangeX) * innerWidth;
  const toY = (y: number) => PADDING + innerHeight - ((y - minY) / rangeY) * innerHeight;

  const maxSystemCount = Math.max(...computed.nodes.map((n) => n.systemCount));
  const radiusFor = (count: number) => 3 + Math.sqrt(count / maxSystemCount) * 7;

  const positioned = new Map(computed.nodes.map((n) => [n.id, { ...n, px: toX(n.x), py: toY(n.y) }]));
  const hovered = hoveredId != null ? positioned.get(hoveredId) : null;

  return (
    <div className="region-map-tab">
      <div className="region-map-shell">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="region-map-svg">
          <g className="region-map-edges">
            {computed.edges.map((edge, i) => {
              const a = positioned.get(edge.a);
              const b = positioned.get(edge.b);
              if (!a || !b) return null;
              return <line key={i} x1={a.px} y1={a.py} x2={b.px} y2={b.py} />;
            })}
          </g>
          <g>
            {[...positioned.values()].map((node) => {
              const color = node.ownerId != null ? owners.colorByOwner.get(node.ownerId) ?? UNCLAIMED_COLOR : UNCLAIMED_COLOR;
              return (
                <g
                  key={node.id}
                  className="region-map-node"
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                >
                  <circle cx={node.px} cy={node.py} r={radiusFor(node.systemCount)} fill={color} opacity={hoveredId == null || hoveredId === node.id ? 1 : 0.55} />
                  {hoveredId === node.id && (
                    <text x={node.px} y={node.py - radiusFor(node.systemCount) - 6} textAnchor="middle" className="region-map-node-label">
                      {node.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        <aside className="region-map-legend">
          <p className="kills-feed-section-title">Sovereignty</p>
          <ul className="pie-chart-legend">
            {owners.topOwners.map((owner) => (
              <li key={owner.id}>
                <span className="pie-chart-legend-dot" style={{ background: owners.colorByOwner.get(owner.id) }} />
                <span className="pie-chart-legend-label">{ownerNames[String(owner.id)] ?? `Alliance ${owner.id}`}</span>
                <span className="pie-chart-legend-value">{owner.count} region{owner.count === 1 ? "" : "s"}</span>
              </li>
            ))}
            <li>
              <span className="pie-chart-legend-dot" style={{ background: UNCLAIMED_COLOR }} />
              <span className="pie-chart-legend-label">Unclaimed / NPC / Other</span>
            </li>
          </ul>
          <p className="region-map-legend-note">
            {hovered
              ? `${hovered.name} - ${hovered.systemCount} system${hovered.systemCount === 1 ? "" : "s"}${
                  hovered.ownerId != null ? `, held by ${ownerNames[String(hovered.ownerId)] ?? "an alliance"}` : ""
                }`
              : "Hover a region for details. Node size tracks system count; color tracks which alliance holds the most systems there."}
          </p>
        </aside>
      </div>
    </div>
  );
}

export default RegionMapTab;
