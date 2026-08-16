export function formatIsk(value: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ISK`;
}

export function formatSp(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} SP`;
}

export function formatPlex(value: number): string {
  return `${new Intl.NumberFormat("en-US").format(value)} PLEX`;
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

/** Formats an ISO timestamp as the exact local time the kill occurred, e.g. "14:36:12" - paired with the date-group headers, which already show which day. */
export function formatExactTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

/** Local-calendar-day key for grouping a list of ISO timestamps by date. */
export function dateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

/** Buckets a security_status value into EVE's highsec/lowsec/nullsec bands for color coding. Rounds first so the band always matches what formatSecurity displays. */
export function securityBand(value: number): "high" | "low" | "null" {
  const rounded = Math.round(value * 10) / 10;
  if (rounded >= 0.5) return "high";
  if (rounded > 0.0) return "low";
  return "null";
}

/** Formats an ISO timestamp's local date as a group heading: "Today", "Yesterday", or "14 August 2026". */
export function formatDateHeading(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(date);
}
