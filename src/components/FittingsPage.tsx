import { useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Rocket, Copy, Send, Trash2, Save, RefreshCw } from "lucide-react";
import {
  listFits,
  saveFit,
  deleteFit,
  syncCharacterFittings,
  sendFitToCharacter,
  exportFitEft,
  exportFitDna,
  type Fit,
  type FitItem,
} from "../lib/fittings";
import { searchMarketTypes, getMarketPrices, type TypeSearchMatch } from "../lib/market";
import { resolveEntityNames } from "../lib/wars";
import { formatIsk, typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";
import type { SessionCharacter } from "../lib/eve";

interface FittingsPageProps {
  characters: SessionCharacter[];
}

type FitTab = "library" | "builder";

const PURPOSES = ["PvP", "PvE", "Exploring", "Industry", "Mining", "Mission", "Other"];

const SLOT_GROUPS: { flagPrefix: string; label: string; group: number }[] = [
  { flagPrefix: "LoSlot", label: "Low Slots", group: 0 },
  { flagPrefix: "MedSlot", label: "Mid Slots", group: 1 },
  { flagPrefix: "HiSlot", label: "High Slots", group: 2 },
  { flagPrefix: "RigSlot", label: "Rig Slots", group: 3 },
  { flagPrefix: "SubSystemSlot", label: "Subsystems", group: 4 },
];

function flagGroup(flag: string): number {
  if (flag.startsWith("LoSlot")) return 0;
  if (flag.startsWith("MedSlot")) return 1;
  if (flag.startsWith("HiSlot")) return 2;
  if (flag.startsWith("RigSlot")) return 3;
  if (flag.startsWith("SubSystemSlot")) return 4;
  if (flag === "DroneBay") return 5;
  if (flag === "Cargo") return 6;
  return 7;
}

function nextFlag(items: FitItem[], prefix: string): string {
  let n = 0;
  while (items.some((i) => i.flag === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Ship + a picker's worth of items priced from a bulk map - the same
 * average-price valuation used elsewhere in this app (Appraisal, etc.),
 * an estimate rather than a live buy-order quote. */
function computeCost(fit: Fit, priceById: Map<number, number>): number {
  let total = priceById.get(fit.ship_type_id) ?? 0;
  for (const item of fit.items) total += (priceById.get(item.type_id) ?? 0) * item.quantity;
  return total;
}

function TypeSearchBox({
  placeholder,
  onPick,
}: {
  placeholder: string;
  onPick: (match: TypeSearchMatch) => void;
}) {
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

function FittingsPage({ characters }: FittingsPageProps) {
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
  const [copied, setCopied] = useState<string | null>(null);

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

  async function handleCopyEft() {
    if (!draft.id) {
      reportError("Save the fit first.");
      return;
    }
    try {
      const text = await exportFitEft(draft.id);
      await writeText(text);
      setCopied("eft");
      setTimeout(() => setCopied(null), 1500);
    } catch (err) {
      reportError(`Failed to copy EFT: ${String(err)}`);
    }
  }

  async function handleCopyDna() {
    if (!draft.id) {
      reportError("Save the fit first.");
      return;
    }
    try {
      const text = await exportFitDna(draft.id);
      await writeText(text);
      setCopied("dna");
      setTimeout(() => setCopied(null), 1500);
    } catch (err) {
      reportError(`Failed to copy DNA: ${String(err)}`);
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

  function addItem(flag: string, typeId: number) {
    setDraft((prev) => {
      const group = flagGroup(flag);
      if (group === 5 || group === 6) {
        const existing = prev.items.find((i) => i.flag === flag && i.type_id === typeId);
        if (existing) {
          return {
            ...prev,
            items: prev.items.map((i) => (i === existing ? { ...i, quantity: i.quantity + 1 } : i)),
          };
        }
        return { ...prev, items: [...prev.items, { type_id: typeId, flag, quantity: 1 }] };
      }
      const newFlag = nextFlag(prev.items, flag);
      return { ...prev, items: [...prev.items, { type_id: typeId, flag: newFlag, quantity: 1 }] };
    });
  }

  function removeItem(index: number) {
    setDraft((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  }

  function nameFor(typeId: number): string {
    return names[String(typeId)] ?? `Type #${typeId}`;
  }

  const draftCost = computeCost(draft, priceById);
  const shipItems = [...draft.items].sort((a, b) => flagGroup(a.flag) - flagGroup(b.flag));
  const droneItems = shipItems.filter((i) => i.flag === "DroneBay");
  const cargoItems = shipItems.filter((i) => i.flag === "Cargo");

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
          <div className="fittings-builder">
            <div className="fittings-builder-main">
              <div className="fittings-builder-ship">
                {draft.ship_type_id ? (
                  <div className="fittings-builder-ship-picked">
                    <img src={typeIconUrl(draft.ship_type_id, 64)} alt="" />
                    <span>{nameFor(draft.ship_type_id)}</span>
                    <button type="button" className="detail-back" onClick={() => setDraft((p) => ({ ...p, ship_type_id: 0, items: [] }))}>
                      Change Ship
                    </button>
                  </div>
                ) : (
                  <TypeSearchBox
                    placeholder="Search for a ship..."
                    onPick={(s) => setDraft((p) => ({ ...p, ship_type_id: s.id }))}
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

              {draft.ship_type_id > 0 && (
                <>
                  {SLOT_GROUPS.map((g) => {
                    const groupItems = shipItems.filter((i) => flagGroup(i.flag) === g.group);
                    return (
                      <div key={g.flagPrefix} className="fittings-slot-group">
                        <p className="fittings-slot-group-label">{g.label}</p>
                        <div className="fittings-slot-list">
                          {groupItems.map((item) => {
                            const index = draft.items.indexOf(item);
                            return (
                              <div key={item.flag} className="fittings-slot-item">
                                <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                                <span>{nameFor(item.type_id)}</span>
                                <button type="button" onClick={() => removeItem(index)}>
                                  <Trash2 size={12} strokeWidth={2} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        <TypeSearchBox placeholder={`+ Add to ${g.label.toLowerCase()}`} onPick={(s) => addItem(g.flagPrefix, s.id)} />
                      </div>
                    );
                  })}

                  <div className="fittings-slot-group">
                    <p className="fittings-slot-group-label">Drones</p>
                    <div className="fittings-slot-list">
                      {droneItems.map((item) => {
                        const index = draft.items.indexOf(item);
                        return (
                          <div key={`${item.flag}-${item.type_id}`} className="fittings-slot-item">
                            <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                            <span>
                              {nameFor(item.type_id)} x{item.quantity}
                            </span>
                            <button type="button" onClick={() => removeItem(index)}>
                              <Trash2 size={12} strokeWidth={2} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <TypeSearchBox placeholder="+ Add drone" onPick={(s) => addItem("DroneBay", s.id)} />
                  </div>

                  <div className="fittings-slot-group">
                    <p className="fittings-slot-group-label">Cargo</p>
                    <div className="fittings-slot-list">
                      {cargoItems.map((item) => {
                        const index = draft.items.indexOf(item);
                        return (
                          <div key={`${item.flag}-${item.type_id}`} className="fittings-slot-item">
                            <img src={typeIconUrl(item.type_id)} alt="" className="market-browser-row-icon" />
                            <span>
                              {nameFor(item.type_id)} x{item.quantity}
                            </span>
                            <button type="button" onClick={() => removeItem(index)}>
                              <Trash2 size={12} strokeWidth={2} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <TypeSearchBox placeholder="+ Add cargo item" onPick={(s) => addItem("Cargo", s.id)} />
                  </div>
                </>
              )}
            </div>

            <div className="fittings-builder-side">
              <div className="fittings-cost-card">
                <span className="market-stat-label">Estimated Cost</span>
                <span className="market-stat-value">{formatIsk(draftCost)}</span>
              </div>

              <button type="button" className="kills-sync-btn fittings-full-btn" onClick={handleSave} disabled={saving}>
                <Save size={14} strokeWidth={2} />
                {saving ? "Saving..." : "Save Fit"}
              </button>

              <div className="fittings-export-row">
                <button type="button" className="detail-back" onClick={handleCopyEft} disabled={!draft.id}>
                  <Copy size={13} strokeWidth={2} />
                  {copied === "eft" ? "Copied!" : "Copy EFT"}
                </button>
                <button type="button" className="detail-back" onClick={handleCopyDna} disabled={!draft.id}>
                  <Copy size={13} strokeWidth={2} />
                  {copied === "dna" ? "Copied!" : "Copy DNA"}
                </button>
              </div>
              <p className="fittings-export-hint">Paste EFT text into EVE's in-game "Import Fitting" dialog.</p>

              {characters.length > 0 && (
                <div className="fittings-send-card">
                  <p className="fittings-slot-group-label">Send to Character</p>
                  <CharacterSelectorStrip characters={characters} selectedId={sendCharacterId} onSelect={setSendCharacterId} />
                  <button
                    type="button"
                    className="kills-sync-btn fittings-full-btn"
                    onClick={handleSendToCharacter}
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
        )}
      </div>
    </main>
  );
}

export default FittingsPage;
