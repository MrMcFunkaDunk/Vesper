// EVE Online industry math: material quantities, job time, job install cost,
// reprocessing yield, invention, and research (ME/TE) formulas.
//
// SOURCE: every formula here was cross-checked against at least two
// independent sources before being committed - two real reference tools
// (eve-tools-suite-main and LazyBlacksmith-master under Git sources/, both
// read directly, not from memory) plus EVE University's wiki for anything
// the two disagreed on or that only one covered. Specific resolutions:
//  - Material rounding: LazyBlacksmith's per-job-batch rounding is a strict
//    generalization of eve-tools-suite's simpler per-plan rounding (they're
//    algebraically identical when runsPerJob === totalRuns) - not a
//    disagreement once traced through, just two use-cases of one rule.
//  - Job install cost: the two tools' formulas were structurally different
//    (EIV x sum-of-rates vs. material-cost x flat multiplier). EVE
//    University's wiki confirmed the EIV-based shape is correct, and its
//    0.25% NPC-station facility-tax default matches what eve-tools-suite
//    already had right independently - good corroboration.
//  - SCC surcharge: neither tool had the current rate (eve-tools-suite had
//    the pre-Feb-2024 1.5%; the real rate has changed twice since - 4% from
//    Feb 2024, cut to 2% for ME/TE research specifically in Jul 2025).
//    Verified via CCP's own "Exploration & Industry Balance Rework" news
//    post, not the reference tools.
//  - Reprocessing: eve-tools-suite was the only source with a yield
//    calculator, and cross-checking it against the wiki caught real gaps -
//    wrong base structure rates (52/56% vs. the wiki's 51/52% for
//    Athanor/Tatara) and two entirely missing factors (security-status and
//    rig modifiers). This file implements the wiki's fuller formula, not
//    eve-tools-suite's.
//  - Invention/decryptors/research time: LazyBlacksmith's formulas traced
//    to real SDE dogma attribute ids (1112-1124) for decryptor effects, and
//    eve-tools-suite doesn't have an invention/research calculator to
//    cross-check against - single-sourced but well-grounded.
//
// Verified: 2026-08-20.

export type ActivityType = "manufacturing" | "reaction" | "invention" | "copying" | "research_me" | "research_te";

/** Real CCP SDE industryActivity ids - fixed, verified this session (see market.rs's ACTIVITY_* constants, same source). */
export const ACTIVITY_ID: Record<ActivityType, number> = {
  manufacturing: 1,
  research_te: 3,
  research_me: 4,
  copying: 5,
  invention: 8,
  reaction: 11,
};

// ---------------------------------------------------------------------------
// Material quantities

/** One material line's per-unit quantity after ME and any structure material bonus - not yet rounded/batched. Floored at a minimum of 1 unit per LazyBlacksmith's calculateAdjustedQuantity. */
export function adjustedMaterialQuantity(baseQuantity: number, materialEfficiency: number, structureMaterialBonus = 0): number {
  const meMultiplier = 1 - materialEfficiency / 100;
  return Math.max(1, baseQuantity * meMultiplier * (1 - structureMaterialBonus));
}

/**
 * Total material quantity needed across `totalRuns`, rounding once per
 * production-job batch rather than once for the whole plan - the real EVE
 * mechanic when a BPC's run cap (or a deliberate choice to split into
 * several smaller jobs) means `totalRuns` is actually produced across
 * multiple separate jobs, each independently rounding its own requirement.
 * Pass `runsPerJob === totalRuns` (the default) for the single-job case,
 * which this reduces to exactly LazyBlacksmith's simpler calculateJobQuantity
 * and eve-tools-suite's requiredQuantity - verified algebraically identical
 * in that case, not just similar.
 */
export function jobMaterialQuantity(adjustedQtyPerUnit: number, totalRuns: number, runsPerJob: number = totalRuns): number {
  if (totalRuns <= 0) return 0;
  const batch = Math.max(1, Math.min(runsPerJob, totalRuns));
  const fullBatches = Math.floor(totalRuns / batch);
  const leftoverRuns = totalRuns % batch;
  const perFullBatch = Math.max(batch, Math.ceil(adjustedQtyPerUnit * batch));
  const leftoverQty = leftoverRuns > 0 ? Math.max(leftoverRuns, Math.ceil(adjustedQtyPerUnit * leftoverRuns)) : 0;
  return fullBatches * perFullBatch + leftoverQty;
}

// ---------------------------------------------------------------------------
// Job time

/** Reactions never benefit from Time Efficiency - real mechanic confirmed independently by both reference tools (neither wires a TE control up on their reaction page/activity path at all). */
export function jobTimeSeconds(baseTimePerRun: number, runs: number, timeEfficiency: number, facilityTimeBonus = 0, activity: ActivityType = "manufacturing"): number {
  const effectiveTe = activity === "reaction" ? 0 : timeEfficiency;
  return baseTimePerRun * runs * (1 - effectiveTe / 100) * (1 - facilityTimeBonus);
}

// ---------------------------------------------------------------------------
// Job install cost

/** Since Feb 2024 (raised from 1.5%); still current for manufacturing/reaction/invention/copying as of this verification. */
export const SCC_SURCHARGE_STANDARD = 0.04;
/** Cut from 4% specifically for ME/TE research jobs in Jul 2025 - verified via CCP's own "Exploration & Industry Balance Rework" post. */
export const SCC_SURCHARGE_RESEARCH = 0.02;
/** Real default for NPC stations (owner-set for player structures) - verified via EVE University wiki, and matches what eve-tools-suite already had independently. */
export const DEFAULT_FACILITY_TAX = 0.0025;

export function sccSurcharge(activity: ActivityType): number {
  return activity === "research_me" || activity === "research_te" ? SCC_SURCHARGE_RESEARCH : SCC_SURCHARGE_STANDARD;
}

/**
 * Real EVE University formula: `EIV x ((system cost index x structure
 * bonus) + facility tax + SCC surcharge + alpha clone tax)`. Alpha clone
 * tax isn't modeled (defaults to 0) - its exact rate wasn't found during
 * verification and is being left as a known gap rather than guessed.
 * `structureBonusMultiplier` is 1.0 (no reduction) by default; a rigged/
 * bonused structure would pass something below 1.0 here.
 */
export function jobInstallCost(
  eiv: number,
  systemCostIndex: number,
  activity: ActivityType,
  facilityTax: number = DEFAULT_FACILITY_TAX,
  structureBonusMultiplier = 1.0,
): number {
  return Math.max(0, eiv * (systemCostIndex * structureBonusMultiplier + facilityTax + sccSurcharge(activity)));
}

/** Estimated Item Value: sum of a blueprint's BASE (ME-0) material quantities x each material's live ESI adjusted_price, for one run - explicitly NOT reduced by the character's actual ME level (confirmed by both reference tools independently). */
export function estimatedItemValue(baseMaterials: { typeId: number; quantity: number }[], adjustedPriceByTypeId: Map<number, number>): number {
  return baseMaterials.reduce((sum, m) => sum + m.quantity * (adjustedPriceByTypeId.get(m.typeId) ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Reprocessing / refining yield
//
// Full formula (Upwell structures), verified via EVE University wiki -
// meaningfully more complete than eve-tools-suite's implementation, which
// is missing the security and rig terms entirely and has the wrong base
// structure rates:
//   Yield = (50 + Rm) x (1+Sec) x (1+Sm) x (1+R*0.03) x (1+Re*0.02) x (1+Op*0.02) x (1+Im)

export type SecurityBand = "highsec" | "lowsec" | "null_or_wh";
export type ReprocessingFacility = "npc_station" | "citadel_or_engineering_complex" | "athanor" | "tatara";
export type ReprocessingRig = "none" | "t1" | "t2";

/** NPC stations genuinely vary (30-50%) rather than a single fixed rate - 50 is the commonly-assumed "good station" default, not a universal constant. */
export const REPROCESSING_BASE_RATE: Record<ReprocessingFacility, number> = {
  npc_station: 50,
  citadel_or_engineering_complex: 50,
  athanor: 51,
  tatara: 52,
};

const REPROCESSING_STRUCTURE_MODIFIER: Record<ReprocessingFacility, number> = {
  npc_station: 0,
  citadel_or_engineering_complex: 0,
  athanor: 0.02,
  tatara: 0.055,
};

const REPROCESSING_RIG_MODIFIER: Record<ReprocessingRig, number> = { none: 0, t1: 1, t2: 3 };
const SECURITY_MODIFIER: Record<SecurityBand, number> = { highsec: 0, lowsec: 0.06, null_or_wh: 0.12 };
/** Implant bonus percentages (RX-801/802/804), as fractions - verified matching set (1/2/4%) between eve-tools-suite and the wiki independently. */
export const REPROCESSING_IMPLANT_BONUS = { none: 0, rx801: 0.01, rx802: 0.02, rx804: 0.04 } as const;

export interface ReprocessingYieldInput {
  facility: ReprocessingFacility;
  rig: ReprocessingRig;
  security: SecurityBand;
  reprocessingLevel: number;
  reprocessingEfficiencyLevel: number;
  oreProcessingLevel: number;
  implantBonus: number;
}

/** Returns the effective yield as a fraction (e.g. 0.549 = 54.9%), not a percentage. */
export function reprocessingYield(input: ReprocessingYieldInput): number {
  const base = REPROCESSING_BASE_RATE[input.facility] + REPROCESSING_RIG_MODIFIER[input.rig];
  const yieldPct =
    base *
    (1 + SECURITY_MODIFIER[input.security]) *
    (1 + REPROCESSING_STRUCTURE_MODIFIER[input.facility]) *
    (1 + input.reprocessingLevel * 0.03) *
    (1 + input.reprocessingEfficiencyLevel * 0.02) *
    (1 + input.oreProcessingLevel * 0.02) *
    (1 + input.implantBonus);
  return yieldPct / 100;
}

/** Whole reprocessing lots only (partial portions are discarded, not partially refined) - floored per material, matching LazyBlacksmith's "plancher par matériau, lots entiers" behavior. */
export function reprocessedMaterialQuantity(materialQtyPerPortion: number, quantityHeld: number, portionSize: number, yieldFraction: number): number {
  const portions = Math.floor(quantityHeld / portionSize);
  return Math.floor(materialQtyPerPortion * portions * yieldFraction);
}

// ---------------------------------------------------------------------------
// Invention
//
// Base output values (1 run / ME 2 / TE 4 before any decryptor) and the
// probability/decryptor formulas are LazyBlacksmith's, traced to real SDE
// dogma attribute ids for decryptor effects (1112=probability,
// 1113=ME, 1114=TE, 1124=runs) - not re-derived or guessed.

export const INVENTION_BASE_RUNS = 1;
export const INVENTION_BASE_ME = 2;
export const INVENTION_BASE_TE = 4;

export interface DecryptorEffect {
  probabilityMultiplier: number;
  runModifier: number;
  meModifier: number;
  teModifier: number;
}

export function inventionProbability(baseProbability: number, encryptionSkillLevel: number, datacore1Level: number, datacore2Level: number, decryptor?: DecryptorEffect): number {
  const skillModifier = 1 + encryptionSkillLevel / 40 + (datacore1Level + datacore2Level) / 30;
  return baseProbability * skillModifier * (decryptor?.probabilityMultiplier ?? 1);
}

export function inventionOutputRuns(decryptor?: DecryptorEffect): number {
  return INVENTION_BASE_RUNS + (decryptor?.runModifier ?? 0);
}
export function inventionOutputMe(decryptor?: DecryptorEffect): number {
  return INVENTION_BASE_ME + (decryptor?.meModifier ?? 0);
}
export function inventionOutputTe(decryptor?: DecryptorEffect): number {
  return INVENTION_BASE_TE + (decryptor?.teModifier ?? 0);
}

/** Only Advanced Industry affects invention time - encryption/datacore skills affect probability, not speed. */
export function inventionTimeSeconds(baseInventionTime: number, facilityModifier: number, advancedIndustryLevel: number, rigBonus = 0): number {
  return baseInventionTime * facilityModifier * (1 - 0.03 * advancedIndustryLevel) * (1 - rigBonus);
}

const INVENTION_JOB_TAX = 1.1;
export function inventionInstallCost(baseCost: number, systemCostIndex: number, runs: number): number {
  return baseCost * systemCostIndex * runs * 0.02 * INVENTION_JOB_TAX;
}

// ---------------------------------------------------------------------------
// Research (ME/TE)

/** Shared level-scaling term for both ME and TE research time/cost - same formula, verified matching in both LazyBlacksmith's JS and its server-side Python duplicate. */
export function researchLevelModifier(level: number): number {
  return (250 * 2 ** (1.25 * level - 2.5)) / 105;
}

/** ME research uses the Metallurgy skill (5%/level); TE research uses the Research skill (5%/level) - pass whichever applies as researchSkillLevel. */
export function researchTimeSeconds(
  baseResearchTime: number,
  level: number,
  facilityModifier: number,
  implantModifier: number,
  researchSkillLevel: number,
  advancedIndustryLevel: number,
  rigBonus = 0,
): number {
  const timeModifier = facilityModifier * implantModifier * (1 - researchSkillLevel * 0.05) * (1 - advancedIndustryLevel * 0.03) * (1 - rigBonus);
  return timeModifier * baseResearchTime * researchLevelModifier(level);
}

const RESEARCH_JOB_TAX = 1.1;
export function researchInstallCost(baseCost: number, systemCostIndex: number, level: number): number {
  return baseCost * systemCostIndex * 0.02 * researchLevelModifier(level) * RESEARCH_JOB_TAX;
}
