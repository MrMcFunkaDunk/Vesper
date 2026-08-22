import { useMemo, useState } from "react";
import { Swords } from "lucide-react";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { formatIsk, formatSecurity, securityColor, formatExactTime } from "../lib/format";
import KillFeedTable from "./KillFeedTable";
import type { KillEntry } from "../lib/kills";
import type { SystemSummary } from "./SystemKillboard";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

/** A gap this long between consecutive kills in the same system splits one
 * battle from the next - the same "session gap" idea real battle-report
 * sites (br.evetools.org, brcat) use, just simpler: no attacker-list
 * lookups, only what the recent-kills feed already carries per kill. */
const BATTLE_GAP_MS = 20 * 60 * 1000;
/** A single kill isn't a "battle" - this is the floor for showing up in
 * the list at all. */
const MIN_BATTLE_KILLS = 2;

interface Battle {
  id: string;
  systemId: number;
  systemName: string;
  systemSecurity: number | null;
  startTime: string;
  endTime: string;
  kills: KillEntry[];
  totalValue: number;
  /** Corp name -> how many kills in this battle involved them, either as
   * victim or final blow - the closest read on "who was fighting" the
   * recent-kills feed's per-kill data supports without a detail lookup
   * per killmail. */
  involvedCorps: Map<string, number>;
}

function buildBattle(systemId: number, kills: KillEntry[]): Battle {
  const first = kills[0];
  const last = kills[kills.length - 1];
  const involvedCorps = new Map<string, number>();
  for (const k of kills) {
    if (k.victim_corporation_name) involvedCorps.set(k.victim_corporation_name, (involvedCorps.get(k.victim_corporation_name) ?? 0) + 1);
    if (k.final_blow_corporation_name) {
      involvedCorps.set(k.final_blow_corporation_name, (involvedCorps.get(k.final_blow_corporation_name) ?? 0) + 1);
    }
  }
  return {
    id: `${systemId}-${first.time}`,
    systemId,
    systemName: first.system_name,
    systemSecurity: first.system_security,
    startTime: first.time,
    endTime: last.time,
    kills,
    totalValue: kills.reduce((sum, k) => sum + k.total_value, 0),
    involvedCorps,
  };
}

function clusterBattles(kills: KillEntry[]): Battle[] {
  const bySystem = new Map<number, KillEntry[]>();
  for (const k of kills) {
    const list = bySystem.get(k.system_id);
    if (list) list.push(k);
    else bySystem.set(k.system_id, [k]);
  }

  const battles: Battle[] = [];
  for (const [systemId, systemKills] of bySystem) {
    const sorted = [...systemKills].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    let current: KillEntry[] = [];
    for (const k of sorted) {
      const previous = current[current.length - 1];
      if (previous && new Date(k.time).getTime() - new Date(previous.time).getTime() > BATTLE_GAP_MS) {
        battles.push(buildBattle(systemId, current));
        current = [k];
      } else {
        current.push(k);
      }
    }
    if (current.length > 0) battles.push(buildBattle(systemId, current));
  }
  return battles.filter((b) => b.kills.length >= MIN_BATTLE_KILLS).sort((a, b) => b.kills.length - a.kills.length);
}

interface BattleReportsFeedProps {
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  onSelectSystem: (system: SystemSummary) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

function BattleReportsFeed({ onSelectKill, onSelectCharacter, onSelectSystem, onSelectCorporation, onSelectAlliance }: BattleReportsFeedProps) {
  const { kills, loading } = useRecentActivity();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const battles = useMemo(() => clusterBattles(kills), [kills]);

  return (
    <div className="kills-feed">
      <p className="settings-section-hint">
        Kills within the same system, clustered wherever no gap longer than 20 minutes separates them - a rough
        battle grouping over the live recent-kills feed, not a full attacker-list analysis.
      </p>
      {loading && battles.length === 0 ? (
        <p className="detail-empty">Loading recent activity...</p>
      ) : battles.length === 0 ? (
        <p className="detail-empty">No multi-kill battles found in the current recent-activity window.</p>
      ) : (
        <div className="battle-report-list">
          {battles.map((battle) => {
            const topCorps = [...battle.involvedCorps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
            const expanded = expandedId === battle.id;
            return (
              <div key={battle.id} className="battle-report-card">
                <button type="button" className="battle-report-header" onClick={() => setExpandedId(expanded ? null : battle.id)}>
                  <Swords size={15} strokeWidth={2} className="battle-report-icon" />
                  <span className="battle-report-system">
                    {battle.systemName}
                    {battle.systemSecurity != null && (
                      <span className="battle-report-security" style={{ color: securityColor(battle.systemSecurity) }}>
                        {formatSecurity(battle.systemSecurity)}
                      </span>
                    )}
                  </span>
                  <span className="battle-report-stats">
                    {battle.kills.length} kills · {formatIsk(battle.totalValue)} destroyed
                  </span>
                  <span className="battle-report-time">
                    {formatExactTime(battle.startTime)} - {formatExactTime(battle.endTime)}
                  </span>
                </button>
                <div className="battle-report-corps">
                  {topCorps.map(([name, count]) => (
                    <span key={name} className="data-table-tag data-table-tag-neutral">
                      {name} ({count})
                    </span>
                  ))}
                  {battle.involvedCorps.size > topCorps.length && (
                    <span className="battle-report-more-corps">+{battle.involvedCorps.size - topCorps.length} more</span>
                  )}
                </div>
                {expanded && (
                  <KillFeedTable
                    kills={battle.kills}
                    onSelectKill={onSelectKill}
                    onSelectCharacter={onSelectCharacter}
                    onSelectSystem={onSelectSystem}
                    onSelectCorporation={onSelectCorporation}
                    onSelectAlliance={onSelectAlliance}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default BattleReportsFeed;
