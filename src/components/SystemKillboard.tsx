import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getSystemKillsHistory } from "../lib/kills";
import { getMapData, type MapData } from "../lib/map";
import { usePaginatedKillFeed } from "../hooks/usePaginatedKillFeed";
import { securityColor, formatSecurity } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import { Pager, PAGE_SIZE } from "./killboardShared";
import BackToMapButton from "./BackToMapButton";
import TrackToggleButton from "./TrackToggleButton";
import type { ConstellationSummary } from "./ConstellationKillboard";
import type { RegionSummary } from "./RegionKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

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
  onSelectConstellation: (constellation: ConstellationSummary) => void;
  onSelectRegion: (region: RegionSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
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
  onSelectConstellation,
  onSelectRegion,
  onSelectCorporation,
  onSelectAlliance,
  rootLabel,
  onGoHome,
  onGoToMap,
}: SystemKillboardProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [page, setPage] = useState(1);

  const { items: kills, exhausted, ensureLoadedThrough } = usePaginatedKillFeed(
    (p) => getSystemKillsHistory(system.id, p),
    system.id,
  );

  useEffect(() => {
    setPage(1);
  }, [system.id]);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
  }, []);

  const pagedKills = (kills ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil((kills ?? []).length / PAGE_SIZE) + (exhausted ? 0 : 1));

  async function changePage(p: number) {
    await ensureLoadedThrough(p * PAGE_SIZE);
    setPage(p);
  }

  const mapSystem = mapData?.systems.find((s) => s.id === system.id);
  const constellation = mapSystem ? mapData?.constellations.find((c) => c.id === mapSystem.constellation_id) : undefined;
  const region = constellation ? mapData?.regions.find((r) => r.id === constellation.region_id) : undefined;

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
          <div className="kills-header-title-row">
            <h2>
              <span className="kills-security" style={{ color: securityColor(system.security) }}>
                {formatSecurity(system.security)}
              </span>{" "}
              {system.name}
            </h2>
            <TrackToggleButton entry={{ type: "system", id: system.id, name: system.name, security: system.security, systemIds: [system.id] }} />
          </div>
          <div className="kills-header-links">
            {constellation && (
              <button
                type="button"
                className="kills-header-link"
                onClick={() =>
                  onSelectConstellation({
                    id: constellation.id,
                    name: constellation.name,
                    regionId: constellation.region_id,
                    regionName: region?.name ?? system.regionName,
                  })
                }
              >
                Constellation: {constellation.name}
              </button>
            )}
            {(region || system.regionName) && (
              <button
                type="button"
                className="kills-header-link"
                onClick={() => region && onSelectRegion({ id: region.id, name: region.name })}
                disabled={!region}
              >
                Region: {region?.name ?? system.regionName}
              </button>
            )}
          </div>
        </div>

        <div className="kills-feed">
          {kills === null ? (
            <p className="detail-empty">Loading kills...</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills recorded for this system.</p>
          ) : (
            <>
              <KillFeedTable
                kills={pagedKills}
                onSelectKill={onSelectKill}
                onSelectCharacter={onSelectCharacter}
                onSelectSystem={onSelectSystem}
                onSelectCorporation={onSelectCorporation}
                onSelectAlliance={onSelectAlliance}
              />
              <Pager page={page} pageCount={pageCount} onChange={changePage} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export default SystemKillboard;
