import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { getCharacterSkills, getAllSkills, type AllSkillEntry, type SessionCharacter } from "../lib/eve";
import { useErrorReporter } from "../hooks/useErrorReporter";

interface CharacterComparisonViewProps {
  characters: SessionCharacter[];
  onClose: () => void;
}

/** Every character's skill_id -> trained_level map, fetched once per character (same getCharacterSkills call CharacterDetail's Skills tab already uses). */
function useComparisonSkills(characters: SessionCharacter[]) {
  const [byCharacter, setByCharacter] = useState<Record<number, Map<number, number>>>({});
  const [loading, setLoading] = useState(true);
  const reportError = useErrorReporter();

  useEffect(() => {
    setLoading(true);
    Promise.allSettled(characters.map((c) => getCharacterSkills(c.id).then((s) => [c.id, s] as const)))
      .then((results) => {
        const next: Record<number, Map<number, number>> = {};
        let failed = 0;
        for (const r of results) {
          if (r.status === "fulfilled") {
            const [id, skills] = r.value;
            next[id] = new Map(skills.skills.map((s) => [s.skill_id, s.trained_level]));
          } else {
            failed++;
          }
        }
        if (failed > 0) reportError(`Failed to load skills for ${failed} character${failed === 1 ? "" : "s"}.`);
        setByCharacter(next);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters.map((c) => c.id).join(",")]);

  return { byCharacter, loading };
}

function CharacterComparisonView({ characters, onClose }: CharacterComparisonViewProps) {
  const [allSkills, setAllSkills] = useState<AllSkillEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const reportError = useErrorReporter();
  const { byCharacter, loading } = useComparisonSkills(characters);

  useEffect(() => {
    getAllSkills()
      .then(setAllSkills)
      .catch((err) => reportError(`Failed to load full skill list: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    const filtered = (allSkills ?? []).filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()));
    const grouped = new Map<string, AllSkillEntry[]>();
    for (const s of filtered) {
      // Only skills at least one character actually has - an all-untrained
      // row (every character skips the same skill) adds nothing to compare.
      const anyTrained = characters.some((c) => (byCharacter[c.id]?.get(s.skill_id) ?? 0) > 0);
      if (!anyTrained) continue;
      const arr = grouped.get(s.group_name) ?? [];
      arr.push(s);
      grouped.set(s.group_name, arr);
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [allSkills, query, byCharacter, characters]);

  return (
    <main className="main main-dashboard">
      <div className="dashboard character-comparison">
        <div className="dashboard-header">
          <button type="button" className="detail-back" onClick={onClose}>
            <ArrowLeft size={14} strokeWidth={2} /> Back to Operations Overview
          </button>
          <p className="eyebrow">Character Comparison</p>
          <h2>Skills Across Your Characters</h2>
        </div>

        <div className="detail-search comparison-search">
          <Search size={13} strokeWidth={2} />
          <input type="text" placeholder="Search skills..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {loading || !allSkills ? (
          <p className="detail-empty">Loading skills for {characters.length} characters...</p>
        ) : rows.length === 0 ? (
          <p className="detail-empty">No trained skills match "{query}".</p>
        ) : (
          <div className="data-table-wrap comparison-table-wrap">
            <table className="data-table comparison-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  {characters.map((c) => (
                    <th key={c.id} className="data-table-numeric">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([groupName, groupSkills]) => (
                  <Fragment key={groupName}>
                    <tr className="comparison-group-row">
                      <td colSpan={characters.length + 1}>{groupName}</td>
                    </tr>
                    {groupSkills.map((skill) => {
                      const levels = characters.map((c) => byCharacter[c.id]?.get(skill.skill_id) ?? 0);
                      const max = Math.max(...levels);
                      const min = Math.min(...levels);
                      return (
                        <tr key={skill.skill_id}>
                          <td>{skill.name}</td>
                          {levels.map((level, i) => (
                            <td
                              key={characters[i].id}
                              className={`data-table-numeric ${
                                level === max && max !== min ? "comparison-cell-max" : level === min && max !== min ? "comparison-cell-min" : ""
                              }`}
                            >
                              {level > 0 ? level : "—"}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

export default CharacterComparisonView;
