import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { getMapData, type MapData, type MapSystem } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityBand, formatSecurity } from "../lib/format";

const SECURITY_COLORS: Record<"high" | "low" | "null", string> = {
  high: "#5fbf8a",
  low: "#e0a85c",
  null: "#e0685f",
};

const JUMP_COLOR = "rgba(230, 236, 245, 0.08)";
const MIN_ZOOM_RATIO = 0.5;
const MAX_ZOOM_RATIO = 400;
const LABEL_ZOOM_RATIO = 12;
const LABEL_MAX_VISIBLE = 200;

interface Transform {
  scale: number;
  translateX: number;
  translateY: number;
}

/** Regions have no 2D projection of their own in the source data - their center is just the centroid of their member systems' already-projected positions. */
function computeRegionCenters(systems: MapSystem[]): Map<number, { x: number; y: number }> {
  const sums = new Map<number, { sumX: number; sumY: number; count: number }>();
  for (const s of systems) {
    const entry = sums.get(s.region_id) ?? { sumX: 0, sumY: 0, count: 0 };
    entry.sumX += s.x;
    entry.sumY += s.y;
    entry.count += 1;
    sums.set(s.region_id, entry);
  }
  const centers = new Map<number, { x: number; y: number }>();
  for (const [regionId, { sumX, sumY, count }] of sums) {
    centers.set(regionId, { x: sumX / count, y: sumY / count });
  }
  return centers;
}

function MapView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MapData | null>(null);
  const regionCentersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const transformRef = useRef<Transform>({ scale: 1, translateX: 0, translateY: 0 });
  const fitScaleRef = useRef(1);
  const draggingRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const selectedIdRef = useRef<number | null>(null);

  const [mapData, setMapData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MapSystem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<MapSystem | null>(null);
  const reportError = useErrorReporter();

  const regionsById = mapData ? new Map(mapData.regions.map((r) => [r.id, r.name])) : new Map<number, string>();

  useEffect(() => {
    getMapData()
      .then((data) => {
        // EVE's 2D projection has the opposite vertical convention from
        // canvas (where y grows downward), so the map renders upside down
        // otherwise. Flipped once here so every transform downstream (fit,
        // draw, hit-testing, search navigation) stays correct unchanged.
        const flipped: MapData = { ...data, systems: data.systems.map((s) => ({ ...s, y: -s.y })) };
        dataRef.current = flipped;
        regionCentersRef.current = computeRegionCenters(flipped.systems);
        setMapData(flipped);
      })
      .catch((err) => reportError(`Failed to load map data: ${String(err)}`))
      .finally(() => setLoading(false));
  }, []);

  function fitToView() {
    const data = dataRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas || data.systems.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of data.systems) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }

    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    const padding = 40;
    const dataWidth = maxX - minX || 1;
    const dataHeight = maxY - minY || 1;
    const scale = Math.min((width - padding * 2) / dataWidth, (height - padding * 2) / dataHeight);

    fitScaleRef.current = scale;
    transformRef.current = {
      scale,
      translateX: padding - minX * scale + (width - padding * 2 - dataWidth * scale) / 2,
      translateY: padding - minY * scale + (height - padding * 2 - dataHeight * scale) / 2,
    };
    draw();
  }

  function draw() {
    const canvas = canvasRef.current;
    const data = dataRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { scale, translateX, translateY } = transformRef.current;
    const zoomRatio = scale / (fitScaleRef.current || scale);
    const toScreenX = (x: number) => x * scale + translateX;
    const toScreenY = (y: number) => y * scale + translateY;

    const systemById = new Map(data.systems.map((s) => [s.id, s]));

    const marginPx = 60;
    const dataMinX = (-translateX - marginPx) / scale;
    const dataMaxX = (width - translateX + marginPx) / scale;
    const dataMinY = (-translateY - marginPx) / scale;
    const dataMaxY = (height - translateY + marginPx) / scale;
    const inView = (x: number, y: number) => x >= dataMinX && x <= dataMaxX && y >= dataMinY && y <= dataMaxY;

    ctx.strokeStyle = JUMP_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const jump of data.jumps) {
      const a = systemById.get(jump.from);
      const b = systemById.get(jump.to);
      if (!a || !b) continue;
      if (!inView(a.x, a.y) && !inView(b.x, b.y)) continue;
      ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
      ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
    }
    ctx.stroke();

    const dotRadius = Math.min(6, Math.max(1.4, 1.4 * Math.sqrt(zoomRatio)));
    const visible: MapSystem[] = [];
    for (const system of data.systems) {
      if (!inView(system.x, system.y)) continue;
      visible.push(system);
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);
      const isSelected = system.id === selectedIdRef.current;
      ctx.fillStyle = SECURITY_COLORS[securityBand(system.security)];
      ctx.beginPath();
      ctx.arc(sx, sy, isSelected ? dotRadius * 2.2 : dotRadius, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    if (zoomRatio >= LABEL_ZOOM_RATIO && visible.length <= LABEL_MAX_VISIBLE) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const system of visible) {
        const labelX = toScreenX(system.x) + dotRadius + 4;
        const labelY = toScreenY(system.y);

        const secText = formatSecurity(system.security);
        ctx.font = "600 11px Inter, sans-serif";
        ctx.fillStyle = SECURITY_COLORS[securityBand(system.security)];
        ctx.fillText(secText, labelX, labelY);
        const secWidth = ctx.measureText(secText).width;

        ctx.font = "11px Inter, sans-serif";
        ctx.fillStyle = "rgba(230, 236, 245, 0.75)";
        ctx.fillText(system.name, labelX + secWidth + 4, labelY);
      }
    } else {
      // Zoomed out too far for individual system names to stay readable -
      // show each region's name at its centroid instead, so there's never
      // a gap where the map has no labels at all.
      ctx.font = "600 12px Inter, sans-serif";
      ctx.fillStyle = "rgba(230, 236, 245, 0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const region of data.regions) {
        const center = regionCentersRef.current.get(region.id);
        if (!center || !inView(center.x, center.y)) continue;
        ctx.fillText(region.name, toScreenX(center.x), toScreenY(center.y));
      }
      ctx.textAlign = "left";
    }
  }

  useEffect(() => {
    if (!mapData) return;
    fitToView();

    const canvas = canvasRef.current;
    if (!canvas) return;

    function pickSystem(clientX: number, clientY: number): MapSystem | null {
      const data = dataRef.current;
      if (!canvas || !data) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { scale, translateX, translateY } = transformRef.current;
      let closest: MapSystem | null = null;
      let closestDist = 12;
      for (const system of data.systems) {
        const sx = system.x * scale + translateX;
        const sy = system.y * scale + translateY;
        const dist = Math.hypot(sx - px, sy - py);
        if (dist < closestDist) {
          closestDist = dist;
          closest = system;
        }
      }
      return closest;
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { scale, translateX, translateY } = transformRef.current;
      const dataX = (mouseX - translateX) / scale;
      const dataY = (mouseY - translateY) / scale;
      const zoomFactor = Math.exp(-e.deltaY * 0.001);
      const minScale = fitScaleRef.current * MIN_ZOOM_RATIO;
      const maxScale = fitScaleRef.current * MAX_ZOOM_RATIO;
      const newScale = Math.min(maxScale, Math.max(minScale, scale * zoomFactor));
      transformRef.current = {
        scale: newScale,
        translateX: mouseX - dataX * newScale,
        translateY: mouseY - dataY * newScale,
      };
      draw();
    }

    function handleMouseDown(e: MouseEvent) {
      draggingRef.current = { x: e.clientX, y: e.clientY, moved: false };
    }

    function handleMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const dx = e.clientX - draggingRef.current.x;
      const dy = e.clientY - draggingRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) draggingRef.current.moved = true;
      draggingRef.current.x = e.clientX;
      draggingRef.current.y = e.clientY;
      transformRef.current = {
        ...transformRef.current,
        translateX: transformRef.current.translateX + dx,
        translateY: transformRef.current.translateY + dy,
      };
      draw();
    }

    function handleMouseUp(e: MouseEvent) {
      const wasDrag = draggingRef.current?.moved;
      draggingRef.current = null;
      if (!wasDrag) {
        const picked = pickSystem(e.clientX, e.clientY);
        selectedIdRef.current = picked?.id ?? null;
        setSelectedSystem(picked);
        draw();
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("resize", draw);

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("resize", draw);
    };
  }, [mapData]);

  function handleSearchChange(value: string) {
    setQuery(value);
    if (!mapData || value.trim().length < 2) {
      setResults([]);
      return;
    }
    const lower = value.toLowerCase();
    setResults(mapData.systems.filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 8));
  }

  function goToSystem(system: MapSystem) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const targetScale = fitScaleRef.current * 40;
    transformRef.current = {
      scale: targetScale,
      translateX: width / 2 - system.x * targetScale,
      translateY: height / 2 - system.y * targetScale,
    };
    selectedIdRef.current = system.id;
    setSelectedSystem(system);
    setQuery(system.name);
    setResults([]);
    draw();
  }

  return (
    <main className="main main-map">
      <div className="map-page">
        <div className="map-search-bar">
          <div className="map-search">
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search for a system..."
              value={query}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setResults([]);
                }}
                aria-label="Clear search"
              >
                <X size={13} strokeWidth={2} />
              </button>
            )}
            {results.length > 0 && (
              <div className="map-search-results">
                {results.map((system) => (
                  <button key={system.id} type="button" onClick={() => goToSystem(system)}>
                    <span
                      className={`kills-security kills-security-${securityBand(system.security)}`}
                    >
                      {formatSecurity(system.security)}
                    </span>
                    {system.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedSystem && (
            <div className="map-selected-info">
              <span className={`kills-security kills-security-${securityBand(selectedSystem.security)}`}>
                {formatSecurity(selectedSystem.security)}
              </span>
              <span className="map-selected-name">{selectedSystem.name}</span>
              <span className="map-selected-region">{regionsById.get(selectedSystem.region_id) ?? ""}</span>
            </div>
          )}
        </div>

        <div className="map-canvas-wrap">
          {loading ? (
            <p className="detail-empty">Loading universe map...</p>
          ) : (
            <canvas ref={canvasRef} className="map-canvas" />
          )}
        </div>
      </div>
    </main>
  );
}

export default MapView;
