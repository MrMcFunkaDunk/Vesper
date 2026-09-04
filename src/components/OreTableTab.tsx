import { useEffect, useMemo, useRef, useState } from "react";
import { getReprocessingMaterials } from "../lib/industry";
import { getCategoryGroups, getGroupItems, getRegionSellMinPrices, type GroupSummary, type TypeSummary } from "../lib/market";
import { materialsPerCubicMeter, isCompressedVariant } from "../lib/mining";
import { formatIsk, typeIconUrl } from "../lib/format";
import { TRADE_HUB_REGIONS } from "../lib/map";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useSortableRows } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import { NumberStepperInput } from "./NumberStepperInput";

// Same category this session's Reprocessing tab already verified and uses
// (IndustryPage.tsx's ORE_CATEGORY_ID) - every group filed under EVE's real
// "Asteroid" item category is a mineable ore, ice, or moon-ore variant.
const ORE_CATEGORY_ID = 25;
const ICE_GROUP_NAMES = new Set(["Ice"]);
// The 5 real moon-ore rarity groups (confirmed against the local SDE this
// session) - excluded from Ore Mining, since they share category 25 with
// plain asteroid ore but need their own table (different normalization -
// per 1000m³, not 1m³ - and a materials list that varies per row instead
// of a fixed mineral column set).
const MOON_GROUP_NAMES = new Set([
  "Ubiquitous Moon Asteroids",
  "Common Moon Asteroids",
  "Uncommon Moon Asteroids",
  "Rare Moon Asteroids",
  "Exceptional Moon Asteroids",
]);
// Gas clouds live in a completely different category (Celestial, not
// Asteroid) and don't reprocess into anything - the item itself is what
// gets sold. Verified against the local SDE this session.
const GAS_GROUP_ID = 711; // "Harvestable Cloud"
const COMPRESSED_GAS_GROUP_ID = 4168; // "Compressed Gas"

const MINERAL_COLUMNS = [
  { typeId: 34, name: "Tritanium" },
  { typeId: 35, name: "Pyerite" },
  { typeId: 36, name: "Mexallon" },
  { typeId: 37, name: "Isogen" },
  { typeId: 38, name: "Nocxium" },
  { typeId: 39, name: "Zydrine" },
  { typeId: 40, name: "Megacyte" },
  { typeId: 11399, name: "Morphite" },
];

// Same 7 ice-product type ids this session already verified against the
// local synced SDE for the market ticker's watchlist.
const ICE_PRODUCT_COLUMNS = [
  { typeId: 16272, name: "Heavy Water" },
  { typeId: 16273, name: "Liquid Ozone" },
  { typeId: 16275, name: "Strontium Clathrates" },
  { typeId: 17887, name: "Oxygen Isotopes" },
  { typeId: 16274, name: "Helium Isotopes" },
  { typeId: 17889, name: "Hydrogen Isotopes" },
  { typeId: 17888, name: "Nitrogen Isotopes" },
];

type OreTableMode = "ore" | "ice" | "moon" | "gas";

interface OreTableRow {
  typeId: number;
  name: string;
  groupName: string;
  volume: number;
  perM3: Map<number, number>;
  materialList?: { name: string; qty: number }[];
  refinedValue: number;
}

interface GasRow {
  typeId: number;
  name: string;
  rawVolume: number;
  rawPrice: number | null;
  compressedTypeId: number | null;
  compressedVolume: number | null;
  compressedPrice: number | null;
}

/** Raw reprocessing recipe cache, keyed by type_id - shared across yield %
 * changes so adjusting the slider doesn't refetch anything, only
 * recomputes materialsPerCubicMeter (a pure, instant function). */
interface RawRecipe {
  typeId: number;
  name: string;
  groupName: string;
  volume: number;
  portionSize: number;
  materials: { type_id: number; name: string; quantity: number }[];
}

function OreTableTab() {
  const [mode, setMode] = useState<OreTableMode>("ore");
  const [defaultTradeHub] = useDefaultTradeHub();
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [yieldPct, setYieldPct] = useState(100);

  const [recipes, setRecipes] = useState<RawRecipe[] | null>(null);
  const [gasItems, setGasItems] = useState<{ id: number; name: string; volume: number }[] | null>(null);
  const [gasRows, setGasRows] = useState<GasRow[] | null>(null);
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const [loadingStage, setLoadingStage] = useState<"groups" | "items" | "recipes" | "prices" | "done">("groups");

  const columns = mode === "ore" ? MINERAL_COLUMNS : mode === "ice" ? ICE_PRODUCT_COLUMNS : [];

  // Ore/ice/moon are static reference data for the session (the same
  // groups/items/reprocessing recipes every time), so once a mode has been
  // loaded once its recipe list is cached here and switching back to it
  // later is instant instead of re-running the whole groups->items->
  // recipes fetch chain again.
  const recipeCacheRef = useRef<Map<Exclude<OreTableMode, "gas">, RawRecipe[]>>(new Map());

  useEffect(() => {
    if (mode === "gas") return; // handled by the gas-specific effect below
    // Captured once the "gas" case is ruled out - `mode` itself stays
    // narrowed only within this scope, not inside the nested async load()
    // below, so the cache's get/set both key off this instead.
    const activeMode = mode;
    const cached = recipeCacheRef.current.get(activeMode);
    if (cached) {
      setRecipes(cached);
      setLoadingStage("done");
      return;
    }
    let cancelled = false;
    setRecipes(null);
    setLoadingStage("groups");

    async function load() {
      const groups: GroupSummary[] = await getCategoryGroups(ORE_CATEGORY_ID);
      const relevantGroups = groups.filter((g) => {
        if (mode === "ice") return ICE_GROUP_NAMES.has(g.name);
        if (mode === "moon") return MOON_GROUP_NAMES.has(g.name);
        return !ICE_GROUP_NAMES.has(g.name) && !MOON_GROUP_NAMES.has(g.name);
      });
      if (cancelled) return;
      setLoadingStage("items");

      const itemLists = await Promise.all(relevantGroups.map((g) => getGroupItems(g.id).then((items) => ({ group: g, items }))));
      if (cancelled) return;
      const flatItems: { item: TypeSummary; groupName: string }[] = [];
      for (const { group, items } of itemLists) {
        for (const item of items) {
          if (isCompressedVariant(item.name)) continue;
          flatItems.push({ item, groupName: group.name });
        }
      }
      setLoadingStage("recipes");

      const loaded = await Promise.all(
        flatItems.map(async ({ item, groupName }): Promise<RawRecipe | null> => {
          try {
            const info = await getReprocessingMaterials(item.id);
            if (info.materials.length === 0) return null;
            return { typeId: item.id, name: item.name, groupName, volume: item.volume, portionSize: info.portion_size, materials: info.materials };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const finalRecipes = loaded.filter((r): r is RawRecipe => r != null);
      recipeCacheRef.current.set(activeMode, finalRecipes);
      setRecipes(finalRecipes);
      setLoadingStage("done");
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Gas is a completely different shape (no reprocessing step - the
  // harvested item itself is what sells, raw or compressed) so it gets its
  // own load path instead of forcing it through the ore/ice/moon recipe
  // machinery above.
  useEffect(() => {
    if (mode !== "gas") return;
    let cancelled = false;
    setGasRows(null);
    setLoadingStage("items");
    getGroupItems(GAS_GROUP_ID).then((items) => {
      if (!cancelled) setGasItems(items.map((i) => ({ id: i.id, name: i.name, volume: i.volume })));
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "gas" || !gasItems) return;
    let cancelled = false;
    setLoadingStage("prices");

    async function loadGasPrices() {
      const compressedItems = await getGroupItems(COMPRESSED_GAS_GROUP_ID);
      const compressedByName = new Map(compressedItems.map((c) => [c.name, c]));
      const compressedByRawId = new Map(gasItems!.map((g) => [g.id, compressedByName.get(`Compressed ${g.name}`) ?? null]));
      // One batched price call for every raw + compressed type id instead
      // of a getRegionSellMinPrice round trip per item (up to ~56 of them
      // across the ~28 gas types) - getRegionSellMinPrices already exists
      // for exactly this and is used one effect down for the ore/ice/moon
      // columns.
      const allTypeIds = [...gasItems!.map((g) => g.id), ...[...compressedByRawId.values()].filter((c) => c != null).map((c) => c!.id)];
      const priceMap = await getRegionSellMinPrices(hubRegionId, allTypeIds);
      if (cancelled) return;
      const rows: GasRow[] = gasItems!.map((g) => {
        const compressed = compressedByRawId.get(g.id) ?? null;
        return {
          typeId: g.id,
          name: g.name,
          rawVolume: g.volume,
          // Left as null (not 0) when the region has no sell orders for
          // this item, so the table can show "-" instead of a misleading
          // "0.00 ISK" that reads as a real price.
          rawPrice: priceMap.get(g.id) ?? null,
          compressedTypeId: compressed?.id ?? null,
          compressedVolume: compressed?.volume ?? null,
          compressedPrice: compressed ? priceMap.get(compressed.id) ?? null : null,
        };
      });
      if (!cancelled) {
        setGasRows(rows);
        setLoadingStage("done");
      }
    }

    loadGasPrices();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, gasItems, hubRegionId]);

  // Live prices for just the fixed column set (8 minerals or 7 ice
  // products) - one bulk call regardless of how many ore/ice/moon rows
  // exist, since every row prices against the same small product list.
  useEffect(() => {
    if (mode === "gas") return;
    let cancelled = false;
    const typeIds = mode === "moon" ? Array.from(new Set((recipes ?? []).flatMap((r) => r.materials.map((m) => m.type_id)))) : columns.map((c) => c.typeId);
    if (typeIds.length === 0) return;
    getRegionSellMinPrices(hubRegionId, typeIds).then((next) => {
      if (!cancelled) setPrices(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubRegionId, mode, recipes]);

  const rows: OreTableRow[] = useMemo(() => {
    if (!recipes) return [];
    const yieldFraction = Math.max(0, yieldPct) / 100;
    return recipes.map((r) => {
      // Ore/moon are normalized per m³ mined (a mining laser pulls a
      // constant volume, and volumes-per-unit vary wildly - 0.1m³ Veldspar
      // vs 40m³ Mercoxit - so per-m³ is what actually makes them
      // comparable). Moon ore specifically scales that per-m³ figure up
      // to "per 1000 m³" to match ore.cerlestes.de's own displayed unit
      // (verified this session against real numbers - Bitumens' 6,000
      // Pyerite/400 Mexallon/65 Hydrocarbons per 1000m³ matched exactly).
      // Ice is normalized per UNIT instead: every ice block reprocesses as
      // one indivisible portion (portion_size is always 1) regardless of
      // its own volume, so "per m³" would just be "per unit ÷ 1000" for
      // every ice type equally. Confirmed against ore.cerlestes.de's own
      // real numbers: Blue Ice shows 69/35/1/414 (per-unit), not
      // 0.069/0.035/0.001/0.414 (per-m³).
      const scale = mode === "moon" ? 1000 : 1;
      const densities = materialsPerCubicMeter(r.materials, r.portionSize, mode === "ice" ? 1 : r.volume, yieldFraction).map((d) => ({
        ...d,
        perM3: d.perM3 * scale,
      }));
      const perM3 = new Map(densities.map((d) => [d.typeId, d.perM3]));
      const refinedValue = densities.reduce((sum, d) => sum + d.perM3 * (prices.get(d.typeId) ?? 0), 0);
      const materialList = mode === "moon" ? densities.filter((d) => d.perM3 > 0).map((d) => ({ name: d.name, qty: d.perM3 })) : undefined;
      return { typeId: r.typeId, name: r.name, groupName: r.groupName, volume: r.volume, perM3, materialList, refinedValue };
    });
  }, [recipes, yieldPct, prices, mode]);

  const sortAccessors = useMemo(() => {
    const accessors: Record<string, (row: OreTableRow) => string | number | null> = {
      name: (row) => row.name,
      volume: (row) => row.volume,
      refinedValue: (row) => row.refinedValue,
    };
    for (const c of columns) accessors[`m_${c.typeId}`] = (row) => row.perM3.get(c.typeId) ?? null;
    return accessors;
  }, [columns]);
  const { rows: sortedRows, sortKey, sortDir, sort } = useSortableRows(rows, sortAccessors, "refinedValue", "desc");

  const sortedGasRows = useSortableRows(
    gasRows ?? [],
    {
      name: (g) => g.name,
      rawIskPerM3: (g) => (g.rawPrice != null ? g.rawPrice / g.rawVolume : null),
      compressedIskPerM3: (g) => (g.compressedPrice != null && g.compressedVolume ? g.compressedPrice / g.compressedVolume : null),
      premium: (g) => {
        const rawPerM3 = g.rawPrice != null ? g.rawPrice / g.rawVolume : null;
        const compPerM3 = g.compressedPrice != null && g.compressedVolume ? g.compressedPrice / g.compressedVolume : null;
        return compPerM3 != null && rawPerM3 != null && rawPerM3 > 0 ? ((compPerM3 - rawPerM3) / rawPerM3) * 100 : null;
      },
    },
    "premium",
    "desc",
  );

  const loading = loadingStage !== "done";

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="kills-tabs">
          <button type="button" className={`kills-tab${mode === "ore" ? " kills-tab-active" : ""}`} onClick={() => setMode("ore")}>
            Ore Mining
          </button>
          <button type="button" className={`kills-tab${mode === "ice" ? " kills-tab-active" : ""}`} onClick={() => setMode("ice")}>
            Ice Harvesting
          </button>
          <button type="button" className={`kills-tab${mode === "moon" ? " kills-tab-active" : ""}`} onClick={() => setMode("moon")}>
            Moon Ores
          </button>
          <button type="button" className={`kills-tab${mode === "gas" ? " kills-tab-active" : ""}`} onClick={() => setMode("gas")}>
            Gas Harvesting
          </button>
        </div>

        <div className="industry-input-grid">
          {mode !== "gas" && (
            <label className="wh-field-label">
              Refining Yield %
              <NumberStepperInput value={yieldPct} onChange={setYieldPct} min={0} max={100} step={1} className="industry-field-input" />
            </label>
          )}
          <label className="wh-field-label">
            Trade Hub
            <select className="industry-field-input" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
              {TRADE_HUB_REGIONS.map((h) => (
                <option key={h.regionId} value={h.regionId}>
                  {h.regionName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="industry-results-panel">
        {loading ? (
          <p className="detail-empty">
            {loadingStage === "groups" ? "Loading types..." : loadingStage === "items" ? "Loading variants..." : loadingStage === "prices" ? "Loading prices..." : "Loading reprocessing data..."}
          </p>
        ) : mode === "gas" ? (
          <>
            <p className="wh-side-label">Raw vs. compressed value per m³</p>
            <p className="settings-section-hint">
              Compression ratios for gas aren't reliably derivable from the local game data, so this stops at
              ISK/m³ for each form rather than guessing at a decompressed-price comparison - the ISK/m³ premium
              already answers "is it worth compressing before I haul it."
            </p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="Name" sortKey="name" activeKey={sortedGasRows.sortKey} dir={sortedGasRows.sortDir} onSort={sortedGasRows.sort} defaultDir="asc" />
                    <SortableTh label="Raw ISK/m³" sortKey="rawIskPerM3" activeKey={sortedGasRows.sortKey} dir={sortedGasRows.sortDir} onSort={sortedGasRows.sort} numeric />
                    <SortableTh
                      label="Compressed ISK/m³"
                      sortKey="compressedIskPerM3"
                      activeKey={sortedGasRows.sortKey}
                      dir={sortedGasRows.sortDir}
                      onSort={sortedGasRows.sort}
                      numeric
                    />
                    <SortableTh label="Compression Premium" sortKey="premium" activeKey={sortedGasRows.sortKey} dir={sortedGasRows.sortDir} onSort={sortedGasRows.sort} numeric />
                  </tr>
                </thead>
                <tbody>
                  {sortedGasRows.rows.map((g) => {
                    const rawPerM3 = g.rawPrice != null ? g.rawPrice / g.rawVolume : null;
                    const compPerM3 = g.compressedPrice != null && g.compressedVolume ? g.compressedPrice / g.compressedVolume : null;
                    const premium = compPerM3 != null && rawPerM3 != null && rawPerM3 > 0 ? ((compPerM3 - rawPerM3) / rawPerM3) * 100 : null;
                    return (
                      <tr key={g.typeId}>
                        <td className="industry-shopping-list-name">
                          <img src={typeIconUrl(g.typeId, 32, g.name)} alt="" className="market-browser-row-icon" />
                          {g.name}
                        </td>
                        <td className="data-table-numeric market-stat-value-isk">{rawPerM3 != null ? formatIsk(rawPerM3) : "–"}</td>
                        <td className="data-table-numeric market-stat-value-isk">{compPerM3 != null ? formatIsk(compPerM3) : "–"}</td>
                        <td className={`data-table-numeric${premium != null ? (premium >= 0 ? " wallet-amount-positive" : " wallet-amount-negative") : ""}`}>
                          {premium != null ? `${premium >= 0 ? "+" : ""}${premium.toFixed(1)}%` : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <p className="wh-side-label">
              {mode === "ore"
                ? `Minerals in 1 m³ ore at ${yieldPct}% yield`
                : mode === "ice"
                  ? `Products in 1 ice at ${yieldPct}% yield`
                  : `Materials in 1000 m³ moon ore at ${yieldPct}% yield`}
            </p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={sort} defaultDir="asc" />
                    <SortableTh label="m³" sortKey="volume" activeKey={sortKey} dir={sortDir} onSort={sort} numeric defaultDir="asc" />
                    {columns.map((c) => (
                      <SortableTh key={c.typeId} label={c.name} sortKey={`m_${c.typeId}`} activeKey={sortKey} dir={sortDir} onSort={sort} numeric />
                    ))}
                    {mode === "moon" && <th>Materials</th>}
                    <SortableTh label="Refined Value" sortKey="refinedValue" activeKey={sortKey} dir={sortDir} onSort={sort} numeric />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.typeId}>
                      <td className="industry-shopping-list-name">
                        <img src={typeIconUrl(row.typeId, 32, row.name)} alt="" className="market-browser-row-icon" />
                        {row.name}
                      </td>
                      <td className="data-table-numeric">{row.volume.toLocaleString()}</td>
                      {columns.map((c) => {
                        const v = row.perM3.get(c.typeId) ?? 0;
                        return (
                          <td key={c.typeId} className="data-table-numeric">
                            {v > 0 ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "–"}
                          </td>
                        );
                      })}
                      {mode === "moon" && (
                        <td className="ore-table-materials-cell">
                          {row.materialList?.map((m) => `${m.qty.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${m.name}`).join(", ")}
                        </td>
                      )}
                      <td className="data-table-numeric wallet-amount-positive">{formatIsk(row.refinedValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default OreTableTab;
