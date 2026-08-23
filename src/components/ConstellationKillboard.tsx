import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { getConstellationKillsHistory } from "../lib/kills";
import { getMapData, type MapData } from "../lib/map";
import { usePaginatedKillFeed } from "../hooks/usePaginatedKillFeed";
import KillFeedTable from "./KillFeedTable";
import { Pager, PAGE_SIZE } from "./killboardShared";
import BackToMapButton from "./BackToMapButton";
import TrackToggleButton from "./TrackToggleButton";
import type { SystemSummary } from "./SystemKillboard";
import type { RegionSummary } from "./RegionKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

export interface ConstellationSummary {
  id: number;
  name: string;
  regionId: number;
  regionName: string | null;
}

interface ConstellationKillboardProps {
  constellation: ConstellationSummary;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectRegion: (region: RegionSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  breadcrumb: ReactNode;
  onGoToMap: () => void;
}

function ConstellationKillboard({
  constellation,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectRegion,
  onSelectCorporation,
  onSelectAlliance,
  breadcrumb,
  onGoToMap,
}: ConstellationKillboardProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [page, setPage] = useState(1);

  const { items: kills, exhausted, ensureLoadedThrough } = usePaginatedKillFeed(
    (p) => getConstellationKillsHistory(constellation.id, p),
    constellation.id,
  );

  useEffect(() => {
    setPage(1);
  }, [constellation.id]);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
  }, []);

  const pagedKills = (kills ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil((kills ?? []).length / PAGE_SIZE) + (exhausted ? 0 : 1));

  async function changePage(p: number) {
    await ensureLoadedThrough(p * PAGE_SIZE);
    setPage(p);
  }

  const memberSystems = (mapData?.systems ?? [])
    .filter((s) => s.constellation_id === constellation.id)
    .sort((a, b) => a.name.localeCompare(b.name));

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
          <p className="eyebrow">Constellation</p>
          <div className="kills-header-title-row">
            <h2>{constellation.name}</h2>
            <TrackToggleButton
              entry={{
                type: "constellation",
                id: constellation.id,
                name: constellation.name,
                systemIds: memberSystems.map((s) => s.id),
              }}
            />
          </div>

          {memberSystems.length > 0 && (
            <p className="kills-header-member-list">
              <span className="kills-header-member-label">Systems:</span>{" "}
              {memberSystems.map((s, i) => (
                <span key={s.id}>
                  <button
                    type="button"
                    className="kills-header-link-inline"
                    onClick={() => onSelectSystem({ id: s.id, name: s.name, security: s.security, regionName: constellation.regionName })}
                  >
                    {s.name}
                  </button>
                  {i < memberSystems.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          )}

          <div className="kills-header-links">
            <button type="button" className="kills-header-link" onClick={() => onSelectRegion({ id: constellation.regionId, name: constellation.regionName ?? `Region #${constellation.regionId}` })}>
              Region: {constellation.regionName ?? `Region #${constellation.regionId}`}
            </button>
          </div>
        </div>

        <div className="kills-feed">
          {kills === null ? (
            <p className="detail-empty">Loading kills...</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills recorded for this constellation.</p>
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

export default ConstellationKillboard;
