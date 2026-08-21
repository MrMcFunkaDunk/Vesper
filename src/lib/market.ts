import { invoke } from "@tauri-apps/api/core";

export interface TypeSearchMatch {
  id: number;
  name: string;
  market_group_id: number | null;
  volume: number;
}

/** Live prefix/substring search against the local item-type cache (synced once from SDE data). */
export function searchMarketTypes(query: string): Promise<TypeSearchMatch[]> {
  return invoke("search_market_types", { query });
}

/** A ship hull's real static mass in kg, from the local SDE cache - for the
 * wormhole rolling calculator's "Use my ship" button. */
export function getTypeMass(typeId: number): Promise<number | null> {
  return invoke("get_type_mass", { typeId });
}

export interface MarketGroupNode {
  id: number;
  parent_id: number | null;
  name: string;
  has_types: boolean;
  icon_id: number | null;
}

/** The full market category tree, flat - build parent/child nesting client-side. */
export function getMarketGroups(): Promise<MarketGroupNode[]> {
  return invoke("get_market_groups");
}

export interface TypeSummary {
  id: number;
  name: string;
}

/** Items filed directly under one leaf market category. */
export function getMarketGroupTypes(marketGroupId: number): Promise<TypeSummary[]> {
  return invoke("get_market_group_types", { marketGroupId });
}

export interface MarketOrder {
  order_id: number;
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  duration: number;
  issued: string;
  location_id: number;
  system_id: number;
  range: string;
}

/** Every open order (buy + sell) for one item in one region. */
export function getRegionMarketOrders(regionId: number, typeId: number): Promise<MarketOrder[]> {
  return invoke("get_region_market_orders", { regionId, typeId });
}

/** Just the lowest sell-order price for one item in one region - null if
 * nobody's selling there right now. Cheaper than getRegionMarketOrders for
 * callers that only need "what would this cost to buy", e.g. the Industry
 * tab's per-hub shopping list pricing. */
export function getRegionSellMinPrice(regionId: number, typeId: number): Promise<number | null> {
  return invoke("get_region_sell_min_price", { regionId, typeId });
}

/** Bulk sibling of getRegionSellMinPrice: one IPC call for a whole material
 * list instead of one call per material. Missing/unpriced materials are
 * simply absent from the returned map rather than null-valued. */
export async function getRegionSellMinPrices(regionId: number, typeIds: number[]): Promise<Map<number, number>> {
  const result = await invoke<Record<number, number>>("get_region_sell_min_prices", { regionId, typeIds });
  return new Map(Object.entries(result).map(([typeId, price]) => [Number(typeId), price]));
}

/** Forces a full re-download of the market/industry SDE cache (types,
 * market groups, blueprint/reaction/reprocessing data) - only touches
 * redownloadable reference data, never a chain or a character. */
export function resyncMarketData(): Promise<void> {
  return invoke("resync_market_data");
}

export interface MarketHistoryPoint {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

/** Daily price/volume history for one item in one region. */
export function getRegionMarketHistory(regionId: number, typeId: number): Promise<MarketHistoryPoint[]> {
  return invoke("get_region_market_history", { regionId, typeId });
}

export interface MarketPrice {
  type_id: number;
  adjusted_price: number | null;
  average_price: number | null;
}

/** EVE-wide average/adjusted price per item type - fallback valuation when a region has no live orders for an item. */
export function getMarketPrices(): Promise<MarketPrice[]> {
  return invoke("get_market_prices");
}

/** Resolves market order location_ids (stations and player structures) to display names.
 * Needs a connected character's token for structures - any connected character works, it's
 * just borrowing a valid token, not acting as that character. */
export function resolveMarketLocations(characterId: number, locationIds: number[]): Promise<Record<number, string>> {
  return invoke("resolve_market_locations", { characterId, locationIds });
}

/** An item type's flavor-text description - not in the local types cache, fetched live from ESI. */
export function getItemDescription(typeId: number): Promise<string> {
  return invoke("get_item_description", { typeId });
}

export interface PublicContractEntry {
  contract_id: number;
  contract_type: string;
  title: string | null;
  price: number;
  reward: number;
  collateral: number;
  volume: number;
  days_to_complete: number;
  date_issued: string;
  date_expired: string;
  issuer_name: string;
  issuer_corporation_name: string;
  start_location_name: string | null;
  end_location_name: string | null;
}

/** Every open public contract (courier, item exchange, auction) in one region. */
export function getPublicContracts(regionId: number): Promise<PublicContractEntry[]> {
  return invoke("get_public_contracts", { regionId });
}
