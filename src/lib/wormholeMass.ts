import type { MassStatus } from "./wormholes";

export type WhSizeClass = "small" | "medium" | "large" | "xl";

/** Wormhole "size" isn't its own stored property - it's the largest ship
 * that can pass, derived from the type's known per-jump mass cap
 * (wormholeTypes.ts's maxJumpMassKg, itself sourced from the SDE). Threshold
 * values match the SDE's real clusters (5M/62M/375M-410M/1B-2B). */
const WH_JUMP_MASS_KG = { xl: 1_000_000_000, large: 300_000_000, medium: 62_000_000 };

export function whSizeClass(maxJumpMassKg: number | null): WhSizeClass | null {
  if (maxJumpMassKg == null || maxJumpMassKg <= 0) return null;
  if (maxJumpMassKg >= WH_JUMP_MASS_KG.xl) return "xl";
  if (maxJumpMassKg >= WH_JUMP_MASS_KG.large) return "large";
  if (maxJumpMassKg >= WH_JUMP_MASS_KG.medium) return "medium";
  return "small";
}

export const WH_SIZE_LABEL: Record<WhSizeClass, string> = {
  xl: "XL (Capital)",
  large: "Large (Battleship)",
  medium: "Medium (Cruiser)",
  small: "Small (Frigate)",
};

export const WH_SIZE_SHORT: Record<WhSizeClass, string> = { xl: "XL", large: "L", medium: "M", small: "S" };

export type TimeStatusTier = "fresh" | "lessThan24h" | "lessThan4h" | "lessThan1h" | "eol" | "expired";

/** The scanner-observed EOL flag always wins over a time estimate - many
 * wormhole types (including K162, the generic exit signature) have no known
 * lifetime and can't be estimated at all, so the boolean stays authoritative
 * wherever an estimate isn't possible. */
export function deriveTimeStatus(firstSeenAt: number, lifetimeHours: number | null, isEol: boolean): TimeStatusTier {
  if (isEol) return "eol";
  if (lifetimeHours == null) return "fresh";
  const ageHours = (Date.now() / 1000 - firstSeenAt) / 3600;
  const remainingHours = lifetimeHours - ageHours;
  if (remainingHours <= 0) return "expired";
  if (remainingHours <= 1) return "lessThan1h";
  if (remainingHours <= 4) return "lessThan4h";
  if (remainingHours <= 24) return "lessThan24h";
  return "fresh";
}

export const TIME_STATUS_LABEL: Record<TimeStatusTier, string> = {
  fresh: "Fresh",
  lessThan24h: "< 24h left",
  lessThan4h: "< 4h left",
  lessThan1h: "< 1h left",
  eol: "EOL",
  expired: "Expired",
};

export interface MassRange {
  worstTotalKg: number;
  bestTotalKg: number;
  worstRemainingKg: number;
  bestRemainingKg: number;
}

/** Real wormhole total mass rolls ±10% at spawn and the client never
 * reveals which way it landed - "worst case" assumes the lower roll,
 * "best case" the higher one. */
export function massRange(totalMassKg: number, massUsedKg: number): MassRange {
  const worstTotalKg = totalMassKg * 0.9;
  const bestTotalKg = totalMassKg * 1.1;
  return {
    worstTotalKg,
    bestTotalKg,
    worstRemainingKg: Math.max(0, worstTotalKg - massUsedKg),
    bestRemainingKg: Math.max(0, bestTotalKg - massUsedKg),
  };
}

export function collapseState(range: MassRange): "open" | "maybe" | "collapsed" {
  if (range.bestRemainingKg <= 0) return "collapsed";
  if (range.worstRemainingKg <= 0) return "maybe";
  return "open";
}

export function passOutcome(range: MassRange, passMassKg: number): "safe" | "risky" | "collapse" {
  if (range.bestRemainingKg - passMassKg <= 0) return "collapse";
  if (range.worstRemainingKg - passMassKg <= 0) return "risky";
  return "safe";
}

/** Worst-case-based thresholds - once real logging has started, mass status
 * becomes a derived read of the log rather than a hand-picked flag. VESPER
 * keeps its own fresh/reduced/critical naming rather than adopting
 * eve-nexum's stable/destabilized/critical strings. */
export function deriveMassStatus(range: MassRange): MassStatus {
  if (range.worstRemainingKg <= range.worstTotalKg * 0.1) return "critical";
  if (range.worstRemainingKg <= range.worstTotalKg * 0.5) return "reduced";
  return "fresh";
}

export interface RollerPreset {
  label: string;
  massKg: number;
}

export const ROLLER_PRESETS: RollerPreset[] = [
  { label: "Battleship", massKg: 100_000_000 },
  { label: "Battleship + Higgs", massKg: 100_000_000 * 0.4 },
  { label: "Heavy Interdictor", massKg: 12_500_000 },
  { label: "Custom", massKg: 0 },
];

export function formatMassKg(kg: number): string {
  if (kg >= 1_000_000_000) return `${(kg / 1_000_000_000).toFixed(2)}B kg`;
  if (kg >= 1_000_000) return `${(kg / 1_000_000).toFixed(1)}M kg`;
  return `${Math.round(kg).toLocaleString()} kg`;
}
