import { useEffect, useRef, useState } from "react";
import { Waypoints, Star, Trash2, Navigation, Sparkles, Download, Telescope } from "lucide-react";
import { toPng } from "html-to-image";
import {
  listChains,
  getChain,
  createChain,
  renameChain,
  deleteChain,
  setChainAutoMap,
  upsertChainSystem,
  deleteChainSystem,
  upsertConnection,
  type ChainSummary,
  type ChainDetail,
} from "../lib/wormholes";
import { searchSystemsLive, getMapData, type SystemSearchMatch } from "../lib/map";
import { getCharacterContacts, type ContactEntry } from "../lib/eve";
import { matchContactStanding } from "../lib/standings";
import { findFreePosition } from "../lib/chainLayout";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useRecentActivity } from "../hooks/useRecentActivity";
import { useCharacterLocation, useCharacterLocationDemand } from "../hooks/useCharacterLocation";
import type { SystemSummary } from "./SystemKillboard";
import ChainSwitcher from "./wormholes/ChainSwitcher";
import ChainCanvas from "./wormholes/ChainCanvas";
import SignaturePanel from "./wormholes/SignaturePanel";
import SystemIntelPanel from "./wormholes/SystemIntelPanel";
import ConnectionEditor from "./wormholes/ConnectionEditor";
import RoutePanel from "./wormholes/RoutePanel";
import ChainEffectSummary from "./wormholes/ChainEffectSummary";
import ScoutConnectionsPanel from "./wormholes/ScoutConnectionsPanel";

interface PathWormholeFinderPageProps {
  activeCharacterId: number | null;
  activeCharacterName: string | null;
  onSelectSystem: (system: SystemSummary) => void;
}

function SystemSearchBox({ onPick }: { onPick: (match: SystemSearchMatch) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SystemSearchMatch[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSystemsLive(trimmed)
        .then((matches) => {
          if (!cancelled) {
            setResults(matches);
            setOpen(matches.length > 0);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="kills-add-combobox wh-search-combobox">
      <input
        type="text"
        placeholder="Add a system to the chain..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && (
        <div className="gatecheck-slot-results kills-add-suggestions">
          {results.map((s) => (
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
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PathWormholeFinderPage({ activeCharacterId, activeCharacterName, onSelectSystem }: PathWormholeFinderPageProps) {
  const [chains, setChains] = useState<ChainSummary[] | null>(null);
  const [activeChainId, setActiveChainId] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainDetail | null>(null);
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [routePanelOpen, setRoutePanelOpen] = useState(false);
  const [effectsPanelOpen, setEffectsPanelOpen] = useState(false);
  const [scoutPanelOpen, setScoutPanelOpen] = useState(false);
  const [pendingRouteDestination, setPendingRouteDestination] = useState<{ id: number; name: string } | null>(null);
  const [followLiveLocation, setFollowLiveLocation] = useState(true);
  const [securityBySystemId, setSecurityBySystemId] = useState<Map<number, number>>(new Map());
  const [regionBySystemId, setRegionBySystemId] = useState<Map<number, string>>(new Map());
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const reportError = useErrorReporter();
  const { kills } = useRecentActivity();
  const location = useCharacterLocation();
  // Registers that live location is needed while this page is open, so
  // CharacterLocationProvider's background poll wakes up even for a session
  // with no auto-map-enabled chain yet - see useCharacterLocationDemand.
  useCharacterLocationDemand();

  useEffect(() => {
    getMapData()
      .then((data) => {
        setSecurityBySystemId(new Map(data.systems.map((s) => [s.id, s.security])));
        const regionNameById = new Map(data.regions.map((r) => [r.id, r.name]));
        setRegionBySystemId(
          new Map(data.systems.map((s) => [s.id, regionNameById.get(s.region_id) ?? ""])),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeCharacterId == null) {
      setContacts([]);
      return;
    }
    getCharacterContacts(activeCharacterId)
      .then((result) => setContacts(result.needs_reauth ? [] : result.entries))
      .catch(() => setContacts([]));
  }, [activeCharacterId]);

  function loadChains(selectId?: string) {
    listChains()
      .then((list) => {
        setChains(list);
        if (selectId) {
          setActiveChainId(selectId);
        } else if (!activeChainId && list.length > 0) {
          setActiveChainId(list[0].id);
        } else if (list.length === 0) {
          setActiveChainId(null);
          setChain(null);
        }
      })
      .catch((err) => reportError(`Failed to load chains: ${String(err)}`));
  }

  useEffect(() => {
    loadChains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracks the latest activeChainId synchronously (assigned during render,
  // not in an effect, so it's never one commit behind) so an in-flight
  // getChain response for a chain the user has since switched away from
  // can't clobber the chain now on screen - without this, quickly switching
  // chains could show one chain's canvas populated with another's data
  // until the next 8s poll silently self-corrected it.
  const activeChainIdRef = useRef(activeChainId);
  activeChainIdRef.current = activeChainId;

  function reloadChain() {
    if (!activeChainId) return;
    const requestedId = activeChainId;
    getChain(requestedId)
      .then((data) => {
        if (activeChainIdRef.current === requestedId) setChain(data);
      })
      .catch((err) => reportError(`Failed to load chain: ${String(err)}`));
  }

  // useChainAutoMapping writes straight to the backend from a hook mounted
  // at the App root - it has no way to tell this page "the chain you're
  // looking at just changed," so without a poll here, an auto-mapped jump
  // would land in wormholes.sqlite correctly but never show up on screen
  // until some unrelated manual action happened to call reloadChain(). This
  // mirrors how every other live-updating feed in the app (kills, tracked
  // systems, character location) is a plain poll, not an event push.
  useEffect(() => {
    if (!activeChainId) return;
    const interval = setInterval(reloadChain, 8_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChainId]);

  useEffect(() => {
    setSelectedSystemId(null);
    setSelectedConnectionId(null);
    if (!activeChainId) {
      setChain(null);
      return;
    }
    const requestedId = activeChainId;
    getChain(requestedId)
      .then((data) => {
        if (activeChainIdRef.current === requestedId) setChain(data);
      })
      .catch((err) => reportError(`Failed to load chain: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChainId]);

  async function handleCreateChain(name: string) {
    try {
      const id = await createChain(name);
      loadChains(id);
    } catch (err) {
      reportError(`Failed to create chain: ${String(err)}`);
    }
  }

  async function handleRenameChain(id: string, name: string) {
    try {
      await renameChain(id, name);
      loadChains(activeChainId ?? undefined);
      if (id === activeChainId) reloadChain();
    } catch (err) {
      reportError(`Failed to rename chain: ${String(err)}`);
    }
  }

  async function handleDeleteChain(id: string) {
    try {
      await deleteChain(id);
      if (id === activeChainId) setActiveChainId(null);
      loadChains();
    } catch (err) {
      reportError(`Failed to delete chain: ${String(err)}`);
    }
  }

  async function handleToggleAutoMap(id: string, enabled: boolean) {
    try {
      await setChainAutoMap(id, enabled);
      loadChains(activeChainId ?? undefined);
      if (id === activeChainId) reloadChain();
    } catch (err) {
      reportError(`Failed to update auto-map setting: ${String(err)}`);
    }
  }

  async function handleAddSystem(match: SystemSearchMatch) {
    if (!chain) return;
    const count = chain.systems.length;
    const anchor = chain.systems.find((s) => s.id === selectedSystemId) ?? chain.systems[chain.systems.length - 1];
    const pos = findFreePosition(
      chain.systems.map((s) => ({ x: s.x, y: s.y })),
      anchor?.x ?? 0,
      anchor?.y ?? 0,
    );
    try {
      await upsertChainSystem(chain.id, {
        id: null,
        system_id: match.id,
        system_name: match.name,
        x: pos.x,
        y: pos.y,
        is_origin: count === 0,
        notes: "",
      });
      reloadChain();
      loadChains(chain.id);
    } catch (err) {
      reportError(`Failed to add system: ${String(err)}`);
    }
  }

  async function handleMoveSystem(id: string, x: number, y: number) {
    if (!chain) return;
    const system = chain.systems.find((s) => s.id === id);
    if (!system) return;
    try {
      await upsertChainSystem(chain.id, {
        id: system.id,
        system_id: system.system_id,
        system_name: system.system_name,
        x,
        y,
        is_origin: system.is_origin,
        notes: system.notes,
      });
      reloadChain();
    } catch (err) {
      reportError(`Failed to move system: ${String(err)}`);
    }
  }

  async function handleSetOrigin(id: string) {
    if (!chain) return;
    try {
      for (const system of chain.systems) {
        if (system.is_origin && system.id !== id) {
          await upsertChainSystem(chain.id, { ...system, id: system.id, is_origin: false });
        }
      }
      const target = chain.systems.find((s) => s.id === id);
      if (target) await upsertChainSystem(chain.id, { ...target, id: target.id, is_origin: true });
      reloadChain();
    } catch (err) {
      reportError(`Failed to set origin: ${String(err)}`);
    }
  }

  async function handleDeleteSystem(id: string) {
    if (!chain) return;
    try {
      await deleteChainSystem(chain.id, id);
      setSelectedSystemId(null);
      reloadChain();
      loadChains(chain.id);
    } catch (err) {
      reportError(`Failed to delete system: ${String(err)}`);
    }
  }

  /** Fired when the user drags a connection line from one system to another
   * on the canvas (React Flow's native connect gesture). */
  /** Exports the chain canvas as a PNG - the raw viewport (just the panned/
   * zoomed node+edge content) is preferred over the whole .react-flow
   * container since it crops tightly to what's actually on the map, with
   * the wider container as a fallback if the viewport element isn't found
   * for some reason. The filter is defensive: harmless if these elements
   * aren't inside the export target, necessary if the fallback is used. */
  async function handleExportPng() {
    if (!chain) return;
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const flow = document.querySelector<HTMLElement>(".react-flow");
    const target = viewport ?? flow;
    if (!target) return;
    try {
      const dataUrl = await toPng(target, {
        backgroundColor: "#0a0a0c",
        pixelRatio: 2,
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          return (
            !node.classList?.contains?.("react-flow__minimap") &&
            !node.classList?.contains?.("react-flow__controls") &&
            !node.classList?.contains?.("react-flow__attribution") &&
            !node.classList?.contains?.("react-flow__panel")
          );
        },
      });
      const link = document.createElement("a");
      const safeName = chain.name.replace(/[^a-z0-9]/gi, "_");
      link.download = `vesper_${safeName}_${new Date().toISOString().split("T")[0]}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      reportError(`Failed to export chain PNG: ${String(err)}`);
    }
  }

  async function handleConnect(fromId: string, toId: string) {
    if (!chain) return;
    const existing = chain.connections.find(
      (c) =>
        (c.from_chain_system_id === fromId && c.to_chain_system_id === toId) ||
        (c.from_chain_system_id === toId && c.to_chain_system_id === fromId),
    );
    if (existing) {
      setSelectedConnectionId(existing.id);
      setSelectedSystemId(null);
      return;
    }
    try {
      const newId = await upsertConnection(chain.id, {
        id: null,
        from_chain_system_id: fromId,
        to_chain_system_id: toId,
        kind: "wormhole",
        wormhole_type: "Unknown",
        mass_status: "fresh",
        is_eol: false,
        from_signature_id: null,
        to_signature_id: null,
        flag_icon: null,
        flag_color: null,
        flag_note: "",
        flag_blink: false,
        notes: "",
      });
      setSelectedConnectionId(newId);
      setSelectedSystemId(null);
      reloadChain();
    } catch (err) {
      reportError(`Failed to create connection: ${String(err)}`);
    }
  }

  const chainOrigin = chain?.systems.find((s) => s.is_origin) ?? null;
  const isFollowingLive = followLiveLocation && location.systemId != null;
  const effectiveOriginSystemId = isFollowingLive ? location.systemId : chainOrigin?.system_id ?? null;
  const effectiveOriginSystemName = isFollowingLive ? location.systemName : chainOrigin?.system_name ?? null;
  const selectedSystem = chain?.systems.find((s) => s.id === selectedSystemId) ?? null;
  const selectedConnection = chain?.connections.find((c) => c.id === selectedConnectionId) ?? null;
  const connectionFromSystem = selectedConnection ? chain?.systems.find((s) => s.id === selectedConnection.from_chain_system_id) ?? null : null;
  const connectionToSystem = selectedConnection ? chain?.systems.find((s) => s.id === selectedConnection.to_chain_system_id) ?? null : null;

  const chainSystemIds = new Set(chain?.systems.map((s) => s.system_id) ?? []);
  const chainKills = kills.filter((k) => chainSystemIds.has(k.system_id));
  const killCountBySystemId = new Map<number, number>();
  for (const k of chainKills) {
    killCountBySystemId.set(k.system_id, (killCountBySystemId.get(k.system_id) ?? 0) + 1);
  }
  const standingBySystemId = new Map<number, number>();
  for (const k of chainKills) {
    const standing =
      matchContactStanding(contacts, {
        characterId: k.victim_character_id,
        corporationId: k.victim_corporation_id,
        allianceId: k.victim_alliance_id,
      }) ??
      matchContactStanding(contacts, {
        characterId: k.final_blow_character_id,
        corporationId: k.final_blow_corporation_id,
        allianceId: k.final_blow_alliance_id,
      });
    if (standing != null) standingBySystemId.set(k.system_id, standing);
  }

  return (
    <main className="main main-wormholes">
      <div className="wh-page">
        <div className="wh-page-header">
          <p className="eyebrow">
            <Waypoints size={14} strokeWidth={2} /> Path & Wormhole Finder
          </p>
          <h2>Chain Mapper</h2>
          <p className="wh-page-subtitle">
            Track your current wormhole chain: paste scan results, draw connections as you find them, and route through
            stargates and wormholes together.
          </p>
        </div>

        {!chains ? (
          <p className="detail-empty">Loading chains...</p>
        ) : (
          <>
            <ChainSwitcher
              chains={chains}
              activeChainId={activeChainId}
              onSelect={setActiveChainId}
              onCreate={handleCreateChain}
              onRename={handleRenameChain}
              onDelete={handleDeleteChain}
              onToggleAutoMap={handleToggleAutoMap}
            />

            {!chain ? (
              <p className="detail-empty">No chain selected - create one above to start mapping.</p>
            ) : (
              <div className="wh-layout">
                <div className="wh-canvas-panel">
                  <div className="wh-toolbar">
                    <SystemSearchBox onPick={handleAddSystem} />
                    <button
                      type="button"
                      className={`wh-mode-btn wh-route-toggle${routePanelOpen ? " wh-mode-btn-active" : ""}`}
                      onClick={() => {
                        setRoutePanelOpen((v) => !v);
                        setEffectsPanelOpen(false);
                        setScoutPanelOpen(false);
                      }}
                    >
                      <Navigation size={13} strokeWidth={2} /> Route
                    </button>
                    <button
                      type="button"
                      className={`wh-mode-btn wh-effects-toggle${effectsPanelOpen ? " wh-mode-btn-active" : ""}`}
                      onClick={() => {
                        setEffectsPanelOpen((v) => !v);
                        setRoutePanelOpen(false);
                        setScoutPanelOpen(false);
                      }}
                    >
                      <Sparkles size={13} strokeWidth={2} /> Effects
                    </button>
                    <button
                      type="button"
                      className={`wh-mode-btn wh-scout-toggle${scoutPanelOpen ? " wh-mode-btn-active" : ""}`}
                      onClick={() => {
                        setScoutPanelOpen((v) => !v);
                        setRoutePanelOpen(false);
                        setEffectsPanelOpen(false);
                      }}
                    >
                      <Telescope size={13} strokeWidth={2} /> Scout
                    </button>
                    <button type="button" className="wh-mode-btn wh-export-btn" onClick={handleExportPng} title="Export chain as PNG">
                      <Download size={13} strokeWidth={2} /> Export
                    </button>
                  </div>
                  <ChainCanvas
                    systems={chain.systems}
                    connections={chain.connections}
                    selectedSystemId={selectedSystemId}
                    selectedConnectionId={selectedConnectionId}
                    onSelectSystem={(id) => {
                      setSelectedSystemId(id);
                      if (id) setSelectedConnectionId(null);
                    }}
                    onSelectConnection={(id) => {
                      setSelectedConnectionId(id);
                      if (id) setSelectedSystemId(null);
                    }}
                    onMoveSystem={handleMoveSystem}
                    onConnect={handleConnect}
                    securityBySystemId={securityBySystemId}
                    killCountBySystemId={killCountBySystemId}
                    standingBySystemId={standingBySystemId}
                    regionBySystemId={regionBySystemId}
                    currentLiveSystemId={location.systemId}
                  />
                </div>

                <div className="wh-side-panel">
                  {routePanelOpen ? (
                    <RoutePanel
                      chainId={chain.id}
                      originSystemId={effectiveOriginSystemId}
                      originSystemName={effectiveOriginSystemName}
                      isFollowingLive={isFollowingLive}
                      onToggleFollow={() => setFollowLiveLocation((v) => !v)}
                      onSelectWormholeHop={(connectionId) => {
                        setSelectedConnectionId(connectionId);
                      }}
                      onClose={() => setRoutePanelOpen(false)}
                      pendingDestination={pendingRouteDestination}
                      onConsumePendingDestination={() => setPendingRouteDestination(null)}
                    />
                  ) : effectsPanelOpen ? (
                    <ChainEffectSummary systems={chain.systems} onClose={() => setEffectsPanelOpen(false)} />
                  ) : scoutPanelOpen ? (
                    <ScoutConnectionsPanel
                      onSelectSystem={onSelectSystem}
                      onRouteTo={(systemId, systemName) => {
                        setPendingRouteDestination({ id: systemId, name: systemName });
                        setScoutPanelOpen(false);
                        setRoutePanelOpen(true);
                      }}
                      onClose={() => setScoutPanelOpen(false)}
                    />
                  ) : selectedSystem ? (
                    <>
                      <div className="wh-system-header">
                        <p className="wh-side-label">{selectedSystem.system_name}</p>
                        <button type="button" className="wh-link-btn" onClick={() => onSelectSystem({ id: selectedSystem.system_id, name: selectedSystem.system_name, security: 0, regionName: null })}>
                          View Killboard
                        </button>
                      </div>
                      <button
                        type="button"
                        className={`wh-origin-btn${selectedSystem.is_origin ? " wh-origin-btn-active" : ""}`}
                        onClick={() => handleSetOrigin(selectedSystem.id)}
                      >
                        <Star size={13} strokeWidth={2} fill={selectedSystem.is_origin ? "currentColor" : "none"} />
                        {selectedSystem.is_origin ? "Origin System" : "Set as Origin"}
                      </button>
                      <SystemIntelPanel
                        chainId={chain.id}
                        system={selectedSystem}
                        structures={chain.structures.filter((s) => s.chain_system_id === selectedSystem.id)}
                        onChanged={reloadChain}
                      />
                      <SignaturePanel
                        chainId={chain.id}
                        system={selectedSystem}
                        signatures={chain.signatures.filter((s) => s.chain_system_id === selectedSystem.id)}
                        onChanged={reloadChain}
                      />
                      <button type="button" className="wh-delete-btn" onClick={() => handleDeleteSystem(selectedSystem.id)}>
                        <Trash2 size={13} strokeWidth={2} /> Remove From Chain
                      </button>
                    </>
                  ) : selectedConnection ? (
                    <ConnectionEditor
                      chainId={chain.id}
                      connection={selectedConnection}
                      fromSystem={connectionFromSystem}
                      toSystem={connectionToSystem}
                      fromSignatures={chain.signatures.filter((s) => s.chain_system_id === selectedConnection.from_chain_system_id)}
                      toSignatures={chain.signatures.filter((s) => s.chain_system_id === selectedConnection.to_chain_system_id)}
                      massLogEntries={chain.mass_log_entries.filter((e) => e.connection_id === selectedConnection.id)}
                      characterName={activeCharacterName}
                      onChanged={reloadChain}
                      onDeleted={() => {
                        setSelectedConnectionId(null);
                        reloadChain();
                      }}
                    />
                  ) : (
                    <div className="wh-side-help">
                      <p className="wh-side-label">Getting Started</p>
                      <p>Search above to add systems to this chain.</p>
                      <p>Drag from a system's edge handle to another system to draw a wormhole between them.</p>
                      <p>Click a system or connection to see its details here.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default PathWormholeFinderPage;
