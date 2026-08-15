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
