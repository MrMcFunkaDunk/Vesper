import { useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Send, Save, Trash2, ChevronDown, Check, X, Swords } from "lucide-react";
import { isCombatOverlayOpen, openCombatOverlay, closeCombatOverlay } from "../lib/combatOverlay";
import { exportFitEft, exportFitDna, type Fit, type FitItem } from "../lib/fittings";
import {
  searchMarketTypes,
  getMarketGroups,
  getMarketGroupTypes,
  getShipStats,
  getItemResourceCosts,
  getSkillRequirementsBulk,
  type TypeSearchMatch,
  type TypeSummary,
  type MarketGroupNode,
  type ShipStats,
  type ItemResourceCost,
  type SkillRequirement,
} from "../lib/market";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import { CategoryTreeNode } from "./MarketBrowser";
import { getCharacterSkills, type SessionCharacter, type SkillEntry } from "../lib/eve";

const PURPOSES = ["PvP", "PvE", "Exploring", "Industry", "Mining", "Mission", "Other"];

/** One slot rack, in the order this app already sorts fit items by
 * (flag_sort_key in fittings.rs) - unchanged from before, only the row
 * count per rack is now real instead of unbounded. Tint colors converted
 * from PYFA's own config.py slotColourMap. */
const SLOT_DEFS: { prefix: string; label: string; countKey: keyof ShipStats; slotType: string; tintClass: string }[] = [
  { prefix: "LoSlot", label: "Low Power", countKey: "low_slots", slotType: "low", tintClass: "fit-rack-low" },
  { prefix: "MedSlot", label: "Mid Power", countKey: "mid_slots", slotType: "mid", tintClass: "fit-rack-mid" },
  { prefix: "HiSlot", label: "High Power", countKey: "hi_slots", slotType: "high", tintClass: "fit-rack-high" },
  { prefix: "RigSlot", label: "Rig Slots", countKey: "rig_slots", slotType: "rig", tintClass: "" },
  { prefix: "SubSystemSlot", label: "Subsystems", countKey: "subsystem_slots", slotType: "subsystem", tintClass: "" },
];

function TypeSearchBox({ placeholder, onPick }: { placeholder: string; onPick: (match: TypeSearchMatch) => void }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMarketTypes(trimmed)
        .then((results) => {
          if (cancelled) return;
          setSuggestions(results);
          setOpen(results.length > 0);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="kills-add-combobox fittings-search-combobox">
      <input
        type="text"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        autoFocus
      />
      {open && (
        <div className="gatecheck-slot-results kills-add-suggestions">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(s);
                setQuery("");
                setOpen(false);
              }}
            >
              <img src={typeIconUrl(s.id)} alt="" className="market-browser-row-icon" />
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceGauge({ label, used, total, unit }: { label: string; used: number; total: number; unit?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const over = total > 0 && used > total;
  return (
    <div className="fit-gauge">
      <div className="fit-gauge-labels">
        <span>{label}</span>
        <span className={over ? "fit-gauge-value-over" : "fit-gauge-value"}>
          {used.toLocaleString(undefined, { maximumFractionDigits: 1 })} / {total.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          {unit}
        </span>
      </div>
      <div className="fit-gauge-track">
        <div className={`fit-gauge-fill${over ? " fit-gauge-fill-over" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface FitBuilderProps {
  characters: SessionCharacter[];
  draft: Fit;
  setDraft: React.Dispatch<React.SetStateAction<Fit>>;
  nameFor: (typeId: number) => string;
  onRegisterName: (typeId: number, name: string) => void;
  priceById: Map<number, number>;
  sendCharacterId: number | null;
  setSendCharacterId: (id: number) => void;
  saving: boolean;
  sending: boolean;
  sendMessage: string | null;
  onSave: () => void;
  onSendToCharacter: () => void;
}

function computeCost(fit: Fit, priceById: Map<number, number>): number {
  let total = priceById.get(fit.ship_type_id) ?? 0;
  for (const item of fit.items) total += (priceById.get(item.type_id) ?? 0) * item.quantity;
  return total;
}

function FitBuilder({
  characters,
  draft,
  setDraft,
  nameFor,
  onRegisterName,
  priceById,
  sendCharacterId,
  setSendCharacterId,
  saving,
  sending,
  sendMessage,
  onSave,
  onSendToCharacter,
}: FitBuilderProps) {
  const reportError = useErrorReporter();
  const [copied, setCopied] = useState<string | null>(null);
  const [shipStats, setShipStats] = useState<ShipStats | null>(null);
  const [resourceCosts, setResourceCosts] = useState<Map<number, ItemResourceCost>>(new Map());
  const [openFlag, setOpenFlag] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["resources", "price"]));

  const [marketGroups, setMarketGroups] = useState<MarketGroupNode[] | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<number>>(new Set());
  const [groupTypesCache, setGroupTypesCache] = useState<Record<number, TypeSummary[]>>({});

  const [skillRequirements, setSkillRequirements] = useState<Map<number, SkillRequirement[]>>(new Map());

  // One unified flyability/doctrine system: "Check Doctrine" lists every
  // logged-in character's pass/fail against the whole fit (fetched lazily,
  // only once the section is opened), and clicking a row focuses that
  // character - which is also what drives the per-slot/per-ship ✓/✗
  // badges elsewhere in the builder. No separate "pick a character"
  // control needed; the doctrine list itself is that control.
  const [checkCharacterId, setCheckCharacterId] = useState<number | null>(null);
  const [doctrineSkills, setDoctrineSkills] = useState<Map<number, SkillEntry[]>>(new Map());
  const [doctrineLoading, setDoctrineLoading] = useState<Set<number>>(new Set());

  const [combatOverlayOn, setCombatOverlayOn] = useState(false);

  useEffect(() => {
    isCombatOverlayOpen()
      .then(setCombatOverlayOn)
      .catch(() => {});
  }, []);

  async function handleToggleCombatOverlay() {
    try {
      if (combatOverlayOn) {
        await closeCombatOverlay();
        setCombatOverlayOn(false);
      } else {
        await openCombatOverlay();
        setCombatOverlayOn(true);
      }
    } catch (err) {
      reportError(`Failed to ${combatOverlayOn ? "close" : "open"} the combat overlay: ${String(err)}`);
    }
  }

  useEffect(() => {
    getMarketGroups()
      .then(setMarketGroups)
      .catch((err) => reportError(`Failed to load the market group tree: ${err}`));
  }, [reportError]);

  useEffect(() => {
    if (!draft.ship_type_id) {
      setShipStats(null);
      return;
    }
    let cancelled = false;
    getShipStats(draft.ship_type_id)
      .then((s) => {
        if (!cancelled) setShipStats(s);
      })
      .catch((err) => reportError(`Failed to load ship stats: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [draft.ship_type_id, reportError]);

  const distinctItemTypeIds = useMemo(() => Array.from(new Set(draft.items.map((i) => i.type_id))), [draft.items]);

  useEffect(() => {
    if (distinctItemTypeIds.length === 0) {
      setResourceCosts(new Map());
      return;
    }
    let cancelled = false;
    getItemResourceCosts(distinctItemTypeIds)
      .then((costs) => {
        if (!cancelled) setResourceCosts(costs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Refetch only when the *set* of distinct items changes, not on every quantity tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distinctItemTypeIds.join(",")]);

  const allTypeIdsForSkillCheck = useMemo(() => {
    const ids = new Set(distinctItemTypeIds);
    if (draft.ship_type_id) ids.add(draft.ship_type_id);
    return Array.from(ids);
  }, [distinctItemTypeIds, draft.ship_type_id]);

  useEffect(() => {
    if (allTypeIdsForSkillCheck.length === 0) {
      setSkillRequirements(new Map());
      return;
    }
    let cancelled = false;
    getSkillRequirementsBulk(allTypeIdsForSkillCheck)
      .then((reqs) => {
        if (!cancelled) setSkillRequirements(reqs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTypeIdsForSkillCheck.join(",")]);

  /** null = nothing to show (no character focused via the doctrine list
   * yet, or this item has no prerequisite skills at all) - anything else
   * is a real pass/fail against the focused character's trained skills. */
  function flyabilityFor(typeId: number): { ok: boolean; missing: { name: string; need: number; have: number }[] } | null {
    if (checkCharacterId == null) return null;
    const skills = doctrineSkills.get(checkCharacterId);
    if (!skills) return null;
    const reqs = skillRequirements.get(typeId);
    if (!reqs || reqs.length === 0) return null;
    const trainedById = new Map(skills.map((s) => [s.skill_id, s.trained_level]));
    const missing = reqs
      .filter((r) => (trainedById.get(r.skill_type_id) ?? 0) < r.level)
      .map((r) => ({ name: r.skill_name, need: r.level, have: trainedById.get(r.skill_type_id) ?? 0 }));
    return { ok: missing.length === 0, missing };
  }

  useEffect(() => {
    if (!expandedSections.has("doctrine")) return;
    const missing = characters.filter((c) => !doctrineSkills.has(c.id) && !doctrineLoading.has(c.id));
    if (missing.length === 0) return;
    setDoctrineLoading((prev) => new Set([...prev, ...missing.map((c) => c.id)]));
    for (const c of missing) {
      getCharacterSkills(c.id)
        .then((result) => {
          setDoctrineSkills((prev) => new Map(prev).set(c.id, result.needs_reauth ? [] : result.skills));
        })
        .catch(() => {
          setDoctrineSkills((prev) => new Map(prev).set(c.id, []));
        })
        .finally(() => {
          setDoctrineLoading((prev) => {
            const next = new Set(prev);
            next.delete(c.id);
            return next;
          });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedSections, characters]);

  /** "loading" while that character's skills are in flight, null before
   * the section's ever been opened, otherwise a real pass/fail against
   * every skill this fit (hull + every fitted item) requires - including
   * exactly which skills are short, for the row's hover tooltip. */
  function doctrineStatusFor(characterId: number): "loading" | { ok: boolean; missing: { name: string; need: number; have: number }[] } | null {
    if (doctrineLoading.has(characterId)) return "loading";
    const skills = doctrineSkills.get(characterId);
    if (!skills) return null;
    const trainedById = new Map(skills.map((s) => [s.skill_id, s.trained_level]));
    const missing: { name: string; need: number; have: number }[] = [];
    const seen = new Set<string>();
    for (const typeId of allTypeIdsForSkillCheck) {
      for (const r of skillRequirements.get(typeId) ?? []) {
        const have = trainedById.get(r.skill_type_id) ?? 0;
        if (have < r.level && !seen.has(r.skill_name)) {
          seen.add(r.skill_name);
          missing.push({ name: r.skill_name, need: r.level, have });
        }
      }
    }
    return { ok: missing.length === 0, missing };
  }

  function flyabilityBadge(typeId: number) {
    const status = flyabilityFor(typeId);
    if (!status) return null;
    const title = status.ok
      ? "Every required skill is trained to level."
      : `Missing: ${status.missing.map((m) => `${m.name} ${m.need} (have ${m.have})`).join(", ")}`;
    return (
      <span className={`fit-flyability-badge ${status.ok ? "fit-flyability-ok" : "fit-flyability-missing"}`} title={title}>
        {status.ok ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
      </span>
    );
  }

  function toggleGroup(group: MarketGroupNode) {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(group.id)) {
        next.delete(group.id);
      } else {
        next.add(group.id);
        if (!groupTypesCache[group.id] && group.has_types) {
          getMarketGroupTypes(group.id)
            .then((types) => setGroupTypesCache((cache) => ({ ...cache, [group.id]: types })))
            .catch(() => {});
        }
      }
      return next;
    });
  }

  const groupChildrenByParent = useMemo(() => {
    const map = new Map<number | null, MarketGroupNode[]>();
    for (const g of marketGroups ?? []) {
      const list = map.get(g.parent_id) ?? [];
      list.push(g);
      map.set(g.parent_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [marketGroups]);

  function firstEmptyFlag(def: (typeof SLOT_DEFS)[number]): string | null {
    const count = shipStats?.[def.countKey] ?? 0;
    for (let i = 0; i < count; i++) {
      const flag = `${def.prefix}${i}`;
      if (!draft.items.some((it) => it.flag === flag)) return flag;
    }
    return null;
  }

  function setSlotItem(flag: string, typeId: number) {
    setDraft((prev) => ({ ...prev, items: [...prev.items.filter((it) => it.flag !== flag), { type_id: typeId, flag, quantity: 1 }] }));
    setOpenFlag(null);
  }

  function clearSlot(flag: string) {
    setDraft((prev) => ({ ...prev, items: prev.items.filter((it) => it.flag !== flag) }));
  }

  function addToFirstEmptySlot(slotType: string, typeId: number) {
    const def = SLOT_DEFS.find((d) => d.slotType === slotType);
    if (!def) {
      reportError("That item doesn't fit into a ship slot.");
      return;
    }
    const flag = firstEmptyFlag(def);
    if (!flag) {
      reportError(`No empty ${def.label.toLowerCase()} slots left.`);
      return;
    }
    setSlotItem(flag, typeId);
  }

  function addUnbounded(flag: "DroneBay" | "Cargo", typeId: number) {
    setDraft((prev) => {
      const existing = prev.items.find((i) => i.flag === flag && i.type_id === typeId);
      if (existing) {
        return { ...prev, items: prev.items.map((i) => (i === existing ? { ...i, quantity: i.quantity + 1 } : i)) };
      }
      return { ...prev, items: [...prev.items, { type_id: typeId, flag, quantity: 1 }] };
    });
  }

  function removeUnbounded(item: FitItem) {
    setDraft((prev) => ({ ...prev, items: prev.items.filter((i) => i !== item) }));
  }

  function toggleSection(id: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCopy(kind: "eft" | "dna", exportFn: () => Promise<string>) {
    try {
      const text = await exportFn();
      await writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch (err) {
      reportError(`Failed to copy ${kind.toUpperCase()}: ${String(err)}`);
    }
  }

  const draftCost = computeCost(draft, priceById);
  const droneItems = draft.items.filter((i) => i.flag === "DroneBay");
  const cargoItems = draft.items.filter((i) => i.flag === "Cargo");

  const poweredFlags = ["HiSlot", "MedSlot", "LoSlot"];
  const sumCost = (predicate: (item: FitItem) => boolean, pick: (c: ItemResourceCost) => number) =>
    draft.items.filter(predicate).reduce((sum, it) => sum + (resourceCosts.get(it.type_id) ? pick(resourceCosts.get(it.type_id)!) : 0) * it.quantity, 0);

  const powerUsed = sumCost((it) => poweredFlags.some((p) => it.flag.startsWith(p)), (c) => c.power);
  const cpuUsed = sumCost((it) => poweredFlags.some((p) => it.flag.startsWith(p)), (c) => c.cpu);
  const calibrationUsed = sumCost((it) => it.flag.startsWith("RigSlot"), (c) => c.calibration);
  const droneBayUsed = sumCost((it) => it.flag === "DroneBay", (c) => c.volume);
  const droneBandwidthUsed = sumCost((it) => it.flag === "DroneBay", (c) => c.drone_bandwidth);

  return (
    <div className="fit-builder-3pane">
      <div className="fit-builder-browser">
        <p className="fittings-slot-group-label">Item Browser</p>
        {marketGroups === null ? (
          <p className="detail-empty">Loading...</p>
        ) : (
          <div className="market-browser-tree">
            {(groupChildrenByParent.get(null) ?? []).map((g) => (
              <CategoryTreeNode
                key={g.id}
                group={g}
                depth={0}
                childrenByParent={groupChildrenByParent}
                expandedIds={expandedGroupIds}
                toggleExpand={toggleGroup}
                groupTypesCache={groupTypesCache}
                selectedTypeId={null}
                onPickType={(t) => {
                  onRegisterName(t.id, t.name);
                  if (t.slot_type) addToFirstEmptySlot(t.slot_type, t.id);
                  else reportError(`${t.name} isn't a fittable module - add it via Drones/Cargo below instead.`);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="fittings-builder-main">
        <div className="fittings-builder-ship">
          {draft.ship_type_id ? (
            <div className="fittings-builder-ship-picked">
              <img src={typeIconUrl(draft.ship_type_id, 64)} alt="" />
              <span>{nameFor(draft.ship_type_id)}</span>
              {flyabilityBadge(draft.ship_type_id)}
              <button
                type="button"
                className="fittings-ship-clear-btn"
                onClick={() => setDraft((p) => ({ ...p, ship_type_id: 0, items: [] }))}
                title="Clear this ship and search for a different one"
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <TypeSearchBox
              placeholder="Search for a ship..."
              onPick={(s) => {
                onRegisterName(s.id, s.name);
                setDraft((p) => ({ ...p, ship_type_id: s.id }));
              }}
            />
          )}
        </div>

        <div className="fittings-builder-fields">
          <input
            type="text"
            className="fittings-name-input"
            value={draft.name}
            onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
            placeholder="Fit name"
          />
          <select className="market-region-select" value={draft.purpose} onChange={(e) => setDraft((p) => ({ ...p, purpose: e.target.value }))}>
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="contracts-search-input"
            value={draft.tags.join(", ")}
            onChange={(e) => setDraft((p) => ({ ...p, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))}
            placeholder="Tags, comma separated"
          />
          <textarea
            className="price-checker-input fittings-description-input"
            value={draft.description}
            onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
            placeholder="Description (optional)"
            rows={2}
          />
        </div>

        {draft.ship_type_id > 0 && shipStats && (
          <>
            {SLOT_DEFS.map((def) => {
              const count = shipStats[def.countKey];
              if (count === 0) return null;
              return (
                <div key={def.prefix} className="fit-rack">
                  <p className={`fit-rack-header ${def.tintClass}`}>
                    {def.label} ({count})
                  </p>
                  <div className="fit-rack-rows">
                    {Array.from({ length: count }, (_, i) => `${def.prefix}${i}`).map((flag) => {
                      const item = draft.items.find((it) => it.flag === flag) ?? null;
                      if (item) {
                        return (
                          <div key={flag} className="fittings-slot-item">
                            <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                            <span>{nameFor(item.type_id)}</span>
                            {flyabilityBadge(item.type_id)}
                            <button type="button" onClick={() => clearSlot(flag)}>
                              <Trash2 size={12} strokeWidth={2} />
                            </button>
                          </div>
                        );
                      }
                      if (openFlag === flag) {
                        return (
                          <TypeSearchBox
                            key={flag}
                            placeholder="Search..."
                            onPick={(s) => {
                              onRegisterName(s.id, s.name);
                              setSlotItem(flag, s.id);
                            }}
                          />
                        );
                      }
                      return (
                        <button key={flag} type="button" className="fit-slot-empty" onClick={() => setOpenFlag(flag)}>
                          Empty {def.label.toLowerCase()} slot
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <div className="fit-rack">
              <p className="fit-rack-header">Drones</p>
              <div className="fittings-slot-list">
                {droneItems.map((item) => (
                  <div key={`${item.flag}-${item.type_id}`} className="fittings-slot-item">
                    <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                    <span>
                      {nameFor(item.type_id)} x{item.quantity}
                    </span>
                    {flyabilityBadge(item.type_id)}
                    <button type="button" onClick={() => removeUnbounded(item)}>
                      <Trash2 size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
              <TypeSearchBox
                placeholder="+ Add drone"
                onPick={(s) => {
                  onRegisterName(s.id, s.name);
                  addUnbounded("DroneBay", s.id);
                }}
              />
            </div>

            <div className="fit-rack">
              <p className="fit-rack-header">Cargo</p>
              <div className="fittings-slot-list">
                {cargoItems.map((item) => (
                  <div key={`${item.flag}-${item.type_id}`} className="fittings-slot-item">
                    <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                    <span>
                      {nameFor(item.type_id)} x{item.quantity}
                    </span>
                    <button type="button" onClick={() => removeUnbounded(item)}>
                      <Trash2 size={12} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
              <TypeSearchBox
                placeholder="+ Add cargo item"
                onPick={(s) => {
                  onRegisterName(s.id, s.name);
                  addUnbounded("Cargo", s.id);
                }}
              />
            </div>
          </>
        )}
      </div>

      <div className="fittings-builder-side">
        <div className="fit-section">
          <button type="button" className="fit-section-header" onClick={() => toggleSection("resources")}>
            <ChevronDown size={14} strokeWidth={2} className={expandedSections.has("resources") ? "" : "fit-section-chevron-closed"} />
            Resources
          </button>
          {expandedSections.has("resources") && shipStats && (
            <div className="fit-section-body">
              <ResourceGauge label="Powergrid" used={powerUsed} total={shipStats.power_output} unit=" MW" />
              <ResourceGauge label="CPU" used={cpuUsed} total={shipStats.cpu_output} unit=" tf" />
              <ResourceGauge label="Calibration" used={calibrationUsed} total={shipStats.calibration} />
              <ResourceGauge label="Drone Bay" used={droneBayUsed} total={shipStats.drone_bay_volume} unit=" m3" />
              <ResourceGauge label="Drone Bandwidth" used={droneBandwidthUsed} total={shipStats.drone_bandwidth} unit=" Mbit/s" />
            </div>
          )}
        </div>

        <div className="fit-section">
          <button type="button" className="fit-section-header" onClick={() => toggleSection("price")}>
            <ChevronDown size={14} strokeWidth={2} className={expandedSections.has("price") ? "" : "fit-section-chevron-closed"} />
            Price
          </button>
          {expandedSections.has("price") && (
            <div className="fit-section-body">
              <div className="fittings-cost-card">
                <span className="market-stat-label">Estimated Cost</span>
                <span className="market-stat-value market-stat-value-isk">{formatIsk(draftCost)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="fit-section">
          <button type="button" className="fit-section-header" onClick={() => toggleSection("doctrine")}>
            <ChevronDown size={14} strokeWidth={2} className={expandedSections.has("doctrine") ? "" : "fit-section-chevron-closed"} />
            Check Doctrine
          </button>
          {expandedSections.has("doctrine") && (
            <div className="fit-section-body">
              {characters.length === 0 ? (
                <p className="detail-empty">No characters logged in.</p>
              ) : !draft.ship_type_id ? (
                <p className="detail-empty">Pick a ship first.</p>
              ) : (
                <>
                  <p className="settings-section-hint">Click a character to see exactly which slots they can't use yet.</p>
                  <div className="fit-doctrine-list">
                    {characters.map((c) => {
                      const status = doctrineStatusFor(c.id);
                      const active = checkCharacterId === c.id;
                      const title =
                        status && status !== "loading" && !status.ok
                          ? `Missing: ${status.missing.map((m) => `${m.name} ${m.need} (have ${m.have})`).join(", ")}`
                          : undefined;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`fit-doctrine-row${active ? " fit-doctrine-row-active" : ""}`}
                          onClick={() => setCheckCharacterId(active ? null : c.id)}
                          title={title}
                        >
                          <img src={c.portrait_url} alt="" className="fit-doctrine-portrait" />
                          <span>{c.name}</span>
                          {status === "loading" ? (
                            <span className="fit-doctrine-status fit-doctrine-loading">Checking...</span>
                          ) : status === null ? null : status.ok ? (
                            <span className="fit-doctrine-status fit-doctrine-pass">
                              <Check size={12} strokeWidth={3} /> Can fly
                            </span>
                          ) : (
                            <span className="fit-doctrine-status fit-doctrine-fail">
                              <X size={12} strokeWidth={3} /> {status.missing.length} skill{status.missing.length === 1 ? "" : "s"} short
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <button type="button" className="kills-sync-btn fittings-full-btn" onClick={onSave} disabled={saving}>
          <Save size={14} strokeWidth={2} />
          {saving ? "Saving..." : "Save Fit"}
        </button>

        <div className="fittings-export-row">
          <button type="button" className="detail-back" onClick={() => handleCopy("eft", () => exportFitEft(draft.id))} disabled={!draft.id}>
            <Copy size={13} strokeWidth={2} />
            {copied === "eft" ? "Copied!" : "Copy EFT"}
          </button>
          <button type="button" className="detail-back" onClick={() => handleCopy("dna", () => exportFitDna(draft.id))} disabled={!draft.id}>
            <Copy size={13} strokeWidth={2} />
            {copied === "dna" ? "Copied!" : "Copy DNA"}
          </button>
        </div>
        <p className="fittings-export-hint">Paste EFT text into EVE's in-game "Import Fitting" dialog.</p>

        <button
          type="button"
          className={`overlay-toggle-btn${combatOverlayOn ? " overlay-toggle-btn-active" : ""}`}
          onClick={handleToggleCombatOverlay}
          title="A small always-on-top window showing live DPS/rep in and out, read from EVE's own combat log - undock with it open."
        >
          <Swords size={13} strokeWidth={2} />
          {combatOverlayOn ? "Close Combat Overlay" : "Open Combat Overlay"}
        </button>

        {characters.length > 0 && (
          <div className="fittings-send-card">
            <p className="fittings-slot-group-label">Send to Character</p>
            <CharacterSelectorStrip characters={characters} selectedId={sendCharacterId} onSelect={setSendCharacterId} />
            <button
              type="button"
              className="kills-sync-btn fittings-full-btn"
              onClick={onSendToCharacter}
              disabled={sending || !draft.id || sendCharacterId == null}
            >
              <Send size={14} strokeWidth={2} />
              {sending ? "Sending..." : "Send Straight to In-Game Fittings"}
            </button>
            {sendMessage && <p className="fittings-inline-success">{sendMessage}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default FitBuilder;
