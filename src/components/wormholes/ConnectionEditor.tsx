import { useState } from "react";
import { Trash2, AlertTriangle, Flag, Skull, Eye, Lock, Clock, ShieldAlert, Zap, X, Navigation } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  upsertConnection,
  deleteConnection,
  upsertMassLog,
  deleteMassLogEntry,
  clearMassLog,
  type Connection,
  type ChainSystem,
  type MassStatus,
  type Signature,
  type MassLogEntry,
} from "../../lib/wormholes";
import { WORMHOLE_TYPES } from "../../lib/wormholeTypes";
import {
  deriveTimeStatus,
  TIME_STATUS_LABEL,
  massRange,
  passOutcome,
  deriveMassStatus,
  formatMassKg,
  ROLLER_PRESETS,
  whSizeClass,
  WH_SIZE_LABEL,
  WH_SIZE_SHORT,
} from "../../lib/wormholeMass";
import { useCharacterLocation } from "../../hooks/useCharacterLocation";
import { getTypeMass } from "../../lib/market";
import { useErrorReporter } from "../../hooks/useErrorReporter";

function formatMass(kg: number | null): string {
  if (kg == null) return "unknown";
  if (kg >= 1_000_000_000) return `${(kg / 1_000_000_000).toFixed(2)}B kg`;
  return `${(kg / 1_000_000).toFixed(0)}M kg`;
}

function WormholeTypeField({ value, onPick }: { value: string; onPick: (code: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = draft ?? value;
  const known = WORMHOLE_TYPES.find((w) => w.code === value);
  const trimmed = shown.trim().toUpperCase();
  const matches = trimmed ? WORMHOLE_TYPES.filter((w) => w.code.startsWith(trimmed)).slice(0, 8) : [];

  function commit(code: string) {
    setDraft(null);
    setOpen(false);
    if (code.trim() && code !== value) onPick(code.trim().toUpperCase());
  }

  return (
    <div className="wh-type-field">
      <div className="kills-add-combobox">
        <input
          type="text"
          value={shown}
          placeholder="e.g. K162, N062"
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => commit(draft ?? value), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(draft ?? value);
          }}
        />
        {open && matches.length > 0 && (
          <div className="gatecheck-slot-results kills-add-suggestions">
            {matches.map((w) => {
              const size = whSizeClass(w.maxJumpMassKg);
              return (
                <button key={w.code} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(w.code)}>
                  <strong>{w.code}</strong> &rarr; {w.leadsToClass}
                  {size && <span className="wh-size-chip">{WH_SIZE_SHORT[size]}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {known && (
        <p className="wh-type-hint">
          Leads to {known.leadsToClass}
          {(() => {
            const size = whSizeClass(known.maxJumpMassKg);
            return size ? ` · ${WH_SIZE_LABEL[size]}` : "";
          })()}
          {" · max "}
          {formatMass(known.maxMassKg)} total, {formatMass(known.maxJumpMassKg)} per jump
          {known.lifetimeHours != null ? ` · ~${known.lifetimeHours}h lifetime` : ""}
        </p>
      )}
    </div>
  );
}

const FLAG_ICONS: Record<string, LucideIcon> = { Flag, Skull, Eye, Lock, Clock, ShieldAlert, Zap };
const FLAG_ICON_NAMES = Object.keys(FLAG_ICONS);

const TIME_STATUS_COLOR: Record<string, string> = {
  fresh: "var(--success)",
  lessThan24h: "var(--success)",
  lessThan4h: "var(--warning)",
  lessThan1h: "var(--danger)",
  eol: "var(--danger)",
  expired: "var(--text-muted)",
};

interface ConnectionEditorProps {
  chainId: string;
  connection: Connection;
  fromSystem: ChainSystem | null;
  toSystem: ChainSystem | null;
  fromSignatures: Signature[];
  toSignatures: Signature[];
  massLogEntries: MassLogEntry[];
  characterName: string | null;
  onChanged: () => void;
  onDeleted: () => void;
}

const MASS_OPTIONS: { value: MassStatus; label: string }[] = [
  { value: "fresh", label: "Fresh" },
  { value: "reduced", label: "Reduced" },
  { value: "critical", label: "Critical" },
];

function elapsedLabel(timestamp: number): string {
  const minutes = Math.floor((Date.now() / 1000 - timestamp) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function ConnectionEditor({
  chainId,
  connection,
  fromSystem,
  toSystem,
  fromSignatures,
  toSignatures,
  massLogEntries,
  characterName,
  onChanged,
  onDeleted,
}: ConnectionEditorProps) {
  const reportError = useErrorReporter();
  const location = useCharacterLocation();
  const [rollerPreset, setRollerPreset] = useState(0);
  const [customMassKg, setCustomMassKg] = useState("");
  const [loadingShipMass, setLoadingShipMass] = useState(false);

  const known = WORMHOLE_TYPES.find((w) => w.code === connection.wormhole_type);
  const timeStatus = deriveTimeStatus(connection.first_seen_at, known?.lifetimeHours ?? null, connection.is_eol);

  const massUsedKg = massLogEntries.reduce((sum, e) => sum + e.mass_kg, 0);
  const range = known?.maxMassKg != null ? massRange(known.maxMassKg, massUsedKg) : null;
  const derivedStatus = range ? deriveMassStatus(range) : null;
  const isRollingActive = massUsedKg > 0 && range != null;

  async function update(patch: Partial<Connection>) {
    try {
      await upsertConnection(chainId, {
        id: connection.id,
        from_chain_system_id: connection.from_chain_system_id,
        to_chain_system_id: connection.to_chain_system_id,
        kind: connection.kind,
        wormhole_type: connection.wormhole_type,
        mass_status: connection.mass_status,
        is_eol: connection.is_eol,
        from_signature_id: connection.from_signature_id,
        to_signature_id: connection.to_signature_id,
        flag_icon: connection.flag_icon,
        flag_color: connection.flag_color,
        flag_note: connection.flag_note,
        flag_blink: connection.flag_blink,
        notes: connection.notes,
        ...patch,
      });
      onChanged();
    } catch (err) {
      reportError(`Failed to update connection: ${String(err)}`);
    }
  }

  async function handleDelete() {
    try {
      await deleteConnection(chainId, connection.id);
      onDeleted();
    } catch (err) {
      reportError(`Failed to delete connection: ${String(err)}`);
    }
  }

  const presetMassKg = ROLLER_PRESETS[rollerPreset]?.massKg ?? 0;
  const activeMassKg = rollerPreset === ROLLER_PRESETS.length - 1 ? Number(customMassKg) || 0 : presetMassKg;

  async function handlePass(hot: boolean) {
    if (!range || activeMassKg <= 0) return;
    const outcome = passOutcome(range, activeMassKg);
    if (outcome === "collapse") {
      const ok = confirm("This pass would collapse the hole - if your ship is the one passing, it could strand you on the far side. Log it anyway?");
      if (!ok) return;
    }
    try {
      await upsertMassLog(chainId, {
        connection_id: connection.id,
        character_name: characterName ?? "Unknown Pilot",
        ship_type_name: ROLLER_PRESETS[rollerPreset]?.label ?? "Custom",
        mass_kg: activeMassKg,
        hot,
        source: "manual",
      });
      onChanged();
    } catch (err) {
      reportError(`Failed to log pass: ${String(err)}`);
    }
  }

  async function handleUseMyShip() {
    if (location.shipTypeId == null) {
      reportError("No live ship data yet - your character location may still be loading.");
      return;
    }
    setLoadingShipMass(true);
    try {
      const mass = await getTypeMass(location.shipTypeId);
      if (mass == null) {
        reportError("Couldn't find a mass value for your current ship.");
        return;
      }
      const customIndex = ROLLER_PRESETS.length - 1;
      setRollerPreset(customIndex);
      setCustomMassKg(String(Math.round(mass)));
    } catch (err) {
      reportError(`Failed to look up ship mass: ${String(err)}`);
    } finally {
      setLoadingShipMass(false);
    }
  }

  async function handleUndo() {
    const last = massLogEntries[massLogEntries.length - 1];
    if (!last) return;
    try {
      await deleteMassLogEntry(chainId, last.id);
      onChanged();
    } catch (err) {
      reportError(`Failed to undo: ${String(err)}`);
    }
  }

  async function handleReset() {
    if (!confirm("Clear the whole mass log for this connection?")) return;
    try {
      await clearMassLog(chainId, connection.id);
      onChanged();
    } catch (err) {
      reportError(`Failed to reset mass log: ${String(err)}`);
    }
  }

  const FlagIcon = connection.flag_icon ? FLAG_ICONS[connection.flag_icon] : null;

  return (
    <div className="wh-conn-editor">
      <p className="wh-side-label">
        {fromSystem?.system_name ?? "?"} <span className="wh-conn-arrow">&harr;</span> {toSystem?.system_name ?? "?"}
      </p>

      {connection.kind === "stargate" ? (
        <p className="wh-conn-stargate-notice">
          <Navigation size={13} strokeWidth={2} /> Stargate hop, tracked automatically as part of your route in and
          out of known space.
        </p>
      ) : null}

      {connection.kind === "wormhole" && (connection.from_signature_broken || connection.to_signature_broken) && (
        <p className="wh-conn-broken-notice">
          <AlertTriangle size={13} strokeWidth={2} /> The signature backing this link is no longer in your scan data - verify it's still there.
        </p>
      )}

      {connection.kind === "wormhole" && (
        <>
      <label className="wh-field-label">
        Wormhole Type
        <WormholeTypeField value={connection.wormhole_type} onPick={(code) => update({ wormhole_type: code })} />
      </label>

      <label className="wh-field-label">
        Mass Status {isRollingActive && <span className="wh-derived-hint">derived from log &middot; reset to override</span>}
        <div className="wh-mass-toggle">
          {MASS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={isRollingActive}
              className={`wh-mass-btn wh-mass-btn-${opt.value}${
                (isRollingActive ? derivedStatus : connection.mass_status) === opt.value ? " wh-mass-btn-active" : ""
              }`}
              onClick={() => update({ mass_status: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </label>

      <label className="wh-field-label wh-eol-row">
        <input type="checkbox" checked={connection.is_eol} onChange={(e) => update({ is_eol: e.target.checked })} />
        End of Life {connection.is_eol && connection.eol_flagged_at && <span className="wh-eol-elapsed">({elapsedLabel(connection.eol_flagged_at)})</span>}
        <span className="wh-time-pill" style={{ color: TIME_STATUS_COLOR[timeStatus] }}>
          {TIME_STATUS_LABEL[timeStatus]}
        </span>
      </label>

      {(fromSignatures.length > 0 || toSignatures.length > 0) && (
        <>
          <label className="wh-field-label">
            {fromSystem?.system_name ?? "From"} Signature
            <select
              value={connection.from_signature_id ?? ""}
              onChange={(e) => update({ from_signature_id: e.target.value || null })}
            >
              <option value="">Not linked</option>
              {fromSignatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sig_id}
                </option>
              ))}
            </select>
          </label>
          <label className="wh-field-label">
            {toSystem?.system_name ?? "To"} Signature
            <select value={connection.to_signature_id ?? ""} onChange={(e) => update({ to_signature_id: e.target.value || null })}>
              <option value="">Not linked</option>
              {toSignatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sig_id}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <div className="wh-flag-block">
        <p className="wh-side-label">Flag</p>
        <div className="wh-flag-row">
          <div className="wh-flag-icon-picker">
            {FLAG_ICON_NAMES.map((name) => {
              const Icon = FLAG_ICONS[name];
              return (
                <button
                  key={name}
                  type="button"
                  className={`wh-flag-icon-btn${connection.flag_icon === name ? " wh-flag-icon-btn-active" : ""}`}
                  style={connection.flag_icon === name && connection.flag_color ? { color: connection.flag_color } : undefined}
                  onClick={() => update({ flag_icon: name })}
                  title={name}
                >
                  <Icon size={13} strokeWidth={2} />
                </button>
              );
            })}
          </div>
          <input
            type="color"
            className="wh-flag-color-input"
            value={connection.flag_color ?? "#e0a85c"}
            onChange={(e) => update({ flag_color: e.target.value })}
          />
          {connection.flag_icon && (
            <button
              type="button"
              className="wh-flag-remove-btn"
              onClick={() => update({ flag_icon: null, flag_color: null, flag_note: "", flag_blink: false })}
              title="Remove flag"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
        <input
          type="text"
          className="wh-flag-note-input"
          placeholder="Flag note (optional)"
          maxLength={200}
          value={connection.flag_note}
          onChange={(e) => update({ flag_note: e.target.value })}
        />
        <label className="wh-flag-blink-row">
          <input type="checkbox" checked={connection.flag_blink} onChange={(e) => update({ flag_blink: e.target.checked })} />
          Blink on the map
        </label>
        {FlagIcon && (
          <p className="wh-flag-preview" style={{ color: connection.flag_color ?? undefined }}>
            <FlagIcon size={13} strokeWidth={2} /> {connection.flag_note || "No note"}
          </p>
        )}
      </div>

      {known?.maxMassKg != null && range && (
        <div className="wh-rolling-block">
          <p className="wh-side-label">Rolling Calculator</p>
          <div className="wh-mass-bar">
            <div className="wh-mass-bar-track">
              <div className="wh-mass-bar-variance" style={{ width: `${100 - (range.worstTotalKg / range.bestTotalKg) * 100}%` }} />
              <div
                className="wh-mass-bar-used"
                style={{ width: `${Math.min(100, (massUsedKg / range.bestTotalKg) * 100)}%` }}
              />
            </div>
            <p className="wh-mass-bar-label">
              {formatMassKg(range.worstRemainingKg)}&ndash;{formatMassKg(range.bestRemainingKg)} left &middot; {formatMassKg(massUsedKg)} used &middot; max {formatMass(known.maxJumpMassKg)} per jump
            </p>
          </div>

          <div className="wh-roller-row">
            <select
              className="wh-roller-select"
              value={rollerPreset}
              onChange={(e) => setRollerPreset(Number(e.target.value))}
            >
              {ROLLER_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
            {rollerPreset === ROLLER_PRESETS.length - 1 && (
              <input
                type="number"
                className="wh-roller-custom-input"
                placeholder="Mass (kg)"
                value={customMassKg}
                onChange={(e) => setCustomMassKg(e.target.value)}
              />
            )}
            <button type="button" className="wh-roller-ship-btn" onClick={handleUseMyShip} disabled={loadingShipMass}>
              {loadingShipMass ? "Loading..." : "Use My Ship"}
            </button>
          </div>

          <div className="wh-pass-row">
            <button
              type="button"
              className={`wh-pass-btn wh-pass-btn-${passOutcome(range, activeMassKg)}`}
              disabled={activeMassKg <= 0}
              onClick={() => handlePass(true)}
            >
              Pass Hot
            </button>
            <button
              type="button"
              className={`wh-pass-btn wh-pass-btn-${passOutcome(range, activeMassKg)}`}
              disabled={activeMassKg <= 0}
              onClick={() => handlePass(false)}
            >
              Pass Cold
            </button>
            <button type="button" className="wh-pass-undo-btn" onClick={handleUndo} disabled={massLogEntries.length === 0}>
              Undo
            </button>
            <button type="button" className="wh-pass-undo-btn" onClick={handleReset} disabled={massLogEntries.length === 0}>
              Reset
            </button>
          </div>

          {massLogEntries.length > 0 && (
            <div className="wh-jump-log">
              {[...massLogEntries].reverse().map((entry) => (
                <div key={entry.id} className="wh-jump-log-row">
                  <span>{entry.character_name}</span>
                  <span className="wh-jump-log-ship">{entry.ship_type_name}</span>
                  <span className={`wh-jump-log-temp wh-jump-log-temp-${entry.hot ? "hot" : "cold"}`}>{entry.hot ? "Hot" : "Cold"}</span>
                  <span>{formatMassKg(entry.mass_kg)}</span>
                  <span className="wh-jump-log-time">{elapsedLabel(entry.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
        </>
      )}

      <label className="wh-field-label">
        Notes
        <textarea
          className="price-checker-input"
          rows={2}
          value={connection.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </label>

      <button type="button" className="wh-delete-btn" onClick={handleDelete}>
        <Trash2 size={13} strokeWidth={2} /> Delete Connection
      </button>
    </div>
  );
}

export default ConnectionEditor;
