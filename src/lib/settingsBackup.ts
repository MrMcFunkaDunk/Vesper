import { invoke } from "@tauri-apps/api/core";

/**
 * A plain-file mirror of everything this app keeps in localStorage (theme,
 * favourites, saved location, industry defaults, gate-camp favourites,
 * etc.), written via a Tauri command to VESPER's own app-data folder - see
 * app_settings_backup.rs's own doc comment for the real incident this
 * exists to guard against. localStorage lives inside the WebView2 profile,
 * which is outside this app's control and can be reset by things it has no
 * visibility into; a plain JSON file this app writes and reads itself
 * can't be touched by whatever does that.
 *
 * Every hook that persists something to localStorage - both the ones built
 * on usePersistentState and the handful that manage localStorage directly
 * (useTheme, useLocationTracking, useIndustryDefaults, useNavOrder,
 * useCharacterOrder, useColorOverrides, useSavedRoutes, useTrackedEntries) -
 * calls backupSetting() right after its own localStorage.setItem() call.
 * Any NEW hook that manages localStorage directly (rather than through
 * usePersistentState, which already calls this) must do the same.
 */

// Debounced per-key rather than per-call - a few hooks write on every
// keystroke/toggle in quick succession (e.g. dragging a nav order), and
// there's no reason to fire a separate IPC round-trip + disk write for
// each intermediate value when only the last one before a pause matters.
const pendingTimers = new Map<string, number>();
const DEBOUNCE_MS = 500;

export function backupSetting(key: string, rawValue: string): void {
  const existing = pendingTimers.get(key);
  if (existing != null) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    pendingTimers.delete(key);
    invoke("set_app_settings_backup_entry", { key, value: rawValue }).catch(() => {
      // Not worth surfacing - worst case this one change doesn't make it
      // into the backup file, same as any other best-effort persistence.
    });
  }, DEBOUNCE_MS);
  pendingTimers.set(key, timer);
}

/**
 * Backfills anything localStorage is missing from the on-disk backup -
 * never overwrites a key localStorage already has a value for, so this is
 * a no-op in the normal case and a full restore only when localStorage
 * has genuinely come back emptier than the backup file remembers.
 * Awaited in main.tsx before the app renders, so every hook's own
 * `useState(() => readFromLocalStorage())`-style initializer sees the
 * restored values on its very first read - no flash of defaults, no
 * separate after-the-fact reconciliation needed for the hooks that only
 * ever read localStorage once at mount.
 */
export async function restoreSettingsFromDisk(): Promise<void> {
  try {
    const backup = await invoke<Record<string, string>>("get_app_settings_backup");
    for (const [key, value] of Object.entries(backup)) {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
      }
    }
  } catch {
    // No backup yet (fresh install) or the IPC call failed - either way,
    // the app falls back to whatever localStorage already has, exactly as
    // it did before this existed.
  }
}
