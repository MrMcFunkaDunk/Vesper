import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Crosshair, MapPin, BarChart3, RefreshCw } from "lucide-react";
import SystemStatsPanel from "./SystemStatsPanel";
import { getMapData, getCharacterHomeSystems, getPlayerStructures, type MapData, type MapSystem, type PlayerStructureInfo } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityColor, securityColorResolved, formatSecurity, formatUtcTime, formatIskCompact, formatExactTime } from "../lib/format";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { useLocationTracking } from "../hooks/useLocationTracking";
import { useMapDisplayPrefs } from "../hooks/useMapDisplayPrefs";
import { RADIUS_OPTIONS, radiusTitle } from "./TopBar";
import { getSystemKillHeat, type KillEntry, type SystemKillHeat } from "../lib/kills";
import type { SystemSummary } from "./SystemKillboard";
import { getCharacterLocation, type SessionCharacter } from "../lib/eve";
import { THEME_CHANGE_EVENT, useTheme, isPremiumTheme } from "../hooks/useTheme";

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
/** securityColor() now returns a "var(--sec-N)" reference rather than a raw
 * hex (so the whole security scale can be redefined per theme and repaint
 * instantly on a switch - see format.ts) - there's no hex left here to
 * compute real luminance from. This is a fixed approximation of which tiers
 * read as the lighter/darker half of the scale, good enough for legend-chip
 * text contrast without needing an actual color read-back. Every theme's
 * --sec-* set keeps the same "high-sec runs light, low/null runs darker and
 * more saturated" shape as the original RIFT-derived scale, so this stays
 * valid regardless of which theme is active. */
const SECURITY_LEGEND_LIGHT_TIERS = new Set([8, 7, 6, 5]);

const SECURITY_LEGEND = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((tenth) => {
  const color = securityColor(tenth / 10);
  const textColor = SECURITY_LEGEND_LIGHT_TIERS.has(tenth) ? "var(--sec-legend-on-light)" : "var(--sec-legend-on-dark)";
  return { tenth, label: (tenth / 10).toFixed(1), color, textColor };
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
function drawPortrait(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, image: HTMLImageElement | null, inkColor: string) {
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
    ctx.fillStyle = inkColor;
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = inkColor;
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
 * dark HUD panel with the active theme's own accent outline, matching every
 * other selection/highlight ring on the map, instead of a literal
 * skeuomorphic gold cottage that would look imported from another app.
 * accent/panelBg/panelBg2 are resolved once per frame by the caller (same
 * pattern as inkColor) rather than re-read here per pin - this used to be
 * hardcoded to the original dark theme's exact hex values regardless of
 * which theme was actually active, so every other theme's map (standard
 * or premium) showed a cyan-on-near-black home marker no matter what. */
function drawHomeMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  initials: string,
  accent: string,
  panelBg: string,
  panelBg2: string,
) {
  const bodyWidth = radius * 1.7;
  const bodyHeight = radius * 1.3;
  const bodyTop = cy - radius * 0.15;

  ctx.beginPath();
  ctx.moveTo(cx - bodyWidth / 2 - radius * 0.15, bodyTop);
  ctx.lineTo(cx, bodyTop - radius * 0.9);
  ctx.lineTo(cx + bodyWidth / 2 + radius * 0.15, bodyTop);
  ctx.closePath();
  ctx.fillStyle = panelBg;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.rect(cx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  ctx.fillStyle = panelBg2;
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

// The last-hour window itself now lives server-side (kill_history.rs's
// SYSTEM_HEAT_WINDOW_MINUTES) since getSystemKillHeat's aggregate query
// already scopes to it - this only controls how often the map re-polls
// that aggregate, not the window length.
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

/** Turns a resolved "#rrggbb" custom-property value into an "r, g, b" triple
 * Canvas rgba() strings can interpolate an alpha into - every theme's own
 * tokens (App.css and the premium deck sheets) are written as hex literals,
 * so getComputedStyle always hands this exactly that format back. Falls
 * back to a neutral mid-gray rather than throwing if a future token is
 * ever written as rgb()/named color instead. */
function hexToRgbTriple(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return "150, 150, 150";
  return `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}`;
}

interface MapThemeColors {
  inkColor: string;
  accentHex: string;
  accentRgb: string;
  dangerRgb: string;
  gateRgb: string;
  gateHex: string;
  homeRoofBg: string;
  homeBodyBg: string;
}

/** Every value draw() needs from the active theme, resolved in one batch.
 * Called once on mount and again only when the theme actually changes (see
 * the THEME_CHANGE_EVENT listener below) - NOT from inside draw() itself.
 * draw() runs on every animation frame while a kill pulse is active
 * (requestAnimationFrame-driven, see requestDraw/ensureAnimating), and
 * getComputedStyle() forces a style recalculation - calling it 6 times
 * every frame was the actual cause of the pulse rings looking like they
 * were stuttering/lagging slightly instead of blinking smoothly, not
 * anything about the pulse math itself. */
function resolveThemeColors(): MapThemeColors {
  const rootStyle = getComputedStyle(document.documentElement);
  const accentHex = rootStyle.getPropertyValue("--accent").trim() || "#6fc3d9";
  const gateHex = rootStyle.getPropertyValue("--gate").trim() || "#f0c04a";
  return {
    inkColor: rootStyle.getPropertyValue("--text").trim() || "#e6ecf5",
    accentHex,
    accentRgb: hexToRgbTriple(accentHex),
    dangerRgb: hexToRgbTriple(rootStyle.getPropertyValue("--danger").trim() || "#e0685f"),
    gateRgb: hexToRgbTriple(rootStyle.getPropertyValue("--gate").trim() || "#d9a35b"),
    gateHex,
    homeRoofBg: rootStyle.getPropertyValue("--bg-elevated-2").trim() || "#1a1c21",
    homeBodyBg: rootStyle.getPropertyValue("--bg-elevated").trim() || "#131418",
  };
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
 * doesn't look identical to one where kills are landing this second.
 * Built from the backend's own last-hour aggregate (getSystemKillHeat)
 * rather than the live ticker feed - that feed is capped at 150 kills New
 * Eden-wide (mergeKillFeeds' MAX_LIVE_KILLS), so a busy hour anywhere else
 * in the game used to silently starve a genuinely hot system of its true
 * count here. The aggregate is already filtered server-side to the rolling
 * hour, so no age check is needed on this end. */
function computeSystemHeat(heat: SystemKillHeat[]): Map<number, SystemHeat> {
  const result = new Map<number, SystemHeat>();
  for (const entry of heat) {
    result.set(entry.system_id, { count: entry.kill_count, mostRecentAt: new Date(entry.last_kill_time).getTime() });
  }
  return result;
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

/** Ranks systems and regions by kill count within the last hour, for the
 * "Top Active" overlay panel - same backend aggregate as computeSystemHeat
 * above, already scoped to the rolling hour server-side. */
function computeTopActivity(heat: SystemKillHeat[]): { systems: TopActivityEntry[]; regions: TopActivityEntry[] } {
  const regionCounts = new Map<string, number>();
  for (const entry of heat) {
    if (entry.region_name) {
      regionCounts.set(entry.region_name, (regionCounts.get(entry.region_name) ?? 0) + entry.kill_count);
    }
  }
  const systems = [...heat]
    .sort((a, b) => b.kill_count - a.kill_count)
    .slice(0, TOP_ACTIVITY_LIMIT)
    .map((entry) => ({ name: entry.system_name, count: entry.kill_count }));
  const regions = [...regionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ACTIVITY_LIMIT)
    .map(([name, count]) => ({ name, count }));
  return { systems, regions };
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
  /** Screen-space hit boxes for every home/location pin drawn on the current
   * frame, rebuilt each draw pass - lets hover detection tell "over this
   * character's marker" apart from "over the system dot" without redoing
   * the pin layout math a second time outside the render loop. */
  const renderedPinsRef = useRef<{ px: number; py: number; radius: number; character: SessionCharacter; kind: "home" | "location" }[]>([]);
  const structuresBySystemRef = useRef<Map<number, PlayerStructureInfo[]>>(new Map());
  const heatMapRef = useRef<Map<number, SystemHeat>>(new Map());
  const animFrameRef = useRef<number | null>(null);
  const rafPulseIdRef = useRef<number | null>(null);
  const drawScheduledRef = useRef(false);
  const themeColorsRef = useRef<MapThemeColors>(resolveThemeColors());
  /** Premium-only targeting HUD: the live grid-position readout is written
   * directly to the DOM on every mousemove (a ref + imperative textContent,
   * not React state) since it would otherwise fire a re-render on every
   * pixel of mouse movement - the same per-frame-cost lesson as the canvas
   * draw loop itself, just for a DOM node instead of a canvas. */
  const coordsHudRef = useRef<HTMLDivElement>(null);
  const lockOnKeyRef = useRef(0);

  const [theme] = useTheme();
  const premium = isPremiumTheme(theme);
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
  /** A lightweight name tag shown while hovering a character's home or
   * live-location marker directly - separate from the system tooltip above
   * since it only needs to answer "whose pin is this", not show a
   * killboard. Hover-only (no pinning) since there's nothing inside it to
   * click. */
  const [pinHover, setPinHover] = useState<{ characterName: string; kind: "home" | "location"; clientX: number; clientY: number } | null>(null);
  const hoveredPinKeyRef = useRef<string | null>(null);
  /** Premium-only "target lock" HUD - four bracket corners that snap onto
   * whatever system was just clicked, at the exact screen position of the
   * click (the same clientX/clientY the pinned tooltip above already
   * anchors to), then hold there highlighting the current selection. key
   * increments on every click so re-selecting the same system still
   * restarts the converge animation instead of it silently no-op'ing. */
  const [lockOn, setLockOn] = useState<{ clientX: number; clientY: number; key: number } | null>(null);
  const [topActivity, setTopActivity] = useState<{ systems: TopActivityEntry[]; regions: TopActivityEntry[] }>({
    systems: [],
    regions: [],
  });
  /** Same data as heatMapRef, just in React state - the ref alone (updated
   * inside resync, read by the 150ms draw loop) doesn't trigger a re-render,
   * so the hover tooltip's reactive kill-count memo below needs its own
   * state copy to notice when a resync actually changes it. */
  const [systemHeat, setSystemHeat] = useState<Map<number, SystemHeat>>(new Map());
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
  // Re-resolves the cached theme colors draw() reads from ONLY when the
  // theme actually changes (see MapThemeColors/resolveThemeColors above) -
  // requestDraw() forces one immediate repaint with the new colors rather
  // than waiting for the next kill-pulse frame, which might not come for a
  // while (or ever, if nothing's currently pulsing).
  useEffect(() => {
    function handleThemeChange() {
      themeColorsRef.current = resolveThemeColors();
      requestDraw();
    }
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Read from the cache resolved on mount/theme-change (see
    // themeColorsRef/resolveThemeColors above), NOT via getComputedStyle
    // here - draw() runs on every animation frame while a kill pulse is
    // active, and getComputedStyle forces a style recalculation; calling
    // it several times per frame was what made the pulse rings look like
    // they were stuttering instead of blinking smoothly. --text is the
    // correct high-contrast ink for the active theme's background, used
    // below (with globalAlpha standing in for what used to be the rgba()
    // alpha channel) for jump lines, selection rings, the selected-system
    // pin, and system/region name labels - all of which used to assume
    // "the canvas is always a dark background" and went invisible the
    // moment the Light theme's near-white --bg made that assumption false.
    // accent/danger/gate replace what constellation hulls, the
    // ticker-hover ring, the active-kill pulse, and the current-location
    // marker used to have hardcoded to the original dark theme's own
    // cyan/red/gold - visibly wrong (a cyan ring on an amber-and-rust
    // Bulkhead map) on every other theme.
    const { inkColor, accentHex, accentRgb, dangerRgb, gateRgb, gateHex, homeRoofBg, homeBodyBg } = themeColorsRef.current;
    // Dark-on-light reads far fainter than the equivalent light-on-dark at
    // the same alpha (the original 0.08/0.75/0.85 numbers were tuned by eye
    // against the dark theme's near-black canvas) - low enough on Light that
    // the jump lines and region label sat right at the edge of visibility,
    // making ordinary redraw/antialiasing jitter during mouse movement read
    // as actual flicker. Bumped for Light specifically rather than changing
    // the numbers everyone else already looks right at.
    const isLightTheme = document.documentElement.dataset.theme === "light";
    const jumpLineAlpha = isLightTheme ? 0.22 : 0.08;
    const nameLabelAlpha = isLightTheme ? 0.92 : 0.75;
    const regionLabelAlpha = isLightTheme ? 1 : 0.85;

    ctx.strokeStyle = inkColor;
    ctx.globalAlpha = jumpLineAlpha;
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
    ctx.globalAlpha = 1;

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
        ctx.fillStyle = `rgba(${accentRgb}, 0.035)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${accentRgb}, 0.16)`;
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

    renderedPinsRef.current = [];

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
      ctx.fillStyle = securityColorResolved(system.security);
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
        ctx.strokeStyle = inkColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (isHovered) {
        ctx.strokeStyle = inkColor;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
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
        ctx.strokeStyle = `rgba(${dangerRgb}, ${clamp(borderWave, 0.15, 1)})`;
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
        ctx.strokeStyle = `rgba(${accentRgb}, 0.95)`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 17, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${accentRgb}, 0.45)`;
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
        ctx.strokeStyle = `rgba(${gateRgb}, 0.6)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        drawPin(ctx, sx, sy - dotRadius * 2 - 3, 7, gateHex);
      }

      // An actual pin (not just the ring above) so the clicked/selected
      // system is unmistakable at a glance, distinct from the tracked
      // current-location marker.
      if (isSelected) {
        drawPin(ctx, sx, sy - dotRadius * 2.2 - 2, 6, inkColor);
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
          drawHomeMarker(ctx, px, py, markerRadius, characterInitials(pin.character.name), accentHex, homeRoofBg, homeBodyBg);
          renderedPinsRef.current.push({ px, py, radius: markerRadius, character: pin.character, kind: "home" });
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
          drawPortrait(ctx, px, py, portraitRadius, pin.image, inkColor);
          renderedPinsRef.current.push({ px, py, radius: portraitRadius, character: pin.character, kind: "location" });
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
        ctx.fillStyle = securityColorResolved(system.security);
        ctx.fillText(secText, labelX, labelY);
        const secWidth = ctx.measureText(secText).width;

        ctx.font = `${labelFontSize}px Inter, sans-serif`;
        ctx.fillStyle = inkColor;
        ctx.globalAlpha = nameLabelAlpha;
        ctx.fillText(system.name, labelX + secWidth + labelGap, labelY);
        ctx.globalAlpha = 1;

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
      ctx.fillStyle = inkColor;
      ctx.globalAlpha = regionLabelAlpha;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const region of data.regions) {
        const center = regionCentersRef.current.get(region.id);
        if (!center || !inView(center.x, center.y)) continue;
        ctx.fillText(region.name, toScreenX(center.x), toScreenY(center.y));
      }
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    }
  }

  /** Coalesces any number of draw() requests within the same tick into a single call, matching zKillboard's own requestDraw pattern. Without this, high-frequency events like mousemove over the map's dense system clusters can each trigger their own full (expensive) redraw, backing up the main thread badly enough that frames visibly drop content like the heat rings.
   *
   * Scheduled through both requestAnimationFrame AND a short setTimeout
   * fallback, whichever fires first - not setTimeout alone. A setTimeout-only
   * version fixed the original "blank until mousemove" bug (rAF is exactly
   * what Chromium suspends the moment the window loses OS focus - see
   * ensureAnimating below) but broke normal on-screen interaction instead:
   * setTimeout(0) isn't paced to the display's actual vsync the way rAF is,
   * so painting through it while actively moving the mouse (dozens of
   * uncoalesced redraws a second, each one landing at a slightly different
   * point in the frame) made the very faint (8% alpha) jump-connection
   * lines visibly flicker in and out - high-contrast content like the dots
   * and labels was well above the threshold where that showed. rAF is the
   * fast path for exactly the case that can see it (mousemove only reaches
   * this app while it has real input focus), and the 120ms setTimeout is
   * purely the backstop for when rAF itself is the thing not firing -
   * whichever wins the race clears drawScheduledRef, so only one actually
   * draws. */
  function requestDraw() {
    if (drawScheduledRef.current) return;
    drawScheduledRef.current = true;
    const runOnce = () => {
      if (!drawScheduledRef.current) return;
      drawScheduledRef.current = false;
      draw();
    };
    requestAnimationFrame(runOnce);
    setTimeout(runOnce, 120);
  }

  // Two loops running side by side, each covering the other's weak spot:
  //
  // 1. A self-rescheduling requestAnimationFrame loop (rafPulseIdRef) - the
  //    actual smoothness driver, ticking at whatever rate the display
  //    refreshes (60/120/144Hz), which is what a ~1.9s sine breathe (see
  //    pulseWave) needs to read as continuous motion instead of visibly
  //    stepping. An earlier version of this used ONLY a 150ms setInterval
  //    (~6.7 ticks/sec - only ~13 samples across the whole 1.9s cycle),
  //    reasoned at the time to be "more than the eye can tell apart from
  //    60fps" - a real, reported-as-choppy regression proved that
  //    assumption wrong.
  // 2. The original setInterval, kept as a low-frequency anti-stall
  //    safety net, not the primary driver anymore. Chromium (and WebView2,
  //    which VESPER's whole UI runs on) throttles a recursive rAF loop
  //    down to near-zero the moment the window loses OS focus, even while
  //    it stays fully visible - exactly the situation VESPER is normally
  //    used in, sitting on a second monitor next to the actual EVE client.
  //    Relying on rAF alone made the pulse silently stall until the next
  //    click or mousemove. setInterval keeps running at its configured
  //    rate regardless of focus (Chromium only throttles it for a fully
  //    hidden/backgrounded tab, which never applies to a single-window
  //    desktop app), so losing focus now only drops the pulse from
  //    "smooth" to "still visibly alive at ~6.7fps" instead of "frozen".
  //
  // Both stop rescheduling themselves independently once nothing is
  // actively pulsing, and either one restarts the other on the next real
  // kill via ensureAnimating's own guard.
  function ensureAnimating() {
    if (animFrameRef.current === null) {
      animFrameRef.current = window.setInterval(() => {
        const now = Date.now();
        draw();
        if (!hasRecentHeat(heatMapRef.current, now)) {
          window.clearInterval(animFrameRef.current!);
          animFrameRef.current = null;
        }
      }, 150);
    }

    if (rafPulseIdRef.current === null) {
      const tick = () => {
        draw();
        if (hasRecentHeat(heatMapRef.current, Date.now())) {
          rafPulseIdRef.current = requestAnimationFrame(tick);
        } else {
          rafPulseIdRef.current = null;
        }
      };
      rafPulseIdRef.current = requestAnimationFrame(tick);
    }
  }

  /** Recomputes heat/top-activity off the backend's own last-hour aggregate
   * (getSystemKillHeat, not the capped live ticker feed - see
   * computeSystemHeat's comment) and forces one fresh draw - the single
   * source of truth for "make the map correct and pulsing right now",
   * reused by the mount effect, the periodic refresh, regaining window
   * focus/visibility, and the manual resync button below. Not triggered off
   * every incoming live kill any more (that's what made the old
   * array-filtering version prone to the 150-kill global cap in the first
   * place) - the 30s interval below plus the focus/visibility effect keep
   * it fresh enough for a "last hour" stat. */
  function resync() {
    getSystemKillHeat()
      .then((heat) => {
        const now = Date.now();
        const nextHeatMap = computeSystemHeat(heat);
        heatMapRef.current = nextHeatMap;
        setSystemHeat(nextHeatMap);
        if (hasRecentHeat(nextHeatMap, now)) ensureAnimating();
        setTopActivity(computeTopActivity(heat));
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load system kill heat: ${String(err)}`));
  }

  useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) window.clearInterval(animFrameRef.current);
      if (rafPulseIdRef.current !== null) cancelAnimationFrame(rafPulseIdRef.current);
    };
  }, []);

  useEffect(() => {
    resync();
    // Also refreshed on a timer so the heat rings and top-active panel keep
    // decaying smoothly even when the feed goes quiet for a while.
    const interval = setInterval(resync, HEAT_REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Belt-and-braces beyond the setInterval fix above: if the window's real
  // OS focus (or visibility) was lost long enough that anything did still
  // end up stalling - e.g. genuine CPU contention with EVE itself running
  // as the actual foreground game, not just Chromium's own throttling
  // policy - getting focus/visibility back forces an immediate resync
  // rather than waiting on the next mousemove or the periodic timer.
  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState === "visible") resync();
    }
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", handleVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    /** Finds the home/location pin (if any) under the cursor, checked before
     * pickSystem on every mousemove so hovering a character's marker shows
     * their name instead of (or on top of) the system's own tooltip. */
    function pickPin(clientX: number, clientY: number) {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      for (const pin of renderedPinsRef.current) {
        if (Math.hypot(pin.px - px, pin.py - py) <= pin.radius) return pin;
      }
      return null;
    }

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
      if (hoveredPinKeyRef.current !== null) {
        hoveredPinKeyRef.current = null;
        setPinHover(null);
      }
      if (coordsHudRef.current) coordsHudRef.current.textContent = "";
    }

    /** Written directly to the DOM (see coordsHudRef's own comment) rather
     * than through setState - this runs on every mousemove, and a HUD
     * flavor readout isn't worth a React re-render per pixel of cursor
     * travel. Divides the real (huge, meters-scale) map coordinates down to
     * a readable few digits - still real, panning/zooming actually changes
     * the numbers, just not claiming a literal unit like "km" it can't back up. */
    function updateCoordsHud(clientX: number, clientY: number) {
      if (!coordsHudRef.current) return;
      const rect = canvas!.getBoundingClientRect();
      const { scale, translateX, translateY } = transformRef.current;
      const dataX = (clientX - rect.left - translateX) / scale;
      const dataY = (clientY - rect.top - translateY) / scale;
      coordsHudRef.current.textContent = `GRID ${(dataX / 1e15).toFixed(2)} / ${(dataY / 1e15).toFixed(2)}`;
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
        updateCoordsHud(e.clientX, e.clientY);
        return;
      }

      const rect = canvas!.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        clearHover();
        return;
      }
      updateCoordsHud(e.clientX, e.clientY);
      const pin = pickPin(e.clientX, e.clientY);
      const pinKey = pin ? `${pin.kind}:${pin.character.id}` : null;
      if (pinKey !== hoveredPinKeyRef.current) {
        hoveredPinKeyRef.current = pinKey;
        setPinHover(pin ? { characterName: pin.character.name, kind: pin.kind, clientX: e.clientX, clientY: e.clientY } : null);
      } else if (pin) {
        setPinHover((prev) => (prev ? { ...prev, clientX: e.clientX, clientY: e.clientY } : prev));
      }

      // A pin sitting right next to its system's dot shouldn't also pop the
      // system's own killboard tooltip at the same time - whichever the
      // cursor is actually over wins, rather than layering both.
      const picked = pin ? null : pickSystem(e.clientX, e.clientY);
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
        // map pick if it actually landed on the canvas itself - otherwise
        // clicking UI elements like the selected-system name, search box, or
        // the pinned tooltip's clickable killboard rows (which visually sit
        // on top of the canvas, inside its bounding box) gets ALSO
        // reprocessed as "clicked this system's dot again", toggling the
        // pin off out from under the row's own onClick before it can
        // navigate. A target check (rather than a coordinate/bounding-box
        // check) is the only way to tell "landed on the canvas" from
        // "landed on an overlay drawn on top of it".
        const onCanvas = e.target === canvas;
        if (onCanvas) {
          const picked = pickSystemForClick(e.clientX, e.clientY);
          selectedIdRef.current = picked?.id ?? null;
          setSelectedSystem(picked);
          setPinnedHover((prev) => {
            if (!picked) return null;
            if (prev?.system.id === picked.id) return null;
            return { system: picked, clientX: e.clientX, clientY: e.clientY };
          });
          lockOnKeyRef.current += 1;
          setLockOn(picked ? { clientX: e.clientX, clientY: e.clientY, key: lockOnKeyRef.current } : null);
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
  // Backed by the same backend aggregate as the heat map (see
  // computeSystemHeat's comment) rather than filtering the capped live
  // ticker feed - a single hot gate could otherwise show a bigger number
  // than this "whole system" count, since the ticker feed only ever holds
  // the most recent 150 kills New Eden-wide.
  const hoveredKillCount = useMemo(() => {
    if (hoveredSystemId == null) return 0;
    return systemHeat.get(hoveredSystemId)?.count ?? 0;
  }, [systemHeat, hoveredSystemId]);

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
                      title={radiusTitle(option.value)}
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
                  severity={currentSystem?.id === kill.system_id ? "system" : "nearby"}
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
                  severity={
                    !alertKillIds.has(kill.killmail_id) ? null : currentSystem?.id === kill.system_id ? "system" : "nearby"
                  }
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
              <button
                type="button"
                className="map-icons-toggle"
                onClick={resync}
                title="Force the heat map and pulse to refresh right now, in case they've gone stale"
              >
                <RefreshCw size={12} strokeWidth={2} />
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

            {premium && (
              <>
                {/* Targeting-scope frame - four corner brackets plus a
                    center reticle, purely decorative (aria-hidden), giving
                    the whole viewport a "looking through a sensor scope"
                    read instead of "a rectangle with a canvas in it". */}
                <div className="map-hud-frame" aria-hidden="true">
                  <span className="map-hud-corner map-hud-corner-tl" />
                  <span className="map-hud-corner map-hud-corner-tr" />
                  <span className="map-hud-corner map-hud-corner-bl" />
                  <span className="map-hud-corner map-hud-corner-br" />
                  <span className="map-hud-reticle" />
                </div>
                {/* Old-CRT viewport: a soft bright band that slowly rolls
                    down the screen (a bad vertical-hold), plus interference
                    lines that flash in sync with .map-canvas-wrap's own
                    brightness-flicker animation (see premium-structure.css -
                    both share the same keyframe percentages against the
                    same duration so they land together, not two independent
                    effects that happen to overlap). */}
                <span className="map-hud-scanroll" aria-hidden="true" />
                <span className="map-hud-staticlines" aria-hidden="true" />
                {/* Live cursor position, written directly to this node on
                    every mousemove - see coordsHudRef/updateCoordsHud. */}
                <div ref={coordsHudRef} className="map-hud-coords" aria-hidden="true" />
              </>
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

      {pinHover && (
        <div className="map-hover-tooltip map-pin-tooltip" style={{ left: pinHover.clientX + 16, top: pinHover.clientY + 16 }}>
          <span className="map-hover-name">{pinHover.characterName}</span>
          <span className="map-hover-kills">{pinHover.kind === "home" ? "Home base" : "Currently here"}</span>
        </div>
      )}

      {premium && lockOn && (
        <div key={lockOn.key} className="map-lock-on" style={{ left: lockOn.clientX, top: lockOn.clientY }} aria-hidden="true">
          <span className="map-lock-on-corner map-lock-on-corner-tl" />
          <span className="map-lock-on-corner map-lock-on-corner-tr" />
          <span className="map-lock-on-corner map-lock-on-corner-bl" />
          <span className="map-lock-on-corner map-lock-on-corner-br" />
        </div>
      )}

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
  /** null: not within the tracked radius at all, no highlight. "system": the
   * kill landed in the exact system currently being tracked - the most
   * urgent case, since it means something's actively happening right where
   * the character is. "nearby": within the tracked radius but a different
   * system - still worth knowing about, less immediately dangerous. */
  severity: "system" | "nearby" | null;
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
/** Wormhole system names are always exactly "J" + 6 digits (e.g. J130735) -
 * a fixed EVE naming convention, never coincidentally matched by a real
 * k-space system name. J-space has no fixed position on the star map (a
 * wormhole's connections are random and temporary, not gates), so a kill
 * there can never show up as a dot anywhere on the map itself the way a
 * k-space kill does - flagging it here is the only way it's still obviously
 * visible as "this happened", not silently indistinguishable from a kill
 * that just isn't showing on the currently-viewed region. */
const WORMHOLE_SYSTEM_NAME = /^J\d{6}$/;

function TickerRow({ kill, severity, isCurrentLocation, onSelect, onSetLocation, onShowOnMap, onMouseEnter, onMouseLeave }: TickerRowProps) {
  const isWormhole = WORMHOLE_SYSTEM_NAME.test(kill.system_name);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`map-ticker-row${severity ? ` map-ticker-row-alert-${severity}` : ""}`}
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
        <div className="map-ticker-time-group">
          <span className="map-ticker-time">{formatUtcTime(kill.time)}</span>
          {isWormhole && <span className="map-ticker-wormhole-badge">Wormhole Kill</span>}
        </div>
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
