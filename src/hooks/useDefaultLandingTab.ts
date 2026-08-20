import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.settings.defaultLandingTab";

/** Which sidebar nav id the app opens to on launch - falls back to
 * whatever the caller passes as the true default (NAV_ITEMS[0].id) rather
 * than hardcoding "dashboard" here, so it can't drift from Sidebar.tsx's
 * own ordering. */
export function useDefaultLandingTab(fallbackId: string) {
  const [tabId, setTabId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? fallbackId;
    } catch {
      return fallbackId;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, tabId);
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [tabId]);

  return [tabId, setTabId] as const;
}
