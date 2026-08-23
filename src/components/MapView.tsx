import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Crosshair, MapPin, BarChart3 } from "lucide-react";
import SystemStatsPanel from "./SystemStatsPanel";
import { getMapData, getCharacterHomeSystems, getPlayerStructures, type MapData, type MapSystem, type PlayerStructureInfo } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityColor, formatSecurity, formatUtcTime, formatIskCompact, formatExactTime } from "../lib/format";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { useLocationTracking } from "../hooks/useLocationTracking";
import { useMapDisplayPrefs } from "../hooks/useMapDisplayPrefs";
import { RADIUS_OPTIONS } from "./TopBar";
import type { KillEntry } from "../lib/kills";
import type { SystemSummary } from "./SystemKillboard";
import { getCharacterLocation, type SessionCharacter } from "../lib/eve";

const TICKER_LIMIT = 60;
/** The nearby feed is a short-lived spotlight, not a growing log - capped
 * at 5 so a burst of simultaneous nearby kills (multiple ships losing
 * fights at once) is still visible together, not just the single latest
 * one, while PROXIMITY_EXPIRY_MS below keeps it from just accumulating
 * forever. */
const PROXIMITY_TICKER_LIMIT = 5;
/** How long a kill stays pinned in the nearby feed after it arrives, absent
 * any newer nearby kill bumping it out of the top 5 first. Once it ages
 * past this with nothing fresher taking its place, it drops out of the
 * spotlight and falls back into the general feed below (still red-flagged
 * there) - so the nearby box is always "current", not a growing list. */
const PROXIMITY_EXPIRY_MS = 45_000;
/** How often the nearby feed re-checks for expired entries - doesn't need
 * to be fast, just frequent enough that an aged-out kill disappears within
 * a few seconds of crossing PROXIMITY_EXPIRY_MS rather than waiting for
 * the next unrelated re-render. */
const PROXIMITY_EXPIRY_CHECK_MS = 3_000;
const TOP_ACTIVITY_LIMIT = 5;

/** Captured once when this module first loads (i.e. app startup), not per Map-page visit - the ticker below is deliberately blank until a kill with a timestamp after this point streams in, rather than showing whatever backlog/snapshot was already sitting in the shared recent-activity feed from earlier in the day. */
const APP_LOADED_AT = Date.now();

const JUMP_COLOR = "rgba(230, 236, 245, 0.08)";
const MIN_ZOOM_RATIO = 0.5;
const MAX_ZOOM_RATIO = 400;
const LABEL_ZOOM_RATIO = 12;
const LABEL_MAX_VISIBLE = 200;

interface ServiceIcon {
  abbr: string;
  color: string;
}

/** DOTLAN-style map key, restricted to the handful of NPC station services
 * actually worth showing at a glance (skips ones like Gambling/Paintshop
 * that don't exist in modern EVE). Keyed by the exact staServices.csv name. */
const SERVICE_ICONS: Record<string, ServiceIcon> = {
  Refinery: { abbr: "Rf", color: "#e0a85c" },
  "Reprocessing Plant": { abbr: "Rp", color: "#c98f4a" },
  Factory: { abbr: "F", color: "#e0685f" },
  Laboratory: { abbr: "R", color: "#9a7fd1" },
  "Office Rental": { abbr: "O", color: "#d9c15f" },
  Cloning: { abbr: "C", color: "#6fc3d9" },
};
/** Synthetic entry for a player-owned industry structure (Refinery/
 * Engineering Complex class) - not an NPC station service, so it isn't in
 * SERVICE_ICONS, but belongs in the same on-map key. */
const INDUSTRY_ICON: ServiceIcon = { abbr: "I", color: "#d9628f" };
/** Any public player-owned structure (citadels, engineering complexes,
 * Ansiblex gates, etc. - the broader ESI public-structures list, not just
 * the industry-capable subset INDUSTRY_ICON covers). Same row, same
 * region-level-or-closer zoom gate as every other icon here - it used to be
 * its own always-visible diamond marker, which cluttered the map at every
 * zoom level instead of only showing where DOTLAN does. */
const PLAYER_STRUCTURE_ICON: ServiceIcon = { abbr: "S", color: "#7f9bd9" };
const ICON_TEXT_COLOR = "#0a0a0c";

const LEGEND_ITEMS: (ServiceIcon & { name: string })[] = [
  ...Object.entries(SERVICE_ICONS).map(([name, icon]) => ({ name, ...icon })),
  { name: "Industry Structure", ...INDUSTRY_ICON },
  { name: "Player Structure", ...PLAYER_STRUCTURE_ICON },
];

/** Picks readable swatch text against a given background - the security
 * gradient spans from very dark (1.0 blue, 0.0 near-black red) to very
 * bright (0.5 yellow), so a single fixed text color would be unreadable
 * at one end or the other. */
function legendTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 140 ? "#0a0a0c" : "#f4f4f6";
}

const SECURITY_LEGEND = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((tenth) => {
  const color = securityColor(tenth / 10);
  return { tenth, label: (tenth / 10).toFixed(1), color, textColor: legendTextColor(color) };
});

/** A classic map-pin silhouette (round head + tapered tail) with its tip
 * exactly on (tipX, tipY) - reads as an actual pin rather than just a ring
 * around the dot, for marking a single specific system (the one currently
 * selected on the map). */
function drawPin(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, headRadius: number, color: string) {
  const headCenterY = tipY - headRadius * 2.1;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - headRadius * 0.55, headCenterY + headRadius * 0.35);
  ctx.lineTo(tipX + headRadius * 0.55, headCenterY + headRadius * 0.35);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(tipX, headCenterY, headRadius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(10, 10, 12, 0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(tipX, headCenterY, headRadius * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(10, 10, 12, 0.55)";
  ctx.fill();
}

/** A character's portrait clipped to a circle, for the map's home-base pins
 * - falls back to a plain ring while the image is still loading (or if it
 * never loads) so the marker's position is still visible either way. */
function drawPortrait(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, image: HTMLImageElement | null) {
  if (image && image.complete && image.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(230, 236, 245, 0.2)";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "#e6ecf5";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** "Ellebitte Viliana" -> "EV" - falls back to the first two letters of a
 * one-word name. Used on the home-base house marker instead of a portrait,
 * since a home marker's whole point is "which system", not "which face". */
function characterInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A little house pin marking a character's home-base system, with their
 * initials in the body instead of a portrait - a home marker only needs to
 * say "whose home is this", not "what do they look like" (drawPortrait's
 * job now belongs to the live current-location pins instead). Styled as a
 * dark HUD panel with the app's own cyan accent outline, matching every
 * other selection/highlight ring on the map, instead of a literal
 * skeuomorphic gold cottage that would look imported from another app. */
function drawHomeMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, initials: string) {
  const bodyWidth = radius * 1.7;
  const bodyHeight = radius * 1.3;
  const bodyTop = cy - radius * 0.15;
  const accent = "#6fc3d9";

  ctx.beginPath();
  ctx.moveTo(cx - bodyWidth / 2 - radius * 0.15, bodyTop);
  ctx.lineTo(cx, bodyTop - radius * 0.9);
  ctx.lineTo(cx + bodyWidth / 2 + radius * 0.15, bodyTop);
  ctx.closePath();
  ctx.fillStyle = "#1a1c21";
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.rect(cx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  ctx.fillStyle = "#131418";
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.font = `700 ${Math.max(8, radius * 0.9)}px Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, cx, bodyTop + bodyHeight / 2 + radius * 0.05);
}

/** Precomputes each system's map-key icon row once per map data load,
 * rather than filtering/looking up service names on every canvas frame. */
function computeSystemIcons(data: MapData): Map<number, ServiceIcon[]> {
  const icons = new Map<number, ServiceIcon[]>();
  for (const entry of data.system_services) {
    const matched = entry.services.map((name) => SERVICE_ICONS[name]).filter((icon): icon is ServiceIcon => Boolean(icon));
    if (matched.length > 0) icons.set(entry.system_id, matched);
  }
  for (const systemId of data.industry_system_ids) {
    const existing = icons.get(systemId) ?? [];
    icons.set(systemId, [...existing, INDUSTRY_ICON]);
  }
  return icons;
}

/** Kills older than this no longer count toward "recent activity" anywhere on the map (hover tooltip, top-active panel, heat ring). */
const HEAT_WINDOW_MS = 60 * 60 * 1000;
const HEAT_REFRESH_MS = 30_000;
/** Exponential-saturation divisor for turning a raw kill count into a 0-1
 * brightness intensity - never hard-caps (100+ kills is still technically
 * brighter than 100 kills), but the practical "solid yellow-hot" range
 * lands around 100+ kills, matching the classic in-game kill heatmap this
 * is modeled on. 1-e^(-count/40): ~3% at 1 kill, ~46% at 25, ~92% at 100. */
const HEAT_INTENSITY_DIVISOR = 40;

function heatIntensity(killCount: number): number {
  return 1 - Math.exp(-killCount / HEAT_INTENSITY_DIVISOR);
}

/** Dim red -> vivid red as intensity climbs - stays red throughout rather
 * than shifting through orange/yellow at high kill counts, so "more kills"
 * always reads as "more red", never as a different color. Stops are
 * [intensity, r, g, b]. */
const HEAT_COLOR_STOPS: [number, number, number, number][] = [
  [0, 110, 18, 18],
  [0.4, 200, 30, 26],
  [1, 255, 40, 34],
];

function heatColor(intensity: number): [number, number, number] {
  let lo = HEAT_COLOR_STOPS[0];
  let hi = HEAT_COLOR_STOPS[HEAT_COLOR_STOPS.length - 1];
  for (let i = 0; i < HEAT_COLOR_STOPS.length - 1; i++) {
    if (intensity >= HEAT_COLOR_STOPS[i][0] && intensity <= HEAT_COLOR_STOPS[i + 1][0]) {
      lo = HEAT_COLOR_STOPS[i];
      hi = HEAT_COLOR_STOPS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const t = clamp((intensity - lo[0]) / span, 0, 1);
  return [Math.round(lo[1] + (hi[1] - lo[1]) * t), Math.round(lo[2] + (hi[2] - lo[2]) * t), Math.round(lo[3] + (hi[3] - lo[3]) * t)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** System label size/spacing at a given zoom level - grows from 11px at the
 * label-visibility threshold up to a 20px cap the further in you go, rather
 * than staying pinned at the same tiny size no matter how close you zoom.
 * Shared by draw() and the label click-hit-test so clicking a label's text
 * always matches what's actually rendered there. */
function labelMetricsForZoom(zoomRatio: number): { fontSize: number; gap: number } {
  const progress = clamp((zoomRatio - LABEL_ZOOM_RATIO) / (LABEL_ZOOM_RATIO * 4), 0, 1);
  return { fontSize: 11 + progress * 9, gap: 4 + progress * 3 };
}

/** Home-base portrait size at a given zoom level - stays small (8px) zoomed
 * way out so a busy region isn't wall-to-wall faces, but grows sharply once
 * you're actually zoomed in on a system, reaching a big, unmistakable size
 * well before max zoom (by ~4x past the label threshold) so identifying a
 * character doesn't require zooming all the way in. */
function portraitRadiusForZoom(zoomRatio: number): number {
  const progress = clamp((zoomRatio - LABEL_ZOOM_RATIO) / (LABEL_ZOOM_RATIO * 3), 0, 1);
  return 8 + progress * 22;
}

interface SystemHeat {
  /** Raw kill count within the rolling last hour - no cap. Each kill ages
   * out exactly 60 minutes after its own timestamp (a true rolling window,
   * not a top-of-the-hour bucket reset), so a system's count only ever
   * drops one kill at a time as each individual kill's own hour elapses. */
  count: number;
  /** Timestamp of the system's single most recent kill - drives whether it's
   * actively pulsing (see PULSE_RECENCY_MS) independently of the count. */
  mostRecentAt: number;
}

/** Per-system heat: a system that's been busy stays visibly hotter (bigger
 * glow, bigger rings, bigger dot, brighter color) even between individual
 * kills, so it reads as "what to avoid" rather than just "what just
 * happened" - but only actively *pulses* while something's happening right
 * now (see PULSE_RECENCY_MS), so a still-hot-but-quiet-for-a-while system
 * doesn't look identical to one where kills are landing this second. */
function computeSystemHeat(kills: KillEntry[], now: number): Map<number, SystemHeat> {
  const heat = new Map<number, SystemHeat>();
  for (const kill of kills) {
    const killTime = new Date(kill.time).getTime();
    const age = now - killTime;
    if (age < 0 || age >= HEAT_WINDOW_MS) continue;
    const existing = heat.get(kill.system_id);
    heat.set(kill.system_id, { count: (existing?.count ?? 0) + 1, mostRecentAt: Math.max(existing?.mostRecentAt ?? 0, killTime) });
  }
  return heat;
}

/** How recently a system's last kill has to have landed for its heat to
 * actively pulse - older than this, it still glows at the same brightness
 * (the rolling-hour count hasn't changed) but holds steady instead of
 * breathing, since nothing is actually happening there right now. */
const PULSE_RECENCY_MS = 2 * 60 * 1000;

function hasRecentHeat(heat: Map<number, SystemHeat>, now: number): boolean {
  for (const entry of heat.values()) {
    if (now - entry.mostRecentAt < PULSE_RECENCY_MS) return true;
  }
  return false;
}

/** Shared breathing wave for anything tied to a system's active-kill pulse
 * (the heat glow/rings and the system dot itself) - phase-offset per
 * system (via systemId) so a cluster of active systems doesn't throb in
 * lockstep, and using the same now/systemId inputs in both places keeps
 * them visibly in sync with each other. Returns a value from `floor` up
 * to 1. */
function pulseWave(now: number, systemId: number, floor: number): number {
  const phase = (systemId % 1000) * 0.31;
  const wave = 0.5 + 0.5 * Math.sin(now / 300 + phase);
  return floor + (1 - floor) * wave;
}


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
/** Andrew's monotone chain convex hull - standard O(n log n) algorithm, not
 * a hand-rolled approximation, since this draws a real geographic boundary
 * (which systems belong to this constellation) rather than a decorative
 * shape. Returns the hull points in order; degenerates to the input for
 * fewer than 3 points (the caller skips drawing those). */
function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** One convex-hull boundary per constellation with 3+ systems - computed
 * once per map data load (system positions never change mid-session), not
 * per frame. Constellations with fewer than 3 systems get no boundary;
 * a hull needs at least a triangle to mean anything, and a 1-2 system
 * constellation reads fine from its systems alone. */
function computeConstellationHulls(systems: MapSystem[]): Map<number, { x: number; y: number }[]> {
  const bySystem = new Map<number, { x: number; y: number }[]>();
  for (const s of systems) {
    const list = bySystem.get(s.constellation_id);
    if (list) list.push({ x: s.x, y: s.y });
    else bySystem.set(s.constellation_id, [{ x: s.x, y: s.y }]);
  }
  const hulls = new Map<number, { x: number; y: number }[]>();
  for (const [constellationId, points] of bySystem) {
    if (points.length < 3) continue;
    hulls.set(constellationId, convexHull(points));
  }
  return hulls;
}

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
  /** Logged-in characters, used to place home-base portrait pins. */
  characters: SessionCharacter[];
}

interface HoverInfo {
  system: MapSystem;
  clientX: number;
  clientY: number;
}

interface CharacterPin {
  character: SessionCharacter;
  image: HTMLImageElement | null;
}

function MapView({ onSelectKill, onSelectSystem, characters }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MapData | null>(null);
  const regionCentersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const constellationHullsRef = useRef<Map<number, { x: number; y: number }[]>>(new Map());
  const systemIconsRef = useRef<Map<number, ServiceIcon[]>>(new Map());
  const transformRef = useRef<Transform>({ scale: 1, translateX: 0, translateY: 0 });
  const fitScaleRef = useRef(1);
  const draggingRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /** Once the user manually zooms or drags, auto-refit (below) stops
   * overriding their view on subsequent resizes - only takes over before
   * that, to correct for the canvas not yet being at its final laid-out
   * size the moment the map first loads. */
  const hasInteractedRef = useRef(false);
  const selectedIdRef = useRef<number | null>(null);
  const hoveredIdRef = useRef<number | null>(null);
  const tickerHoveredIdRef = useRef<number | null>(null);
  const currentSystemIdRef = useRef<number | null>(null);
  const showServiceIconsRef = useRef(true);
  const homePinsBySystemRef = useRef<Map<number, CharacterPin[]>>(new Map());
  const locationPinsBySystemRef = useRef<Map<number, CharacterPin[]>>(new Map());
  const structuresBySystemRef = useRef<Map<number, PlayerStructureInfo[]>>(new Map());
  const heatMapRef = useRef<Map<number, SystemHeat>>(new Map());
  const animFrameRef = useRef<number | null>(null);
  const drawScheduledRef = useRef(false);

  const [mapData, setMapData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MapSystem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<MapSystem | null>(null);
  const [statsSystemId, setStatsSystemId] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  /** Clicking a system pins its tooltip open at that screen position, so
   * the mini-killboard inside it can actually be clicked without the
   * tooltip disappearing the instant the mouse leaves the dot - normal
   * hover still works (and takes over the tooltip) whenever nothing is
   * pinned. Cleared by clicking the same system again or clicking
   * elsewhere on the map. */
  const [pinnedHover, setPinnedHover] = useState<HoverInfo | null>(null);
  const [topActivity, setTopActivity] = useState<{ systems: TopActivityEntry[]; regions: TopActivityEntry[] }>({
    systems: [],
    regions: [],
  });
  const [homeSystemCount, setHomeSystemCount] = useState(0);
  const { legendOpen, setLegendOpen, showServiceIcons, setShowServiceIcons } = useMapDisplayPrefs();
  // Ticks forward periodically purely to force the nearby-feed expiry check
  // below to re-run even when no new kill has arrived - otherwise a kill
  // sitting past PROXIMITY_EXPIRY_MS would only actually drop out of the
  // list the next time some unrelated re-render happened to fire.
  const [proximityClock, setProximityClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setProximityClock(Date.now()), PROXIMITY_EXPIRY_CHECK_MS);
    return () => clearInterval(interval);
  }, []);
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();
  const { alertKillIds, currentSystem, setCurrentSystem, radius, setRadius } = useLocationTracking();

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
        constellationHullsRef.current = computeConstellationHulls(flipped.systems);
        systemIconsRef.current = computeSystemIcons(flipped);
        setMapData(flipped);
      })
      .catch((err) => reportError(`Failed to load map data: ${String(err)}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (characters.length === 0) return;
    let cancelled = false;
    getCharacterHomeSystems(characters.map((c) => c.id))
      .then((results) => {
        if (cancelled) return;
        const bySystem = new Map<number, CharacterPin[]>();
        for (const result of results) {
          if (result.system_id == null) continue;
          const character = characters.find((c) => c.id === result.character_id);
          if (!character) continue;
          const list = bySystem.get(result.system_id) ?? [];
          list.push({ character, image: null });
          bySystem.set(result.system_id, list);
        }
        homePinsBySystemRef.current = bySystem;
        setHomeSystemCount(bySystem.size);
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load character home systems: ${String(err)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters.map((c) => c.id).join(",")]);

  // Live current-location pins (portraits) - separate from the home-base
  // markers above (house icons), and polled continuously since a character
  // actually moves around while playing, unlike their home system. Only
  // system-level granularity is needed (which station/structure within a
  // system isn't shown), matching what getCharacterLocation already returns.
  useEffect(() => {
    if (characters.length === 0) return;
    let cancelled = false;

    async function poll() {
      const bySystem = new Map<number, CharacterPin[]>();
      await Promise.all(
        characters.map(async (character) => {
          try {
            const loc = await getCharacterLocation(character.id);
            if (loc.needs_reauth || loc.solar_system_id == null) return;
            const list = bySystem.get(loc.solar_system_id) ?? [];
            list.push({ character, image: null });
            bySystem.set(loc.solar_system_id, list);
          } catch {
            // Best-effort - one character's failed location fetch shouldn't blank the rest.
          }
        }),
      );
      if (cancelled) return;
      // Portraits carry over from the previous pass by URL rather than
      // reloading every poll - only a character whose system actually
      // changed (or is new) needs a fresh Image.
      const previous = locationPinsBySystemRef.current;
      for (const [systemId, pins] of bySystem) {
        const previousPins = previous.get(systemId);
        for (const pin of pins) {
          const existing = previousPins?.find((p) => p.character.id === pin.character.id);
          if (existing?.image) {
            pin.image = existing.image;
            continue;
          }
          const img = new Image();
          img.onload = () => requestDraw();
          img.src = pin.character.portrait_url;
          pin.image = img;
        }
      }
      locationPinsBySystemRef.current = bySystem;
      requestDraw();
    }

    poll();
    const interval = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters.map((c) => c.id).join(",")]);

  useEffect(() => {
    let cancelled = false;
    getPlayerStructures()
      .then((structures) => {
        if (cancelled) return;
        const bySystem = new Map<number, PlayerStructureInfo[]>();
        for (const structure of structures) {
          const list = bySystem.get(structure.system_id);
          if (list) list.push(structure);
          else bySystem.set(structure.system_id, [structure]);
        }
        structuresBySystemRef.current = bySystem;
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load player structures: ${String(err)}`));
    return () => {
      cancelled = true;
    };
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

    // Self-healing: every draw() call (triggered by plenty of things beyond
    // just the kills effect - resize, pan, mount) re-checks that the pulse
    // loop is actually running whenever there's active heat to animate, and
    // restarts it if not. Covers the case where MapView remounts (leaving
    // the Map tab and coming back fully unmounts/remounts it) - the pulse
    // should always resume on its own rather than depending on getting the
    // exact right effect ever fire again after a fresh mount.
    if (animFrameRef.current === null && hasRecentHeat(heatMapRef.current, Date.now())) {
      ensureAnimating();
    }

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

    // Constellation boundaries - a faint hull behind everything else, only
    // once zoomed in enough that individual systems (not just region names)
    // are visible, so it reads as texture/wayfinding rather than clutter at
    // the whole-region view where it'd just be noise on top of noise.
    if (zoomRatio >= LABEL_ZOOM_RATIO) {
      for (const hull of constellationHullsRef.current.values()) {
        if (hull.length < 3 || !hull.some((p) => inView(p.x, p.y))) continue;
        ctx.beginPath();
        ctx.moveTo(toScreenX(hull[0].x), toScreenY(hull[0].y));
        for (let i = 1; i < hull.length; i++) ctx.lineTo(toScreenX(hull[i].x), toScreenY(hull[i].y));
        ctx.closePath();
        ctx.fillStyle = "rgba(111, 195, 217, 0.035)";
        ctx.fill();
        ctx.strokeStyle = "rgba(111, 195, 217, 0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    const dotRadius = Math.min(6, Math.max(1.4, 1.4 * Math.sqrt(zoomRatio)));
    const now = Date.now();

    // Persistent heat: a soft glow plus two concentric rings, colored along
    // the classic dim-red -> red -> orange -> yellow ramp EVE's own old
    // in-game kill heatmap used (see heatColor), brightening continuously
    // with kill count rather than capping out after half a dozen kills -
    // so a system that's been busy over the last hour still visibly stands
    // out even between pings ("what to avoid", not just "what just
    // happened"), and a genuinely hot system (dozens/hundreds of kills)
    // reads as unmistakably hotter than a system with just one or two.
    // Only actively pulses (both brightness and size) while a kill has
    // landed there in the last PULSE_RECENCY_MS - older-but-still-within-
    // the-hour heat holds rock steady instead, so "fighting right now" and
    // "was busy a while ago" read as visibly different states, not the
    // same static glow. draw() keeps re-running every animation frame
    // while anything is actively pulsing (see ensureAnimating below).
    for (const [systemId, entry] of heatMapRef.current) {
      if (entry.count <= 0) continue;
      const system = systemById.get(systemId);
      if (!system || !inView(system.x, system.y)) continue;
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);

      const intensity = heatIntensity(entry.count);
      const [hr, hg, hb] = heatColor(intensity);
      // Purely a function of kill count - no pulse/wave here at all. Only
      // the system dot itself (drawn later below) pulses; the heat glow is
      // a steady "how hot has this system been" read that never animates.
      const alpha = intensity;

      const glowRadius = dotRadius * (4.5 + intensity * 11);
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
      glow.addColorStop(0, `rgba(${hr}, ${hg}, ${hb}, ${clamp(alpha * 0.95, 0.05, 0.95)})`);
      glow.addColorStop(0.45, `rgba(${hr}, ${hg}, ${hb}, ${clamp(alpha * 0.5, 0.03, 0.55)})`);
      glow.addColorStop(1, `rgba(${hr}, ${hg}, ${hb}, 0)`);
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const visible: MapSystem[] = [];
    for (const system of data.systems) {
      if (!inView(system.x, system.y)) continue;
      visible.push(system);
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);
      const isSelected = system.id === selectedIdRef.current;
      const isHovered = !isSelected && system.id === hoveredIdRef.current;
      const isTickerHovered = system.id === tickerHoveredIdRef.current;
      const isCurrentLocation = system.id === currentSystemIdRef.current;
      const heatEntryForDot = heatMapRef.current.get(system.id);
      const heatBump = heatIntensity(heatEntryForDot?.count ?? 0) * 3.4;
      // The dot itself pulses too while a kill's actively landing here -
      // fading from fully transparent back up to its real security color,
      // not swapping color, so "which system is this" (security status)
      // never gets lost underneath "something's happening here right now".
      // Same now/systemId pulse as the glow above, so they breathe together.
      const isDotActive = heatEntryForDot != null && now - heatEntryForDot.mostRecentAt < PULSE_RECENCY_MS;
      ctx.fillStyle = securityColor(system.security);
      ctx.globalAlpha = isDotActive ? pulseWave(now, system.id, 0.04) : 1;
      ctx.beginPath();
      ctx.arc(
        sx,
        sy,
        (isSelected ? dotRadius * 2.2 : isCurrentLocation ? dotRadius * 2 : isHovered ? dotRadius * 1.7 : dotRadius) + heatBump,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (isHovered) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // A pulsing outline just outside the dot itself, separate from the
      // (non-pulsing) heat glow above - the glow says "this system has been
      // hot", this ring says "a kill is landing here right now", and
      // without its own border the dot's alpha-only pulse was too subtle to
      // notice at a glance.
      if (isDotActive) {
        const borderWave = pulseWave(now, system.id, 0.15);
        const baseRadius =
          (isSelected ? dotRadius * 2.2 : isCurrentLocation ? dotRadius * 2 : isHovered ? dotRadius * 1.7 : dotRadius) + heatBump;
        ctx.beginPath();
        ctx.arc(sx, sy, baseRadius + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 90, 60, ${clamp(borderWave, 0.15, 1)})`;
        ctx.lineWidth = 1.2 + borderWave * 1.6;
        ctx.stroke();
      }

      // A fixed-pixel-radius ring (not scaled by zoom, unlike the dot itself)
      // so a system flagged from hovering a ticker row stays easy to spot
      // even zoomed way out across a busy region - the whole point being to
      // find it on a big map, not just mark a barely-visible dot.
      if (isTickerHovered) {
        ctx.beginPath();
        ctx.arc(sx, sy, 11, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(111, 195, 217, 0.95)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 17, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(111, 195, 217, 0.45)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // The tracked "current location" marker - an actual pin, always drawn
      // (not gated by hover/zoom like the rings above) so it's visible at a
      // glance no matter where on the map you're looking, and immediately
      // jumps to the new system the moment the location changes (see the
      // currentSystemIdRef effect below).
      if (isCurrentLocation) {
        ctx.beginPath();
        ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(240, 192, 74, 0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        drawPin(ctx, sx, sy - dotRadius * 2 - 3, 7, "#f0c04a");
      }

      // An actual pin (not just the ring above) so the clicked/selected
      // system is unmistakable at a glance, distinct from the tracked
      // current-location marker.
      if (isSelected) {
        drawPin(ctx, sx, sy - dotRadius * 2.2 - 2, 6, "#ffffff");
      }

      // Home-base house markers - always drawn (not gated by zoom) so you
      // can spot at a glance where every logged-in character's home is,
      // offset to the dot's upper-right. Initials instead of a portrait -
      // a home marker's job is "whose home is this", not "what do they
      // look like" (that's the live location pins below). Grows sharply
      // with zoom (see portraitRadiusForZoom) so it's not just a tiny
      // mark forever once you're zoomed in.
      const homePins = homePinsBySystemRef.current.get(system.id);
      if (homePins && homePins.length > 0) {
        const markerRadius = portraitRadiusForZoom(zoomRatio);
        let px = sx + dotRadius + markerRadius + 3;
        const py = sy - dotRadius - markerRadius - 3;
        for (const pin of homePins) {
          drawHomeMarker(ctx, px, py, markerRadius, characterInitials(pin.character.name));
          px += markerRadius * 2 + 3;
        }
      }

      // Live current-location portrait pins - where each logged-in
      // character actually is right now, offset to the dot's lower-right
      // so they never collide with the home markers above it (a character
      // sitting at home shows both, right next to each other).
      const locationPins = locationPinsBySystemRef.current.get(system.id);
      if (locationPins && locationPins.length > 0) {
        const portraitRadius = portraitRadiusForZoom(zoomRatio);
        let px = sx + dotRadius + portraitRadius + 3;
        const py = sy + dotRadius + portraitRadius + 3;
        for (const pin of locationPins) {
          drawPortrait(ctx, px, py, portraitRadius, pin.image);
          px += portraitRadius * 2 + 3;
        }
      }

    }

    if (zoomRatio >= LABEL_ZOOM_RATIO && visible.length <= LABEL_MAX_VISIBLE) {
      const { fontSize: labelFontSize, gap: labelGap } = labelMetricsForZoom(zoomRatio);

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const system of visible) {
        const labelX = toScreenX(system.x) + dotRadius + labelGap;
        const labelY = toScreenY(system.y);

        const secText = formatSecurity(system.security);
        ctx.font = `600 ${labelFontSize}px Inter, sans-serif`;
        ctx.fillStyle = securityColor(system.security);
        ctx.fillText(secText, labelX, labelY);
        const secWidth = ctx.measureText(secText).width;

        ctx.font = `${labelFontSize}px Inter, sans-serif`;
        ctx.fillStyle = "rgba(230, 236, 245, 0.75)";
        ctx.fillText(system.name, labelX + secWidth + labelGap, labelY);

        // DOTLAN-style key icons (Refinery/Factory/Cloning/etc) - a row of
        // small colored squares under the name, same region-level-or-closer
        // gate as the labels themselves. Player structures join the same
        // row here (rather than their own always-visible marker) so they
        // only ever show at the same zoom level as everything else in it.
        const baseIcons = systemIconsRef.current.get(system.id);
        const hasPlayerStructures = structuresBySystemRef.current.has(system.id);
        const icons = hasPlayerStructures ? [...(baseIcons ?? []), PLAYER_STRUCTURE_ICON] : baseIcons;
        if (showServiceIconsRef.current && icons && icons.length > 0) {
          // Bigger baseline than the label text itself (not a fraction of
          // it) and keeps growing at the same rate as zoom increases, so the
          // icons stay legible rather than staying small and cramped.
          const iconSize = Math.max(13, labelFontSize * 1.15);
          const iconGap = Math.max(2, iconSize * 0.18);
          const iconY = labelY + labelFontSize * 0.85;
          let iconX = labelX;
          ctx.textAlign = "center";
          ctx.font = `700 ${Math.max(9, iconSize * 0.6)}px Inter, sans-serif`;
          for (const icon of icons) {
            ctx.fillStyle = icon.color;
            ctx.fillRect(iconX, iconY, iconSize, iconSize);
            ctx.fillStyle = ICON_TEXT_COLOR;
            ctx.fillText(icon.abbr, iconX + iconSize / 2, iconY + iconSize / 2 + 0.5);
            iconX += iconSize + iconGap;
          }
          ctx.textAlign = "left";
        }

        // Kill count inside the dot itself, matching the real in-game
        // starmap's big colored "pip with a number in it" once you're
        // zoomed in close enough to read it - a solid heat-colored disc
        // sized to the text (not the tiny security dot's radius), with
        // halo-stroked white text so it stays legible across the whole
        // dim-red-to-yellow color ramp.
        const heatEntry = heatMapRef.current.get(system.id);
        if (heatEntry && heatEntry.count > 0) {
          const dotX = toScreenX(system.x);
          const dotY = labelY;
          const numFontSize = Math.max(11, labelFontSize * 0.95);
          const [hr, hg, hb] = heatColor(heatIntensity(heatEntry.count));
          const text = String(heatEntry.count);
          ctx.font = `700 ${numFontSize}px Inter, sans-serif`;
          const textWidth = ctx.measureText(text).width;
          const pipRadius = Math.max(dotRadius + 5, textWidth / 2 + 5);

          ctx.beginPath();
          ctx.arc(dotX, dotY, pipRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
          ctx.fill();
          ctx.strokeStyle = "rgba(10, 8, 8, 0.55)";
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "rgba(10, 8, 8, 0.85)";
          ctx.strokeText(text, dotX, dotY + 0.5);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(text, dotX, dotY + 0.5);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
        }
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
      draw();
      // Keeps ticking every frame as long as some system is actively
      // pulsing (a kill within the last PULSE_RECENCY_MS) - stops (falls
      // back to on-demand redraws) once that goes quiet, so an empty or
      // merely-still-warm map isn't burning frames for nothing. Older,
      // non-pulsing heat still renders (draw() reads it fine on any
      // triggered redraw), it just doesn't need a continuous animation
      // loop to look right.
      const stillAnimating = hasRecentHeat(heatMapRef.current, now);
      animFrameRef.current = stillAnimating ? requestAnimationFrame(tick) : null;
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
    heatMapRef.current = computeSystemHeat(kills, now);
    if (hasRecentHeat(heatMapRef.current, now)) ensureAnimating();
    setTopActivity(computeTopActivity(kills, now));
    requestDraw();
    // Also refreshed on a timer so the heat rings and top-active panel keep
    // decaying smoothly even when the feed goes quiet for a while.
    const interval = setInterval(() => {
      const refreshedNow = Date.now();
      heatMapRef.current = computeSystemHeat(kills, refreshedNow);
      if (hasRecentHeat(heatMapRef.current, refreshedNow)) ensureAnimating();
      setTopActivity(computeTopActivity(kills, refreshedNow));
      requestDraw();
    }, HEAT_REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kills]);

  // Kept in a ref (not read directly off currentSystem in draw()) for the
  // same reason as tickerHoveredIdRef: the mouse/wheel event listeners below
  // are registered once per mapData load and would otherwise keep calling a
  // stale draw() closure that never sees a later location change.
  useEffect(() => {
    currentSystemIdRef.current = currentSystem?.id ?? null;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSystem]);

  useEffect(() => {
    showServiceIconsRef.current = showServiceIcons;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showServiceIcons]);

  useEffect(() => {
    if (!mapData) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // The canvas can still be at a stale/default size (e.g. mid tab-switch
    // layout, before the sidebar/flex layout has settled) the instant this
    // effect fires - fitting to that would center the map for the wrong
    // dimensions and never get corrected, since a plain resize listener
    // only redraws with the existing (wrong) transform rather than
    // recalculating it. A ResizeObserver fires with the canvas's real
    // laid-out size as soon as it stabilizes, and again on every genuine
    // resize after that - auto-refitting until the user actually takes the
    // view into their own hands via pan/zoom.
    const resizeObserver = new ResizeObserver(() => {
      if (!hasInteractedRef.current) fitToView();
    });
    resizeObserver.observe(canvas);

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
          const { fontSize: labelFontSize, gap: labelGap } = labelMetricsForZoom(zoomRatio);
          for (const system of data.systems) {
            const sx = system.x * scale + translateX;
            const sy = system.y * scale + translateY;
            ctx.font = `600 ${labelFontSize}px Inter, sans-serif`;
            const secWidth = ctx.measureText(formatSecurity(system.security)).width;
            ctx.font = `${labelFontSize}px Inter, sans-serif`;
            const nameWidth = ctx.measureText(system.name).width;
            const labelX = sx + dotRadius + labelGap;
            const labelY = sy;
            const labelWidth = secWidth + labelGap + nameWidth;
            const labelHalfHeight = labelFontSize * 0.6;
            if (
              px >= labelX - 2 &&
              px <= labelX + labelWidth + 2 &&
              py >= labelY - labelHalfHeight &&
              py <= labelY + labelHalfHeight
            ) {
              return system;
            }
          }
        }
      }

      return pickSystem(clientX, clientY);
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      hasInteractedRef.current = true;
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
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          draggingRef.current.moved = true;
          hasInteractedRef.current = true;
        }
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
          setPinnedHover((prev) => {
            if (!picked) return null;
            if (prev?.system.id === picked.id) return null;
            return { system: picked, clientX: e.clientX, clientY: e.clientY };
          });
          requestDraw();
        }
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousedown", handleMouseDown);
    // No native canvas "mouseleave" listener: the mini-killboard tooltip
    // sits on top of the canvas with pointer-events re-enabled (so its
    // kill rows are clickable), and moving the cursor onto it would fire a
    // real DOM mouseleave on the canvas underneath, clearing hoverInfo and
    // hiding the tooltip the instant someone tries to click a kill in it.
    // handleMouseMove's own clientX/Y-vs-canvas-rect bounds check below
    // already covers "the mouse actually left the map area".
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("resize", requestDraw);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("resize", requestDraw);
    };
  }, [mapData]);

  function handleTickerRowEnter(systemId: number) {
    tickerHoveredIdRef.current = systemId;
    requestDraw();
  }

  function handleTickerRowLeave() {
    tickerHoveredIdRef.current = null;
    requestDraw();
  }

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

  /** Centers and zooms to fit the whole region a system belongs to - used by
   * the ticker's locate button, so clicking it shows where the kill happened
   * in its surrounding neighborhood rather than either the whole cluttered
   * universe or an extreme single-system close-up. */
  function goToRegionOfSystem(systemId: number) {
    const data = dataRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas) return;
    const system = data.systems.find((s) => s.id === systemId);
    if (!system) return;
    const regionSystems = data.systems.filter((s) => s.region_id === system.region_id);
    if (regionSystems.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of regionSystems) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const padding = 60;
    const dataWidth = maxX - minX || 1;
    const dataHeight = maxY - minY || 1;
    const rawScale = Math.min((width - padding * 2) / dataWidth, (height - padding * 2) / dataHeight);
    // Clamped so a very sparse/tiny region still zooms in meaningfully, and a
    // very large/dense one doesn't overshoot the "region level" feel this is
    // meant to give (goToSystem's 40x is the deep single-system close-up).
    const scale = clamp(rawScale, fitScaleRef.current * 8, fitScaleRef.current * 35);

    transformRef.current = {
      scale,
      translateX: padding - minX * scale + (width - padding * 2 - dataWidth * scale) / 2,
      translateY: padding - minY * scale + (height - padding * 2 - dataHeight * scale) / 2,
    };
    selectedIdRef.current = system.id;
    setSelectedSystem(system);
    setQuery(system.name);
    setResults([]);
    requestDraw();
  }

  // A pinned tooltip (from clicking a system) takes priority over whatever
  // is currently hovered - see pinnedHover's own comment above.
  const activeHover = pinnedHover ?? hoverInfo;

  // Memoized rather than recomputed inline - this used to re-scan the full
  // live kills array (and re-parse every timestamp) on every render,
  // including ones triggered by unrelated state changes like a mousemove
  // that didn't even change which system is hovered.
  const hoveredSystemId = activeHover?.system.id;
  const hoveredKillCount = useMemo(() => {
    if (hoveredSystemId == null) return 0;
    const now = Date.now();
    return kills.filter((k) => k.system_id === hoveredSystemId && now - new Date(k.time).getTime() < HEAT_WINDOW_MS).length;
  }, [kills, hoveredSystemId]);

  // getPlayerStructures() already resolves owner corp/alliance per
  // structure (see the effect above) - reused here instead of a second
  // fetch, so hovering a system with a citadel shows who owns it without
  // needing the Stats popup's Locations tab.
  const hoveredStructures = useMemo(
    () => (hoveredSystemId == null ? [] : (structuresBySystemRef.current.get(hoveredSystemId) ?? [])),
    [hoveredSystemId],
  );

  /** A compact mini-killboard for the hover tooltip - the same live kill
   * feed already driving the map dots/ticker, just filtered to this one
   * system and capped short, click-through to the real kill detail page. */
  const hoveredKills = useMemo(() => {
    if (hoveredSystemId == null) return [];
    return kills
      .filter((k) => k.system_id === hoveredSystemId)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 5);
  }, [kills, hoveredSystemId]);

  // Every live kill gets routed into exactly one of the two feeds below,
  // based on whether it falls within the chosen proximity radius AND is
  // still fresh enough (see PROXIMITY_EXPIRY_MS) - not shown in both. A
  // location change clears alertKillIds (see setCurrentSystem in
  // useLocationTracking), so the nearby feed empties and any of its old
  // entries fall back into the general feed the moment you re-track.
  // Both lists used to be plain per-render filter/sort/slice passes over the
  // full live kill array - recomputed on every render, including ones
  // triggered by unrelated state like a canvas mousemove. Same fix as
  // hoveredKillCount above.
  const proximityTickerKills = useMemo(
    () =>
      kills
        .filter(
          (k) =>
            new Date(k.time).getTime() >= APP_LOADED_AT &&
            alertKillIds.has(k.killmail_id) &&
            proximityClock - new Date(k.time).getTime() < PROXIMITY_EXPIRY_MS,
        )
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, PROXIMITY_TICKER_LIMIT),
    [kills, alertKillIds, proximityClock],
  );
  const proximityTickerIds = useMemo(() => new Set(proximityTickerKills.map((k) => k.killmail_id)), [proximityTickerKills]);

  const tickerKills = useMemo(
    () =>
      kills
        .filter((k) => new Date(k.time).getTime() >= APP_LOADED_AT && !proximityTickerIds.has(k.killmail_id))
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, TICKER_LIMIT),
    [kills, proximityTickerIds],
  );

  return (
    <>
      <div className="map-page">
        <aside className="map-ticker">
          <div className="map-ticker-proximity">
            <div className="map-ticker-proximity-header">
              <span>Nearby</span>
              {currentSystem ? (
                <div className="location-tracker-radius map-ticker-radius-picker">
                  {RADIUS_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className={`location-tracker-radius-btn${radius === option.value ? " location-tracker-radius-active" : ""}`}
                      onClick={() => setRadius(option.value)}
                      title={option.value === "region" ? "Track the whole region" : `Track ${option.value} jumps out`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="map-ticker-proximity-radius">No location set</span>
              )}
            </div>
            {!currentSystem ? (
              <p className="map-ticker-empty">Set your current location to track nearby kills.</p>
            ) : proximityTickerKills.length === 0 ? (
              <p className="map-ticker-empty">No nearby kills yet.</p>
            ) : (
              proximityTickerKills.map((kill) => (
                <TickerRow
                  key={kill.killmail_id}
                  kill={kill}
                  isAlert
                  isCurrentLocation={currentSystem?.id === kill.system_id}
                  onSelect={() => onSelectKill(kill.killmail_id)}
                  onSetLocation={() => setCurrentSystem({ id: kill.system_id, name: kill.system_name })}
                  onShowOnMap={() => goToRegionOfSystem(kill.system_id)}
                  onMouseEnter={() => handleTickerRowEnter(kill.system_id)}
                  onMouseLeave={handleTickerRowLeave}
                />
              ))
            )}
          </div>

          <div className="map-ticker-divider" />

          <div className="map-ticker-list">
            {tickerKills.length === 0 ? (
              <p className="map-ticker-empty">Waiting for the next kill...</p>
            ) : (
              tickerKills.map((kill) => (
                <TickerRow
                  key={kill.killmail_id}
                  kill={kill}
                  isAlert={alertKillIds.has(kill.killmail_id)}
                  isCurrentLocation={currentSystem?.id === kill.system_id}
                  onSelect={() => onSelectKill(kill.killmail_id)}
                  onSetLocation={() => setCurrentSystem({ id: kill.system_id, name: kill.system_name })}
                  onShowOnMap={() => goToRegionOfSystem(kill.system_id)}
                  onMouseEnter={() => handleTickerRowEnter(kill.system_id)}
                  onMouseLeave={handleTickerRowLeave}
                />
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
                      <span className="kills-security" style={{ color: securityColor(system.security) }}>
                        {formatSecurity(system.security)}
                      </span>
                      {system.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="map-layer-toggles">
              <button
                type="button"
                className={`map-icons-toggle${legendOpen ? " map-icons-toggle-active" : ""}`}
                onClick={() => setLegendOpen((v) => !v)}
                title={legendOpen ? "Hide the map key" : "Show the map key"}
              >
                Key
              </button>
              <button
                type="button"
                className={`map-icons-toggle${showServiceIcons ? " map-icons-toggle-active" : ""}`}
                onClick={() => setShowServiceIcons((v) => !v)}
                title="Toggle the station-service key icons shown under system names"
              >
                Icons
              </button>
            </div>

            {selectedSystem && (
              <div className="map-selected-info">
                <span className="kills-security" style={{ color: securityColor(selectedSystem.security) }}>
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
                <button
                  type="button"
                  className={`map-selected-set-location${
                    currentSystem?.id === selectedSystem.id ? " map-selected-set-location-active" : ""
                  }`}
                  onClick={() => setCurrentSystem({ id: selectedSystem.id, name: selectedSystem.name })}
                  title="Set as my current location - overrides whatever's set in the top bar"
                >
                  <MapPin size={13} strokeWidth={2} />
                  {currentSystem?.id === selectedSystem.id ? "Current Location" : "Set as My Location"}
                </button>
                <button
                  type="button"
                  className="map-selected-stats-btn"
                  onClick={() => setStatsSystemId(selectedSystem.id)}
                  title="Show system stats (DOTLAN-style detail)"
                >
                  <BarChart3 size={13} strokeWidth={2} />
                  Stats
                </button>
              </div>
            )}
          </div>

          <div className="map-canvas-wrap">
            {loading ? (
              <p className="detail-empty">Loading universe map...</p>
            ) : (
              <canvas ref={canvasRef} className="map-canvas" />
            )}

            {legendOpen && (
              <div className="map-legend">
                <div className="map-legend-header">
                  <p>Map Key</p>
                </div>
                <p>Security</p>
                <div className="map-security-legend">
                  {SECURITY_LEGEND.map((s) => (
                    <span
                      key={s.tenth}
                      className="map-security-chip"
                      style={{ background: s.color, color: s.textColor }}
                      title={`${s.label} security`}
                    >
                      {s.label}
                    </span>
                  ))}
                </div>
                <p>Station Key</p>
                {LEGEND_ITEMS.map((item) => (
                  <div key={item.name} className="map-legend-row">
                    <span className="map-legend-swatch" style={{ background: item.color, color: ICON_TEXT_COLOR }}>
                      {item.abbr}
                    </span>
                    <span>{item.name}</span>
                  </div>
                ))}
                <p className="map-legend-hint">Zoom to region level to see icons</p>
                {currentSystem && (
                  <div className="map-legend-row map-legend-current-location">
                    <MapPin size={13} strokeWidth={2.5} className="map-legend-pin" />
                    <span>Current Location ({currentSystem.name})</span>
                  </div>
                )}
                {homeSystemCount > 0 && (
                  <p className="map-legend-hint">Portraits mark each character's home station</p>
                )}
              </div>
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

      {activeHover && (
        <div
          className={`map-hover-tooltip${pinnedHover ? " map-hover-tooltip-pinned" : ""}`}
          style={{ left: activeHover.clientX + 16, top: activeHover.clientY + 16 }}
        >
          <div className="map-hover-tooltip-title">
            <span className="kills-security" style={{ color: securityColor(activeHover.system.security) }}>
              {formatSecurity(activeHover.system.security)}
            </span>
            <span className="map-hover-name">{activeHover.system.name}</span>
            {pinnedHover && (
              <button type="button" className="map-hover-tooltip-close" onClick={() => setPinnedHover(null)} title="Unpin">
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
          <span className="map-hover-kills">
            {hoveredKillCount > 0
              ? `${hoveredKillCount} kill${hoveredKillCount === 1 ? "" : "s"} in the last hour`
              : "No recent activity"}
          </span>
          {hoveredKills.length > 0 && (
            <div className="map-hover-killboard">
              {hoveredKills.map((k) => (
                <div key={k.killmail_id} className="map-hover-killboard-row" onClick={() => onSelectKill(k.killmail_id)}>
                  <img className="map-hover-killboard-icon" src={`https://images.evetech.net/types/${k.ship_type_id}/icon?size=32`} alt="" />
                  <span className="map-hover-killboard-ship">{k.ship_type_name}</span>
                  <span className="map-hover-killboard-victim">{k.victim_character_name ?? "Unknown"}</span>
                  <span className="map-hover-killboard-time">{formatExactTime(k.time)}</span>
                </div>
              ))}
            </div>
          )}
          {hoveredStructures.length > 0 && (
            <div className="map-hover-structures">
              {hoveredStructures.length > 1 && <span className="map-hover-structures-count">{hoveredStructures.length} structures</span>}
              {hoveredStructures.slice(0, 3).map((s) => (
                <span key={s.id} className="map-hover-structure-row">
                  {s.owner_alliance_ticker ? `[${s.owner_alliance_ticker}] ` : ""}
                  {s.owner_corporation_name ?? s.owner_corporation_ticker ?? "Unknown owner"}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {statsSystemId !== null && <SystemStatsPanel systemId={statsSystemId} onClose={() => setStatsSystemId(null)} />}
    </>
  );
}

interface TickerRowProps {
  kill: KillEntry;
  isAlert: boolean;
  isCurrentLocation: boolean;
  onSelect: () => void;
  onSetLocation: () => void;
  onShowOnMap: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** A single ticker entry - shared by both the proximity feed and the general
 * feed below it, since a proximity kill renders identically in each, just in
 * a different list. */
function TickerRow({ kill, isAlert, isCurrentLocation, onSelect, onSetLocation, onShowOnMap, onMouseEnter, onMouseLeave }: TickerRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`map-ticker-row${isAlert ? " map-ticker-row-alert" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="map-ticker-row-top">
        <span className="map-ticker-time">{formatUtcTime(kill.time)}</span>
        <div className="map-ticker-row-actions">
          <button
            type="button"
            className={`map-ticker-locate${isCurrentLocation ? " map-ticker-locate-active" : ""}`}
            title="Set as my current location - overrides whatever's set in the top bar"
            aria-label="Set as my current location"
            onClick={(e) => {
              e.stopPropagation();
              onSetLocation();
            }}
          >
            <MapPin size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="map-ticker-locate"
            title="Show on map"
            aria-label="Show on map"
            onClick={(e) => {
              e.stopPropagation();
              onShowOnMap();
            }}
          >
            <Crosshair size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
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
    </div>
  );
}

export default MapView;
