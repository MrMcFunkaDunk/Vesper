import { invoke } from "@tauri-apps/api/core";

export interface MultiboxClient {
  hwnd: number;
  /** null at the character-select screen; the character's name once logged in. */
  character_name: string | null;
}

export interface ClientLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MultiboxSettings {
  always_on_top: boolean;
  /** 0-255, matching DWM's own opacity range. */
  opacity: number;
  default_width: number;
  default_height: number;
  locked: boolean;
  hide_active_preview: boolean;
  minimize_inactive_clients: boolean;
  highlight_active: boolean;
  highlight_color: [number, number, number];
  show_frames: boolean;
  frame_color: [number, number, number];
  show_overlay: boolean;
  label_size: number;
  label_color: [number, number, number];
  label_at_bottom: boolean;
  remember_positions: boolean;
  unique_layout_per_client: boolean;
  snap_to_grid: boolean;
  snap_grid_x: number;
  snap_grid_y: number;
  zoom_on_hover: boolean;
  zoom_factor: number;
  /** 0-8, a 3x3 grid index (0=top-left, 4=center, 8=bottom-right). */
  zoom_anchor: number;
  force_hidden: Record<string, boolean>;
  layouts: Record<string, ClientLayout>;
  /** Character name -> global hotkey combo (e.g. "Ctrl+Alt+F1") that
   * brings that client's window to the foreground from anywhere. */
  hotkeys: Record<string, string>;
}

/** Every currently running EVE client - works whether or not the floating
 * preview overlay is open, so the tab can show a live count/list either way. */
export function getMultiboxClients(): Promise<MultiboxClient[]> {
  return invoke("get_multibox_clients");
}

export function isMultiboxOverlayOpen(): Promise<boolean> {
  return invoke("is_multibox_overlay_open");
}

/** Opens the floating thumbnail-preview windows - one independent,
 * borderless window per detected client, not part of VESPER's own UI, so
 * they keep floating on the desktop regardless of which VESPER tab is
 * active or whether VESPER is minimized. */
export function openMultiboxOverlay(): Promise<void> {
  return invoke("open_multibox_overlay");
}

export function closeMultiboxOverlay(): Promise<void> {
  return invoke("close_multibox_overlay");
}

export function getMultiboxSettings(): Promise<MultiboxSettings> {
  return invoke("get_multibox_settings");
}

/** Persists settings and, if the overlay is currently open, applies them to
 * every running preview within about a second (its own refresh tick picks
 * up the change) - no need to close and reopen the overlay for a setting
 * to take effect. */
export function setMultiboxSettings(settings: MultiboxSettings): Promise<void> {
  return invoke("set_multibox_settings", { settings });
}

export interface MultiboxProfile {
  name: string;
  settings: MultiboxSettings;
}

/** Named presets of the whole settings struct - e.g. a "PvP" layout vs a
 * "Mining" layout, swappable in one click. */
export function listMultiboxProfiles(): Promise<MultiboxProfile[]> {
  return invoke("list_multibox_profiles");
}

/** Saves the given settings under a name, overwriting any existing profile
 * with the same name rather than creating a duplicate. */
export function saveMultiboxProfile(name: string, settings: MultiboxSettings): Promise<void> {
  return invoke("save_multibox_profile", { name, settings });
}

export function deleteMultiboxProfile(name: string): Promise<void> {
  return invoke("delete_multibox_profile", { name });
}
