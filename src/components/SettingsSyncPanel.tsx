import { useEffect, useState } from "react";
import { RefreshCw, FolderOpen, FolderCog, RotateCcw, Trash2, Save, Plus, Pencil, Copy, Check, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  getDefaultEveSettingsPath,
  listEveSettingsServers,
  listEveSettingsProfiles,
  listEveSettingsFiles,
  syncEveSettingsFile,
  listSettingsBackups,
  createSettingsFileBackup,
  createSettingsProfileBackup,
  restoreSettingsBackup,
  deleteSettingsBackup,
  createEveSettingsProfile,
  renameEveSettingsProfile,
  duplicateEveSettingsProfile,
  deleteEveSettingsProfile,
  type EveServerFolder,
  type EveSettingsProfile,
  type EveSettingsFile,
  type BackupEntry,
} from "../lib/settingsSync";
import { formatRelativeTime } from "../lib/format";
import { resolveEntityNames } from "../lib/wars";
import { useErrorReporter } from "../hooks/useErrorReporter";
import type { SessionCharacter } from "../lib/eve";

const CUSTOM_PATH_KEY = "vesper.settingsSync.customBasePath";

interface SettingsSyncPanelProps {
  characters: SessionCharacter[];
}

interface ProfileTabsProps {
  profiles: EveSettingsProfile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onCreate: (name: string) => void;
  onRename: (profile: EveSettingsProfile, name: string) => void;
  onDuplicate: (profile: EveSettingsProfile, name: string) => void;
  onDelete: (profile: EveSettingsProfile) => void;
}

/** Profile tabs with +/rename/duplicate/delete controls, matching the
 * reference eve-settings-manager tool's profile strip - modeled on this
 * app's own ChainSwitcher (wormhole chain tabs), same inline-rename idiom. */
function ProfileTabs({ profiles, activePath, onSelect, onCreate, onRename, onDuplicate, onDelete }: ProfileTabsProps) {
  const [creating, setCreating] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [duplicatingPath, setDuplicatingPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  function startCreate() {
    setDraftName("New Profile");
    setCreating(true);
    setRenamingPath(null);
    setDuplicatingPath(null);
  }

  function confirmCreate() {
    const name = draftName.trim();
    if (name) onCreate(name);
    setCreating(false);
  }

  function startRename(profile: EveSettingsProfile) {
    setDraftName(profile.name);
    setRenamingPath(profile.path);
    setCreating(false);
    setDuplicatingPath(null);
  }

  function confirmRename(profile: EveSettingsProfile) {
    const name = draftName.trim();
    if (name) onRename(profile, name);
    setRenamingPath(null);
  }

  function startDuplicate(profile: EveSettingsProfile) {
    setDraftName(`${profile.name} Copy`);
    setDuplicatingPath(profile.path);
    setCreating(false);
    setRenamingPath(null);
  }

  function confirmDuplicate(profile: EveSettingsProfile) {
    const name = draftName.trim();
    if (name) onDuplicate(profile, name);
    setDuplicatingPath(null);
  }

  return (
    <div className="settings-profile-tabs">
      {profiles.map((profile) => {
        if (renamingPath === profile.path || duplicatingPath === profile.path) {
          const confirming = renamingPath === profile.path ? () => confirmRename(profile) : () => confirmDuplicate(profile);
          const cancel = () => {
            setRenamingPath(null);
            setDuplicatingPath(null);
          };
          return (
            <div key={profile.path} className="settings-profile-rename">
              <input
                type="text"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirming();
                  if (e.key === "Escape") cancel();
                }}
              />
              <button type="button" onClick={confirming} title="Save">
                <Check size={13} strokeWidth={2} />
              </button>
              <button type="button" onClick={cancel} title="Cancel">
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          );
        }
        return (
          <button
            key={profile.path}
            type="button"
            className={`settings-profile-pill${profile.path === activePath ? " settings-profile-pill-active" : ""}`}
            onClick={() => onSelect(profile.path)}
          >
            {profile.name}
            <span
              className="settings-profile-pill-action"
              onClick={(e) => {
                e.stopPropagation();
                startRename(profile);
              }}
              title="Rename profile"
            >
              <Pencil size={11} strokeWidth={2} />
            </span>
            <span
              className="settings-profile-pill-action"
              onClick={(e) => {
                e.stopPropagation();
                startDuplicate(profile);
              }}
              title="Duplicate profile"
            >
              <Copy size={11} strokeWidth={2} />
            </span>
            <span
              className="settings-profile-pill-action"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete profile "${profile.name}" and every settings file inside it? This can't be undone.`)) onDelete(profile);
              }}
              title="Delete profile"
            >
              <Trash2 size={11} strokeWidth={2} />
            </span>
          </button>
        );
      })}

      {creating ? (
        <div className="settings-profile-rename">
          <input
            type="text"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmCreate();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" onClick={confirmCreate} title="Save">
            <Check size={13} strokeWidth={2} />
          </button>
          <button type="button" onClick={() => setCreating(false)} title="Cancel">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button type="button" className="settings-profile-pill settings-profile-pill-new" onClick={startCreate}>
          <Plus size={13} strokeWidth={2} /> New Profile
        </button>
      )}
    </div>
  );
}

function formatBackupTime(unixSeconds: number): string {
  return formatRelativeTime(new Date(unixSeconds * 1000).toISOString());
}

/** Copies one character's real EVE client settings file onto others -
 * same file-level operation the user's own eve-settings-manager tool
 * does daily: a raw byte-for-byte .dat replace, backed up first. Also
 * carries that tool's full backup management (list/restore/delete,
 * whole-profile or single-file) and settings-profile CRUD. */
function SettingsSyncPanel({ characters }: SettingsSyncPanelProps) {
  const reportError = useErrorReporter();
  const [basePath, setBasePath] = useState<string | null | undefined>(undefined);
  const [servers, setServers] = useState<EveServerFolder[]>([]);
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<EveSettingsProfile[]>([]);
  const [profilePath, setProfilePath] = useState<string | null>(null);
  const [files, setFiles] = useState<EveSettingsFile[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [destPaths, setDestPaths] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [rowActionPath, setRowActionPath] = useState<string | null>(null);

  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [backupActionId, setBackupActionId] = useState<string | null>(null);
  const [backingUpProfile, setBackingUpProfile] = useState(false);

  useEffect(() => {
    const custom = localStorage.getItem(CUSTOM_PATH_KEY);
    if (custom) {
      setBasePath(custom);
      return;
    }
    getDefaultEveSettingsPath()
      .then(setBasePath)
      .catch(() => setBasePath(null));
  }, []);

  useEffect(() => {
    if (!basePath) return;
    listEveSettingsServers(basePath)
      .then((s) => {
        setServers(s);
        if (s.length === 1) setServerPath(s[0].path);
      })
      .catch((err) => reportError(`Failed to list EVE servers: ${err}`));
  }, [basePath, reportError]);

  useEffect(() => {
    if (!serverPath) return;
    listEveSettingsProfiles(serverPath)
      .then((p) => {
        setProfiles(p);
        if (p.length === 1) setProfilePath(p[0].path);
      })
      .catch((err) => reportError(`Failed to list settings profiles: ${err}`));
  }, [serverPath, reportError]);

  useEffect(() => {
    setFiles(null);
    setSourcePath(null);
    setDestPaths(new Set());
    if (!profilePath) return;
    listEveSettingsFiles(profilePath)
      .then(setFiles)
      .catch((err) => reportError(`Failed to list settings files: ${err}`));
  }, [profilePath, reportError]);

  useEffect(() => {
    if (!files) return;
    const knownIds = new Set(characters.map((c) => String(c.id)));
    const unknownCharIds = files.filter((f) => f.file_type === "char" && !knownIds.has(f.id)).map((f) => Number(f.id));
    if (unknownCharIds.length === 0) return;
    resolveEntityNames(unknownCharIds)
      .then((resolved) => setNames((prev) => ({ ...prev, ...resolved })))
      .catch(() => {});
  }, [files, characters]);

  function loadBackups() {
    listSettingsBackups()
      .then(setBackups)
      .catch((err) => reportError(`Failed to list backups: ${err}`));
  }

  useEffect(() => {
    loadBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function nameFor(file: EveSettingsFile): string {
    if (file.file_type === "user") return `Shared account settings (owner ${file.id})`;
    const known = characters.find((c) => String(c.id) === file.id);
    if (known) return known.name;
    return names[file.id] ?? `Character #${file.id}`;
  }

  function toggleDest(path: string) {
    setDestPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handlePickFolder() {
    try {
      const picked = await openFolderDialog({ directory: true, title: "Select your EVE settings folder (…\\CCP\\EVE)" });
      if (!picked || Array.isArray(picked)) return;
      localStorage.setItem(CUSTOM_PATH_KEY, picked);
      setBasePath(picked);
      setServerPath(null);
      setProfilePath(null);
    } catch (err) {
      reportError(`Failed to open folder picker: ${String(err)}`);
    }
  }

  async function handleDefaultPath() {
    localStorage.removeItem(CUSTOM_PATH_KEY);
    setServerPath(null);
    setProfilePath(null);
    try {
      setBasePath(await getDefaultEveSettingsPath());
    } catch (err) {
      reportError(`Failed to detect the default EVE settings path: ${String(err)}`);
    }
  }

  async function handleSync() {
    if (!sourcePath || destPaths.size === 0 || !files) return;
    const sourceFile = files.find((f) => f.path === sourcePath);
    const label = sourceFile ? nameFor(sourceFile) : "the selected file";
    const destCount = destPaths.size;
    const confirmed = window.confirm(
      `Copy ${label}'s settings onto ${destCount} other file(s)? Each destination's current settings will be backed up inside VESPER first, then overwritten. This can't be undone in-game - only VESPER's own backup copy will exist.`,
    );
    if (!confirmed) return;

    setSyncing(true);
    setSyncMessage(null);
    try {
      const results = await syncEveSettingsFile(sourcePath, [...destPaths]);
      const backedUp = results.filter((r) => r.backup_path).length;
      setSyncMessage(`Synced to ${results.length} file(s) - ${backedUp} backup(s) made before overwriting.`);
      setTimeout(() => setSyncMessage(null), 6000);
      setDestPaths(new Set());
      const refreshed = await listEveSettingsFiles(profilePath!);
      setFiles(refreshed);
      loadBackups();
    } catch (err) {
      reportError(`Failed to sync settings: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleBackupFile(file: EveSettingsFile) {
    setRowActionPath(file.path);
    try {
      await createSettingsFileBackup(file.path, `${nameFor(file)} - manual backup`);
      loadBackups();
      setSyncMessage(`Backed up ${nameFor(file)}.`);
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err) {
      reportError(`Failed to back up settings file: ${String(err)}`);
    } finally {
      setRowActionPath(null);
    }
  }

  async function handleBackupProfile() {
    if (!profilePath) return;
    const profile = profiles.find((p) => p.path === profilePath);
    setBackingUpProfile(true);
    try {
      await createSettingsProfileBackup(profilePath, profile ? `${profile.name} (full profile)` : undefined);
      loadBackups();
      setSyncMessage("Backed up the whole profile.");
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err) {
      reportError(`Failed to back up profile: ${String(err)}`);
    } finally {
      setBackingUpProfile(false);
    }
  }

  async function handleOpenPath(path: string) {
    try {
      await revealItemInDir(path);
    } catch (err) {
      reportError(`Failed to open folder: ${String(err)}`);
    }
  }

  async function handleRestoreBackup(entry: BackupEntry) {
    const what = entry.kind === "profile" ? `${entry.file_count} file(s) back into its profile folder` : "this file";
    if (!confirm(`Restore "${entry.display_name}"? This copies ${what}, overwriting whatever is currently there.`)) return;
    setBackupActionId(entry.id);
    try {
      await restoreSettingsBackup(entry.id);
      if (profilePath) setFiles(await listEveSettingsFiles(profilePath));
      setSyncMessage(`Restored "${entry.display_name}".`);
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err) {
      reportError(`Failed to restore backup: ${String(err)}`);
    } finally {
      setBackupActionId(null);
    }
  }

  async function handleDeleteBackup(entry: BackupEntry) {
    if (!confirm(`Delete backup "${entry.display_name}"? VESPER's own copy is removed - this can't be undone.`)) return;
    setBackupActionId(entry.id);
    try {
      await deleteSettingsBackup(entry.id);
      loadBackups();
    } catch (err) {
      reportError(`Failed to delete backup: ${String(err)}`);
    } finally {
      setBackupActionId(null);
    }
  }

  async function refreshProfiles(selectPath?: string) {
    if (!serverPath) return;
    const refreshed = await listEveSettingsProfiles(serverPath);
    setProfiles(refreshed);
    if (selectPath) setProfilePath(selectPath);
  }

  async function handleCreateProfile(name: string) {
    if (!serverPath) return;
    try {
      const profile = await createEveSettingsProfile(serverPath, name);
      await refreshProfiles(profile.path);
    } catch (err) {
      reportError(`Failed to create profile: ${String(err)}`);
    }
  }

  async function handleRenameProfile(profile: EveSettingsProfile, newName: string) {
    try {
      const renamed = await renameEveSettingsProfile(profile.path, newName);
      await refreshProfiles(profilePath === profile.path ? renamed.path : undefined);
    } catch (err) {
      reportError(`Failed to rename profile: ${String(err)}`);
    }
  }

  async function handleDuplicateProfile(profile: EveSettingsProfile, newName: string) {
    try {
      const duplicated = await duplicateEveSettingsProfile(profile.path, newName);
      await refreshProfiles(duplicated.path);
    } catch (err) {
      reportError(`Failed to duplicate profile: ${String(err)}`);
    }
  }

  async function handleDeleteProfile(profile: EveSettingsProfile) {
    try {
      await deleteEveSettingsProfile(profile.path);
      if (profilePath === profile.path) setProfilePath(null);
      await refreshProfiles();
    } catch (err) {
      reportError(`Failed to delete profile: ${String(err)}`);
    }
  }

  if (basePath === undefined) {
    return <p className="detail-empty">Looking for your EVE settings folder...</p>;
  }

  if (basePath === null) {
    return (
      <div className="settings-sync-panel">
        <p className="detail-empty">
          Couldn't find your EVE settings folder at the default location (%LOCALAPPDATA%\CCP\EVE).
        </p>
        <div className="settings-section-row">
          <button type="button" className="kills-sync-btn" onClick={handlePickFolder}>
            <FolderCog size={13} strokeWidth={2} />
            Manually Select Folder
          </button>
        </div>
      </div>
    );
  }

  const sourceFileType = files?.find((f) => f.path === sourcePath)?.file_type ?? null;
  const destCandidates = files?.filter((f) => f.path !== sourcePath && (!sourceFileType || f.file_type === sourceFileType)) ?? [];
  const isDefaultPath = !localStorage.getItem(CUSTOM_PATH_KEY);

  return (
    <div className="settings-sync-panel">
      <p className="settings-section-hint">
        Copies one character's EVE client settings (overview, UI layout, keybinds, chat channels) straight onto
        others - the exact same file-level operation as editing your overview once and having it apply everywhere.
        Every destination file is backed up inside VESPER first, before anything is overwritten.
      </p>

      <div className="settings-section-row">
        <button type="button" className="detail-back" onClick={handlePickFolder}>
          <FolderCog size={13} strokeWidth={2} />
          Manually Select Folder
        </button>
        <button type="button" className="detail-back" onClick={handleDefaultPath} disabled={isDefaultPath}>
          Default Path
        </button>
        <span className="settings-sync-basepath" title={basePath}>
          {basePath}
        </span>
      </div>

      <div className="settings-sync-pickers">
        <label className="settings-sync-picker">
          <span>Server</span>
          <select value={serverPath ?? ""} onChange={(e) => setServerPath(e.target.value || null)}>
            <option value="" disabled>
              Select a server...
            </option>
            {servers.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {serverPath && (
        <ProfileTabs
          profiles={profiles}
          activePath={profilePath}
          onSelect={setProfilePath}
          onCreate={handleCreateProfile}
          onRename={handleRenameProfile}
          onDuplicate={handleDuplicateProfile}
          onDelete={handleDeleteProfile}
        />
      )}

      {profilePath && (
        <div className="settings-section-row">
          <button type="button" className="kills-sync-btn" onClick={handleBackupProfile} disabled={backingUpProfile}>
            <Save size={13} strokeWidth={2} />
            {backingUpProfile ? "Backing up..." : "Backup Profile"}
          </button>
          <button type="button" className="detail-back" onClick={() => handleOpenPath(profilePath)}>
            <FolderOpen size={13} strokeWidth={2} />
            Open Profile
          </button>
          {syncMessage && <span className="fittings-inline-success">{syncMessage}</span>}
        </div>
      )}

      {files === null ? (
        profilePath && <p className="detail-empty">Loading settings files...</p>
      ) : files.length === 0 ? (
        <p className="detail-empty">No character or account settings files found in this profile.</p>
      ) : (
        <>
          <div className="settings-sync-columns">
            <div className="settings-sync-column">
              <p className="settings-sync-column-label">Sync FROM (source)</p>
              {files.map((f) => (
                <div key={f.path} className="settings-sync-file-row">
                  <label>
                    <input type="radio" name="sync-source" checked={sourcePath === f.path} onChange={() => setSourcePath(f.path)} />
                    <span className="settings-sync-file-name">{nameFor(f)}</span>
                    <span className="data-table-tag data-table-tag-neutral">{f.file_type}</span>
                  </label>
                  <span className="settings-sync-file-actions">
                    <button
                      type="button"
                      className="settings-sync-file-action"
                      onClick={() => handleBackupFile(f)}
                      disabled={rowActionPath === f.path}
                      title="Back up this file"
                    >
                      <Save size={12} strokeWidth={2} />
                    </button>
                    <button type="button" className="settings-sync-file-action" onClick={() => handleOpenPath(f.path)} title="Reveal in Explorer">
                      <FolderOpen size={12} strokeWidth={2} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div className="settings-sync-column">
              <p className="settings-sync-column-label">Sync TO (destinations)</p>
              {!sourcePath ? (
                <p className="detail-empty">Pick a source first.</p>
              ) : (
                destCandidates.map((f) => (
                  <label key={f.path} className="settings-sync-file-row">
                    <input type="checkbox" checked={destPaths.has(f.path)} onChange={() => toggleDest(f.path)} />
                    <span className="settings-sync-file-name">{nameFor(f)}</span>
                    <span className="data-table-tag data-table-tag-neutral">{f.file_type}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleSync} disabled={syncing || !sourcePath || destPaths.size === 0}>
              <RefreshCw size={13} strokeWidth={2} className={syncing ? "market-resync-spin" : undefined} />
              {syncing ? "Syncing..." : destPaths.size > 0 ? `Sync to ${destPaths.size} File(s)` : "Sync"}
            </button>
            {syncMessage && <span className="fittings-inline-success">{syncMessage}</span>}
          </div>
        </>
      )}

      <div className="settings-sync-backups">
        <h4>Backups</h4>
        <p className="settings-section-hint">
          Every backup VESPER has made - both ones you triggered explicitly and the automatic ones made just before
          a sync overwrite. Restoring copies a backup's contents back to where it came from.
        </p>
        {!backups ? (
          <p className="detail-empty">Loading backups...</p>
        ) : backups.length === 0 ? (
          <p className="detail-empty">No backups yet - one is made automatically the first time you sync or back up a file/profile.</p>
        ) : (
          <div className="settings-backup-list">
            {backups.map((entry) => (
              <div key={entry.id} className="settings-backup-row">
                <span className={`data-table-tag ${entry.kind === "profile" ? "data-table-tag-accent" : "data-table-tag-neutral"}`}>
                  {entry.kind === "profile" ? "Profile" : "File"}
                </span>
                <span className="settings-backup-name" title={entry.source_path}>
                  {entry.display_name}
                </span>
                {entry.kind === "profile" && <span className="settings-backup-count">{entry.file_count} file(s)</span>}
                <span className="settings-backup-time">{formatBackupTime(entry.created_at)}</span>
                <span className="settings-sync-file-actions">
                  <button
                    type="button"
                    className="settings-sync-file-action"
                    onClick={() => handleOpenPath(entry.backup_path)}
                    title="Reveal backup in Explorer"
                  >
                    <FolderOpen size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="settings-sync-file-action"
                    onClick={() => handleRestoreBackup(entry)}
                    disabled={backupActionId === entry.id}
                    title="Restore this backup"
                  >
                    <RotateCcw size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="settings-sync-file-action settings-sync-file-action-danger"
                    onClick={() => handleDeleteBackup(entry)}
                    disabled={backupActionId === entry.id}
                    title="Delete this backup"
                  >
                    <Trash2 size={12} strokeWidth={2} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsSyncPanel;
