// EVE Online skill-training math: SP-per-level, training rate, attribute
// mechanics, and skill-injector economics.
//
// SOURCE: every formula here is a direct port of EVEMon's real, ~15-year-
// battle-tested implementation (Git sources/evemon-master), not re-derived
// from memory - see StaticSkill.GetPointsRequiredForLevel,
// BaseCharacter.GetBaseSPPerHour, EveConstants, and
// BaseCharacter.GetRequiredSkillInjectorsForSkillPoints /
// GetSkillPointsGainedFromInjector. The skill primary/secondary attribute
// dogma ids (180/181, referencing 164-168) were verified live against real
// ESI data (Gunnery, type 3300 -> Perception/Willpower, rank 1), not
// guessed - see esi.rs's SKILL_ATTRIBUTE_REF_IDS comment for the same trail.
//
// Verified: 2026-08-19.

export type AttributeName = "Charisma" | "Intelligence" | "Memory" | "Perception" | "Willpower";

/** Every character starts every attribute at this base, before remap/implants. */
export const BASE_ATTRIBUTE_VALUE = 17;
/** Total bonus points distributed across the 5 attributes on a remap (on top of the 85 base). */
export const SPARE_REMAP_POINTS = 14;
/** Max bonus any single attribute can receive from a remap. */
export const MAX_REMAP_POINTS_PER_ATTRIBUTE = 10;
/** Max bonus any single attribute can receive from implants. */
export const MAX_IMPLANT_BONUS = 5;

/**
 * Cumulative SP required to reach `level` (0-5) for a skill of the given
 * rank, starting from 0. Exact port of EVEMon's per-level switch (not the
 * "clean" 250*rank*2^(2.5*(level-1)) formula collapsed into one branch) so
 * the same rounding quirks (e.g. level 2 at rank 1 = 1415, not 1414) match
 * exactly rather than drifting by a point here and there.
 */
export function spRequiredForLevel(rank: number, level: number): number {
  switch (level) {
    case -1:
    case 0:
      return 0;
    case 1:
      return 250 * rank;
    case 2:
      return rank === 1 ? 1415 : Math.trunc(rank * 1414.3 + 0.5);
    case 3:
      return 8000 * rank;
    case 4:
      return Math.ceil(2 ** (2.5 * 4 - 2.5) * 250 * rank);
    case 5:
      return 256000 * rank;
    default:
      throw new Error(`Invalid skill level ${level}`);
  }
}

/** SP needed for just this one level (delta from the previous level), not the cumulative total. */
export function spForLevelOnly(rank: number, level: number): number {
  return spRequiredForLevel(rank, level) - spRequiredForLevel(rank, level - 1);
}

/** SP/hour training rate from two EFFECTIVE (base+remap+implant) attribute values. */
export function spPerHour(primaryEffective: number, secondaryEffective: number): number {
  return primaryEffective * 60 + secondaryEffective * 30;
}

/** Whole seconds to train `spNeeded` points at the given SP/hour rate. Returns null if the rate is non-positive (can't train). */
export function trainingSeconds(spNeeded: number, spPerHourRate: number): number | null {
  if (spPerHourRate <= 0) return null;
  return Math.ceil((spNeeded / spPerHourRate) * 3600);
}

/**
 * SP gained from one large skill injector, based on the character's total SP
 * AT THE TIME of injection (the bracket shifts as SP climbs, so injecting N
 * times isn't just N * a fixed amount past the first bracket boundary).
 */
export function skillPointsFromInjector(currentTotalSp: number): number {
  const spMillions = currentTotalSp / 1_000_000;
  if (spMillions < 5) return 500_000;
  if (spMillions < 50) return 400_000;
  if (spMillions < 80) return 300_000;
  return 150_000;
}

/** How many injectors, used one after another, to cover `spNeeded` more points starting from `currentTotalSp`. */
export function requiredInjectors(currentTotalSp: number, spNeeded: number): number {
  let remaining = spNeeded;
  let projectedTotal = currentTotalSp;
  let count = 0;
  while (remaining > 0) {
    const gained = skillPointsFromInjector(projectedTotal);
    remaining -= gained;
    projectedTotal += gained;
    count++;
  }
  return count;
}

export interface PlannableSkill {
  skill_id: number;
  name: string;
  rank: number;
  primary_attribute: AttributeName | null;
  secondary_attribute: AttributeName | null;
  prerequisites: { skill_id: number; level: number }[];
}

export interface ExpandedEntry {
  skill_id: number;
  level: number;
  is_prerequisite: boolean;
}

/**
 * Walks a skill's full prerequisite tree (recursively - a prerequisite can
 * itself have prerequisites) and every intermediate level between what's
 * already trained/planned and the target, in dependency order (deepest
 * prerequisites first, the actually-requested skill+level last). Mirrors
 * how the real in-game skill queue needs each level queued as its own step
 * when jumping more than one level at once - not a single lumped entry.
 *
 * `alreadySatisfied` should return true for anything that needs no plan
 * entry: already trained to that level, or already present elsewhere in
 * the plan (checked by the caller before this runs, since a level planned
 * for a different reason still means don't plan it twice).
 */
export function expandWithPrerequisites(
  targetSkillId: number,
  targetLevel: number,
  skillsById: Map<number, PlannableSkill>,
  alreadySatisfied: (skillId: number, level: number) => boolean,
): ExpandedEntry[] {
  const out: ExpandedEntry[] = [];
  const seen = new Set<string>();

  function visit(skillId: number, level: number, isPrereq: boolean) {
    const key = `${skillId}:${level}`;
    if (seen.has(key)) return;
    seen.add(key);

    const skill = skillsById.get(skillId);
    if (!skill) return;

    // This skill's own prerequisites must be satisfied at ITS required
    // level before level 1 of this skill can even be trained - so recurse
    // into them once, at level 1 of this skill's chain (they don't repeat
    // per intermediate level of this skill).
    if (level === 1) {
      for (const prereq of skill.prerequisites) {
        if (!alreadySatisfied(prereq.skill_id, prereq.level)) {
          visit(prereq.skill_id, prereq.level, true);
        }
      }
    } else if (!alreadySatisfied(skillId, level - 1)) {
      // Jumping straight to a higher level still needs every level below it
      // queued first, unless that lower level is already satisfied.
      visit(skillId, level - 1, true);
    }

    if (!alreadySatisfied(skillId, level)) {
      out.push({ skill_id: skillId, level, is_prerequisite: isPrereq });
    }
  }

  visit(targetSkillId, targetLevel, false);
  return out;
}

export interface AttributeSpread {
  Charisma: number;
  Intelligence: number;
  Memory: number;
  Perception: number;
  Willpower: number;
}

export interface RemapCandidateSkill {
  rank: number;
  spNeeded: number;
  primary_attribute: AttributeName | null;
  secondary_attribute: AttributeName | null;
}

/**
 * Brute-forces every valid remap-point distribution (base 17 + spread, no
 * implants factored in - a "what's the best pure remap" recommendation,
 * not a full implant-inclusive simulation) against a skill list, returning
 * whichever spread minimizes total training time. Mirrors
 * AttributesOptimizer's approach in both reference tools: exhaustive search
 * over the ~14,641-combination space rather than a heuristic, since the
 * space is small enough that exhaustive is both correct and fast.
 */
export function optimizeRemap(skills: RemapCandidateSkill[]): { spread: AttributeSpread; totalSeconds: number } {
  let best: { spread: AttributeSpread; totalSeconds: number } | null = null;
  for (const spread of remapDistributions()) {
    let total = 0;
    for (const skill of skills) {
      if (!skill.primary_attribute || !skill.secondary_attribute) continue;
      const primary = BASE_ATTRIBUTE_VALUE + spread[skill.primary_attribute];
      const secondary = BASE_ATTRIBUTE_VALUE + spread[skill.secondary_attribute];
      const seconds = trainingSeconds(skill.spNeeded, spPerHour(primary, secondary)) ?? 0;
      total += seconds;
    }
    if (!best || total < best.totalSeconds) best = { spread, totalSeconds: total };
  }
  // remapDistributions always yields at least one combination (all points
  // possible to distribute), so best is never null for a non-empty search -
  // the fallback only matters for an empty skills list, where every
  // candidate ties at 0 seconds and any spread is as good as any other.
  return best ?? { spread: { Charisma: 0, Intelligence: 0, Memory: 0, Perception: 0, Willpower: 0 }, totalSeconds: 0 };
}

/** Every remap-point distribution across the 5 attributes that sums to SPARE_REMAP_POINTS, each capped at MAX_REMAP_POINTS_PER_ATTRIBUTE - the search space the remap optimizer brute-forces. */
export function* remapDistributions(): Generator<AttributeSpread> {
  const max = MAX_REMAP_POINTS_PER_ATTRIBUTE;
  for (let a = 0; a <= max; a++) {
    for (let b = 0; b <= max && a + b <= SPARE_REMAP_POINTS; b++) {
      for (let c = 0; c <= max && a + b + c <= SPARE_REMAP_POINTS; c++) {
        for (let d = 0; d <= max && a + b + c + d <= SPARE_REMAP_POINTS; d++) {
          const e = SPARE_REMAP_POINTS - a - b - c - d;
          if (e < 0 || e > max) continue;
          yield { Charisma: a, Intelligence: b, Memory: c, Perception: d, Willpower: e };
        }
      }
    }
  }
}
