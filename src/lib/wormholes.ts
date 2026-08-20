import { invoke } from "@tauri-apps/api/core";

export interface ChainSummary {
  id: string;
  name: string;
  system_count: number;
  auto_map_enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface ChainSystem {
  id: string;
  system_id: number;
  system_name: string;
  x: number;
  y: number;
  is_origin: boolean;
  notes: string;
}

export type SignatureKind = "unknown" | "combat" | "data" | "relic" | "gas" | "wormhole" | "ore";

export interface Signature {
  id: string;
  chain_system_id: string;
  sig_id: string;
  sig_type: string;
  name: string;
  signal_strength: string;
  kind: SignatureKind;
  first_seen_at: number;
  last_seen_at: number;
}

export type StructureType =
  | "unknown"
  | "astrahus"
  | "fortizar"
  | "keepstar"
  | "raitaru"
  | "azbel"
  | "sotiyo"
  | "athanor"
  | "tatara"
  | "ansiblex"
  | "pharolynx"
  | "tenebrex";

/** A player-owned structure manually registered for a chain system, pasted
 * from the in-game Overview - ESI's public structure list only covers
 * known/scannable space, so it can't see a citadel sitting in unscanned
 * J-space. Unlike signatures, nothing here decays; it stays until deleted. */
export interface ChainStructure {
  id: string;
  chain_system_id: string;
  eve_id: number;
  name: string;
  structure_type: StructureType;
  created_at: number;
}

export type MassStatus = "fresh" | "reduced" | "critical";

export type ConnectionKind = "wormhole" | "stargate";

export interface Connection {
  id: string;
  from_chain_system_id: string;
  to_chain_system_id: string;
  /** "stargate" connections are auto-added by live-location tracking for a
   * plain gate hop - a breadcrumb of the route in and out of known space,
   * not a wormhole to manage (no type/mass/EOL/rolling calculator). */
  kind: ConnectionKind;
  wormhole_type: string;
  mass_status: MassStatus;
  is_eol: boolean;
  eol_flagged_at: number | null;
  first_seen_at: number;
  from_signature_id: string | null;
  to_signature_id: string | null;
  from_signature_broken: boolean;
  to_signature_broken: boolean;
  flag_icon: string | null;
  flag_color: string | null;
  flag_note: string;
  flag_blink: boolean;
  notes: string;
}

export interface MassLogEntry {
  id: string;
  connection_id: string;
  character_name: string;
  ship_type_name: string;
  mass_kg: number;
  hot: boolean;
  source: "manual" | "esi_auto";
  created_at: number;
}

export interface ChainDetail {
  id: string;
  name: string;
  auto_map_enabled: boolean;
  systems: ChainSystem[];
  connections: Connection[];
  signatures: Signature[];
  structures: ChainStructure[];
  mass_log_entries: MassLogEntry[];
  created_at: number;
  updated_at: number;
}

export function listChains(): Promise<ChainSummary[]> {
  return invoke("list_chains");
}

export function getChain(chainId: string): Promise<ChainDetail> {
  return invoke("get_chain", { chainId });
}

export function createChain(name: string): Promise<string> {
  return invoke("create_chain", { name });
}

export function renameChain(chainId: string, name: string): Promise<void> {
  return invoke("rename_chain", { chainId, name });
}

export function deleteChain(chainId: string): Promise<void> {
  return invoke("delete_chain", { chainId });
}

/** Governs both auto-add-systems-and-connections and auto-mass-logging as
 * one toggle - "this chain tracks my live movement," not two switches. */
export function setChainAutoMap(chainId: string, enabled: boolean): Promise<void> {
  return invoke("set_chain_auto_map", { chainId, enabled });
}

export interface ChainSystemInput {
  id: string | null;
  system_id: number;
  system_name: string;
  x: number;
  y: number;
  is_origin: boolean;
  notes: string;
}

export function upsertChainSystem(chainId: string, input: ChainSystemInput): Promise<string> {
  return invoke("upsert_chain_system", { chainId, input });
}

export function deleteChainSystem(chainId: string, chainSystemId: string): Promise<void> {
  return invoke("delete_chain_system", { chainId, chainSystemId });
}

export interface ConnectionInput {
  id: string | null;
  from_chain_system_id: string;
  to_chain_system_id: string;
  kind: ConnectionKind;
  wormhole_type: string;
  mass_status: MassStatus;
  is_eol: boolean;
  from_signature_id: string | null;
  to_signature_id: string | null;
  flag_icon: string | null;
  flag_color: string | null;
  flag_note: string;
  flag_blink: boolean;
  notes: string;
}

export function upsertConnection(chainId: string, input: ConnectionInput): Promise<string> {
  return invoke("upsert_connection", { chainId, input });
}

export function deleteConnection(chainId: string, connectionId: string): Promise<void> {
  return invoke("delete_connection", { chainId, connectionId });
}

export interface MassLogInput {
  connection_id: string;
  character_name: string;
  ship_type_name: string;
  mass_kg: number;
  hot: boolean;
  source: "manual" | "esi_auto";
}

export function upsertMassLog(chainId: string, input: MassLogInput): Promise<string> {
  return invoke("upsert_mass_log", { chainId, input });
}

/** Undo: deletes a specific log row the caller already has. */
export function deleteMassLogEntry(chainId: string, entryId: string): Promise<void> {
  return invoke("delete_mass_log_entry", { chainId, entryId });
}

/** Reset: clears every logged pass for one connection. */
export function clearMassLog(chainId: string, connectionId: string): Promise<void> {
  return invoke("clear_mass_log", { chainId, connectionId });
}

export interface SignatureInput {
  id: string | null;
  chain_system_id: string;
  sig_id: string;
  sig_type: string;
  name: string;
  signal_strength: string;
  kind: SignatureKind;
}

export function upsertSignature(chainId: string, input: SignatureInput): Promise<string> {
  return invoke("upsert_signature", { chainId, input });
}

export interface ParsedSignature {
  sig_id: string;
  kind: SignatureKind;
  sig_type: string;
  signal_strength: string;
}

export interface ImportSignaturesResult {
  imported: number;
  updated: number;
  missing_sig_ids: string[];
}

/** Bulk-upserts a pasted d-scan/probe-scan paste for one chain system. Never
 * deletes sigs missing from the paste - those come back in `missing_sig_ids`
 * for the caller to surface, since a partial scan shouldn't silently erase
 * sigs the player just didn't rescan. */
export function importSignatures(
  chainId: string,
  chainSystemId: string,
  signatures: ParsedSignature[],
): Promise<ImportSignaturesResult> {
  return invoke("import_signatures", { chainId, chainSystemId, signatures });
}

export function deleteSignature(chainId: string, signatureId: string): Promise<void> {
  return invoke("delete_signature", { chainId, signatureId });
}

export interface ParsedStructure {
  eve_id: number;
  name: string;
  structure_type: StructureType;
}

export interface ImportStructuresResult {
  imported: number;
  updated: number;
}

/** Bulk-upserts a pasted in-game Overview list of player-owned structures for
 * one chain system - re-pasting is safe, existing entries (matched by
 * eve_id) are just updated rather than duplicated. */
export function importStructures(
  chainId: string,
  chainSystemId: string,
  structures: ParsedStructure[],
): Promise<ImportStructuresResult> {
  return invoke("import_structures", { chainId, chainSystemId, structures });
}

export function deleteChainStructure(chainId: string, structureId: string): Promise<void> {
  return invoke("delete_chain_structure", { chainId, structureId });
}

export interface RouteHop {
  kind: "stargate" | "wormhole";
  connection_id: string | null;
}

export interface RouteStep {
  system_id: number;
  system_name: string;
  via: RouteHop | null;
}

/** Shortest path over stargates plus this chain's drawn wormhole connections -
 * a local BFS, not CCP's ESI route endpoint (which has no wormhole concept). */
export function findChainRoute(chainId: string, originSystemId: number, destinationSystemId: number): Promise<RouteStep[]> {
  return invoke("find_chain_route", { chainId, originSystemId, destinationSystemId });
}
