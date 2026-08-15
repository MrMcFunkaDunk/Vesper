import { useState, type FormEvent } from "react";
import { Plus, X, RefreshCw } from "lucide-react";
import { searchSystem, getRecentKills, type KillEntry } from "../lib/kills";
import { useWatchedSystems } from "../hooks/useWatchedSystems";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk, formatRelativeTime, dateKey, formatDateHeading, formatSecurity, securityBand } from "../lib/format";
import KillDetailView from "./KillDetailView";

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=32`;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=32`;
}

interface KillGroup {
  key: string;
  heading: string;
  entries: KillEntry[];
}

function groupKillsByDate(kills: KillEntry[]): KillGroup[] {
  const groups: KillGroup[] = [];
  for (const kill of kills) {
    const key = dateKey(kill.time);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(kill);
    } else {
      groups.push({ key, heading: formatDateHeading(kill.time), entries: [kill] });
    }
  }
  return groups;
}

function KillsIntel() {
  const { systems, addSystem, removeSystem } = useWatchedSystems();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [kills, setKills] = useState<KillEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const [selectedKillId, setSelectedKillId] = useState<number | null>(null);
  const reportError = useErrorReporter();

  async function handleAddSystem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = query.trim();
    if (!name) return;
    setSearching(true);
    try {
      const match = await searchSystem(name);
      if (!match) {
        reportError(`No solar system found named "${name}". This needs an exact match - check the spelling.`);
        return;
      }
      addSystem(match);
      setQuery("");
    } catch (err) {
      reportError(`System lookup failed: ${String(err)}`);
    } finally {
      setSearching(false);
    }
  }

  async function handleSync() {
    if (systems.length === 0) return;
    setSyncing(true);
    try {
      const results = await getRecentKills(systems.map((s) => s.id));
      setKills(results);
      setHasSynced(true);
    } catch (err) {
      reportError(`Failed to load kills: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  if (selectedKillId != null) {
    return <KillDetailView killmailId={selectedKillId} onBack={() => setSelectedKillId(null)} />;
  }

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header">
          <p className="eyebrow">Kills & Intel</p>
          <h2>Recent Activity</h2>
        </div>

        <div className="kills-watchlist">
          <form className="kills-add-form" onSubmit={handleAddSystem}>
            <input
              type="text"
              placeholder="Add a system to watch (exact name, e.g. Jita)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={searching}
            />
            <button type="submit" disabled={searching || !query.trim()}>
              <Plus size={14} strokeWidth={2} />
              {searching ? "Searching..." : "Add"}
            </button>
          </form>

          <div className="kills-watched-chips">
            {systems.length === 0 ? (
              <span className="kills-watched-empty">No systems watched yet.</span>
            ) : (
              systems.map((system) => (
                <span key={system.id} className="kills-watched-chip">
                  {system.name}
                  <button
                    type="button"
                    onClick={() => removeSystem(system.id)}
                    aria-label={`Stop watching ${system.name}`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              ))
            )}
          </div>

          <button
            type="button"
            className="kills-sync-btn"
            onClick={handleSync}
            disabled={syncing || systems.length === 0}
          >
            <RefreshCw size={13} strokeWidth={2} className={syncing ? "kills-sync-spinning" : ""} />
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>

        <div className="kills-feed">
          {systems.length === 0 ? (
            <p className="detail-empty">Add a system above to start watching for activity.</p>
          ) : !hasSynced ? (
            <p className="detail-empty">Click Sync to pull recent kills for your watched systems.</p>
          ) : kills.length === 0 ? (
            <p className="detail-empty">No recent kills in your watched systems.</p>
          ) : (
            <div className="kills-table">
              <div className="kills-row kills-row-header">
                <span>Time</span>
                <span>Ship</span>
                <span>Location</span>
                <span>Victim</span>
                <span>ISK Lost</span>
                <span>Final Blow</span>
              </div>
              {groupKillsByDate(kills).map((group) => (
                <div key={group.key}>
                  <div className="kills-date-divider">
                    <span>{group.heading}</span>
                  </div>
                  {group.entries.map((kill) => (
                    <div
                      key={kill.killmail_id}
                      className="kills-row kills-row-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedKillId(kill.killmail_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedKillId(kill.killmail_id);
                        }
                      }}
                    >
                      <span className="kills-time">{formatRelativeTime(kill.time)}</span>

                      <div className="kills-ship-cell">
                        <img
                          className="kills-ship-icon"
                          src={`https://images.evetech.net/types/${kill.ship_type_id}/icon?size=32`}
                          alt=""
                        />
                        <span className="kills-ship">{kill.ship_type_name}</span>
                      </div>

                      <div className="kills-location-cell">
                        <div className="kills-location-line">
                          {kill.system_security != null && (
                            <span className={`kills-security kills-security-${securityBand(kill.system_security)}`}>
                              {formatSecurity(kill.system_security)}
                            </span>
                          )}
                          <span className="kills-system">{kill.system_name}</span>
                        </div>
                        {kill.region_name && <span className="kills-region">{kill.region_name}</span>}
                      </div>

                      <div className="kills-victim-cell">
                        <div className="kills-avatar-stack">
                          {kill.victim_character_id && (
                            <img
                              className="kills-portrait"
                              src={`https://images.evetech.net/characters/${kill.victim_character_id}/portrait?size=32`}
                              alt=""
                            />
                          )}
                          {kill.victim_corporation_id && (
                            <img
                              className="kills-logo"
                              src={corpLogoUrl(kill.victim_corporation_id)}
                              alt=""
                              title={kill.victim_corporation_name ?? undefined}
                            />
                          )}
                          {kill.victim_alliance_id && (
                            <img
                              className="kills-logo"
                              src={allianceLogoUrl(kill.victim_alliance_id)}
                              alt=""
                              title={kill.victim_alliance_name ?? undefined}
                            />
                          )}
                        </div>
                        <div className="kills-identity">
                          <span className="kills-identity-name">{kill.victim_character_name ?? "Unknown"}</span>
                          {kill.victim_corporation_name && (
                            <span className="kills-identity-corp">{kill.victim_corporation_name}</span>
                          )}
                          {kill.victim_alliance_name && (
                            <span className="kills-identity-alliance">{kill.victim_alliance_name}</span>
                          )}
                        </div>
                      </div>

                      <span className="kills-value">{formatIsk(kill.total_value)}</span>

                      <div className="kills-finalblow-cell">
                        <div className="kills-avatar-stack">
                          {kill.final_blow_character_id && (
                            <img
                              className="kills-portrait"
                              src={`https://images.evetech.net/characters/${kill.final_blow_character_id}/portrait?size=32`}
                              alt=""
                            />
                          )}
                          {kill.final_blow_corporation_id && (
                            <img
                              className="kills-logo"
                              src={corpLogoUrl(kill.final_blow_corporation_id)}
                              alt=""
                              title={kill.final_blow_corporation_name ?? undefined}
                            />
                          )}
                          {kill.final_blow_alliance_id && (
                            <img
                              className="kills-logo"
                              src={allianceLogoUrl(kill.final_blow_alliance_id)}
                              alt=""
                              title={kill.final_blow_alliance_name ?? undefined}
                            />
                          )}
                        </div>
                        <div className="kills-identity">
                          <div className="kills-identity-name-row">
                            <span className="kills-identity-name">{kill.final_blow_character_name ?? "—"}</span>
                            {kill.solo && <span className="kills-tag kills-tag-solo">Solo</span>}
                            {kill.npc && <span className="kills-tag kills-tag-npc">NPC</span>}
                          </div>
                          {kill.final_blow_corporation_name && (
                            <span className="kills-identity-corp">{kill.final_blow_corporation_name}</span>
                          )}
                          {kill.final_blow_alliance_name && (
                            <span className="kills-identity-alliance">{kill.final_blow_alliance_name}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default KillsIntel;
