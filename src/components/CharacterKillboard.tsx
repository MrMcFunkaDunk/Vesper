import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  getCharacterProfile,
  getCharacterKills,
  getCharacterLosses,
  getCharacterStats,
  type CharacterProfile,
  type CharacterStats,
  type KillEntry,
} from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatIsk, formatPercent } from "../lib/format";
import KillFeedTable from "./KillFeedTable";

type KillboardTab = "kills" | "losses";

interface CharacterKillboardProps {
  characterId: number;
  onBack: () => void;
  onSelectKill: (killmailId: number) => void;
  onSelectCharacter: (characterId: number) => void;
  rootLabel: string;
  onGoHome: () => void;
}

function corpLogoUrl(id: number): string {
  return `https://images.evetech.net/corporations/${id}/logo?size=64`;
}

function allianceLogoUrl(id: number): string {
  return `https://images.evetech.net/alliances/${id}/logo?size=64`;
}

function CharacterKillboard({
  characterId,
  onBack,
  onSelectKill,
  onSelectCharacter,
  rootLabel,
  onGoHome,
}: CharacterKillboardProps) {
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [stats, setStats] = useState<CharacterStats | null>(null);
  const [tab, setTab] = useState<KillboardTab>("kills");
  const [kills, setKills] = useState<KillEntry[] | null>(null);
  const [losses, setLosses] = useState<KillEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const reportError = useErrorReporter();

  useEffect(() => {
    setProfile(null);
    setStats(null);
    setKills(null);
    setLosses(null);
    setTab("kills");
    setLoading(true);

    getCharacterProfile(characterId)
      .then(setProfile)
      .catch((err) => reportError(`Failed to load character profile: ${String(err)}`));

    getCharacterStats(characterId)
      .then(setStats)
      .catch((err) => reportError(`Failed to load character stats: ${String(err)}`));

    getCharacterKills(characterId)
      .then(setKills)
      .catch((err) => reportError(`Failed to load kills: ${String(err)}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  function handleTabChange(next: KillboardTab) {
    setTab(next);
    if (next === "losses" && losses === null) {
      setLoading(true);
      getCharacterLosses(characterId)
        .then(setLosses)
        .catch((err) => reportError(`Failed to load losses: ${String(err)}`))
        .finally(() => setLoading(false));
    }
  }

  const activeList = tab === "kills" ? kills : losses;

  return (
    <main className="main main-kills">
      <div className="kills-page">
        <div className="kills-header kills-header-breadcrumb">
          <p className="eyebrow">Kills & Intel</p>
          <h2
            className="kills-breadcrumb-link"
            role="button"
            tabIndex={0}
            onClick={onGoHome}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onGoHome();
              }
            }}
          >
            {rootLabel}
          </h2>
        </div>

        <button type="button" className="detail-back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2} />
          Back
        </button>

        {!profile ? (
          <p className="detail-empty">Loading character...</p>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-avatar">
                <img
                  className="detail-portrait"
                  src={`https://images.evetech.net/characters/${profile.character_id}/portrait?size=128`}
                  alt=""
                />
                <div className="detail-logo-stack">
                  <img
                    className="detail-logo"
                    src={corpLogoUrl(profile.corporation_id)}
                    alt=""
                    title={profile.corporation_name ?? undefined}
                  />
                  {profile.alliance_id && (
                    <img
                      className="detail-logo"
                      src={allianceLogoUrl(profile.alliance_id)}
                      alt=""
                      title={profile.alliance_name ?? undefined}
                    />
                  )}
                </div>
              </div>
              <div className="detail-identity">
                <h2>{profile.character_name}</h2>
                <span className="detail-corp">
                  {profile.corporation_name ?? "—"}
                  {profile.corporation_ticker ? ` [${profile.corporation_ticker}]` : ""}
                  {profile.alliance_name ? ` • ${profile.alliance_name}` : ""}
                  {profile.alliance_ticker ? ` <${profile.alliance_ticker}>` : ""}
                </span>
                <div className="detail-stats-row">
                  {profile.security_status != null && (
                    <span
                      className={
                        profile.security_status >= 0 ? "character-security-positive" : "character-security-negative"
                      }
                    >
                      Sec. Status: {profile.security_status.toFixed(2)}
                    </span>
                  )}
                  {profile.birthday && (
                    <>
                      <span className="detail-stats-sep">//</span>
                      <span>Since {new Date(profile.birthday).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {stats && (
              <div className="detail-panel">
                <p className="eyebrow">Stats (All-Time)</p>
                <div className="character-stats-table">
                  <div className="character-stats-row character-stats-header">
                    <span />
                    <span>Destroyed</span>
                    <span>Lost</span>
                    <span>Eff.</span>
                  </div>
                  <div className="character-stats-row">
                    <span className="character-stats-label">Ships</span>
                    <span className="character-stats-destroyed">{stats.ships_destroyed}</span>
                    <span className="character-stats-lost">{stats.ships_lost}</span>
                    <span>{formatPercent(stats.ships_destroyed, stats.ships_destroyed + stats.ships_lost)}</span>
                  </div>
                  <div className="character-stats-row">
                    <span className="character-stats-label">Points</span>
                    <span className="character-stats-destroyed">{stats.points_destroyed}</span>
                    <span className="character-stats-lost">{stats.points_lost}</span>
                    <span>{formatPercent(stats.points_destroyed, stats.points_destroyed + stats.points_lost)}</span>
                  </div>
                  <div className="character-stats-row">
                    <span className="character-stats-label">ISK</span>
                    <span className="character-stats-destroyed">{formatIsk(stats.isk_destroyed)}</span>
                    <span className="character-stats-lost">{formatIsk(stats.isk_lost)}</span>
                    <span>{formatPercent(stats.isk_destroyed, stats.isk_destroyed + stats.isk_lost)}</span>
                  </div>
                </div>
                <div className="character-stats-extra">
                  <span>Danger Ratio: {stats.danger_ratio}%</span>
                  <span className="detail-stats-sep">//</span>
                  <span>Solo Kills: {stats.solo_kills}</span>
                  <span className="detail-stats-sep">//</span>
                  <span>Solo Losses: {stats.solo_losses}</span>
                </div>
              </div>
            )}

            <div className="kills-tabs">
              <button
                type="button"
                className={`kills-tab ${tab === "kills" ? "kills-tab-active" : ""}`}
                onClick={() => handleTabChange("kills")}
              >
                Kills
              </button>
              <button
                type="button"
                className={`kills-tab ${tab === "losses" ? "kills-tab-active" : ""}`}
                onClick={() => handleTabChange("losses")}
              >
                Losses
              </button>
            </div>

            <div className="kills-feed">
              {loading && activeList === null ? (
                <p className="detail-empty">Loading {tab}...</p>
              ) : !activeList || activeList.length === 0 ? (
                <p className="detail-empty">No {tab} recorded.</p>
              ) : (
                <KillFeedTable kills={activeList} onSelectKill={onSelectKill} onSelectCharacter={onSelectCharacter} />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default CharacterKillboard;
