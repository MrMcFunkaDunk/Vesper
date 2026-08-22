import { invoke } from "@tauri-apps/api/core";

export interface EveServerFolder {
  name: string;
  path: string;
}

export interface EveSettingsProfile {
  name: string;
  path: string;
}

export interface EveSettingsFile {
  /** "char" or "user" - which of EVE's two settings-file kinds this is. */
  file_type: "char" | "user";
  /** The numeric character or account id parsed straight from the filename. */
  id: string;
  path: string;
  modified_at: number;
}

export interface SyncResult {
  dest_path: string;
  /** Where the destination's pre-sync contents were backed up to - null
   * only when the destination file didn't exist yet, so there was
   * nothing to back up. */
  backup_path: string | null;
}

export interface BackupEntry {
  id: string;
  /** "file" (one core_*.dat) or "profile" (every .dat in a settings profile folder). */
  kind: "file" | "profile";
  display_name: string;
  /** Where restoring this backup writes back to. */
  source_path: string;
  /** Where VESPER's own copy of the backed-up data lives. */
  backup_path: string;
  created_at: number;
  file_count: number;
}

/** EVE's own local settings folder (%LOCALAPPDATA%\CCP\EVE on Windows) -
 * null if it isn't at the default location. */
export function getDefaultEveSettingsPath(): Promise<string | null> {
  return invoke("get_default_eve_settings_path");
}

/** Server sub-folders under the EVE settings folder (e.g. Tranquility) -
 * only ones that actually contain at least one settings profile. */
export function listEveSettingsServers(basePath: string): Promise<EveServerFolder[]> {
  return invoke("list_eve_settings_servers", { basePath });
}

/** Settings profiles under one server folder (EVE's own "Settings
 * Profile" concept, selectable at character select - usually just
 * "Default" unless the user made others in-game). */
export function listEveSettingsProfiles(serverPath: string): Promise<EveSettingsProfile[]> {
  return invoke("list_eve_settings_profiles", { serverPath });
}

/** Every character/account settings file inside one profile folder. */
export function listEveSettingsFiles(profilePath: string): Promise<EveSettingsFile[]> {
  return invoke("list_eve_settings_files", { profilePath });
}

/** Copies one settings file's raw bytes onto one or more destination
 * files - a full replace, not a merge. Each destination that already
 * exists is backed up first (see SyncResult.backup_path). */
export function syncEveSettingsFile(sourcePath: string, destPaths: string[]): Promise<SyncResult[]> {
  return invoke("sync_eve_settings_file", { sourcePath, destPaths });
}

/** Every tracked backup (both single-file and whole-profile kinds),
 * newest first - includes automatic pre-sync backups. */
export function listSettingsBackups(): Promise<BackupEntry[]> {
  return invoke("list_settings_backups");
}

/** Backs up one settings file on demand (the per-row action). */
export function createSettingsFileBackup(sourcePath: string, displayName?: string): Promise<BackupEntry> {
  return invoke("create_settings_file_backup", { sourcePath, displayName: displayName ?? null });
}

/** Backs up every .dat file in a whole settings profile at once. */
export function createSettingsProfileBackup(profilePath: string, displayName?: string): Promise<BackupEntry> {
  return invoke("create_settings_profile_backup", { profilePath, displayName: displayName ?? null });
}

/** Copies a tracked backup's contents back to where it came from. */
export function restoreSettingsBackup(backupId: string): Promise<void> {
  return invoke("restore_settings_backup", { backupId });
}

/** Deletes a tracked backup's own copy (never touches the live game file). */
export function deleteSettingsBackup(backupId: string): Promise<void> {
  return invoke("delete_settings_backup", { backupId });
}

/** Creates a new, empty settings profile folder under a server. */
export function createEveSettingsProfile(serverPath: string, name: string): Promise<EveSettingsProfile> {
  return invoke("create_eve_settings_profile", { serverPath, name });
}

/** Renames a settings profile folder in place. */
export function renameEveSettingsProfile(profilePath: string, newName: string): Promise<EveSettingsProfile> {
  return invoke("rename_eve_settings_profile", { profilePath, newName });
}

/** Copies a whole settings profile folder under a new name. */
export function duplicateEveSettingsProfile(profilePath: string, newName: string): Promise<EveSettingsProfile> {
  return invoke("duplicate_eve_settings_profile", { profilePath, newName });
}

/** Deletes a settings profile folder and everything in it. */
export function deleteEveSettingsProfile(profilePath: string): Promise<void> {
  return invoke("delete_eve_settings_profile", { profilePath });
}
