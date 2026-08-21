// Recursive BOM (bill of materials) expansion: given a target item and
// quantity, walks down through every buildable sub-component to raw/bought
// materials, comparing build-vs-buy cost at every tier - the same core
// algorithm eve-tools-suite-main's buildtree.ts uses (verified this
// session), reimplemented against VESPER's own backend/data layer.

import { getBlueprintDetail, findBlueprintForProduct, type BlueprintDetail, type ActivityInfo } from "./industry";
import { adjustedMaterialQuantity, jobMaterialQuantity, jobTimeSeconds, type ActivityType } from "./industryMath";

export interface BuildTreeOptions {
  materialEfficiency: number;
  timeEfficiency: number;
  runsPerJob?: number;
  structureMaterialBonus?: number;
  structureTimeBonus?: number;
  /** Safety cap on recursion depth - a real capital-ship BOM is deep but finite; this guards against any unexpected cyclical SDE data. */
  maxDepth?: number;
  /** Safety cap on total node count across the whole tree. */
  maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 400;

export interface BuildTreeNode {
  typeId: number;
  name: string;
  quantityNeeded: number;
  runs: number;
  activity: ActivityType | null;
  shouldBuild: boolean;
  buildCostPerUnit: number | null;
  buyCostPerUnit: number;
  totalCost: number;
  timeSeconds: number | null;
  materials: BuildTreeNode[];
}

interface BuildContext {
  options: Required<BuildTreeOptions>;
  prices: Map<number, number>;
  blueprintCache: Map<number, BlueprintDetail>;
  productToBlueprintCache: Map<number, number | null>;
  nodeCount: number;
}

async function getCachedBlueprintDetail(ctx: BuildContext, typeId: number): Promise<BlueprintDetail> {
  const cached = ctx.blueprintCache.get(typeId);
  if (cached) return cached;
  const detail = await getBlueprintDetail(typeId);
  ctx.blueprintCache.set(typeId, detail);
  return detail;
}

async function getCachedBlueprintForProduct(ctx: BuildContext, productTypeId: number): Promise<number | null> {
  if (ctx.productToBlueprintCache.has(productTypeId)) return ctx.productToBlueprintCache.get(productTypeId)!;
  const blueprintId = await findBlueprintForProduct(productTypeId);
  ctx.productToBlueprintCache.set(productTypeId, blueprintId);
  return blueprintId;
}

function buyPrice(ctx: BuildContext, typeId: number): number {
  return ctx.prices.get(typeId) ?? 0;
}

/** Leaf node for a component that gets bought outright rather than built -
 * hit whenever expand() gives up going deeper (depth/node cap, no blueprint
 * for this product, or a blueprint with no usable activity). */
function buyOnlyLeaf(typeId: number, name: string, quantityNeeded: number, buyCostPerUnit: number): BuildTreeNode {
  return {
    typeId,
    name,
    quantityNeeded,
    runs: 0,
    activity: null,
    shouldBuild: false,
    buildCostPerUnit: null,
    buyCostPerUnit,
    totalCost: buyCostPerUnit * quantityNeeded,
    timeSeconds: null,
    materials: [],
  };
}

async function expand(ctx: BuildContext, typeId: number, name: string, quantityNeeded: number, depth: number): Promise<BuildTreeNode> {
  ctx.nodeCount++;
  const buyCostPerUnit = buyPrice(ctx, typeId);

  if (depth >= ctx.options.maxDepth || ctx.nodeCount >= ctx.options.maxNodes) {
    return buyOnlyLeaf(typeId, name, quantityNeeded, buyCostPerUnit);
  }

  const blueprintTypeId = await getCachedBlueprintForProduct(ctx, typeId);
  if (blueprintTypeId == null) {
    return buyOnlyLeaf(typeId, name, quantityNeeded, buyCostPerUnit);
  }

  const detail = await getCachedBlueprintDetail(ctx, blueprintTypeId);
  const activityInfo: ActivityInfo | null = detail.manufacturing ?? detail.reaction;
  const activity: ActivityType | null = detail.manufacturing ? "manufacturing" : detail.reaction ? "reaction" : null;
  if (!activityInfo || !activity) {
    return buyOnlyLeaf(typeId, name, quantityNeeded, buyCostPerUnit);
  }

  const outputPerRun = activityInfo.products.find((p) => p.type_id === typeId)?.quantity ?? 1;
  const runs = Math.ceil(quantityNeeded / outputPerRun);

  // Reactions never get ME - real mechanic confirmed by both reference
  // tools independently (see industryMath.ts's provenance notes).
  const me = activity === "reaction" ? 0 : ctx.options.materialEfficiency;
  const te = activity === "reaction" ? 0 : ctx.options.timeEfficiency;
  const structureMaterialBonus = activity === "reaction" ? 0 : ctx.options.structureMaterialBonus;

  const materials: BuildTreeNode[] = [];
  let materialCost = 0;
  for (const line of activityInfo.materials) {
    const adjustedPerUnit = adjustedMaterialQuantity(line.quantity, me, structureMaterialBonus);
    const totalQty = jobMaterialQuantity(adjustedPerUnit, runs, ctx.options.runsPerJob);
    const child = await expand(ctx, line.type_id, line.name, totalQty, depth + 1);
    materials.push(child);
    materialCost += child.totalCost;
  }

  const timeSeconds = jobTimeSeconds(activityInfo.time_seconds, runs, te, ctx.options.structureTimeBonus, activity);
  const buildCostPerUnit = materialCost / quantityNeeded;
  const buyTotal = buyCostPerUnit * quantityNeeded;
  const shouldBuild = materialCost < buyTotal || buyCostPerUnit === 0;

  return {
    typeId,
    name,
    quantityNeeded,
    runs,
    activity,
    shouldBuild,
    buildCostPerUnit,
    buyCostPerUnit,
    totalCost: shouldBuild ? materialCost : buyTotal,
    timeSeconds,
    materials: shouldBuild ? materials : [],
  };
}

/**
 * Recursively expands `productTypeId` into a full build-vs-buy tree.
 * `prices` should be buy prices per unit (e.g. Jita sell price) for every
 * type that might appear as a leaf - a missing entry is treated as
 * unpriced (0), which will bias that node toward "build" since buying it
 * looks free; callers should ensure prices are populated for anything they
 * want a meaningful buy comparison for.
 */
export async function buildCostTree(productTypeId: number, name: string, quantity: number, options: BuildTreeOptions, prices: Map<number, number>): Promise<BuildTreeNode> {
  const ctx: BuildContext = {
    options: {
      materialEfficiency: options.materialEfficiency,
      timeEfficiency: options.timeEfficiency,
      runsPerJob: options.runsPerJob ?? Number.MAX_SAFE_INTEGER,
      structureMaterialBonus: options.structureMaterialBonus ?? 0,
      structureTimeBonus: options.structureTimeBonus ?? 0,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    },
    prices,
    blueprintCache: new Map(),
    productToBlueprintCache: new Map(),
    nodeCount: 0,
  };
  return expand(ctx, productTypeId, name, quantity, 0);
}

/** Flattens a build tree into total raw/bought material quantities needed across the whole plan - the "shopping list" view, deduped and summed across every branch that ends in a buy decision. */
export function flattenRawMaterials(node: BuildTreeNode, into: Map<number, { name: string; quantity: number }> = new Map()): Map<number, { name: string; quantity: number }> {
  if (!node.shouldBuild || node.materials.length === 0) {
    const existing = into.get(node.typeId);
    into.set(node.typeId, { name: node.name, quantity: (existing?.quantity ?? 0) + node.quantityNeeded });
    return into;
  }
  for (const child of node.materials) {
    flattenRawMaterials(child, into);
  }
  return into;
}
