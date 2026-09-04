import type { MaterialLine } from "./industry";
import type { MarketOrder } from "./market";

/** One mineral/material's continuous density in one m³ of ore/ice at a
 * given refining yield. */
export interface MaterialDensity {
  typeId: number;
  name: string;
  perM3: number;
}

/**
 * Minerals/materials contained in exactly 1 m³ of a mined item at a given
 * refining yield - the ore.cerlestes.de "Ore Table" methodology: mining
 * lasers extract a constant m³ per cycle, not a fixed unit count, so
 * normalizing per-m³ (rather than per-unit or per-portion) is what
 * actually lets two different ores/ices be compared on "which is worth
 * more to mine."
 *
 * Deliberately NOT reprocessedMaterialQuantity (industryMath.ts) - that
 * function answers "I hold X units, what do I actually get" and floors to
 * whole reprocessing lots (partial portions are wasted in the real game).
 * This answers "how much of this mineral does one m³ of ore contain,"
 * which needs the exact continuous ratio, not a floored batch outcome -
 * portion flooring doesn't apply once you're asking about a fixed volume
 * rather than a held quantity.
 */
export function materialsPerCubicMeter(
  materials: MaterialLine[],
  portionSize: number,
  volumePerUnit: number,
  yieldFraction: number,
): MaterialDensity[] {
  if (portionSize <= 0 || volumePerUnit <= 0) return materials.map((m) => ({ typeId: m.type_id, name: m.name, perM3: 0 }));
  return materials.map((m) => ({
    typeId: m.type_id,
    name: m.name,
    perM3: (m.quantity / portionSize / volumePerUnit) * yieldFraction,
  }));
}

/** Real EVE naming convention: every compressed ore/ice variant's name
 * contains this word (confirmed against the local synced SDE - e.g.
 * "Compressed Veldspar", "Batch Compressed Veldspar II-Grade"). Ore
 * Table's per-m³ tables are scoped to raw, uncompressed ore/ice only -
 * compressing doesn't change how much a mining laser actually pulled out
 * per m³ mined, only how much cargo space hauling it needs afterward,
 * which is a separate concern from this table's purpose. */
export function isCompressedVariant(name: string): boolean {
  return name.includes("Compressed");
}

/**
 * ore.cerlestes.de's "weighted percentile" price: not a percentile of
 * order *count*, but the price at which cumulative remaining *volume*
 * (walked from the best price outward) first reaches the target
 * percentile of the book's total volume. A single 1-unit order priced at
 * an extreme can't skew this the way it would a plain min/max - the order
 * has to actually represent that much of the real tradeable volume to
 * move the result, which is exactly why cerlestes recommends the 98th
 * percentile for busy hubs (stable against outlier orders) and the 90th
 * for thinner regions (98th could land past the whole book's volume).
 *
 * side: "sell" walks from the lowest sell price up (a buyer's real cost
 * to acquire that much volume); "buy" walks from the highest buy price
 * down (a seller's real proceeds to place that much volume). Returns null
 * if there are no orders on that side at all.
 */
export function weightedPercentilePrice(orders: MarketOrder[], percentile: number, side: "sell" | "buy"): number | null {
  const relevant = orders.filter((o) => o.is_buy_order === (side === "buy"));
  if (relevant.length === 0) return null;
  const sorted = [...relevant].sort((a, b) => (side === "sell" ? a.price - b.price : b.price - a.price));
  const totalVolume = sorted.reduce((sum, o) => sum + o.volume_remain, 0);
  if (totalVolume <= 0) return null;
  const targetVolume = (Math.min(100, Math.max(0, percentile)) / 100) * totalVolume;
  let cumulative = 0;
  for (const order of sorted) {
    cumulative += order.volume_remain;
    if (cumulative >= targetVolume) return order.price;
  }
  return sorted[sorted.length - 1].price;
}
