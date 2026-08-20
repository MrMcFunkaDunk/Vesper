import { useEffect, useState } from "react";
import { Telescope, X, RefreshCw, Navigation } from "lucide-react";
import { getScoutConnections, type ScoutConnection } from "../../lib/scout";
import { WORMHOLE_TYPES } from "../../lib/wormholeTypes";
import { useErrorReporter } from "../../hooks/useErrorReporter";
import type { SystemSummary } from "../SystemKillboard";

interface ScoutConnectionsPanelProps {
  onSelectSystem: (system: SystemSummary) => void;
  onRouteTo: (systemId: number, systemName: string) => void;
  onClose: () => void;
}

type ScoutSource = "Thera" | "Turnur";

function classBadgeClass(inSystemClass: string): string {
  const c = inSystemClass.toLowerCase();
  if (c === "hs") return "wh-scout-class-hs";
  if (c === "ls") return "wh-scout-class-ls";
  if (c === "ns") return "wh-scout-class-ns";
  return "wh-scout-class-wh";
}

function remainingClass(hours: number): string {
  if (hours < 2) return "wh-scout-remaining-critical";
  if (hours < 8) return "wh-scout-remaining-aging";
  return "wh-scout-remaining-fresh";
}

function ScoutConnectionsPanel({ onSelectSystem, onRouteTo, onClose }: ScoutConnectionsPanelProps) {
  const [source, setSource] = useState<ScoutSource>("Thera");
  const [connections, setConnections] = useState<ScoutConnection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const reportError = useErrorReporter();

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function load() {
    setLoading(true);
    try {
      const result = await getScoutConnections(source);
      result.sort((a, b) => b.remaining_hours - a.remaining_hours);
      setConnections(result);
    } catch (err) {
      reportError(`Failed to load ${source} connections from EvE-Scout: ${String(err)}`);
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }

  const trimmed = filterQuery.trim().toLowerCase();
  const filtered = connections
    ? connections.filter(
        (c) => !trimmed || c.in_system_name.toLowerCase().includes(trimmed) || c.in_region_name.toLowerCase().includes(trimmed),
      )
    : [];

  return (
    <div className="wh-route-panel">
      <div className="wh-route-header">
        <p className="wh-side-label">
          <Telescope size={13} strokeWidth={2} /> Scout Connections
        </p>
        <div className="wh-route-header-actions">
          <button type="button" className="wh-route-follow-btn" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw size={13} strokeWidth={2} />
          </button>
          <button type="button" className="wh-route-close" onClick={onClose} title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="character-tabs wh-scout-source-tabs">
        <button type="button" className={`character-tab${source === "Thera" ? " character-tab-active" : ""}`} onClick={() => setSource("Thera")}>
          Thera
        </button>
        <button type="button" className={`character-tab${source === "Turnur" ? " character-tab-active" : ""}`} onClick={() => setSource("Turnur")}>
          Turnur
        </button>
      </div>

      <div className="kills-add-combobox">
        <input
          type="text"
          placeholder="Filter by destination system or region..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
      </div>

      {loading && <p className="detail-empty wh-route-loading">Loading {source} connections...</p>}

      {!loading && connections && connections.length === 0 && (
        <p className="detail-empty">No confirmed {source} connections right now.</p>
      )}

      {!loading && filtered.length > 0 && (
        <p className="wh-scout-count">
          {filtered.length} connection{filtered.length === 1 ? "" : "s"}
        </p>
      )}

      <div className="wh-scout-list">
        {filtered.map((c) => {
          const known = WORMHOLE_TYPES.find((w) => w.code === c.wh_type);
          return (
            <div key={c.id} className="wh-scout-row">
              <div className="wh-scout-row-header">
                <span className="wh-scout-system-name">{c.in_system_name}</span>
                <span className={`wh-scout-class-badge ${classBadgeClass(c.in_system_class)}`}>{c.in_system_class.toUpperCase()}</span>
                <span className={`wh-scout-remaining ${remainingClass(c.remaining_hours)}`}>{c.remaining_hours}h left</span>
              </div>
              <p className="wh-scout-region">{c.in_region_name}</p>
              <p className="wh-scout-meta">
                {c.wh_type} · Max {c.max_ship_size}
                {known?.lifetimeHours != null && ` · ~${known.lifetimeHours}h lifetime`}
                {known?.maxMassKg != null && ` · ${(known.maxMassKg / 1_000_000_000).toFixed(1)}B kg total`}
              </p>
              <div className="wh-scout-row-actions">
                <button
                  type="button"
                  className="wh-link-btn"
                  onClick={() => onSelectSystem({ id: c.in_system_id, name: c.in_system_name, security: 0, regionName: c.in_region_name })}
                >
                  View Killboard
                </button>
                <button type="button" className="wh-link-btn" onClick={() => onRouteTo(c.in_system_id, c.in_system_name)}>
                  <Navigation size={11} strokeWidth={2} /> Route Here
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ScoutConnectionsPanel;
