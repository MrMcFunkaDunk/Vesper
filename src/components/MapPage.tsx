import { useState } from "react";
import MapView from "./MapView";
import GateCheck from "./GateCheck";
import type { SystemSummary } from "./SystemKillboard";

type MapTab = "map" | "gatecheck";

const TABS: { id: MapTab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "gatecheck", label: "Gate Check" },
];

interface MapPageProps {
  onSelectKill: (killmailId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
}

function MapPage({ onSelectKill, onSelectSystem }: MapPageProps) {
  const [tab, setTab] = useState<MapTab>("map");

  return (
    <main className="main main-map">
      <div className="map-page-shell">
        <div className="map-page-tabs kills-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`kills-tab ${tab === t.id ? "kills-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "map" ? (
          <MapView onSelectKill={onSelectKill} onSelectSystem={onSelectSystem} />
        ) : (
          <GateCheck onSelectSystem={onSelectSystem} />
        )}
      </div>
    </main>
  );
}

export default MapPage;
