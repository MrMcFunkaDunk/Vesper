import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Star } from "lucide-react";
import { getMapData, regionHubColor, regionLabelWithHub, TRADE_HUB_REGIONS, tradeHubName, type MapData } from "../lib/map";
import { toCsv, downloadCsv } from "../lib/csvExport";
import MarketHistoryChart from "./MarketHistoryChart";
import {
  searchMarketTypes,
  getMarketGroups,
  getMarketGroupTypes,
  getRegionMarketOrders,
  getRegionMarketHistory,
  resolveMarketLocations,
  getItemDescription,
  type TypeSearchMatch,
  type MarketGroupNode,
  type TypeSummary,
  type MarketOrder,
  type MarketHistoryPoint,
} from "../lib/market";
import { formatIsk, formatSecurity, securityColor, formatTimeRemaining, typeIconUrl } from "../lib/format";
import type { SessionCharacter } from "../lib/eve";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import { useMarketFavourites } from "../hooks/useMarketFavourites";

/** CCP's own per-category art, extracted once from the official (now
 * deprecated but still hosted) Image Export Collection and bundled as
 * static assets, keyed by the same iconID every market group in the SDE
 * already carries - there's no live public endpoint for these the way
 * images.evetech.net covers item/character/corp/alliance icons, so this is
 * the only way to show the real category icon at every tier of the tree
 * instead of only the top level. Covers 307 of the 444 distinct iconIDs
 * actually used across the whole tree (~69%) - established, long-standing
 * categories are all in that set; a handful of very new or obscure ones
 * just render without an icon rather than a misleading stand-in. */
const iconModules = import.meta.glob("../assets/market-icons/icon-*.png", { eager: true, import: "default" }) as Record<
  string,
  string
>;
export const CATEGORY_ICON_BY_ICON_ID: Record<number, string> = {};
for (const [path, url] of Object.entries(iconModules)) {
  const match = path.match(/icon-(\d+)\.png$/);
  if (match) CATEGORY_ICON_BY_ICON_ID[Number(match[1])] = url;
}

/** Walks parent_id up to the root, returning root-to-leaf order, so the
 * item detail panel can show "Ships → Frigates → ..." for whichever
 * category the currently viewed item actually lives under. */
function getAncestorPath(groupId: number, groups: MarketGroupNode[]): MarketGroupNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const path: MarketGroupNode[] = [];
  let current = byId.get(groupId);
  while (current) {
    path.unshift(current);
    current = current.parent_id != null ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

export interface CategoryTreeNodeProps {
  group: MarketGroupNode;
  depth: number;
  childrenByParent: Map<number | null, MarketGroupNode[]>;
  expandedIds: Set<number>;
  toggleExpand: (group: MarketGroupNode) => void;
  groupTypesCache: Record<number, TypeSummary[]>;
  selectedTypeId: number | null;
  onPickType: (t: TypeSummary, groupId: number) => void;
}

/** One row of the market category tree, recursing into its own children
 * (and, once expanded, its items) so every tier is browsable at once
 * instead of only one level at a time. Every row - not just the top
 * level - shows its real CCP category icon when we have one bundled. */
export function CategoryTreeNode({
  group,
  depth,
  childrenByParent,
  expandedIds,
  toggleExpand,
  groupTypesCache,
  selectedTypeId,
  onPickType,
}: CategoryTreeNodeProps) {
  const children = childrenByParent.get(group.id) ?? [];
  const isExpanded = expandedIds.has(group.id);
  const types = groupTypesCache[group.id];
  const hasChildrenOrTypes = children.length > 0 || group.has_types;
  const indent = 10 + depth * 18;
  const icon = group.icon_id != null ? CATEGORY_ICON_BY_ICON_ID[group.icon_id] : undefined;

  return (
    <div className="market-tree-node">
      <button type="button" className="market-browser-tree-item" style={{ paddingLeft: indent }} onClick={() => toggleExpand(group)}>
        {icon && <img src={icon} alt="" className="market-browser-row-icon" />}
        <span className="market-browser-tree-item-label">{group.name}</span>
        {hasChildrenOrTypes && (
          <ChevronRight size={13} strokeWidth={2} className={`market-tree-chevron${isExpanded ? " market-tree-chevron-open" : ""}`} />
        )}
      </button>
      {isExpanded && (
        <div className="market-tree-children">
          {children.map((child) => (
            <CategoryTreeNode
              key={child.id}
              group={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              groupTypesCache={groupTypesCache}
              selectedTypeId={selectedTypeId}
              onPickType={onPickType}
            />
          ))}
          {group.has_types &&
            (types == null ? (
              <p className="detail-empty market-tree-loading">Loading...</p>
            ) : types.length === 0 ? (
              <p className="detail-empty market-tree-loading">No items in this category.</p>
            ) : (
              types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  style={{ paddingLeft: indent + 18 }}
                  className={`market-browser-tree-item market-browser-tree-item-leaf${selectedTypeId === t.id ? " market-browser-tree-item-active" : ""}`}
                  onClick={() => onPickType(t, group.id)}
                >
                  <img src={typeIconUrl(t.id, 32, t.name)} alt="" className="market-browser-row-icon" />
                  {t.name}
                </button>
              ))
            ))}
        </div>
      )}
    </div>
  );
}

function locationCell(order: MarketOrder, locationNames: Record<number, string>, systemLookup: Map<number, { name: string; security: number }>) {
  const sys = systemLookup.get(order.system_id);
  const locationName = locationNames[order.location_id];
  return (
    <td className="market-browser-location-cell">
      <span className="market-browser-location-name">{locationName ?? `Location #${order.location_id}`}</span>
      <span className="market-browser-location-system">
        {sys && (
          <span className="kills-security" style={{ color: securityColor(sys.security) }}>{formatSecurity(sys.security)}</span>
        )}{" "}
        {sys?.name ?? `System #${order.system_id}`}
      </span>
    </td>
  );
}

function expiresIn(order: MarketOrder): string {
  const expiryMs = new Date(order.issued).getTime() + order.duration * 86_400_000;
  return formatTimeRemaining(new Date(expiryMs).toISOString());
}

export interface MarketItemRef {
  id: number;
  name: string;
}

interface MarketBrowserProps {
  characters: SessionCharacter[];
  /** An item to jump straight into, e.g. from clicking an item on a kill's fit. */
  initialItem?: MarketItemRef | null;
  onConsumeInitialItem?: () => void;
}

/** One trade hub's row in the Compare Trade Hubs table - same metrics as
 * the single-region stat cards above the tabs, just computed per hub
 * instead of only for whichever region is currently selected. */
interface HubStat {
  latestAverage: number | null;
  bestSell: number | null;
  bestBuy: number | null;
  spread: number | null;
  spreadPct: number | null;
  splitPrice: number | null;
  avgVolume7d: number | null;
}

function MarketBrowser({ characters, initialItem, onConsumeInitialItem }: MarketBrowserProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  // Two permanently-visible, mutually exclusive pickers rather than a
  // toggle-to-reveal "custom" fallback: the Trade Hub list has only the 5
  // hubs, the All Other Regions list has every region except those 5. Both
  // just write straight into the same regionId - whichever one you touch
  // last wins. Each tracks its own "have I actually been used yet" flag so
  // its closed-state text can show a generic "Trade Hubs" / "All Other
  // Regions" placeholder rather than a real (and possibly wrong-list)
  // selection until the user actually picks something from it - picking
  // from one clears the other's flag so they can't both claim to be active.
  const [defaultTradeHub] = useDefaultTradeHub();
  const [regionId, setRegionId] = useState(defaultTradeHub);
  const [hubTouched, setHubTouched] = useState(false);
  const [otherRegionTouched, setOtherRegionTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TypeSearchMatch[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<TypeSearchMatch | TypeSummary | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [itemTab, setItemTab] = useState<"orders" | "history">("orders");
  const [description, setDescription] = useState<string | null>(null);
  const { favourites, isFavourite, toggleFavourite } = useMarketFavourites();
  const [favouritesOpen, setFavouritesOpen] = useState(false);

  const [marketGroups, setMarketGroups] = useState<MarketGroupNode[] | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [groupTypesCache, setGroupTypesCache] = useState<Record<number, TypeSummary[]>>({});

  const [orders, setOrders] = useState<MarketOrder[] | null>(null);
  const [history, setHistory] = useState<MarketHistoryPoint[] | null>(null);
  const [locationNames, setLocationNames] = useState<Record<number, string>>({});
  const [loadingItem, setLoadingItem] = useState(false);

  // Trade-hub comparison for the Price History view - collapsed and
  // unfetched by default (10 extra ESI calls, 5 hubs x orders+history), so
  // it only costs anything once someone actually wants to see all 5 side
  // by side rather than every time an item's history is opened.
  const [hubComparisonOpen, setHubComparisonOpen] = useState(false);
  const [hubStats, setHubStats] = useState<Map<number, HubStat> | null>(null);
  const [hubStatsLoading, setHubStatsLoading] = useState(false);

  useEffect(() => {
    getMapData().then(setMapData).catch(() => {});
    getMarketGroups().then(setMarketGroups).catch(() => {});
  }, []);

  useEffect(() => {
    if (!initialItem) return;
    pickType({ id: initialItem.id, name: initialItem.name, slot_type: null, volume: 0 });
    onConsumeInitialItem?.();
    // Only meant to consume the value this component received, not re-fire
    // on every render (pickType/onConsumeInitialItem are stable enough for
    // this to be a one-shot effect keyed on the incoming item itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem]);

  useEffect(() => {
    if (!selectedType) {
      setDescription(null);
      return;
    }
    let cancelled = false;
    setDescription(null);
    getItemDescription(selectedType.id)
      .then((d) => {
        if (!cancelled) setDescription(d);
      })
      .catch(() => {
        if (!cancelled) setDescription("");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedType]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMarketTypes(trimmed)
        .then((results) => {
          if (cancelled) return;
          setSuggestions(results);
          setSuggestionsOpen(results.length > 0);
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
    if (!selectedType) {
      setOrders(null);
      setHistory(null);
      return;
    }
    setLoadingItem(true);
    setOrders(null);
    setHistory(null);
    setItemTab("orders");
    Promise.all([getRegionMarketOrders(regionId, selectedType.id), getRegionMarketHistory(regionId, selectedType.id)])
      .then(([o, h]) => {
        setOrders(o);
        setHistory(h);
      })
      .catch(() => {
        setOrders([]);
        setHistory([]);
      })
      .finally(() => setLoadingItem(false));
  }, [regionId, selectedType]);

  // A new item invalidates any comparison fetched for the last one - closed
  // and cleared rather than left showing stale numbers under the new name.
  useEffect(() => {
    setHubComparisonOpen(false);
    setHubStats(null);
  }, [selectedType]);

  useEffect(() => {
    if (!hubComparisonOpen || !selectedType || hubStats) return;
    let cancelled = false;
    setHubStatsLoading(true);
    Promise.all(
      TRADE_HUB_REGIONS.map(async (h): Promise<readonly [number, HubStat]> => {
        const [hubOrders, hubHistory] = await Promise.all([
          getRegionMarketOrders(h.regionId, selectedType.id).catch(() => []),
          getRegionMarketHistory(h.regionId, selectedType.id).catch(() => []),
        ]);
        const hubSells = hubOrders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
        const hubBuys = hubOrders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
        const bestSell = hubSells[0]?.price ?? null;
        const bestBuy = hubBuys[0]?.price ?? null;
        const spread = bestSell != null && bestBuy != null ? bestSell - bestBuy : null;
        const spreadPct = spread != null && bestSell ? (spread / bestSell) * 100 : null;
        const splitPrice = bestSell != null && bestBuy != null ? (bestSell + bestBuy) / 2 : null;
        const avgVolume7d =
          hubHistory.length > 0 ? hubHistory.slice(-7).reduce((sum, p) => sum + p.volume, 0) / Math.min(7, hubHistory.length) : null;
        const latestAverage = hubHistory.length > 0 ? hubHistory[hubHistory.length - 1].average : null;
        return [h.regionId, { latestAverage, bestSell, bestBuy, spread, spreadPct, splitPrice, avgVolume7d }];
      }),
    )
      .then((results) => {
        if (!cancelled) setHubStats(new Map(results));
      })
      .finally(() => {
        if (!cancelled) setHubStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hubComparisonOpen, selectedType, hubStats]);

  useEffect(() => {
    if (!orders || orders.length === 0 || characters.length === 0) {
      setLocationNames({});
      return;
    }
    const uniqueIds = [...new Set(orders.map((o) => o.location_id))];
    resolveMarketLocations(characters[0].id, uniqueIds)
      .then(setLocationNames)
      .catch(() => setLocationNames({}));
  }, [orders, characters]);

  function pickType(t: TypeSearchMatch | TypeSummary, groupId?: number) {
    setSelectedType(t);
    setSelectedGroupId(groupId ?? ("market_group_id" in t ? (t.market_group_id ?? null) : null));
    setQuery("");
    setSuggestions([]);
    setSuggestionsOpen(false);
  }

  function toggleExpand(group: MarketGroupNode) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(group.id)) next.delete(group.id);
      else next.add(group.id);
      return next;
    });
    if (group.has_types && !groupTypesCache[group.id]) {
      getMarketGroupTypes(group.id)
        .then((types) => setGroupTypesCache((prev) => ({ ...prev, [group.id]: types })))
        .catch(() => setGroupTypesCache((prev) => ({ ...prev, [group.id]: [] })));
    }
  }

  const childrenByParent = useMemo(() => {
    const map = new Map<number | null, MarketGroupNode[]>();
    for (const g of marketGroups ?? []) {
      const list = map.get(g.parent_id);
      if (list) list.push(g);
      else map.set(g.parent_id, [g]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [marketGroups]);
  const topLevelGroups = childrenByParent.get(null) ?? [];
  const breadcrumbTrail = useMemo(
    () => (selectedGroupId != null ? getAncestorPath(selectedGroupId, marketGroups ?? []).map((g) => g.name).join(" → ") : ""),
    [selectedGroupId, marketGroups],
  );

  const systemLookup = useMemo(() => {
    const map = new Map<number, { name: string; security: number }>();
    mapData?.systems.forEach((s) => map.set(s.id, { name: s.name, security: s.security }));
    return map;
  }, [mapData]);

  const sellOrders = (orders ?? []).filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
  const buyOrders = (orders ?? []).filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
  const bestSell = sellOrders[0]?.price;
  const bestBuy = buyOrders[0]?.price;
  const spread = bestSell != null && bestBuy != null ? bestSell - bestBuy : null;
  const spreadPct = spread != null && bestSell ? (spread / bestSell) * 100 : null;
  /** The midpoint between best sell and best buy - the standard "Jita split"
   * price player-to-player trades use to divide the market maker's spread
   * evenly, so neither side pays full broker fees/tax or eats the whole gap. */
  const splitPrice = bestSell != null && bestBuy != null ? (bestSell + bestBuy) / 2 : null;
  const avgVolume7d = history && history.length > 0 ? history.slice(-7).reduce((sum, p) => sum + p.volume, 0) / Math.min(7, history.length) : null;

  function exportItemTabCsv() {
    if (!selectedType) return;
    const namePrefix = selectedType.name.replace(/\s+/g, "_");
    if (itemTab === "history") {
      if (!history) return;
      const csv = toCsv(history, [
        { header: "Date", value: (p) => p.date },
        { header: "Average", value: (p) => p.average },
        { header: "Highest", value: (p) => p.highest },
        { header: "Lowest", value: (p) => p.lowest },
        { header: "Order Count", value: (p) => p.order_count },
        { header: "Volume", value: (p) => p.volume },
      ]);
      downloadCsv(`${namePrefix}_price_history.csv`, csv);
      return;
    }
    const rows = [...sellOrders.map((o) => ({ ...o, side: "Sell" })), ...buyOrders.map((o) => ({ ...o, side: "Buy" }))];
    const csv = toCsv(rows, [
      { header: "Side", value: (o) => o.side },
      { header: "Price", value: (o) => o.price },
      { header: "Volume Remaining", value: (o) => o.volume_remain },
      { header: "Volume Total", value: (o) => o.volume_total },
      { header: "Min Volume", value: (o) => o.min_volume },
      { header: "Location", value: (o) => locationNames[o.location_id] ?? String(o.location_id) },
      { header: "Range", value: (o) => o.range },
      { header: "Issued", value: (o) => o.issued },
    ]);
    downloadCsv(`${namePrefix}_orders.csv`, csv);
  }

  return (
    <div className="market-browser">
      <div className="market-browser-toolbar">
        <select
          className="market-region-select"
          value={hubTouched ? regionId : ""}
          onChange={(e) => {
            setRegionId(Number(e.target.value));
            setHubTouched(true);
            setOtherRegionTouched(false);
          }}
        >
          <option value="" disabled hidden>
            Trade Hubs
          </option>
          {TRADE_HUB_REGIONS.map((hub) => (
            <option key={hub.regionId} value={hub.regionId} style={{ color: regionHubColor(hub.regionName) }}>
              {regionLabelWithHub(hub.regionName)}
            </option>
          ))}
        </select>
        <select
          className="market-region-select"
          value={otherRegionTouched ? regionId : ""}
          onChange={(e) => {
            setRegionId(Number(e.target.value));
            setOtherRegionTouched(true);
            setHubTouched(false);
          }}
        >
          <option value="" disabled hidden>
            All Other Regions
          </option>
          {(mapData?.regions ?? [])
            .filter((r) => !TRADE_HUB_REGIONS.some((hub) => hub.regionId === r.id))
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>

      <div className="market-browser-layout">
        <div className="market-browser-tree">
          <div className="market-browser-favourites">
            <button
              type="button"
              className={`market-browser-favourites-toggle${favouritesOpen ? " market-browser-favourites-toggle-active" : ""}`}
              onClick={() => setFavouritesOpen((v) => !v)}
            >
              <Star size={14} strokeWidth={2} fill={favouritesOpen ? "currentColor" : "none"} />
              My Favourites
              {favourites.length > 0 && <span className="market-browser-favourites-count">{favourites.length}</span>}
            </button>
            {favouritesOpen && (
              favourites.length === 0 ? (
                <p className="market-browser-favourites-empty">
                  No favourites yet - open an item below and click the star next to its name to add it here.
                </p>
              ) : (
                <div className="market-browser-favourites-list">
                  {favourites.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => pickType({ id: f.id, name: f.name, slot_type: null, volume: 0 })}
                    >
                      <img src={typeIconUrl(f.id, 32, f.name)} alt="" className="market-browser-row-icon" />
                      {f.name}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>

          <div className="kills-add-combobox market-browser-search">
            <input
              type="text"
              placeholder="Search for an item (e.g. Tritanium, Raven)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
              onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
            />
            {suggestionsOpen && (
              <div className="gatecheck-slot-results kills-add-suggestions">
                {suggestions.map((s) => (
                  <button key={s.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickType(s)}>
                    <img src={typeIconUrl(s.id, 32, s.name)} alt="" className="market-browser-row-icon" />
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {expandedIds.size > 0 && (
            <button type="button" className="skill-action-btn market-browser-collapse-all" onClick={() => setExpandedIds(new Set())}>
              Collapse All
            </button>
          )}

          <div className="market-browser-tree-list">
            {topLevelGroups.map((g) => (
              <CategoryTreeNode
                key={g.id}
                group={g}
                depth={0}
                childrenByParent={childrenByParent}
                expandedIds={expandedIds}
                toggleExpand={toggleExpand}
                groupTypesCache={groupTypesCache}
                selectedTypeId={selectedType?.id ?? null}
                onPickType={pickType}
              />
            ))}
          </div>
        </div>

        <div className="market-browser-main">
          {!selectedType ? (
            <p className="detail-empty">Search for an item or browse the categories to check its market.</p>
          ) : loadingItem ? (
            <p className="detail-empty">Loading {selectedType.name}...</p>
          ) : (
            <>
              <div className="market-browser-item-header">
                <img src={typeIconUrl(selectedType.id, 64, selectedType.name)} alt="" className="market-browser-item-icon" />
                <div className="market-browser-item-title">
                  <span className="market-browser-crumb-trail">
                    {breadcrumbTrail || "All Categories"}
                  </span>
                  <h3>{selectedType.name}</h3>
                </div>
                <button
                  type="button"
                  className={`market-browser-favourite-star${isFavourite(selectedType.id) ? " market-browser-favourite-star-active" : ""}`}
                  onClick={() => toggleFavourite({ id: selectedType.id, name: selectedType.name })}
                  title={isFavourite(selectedType.id) ? "Remove from My Favourites" : "Add to My Favourites"}
                  aria-label={isFavourite(selectedType.id) ? "Remove from My Favourites" : "Add to My Favourites"}
                >
                  <Star size={18} strokeWidth={2} fill={isFavourite(selectedType.id) ? "currentColor" : "none"} />
                </button>
              </div>

              {description && <p className="market-browser-item-description">{description}</p>}

              <div className="market-browser-stats">
                <div className="market-stat-card">
                  <span className="market-stat-label">Avg Vol (7d)</span>
                  <span className="market-stat-value market-stat-value-accent">
                    {avgVolume7d != null ? Math.round(avgVolume7d).toLocaleString() : "—"}
                  </span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Spread</span>
                  <span className="market-stat-value market-stat-value-warning">
                    {spread != null ? `${formatIsk(spread)}${spreadPct != null ? ` (${spreadPct.toFixed(1)}%)` : ""}` : "—"}
                  </span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Best Sell</span>
                  <span className="market-stat-value wallet-amount-negative">{bestSell != null ? formatIsk(bestSell) : "—"}</span>
                </div>
                <div className="market-stat-card">
                  <span className="market-stat-label">Best Buy</span>
                  <span className="market-stat-value wallet-amount-positive">{bestBuy != null ? formatIsk(bestBuy) : "—"}</span>
                </div>
                <div className="market-stat-card" title="The midpoint between Best Sell and Best Buy - the fair price for a direct player trade, splitting the market spread evenly instead of either side paying the full gap or broker fees/tax.">
                  <span className="market-stat-label">Split Price</span>
                  <span className="market-stat-value market-stat-value-isk">{splitPrice != null ? formatIsk(splitPrice) : "—"}</span>
                </div>
              </div>

              <div className="kills-tabs">
                <button
                  type="button"
                  className={`kills-tab ${itemTab === "orders" ? "kills-tab-active" : ""}`}
                  onClick={() => setItemTab("orders")}
                >
                  Market Data
                </button>
                <button
                  type="button"
                  className={`kills-tab ${itemTab === "history" ? "kills-tab-active" : ""}`}
                  onClick={() => setItemTab("history")}
                >
                  Price History
                </button>
                <button type="button" className="skill-action-btn market-item-export-btn" onClick={exportItemTabCsv}>
                  Export CSV
                </button>
              </div>

              {itemTab === "history" && (
                <div className="fit-section market-hub-compare">
                  <button type="button" className="fit-section-header" onClick={() => setHubComparisonOpen((v) => !v)}>
                    <ChevronRight size={14} strokeWidth={2} className={hubComparisonOpen ? "market-hub-compare-chevron-open" : undefined} />
                    Compare Trade Hubs
                  </button>
                  {hubComparisonOpen && (
                    <div className="fit-section-body">
                      {hubStatsLoading && !hubStats ? (
                        <p className="detail-empty">Checking all 5 trade hubs...</p>
                      ) : !hubStats ? null : (
                        <div className="data-table-wrap">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Trade Hub</th>
                                <th className="data-table-numeric market-history-grid-average">Average</th>
                                <th className="data-table-numeric">Spread</th>
                                <th className="data-table-numeric wallet-amount-negative">Best Sell</th>
                                <th className="data-table-numeric wallet-amount-positive">Best Buy</th>
                                <th className="data-table-numeric">Split Price</th>
                                <th className="data-table-numeric">Avg Vol (7d)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {TRADE_HUB_REGIONS.map((h) => {
                                const s = hubStats.get(h.regionId);
                                return (
                                  <tr key={h.regionId}>
                                    <td>{tradeHubName(h.regionName)}</td>
                                    <td className="data-table-numeric market-history-grid-average">
                                      {s?.latestAverage != null ? formatIsk(s.latestAverage) : "—"}
                                    </td>
                                    <td className="data-table-numeric market-stat-value-warning">
                                      {s?.spread != null ? `${formatIsk(s.spread)}${s.spreadPct != null ? ` (${s.spreadPct.toFixed(1)}%)` : ""}` : "—"}
                                    </td>
                                    <td className="data-table-numeric wallet-amount-negative">{s?.bestSell != null ? formatIsk(s.bestSell) : "—"}</td>
                                    <td className="data-table-numeric wallet-amount-positive">{s?.bestBuy != null ? formatIsk(s.bestBuy) : "—"}</td>
                                    <td className="data-table-numeric market-stat-value-isk">{s?.splitPrice != null ? formatIsk(s.splitPrice) : "—"}</td>
                                    <td className="data-table-numeric">{s?.avgVolume7d != null ? Math.round(s.avgVolume7d).toLocaleString() : "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {itemTab === "history" ? (
                history && <MarketHistoryChart points={history} />
              ) : (
                <div className="market-browser-books">
                  <div className="data-table-wrap market-browser-book">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th colSpan={5}>Sellers ({sellOrders.length})</th>
                        </tr>
                        <tr>
                          <th className="data-table-numeric">Price</th>
                          <th className="data-table-numeric">Volume</th>
                          <th className="data-table-numeric">Min</th>
                          <th>Location</th>
                          <th>Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sellOrders.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="detail-empty">
                              No sell orders in this region.
                            </td>
                          </tr>
                        ) : (
                          sellOrders.slice(0, 50).map((o) => (
                            <tr key={o.order_id}>
                              <td className="data-table-numeric wallet-amount-negative">{formatIsk(o.price)}</td>
                              <td className="data-table-numeric">
                                {o.volume_remain.toLocaleString()} / {o.volume_total.toLocaleString()}
                              </td>
                              <td className="data-table-numeric">{o.min_volume}</td>
                              {locationCell(o, locationNames, systemLookup)}
                              <td>{expiresIn(o)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="data-table-wrap market-browser-book">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th colSpan={6}>Buyers ({buyOrders.length})</th>
                        </tr>
                        <tr>
                          <th className="data-table-numeric">Price</th>
                          <th className="data-table-numeric">Volume</th>
                          <th className="data-table-numeric">Min</th>
                          <th>Location</th>
                          <th>Range</th>
                          <th>Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {buyOrders.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="detail-empty">
                              No buy orders in this region.
                            </td>
                          </tr>
                        ) : (
                          buyOrders.slice(0, 50).map((o) => (
                            <tr key={o.order_id}>
                              <td className="data-table-numeric wallet-amount-positive">{formatIsk(o.price)}</td>
                              <td className="data-table-numeric">
                                {o.volume_remain.toLocaleString()} / {o.volume_total.toLocaleString()}
                              </td>
                              <td className="data-table-numeric">{o.min_volume}</td>
                              {locationCell(o, locationNames, systemLookup)}
                              <td>{o.range === "region" ? "Region" : o.range === "solarsystem" ? "System" : o.range === "station" ? "Station" : `${o.range} jumps`}</td>
                              <td>{expiresIn(o)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default MarketBrowser;
