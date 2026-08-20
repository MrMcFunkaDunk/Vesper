import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getSystemDetail, type CelestialInfo, type StationInfo, type SystemDetail } from "../lib/map";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityColor, formatSecurity } from "../lib/format";
import ActivityGraphs from "./ActivityGraphs";

type StatsTab = "overview" | "celestials" | "locations";

const TABS: { id: StatsTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "celestials", label: "Celestials" },
  { id: "locations", label: "Locations" },
];

interface SystemStatsPanelProps {
  systemId: number;
  onClose: () => void;
}

/**
 * A DOTLAN-style system detail popup: region/constellation facts, live
 * jump/kill snapshots from ESI, the celestial tree, and nearest 0.0/lowsec.
 * Deliberately has no Kills tab - that's already the System Killboard page,
 * no need to rebuild it here.
 */
function SystemStatsPanel({ systemId, onClose }: SystemStatsPanelProps) {
  const [detail, setDetail] = useState<SystemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StatsTab>("overview");
  const reportError = useErrorReporter();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setTab("overview");
    getSystemDetail(systemId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => reportError(`Failed to load system detail: ${String(err)}`))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [systemId]);

  return (
    <div className="system-stats-backdrop" onClick={onClose}>
      <div className="system-stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="system-stats-header">
          <div>
            <h3>{detail?.name ?? "Loading..."}</h3>
            {detail && (
              <p className="system-stats-subtitle">
                <span className="kills-security" style={{ color: securityColor(detail.security) }}>
                  {formatSecurity(detail.security)}
                </span>
                {detail.constellation_name} / {detail.region_name}
              </p>
            )}
          </div>
          <button type="button" className="system-stats-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {loading || !detail ? (
          <p className="detail-empty">Loading system detail...</p>
        ) : (
          <>
            <div className="system-stats-tabs kills-tabs">
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

            <div className="system-stats-body">
              {tab === "overview" && <OverviewTab detail={detail} />}
              {tab === "celestials" && <CelestialsTab detail={detail} />}
              {tab === "locations" && <LocationsTab detail={detail} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OverviewTab({ detail }: { detail: SystemDetail }) {
  return (
    <div className="system-stats-overview">
      <div className="system-stats-grid">
        <div className="system-stats-row">
          <span>Region</span>
          <span>{detail.region_name}</span>
        </div>
        <div className="system-stats-row">
          <span>Constellation</span>
          <span>{detail.constellation_name}</span>
        </div>
        <div className="system-stats-row">
          <span>Planets</span>
          <span>{detail.planet_count}</span>
        </div>
        <div className="system-stats-row">
          <span>Moons</span>
          <span>{detail.moon_count}</span>
        </div>
        <div className="system-stats-row">
          <span>Stations</span>
          <span>{detail.stations.length}</span>
        </div>
      </div>
      <div className="system-stats-live-grid">
        <div className="system-stats-card">
          <span className="system-stats-card-value">{detail.ship_jumps_1h}</span>
          <span className="system-stats-card-label">Ship Jumps</span>
          <span className="system-stats-card-sublabel">last hour</span>
        </div>
        <div className="system-stats-card system-stats-card-danger">
          <span className="system-stats-card-value">{detail.ship_kills_1h}</span>
          <span className="system-stats-card-label">Ship Kills</span>
          <span className="system-stats-card-sublabel">last hour</span>
        </div>
        <div className="system-stats-card">
          <span className="system-stats-card-value">{detail.npc_kills_1h}</span>
          <span className="system-stats-card-label">NPC Kills</span>
          <span className="system-stats-card-sublabel">last hour</span>
        </div>
        <div className="system-stats-card system-stats-card-danger">
          <span className="system-stats-card-value">{detail.pod_kills_1h}</span>
          <span className="system-stats-card-label">Pod Kills</span>
          <span className="system-stats-card-sublabel">last hour</span>
        </div>
      </div>

      <p className="system-stats-service-title system-stats-service-subheading">Last 48 Hours</p>
      <ActivityGraphs systemId={detail.id} />
    </div>
  );
}

function CelestialsTab({ detail }: { detail: SystemDetail }) {
  const planets = detail.celestials.filter((c) => c.kind === "Planet");
  const childrenByOrbit = new Map<number, CelestialInfo[]>();
  for (const c of detail.celestials) {
    if ((c.kind === "Moon" || c.kind === "Asteroid Belt") && c.orbit_id != null) {
      const list = childrenByOrbit.get(c.orbit_id) ?? [];
      list.push(c);
      childrenByOrbit.set(c.orbit_id, list);
    }
  }
  const stargates = detail.celestials.filter((c) => c.kind === "Stargate");

  if (planets.length === 0 && stargates.length === 0) {
    return <p className="detail-empty">No celestial data available for this system.</p>;
  }

  return (
    <div className="system-stats-celestials">
      {planets.map((planet) => (
        <div key={planet.id} className="system-stats-planet">
          <p className="system-stats-planet-name">{planet.name}</p>
          {(childrenByOrbit.get(planet.id) ?? []).map((child) => (
            <div key={child.id} className="system-stats-celestial-row system-stats-celestial-nested">
              <span>{child.name}</span>
              <span className="system-stats-celestial-kind">{child.kind}</span>
            </div>
          ))}
        </div>
      ))}
      {stargates.length > 0 && (
        <div className="system-stats-planet">
          <p className="system-stats-planet-name">Stargates</p>
          {stargates.map((gate) => (
            <div key={gate.id} className="system-stats-celestial-row system-stats-celestial-nested">
              <span>{gate.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LocationsTab({ detail }: { detail: SystemDetail }) {
  const serviceGroups = new Map<string, StationInfo[]>();
  for (const station of detail.stations) {
    for (const service of station.services) {
      const list = serviceGroups.get(service) ?? [];
      list.push(station);
      serviceGroups.set(service, list);
    }
  }

  return (
    <div className="system-stats-locations">
      <div className="system-stats-nearest">
        <div className="system-stats-row">
          <span>Nearest 0.0</span>
          <span>
            {detail.nearest_nullsec
              ? `${detail.nearest_nullsec.name} (${detail.nearest_nullsec.jumps} jump${detail.nearest_nullsec.jumps === 1 ? "" : "s"})`
              : "Unknown"}
          </span>
        </div>
        <div className="system-stats-row">
          <span>Nearest Lowsec</span>
          <span>
            {detail.nearest_lowsec
              ? `${detail.nearest_lowsec.name} (${detail.nearest_lowsec.jumps} jump${detail.nearest_lowsec.jumps === 1 ? "" : "s"})`
              : "Unknown"}
          </span>
        </div>
      </div>

      <div className="system-stats-service-group">
        <p className="system-stats-service-title">NPC Stations</p>
        {detail.stations.length === 0 ? (
          <p className="detail-empty">No NPC stations in this system.</p>
        ) : (
          detail.stations.map((station) => (
            <div key={station.id} className="system-stats-celestial-row">
              <span>{station.name}</span>
            </div>
          ))
        )}
      </div>

      <div className="system-stats-service-group">
        <p className="system-stats-service-title">Player Structures</p>
        {detail.player_structures.length === 0 ? (
          <p className="detail-empty">No known player-owned structures in this system.</p>
        ) : (
          detail.player_structures.map((structure) => {
            const ownerLabel = structure.owner_corporation_name
              ? `[${structure.owner_corporation_ticker ?? "?"}] ${structure.owner_corporation_name}`
              : null;
            const allianceLabel = structure.owner_alliance_name
              ? `[${structure.owner_alliance_ticker ?? "?"}] ${structure.owner_alliance_name}`
              : null;
            return (
              <div key={structure.id} className="system-stats-celestial-row">
                <span>{structure.name}</span>
                {ownerLabel && (
                  <span className="system-stats-celestial-kind">
                    {ownerLabel}
                    {allianceLabel ? ` · ${allianceLabel}` : ""}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {serviceGroups.size > 0 && (
        <>
          <p className="system-stats-service-title system-stats-service-subheading">Station Services</p>
          {[...serviceGroups.entries()].map(([service, stations]) => (
            <div key={service} className="system-stats-service-group">
              <p className="system-stats-service-title">Station(s) with {service}</p>
              {stations.map((station) => (
                <div key={station.id} className="system-stats-celestial-row">
                  <span>{station.name}</span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default SystemStatsPanel;
