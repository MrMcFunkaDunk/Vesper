import { invoke } from "@tauri-apps/api/core";

export interface SessionCharacter {
  id: number;
  name: string;
  scopes: string[];
  portrait_url: string;
}

export interface Session {
  characters: SessionCharacter[];
  active_character_id: number | null;
}

export function startLogin(scopes: string[] = []): Promise<void> {
  return invoke("start_login", { scopes });
}

export function getSession(): Promise<Session> {
  return invoke("get_session");
}

export function setActiveCharacter(id: number): Promise<void> {
  return invoke("set_active_character", { id });
}

export function logoutCharacter(id: number): Promise<void> {
  return invoke("logout_character", { id });
}

export interface CharacterOverview {
  character_id: number;
  isk_balance: number | null;
  total_sp: number | null;
  training_skill_name: string | null;
  training_finish_date: string | null;
  ship_type_name: string | null;
  system_name: string | null;
  corporation_name: string | null;
  alliance_name: string | null;
  needs_reauth: boolean;
}

export function getCharacterOverview(id: number): Promise<CharacterOverview> {
  return invoke("get_character_overview", { id });
}
