/** CCP's own image server - stable, public, no auth or bundling needed. Used
 * anywhere an item type is shown (Assets, Market Orders, Transactions, the
 * market tools) so the app can show real EVE icon art without shipping any
 * icon assets itself.
 *
 * Blueprints AND reaction formulas have no "icon" render at all - confirmed
 * live, /types/{id}/icon returns a 400 for every type ID in either category,
 * not just a missing/placeholder image. Both only exist under the dedicated
 * /bp render instead (also confirmed live), so the name (always suffixed
 * "... Blueprint" or "... Reaction Formula" with zero exceptions in EVE's
 * naming - reaction formulas are technically their own Blueprint-category
 * items, just named differently) is used here to route to the right
 * endpoint - pass it whenever it's already at hand from the same data the
 * type_id came from.
 *
 * SKINs and raw reaction-product materials (fuel blocks etc.) were also
 * checked live and genuinely have no image under any known variant (icon,
 * render, bp, bpc all 404/400) - CCP just doesn't provide art for those, so
 * there's nothing to route around there. */
export function typeIconUrl(typeId: number, size: 32 | 64 = 32, name?: string): string {
  const variant = name?.endsWith(" Blueprint") || name?.endsWith(" Reaction Formula") ? "bp" : "icon";
  return `https://images.evetech.net/types/${typeId}/${variant}?size=${size}`;
}

export function formatIsk(value: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ISK`;
}

export function formatSp(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} SP`;
}

/** Formats a part/total ratio as a percentage, e.g. for kill-value or efficiency breakdowns. */
export function formatPercent(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";
}

export function formatTimeRemaining(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "finishing soon";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Same as formatTimeRemaining but always includes minutes, matching EveMon's queue-footer style ("106d 9h 58m"). */
export function formatTimeRemainingFull(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "0m";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** "Mon 30 Nov 18:43 EVE" - EVE time is always UTC, matching EveMon's queue-footer style. */
export function formatEveDateTime(iso: string): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const day = d.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${weekday} ${day} ${month} ${time} EVE`;
}

/** "36 in queue · ends in 106d 9h 58m · ends Mon 30 Nov 18:43 EVE" - the queue-tab footer summary, reused wherever the character's training status is shown (character cards, the detail header). */
export function formatQueueSummary(queueLength: number | null, queueEndsAt: string | null): string | null {
  if (queueLength == null || queueLength === 0) return null;
  const parts = [`${queueLength} in queue`];
  if (queueEndsAt) {
    parts.push(`ends in ${formatTimeRemainingFull(queueEndsAt)}`);
    parts.push(`ends ${formatEveDateTime(queueEndsAt)}`);
  }
  return parts.join(" · ");
}

/** Formats a past ISO timestamp as "5m ago" / "3h ago" / "2d ago". */
export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ago`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ago`;
}

/** Formats an ISO timestamp as the exact EVE time (UTC) the kill occurred, e.g. "14:36:12" - paired with the date-group headers, which already show which day. */
export function formatExactTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
}

/** Formats a past ISO timestamp with second-level precision for the first minute ("3s ago"), then falls back to formatRelativeTime - for live "last updated" indicators where "just now" for a whole 60s gives no visible feedback that anything happened. */
export function formatSecondsAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 3) return "just now";
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  return formatRelativeTime(iso);
}

/** EVE-time (UTC) calendar-day key for grouping a list of ISO timestamps by date - matches the day boundary EVE itself uses, not the viewer's local timezone. */
export function dateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Formats an ISO timestamp as "HH:MM UTC", matching zKillboard's convention of always showing kill times in UTC regardless of viewer timezone. */
export function formatUtcTime(iso: string): string {
  return `${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** Formats an ISK value with b/m/k suffixes, e.g. 1234567890 -> "1.23b ISK", matching the compact style used across EVE community killboards. */
export function formatIskCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b ISK`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m ISK`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k ISK`;
  return `${Math.round(value)} ISK`;
}

/** Rounds a raw ESI security_status value to EVE's usual one-decimal display, e.g. 0.549 -> "0.5". */
export function formatSecurity(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** EVE's real per-0.1-step security status colors (1.0 down to 0.0 and
 * below) - the same gradient the game's own UI uses, not just a 3-band
 * high/low/null approximation. Keyed by integer tenths to avoid any
 * floating-point equality risk. */
const SECURITY_COLOR_BY_TENTH: Record<number, string> = {
  10: "#053FD3",
  9: "#13C5EC",
  8: "#13EC9D",
  7: "#13EC28",
  6: "#73EC13",
  5: "#FFDF00",
  4: "#ECAB13",
  3: "#EC8513",
  2: "#EC5F13",
  1: "#EC3913",
};
/** EVE's own client uses a near-black maroon (#500000) here, matching the
 * real game's "danger" framing - but against this app's own dark UI that
 * reads as almost invisible rather than as a warning, so this brightens it
 * while keeping it read as "more extreme than lowsec's orange-red" (tenth
 * 1's #EC3913), continuing the same saturated palette as the rest of the
 * scale above. */
const SECURITY_COLOR_MIN = "#EC1313";

/** Coarse 3-tier band, kept only for things like the Tracked Systems chip
 * background tint where a flat high/low/null tone (matching the other
 * trackable types' own flat colors) reads better than the full 11-step
 * gradient - the actual security NUMBER display always uses securityColor
 * below for the real per-0.1 color. */
export function securityBand(value: number): "high" | "low" | "null" {
  const rounded = Math.round(value * 10) / 10;
  if (rounded >= 0.5) return "high";
  if (rounded > 0.0) return "low";
  return "null";
}

/** Real, unchanging EVE naming convention for wormhole (J-space) systems -
 * always "J" followed by exactly 6 digits, e.g. "J164710". Their reported
 * security_status doesn't reliably distinguish them from nullsec the way
 * securityBand() buckets things, so a kill-feed security-band filter needs
 * this name check first before falling back to the numeric band. */
export function isWSpaceSystemName(name: string): boolean {
  return /^J\d{6}$/.test(name);
}

/** Four-way security-band classification for kill-feed filtering - w-space
 * carved out by name (see isWSpaceSystemName) since its security_status
 * doesn't reliably separate from nullsec, everything else falls back to
 * the existing 3-tier securityBand(). Security-less entries (name doesn't
 * match w-space and no numeric value) default to "nullsec" rather than
 * being silently dropped from every filter. */
export function killSecurityBand(security: number | null, systemName: string): "highsec" | "lowsec" | "nullsec" | "wspace" {
  if (isWSpaceSystemName(systemName)) return "wspace";
  if (security == null) return "nullsec";
  const band = securityBand(security);
  if (band === "high") return "highsec";
  if (band === "low") return "lowsec";
  return "nullsec";
}

/** Exact display color for a security_status value, rounded the same way formatSecurity rounds the number itself. */
export function securityColor(value: number): string {
  const tenths = Math.round(value * 10);
  if (tenths >= 10) return SECURITY_COLOR_BY_TENTH[10];
  if (tenths <= 0) return SECURITY_COLOR_MIN;
  return SECURITY_COLOR_BY_TENTH[tenths] ?? SECURITY_COLOR_MIN;
}

/** CSS class for a standing value's positive/negative/neutral color bucket. */
export function standingClass(value: number): string {
  if (value > 0) return "standing-text-positive";
  if (value < 0) return "standing-text-negative";
  return "standing-text-neutral";
}

/** Formats an ISO timestamp's EVE-time (UTC) date as a group heading: "Today", "Yesterday", or "14 August 2026" - the day boundary matches EVE's own UTC day, not the viewer's local timezone. */
export function formatDateHeading(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
