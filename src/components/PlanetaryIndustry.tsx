import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getPiData, type PiData, type PiMaterial, type PiSchematic } from "../lib/pi";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { typeIconUrl } from "../lib/format";

const TIERS = ["P0", "P1", "P2", "P3", "P4"] as const;
const TIER_LABELS: Record<(typeof TIERS)[number], string> = {
  P0: "P0 Materials",
  P1: "P1 Materials",
  P2: "P2 Materials",
  P3: "P3 Materials",
  P4: "P4 Materials",
};

type Selection = { kind: "planet"; name: string } | { kind: "material"; typeId: number } | null;

function pillKey(kind: "planet" | "material", id: string | number): string {
  return `${kind}:${id}`;
}

interface ConnectionLine {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Every material a schematic could ever need to trace back through, given
 * a starting material - walks the schematic graph "up" from a product to
 * its raw P0 ancestors (or "up" from a P0 to nothing, since it has none). */
function collectAncestors(schematicByOutput: Map<number, PiSchematic>, typeId: number, acc: Set<number> = new Set()): Set<number> {
  if (acc.has(typeId)) return acc;
  acc.add(typeId);
  const schematic = schematicByOutput.get(typeId);
  if (schematic) {
    for (const input of schematic.inputs) collectAncestors(schematicByOutput, input.type_id, acc);
  }
  return acc;
}

function collectP0Ancestors(
  materialById: Map<number, PiMaterial>,
  schematicByOutput: Map<number, PiSchematic>,
  typeId: number,
  acc: Set<number> = new Set(),
): Set<number> {
  const material = materialById.get(typeId);
  if (!material) return acc;
  if (material.tier === "P0") {
    acc.add(typeId);
    return acc;
  }
  const schematic = schematicByOutput.get(typeId);
  if (schematic) {
    for (const input of schematic.inputs) collectP0Ancestors(materialById, schematicByOutput, input.type_id, acc);
  }
  return acc;
}

interface RecipeNodeProps {
  typeId: number;
  materialById: Map<number, PiMaterial>;
  schematicByOutput: Map<number, PiSchematic>;
  planetsForP0: Map<number, string[]>;
}

function RecipeNode({ typeId, materialById, schematicByOutput, planetsForP0 }: RecipeNodeProps) {
  const material = materialById.get(typeId);
  if (!material) return null;

  if (material.tier === "P0") {
    const planets = planetsForP0.get(typeId) ?? [];
    return (
      <div className="pi-recipe-node">
        <div className="pi-recipe-node-row">
          <img className="pi-recipe-node-icon" src={typeIconUrl(typeId)} alt="" />
          <span className="pi-recipe-node-name">{material.name}</span>
        </div>
        {planets.length > 0 && <p className="pi-recipe-node-sources">Sources: {planets.join(", ")}</p>}
      </div>
    );
  }

  const schematic = schematicByOutput.get(typeId);
  return (
    <div className="pi-recipe-node">
      <div className="pi-recipe-node-row">
        <img className="pi-recipe-node-icon" src={typeIconUrl(typeId)} alt="" />
        <span className="pi-recipe-node-name">{material.name}</span>
      </div>
      {schematic && schematic.inputs.length > 0 && (
        <div className="pi-recipe-node-children">
          {schematic.inputs.map((input) => (
            <RecipeNode
              key={input.type_id}
              typeId={input.type_id}
              materialById={materialById}
              schematicByOutput={schematicByOutput}
              planetsForP0={planetsForP0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanetaryIndustry() {
  const [data, setData] = useState<PiData | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [planTarget, setPlanTarget] = useState<number | null>(null);
  const [planQuery, setPlanQuery] = useState("");
  const [drawConnections, setDrawConnections] = useState(true);
  const [lines, setLines] = useState<ConnectionLine[]>([]);
  const reportError = useErrorReporter();

  const gridWrapRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  function registerPillRef(key: string) {
    return (el: HTMLButtonElement | null) => {
      if (el) pillRefs.current.set(key, el);
      else pillRefs.current.delete(key);
    };
  }

  useEffect(() => {
    getPiData()
      .then(setData)
      .catch((err) => reportError(`Failed to load Planetary Industry data: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const materialById = useMemo(() => new Map((data?.materials ?? []).map((m) => [m.type_id, m])), [data]);
  const schematicByOutput = useMemo(() => {
    const map = new Map<number, PiSchematic>();
    for (const s of data?.schematics ?? []) {
      for (const output of s.outputs) map.set(output.type_id, s);
    }
    return map;
  }, [data]);

  const materialsByTier = useMemo(() => {
    const groups: Record<string, PiMaterial[]> = { P0: [], P1: [], P2: [], P3: [], P4: [] };
    for (const m of data?.materials ?? []) {
      (groups[m.tier] ?? (groups[m.tier] = [])).push(m);
    }
    for (const tier of TIERS) groups[tier]?.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }, [data]);

  const planetsForP0 = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const planet of data?.planet_types ?? []) {
      for (const typeId of planet.p0_type_ids) {
        const list = map.get(typeId) ?? [];
        list.push(planet.name);
        map.set(typeId, list);
      }
    }
    return map;
  }, [data]);

  const highlighted = useMemo(() => {
    if (!selection || !data) return new Set<number>();
    if (selection.kind === "planet") {
      const planet = data.planet_types.find((p) => p.name === selection.name);
      return new Set(planet?.p0_type_ids ?? []);
    }
    return collectAncestors(schematicByOutput, selection.typeId);
  }, [selection, data, schematicByOutput]);

  // Which planets to highlight alongside a material selection - every planet
  // that supplies at least one of the P0 raw materials at the root of the
  // selected chain, so the Planets column shows where the whole thing
  // ultimately comes from, not just the P0-P4 material chain on its own.
  const highlightedPlanets = useMemo(() => {
    if (!selection || !data) return new Set<string>();
    if (selection.kind === "planet") return new Set([selection.name]);
    const planets = new Set<string>();
    for (const typeId of highlighted) {
      if (materialById.get(typeId)?.tier !== "P0") continue;
      for (const planetName of planetsForP0.get(typeId) ?? []) planets.add(planetName);
    }
    return planets;
  }, [selection, data, highlighted, materialById, planetsForP0]);

  // Direct edges only (planet -> its own P0s, or a material -> each of its
  // schematic's direct inputs) - the highlight sets above already cover the
  // full transitive chain, but connection lines only need to be drawn
  // between directly-linked pairs, not every ancestor to every descendant.
  // A material selection's walk also terminates each P0 leaf by connecting
  // it back to every planet that supplies it, so the chain reaches all the
  // way into the Planets column instead of stopping at P0.
  const edges = useMemo(() => {
    if (!selection || !data) return [];
    const pairs: [string, string][] = [];
    if (selection.kind === "planet") {
      const planet = data.planet_types.find((p) => p.name === selection.name);
      for (const p0Id of planet?.p0_type_ids ?? []) {
        pairs.push([pillKey("planet", selection.name), pillKey("material", p0Id)]);
      }
      return pairs;
    }
    const visited = new Set<number>();
    function walk(typeId: number) {
      if (visited.has(typeId)) return;
      visited.add(typeId);
      const schematic = schematicByOutput.get(typeId);
      if (!schematic) {
        if (materialById.get(typeId)?.tier === "P0") {
          for (const planetName of planetsForP0.get(typeId) ?? []) {
            pairs.push([pillKey("planet", planetName), pillKey("material", typeId)]);
          }
        }
        return;
      }
      for (const input of schematic.inputs) {
        pairs.push([pillKey("material", input.type_id), pillKey("material", typeId)]);
        walk(input.type_id);
      }
    }
    walk(selection.typeId);
    return pairs;
  }, [selection, data, schematicByOutput, materialById, planetsForP0]);

  // Recomputes on every edge/scroll/resize change rather than once, since
  // pills live in independently-scrollable columns (pi-column-list) - a
  // highlighted pill's on-screen position genuinely moves as the user
  // scrolls any single column, not just on window resize.
  useLayoutEffect(() => {
    function recompute() {
      const wrap = gridWrapRef.current;
      if (!wrap || edges.length === 0) {
        setLines([]);
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const next: ConnectionLine[] = [];
      for (const [fromKey, toKey] of edges) {
        const fromEl = pillRefs.current.get(fromKey);
        const toEl = pillRefs.current.get(toKey);
        if (!fromEl || !toEl) continue;
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        next.push({
          key: `${fromKey}->${toKey}`,
          x1: fromRect.right - wrapRect.left,
          y1: fromRect.top + fromRect.height / 2 - wrapRect.top,
          x2: toRect.left - wrapRect.left,
          y2: toRect.top + toRect.height / 2 - wrapRect.top,
        });
      }
      setLines(next);
    }

    recompute();
    const wrap = gridWrapRef.current;
    window.addEventListener("resize", recompute);
    wrap?.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      wrap?.removeEventListener("scroll", recompute, true);
    };
  }, [edges]);

  const manufacturable = useMemo(
    () => (data?.materials ?? []).filter((m) => m.tier !== "P0").sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );

  const planMatches = useMemo(() => {
    const q = planQuery.trim().toLowerCase();
    if (!q) return [];
    return manufacturable.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [manufacturable, planQuery]);

  const planMaterial = planTarget != null ? materialById.get(planTarget) : null;
  const planP0s = useMemo(() => {
    if (planTarget == null) return [];
    const ids = collectP0Ancestors(materialById, schematicByOutput, planTarget);
    return Array.from(ids)
      .map((id) => materialById.get(id))
      .filter((m): m is PiMaterial => Boolean(m))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [planTarget, materialById, schematicByOutput]);

  return (
    <main className="main main-pi">
      <div className="pi-page">
        <div className="pi-header">
          <p className="eyebrow">Planetary Industry</p>
          <div className="pi-header-title-row">
            <h2>Planetary Industry Visualizer</h2>
            <label className="pi-connections-toggle">
              <input type="checkbox" checked={drawConnections} onChange={(e) => setDrawConnections(e.target.checked)} />
              Draw connections
            </label>
          </div>
          <p className="pi-intro">
            Click a planet type to see which raw materials it yields, or click any material to trace its full
            production chain back to raw resources. Recipe data is synced once from CCP's own static data export, not
            guessed.
          </p>
        </div>

        {!data ? (
          <p className="detail-empty">Loading Planetary Industry data...</p>
        ) : (
          <>
            <div className="pi-grid-wrap" ref={gridWrapRef}>
              {drawConnections && lines.length > 0 && (
                <svg className="pi-connections-svg">
                  {lines.map((line) => (
                    <line key={line.key} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
                  ))}
                </svg>
              )}
              <div className="pi-grid">
                <div className="pi-column">
                  <p className="pi-column-title">Planets</p>
                  <div className="pi-column-list">
                    {data.planet_types.map((planet) => {
                      const active = selection?.kind === "planet" && selection.name === planet.name;
                      const dimmed = selection != null && !active && !highlightedPlanets.has(planet.name);
                      return (
                        <button
                          key={planet.name}
                          ref={registerPillRef(pillKey("planet", planet.name))}
                          type="button"
                          className={`pi-pill pi-pill-planet${active ? " pi-pill-active" : ""}${
                            !active && highlightedPlanets.has(planet.name) ? " pi-pill-highlighted" : ""
                          }${dimmed ? " pi-pill-dimmed" : ""}`}
                          onClick={() => setSelection(active ? null : { kind: "planet", name: planet.name })}
                        >
                          <span className={`pi-planet-swatch pi-planet-swatch-${planet.name.toLowerCase()}`} />
                          {planet.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {TIERS.map((tier) => (
                  <div key={tier} className="pi-column">
                    <p className="pi-column-title">{TIER_LABELS[tier]}</p>
                    <div className="pi-column-list">
                      {(materialsByTier[tier] ?? []).map((m) => {
                        const active = selection?.kind === "material" && selection.typeId === m.type_id;
                        const dimmed = selection != null && !active && !highlighted.has(m.type_id);
                        return (
                          <button
                            key={m.type_id}
                            ref={registerPillRef(pillKey("material", m.type_id))}
                            type="button"
                            className={`pi-pill${active ? " pi-pill-active" : ""}${
                              !active && highlighted.has(m.type_id) ? " pi-pill-highlighted" : ""
                            }${dimmed ? " pi-pill-dimmed" : ""}`}
                            onClick={() => setSelection(active ? null : { kind: "material", typeId: m.type_id })}
                          >
                            <img className="pi-pill-icon" src={typeIconUrl(m.type_id)} alt="" />
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pi-plan-section">
              <p className="kills-feed-section-title">Manufacturing Strategies</p>
              <div className="pi-plan-search">
                <input
                  type="text"
                  placeholder="Search a P1-P4 commodity to plan (e.g. Cryoprotectant Solution)"
                  value={planQuery}
                  onChange={(e) => setPlanQuery(e.target.value)}
                />
                {planMatches.length > 0 && (
                  <div className="gatecheck-slot-results kills-add-suggestions">
                    {planMatches.map((m) => (
                      <button
                        key={m.type_id}
                        type="button"
                        onClick={() => {
                          setPlanTarget(m.type_id);
                          setPlanQuery("");
                        }}
                      >
                        <img className="pi-pill-icon" src={typeIconUrl(m.type_id)} alt="" />
                        {m.name}
                        <span className="pi-plan-suggestion-tier">{m.tier}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {planMaterial && (
                <>
                  <div className="pi-plan-card">
                    <div className="pi-plan-card-head">
                      <img className="pi-pill-icon" src={typeIconUrl(planMaterial.type_id)} alt="" />
                      <span className="pi-plan-card-title">Manufacturing Plan: {planMaterial.name}</span>
                      <span className="pi-plan-card-count">{planP0s.length}/{planP0s.length} Resources</span>
                    </div>
                    <p className="pi-plan-card-subtitle">Required Raw Materials (P0)</p>
                    {planP0s.map((p0) => (
                      <div key={p0.type_id} className="pi-plan-material-row">
                        <img className="pi-pill-icon" src={typeIconUrl(p0.type_id)} alt="" />
                        <span className="pi-plan-material-name">{p0.name}</span>
                        <span className="pi-plan-material-planets">
                          {(planetsForP0.get(p0.type_id) ?? []).map((planetName) => (
                            <span key={planetName} className="pi-plan-planet-chip">
                              {planetName}
                            </span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>

                  <p className="kills-feed-section-title kills-feed-section-title-spaced">
                    Recipe Tree for {planMaterial.name}
                  </p>
                  <div className="pi-recipe-tree">
                    <RecipeNode
                      typeId={planMaterial.type_id}
                      materialById={materialById}
                      schematicByOutput={schematicByOutput}
                      planetsForP0={planetsForP0}
                    />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default PlanetaryIndustry;
