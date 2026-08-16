import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { getMapData, type MapData, type MapSystem } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityBand, formatSecurity, formatUtcTime, formatIskCompact } from "../lib/format";
import { useRecentActivity } from "../hooks/useRecentActivity";
import type { KillEntry } from "../lib/kills";
import type { SystemSummary } from "./SystemKillboard";

const TICKER_LIMIT = 60;
const TOP_ACTIVITY_LIMIT = 5;

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

/** Kills older than this no longer count toward "recent activity" anywhere on the map (hover tooltip, top-active panel, heat ring). */
const HEAT_WINDOW_MS = 60 * 60 * 1000;
const HEAT_REFRESH_MS = 30_000;
/** Per-kill step and cap for a system's heat level - matches zKillboard's own live map exactly (+2 per kill in the window, capped at 12). */
const HEAT_STEP = 2;
const HEAT_CAP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Per-system heat level: a system that's been busy stays visibly hotter (bigger glow, bigger rings, bigger dot) even between individual kills, so it reads as "what to avoid" rather than just "what just happened". */
function computeSystemHeat(kills: KillEntry[], now: number): Map<number, number> {
  const heat = new Map<number, number>();
  for (const kill of kills) {
    const age = now - new Date(kill.time).getTime();
    if (age < 0 || age >= HEAT_WINDOW_MS) continue;
    heat.set(kill.system_id, Math.min((heat.get(kill.system_id) ?? 0) + HEAT_STEP, HEAT_CAP));
  }
  return heat;
}

/** A single sonar-style ping animation, spawned at a system the moment a new kill streams in there - matches zKillboard's live map. */
interface Ping {
  systemId: number;
  startedAt: number;
}

const PING_DURATION_MS = 1600;
const PING_MAX_RADIUS_PX = 34;

interface TopActivityEntry {
  name: string;
  count: number;
}

/** Ranks systems and regions by kill count within the last hour, for the "Top Active" overlay panel. */
function computeTopActivity(kills: KillEntry[], now: number): { systems: TopActivityEntry[]; regions: TopActivityEntry[] } {
  const systemCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  for (const kill of kills) {
    const age = now - new Date(kill.time).getTime();
    if (age < 0 || age >= HEAT_WINDOW_MS) continue;
    systemCounts.set(kill.system_name, (systemCounts.get(kill.system_name) ?? 0) + 1);
    if (kill.region_name) {
      regionCounts.set(kill.region_name, (regionCounts.get(kill.region_name) ?? 0) + 1);
    }
  }
  const topN = (counts: Map<string, number>): TopActivityEntry[] =>
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_ACTIVITY_LIMIT).map(([name, count]) => ({ name, count }));
  return { systems: topN(systemCounts), regions: topN(regionCounts) };
}

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

interface MapViewProps {
  /** Called with a killmail id when a ticker row is clicked, so the app can jump to its detail view in Kills & Intel. */
  onSelectKill: (killmailId: number) => void;
  /** Called with the selected system when its name is clicked, so the app can jump to its killboard in Kills & Intel. */
  onSelectSystem: (system: SystemSummary) => void;
}

interface HoverInfo {
  system: MapSystem;
  clientX: number;
  clientY: number;
}

function MapView({ onSelectKill, onSelectSystem }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MapData | null>(null);
  const regionCentersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const transformRef = useRef<Transform>({ scale: 1, translateX: 0, translateY: 0 });
  const fitScaleRef = useRef(1);
  const draggingRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const hoveredIdRef = useRef<number | null>(null);
  const pingsRef = useRef<Ping[]>([]);
  const heatMapRef = useRef<Map<number, number>>(new Map());
  const seenKillIdsRef = useRef<Set<number> | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const drawScheduledRef = useRef(false);

  const [mapData, setMapData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MapSystem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<MapSystem | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [topActivity, setTopActivity] = useState<{ systems: TopActivityEntry[]; regions: TopActivityEntry[] }>({
    systems: [],
    regions: [],
  });
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();

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
    requestDraw();
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
    const now = Date.now();

    // Persistent heat: a soft glow plus two concentric rings whose radius
    // and opacity grow with the system's heat level, so a system that's
    // been busy over the last hour still visibly stands out even between
    // pings - "what to avoid", not just "what just happened". Formulas
    // match zKillboard's own live map (heat 0-12, +2 per kill, capped).
    for (const [systemId, heatLevel] of heatMapRef.current) {
      if (heatLevel <= 0) continue;
      const system = systemById.get(systemId);
      if (!system || !inView(system.x, system.y)) continue;
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);

      const glowRadius = dotRadius * (5.2 + heatLevel * 0.22);
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
      glow.addColorStop(0, `rgba(255, 94, 94, ${clamp(0.36 + heatLevel * 0.04, 0.36, 0.8)})`);
      glow.addColorStop(0.45, `rgba(255, 168, 76, ${clamp(0.22 + heatLevel * 0.03, 0.22, 0.5)})`);
      glow.addColorStop(1, "rgba(255, 94, 94, 0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = `rgba(255, 108, 108, ${clamp(0.45 + heatLevel * 0.04, 0.45, 0.9)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(sx, sy, dotRadius * 2.8 + heatLevel * 0.7, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 196, 116, ${clamp(0.2 + heatLevel * 0.03, 0.2, 0.55)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, dotRadius * 4 + heatLevel * 0.95, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Sonar-style pings: one ring spawned per new kill, expanding and
    // fading out over PING_DURATION_MS - a "something just happened" flash
    // layered on top of the steadier heat rings above.
    for (const ping of pingsRef.current) {
      const system = systemById.get(ping.systemId);
      if (!system || !inView(system.x, system.y)) continue;
      const t = Math.min((now - ping.startedAt) / PING_DURATION_MS, 1);
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);
      const radius = dotRadius + t * PING_MAX_RADIUS_PX;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 120, 40, ${(1 - t) * 0.85})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const visible: MapSystem[] = [];
    for (const system of data.systems) {
      if (!inView(system.x, system.y)) continue;
      visible.push(system);
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);
      const isSelected = system.id === selectedIdRef.current;
      const isHovered = !isSelected && system.id === hoveredIdRef.current;
      const heatBump = Math.min((heatMapRef.current.get(system.id) ?? 0) * 0.28, 2.4);
      ctx.fillStyle = SECURITY_COLORS[securityBand(system.security)];
      ctx.beginPath();
      ctx.arc(sx, sy, (isSelected ? dotRadius * 2.2 : isHovered ? dotRadius * 1.7 : dotRadius) + heatBump, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (isHovered) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
        ctx.lineWidth = 1;
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

  /** Coalesces any number of draw() requests within the same frame into a single call, matching zKillboard's own requestDraw pattern. Without this, high-frequency events like mousemove over the map's dense system clusters can each trigger their own full (expensive) redraw, backing up the main thread badly enough that frames visibly drop content like the heat rings. */
  function requestDraw() {
    if (drawScheduledRef.current) return;
    drawScheduledRef.current = true;
    requestAnimationFrame(() => {
      drawScheduledRef.current = false;
      draw();
    });
  }

  function ensureAnimating() {
    if (animFrameRef.current !== null) return;
    function tick() {
      const now = Date.now();
      pingsRef.current = pingsRef.current.filter((p) => now - p.startedAt < PING_DURATION_MS);
      draw();
      animFrameRef.current = pingsRef.current.length > 0 ? requestAnimationFrame(tick) : null;
    }
    animFrameRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    if (seenKillIdsRef.current === null) {
      // First snapshot on load - just remember what's already there so the
      // whole existing history doesn't burst into pings all at once.
      seenKillIdsRef.current = new Set(kills.map((k) => k.killmail_id));
    } else {
      let spawned = false;
      for (const kill of kills) {
        if (!seenKillIdsRef.current.has(kill.killmail_id)) {
          seenKillIdsRef.current.add(kill.killmail_id);
          pingsRef.current.push({ systemId: kill.system_id, startedAt: now });
          spawned = true;
        }
      }
      if (spawned) ensureAnimating();
    }
    heatMapRef.current = computeSystemHeat(kills, now);
    setTopActivity(computeTopActivity(kills, now));
    requestDraw();
    // Also refreshed on a timer so the heat rings and top-active panel keep
    // decaying smoothly even when the feed goes quiet for a while.
    const interval = setInterval(() => {
      const refreshedNow = Date.now();
      heatMapRef.current = computeSystemHeat(kills, refreshedNow);
      setTopActivity(computeTopActivity(kills, refreshedNow));
      requestDraw();
    }, HEAT_REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kills]);

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

    /**
     * Click-only, more expensive version of pickSystem: also checks each
     * system's rendered LABEL text, not just its dot. In a dense hub (Jita's
     * neighborhood is the worst case), a neighboring system's dot can sit
     * physically closer to a click than the labeled system's own dot does,
     * even though the click landed squarely on that system's name - so a
     * pure nearest-dot search picks the wrong system. Only used on mouseup
     * (a single click), not on every mousemove, since it's O(systems) with
     * canvas text measurement and would reintroduce the redraw-storm bug
     * fixed earlier if run on hover.
     */
    function pickSystemForClick(clientX: number, clientY: number): MapSystem | null {
      const data = dataRef.current;
      if (!canvas || !data) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { scale, translateX, translateY } = transformRef.current;
      const zoomRatio = scale / (fitScaleRef.current || scale);

      if (zoomRatio >= LABEL_ZOOM_RATIO) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const dotRadius = Math.min(6, Math.max(1.4, 1.4 * Math.sqrt(zoomRatio)));
          for (const system of data.systems) {
            const sx = system.x * scale + translateX;
            const sy = system.y * scale + translateY;
            ctx.font = "600 11px Inter, sans-serif";
            const secWidth = ctx.measureText(formatSecurity(system.security)).width;
            ctx.font = "11px Inter, sans-serif";
            const nameWidth = ctx.measureText(system.name).width;
            const labelX = sx + dotRadius + 4;
            const labelY = sy;
            const labelWidth = secWidth + 4 + nameWidth;
            if (px >= labelX - 2 && px <= labelX + labelWidth + 2 && py >= labelY - 7 && py <= labelY + 7) {
              return system;
            }
          }
        }
      }

      return pickSystem(clientX, clientY);
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
      requestDraw();
    }

    function handleMouseDown(e: MouseEvent) {
      draggingRef.current = { x: e.clientX, y: e.clientY, moved: false };
    }

    function clearHover() {
      if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null;
        setHoverInfo(null);
        requestDraw();
      }
    }

    function handleMouseMove(e: MouseEvent) {
      if (draggingRef.current) {
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
        requestDraw();
        return;
      }

      const rect = canvas!.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        clearHover();
        return;
      }
      const picked = pickSystem(e.clientX, e.clientY);
      const pickedId = picked?.id ?? null;
      if (pickedId !== hoveredIdRef.current) {
        hoveredIdRef.current = pickedId;
        setHoverInfo(picked ? { system: picked, clientX: e.clientX, clientY: e.clientY } : null);
        requestDraw();
      } else if (picked) {
        setHoverInfo((prev) => (prev ? { ...prev, clientX: e.clientX, clientY: e.clientY } : prev));
      }
    }

    function handleMouseUp(e: MouseEvent) {
      const wasDrag = draggingRef.current?.moved;
      draggingRef.current = null;
      if (!wasDrag) {
        // handleMouseUp is registered on window (a drag can legitimately end
        // outside the canvas), but a plain click should only be treated as a
        // map pick if it actually landed on the canvas - otherwise clicking
        // UI elements like the selected-system name, search box, or ticker
        // wrongly clears/reselects a system out from under whatever else was
        // about to handle that same click (e.g. its own onClick).
        const rect = canvas!.getBoundingClientRect();
        const onCanvas = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (onCanvas) {
          const picked = pickSystemForClick(e.clientX, e.clientY);
          selectedIdRef.current = picked?.id ?? null;
          setSelectedSystem(picked);
          requestDraw();
        }
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mouseleave", clearHover);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("resize", requestDraw);

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mouseleave", clearHover);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("resize", requestDraw);
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
    requestDraw();
  }

  const hoveredKillCount = hoverInfo
    ? kills.filter((k) => k.system_id === hoverInfo.system.id && Date.now() - new Date(k.time).getTime() < HEAT_WINDOW_MS).length
    : 0;

  const tickerKills = [...kills].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, TICKER_LIMIT);

  return (
    <>
      <div className="map-page">
        <aside className="map-ticker">
          <div className="map-ticker-list">
            {tickerKills.length === 0 ? (
              <p className="map-ticker-empty">No recent activity.</p>
            ) : (
              tickerKills.map((kill) => (
                <button
                  key={kill.killmail_id}
                  type="button"
                  className="map-ticker-row"
                  onClick={() => onSelectKill(kill.killmail_id)}
                >
                  <span className="map-ticker-time">{formatUtcTime(kill.time)}</span>
                  <div className="map-ticker-row-body">
                    <img src={`https://images.evetech.net/types/${kill.ship_type_id}/icon?size=64`} alt="" />
                    <div className="map-ticker-row-text">
                      <span className="map-ticker-title">{kill.ship_type_name}</span>
                      <span className="map-ticker-subtitle">
                        {kill.system_name} | {formatIskCompact(kill.total_value)} | {kill.attacker_count}{" "}
                        attacker{kill.attacker_count === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="map-main">
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
                <span
                  className="map-selected-name kills-system-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    onSelectSystem({
                      id: selectedSystem.id,
                      name: selectedSystem.name,
                      security: selectedSystem.security,
                      regionName: regionsById.get(selectedSystem.region_id) ?? null,
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectSystem({
                        id: selectedSystem.id,
                        name: selectedSystem.name,
                        security: selectedSystem.security,
                        regionName: regionsById.get(selectedSystem.region_id) ?? null,
                      });
                    }
                  }}
                >
                  {selectedSystem.name}
                </span>
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

            {(topActivity.systems.length > 0 || topActivity.regions.length > 0) && (
              <div className="map-top-activity">
                <div className="map-top-activity-col">
                  <p>Top Active Systems</p>
                  {topActivity.systems.map((entry) => (
                    <div key={entry.name} className="map-top-activity-row">
                      <span>{entry.name}</span>
                      <span>{entry.count}</span>
                    </div>
                  ))}
                </div>
                <div className="map-top-activity-col">
                  <p>Top Active Regions</p>
                  {topActivity.regions.map((entry) => (
                    <div key={entry.name} className="map-top-activity-row">
                      <span>{entry.name}</span>
                      <span>{entry.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {hoverInfo && (
        <div className="map-hover-tooltip" style={{ left: hoverInfo.clientX + 16, top: hoverInfo.clientY + 16 }}>
          <div className="map-hover-tooltip-title">
            <span className={`kills-security kills-security-${securityBand(hoverInfo.system.security)}`}>
              {formatSecurity(hoverInfo.system.security)}
            </span>
            <span className="map-hover-name">{hoverInfo.system.name}</span>
          </div>
          <span className="map-hover-kills">
            {hoveredKillCount > 0
              ? `${hoveredKillCount} kill${hoveredKillCount === 1 ? "" : "s"} in the last hour`
              : "No recent activity"}
          </span>
        </div>
      )}
    </>
  );
}

export default MapView;
