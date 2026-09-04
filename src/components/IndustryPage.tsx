import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, CornerDownRight, Factory, Star, X } from "lucide-react";
import { NumberStepperInput } from "./NumberStepperInput";
import {
  searchBlueprints,
  getBlueprintDetail,
  getIndustrySystemCostIndices,
  getReprocessingMaterials,
  type TypeSearchMatch,
  type ReprocessingInfo,
  type BlueprintDetail,
} from "../lib/industry";
import {
  getMarketPrices,
  getRegionSellMinPrices,
  getCategoryGroups,
  getGroupItems,
  getInventableBlueprintGroups,
  getInventableBlueprintsInGroup,
  getResearchableBlueprintGroups,
  getResearchableBlueprintsInGroup,
  getItemDetail,
  type GroupSummary,
  type TypeSummary,
} from "../lib/market";
import { buildCostTree, repriceTree, type BuildTreeNode } from "../lib/industryBuildTree";
import {
  computeJobCostBreakdown,
  type JobCostBreakdown,
  estimatedItemValue,
  reprocessingYield,
  reprocessedMaterialQuantity,
  REPROCESSING_BASE_RATE,
  REPROCESSING_IMPLANT_BONUS,
  inventionProbability,
  inventionOutputRuns,
  inventionOutputMe,
  inventionOutputTe,
  inventionTimeSeconds,
  researchTimeSeconds,
  type ActivityType,
  type ReprocessingFacility,
  type ReprocessingRig,
  type SecurityBand,
  type DecryptorEffect,
} from "../lib/industryMath";
import { formatIsk, typeIconUrl } from "../lib/format";
import { searchSystemsLive, TRADE_HUB_REGIONS, type SystemSearchMatch } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useIndustryDefaults } from "../hooks/useIndustryDefaults";
import { useBlueprintFavourites, type BlueprintFavourite } from "../hooks/useBlueprintFavourites";
import HelpBadge from "./HelpBadge";
import { HELP_CONTENT } from "../lib/helpContent";

// EVE's real "Asteroid" item category - confirmed against the local SDE
// cache (every group filed under it is a mineable ore or ice variant,
// nothing else) rather than assumed from memory. Reprocessing_materials
// data confirms Salvage has no reprocessing recipe of its own in the
// current SDE (it's already a refined output, not something you'd
// reprocess further), so the browse list below is Ore/Ice only.
const ORE_CATEGORY_ID = 25;

/** Plain object rather than importing HelpContent - structurally identical
 * to what HelpBadge expects, and this glossary only makes sense pinned to
 * the Costs sidebar itself, not the page-level help registry every other
 * tab's badge reads from. */
const COSTS_SIDEBAR_HELP = {
  title: "Costs",
  what: "Every cost figure for the current build in one place - the material cost from the Build Steps tree, plus (once a system is picked and Calculate Build Cost run) the real job-installation cost the in-game Industry window itself would charge.",
  how: [
    "Per Unit is a fixed property of the item itself - Build Cost, Job Cost, and Build Time here never move when you change Runs, since that's what building just one costs regardless of batch size.",
    "The block below it is the full batch for however many Runs you've set - the same Build Cost/Job Cost/Build Time, scaled up, plus a Total Job Run Cost for the whole order.",
    "Blueprint Cost - what buying the blueprint/BPC itself cost you - is entered next to the search box above, before or after calculating. Once set, it shows as its own line in both boxes and counts toward Total Job Run Cost alongside Build Cost and Job Cost.",
    "Job Cost per Run further down is always for a single run too, regardless of how many Runs you've set - untick the checkboxes in the Build Steps tree instead to price just what you actually still need to buy or build, then Copy to Clipboard for a ready-to-paste Multibuy list.",
  ],
  gives: [
    "Estimated Item Value (EIV): the game's own valuation of this build's base (0% ME) materials at real Trade Hub prices - not reduced by your actual ME level.",
    "System Cost Index (SCI): the picked system's live industry activity index, from ESI - busier systems cost more to build in.",
    "Structure Role Bonus: a cost-reduction the structure owner can set - manual entry, since no ESI endpoint exposes it. Reduces just the SCI portion, not the taxes.",
    "Facility Tax: 0.25% fixed at NPC stations; owner-set, capped at 10%, at player structures - also manual entry, same ESI limitation.",
    "SCC Surcharge: CCP's own fixed cut - 4% for manufacturing/reaction/invention/copying, 2% for ME/TE research.",
    "Alpha Clone Tax: an extra flat 0.25% of EIV, Alpha clones only.",
    "Total Job Cost: Job Gross Cost (SCI after any role bonus) plus every tax above - this is the number that gets added into Total Cost.",
  ],
};

const FACILITY_LABEL: Record<ReprocessingFacility, string> = {
  npc_station: "NPC Station",
  citadel_or_engineering_complex: "Citadel / Engineering Complex",
  athanor: "Athanor (Refinery)",
  tatara: "Tatara (Refinery)",
};

const RIG_LABEL: Record<ReprocessingRig, string> = {
  none: "None",
  t1: "T1 Reprocessing Rig",
  t2: "T2 Reprocessing Rig",
};

const SECURITY_LABEL: Record<SecurityBand, string> = {
  highsec: "Highsec",
  lowsec: "Lowsec",
  null_or_wh: "Nullsec / Wormhole",
};

type ImplantTier = keyof typeof REPROCESSING_IMPLANT_BONUS;

const IMPLANT_LABEL: Record<ImplantTier, string> = {
  none: "None",
  rx801: "RX-801 (+1%)",
  rx802: "RX-802 (+2%)",
  rx804: "RX-804 (+4%)",
};

type IndustryTab = "production" | "reprocessing" | "invention" | "research";

type StructureTier = "npc_station" | "engineering_complex";

const STRUCTURE_LABEL: Record<StructureTier, string> = {
  npc_station: "NPC Station",
  engineering_complex: "Engineering Complex",
};

interface DecryptorOption extends DecryptorEffect {
  key: string;
  label: string;
}

/** All 8 real decryptors and their exact modifiers - verified against the
 * EVE University wiki's Invention page (2026-08-20), not guessed. A blank/
 * omitted TE modifier on the wiki (Augmentation, Optimized Augmentation)
 * means 0, not "unknown". */
const DECRYPTORS: DecryptorOption[] = [
  { key: "none", label: "None", probabilityMultiplier: 1, runModifier: 0, meModifier: 0, teModifier: 0 },
  { key: "accelerant", label: "Accelerant (+20% chance)", probabilityMultiplier: 1.2, runModifier: 1, meModifier: 2, teModifier: 10 },
  { key: "attainment", label: "Attainment (+80% chance)", probabilityMultiplier: 1.8, runModifier: 4, meModifier: -1, teModifier: 4 },
  { key: "augmentation", label: "Augmentation (-40% chance)", probabilityMultiplier: 0.6, runModifier: 9, meModifier: -2, teModifier: 0 },
  { key: "optimized_attainment", label: "Optimized Attainment (+90% chance)", probabilityMultiplier: 1.9, runModifier: 2, meModifier: 1, teModifier: -2 },
  { key: "optimized_augmentation", label: "Optimized Augmentation (-10% chance)", probabilityMultiplier: 0.9, runModifier: 7, meModifier: 2, teModifier: 0 },
  { key: "parity", label: "Parity (+50% chance)", probabilityMultiplier: 1.5, runModifier: 3, meModifier: 1, teModifier: -2 },
  { key: "process", label: "Process (+10% chance)", probabilityMultiplier: 1.1, runModifier: 0, meModifier: 3, teModifier: 6 },
  { key: "symmetry", label: "Symmetry (+0% chance)", probabilityMultiplier: 1.0, runModifier: 2, meModifier: 1, teModifier: 8 },
];

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** Whether a node renders the "Build" pill rather than "Buy" - shared by
 * the row itself and the sibling sort below so the two never disagree. */
function isBuildRow(node: BuildTreeNode): boolean {
  return node.activity != null && node.shouldBuild;
}

/** Each nesting level gets progressively darker/more recessed off the
 * theme's own --bg-elevated. Mixing toward --bg (tried first) turned out
 * not to work on every theme - Cold Ballast's --bg (#0a0f14) and
 * --bg-elevated (#101923) are both already near-black and barely differ
 * from each other, so no percentage between two almost-identical dark
 * values could ever produce real contrast. Mixing toward literal black
 * instead gives a genuinely large range to work with regardless of how
 * close together a given theme's own tokens happen to be - confirmed live
 * against Cold Ballast specifically, the theme that exposed the bug.
 * Reads as "one step further back/down" the deeper a tier goes - the same
 * real-world metaphor a recessed panel or a folder nested further into a
 * drawer uses. Capped so a genuinely deep BOM doesn't bottom out solid
 * black by the time it reaches raw materials. */
function tierTint(depth: number): string {
  // 12%/tier capped at 65% - strong enough that adjacent tiers are
  // actually distinguishable at a glance in a real, deeply-nested BOM
  // (four or five tiers visible at once), not just barely-different
  // shades of the same box.
  const percent = Math.min(depth * 12, 65);
  return `color-mix(in srgb, black ${percent}%, var(--bg-elevated))`;
}

/** Every checkable row's identity - the type_id chain from the tree root
 * down to that row, not a positional index. A plain index would break the
 * moment the build/buy sort below reorders siblings (the row a user
 * checked would silently become a different one); typeId chains stay
 * correct regardless of render order, since a blueprint never lists the
 * same material twice as sibling lines under one parent. */
function rowPath(parentPath: string, typeId: number): string {
  return `${parentPath}>${typeId}`;
}

/** Every ancestor of path, root-first, path itself included last - e.g.
 * "root>20125>11145" -> ["root", "root>20125", "root>20125>11145"]. Used
 * when expanding the root's own row: clears out any stale ticked state on
 * the row being drilled into and everything above it - root's own path is
 * never consulted by sumVisibleTickedCost/collectCheckedItems either way
 * (they start at its direct Tier 1 children), so this just keeps
 * checkedPaths tidy rather than changing what actually gets counted. */
function ancestorPaths(path: string): string[] {
  const parts = path.split(">");
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    result.push(parts.slice(0, i + 1).join(">"));
  }
  return result;
}

/** Every path in node's own subtree, itself included - used both to seed
 * "everything ticked" on a fresh calculation and to cascade an uncheck
 * down through a node's descendants (see toggleChecked's comment for why
 * that cascade matters). */
function collectPaths(node: BuildTreeNode, path: string, into: Set<string>): Set<string> {
  into.add(path);
  for (const child of node.materials) {
    collectPaths(child, rowPath(path, child.typeId), into);
  }
  return into;
}

/** Every distinct type_id anywhere in the tree, root included - used to
 * fetch real hub sell prices for every row at once (not just the flattened
 * shopping-list leaves), since a Build row's own per-unit hub price is just
 * as real a number to show as a Buy row's. */
function collectAllTypeIds(node: BuildTreeNode, into: Set<number> = new Set()): Set<number> {
  into.add(node.typeId);
  for (const child of node.materials) collectAllTypeIds(child, into);
  return into;
}

/** Walks root's whole subtree once, bucketing every descendant by tier
 * depth (root's own direct materials are Tier 1) instead of returning a
 * tree BuildTreeFlatList would have to recurse into itself - that's the
 * exact "each level nests its own box" shape this replaces. A Map (not a
 * plain object) so insertion order - the order tiers are actually
 * discovered in, which since root is walked breadth-first-by-recursion is
 * already shallowest-first - is the iteration order, with no separate
 * sort-the-keys step needed. Each tier's own rows are build-first sorted
 * (isBuildRow) before being pushed, matching the ordering the old nested
 * view used within one parent's children - now applied across every
 * parent contributing to that tier, not just siblings under one node.
 * Each row also carries its own parentName/parentPath - a tier below the
 * first mixes materials from however many different parents contributed to
 * it (Life Support Backup Unit's own materials sitting right next to Auto-
 * Integrity Preservation Seal's), and the recursive walk here processes one
 * parent's whole contribution to a tier before moving to the next parent -
 * so consecutive rows sharing a parentName are already guaranteed to be
 * genuinely one contiguous group, not coincidentally adjacent. */
function flattenByTier(
  root: BuildTreeNode,
  rootPath: string,
): [number, { node: BuildTreeNode; path: string; parentName: string; parentPath: string }[]][] {
  const tiers = new Map<number, { node: BuildTreeNode; path: string; parentName: string; parentPath: string }[]>();
  function walk(node: BuildTreeNode, path: string, depth: number) {
    const sorted = [...node.materials].sort((a, b) => Number(isBuildRow(b)) - Number(isBuildRow(a)));
    for (const child of sorted) {
      const childPath = rowPath(path, child.typeId);
      if (!tiers.has(depth)) tiers.set(depth, []);
      tiers.get(depth)!.push({ node: child, path: childPath, parentName: node.name, parentPath: path });
      walk(child, childPath, depth + 1);
    }
  }
  walk(root, rootPath, 1);
  return Array.from(tiers.entries());
}

/** Does `node` have at least one of its own direct materials still ticked
 * right now - the switch between "build it from what's ticked below" and
 * "just use its plain Buy Cost", independent of whether its tier happens
 * to be open on screen. Opening a tier is just looking; ticking/unticking
 * what's under it is deciding. Untick every one of a buildable's own
 * materials and it falls straight back to the exact number it showed
 * before its tier was ever opened - re-tick any of them and the rollup
 * comes right back - all without needing to touch the buildable's own
 * checkbox, which stays free to mean something else entirely - unticking
 * a buildable's own checkbox directly removes it (and everything under
 * it) from cost outright, a stronger statement than "don't buy it
 * pre-made" (see sumVisibleTickedCost's own comment). */
function hasTickedMaterials(node: BuildTreeNode, path: string, checked: Set<string>): boolean {
  return node.materials.some((child) => checked.has(rowPath(path, child.typeId)));
}

/** What `node`'s own Total column is showing right now - its plain Buy
 * Cost whenever its own tier is closed OR none of its own materials are
 * ticked (an estimate, not a real breakdown backing it - see
 * .industry-build-cost-pending), or the rollup of just its ticked
 * materials once its tier is open AND at least one of them is ticked, or
 * a leaf's own totalCost always, since a leaf has neither a tier nor
 * materials of its own to defer to. Recurses through tickedMaterialsRollup
 * below however many tiers deep the BOM actually goes - reverting a Tier 4
 * item back to its own Buy Cost now correctly ripples all the way up
 * through Tier 3, 2 and 1, not just one level. Used here so
 * sumVisibleTickedCost below always agrees with what the tree itself is
 * showing - it used to use node.totalCost directly (the fully-recursive
 * theoretical best cost, computed once up front regardless of the UI's own
 * tier/tick state), which silently assumed every tier was already open
 * (and everything under it ticked) even when it visibly wasn't, so the
 * Costs sidebar's Build Cost disagreed with the tree's own Tier 1 total. */
function effectiveNodeCost(node: BuildTreeNode, path: string, depth: number, collapsedTiers: Set<number>, checked: Set<string>): number {
  if (node.materials.length === 0) return node.totalCost;
  const tierOpen = !collapsedTiers.has(depth + 1);
  if (!tierOpen || !hasTickedMaterials(node, path, checked)) return node.buyCostPerUnit * node.quantityNeeded;
  return tickedMaterialsRollup(node, path, depth, collapsedTiers, checked);
}

/** The sum of `node`'s own direct materials that are actually ticked right
 * now - an unticked material drops out of the rollup entirely, the same
 * "untick it and it stops counting" rule every other row already follows,
 * just applied to what a parent rolls up instead of to a row's own
 * standalone cost. Each ticked child is priced via effectiveNodeCost
 * itself (mutually recursive with it) - a child that's ALSO a buildable
 * with its own tier open and its own ticked materials resolves the exact
 * same way, all the way down however many tiers the BOM goes, instead of
 * stopping one level down and falling back to a single precomputed
 * "assume everything below is optimal" number the way this used to.
 * Shared by BuildTreeRow's own Total column render and effectiveNodeCost
 * above, so the two can never compute this differently from each other
 * again (see that function's own comment for the bug this shared
 * implementation originally fixed). depth here is the depth of `node`
 * itself - children sit one tier below it. */
function tickedMaterialsRollup(node: BuildTreeNode, path: string, depth: number, collapsedTiers: Set<number>, checked: Set<string>): number {
  return node.materials.reduce((sum, child) => {
    const childPath = rowPath(path, child.typeId);
    if (!checked.has(childPath)) return sum;
    return sum + effectiveNodeCost(child, childPath, depth + 1, collapsedTiers, checked);
  }, 0);
}

/** Build Cost, wherever it's ticked, is the sum of Tier 1's own contributions
 * - unticked entirely (contributes nothing, subtree and all - see below),
 * or effectiveNodeCost's own number, which already resolves down through
 * whatever's ticked beneath it on its own, however deep that goes. A
 * ticked node's own effective cost IS its entire contribution: recursing
 * any further into its children on top of that would double-count the
 * same real-world purchase (a buildable and the materials that make it up
 * can't both be on the same bill). An unticked node contributes nothing at
 * all, subtree included - "I already have this, however it'd otherwise be
 * sourced" is a stronger, more encompassing statement than "just don't buy
 * the pre-made version", which is what ticking/unticking its own materials
 * instead is for (see hasTickedMaterials/effectiveNodeCost). This used to
 * walk the whole tree top-down and stop recursing at the first TICKED
 * ancestor instead - which meant a Tier 2+ checkbox had no effect at all
 * unless its Tier 1 ancestor was ALSO unticked first, since ticking the
 * ancestor short-circuited before ever looking at its children's own
 * state. Ticking/unticking anywhere now always does something, immediately. */
function sumVisibleTickedCost(root: BuildTreeNode, rootPath: string, checked: Set<string>, collapsedTiers: Set<number>): number {
  let sum = 0;
  for (const child of root.materials) {
    const path = rowPath(rootPath, child.typeId);
    if (checked.has(path)) sum += effectiveNodeCost(child, path, 1, collapsedTiers, checked);
  }
  return sum;
}

/** Every real, still-wanted item's name + quantity, for the Multibuy
 * clipboard export - same "a ticked node IS its own contribution, an
 * unticked one contributes nothing at all" rule sumVisibleTickedCost
 * follows, just collecting items instead of summing cost. A ticked
 * buildable whose own tier is open (and has ticked materials of its own)
 * isn't itself the thing to go buy - its now-active materials are, so this
 * recurses into them instead of listing the buildable itself; everything
 * else (a leaf, or a buildable that's reverted to its plain Buy Cost) IS
 * the thing to list. Summed by type_id in case the same material ends up
 * checked at more than one point in the tree, so the pasted list doesn't
 * show the same item on two separate lines. */
function collectEffectiveItems(
  node: BuildTreeNode,
  path: string,
  depth: number,
  collapsedTiers: Set<number>,
  checked: Set<string>,
  into: Map<number, { name: string; quantity: number }>,
): void {
  const tierOpen = !collapsedTiers.has(depth + 1);
  const usesRollup = node.materials.length > 0 && tierOpen && hasTickedMaterials(node, path, checked);
  if (!usesRollup) {
    const existing = into.get(node.typeId);
    into.set(node.typeId, { name: node.name, quantity: (existing?.quantity ?? 0) + node.quantityNeeded });
    return;
  }
  for (const child of node.materials) {
    const childPath = rowPath(path, child.typeId);
    if (checked.has(childPath)) collectEffectiveItems(child, childPath, depth + 1, collapsedTiers, checked, into);
  }
}

function collectCheckedItems(
  root: BuildTreeNode,
  rootPath: string,
  checked: Set<string>,
  collapsedTiers: Set<number>,
): Map<number, { name: string; quantity: number }> {
  const into = new Map<number, { name: string; quantity: number }>();
  for (const child of root.materials) {
    const path = rowPath(rootPath, child.typeId);
    if (checked.has(path)) collectEffectiveItems(child, path, 1, collapsedTiers, checked, into);
  }
  return into;
}

interface BuildTreeRowProps {
  node: BuildTreeNode;
  depth: number;
  path: string;
  checkedPaths: Set<string>;
  onToggle: (node: BuildTreeNode, path: string) => void;
  /** Only the root (depth 0) actually expands/collapses in place - every
   * other row is rendered flat now (see BuildTreeFlatList) and passes
   * neither of these. */
  expanded?: boolean;
  onExpandToggle?: (node: BuildTreeNode, path: string, expanding: boolean) => void;
  /** type_id -> group_name (e.g. "Mineral"), shown on hover over the row's
   * own icon+name. Missing entries (lookup still in flight, or failed)
   * just mean no tooltip - never block rendering the row itself on it. */
  itemGroupNames: Map<number, string>;
  /** Which tier depths are currently collapsed - lifted all the way up to
   * ProductionCalculator (not owned locally by BuildTreeFlatList) so both
   * a row's own reveal state AND its Total column's rollup of its
   * children can react to tier state, all the way up to the root. See
   * nextTierExpanded/effectiveMaterialsTotal below for how each is used. */
  collapsedTiers: Set<number>;
}

/** Renders exactly one row's own content - never its children. The root
 * (depth 0) is the only row that still expands/collapses in place (its own
 * chevron, its own onClick); every other row is always a flat, non-
 * expandable line now - see BuildTreeFlatList, which renders the whole
 * rest of the BOM as one flat box grouped by tier instead of each row
 * nesting its own separately-boxed children the way this used to work.
 * Real testing found the old nested-box-within-box presentation genuinely
 * hard to read once a BOM went more than two or three tiers deep - one
 * flat box with a line between tiers reads far more clearly. */
function BuildTreeRow({
  node,
  depth,
  path,
  checkedPaths,
  onToggle,
  expanded,
  onExpandToggle,
  itemGroupNames,
  collapsedTiers,
}: BuildTreeRowProps) {
  const indent = 10 + depth * 18;
  const groupName = itemGroupNames.get(node.typeId);
  const hasChildren = node.materials.length > 0;
  const buyTotal = node.buyCostPerUnit * node.quantityNeeded;
  /** The root has no "tier below its own tier" concept the way every other
   * row does (it isn't part of any tier itself), so its own breakdown is
   * always considered open. Every other row waits on collapsedTiers not
   * having its own next tier (depth + 1) in it. */
  const nextTierExpanded = depth === 0 || !collapsedTiers.has(depth + 1);
  /** A leaf (no materials) has no "tier below" to wait on - it always
   * shows its own real Total. A buildable row's Total instead starts out
   * as its own Buy Cost (all that's known about it before its tier is
   * open) and is replaced by the real build breakdown - see the Total
   * column render below - once that tier opens AND at least one of its
   * own materials is still ticked (see hasTickedMaterials). Untick every
   * one of them and this row falls straight back to Buy Cost, exactly as
   * if the tier had never been opened - the tier stays visually open (it's
   * still worth looking at), it just stops backing this row's own number. */
  const showBreakdown = !hasChildren || (nextTierExpanded && hasTickedMaterials(node, path, checkedPaths));
  /** Once a buildable's own tier opens (and something under it is ticked),
   * its Total stops being its plain Buy Cost and becomes the real
   * materials rollup instead - comparing that new number back against the
   * Buy Cost it just replaced is exactly "is building this actually
   * cheaper than just buying it, now that I can see the real breakdown",
   * so it's colored the same way any other before/after price change
   * would be: green if opening the tier saved money, red if it actually
   * costs more than buying outright would have. A leaf never has this
   * comparison (its Total never changes state), and neither does a
   * buildable whose tier is closed or has nothing ticked under it right
   * now (nothing's currently backing a breakdown to compare against). */
  const resolvedTotal = hasChildren && showBreakdown ? tickedMaterialsRollup(node, path, depth, collapsedTiers, checkedPaths) : null;
  const totalValue = !showBreakdown ? buyTotal : (resolvedTotal ?? node.totalCost);
  const totalIsCheaper = resolvedTotal != null && resolvedTotal < buyTotal;
  const totalIsCostlier = resolvedTotal != null && resolvedTotal > buyTotal;

  return (
    <div className="market-tree-node industry-build-node">
      <div className="market-browser-tree-item industry-build-row" style={{ paddingLeft: indent }}>
        {/* The root product (the actual thing being built, e.g. the Curse
            itself) has no checkbox - "opting out" of it is meaningless, and
            expanding its own row already unticks it automatically via
            handleExpandToggle, same as any other row. */}
        {depth > 0 && (
          <input
            type="checkbox"
            className="industry-build-checkbox"
            checked={checkedPaths.has(path)}
            onChange={() => onToggle(node, path)}
            aria-label={`Include ${node.name} in the Multibuy clipboard export`}
          />
        )}
        <button
          type="button"
          className="industry-build-row-body"
          onClick={() => {
            if (depth !== 0 || !hasChildren || !onExpandToggle) return;
            onExpandToggle(node, path, !expanded);
          }}
        >
          <img src={typeIconUrl(node.typeId, 32, node.name)} alt="" className="market-browser-row-icon" title={groupName} />
          <span className="market-browser-tree-item-label" title={groupName}>
            {node.name}
            {node.activity != null && (
              <Factory
                size={12}
                strokeWidth={2}
                className="industry-build-has-blueprint"
                aria-label="Has a blueprint/reaction formula"
              >
                <title>Has a blueprint/reaction formula - could be built instead of bought</title>
              </Factory>
            )}
          </span>
          <span className="industry-build-qty-col" title="Total Quantity: the total number of units required for this stage of the build.">
            x{node.quantityNeeded.toLocaleString()}
          </span>
          {/* Total always shows a number - a buildable row starts out
              showing its own Buy Cost here (grey/muted: an estimate, not
              yet the real breakdown) and this same slot is replaced by the
              combined cost of the tier below once that tier is actually
              open, propagating the same "replace the estimate with the
              real number" rule all the way up to the root's own Total. A
              leaf material has no tier below to wait on, so it always
              shows its own real totalCost here. */}
          <span
            className={`industry-build-cost${!showBreakdown ? " industry-build-cost-pending" : ""}${totalIsCheaper ? " industry-build-cost-cheaper" : ""}${totalIsCostlier ? " industry-build-cost-costlier" : ""}`}
            title={
              !showBreakdown
                ? "Total: the Trade Hub cost of buying the full quantity needed outright - shown until the tier below is open, then replaced by the real cost to build this instead."
                : resolvedTotal != null
                  ? `Total: the combined Trade Hub cost of all required materials from the tier directly below - ${
                      totalIsCheaper ? "cheaper" : totalIsCostlier ? "more expensive" : "the same"
                    } than the ${formatIsk(buyTotal)} it'd cost to just buy this outright.`
                  : "Total: this item's own assessed cost - the cheaper of building it from its own materials or buying it outright."
            }
          >
            {formatIsk(totalValue)}
          </span>
          {depth === 0 && hasChildren && (
            <ChevronRight size={13} strokeWidth={2} className={`market-tree-chevron${expanded ? " market-tree-chevron-open" : ""}`} />
          )}
        </button>
      </div>
    </div>
  );
}

/** Everything under the root, flattened into one box and grouped by tier
 * (root's direct materials = Tier 1, their own materials = Tier 2, and so
 * on) instead of each row nesting its own separately-boxed, separately-
 * indented children the recursive version used to render. Walks the whole
 * subtree once up front (flattenByTier) rather than each BuildTreeRow
 * recursing into its own children at render time - the data is the exact
 * same recursive BuildTreeNode tree either way, only how it's laid out on
 * screen changes. */
/** A tri-state "select all" checkbox - ticked when every one of `paths` is
 * checked, unticked when none are, indeterminate (the dash state, not
 * exposed as a plain HTML attribute so it's set imperatively via ref) when
 * it's a mix. Clicking always moves to one of the two solid states: tick
 * everything if it wasn't already all ticked, untick everything if it was. */
function GroupCheckbox({
  paths,
  checkedPaths,
  onToggleGroup,
  label,
}: {
  paths: string[];
  checkedPaths: Set<string>;
  onToggleGroup: (paths: string[], checked: boolean) => void;
  label: string;
}) {
  const checkedCount = paths.filter((p) => checkedPaths.has(p)).length;
  const allChecked = paths.length > 0 && checkedCount === paths.length;
  return (
    <input
      type="checkbox"
      className="industry-build-checkbox"
      checked={allChecked}
      ref={(el) => {
        if (el) el.indeterminate = checkedCount > 0 && checkedCount < paths.length;
      }}
      onChange={(e) => {
        e.stopPropagation();
        onToggleGroup(paths, !allChecked);
      }}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

function BuildTreeFlatList({
  root,
  rootPath,
  checkedPaths,
  onToggle,
  onToggleGroup,
  itemGroupNames,
  collapsedTiers,
  onToggleTier,
}: {
  root: BuildTreeNode;
  rootPath: string;
  checkedPaths: Set<string>;
  onToggle: (node: BuildTreeNode, path: string) => void;
  /** Ticks or unticks every path in the given list at once - backs both
   * the per-parent-group and per-tier "select all" checkboxes below. */
  onToggleGroup: (paths: string[], checked: boolean) => void;
  itemGroupNames: Map<number, string>;
  /** Lifted to ProductionCalculator (not owned locally here) so the root's
   * own Total - rendered by its own separate BuildTreeRow call up there,
   * outside this component entirely - can react to the same tier state
   * every row's own Total already does. */
  collapsedTiers: Set<number>;
  onToggleTier: (tierDepth: number) => void;
}) {
  const tiers = useMemo(() => flattenByTier(root, rootPath), [root, rootPath]);

  return (
    <div className="market-tree-children industry-build-children">
      <CornerDownRight size={13} strokeWidth={2} className="industry-build-tier-connector" aria-hidden="true" />
      {tiers.map(([tierDepth, rows], tierIndex) => {
        const tierCollapsed = collapsedTiers.has(tierDepth);
        const tierPaths = rows.map((r) => r.path);
        const tierTitle = (
          <div className="industry-build-tier-title-row">
            <GroupCheckbox
              paths={tierPaths}
              checkedPaths={checkedPaths}
              onToggleGroup={onToggleGroup}
              label={`Select all materials in Tier ${tierDepth}`}
            />
            <button type="button" className="industry-build-tier-title-btn" onClick={() => onToggleTier(tierDepth)}>
              <ChevronRight size={12} strokeWidth={2.5} className={`market-tree-chevron${tierCollapsed ? "" : " market-tree-chevron-open"}`} />
              <span className="industry-build-section-title">Tier {tierDepth}</span>
            </button>
          </div>
        );
        return (
          // tierTint(tierDepth) here, not on the flat box as a whole - one
          // flat box replaces the old nested-box-per-tier structure, but the
          // "deeper tier reads as progressively darker" signal that structure
          // carried is still worth keeping, just applied per tier-group
          // inside the one box instead of per nested box.
          <div key={tierDepth} className="industry-build-tier-group" style={{ background: tierTint(tierDepth) }}>
            {/* Tier 1 needs no divider of its own - it's always first, right
                after the tier connector above. Every tier after it is
                breaking away from the one before, so it gets a rule line. */}
            {tierIndex === 0 ? tierTitle : <div className="industry-build-materials-divider">{tierTitle}</div>}
            {!tierCollapsed &&
              (() => {
                // Running sum for the group currently being walked - reset
                // the moment a new parent starts, so by the group's last row
                // it holds exactly that parent's own materials total. Each
                // row's own contribution is effectiveNodeCost (0 if it's
                // unticked - matches tickedMaterialsRollup dropping an
                // unticked material out of its own parent's rollup), not
                // node.totalCost - the same number that row's own Total
                // column is showing right now (see that function's own
                // comment), so this subtotal can never disagree with what's
                // sitting directly above it.
                let groupSum = 0;
                return rows.map(({ node, path, parentName, parentPath }, rowIndex) => {
                  const isGroupStart = rowIndex === 0 || rows[rowIndex - 1].parentPath !== parentPath;
                  const isGroupEnd = rowIndex === rows.length - 1 || rows[rowIndex + 1].parentPath !== parentPath;
                  if (isGroupStart) groupSum = 0;
                  if (checkedPaths.has(path)) groupSum += effectiveNodeCost(node, path, tierDepth, collapsedTiers, checkedPaths);
                  // Every row from here up to (not including) the next
                  // parent boundary - flattenByTier's walk order already
                  // guarantees they're contiguous, so this is a plain
                  // forward scan, not a full re-group of the tier.
                  const groupPaths: string[] = [];
                  if (isGroupStart) {
                    for (let j = rowIndex; j < rows.length && rows[j].parentPath === parentPath; j++) {
                      groupPaths.push(rows[j].path);
                    }
                  }
                  return (
                    <Fragment key={path}>
                      {/* Tier 1 has exactly one parent (root) by construction -
                          a "for X" header there would just repeat the page's
                          own title. Every tier after it mixes materials from
                          however many different parents contributed to it, so
                          a small header at each parent boundary is what
                          actually answers "what is this batch of rows even
                          for" - flattenByTier's own walk order already
                          guarantees every one parent's rows are contiguous, so
                          a plain "did the parent change" check is enough. */}
                      {tierIndex > 0 && isGroupStart && (
                        <p className="industry-build-parent-header">
                          <GroupCheckbox
                            paths={groupPaths}
                            checkedPaths={checkedPaths}
                            onToggleGroup={onToggleGroup}
                            label={`Select all materials for ${parentName}`}
                          />
                          For {parentName}
                        </p>
                      )}
                      <BuildTreeRow
                        node={node}
                        depth={tierDepth}
                        path={path}
                        checkedPaths={checkedPaths}
                        onToggle={onToggle}
                        itemGroupNames={itemGroupNames}
                        collapsedTiers={collapsedTiers}
                      />
                      {/* A quick per-parent visual, not a real column - a
                          plain-language "does this batch add up to roughly
                          what I'd expect" check, right under the same
                          numbers it's summing. */}
                      {tierIndex > 0 && isGroupEnd && (
                        <div className="industry-build-parent-subtotal" style={{ paddingLeft: 10 + tierDepth * 18 }}>
                          <span />
                          <span className="industry-build-parent-subtotal-label">Materials Total</span>
                          <span />
                          <span className="industry-build-parent-subtotal-value">{formatIsk(groupSum)}</span>
                          <span />
                        </div>
                      )}
                    </Fragment>
                  );
                });
              })()}
          </div>
        );
      })}
    </div>
  );
}

function ProductionCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  /** Set right before loadFavourite assigns query/systemQuery directly -
   * lets the two debounced search effects below tell "the user is typing"
   * apart from "a favourite just restored an already-known selection", so
   * loading one doesn't pop a suggestions dropdown back open over a
   * blueprint/system that's already correctly selected. */
  const skipBlueprintSearch = useRef(false);
  const skipSystemSearch = useRef(false);

  const [defaultTradeHub] = useDefaultTradeHub();
  const { defaults: industryDefaults } = useIndustryDefaults();
  const { favourites, isFavourite, saveFavourite, removeFavourite } = useBlueprintFavourites();
  const [favouritesOpen, setFavouritesOpen] = useState(false);
  const [justFavourited, setJustFavourited] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  const [runs, setRuns] = useState(1);
  const [materialEfficiency, setMaterialEfficiency] = useState(industryDefaults.production.materialEfficiency);
  const [timeEfficiency, setTimeEfficiency] = useState(industryDefaults.production.timeEfficiency);
  const [structure, setStructure] = useState<StructureTier>(
    industryDefaults.production.structure === "npc_station" ? "npc_station" : "engineering_complex",
  );
  const [facilityTax, setFacilityTax] = useState(industryDefaults.production.facilityTax);
  // Job-cost inputs neither VESPER nor a plain ESI call can know on their
  // own: a structure's role bonus is set by its owner with no public
  // endpoint exposing it, and Alpha/Omega status has no direct ESI field
  // either (VESPER only guesses it elsewhere via skill levels, which isn't
  // reliable enough to silently apply a tax off of). Manual for now.
  const [structureRoleBonusPct, setStructureRoleBonusPct] = useState(0);
  const [isAlphaClone, setIsAlphaClone] = useState(false);

  const [systemQuery, setSystemQuery] = useState("");
  const [systemSuggestions, setSystemSuggestions] = useState<SystemSearchMatch[]>([]);
  const [systemSuggestionsOpen, setSystemSuggestionsOpen] = useState(false);
  const [system, setSystem] = useState<SystemSearchMatch | null>(null);

  const [tree, setTree] = useState<BuildTreeNode | null>(null);
  /** The job-cost panel (SCI/role-bonus/facility/SCC/alpha/total), kept as
   * its own piece of state rather than folded into the tree's totalCost -
   * pricedTree below recomputes totalCost from scratch off hub prices
   * every time they refresh, so anything added directly onto tree.totalCost
   * gets silently overwritten the moment that happens. Only set when a
   * system was picked (job cost needs a real System Cost Index); null
   * otherwise, which the footer treats as "nothing to add". */
  const [jobCost, setJobCost] = useState<JobCostBreakdown | null>(null);
  /** The blueprint/reaction-formula item itself - a one-time acquisition
   * cost separate from the per-unit material tree above (buildCostTree
   * starts from what the blueprint OUTPUTS, so the blueprint's own cost
   * never appears anywhere in that tree). Shown as its own line rather than
   * folded into totalCost/"Per unit", since owning the blueprint isn't a
   * per-run material cost. */
  const [blueprintCost, setBlueprintCost] = useState<{ typeId: number; name: string; cost: number } | null>(null);
  /** A manually-typed override for the blueprint row's cost, as a raw
   * string so the field can be edited freely (cleared, mid-typing, etc.)
   * without fighting a parsed number's re-formatting. Market/adjusted
   * pricing rarely covers blueprints at all (most aren't sold as market
   * orders, only via contracts), so this is the practical way to get a
   * real figure in: look the price up on contracts yourself and type it
   * in. */
  const [blueprintManualCost, setBlueprintManualCost] = useState("");
  /** Which Build Steps rows are ticked, keyed by rowPath (see BuildTreeRow) -
   * lets someone check off just the handful of items they still need
   * (already have the rest in a hangar, only buying part of the list this
   * trip, etc.) and see a total for only that subset instead of everything. */
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());
  /** Which Build Steps rows are currently expanded, keyed the same way as
   * checkedPaths - lifted up here (rather than local state per row) so
   * "Collapse All" can close every open tier from one place instead of
   * only ever being able to reach whichever single row's own state it is. */
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [calculating, setCalculating] = useState(false);
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [hubPrices, setHubPrices] = useState<Map<number, number>>(new Map());
  const [hubPricesLoading, setHubPricesLoading] = useState(false);
  /** typeId -> group_name (e.g. "Mineral", "Composite"), shown on hover
   * over a row's own icon+name. getItemDetail is a per-type lookup (local
   * SDE data, not a network call), so this fetches every distinct type in
   * the tree once, the same batch-then-cache pattern hubPrices already
   * uses, rather than one call per row per hover. */
  const [itemGroupNames, setItemGroupNames] = useState<Map<number, string>>(new Map());
  const reportError = useErrorReporter();

  /** Saves (or updates) the currently-selected blueprint's whole setup -
   * runs/ME/TE/structure/tax/trade hub/system - as a favourite, so it can
   * be picked from the list later with everything restored instead of
   * retyping it. Always overwrites rather than toggling off, so tweaking
   * an already-favourited setup and clicking again just updates it. */
  function handleFavouriteSetup() {
    if (!selected) return;
    saveFavourite({
      typeId: selected.id,
      name: selected.name,
      runs,
      materialEfficiency,
      timeEfficiency,
      structure,
      facilityTax,
      structureRoleBonusPct,
      isAlphaClone,
      hubRegionId,
      systemId: system?.id ?? null,
      systemName: system?.name ?? null,
      blueprintCost: blueprintManualCost,
    });
    setJustFavourited(true);
    window.setTimeout(() => setJustFavourited(false), 1500);
  }

  /** Loads a saved favourite's whole setup back in - just the inputs, not
   * an automatic recalculation, so this stays a simple, safe state
   * assignment rather than needing handleCalculate to read values that
   * haven't actually landed in state yet by the time it'd run. The
   * blueprint/system are restored as real selections, not just text in
   * their fields - skipBlueprintSearch/skipSystemSearch stop the normal
   * debounced-search effects from popping their suggestions dropdowns
   * back open over a selection that's already correct, which otherwise
   * looked like the blueprint/system hadn't actually been picked yet. */
  function loadFavourite(fav: BlueprintFavourite) {
    skipBlueprintSearch.current = true;
    setQuery(fav.name);
    setSuggestionsOpen(false);
    setSelected({ id: fav.typeId, name: fav.name, market_group_id: null, volume: 0 });
    setRuns(fav.runs);
    setMaterialEfficiency(fav.materialEfficiency);
    setTimeEfficiency(fav.timeEfficiency);
    setStructure(fav.structure === "npc_station" ? "npc_station" : "engineering_complex");
    setFacilityTax(fav.facilityTax);
    // ?? fallbacks: a favourite saved before these fields existed won't
    // have them in its stored JSON at all, not just at their zero-value
    // or empty-string default.
    setStructureRoleBonusPct(fav.structureRoleBonusPct ?? 0);
    setIsAlphaClone(fav.isAlphaClone ?? false);
    setHubRegionId(fav.hubRegionId);
    setBlueprintManualCost(fav.blueprintCost ?? "");
    skipSystemSearch.current = true;
    setSystemSuggestionsOpen(false);
    if (fav.systemId != null && fav.systemName != null) {
      setSystem({ id: fav.systemId, name: fav.systemName, security: 0 });
      setSystemQuery(fav.systemName);
    } else {
      setSystem(null);
      setSystemQuery("");
    }
    setTree(null);
    setJobCost(null);
    setFavouritesOpen(false);
  }

  useEffect(() => {
    if (skipBlueprintSearch.current) {
      skipBlueprintSearch.current = false;
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchBlueprints(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (skipSystemSearch.current) {
      skipSystemSearch.current = false;
      return;
    }
    const trimmed = systemQuery.trim();
    if (trimmed.length < 2) {
      setSystemSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSystemsLive(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSystemSuggestions(matches);
            setSystemSuggestionsOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setSystemSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [systemQuery]);

  useEffect(() => {
    if (!tree) {
      setHubPrices(new Map());
      return;
    }
    // Every distinct item anywhere in the tree, not just the flattened
    // shopping-list leaves - a Build row's own per-unit hub price is shown
    // too now, not only Buy rows, so it needs pricing just the same.
    const typeIds = Array.from(collectAllTypeIds(tree));
    if (typeIds.length === 0) {
      setHubPrices(new Map());
      return;
    }
    let cancelled = false;
    // Clear immediately rather than leaving the previous hub's numbers on
    // screen mislabeled as the new hub's - the row falls back to the
    // EVE-wide adjusted price (still a real number, just not hub-specific)
    // while the fresh per-hub fetch is in flight.
    setHubPrices(new Map());
    setHubPricesLoading(true);
    // One IPC call for the whole material list instead of one per material -
    // the backend batches and caches these itself now.
    getRegionSellMinPrices(hubRegionId, typeIds)
      .then((next) => {
        if (cancelled) return;
        setHubPrices(next);
      })
      .catch(() => {
        if (!cancelled) setHubPrices(new Map());
      })
      .finally(() => {
        if (!cancelled) setHubPricesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, hubRegionId]);

  useEffect(() => {
    if (!tree) {
      setItemGroupNames(new Map());
      return;
    }
    const typeIds = Array.from(collectAllTypeIds(tree));
    if (typeIds.length === 0) {
      setItemGroupNames(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      typeIds.map((typeId) =>
        getItemDetail(typeId)
          .then((detail) => [typeId, detail.group_name] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<number, string>();
      for (const r of results) if (r) next.set(r[0], r[1]);
      setItemGroupNames(next);
    });
    return () => {
      cancelled = true;
    };
  }, [tree]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setTree(null);
    setJobCost(null);
    setBlueprintCost(null);
    setCheckedPaths(new Set());
    setExpandedPaths(new Set());
    try {
      const detail = await getBlueprintDetail(selected.id);
      const activityInfo = detail.manufacturing ?? detail.reaction;
      const activity: ActivityType | null = detail.manufacturing ? "manufacturing" : detail.reaction ? "reaction" : null;
      if (!activityInfo || !activity) {
        reportError(`${selected.name} has no manufacturing or reaction data - it may not be a real blueprint/reaction formula.`);
        return;
      }

      const prices = await getMarketPrices();
      const priceByTypeId = new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0]));
      setBlueprintCost({ typeId: selected.id, name: selected.name, cost: priceByTypeId.get(selected.id) ?? 0 });

      // The blueprint/reaction-formula item itself is never a manufacturable
      // product (nothing produces "Orca Blueprint" - it's the SHIP that gets
      // built), so the tree must start from what the blueprint OUTPUTS, not
      // from the blueprint's own type_id.
      const output = activityInfo.products[0];
      if (!output) {
        reportError(`${selected.name} has no listed output product.`);
        return;
      }
      const totalQuantity = runs * output.quantity;

      const result = await buildCostTree(output.type_id, output.name, totalQuantity, {
        materialEfficiency,
        timeEfficiency,
        structureMaterialBonus: structure === "engineering_complex" ? 0.01 : 0,
        structureTimeBonus: structure === "engineering_complex" ? 0.15 : 0,
      }, priceByTypeId);
      setTree(result);
      // Opt-out by default: every material row starts ticked (the
      // blueprint row deliberately doesn't - see its own comment) so
      // "Selected total" reads as the real total until something's
      // unticked, rather than looking like nothing's selected yet.
      setCheckedPaths(collectPaths(result, rowPath("root", result.typeId), new Set()));
      // Tier 1 is always visible the moment the root's own row is
      // expanded - every tier past it starts closed, so a deep BOM
      // doesn't dump every raw material on screen unprompted; drilling
      // further in is an explicit choice made one tier at a time.
      const tierDepths = flattenByTier(result, rowPath("root", result.typeId)).map(([depth]) => depth);
      setCollapsedTiers(new Set(tierDepths.filter((depth) => depth !== 1)));

      if (system) {
        const costIndices = await getIndustrySystemCostIndices();
        const systemIndex = costIndices.find((c) => c.solar_system_id === system.id);
        const activityKey = activity === "manufacturing" ? "manufacturing" : "reaction";
        const costIndex = systemIndex?.indices[activityKey] ?? 0.05;
        const eiv = estimatedItemValue(
          activityInfo.materials.map((m) => ({ typeId: m.type_id, quantity: m.quantity * runs })),
          priceByTypeId,
        );
        setJobCost(computeJobCostBreakdown(eiv, costIndex, activity, facilityTax, structureRoleBonusPct, isAlphaClone));
      } else if (systemQuery.trim().length > 0) {
        // Typing a name into the System field doesn't select it on its own -
        // system only gets set by clicking a suggestion (see the input's
        // onChange, which clears it on every keystroke). Without this, a
        // typed-but-never-clicked system silently skipped the whole Job
        // Cost section with no feedback at all, which looked exactly like
        // the feature wasn't there.
        reportError(`"${systemQuery}" wasn't selected from the dropdown, so no Job Cost was calculated - pick a system from the suggestions list under the field to include it.`);
      }
    } catch (err) {
      reportError(`Failed to calculate build cost: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  /** Toggles a single tree row - no cascade into its subtree needed. A
   * descendant's own ticked state only ever gets consulted once its
   * ancestor chain is both ticked and has its tier open all the way down
   * to it (see effectiveNodeCost/hasTickedMaterials) - so touching a row
   * that isn't visible yet would just be reaching down and silently
   * changing something the user can't even see, for no actual effect on
   * cost right now. */
  function toggleChecked(_node: BuildTreeNode, path: string) {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Ticks or unticks a whole batch of rows at once - the group ("For X")
   * and tier ("Tier N") select-all checkboxes both just hand this the
   * paths of every row they cover. */
  function toggleCheckedPaths(paths: string[], checked: boolean) {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }

  /** This only ever fires for the root's own row now (see BuildTreeRow's
   * click gate) - opening it to look inside is itself a decision, so
   * expanding ticks its direct children (Tier 1 becomes what actually
   * gets priced - see sumVisibleTickedCost) and collapsing it back
   * reverses that, matching the rolled-up view collapsing back to.
   * ancestorPaths here just clears any stale ticked state on the row and
   * whatever's above it, tidying checkedPaths rather than changing what's
   * actually counted (root's own ticked state was never consulted
   * anyway). */
  function handleExpandToggle(node: BuildTreeNode, path: string, expanding: boolean) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (expanding) next.add(path);
      else next.delete(path);
      return next;
    });
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (expanding) {
        for (const p of ancestorPaths(path)) next.delete(p);
        for (const child of node.materials) next.add(rowPath(path, child.typeId));
      } else {
        next.add(path);
        for (const child of node.materials) next.delete(rowPath(path, child.typeId));
      }
      return next;
    });
  }

  /** Closes every open tier at once and puts the checkbox state back to
   * "everything ticked at the top" - the same state a fresh calculation
   * starts in - rather than leaving whatever ticks/unticks were made deep
   * in now-hidden branches silently still in effect. */
  function handleCollapseAll() {
    setExpandedPaths(new Set());
    if (tree) setCheckedPaths(collectPaths(tree, rowPath("root", tree.typeId), new Set()));
  }

  /** Every cost field re-derived off real Trade Hub prices instead of the
   * galaxy-wide index buildCostTree started from (see repriceTree) - the
   * one source of truth for Total cost/Per unit/Selected total/Build-vs-Buy
   * everywhere below, not just a column sitting next to a different number.
   * Falls back to the original galaxy-index price node by node wherever the
   * hub has no live sell orders, same as the per-row display already did;
   * an empty hubPrices map (nothing fetched yet) just means every node
   * falls back, so this is never null while tree itself isn't. */
  const pricedTree = useMemo(() => (tree ? repriceTree(tree, hubPrices) : null), [tree, hubPrices]);
  // The root is the only row that still expands/collapses in place - see
  // BuildTreeRow's own comment for why every other row is flat now.
  const rootPath = pricedTree ? rowPath("root", pricedTree.typeId) : "root";
  const rootExpanded = expandedPaths.has(rootPath);
  // Which tiers are currently collapsed - lifted up here (not owned by
  // BuildTreeFlatList) so the root's own Total, computed by its own
  // separate BuildTreeRow call below, can roll up the same tier-aware
  // child costs every other row's own Total already does.
  const [collapsedTiers, setCollapsedTiers] = useState<Set<number>>(new Set());
  function toggleTier(tierDepth: number) {
    setCollapsedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tierDepth)) next.delete(tierDepth);
      else next.add(tierDepth);
      return next;
    });
  }
  /** Build Cost, wherever it's shown in the Costs sidebar, is this - not
   * pricedTree.totalCost directly - so it always agrees with what the
   * Build Steps tree itself is showing: it starts out matching the tree's
   * own Tier 1 total (every Tier 1 material ticked by default, each
   * contributing whatever its own row currently shows - Buy Cost until
   * its tier opens, the real build breakdown after), moves in lockstep as
   * tiers get opened or closed, and only diverges from that tree total
   * once something actually gets unticked. */
  const tickedBuildCost = useMemo(
    () => (pricedTree ? sumVisibleTickedCost(pricedTree, rootPath, checkedPaths, collapsedTiers) : 0),
    [pricedTree, rootPath, checkedPaths, collapsedTiers],
  );

  // A manual entry always wins once typed, even "0" - only a genuinely
  // empty field falls back to the (usually unhelpful, market-order-based)
  // fetched price, so clearing the field back out restores that fallback.
  // Entered up front next to the blueprint search, before Calculate Build
  // Cost even runs, and survives calculation from then on (handleCalculate
  // used to reset it to blank on every run - fixed alongside this move).
  const blueprintEffectiveCost = blueprintManualCost.trim() !== "" ? Number(blueprintManualCost) || 0 : (blueprintCost?.cost ?? 0);
  /** What acquiring the blueprint/BPC itself cost - a real expense of the
   * job, folded into both Build Cost boxes (Per Unit divides it by
   * quantityNeeded, the full-batch box shows it flat) as its own Blueprint
   * Cost line. No more opt-in checkbox now that it's entered up front
   * instead of ticked in the Build Steps tree - typing a real cost in *is*
   * the opt-in. */
  const blueprintCostIncluded = blueprintEffectiveCost;

  /** Name\tQuantity per line - the same tab-separated shape EVE's own
   * inventory/contract copy produces, which is exactly what the game's
   * Multibuy paste box expects. Summed by type_id first (collectCheckedItems)
   * so the same material checked in two branches doesn't show up twice. */
  function handleCopyToClipboard() {
    const items = new Map<number, { name: string; quantity: number }>();
    if (blueprintCost) {
      items.set(blueprintCost.typeId, { name: blueprintCost.name, quantity: 1 });
    }
    if (pricedTree) {
      for (const [typeId, item] of collectCheckedItems(pricedTree, rowPath("root", pricedTree.typeId), checkedPaths, collapsedTiers)) {
        const existing = items.get(typeId);
        items.set(typeId, { name: item.name, quantity: (existing?.quantity ?? 0) + item.quantity });
      }
    }
    if (items.size === 0) return;
    const text = Array.from(items.values())
      .map((i) => `${i.name}\t${i.quantity}`)
      .join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setJustCopied(true);
        window.setTimeout(() => setJustCopied(false), 1500);
      })
      .catch((err) => reportError(`Failed to copy to clipboard: ${String(err)}`));
  }

  return (
    <div className="industry-production">
      <div className="industry-production-layout">
      <div className="industry-main-column">
      <div className="industry-inputs-panel">
        <div className="market-browser-favourites">
          <button
            type="button"
            className={`market-browser-favourites-toggle${favouritesOpen ? " market-browser-favourites-toggle-active" : ""}`}
            onClick={() => setFavouritesOpen((v) => !v)}
          >
            <Star size={14} strokeWidth={2} fill={favouritesOpen ? "currentColor" : "none"} />
            My Favourites
            {favourites.length > 0 && <span className="market-browser-favourites-count">{favourites.length}</span>}
          </button>
          {favouritesOpen &&
            (favourites.length === 0 ? (
              <p className="market-browser-favourites-empty">
                No favourites yet - pick a blueprint below, set it up how you like, then click "Favourite This Setup".
              </p>
            ) : (
              <div className="market-browser-favourites-list">
                {favourites.map((f) => (
                  <div key={f.typeId} className="industry-blueprint-favourite-row">
                    <button type="button" onClick={() => loadFavourite(f)}>
                      <img src={typeIconUrl(f.typeId, 32, f.name)} alt="" className="market-browser-row-icon" />
                      <span className="industry-blueprint-favourite-name">{f.name}</span>
                    </button>
                    <button
                      type="button"
                      className="industry-blueprint-favourite-remove"
                      onClick={() => removeFavourite(f.typeId)}
                      aria-label={`Remove ${f.name} from favourites`}
                      title="Remove from favourites"
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
        </div>

        <div className="industry-blueprint-search-row">
          <div className="industry-blueprint-search-field">
            <span>Blueprint</span>
            <div className="kills-add-combobox industry-blueprint-search">
              <input
                type="text"
                placeholder="Search for a blueprint or reaction formula..."
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                  setTree(null);
                  setBlueprintManualCost("");
                }}
                onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
                onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
              />
              {suggestionsOpen && (
                <div className="gatecheck-slot-results kills-add-suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelected(s);
                        setQuery(s.name);
                        setSuggestionsOpen(false);
                      }}
                    >
                      <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selected && (
            <label className="wh-field-label industry-blueprint-cost-inline">
              Blueprint Cost
              <input
                type="number"
                min={0}
                step="any"
                className="industry-field-input"
                placeholder="0.00"
                value={blueprintManualCost}
                onChange={(e) => setBlueprintManualCost(e.target.value)}
                title="What buying this blueprint/BPC cost you - most real prices come from contracts, not the market, so this is manual. Set it before or after calculating; it's added into Build Cost either way."
              />
            </label>
          )}
        </div>

        {selected && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Runs
              <NumberStepperInput value={runs} onChange={setRuns} min={1} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Material Efficiency
              <NumberStepperInput value={materialEfficiency} onChange={setMaterialEfficiency} min={0} max={10} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Time Efficiency
              <NumberStepperInput value={timeEfficiency} onChange={setTimeEfficiency} min={0} max={20} step={2} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Facility Tax %
              <NumberStepperInput
                value={facilityTax * 100}
                onChange={(v) => setFacilityTax(v / 100)}
                min={0}
                max={10}
                step={0.01}
                className="industry-field-input"
                title="0.25% fixed at NPC stations; owner-set at player structures, capped at 10%. No public ESI endpoint exposes a player structure's own rate, so this is manual for now."
              />
            </label>
            <label className="wh-field-label">
              Structure Role Bonus %
              <NumberStepperInput
                value={structureRoleBonusPct}
                onChange={setStructureRoleBonusPct}
                min={0}
                step={0.1}
                className="industry-field-input"
                title="A cost-reduction role bonus the structure owner can set (e.g. 3 for -3%) - reduces just the System Cost Index portion of the job cost, not the taxes. Manual for now, no ESI endpoint exposes it."
              />
            </label>
            <label className="wh-field-label">
              Structure
              <select className="industry-field-input" value={structure} onChange={(e) => setStructure(e.target.value as StructureTier)}>
                {(Object.keys(STRUCTURE_LABEL) as StructureTier[]).map((s) => (
                  <option key={s} value={s}>
                    {STRUCTURE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Trade Hub
              <select className="industry-field-input" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
                {TRADE_HUB_REGIONS.map((h) => (
                  <option key={h.regionId} value={h.regionId}>
                    {h.regionName}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Clone Type
              <select
                className="industry-field-input"
                value={isAlphaClone ? "alpha" : "omega"}
                onChange={(e) => setIsAlphaClone(e.target.value === "alpha")}
                title="Alpha clones pay an extra flat 0.25% of EIV in job cost. Manual for now - ESI has no direct field for Alpha/Omega status."
              >
                <option value="omega">Omega</option>
                <option value="alpha">Alpha</option>
              </select>
            </label>
            {hubPricesLoading && <span className="industry-hub-prices-loading">Loading hub prices...</span>}
            <div className="kills-add-combobox industry-system-search">
              <label className="wh-field-label">
                System (for job cost)
                <input
                  type="text"
                  placeholder="Optional - e.g. Jita"
                  value={systemQuery}
                  onChange={(e) => {
                    setSystemQuery(e.target.value);
                    setSystem(null);
                  }}
                  onFocus={() => systemSuggestions.length > 0 && setSystemSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSystemSuggestionsOpen(false), 120)}
                />
              </label>
              {systemSuggestionsOpen && (
                <div className="gatecheck-slot-results kills-add-suggestions">
                  {systemSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSystem(s);
                        setSystemQuery(s.name);
                        setSystemSuggestionsOpen(false);
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pricedTree && (
              <div
                className="market-stat-card industry-ship-cost-card"
                title="What buying this outright, brand new, would cost at the Trade Hub right now - the real market price of the finished item itself, not its component materials. Scales with the same quantity Build Cost does, so the two are directly comparable."
              >
                <span className="market-stat-label">Brand New Ship Cost from Market</span>
                <span className="market-stat-value market-stat-value-isk">
                  {formatIsk(pricedTree.buyCostPerUnit * pricedTree.quantityNeeded)}
                </span>
              </div>
            )}
          </div>
        )}

        {selected && (
          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
              {calculating ? "Calculating..." : "Calculate Build Cost"}
            </button>
            <button
              type="button"
              className={`kills-sync-btn${isFavourite(selected.id) ? " industry-favourite-setup-active" : ""}`}
              onClick={handleFavouriteSetup}
              title="Save these runs/ME/TE/structure/tax/trade hub/system settings against this blueprint, so picking it from My Favourites restores them exactly"
            >
              <Star size={13} strokeWidth={2} fill={isFavourite(selected.id) ? "currentColor" : "none"} />
              {justFavourited ? "Saved!" : isFavourite(selected.id) ? "Update Favourite" : "Favourite This Setup"}
            </button>
          </div>
        )}
      </div>

      {pricedTree && (
        <div className="industry-results-panel">
          <div className="industry-build-steps-header">
            <p className="wh-side-label">Build Steps</p>
            {expandedPaths.size > 0 && (
              <button type="button" className="skill-action-btn" onClick={handleCollapseAll}>
                Collapse All
              </button>
            )}
          </div>
          <div className="industry-build-header">
            <span className="industry-build-header-checkbox-spacer" />
            <div className="industry-build-header-grid">
              <span />
              <span className="industry-build-header-label-left">Material</span>
              <span title="Total Quantity: the total number of units required for this stage of the build.">Qty</span>
              <span title="Total: the Trade Hub cost of buying the full quantity needed outright, until the tier below is open - then it's replaced by the real combined cost of that tier's materials instead.">
                Total
              </span>
              <span />
            </div>
          </div>
          <div className="market-browser-tree-list">
            <BuildTreeRow
              node={pricedTree}
              depth={0}
              path={rootPath}
              checkedPaths={checkedPaths}
              expanded={rootExpanded}
              onExpandToggle={handleExpandToggle}
              onToggle={toggleChecked}
              itemGroupNames={itemGroupNames}
              collapsedTiers={collapsedTiers}
            />
            {rootExpanded && pricedTree.materials.length > 0 && (
              <BuildTreeFlatList
                root={pricedTree}
                rootPath={rootPath}
                checkedPaths={checkedPaths}
                onToggle={toggleChecked}
                onToggleGroup={toggleCheckedPaths}
                itemGroupNames={itemGroupNames}
                collapsedTiers={collapsedTiers}
                onToggleTier={toggleTier}
              />
            )}
          </div>
        </div>
      )}
      </div>

      {pricedTree && (
        <div className="industry-costs-sidebar">
          <div className="industry-costs-sidebar-header">
            <p className="wh-side-label">Costs</p>
            <HelpBadge content={COSTS_SIDEBAR_HELP} align="left" />
          </div>

          {/* Per-unit figures - a fixed property of the item itself, so they
              never move when the Runs input above changes, unlike the
              batch block below which scales with it. Build Time here is
              per-run (a job's duration doesn't depend on how many units
              one run outputs), everything else is per-unit - see the
              batch block's own comment for why those two denominators
              (runs vs. quantityNeeded) aren't always the same number. */}
          <div className="industry-job-cost-block">
            <p className="industry-job-cost-section-label">Per Unit</p>
            <div className="industry-job-cost-row">
              <span>Build Cost</span>
              <span className="industry-job-cost-value">{formatIsk(tickedBuildCost / pricedTree.quantityNeeded)}</span>
            </div>
            {blueprintCostIncluded > 0 && (
              <div className="industry-job-cost-row">
                <span>Blueprint Cost</span>
                <span className="industry-job-cost-value">{formatIsk(blueprintCostIncluded / pricedTree.quantityNeeded)}</span>
              </div>
            )}
            {jobCost && (
              <div className="industry-job-cost-row">
                <span>Job Cost</span>
                <span className="industry-job-cost-value">{formatIsk(jobCost.totalJobCost / pricedTree.quantityNeeded)}</span>
              </div>
            )}
            <div className="industry-job-cost-row industry-job-cost-subtotal">
              <span>Total Job Run Cost</span>
              <span className="industry-job-cost-value industry-job-cost-value-total">
                {formatIsk((tickedBuildCost + blueprintCostIncluded + (jobCost?.totalJobCost ?? 0)) / pricedTree.quantityNeeded)}
              </span>
            </div>
            {pricedTree.timeSeconds != null && (
              <div className="industry-job-cost-row">
                <span>Build Time</span>
                <span>{formatDuration(pricedTree.timeSeconds / runs)}</span>
              </div>
            )}
          </div>

          {/* The full batch - scales with Runs. quantityNeeded (the output
              item count) isn't always equal to runs - a blueprint can output
              more than one unit per run (ammo, charges) - so this uses
              quantityNeeded for the item-count label but the underlying
              totals are already tree-wide, not re-derived from runs. */}
          <div className="industry-job-cost-block">
            <p className="industry-job-cost-section-label">
              {runs} Run{runs === 1 ? "" : "s"} ({pricedTree.quantityNeeded.toLocaleString()} item{pricedTree.quantityNeeded === 1 ? "" : "s"})
            </p>
            <div className="industry-job-cost-row">
              <span>Build Cost</span>
              <span className="industry-job-cost-value">{formatIsk(tickedBuildCost)}</span>
            </div>
            {blueprintCostIncluded > 0 && (
              <div className="industry-job-cost-row">
                <span>Blueprint Cost</span>
                <span className="industry-job-cost-value">{formatIsk(blueprintCostIncluded)}</span>
              </div>
            )}
            {jobCost && (
              <div className="industry-job-cost-row">
                <span>Job Cost</span>
                <span className="industry-job-cost-value">{formatIsk(jobCost.totalJobCost)}</span>
              </div>
            )}
            <div className="industry-job-cost-row industry-job-cost-subtotal">
              <span>Total Job Run Cost</span>
              <span className="industry-job-cost-value industry-job-cost-value-total">
                {formatIsk(tickedBuildCost + blueprintCostIncluded + (jobCost?.totalJobCost ?? 0))}
              </span>
            </div>
            {pricedTree.timeSeconds != null && (
              <div className="industry-job-cost-row">
                <span>Build Time</span>
                <span>{formatDuration(pricedTree.timeSeconds)}</span>
              </div>
            )}
          </div>

          {checkedPaths.size > 0 && (
            <button
              type="button"
              className="industry-copy-clipboard-btn"
              onClick={handleCopyToClipboard}
              title="Copy the ticked items as Name/Quantity lines, ready to paste into the game's Multibuy window"
            >
              <Copy size={14} strokeWidth={2.5} />
              {justCopied ? "Copied!" : "Copy to Clipboard"}
            </button>
          )}

          {jobCost && (
            <>
              {/* Every ISK figure below is divided by runs - a single run's
                  tax bill, fixed regardless of how many runs are queued up,
                  same as the Per Unit block above. The percentages
                  (System Cost Index, Facility Tax, SCC Surcharge, Alpha Tax)
                  are rates, not amounts, so they're shown as-is - EIV scales
                  linearly with runs (same materials per run x runs), so
                  dividing its dependent tax amounts back down by runs is
                  exactly the single-run figure, not an approximation. */}
              <p className="wh-side-label industry-job-cost-heading">
                Job Cost per Run{system && ` in System ${system.name}`}
              </p>

              <div className="industry-job-cost-block">
                <div className="industry-job-cost-row industry-job-cost-eiv">
                  <span>Estimated Item Value (EIV)</span>
                  <span className="industry-job-cost-value">{formatIsk(jobCost.eiv / runs)}</span>
                </div>
              </div>

              <div className="industry-job-cost-block">
                <p className="industry-job-cost-section-label">Job Gross Cost</p>
                <div className="industry-job-cost-row">
                  <span>System Cost Index ({(jobCost.systemCostIndex * 100).toFixed(2)}% EIV)</span>
                  <span className="industry-job-cost-value">{formatIsk(jobCost.sciAmount / runs)}</span>
                </div>
                {jobCost.structureRoleBonusPct > 0 && (
                  <div className="industry-job-cost-row industry-job-cost-reduction">
                    <span>Structure Role Bonus (-{jobCost.structureRoleBonusPct}% of SCI)</span>
                    <span>-{formatIsk(jobCost.roleBonusReduction / runs)}</span>
                  </div>
                )}
                <div className="industry-job-cost-row industry-job-cost-subtotal">
                  <span>Total Job Gross Cost</span>
                  <span className="industry-job-cost-value industry-job-cost-value-total">{formatIsk(jobCost.jobGrossCost / runs)}</span>
                </div>
              </div>

              <div className="industry-job-cost-block">
                <p className="industry-job-cost-section-label">Taxes</p>
                <div className="industry-job-cost-row">
                  <span>Facility Tax ({(jobCost.facilityTaxPct * 100).toFixed(2)}% EIV)</span>
                  <span className="industry-job-cost-value">{formatIsk(jobCost.facilityTaxAmount / runs)}</span>
                </div>
                <div className="industry-job-cost-row">
                  <span>SCC Surcharge ({(jobCost.sccSurchargePct * 100).toFixed(2)}% EIV)</span>
                  <span className="industry-job-cost-value">{formatIsk(jobCost.sccSurchargeAmount / runs)}</span>
                </div>
                {jobCost.alphaTaxAmount > 0 && (
                  <div className="industry-job-cost-row">
                    <span>Alpha Clone Tax ({(jobCost.alphaTaxPct * 100).toFixed(2)}% EIV)</span>
                    <span className="industry-job-cost-value">{formatIsk(jobCost.alphaTaxAmount / runs)}</span>
                  </div>
                )}
                <div className="industry-job-cost-row industry-job-cost-subtotal">
                  <span>Total Taxes</span>
                  <span className="industry-job-cost-value industry-job-cost-value-total">{formatIsk(jobCost.totalTaxes / runs)}</span>
                </div>
              </div>

              <div className="industry-job-cost-block industry-job-cost-total-block">
                <div className="industry-job-cost-row industry-job-cost-total">
                  <span>Total Job Cost</span>
                  <span className="industry-job-cost-value industry-job-cost-value-total">{formatIsk(jobCost.totalJobCost / runs)}</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      </div>
    </div>
  );
}

function ReprocessingCalculator() {
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  // Browsable ore/ice picker, replacing a type-to-search box - nobody has
  // "Nocxite" or "Bezdnacine" memorized, so picking from a list beats
  // recalling a name. Two levels, same pattern as the Item Database's own
  // category->group->item browse: pick a mineral (Veldspar, Ice, ...),
  // then the specific grade/compression variant within it.
  const [oreGroups, setOreGroups] = useState<GroupSummary[] | null>(null);
  const [activeGroup, setActiveGroup] = useState<GroupSummary | null>(null);
  const [groupItems, setGroupItems] = useState<TypeSummary[] | null>(null);

  const [defaultTradeHub] = useDefaultTradeHub();
  const { defaults: industryDefaults, saveReprocessingDefaults } = useIndustryDefaults();

  const [quantityHeld, setQuantityHeld] = useState(1000);
  const [facility, setFacility] = useState<ReprocessingFacility>(industryDefaults.reprocessing.facility);
  const [rig, setRig] = useState<ReprocessingRig>(industryDefaults.reprocessing.rig);
  const [security, setSecurity] = useState<SecurityBand>(industryDefaults.reprocessing.security);
  const [reprocessingLevel, setReprocessingLevel] = useState(industryDefaults.reprocessing.reprocessingLevel);
  const [reprocessingEfficiencyLevel, setReprocessingEfficiencyLevel] = useState(industryDefaults.reprocessing.reprocessingEfficiencyLevel);
  const [oreProcessingLevel, setOreProcessingLevel] = useState(industryDefaults.reprocessing.oreProcessingLevel);
  const [implant, setImplant] = useState<ImplantTier>(
    industryDefaults.reprocessing.implant in IMPLANT_LABEL ? (industryDefaults.reprocessing.implant as ImplantTier) : "none",
  );
  const [savedDefaults, setSavedDefaults] = useState(false);

  const [info, setInfo] = useState<ReprocessingInfo | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [basePrices, setBasePrices] = useState<Map<number, number>>(new Map());
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [hubPrices, setHubPrices] = useState<Map<number, number>>(new Map());
  const [hubPricesLoading, setHubPricesLoading] = useState(false);
  const reportError = useErrorReporter();

  function handleSaveDefaults() {
    saveReprocessingDefaults({ facility, rig, security, reprocessingLevel, reprocessingEfficiencyLevel, oreProcessingLevel, implant });
    setSavedDefaults(true);
    window.setTimeout(() => setSavedDefaults(false), 1500);
  }

  useEffect(() => {
    getCategoryGroups(ORE_CATEGORY_ID)
      .then(setOreGroups)
      .catch((err) => reportError(`Failed to load ore/ice types: ${String(err)}`));
  }, [reportError]);

  useEffect(() => {
    if (!activeGroup) {
      setGroupItems(null);
      return;
    }
    let cancelled = false;
    setGroupItems(null);
    getGroupItems(activeGroup.id)
      .then((items) => {
        if (!cancelled) setGroupItems(items);
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load ${activeGroup.name} variants: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, reportError]);

  useEffect(() => {
    if (!info || info.materials.length === 0) {
      setHubPrices(new Map());
      return;
    }
    let cancelled = false;
    setHubPrices(new Map());
    setHubPricesLoading(true);
    getRegionSellMinPrices(
      hubRegionId,
      info.materials.map((m) => m.type_id),
    )
      .then((next) => {
        if (cancelled) return;
        setHubPrices(next);
      })
      .catch(() => {
        if (!cancelled) setHubPrices(new Map());
      })
      .finally(() => {
        if (!cancelled) setHubPricesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [info, hubRegionId]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    try {
      const result = await getReprocessingMaterials(selected.id);
      if (result.materials.length === 0) {
        reportError(`${selected.name} doesn't reprocess into anything.`);
        setInfo(null);
        return;
      }
      setInfo(result);
      const prices = await getMarketPrices();
      setBasePrices(new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0])));
    } catch (err) {
      reportError(`Failed to load reprocessing data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const yieldFraction = reprocessingYield({
    facility,
    rig,
    security,
    reprocessingLevel,
    reprocessingEfficiencyLevel,
    oreProcessingLevel,
    implantBonus: REPROCESSING_IMPLANT_BONUS[implant],
  });
  const portions = info ? Math.floor(quantityHeld / info.portion_size) : 0;
  const leftover = info ? quantityHeld - portions * info.portion_size : 0;
  const outputs = info
    ? info.materials.map((m) => ({
        ...m,
        yieldQty: reprocessedMaterialQuantity(m.quantity, quantityHeld, info.portion_size, yieldFraction),
      }))
    : [];
  const totalValue = outputs.reduce((sum, o) => sum + (hubPrices.get(o.type_id) ?? basePrices.get(o.type_id) ?? 0) * o.yieldQty, 0);

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        {!selected &&
          (!activeGroup ? (
            <div className="industry-browse-picker">
              <p className="item-db-breadcrumb">Choose an ore or ice type</p>
              {oreGroups === null ? (
                <p className="detail-empty">Loading ore/ice types...</p>
              ) : (
                <div className="item-db-grid">
                  {oreGroups.map((g) => (
                    <button key={g.id} type="button" className="item-db-card" onClick={() => setActiveGroup(g)}>
                      <span className="item-db-card-name">{g.name}</span>
                      <span className="data-table-tag data-table-tag-neutral">{g.item_count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="industry-browse-picker">
              <button type="button" className="detail-back" onClick={() => setActiveGroup(null)}>
                <ChevronLeft size={16} strokeWidth={2} /> Back
              </button>
              <p className="item-db-breadcrumb">{activeGroup.name} - choose a grade or variant</p>
              {groupItems === null ? (
                <p className="detail-empty">Loading {activeGroup.name} variants...</p>
              ) : (
                <div className="item-db-item-grid">
                  {groupItems.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      className="item-db-item"
                      title={i.name}
                      onClick={() => {
                        setSelected({ id: i.id, name: i.name, market_group_id: null, volume: i.volume });
                        setInfo(null);
                      }}
                    >
                      <img src={typeIconUrl(i.id, 64, i.name)} alt="" className="item-db-item-icon" loading="lazy" />
                      <span className="item-db-item-name">{i.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

        {selected && (
          <div className="industry-selected-pick">
            <img src={typeIconUrl(selected.id, 32, selected.name)} alt="" className="market-browser-row-icon" />
            <span className="industry-selected-pick-name">{selected.name}</span>
            <button
              type="button"
              className="detail-back"
              onClick={() => {
                setSelected(null);
                setInfo(null);
              }}
            >
              Change
            </button>
          </div>
        )}

        {selected && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Quantity Held
              <NumberStepperInput value={quantityHeld} onChange={setQuantityHeld} min={1} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Reprocessing
              <NumberStepperInput value={reprocessingLevel} onChange={setReprocessingLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Reprocessing Efficiency
              <NumberStepperInput
                value={reprocessingEfficiencyLevel}
                onChange={setReprocessingEfficiencyLevel}
                min={0}
                max={5}
                className="industry-field-input"
              />
            </label>
            <label className="wh-field-label">
              Ore/Ice Processing
              <NumberStepperInput value={oreProcessingLevel} onChange={setOreProcessingLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Facility
              <select className="industry-field-input" value={facility} onChange={(e) => setFacility(e.target.value as ReprocessingFacility)}>
                {(Object.keys(REPROCESSING_BASE_RATE) as ReprocessingFacility[]).map((f) => (
                  <option key={f} value={f}>
                    {FACILITY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Rig
              <select className="industry-field-input" value={rig} onChange={(e) => setRig(e.target.value as ReprocessingRig)}>
                {(Object.keys(RIG_LABEL) as ReprocessingRig[]).map((r) => (
                  <option key={r} value={r}>
                    {RIG_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Security
              <select className="industry-field-input" value={security} onChange={(e) => setSecurity(e.target.value as SecurityBand)}>
                {(Object.keys(SECURITY_LABEL) as SecurityBand[]).map((s) => (
                  <option key={s} value={s}>
                    {SECURITY_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Implant
              <select className="industry-field-input" value={implant} onChange={(e) => setImplant(e.target.value as ImplantTier)}>
                {(Object.keys(IMPLANT_LABEL) as ImplantTier[]).map((i) => (
                  <option key={i} value={i}>
                    {IMPLANT_LABEL[i]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {selected && (
          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
              {calculating ? "Calculating..." : "Calculate Reprocessing Yield"}
            </button>
            <button type="button" className="detail-back" onClick={handleSaveDefaults} title="Remember these facility/rig/security/skill inputs as the default next time">
              {savedDefaults ? "Saved!" : "Save as Default"}
            </button>
          </div>
        )}
      </div>

      {info && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Effective yield: <strong>{(yieldFraction * 100).toFixed(2)}%</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Portions processed: <strong>{portions.toLocaleString()}</strong> ({info.portion_size.toLocaleString()}/portion)
            </span>
            {leftover > 0 && (
              <>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Leftover (not enough for a portion): <strong>{leftover.toLocaleString()}</strong>
                </span>
              </>
            )}
          </div>

          <div className="industry-shopping-list-header">
            <p className="wh-side-label">Yielded Materials</p>
            <label className="wh-field-label industry-hub-select-label">
              Trade Hub
              <select className="industry-field-input" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
                {TRADE_HUB_REGIONS.map((h) => (
                  <option key={h.regionId} value={h.regionId}>
                    {h.regionName}
                  </option>
                ))}
              </select>
            </label>
            {hubPricesLoading && <span className="industry-hub-prices-loading">Loading hub prices...</span>}
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="data-table-numeric">Unit Price</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {outputs.map((o) => {
                  const unitPrice = hubPrices.get(o.type_id) ?? basePrices.get(o.type_id) ?? 0;
                  const total = unitPrice * o.yieldQty;
                  return (
                    <tr key={o.type_id}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(o.type_id, 32, o.name)} alt="" className="market-browser-row-icon" />
                        {o.name}
                      </td>
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(unitPrice)}</td>
                      <td className="data-table-numeric">{o.yieldQty.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="industry-shopping-list-total-row">
                  <td colSpan={3}>Total Value</td>
                  <td className="data-table-numeric wallet-amount-positive">{formatIsk(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function InventionCalculator() {
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  // Browsable T1-blueprint picker, same reasoning as Reprocessing's ore
  // list: nobody has the exact T1 blueprint name for every T2 item they
  // might want memorized, so pick from a list instead of typing one. Both
  // levels are pre-filtered server-side to blueprints that actually have
  // invention data, so nothing shown here can dead-end on "has no
  // invention data" once clicked (the old shared blueprint-search box
  // could suggest any manufacturable blueprint, invertible or not).
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [activeGroup, setActiveGroup] = useState<GroupSummary | null>(null);
  const [groupItems, setGroupItems] = useState<TypeSummary[] | null>(null);

  const [detail, setDetail] = useState<BlueprintDetail | null>(null);
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  const [encryptionLevel, setEncryptionLevel] = useState(4);
  const [datacore1Level, setDatacore1Level] = useState(5);
  const [datacore2Level, setDatacore2Level] = useState(5);
  const [decryptorKey, setDecryptorKey] = useState("none");
  const [advancedIndustryLevel, setAdvancedIndustryLevel] = useState(5);
  const [facilityModifier, setFacilityModifier] = useState(1);
  const [rigBonusPct, setRigBonusPct] = useState(0);

  const [basePrices, setBasePrices] = useState<Map<number, number>>(new Map());
  const [calculating, setCalculating] = useState(false);
  const reportError = useErrorReporter();

  useEffect(() => {
    getInventableBlueprintGroups()
      .then(setGroups)
      .catch((err) => reportError(`Failed to load invertible blueprint types: ${String(err)}`));
  }, [reportError]);

  useEffect(() => {
    if (!activeGroup) {
      setGroupItems(null);
      return;
    }
    let cancelled = false;
    setGroupItems(null);
    getInventableBlueprintsInGroup(activeGroup.id)
      .then((items) => {
        if (!cancelled) setGroupItems(items);
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load ${activeGroup.name} blueprints: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, reportError]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setDetail(null);
    try {
      const d = await getBlueprintDetail(selected.id);
      if (!d.invention) {
        reportError(`${selected.name} has no invention data.`);
        return;
      }
      setDetail(d);
      setOutcomeIndex(0);
      const prices = await getMarketPrices();
      setBasePrices(new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0])));
    } catch (err) {
      reportError(`Failed to load invention data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const invention = detail?.invention ?? null;
  const outcome = invention?.outcomes[outcomeIndex] ?? null;
  const decryptor = DECRYPTORS.find((d) => d.key === decryptorKey) ?? DECRYPTORS[0];

  const probability = outcome
    ? Math.min(1, inventionProbability(outcome.probability, encryptionLevel, datacore1Level, datacore2Level, decryptor))
    : 0;
  const outputRuns = inventionOutputRuns(decryptor);
  const outputMe = inventionOutputMe(decryptor);
  const outputTe = inventionOutputTe(decryptor);
  const timeSeconds = invention ? inventionTimeSeconds(invention.time_seconds, facilityModifier, advancedIndustryLevel, rigBonusPct / 100) : 0;
  const materialCost = invention ? invention.materials.reduce((sum, m) => sum + m.quantity * (basePrices.get(m.type_id) ?? 0), 0) : 0;
  const expectedAttempts = probability > 0 ? 1 / probability : Infinity;
  const expectedCostPerSuccess = probability > 0 ? materialCost / probability : Infinity;

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        {!selected &&
          (!activeGroup ? (
            <div className="industry-browse-picker">
              <p className="item-db-breadcrumb">Choose a T1 item to invent from</p>
              {groups === null ? (
                <p className="detail-empty">Loading invertible blueprint types...</p>
              ) : (
                <div className="item-db-grid">
                  {groups.map((g) => (
                    <button key={g.id} type="button" className="item-db-card" onClick={() => setActiveGroup(g)}>
                      <span className="item-db-card-name">{g.name}</span>
                      <span className="data-table-tag data-table-tag-neutral">{g.item_count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="industry-browse-picker">
              <button type="button" className="detail-back" onClick={() => setActiveGroup(null)}>
                <ChevronLeft size={16} strokeWidth={2} /> Back
              </button>
              <p className="item-db-breadcrumb">{activeGroup.name} - choose the exact blueprint</p>
              {groupItems === null ? (
                <p className="detail-empty">Loading {activeGroup.name} blueprints...</p>
              ) : (
                <div className="item-db-item-grid">
                  {groupItems.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      className="item-db-item"
                      title={i.name}
                      onClick={() => {
                        setSelected({ id: i.id, name: i.name, market_group_id: null, volume: i.volume });
                        setDetail(null);
                      }}
                    >
                      <img src={typeIconUrl(i.id, 64, i.name)} alt="" className="item-db-item-icon" loading="lazy" />
                      <span className="item-db-item-name">{i.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

        {selected && (
          <div className="industry-selected-pick">
            <img src={typeIconUrl(selected.id, 32, selected.name)} alt="" className="market-browser-row-icon" />
            <span className="industry-selected-pick-name">{selected.name}</span>
            <button
              type="button"
              className="detail-back"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              Change
            </button>
          </div>
        )}

        {selected && (
          <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
            {calculating ? "Loading..." : "Load Invention Data"}
          </button>
        )}

        {invention && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Encryption Skill
              <NumberStepperInput value={encryptionLevel} onChange={setEncryptionLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Datacore Skill 1
              <NumberStepperInput value={datacore1Level} onChange={setDatacore1Level} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Datacore Skill 2
              <NumberStepperInput value={datacore2Level} onChange={setDatacore2Level} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Advanced Industry
              <NumberStepperInput value={advancedIndustryLevel} onChange={setAdvancedIndustryLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Facility Time Modifier
              <NumberStepperInput value={facilityModifier} onChange={setFacilityModifier} min={0} step={0.01} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Rig Time Bonus %
              <NumberStepperInput value={rigBonusPct} onChange={setRigBonusPct} min={0} max={100} step={1} className="industry-field-input" />
            </label>
            {invention.outcomes.length > 1 && (
              <label className="wh-field-label">
                Invent Into
                <select className="industry-field-input" value={outcomeIndex} onChange={(e) => setOutcomeIndex(Number(e.target.value))}>
                  {invention.outcomes.map((o, i) => (
                    <option key={o.product_type_id} value={i}>
                      {o.product_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="wh-field-label">
              Decryptor
              <select className="industry-field-input" value={decryptorKey} onChange={(e) => setDecryptorKey(e.target.value)}>
                {DECRYPTORS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {invention && outcome && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Success chance: <strong>{(probability * 100).toFixed(1)}%</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Expected attempts per success: <strong>{expectedAttempts === Infinity ? "-" : expectedAttempts.toFixed(2)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Output: <strong>{outputRuns} runs / {outputMe}% ME / {outputTe}% TE</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Time per attempt: <strong>{formatDuration(timeSeconds)}</strong>
            </span>
          </div>

          <div className="skill-plan-footer">
            <span>
              Material cost per attempt: <strong className="wallet-amount-negative">{formatIsk(materialCost)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Expected cost per success: <strong className="wallet-amount-negative">{expectedCostPerSuccess === Infinity ? "-" : formatIsk(expectedCostPerSuccess)}</strong>
            </span>
          </div>

          <p className="wh-side-label">Invention Materials</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="data-table-numeric">Unit Price</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {invention.materials.map((m) => {
                  const unitPrice = basePrices.get(m.type_id) ?? 0;
                  const total = unitPrice * m.quantity;
                  return (
                    <tr key={m.type_id}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(m.type_id, 32, m.name)} alt="" className="market-browser-row-icon" />
                        {m.name}
                      </td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(unitPrice)}</td>
                      <td className="data-table-numeric">{m.quantity.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

type ResearchType = "research_me" | "research_te";

const RESEARCH_TYPE_LABEL: Record<ResearchType, string> = {
  research_me: "Material Efficiency",
  research_te: "Time Efficiency",
};

function ResearchCalculator() {
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);
  // Browsable picker, same reasoning as Reprocessing/Invention above -
  // ME/TE research applies to a much wider set (essentially every
  // manufacturable blueprint, not just T1), but the interaction is the
  // same: pick the item family, then the exact blueprint.
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [activeGroup, setActiveGroup] = useState<GroupSummary | null>(null);
  const [groupItems, setGroupItems] = useState<TypeSummary[] | null>(null);

  const [detail, setDetail] = useState<BlueprintDetail | null>(null);
  const [researchType, setResearchType] = useState<ResearchType>("research_me");
  const [currentLevel, setCurrentLevel] = useState(0);
  const [targetLevel, setTargetLevel] = useState(10);
  const [researchSkillLevel, setResearchSkillLevel] = useState(5);
  const [advancedIndustryLevel, setAdvancedIndustryLevel] = useState(5);
  const [facilityModifier, setFacilityModifier] = useState(1);
  const [implantModifier, setImplantModifier] = useState(1);
  const [rigBonusPct, setRigBonusPct] = useState(0);

  const [calculating, setCalculating] = useState(false);
  const reportError = useErrorReporter();

  useEffect(() => {
    getResearchableBlueprintGroups()
      .then(setGroups)
      .catch((err) => reportError(`Failed to load researchable blueprint types: ${String(err)}`));
  }, [reportError]);

  useEffect(() => {
    if (!activeGroup) {
      setGroupItems(null);
      return;
    }
    let cancelled = false;
    setGroupItems(null);
    getResearchableBlueprintsInGroup(activeGroup.id)
      .then((items) => {
        if (!cancelled) setGroupItems(items);
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load ${activeGroup.name} blueprints: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, reportError]);

  // ME researches one level at a time (0-10); TE researches in steps of 2
  // (0-20, 10 jobs total) - switching type re-scales current/target level
  // onto the right step so a leftover odd TE level (or an ME level above
  // 10) can't linger from before the switch.
  useEffect(() => {
    if (researchType === "research_me") {
      setCurrentLevel((v) => Math.min(10, v));
      setTargetLevel(10);
    } else {
      setCurrentLevel((v) => Math.min(20, v % 2 === 0 ? v : v - 1));
      setTargetLevel(20);
    }
  }, [researchType]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setDetail(null);
    try {
      const d = await getBlueprintDetail(selected.id);
      if (!d.research_me && !d.research_te) {
        reportError(`${selected.name} has no research data.`);
        return;
      }
      setDetail(d);
    } catch (err) {
      reportError(`Failed to load research data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const activity = detail ? (researchType === "research_me" ? detail.research_me : detail.research_te) : null;
  const step = researchType === "research_me" ? 1 : 2;
  const maxLevel = researchType === "research_me" ? 10 : 20;

  const levelsToRun: number[] = [];
  if (activity) {
    for (let lvl = currentLevel + step; lvl <= targetLevel; lvl += step) levelsToRun.push(lvl);
  }
  const totalTimeSeconds = activity
    ? levelsToRun.reduce(
        (sum, lvl) =>
          sum + researchTimeSeconds(activity.time_seconds, lvl, facilityModifier, implantModifier, researchSkillLevel, advancedIndustryLevel, rigBonusPct / 100),
        0,
      )
    : 0;

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        {!selected &&
          (!activeGroup ? (
            <div className="industry-browse-picker">
              <p className="item-db-breadcrumb">Choose a blueprint type to research</p>
              {groups === null ? (
                <p className="detail-empty">Loading researchable blueprint types...</p>
              ) : (
                <div className="item-db-grid">
                  {groups.map((g) => (
                    <button key={g.id} type="button" className="item-db-card" onClick={() => setActiveGroup(g)}>
                      <span className="item-db-card-name">{g.name}</span>
                      <span className="data-table-tag data-table-tag-neutral">{g.item_count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="industry-browse-picker">
              <button type="button" className="detail-back" onClick={() => setActiveGroup(null)}>
                <ChevronLeft size={16} strokeWidth={2} /> Back
              </button>
              <p className="item-db-breadcrumb">{activeGroup.name} - choose the exact blueprint</p>
              {groupItems === null ? (
                <p className="detail-empty">Loading {activeGroup.name} blueprints...</p>
              ) : (
                <div className="item-db-item-grid">
                  {groupItems.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      className="item-db-item"
                      title={i.name}
                      onClick={() => {
                        setSelected({ id: i.id, name: i.name, market_group_id: null, volume: i.volume });
                        setDetail(null);
                      }}
                    >
                      <img src={typeIconUrl(i.id, 64, i.name)} alt="" className="item-db-item-icon" loading="lazy" />
                      <span className="item-db-item-name">{i.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

        {selected && (
          <div className="industry-selected-pick">
            <img src={typeIconUrl(selected.id, 32, selected.name)} alt="" className="market-browser-row-icon" />
            <span className="industry-selected-pick-name">{selected.name}</span>
            <button
              type="button"
              className="detail-back"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              Change
            </button>
          </div>
        )}

        {selected && (
          <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
            {calculating ? "Loading..." : "Load Research Data"}
          </button>
        )}

        {detail && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Current Level
              <NumberStepperInput value={currentLevel} onChange={setCurrentLevel} min={0} max={maxLevel} step={step} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Target Level
              <NumberStepperInput value={targetLevel} onChange={setTargetLevel} min={0} max={maxLevel} step={step} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              {researchType === "research_me" ? "Metallurgy" : "Research"} Skill
              <NumberStepperInput value={researchSkillLevel} onChange={setResearchSkillLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Advanced Industry
              <NumberStepperInput value={advancedIndustryLevel} onChange={setAdvancedIndustryLevel} min={0} max={5} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Facility Time Modifier
              <NumberStepperInput value={facilityModifier} onChange={setFacilityModifier} min={0} step={0.01} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Implant Time Modifier
              <NumberStepperInput value={implantModifier} onChange={setImplantModifier} min={0} step={0.01} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Rig Time Bonus %
              <NumberStepperInput value={rigBonusPct} onChange={setRigBonusPct} min={0} max={100} step={1} className="industry-field-input" />
            </label>
            <label className="wh-field-label">
              Research Type
              <select className="industry-field-input" value={researchType} onChange={(e) => setResearchType(e.target.value as ResearchType)}>
                {(Object.keys(RESEARCH_TYPE_LABEL) as ResearchType[]).map((t) => (
                  <option key={t} value={t}>
                    {RESEARCH_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {activity && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Jobs required: <strong>{levelsToRun.length}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Total research time: <strong>{formatDuration(totalTimeSeconds)}</strong>
            </span>
          </div>

          {levelsToRun.length > 0 && (
            <>
              <p className="wh-side-label">Per-Job Breakdown</p>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th className="data-table-numeric">Reaches Level</th>
                      <th className="data-table-numeric">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levelsToRun.map((lvl, i) => {
                      const jobTime = researchTimeSeconds(
                        activity.time_seconds,
                        lvl,
                        facilityModifier,
                        implantModifier,
                        researchSkillLevel,
                        advancedIndustryLevel,
                        rigBonusPct / 100,
                      );
                      return (
                        <tr key={lvl}>
                          <td>Job {i + 1}</td>
                          <td className="data-table-numeric">{lvl}%</td>
                          <td className="data-table-numeric">{formatDuration(jobTime)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Character-only, per D5's scoping - corp mining observer data (refinery
 * -level tracking of a whole team) is skipped for this pass. */
function IndustryPage() {
  const [tab, setTab] = useState<IndustryTab>("production");

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">
            <Factory size={14} strokeWidth={2} /> Industry
          </p>
          <h2>Production &amp; Reprocessing</h2>
          <p className="wh-page-subtitle">
            Blueprint build-cost calculation with real material/job-cost formulas, and ore/ice reprocessing yields.
          </p>
        </div>

        <div className="character-tabs">
          <button type="button" className={`character-tab${tab === "production" ? " character-tab-active" : ""}`} onClick={() => setTab("production")}>
            Production
          </button>
          <button type="button" className={`character-tab${tab === "reprocessing" ? " character-tab-active" : ""}`} onClick={() => setTab("reprocessing")}>
            Reprocessing
          </button>
          <button type="button" className={`character-tab${tab === "invention" ? " character-tab-active" : ""}`} onClick={() => setTab("invention")}>
            Invention
          </button>
          <button type="button" className={`character-tab${tab === "research" ? " character-tab-active" : ""}`} onClick={() => setTab("research")}>
            Research
          </button>
          <HelpBadge content={HELP_CONTENT[`industry.${tab}`] ?? HELP_CONTENT.industry} />
        </div>

        {tab === "production" ? (
          <ProductionCalculator />
        ) : tab === "reprocessing" ? (
          <ReprocessingCalculator />
        ) : tab === "invention" ? (
          <InventionCalculator />
        ) : (
          <ResearchCalculator />
        )}
      </div>
    </main>
  );
}

export default IndustryPage;
