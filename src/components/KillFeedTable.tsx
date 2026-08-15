import type { KeyboardEvent, MouseEvent } from "react";
import type { KillEntry } from "../lib/kills";
import { formatIsk, formatExactTime, dateKey, formatDateHeading, formatSecurity, securityBand } from "../lib/format";

interface KillFeedTableProps {
  kills: KillEntry[];
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
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

function KillFeedTable({ kills, onSelectKill, onSelectCharacter }: KillFeedTableProps) {
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
          {group.entries.map((kill) => (
            <div
              key={kill.killmail_id}
              className="kills-row kills-row-clickable"
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
              <span className="kills-time">{formatExactTime(kill.time)}</span>

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
                    <span className="kills-identity-corp">{kill.victim_corporation_name}</span>
                  )}
                  {kill.victim_alliance_name && (
                    <span className="kills-identity-alliance">{kill.victim_alliance_name}</span>
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
  );
}

export default KillFeedTable;
