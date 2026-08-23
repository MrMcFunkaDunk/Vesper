import type { KeyboardEvent, MouseEvent } from "react";
import { Check, X } from "lucide-react";
import type { KillEntry } from "../lib/kills";
import { formatIsk, formatExactTime, dateKey, formatDateHeading, formatSecurity, securityColor } from "../lib/format";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

interface KillFeedTableProps {
  kills: KillEntry[];
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
  /** When provided, tags each row as a "kill" (green, check icon) or "loss"
   * (red, cross icon) - used by the Character Overview tab's merged
   * kills+losses feed. Omitted everywhere else, where every row in the
   * list means the same thing and no coloring is needed. */
  outcomeFor?: (kill: KillEntry) => "kill" | "loss" | undefined;
}

interface KillGroup {
  key: string;
  heading: string;
  entries: KillEntry[];
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=32`;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=32`;
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

function KillFeedTable({
  kills,
  onSelectKill,
  onSelectCharacter,
  onSelectSystem,
  onSelectCorporation,
  onSelectAlliance,
  outcomeFor,
}: KillFeedTableProps) {
  function characterLinkProps(characterId: number | null) {
    if (!characterId) return {};
    return {
      role: "button" as const,
      tabIndex: 0,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        onSelectCharacter(characterId);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelectCharacter(characterId);
        }
      },
    };
  }

  function corporationLinkProps(corporationId: number | null, corporationName: string | null) {
    if (!corporationId || !corporationName) return {};
    return {
      role: "button" as const,
      tabIndex: 0,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        onSelectCorporation({ id: corporationId, name: corporationName });
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelectCorporation({ id: corporationId, name: corporationName });
        }
      },
    };
  }

  function allianceLinkProps(allianceId: number | null, allianceName: string | null) {
    if (!allianceId || !allianceName) return {};
    return {
      role: "button" as const,
      tabIndex: 0,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        onSelectAlliance({ id: allianceId, name: allianceName });
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelectAlliance({ id: allianceId, name: allianceName });
        }
      },
    };
  }

  function handleSelectSystem(e: { stopPropagation: () => void }, kill: KillEntry) {
    e.stopPropagation();
    onSelectSystem({
      id: kill.system_id,
      name: kill.system_name,
      security: kill.system_security ?? 0,
      regionName: kill.region_name,
    });
  }


  return (
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
          {group.entries.map((kill) => {
            const outcome = outcomeFor?.(kill);
            return (
            <div
              key={kill.killmail_id}
              className={`kills-row kills-row-clickable${outcome ? ` kills-row-outcome-${outcome}` : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectKill(kill.killmail_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectKill(kill.killmail_id);
                }
              }}
            >
              <span className="kills-time">
                {outcome === "kill" && <Check size={13} strokeWidth={2.5} className="kills-outcome-icon kills-outcome-icon-kill" />}
                {outcome === "loss" && <X size={13} strokeWidth={2.5} className="kills-outcome-icon kills-outcome-icon-loss" />}
                {formatExactTime(kill.time)}
              </span>

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
                    <span className="kills-security" style={{ color: securityColor(kill.system_security) }}>
                      {formatSecurity(kill.system_security)}
                    </span>
                  )}
                  <span
                    className="kills-system kills-system-clickable"
                    role="button"
                    tabIndex={0}
                    style={kill.system_security != null ? { color: securityColor(kill.system_security) } : undefined}
                    onClick={(e) => handleSelectSystem(e, kill)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelectSystem(e, kill);
                      }
                    }}
                  >
                    {kill.system_name}
                  </span>
                </div>
                {kill.region_name && <span className="kills-region">{kill.region_name}</span>}
              </div>

              <div
                className={`kills-victim-cell ${kill.victim_character_id ? "kills-person-clickable" : ""}`}
                {...characterLinkProps(kill.victim_character_id)}
              >
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
                    <span
                      className="kills-identity-corp kills-system-clickable"
                      {...corporationLinkProps(kill.victim_corporation_id, kill.victim_corporation_name)}
                    >
                      {kill.victim_corporation_name}
                    </span>
                  )}
                  {kill.victim_alliance_name && (
                    <span
                      className="kills-identity-alliance kills-system-clickable"
                      {...allianceLinkProps(kill.victim_alliance_id, kill.victim_alliance_name)}
                    >
                      {kill.victim_alliance_name}
                    </span>
                  )}
                </div>
              </div>

              <span className="kills-value">{formatIsk(kill.total_value)}</span>

              <div
                className={`kills-finalblow-cell ${kill.final_blow_character_id ? "kills-person-clickable" : ""}`}
                {...characterLinkProps(kill.final_blow_character_id)}
              >
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
                    {!kill.solo && kill.attacker_count > 1 && (
                      <span className="kills-tag kills-tag-attackers" title={`${kill.attacker_count} attackers`}>
                        {kill.attacker_count}x
                      </span>
                    )}
                  </div>
                  {kill.final_blow_corporation_name && (
                    <span
                      className="kills-identity-corp kills-system-clickable"
                      {...corporationLinkProps(kill.final_blow_corporation_id, kill.final_blow_corporation_name)}
                    >
                      {kill.final_blow_corporation_name}
                    </span>
                  )}
                  {kill.final_blow_alliance_name && (
                    <span
                      className="kills-identity-alliance kills-system-clickable"
                      {...allianceLinkProps(kill.final_blow_alliance_id, kill.final_blow_alliance_name)}
                    >
                      {kill.final_blow_alliance_name}
                    </span>
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default KillFeedTable;
