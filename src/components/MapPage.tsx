import { useEffect, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import MapView from "./MapView";
import type { MapSystem } from "../lib/map";
import PageTabBar from "./PageTabBar";
import GateCheck from "./GateCheck";
import LikelyGateCamps from "./LikelyGateCamps";
import LocalThreatCheck from "./LocalThreatCheck";
import DScanCheck from "./DScanCheck";
import RegionMapTab from "./RegionMapTab";
import type { SystemSummary } from "./SystemKillboard";
import type { GateSummary } from "./GateKillboard";
import type { SessionCharacter } from "../lib/eve";

type MapTab = "map" | "gatecheck" | "likelycamps" | "localthreat" | "dscan" | "regionmap";

const TABS: { id: MapTab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "gatecheck", label: "Gate Check" },
  { id: "likelycamps", label: "Likely Gate Camps" },
  { id: "localthreat", label: "Local Threat" },
  { id: "dscan", label: "D-Scan" },
  { id: "regionmap", label: "Region Map" },
];

interface MapPageProps {
  onSelectKill: (killmailId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectGate: (gate: GateSummary) => void;
  onSelectCharacter: (characterId: number) => void;
  characters: SessionCharacter[];
  /** MapPage stays mounted (CSS-hidden, not unmounted) whenever another tab
   * is open, to keep its own map/heat-map/kill-feed state warm - so unlike
   * the other 3 multi-tab pages, it can't just report its tab on mount. This
   * says whether Map is the tab actually showing right now, so the active-tab
   * report below can also fire on becoming visible again, not just on a tab
   * change. */
  visible: boolean;
  /** A sub-tab favourite ("map.localthreat") clicked in the Sidebar - jumps
   * straight to that tab, one-shot like WalletMarketPage's initialMarketItem. */
  initialTab?: string | null;
  onConsumeInitialTab?: () => void;
  /** Reports the active tab up to App.tsx (only while visible) so the
   * TopBar star button knows which specific tab to favourite. */
  onActiveTabChange?: (tab: string) => void;
}

function MapPage({
  onSelectKill,
  onSelectSystem,
  onSelectGate,
  onSelectCharacter,
  characters,
  visible,
  initialTab,
  onConsumeInitialTab,
  onActiveTabChange,
}: MapPageProps) {
  const [tab, setTab] = useState<MapTab>("map");
  // Set by "Send Route to Gate Check" on the map tab - GateCheck below picks
  // this up, pre-fills its waypoint slots, auto-runs the check, then
  // consumes it (one-shot, same pattern as initialTab above).
  const [pendingGateCheckWaypoints, setPendingGateCheckWaypoints] = useState<MapSystem[] | null>(null);
  // Covers the whole app window (sidebar, top bar, this page's own header
  // and tab bar) with just the map itself when true - see the render below
  // and .map-fullscreen-overlay in App.css.
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (initialTab && TABS.some((t) => t.id === initialTab)) {
      setTab(initialTab as MapTab);
      onConsumeInitialTab?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  useEffect(() => {
    if (visible) onActiveTabChange?.(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab]);

  // isFullscreen only ever toggles CSS classes below (position/z-index on
  // the outer <main>, display:none on the header/tab bar) rather than
  // changing which branch renders - MapView stays mounted in exactly the
  // same place in the tree the whole time. Swapping between two different
  // return statements would unmount and remount it on every toggle,
  // resetting its zoom/pan/selection state right when a seamless resize is
  // the entire point.
  return (
    <main className={`main main-map${isFullscreen ? " main-map-fullscreen" : ""}`}>
      <div className={`map-page-shell${tab === "map" ? " map-page-shell-map" : ""}`}>
        <div className={`map-page-header${isFullscreen ? " map-page-header-hidden" : ""}`}>
          <div>
            <p className="eyebrow">
              <MapIcon size={14} strokeWidth={2} /> Map
            </p>
            <h2>Map, Gate &amp; Intel Check</h2>
            <p className="wh-page-subtitle">
              A searchable map of New Eden with live kill activity, plus gate-camp checking and local/D-Scan intel
              tools, so you can see where the action is and plan routes around it.
            </p>
          </div>
        </div>

        <PageTabBar
          pageId="map"
          tabs={TABS}
          activeTab={tab}
          onSelect={(id) => setTab(id as MapTab)}
          className={`map-page-tabs${isFullscreen ? " map-page-tabs-hidden" : ""}`}
        />

        {tab === "map" ? (
          <MapView
            onSelectKill={onSelectKill}
            onSelectSystem={onSelectSystem}
            characters={characters}
            onSendRouteToGateCheck={(systems) => {
              setPendingGateCheckWaypoints(systems);
              setTab("gatecheck");
            }}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen((v) => !v)}
          />
        ) : tab === "gatecheck" ? (
          <GateCheck
            onSelectSystem={onSelectSystem}
            onSelectGate={onSelectGate}
            initialWaypoints={pendingGateCheckWaypoints}
            onConsumeInitialWaypoints={() => setPendingGateCheckWaypoints(null)}
          />
        ) : tab === "likelycamps" ? (
          <LikelyGateCamps onSelectGate={onSelectGate} />
        ) : tab === "localthreat" ? (
          <LocalThreatCheck onSelectCharacter={onSelectCharacter} />
        ) : tab === "dscan" ? (
          <DScanCheck />
        ) : (
          <RegionMapTab />
        )}
      </div>
    </main>
  );
}

export default MapPage;
