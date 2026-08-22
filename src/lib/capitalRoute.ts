/** Capital jump-drive route planning: range/fuel/fatigue math for a sequence
 * of straight-line jump-drive hops between systems. Unlike the stargate
 * router (route.rs), a jump drive doesn't follow the jump graph at all - it's
 * a direct line through real 3D space, so this is pure client-side math over
 * already-fetched system positions and ship attributes, not a pathfinding
 * problem.
 *
 * Every formula below was verified live against ESI's own dogma attribute
 * descriptions and skill descriptions, and against EVE University's Jump
 * Fatigue page, rather than assumed from memory:
 *   - Jump Drive Calibration: "20% increase in maximum jump range per skill
 *     level" (ESI skill description, type 21611).
 *   - Jump Fuel Conservation: "10% reduction in isotope consumption amount
 *     for jump drive operation per light year per skill level" (ESI skill
 *     description, type 21610).
 *   - Jump Activation Cooldown = max(1 + LY jumped, 0.1 x fatigue-before-jump
 *     in minutes), capped at 30 minutes.
 *   - New Jump Fatigue = max(10 x (1 + LY jumped), fatigue-before-jump x
 *     (1 + LY jumped)) in minutes, capped at 300 minutes (5 hours).
 * Fatigue decay while not jumping is real-time and continuous, but EVE
 * doesn't publish an exact decay-rate constant anywhere - rather than guess
 * one, this planner assumes the whole route is flown back-to-back with no
 * waiting, which is also the honest worst case for total trip time.
 */

export const METERS_PER_LY = 9.4607e15;

export const JUMP_DRIVE_CALIBRATION_SKILL_ID = 21611;
export const JUMP_FUEL_CONSERVATION_SKILL_ID = 21610;

const MAX_COOLDOWN_MINUTES = 30;
const MAX_FATIGUE_MINUTES = 300;

/** The four jump-fuel isotopes - every jump-capable hull burns exactly one
 * of these, keyed by faction (verified live via ESI's /universe/ids/). Only
 * four ever exist, so a small fixed map is simpler and just as correct as a
 * general-purpose type-name lookup for this one use. */
export const JUMP_FUEL_TYPE_NAMES: Record<number, string> = {
  16274: "Helium Isotopes",
  17889: "Hydrogen Isotopes",
  17888: "Nitrogen Isotopes",
  17887: "Oxygen Isotopes",
};

export interface RoutePosition {
  systemId: number;
  systemName: string;
  pos: [number, number, number];
}

export interface CapitalRouteLeg {
  fromSystemId: number;
  fromSystemName: string;
  toSystemId: number;
  toSystemName: string;
  distanceLy: number;
  inRange: boolean;
  fuelUnits: number;
  cooldownMinutes: number;
  fatigueAfterMinutes: number;
}

export interface CapitalRoutePlan {
  effectiveRangeLy: number;
  legs: CapitalRouteLeg[];
  totalFuelUnits: number;
  totalMinutes: number;
  anyLegOutOfRange: boolean;
}

export function distanceLy(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / METERS_PER_LY;
}

export function planCapitalRoute(
  waypoints: RoutePosition[],
  baseRangeLy: number,
  fuelPerLy: number,
  jdcLevel: number,
  jfcLevel: number,
): CapitalRoutePlan {
  const effectiveRangeLy = baseRangeLy * (1 + 0.2 * jdcLevel);
  const fuelMultiplier = 1 - 0.1 * jfcLevel;

  let fatigue = 0;
  let totalFuelUnits = 0;
  let totalMinutes = 0;
  let anyLegOutOfRange = false;
  const legs: CapitalRouteLeg[] = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    const ly = distanceLy(from.pos, to.pos);
    const inRange = ly <= effectiveRangeLy;
    if (!inRange) anyLegOutOfRange = true;

    const fuelUnits = ly * fuelPerLy * fuelMultiplier;
    const cooldownMinutes = Math.min(MAX_COOLDOWN_MINUTES, Math.max(1 + ly, 0.1 * fatigue));
    const fatigueAfterMinutes = Math.min(MAX_FATIGUE_MINUTES, Math.max(10 * (1 + ly), fatigue * (1 + ly)));

    legs.push({
      fromSystemId: from.systemId,
      fromSystemName: from.systemName,
      toSystemId: to.systemId,
      toSystemName: to.systemName,
      distanceLy: ly,
      inRange,
      fuelUnits,
      cooldownMinutes,
      fatigueAfterMinutes,
    });

    totalFuelUnits += fuelUnits;
    totalMinutes += cooldownMinutes;
    fatigue = fatigueAfterMinutes;
  }

  return { effectiveRangeLy, legs, totalFuelUnits, totalMinutes, anyLegOutOfRange };
}
