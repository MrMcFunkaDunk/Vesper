import { useEffect, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import {
  getCharacterOverview,
  getCharacterSkills,
  type CharacterOverview,
  type CharacterSkills,
  type SessionCharacter,
} from "../lib/eve";
import { formatIsk, formatSp, formatTimeRemaining } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";

interface CharacterDetailProps {
  character: SessionCharacter;
  onBack: () => void;
}

function SkillLevelPips({ level }: { level: number }) {
  return (
    <span className="skill-pips" aria-label={`Level ${level}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={`skill-pip${n <= level ? " skill-pip-filled" : ""}`} />
      ))}
    </span>
  );
}

function CharacterDetail({ character, onBack }: CharacterDetailProps) {
  const [overview, setOverview] = useState<CharacterOverview | null>(null);
  const [skills, setSkills] = useState<CharacterSkills | null>(null);
  const [query, setQuery] = useState("");
  const reportError = useErrorReporter();

  useEffect(() => {
    setOverview(null);
    setSkills(null);
    setQuery("");
    getCharacterOverview(character.id)
      .then(setOverview)
      .catch((err) => reportError(`Failed to load overview for ${character.name}: ${String(err)}`));
    getCharacterSkills(character.id)
      .then(setSkills)
      .catch((err) => reportError(`Failed to load skills for ${character.name}: ${String(err)}`));
  }, [character.id, character.name]);

  const filteredSkills = skills?.skills.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())) ?? [];

  return (
    <main className="main main-detail">
      <div className="detail">
        <button type="button" className="detail-back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2} />
          Back to Operations Overview
        </button>

        <div className="detail-header">
          <img className="detail-portrait" src={character.portrait_url} alt="" />
          <div className="detail-identity">
            <h2>{character.name}</h2>
            <span className="detail-corp">
              {overview?.corporation_name ?? "—"}
              {overview?.alliance_name ? ` • ${overview.alliance_name}` : ""}
            </span>
            <div className="detail-stats-row">
              <span>{overview?.isk_balance != null ? formatIsk(overview.isk_balance) : "—"}</span>
              <span className="detail-stats-sep">//</span>
              <span>{overview?.total_sp != null ? formatSp(overview.total_sp) : "—"}</span>
              <span className="detail-stats-sep">//</span>
              <span>{[overview?.system_name, overview?.ship_type_name].filter(Boolean).join(" · ") || "—"}</span>
            </div>
            {overview?.training_skill_name && (
              <span className="detail-training">
                Training: {overview.training_skill_name}
                {overview.training_finish_date ? ` (${formatTimeRemaining(overview.training_finish_date)})` : ""}
              </span>
            )}
          </div>
        </div>

        <div className="detail-panel">
          <div className="detail-panel-header">
            <p className="eyebrow">Skills</p>
            <div className="detail-search">
              <Search size={13} strokeWidth={2} />
              <input
                type="text"
                placeholder="Search skills..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {!skills ? (
            <p className="detail-empty">Loading skills...</p>
          ) : skills.needs_reauth ? (
            <p className="detail-empty">Sign in again to unlock skill data for this character.</p>
          ) : filteredSkills.length === 0 ? (
            <p className="detail-empty">No skills match "{query}".</p>
          ) : (
            <div className="skill-list">
              {filteredSkills.map((skill) => (
                <div key={skill.skill_id} className="skill-row">
                  <span className="skill-name">{skill.name}</span>
                  <SkillLevelPips level={skill.trained_level} />
                  <span className="skill-sp">{new Intl.NumberFormat("en-US").format(skill.skillpoints)} SP</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default CharacterDetail;
