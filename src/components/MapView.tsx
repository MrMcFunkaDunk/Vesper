import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Crosshair, MapPin, BarChart3, RefreshCw, Radar, Maximize2, Minimize2, ChevronDown, Skull } from "lucide-react";
import SystemStatsPanel from "./SystemStatsPanel";
import { useTrackedEntities } from "../hooks/useTrackedEntities";
import {
  getMapData,
  getCharacterHomeSystems,
  getPlayerStructures,
  getFwSystems,
  getSovereigntyMap,
  getIncursions,
  getSystemActivity,
  colorForId,
  type MapData,
  type MapSystem,
  type MapJump,
  type PlayerStructureInfo,
  type FwSystemStatus,
  type SovEntry,
  type IncursionSystem,
  type SystemActivityCounts,
} from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import {
  securityColor,
  securityColorResolved,
  securityBand,
  isWSpaceSystemName,
  isAbyssalSystemName,
  formatSecurity,
  formatUtcTime,
  formatIskCompact,
  formatExactTime,
} from "../lib/format";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { useLocationTracking } from "../hooks/useLocationTracking";
import { useMapDisplayPrefs } from "../hooks/useMapDisplayPrefs";
import { RADIUS_OPTIONS, radiusTitle } from "./TopBar";
import { getSystemKillHeat, type KillEntry, type SystemKillHeat } from "../lib/kills";
import type { SystemSummary } from "./SystemKillboard";
import { getCharacterLocation, type SessionCharacter } from "../lib/eve";
import { resolveEntityNames } from "../lib/wars";
import { THEME_CHANGE_EVENT, useTheme, isPremiumTheme } from "../hooks/useTheme";

/** Which last-hour aggregate the background heat glow currently reads from
 * - only one at a time (three overlapping glows would be unreadable), see
 * the "Heat" mode selector in .map-layer-toggles. */
type HeatMode = "kills" | "traffic" | "npc";

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
/** Cap on how many systems get the per-node glow gradient (see draw()) -
 * more generous than LABEL_MAX_VISIBLE since a small radial gradient is far
 * cheaper than a text label, but a full-universe zoom-out (tens of
 * thousands of systems) still needs a safety valve. */
// Pre-rendered glow sprites (one per security tenth, blitted via drawImage
// and scaled to whatever radius a given frame needs) replace building a
// fresh createRadialGradient + fill per system per frame - the same
// point-sprite idea the EVE Frontier Map project's WebGL renderer uses for
// its own star glow, adapted to Canvas2D. Cheap enough that the visible-
// system cap below could be raised well past the old gradient-per-node
// budget without the glow costing a stutter.
const GLOW_SPRITE_SIZE = 128;

function buildGlowSprite(rgb: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_SIZE;
  canvas.height = GLOW_SPRITE_SIZE;
  const c = canvas.getContext("2d")!;
  const r = GLOW_SPRITE_SIZE / 2;
  const gradient = c.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, `rgba(${rgb}, 0.3)`);
  gradient.addColorStop(0.5, `rgba(${rgb}, 0.08)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  c.fillStyle = gradient;
  c.beginPath();
  c.arc(r, r, r, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

function getGlowSprite(cache: Map<number, HTMLCanvasElement>, secTenth: number, rgb: string): HTMLCanvasElement {
  let sprite = cache.get(secTenth);
  if (!sprite) {
    sprite = buildGlowSprite(rgb);
    cache.set(secTenth, sprite);
  }
  return sprite;
}

/** Same pre-rendered-sprite trick as buildGlowSprite/getGlowSprite above,
 * for the node's own "glassy disc" fill - a different gradient shape (a
 * hard edge at the circle boundary rather than a soft falloff well beyond
 * it), so it gets its own sprite/cache rather than reusing the glow's. */
function buildDiscSprite(rgb: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_SIZE;
  canvas.height = GLOW_SPRITE_SIZE;
  const c = canvas.getContext("2d")!;
  const r = GLOW_SPRITE_SIZE / 2;
  const gradient = c.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, `rgba(${rgb}, 0.1)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0.55)`);
  c.fillStyle = gradient;
  c.beginPath();
  c.arc(r, r, r, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

function getDiscSprite(cache: Map<number, HTMLCanvasElement>, secTenth: number, rgb: string): HTMLCanvasElement {
  let sprite = cache.get(secTenth);
  if (!sprite) {
    sprite = buildDiscSprite(rgb);
    cache.set(secTenth, sprite);
  }
  return sprite;
}

/** Same sprite-caching idea again for the kill/traffic/NPC heat glows -
 * these were still building a fresh createRadialGradient per active system
 * per frame. Unlike security tier (11 fixed values), heat intensity is a
 * continuous 0-1 float, so color/alpha are quantized into a small number of
 * buckets for caching purposes while glowRadius itself stays a smooth,
 * unquantized function of the real intensity (drawImage scaling is
 * continuous, so only the color has to step). Keyed by "family" (kill/
 * traffic/npc) since each has its own color ramp. */
const HEAT_GLOW_BUCKETS = 24;

function buildHeatGlowSprite(intensity: number, stops: [number, number, number, number][]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_SIZE;
  canvas.height = GLOW_SPRITE_SIZE;
  const c = canvas.getContext("2d")!;
  const r = GLOW_SPRITE_SIZE / 2;
  const [hr, hg, hb] = heatColor(intensity, stops);
  const gradient = c.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, `rgba(${hr}, ${hg}, ${hb}, ${clamp(intensity * 0.95, 0.05, 0.95)})`);
  gradient.addColorStop(0.45, `rgba(${hr}, ${hg}, ${hb}, ${clamp(intensity * 0.5, 0.03, 0.55)})`);
  gradient.addColorStop(1, `rgba(${hr}, ${hg}, ${hb}, 0)`);
  c.fillStyle = gradient;
  c.beginPath();
  c.arc(r, r, r, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

function getHeatGlowSprite(
  cache: Map<string, HTMLCanvasElement>,
  family: string,
  intensity: number,
  stops: [number, number, number, number][],
): HTMLCanvasElement {
  const bucket = clamp(Math.round(intensity * HEAT_GLOW_BUCKETS), 0, HEAT_GLOW_BUCKETS);
  const key = `${family}-${bucket}`;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = buildHeatGlowSprite(bucket / HEAT_GLOW_BUCKETS, stops);
    cache.set(key, sprite);
  }
  return sprite;
}

const GLOW_MAX_VISIBLE = 2500;

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

/** A targeting reticle - a ring plus 4 short tick marks standing off from
 * it on each side - for the selected system, in place of the plain drop-pin
 * every other marker on this map already uses (current location, home
 * base, destination). With three different pin-shaped markers now possible
 * on the same map, "selected" needs a shape that reads as clearly distinct
 * at a glance rather than just another pin in a different color.
 *
 * `progress` (0-1, eased outside this function) drives a brief "locking on"
 * assembly: the 4 ticks start further out and snap inward to their resting
 * position while the whole reticle fades in, rather than simply appearing
 * at full strength the instant a system is clicked. Callers pass 1 outright
 * under reduced motion, skipping the animation entirely rather than easing
 * toward it. */
function drawSelectionReticle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, progress: number) {
  ctx.globalAlpha = 0.3 + 0.7 * progress;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const gap = 4;
  const arm = 7;
  const spread = 10 * (1 - progress);
  const g = gap + spread;
  const a = arm + spread;
  ctx.beginPath();
  ctx.moveTo(x - radius - a, y);
  ctx.lineTo(x - radius - g, y);
  ctx.moveTo(x + radius + g, y);
  ctx.lineTo(x + radius + a, y);
  ctx.moveTo(x, y - radius - a);
  ctx.lineTo(x, y - radius - g);
  ctx.moveTo(x, y + radius + g);
  ctx.lineTo(x, y + radius + a);
  ctx.stroke();
  ctx.globalAlpha = 1;
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
/** Ship-jump counts at a busy trade hub run into the thousands/hour - kill
 * counts never do - so the Traffic heat mode needs a much wider divisor or
 * every populated system would read as identically maxed-out. */
const TRAFFIC_INTENSITY_DIVISOR = 400;
/** NPC/ratting kill counts sit closer to player kill counts than to jump
 * counts, but still run a bit hotter in a busy null-sec system. */
const NPC_INTENSITY_DIVISOR = 80;

function heatIntensity(count: number, divisor: number = HEAT_INTENSITY_DIVISOR): number {
  return 1 - Math.exp(-count / divisor);
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

/** Dim cyan -> bright cyan/white for the Traffic (ship-jump) heat mode -
 * deliberately a cool color, never confusable with the kill heat's red at a
 * glance regardless of which mode is currently active. */
const TRAFFIC_COLOR_STOPS: [number, number, number, number][] = [
  [0, 18, 60, 70],
  [0.4, 30, 140, 170],
  [1, 60, 220, 255],
];

/** Dim amber -> bright amber for the NPC-activity (ratting) heat mode - a
 * third, distinct hue from both kills (red) and traffic (cyan). */
const NPC_COLOR_STOPS: [number, number, number, number][] = [
  [0, 70, 50, 12],
  [0.4, 170, 120, 20],
  [1, 255, 190, 40],
];

function heatColor(intensity: number, stops: [number, number, number, number][] = HEAT_COLOR_STOPS): [number, number, number] {
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (intensity >= stops[i][0] && intensity <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
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

/** ESI's /sovereignty/map/ (see getSovereigntyMap) returns a row for every
 * system in the game, not just player-held null-sec - highsec/lowsec
 * systems get one too, owned by their NPC empire faction via faction_id.
 * "Sovereignty" in the map-filter/dimming sense means real player alliance
 * or corp ownership specifically, so every check needs alliance_id/
 * corporation_id, never just "is there an entry at all" (sovRef.has(id) is
 * true for nearly the whole map and would barely dim anything). */
function hasSovOwner(sov: SovEntry | undefined): boolean {
  return (sov?.alliance_id ?? sov?.corporation_id) != null;
}

/** One "focus" filter's (FW / Sov / Incursion) own jump-line geometry - see
 * the *GatePathsRef comments where this is called from. `colored` mirrors
 * gateBucketPathsRef's own local/distant-then-security-tenth bucketing, but
 * only for connections touching at least one relevant system; `dimmed`
 * flattens every other connection into a single grey path per tier, since
 * they all render in the same flat color regardless of security. */
interface FocusGatePaths {
  colored: Map<string, Path2D>;
  dimmed: { local: Path2D; distant: Path2D };
}

function buildFocusGatePaths(systemById: Map<number, MapSystem>, jumps: MapJump[], isRelevant: (systemId: number) => boolean): FocusGatePaths {
  const colored = new Map<string, Path2D>();
  const dimmedLocal = new Path2D();
  const dimmedDistant = new Path2D();
  for (const jump of jumps) {
    const a = systemById.get(jump.from);
    const b = systemById.get(jump.to);
    if (!a || !b) continue;
    const isLocal = a.constellation_id === b.constellation_id;
    if (isRelevant(a.id) || isRelevant(b.id)) {
      const secTenth = clamp(Math.round(a.security * 10), 0, 10);
      const key = `${isLocal ? "s" : "d"}${secTenth}`;
      let path = colored.get(key);
      if (!path) {
        path = new Path2D();
        colored.set(key, path);
      }
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    } else {
      const path = isLocal ? dimmedLocal : dimmedDistant;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
  }
  return { colored, dimmed: { local: dimmedLocal, distant: dimmedDistant } };
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
  /** Neutral, theme-consistent grey (--text-secondary) for systems dimmed
   * out of relevance by an active map filter - e.g. every non-Faction-
   * Warfare system once the FW overlay is on, the same "everything else
   * fades to grey" treatment EVE's own client uses so the systems that
   * actually matter don't have to compete with ~5,000 normally-colored
   * dots for attention. */
  mutedRgb: string;
  mutedHex: string;
  /** One entry per security tenth (index 0 = 0.0/"min" through index 10 =
   * 1.0), resolved once per theme change rather than per system per frame -
   * same "getComputedStyle is expensive inside draw()" reasoning as the
   * other colors above, just not yet applied to security color until this
   * (securityColorResolved was still being called per visible system every
   * frame). */
  securityHexByTenth: string[];
  securityRgbByTenth: string[];
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
  const mutedHex = rootStyle.getPropertyValue("--text-secondary").trim() || "#808080";
  const securityHexByTenth = Array.from({ length: 11 }, (_, tenth) => securityColorResolved(tenth / 10));
  return {
    inkColor: rootStyle.getPropertyValue("--text").trim() || "#e6ecf5",
    accentHex,
    accentRgb: hexToRgbTriple(accentHex),
    dangerRgb: hexToRgbTriple(rootStyle.getPropertyValue("--danger").trim() || "#e0685f"),
    gateRgb: hexToRgbTriple(rootStyle.getPropertyValue("--gate").trim() || "#d9a35b"),
    gateHex,
    homeRoofBg: rootStyle.getPropertyValue("--bg-elevated-2").trim() || "#1a1c21",
    homeBodyBg: rootStyle.getPropertyValue("--bg-elevated").trim() || "#131418",
    mutedRgb: hexToRgbTriple(mutedHex),
    mutedHex,
    securityHexByTenth,
    securityRgbByTenth: securityHexByTenth.map(hexToRgbTriple),
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

/** Sov ownership badge size at a given zoom level - the same growth curve
 * as portraitRadiusForZoom, but capped much smaller since a sov-heavy
 * region can have dozens of these on screen at once (unlike the handful
 * of character pins), where a full-size portrait badge per system would
 * be overwhelming. */
function sovLogoRadiusForZoom(zoomRatio: number): number {
  const progress = clamp((zoomRatio - LABEL_ZOOM_RATIO) / (LABEL_ZOOM_RATIO * 3), 0, 1);
  return 6 + progress * 8;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=32`;
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=32`;
}

/** Lazily creates (and caches) the Image for a sov owner's logo - only
 * fetched the first time that owner is actually drawn, and reused from
 * then on for every other system it holds and every future frame.
 * onLoad triggers a redraw so the badge appears the moment the image is
 * actually ready instead of waiting for some other reason to repaint. */
function getSovLogo(cache: Map<number, HTMLImageElement>, id: number, url: string, onLoad: () => void): HTMLImageElement {
  let img = cache.get(id);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = url;
    cache.set(id, img);
  }
  return img;
}

interface SystemHeat {
  /** Raw kill count within the rolling last hour - no cap. Each kill ages
   * out exactly 60 minutes after its own timestamp (a true rolling window,
   * not a top-of-the-hour bucket reset), so a system's count only ever
   * drops one kill at a time as each individual kill's own hour elapses. */
  count: number;
  /** Timestamp of the system's single most recent kill - drives whether it's
   * actively pulsing (see PULSE_ANIMATION_MS) independently of the count. */
  mostRecentAt: number;
}

/** Per-system heat: a system that's been busy stays visibly hotter (bigger
 * glow, bigger rings, bigger dot, brighter color) even between individual
 * kills, so it reads as "what to avoid" rather than just "what just
 * happened" - but only actively *pulses* while something's happening right
 * now (see PULSE_ANIMATION_MS), so a still-hot-but-quiet-for-a-while system
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

/** How long a system's heat actively *pulses* once this client first
 * notices a new kill there - older than this, it still glows at the same
 * brightness (the rolling-hour count hasn't changed) but holds steady
 * instead of breathing, since nothing is actually happening there right
 * now. Also gates how long the animation loop keeps redrawing at full
 * display refresh rate for a visible kill - a system that's been busy
 * stays visibly hot for the whole hour regardless, it just stops costing a
 * continuous 60fps+ redraw once the pulse window passes.
 *
 * Deliberately measured from heatFirstNoticedAtRef (when THIS client first
 * saw the kill), never from the kill's own mostRecentAt timestamp - a
 * killmail has to be reported, fetched, and enriched by killmail.stream/
 * zKillboard before it ever reaches this app, and that pipeline's own
 * delay (confirmed live: routinely 50+ seconds) can already exceed a short
 * pulse window before the data even arrives, silently making the pulse a
 * no-op despite kills flowing in correctly. Anchoring to first-noticed
 * instead guarantees the full window is always available, independent of
 * how stale the upstream data was by the time it got here. */
const PULSE_ANIMATION_MS = 15_000;

/** Shared breathing wave for anything tied to a system's active-kill pulse
 * (the heat glow/rings and the system dot itself) - phase-offset per
 * system (via systemId) so a cluster of active systems doesn't throb in
 * lockstep, and using the same now/systemId inputs in both places keeps
 * them visibly in sync with each other. Returns a value from `floor` up
 * to 1. reducedMotion skips the oscillation entirely and holds at the
 * brightest/fully-visible end (1) - the information ("this is actively
 * pulsing") stays legible, only the motion itself is removed, matching
 * prefers-reduced-motion's own intent rather than just dimming things. */
function pulseWave(now: number, systemId: number, floor: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  const phase = (systemId % 1000) * 0.31;
  const wave = 0.5 + 0.5 * Math.sin(now / 300 + phase);
  return floor + (1 - floor) * wave;
}


export interface TopActivityEntry {
  name: string;
  count: number;
}

export interface TopActivity {
  systems: TopActivityEntry[];
  regions: TopActivityEntry[];
}

/** Ranks systems and regions by kill count within the last hour, for the
 * "Top Active" panel - same backend aggregate as computeSystemHeat above,
 * already scoped to the rolling hour server-side. */
function computeTopActivity(heat: SystemKillHeat[]): TopActivity {
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

/** Same shape as computeRegionCenters, one level down - used to find which
 * constellation the camera is actually looking at for the close-zoom
 * region/constellation watermark below, the same way DOTLAN's region maps
 * (and the in-game 2D map itself) always show "where you are" text even
 * zoomed in past the point individual region boundaries mean anything. */
function computeConstellationCenters(systems: MapSystem[]): Map<number, { x: number; y: number }> {
  const sums = new Map<number, { sumX: number; sumY: number; count: number }>();
  for (const s of systems) {
    const entry = sums.get(s.constellation_id) ?? { sumX: 0, sumY: 0, count: 0 };
    entry.sumX += s.x;
    entry.sumY += s.y;
    entry.count += 1;
    sums.set(s.constellation_id, entry);
  }
  const centers = new Map<number, { x: number; y: number }>();
  for (const [constellationId, { sumX, sumY, count }] of sums) {
    centers.set(constellationId, { x: sumX / count, y: sumY / count });
  }
  return centers;
}

/** "Sinq Laison" -> "S I N Q   L A I S O N" - Canvas2D fillText has no
 * letter-spacing property, so the wide-tracked look the in-game 2D map uses
 * for its background region watermark is built by hand, word gaps doubled
 * so they still read as separate words once every letter is spaced out. */
function letterSpaced(text: string): string {
  return text.toUpperCase().split(" ").map((word) => word.split("").join(" ")).join("   ");
}

/** Repositions a tooltip by mutating the DOM directly instead of through
 * React state - see the tooltip refs' own comment for why. */
function moveTooltip(ref: { current: HTMLDivElement | null }, clientX: number, clientY: number) {
  if (ref.current) {
    ref.current.style.left = `${clientX + 16}px`;
    ref.current.style.top = `${clientY + 16}px`;
  }
}

/** Bidirectional stargate adjacency list, built once when the map loads -
 * the graph-index groundwork the route-planning rewrite needs. Kept
 * separate from gateBucketPathsRef (that one is rendering geometry, keyed
 * by tier/security for drawing; this one is pure topology, keyed by system
 * id, for BFS). */
function buildAdjacency(jumps: MapJump[]): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  for (const jump of jumps) {
    const from = adjacency.get(jump.from);
    if (from) from.push(jump.to);
    else adjacency.set(jump.from, [jump.to]);
    const to = adjacency.get(jump.to);
    if (to) to.push(jump.from);
    else adjacency.set(jump.to, [jump.from]);
  }
  return adjacency;
}

/** Unweighted BFS shortest path over the stargate graph - same "shortest"
 * semantics as every other route-finding in this codebase (see
 * threats.rs's find_nearest_threat, wormholes.rs's find_chain_route), just
 * origin-to-a-specific-destination instead of origin-to-nearest-match.
 * Returns the full path (origin through destination inclusive), or an
 * empty array if no path exists (e.g. destination is wormhole-only). */
function findShortestRoute(originId: number, destinationId: number, adjacency: Map<number, number[]>): number[] {
  if (originId === destinationId) return [originId];
  const previous = new Map<number, number | null>([[originId, null]]);
  const queue = [originId];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === destinationId) break;
    for (const next of adjacency.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(destinationId)) return [];
  const route: number[] = [];
  for (let current: number | null = destinationId; current !== null; current = previous.get(current) ?? null) {
    route.push(current);
  }
  return route.reverse();
}

/** Anchor candidates a label tries in order - right first (today's only
 * option), then above/left/below - each expressed as which side of the dot
 * the label sits on. Same 4-direction set the rewrite plan calls for, sized
 * to what a small system-name label actually needs (no diagonal anchors -
 * dense clusters didn't need them in testing, and they'd double the
 * candidate count for little gain). */
const LABEL_ANCHOR_SIDES = ["right", "top", "left", "bottom"] as const;
type LabelAnchorSide = (typeof LABEL_ANCHOR_SIDES)[number];

interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The label's fillText anchor point (left edge, vertical middle - textAlign
 * stays "left"/textBaseline "middle" for every side, only the starting
 * point moves) and its bounding rect for collision testing, for one
 * candidate side around a dot at (sx, sy). */
function labelRectForSide(
  side: LabelAnchorSide,
  sx: number,
  sy: number,
  dotRadius: number,
  gap: number,
  width: number,
  height: number,
): { textX: number; textY: number; rect: LabelRect } {
  const offset = dotRadius + gap;
  if (side === "right") {
    const textX = sx + offset;
    const textY = sy;
    return { textX, textY, rect: { x: textX, y: textY - height / 2, width, height } };
  }
  if (side === "left") {
    const textX = sx - offset - width;
    const textY = sy;
    return { textX, textY, rect: { x: textX, y: textY - height / 2, width, height } };
  }
  const textX = sx - width / 2;
  const textY = side === "top" ? sy - offset - height / 2 : sy + offset + height / 2;
  return { textX, textY, rect: { x: textX, y: textY - height / 2, width, height } };
}

/** Whichever id's centroid is closest to (x, y) - used to find "which
 * region/constellation is the camera actually looking at" for the
 * close-zoom watermark, since the camera's current viewport rarely lines up
 * with any one region's true geometric center. */
function nearestCenterId(centers: Map<number, { x: number; y: number }>, x: number, y: number): number | null {
  let bestId: number | null = null;
  let bestDist = Infinity;
  for (const [id, c] of centers) {
    const dx = c.x - x;
    const dy = c.y - y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = id;
    }
  }
  return bestId;
}

interface MapViewProps {
  /** Called with a killmail id when a ticker row is clicked, so the app can jump to its detail view in Kills & Intel. */
  onSelectKill: (killmailId: number) => void;
  /** Called with the selected system when its name is clicked, so the app can jump to its killboard in Kills & Intel. */
  onSelectSystem: (system: SystemSummary) => void;
  /** Logged-in characters, used to place home-base portrait pins. */
  characters: SessionCharacter[];
  /** Called with [origin, destination] when "Send Route to Gate Check" is
   * clicked, so the page shell can switch to the Gate Check sub-tab and
   * pre-fill/auto-run it against the same two endpoints - quickly checking
   * for camps along a route you're about to fly, not just planning it. */
  onSendRouteToGateCheck?: (systems: MapSystem[]) => void;
  /** Whether the page shell is currently rendering this component as a
   * full-viewport overlay (covering the sidebar, top bar, and the map
   * page's own header/tabs) instead of its normal place in the layout -
   * drives the toolbar's expand/collapse icon and title. */
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
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

function MapView({
  onSelectKill,
  onSelectSystem,
  characters,
  onSendRouteToGateCheck,
  isFullscreen,
  onToggleFullscreen,
}: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MapData | null>(null);
  const regionCentersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const constellationCentersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Rebuilding this ~8,000-entry lookup from scratch was happening on every
  // single animation frame (draw() runs at up to 60fps while a kill pulse
  // is active) even though the underlying system list only ever changes
  // once per load - cached here instead, alongside the other data-derived
  // lookups that already follow this pattern.
  const systemByIdRef = useRef<Map<number, MapSystem>>(new Map());
  const adjacencyRef = useRef<Map<number, number[]>>(new Map());
  // The last frame's on-screen system list, kept for hover hit-testing (see
  // pickSystem) - scanning only what's actually visible instead of every
  // system in New Eden (~8,000) on every single mousemove.
  const visibleSystemsRef = useRef<MapSystem[]>([]);
  // Jump-line geometry in raw data-space, bucketed by tier x security-tenth
  // (see the draw()-time comment where this is stroked) - built once here
  // instead of being rebuilt with fresh screen-space moveTo/lineTo calls on
  // every single animation frame, which was one of draw()'s most expensive
  // per-frame costs given New Eden's full stargate graph.
  const gateBucketPathsRef = useRef<Map<string, Path2D>>(new Map());
  // Each "focus" filter (FW / Sov / Incursion) gets its own line geometry,
  // parallel to gateBucketPathsRef above but split by "does this connection
  // touch a system relevant to this filter" - rebuilt (see
  // buildFocusGatePaths/rebuild*GatePaths) whenever that filter's own data
  // refreshes, since gateBucketPathsRef's single security-tiered path per
  // bucket has no way to selectively grey out just the non-relevant
  // segments without rebuilding it. The *GateBucketPathsRef half keeps the
  // normal per-tenth colors for relevant connections; the *DimmedGatePathsRef
  // half flattens every other connection into one grey path per
  // local/distant tier (no need for 11 separate grey buckets when they all
  // render in the same flat color). Kept as three independent pairs rather
  // than one merged "is this relevant to ANY active filter" set so multiple
  // filters can be on at once - draw() draws every active filter's dimmed
  // pass first and its colored pass after, so a connection relevant to any
  // one of them ends up colored regardless of what another filter's own
  // (unaware) dimmed pass painted first.
  const emptyFocusGatePaths = (): FocusGatePaths => ({ colored: new Map(), dimmed: { local: new Path2D(), distant: new Path2D() } });
  const fwGatePathsRef = useRef<FocusGatePaths>(emptyFocusGatePaths());
  const sovGatePathsRef = useRef<FocusGatePaths>(emptyFocusGatePaths());
  const incursionGatePathsRef = useRef<FocusGatePaths>(emptyFocusGatePaths());
  const glowSpriteCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const discSpriteCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // Not cleared on theme change like the two above - kill/traffic/NPC heat
  // colors are fixed constants (HEAT_COLOR_STOPS etc.), not theme-derived.
  const heatGlowSpriteCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // All constellation hull outlines merged into one Path2D, in data-space,
  // built once when the map loads - every hull shares the exact same
  // fill/stroke style, so they can all be drawn with a single fill()/
  // stroke() call per frame instead of a per-point screen-space rebuild
  // (moveTo/lineTo through toScreenX/Y for every hull, every frame) the
  // way this used to work.
  const constellationHullPathRef = useRef<Path2D>(new Path2D());
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
  // When the current selection was made - drives the reticle's brief
  // assemble-in animation (see drawSelectionReticle's call site), set
  // alongside every selectedIdRef assignment.
  const selectedAtRef = useRef(0);
  const hoveredIdRef = useRef<number | null>(null);
  const tickerHoveredIdRef = useRef<number | null>(null);
  const currentSystemIdRef = useRef<number | null>(null);
  const destinationIdRef = useRef<number | null>(null);
  const showServiceIconsRef = useRef(true);
  const showFwContestedRef = useRef(false);
  const fwSystemsRef = useRef<Map<number, FwSystemStatus>>(new Map());
  const showSovRef = useRef(false);
  const sovRef = useRef<Map<number, SovEntry>>(new Map());
  /** Alliance/corp logo images for the Sov filter's ownership badge, keyed
   * by alliance or corp id (EVE ids are unique across every entity type, so
   * one shared cache is safe) - loaded lazily the first time a given owner
   * is actually drawn, and reused for every other system that same owner
   * holds, rather than fetching the same logo once per system. */
  const sovLogoCacheRef = useRef<Map<number, HTMLImageElement>>(new Map());
  /** Resolved alliance/corp names for the Sov filter's hover tooltip, keyed
   * the same way as sovLogoCacheRef - populated in bulk (one resolve_names
   * call for every not-yet-cached owner) whenever the sovereignty map
   * refreshes, rather than resolving one name per hover, so the tooltip
   * appears instantly instead of waiting on a fetch. */
  const sovNamesRef = useRef<Map<number, string>>(new Map());
  /** Screen-space hit circles for every Sov ownership badge drawn on the
   * current frame, rebuilt each draw pass - same pattern as
   * renderedPinsRef, just for sov badges instead of character pins. */
  const renderedSovBadgesRef = useRef<{ px: number; py: number; radius: number; ownerId: number; kind: "alliance" | "corporation" }[]>([]);
  const showIncursionsRef = useRef(false);
  const incursionsRef = useRef<Map<number, IncursionSystem>>(new Map());
  const heatModeRef = useRef<HeatMode>("kills");
  const activityRef = useRef<Map<number, SystemActivityCounts>>(new Map());
  const homePinsBySystemRef = useRef<Map<number, CharacterPin[]>>(new Map());
  const locationPinsBySystemRef = useRef<Map<number, CharacterPin[]>>(new Map());
  /** Screen-space hit boxes for every home/location pin drawn on the current
   * frame, rebuilt each draw pass - lets hover detection tell "over this
   * character's marker" apart from "over the system dot" without redoing
   * the pin layout math a second time outside the render loop. */
  const renderedPinsRef = useRef<{ px: number; py: number; radius: number; character: SessionCharacter; kind: "home" | "location" }[]>([]);
  // Where each system's label actually landed this frame (if it landed at
  // all - a low-priority label can lose every anchor to collision and be
  // skipped entirely) - pickSystemForClick reads this instead of assuming
  // every label sits to a dot's right, now that collision placement can put
  // one above/left/below instead.
  const renderedLabelRectsRef = useRef<Map<number, LabelRect>>(new Map());
  const structuresBySystemRef = useRef<Map<number, PlayerStructureInfo[]>>(new Map());
  const heatMapRef = useRef<Map<number, SystemHeat>>(new Map());
  // When THIS client first observed each system's current mostRecentAt
  // value (not the kill's own timestamp - see the resync() comment where
  // this is populated for why the two can differ by a lot). The pulse
  // check below reads this instead of heatEntry.mostRecentAt directly.
  const heatFirstNoticedAtRef = useRef<Map<number, number>>(new Map());
  const animFrameRef = useRef<number | null>(null);
  const rafPulseIdRef = useRef<number | null>(null);
  // Whether any CURRENTLY VISIBLE system is actively pulsing, set once per
  // draw() by the main node loop below (which already checks this per
  // system for the dot-pulse itself, so tracking it here is free) - the
  // animation loop's own continuation checks read this instead of a
  // universe-wide "is anything recent" check, which is true almost
  // permanently (EVE has thousands of concurrent players, so some kill
  // somewhere in New Eden is essentially always "recent") and was keeping
  // the map redrawing at full display refresh rate nearly all the time
  // regardless of whether anything on screen was actually changing.
  const hasVisiblePulseRef = useRef(false);
  // Last frame's label-visibility decision - see the hysteresis comment
  // where this is read/written in draw().
  const showLabelsRef = useRef(false);
  // Checked once on mount and kept live via the media query's own change
  // event (an OS-level setting can change without a page reload) - every
  // pulseWave() call reads this so the kill/FW/sov breathing animations
  // hold at a steady, fully-visible state instead of oscillating when the
  // pilot has asked their OS for less motion.
  const prefersReducedMotionRef = useRef(
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => {
      prefersReducedMotionRef.current = query.matches;
      requestDraw();
    };
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // The mouse-event-handling effect below only re-runs when mapData changes
  // (see its dependency array), so reading pinnedHover state directly inside
  // handleMouseMove would see a stale, permanently-null closure - mirrored
  // here instead, updated at every setPinnedHover call site, matching how
  // selectedIdRef/hoveredIdRef already do this for the same reason.
  const pinnedHoverRef = useRef<HoverInfo | null>(null);
  /** A lightweight name tag shown while hovering a character's home or
   * live-location marker directly - separate from the system tooltip above
   * since it only needs to answer "whose pin is this", not show a
   * killboard. Hover-only (no pinning) since there's nothing inside it to
   * click. */
  const [pinHover, setPinHover] = useState<{ characterName: string; kind: "home" | "location"; clientX: number; clientY: number } | null>(null);
  const hoveredPinKeyRef = useRef<string | null>(null);
  /** Same idea as pinHover, for a Sov ownership badge - just the resolved
   * alliance/corp name and which kind it is, since that's the one thing
   * the badge's logo alone can't tell you. */
  const [sovHover, setSovHover] = useState<{ name: string; kind: "alliance" | "corporation"; clientX: number; clientY: number } | null>(null);
  const hoveredSovKeyRef = useRef<number | null>(null);
  // Tooltip DOM nodes, for moveTooltip below - repositioning a tooltip while
  // the mouse moves over the SAME target used to go through React state
  // (setXxxHover((prev) => ({...prev, clientX, clientY}))) on every single
  // mousemove, re-rendering this whole ~2,900-line component just to slide a
  // tooltip a few pixels. State still carries clientX/clientY for the
  // INITIAL position when a new target is first hovered (so the tooltip
  // mounts in the right place); every subsequent move to the same target
  // mutates the DOM directly through these refs instead.
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null);
  const pinTooltipRef = useRef<HTMLDivElement | null>(null);
  const sovTooltipRef = useRef<HTMLDivElement | null>(null);
  /** Premium-only "target lock" HUD - four bracket corners that snap onto
   * whatever system was just clicked, at the exact screen position of the
   * click (the same clientX/clientY the pinned tooltip above already
   * anchors to), then hold there highlighting the current selection. key
   * increments on every click so re-selecting the same system still
   * restarts the converge animation instead of it silently no-op'ing. */
  const [lockOn, setLockOn] = useState<{ clientX: number; clientY: number; key: number } | null>(null);
  const [topActivity, setTopActivity] = useState<TopActivity>({
    systems: [],
    regions: [],
  });
  // Collapsed by default - the ticker's own real estate is for the live
  // kill feed; Top Active is a real but secondary "last hour at a glance"
  // stat that doesn't need to permanently cost the feed its own height.
  const [topActivityOpen, setTopActivityOpen] = useState(false);
  /** Same data as heatMapRef, just in React state - the ref alone (updated
   * inside resync, read by the 150ms draw loop) doesn't trigger a re-render,
   * so the hover tooltip's reactive kill-count memo below needs its own
   * state copy to notice when a resync actually changes it. */
  const [systemHeat, setSystemHeat] = useState<Map<number, SystemHeat>>(new Map());
  const [homeSystemCount, setHomeSystemCount] = useState(0);
  const {
    legendOpen,
    setLegendOpen,
    showServiceIcons,
    setShowServiceIcons,
    showFwContested,
    setShowFwContested,
    showSov,
    setShowSov,
    showIncursions,
    setShowIncursions,
    heatMode,
    setHeatMode,
  } = useMapDisplayPrefs();
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
      // Cached sprites bake in the OLD theme's security colors - stale
      // once the palette changes, so they're dropped and lazily rebuilt
      // from the freshly-resolved colors above on the next draw().
      glowSpriteCacheRef.current.clear();
      discSpriteCacheRef.current.clear();
      requestDraw();
    }
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();
  const { alertKillIds, currentSystem, setCurrentSystem, radius, setRadius } = useLocationTracking();
  // A tracked friend's own death belongs in the same "surface this above
  // everything else" box as a nearby kill, regardless of where in New Eden
  // it happened - see proximityTickerKills below, which folds this into the
  // same feed rather than leaving it to show up wherever it falls in the
  // full general ticker underneath.
  const { entities: trackedEntities } = useTrackedEntities();
  const trackedCharacterIds = useMemo(
    () => new Set(trackedEntities.filter((e) => e.kind === "character").map((e) => e.entity_id)),
    [trackedEntities],
  );

  // Route planning - first piece of the map rewrite. Origin is whatever
  // useLocationTracking already treats as "my current system" (shared with
  // the rest of the app, not map-local state); destination is picked here.
  // The route itself is plain BFS over the same stargate graph the map
  // already renders (see findShortestRoute/adjacencyRef) - unweighted, same
  // "shortest" semantics as every other route-finding already in this
  // codebase, entirely client-side since the full jump graph is already
  // loaded for rendering.
  const [destinationSystem, setDestinationSystem] = useState<MapSystem | null>(null);
  const route = useMemo(() => {
    if (!currentSystem || !destinationSystem) return [];
    return findShortestRoute(currentSystem.id, destinationSystem.id, adjacencyRef.current);
    // mapData (not adjacencyRef itself, which isn't reactive) signals when
    // adjacencyRef.current has actually been freshly populated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSystem, destinationSystem, mapData]);
  const routeRef = useRef<number[]>([]);
  useEffect(() => {
    routeRef.current = route;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const regionsById = mapData ? new Map(mapData.regions.map((r) => [r.id, r.name])) : new Map<number, string>();

  // Escape exits fullscreen - the standard expectation for anything that
  // takes over the whole window, on top of the toolbar button itself.
  useEffect(() => {
    if (!isFullscreen || !onToggleFullscreen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onToggleFullscreen!();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, onToggleFullscreen]);

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
        constellationCentersRef.current = computeConstellationCenters(flipped.systems);
        systemByIdRef.current = new Map(flipped.systems.map((s) => [s.id, s]));
        adjacencyRef.current = buildAdjacency(flipped.jumps);

        const buckets = new Map<string, Path2D>();
        for (const jump of flipped.jumps) {
          const a = systemByIdRef.current.get(jump.from);
          const b = systemByIdRef.current.get(jump.to);
          if (!a || !b) continue;
          const isLocal = a.constellation_id === b.constellation_id;
          const secTenth = clamp(Math.round(a.security * 10), 0, 10);
          const key = `${isLocal ? "s" : "d"}${secTenth}`;
          let path = buckets.get(key);
          if (!path) {
            path = new Path2D();
            buckets.set(key, path);
          }
          path.moveTo(a.x, a.y);
          path.lineTo(b.x, b.y);
        }
        gateBucketPathsRef.current = buckets;
        const hullPath = new Path2D();
        for (const hull of computeConstellationHulls(flipped.systems).values()) {
          if (hull.length < 3) continue;
          hullPath.moveTo(hull[0].x, hull[0].y);
          for (let i = 1; i < hull.length; i++) hullPath.lineTo(hull[i].x, hull[i].y);
          hullPath.closePath();
        }
        constellationHullPathRef.current = hullPath;
        systemIconsRef.current = computeSystemIcons(flipped);
        // In case FW data (see resync()'s getFwSystems call) already arrived
        // before the jump graph did - rebuildFwGatePaths no-ops until both
        // are ready, so whichever of the two loads second is what actually
        // triggers the real build.
        rebuildFwGatePaths();
        rebuildSovGatePaths();
        rebuildIncursionGatePaths();
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
    if (
      animFrameRef.current === null &&
      ([...heatMapRef.current.keys()].some(
        (systemId) => Date.now() - (heatFirstNoticedAtRef.current.get(systemId) ?? 0) < PULSE_ANIMATION_MS,
      ) ||
        (selectedIdRef.current != null && !prefersReducedMotionRef.current && Date.now() - selectedAtRef.current < 150))
    ) {
      ensureAnimating();
    }

    // Capped rather than using the display's real devicePixelRatio directly
    // - on a 4K+ monitor that can mean an enormous canvas backing store
    // (e.g. 2x DPR at 4K is ~33M pixels per redraw), and the extra sharpness
    // past 1.5x is barely perceptible on a map that's mostly thin lines and
    // small dots anyway.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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

    // Hysteresis around the label/system-detail threshold - without it, a
    // zoom value hovering right at LABEL_ZOOM_RATIO (a mouse wheel's natural
    // resting point when zooming in/out by hand) flips every dependent
    // effect (labels, constellation hulls, the background watermark, sov
    // logos) on and off every other frame. Once shown, needs a real 15%
    // zoom-out to hide again; once hidden, needs the full normal threshold
    // to show - a single computed boolean instead of the 5 separate
    // `zoomRatio >= LABEL_ZOOM_RATIO` checks below re-deciding independently
    // (and potentially inconsistently with each other) every frame.
    const showLabels = showLabelsRef.current
      ? zoomRatio >= LABEL_ZOOM_RATIO * 0.85
      : zoomRatio >= LABEL_ZOOM_RATIO;
    showLabelsRef.current = showLabels;

    const systemById = systemByIdRef.current;

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
    const {
      inkColor,
      accentHex,
      accentRgb,
      dangerRgb,
      gateRgb,
      gateHex,
      homeRoofBg,
      homeBodyBg,
      mutedRgb,
      mutedHex,
      securityHexByTenth,
      securityRgbByTenth,
    } = themeColorsRef.current;
    // Dark-on-light reads far fainter than the equivalent light-on-dark at
    // the same alpha (the original 0.08/0.75/0.85 numbers were tuned by eye
    // against the dark theme's near-black canvas) - low enough on Light that
    // the jump lines and region label sat right at the edge of visibility,
    // making ordinary redraw/antialiasing jitter during mouse movement read
    // as actual flicker. Bumped for Light specifically rather than changing
    // the numbers everyone else already looks right at.
    const isLightTheme = document.documentElement.dataset.theme === "light";
    const nameLabelAlpha = isLightTheme ? 0.92 : 0.75;
    const regionLabelAlpha = isLightTheme ? 1 : 0.85;

    // Background region/constellation watermark - the in-game 2D map keeps
    // "where you are" spelled out big and faint behind the systems even
    // zoomed in close enough to read individual system names (see the real
    // Sinq Laison reference: "SINQ LAISON" wide-tracked across the middle,
    // a small italic "Algintal" constellation name above it) rather than
    // only showing a region name as a fallback once zoomed too far out for
    // system labels. Anchored on the region/constellation nearest the
    // viewport's own center, not a fixed geometric centroid that could sit
    // far outside the current view - and drawn here, before every other
    // layer, so lines/nodes/labels all paint over it exactly like the
    // reference's own layering.
    if (showLabels && data.regions.length > 0) {
      const viewCenterX = (dataMinX + dataMaxX) / 2;
      const viewCenterY = (dataMinY + dataMaxY) / 2;
      const regionId = nearestCenterId(regionCentersRef.current, viewCenterX, viewCenterY);
      const constellationId = nearestCenterId(constellationCentersRef.current, viewCenterX, viewCenterY);
      const regionName = regionId != null ? data.regions.find((r) => r.id === regionId)?.name : null;
      const constellationName = constellationId != null ? data.constellations.find((c) => c.id === constellationId)?.name : null;
      const cx = width / 2;
      const cy = height / 2;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (constellationName) {
        ctx.font = `italic 500 13px Inter, sans-serif`;
        ctx.fillStyle = inkColor;
        ctx.globalAlpha = (isLightTheme ? 0.4 : 0.32) * regionLabelAlpha;
        ctx.fillText(constellationName, cx, cy - 34);
      }
      if (regionName) {
        ctx.font = `600 26px Inter, sans-serif`;
        ctx.fillStyle = inkColor;
        ctx.globalAlpha = (isLightTheme ? 0.16 : 0.12) * regionLabelAlpha;
        ctx.fillText(letterSpaced(regionName), cx, cy);
      }
      ctx.restore();
    }

    // Colored by security tier (matching the in-game 2D map exactly) rather
    // than a flat grey ink wash - solid lines for tight, same-constellation
    // links, small round dots for every longer haul (same-region or
    // cross-region collapsed into one dotted tier, matching the reference:
    // the game doesn't visually distinguish those two, it's just "local
    // cluster" vs "everything else"). The paths themselves are cached once,
    // in data-space, when the map loads (see gateBucketPathsRef) rather than
    // rebuilt with fresh screen-space moveTo/lineTo calls every frame -
    // drawn here through a temporary transform instead, so pan/zoom is just
    // a matrix change, not a full re-walk of New Eden's stargate graph.
    // lineWidth/dash lengths are divided by scale to compensate, since
    // they're interpreted in the transform's own coordinate space once it's
    // applied, not screen pixels.
    const localLineAlpha = isLightTheme ? 0.62 : 0.5;
    const distantLineAlpha = isLightTheme ? 0.48 : 0.36;
    // Every currently-active "focus" filter's own geometry (see
    // buildFocusGatePaths/*GatePathsRef) - empty when nothing is toggled on,
    // in which case the plain security-tiered gateBucketPathsRef below draws
    // exactly as it always has.
    const activeFocusPaths: FocusGatePaths[] = [];
    if (showFwContestedRef.current) activeFocusPaths.push(fwGatePathsRef.current);
    if (showSovRef.current) activeFocusPaths.push(sovGatePathsRef.current);
    if (showIncursionsRef.current) activeFocusPaths.push(incursionGatePathsRef.current);
    const focusActive = activeFocusPaths.length > 0;
    ctx.save();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * translateX, dpr * translateY);
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([]);
    ctx.globalAlpha = localLineAlpha;
    if (focusActive) {
      // Every dimmed pass first, so a connection any ONE active filter
      // considers relevant - drawn in its real color in the colored pass
      // below - always ends up on top, even though each filter's own
      // dimmed pass has no idea another filter thinks this connection
      // matters.
      ctx.strokeStyle = mutedHex;
      for (const paths of activeFocusPaths) ctx.stroke(paths.dimmed.local);
      for (const paths of activeFocusPaths) {
        for (const [key, path] of paths.colored) {
          if (key[0] !== "s") continue;
          ctx.strokeStyle = securityHexByTenth[Number(key.slice(1))];
          ctx.stroke(path);
        }
      }
    } else {
      for (const [key, path] of gateBucketPathsRef.current) {
        if (key[0] !== "s") continue;
        ctx.strokeStyle = securityHexByTenth[Number(key.slice(1))];
        ctx.stroke(path);
      }
    }
    // Round-capped near-zero dashes draw as small dots rather than short
    // dashes - the dense, colored dotted haze of long-haul connections is
    // most of what makes the in-game map read as "busy but clean" instead
    // of empty space.
    ctx.lineCap = "round";
    ctx.lineWidth = 1.6 / scale;
    ctx.setLineDash([0.1 / scale, 6 / scale]);
    ctx.globalAlpha = distantLineAlpha;
    if (focusActive) {
      ctx.strokeStyle = mutedHex;
      for (const paths of activeFocusPaths) ctx.stroke(paths.dimmed.distant);
      for (const paths of activeFocusPaths) {
        for (const [key, path] of paths.colored) {
          if (key[0] !== "d") continue;
          ctx.strokeStyle = securityHexByTenth[Number(key.slice(1))];
          ctx.stroke(path);
        }
      }
    } else {
      for (const [key, path] of gateBucketPathsRef.current) {
        if (key[0] !== "d") continue;
        ctx.strokeStyle = securityHexByTenth[Number(key.slice(1))];
        ctx.stroke(path);
      }
    }
    ctx.restore();

    // Active route - the first piece of the map rewrite, independent of the
    // colored-vs-neutral connections debate: drawn as the single boldest
    // line on the canvas so it reads as "the answer" over the busy
    // backdrop, matching every other map/nav tool's own convention for an
    // active route regardless of how the base geography is styled.
    if (routeRef.current.length > 1) {
      const routePath = new Path2D();
      let started = false;
      for (const systemId of routeRef.current) {
        const system = systemById.get(systemId);
        if (!system) continue;
        const sx = toScreenX(system.x);
        const sy = toScreenY(system.y);
        if (!started) {
          routePath.moveTo(sx, sy);
          started = true;
        } else {
          routePath.lineTo(sx, sy);
        }
      }
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = accentHex;
      ctx.stroke(routePath);
      ctx.lineCap = "butt";
      ctx.globalAlpha = 1;
    }

    // Constellation boundaries - a faint hull behind everything else, only
    // once zoomed in enough that individual systems (not just region names)
    // are visible, so it reads as texture/wayfinding rather than clutter at
    // the whole-region view where it'd just be noise on top of noise. One
    // cached data-space Path2D covering every constellation (built on load,
    // see constellationHullPathRef), drawn through a temporary transform -
    // same technique as the jump lines above, replacing a per-point
    // screen-space rebuild of ~1,150 hulls every single frame.
    if (showLabels) {
      ctx.save();
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * translateX, dpr * translateY);
      ctx.fillStyle = `rgba(${accentRgb}, 0.035)`;
      ctx.fill(constellationHullPathRef.current);
      ctx.strokeStyle = `rgba(${accentRgb}, 0.16)`;
      ctx.lineWidth = 1 / scale;
      ctx.stroke(constellationHullPathRef.current);
      ctx.restore();
    }

    const dotRadius = Math.min(6, Math.max(1.4, 1.4 * Math.sqrt(zoomRatio)));
    const now = Date.now();

    // Whether ANY "focus" filter (FW / Sov / Incursion) is on - hoisted up
    // here (not just computed per-system below) because the heat glow block
    // right below needs it too. Under an active filter, color alone should
    // mark what's relevant (see the per-system dimming logic further down);
    // the heat/traffic/NPC glow is a real, useful, but entirely UNRELATED
    // signal ("where's the action"), and it happens to often coincide with
    // owned/contested space (that's where the fighting is) - which reads as
    // "some relevant systems have this decoration and others don't" rather
    // than the intended "grey vs color is the only distinction". So it's
    // suppressed the same way the per-system security glow is, whenever a
    // filter is active, and both come back exactly as before once it's off.
    const isFocusFilterActive = showFwContestedRef.current || showSovRef.current || showIncursionsRef.current;

    // Persistent heat: a soft glow plus two concentric rings, colored along
    // the classic dim-red -> red -> orange -> yellow ramp EVE's own old
    // in-game kill heatmap used (see heatColor), brightening continuously
    // with kill count rather than capping out after half a dozen kills -
    // so a system that's been busy over the last hour still visibly stands
    // out even between pings ("what to avoid", not just "what just
    // happened"), and a genuinely hot system (dozens/hundreds of kills)
    // reads as unmistakably hotter than a system with just one or two.
    // Only actively pulses (both brightness and size) while a kill has
    // landed there in the last PULSE_ANIMATION_MS - older-but-still-within-
    // the-hour heat holds rock steady instead, so "fighting right now" and
    // "was busy a while ago" read as visibly different states, not the
    // same static glow. draw() keeps re-running every animation frame
    // while anything is actively pulsing (see ensureAnimating below).
    if (isFocusFilterActive) {
      // Skip both heat-glow branches below entirely.
    } else if (heatModeRef.current === "kills") {
      for (const [systemId, entry] of heatMapRef.current) {
        if (entry.count <= 0) continue;
        const system = systemById.get(systemId);
        if (!system || !inView(system.x, system.y)) continue;
        const sx = toScreenX(system.x);
        const sy = toScreenY(system.y);

        const intensity = heatIntensity(entry.count);
        // Purely a function of kill count - no pulse/wave here at all. Only
        // the system dot itself (drawn later below) pulses; the heat glow is
        // a steady "how hot has this system been" read that never animates.
        const glowRadius = dotRadius * (4.5 + intensity * 11);
        const sprite = getHeatGlowSprite(heatGlowSpriteCacheRef.current, "kill", intensity, HEAT_COLOR_STOPS);
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.drawImage(sprite, sx - glowRadius, sy - glowRadius, glowRadius * 2, glowRadius * 2);
        ctx.restore();
      }
    } else {
      // Traffic (ship jumps) / NPC Activity modes - same glow technique as
      // the kill heat above, just a different data source, divisor (see
      // TRAFFIC_INTENSITY_DIVISOR/NPC_INTENSITY_DIVISOR's own comments for
      // why jump counts need a much wider one), and color ramp, so no mode
      // is ever visually confusable with another. No pulse/dot-level
      // reactivity here - VESPER has no live jump/NPC-kill feed the way it
      // does for player kills, only this last-hour aggregate.
      const divisor = heatModeRef.current === "traffic" ? TRAFFIC_INTENSITY_DIVISOR : NPC_INTENSITY_DIVISOR;
      const stops = heatModeRef.current === "traffic" ? TRAFFIC_COLOR_STOPS : NPC_COLOR_STOPS;
      for (const entry of activityRef.current.values()) {
        const count = heatModeRef.current === "traffic" ? entry.ship_jumps : entry.npc_kills;
        if (count <= 0) continue;
        const system = systemById.get(entry.system_id);
        if (!system || !inView(system.x, system.y)) continue;
        const sx = toScreenX(system.x);
        const sy = toScreenY(system.y);

        const intensity = heatIntensity(count, divisor);
        const glowRadius = dotRadius * (4.5 + intensity * 11);
        const sprite = getHeatGlowSprite(heatGlowSpriteCacheRef.current, heatModeRef.current, intensity, stops);
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.drawImage(sprite, sx - glowRadius, sy - glowRadius, glowRadius * 2, glowRadius * 2);
        ctx.restore();
      }
    }

    renderedPinsRef.current = [];
    renderedSovBadgesRef.current = [];

    const visible: MapSystem[] = [];
    for (const system of data.systems) {
      if (inView(system.x, system.y)) visible.push(system);
    }
    visibleSystemsRef.current = visible;
    // A soft glow behind every node's ring (see below) reads great at a
    // constellation/region view but adds a radial gradient per system - skip
    // it past this many on screen at once (a whole-cluster/full-universe
    // zoom-out, where individual glows wouldn't be legible at that density
    // anyway) so panning around a busy area of space never drops frames.
    const showGlow = visible.length <= GLOW_MAX_VISIBLE;
    let anyVisiblePulse = false;

    for (const system of visible) {
      const sx = toScreenX(system.x);
      const sy = toScreenY(system.y);
      const isSelected = system.id === selectedIdRef.current;
      const isHovered = !isSelected && system.id === hoveredIdRef.current;
      const isTickerHovered = system.id === tickerHoveredIdRef.current;
      const isCurrentLocation = system.id === currentSystemIdRef.current;
      const isDestination = system.id === destinationIdRef.current;
      const heatEntryForDot = heatMapRef.current.get(system.id);
      const heatBump = heatIntensity(heatEntryForDot?.count ?? 0) * 3.4;
      // The dot itself pulses too while a kill's actively landing here -
      // fading from fully transparent back up to its real security color,
      // not swapping color, so "which system is this" (security status)
      // never gets lost underneath "something's happening here right now".
      // Same now/systemId pulse as the glow above, so they breathe together.
      // Keyed off heatFirstNoticedAtRef (when THIS client first saw this
      // kill), not heatEntryForDot.mostRecentAt (the kill's own timestamp,
      // which can already be a minute or more old by the time the
      // killmail.stream/zKillboard enrichment pipeline delivers it) - see
      // resync()'s own comment for why the two can differ so much.
      const isDotActive =
        heatEntryForDot != null && now - (heatFirstNoticedAtRef.current.get(system.id) ?? 0) < PULSE_ANIMATION_MS;
      // Reduced motion means there's nothing left to animate frame-to-frame
      // (pulseWave holds steady at 1 throughout) - the continuous redraw
      // loop can stay off entirely rather than spinning at full refresh
      // rate to redraw an unchanging steady state.
      if (isDotActive && !prefersReducedMotionRef.current) anyVisiblePulse = true;
      // Keeps the loop alive just long enough for the selection reticle's
      // brief assemble-in animation (see drawSelectionReticle) to actually
      // play, rather than only ever redrawing on the next unrelated event.
      if (isSelected && !prefersReducedMotionRef.current && now - selectedAtRef.current < 150) anyVisiblePulse = true;
      const dotAlpha = isDotActive ? pulseWave(now, system.id, 0.04, prefersReducedMotionRef.current) : 1;
      const baseRadius =
        (isSelected ? dotRadius * 2.2 : isCurrentLocation ? dotRadius * 2 : isHovered ? dotRadius * 1.7 : dotRadius) + heatBump;
      const secTenth = clamp(Math.round(system.security * 10), 0, 10);
      // "Focus" filters (FW / Sov / Incursion): with any of them on,
      // everything that isn't relevant to at least one active one fades to
      // a flat neutral grey, the same "grey out what doesn't matter right
      // now" treatment EVE's own client uses for its FW map - a system's
      // normal security color is real information, but with ~5,000 of them
      // lit up at once it drowns out the handful of systems a given filter
      // exists to show. Two or more active at once compose with OR - a
      // system relevant to any one of them stays lit. -1 is a sprite-cache
      // key that can never collide with a real security tenth (0-10), so
      // the grey sprite gets built once and reused for every dimmed system
      // regardless of its actual security.
      const isFwFilterOn = showFwContestedRef.current;
      const isSovFilterOn = showSovRef.current;
      const isIncursionFilterOn = showIncursionsRef.current;
      const isFocusRelevant =
        (isFwFilterOn && fwSystemsRef.current.has(system.id)) ||
        (isSovFilterOn && hasSovOwner(sovRef.current.get(system.id))) ||
        (isIncursionFilterOn && incursionsRef.current.has(system.id));
      const focusDimmed = isFocusFilterActive && !isFocusRelevant;
      const spriteKey = focusDimmed ? -1 : secTenth;
      const secHex = focusDimmed ? mutedHex : securityHexByTenth[secTenth];
      const secRgb = focusDimmed ? mutedRgb : securityRgbByTenth[secTenth];

      // Soft halo behind the node - the in-game 2D map's systems read as
      // glowing points of light, not flat dots, and this is the cheap
      // Canvas2D approximation of that (a real bloom pass needs WebGL).
      // Skipped entirely (for BOTH dimmed and undimmed systems) while any
      // focus filter is active - not just for dimmed ones. A relevant
      // system's own glow radius (baseRadius * 2.1) is over double the dot
      // itself, and with many relevant systems packed into one cluster
      // (e.g. a whole sov-owned null-sec region) their overlapping glows
      // compound into a big blob of circles - while dimmed neighbors right
      // next to them render as plain small dots with no glow at all, since
      // dimming already skips it. That asymmetry reads as "some systems
      // arbitrarily got extra decoration" rather than the intended "color
      // alone marks what's relevant" - so under a filter, glow is off for
      // everyone and color is the only thing doing the work.
      if (showGlow && !isFocusFilterActive) {
        const glowRadius = baseRadius * 2.1;
        const sprite = getGlowSprite(glowSpriteCacheRef.current, spriteKey, secRgb);
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = dotAlpha;
        ctx.drawImage(sprite, sx - glowRadius, sy - glowRadius, glowRadius * 2, glowRadius * 2);
        ctx.restore();
      }

      // The node itself: a dim glassy disc (radial gradient, darker at the
      // center than the rim) inside a crisp full-brightness security-colour
      // ring - closer to the in-game 2D map's "glowing ring" nodes than a
      // single flat fill, while every existing pulse/selection/hover state
      // still layers on top exactly as before. Same pre-rendered-sprite
      // technique as the glow halo above (one per security tenth, blitted
      // and scaled) instead of a fresh createRadialGradient per system per
      // frame - this was the one gradient the earlier glow-sprite pass
      // missed, and it ran for every visible node, not just glowing ones.
      const discSprite = getDiscSprite(discSpriteCacheRef.current, spriteKey, secRgb);
      ctx.globalAlpha = dotAlpha;
      ctx.drawImage(discSprite, sx - baseRadius, sy - baseRadius, baseRadius * 2, baseRadius * 2);
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(sx, sy, baseRadius, 0, Math.PI * 2);
      ctx.strokeStyle = secHex;
      ctx.globalAlpha = dotAlpha;
      ctx.lineWidth = isCurrentLocation ? 2 : 1.3;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Selected gets its own dedicated ring via the targeting reticle
      // below instead of sharing this plain one with hover.
      if (isHovered && !isSelected) {
        ctx.beginPath();
        ctx.arc(sx, sy, baseRadius + 2, 0, Math.PI * 2);
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
        const borderWave = pulseWave(now, system.id, 0.15, prefersReducedMotionRef.current);
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

      // Sovereignty ownership - a static (non-pulsing) filled halo colored
      // by whichever alliance/corp holds it, a deterministic hash color
      // rather than a fixed palette since there's no small fixed set of
      // null-sec owners the way there are only 4 FW factions. Sits at a
      // slightly bigger radius than the FW ring above so the two never
      // visually collide on the rare system that somehow has both.
      if (showSovRef.current) {
        const sov = sovRef.current.get(system.id);
        const ownerId = sov?.alliance_id ?? sov?.corporation_id;
        if (ownerId) {
          // No plain ownership ring here any more - with the dimming above,
          // an undimmed dot under the Sov filter already means "this is
          // owned", the same way an undimmed FW system needs no ring of its
          // own. sovColor still names the owner for the logo/tracked-ring
          // below, which say WHO and WHICH owner respectively - real info
          // dimming alone can't carry.
          const sovColor = colorForId(ownerId);

          // The owner's actual alliance/corp logo, not just the hashed
          // ring color - "who" instead of just "someone consistent holds
          // this". Only gated behind the same zoom threshold labels use
          // (not the ring above, which stays visible at any zoom) since a
          // sov-heavy region can have dozens of owners on screen at once,
          // and fetching every one of their logos zoomed all the way out
          // across New Eden would be pure waste. Offset to the dot's
          // upper-left so it never collides with the home marker
          // (upper-right) or live location portrait (lower-right).
          if (showLabels) {
            const isAlliance = sov!.alliance_id != null;
            const logoUrl = isAlliance ? allianceLogoUrl(sov!.alliance_id!) : corpLogoUrl(sov!.corporation_id!);
            const logo = getSovLogo(sovLogoCacheRef.current, ownerId, logoUrl, requestDraw);
            const logoRadius = sovLogoRadiusForZoom(zoomRatio);
            const logoX = sx - dotRadius - logoRadius - 3;
            const logoY = sy - dotRadius - logoRadius - 3;
            drawPortrait(ctx, logoX, logoY, logoRadius, logo, sovColor);
            renderedSovBadgesRef.current.push({ px: logoX, py: logoY, radius: logoRadius, ownerId, kind: isAlliance ? "alliance" : "corporation" });
          }

          // No tracked-alliance ring or structure-vulnerability pulse ring
          // here any more either - both used the same "extra ring on top of
          // the dot" language as the ownership/FW/incursion rings already
          // removed, and at any moment a real, large fraction of all null-
          // sec structures can be inside their (multi-hour-long) real
          // vulnerability window simultaneously - confirmed live: 561 of
          // 2712 structures right now - which turned the pulse into a wall
          // of overlapping rings across whole regions, not a rare callout.
        }
      }


      // The tracked "current location" marker - an actual pin, always drawn
      // (not gated by hover/zoom like the rings above) so it's visible at a
      // glance no matter where on the map you're looking, and immediately
      // jumps to the new system the moment the location changes (see the
      // currentSystemIdRef effect below).
      if (isCurrentLocation) {
        // A warm bloom behind the ring - always drawn regardless of
        // showGlow, since there's only ever one of these on screen at once,
        // matching the soft white/gold halo the in-game 2D map puts on
        // wherever your ship actually is.
        const haloRadius = baseRadius * 6.5;
        const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, haloRadius);
        halo.addColorStop(0, `rgba(${gateRgb}, 0.32)`);
        halo.addColorStop(0.4, `rgba(${gateRgb}, 0.1)`);
        halo.addColorStop(1, `rgba(${gateRgb}, 0)`);
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(sx, sy, haloRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${gateRgb}, 0.6)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        drawPin(ctx, sx, sy - dotRadius * 2 - 3, 7, gateHex);
      }

      // The route destination - same accent color as the route line itself
      // so the two read as one connected idea ("this line leads here"), a
      // distinct ring shape (square-ish flag ring, not the current-location
      // pin's rounded halo) so the two markers are never confused even when
      // a destination and the current location happen to be the same
      // system briefly mid-route-edit.
      if (isDestination) {
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.strokeStyle = accentHex;
        ctx.lineWidth = 2;
        ctx.stroke();
        drawPin(ctx, sx, sy - dotRadius * 2 - 3, 7, accentHex);
      }

      // A targeting reticle (not a pin) for the selected system - with
      // current-location, home-base, and destination all using pin shapes
      // now, "selected" needs its own distinct silhouette rather than a
      // fourth pin in a different color.
      if (isSelected) {
        const selectionProgress = prefersReducedMotionRef.current
          ? 1
          : 1 - Math.pow(1 - clamp((now - selectedAtRef.current) / 150, 0, 1), 3);
        drawSelectionReticle(ctx, sx, sy, baseRadius + 2, inkColor, selectionProgress);
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
    hasVisiblePulseRef.current = anyVisiblePulse;

    if (showLabels) {
      const { fontSize: labelFontSize, gap: labelGap } = labelMetricsForZoom(zoomRatio);
      const labelHeight = labelFontSize * 1.2;

      // Priority-ordered collision placement, replacing the old all-or-
      // nothing "hide every label past LABEL_MAX_VISIBLE systems on
      // screen" cutoff - the most important systems (selected, your
      // destination, current location, on your active route, hovered) now
      // always claim a label first and try 4 anchor sides around their dot
      // before giving up, so a busy cluster drops its least important
      // labels instead of losing every label at once, including the one
      // you're actually looking for. Same cap as before on how many
      // candidates are even attempted, to keep worst-case collision-testing
      // cost bounded regardless of how zoomed out the view is.
      const routeSet = routeRef.current.length > 1 ? new Set(routeRef.current) : null;
      const candidates = visible.map((system) => {
        let priority = 100;
        if (heatMapRef.current.get(system.id)?.count) priority = 500;
        if (routeSet?.has(system.id)) priority = 800;
        if (system.id === tickerHoveredIdRef.current || system.id === hoveredIdRef.current) priority = 650;
        if (system.id === currentSystemIdRef.current) priority = 900;
        if (system.id === destinationIdRef.current) priority = 950;
        if (system.id === selectedIdRef.current) priority = 1000;
        return { system, priority };
      });
      candidates.sort((a, b) => b.priority - a.priority);

      const placedRects: LabelRect[] = [];
      const acceptedRects = new Map<number, LabelRect>();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      let attempted = 0;
      for (const { system } of candidates) {
        if (attempted >= LABEL_MAX_VISIBLE) break;
        attempted++;

        const sx = toScreenX(system.x);
        const sy = toScreenY(system.y);
        const secText = formatSecurity(system.security);
        ctx.font = `600 ${labelFontSize}px Inter, sans-serif`;
        const secWidth = ctx.measureText(secText).width;
        ctx.font = `${labelFontSize}px Inter, sans-serif`;
        const nameWidth = ctx.measureText(system.name).width;
        const labelWidth = secWidth + labelGap + nameWidth;

        let placement: { textX: number; textY: number; rect: LabelRect } | null = null;
        for (const side of LABEL_ANCHOR_SIDES) {
          const candidate = labelRectForSide(side, sx, sy, dotRadius, labelGap, labelWidth, labelHeight);
          if (!placedRects.some((p) => rectsOverlap(p, candidate.rect))) {
            placement = candidate;
            break;
          }
        }

        // Kill count inside the dot itself, matching the real in-game
        // starmap's big colored "pip with a number in it" once you're
        // zoomed in close enough to read it - drawn regardless of whether
        // this system's label found room, since it's anchored to the dot
        // itself, not to the label.
        const heatEntry = heatMapRef.current.get(system.id);
        if (heatEntry && heatEntry.count > 0) {
          const numFontSize = Math.max(11, labelFontSize * 0.95);
          const [hr, hg, hb] = heatColor(heatIntensity(heatEntry.count));
          const text = String(heatEntry.count);
          ctx.font = `700 ${numFontSize}px Inter, sans-serif`;
          const textWidth = ctx.measureText(text).width;
          const pipRadius = Math.max(dotRadius + 5, textWidth / 2 + 5);

          ctx.beginPath();
          ctx.arc(sx, sy, pipRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
          ctx.fill();
          ctx.strokeStyle = "rgba(10, 8, 8, 0.55)";
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.textAlign = "center";
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "rgba(10, 8, 8, 0.85)";
          ctx.strokeText(text, sx, sy + 0.5);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(text, sx, sy + 0.5);
          ctx.textAlign = "left";
        }

        // No anchor had room - this label loses out to higher-priority
        // neighbors this frame. The dot, ring, and heat pip above still
        // render; only the name/security text and its icon row are skipped.
        if (!placement) continue;
        placedRects.push(placement.rect);
        acceptedRects.set(system.id, placement.rect);

        ctx.font = `600 ${labelFontSize}px Inter, sans-serif`;
        ctx.fillStyle = securityHexByTenth[clamp(Math.round(system.security * 10), 0, 10)];
        ctx.fillText(secText, placement.textX, placement.textY);

        ctx.font = `${labelFontSize}px Inter, sans-serif`;
        ctx.fillStyle = inkColor;
        ctx.globalAlpha = nameLabelAlpha;
        ctx.fillText(system.name, placement.textX + secWidth + labelGap, placement.textY);
        ctx.globalAlpha = 1;

        // DOTLAN-style key icons (Refinery/Factory/Cloning/etc) - a row of
        // small colored squares under the name, same region-level-or-closer
        // gate as the labels themselves. Player structures join the same
        // row here (rather than their own always-visible marker) so they
        // only ever show at the same zoom level as everything else in it.
        // Always tucked under the label's own text start regardless of
        // which side it landed on, so the icon row never drifts away from
        // the name it belongs to.
        const baseIcons = systemIconsRef.current.get(system.id);
        const hasPlayerStructures = structuresBySystemRef.current.has(system.id);
        const icons = hasPlayerStructures ? [...(baseIcons ?? []), PLAYER_STRUCTURE_ICON] : baseIcons;
        if (showServiceIconsRef.current && icons && icons.length > 0) {
          // Bigger baseline than the label text itself (not a fraction of
          // it) and keeps growing at the same rate as zoom increases, so the
          // icons stay legible rather than staying small and cramped.
          const iconSize = Math.max(13, labelFontSize * 1.15);
          const iconGap = Math.max(2, iconSize * 0.18);
          const iconY = placement.textY + labelFontSize * 0.85;
          let iconX = placement.textX;
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
      }
      renderedLabelRectsRef.current = acceptedRects;
    } else {
      // No system labels at this zoom - clear so pickSystemForClick doesn't
      // hit-test against stale rectangles from the last time labels showed.
      if (renderedLabelRectsRef.current.size > 0) renderedLabelRectsRef.current = new Map();
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
        draw();
        // Viewport-aware, not a universe-wide check - see
        // hasVisiblePulseRef's own comment for why that check almost never
        // returns false and was keeping this loop running near-permanently.
        if (!hasVisiblePulseRef.current) {
          window.clearInterval(animFrameRef.current!);
          animFrameRef.current = null;
        }
      }, 150);
    }

    if (rafPulseIdRef.current === null) {
      const tick = () => {
        draw();
        if (hasVisiblePulseRef.current) {
          rafPulseIdRef.current = requestAnimationFrame(tick);
        } else {
          rafPulseIdRef.current = null;
        }
      };
      rafPulseIdRef.current = requestAnimationFrame(tick);
    }
  }

  /** Rebuilds one "focus" filter's own line geometry (see fwGatePathsRef/
   * sovGatePathsRef/incursionGatePathsRef) from the current jump graph and
   * that filter's own relevant-system set - called whenever that filter's
   * data refreshes (see resync() below), not every frame, the same "cache
   * the geometry, redraw from the cache" approach gateBucketPathsRef itself
   * uses. A no-op if the jump graph hasn't loaded yet; the next refresh
   * will pick it up. */
  function rebuildFwGatePaths() {
    const data = dataRef.current;
    const systemById = systemByIdRef.current;
    if (!data || systemById.size === 0) return;
    fwGatePathsRef.current = buildFocusGatePaths(systemById, data.jumps, (id) => fwSystemsRef.current.has(id));
  }

  function rebuildSovGatePaths() {
    const data = dataRef.current;
    const systemById = systemByIdRef.current;
    if (!data || systemById.size === 0) return;
    sovGatePathsRef.current = buildFocusGatePaths(systemById, data.jumps, (id) => hasSovOwner(sovRef.current.get(id)));
  }

  function rebuildIncursionGatePaths() {
    const data = dataRef.current;
    const systemById = systemByIdRef.current;
    if (!data || systemById.size === 0) return;
    incursionGatePathsRef.current = buildFocusGatePaths(systemById, data.jumps, (id) => incursionsRef.current.has(id));
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
        // The pulse can't reliably key off a kill's own timestamp - a
        // killmail has to be reported, fetched, and enriched by
        // killmail.stream/zKillboard before it ever reaches this app, and
        // that pipeline's own delay (confirmed live: routinely 50+ seconds,
        // sometimes much more) already ate most or all of a short pulse
        // window before the data even arrived. Tracked here instead: the
        // first time THIS client sees a given mostRecentAt value for a
        // system (i.e. it differs from what the PREVIOUS heat map had),
        // that's when its pulse clock actually starts, so the window
        // always has its full length available regardless of how stale
        // the kill was by the time it got here.
        const previousHeatMap = heatMapRef.current;
        for (const [systemId, entry] of nextHeatMap) {
          if (previousHeatMap.get(systemId)?.mostRecentAt !== entry.mostRecentAt) {
            heatFirstNoticedAtRef.current.set(systemId, now);
          }
        }
        heatMapRef.current = nextHeatMap;
        setSystemHeat(nextHeatMap);
        if ([...nextHeatMap.keys()].some((systemId) => now - (heatFirstNoticedAtRef.current.get(systemId) ?? 0) < PULSE_ANIMATION_MS)) {
          ensureAnimating();
        }
        setTopActivity(computeTopActivity(heat));
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load system kill heat: ${String(err)}`));
    // Front lines move constantly, so this rides the exact same mount/
    // interval/focus/manual-resync triggers as the heat fetch above rather
    // than needing its own separate polling setup. Every filter below does
    // the same for the same reason - null-sec flips, incursions relocate,
    // and last-hour activity ages out continuously.
    getFwSystems()
      .then((systems) => {
        fwSystemsRef.current = new Map(systems.map((s) => [s.solar_system_id, s]));
        rebuildFwGatePaths();
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load faction warfare status: ${String(err)}`));
    getSovereigntyMap()
      .then((entries) => {
        sovRef.current = new Map(entries.map((e) => [e.system_id, e]));
        rebuildSovGatePaths();
        requestDraw();

        // Bulk-resolve every not-yet-cached owner's name in one call, so
        // the hover tooltip below has a name ready instantly instead of
        // fetching one owner at a time as each badge gets hovered.
        const idsToResolve = [
          ...new Set(
            entries
              .map((e) => e.alliance_id ?? e.corporation_id)
              .filter((id): id is number => id != null && !sovNamesRef.current.has(id)),
          ),
        ];
        if (idsToResolve.length > 0) {
          resolveEntityNames(idsToResolve)
            .then((resolved) => {
              for (const [idStr, name] of Object.entries(resolved)) {
                sovNamesRef.current.set(Number(idStr), name);
              }
            })
            .catch(() => {
              // Best-effort - a badge with no resolved name yet just shows
              // no tooltip on hover until the next sov refresh retries it.
            });
        }
      })
      .catch((err) => reportError(`Failed to load sovereignty map: ${String(err)}`));
    getIncursions()
      .then((systems) => {
        incursionsRef.current = new Map(systems.map((s) => [s.system_id, s]));
        rebuildIncursionGatePaths();
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load incursions: ${String(err)}`));
    getSystemActivity()
      .then((entries) => {
        activityRef.current = new Map(entries.map((e) => [e.system_id, e]));
        requestDraw();
      })
      .catch((err) => reportError(`Failed to load system traffic/activity: ${String(err)}`));
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
    destinationIdRef.current = destinationSystem?.id ?? null;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationSystem]);

  useEffect(() => {
    showServiceIconsRef.current = showServiceIcons;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showServiceIcons]);

  useEffect(() => {
    showFwContestedRef.current = showFwContested;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFwContested]);

  useEffect(() => {
    showSovRef.current = showSov;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSov]);

  useEffect(() => {
    showIncursionsRef.current = showIncursions;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIncursions]);

  useEffect(() => {
    heatModeRef.current = heatMode;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatMode]);

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

    /** Same idea as pickPin, for a Sov ownership badge - checked alongside
     * it (badges sit upper-left of the dot, pins sit upper/lower-right, so
     * the two never actually compete for the same pixels). */
    function pickSovBadge(clientX: number, clientY: number) {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      for (const badge of renderedSovBadgesRef.current) {
        if (Math.hypot(badge.px - px, badge.py - py) <= badge.radius) return badge;
      }
      return null;
    }

    function pickSystem(clientX: number, clientY: number): MapSystem | null {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { scale, translateX, translateY } = transformRef.current;
      let closest: MapSystem | null = null;
      let closestDist = 12;
      // Runs on every mousemove, so it scans only what's already on screen
      // (visibleSystemsRef, refreshed each draw()) rather than every system
      // in New Eden - a system that isn't visible can't be under the cursor
      // anyway, so this never changes the result, only the search space.
      for (const system of visibleSystemsRef.current) {
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
     * system's actual rendered label rectangle (renderedLabelRectsRef, built
     * fresh by draw()'s label-collision placement every frame - see
     * LABEL_ANCHOR_SIDES), not just its dot. A system's label can land on
     * any of 4 sides of its dot depending on what collided with what this
     * frame, so hit-testing has to use the SAME rectangles draw() actually
     * placed rather than recomputing a fixed "always to the right"
     * assumption that stopped being true the moment collision placement
     * could choose a different side. Only used on mouseup (a single click),
     * not on every mousemove, since it's O(systems) with canvas text
     * measurement and would reintroduce the redraw-storm bug fixed earlier
     * if run on hover.
     */
    function pickSystemForClick(clientX: number, clientY: number): MapSystem | null {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;

      // Overlapping label boxes can still both cover the same pixel (two
      // high-priority systems sitting close together) - picking whichever
      // matching candidate's own dot is closest to the click resolves that
      // the same way pickSystem's plain dot-search already does.
      let best: MapSystem | null = null;
      let bestDist = Infinity;
      const { scale, translateX, translateY } = transformRef.current;
      for (const [systemId, labelRect] of renderedLabelRectsRef.current) {
        if (px < labelRect.x - 2 || px > labelRect.x + labelRect.width + 2) continue;
        if (py < labelRect.y - 2 || py > labelRect.y + labelRect.height + 2) continue;
        const system = systemByIdRef.current.get(systemId);
        if (!system) continue;
        const sx = system.x * scale + translateX;
        const sy = system.y * scale + translateY;
        const dist = Math.hypot(sx - px, sy - py);
        if (dist < bestDist) {
          bestDist = dist;
          best = system;
        }
      }
      if (best) return best;

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
      if (hoveredSovKeyRef.current !== null) {
        hoveredSovKeyRef.current = null;
        setSovHover(null);
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
        moveTooltip(pinTooltipRef, e.clientX, e.clientY);
      }

      // A Sov badge sitting near a dot shouldn't compete with a character
      // pin for the same hover - pins take priority since they're the
      // rarer, more specific marker of the two.
      const sovBadge = pin ? null : pickSovBadge(e.clientX, e.clientY);
      const sovKey = sovBadge ? sovBadge.ownerId : null;
      if (sovKey !== hoveredSovKeyRef.current) {
        hoveredSovKeyRef.current = sovKey;
        setSovHover(
          sovBadge
            ? { name: sovNamesRef.current.get(sovBadge.ownerId) ?? "Unknown", kind: sovBadge.kind, clientX: e.clientX, clientY: e.clientY }
            : null,
        );
      } else if (sovBadge) {
        moveTooltip(sovTooltipRef, e.clientX, e.clientY);
      }

      // A pin or sov badge sitting right next to its system's dot shouldn't
      // also pop the system's own killboard tooltip at the same time -
      // whichever the cursor is actually over wins, rather than layering
      // all three.
      const picked = pin || sovBadge ? null : pickSystem(e.clientX, e.clientY);
      const pickedId = picked?.id ?? null;
      if (pickedId !== hoveredIdRef.current) {
        hoveredIdRef.current = pickedId;
        setHoverInfo(picked ? { system: picked, clientX: e.clientX, clientY: e.clientY } : null);
        requestDraw();
      } else if (picked && !pinnedHoverRef.current) {
        // Pinned takes priority over live hover (see activeHover below) - no
        // point moving this tooltip while a pinned one is what's actually
        // shown.
        moveTooltip(hoverTooltipRef, e.clientX, e.clientY);
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
          selectedAtRef.current = Date.now();
          setSelectedSystem(picked);
          const newPinnedHover =
            picked && pinnedHoverRef.current?.system.id !== picked.id
              ? { system: picked, clientX: e.clientX, clientY: e.clientY }
              : null;
          pinnedHoverRef.current = newPinnedHover;
          setPinnedHover(newPinnedHover);
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
    selectedAtRef.current = Date.now();
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
    // Extra clearance along the bottom specifically - the Legend
    // (bottom-left) and Top Active Systems/Regions (bottom-right) panels
    // are both fixed overlays living there (see .map-legend/.map-top-activity
    // in App.css), and a uniform 60px padding isn't enough to guarantee the
    // actual system that triggered this fit - which could sit anywhere in
    // its region's bounding box, including the southern edge - doesn't land
    // right behind one of them.
    const bottomPadding = padding + 110;
    const dataWidth = maxX - minX || 1;
    const dataHeight = maxY - minY || 1;
    const rawScale = Math.min((width - padding * 2) / dataWidth, (height - padding - bottomPadding) / dataHeight);
    // Clamped so a very sparse/tiny region still zooms in meaningfully, and a
    // very large/dense one doesn't overshoot the "region level" feel this is
    // meant to give (goToSystem's 40x is the deep single-system close-up).
    const scale = clamp(rawScale, fitScaleRef.current * 8, fitScaleRef.current * 35);

    transformRef.current = {
      scale,
      translateX: padding - minX * scale + (width - padding * 2 - dataWidth * scale) / 2,
      translateY: padding - minY * scale + (height - padding - bottomPadding - dataHeight * scale) / 2,
    };
    selectedIdRef.current = system.id;
    selectedAtRef.current = Date.now();
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
            ((alertKillIds.has(k.killmail_id) && proximityClock - new Date(k.time).getTime() < PROXIMITY_EXPIRY_MS) ||
              (k.victim_character_id != null && trackedCharacterIds.has(k.victim_character_id))),
        )
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, PROXIMITY_TICKER_LIMIT),
    [kills, alertKillIds, proximityClock, trackedCharacterIds],
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
          {(topActivity.systems.length > 0 || topActivity.regions.length > 0) && (
            <>
              <button
                type="button"
                className="map-ticker-top-activity-toggle"
                onClick={() => setTopActivityOpen((v) => !v)}
                aria-expanded={topActivityOpen}
              >
                <span>Top Activity (last hour)</span>
                <ChevronDown size={14} strokeWidth={2} className={topActivityOpen ? "map-ticker-chevron-open" : undefined} />
              </button>
              {topActivityOpen && (
                <div className="map-ticker-top-activity">
                  <div className="map-ticker-top-activity-col">
                    <p>Top Active Systems</p>
                    {topActivity.systems.map((entry) => (
                      <div key={entry.name} className="map-top-activity-row">
                        <span>{entry.name}</span>
                        <span>{entry.count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="map-ticker-top-activity-col">
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
              <div className="map-ticker-divider" />
            </>
          )}
          <div className="map-ticker-proximity">
            <div className="map-ticker-proximity-header">
              <span>Nearby &amp; Tracked</span>
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
            {proximityTickerKills.length === 0 ? (
              <p className="map-ticker-empty">
                {currentSystem
                  ? "No nearby or tracked kills yet."
                  : "Set your current location to track nearby kills - a tracked character's own kills show up here too."}
              </p>
            ) : (
              proximityTickerKills.map((kill) => (
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
                className={`map-icons-toggle${showFwContested ? " map-icons-toggle-active" : ""}`}
                onClick={() => setShowFwContested((v) => !v)}
                title="Ring any faction-warfare system that's actively contested (can flip to the occupying faction right now)"
              >
                FW
              </button>
              <button
                type="button"
                className={`map-icons-toggle${showSov ? " map-icons-toggle-active" : ""}`}
                onClick={() => setShowSov((v) => !v)}
                title="Show null-sec sovereignty ownership, tracked-alliance space, and structure vulnerability windows"
              >
                Sov
              </button>
              <button
                type="button"
                className={`map-icons-toggle${showIncursions ? " map-icons-toggle-active" : ""}`}
                onClick={() => setShowIncursions((v) => !v)}
                title="Ring every system currently infested by a live Sansha incursion"
              >
                Incursion
              </button>
              <button
                type="button"
                className="map-icons-toggle"
                onClick={() => setHeatMode((m) => (m === "kills" ? "traffic" : m === "traffic" ? "npc" : "kills"))}
                title="Cycle the background heat glow between last-hour Kills, Traffic (ship jumps), and NPC activity"
              >
                Heat: {heatMode === "kills" ? "Kills" : heatMode === "traffic" ? "Traffic" : "NPC"}
              </button>
            </div>

            {/* Separate from the filter toggles above (pushed to the far
               right via margin-left: auto - see .map-action-toggles) since
               these two aren't filters at all, just standalone actions
               ("refresh the data", "resize the window") that don't belong
               in the same visual group as the FW/Sov/Incursion/Heat
               buttons whose whole point is to stay pressed/toggled on. */}
            <div className="map-action-toggles">
              <button
                type="button"
                className="map-icons-toggle"
                onClick={resync}
                title="Force the heat map and pulse to refresh right now, in case they've gone stale"
              >
                <RefreshCw size={12} strokeWidth={2} />
              </button>
              {onToggleFullscreen && (
                <button
                  type="button"
                  className="map-icons-toggle"
                  onClick={onToggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fill the whole app window with the map"}
                >
                  {isFullscreen ? <Minimize2 size={12} strokeWidth={2} /> : <Maximize2 size={12} strokeWidth={2} />}
                </button>
              )}
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
                  className={`map-selected-set-location${
                    destinationSystem?.id === selectedSystem.id ? " map-selected-set-location-active" : ""
                  }`}
                  onClick={() => setDestinationSystem((prev) => (prev?.id === selectedSystem.id ? null : selectedSystem))}
                  title={
                    destinationSystem?.id === selectedSystem.id
                      ? "Clear this destination"
                      : "Set as my destination and plot a route from my current location"
                  }
                >
                  <Crosshair size={13} strokeWidth={2} />
                  {destinationSystem?.id === selectedSystem.id ? "Destination" : "Set as Destination"}
                </button>
                {destinationSystem && (
                  <span className="map-selected-region">
                    {!currentSystem
                      ? "Set your current location to plot a route"
                      : route.length === 0
                        ? `No stargate route to ${destinationSystem.name}`
                        : route.length === 1
                          ? "You're already there"
                          : `${route.length - 1} jump${route.length - 1 === 1 ? "" : "s"} to ${destinationSystem.name}`}
                  </span>
                )}
                {onSendRouteToGateCheck && currentSystem && destinationSystem && route.length > 1 && (
                  <button
                    type="button"
                    className="map-selected-stats-btn"
                    onClick={() => {
                      const origin = systemByIdRef.current.get(currentSystem.id);
                      if (!origin) return;
                      onSendRouteToGateCheck([origin, destinationSystem]);
                    }}
                    title="Check this route for gate camps in the Gate Check tab"
                  >
                    <Radar size={13} strokeWidth={2} />
                    Send Route to Gate Check
                  </button>
                )}
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
                {(showFwContested || showSov || showIncursions) && (
                  <p className="map-legend-hint">Everything not relevant to an active filter below fades to grey</p>
                )}
                {showSov && (
                  <p className="map-legend-hint">Sovereignty: zoom in on a system to see the owning alliance/corp logo badged next to its dot.</p>
                )}
              </div>
            )}

          </div>
        </div>
      </div>

      {pinHover && (
        <div
          ref={pinTooltipRef}
          className="map-hover-tooltip map-pin-tooltip"
          style={{ left: pinHover.clientX + 16, top: pinHover.clientY + 16 }}
        >
          <span className="map-hover-name">{pinHover.characterName}</span>
          <span className="map-hover-kills">{pinHover.kind === "home" ? "Home base" : "Currently here"}</span>
        </div>
      )}

      {sovHover && (
        <div
          ref={sovTooltipRef}
          className="map-hover-tooltip map-pin-tooltip"
          style={{ left: sovHover.clientX + 16, top: sovHover.clientY + 16 }}
        >
          <span className="map-hover-name">{sovHover.name}</span>
          <span className="map-hover-kills">{sovHover.kind === "alliance" ? "Alliance" : "Corporation"}</span>
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
          ref={hoverTooltipRef}
          className={`map-hover-tooltip${pinnedHover ? " map-hover-tooltip-pinned" : ""}`}
          style={{ left: activeHover.clientX + 16, top: activeHover.clientY + 16 }}
        >
          <div className="map-hover-tooltip-title">
            <span className="kills-security" style={{ color: securityColor(activeHover.system.security) }}>
              {formatSecurity(activeHover.system.security)}
            </span>
            <span className="map-hover-name">{activeHover.system.name}</span>
            {pinnedHover && (
              <button
                type="button"
                className="map-hover-tooltip-close"
                onClick={() => {
                  pinnedHoverRef.current = null;
                  setPinnedHover(null);
                }}
                title="Unpin"
              >
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
/** Every row carries a small security-band tag next to its timestamp,
 * tinted by the kill system's exact security status - securityColor(), the
 * same per-0.1 --sec-N scale the map's own system dots use - so a row and
 * its dot on the map read as the same colour.
 *
 * Wormhole space is the case that most needs it: J-space has no fixed
 * position on the star map (a wormhole's connections are random and
 * temporary, not gates), so a kill there can never show up as a dot at all
 * the way a k-space kill does - without the tag it's silently
 * indistinguishable from a kill that just isn't in the currently-viewed
 * region. It keeps its own fixed violet + glow (see --wormhole) rather
 * than a point on the security scale, since w-space isn't a security
 * level. A k-space kill whose security didn't resolve (rare - see
 * poll_recent_activity) gets no tag rather than a guessed one. */
const SEC_BAND_LABEL = { high: "Highsec", low: "Lowsec", null: "Nullsec" } as const;

function TickerRow({ kill, severity, isCurrentLocation, onSelect, onSetLocation, onShowOnMap, onMouseEnter, onMouseLeave }: TickerRowProps) {
  // A tracked character's own death, independent of severity (which is
  // about proximity to your current location, not who died) - a tracked
  // friend can die right next to you or ten regions away, and either way
  // it's worth calling out by name, not just folded into the same red/
  // amber proximity tint severity already uses.
  const { entities: trackedEntities } = useTrackedEntities();
  const trackedVictimName =
    kill.victim_character_id != null &&
    trackedEntities.some((e) => e.kind === "character" && e.entity_id === kill.victim_character_id)
      ? kill.victim_character_name
      : null;
  const isWormhole = isWSpaceSystemName(kill.system_name);
  const isAbyssal = isAbyssalSystemName(kill.system_name);
  const secTag =
    !isWormhole && !isAbyssal && kill.system_security != null
      ? { label: SEC_BAND_LABEL[securityBand(kill.system_security)], color: securityColor(kill.system_security) }
      : null;
  // The system name itself gets the same color treatment as the badges
  // above it - wormhole's fixed violet, abyssal's own fixed color, or the
  // real per-0.1 security tier color for everything else, so the name
  // reads as "what kind of space is this" at a glance, matching its dot
  // on the map (for k-space) or its badge right above it (for w-space/
  // abyssal) rather than sitting in the same flat muted color regardless.
  const systemNameColor = isWormhole
    ? "var(--wormhole)"
    : isAbyssal
      ? "var(--abyssal)"
      : kill.system_security != null
        ? securityColor(kill.system_security)
        : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`map-ticker-row${severity ? ` map-ticker-row-alert-${severity}` : ""}${trackedVictimName ? " map-ticker-row-tracked" : ""}`}
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
          {isAbyssal && (
            <span className="map-ticker-abyssal-badge" title="Abyssal Deadspace has no fixed position, so it can't be shown on the map">
              Abyssal Kill
            </span>
          )}
          {secTag && (
            <span className="map-ticker-sec-badge" style={{ color: secTag.color }}>
              {secTag.label}
            </span>
          )}
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
      {trackedVictimName && (
        <div className="map-ticker-tracked-victim">
          <Skull size={12} strokeWidth={2} />
          <span>{trackedVictimName}</span>
        </div>
      )}
      <div className="map-ticker-row-body">
        <img src={`https://images.evetech.net/types/${kill.ship_type_id}/icon?size=64`} alt="" />
        <div className="map-ticker-row-text">
          <span className="map-ticker-title">{kill.ship_type_name}</span>
          <span className="map-ticker-subtitle" style={{ color: systemNameColor }}>
            {kill.system_name}
          </span>
          <span className="map-ticker-subtitle map-ticker-subtitle-meta">
            {formatIskCompact(kill.total_value)} · {kill.attacker_count} attacker{kill.attacker_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default MapView;
