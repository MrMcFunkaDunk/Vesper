import { useEffect, useState } from "react";
import { Building2, Rocket, Skull, Swords, Trash2 } from "lucide-react";
import { getSystemDetail, type SystemDetail } from "../../lib/map";
import {
  upsertChainSystem,
  importStructures,
  deleteChainStructure,
  type ChainSystem,
  type ChainStructure,
  type StructureType,
} from "../../lib/wormholes";
import { useErrorReporter } from "../../hooks/useErrorReporter";
import { WH_SYSTEM_STATICS } from "../../lib/whSystemStatics";
import { EFFECT_LABELS, EFFECT_SYMBOLS } from "../../lib/wormholeEffects";

interface SystemIntelPanelProps {
  chainId: string;
  system: ChainSystem;
  structures: ChainStructure[];
  onChanged: () => void;
}

const STRUCTURE_TYPE_LABELS: Record<StructureType, string> = {
  unknown: "Unknown",
  astrahus: "Astrahus",
  fortizar: "Fortizar",
  keepstar: "Keepstar",
  raitaru: "Raitaru",
  azbel: "Azbel",
  sotiyo: "Sotiyo",
  athanor: "Athanor",
  tatara: "Tatara",
  ansiblex: "Ansiblex",
  pharolynx: "Pharolynx",
  tenebrex: "Tenebrex",
};

const PASTE_TYPE_MAP: Partial<Record<string, StructureType>> = {
  astrahus: "astrahus",
  fortizar: "fortizar",
  keepstar: "keepstar",
  raitaru: "raitaru",
  azbel: "azbel",
  sotiyo: "sotiyo",
  athanor: "athanor",
  tatara: "tatara",
  "ansiblex jump gate": "ansiblex",
  ansiblex: "ansiblex",
  "pharolynx cyno beacon": "pharolynx",
  pharolynx: "pharolynx",
  "tenebrex cyno jammer": "tenebrex",
  tenebrex: "tenebrex",
};

interface ParsedStructureRow {
  eve_id: number;
  name: string;
  structure_type: StructureType;
}

/** Parses EVE's in-game Overview clipboard paste for a citadel/structure:
 * tab-separated Item ID / Name / Type. ESI can't see a structure sitting in
 * unscanned J-space, so this is the only way to register one on the chain. */
function parseStructureClipboard(text: string): ParsedStructureRow[] {
  const results: ParsedStructureRow[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const eveId = parseInt(parts[0]?.trim() ?? "", 10);
    if (Number.isNaN(eveId)) continue;
    const name = parts[1]?.trim() ?? "";
    const typeStr = parts[2]?.trim().toLowerCase() ?? "";
    const structureType = PASTE_TYPE_MAP[typeStr];
    if (!structureType) continue;
    results.push({ eve_id: eveId, name, structure_type: structureType });
  }
  return results;
}

/** Structures, NPC stations, and 1h activity for the selected system - all
 * pulled from the exact same getSystemDetail call the Map page already uses
 * (stations/player_structures/kill+jump snapshots), so this is reused data,
 * not a new fetch pipeline. Also hosts the per-system notes field, which the
 * chain_systems schema already had a column for but no UI ever wrote to. */
function SystemIntelPanel({ chainId, system, structures, onChanged }: SystemIntelPanelProps) {
  const [detail, setDetail] = useState<SystemDetail | null>(null);
  const [notes, setNotes] = useState(system.notes);
  const [structurePaste, setStructurePaste] = useState("");
  const [importingStructures, setImportingStructures] = useState(false);
  const reportError = useErrorReporter();

  async function handleImportStructures() {
    const parsed = parseStructureClipboard(structurePaste);
    if (parsed.length === 0) {
      reportError("No recognizable structures found in that paste - copy directly from the in-game Overview.");
      return;
    }
    setImportingStructures(true);
    try {
      await importStructures(chainId, system.id, parsed);
      setStructurePaste("");
      onChanged();
    } catch (err) {
      reportError(`Failed to import structures: ${String(err)}`);
    } finally {
      setImportingStructures(false);
    }
  }

  async function handleDeleteStructure(structureId: string) {
    try {
      await deleteChainStructure(chainId, structureId);
      onChanged();
    } catch (err) {
      reportError(`Failed to delete structure: ${String(err)}`);
    }
  }

  useEffect(() => {
    setNotes(system.notes);
    // Also clears any unsent structure paste - this panel isn't remounted
    // on system switch (no per-system key in the parent), so without this
    // leftover clipboard text from the previous system would still be
    // sitting in the textarea and could get submitted against the wrong
    // chain_system_id if "Import Structures" is clicked without noticing.
    setStructurePaste("");
  }, [system.id, system.notes]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    getSystemDetail(system.system_id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [system.system_id]);

  async function saveNotes() {
    if (notes === system.notes) return;
    try {
      await upsertChainSystem(chainId, {
        id: system.id,
        system_id: system.system_id,
        system_name: system.system_name,
        x: system.x,
        y: system.y,
        is_origin: system.is_origin,
        notes,
      });
      onChanged();
    } catch (err) {
      reportError(`Failed to save notes: ${String(err)}`);
    }
  }

  if (!detail) {
    return <p className="detail-empty wh-intel-loading">Loading system intel...</p>;
  }

  const hasActivity = detail.ship_kills_1h > 0 || detail.npc_kills_1h > 0 || detail.pod_kills_1h > 0 || detail.ship_jumps_1h > 0;
  const whStatic = WH_SYSTEM_STATICS[system.system_id];

  return (
    <div className="wh-intel-panel">
      {whStatic && (
        <div className="wh-intel-statics" title="Known statics for this system - not what you scanned, what's always here">
          <span className="wh-intel-statics-class">{whStatic.class}</span>
          {whStatic.effect && (
            <span className="wh-intel-statics-effect">
              {EFFECT_SYMBOLS[whStatic.effect]} {EFFECT_LABELS[whStatic.effect]}
            </span>
          )}
          {whStatic.statics.length > 0 && (
            <span className="wh-intel-statics-list">Statics: {whStatic.statics.join(", ")}</span>
          )}
        </div>
      )}

      {hasActivity && (
        <div className="wh-intel-activity">
          {detail.ship_jumps_1h > 0 && (
            <span className="wh-intel-stat" title="Ship jumps, last hour">
              <Rocket size={12} strokeWidth={2} /> {detail.ship_jumps_1h}
            </span>
          )}
          {detail.ship_kills_1h > 0 && (
            <span className="wh-intel-stat wh-intel-stat-danger" title="Ship kills, last hour">
              <Swords size={12} strokeWidth={2} /> {detail.ship_kills_1h}
            </span>
          )}
          {detail.pod_kills_1h > 0 && (
            <span className="wh-intel-stat wh-intel-stat-danger" title="Pod kills, last hour">
              <Skull size={12} strokeWidth={2} /> {detail.pod_kills_1h}
            </span>
          )}
        </div>
      )}

      {detail.stations.length > 0 && (
        <div className="wh-intel-section">
          <p className="wh-side-label">NPC Stations</p>
          {detail.stations.map((s) => (
            <p key={s.id} className="wh-intel-row">
              {s.name}
            </p>
          ))}
        </div>
      )}

      {detail.player_structures.length > 0 && (
        <div className="wh-intel-section">
          <p className="wh-side-label">
            <Building2 size={13} strokeWidth={2} /> Structures
          </p>
          {detail.player_structures.map((s) => (
            <p key={s.id} className="wh-intel-row">
              {s.name}
              {s.owner_corporation_ticker && <span className="wh-intel-row-sub"> [{s.owner_corporation_ticker}]</span>}
            </p>
          ))}
        </div>
      )}

      <div className="wh-intel-section">
        <p className="wh-side-label">
          <Building2 size={13} strokeWidth={2} /> Structures (Manual)
        </p>
        {structures.length === 0 ? (
          <p className="detail-empty wh-sig-empty">
            None registered - ESI can't see structures in unscanned J-space, so paste your in-game Overview below to
            track one here.
          </p>
        ) : (
          structures.map((s) => (
            <div key={s.id} className="wh-intel-row wh-structure-row">
              <span>
                {s.name}
                <span className="wh-intel-row-sub"> ({STRUCTURE_TYPE_LABELS[s.structure_type]})</span>
              </span>
              <button type="button" onClick={() => handleDeleteStructure(s.id)} title="Remove structure">
                <Trash2 size={12} strokeWidth={2} />
              </button>
            </div>
          ))
        )}
        <textarea
          className="price-checker-input wh-sig-paste"
          placeholder="Paste the in-game Overview here to register a citadel..."
          rows={2}
          value={structurePaste}
          onChange={(e) => setStructurePaste(e.target.value)}
        />
        <button
          type="button"
          className="kills-sync-btn"
          onClick={handleImportStructures}
          disabled={importingStructures || structurePaste.trim().length === 0}
        >
          {importingStructures ? "Importing..." : "Import Structures"}
        </button>
      </div>

      <label className="wh-field-label">
        System Notes
        <textarea
          className="price-checker-input"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
        />
      </label>
    </div>
  );
}

export default SystemIntelPanel;
