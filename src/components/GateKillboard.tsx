import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { getLocationKills, type KillEntry } from "../lib/kills";
import KillFeedTable from "./KillFeedTable";
import BackToMapButton from "./BackToMapButton";
import TrackToggleButton from "./TrackToggleButton";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

export interface GateSummary {
  /** The gate's own ESI stargate id - same id space as zkb's locationID and TrackedEntry's "gate" type. */
  id: number;
  /** Display name only, e.g. "Nourvukaiken" - not the full "Stargate (X)" wrapper. */
  name: string;
  systemId: number;
  systemName: string;
}

interface GateKillboardProps {
  gate: GateSummary;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  breadcrumb: ReactNode;
  onGoToMap: () => void;
}

/** A single gate's own killboard - kills within the gate-camp attribution
 * radius of one specific stargate (see route.rs's GATE_PROXIMITY_METERS),
 * the in-app equivalent of zKillboard's own /location/{id}/ page. Not
 * paginated like System/Region's killboards - a single gate's traffic
 * doesn't run deep enough to need it, so this just shows whatever
 * get_location_kills' single capped fetch returns. */
function GateKillboard({
  gate,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  breadcrumb,
  onGoToMap,
}: GateKillboardProps) {
  const [kills, setKills] = useState<KillEntry[] | null>(null);

  useEffect(() => {
    let active = true;
    setKills(null);
    getLocationKills(gate.id)
      .then((result) => {
        if (active) setKills(result);
      })
      .catch(() => {
        if (active) setKills([]);
      });
    return () => {
      active = false;
    };
  }, [gate.id]);

  return (
    <main className="main main-kills">
      <div className="kills-page">
        {breadcrumb}

        <div className="kills-nav-buttons">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          <BackToMapButton onClick={onGoToMap} />
        </div>

        <div className="kills-header">
          <p className="eyebrow">Gate</p>
          <div className="kills-header-title-row">
            <h2>Stargate ({gate.name})</h2>
            <TrackToggleButton entry={{ type: "gate", id: gate.id, name: gate.name, systemIds: [gate.systemId] }} />
          </div>
          <p className="kills-header-member-list">
            <span className="kills-header-member-label">System:</span>{" "}
            <button
              type="button"
              className="kills-header-link-inline"
              onClick={() => onSelectSystem({ id: gate.systemId, name: gate.systemName, security: 0, regionName: null })}
            >
              {gate.systemName}
            </button>
          </p>
        </div>

        <div className="kills-feed">
          {kills === null ? (
            <p className="detail-empty">Loading kills...</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills recorded at this gate.</p>
          ) : (
            <KillFeedTable
              kills={kills}
              onSelectKill={onSelectKill}
              onSelectCharacter={onSelectCharacter}
              onSelectSystem={onSelectSystem}
              onSelectCorporation={onSelectCorporation}
              onSelectAlliance={onSelectAlliance}
            />
          )}
        </div>
      </div>
    </main>
  );
}

export default GateKillboard;
