import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { getRegionKillsHistory } from "../lib/kills";
import { getMapData, type MapData } from "../lib/map";
import { usePaginatedKillFeed } from "../hooks/usePaginatedKillFeed";
import KillFeedTable from "./KillFeedTable";
import { Pager, PAGE_SIZE } from "./killboardShared";
import BackToMapButton from "./BackToMapButton";
import TrackToggleButton from "./TrackToggleButton";
import type { SystemSummary } from "./SystemKillboard";
import type { ConstellationSummary } from "./ConstellationKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

export interface RegionSummary {
  id: number;
  name: string;
}

interface RegionKillboardProps {
  region: RegionSummary;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectConstellation: (constellation: ConstellationSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  breadcrumb: ReactNode;
  onGoToMap: () => void;
}

function RegionKillboard({
  region,
  onBack,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectConstellation,
  onSelectCorporation,
  onSelectAlliance,
  breadcrumb,
  onGoToMap,
}: RegionKillboardProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [page, setPage] = useState(1);

  const { items: kills, exhausted, ensureLoadedThrough } = usePaginatedKillFeed(
    (p) => getRegionKillsHistory(region.id, p),
    region.id,
  );

  useEffect(() => {
    setPage(1);
  }, [region.id]);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
  }, []);

  const pagedKills = (kills ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil((kills ?? []).length / PAGE_SIZE) + (exhausted ? 0 : 1));

  async function changePage(p: number) {
    await ensureLoadedThrough(p * PAGE_SIZE);
    setPage(p);
  }

  const memberConstellations = (mapData?.constellations ?? [])
    .filter((c) => c.region_id === region.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const memberSystemIds = (mapData?.systems ?? []).filter((s) => s.region_id === region.id).map((s) => s.id);

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
          <p className="eyebrow">Region</p>
          <div className="kills-header-title-row">
            <h2>{region.name}</h2>
            <TrackToggleButton entry={{ type: "region", id: region.id, name: region.name, systemIds: memberSystemIds }} />
          </div>

          {memberConstellations.length > 0 && (
            <p className="kills-header-member-list">
              <span className="kills-header-member-label">Constellations:</span>{" "}
              {memberConstellations.map((c, i) => (
                <span key={c.id}>
                  <button
                    type="button"
                    className="kills-header-link-inline"
                    onClick={() => onSelectConstellation({ id: c.id, name: c.name, regionId: region.id, regionName: region.name })}
                  >
                    {c.name}
                  </button>
                  {i < memberConstellations.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="kills-feed">
          {kills === null ? (
            <p className="detail-empty">Loading kills...</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills recorded for this region.</p>
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

export default RegionKillboard;
