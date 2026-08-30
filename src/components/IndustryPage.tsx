import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, CornerDownRight, Factory, Minus, Plus, Star, X } from "lucide-react";
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
  type GroupSummary,
  type TypeSummary,
} from "../lib/market";
import { buildCostTree, repriceTree, type BuildTreeNode } from "../lib/industryBuildTree";
import {
  jobInstallCost,
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
import { getCharacterMiningLedger, type CharacterMiningLedger, type SessionCharacter } from "../lib/eve";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useIndustryDefaults } from "../hooks/useIndustryDefaults";
import { useBlueprintFavourites, type BlueprintFavourite } from "../hooks/useBlueprintFavourites";
import HelpBadge from "./HelpBadge";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import { HELP_CONTENT } from "../lib/helpContent";
import CharacterSelectorStrip from "./CharacterSelectorStrip";

// EVE's real "Asteroid" item category - confirmed against the local SDE
// cache (every group filed under it is a mineable ore or ice variant,
// nothing else) rather than assumed from memory. Reprocessing_materials
// data confirms Salvage has no reprocessing recipe of its own in the
// current SDE (it's already a refined output, not something you'd
// reprocess further), so the browse list below is Ore/Ice only.
const ORE_CATEGORY_ID = 25;

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

type IndustryTab = "production" | "reprocessing" | "invention" | "research" | "mining";

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

/** Each nesting level gets a progressively stronger tint toward --accent
 * off the theme's own --bg-elevated, so a deeper tier visibly reads as
 * "one step further in" rather than every level looking like the exact
 * same box regardless of depth. Relative to whatever the active theme's
 * own accent/surface colors actually are (via color-mix), rather than a
 * hardcoded blue, so it stays sane across every theme this app ships
 * (including the more saturated seasonal ones) instead of just adding a
 * fixed color on top. Capped so a genuinely deep BOM doesn't end up solid
 * accent-colored by the time it bottoms out at raw materials. */
function tierTint(depth: number): string {
  const percent = Math.min(depth * 6, 30);
  return `color-mix(in srgb, var(--accent) ${percent}%, var(--bg-elevated))`;
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
 * when expanding a row: unticking just that one row isn't enough if any
 * ancestor above it is still ticked, since sumCheckedCost's short-circuit
 * stops at the FIRST ticked ancestor it meets going down from the root -
 * a still-ticked grandparent would keep swallowing this whole branch
 * regardless of what gets ticked/unticked below it. */
function ancestorPaths(path: string): string[] {
  const parts = path.split(">");
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    result.push(parts.slice(0, i + 1).join(">"));
  }
  return result;
}

/** Sums the real hub buy cost (per-unit hub price x quantity needed - the
 * same figure each row's own hub-total column shows) for every checked
 * row, not node.totalCost - that field is the galaxy-wide-index-based
 * build/buy assessment, which is a different number from "what would this
 * actually cost to buy at the trade hub right now", and hub cost is what
 * ticking a row is meant to represent. A checked node short-circuits
 * rather than also recursing into its children (its own hub cost already
 * stands for that whole branch), so only an *unchecked* node keeps walking
 * down - its children might still be individually opted back in below it.
 * This is what makes "everything ticked by default" a coherent number
 * with no double-counting, and lets unticking one row cleanly drop just
 * that row's cost (see the cascade-clear in toggleChecked). */
function sumCheckedCost(node: BuildTreeNode, path: string, checked: Set<string>, hubPrices: Map<number, number>): number {
  if (checked.has(path)) return (hubPrices.get(node.typeId) ?? node.buyCostPerUnit) * node.quantityNeeded;
  let sum = 0;
  for (const child of node.materials) {
    sum += sumCheckedCost(child, rowPath(path, child.typeId), checked, hubPrices);
  }
  return sum;
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

/** Every checked row's name + quantity, for the Multibuy clipboard export -
 * same short-circuit rule as sumCheckedCost (a checked node contributes
 * itself and stops, since its own quantityNeeded already accounts for
 * everything under it), and summed by type_id in case the same material
 * ends up checked at more than one point in the tree, so the pasted list
 * doesn't show the same item on two separate lines. */
function collectCheckedItems(
  node: BuildTreeNode,
  path: string,
  checked: Set<string>,
  into: Map<number, { name: string; quantity: number }>,
): Map<number, { name: string; quantity: number }> {
  if (checked.has(path)) {
    const existing = into.get(node.typeId);
    into.set(node.typeId, { name: node.name, quantity: (existing?.quantity ?? 0) + node.quantityNeeded });
    return into;
  }
  for (const child of node.materials) {
    collectCheckedItems(child, rowPath(path, child.typeId), checked, into);
  }
  return into;
}

interface BuildTreeRowProps {
  node: BuildTreeNode;
  depth: number;
  path: string;
  checkedPaths: Set<string>;
  /** Lifted to the parent (not local useState) so a "Collapse All" button
   * up there can close every open tier at once instead of only being able
   * to reach whichever single row's own local state it happens to be. */
  expandedPaths: Set<string>;
  onToggle: (node: BuildTreeNode, path: string) => void;
  onExpandToggle: (node: BuildTreeNode, path: string, expanding: boolean) => void;
  /** Real per-unit sell prices at the selected Trade Hub, keyed by type_id -
   * falls back to the node's own galaxy-wide index price (buyCostPerUnit)
   * for anything the hub has no live sell orders for. */
  hubPrices: Map<number, number>;
}

function BuildTreeRow({ node, depth, path, checkedPaths, expandedPaths, onToggle, onExpandToggle, hubPrices }: BuildTreeRowProps) {
  const expanded = expandedPaths.has(path);
  const indent = 10 + depth * 18;
  const hasChildren = node.materials.length > 0;
  // node itself already carries hub-based prices by the time it gets here
  // (see repriceTree, applied once at the tree root) - hubPrices is only
  // still needed here for the one thing that isn't part of the tree
  // itself: direct-children's totals for directMaterialsHubTotal below.
  const buyTotal = node.buyCostPerUnit * node.quantityNeeded;
  const buildTotal = node.buildCostPerUnit != null ? node.buildCostPerUnit * node.quantityNeeded : null;
  const buildIsCheaper = buildTotal != null && buildTotal < buyTotal;
  /** For a row with its own materials, node.totalCost (the recursive
   * build-vs-buy optimum, i.e. buildTotal or buyTotal above) isn't the only
   * useful number - "what would just the direct ingredients one level down
   * cost", not optimizing any further than that, is a different, still
   * useful comparison for this item's own next production step. Leaf rows
   * (no materials) keep showing their own real totalCost instead. */
  const directMaterialsHubTotal = node.materials.reduce(
    (sum, child) => sum + (hubPrices.get(child.typeId) ?? child.buyCostPerUnit) * child.quantityNeeded,
    0,
  );
  // Build materials first, buy materials after - a stable sort so
  // materials within the same group keep the build-tree's own original
  // ordering rather than shuffling alphabetically or by quantity.
  const sortedMaterials = useMemo(
    () => [...node.materials].sort((a, b) => Number(isBuildRow(b)) - Number(isBuildRow(a))),
    [node.materials],
  );

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
            aria-label={`Include ${node.name} in the selected total`}
          />
        )}
        <button
          type="button"
          className="industry-build-row-body"
          onClick={() => {
            if (!hasChildren) return;
            onExpandToggle(node, path, !expanded);
          }}
        >
          <img src={typeIconUrl(node.typeId, 32, node.name)} alt="" className="market-browser-row-icon" />
          <span className="market-browser-tree-item-label">
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
          <span
            className={`industry-build-cost-option${buildIsCheaper ? " industry-build-cost-cheaper" : ""}`}
            title={
              buildTotal != null
                ? "Build Cost: what it would cost to build the full quantity needed from its own materials, at real Trade Hub prices."
                : "Build Cost: no blueprint or reaction formula exists for this item - it can only be bought."
            }
          >
            {buildTotal != null ? formatIsk(buildTotal) : "—"}
          </span>
          <span
            className={`industry-build-cost-option${buildIsCheaper ? "" : " industry-build-cost-cheaper"}`}
            title="Buy Cost: the Trade Hub cost of buying the full quantity needed outright, right now."
          >
            {formatIsk(buyTotal)}
          </span>
          <span
            className="industry-build-cost"
            title={
              hasChildren
                ? "Total Material Cost: the combined Trade Hub cost of all required materials from the tier directly below, using the full quantities needed for the build."
                : "Total Cost: the cheaper of Build Cost and Buy Cost above - this item's own assessed cost."
            }
          >
            {formatIsk(hasChildren ? directMaterialsHubTotal : node.totalCost)}
          </span>
          {hasChildren && (
            <ChevronRight size={13} strokeWidth={2} className={`market-tree-chevron${expanded ? " market-tree-chevron-open" : ""}`} />
          )}
        </button>
      </div>
      {expanded && hasChildren && (
        <div className="market-tree-children industry-build-children" style={{ background: tierTint(depth + 1) }}>
          <CornerDownRight size={13} strokeWidth={2} className="industry-build-tier-connector" aria-hidden="true" />
          {sortedMaterials.map((child) => (
            <BuildTreeRow
              key={child.typeId}
              node={child}
              depth={depth + 1}
              path={rowPath(path, child.typeId)}
              checkedPaths={checkedPaths}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onExpandToggle={onExpandToggle}
              hubPrices={hubPrices}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface NumberStepperInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

/** Every plain number input across the Industry tabs used the browser's own
 * up/down spinner arrows - replaced everywhere with explicit +/- buttons
 * instead, which are easier to hit precisely and read at a glance than the
 * native control's tiny hit targets. min/max are clamped the same way each
 * field's own onChange already did (an empty/invalid field falls back to 0
 * before clamping, which lands on the same floor every existing field's own
 * fallback constant already matched its min at). */
function NumberStepperInput({ value, onChange, min, max, step = 1, className }: NumberStepperInputProps) {
  function clamp(next: number): number {
    let result = next;
    if (min != null) result = Math.max(min, result);
    if (max != null) result = Math.min(max, result);
    return result;
  }

  return (
    <div className="industry-number-stepper">
      <button
        type="button"
        className="industry-number-stepper-btn"
        onClick={() => onChange(clamp(value - step))}
        disabled={min != null && value <= min}
        aria-label="Decrease"
      >
        <Minus size={12} strokeWidth={2.5} />
      </button>
      <input
        type="number"
        className={className}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value) || 0))}
      />
      <button
        type="button"
        className="industry-number-stepper-btn"
        onClick={() => onChange(clamp(value + step))}
        disabled={max != null && value >= max}
        aria-label="Increase"
      >
        <Plus size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function ProductionCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);

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

  const [systemQuery, setSystemQuery] = useState("");
  const [systemSuggestions, setSystemSuggestions] = useState<SystemSearchMatch[]>([]);
  const [systemSuggestionsOpen, setSystemSuggestionsOpen] = useState(false);
  const [system, setSystem] = useState<SystemSearchMatch | null>(null);

  const [tree, setTree] = useState<BuildTreeNode | null>(null);
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
   * orders, only via contracts - see blueprintEffectiveCost below), so this
   * is the practical way to get a real figure in: look the price up on
   * contracts yourself and type it in. */
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
      hubRegionId,
      systemId: system?.id ?? null,
      systemName: system?.name ?? null,
    });
    setJustFavourited(true);
    window.setTimeout(() => setJustFavourited(false), 1500);
  }

  /** Loads a saved favourite's whole setup back in - just the inputs, not
   * an automatic recalculation, so this stays a simple, safe state
   * assignment rather than needing handleCalculate to read values that
   * haven't actually landed in state yet by the time it'd run. */
  function loadFavourite(fav: BlueprintFavourite) {
    setQuery(fav.name);
    setSelected({ id: fav.typeId, name: fav.name, market_group_id: null, volume: 0 });
    setRuns(fav.runs);
    setMaterialEfficiency(fav.materialEfficiency);
    setTimeEfficiency(fav.timeEfficiency);
    setStructure(fav.structure === "npc_station" ? "npc_station" : "engineering_complex");
    setFacilityTax(fav.facilityTax);
    setHubRegionId(fav.hubRegionId);
    if (fav.systemId != null && fav.systemName != null) {
      setSystem({ id: fav.systemId, name: fav.systemName, security: 0 });
      setSystemQuery(fav.systemName);
    } else {
      setSystem(null);
      setSystemQuery("");
    }
    setTree(null);
    setFavouritesOpen(false);
  }

  useEffect(() => {
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

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setTree(null);
    setBlueprintCost(null);
    setBlueprintManualCost("");
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

      if (system) {
        const costIndices = await getIndustrySystemCostIndices();
        const systemIndex = costIndices.find((c) => c.solar_system_id === system.id);
        const activityKey = activity === "manufacturing" ? "manufacturing" : "reaction";
        const costIndex = systemIndex?.indices[activityKey] ?? 0.05;
        const eiv = estimatedItemValue(
          activityInfo.materials.map((m) => ({ typeId: m.type_id, quantity: m.quantity * runs })),
          priceByTypeId,
        );
        const installCost = jobInstallCost(eiv, costIndex, activity, facilityTax);
        setTree((prev) => (prev ? { ...prev, totalCost: prev.totalCost + installCost } : prev));
      }
    } catch (err) {
      reportError(`Failed to calculate build cost: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  /** Toggles a tree row. Unticking cascades down through the whole
   * subtree (not just this one path) - otherwise the still-ticked
   * children would simply take over the sum via sumCheckedCost's
   * short-circuit rule, and the row would look unticked while its cost
   * silently kept counting. Ticking a row back on only needs to add that
   * one path back - its subtree is irrelevant to the sum once the parent
   * itself is ticked, whatever state the descendants are still in. */
  function toggleChecked(node: BuildTreeNode, path: string) {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        for (const p of collectPaths(node, path, new Set())) next.delete(p);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  /** The blueprint row has no subtree, so a plain flip is enough - no cascade needed. */
  function toggleBlueprintChecked(path: string) {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Opening a row to look inside it is itself a decision - it means
   * "I'm building this from its own materials, not treating it as one
   * unit" - so expanding automatically unticks the row and ticks its
   * direct children (their own totalCost stands in for the parent's),
   * and collapsing it back reverses that (re-tick the row, untick its
   * children) since going back to the rolled-up view means the drill-down
   * is done. Only direct children are touched on the way down - a
   * grandchild's own state only matters once its own parent is expanded
   * too. Expanding also unticks every ancestor above this row, not just
   * the row itself: sumCheckedCost stops at the first ticked ancestor it
   * finds coming down from the root, so leaving one ticked above this row
   * (e.g. the root product, ticked by default) would keep swallowing
   * whatever gets ticked/unticked in here regardless. */
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

  const BLUEPRINT_ROW_PATH = "blueprint";
  // A manual entry always wins once typed, even "0" - only a genuinely
  // empty field falls back to the (usually unhelpful, market-order-based)
  // fetched price, so clearing the field back out restores that fallback.
  const blueprintEffectiveCost = blueprintManualCost.trim() !== "" ? Number(blueprintManualCost) || 0 : (blueprintCost?.cost ?? 0);
  const selectedTotal = useMemo(() => {
    let sum = checkedPaths.has(BLUEPRINT_ROW_PATH) ? blueprintEffectiveCost : 0;
    if (pricedTree) sum += sumCheckedCost(pricedTree, rowPath("root", pricedTree.typeId), checkedPaths, hubPrices);
    return sum;
  }, [pricedTree, blueprintEffectiveCost, checkedPaths, hubPrices]);

  /** Name\tQuantity per line - the same tab-separated shape EVE's own
   * inventory/contract copy produces, which is exactly what the game's
   * Multibuy paste box expects. Summed by type_id first (collectCheckedItems)
   * so the same material checked in two branches doesn't show up twice. */
  function handleCopyToClipboard() {
    const items = new Map<number, { name: string; quantity: number }>();
    if (blueprintCost && checkedPaths.has(BLUEPRINT_ROW_PATH)) {
      items.set(blueprintCost.typeId, { name: blueprintCost.name, quantity: 1 });
    }
    if (pricedTree) collectCheckedItems(pricedTree, rowPath("root", pricedTree.typeId), checkedPaths, items);
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

        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search for a blueprint or reaction formula..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setTree(null);
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
                step={0.01}
                className="industry-field-input"
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
          </div>
        )}

        {selected && (
          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
              {calculating ? "Calculating..." : "Calculate Build Cost"}
            </button>
            <button
              type="button"
              className={`detail-back${isFavourite(selected.id) ? " industry-favourite-setup-active" : ""}`}
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
              <span title="Build Cost: what it would cost to build the full quantity needed from its own materials, at real Trade Hub prices.">
                Build Cost
              </span>
              <span title="Buy Cost: the Trade Hub cost of buying the full quantity needed outright, right now.">Buy Cost</span>
              <span title="Total: the cheaper of Build/Buy for a raw material, or the combined cost of just the materials one tier below for anything buildable.">
                Total
              </span>
              <span />
            </div>
          </div>
          <div className="market-browser-tree-list">
            {blueprintCost && (
              <div className="market-tree-node industry-build-node">
                <div className="market-browser-tree-item industry-build-row industry-build-row-blueprint">
                  <input
                    type="checkbox"
                    className="industry-build-checkbox"
                    checked={checkedPaths.has(BLUEPRINT_ROW_PATH)}
                    onChange={() => toggleBlueprintChecked(BLUEPRINT_ROW_PATH)}
                    aria-label={`Include ${blueprintCost.name} in the selected total`}
                  />
                  <img src={typeIconUrl(blueprintCost.typeId, 32, blueprintCost.name)} alt="" className="market-browser-row-icon" />
                  <span className="market-browser-tree-item-label">{blueprintCost.name}</span>
                  <span className="industry-build-decision industry-build-decision-buy">Buy</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    className="industry-build-cost-input"
                    placeholder={formatIsk(blueprintCost.cost)}
                    value={blueprintManualCost}
                    onChange={(e) => setBlueprintManualCost(e.target.value)}
                    title="Blueprints are rarely sold on the market - most real prices come from contracts. Type in what you found there."
                  />
                </div>
              </div>
            )}
            <BuildTreeRow
              node={pricedTree}
              depth={0}
              path={rowPath("root", pricedTree.typeId)}
              checkedPaths={checkedPaths}
              expandedPaths={expandedPaths}
              onToggle={toggleChecked}
              onExpandToggle={handleExpandToggle}
              hubPrices={hubPrices}
            />
          </div>

          <div className="skill-plan-footer">
            <span>
              Total cost: <strong>{formatIsk(pricedTree.totalCost)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Per unit: <strong>{formatIsk(pricedTree.totalCost / pricedTree.quantityNeeded)}</strong>
            </span>
            {pricedTree.timeSeconds != null && (
              <>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Build time: <strong>{formatDuration(pricedTree.timeSeconds)}</strong>
                </span>
              </>
            )}
            {checkedPaths.size > 0 && (
              <>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Selected total ({checkedPaths.size} item{checkedPaths.size === 1 ? "" : "s"}):{" "}
                  <strong>{formatIsk(selectedTotal)}</strong>
                </span>
                <button
                  type="button"
                  className="industry-copy-clipboard-btn"
                  onClick={handleCopyToClipboard}
                  title="Copy the ticked items as Name/Quantity lines, ready to paste into the game's Multibuy window"
                >
                  <Copy size={14} strokeWidth={2.5} />
                  {justCopied ? "Copied!" : "Copy to Clipboard"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

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
function MiningLedgerTab({ characters }: { characters: SessionCharacter[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(characters[0]?.id ?? null);
  const [ledger, setLedger] = useState<CharacterMiningLedger | null>(null);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const reportError = useErrorReporter();

  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLedger(null);
    if (selectedId == null) return;
    getCharacterMiningLedger(selectedId)
      .then(setLedger)
      .catch((err) => reportError(`Failed to load mining ledger: ${String(err)}`));
  }, [selectedId, reportError]);

  const grouped = useMemo(() => {
    if (!ledger) return [];
    const byType = new Map<number, { typeName: string; quantity: number }>();
    for (const e of ledger.entries) {
      const existing = byType.get(e.type_id);
      if (existing) existing.quantity += e.quantity;
      else byType.set(e.type_id, { typeName: e.type_name, quantity: e.quantity });
    }
    return [...byType.entries()]
      .map(([typeId, v]) => ({ typeId, ...v, value: (prices.get(typeId) ?? 0) * v.quantity }))
      .sort((a, b) => b.value - a.value);
  }, [ledger, prices]);

  const totalValue = grouped.reduce((sum, g) => sum + g.value, 0);
  const distinctDays = ledger ? new Set(ledger.entries.map((e) => e.date)).size : 0;
  const iskPerDay = distinctDays > 0 ? totalValue / distinctDays : 0;
  const sortedGrouped = useSortableRows(grouped, {
    typeName: (g) => g.typeName,
    quantity: (g) => g.quantity,
    value: (g) => g.value,
  }, "value");

  return (
    <div className="industry-production">
      {characters.length > 1 && <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />}
      {selectedId == null ? (
        <p className="detail-empty">No connected characters.</p>
      ) : !ledger ? (
        <p className="detail-empty">Loading mining ledger...</p>
      ) : ledger.needs_reauth ? (
        <p className="detail-empty">Sign in again to unlock the mining ledger for this character.</p>
      ) : ledger.entries.length === 0 ? (
        <p className="detail-empty">No mining activity recorded in the last 90 days.</p>
      ) : (
        <>
          <p className="settings-section-hint">
            Up to 90 days of mining history from ESI, valued at EVE-wide average price - a rough guide, not a
            guaranteed sell price.
          </p>
          <div className="market-browser-stats">
            <div className="market-stat-card">
              <span className="market-stat-label">Total Value</span>
              <span className="market-stat-value">{formatIsk(totalValue)}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">Active Days</span>
              <span className="market-stat-value">{distinctDays}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">ISK / Active Day</span>
              <span className="market-stat-value">{formatIsk(iskPerDay)}</span>
            </div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Ore / Ice" sortKey="typeName" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} />
                  <SortableTh label="Quantity" sortKey="quantity" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} numeric />
                  <SortableTh label="Est. Value" sortKey="value" activeKey={sortedGrouped.sortKey} dir={sortedGrouped.sortDir} onSort={sortedGrouped.sort} numeric />
                </tr>
              </thead>
              <tbody>
                {sortedGrouped.rows.map((g) => (
                  <tr key={g.typeId}>
                    <td>
                      <span className="asset-item-cell">
                        <img src={typeIconUrl(g.typeId, 32, g.typeName)} alt="" className="market-browser-row-icon" />
                        {g.typeName}
                      </span>
                    </td>
                    <td className="data-table-numeric">{g.quantity.toLocaleString()}</td>
                    <td className="data-table-numeric">{formatIsk(g.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function IndustryPage({ characters }: { characters: SessionCharacter[] }) {
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
          <button type="button" className={`character-tab${tab === "mining" ? " character-tab-active" : ""}`} onClick={() => setTab("mining")}>
            Mining Ledger
          </button>
          <HelpBadge content={HELP_CONTENT[`industry.${tab}`] ?? HELP_CONTENT.industry} />
        </div>

        {tab === "production" ? (
          <ProductionCalculator />
        ) : tab === "reprocessing" ? (
          <ReprocessingCalculator />
        ) : tab === "invention" ? (
          <InventionCalculator />
        ) : tab === "research" ? (
          <ResearchCalculator />
        ) : (
          <MiningLedgerTab characters={characters} />
        )}
      </div>
    </main>
  );
}

export default IndustryPage;
