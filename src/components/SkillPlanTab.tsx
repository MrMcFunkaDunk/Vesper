import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronDown } from "lucide-react";
import {
  listPlans,
  getPlan,
  createPlan,
  renamePlan,
  deletePlan,
  addPlanEntries,
  updatePlanEntry,
  reorderPlanEntries,
  deletePlanEntry,
  type PlanSummary,
  type PlanDetail,
} from "../lib/skillPlans";
import type { AllSkillEntry, CharacterAttributes } from "../lib/eve";
import {
  spForLevelOnly,
  spPerHour,
  trainingSeconds,
  expandWithPrerequisites,
  optimizeRemap,
  requiredInjectors,
  BASE_ATTRIBUTE_VALUE,
  MAX_IMPLANT_BONUS,
  type PlannableSkill,
  type AttributeName,
  type AttributeSpread,
} from "../lib/skillTraining";
import { useErrorReporter } from "../hooks/useErrorReporter";

interface SkillPlanTabProps {
  characterId: number;
  allSkills: AllSkillEntry[] | null;
  trainedLevelBySkillId: Map<number, number>;
  attributes: CharacterAttributes | null;
  currentTotalSp: number | null;
}

const EMPTY_IMPLANT_BONUSES: Record<AttributeName, number> = {
  Charisma: 0,
  Intelligence: 0,
  Memory: 0,
  Perception: 0,
  Willpower: 0,
};

const PRIORITY_LABELS: Record<number, string> = { 1: "Highest", 2: "High", 3: "Normal", 4: "Low", 5: "Lowest" };

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function romanLevel(level: number): string {
  return ["", "I", "II", "III", "IV", "V"][level] ?? String(level);
}

function SkillPlanTab({ characterId, allSkills, trainedLevelBySkillId, attributes, currentTotalSp }: SkillPlanTabProps) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addingLevel, setAddingLevel] = useState<AllSkillEntry | null>(null);
  const [remapResult, setRemapResult] = useState<{ spread: AttributeSpread; totalSeconds: number } | null>(null);
  const [hypotheticalImplants, setHypotheticalImplants] = useState<Record<AttributeName, number>>(EMPTY_IMPLANT_BONUSES);
  const reportError = useErrorReporter();

  function reloadPlans(selectId?: string) {
    listPlans(characterId)
      .then((list) => {
        setPlans(list);
        if (selectId) setActivePlanId(selectId);
        else if (!activePlanId && list.length > 0) setActivePlanId(list[0].id);
      })
      .catch((err) => reportError(`Failed to load skill plans: ${String(err)}`));
  }

  useEffect(() => {
    reloadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  function reloadPlan() {
    if (!activePlanId) return;
    getPlan(activePlanId)
      .then(setPlan)
      .catch((err) => reportError(`Failed to load plan: ${String(err)}`));
  }

  useEffect(() => {
    if (!activePlanId) {
      setPlan(null);
      return;
    }
    reloadPlan();
    setRemapResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlanId]);

  // A stale recommendation is worse than none - remap points are rationed
  // (roughly once a year without a bonus remap), so showing a "saves X"
  // number computed against a skill set the plan no longer matches would be
  // actively misleading for a real decision. Re-running the optimizer is a
  // manual action (the button), this only clears the last result.
  useEffect(() => {
    setRemapResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.entries]);

  const skillsById = useMemo(() => {
    const map = new Map<number, PlannableSkill>();
    for (const s of allSkills ?? []) {
      map.set(s.skill_id, {
        skill_id: s.skill_id,
        name: s.name,
        rank: s.rank,
        primary_attribute: s.primary_attribute as AttributeName | null,
        secondary_attribute: s.secondary_attribute as AttributeName | null,
        prerequisites: s.prerequisites.map((p) => ({ skill_id: p.skill_id, level: p.level })),
      });
    }
    return map;
  }, [allSkills]);

  const plannedLevelsBySkillId = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const entry of plan?.entries ?? []) {
      const set = map.get(entry.skill_id) ?? new Set<number>();
      set.add(entry.level);
      map.set(entry.skill_id, set);
    }
    return map;
  }, [plan]);

  function isSatisfied(skillId: number, level: number): boolean {
    if ((trainedLevelBySkillId.get(skillId) ?? 0) >= level) return true;
    return plannedLevelsBySkillId.get(skillId)?.has(level) ?? false;
  }

  const searchResults =
    addQuery.trim().length < 2
      ? []
      : (allSkills ?? []).filter((s) => s.name.toLowerCase().includes(addQuery.trim().toLowerCase())).slice(0, 20);

  async function handleCreatePlan() {
    try {
      const id = await createPlan(characterId, `Plan ${(plans?.length ?? 0) + 1}`);
      reloadPlans(id);
    } catch (err) {
      reportError(`Failed to create plan: ${String(err)}`);
    }
  }

  async function handleRenamePlan(name: string) {
    if (!activePlanId || !name.trim()) return;
    try {
      await renamePlan(activePlanId, name.trim());
      reloadPlans(activePlanId);
    } catch (err) {
      reportError(`Failed to rename plan: ${String(err)}`);
    }
  }

  async function handleDeletePlan() {
    if (!activePlanId) return;
    try {
      await deletePlan(activePlanId);
      setActivePlanId(null);
      reloadPlans();
    } catch (err) {
      reportError(`Failed to delete plan: ${String(err)}`);
    }
  }

  async function handleAddSkillLevel(skill: AllSkillEntry, level: number) {
    if (!activePlanId) return;
    const expanded = expandWithPrerequisites(skill.skill_id, level, skillsById, isSatisfied);
    if (expanded.length === 0) return;
    try {
      await addPlanEntries(
        activePlanId,
        expanded.map((e) => ({ skill_id: e.skill_id, level: e.level, is_prerequisite: e.is_prerequisite })),
      );
      setAddQuery("");
      setAddOpen(false);
      setAddingLevel(null);
      reloadPlan();
    } catch (err) {
      reportError(`Failed to add to plan: ${String(err)}`);
    }
  }

  async function handleDeleteEntry(entryId: string) {
    if (!activePlanId) return;
    try {
      await deletePlanEntry(activePlanId, entryId);
      reloadPlan();
    } catch (err) {
      reportError(`Failed to remove plan entry: ${String(err)}`);
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!plan || !activePlanId) return;
    const target = index + direction;
    if (target < 0 || target >= plan.entries.length) return;
    const reordered = [...plan.entries];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setPlan({ ...plan, entries: reordered });
    try {
      await reorderPlanEntries(
        activePlanId,
        reordered.map((e) => e.id),
      );
    } catch (err) {
      reportError(`Failed to reorder plan: ${String(err)}`);
      reloadPlan();
    }
  }

  async function handlePriorityChange(entryId: string, priority: number, notes: string) {
    if (!activePlanId) return;
    try {
      await updatePlanEntry(activePlanId, entryId, priority, notes);
      reloadPlan();
    } catch (err) {
      reportError(`Failed to update plan entry: ${String(err)}`);
    }
  }

  // Base (post-remap, no implants) attribute value lookup by name - shared
  // by the main time computation and the implant-preview calculator below,
  // which adds a hypothetical bonus on top of the same base.
  function baseAttrValue(name: AttributeName): number {
    if (!attributes) return 0;
    switch (name) {
      case "Charisma":
        return attributes.charisma;
      case "Intelligence":
        return attributes.intelligence;
      case "Memory":
        return attributes.memory;
      case "Perception":
        return attributes.perception;
      case "Willpower":
        return attributes.willpower;
    }
  }

  // Cascading times: each entry's training starts the instant the previous
  // one finishes, in plan order (sort_order) - matches how the real skill
  // queue and both reference tools compute plan ETAs.
  const computed = useMemo(() => {
    let cumulativeSeconds = 0;
    return (plan?.entries ?? []).map((entry) => {
      const skill = skillsById.get(entry.skill_id);
      const rank = skill?.rank ?? 1;
      const spNeeded = spForLevelOnly(rank, entry.level);
      let rate = 0;
      if (skill?.primary_attribute && skill.secondary_attribute && attributes) {
        rate = spPerHour(baseAttrValue(skill.primary_attribute), baseAttrValue(skill.secondary_attribute));
      }
      const seconds = trainingSeconds(spNeeded, rate) ?? 0;
      cumulativeSeconds += seconds;
      return { entry, skill, spNeeded, seconds, cumulativeSeconds };
    });
  }, [plan, skillsById, attributes]);

  const totalSeconds = computed.length > 0 ? computed[computed.length - 1].cumulativeSeconds : 0;
  const totalSp = computed.reduce((sum, c) => sum + c.spNeeded, 0);

  // "What if I had these implants" preview - hypothetical bonuses on top of
  // the same base attributes computed uses, not tied to any implant actually
  // owned. Recomputed inline (not memoized) since it only runs when the
  // small implant-bonus inputs change, which is cheap for a plan-sized list.
  const implantPreviewSeconds = (plan?.entries ?? []).reduce((sum, entry) => {
    const skill = skillsById.get(entry.skill_id);
    if (!skill?.primary_attribute || !skill.secondary_attribute) return sum;
    const rank = skill.rank;
    const spNeeded = spForLevelOnly(rank, entry.level);
    const primary = baseAttrValue(skill.primary_attribute) + hypotheticalImplants[skill.primary_attribute];
    const secondary = baseAttrValue(skill.secondary_attribute) + hypotheticalImplants[skill.secondary_attribute];
    return sum + (trainingSeconds(spNeeded, spPerHour(primary, secondary)) ?? 0);
  }, 0);

  const injectorsNeeded = currentTotalSp != null && totalSp > 0 ? requiredInjectors(currentTotalSp, totalSp) : null;

  function handleOptimizeRemap() {
    const candidateSkills = computed.map(({ skill, spNeeded }) => ({
      rank: skill?.rank ?? 1,
      spNeeded,
      primary_attribute: skill?.primary_attribute ?? null,
      secondary_attribute: skill?.secondary_attribute ?? null,
    }));
    setRemapResult(optimizeRemap(candidateSkills));
  }

  return (
    <div className="skill-plan-tab">
      <div className="detail-panel-header">
        <p className="eyebrow">Skill Plan</p>
        <div className="skill-plan-selector">
          {plans && plans.length > 0 && (
            <select value={activePlanId ?? ""} onChange={(e) => setActivePlanId(e.target.value)} className="skill-plan-select">
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.entry_count})
                </option>
              ))}
            </select>
          )}
          <button type="button" className="skill-action-btn" onClick={handleCreatePlan}>
            <Plus size={13} strokeWidth={2} /> New Plan
          </button>
          {activePlanId && (
            <>
              <button type="button" className="skill-action-btn" onClick={() => handleRenamePlan(prompt("Plan name:", plan?.name) ?? "")}>
                Rename
              </button>
              <button type="button" className="skill-action-btn skill-action-btn-danger" onClick={handleDeletePlan}>
                Delete Plan
              </button>
            </>
          )}
        </div>
      </div>

      {!plans ? (
        <p className="detail-empty">Loading plans...</p>
      ) : !activePlanId ? (
        <p className="detail-empty">Create a plan to start planning skills you haven't queued in-game yet.</p>
      ) : (
        <>
          <div className="skill-plan-add">
            <div className="detail-search skill-plan-add-search">
              <input
                type="text"
                placeholder="Search a skill to add..."
                value={addQuery}
                onChange={(e) => {
                  setAddQuery(e.target.value);
                  setAddOpen(true);
                  setAddingLevel(null);
                }}
                onFocus={() => setAddOpen(true)}
              />
              <ChevronDown size={13} strokeWidth={2} />
            </div>
            {addOpen && searchResults.length > 0 && !addingLevel && (
              <div className="gatecheck-slot-results skill-plan-add-suggestions">
                {searchResults.map((s) => (
                  <button key={s.skill_id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setAddingLevel(s)}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            {addingLevel && (
              <div className="skill-plan-level-picker">
                <span>{addingLevel.name} to level:</span>
                {[1, 2, 3, 4, 5].map((lvl) => {
                  const trained = trainedLevelBySkillId.get(addingLevel.skill_id) ?? 0;
                  const disabled = trained >= lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      disabled={disabled}
                      className="skill-plan-level-btn"
                      onClick={() => handleAddSkillLevel(addingLevel, lvl)}
                    >
                      {romanLevel(lvl)}
                    </button>
                  );
                })}
                <button type="button" className="skill-action-btn" onClick={() => setAddingLevel(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>

          {!plan || !allSkills ? (
            <p className="detail-empty">Loading plan...</p>
          ) : plan.entries.length === 0 ? (
            <p className="detail-empty">No skills planned yet - search above to add one.</p>
          ) : (
            <>
              <div className="skill-plan-list">
                {computed.map(({ entry, skill, spNeeded, seconds, cumulativeSeconds }, index) => (
                  <div key={entry.id} className={`skill-plan-row${entry.is_prerequisite ? " skill-plan-row-prereq" : ""}`}>
                    <span className="skill-plan-position">{index + 1}</span>
                    <div className="skill-plan-main">
                      <span className="skill-plan-name">
                        {skill?.name ?? `Skill #${entry.skill_id}`} {romanLevel(entry.level)}
                        {entry.is_prerequisite && <span className="skill-plan-prereq-tag">prerequisite</span>}
                      </span>
                      <span className="skill-plan-meta">
                        {spNeeded.toLocaleString()} SP · {formatDuration(seconds)} · ends in {formatDuration(cumulativeSeconds)}
                      </span>
                    </div>
                    <select
                      className="skill-plan-priority-select"
                      value={entry.priority}
                      onChange={(e) => handlePriorityChange(entry.id, Number(e.target.value), entry.notes)}
                      title="Priority"
                    >
                      {[1, 2, 3, 4, 5].map((p) => (
                        <option key={p} value={p}>
                          {PRIORITY_LABELS[p]}
                        </option>
                      ))}
                    </select>
                    <div className="skill-plan-row-actions">
                      <button type="button" onClick={() => handleMove(index, -1)} disabled={index === 0} title="Move up">
                        <ArrowUp size={12} strokeWidth={2} />
                      </button>
                      <button type="button" onClick={() => handleMove(index, 1)} disabled={index === computed.length - 1} title="Move down">
                        <ArrowDown size={12} strokeWidth={2} />
                      </button>
                      <button type="button" onClick={() => handleDeleteEntry(entry.id)} title="Remove from plan">
                        <Trash2 size={12} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="skill-plan-footer">
                <span>
                  <strong>{plan.entries.length}</strong> skills planned
                </span>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  <strong>{totalSp.toLocaleString()}</strong> SP needed
                </span>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Total time: <strong>{formatDuration(totalSeconds)}</strong>
                </span>
                {injectorsNeeded != null && (
                  <>
                    <span className="skill-queue-footer-sep">|</span>
                    <span title="Large skill injectors, used one after another - the SP-per-injector yield drops as your total SP climbs, so this accounts for the bracket shifting mid-way">
                      Or <strong>{injectorsNeeded}</strong> injector{injectorsNeeded === 1 ? "" : "s"}
                    </span>
                  </>
                )}
                <span className="skill-queue-footer-sep">|</span>
                <button type="button" className="skill-action-btn" onClick={handleOptimizeRemap}>
                  Optimize Remap
                </button>
              </div>

              <div className="skill-plan-implant-calc">
                <p className="wh-side-label">Implant Calculator</p>
                <p className="skill-plan-remap-note">Try hypothetical implant bonuses (not what's actually fitted) and see the time impact on this plan.</p>
                <div className="attribute-row">
                  {(
                    [
                      ["Int", "Intelligence"],
                      ["Per", "Perception"],
                      ["Cha", "Charisma"],
                      ["Wil", "Willpower"],
                      ["Mem", "Memory"],
                    ] as const
                  ).map(([label, name]) => (
                    <label key={name} className="skill-plan-implant-input">
                      {label}
                      <input
                        type="number"
                        min={0}
                        max={MAX_IMPLANT_BONUS}
                        value={hypotheticalImplants[name]}
                        onChange={(e) =>
                          setHypotheticalImplants((prev) => ({
                            ...prev,
                            [name]: Math.max(0, Math.min(MAX_IMPLANT_BONUS, Number(e.target.value) || 0)),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
                {Object.values(hypotheticalImplants).some((v) => v > 0) && (
                  <p className="skill-plan-remap-note">
                    New total: <strong>{formatDuration(implantPreviewSeconds)}</strong> (
                    {implantPreviewSeconds <= totalSeconds ? "saves " : "adds "}
                    <strong>{formatDuration(Math.abs(totalSeconds - implantPreviewSeconds))}</strong>)
                  </p>
                )}
              </div>

              {remapResult && (
                <div className="skill-plan-remap-result">
                  <p className="wh-side-label">Recommended Remap</p>
                  <p className="skill-plan-remap-note">
                    Best attribute split for this plan (base only, implants not factored in) - saves{" "}
                    <strong>{formatDuration(Math.max(0, totalSeconds - remapResult.totalSeconds))}</strong> vs your current
                    attributes.
                  </p>
                  <div className="attribute-row">
                    {(
                      [
                        ["Int", remapResult.spread.Intelligence],
                        ["Per", remapResult.spread.Perception],
                        ["Cha", remapResult.spread.Charisma],
                        ["Wil", remapResult.spread.Willpower],
                        ["Mem", remapResult.spread.Memory],
                      ] as const
                    ).map(([label, points]) => (
                      <span key={label} className="attribute-pill">
                        {label} <strong>{BASE_ATTRIBUTE_VALUE + points}</strong>
                        {points > 0 && <span className="skill-plan-remap-plus"> (+{points})</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default SkillPlanTab;
