import { invoke } from "@tauri-apps/api/core";

export interface TypeSearchMatch {
  id: number;
  name: string;
  market_group_id: number | null;
  volume: number;
  /** "high"/"mid"/"low"/"rig"/"subsystem"/"service", or null for anything
   * that isn't a fittable module - which slot list the Fit Builder should
   * drop this into when added. */
  slot_type: string | null;
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

export interface ShipStats {
  hi_slots: number;
  mid_slots: number;
  low_slots: number;
  rig_slots: number;
  subsystem_slots: number;
  power_output: number;
  cpu_output: number;
  calibration: number;
  drone_bay_volume: number;
  drone_bandwidth: number;
}

/** A ship's real slot counts and resource capacities, straight from its
 * own dogma attributes - what the Fit Builder's fixed slot list and
 * Resources sidebar are both built from. */
export function getShipStats(typeId: number): Promise<ShipStats> {
  return invoke("get_ship_stats", { typeId });
}

export interface JumpDriveInfo {
  base_range_ly: number;
  fuel_per_ly: number;
  fuel_type_id: number;
}

/** A ship's jump drive attributes (base range in light years, isotope units
 * burned per light year, which isotope type) straight from its own dogma
 * attributes - null if the type has no jump drive at all. Used by the
 * Capital Route planner. */
export function getJumpDriveInfo(typeId: number): Promise<JumpDriveInfo | null> {
  return invoke("get_jump_drive_info", { typeId });
}

export interface ItemResourceCost {
  power: number;
  cpu: number;
  calibration: number;
  drone_bandwidth: number;
  volume: number;
}

/** Bulk PG/CPU/calibration-cost/volume lookup for a whole fit's worth of
 * items in one round trip, keyed by type_id - missing entries (nothing to
 * report, e.g. a drone with no PG/CPU cost) are simply absent. */
export async function getItemResourceCosts(typeIds: number[]): Promise<Map<number, ItemResourceCost>> {
  const result = await invoke<Record<number, ItemResourceCost>>("get_item_resource_costs", { typeIds });
  return new Map(Object.entries(result).map(([typeId, cost]) => [Number(typeId), cost]));
}

export interface SkillRequirement {
  skill_type_id: number;
  skill_name: string;
  level: number;
}

/** Every prerequisite skill (and level) for a batch of items at once - a
 * ship hull, every fitted module, a whole doctrine's worth of hulls - keyed
 * by type_id. An item with no skill requirements at all is simply absent. */
export async function getSkillRequirementsBulk(typeIds: number[]): Promise<Map<number, SkillRequirement[]>> {
  const result = await invoke<Record<number, SkillRequirement[]>>("get_skill_requirements_bulk", { typeIds });
  return new Map(Object.entries(result).map(([typeId, reqs]) => [Number(typeId), reqs]));
}

export interface CategorySummary {
  id: number;
  name: string;
  icon_id: number | null;
  item_count: number;
}

/** Every published EVE item category (Ship, Module, Charge, Blueprint,
 * Drone, Implant, Structure, ...) that has at least one published item -
 * the Item Database's home page, from the same local SDE cache as
 * everything else here. */
export function getItemCategories(): Promise<CategorySummary[]> {
  return invoke("get_item_categories");
}

export interface GroupSummary {
  id: number;
  name: string;
  item_count: number;
}

/** Every group under one category (e.g. under Ship: Frigate, Cruiser,
 * Assault Frigate, ...). */
export function getCategoryGroups(categoryId: number): Promise<GroupSummary[]> {
  return invoke("get_category_groups", { categoryId });
}

/** Every item filed directly under one leaf group. */
export function getGroupItems(groupId: number): Promise<TypeSummary[]> {
  return invoke("get_group_items", { groupId });
}

export interface AttributeValue {
  attribute_id: number;
  name: string;
  value: number;
  unit_id: number | null;
  high_is_good: boolean;
}

export interface ItemDetail {
  type_id: number;
  name: string;
  group_id: number;
  group_name: string;
  category_id: number;
  category_name: string;
  attributes: AttributeValue[];
}

/** One item's full detail page: name, group/category breadcrumb, and
 * every displayable dogma attribute. Flavor text is a separate call
 * (getItemDescription) since it's a live ESI fetch, not local-cache data. */
export function getItemDetail(typeId: number): Promise<ItemDetail> {
  return invoke("get_item_detail", { typeId });
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
  /** Same meaning as TypeSearchMatch.slot_type. */
  slot_type: string | null;
  /** m3 per unit. */
  volume: number;
}

/** Items filed directly under one leaf market category. */
export function getMarketGroupTypes(marketGroupId: number): Promise<TypeSummary[]> {
  return invoke("get_market_group_types", { marketGroupId });
}

/** Exact item-name -> type_id lookup, keyed by name - the reverse of every
 * other name resolver in this file. Names with no match (e.g. celestial
 * bodies like "Moon" aren't real inventory items) are simply absent. */
export async function resolveTypeIdsByName(names: string[]): Promise<Map<string, number>> {
  const result = await invoke<Record<string, number>>("resolve_type_ids_by_name", { names });
  return new Map(Object.entries(result));
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
