import { useEffect, useRef } from "react";
import { useCharacterLocation } from "./useCharacterLocation";
import { getMapData } from "../lib/map";
import {
  listChains,
  getChain,
  upsertChainSystem,
  upsertConnection,
  upsertMassLog,
  type ChainDetail,
  type ChainSystem,
} from "../lib/wormholes";
import { getTypeMass } from "../lib/market";
import { findFreePosition } from "../lib/chainLayout";
import { useErrorReporter } from "./useErrorReporter";
import { readNotificationPreferences } from "./useNotificationPreferences";
import { notify } from "../lib/notifications";

interface LiveSystem {
  systemId: number;
  systemName: string;
}

async function applyAutoJump(
  chain: ChainDetail,
  prev: LiveSystem,
  next: LiveSystem,
  wasStargateHop: boolean,
  characterName: string | null,
  shipTypeId: number | null,
  shipTypeName: string | null,
) {
  const fromChainSystem = chain.systems.find((s) => s.system_id === prev.systemId);

  let toChainSystem: ChainSystem | undefined = chain.systems.find((s) => s.system_id === next.systemId);
  if (!toChainSystem) {
    const anchor = fromChainSystem ?? chain.systems[0] ?? { x: 0, y: 0 };
    const pos = findFreePosition(
      chain.systems.map((s) => ({ x: s.x, y: s.y })),
      anchor.x,
      anchor.y,
    );
    const newId = await upsertChainSystem(chain.id, {
      id: null,
      system_id: next.systemId,
      system_name: next.systemName,
      x: pos.x,
      y: pos.y,
      is_origin: false,
      notes: "",
    });
    toChainSystem = { id: newId, system_id: next.systemId, system_name: next.systemName, x: pos.x, y: pos.y, is_origin: false, notes: "" };
  }

  // No prior baseline on this chain (app just started mid-flight, or this
  // is the first system the tracked character has visited since enabling
  // auto-map on this chain) - the new system still gets added above, just
  // nothing to draw a connection to yet.
  if (!fromChainSystem) return { newConnection: false as const, connectionKind: undefined };

  const existing = chain.connections.find(
    (c) =>
      (c.from_chain_system_id === fromChainSystem.id && c.to_chain_system_id === toChainSystem!.id) ||
      (c.from_chain_system_id === toChainSystem!.id && c.to_chain_system_id === fromChainSystem.id),
  );

  const isNewConnection = !existing;
  let connectionId = existing?.id;
  let connectionKind = existing?.kind;
  if (!connectionId) {
    connectionKind = wasStargateHop ? "stargate" : "wormhole";
    connectionId = await upsertConnection(chain.id, {
      id: null,
      from_chain_system_id: fromChainSystem.id,
      to_chain_system_id: toChainSystem.id,
      kind: connectionKind,
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
  }

  // Mass-rolling only makes sense for wormholes - a stargate has no mass
  // budget to track, so a gate hop only ever adds the breadcrumb connection
  // above, never a mass-log entry.
  if (connectionKind === "wormhole" && shipTypeId != null) {
    try {
      const massKg = await getTypeMass(shipTypeId);
      if (massKg != null) {
        await upsertMassLog(chain.id, {
          connection_id: connectionId,
          character_name: characterName ?? "Unknown Pilot",
          ship_type_name: shipTypeName ?? "Unknown Ship",
          mass_kg: massKg,
          // An auto-detected pass can't know the pilot's deliberate hot/cold
          // intent - only the manual Pass Hot/Cold buttons set that.
          hot: false,
          source: "esi_auto",
        });
      }
    } catch {
      // Best-effort - a failed mass lookup shouldn't undo the topology
      // update (new system/connection) that already succeeded above.
    }
  }

  return { newConnection: isNewConnection, connectionKind };
}

/**
 * Watches the tracked character's live location and, for every chain with
 * auto-map-building enabled, adds/connects systems for every jump - gate
 * hops and wormhole hops alike, so the chain shows the whole breadcrumb
 * trail in and out of known space, not just the wormhole leg. Each new
 * connection is tagged "stargate" or "wormhole" depending on which kind of
 * hop it actually was (checked against the real jump graph), so gate
 * connections don't get wormhole-only fields like mass/EOL/rolling-calc.
 * Mounted once at the App shell level (not inside PathWormholeFinderPage,
 * which fully unmounts on tab switch) so this keeps working while the user
 * is on a different tab - the whole point of matching eve-nexum's always-on
 * background tracking.
 */
export function useChainAutoMapping(characterName: string | null) {
  const { systemId, systemName, shipTypeId, shipTypeName } = useCharacterLocation();
  const prevRef = useRef<LiveSystem | null>(null);
  const stargateEdgesRef = useRef<Set<string> | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    if (systemId == null) return;
    const prev = prevRef.current;
    const next: LiveSystem = { systemId, systemName: systemName ?? `System #${systemId}` };
    prevRef.current = next;
    if (!prev || prev.systemId === systemId) return;

    (async () => {
      try {
        if (!stargateEdgesRef.current) {
          const mapData = await getMapData();
          const edges = new Set<string>();
          for (const jump of mapData.jumps) {
            edges.add(`${jump.from}-${jump.to}`);
            edges.add(`${jump.to}-${jump.from}`);
          }
          stargateEdgesRef.current = edges;
        }
        const wasStargateHop = stargateEdgesRef.current.has(`${prev.systemId}-${systemId}`);

        const prefs = readNotificationPreferences();
        const chains = await listChains();
        for (const summary of chains) {
          if (!summary.auto_map_enabled) continue;
          const chain = await getChain(summary.id);
          const result = await applyAutoJump(chain, prev, next, wasStargateHop, characterName, shipTypeId, shipTypeName);
          if (prefs.enabled && prefs.autoMapJumps && result.newConnection && result.connectionKind === "wormhole") {
            notify("New Wormhole Mapped", `${summary.name}: ${prev.systemName} → ${next.systemName}`);
          }
        }
      } catch (err) {
        reportError(`Auto-map tracking failed: ${String(err)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemId, systemName]);
}

/** Renders nothing - exists purely to call useChainAutoMapping from a JSX
 * position inside the CharacterLocationProvider subtree in App.tsx. */
export function ChainAutoMappingEffect({ characterName }: { characterName: string | null }) {
  useChainAutoMapping(characterName);
  return null;
}
