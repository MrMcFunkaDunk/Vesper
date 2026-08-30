import { useState } from "react";
import MapView from "./MapView";
import GateCheck from "./GateCheck";
import LikelyGateCamps from "./LikelyGateCamps";
import type { SystemSummary } from "./SystemKillboard";
import type { GateSummary } from "./GateKillboard";
import type { SessionCharacter } from "../lib/eve";

type MapTab = "map" | "gatecheck" | "likelycamps";

const TABS: { id: MapTab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "gatecheck", label: "Gate Check" },
  { id: "likelycamps", label: "Likely Gate Camps" },
];

interface MapPageProps {
  onSelectKill: (killmailId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectGate: (gate: GateSummary) => void;
  characters: SessionCharacter[];
}

function MapPage({ onSelectKill, onSelectSystem, onSelectGate, characters }: MapPageProps) {
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
          <MapView onSelectKill={onSelectKill} onSelectSystem={onSelectSystem} characters={characters} />
        ) : tab === "gatecheck" ? (
          <GateCheck onSelectSystem={onSelectSystem} onSelectGate={onSelectGate} />
        ) : (
          <LikelyGateCamps onSelectGate={onSelectGate} />
        )}
      </div>
    </main>
  );
}

export default MapPage;
