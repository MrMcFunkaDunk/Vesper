import { useState } from "react";
import MapView from "./MapView";
import GateCheck from "./GateCheck";
import LikelyGateCamps from "./LikelyGateCamps";
import LocalThreatCheck from "./LocalThreatCheck";
import DScanCheck from "./DScanCheck";
import type { SystemSummary } from "./SystemKillboard";
import type { GateSummary } from "./GateKillboard";
import type { SessionCharacter } from "../lib/eve";

type MapTab = "map" | "gatecheck" | "likelycamps" | "localthreat" | "dscan";

const TABS: { id: MapTab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "gatecheck", label: "Gate Check" },
  { id: "likelycamps", label: "Likely Gate Camps" },
  { id: "localthreat", label: "Local Threat" },
  { id: "dscan", label: "D-Scan" },
];

interface MapPageProps {
  onSelectKill: (killmailId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectGate: (gate: GateSummary) => void;
  onSelectCharacter: (characterId: number) => void;
  characters: SessionCharacter[];
}

function MapPage({ onSelectKill, onSelectSystem, onSelectGate, onSelectCharacter, characters }: MapPageProps) {
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
        ) : tab === "likelycamps" ? (
          <LikelyGateCamps onSelectGate={onSelectGate} />
        ) : tab === "localthreat" ? (
          <LocalThreatCheck onSelectCharacter={onSelectCharacter} />
        ) : (
          <DScanCheck />
        )}
      </div>
    </main>
  );
}

export default MapPage;
