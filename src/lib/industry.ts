import { invoke } from "@tauri-apps/api/core";

export interface TypeSearchMatch {
  id: number;
  name: string;
  market_group_id: number | null;
  volume: number;
}

export interface MaterialLine {
  type_id: number;
  name: string;
  quantity: number;
}

export interface ActivityInfo {
  time_seconds: number;
  materials: MaterialLine[];
  products: MaterialLine[];
}

export interface InventionOutcome {
  product_type_id: number;
  product_name: string;
  quantity: number;
  probability: number;
}

export interface InventionInfo {
  time_seconds: number;
  materials: MaterialLine[];
  outcomes: InventionOutcome[];
}

export interface BlueprintDetail {
  type_id: number;
  name: string;
  manufacturing: ActivityInfo | null;
  reaction: ActivityInfo | null;
  copying: ActivityInfo | null;
  research_me: ActivityInfo | null;
  research_te: ActivityInfo | null;
  invention: InventionInfo | null;
}

export interface ReprocessingInfo {
  type_id: number;
  name: string;
  portion_size: number;
  materials: MaterialLine[];
}

/** ESI's own activity strings, verified against its live OpenAPI schema. */
export interface SystemCostIndices {
  solar_system_id: number;
  indices: Record<string, number>;
}

export function searchBlueprints(query: string): Promise<TypeSearchMatch[]> {
  return invoke("search_blueprints", { query });
}

export function getBlueprintDetail(typeId: number): Promise<BlueprintDetail> {
  return invoke("get_blueprint_detail", { typeId });
}

/** Returns the blueprint/reaction-formula type_id that manufactures this product, or null if it's a raw/bought material with no recipe of its own - the operation BOM recursion needs at every node. */
export function findBlueprintForProduct(productTypeId: number): Promise<number | null> {
  return invoke("find_blueprint_for_product", { productTypeId });
}

export function getReprocessingMaterials(typeId: number): Promise<ReprocessingInfo> {
  return invoke("get_reprocessing_materials", { typeId });
}

export function getIndustrySystemCostIndices(): Promise<SystemCostIndices[]> {
  return invoke("get_industry_system_cost_indices");
}
