import { useEffect, useState } from "react";
import MapView from "./MapView";
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

  return (
    <main className="main main-map">
      <div className="map-page-shell">
        <PageTabBar pageId="map" tabs={TABS} activeTab={tab} onSelect={(id) => setTab(id as MapTab)} className="map-page-tabs" />

        {tab === "map" ? (
          <MapView onSelectKill={onSelectKill} onSelectSystem={onSelectSystem} characters={characters} />
        ) : tab === "gatecheck" ? (
          <GateCheck onSelectSystem={onSelectSystem} onSelectGate={onSelectGate} />
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
