import { invoke } from "@tauri-apps/api/core";

export interface PlanSummary {
  id: string;
  name: string;
  entry_count: number;
  created_at: number;
  updated_at: number;
}

export interface PlanEntry {
  id: string;
  skill_id: number;
  level: number;
  priority: number;
  notes: string;
  sort_order: number;
  is_prerequisite: boolean;
}

export interface PlanDetail {
  id: string;
  name: string;
  entries: PlanEntry[];
}

export interface NewPlanEntry {
  skill_id: number;
  level: number;
  is_prerequisite: boolean;
}

export function listPlans(characterId: number): Promise<PlanSummary[]> {
  return invoke("list_plans", { characterId });
}

export function getPlan(planId: string): Promise<PlanDetail> {
  return invoke("get_plan", { planId });
}

export function createPlan(characterId: number, name: string): Promise<string> {
  return invoke("create_plan", { characterId, name });
}

export function renamePlan(planId: string, name: string): Promise<void> {
  return invoke("rename_plan", { planId, name });
}

export function deletePlan(planId: string): Promise<void> {
  return invoke("delete_plan", { planId });
}

export function addPlanEntries(planId: string, entries: NewPlanEntry[]): Promise<void> {
  return invoke("add_plan_entries", { planId, entries });
}

export function updatePlanEntry(planId: string, entryId: string, priority: number, notes: string): Promise<void> {
  return invoke("update_plan_entry", { planId, entryId, priority, notes });
}

export function reorderPlanEntries(planId: string, entryIdsInOrder: string[]): Promise<void> {
  return invoke("reorder_plan_entries", { planId, entryIdsInOrder });
}

export function deletePlanEntry(planId: string, entryId: string): Promise<void> {
  return invoke("delete_plan_entry", { planId, entryId });
}
