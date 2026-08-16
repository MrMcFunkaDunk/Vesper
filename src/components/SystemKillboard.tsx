import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getRecentKills, type KillEntry } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityBand, formatSecurity } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import BackToMapButton from "./BackToMapButton";

export interface SystemSummary {
  id: number;
  name: string;
  security: number;
  regionName: string | null;
}

interface SystemKillboardProps {
  system: SystemSummary;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  rootLabel: string;
  onGoHome: () => void;
  onGoToMap: () => void;
}

function SystemKillboard({
  system,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  rootLabel,
  onGoHome,
  onGoToMap,
}: SystemKillboardProps) {
  const [kills, setKills] = useState<KillEntry[] | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    setKills(null);
    getRecentKills([system.id])
      .then(setKills)
      .catch((err) => reportError(`Failed to load kills for ${system.name}: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system.id]);

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header kills-header-breadcrumb">
          <p className="eyebrow">Kills & Intel</p>
          <h2
            className="kills-breadcrumb-link"
            role="button"
            tabIndex={0}
            onClick={onGoHome}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onGoHome();
              }
            }}
          >
            {rootLabel}
          </h2>
        </div>

        <div className="kills-nav-buttons">
          <button type="button" className="detail-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          <BackToMapButton onClick={onGoToMap} />
        </div>

        <div className="kills-header">
          <p className="eyebrow">System</p>
          <h2>
            <span className={`kills-security kills-security-${securityBand(system.security)}`}>
              {formatSecurity(system.security)}
            </span>{" "}
            {system.name}
          </h2>
          {system.regionName && <span className="kills-region">{system.regionName}</span>}
        </div>

        <div className="kills-feed">
          {kills === null ? (
            <p className="detail-empty">Loading kills...</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills recorded for this system.</p>
          ) : (
            <KillFeedTable kills={kills} onSelectKill={onSelectKill} onSelectCharacter={onSelectCharacter} onSelectSystem={onSelectSystem} />
          )}
        </div>
      </div>
    </main>
  );
}

export default SystemKillboard;
