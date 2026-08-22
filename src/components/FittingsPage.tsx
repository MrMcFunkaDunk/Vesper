import { useEffect, useMemo, useState } from "react";
import { Rocket, Trash2, RefreshCw } from "lucide-react";
import { listFits, saveFit, deleteFit, syncCharacterFittings, sendFitToCharacter, type Fit } from "../lib/fittings";
import { getMarketPrices } from "../lib/market";
import { resolveEntityNames } from "../lib/wars";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import FitBuilder from "./FitBuilder";
import type { SessionCharacter } from "../lib/eve";

interface FittingsPageProps {
  characters: SessionCharacter[];
  /** A ship to jump straight into the builder with, e.g. from Item
   * Database's "Fit This Ship" button (now on the Wallet & Market page). */
  initialShipTypeId?: number | null;
  onConsumeInitialShipTypeId?: () => void;
}

type FitTab = "library" | "builder";

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

function FittingsPage({ characters, initialShipTypeId, onConsumeInitialShipTypeId }: FittingsPageProps) {
  const [tab, setTab] = useState<FitTab>("library");
  const [fits, setFits] = useState<Fit[] | null>(null);
  const [priceById, setPriceById] = useState<Map<number, number>>(new Map());
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [purposeFilter, setPurposeFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState<"All" | "local" | "esi">("All");
  const [sort, setSort] = useState<"updated" | "name" | "cost">("updated");
  const [syncCharacterId, setSyncCharacterId] = useState<number | null>(characters[0]?.id ?? null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [draft, setDraft] = useState<Fit>(emptyFit());
  const [saving, setSaving] = useState(false);
  const [sendCharacterId, setSendCharacterId] = useState<number | null>(characters[0]?.id ?? null);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);

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
  }, [fits, query, purposeFilter, sourceFilter, sort, names, priceById]);

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
          <h2>{tab === "library" ? "My Fits" : draft.id ? "Edit Fit" : "New Fit"}</h2>
          <p className="fittings-page-subtitle">
            Your own fit library - synced from your characters' real in-game fits, or built here from scratch. Send
            any fit straight to a character's in-game Fittings browser, or copy it as EFT/DNA text to paste in-game
            yourself.
          </p>
        </div>

        <div className="kills-tabs">
          <button type="button" className={`kills-tab ${tab === "library" ? "kills-tab-active" : ""}`} onClick={() => setTab("library")}>
            My Fits
          </button>
          <button type="button" className={`kills-tab ${tab === "builder" ? "kills-tab-active" : ""}`} onClick={newFit}>
            New Fit
          </button>
        </div>

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
              <select className="market-region-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="updated">Recently Updated</option>
                <option value="name">Name</option>
                <option value="cost">Est. Cost</option>
              </select>
            </div>

            {characters.length > 0 && (
              <div className="fittings-sync-row">
                <CharacterSelectorStrip characters={characters} selectedId={syncCharacterId} onSelect={setSyncCharacterId} />
                <button type="button" className="kills-sync-btn" onClick={handleSync} disabled={syncing || syncCharacterId == null}>
                  <RefreshCw size={13} strokeWidth={2} className={syncing ? "spin" : undefined} />
                  {syncing ? "Syncing..." : "Sync This Character's Fits"}
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
            ) : (
              <div className="fittings-grid">
                {filtered.map((fit) => (
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
    </main>
  );
}

export default FittingsPage;
