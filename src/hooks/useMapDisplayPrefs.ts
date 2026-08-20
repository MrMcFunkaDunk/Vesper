import { useEffect, useRef, useState } from "react";

const LEGEND_OPEN_KEY = "vesper.map.legendOpen";
const SHOW_SERVICE_ICONS_KEY = "vesper.map.showServiceIcons";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

/** Whether the Map screen's key/legend panel is open and whether the
 * DOTLAN-style service icons show under system names - both default to on
 * (matching the map's existing out-of-the-box look), persisted so closing
 * the key or hiding icons sticks across tab switches instead of resetting
 * every time MapView remounts. */
export function useMapDisplayPrefs() {
  const [legendOpen, setLegendOpen] = useState(() => readBool(LEGEND_OPEN_KEY, true));
  const [showServiceIcons, setShowServiceIcons] = useState(() => readBool(SHOW_SERVICE_ICONS_KEY, true));

  const legendHydrated = useRef(false);
  useEffect(() => {
    if (!legendHydrated.current) {
      legendHydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(LEGEND_OPEN_KEY, String(legendOpen));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [legendOpen]);

  const iconsHydrated = useRef(false);
  useEffect(() => {
    if (!iconsHydrated.current) {
      iconsHydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(SHOW_SERVICE_ICONS_KEY, String(showServiceIcons));
    } catch {
      // Not worth surfacing - worst case the preference doesn't persist.
    }
  }, [showServiceIcons]);

  return { legendOpen, setLegendOpen, showServiceIcons, setShowServiceIcons };
}
