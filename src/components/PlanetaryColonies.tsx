import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  getCharacterPlanets,
  getCharacterPlanetDetail,
  type SessionCharacter,
  type PlanetEntry,
  type PlanetPin,
} from "../lib/eve";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useNotificationCenter } from "../hooks/useNotificationCenter";
import { formatTimeElapsedFull, formatTimeRemainingFull, formatEveDateTime } from "../lib/format";
import { typeIconUrl } from "../lib/format";
import { useSortableRows, useTextFilter, useSelectFilter } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import TableFilterBar from "./TableFilterBar";

type ColonyStatus = "active" | "idle" | "no_extractors";

interface ColonyRow {
  key: string;
  characterId: number;
  characterName: string;
  portraitUrl: string;
  planet: PlanetEntry;
  status: ColonyStatus;
  extractorCount: number;
  earliestExpiry: string | null;
  pins: PlanetPin[] | null;
  needsReauth: boolean;
}

function computeStatus(pins: PlanetPin[]): { status: ColonyStatus; earliestExpiry: string | null; extractorCount: number } {
  const extractors = pins.filter((p) => p.is_extractor && p.expiry_time);
  if (extractors.length === 0) return { status: "no_extractors", earliestExpiry: null, extractorCount: 0 };
  const earliest = extractors.reduce((min, p) => (p.expiry_time! < min ? p.expiry_time! : min), extractors[0].expiry_time!);
  const status: ColonyStatus = new Date(earliest).getTime() <= Date.now() ? "idle" : "active";
  return { status, earliestExpiry: earliest, extractorCount: extractors.length };
}

const STATUS_LABEL: Record<ColonyStatus, string> = {
  active: "Active",
  idle: "Needs Restart",
  no_extractors: "No Extractors",
};

const STATUS_CLASS: Record<ColonyStatus, string> = {
  active: "data-table-tag",
  idle: "data-table-tag data-table-tag-danger",
  no_extractors: "data-table-tag data-table-tag-neutral",
};

/** How often colonies are silently re-checked in the background so a
 * restart-needed notification can actually fire without the user having to
 * sit on this page - an extractor's shortest possible cycle is measured in
 * hours, so this doesn't need to be frequent to still catch it promptly. */
const PI_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface PlanetaryColoniesProps {
  characters: SessionCharacter[];
}

function PlanetaryColonies({ characters }: PlanetaryColoniesProps) {
  const [colonies, setColonies] = useState<ColonyRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [reauthCharacters, setReauthCharacters] = useState<Set<number>>(new Set());
  const reportError = useErrorReporter();
  const { addNotification } = useNotificationCenter();
  // Last-seen status per colony, so a poll can tell "just went idle" (worth
  // a notification) apart from "already was idle" (not new information).
  // Null specifically means "haven't established a baseline yet" - the
  // very first load of a fresh character list should never itself fire a
  // notification for colonies that were already sitting idle before the
  // app ever checked them.
  const prevStatusRef = useRef<Map<string, ColonyStatus> | null>(null);

  useEffect(() => {
    prevStatusRef.current = null;
    if (characters.length === 0) {
      setColonies([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setColonies(null);

    async function loadAll() {
      const needsReauth = new Set<number>();
      const rows: ColonyRow[] = [];

      await Promise.all(
        characters.map(async (character) => {
          let list;
          try {
            list = await getCharacterPlanets(character.id);
          } catch (err) {
            reportError(`Failed to load ${character.name}'s planetary colonies: ${String(err)}`);
            return;
          }
          if (list.needs_reauth) {
            needsReauth.add(character.id);
            return;
          }
          await Promise.all(
            list.entries.map(async (planet) => {
              const key = `${character.id}:${planet.planet_id}`;
              try {
                const detail = await getCharacterPlanetDetail(character.id, planet.planet_id);
                if (detail.needs_reauth) {
                  needsReauth.add(character.id);
                  return;
                }
                const { status, earliestExpiry, extractorCount } = computeStatus(detail.pins);
                rows.push({
                  key,
                  characterId: character.id,
                  characterName: character.name,
                  portraitUrl: character.portrait_url,
                  planet,
                  status,
                  extractorCount,
                  earliestExpiry,
                  pins: detail.pins,
                  needsReauth: false,
                });
              } catch (err) {
                reportError(`Failed to load colony detail for ${character.name} / ${planet.planet_name}: ${String(err)}`);
              }
            }),
          );
        }),
      );

      if (cancelled) return;

      const previous = prevStatusRef.current;
      if (previous) {
        for (const row of rows) {
          if (row.status === "idle" && previous.get(row.key) !== "idle") {
            addNotification(
              "Planetary colony needs restart",
              `${row.characterName}'s ${row.planet.planet_name} (${row.planet.solar_system_name}) - an extractor cycle just finished.`,
            );
          }
        }
      }
      prevStatusRef.current = new Map(rows.map((r) => [r.key, r.status]));

      setColonies(rows);
      setReauthCharacters(needsReauth);
      setLoading(false);
    }

    loadAll();
    const interval = setInterval(loadAll, PI_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, reportError]);

  const colonyText = useTextFilter(colonies ?? [], (r) => [r.characterName, r.planet.planet_name, r.planet.solar_system_name]);
  const colonyCharacter = useSelectFilter(colonyText.filtered, (r) => r.characterName);
  const colonyType = useSelectFilter(colonyCharacter.filtered, (r) => r.planet.planet_type);
  const colonyStatus = useSelectFilter(colonyType.filtered, (r) => STATUS_LABEL[r.status]);
  const sorted = useSortableRows(colonyStatus.filtered, {
    characterName: (r) => r.characterName,
    planetName: (r) => r.planet.planet_name,
    solarSystemName: (r) => r.planet.solar_system_name,
    planetType: (r) => r.planet.planet_type,
    upgradeLevel: (r) => r.planet.upgrade_level,
    status: (r) => (r.status === "idle" ? 0 : r.status === "active" ? 1 : 2),
    earliestExpiry: (r) => (r.earliestExpiry ? new Date(r.earliestExpiry).getTime() : Number.MAX_SAFE_INTEGER),
  }, "status", "asc");

  const summary = useMemo(() => {
    const list = colonies ?? [];
    return {
      total: list.length,
      active: list.filter((c) => c.status === "active").length,
      idle: list.filter((c) => c.status === "idle").length,
    };
  }, [colonies]);

  if (characters.length === 0) {
    return <p className="detail-empty">No connected characters.</p>;
  }

  return (
    <div className="pi-colonies">
      {reauthCharacters.size > 0 && (
        <p className="detail-empty">
          {Array.from(reauthCharacters)
            .map((id) => characters.find((c) => c.id === id)?.name ?? `#${id}`)
            .join(", ")}{" "}
          need{reauthCharacters.size === 1 ? "s" : ""} to sign in again to unlock planetary data.
        </p>
      )}

      {loading && !colonies ? (
        <p className="detail-empty">Loading planetary colonies across all characters...</p>
      ) : colonies && colonies.length === 0 ? (
        <p className="detail-empty">No planetary colonies found on any connected character.</p>
      ) : (
        colonies && (
          <>
            <div className="market-browser-stats">
              <div className="market-stat-card">
                <span className="market-stat-label">Colonies</span>
                <span className="market-stat-value">{summary.total}</span>
              </div>
              <div className="market-stat-card">
                <span className="market-stat-label">Active</span>
                <span className="market-stat-value character-stats-destroyed">{summary.active}</span>
              </div>
              <div
                className="market-stat-card"
                title="At least one extractor's current cycle has already ended - go restart it in-game."
              >
                <span className="market-stat-label">Needs Restart</span>
                <span className={summary.idle > 0 ? "market-stat-value character-stats-lost" : "market-stat-value"}>
                  {summary.idle}
                </span>
              </div>
            </div>

            <TableFilterBar
              searchQuery={colonyText.query}
              onSearchChange={colonyText.setQuery}
              searchPlaceholder="Search character, planet, or system..."
              selects={[
                { label: "Characters", value: colonyCharacter.value, options: colonyCharacter.options, onChange: colonyCharacter.setValue },
                { label: "Planet Types", value: colonyType.value, options: colonyType.options, onChange: colonyType.setValue },
                { label: "Statuses", value: colonyStatus.value, options: colonyStatus.options, onChange: colonyStatus.setValue },
              ]}
              resultCount={`${sorted.rows.length} of ${colonies.length}`}
            />

            {sorted.rows.length === 0 ? (
              <p className="detail-empty">No colonies match the current filters.</p>
            ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="Character" sortKey="characterName" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <SortableTh label="Planet" sortKey="planetName" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <SortableTh label="System" sortKey="solarSystemName" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <SortableTh label="Type" sortKey="planetType" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <SortableTh label="Level" sortKey="upgradeLevel" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                    <SortableTh label="Status" sortKey="status" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <SortableTh label="Extractors" sortKey="earliestExpiry" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                    <th>Pins</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.rows.map((row) => (
                    <Fragment key={row.key}>
                      <tr
                        className="contract-row-expandable"
                        onClick={() => setExpandedKey(expandedKey === row.key ? null : row.key)}
                      >
                        <td>
                          <span className="asset-item-cell">
                            <img className="kills-portrait" style={{ width: 24, height: 24 }} src={row.portraitUrl} alt="" />
                            {row.characterName}
                          </span>
                        </td>
                        <td>{row.planet.planet_name}</td>
                        <td>{row.planet.solar_system_name}</td>
                        <td>{row.planet.planet_type}</td>
                        <td className="data-table-numeric">{row.planet.upgrade_level}</td>
                        <td>
                          <span className={STATUS_CLASS[row.status]}>{STATUS_LABEL[row.status]}</span>
                        </td>
                        <td>
                          {row.earliestExpiry == null
                            ? "—"
                            : row.status === "idle"
                              ? `Idle for ${formatTimeElapsedFull(row.earliestExpiry)}`
                              : `${formatTimeRemainingFull(row.earliestExpiry)} left`}
                        </td>
                        <td>
                          {row.pins && (
                            <div className="pi-colony-pin-strip">
                              {row.pins.map((pin) => {
                                const idle = pin.is_extractor && pin.expiry_time != null && new Date(pin.expiry_time).getTime() <= Date.now();
                                const running = pin.is_extractor && pin.expiry_time != null && !idle;
                                return (
                                  <img
                                    key={pin.pin_id}
                                    className={`pi-colony-pin-strip-icon${idle ? " pi-colony-pin-strip-icon-idle" : running ? " pi-colony-pin-strip-icon-running" : ""}`}
                                    src={typeIconUrl(pin.type_id)}
                                    alt=""
                                    title={`${pin.type_name}${idle ? " - idle" : ""}`}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                      {expandedKey === row.key && (
                        <tr className="contract-items-row">
                          <td colSpan={8}>
                            {row.pins == null || row.pins.length === 0 ? (
                              <p className="detail-empty">No pins found on this colony.</p>
                            ) : (
                              <div className="pi-colony-pins">
                                {row.pins.map((pin) => (
                                  <div key={pin.pin_id} className="pi-colony-pin-card">
                                    <div className="pi-colony-pin-head">
                                      <img className="pi-pill-icon" src={typeIconUrl(pin.type_id)} alt="" />
                                      <span className="pi-colony-pin-name">{pin.type_name}</span>
                                      {pin.is_factory && <span className="data-table-tag data-table-tag-neutral">Factory</span>}
                                    </div>
                                    {pin.is_extractor && pin.product_type_name && (
                                      <p className="pi-colony-pin-detail">Extracting: {pin.product_type_name}</p>
                                    )}
                                    {pin.expiry_time && (
                                      <p className={`pi-colony-pin-detail${new Date(pin.expiry_time).getTime() <= Date.now() ? " pi-colony-pin-detail-idle" : ""}`}>
                                        {new Date(pin.expiry_time).getTime() <= Date.now()
                                          ? `Idle for ${formatTimeElapsedFull(pin.expiry_time)}`
                                          : `Cycle ends ${formatEveDateTime(pin.expiry_time)} (${formatTimeRemainingFull(pin.expiry_time)} left)`}
                                      </p>
                                    )}
                                    {pin.contents.length > 0 && (
                                      <p className="pi-colony-pin-detail">
                                        Storage: {pin.contents.map((c) => `${c.type_name} x${c.amount.toLocaleString()}`).join(", ")}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </>
        )
      )}
    </div>
  );
}

export default PlanetaryColonies;
