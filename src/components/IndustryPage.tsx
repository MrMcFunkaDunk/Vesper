import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Factory, X } from "lucide-react";
import {
  searchBlueprints,
  getBlueprintDetail,
  getIndustrySystemCostIndices,
  getReprocessingMaterials,
  type TypeSearchMatch,
  type ReprocessingInfo,
  type BlueprintDetail,
} from "../lib/industry";
import { getMarketPrices, getRegionSellMinPrices, searchMarketTypes } from "../lib/market";
import { buildCostTree, flattenRawMaterials, type BuildTreeNode } from "../lib/industryBuildTree";
import {
  jobInstallCost,
  estimatedItemValue,
  reprocessingYield,
  reprocessedMaterialQuantity,
  REPROCESSING_BASE_RATE,
  REPROCESSING_IMPLANT_BONUS,
  inventionProbability,
  inventionOutputRuns,
  inventionOutputMe,
  inventionOutputTe,
  inventionTimeSeconds,
  researchTimeSeconds,
  type ActivityType,
  type ReprocessingFacility,
  type ReprocessingRig,
  type SecurityBand,
  type DecryptorEffect,
} from "../lib/industryMath";
import { formatIsk, typeIconUrl } from "../lib/format";
import { searchSystemsLive, TRADE_HUB_REGIONS, type SystemSearchMatch } from "../lib/map";
import { getCharacterMiningLedger, type CharacterMiningLedger, type SessionCharacter } from "../lib/eve";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useIndustryDefaults } from "../hooks/useIndustryDefaults";
import HelpBadge from "./HelpBadge";
import { HELP_CONTENT } from "../lib/helpContent";
import CharacterSelectorStrip from "./CharacterSelectorStrip";

const FACILITY_LABEL: Record<ReprocessingFacility, string> = {
  npc_station: "NPC Station",
  citadel_or_engineering_complex: "Citadel / Engineering Complex",
  athanor: "Athanor (Refinery)",
  tatara: "Tatara (Refinery)",
};

const RIG_LABEL: Record<ReprocessingRig, string> = {
  none: "None",
  t1: "T1 Reprocessing Rig",
  t2: "T2 Reprocessing Rig",
};

const SECURITY_LABEL: Record<SecurityBand, string> = {
  highsec: "Highsec",
  lowsec: "Lowsec",
  null_or_wh: "Nullsec / Wormhole",
};

type ImplantTier = keyof typeof REPROCESSING_IMPLANT_BONUS;

const IMPLANT_LABEL: Record<ImplantTier, string> = {
  none: "None",
  rx801: "RX-801 (+1%)",
  rx802: "RX-802 (+2%)",
  rx804: "RX-804 (+4%)",
};

type IndustryTab = "production" | "reprocessing" | "invention" | "research" | "mining";

type StructureTier = "npc_station" | "engineering_complex";

const STRUCTURE_LABEL: Record<StructureTier, string> = {
  npc_station: "NPC Station",
  engineering_complex: "Engineering Complex",
};

interface DecryptorOption extends DecryptorEffect {
  key: string;
  label: string;
}

/** All 8 real decryptors and their exact modifiers - verified against the
 * EVE University wiki's Invention page (2026-08-20), not guessed. A blank/
 * omitted TE modifier on the wiki (Augmentation, Optimized Augmentation)
 * means 0, not "unknown". */
const DECRYPTORS: DecryptorOption[] = [
  { key: "none", label: "None", probabilityMultiplier: 1, runModifier: 0, meModifier: 0, teModifier: 0 },
  { key: "accelerant", label: "Accelerant (+20% chance)", probabilityMultiplier: 1.2, runModifier: 1, meModifier: 2, teModifier: 10 },
  { key: "attainment", label: "Attainment (+80% chance)", probabilityMultiplier: 1.8, runModifier: 4, meModifier: -1, teModifier: 4 },
  { key: "augmentation", label: "Augmentation (-40% chance)", probabilityMultiplier: 0.6, runModifier: 9, meModifier: -2, teModifier: 0 },
  { key: "optimized_attainment", label: "Optimized Attainment (+90% chance)", probabilityMultiplier: 1.9, runModifier: 2, meModifier: 1, teModifier: -2 },
  { key: "optimized_augmentation", label: "Optimized Augmentation (-10% chance)", probabilityMultiplier: 0.9, runModifier: 7, meModifier: 2, teModifier: 0 },
  { key: "parity", label: "Parity (+50% chance)", probabilityMultiplier: 1.5, runModifier: 3, meModifier: 1, teModifier: -2 },
  { key: "process", label: "Process (+10% chance)", probabilityMultiplier: 1.1, runModifier: 0, meModifier: 3, teModifier: 6 },
  { key: "symmetry", label: "Symmetry (+0% chance)", probabilityMultiplier: 1.0, runModifier: 2, meModifier: 1, teModifier: 8 },
];

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

function BuildTreeRow({ node, depth }: { node: BuildTreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const indent = 10 + depth * 18;
  const hasChildren = node.materials.length > 0;

  return (
    <div className="market-tree-node">
      <button
        type="button"
        className="market-browser-tree-item industry-build-row"
        style={{ paddingLeft: indent }}
        onClick={() => hasChildren && setExpanded((v) => !v)}
      >
        <img src={typeIconUrl(node.typeId, 32, node.name)} alt="" className="market-browser-row-icon" />
        <span className="market-browser-tree-item-label">
          {node.name}
          <span className="industry-build-qty"> x{node.quantityNeeded.toLocaleString()}</span>
        </span>
        <span className={`industry-build-decision${node.shouldBuild ? "" : " industry-build-decision-buy"}`}>
          {node.activity == null ? "Buy" : node.shouldBuild ? "Build" : "Buy"}
        </span>
        <span className="industry-build-cost">{formatIsk(node.totalCost)}</span>
        {hasChildren && (
          <ChevronRight size={13} strokeWidth={2} className={`market-tree-chevron${expanded ? " market-tree-chevron-open" : ""}`} />
        )}
      </button>
      {expanded && hasChildren && (
        <div className="market-tree-children">
          {node.materials.map((child) => (
            <BuildTreeRow key={child.typeId} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductionCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);

  const [defaultTradeHub] = useDefaultTradeHub();
  const { defaults: industryDefaults, saveProductionDefaults } = useIndustryDefaults();

  const [runs, setRuns] = useState(1);
  const [materialEfficiency, setMaterialEfficiency] = useState(industryDefaults.production.materialEfficiency);
  const [timeEfficiency, setTimeEfficiency] = useState(industryDefaults.production.timeEfficiency);
  const [structure, setStructure] = useState<StructureTier>(
    industryDefaults.production.structure === "npc_station" ? "npc_station" : "engineering_complex",
  );
  const [facilityTax, setFacilityTax] = useState(industryDefaults.production.facilityTax);
  const [savedDefaults, setSavedDefaults] = useState(false);

  const [systemQuery, setSystemQuery] = useState("");
  const [systemSuggestions, setSystemSuggestions] = useState<SystemSearchMatch[]>([]);
  const [systemSuggestionsOpen, setSystemSuggestionsOpen] = useState(false);
  const [system, setSystem] = useState<SystemSearchMatch | null>(null);

  const [tree, setTree] = useState<BuildTreeNode | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [basePrices, setBasePrices] = useState<Map<number, number>>(new Map());
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [hubPrices, setHubPrices] = useState<Map<number, number>>(new Map());
  const [hubPricesLoading, setHubPricesLoading] = useState(false);
  const reportError = useErrorReporter();

  // Multiple queued build jobs, each a snapshot of the tree as computed at
  // "add" time (its own ME/TE/runs baked in) - independent of whatever the
  // inputs above currently show, so reconfiguring for the next product
  // doesn't retroactively change an already-queued one.
  const [shoppingListJobs, setShoppingListJobs] = useState<{ id: string; name: string; runs: number; tree: BuildTreeNode }[]>([]);

  function handleAddToShoppingList() {
    if (!tree || !selected) return;
    setShoppingListJobs((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: selected.name, runs, tree }]);
  }

  function handleRemoveShoppingListJob(id: string) {
    setShoppingListJobs((prev) => prev.filter((j) => j.id !== id));
  }

  const aggregatedMaterials = useMemo(() => {
    const combined = new Map<number, { name: string; quantity: number }>();
    for (const job of shoppingListJobs) flattenRawMaterials(job.tree, combined);
    return Array.from(combined.entries());
  }, [shoppingListJobs]);

  function handleSaveDefaults() {
    saveProductionDefaults({ materialEfficiency, timeEfficiency, structure, facilityTax });
    setSavedDefaults(true);
    window.setTimeout(() => setSavedDefaults(false), 1500);
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchBlueprints(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
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

  useEffect(() => {
    const trimmed = systemQuery.trim();
    if (trimmed.length < 2) {
      setSystemSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSystemsLive(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSystemSuggestions(matches);
            setSystemSuggestionsOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setSystemSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [systemQuery]);

  useEffect(() => {
    if (!tree) {
      setHubPrices(new Map());
      return;
    }
    const materials = Array.from(flattenRawMaterials(tree).entries());
    if (materials.length === 0) {
      setHubPrices(new Map());
      return;
    }
    let cancelled = false;
    // Clear immediately rather than leaving the previous hub's numbers on
    // screen mislabeled as the new hub's - the row falls back to the
    // EVE-wide adjusted price (still a real number, just not hub-specific)
    // while the fresh per-hub fetch is in flight.
    setHubPrices(new Map());
    setHubPricesLoading(true);
    // One IPC call for the whole material list instead of one per material -
    // the backend batches and caches these itself now.
    getRegionSellMinPrices(
      hubRegionId,
      materials.map(([typeId]) => typeId),
    )
      .then((next) => {
        if (cancelled) return;
        setHubPrices(next);
      })
      .catch(() => {
        if (!cancelled) setHubPrices(new Map());
      })
      .finally(() => {
        if (!cancelled) setHubPricesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, hubRegionId]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setTree(null);
    try {
      const detail = await getBlueprintDetail(selected.id);
      const activityInfo = detail.manufacturing ?? detail.reaction;
      const activity: ActivityType | null = detail.manufacturing ? "manufacturing" : detail.reaction ? "reaction" : null;
      if (!activityInfo || !activity) {
        reportError(`${selected.name} has no manufacturing or reaction data - it may not be a real blueprint/reaction formula.`);
        return;
      }

      const prices = await getMarketPrices();
      const priceByTypeId = new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0]));
      setBasePrices(priceByTypeId);

      // The blueprint/reaction-formula item itself is never a manufacturable
      // product (nothing produces "Orca Blueprint" - it's the SHIP that gets
      // built), so the tree must start from what the blueprint OUTPUTS, not
      // from the blueprint's own type_id.
      const output = activityInfo.products[0];
      if (!output) {
        reportError(`${selected.name} has no listed output product.`);
        return;
      }
      const totalQuantity = runs * output.quantity;

      const result = await buildCostTree(output.type_id, output.name, totalQuantity, {
        materialEfficiency,
        timeEfficiency,
        structureMaterialBonus: structure === "engineering_complex" ? 0.01 : 0,
        structureTimeBonus: structure === "engineering_complex" ? 0.15 : 0,
      }, priceByTypeId);
      setTree(result);

      if (system) {
        const costIndices = await getIndustrySystemCostIndices();
        const systemIndex = costIndices.find((c) => c.solar_system_id === system.id);
        const activityKey = activity === "manufacturing" ? "manufacturing" : "reaction";
        const costIndex = systemIndex?.indices[activityKey] ?? 0.05;
        const eiv = estimatedItemValue(
          activityInfo.materials.map((m) => ({ typeId: m.type_id, quantity: m.quantity * runs })),
          priceByTypeId,
        );
        const installCost = jobInstallCost(eiv, costIndex, activity, facilityTax);
        setTree((prev) => (prev ? { ...prev, totalCost: prev.totalCost + installCost } : prev));
      }
    } catch (err) {
      reportError(`Failed to calculate build cost: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const rawMaterials = tree ? Array.from(flattenRawMaterials(tree).entries()) : [];

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search for a blueprint or reaction formula..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setTree(null);
            }}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelected(s);
                    setQuery(s.name);
                    setSuggestionsOpen(false);
                  }}
                >
                  <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Runs
              <input type="number" min={1} className="industry-field-input" value={runs} onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <label className="wh-field-label">
              Material Efficiency
              <input
                type="number"
                min={0}
                max={10}
                className="industry-field-input"
                value={materialEfficiency}
                onChange={(e) => setMaterialEfficiency(Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Time Efficiency
              <input
                type="number"
                min={0}
                max={20}
                step={2}
                className="industry-field-input"
                value={timeEfficiency}
                onChange={(e) => setTimeEfficiency(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Structure
              <select className="industry-field-input" value={structure} onChange={(e) => setStructure(e.target.value as StructureTier)}>
                {(Object.keys(STRUCTURE_LABEL) as StructureTier[]).map((s) => (
                  <option key={s} value={s}>
                    {STRUCTURE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Facility Tax %
              <input
                type="number"
                min={0}
                step={0.01}
                className="industry-field-input"
                value={facilityTax * 100}
                onChange={(e) => setFacilityTax(Math.max(0, Number(e.target.value) || 0) / 100)}
              />
            </label>
            <div className="kills-add-combobox industry-system-search">
              <label className="wh-field-label">
                System (for job cost)
                <input
                  type="text"
                  placeholder="Optional - e.g. Jita"
                  value={systemQuery}
                  onChange={(e) => {
                    setSystemQuery(e.target.value);
                    setSystem(null);
                  }}
                  onFocus={() => systemSuggestions.length > 0 && setSystemSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSystemSuggestionsOpen(false), 120)}
                />
              </label>
              {systemSuggestionsOpen && (
                <div className="gatecheck-slot-results kills-add-suggestions">
                  {systemSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSystem(s);
                        setSystemQuery(s.name);
                        setSystemSuggestionsOpen(false);
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {selected && (
          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
              {calculating ? "Calculating..." : "Calculate Build Cost"}
            </button>
            <button type="button" className="detail-back" onClick={handleSaveDefaults} title="Remember these ME/TE/structure/tax inputs as the default next time">
              {savedDefaults ? "Saved!" : "Save as Default"}
            </button>
            {tree && (
              <button
                type="button"
                className="detail-back"
                onClick={handleAddToShoppingList}
                title="Add this build (with its current ME/TE/runs) to the running shopping list below"
              >
                + Add to Shopping List
              </button>
            )}
          </div>
        )}
      </div>

      {tree && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Total cost: <strong>{formatIsk(tree.totalCost)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Per unit: <strong>{formatIsk(tree.totalCost / tree.quantityNeeded)}</strong>
            </span>
            {tree.timeSeconds != null && (
              <>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Build time: <strong>{formatDuration(tree.timeSeconds)}</strong>
                </span>
              </>
            )}
          </div>

          <p className="wh-side-label">Build Steps</p>
          <div className="market-browser-tree-list">
            <BuildTreeRow node={tree} depth={0} />
          </div>

          {rawMaterials.length > 0 && (
            <>
              <div className="industry-shopping-list-header">
                <p className="wh-side-label">Shopping List (Raw / Bought Materials)</p>
                <label className="wh-field-label industry-hub-select-label">
                  Trade Hub
                  <select
                    className="industry-field-input"
                    value={hubRegionId}
                    onChange={(e) => setHubRegionId(Number(e.target.value))}
                  >
                    {TRADE_HUB_REGIONS.map((h) => (
                      <option key={h.regionId} value={h.regionId}>
                        {h.regionName}
                      </option>
                    ))}
                  </select>
                </label>
                {hubPricesLoading && <span className="industry-hub-prices-loading">Loading hub prices...</span>}
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th className="data-table-numeric">Unit Price</th>
                      <th className="data-table-numeric">Quantity</th>
                      <th className="data-table-numeric">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawMaterials.map(([typeId, m]) => {
                      const unitPrice = hubPrices.get(typeId) ?? basePrices.get(typeId) ?? 0;
                      const total = unitPrice * m.quantity;
                      return (
                        <tr key={typeId}>
                          <td className="industry-shopping-list-name">
                            <img src={typeIconUrl(typeId, 32, m.name)} alt="" className="market-browser-row-icon" />
                            {m.name}
                          </td>
                          <td className="data-table-numeric wallet-amount-negative">{formatIsk(unitPrice)}</td>
                          <td className="data-table-numeric">{m.quantity.toLocaleString()}</td>
                          <td className="data-table-numeric wallet-amount-negative">{formatIsk(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="industry-shopping-list-total-row">
                      <td colSpan={3}>Shopping List Total</td>
                      <td className="data-table-numeric wallet-amount-negative">
                        {formatIsk(
                          rawMaterials.reduce((sum, [typeId, m]) => sum + (hubPrices.get(typeId) ?? basePrices.get(typeId) ?? 0) * m.quantity, 0),
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {shoppingListJobs.length > 0 && (
        <div className="industry-results-panel">
          <div className="industry-shopping-list-header">
            <p className="wh-side-label">Multi-Job Shopping List ({shoppingListJobs.length} job{shoppingListJobs.length === 1 ? "" : "s"})</p>
          </div>
          <div className="industry-shopping-list-jobs">
            {shoppingListJobs.map((job) => (
              <span key={job.id} className="data-table-tag data-table-tag-neutral industry-shopping-list-job-tag">
                {job.name} x{job.runs}
                <button type="button" onClick={() => handleRemoveShoppingListJob(job.id)} title="Remove this job from the list">
                  <X size={11} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="data-table-numeric">Unit Price</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {aggregatedMaterials.map(([typeId, m]) => {
                  const unitPrice = hubPrices.get(typeId) ?? basePrices.get(typeId) ?? 0;
                  const total = unitPrice * m.quantity;
                  return (
                    <tr key={typeId}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(typeId, 32, m.name)} alt="" className="market-browser-row-icon" />
                        {m.name}
                      </td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(unitPrice)}</td>
                      <td className="data-table-numeric">{m.quantity.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="industry-shopping-list-total-row">
                  <td colSpan={3}>Combined Shopping List Total</td>
                  <td className="data-table-numeric wallet-amount-negative">
                    {formatIsk(aggregatedMaterials.reduce((sum, [typeId, m]) => sum + (hubPrices.get(typeId) ?? basePrices.get(typeId) ?? 0) * m.quantity, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReprocessingCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);

  const [defaultTradeHub] = useDefaultTradeHub();
  const { defaults: industryDefaults, saveReprocessingDefaults } = useIndustryDefaults();

  const [quantityHeld, setQuantityHeld] = useState(1000);
  const [facility, setFacility] = useState<ReprocessingFacility>(industryDefaults.reprocessing.facility);
  const [rig, setRig] = useState<ReprocessingRig>(industryDefaults.reprocessing.rig);
  const [security, setSecurity] = useState<SecurityBand>(industryDefaults.reprocessing.security);
  const [reprocessingLevel, setReprocessingLevel] = useState(industryDefaults.reprocessing.reprocessingLevel);
  const [reprocessingEfficiencyLevel, setReprocessingEfficiencyLevel] = useState(industryDefaults.reprocessing.reprocessingEfficiencyLevel);
  const [oreProcessingLevel, setOreProcessingLevel] = useState(industryDefaults.reprocessing.oreProcessingLevel);
  const [implant, setImplant] = useState<ImplantTier>(
    industryDefaults.reprocessing.implant in IMPLANT_LABEL ? (industryDefaults.reprocessing.implant as ImplantTier) : "none",
  );
  const [savedDefaults, setSavedDefaults] = useState(false);

  const [info, setInfo] = useState<ReprocessingInfo | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [basePrices, setBasePrices] = useState<Map<number, number>>(new Map());
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [hubPrices, setHubPrices] = useState<Map<number, number>>(new Map());
  const [hubPricesLoading, setHubPricesLoading] = useState(false);
  const reportError = useErrorReporter();

  function handleSaveDefaults() {
    saveReprocessingDefaults({ facility, rig, security, reprocessingLevel, reprocessingEfficiencyLevel, oreProcessingLevel, implant });
    setSavedDefaults(true);
    window.setTimeout(() => setSavedDefaults(false), 1500);
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMarketTypes(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
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

  useEffect(() => {
    if (!info || info.materials.length === 0) {
      setHubPrices(new Map());
      return;
    }
    let cancelled = false;
    setHubPrices(new Map());
    setHubPricesLoading(true);
    getRegionSellMinPrices(
      hubRegionId,
      info.materials.map((m) => m.type_id),
    )
      .then((next) => {
        if (cancelled) return;
        setHubPrices(next);
      })
      .catch(() => {
        if (!cancelled) setHubPrices(new Map());
      })
      .finally(() => {
        if (!cancelled) setHubPricesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [info, hubRegionId]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    try {
      const result = await getReprocessingMaterials(selected.id);
      if (result.materials.length === 0) {
        reportError(`${selected.name} doesn't reprocess into anything - it may not be an ore, ice, or salvage type.`);
        setInfo(null);
        return;
      }
      setInfo(result);
      const prices = await getMarketPrices();
      setBasePrices(new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0])));
    } catch (err) {
      reportError(`Failed to load reprocessing data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const yieldFraction = reprocessingYield({
    facility,
    rig,
    security,
    reprocessingLevel,
    reprocessingEfficiencyLevel,
    oreProcessingLevel,
    implantBonus: REPROCESSING_IMPLANT_BONUS[implant],
  });
  const portions = info ? Math.floor(quantityHeld / info.portion_size) : 0;
  const leftover = info ? quantityHeld - portions * info.portion_size : 0;
  const outputs = info
    ? info.materials.map((m) => ({
        ...m,
        yieldQty: reprocessedMaterialQuantity(m.quantity, quantityHeld, info.portion_size, yieldFraction),
      }))
    : [];
  const totalValue = outputs.reduce((sum, o) => sum + (hubPrices.get(o.type_id) ?? basePrices.get(o.type_id) ?? 0) * o.yieldQty, 0);

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search for an ore, ice, or salvage type..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setInfo(null);
            }}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelected(s);
                    setQuery(s.name);
                    setSuggestionsOpen(false);
                  }}
                >
                  <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Quantity Held
              <input
                type="number"
                min={1}
                className="industry-field-input"
                value={quantityHeld}
                onChange={(e) => setQuantityHeld(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="wh-field-label">
              Facility
              <select className="industry-field-input" value={facility} onChange={(e) => setFacility(e.target.value as ReprocessingFacility)}>
                {(Object.keys(REPROCESSING_BASE_RATE) as ReprocessingFacility[]).map((f) => (
                  <option key={f} value={f}>
                    {FACILITY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Rig
              <select className="industry-field-input" value={rig} onChange={(e) => setRig(e.target.value as ReprocessingRig)}>
                {(Object.keys(RIG_LABEL) as ReprocessingRig[]).map((r) => (
                  <option key={r} value={r}>
                    {RIG_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Security
              <select className="industry-field-input" value={security} onChange={(e) => setSecurity(e.target.value as SecurityBand)}>
                {(Object.keys(SECURITY_LABEL) as SecurityBand[]).map((s) => (
                  <option key={s} value={s}>
                    {SECURITY_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Reprocessing
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={reprocessingLevel}
                onChange={(e) => setReprocessingLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Reprocessing Efficiency
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={reprocessingEfficiencyLevel}
                onChange={(e) => setReprocessingEfficiencyLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Ore/Ice Processing
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={oreProcessingLevel}
                onChange={(e) => setOreProcessingLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Implant
              <select className="industry-field-input" value={implant} onChange={(e) => setImplant(e.target.value as ImplantTier)}>
                {(Object.keys(IMPLANT_LABEL) as ImplantTier[]).map((i) => (
                  <option key={i} value={i}>
                    {IMPLANT_LABEL[i]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {selected && (
          <div className="settings-section-row">
            <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
              {calculating ? "Calculating..." : "Calculate Reprocessing Yield"}
            </button>
            <button type="button" className="detail-back" onClick={handleSaveDefaults} title="Remember these facility/rig/security/skill inputs as the default next time">
              {savedDefaults ? "Saved!" : "Save as Default"}
            </button>
          </div>
        )}
      </div>

      {info && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Effective yield: <strong>{(yieldFraction * 100).toFixed(2)}%</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Portions processed: <strong>{portions.toLocaleString()}</strong> ({info.portion_size.toLocaleString()}/portion)
            </span>
            {leftover > 0 && (
              <>
                <span className="skill-queue-footer-sep">|</span>
                <span>
                  Leftover (not enough for a portion): <strong>{leftover.toLocaleString()}</strong>
                </span>
              </>
            )}
          </div>

          <div className="industry-shopping-list-header">
            <p className="wh-side-label">Yielded Materials</p>
            <label className="wh-field-label industry-hub-select-label">
              Trade Hub
              <select className="industry-field-input" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
                {TRADE_HUB_REGIONS.map((h) => (
                  <option key={h.regionId} value={h.regionId}>
                    {h.regionName}
                  </option>
                ))}
              </select>
            </label>
            {hubPricesLoading && <span className="industry-hub-prices-loading">Loading hub prices...</span>}
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="data-table-numeric">Unit Price</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {outputs.map((o) => {
                  const unitPrice = hubPrices.get(o.type_id) ?? basePrices.get(o.type_id) ?? 0;
                  const total = unitPrice * o.yieldQty;
                  return (
                    <tr key={o.type_id}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(o.type_id, 32, o.name)} alt="" className="market-browser-row-icon" />
                        {o.name}
                      </td>
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(unitPrice)}</td>
                      <td className="data-table-numeric">{o.yieldQty.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="industry-shopping-list-total-row">
                  <td colSpan={3}>Total Value</td>
                  <td className="data-table-numeric wallet-amount-positive">{formatIsk(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function InventionCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);

  const [detail, setDetail] = useState<BlueprintDetail | null>(null);
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  const [encryptionLevel, setEncryptionLevel] = useState(4);
  const [datacore1Level, setDatacore1Level] = useState(5);
  const [datacore2Level, setDatacore2Level] = useState(5);
  const [decryptorKey, setDecryptorKey] = useState("none");
  const [advancedIndustryLevel, setAdvancedIndustryLevel] = useState(5);
  const [facilityModifier, setFacilityModifier] = useState(1);
  const [rigBonusPct, setRigBonusPct] = useState(0);

  const [basePrices, setBasePrices] = useState<Map<number, number>>(new Map());
  const [calculating, setCalculating] = useState(false);
  const reportError = useErrorReporter();

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchBlueprints(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
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

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setDetail(null);
    try {
      const d = await getBlueprintDetail(selected.id);
      if (!d.invention) {
        reportError(`${selected.name} has no invention data - it may not be a T1 item that can be invented into a T2 variant.`);
        return;
      }
      setDetail(d);
      setOutcomeIndex(0);
      const prices = await getMarketPrices();
      setBasePrices(new Map(prices.map((p) => [p.type_id, p.adjusted_price ?? p.average_price ?? 0])));
    } catch (err) {
      reportError(`Failed to load invention data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const invention = detail?.invention ?? null;
  const outcome = invention?.outcomes[outcomeIndex] ?? null;
  const decryptor = DECRYPTORS.find((d) => d.key === decryptorKey) ?? DECRYPTORS[0];

  const probability = outcome
    ? Math.min(1, inventionProbability(outcome.probability, encryptionLevel, datacore1Level, datacore2Level, decryptor))
    : 0;
  const outputRuns = inventionOutputRuns(decryptor);
  const outputMe = inventionOutputMe(decryptor);
  const outputTe = inventionOutputTe(decryptor);
  const timeSeconds = invention ? inventionTimeSeconds(invention.time_seconds, facilityModifier, advancedIndustryLevel, rigBonusPct / 100) : 0;
  const materialCost = invention ? invention.materials.reduce((sum, m) => sum + m.quantity * (basePrices.get(m.type_id) ?? 0), 0) : 0;
  const expectedAttempts = probability > 0 ? 1 / probability : Infinity;
  const expectedCostPerSuccess = probability > 0 ? materialCost / probability : Infinity;

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search for a T1 blueprint that can be invented (e.g. Rifter Blueprint)..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setDetail(null);
            }}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelected(s);
                    setQuery(s.name);
                    setSuggestionsOpen(false);
                  }}
                >
                  <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
            {calculating ? "Loading..." : "Load Invention Data"}
          </button>
        )}

        {invention && (
          <div className="industry-input-grid">
            {invention.outcomes.length > 1 && (
              <label className="wh-field-label">
                Invent Into
                <select className="industry-field-input" value={outcomeIndex} onChange={(e) => setOutcomeIndex(Number(e.target.value))}>
                  {invention.outcomes.map((o, i) => (
                    <option key={o.product_type_id} value={i}>
                      {o.product_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="wh-field-label">
              Encryption Skill
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={encryptionLevel}
                onChange={(e) => setEncryptionLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Datacore Skill 1
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={datacore1Level}
                onChange={(e) => setDatacore1Level(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Datacore Skill 2
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={datacore2Level}
                onChange={(e) => setDatacore2Level(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Decryptor
              <select className="industry-field-input" value={decryptorKey} onChange={(e) => setDecryptorKey(e.target.value)}>
                {DECRYPTORS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Advanced Industry
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={advancedIndustryLevel}
                onChange={(e) => setAdvancedIndustryLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Facility Time Modifier
              <input
                type="number"
                min={0}
                step={0.01}
                className="industry-field-input"
                value={facilityModifier}
                onChange={(e) => setFacilityModifier(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label className="wh-field-label">
              Rig Time Bonus %
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                className="industry-field-input"
                value={rigBonusPct}
                onChange={(e) => setRigBonusPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
            </label>
          </div>
        )}
      </div>

      {invention && outcome && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Success chance: <strong>{(probability * 100).toFixed(1)}%</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Expected attempts per success: <strong>{expectedAttempts === Infinity ? "-" : expectedAttempts.toFixed(2)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Output: <strong>{outputRuns} runs / {outputMe}% ME / {outputTe}% TE</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Time per attempt: <strong>{formatDuration(timeSeconds)}</strong>
            </span>
          </div>

          <div className="skill-plan-footer">
            <span>
              Material cost per attempt: <strong className="wallet-amount-negative">{formatIsk(materialCost)}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Expected cost per success: <strong className="wallet-amount-negative">{expectedCostPerSuccess === Infinity ? "-" : formatIsk(expectedCostPerSuccess)}</strong>
            </span>
          </div>

          <p className="wh-side-label">Invention Materials</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="data-table-numeric">Unit Price</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                {invention.materials.map((m) => {
                  const unitPrice = basePrices.get(m.type_id) ?? 0;
                  const total = unitPrice * m.quantity;
                  return (
                    <tr key={m.type_id}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(m.type_id, 32, m.name)} alt="" className="market-browser-row-icon" />
                        {m.name}
                      </td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(unitPrice)}</td>
                      <td className="data-table-numeric">{m.quantity.toLocaleString()}</td>
                      <td className="data-table-numeric wallet-amount-negative">{formatIsk(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

type ResearchType = "research_me" | "research_te";

const RESEARCH_TYPE_LABEL: Record<ResearchType, string> = {
  research_me: "Material Efficiency",
  research_te: "Time Efficiency",
};

function ResearchCalculator() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<TypeSearchMatch | null>(null);

  const [detail, setDetail] = useState<BlueprintDetail | null>(null);
  const [researchType, setResearchType] = useState<ResearchType>("research_me");
  const [currentLevel, setCurrentLevel] = useState(0);
  const [targetLevel, setTargetLevel] = useState(10);
  const [researchSkillLevel, setResearchSkillLevel] = useState(5);
  const [advancedIndustryLevel, setAdvancedIndustryLevel] = useState(5);
  const [facilityModifier, setFacilityModifier] = useState(1);
  const [implantModifier, setImplantModifier] = useState(1);
  const [rigBonusPct, setRigBonusPct] = useState(0);

  const [calculating, setCalculating] = useState(false);
  const reportError = useErrorReporter();

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchBlueprints(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setSuggestions(matches);
            setSuggestionsOpen(matches.length > 0);
          }
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

  // ME researches one level at a time (0-10); TE researches in steps of 2
  // (0-20, 10 jobs total) - switching type re-scales current/target level
  // onto the right step so a leftover odd TE level (or an ME level above
  // 10) can't linger from before the switch.
  useEffect(() => {
    if (researchType === "research_me") {
      setCurrentLevel((v) => Math.min(10, v));
      setTargetLevel(10);
    } else {
      setCurrentLevel((v) => Math.min(20, v % 2 === 0 ? v : v - 1));
      setTargetLevel(20);
    }
  }, [researchType]);

  async function handleCalculate() {
    if (!selected) return;
    setCalculating(true);
    setDetail(null);
    try {
      const d = await getBlueprintDetail(selected.id);
      if (!d.research_me && !d.research_te) {
        reportError(`${selected.name} has no research data - only manufacturable blueprints can be ME/TE researched.`);
        return;
      }
      setDetail(d);
    } catch (err) {
      reportError(`Failed to load research data: ${String(err)}`);
    } finally {
      setCalculating(false);
    }
  }

  const activity = detail ? (researchType === "research_me" ? detail.research_me : detail.research_te) : null;
  const step = researchType === "research_me" ? 1 : 2;
  const maxLevel = researchType === "research_me" ? 10 : 20;

  const levelsToRun: number[] = [];
  if (activity) {
    for (let lvl = currentLevel + step; lvl <= targetLevel; lvl += step) levelsToRun.push(lvl);
  }
  const totalTimeSeconds = activity
    ? levelsToRun.reduce(
        (sum, lvl) =>
          sum + researchTimeSeconds(activity.time_seconds, lvl, facilityModifier, implantModifier, researchSkillLevel, advancedIndustryLevel, rigBonusPct / 100),
        0,
      )
    : 0;

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-add-combobox industry-blueprint-search">
          <input
            type="text"
            placeholder="Search for a blueprint to research..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setDetail(null);
            }}
            onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
          />
          {suggestionsOpen && (
            <div className="gatecheck-slot-results kills-add-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelected(s);
                    setQuery(s.name);
                    setSuggestionsOpen(false);
                  }}
                >
                  <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <button type="button" className="kills-sync-btn" onClick={handleCalculate} disabled={calculating}>
            {calculating ? "Loading..." : "Load Research Data"}
          </button>
        )}

        {detail && (
          <div className="industry-input-grid">
            <label className="wh-field-label">
              Research Type
              <select className="industry-field-input" value={researchType} onChange={(e) => setResearchType(e.target.value as ResearchType)}>
                {(Object.keys(RESEARCH_TYPE_LABEL) as ResearchType[]).map((t) => (
                  <option key={t} value={t}>
                    {RESEARCH_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wh-field-label">
              Current Level
              <input
                type="number"
                min={0}
                max={maxLevel}
                step={step}
                className="industry-field-input"
                value={currentLevel}
                onChange={(e) => setCurrentLevel(Math.max(0, Math.min(maxLevel, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Target Level
              <input
                type="number"
                min={0}
                max={maxLevel}
                step={step}
                className="industry-field-input"
                value={targetLevel}
                onChange={(e) => setTargetLevel(Math.max(0, Math.min(maxLevel, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              {researchType === "research_me" ? "Metallurgy" : "Research"} Skill
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={researchSkillLevel}
                onChange={(e) => setResearchSkillLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Advanced Industry
              <input
                type="number"
                min={0}
                max={5}
                className="industry-field-input"
                value={advancedIndustryLevel}
                onChange={(e) => setAdvancedIndustryLevel(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="wh-field-label">
              Facility Time Modifier
              <input
                type="number"
                min={0}
                step={0.01}
                className="industry-field-input"
                value={facilityModifier}
                onChange={(e) => setFacilityModifier(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label className="wh-field-label">
              Implant Time Modifier
              <input
                type="number"
                min={0}
                step={0.01}
                className="industry-field-input"
                value={implantModifier}
                onChange={(e) => setImplantModifier(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label className="wh-field-label">
              Rig Time Bonus %
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                className="industry-field-input"
                value={rigBonusPct}
                onChange={(e) => setRigBonusPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
            </label>
          </div>
        )}
      </div>

      {activity && (
        <div className="industry-results-panel">
          <div className="skill-plan-footer">
            <span>
              Jobs required: <strong>{levelsToRun.length}</strong>
            </span>
            <span className="skill-queue-footer-sep">|</span>
            <span>
              Total research time: <strong>{formatDuration(totalTimeSeconds)}</strong>
            </span>
          </div>

          {levelsToRun.length > 0 && (
            <>
              <p className="wh-side-label">Per-Job Breakdown</p>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th className="data-table-numeric">Reaches Level</th>
                      <th className="data-table-numeric">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levelsToRun.map((lvl, i) => {
                      const jobTime = researchTimeSeconds(
                        activity.time_seconds,
                        lvl,
                        facilityModifier,
                        implantModifier,
                        researchSkillLevel,
                        advancedIndustryLevel,
                        rigBonusPct / 100,
                      );
                      return (
                        <tr key={lvl}>
                          <td>Job {i + 1}</td>
                          <td className="data-table-numeric">{lvl}%</td>
                          <td className="data-table-numeric">{formatDuration(jobTime)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Character-only, per D5's scoping - corp mining observer data (refinery
 * -level tracking of a whole team) is skipped for this pass. */
function MiningLedgerTab({ characters }: { characters: SessionCharacter[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(characters[0]?.id ?? null);
  const [ledger, setLedger] = useState<CharacterMiningLedger | null>(null);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const reportError = useErrorReporter();

  useEffect(() => {
    getMarketPrices()
      .then((list) => {
        const map = new Map<number, number>();
        for (const p of list) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLedger(null);
    if (selectedId == null) return;
    getCharacterMiningLedger(selectedId)
      .then(setLedger)
      .catch((err) => reportError(`Failed to load mining ledger: ${String(err)}`));
  }, [selectedId, reportError]);

  const grouped = useMemo(() => {
    if (!ledger) return [];
    const byType = new Map<number, { typeName: string; quantity: number }>();
    for (const e of ledger.entries) {
      const existing = byType.get(e.type_id);
      if (existing) existing.quantity += e.quantity;
      else byType.set(e.type_id, { typeName: e.type_name, quantity: e.quantity });
    }
    return [...byType.entries()]
      .map(([typeId, v]) => ({ typeId, ...v, value: (prices.get(typeId) ?? 0) * v.quantity }))
      .sort((a, b) => b.value - a.value);
  }, [ledger, prices]);

  const totalValue = grouped.reduce((sum, g) => sum + g.value, 0);
  const distinctDays = ledger ? new Set(ledger.entries.map((e) => e.date)).size : 0;
  const iskPerDay = distinctDays > 0 ? totalValue / distinctDays : 0;

  return (
    <div className="industry-production">
      {characters.length > 1 && <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />}
      {selectedId == null ? (
        <p className="detail-empty">No connected characters.</p>
      ) : !ledger ? (
        <p className="detail-empty">Loading mining ledger...</p>
      ) : ledger.needs_reauth ? (
        <p className="detail-empty">Sign in again to unlock the mining ledger for this character.</p>
      ) : ledger.entries.length === 0 ? (
        <p className="detail-empty">No mining activity recorded in the last 90 days.</p>
      ) : (
        <>
          <p className="settings-section-hint">
            Up to 90 days of mining history from ESI, valued at EVE-wide average price - a rough guide, not a
            guaranteed sell price.
          </p>
          <div className="market-browser-stats">
            <div className="market-stat-card">
              <span className="market-stat-label">Total Value</span>
              <span className="market-stat-value">{formatIsk(totalValue)}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">Active Days</span>
              <span className="market-stat-value">{distinctDays}</span>
            </div>
            <div className="market-stat-card">
              <span className="market-stat-label">ISK / Active Day</span>
              <span className="market-stat-value">{formatIsk(iskPerDay)}</span>
            </div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ore / Ice</th>
                  <th className="data-table-numeric">Quantity</th>
                  <th className="data-table-numeric">Est. Value</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => (
                  <tr key={g.typeId}>
                    <td>
                      <span className="asset-item-cell">
                        <img src={typeIconUrl(g.typeId, 32, g.typeName)} alt="" className="market-browser-row-icon" />
                        {g.typeName}
                      </span>
                    </td>
                    <td className="data-table-numeric">{g.quantity.toLocaleString()}</td>
                    <td className="data-table-numeric">{formatIsk(g.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function IndustryPage({ characters }: { characters: SessionCharacter[] }) {
  const [tab, setTab] = useState<IndustryTab>("production");

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">
            <Factory size={14} strokeWidth={2} /> Industry
          </p>
          <h2>Production &amp; Reprocessing</h2>
          <p className="wh-page-subtitle">
            Blueprint build-cost calculation with real material/job-cost formulas, and ore/ice reprocessing yields.
          </p>
        </div>

        <div className="character-tabs">
          <button type="button" className={`character-tab${tab === "production" ? " character-tab-active" : ""}`} onClick={() => setTab("production")}>
            Production
          </button>
          <button type="button" className={`character-tab${tab === "reprocessing" ? " character-tab-active" : ""}`} onClick={() => setTab("reprocessing")}>
            Reprocessing
          </button>
          <button type="button" className={`character-tab${tab === "invention" ? " character-tab-active" : ""}`} onClick={() => setTab("invention")}>
            Invention
          </button>
          <button type="button" className={`character-tab${tab === "research" ? " character-tab-active" : ""}`} onClick={() => setTab("research")}>
            Research
          </button>
          <button type="button" className={`character-tab${tab === "mining" ? " character-tab-active" : ""}`} onClick={() => setTab("mining")}>
            Mining Ledger
          </button>
          <HelpBadge content={HELP_CONTENT[`industry.${tab}`] ?? HELP_CONTENT.industry} />
        </div>

        {tab === "production" ? (
          <ProductionCalculator />
        ) : tab === "reprocessing" ? (
          <ReprocessingCalculator />
        ) : tab === "invention" ? (
          <InventionCalculator />
        ) : tab === "research" ? (
          <ResearchCalculator />
        ) : (
          <MiningLedgerTab characters={characters} />
        )}
      </div>
    </main>
  );
}

export default IndustryPage;
