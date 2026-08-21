import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.settings.defaultLandingTab";

/** Which sidebar nav id the app opens to on launch - falls back to
 * whatever the caller passes as the true default (NAV_ITEMS[0].id) rather
 * than hardcoding "dashboard" here, so it can't drift from Sidebar.tsx's
 * own ordering. */
export function useDefaultLandingTab(fallbackId: string) {
  return usePersistentState<string>(STORAGE_KEY, fallbackId);
}
