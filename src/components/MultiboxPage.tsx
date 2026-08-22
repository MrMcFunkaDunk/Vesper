import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Users, X, Plus, Check, Trash2 } from "lucide-react";
import {
  getMultiboxClients,
  isMultiboxOverlayOpen,
  openMultiboxOverlay,
  closeMultiboxOverlay,
  getMultiboxSettings,
  setMultiboxSettings,
  listMultiboxProfiles,
  saveMultiboxProfile,
  deleteMultiboxProfile,
  type MultiboxClient,
  type MultiboxSettings,
  type MultiboxProfile,
} from "../lib/multibox";
import { useErrorReporter } from "../hooks/useErrorReporter";
import HelpBadge from "./HelpBadge";
import { HELP_CONTENT } from "../lib/helpContent";

const CLIENT_POLL_MS = 3000;

const COLOR_PRESETS: [number, number, number][] = [
  [0x9a, 0xe6, 0x3c], // green
  [0xff, 0x5c, 0x5c], // red
  [0xff, 0xa5, 0x00], // orange
  [0x6f, 0xc3, 0xd9], // cyan (VESPER's own accent)
  [0xc9, 0x8a, 0xff], // purple
  [0xff, 0xff, 0xff], // white
];

const ANCHOR_LABELS = ["Top-left", "Top-center", "Top-right", "Middle-left", "Center", "Middle-right", "Bottom-left", "Bottom-center", "Bottom-right"];

function rgbCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function ColorSwatchPicker({ value, onChange }: { value: [number, number, number]; onChange: (color: [number, number, number]) => void }) {
  return (
    <div className="multibox-color-swatch-row">
      {COLOR_PRESETS.map((color) => (
        <button
          key={rgbCss(color)}
          type="button"
          className={`multibox-color-swatch${value.join(",") === color.join(",") ? " multibox-color-swatch-active" : ""}`}
          style={{ background: rgbCss(color) }}
          aria-label={`Use ${rgbCss(color)}`}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

function AnchorPicker({ value, onChange }: { value: number; onChange: (anchor: number) => void }) {
  return (
    <div className="multibox-anchor-grid">
      {ANCHOR_LABELS.map((label, i) => (
        <button
          key={label}
          type="button"
          className={`multibox-anchor-cell${value === i ? " multibox-anchor-cell-active" : ""}`}
          aria-label={label}
          title={label}
          onClick={() => onChange(i)}
        />
      ))}
    </div>
  );
}

/** Builds a "Ctrl+Alt+F1"-style combo string from a keydown event, or null
 * if the key isn't usable as a global hotkey - either it's a bare modifier
 * on its own, or it has no modifier at all (a global hotkey with no
 * modifier would steal that key from every other application on the PC,
 * including normal typing, so this refuses to record one). */
function comboFromKeyEvent(e: ReactKeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Win");
  if (parts.length === 0) return null;

  let key = e.key;
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) {
    // F1-F24, already in the right shape
  } else if (/^[0-9]$/.test(key)) {
    // digit, already in the right shape
  } else if (/^[a-zA-Z]$/.test(key)) {
    key = key.toUpperCase();
  } else {
    return null;
  }
  parts.push(key);
  return parts.join("+");
}

function HotkeyRecorder({ combo, onChange }: { combo: string | undefined; onChange: (combo: string | null) => void }) {
  const [recording, setRecording] = useState(false);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (e.key === "Escape") {
      setRecording(false);
      return;
    }
    const next = comboFromKeyEvent(e);
    if (next) {
      onChange(next);
      setRecording(false);
    }
  }

  return (
    <div className="multibox-hotkey-row">
      <button
        type="button"
        className={`multibox-hotkey-btn${recording ? " multibox-hotkey-btn-recording" : ""}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={recording ? handleKeyDown : undefined}
        title={recording ? "Press a key combo (Esc to cancel)" : "Click, then press a key combo to set a global hotkey"}
      >
        {recording ? "Press keys..." : (combo ?? "Set hotkey")}
      </button>
      {combo && (
        <button type="button" className="multibox-hotkey-clear" onClick={() => onChange(null)} title="Clear hotkey">
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/** Named presets of the whole settings struct - "PvP" vs "Mining" layouts,
 * swappable in one click instead of re-toggling everything by hand. Reuses
 * the same pill-tab-with-inline-create idiom as the Settings Sync profile
 * tabs and the wormhole Chain Switcher. */
function MultiboxProfileBar({
  profiles,
  onLoad,
  onSave,
  onDelete,
}: {
  profiles: MultiboxProfile[];
  onLoad: (profile: MultiboxProfile) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  function startCreate() {
    setDraftName("");
    setCreating(true);
  }

  function confirmSave() {
    const name = draftName.trim();
    if (name) onSave(name);
    setCreating(false);
  }

  return (
    <div className="settings-profile-tabs">
      {profiles.map((profile) => (
        <button key={profile.name} type="button" className="settings-profile-pill" onClick={() => onLoad(profile)}>
          {profile.name}
          <span
            className="settings-profile-pill-action"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete profile "${profile.name}"?`)) onDelete(profile.name);
            }}
            title="Delete profile"
          >
            <Trash2 size={11} strokeWidth={2} />
          </span>
        </button>
      ))}
      {creating ? (
        <div className="settings-profile-rename">
          <input
            type="text"
            autoFocus
            placeholder="Profile name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmSave();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" onClick={confirmSave} title="Save">
            <Check size={13} strokeWidth={2} />
          </button>
          <button type="button" onClick={() => setCreating(false)} title="Cancel">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button type="button" className="settings-profile-pill settings-profile-pill-new" onClick={startCreate}>
          <Plus size={13} strokeWidth={2} /> Save Current As...
        </button>
      )}
    </div>
  );
}

function MultiboxPage() {
  const [clients, setClients] = useState<MultiboxClient[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [settings, setSettings] = useState<MultiboxSettings | null>(null);
  const [profiles, setProfiles] = useState<MultiboxProfile[]>([]);
  const reportError = useErrorReporter();

  useEffect(() => {
    getMultiboxSettings()
      .then(setSettings)
      .catch((err) => reportError(`Failed to load multibox settings: ${String(err)}`));
    listMultiboxProfiles()
      .then(setProfiles)
      .catch((err) => reportError(`Failed to load multibox profiles: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [nextClients, nextOpen] = await Promise.all([getMultiboxClients(), isMultiboxOverlayOpen()]);
        if (cancelled) return;
        setClients(nextClients);
        setOverlayOpen(nextOpen);
      } catch (err) {
        if (!cancelled) reportError(`Failed to check EVE clients: ${String(err)}`);
      }
    }

    poll();
    const interval = setInterval(poll, CLIENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggle() {
    setPending(true);
    try {
      if (overlayOpen) {
        await closeMultiboxOverlay();
        setOverlayOpen(false);
      } else {
        await openMultiboxOverlay();
        setOverlayOpen(true);
      }
    } catch (err) {
      reportError(`Failed to ${overlayOpen ? "close" : "open"} the multibox preview: ${String(err)}`);
    } finally {
      setPending(false);
    }
  }

  function updateSettings(patch: Partial<MultiboxSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setMultiboxSettings(next).catch((err) => reportError(`Failed to save multibox settings: ${String(err)}`));
      return next;
    });
  }

  function toggleClientHidden(label: string, hidden: boolean) {
    updateSettings({ force_hidden: { ...(settings?.force_hidden ?? {}), [label]: hidden } });
  }

  function setHotkey(label: string, combo: string | null) {
    const nextHotkeys = { ...(settings?.hotkeys ?? {}) };
    if (combo) nextHotkeys[label] = combo;
    else delete nextHotkeys[label];
    updateSettings({ hotkeys: nextHotkeys });
  }

  function handleLoadProfile(profile: MultiboxProfile) {
    setSettings(profile.settings);
    setMultiboxSettings(profile.settings).catch((err) => reportError(`Failed to apply profile: ${String(err)}`));
  }

  async function handleSaveProfile(name: string) {
    if (!settings) return;
    try {
      await saveMultiboxProfile(name, settings);
      setProfiles(await listMultiboxProfiles());
    } catch (err) {
      reportError(`Failed to save profile: ${String(err)}`);
    }
  }

  async function handleDeleteProfile(name: string) {
    try {
      await deleteMultiboxProfile(name);
      setProfiles(await listMultiboxProfiles());
    } catch (err) {
      reportError(`Failed to delete profile: ${String(err)}`);
    }
  }

  return (
    <main className="main main-dashboard">
      <div className="dashboard">
        <div className="dashboard-header">
          <p className="eyebrow">
            <Users size={14} strokeWidth={2} /> Multiboxing
          </p>
          <div className="dashboard-header-title-row">
            <h2>Client Preview</h2>
            <HelpBadge content={HELP_CONTENT.multiboxing} />
          </div>
          <p className="wh-page-subtitle">
            Live thumbnail previews of every running EVE client, each its own floating window you can position and resize
            anywhere - click one to switch focus to that client.
          </p>
        </div>

        <div className="multibox-status-row">
          <div className="multibox-status-card">
            <p className="eyebrow">Detected Clients</p>
            <h2>{clients.length}</h2>
          </div>
          <button type="button" className="kills-sync-btn" onClick={handleToggle} disabled={pending}>
            {overlayOpen ? "Close Floating Preview" : "Open Floating Preview"}
          </button>
        </div>

        {settings && (
          <>
            <div className="settings-section">
              <h3>Profiles</h3>
              <p className="settings-section-hint">
                Save the whole set of settings below under a name - e.g. a "PvP" layout vs a "Mining" layout - and
                swap between them in one click instead of re-toggling everything by hand.
              </p>
              <MultiboxProfileBar profiles={profiles} onLoad={handleLoadProfile} onSave={handleSaveProfile} onDelete={handleDeleteProfile} />
            </div>

            <div className="settings-section">
              <h3>General</h3>
              <p className="settings-section-hint">Applies live to any already-open previews within about a second.</p>

              <label className="settings-checkbox-row">
                <input type="checkbox" checked={settings.always_on_top} onChange={(e) => updateSettings({ always_on_top: e.target.checked })} />
                Always on top of other windows
              </label>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={settings.locked} onChange={(e) => updateSettings({ locked: e.target.checked })} />
                Lock positions &amp; sizes (prevents dragging/resizing)
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.hide_active_preview}
                  onChange={(e) => updateSettings({ hide_active_preview: e.target.checked })}
                />
                Hide the preview of whichever client currently has focus
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.minimize_inactive_clients}
                  onChange={(e) => updateSettings({ minimize_inactive_clients: e.target.checked })}
                />
                Minimize every client except whichever one has focus
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.remember_positions}
                  onChange={(e) => updateSettings({ remember_positions: e.target.checked })}
                />
                Remember each client's window position between sessions
              </label>
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.unique_layout_per_client}
                  onChange={(e) => updateSettings({ unique_layout_per_client: e.target.checked })}
                />
                Remember each client's own size too, instead of always using the default below
              </label>
            </div>

            <div className="settings-section">
              <h3>Thumbnail</h3>
              <div className="settings-section-row">
                <span className="settings-inline-label">Opacity</span>
                <input
                  type="range"
                  min={40}
                  max={255}
                  value={settings.opacity}
                  onChange={(e) => updateSettings({ opacity: Number(e.target.value) })}
                />
                <span className="multibox-settings-value">{Math.round((settings.opacity / 255) * 100)}%</span>
              </div>
              <div className="settings-section-row">
                <span className="settings-inline-label">Default size</span>
                <input
                  type="number"
                  className="industry-field-input multibox-size-input"
                  value={settings.default_width}
                  min={120}
                  onChange={(e) => updateSettings({ default_width: Number(e.target.value) })}
                />
                <span className="multibox-settings-value">x</span>
                <input
                  type="number"
                  className="industry-field-input multibox-size-input"
                  value={settings.default_height}
                  min={80}
                  onChange={(e) => updateSettings({ default_height: Number(e.target.value) })}
                />
                <span className="settings-section-hint">Only applies to new preview windows.</span>
              </div>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={settings.snap_to_grid} onChange={(e) => updateSettings({ snap_to_grid: e.target.checked })} />
                Snap position to a grid while dragging
              </label>
              {settings.snap_to_grid && (
                <div className="settings-section-row">
                  <span className="settings-inline-label">Grid size</span>
                  <input
                    type="number"
                    className="industry-field-input multibox-size-input"
                    value={settings.snap_grid_x}
                    min={10}
                    onChange={(e) => updateSettings({ snap_grid_x: Number(e.target.value) })}
                  />
                  <span className="multibox-settings-value">x</span>
                  <input
                    type="number"
                    className="industry-field-input multibox-size-input"
                    value={settings.snap_grid_y}
                    min={10}
                    onChange={(e) => updateSettings({ snap_grid_y: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>

            <div className="settings-section">
              <h3>Zoom on Hover</h3>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={settings.zoom_on_hover} onChange={(e) => updateSettings({ zoom_on_hover: e.target.checked })} />
                Temporarily enlarge a preview while the mouse is over it
              </label>
              {settings.zoom_on_hover && (
                <>
                  <div className="settings-section-row">
                    <span className="settings-inline-label">Zoom factor</span>
                    <input
                      type="range"
                      min={1.1}
                      max={3}
                      step={0.1}
                      value={settings.zoom_factor}
                      onChange={(e) => updateSettings({ zoom_factor: Number(e.target.value) })}
                    />
                    <span className="multibox-settings-value">{settings.zoom_factor.toFixed(1)}x</span>
                  </div>
                  <div className="settings-section-row">
                    <span className="settings-inline-label">Anchor</span>
                    <AnchorPicker value={settings.zoom_anchor} onChange={(zoom_anchor) => updateSettings({ zoom_anchor })} />
                  </div>
                </>
              )}
            </div>

            <div className="settings-section">
              <h3>Overlay</h3>
              <label className="settings-checkbox-row">
                <input type="checkbox" checked={settings.show_overlay} onChange={(e) => updateSettings({ show_overlay: e.target.checked })} />
                Show overlay (label, frames, highlight) - off shows bare thumbnails only
              </label>

              {settings.show_overlay && (
                <>
                  <div className="settings-section-row">
                    <span className="settings-inline-label">Label size</span>
                    <input
                      type="number"
                      className="industry-field-input multibox-size-input"
                      value={settings.label_size}
                      min={8}
                      max={32}
                      onChange={(e) => updateSettings({ label_size: Number(e.target.value) })}
                    />
                    <span className="settings-inline-label">Color</span>
                    <ColorSwatchPicker value={settings.label_color} onChange={(label_color) => updateSettings({ label_color })} />
                  </div>
                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.label_at_bottom}
                      onChange={(e) => updateSettings({ label_at_bottom: e.target.checked })}
                    />
                    Show the label at the bottom instead of the top
                  </label>

                  <label className="settings-checkbox-row">
                    <input type="checkbox" checked={settings.show_frames} onChange={(e) => updateSettings({ show_frames: e.target.checked })} />
                    Show a frame around every preview, not just the active one
                  </label>
                  {settings.show_frames && (
                    <div className="settings-section-row">
                      <span className="settings-inline-label">Frame color</span>
                      <ColorSwatchPicker value={settings.frame_color} onChange={(frame_color) => updateSettings({ frame_color })} />
                    </div>
                  )}

                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.highlight_active}
                      onChange={(e) => updateSettings({ highlight_active: e.target.checked })}
                    />
                    Highlight whichever client currently has focus
                  </label>
                  {settings.highlight_active && (
                    <div className="settings-section-row">
                      <span className="settings-inline-label">Highlight color</span>
                      <ColorSwatchPicker value={settings.highlight_color} onChange={(highlight_color) => updateSettings({ highlight_color })} />
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {clients.length === 0 ? (
          <p className="detail-empty">No running EVE clients detected. Launch one or more clients and this list updates automatically.</p>
        ) : (
          <div className="settings-section">
            <h3>Active Clients</h3>
            <p className="settings-section-hint">
              Set a hotkey on a character to jump straight to that client from anywhere, even while a different one
              is focused - needs at least one modifier key (Ctrl/Alt/Shift/Win) so it doesn't steal a plain key from
              everything else on your PC.
            </p>
            <div className="multibox-client-list">
              {clients.map((client) => {
                const label = client.character_name ?? "Character Select";
                const hidden = settings?.force_hidden[label] ?? false;
                return (
                  <div key={client.hwnd} className="multibox-client-row">
                    <span className={`multibox-client-dot${client.character_name ? " multibox-client-dot-active" : ""}`} />
                    <span className="multibox-client-name">{label}</span>
                    {client.character_name && (
                      <HotkeyRecorder combo={settings?.hotkeys[label]} onChange={(combo) => setHotkey(label, combo)} />
                    )}
                    <label className="multibox-client-hide-toggle">
                      <input type="checkbox" checked={hidden} onChange={(e) => toggleClientHidden(label, e.target.checked)} />
                      Hide preview
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default MultiboxPage;
