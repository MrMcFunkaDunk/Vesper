import { useEffect, useMemo, useState } from "react";
import { Rocket, Trash2, RefreshCw } from "lucide-react";
import { listFits, saveFit, deleteFit, syncCharacterFittings, sendFitToCharacter, type Fit } from "../lib/fittings";
import { getMarketPrices } from "../lib/market";
import { resolveEntityNames } from "../lib/wars";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import FitBuilder from "./FitBuilder";
import PageTabBar from "./PageTabBar";
import ShipFitPanel from "./ShipFitPanel";
import { SortableTh } from "./SortableTh";
import { useSortableRows } from "../hooks/useSortableRows";
import { getCharacterAssets, type SessionCharacter, type AssetEntry } from "../lib/eve";

interface FittingsPageProps {
  characters: SessionCharacter[];
  /** A ship to jump straight into the builder with, e.g. from Item
   * Database's "Fit This Ship" button (now on the Wallet & Market page). */
  initialShipTypeId?: number | null;
  onConsumeInitialShipTypeId?: () => void;
  /** A sub-tab favourite ("fittings-fleets.builder") clicked in the Sidebar -
   * jumps straight to that tab, one-shot like initialShipTypeId above. */
  initialTab?: string | null;
  onConsumeInitialTab?: () => void;
  /** Reports the active tab up to App.tsx so the TopBar star button knows
   * which specific tab to favourite. */
  onActiveTabChange?: (tab: string) => void;
}

type FitTab = "library" | "builder" | "ships";
const FIT_TABS: { id: FitTab; label: string }[] = [
  { id: "library", label: "My Fits" },
  { id: "builder", label: "New Fit" },
  { id: "ships", label: "My Ships" },
];
const FIT_TAB_IDS: FitTab[] = FIT_TABS.map((t) => t.id);

interface OwnedShip extends AssetEntry {
  characterName: string;
}

const PURPOSES = ["PvP", "PvE", "Exploring", "Industry", "Mining", "Mission", "Other"];

/** Ship + a picker's worth of items priced from a bulk map - the same
 * average-price valuation used elsewhere in this app (Appraisal, etc.),
 * an estimate rather than a live buy-order quote. */
function computeCost(fit: Fit, priceById: Map<number, number>): number {
  let total = priceById.get(fit.ship_type_id) ?? 0;
  for (const item of fit.items) total += (priceById.get(item.type_id) ?? 0) * item.quantity;
  return total;
}

function emptyFit(): Fit {
  return {
    id: "",
    name: "New Fit",
    ship_type_id: 0,
    description: "",
    purpose: "PvP",
    tags: [],
    items: [],
    source: "local",
    esi_character_id: null,
    created_at: 0,
    updated_at: 0,
  };
}

function FittingsPage({
  characters,
  initialShipTypeId,
  onConsumeInitialShipTypeId,
  initialTab,
  onConsumeInitialTab,
  onActiveTabChange,
}: FittingsPageProps) {
  const [tab, setTab] = useState<FitTab>("library");

  useEffect(() => {
    if (initialTab && (FIT_TAB_IDS as string[]).includes(initialTab)) {
      setTab(initialTab as FitTab);
      onConsumeInitialTab?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  useEffect(() => {
    onActiveTabChange?.(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [fits, setFits] = useState<Fit[] | null>(null);
  const [priceById, setPriceById] = useState<Map<number, number>>(new Map());
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [purposeFilter, setPurposeFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState<"All" | "local" | "esi">("All");
  const [characterFilter, setCharacterFilter] = useState<number | "All">("All");
  const [sort, setSort] = useState<"updated" | "name" | "cost">("updated");
  const [syncCharacterId, setSyncCharacterId] = useState<number | null>(characters[0]?.id ?? null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  /** The ship hull picked in the "browse by ship" grid - null shows every
   * hull that has at least one fit (per the current filters above); set
   * narrows the fit grid below it down to just that hull's fits, for
   * accounts with many fits per hull (e.g. 20 different Hulk fits) where
   * scrolling a flat list to find the right one gets tedious. */
  const [selectedShipTypeId, setSelectedShipTypeId] = useState<number | null>(null);

  const [draft, setDraft] = useState<Fit>(emptyFit());
  const [saving, setSaving] = useState(false);
  const [sendCharacterId, setSendCharacterId] = useState<number | null>(characters[0]?.id ?? null);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);

  const [shipAssets, setShipAssets] = useState<{ character: SessionCharacter; entries: AssetEntry[] }[] | null>(null);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [viewingFit, setViewingFit] = useState<OwnedShip | null>(null);

  const reportError = useErrorReporter();

  function loadFits() {
    listFits()
      .then(setFits)
      .catch((err) => reportError(`Failed to load fits: ${String(err)}`));
  }

  useEffect(() => {
    loadFits();
    getMarketPrices()
      .then((prices) => {
        const map = new Map<number, number>();
        for (const p of prices) if (p.average_price != null) map.set(p.type_id, p.average_price);
        setPriceById(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!fits || fits.length === 0) return;
    const ids = new Set<number>();
    for (const f of fits) {
      ids.add(f.ship_type_id);
      for (const item of f.items) ids.add(item.type_id);
    }
    resolveEntityNames([...ids])
      .then((resolved) => setNames((prev) => ({ ...prev, ...resolved })))
      .catch(() => {});
  }, [fits]);

  const filtered = useMemo(() => {
    if (!fits) return [];
    const q = query.trim().toLowerCase();
    let result = fits.filter((f) => {
      if (purposeFilter !== "All" && f.purpose !== purposeFilter) return false;
      if (sourceFilter !== "All" && f.source !== sourceFilter) return false;
      if (characterFilter !== "All" && f.esi_character_id !== characterFilter) return false;
      if (q) {
        const shipName = names[String(f.ship_type_id)] ?? "";
        const haystack = `${f.name} ${f.description} ${shipName} ${f.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    result = [...result].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "cost") return computeCost(b, priceById) - computeCost(a, priceById);
      return b.updated_at - a.updated_at;
    });
    return result;
  }, [fits, query, purposeFilter, sourceFilter, characterFilter, sort, names, priceById]);

  /** One tile per distinct hull among the currently filtered fits, sorted
   * alphabetically by ship name so a specific hull (e.g. "Hulk") is easy to
   * scan for rather than buried by recency or fit count. */
  const shipGroups = useMemo(() => {
    const counts = new Map<number, number>();
    for (const f of filtered) counts.set(f.ship_type_id, (counts.get(f.ship_type_id) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([shipTypeId, count]) => ({ shipTypeId, count, name: names[String(shipTypeId)] ?? `Type #${shipTypeId}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered, names]);

  useEffect(() => {
    if (selectedShipTypeId != null && !shipGroups.some((g) => g.shipTypeId === selectedShipTypeId)) {
      setSelectedShipTypeId(null);
    }
  }, [shipGroups, selectedShipTypeId]);

  function loadShipAssets() {
    if (characters.length === 0) return;
    setShipsLoading(true);
    Promise.all(
      characters.map((c) =>
        getCharacterAssets(c.id)
          .then((res) => ({ character: c, entries: res.entries }))
          .catch(() => ({ character: c, entries: [] as AssetEntry[] }))
      )
    )
      .then(setShipAssets)
      .finally(() => setShipsLoading(false));
  }

  useEffect(() => {
    if (tab === "ships" && shipAssets == null) loadShipAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /** Every asset grouped by its direct (unresolved) location_id, combined
   * across every character - an item_id is a globally unique EVE item
   * instance, so there's no collision risk merging characters into one map.
   * Mirrors the same lookup CharacterDetail's Assets tab uses to power its
   * own "View Fit" button. */
  const shipChildrenByLocation = useMemo(() => {
    const map = new Map<number, AssetEntry[]>();
    for (const { entries } of shipAssets ?? []) {
      for (const a of entries) {
        const arr = map.get(a.location_id);
        if (arr) arr.push(a);
        else map.set(a.location_id, [a]);
      }
    }
    return map;
  }, [shipAssets]);

  const ownedShips = useMemo<OwnedShip[]>(() => {
    return (shipAssets ?? []).flatMap(({ character, entries }) =>
      entries.filter((a) => a.category_name === "Ship").map((a) => ({ ...a, characterName: character.name }))
    );
  }, [shipAssets]);

  const shipAccessors = useMemo(
    () => ({
      type_name: (s: OwnedShip) => s.type_name,
      characterName: (s: OwnedShip) => s.characterName,
      location_name: (s: OwnedShip) => s.location_name,
    }),
    []
  );
  const sortedShips = useSortableRows(ownedShips, shipAccessors, "type_name", "asc");

  function openInBuilder(fit: Fit) {
    setDraft(fit);
    setTab("builder");
  }

  function newFit() {
    setDraft(emptyFit());
    setTab("builder");
  }

  function newFitWithShip(shipTypeId: number) {
    setDraft({ ...emptyFit(), ship_type_id: shipTypeId });
    setTab("builder");
  }

  useEffect(() => {
    if (initialShipTypeId != null) {
      newFitWithShip(initialShipTypeId);
      onConsumeInitialShipTypeId?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShipTypeId]);

  async function handleSync() {
    if (syncCharacterId == null) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const count = await syncCharacterFittings(syncCharacterId);
      loadFits();
      setSyncMessage(`Synced ${count} fit(s) from this character's in-game Fittings browser.`);
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err) {
      reportError(`Failed to sync fittings: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncAll() {
    if (characters.length === 0) return;
    setSyncingAll(true);
    setSyncMessage(null);
    try {
      const counts = await Promise.all(
        characters.map((c) =>
          syncCharacterFittings(c.id).catch((err) => {
            reportError(`Failed to sync ${c.name}'s fittings: ${String(err)}`);
            return 0;
          })
        )
      );
      loadFits();
      const total = counts.reduce((sum, n) => sum + n, 0);
      setSyncMessage(`Synced ${total} fit(s) across ${characters.length} character(s).`);
      setTimeout(() => setSyncMessage(null), 4000);
    } finally {
      setSyncingAll(false);
    }
  }

  async function handleSave() {
    if (!draft.ship_type_id) {
      reportError("Pick a ship before saving.");
      return;
    }
    setSaving(true);
    try {
      const id = await saveFit({
        id: draft.id || null,
        name: draft.name,
        ship_type_id: draft.ship_type_id,
        description: draft.description,
        purpose: draft.purpose,
        tags: draft.tags,
        items: draft.items,
      });
      loadFits();
      setDraft((prev) => ({ ...prev, id, source: "local", esi_character_id: null }));
    } catch (err) {
      reportError(`Failed to save fit: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteFit(id);
      loadFits();
      if (draft.id === id) setDraft(emptyFit());
    } catch (err) {
      reportError(`Failed to delete fit: ${String(err)}`);
    }
  }

  async function handleSendToCharacter() {
    if (!draft.id || sendCharacterId == null) return;
    setSending(true);
    setSendMessage(null);
    try {
      await sendFitToCharacter(sendCharacterId, draft.id);
      setSendMessage("Sent! Check this character's in-game Fittings browser.");
      setTimeout(() => setSendMessage(null), 4000);
    } catch (err) {
      reportError(`Failed to send fit to character: ${String(err)}`);
    } finally {
      setSending(false);
    }
  }

  function nameFor(typeId: number): string {
    return names[String(typeId)] ?? `Type #${typeId}`;
  }

  /** Called the moment an item is picked in the Fit Builder (search box or
   * item-browser tree) - both already know the item's real name from the
   * pick itself, so there's no need to wait for a save+refetch cycle
   * before nameFor() can resolve it (that gap is what showed "Type #N"
   * for anything just added to an in-progress draft). */
  function registerName(typeId: number, name: string) {
    setNames((prev) => (prev[String(typeId)] ? prev : { ...prev, [String(typeId)]: name }));
  }

  return (
    <main className="main main-fittings">
      <div className="fittings-page">
        <div className="fittings-page-header">
          <p className="eyebrow">
            <Rocket size={14} strokeWidth={2} /> Fittings
          </p>
          <h2>{tab === "library" ? "My Fits" : tab === "ships" ? "My Ships" : draft.id ? "Edit Fit" : "New Fit"}</h2>
          <p className="fittings-page-subtitle">
            Your own fit library - synced from your characters' real in-game fits, or built here from scratch. Send
            any fit straight to a character's in-game Fittings browser, or copy it as EFT/DNA text to paste in-game
            yourself.
          </p>
        </div>

        <PageTabBar
          pageId="fittings-fleets"
          tabs={FIT_TABS}
          activeTab={tab}
          onSelect={(id) => (id === "builder" ? newFit() : setTab(id as FitTab))}
        />

        {tab === "library" ? (
          <>
            <div className="fittings-toolbar">
              <input
                type="text"
                className="contracts-search-input"
                placeholder="Search name, ship, description, tags..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="market-region-select" value={purposeFilter} onChange={(e) => setPurposeFilter(e.target.value)}>
                <option value="All">All Purposes</option>
                {PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select className="market-region-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}>
                <option value="All">All Sources</option>
                <option value="local">Built Here</option>
                <option value="esi">Synced from Character</option>
              </select>
              <select
                className="market-region-select"
                value={characterFilter === "All" ? "All" : String(characterFilter)}
                onChange={(e) => setCharacterFilter(e.target.value === "All" ? "All" : Number(e.target.value))}
              >
                <option value="All">All Characters</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select className="market-region-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="updated">Recently Updated</option>
                <option value="name">Name</option>
                <option value="cost">Est. Cost</option>
              </select>
            </div>

            {characters.length > 0 && (
              <div className="fittings-sync-row">
                <CharacterSelectorStrip characters={characters} selectedId={syncCharacterId} onSelect={setSyncCharacterId} />
                <button type="button" className="kills-sync-btn" onClick={handleSync} disabled={syncing || syncingAll || syncCharacterId == null}>
                  <RefreshCw size={13} strokeWidth={2} className={syncing ? "spin" : undefined} />
                  {syncing ? "Syncing..." : "Sync This Character's Fits"}
                </button>
                <button type="button" className="kills-sync-btn" onClick={handleSyncAll} disabled={syncing || syncingAll}>
                  <RefreshCw size={13} strokeWidth={2} className={syncingAll ? "spin" : undefined} />
                  {syncingAll ? "Syncing All..." : "Sync All Characters"}
                </button>
                {syncMessage && <span className="fittings-inline-success">{syncMessage}</span>}
              </div>
            )}

            {!fits ? (
              <p className="detail-empty">Loading fits...</p>
            ) : filtered.length === 0 ? (
              <p className="detail-empty">
                {fits.length === 0
                  ? "No fits yet - build one, or sync a character's real in-game fits above."
                  : "No fits match this filter."}
              </p>
            ) : selectedShipTypeId == null ? (
              <div className="fittings-ship-grid">
                {shipGroups.map((g) => (
                  <button key={g.shipTypeId} type="button" className="fittings-ship-tile" onClick={() => setSelectedShipTypeId(g.shipTypeId)}>
                    <img src={typeIconUrl(g.shipTypeId, 64)} alt="" />
                    <span className="fittings-ship-tile-name">{g.name}</span>
                    <span className="fittings-ship-tile-count">
                      {g.count} fit{g.count === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <>
                <button type="button" className="detail-back" onClick={() => setSelectedShipTypeId(null)}>
                  ← All Ships
                </button>
                <div className="fittings-grid">
                  {filtered
                    .filter((fit) => fit.ship_type_id === selectedShipTypeId)
                    .map((fit) => (
                      <div key={fit.id} className="fittings-card" onClick={() => openInBuilder(fit)}>
                        <div className="fittings-card-head">
                          <img className="fittings-card-ship" src={typeIconUrl(fit.ship_type_id, 64)} alt="" />
                          <div className="fittings-card-identity">
                            <span className="fittings-card-name">{fit.name}</span>
                            <span className="fittings-card-ship-name">{nameFor(fit.ship_type_id)}</span>
                          </div>
                          <span className={`fittings-card-source fittings-card-source-${fit.source}`}>
                            {fit.source === "esi" ? "In-Game" : "Local"}
                          </span>
                        </div>
                        <div className="fittings-card-meta">
                          <span className="data-table-tag data-table-tag-neutral">{fit.purpose || "Unset"}</span>
                          <span className="fittings-card-cost">{formatIsk(computeCost(fit, priceById))}</span>
                        </div>
                        {fit.tags.length > 0 && (
                          <div className="fittings-card-tags">
                            {fit.tags.slice(0, 4).map((t) => (
                              <span key={t} className="wars-tag">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          className="fittings-card-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(fit.id);
                          }}
                          title="Delete"
                        >
                          <Trash2 size={13} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                </div>
              </>
            )}
          </>
        ) : tab === "ships" ? (
          <>
            <div className="fittings-toolbar">
              <button type="button" className="kills-sync-btn" onClick={loadShipAssets} disabled={shipsLoading}>
                <RefreshCw size={13} strokeWidth={2} className={shipsLoading ? "spin" : undefined} />
                {shipsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>

            {shipAssets == null ? (
              <p className="detail-empty">Loading your ships...</p>
            ) : ownedShips.length === 0 ? (
              <p className="detail-empty">
                No ships found across your characters' hangars. A ship currently being flown won't show up here - only
                ones parked in a station or structure.
              </p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortableTh label="Ship" sortKey="type_name" activeKey={sortedShips.sortKey} dir={sortedShips.sortDir} onSort={sortedShips.sort} defaultDir="asc" />
                      {characters.length > 1 && (
                        <SortableTh
                          label="Character"
                          sortKey="characterName"
                          activeKey={sortedShips.sortKey}
                          dir={sortedShips.sortDir}
                          onSort={sortedShips.sort}
                          defaultDir="asc"
                        />
                      )}
                      <SortableTh
                        label="Location"
                        sortKey="location_name"
                        activeKey={sortedShips.sortKey}
                        dir={sortedShips.sortDir}
                        onSort={sortedShips.sort}
                        defaultDir="asc"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedShips.rows.map((ship) => {
                      const contents = shipChildrenByLocation.get(ship.item_id);
                      return (
                        <tr key={ship.item_id}>
                          <td>
                            <span className="asset-item-cell">
                              <img className="asset-item-icon" src={typeIconUrl(ship.type_id, 32, ship.type_name)} alt="" />
                              {ship.type_name}
                              {contents && contents.length > 0 && (
                                <button
                                  type="button"
                                  className="asset-view-fit-btn"
                                  onClick={() => setViewingFit(ship)}
                                  title={`View what's fitted/stowed on this ${ship.type_name}`}
                                >
                                  <Rocket size={11} strokeWidth={2} />
                                  View Fit
                                </button>
                              )}
                            </span>
                          </td>
                          {characters.length > 1 && <td>{ship.characterName}</td>}
                          <td>{ship.location_name}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <FitBuilder
            characters={characters}
            draft={draft}
            setDraft={setDraft}
            nameFor={nameFor}
            onRegisterName={registerName}
            priceById={priceById}
            sendCharacterId={sendCharacterId}
            setSendCharacterId={setSendCharacterId}
            saving={saving}
            sending={sending}
            sendMessage={sendMessage}
            onSave={handleSave}
            onSendToCharacter={handleSendToCharacter}
          />
        )}
      </div>

      {viewingFit && (
        <ShipFitPanel ship={viewingFit} modules={shipChildrenByLocation.get(viewingFit.item_id) ?? []} onClose={() => setViewingFit(null)} />
      )}
    </main>
  );
}

export default FittingsPage;
