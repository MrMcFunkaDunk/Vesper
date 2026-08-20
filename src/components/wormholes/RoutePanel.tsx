import { useEffect, useRef, useState } from "react";
import { Navigation, X, LocateFixed, Pin } from "lucide-react";
import { findChainRoute, type RouteStep } from "../../lib/wormholes";
import { searchSystemsLive, regionLabelWithHub, regionHubColor, type SystemSearchMatch } from "../../lib/map";
import { useErrorReporter } from "../../hooks/useErrorReporter";

interface RoutePanelProps {
  chainId: string;
  originSystemId: number | null;
  originSystemName: string | null;
  /** Whether originSystemId is currently the character's live location
   * (vs. the chain's manually-flagged origin system, or nothing). Drives
   * the follow-toggle button's label/icon - the toggle itself lives in the
   * parent since it also affects whether the canvas highlights the manual
   * origin star. */
  isFollowingLive: boolean;
  onToggleFollow: () => void;
  onSelectWormholeHop: (connectionId: string) => void;
  onClose: () => void;
  /** A destination handed in from outside (e.g. "Route Here" on a Scout
   * connection) rather than picked from this panel's own search box. */
  pendingDestination?: { id: number; name: string } | null;
  onConsumePendingDestination?: () => void;
}

const TRADE_HUB_SYSTEMS: { systemId: number; name: string; regionName: string }[] = [
  { systemId: 30000142, name: "Jita", regionName: "The Forge" },
  { systemId: 30002187, name: "Amarr", regionName: "Domain" },
  { systemId: 30002659, name: "Dodixie", regionName: "Sinq Laison" },
  { systemId: 30002510, name: "Rens", regionName: "Heimatar" },
  { systemId: 30002053, name: "Hek", regionName: "Metropolis" },
];

function RoutePanel({
  chainId,
  originSystemId,
  originSystemName,
  isFollowingLive,
  onToggleFollow,
  onSelectWormholeHop,
  onClose,
  pendingDestination,
  onConsumePendingDestination,
}: RoutePanelProps) {
  const [destQuery, setDestQuery] = useState("");
  const [destResults, setDestResults] = useState<SystemSearchMatch[]>([]);
  const [destOpen, setDestOpen] = useState(false);
  const [destination, setDestination] = useState<{ id: number; name: string } | null>(null);
  const [steps, setSteps] = useState<RouteStep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const reportError = useErrorReporter();
  const lastOriginRef = useRef<number | null>(originSystemId);

  useEffect(() => {
    const trimmed = destQuery.trim();
    if (trimmed.length < 2) {
      setDestResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSystemsLive(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setDestResults(matches);
            setDestOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setDestResults([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destQuery]);

  // Re-runs the last-viewed route whenever the origin genuinely changes -
  // this is what makes following live location feel like "auto-pathing"
  // rather than a one-shot snapshot that goes stale the moment the
  // character actually jumps. Guarded against the poll ticking every 10s
  // with the same system (which shouldn't trigger a re-fetch).
  useEffect(() => {
    if (lastOriginRef.current === originSystemId) return;
    lastOriginRef.current = originSystemId;
    if (originSystemId != null && destination) {
      runRoute(destination.id, destination.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originSystemId]);

  // Handed in from outside (Scout panel's "Route Here") - runs once per
  // hand-off, then consumed so re-opening this panel later doesn't replay it.
  useEffect(() => {
    if (!pendingDestination) return;
    runRoute(pendingDestination.id, pendingDestination.name);
    onConsumePendingDestination?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDestination]);

  async function runRoute(destinationId: number, destinationName: string) {
    if (originSystemId == null) {
      reportError("Mark a system as this chain's origin first (select it on the map, then \"Set as Origin\").");
      return;
    }
    setDestination({ id: destinationId, name: destinationName });
    setDestOpen(false);
    setDestQuery("");
    setLoading(true);
    setSteps(null);
    try {
      const result = await findChainRoute(chainId, originSystemId, destinationId);
      setSteps(result);
    } catch (err) {
      reportError(`Failed to find a route: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  const wormholeHops = steps ? steps.filter((s) => s.via?.kind === "wormhole").length : 0;

  return (
    <div className="wh-route-panel">
      <div className="wh-route-header">
        <p className="wh-side-label">
          <Navigation size={13} strokeWidth={2} /> Route From {originSystemName ?? "Origin"}
        </p>
        <div className="wh-route-header-actions">
          <button
            type="button"
            className={`wh-route-follow-btn${isFollowingLive ? " wh-route-follow-btn-active" : ""}`}
            onClick={onToggleFollow}
            title={isFollowingLive ? "Following your live location - click to pin to the manual origin instead" : "Click to follow your live location"}
          >
            {isFollowingLive ? <LocateFixed size={13} strokeWidth={2} /> : <Pin size={13} strokeWidth={2} />}
            {isFollowingLive ? "Following You" : "Pinned"}
          </button>
          <button type="button" className="wh-route-close" onClick={onClose} title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="kills-add-combobox">
        <input
          type="text"
          placeholder="Route to a system..."
          value={destQuery}
          onChange={(e) => setDestQuery(e.target.value)}
          onFocus={() => destResults.length > 0 && setDestOpen(true)}
          onBlur={() => setTimeout(() => setDestOpen(false), 120)}
        />
        {destOpen && (
          <div className="gatecheck-slot-results kills-add-suggestions">
            {destResults.map((s) => (
              <button key={s.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runRoute(s.id, s.name)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="wh-route-hub-row">
        {TRADE_HUB_SYSTEMS.map((hub) => (
          <button
            key={hub.systemId}
            type="button"
            className="wh-route-hub-btn"
            style={{ color: regionHubColor(hub.regionName) }}
            onClick={() => runRoute(hub.systemId, hub.name)}
            title={regionLabelWithHub(hub.regionName)}
          >
            {hub.name}
          </button>
        ))}
      </div>

      {loading && <p className="detail-empty wh-route-loading">Finding route...</p>}

      {!loading && steps && destination && (
        <div className="wh-route-result">
          <p className="wh-route-summary">
            {steps.length - 1} jump{steps.length - 1 === 1 ? "" : "s"} to {destination.name}
            {wormholeHops > 0 && ` · ${wormholeHops} via wormhole`}
          </p>
          <div className="wh-route-steps">
            {steps.map((step, i) => (
              <div key={`${step.system_id}-${i}`} className="wh-route-step">
                {step.via && (
                  <span className={`wh-route-hop wh-route-hop-${step.via.kind}`}>{step.via.kind === "wormhole" ? "WH" : "Gate"}</span>
                )}
                <button
                  type="button"
                  className="wh-route-step-name"
                  disabled={step.via?.kind !== "wormhole"}
                  onClick={() => step.via?.connection_id && onSelectWormholeHop(step.via.connection_id)}
                >
                  {step.system_name}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default RoutePanel;
