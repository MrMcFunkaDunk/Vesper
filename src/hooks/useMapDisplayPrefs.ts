import { usePersistentState } from "./usePersistentState";

const LEGEND_OPEN_KEY = "vesper.map.legendOpen";
const SHOW_SERVICE_ICONS_KEY = "vesper.map.showServiceIcons";
const SHOW_FW_CONTESTED_KEY = "vesper.map.showFwContested";
const SHOW_SOV_KEY = "vesper.map.showSov";
const SHOW_INCURSIONS_KEY = "vesper.map.showIncursions";
const HEAT_MODE_KEY = "vesper.map.heatMode";

/** Whether the Map screen's key/legend panel is open, whether the
 * DOTLAN-style service icons show under system names, whether contested
 * faction-warfare systems get their own ring, whether null-sec sovereignty
 * ownership/vulnerability shows, whether active incursions are marked, and
 * which last-hour aggregate the background heat glow reads from. The first
 * two default to on (matching the map's existing out-of-the-box look);
 * every other filter here defaults off/kills - niche filters most sessions
 * don't need lit up by default - persisted so these stick across tab
 * switches instead of resetting every time MapView remounts. */
export function useMapDisplayPrefs() {
  const [legendOpen, setLegendOpen] = usePersistentState<boolean>(LEGEND_OPEN_KEY, true);
  const [showServiceIcons, setShowServiceIcons] = usePersistentState<boolean>(SHOW_SERVICE_ICONS_KEY, true);
  const [showFwContested, setShowFwContested] = usePersistentState<boolean>(SHOW_FW_CONTESTED_KEY, false);
  const [showSov, setShowSov] = usePersistentState<boolean>(SHOW_SOV_KEY, false);
  const [showIncursions, setShowIncursions] = usePersistentState<boolean>(SHOW_INCURSIONS_KEY, false);
  const [heatMode, setHeatMode] = usePersistentState<"kills" | "traffic" | "npc">(HEAT_MODE_KEY, "kills");

  return {
    legendOpen,
    setLegendOpen,
    showServiceIcons,
    setShowServiceIcons,
    showFwContested,
    setShowFwContested,
    showSov,
    setShowSov,
    showIncursions,
    setShowIncursions,
    heatMode,
    setHeatMode,
  };
}
