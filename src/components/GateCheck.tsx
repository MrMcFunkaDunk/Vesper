import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getMapData, type MapSystem } from "../lib/map";
import { planGateCheck, getGateActivity, type RoutePreference, type GateCheckSystem, type GateKillEvent } from "../lib/route";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { securityBand, formatSecurity } from "../lib/format";
import type { SystemSummary } from "./SystemKillboard";

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
  count: number;
}

interface RouteRow extends GateCheckSystem {
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

/** Builds the Info column's lines: one per gate with recent kills, plus a line for every specific threat seen in the system. */
function infoLines(row: RouteRow): string[] {
  const lines: string[] =
    row.totalGateKills === 0
      ? ["No kills at gates."]
      : row.gates.map((g) => `${g.count} kill${g.count === 1 ? "" : "s"} at the ${g.gateName} gate.`);
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
}

function GateCheck({ onSelectSystem }: GateCheckProps) {
  const [mapSystems, setMapSystems] = useState<MapSystem[]>([]);
  const [waypoints, setWaypoints] = useState<Slot[]>([emptySlot(0), emptySlot(1)]);
  const [avoids, setAvoids] = useState<Slot[]>([emptySlot(100)]);
  const [preference, setPreference] = useState<RoutePreference>("shortest");
  const [rows, setRows] = useState<RouteRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const keyCounterRef = useRef(200);
  const reportError = useErrorReporter();

  useEffect(() => {
    getMapData()
      .then((data) => setMapSystems(data.systems))
      .catch((err) => reportError(`Failed to load system list: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const now = Date.now();
      const recent = events.filter((e) => now - new Date(e.time).getTime() < RECENT_WINDOW_MS);

      const bySystem = new Map<number, GateKillEvent[]>();
      for (const event of recent) {
        const list = bySystem.get(event.system_id);
        if (list) list.push(event);
        else bySystem.set(event.system_id, [event]);
      }

      setRows(
        result.systems.map((s) => {
          const sysEvents = bySystem.get(s.id) ?? [];
          const gateCounts = new Map<string, number>();
          for (const event of sysEvents) {
            if (!event.gate_name) continue;
            gateCounts.set(event.gate_name, (gateCounts.get(event.gate_name) ?? 0) + 1);
          }
          const gates = [...gateCounts.entries()].map(([gateName, count]) => ({ gateName, count }));
          return {
            ...s,
            totalGateKills: gates.reduce((sum, g) => sum + g.count, 0),
            gates,
            smartbomb: sysEvents.some((e) => e.smartbomb),
            interdictor: sysEvents.some((e) => e.interdictor),
            capital: sysEvents.some((e) => e.capital),
            citadel: sysEvents.some((e) => e.citadel),
            mobileBubble: sysEvents.some((e) => e.mobile_bubble),
          };
        }),
      );
    } catch (err) {
      reportError(`Failed to plan route: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }

  function openLink(url: string) {
    openUrl(url).catch((err) => reportError(`Failed to open link: ${String(err)}`));
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
                  <span className={`kills-security kills-security-${securityBand(slot.system.security)}`}>
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
                          <span className={`kills-security kills-security-${securityBand(system.security)}`}>
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
          <div className="gatecheck-form-row">
            <span className="gatecheck-label">I will be traveling from</span>
            {renderSlotRow(waypoints, setWaypoints, "to")}
          </div>

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
            <div className="gatecheck-table-wrap">
              <table className="gatecheck-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Region</th>
                    <th>System / Sec</th>
                    <th>Kills (1h)</th>
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
                          <span className={`kills-security kills-security-${securityBand(row.security)}`}>
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
                        <td>{row.totalGateKills}</td>
                        <td>
                          {infoLines(row).map((line, i) => (
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
