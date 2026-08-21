import { usePersistentState } from "./usePersistentState";

const LEGEND_OPEN_KEY = "vesper.map.legendOpen";
const SHOW_SERVICE_ICONS_KEY = "vesper.map.showServiceIcons";

/** Whether the Map screen's key/legend panel is open and whether the
 * DOTLAN-style service icons show under system names - both default to on
 * (matching the map's existing out-of-the-box look), persisted so closing
 * the key or hiding icons sticks across tab switches instead of resetting
 * every time MapView remounts. */
export function useMapDisplayPrefs() {
  const [legendOpen, setLegendOpen] = usePersistentState<boolean>(LEGEND_OPEN_KEY, true);
  const [showServiceIcons, setShowServiceIcons] = usePersistentState<boolean>(SHOW_SERVICE_ICONS_KEY, true);

  return { legendOpen, setLegendOpen, showServiceIcons, setShowServiceIcons };
}
