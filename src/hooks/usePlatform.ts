import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

let cached: string | null = null;
let pending: Promise<string> | null = null;

function fetchPlatform(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = invoke<string>("get_platform")
      .then((platform) => {
        cached = platform;
        return platform;
      })
      .catch(() => "windows");
  }
  return pending;
}

export function usePlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(cached);
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchPlatform().then((p) => {
      if (!cancelled) setPlatform(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return platform;
}

/**
 * Multibox, the Combat Overlay, and the Price Widget are native Win32/GDI
 * overlays with no cross-platform implementation yet. Treat an unresolved
 * platform as Windows so the overwhelming majority of users (on Windows)
 * never see these entry points flash in and out while the check resolves.
 */
export function useIsWindows(): boolean {
  const platform = usePlatform();
  return platform === null || platform === "windows";
}
