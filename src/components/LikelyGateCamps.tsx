import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getLikelyGateCamps, type LikelyGateCamp } from "../lib/route";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityColor, formatSecurity, formatExactTime, formatSecondsAgo } from "../lib/format";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import type { GateSummary } from "./GateKillboard";

interface LikelyGateCampsProps {
  onSelectGate: (gate: GateSummary) => void;
}

function killBand(kills: number): "safe" | "caution" | "danger" {
  if (kills < 2) return "safe";
  if (kills <= 5) return "caution";
  return "danger";
}

/** New Eden-wide "what's likely camped right now" board - the in-app
 * equivalent of eve-gatecheck.space's own "Current (likely) gatecamps"
 * list, sourced entirely from the local kill-history store (see
 * kill_history::get_likely_gate_camps) rather than any external site. */
function LikelyGateCamps({ onSelectGate }: LikelyGateCampsProps) {
  const [camps, setCamps] = useState<LikelyGateCamp[] | null>(null);
  const [loading, setLoading] = useState(false);
  const reportError = useErrorReporter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getLikelyGateCamps();
      setCamps(result);
    } catch (err) {
      reportError(`Failed to load likely gate camps: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    load();
    // Refreshed on the same cadence as GateCheck's own rolling window, so a
    // camp that's dissolved in the last hour drops off here too without
    // needing a manual refresh.
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const sorted = useSortableRows<LikelyGateCamp>(camps ?? [], {
    location: (camp) => camp.origin_system_name,
    kills: (camp) => camp.kills_last_hour,
    last_kill: (camp) => new Date(camp.last_kill_time).getTime(),
  });

  return (
    <div className="gatecheck-page">
      <div className="likely-camps-header">
        <div>
          <h3>Current (likely) gate camps</h3>
          <p className="gatecheck-label">
            Every gate with a recorded kill in the last hour, New Eden-wide, ranked by kill count.
          </p>
        </div>
        <button type="button" className="detail-back" onClick={load} disabled={loading}>
          <RefreshCw size={13} strokeWidth={2} className={loading ? "market-resync-spin" : undefined} />
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {camps === null ? (
        <p className="detail-empty">Loading...</p>
      ) : camps.length === 0 ? (
        <p className="detail-empty">No kills recorded at any gate in the last hour.</p>
      ) : (
        <div className="gatecheck-table-wrap">
          <table className="gatecheck-table">
            <thead>
              <tr>
                <SortableTh
                  label="Location"
                  sortKey="location"
                  activeKey={sorted.sortKey}
                  dir={sorted.sortDir}
                  onSort={(key) => sorted.sort(key, "asc")}
                />
                <SortableTh
                  label="Kills (1h)"
                  sortKey="kills"
                  activeKey={sorted.sortKey}
                  dir={sorted.sortDir}
                  onSort={(key) => sorted.sort(key, "desc")}
                  numeric
                />
                <SortableTh
                  label="Last kill"
                  sortKey="last_kill"
                  activeKey={sorted.sortKey}
                  dir={sorted.sortDir}
                  onSort={(key) => sorted.sort(key, "desc")}
                  numeric
                />
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((camp) => (
                <tr key={camp.gate_location_id} className={`gatecheck-row gatecheck-row-${killBand(camp.kills_last_hour)}`}>
                  <td>
                    {camp.origin_system_name}
                    <span className="kills-security" style={{ color: securityColor(camp.origin_security) }}>
                      {formatSecurity(camp.origin_security)}
                    </span>
                    <span className="likely-camps-arrow">on the</span>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        onSelectGate({
                          id: camp.gate_location_id,
                          name: camp.gate_name,
                          systemId: camp.origin_system_id,
                          systemName: camp.origin_system_name,
                        });
                      }}
                    >
                      {camp.gate_name} gate
                    </a>
                    {camp.destination_security != null && (
                      <span className="kills-security" style={{ color: securityColor(camp.destination_security) }}>
                        {formatSecurity(camp.destination_security)}
                      </span>
                    )}
                  </td>
                  <td>
                    {camp.kills_last_hour} ({camp.pods_last_hour} pod{camp.pods_last_hour === 1 ? "" : "s"})
                  </td>
                  <td>
                    {formatExactTime(camp.last_kill_time)} <span className="likely-camps-last-kill-ago">({formatSecondsAgo(camp.last_kill_time)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default LikelyGateCamps;
