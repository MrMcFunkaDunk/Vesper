import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { X, ArrowLeftRight, Star } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getMapData, type MapSystem } from "../lib/map";
import { planGateCheck, getGateActivity, type RoutePreference, type GateCheckSystem, type GateKillEvent } from "../lib/route";
import { getSystemKillHeat } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityColor, formatSecurity } from "../lib/format";
import { useSavedRoutes, type SavedRoute } from "../hooks/useSavedRoutes";
import type { SystemSummary } from "./SystemKillboard";
import type { GateSummary } from "./GateKillboard";

/** Kills older than this don't count as "recent" for a gate's danger rating - same window the map's heat overlay uses. */
const RECENT_WINDOW_MS = 60 * 60 * 1000;

interface Slot {
  key: number;
  query: string;
  system: MapSystem | null;
  results: MapSystem[];
}

function emptySlot(key: number): Slot {
  return { key, query: "", system: null, results: [] };
}

type SlotSetter = Dispatch<SetStateAction<Slot[]>>;

interface GateBreakdown {
  gateName: string;
  gateId: number | null;
  count: number;
}

interface RouteRow extends GateCheckSystem {
  /** Every kill anywhere in the system in the last hour, regardless of
   * whether it happened near a gate - so a system that's simply a busy
   * fight elsewhere (not a gate camp) still reads as "something's
   * happening here" instead of a misleadingly clear 0. */
  totalSystemKills: number;
  totalGateKills: number;
  gates: GateBreakdown[];
  smartbomb: boolean;
  interdictor: boolean;
  capital: boolean;
  citadel: boolean;
  mobileBubble: boolean;
}

const HAS_THREAT_FLAG = (row: RouteRow) => row.smartbomb || row.interdictor || row.capital || row.citadel || row.mobileBubble;

function killBand(row: RouteRow): "safe" | "caution" | "danger" {
  if (HAS_THREAT_FLAG(row)) return "danger";
  if (row.totalGateKills <= 0) return "safe";
  if (row.totalGateKills <= 2) return "caution";
  return "danger";
}

/** The Info column's threat-flag lines - the per-gate kill-count lines are
 * rendered separately (see the table body below) since those need to be
 * clickable, not plain text. */
function threatLines(row: RouteRow): string[] {
  const lines: string[] = [];
  if (row.smartbomb) lines.push("Smartbombs used.");
  if (row.interdictor) lines.push("HICs/dictors used.");
  if (row.mobileBubble) lines.push("Mobile bubbles used.");
  if (row.capital) lines.push("Capitals used.");
  if (row.citadel) lines.push("Citadels used.");
  return lines;
}

function dotlanName(name: string): string {
  return name.replace(/ /g, "_");
}

interface GateCheckProps {
  onSelectSystem: (system: SystemSummary) => void;
  onSelectGate: (gate: GateSummary) => void;
}

function GateCheck({ onSelectSystem, onSelectGate }: GateCheckProps) {
  const [mapSystems, setMapSystems] = useState<MapSystem[]>([]);
  const [waypoints, setWaypoints] = useState<Slot[]>([emptySlot(0), emptySlot(1)]);
  const [avoids, setAvoids] = useState<Slot[]>([emptySlot(100)]);
  const [preference, setPreference] = useState<RoutePreference>("shortest");
  // Kept as the raw route + unfiltered events, not pre-computed rows - rows
  // are derived below via useMemo against a ticking clock, so a kill that
  // was inside the 1h window at check-time actually drops back out of the
  // count on its own as real time passes, instead of staying "recent"
  // forever until the next manual Check! click.
  const [routeSystems, setRouteSystems] = useState<GateCheckSystem[] | null>(null);
  const [rawEvents, setRawEvents] = useState<GateKillEvent[]>([]);
  /** Whole-system last-hour kill counts, keyed by system_id - the same
   * uncapped local-store aggregate the Map's heat glow uses (getSystemKillHeat),
   * kept separate from the gate-specific totalGateKills below rather than
   * folded into it: a system can be full of activity that never lands
   * within 100km of any of its gates, and that's still worth knowing before
   * jumping through it. */
  const [systemTotals, setSystemTotals] = useState<Map<number, number>>(new Map());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const keyCounterRef = useRef(200);
  const reportError = useErrorReporter();
  const { routes: savedRoutes, addRoute, removeRoute } = useSavedRoutes();
  const [saveNameDraft, setSaveNameDraft] = useState("");

  useEffect(() => {
    getMapData()
      .then((data) => setMapSystems(data.systems))
      .catch((err) => reportError(`Failed to load system list: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadSystemTotals() {
    getSystemKillHeat()
      .then((heat) => setSystemTotals(new Map(heat.map((h) => [h.system_id, h.kill_count]))))
      .catch((err) => reportError(`Failed to load system kill totals: ${String(err)}`));
  }

  // Ticks the clock every 30s so the derived rows below (see the useMemo)
  // re-run and drop any kill that's aged out of the rolling 1h window,
  // without needing another Check! click - a gate that was "3 kills, 1h
  // ago" should read as clear again on its own once that hour's up. Also
  // refreshes the whole-system totals on the same cadence - unlike
  // rawEvents (individual timestamped events the memo below ages out
  // itself), systemTotals is a pre-aggregated count that only goes stale by
  // being re-fetched.
  useEffect(() => {
    loadSystemTotals();
    const interval = setInterval(() => {
      setNowTick(Date.now());
      loadSystemTotals();
    }, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo<RouteRow[] | null>(() => {
    if (!routeSystems) return null;
    const recent = rawEvents.filter((e) => nowTick - new Date(e.time).getTime() < RECENT_WINDOW_MS);

    const bySystem = new Map<number, GateKillEvent[]>();
    for (const event of recent) {
      const list = bySystem.get(event.system_id);
      if (list) list.push(event);
      else bySystem.set(event.system_id, [event]);
    }

    return routeSystems.map((s) => {
      const sysEvents = bySystem.get(s.id) ?? [];
      const gateCounts = new Map<string, { count: number; gateId: number | null }>();
      for (const event of sysEvents) {
        if (!event.gate_name) continue;
        const existing = gateCounts.get(event.gate_name);
        gateCounts.set(event.gate_name, { count: (existing?.count ?? 0) + 1, gateId: event.gate_id });
      }
      const gates = [...gateCounts.entries()].map(([gateName, g]) => ({ gateName, gateId: g.gateId, count: g.count }));
      return {
        ...s,
        totalSystemKills: systemTotals.get(s.id) ?? 0,
        totalGateKills: gates.reduce((sum, g) => sum + g.count, 0),
        gates,
        smartbomb: sysEvents.some((e) => e.smartbomb),
        interdictor: sysEvents.some((e) => e.interdictor),
        capital: sysEvents.some((e) => e.capital),
        citadel: sysEvents.some((e) => e.citadel),
        mobileBubble: sysEvents.some((e) => e.mobile_bubble),
      };
    });
  }, [routeSystems, rawEvents, nowTick, systemTotals]);

  function updateSlots(setter: SlotSetter, index: number, patch: Partial<Slot>) {
    setter((slots) => slots.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function handleQueryChange(setter: SlotSetter, index: number, value: string) {
    const lower = value.toLowerCase().trim();
    const results = lower.length < 2 ? [] : mapSystems.filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 8);
    updateSlots(setter, index, { query: value, system: null, results });
  }

  function pickSystem(
    setter: SlotSetter,
    slots: Slot[],
    index: number,
    system: MapSystem,
  ) {
    const isLast = index === slots.length - 1;
    setter((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, query: system.name, system, results: [] } : s));
      if (isLast) next.push(emptySlot(++keyCounterRef.current));
      return next;
    });
  }

  function removeSlot(setter: SlotSetter, index: number) {
    setter((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0 || next[next.length - 1].system) {
        next.push(emptySlot(++keyCounterRef.current));
      }
      return next;
    });
  }

  async function handleCheck() {
    const waypointIds = waypoints.filter((s) => s.system).map((s) => s.system!.id);
    const avoidIds = avoids.filter((s) => s.system).map((s) => s.system!.id);
    if (waypointIds.length < 2) {
      reportError("Pick at least a start and destination system.");
      return;
    }

    setChecking(true);
    try {
      const result = await planGateCheck(waypointIds, avoidIds, preference);
      const routeSystemIds = result.systems.map((s) => s.id);
      const events = await getGateActivity(routeSystemIds).catch(() => []);
      setRouteSystems(result.systems);
      setRawEvents(events);
      setNowTick(Date.now());
    } catch (err) {
      reportError(`Failed to plan route: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }

  function openLink(url: string) {
    openUrl(url).catch((err) => reportError(`Failed to open link: ${String(err)}`));
  }

  const selectedWaypoints = waypoints.filter((s) => s.system);
  const suggestedRouteName = selectedWaypoints.map((s) => s.system!.name).join(" → ");

  function loadSavedRoute(route: SavedRoute, reversed: boolean) {
    const systems = reversed ? [...route.systems].reverse() : route.systems;
    const slots: Slot[] = systems.map((sys) => ({
      key: ++keyCounterRef.current,
      query: sys.name,
      system: { id: sys.id, name: sys.name, security: sys.security, region_id: 0, constellation_id: 0, x: 0, y: 0 },
      results: [],
    }));
    slots.push(emptySlot(++keyCounterRef.current));
    setWaypoints(slots);
    setRouteSystems(null);
  }

  function saveCurrentRoute() {
    if (selectedWaypoints.length < 2) {
      reportError("Pick at least a start and destination system before saving a journey.");
      return;
    }
    const name = saveNameDraft.trim() || suggestedRouteName;
    addRoute({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      systems: selectedWaypoints.map((s) => ({ id: s.system!.id, name: s.system!.name, security: s.system!.security })),
    });
    setSaveNameDraft("");
  }

  function renderSlotRow(
    slots: Slot[],
    setter: SlotSetter,
    joiner: string,
  ) {
    return (
      <div className="gatecheck-slots">
        {slots.map((slot, index) => (
          <div key={slot.key} className="gatecheck-slot-group">
            {index > 0 && <span className="gatecheck-joiner">{joiner}</span>}
            <div className="gatecheck-slot">
              {slot.system ? (
                <span className="gatecheck-chip">
                  {slot.system.name}
                  <span className="kills-security" style={{ color: securityColor(slot.system.security) }}>
                    {formatSecurity(slot.system.security)}
                  </span>
                  <button type="button" onClick={() => removeSlot(setter, index)} aria-label="Remove">
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="System name..."
                    value={slot.query}
                    onChange={(e) => handleQueryChange(setter, index, e.target.value)}
                  />
                  {slot.results.length > 0 && (
                    <div className="gatecheck-slot-results">
                      {slot.results.map((system) => (
                        <button key={system.id} type="button" onClick={() => pickSystem(setter, slots, index, system)}>
                          <span className="kills-security" style={{ color: securityColor(system.security) }}>
                            {formatSecurity(system.security)}
                          </span>
                          {system.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  let lastRegion: string | null = null;

  return (
    <div className="gatecheck-page">
        <div className="gatecheck-form">
          {savedRoutes.length > 0 && (
            <div className="gatecheck-form-row">
              <span className="gatecheck-label">Saved journeys</span>
              <div className="gatecheck-saved-routes">
                {savedRoutes.map((route) => (
                  <span key={route.id} className="gatecheck-saved-chip">
                    <button type="button" onClick={() => loadSavedRoute(route, false)}>
                      {route.name}
                    </button>
                    <button
                      type="button"
                      className="gatecheck-saved-reverse"
                      onClick={() => loadSavedRoute(route, true)}
                      title={`Load ${route.name} in reverse`}
                      aria-label={`Load ${route.name} in reverse`}
                    >
                      <ArrowLeftRight size={12} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      className="gatecheck-saved-remove"
                      onClick={() => removeRoute(route.id)}
                      aria-label={`Delete saved journey ${route.name}`}
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="gatecheck-form-row">
            <span className="gatecheck-label">I will be traveling from</span>
            {renderSlotRow(waypoints, setWaypoints, "to")}
          </div>

          {selectedWaypoints.length >= 2 && (
            <div className="gatecheck-form-row">
              <span className="gatecheck-label">Save this journey</span>
              <div className="gatecheck-save-controls">
                <input
                  type="text"
                  value={saveNameDraft}
                  onChange={(e) => setSaveNameDraft(e.target.value)}
                  placeholder={suggestedRouteName}
                />
                <button type="button" className="gatecheck-save-button" onClick={saveCurrentRoute}>
                  <Star size={13} strokeWidth={2} />
                  Save
                </button>
              </div>
            </div>
          )}

          <div className="gatecheck-form-row">
            <span className="gatecheck-label">Avoid these systems</span>
            {renderSlotRow(avoids, setAvoids, "")}
          </div>

          <div className="gatecheck-form-row">
            <span className="gatecheck-label">Prefer</span>
            <div className="gatecheck-preference">
              {(["shortest", "secure", "insecure"] as RoutePreference[]).map((option) => (
                <label key={option} className="gatecheck-radio">
                  <input
                    type="radio"
                    name="gatecheck-preference"
                    checked={preference === option}
                    onChange={() => setPreference(option)}
                  />
                  {option === "shortest" ? "Shortest" : option === "secure" ? "Secure" : "Unsecure"}
                </label>
              ))}
            </div>
          </div>

          <button type="button" className="gatecheck-check-button" onClick={handleCheck} disabled={checking}>
            {checking ? "Checking..." : "Check!"}
          </button>
        </div>

        {rows && (
          <div className="gatecheck-results">
            <p className="gatecheck-results-heading">
              Your route <span>({rows.length - 1} jumps)</span>
            </p>
            <p className="gatecheck-caveat">
              Showing kills from the last hour (EVE time) - a kill drops off this list on its own once it's more than
              an hour old, so a clear system now isn't a guarantee it stays that way. A system can show a lot of
              kills in total but none at a gate if the fighting isn't happening near one you'd actually jump through.
            </p>
            <div className="gatecheck-table-wrap">
              <table className="gatecheck-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Region</th>
                    <th>System / Sec</th>
                    <th>Total Kills In System (1h)</th>
                    <th>Kills Within 100km Of A Gate (1h)</th>
                    <th>Info</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const showRegion = row.region_name !== lastRegion;
                    lastRegion = row.region_name;
                    return (
                      <tr key={`${row.id}-${index}`} className={`gatecheck-row gatecheck-row-${killBand(row)}`}>
                        <td>{index + 1}</td>
                        <td>
                          {showRegion && row.region_name ? (
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault();
                                openLink(`https://evemaps.dotlan.net/map/${dotlanName(row.region_name)}`);
                              }}
                            >
                              {row.region_name}
                            </a>
                          ) : null}
                        </td>
                        <td>
                          <span className="kills-security" style={{ color: securityColor(row.security) }}>
                            {formatSecurity(row.security)}
                          </span>
                          <span
                            className="kills-system-clickable"
                            role="button"
                            tabIndex={0}
                            onClick={() =>
                              onSelectSystem({
                                id: row.id,
                                name: row.name,
                                security: row.security,
                                regionName: row.region_name || null,
                              })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectSystem({
                                  id: row.id,
                                  name: row.name,
                                  security: row.security,
                                  regionName: row.region_name || null,
                                });
                              }
                            }}
                          >
                            {row.name}
                          </span>
                        </td>
                        <td>{row.totalSystemKills}</td>
                        <td>{row.totalGateKills}</td>
                        <td>
                          {row.totalGateKills === 0 && <div>No kills at gates.</div>}
                          {row.gates.map((g) =>
                            g.gateId != null ? (
                              <div key={g.gateName}>
                                {g.count} kill{g.count === 1 ? "" : "s"} at the{" "}
                                <a
                                  href="#"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    onSelectGate({ id: g.gateId!, name: g.gateName, systemId: row.id, systemName: row.name });
                                  }}
                                >
                                  {g.gateName} gate
                                </a>
                                .
                              </div>
                            ) : (
                              <div key={g.gateName}>
                                {g.count} kill{g.count === 1 ? "" : "s"} at the {g.gateName} gate.
                              </div>
                            ),
                          )}
                          {threatLines(row).map((line, i) => (
                            <div key={i}>{line}</div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="gatecheck-legend">
              {[
                ["safe", "0 kills"],
                ["caution", "2 kills or less"],
                ["danger", "3 kills or more"],
                ["danger", "smartbomb kills"],
                ["danger", "hic/dictors used"],
                ["danger", "mobile bubbles used"],
                ["danger", "capitals used"],
                ["danger", "citadels used"],
              ].map(([band, label]) => (
                <div key={label} className="gatecheck-legend-row">
                  <span className={`gatecheck-legend-item gatecheck-row-${band}`}>{label}</span>
                  <span>at gates in system in the past hour</span>
                </div>
              ))}
            </div>
          </div>
        )}
    </div>
  );
}

export default GateCheck;
