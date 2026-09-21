// Live thumbnail previews of every running EVE client, with click-to-focus -
// VESPER's own take on what EVE-O Preview does, built fresh against the
// Windows APIs directly (DWM's thumbnail composition, the same mechanism
// behind Alt-Tab/taskbar previews) rather than porting anything. Stays
// strictly view-only: no keyboard/mouse relay, no interaction with the EVE
// client beyond bringing it to the foreground/minimizing/restoring it -
// the same boundary CCP has publicly confirmed is EULA/ToS-safe for this
// class of tool.
//
// Each detected client gets its OWN independent, borderless floating
// window (not one shared container) - draggable and resizable on its own,
// matching how EVE-O Preview's thumbnails behave. These are plain native
// windows (no WebView2 involved) because DWM thumbnails are composited by
// the OS directly onto a destination window's client area, not something
// paintable into an HTML <canvas>. A single hidden "controller" window
// drives periodic re-scanning (creating a preview window for every newly
// seen client, destroying one for every client that's gone, tracking which
// one currently has focus) and owns the one Win32 message loop, on a
// dedicated thread independent of Tauri's own window(s) - so the whole
// thing keeps floating on the desktop regardless of which VESPER tab is
// active or whether VESPER is minimized.
//
// The Windows implementation (DWM/GDI/Win32) lives in `multibox_windows`.
// Linux and macOS have no equivalent to DWM thumbnail composition, so
// `multibox_linux`/`multibox_macos` take a different shape entirely: each
// just supplies enumerate/capture/focus primitives to the shared driver in
// `multibox_overlay_driver`, which opens an ordinary Tauri webview window
// per client and pushes it a periodic screenshot instead of a live
// composited thumbnail. Any other platform gets the stub functions at the
// bottom of this file.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[cfg(windows)]
mod multibox_windows;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod multibox_overlay_driver;
#[cfg(target_os = "linux")]
mod multibox_linux;
#[cfg(target_os = "macos")]
mod multibox_macos;

#[derive(Serialize, Clone)]
pub struct MultiboxClient {
    pub hwnd: isize,
    /// None at the character-select screen (window title is just "EVE"),
    /// Some(name) once logged into a character (title is "EVE - Name").
    pub character_name: Option<String>,
}

/// Remembered per-client window geometry - x/y only get read back when
/// `remember_positions` is on, width/height only when
/// `unique_layout_per_client` is on, but both always get written so
/// flipping a toggle back on later picks up whatever was last set.
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
pub struct ClientLayout {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MultiboxSettings {
    pub always_on_top: bool,
    /// 0-255, matching DWM's own opacity range.
    pub opacity: u8,
    pub default_width: i32,
    pub default_height: i32,
    /// Disables both dragging and edge-resizing on every preview at once -
    /// a single global switch rather than per-window, so a layout you're
    /// happy with can't be nudged out of place by an accidental drag.
    pub locked: bool,
    /// Hides whichever preview corresponds to the EVE client that
    /// currently has OS focus - you're already looking at that one.
    pub hide_active_preview: bool,
    /// Minimizes every EVE client except whichever one currently has
    /// focus - the same real-window-management action the click-to-focus
    /// handler already performs in reverse (restoring on click).
    pub minimize_inactive_clients: bool,
    pub highlight_active: bool,
    pub highlight_color: (u8, u8, u8),
    /// Draws a border on every preview, not just the active one.
    pub show_frames: bool,
    pub frame_color: (u8, u8, u8),
    /// Master switch for all overlay chrome (label, frame, highlight) -
    /// off means just the bare thumbnails, filling the whole window.
    pub show_overlay: bool,
    pub label_size: i32,
    pub label_color: (u8, u8, u8),
    pub label_at_bottom: bool,
    /// Reopen each client's preview at its remembered position rather than
    /// a fresh cascade spot every time.
    pub remember_positions: bool,
    /// Reopen each client's preview at its own remembered size rather than
    /// the shared default_width/default_height.
    pub unique_layout_per_client: bool,
    pub snap_to_grid: bool,
    pub snap_grid_x: i32,
    pub snap_grid_y: i32,
    pub zoom_on_hover: bool,
    pub zoom_factor: f32,
    /// 0-8, a 3x3 grid index (0=top-left, 4=center, 8=bottom-right) - which
    /// point of the thumbnail stays fixed while it grows on hover.
    pub zoom_anchor: u8,
    /// Character name -> force-hidden, set from the Active Clients list -
    /// independent of hide_active_preview, for clients you just don't want
    /// a preview of at all (e.g. an alt parked on autopilot).
    pub force_hidden: HashMap<String, bool>,
    /// Character name -> remembered geometry. Unnamed (character-select)
    /// windows aren't persisted here - there's no stable identity for them
    /// across launches.
    pub layouts: HashMap<String, ClientLayout>,
    /// Character name -> global hotkey combo (e.g. "Ctrl+Alt+F1") that
    /// brings that client's window to the foreground from anywhere, even
    /// while a different client has focus. `#[serde(default)]` so an
    /// existing settings file saved before this field existed still loads
    /// instead of silently resetting every other multibox setting.
    #[serde(default)]
    pub hotkeys: HashMap<String, String>,
}

impl Default for MultiboxSettings {
    fn default() -> Self {
        MultiboxSettings {
            always_on_top: true,
            opacity: 255,
            default_width: 385,
            default_height: 220,
            locked: false,
            hide_active_preview: false,
            minimize_inactive_clients: false,
            highlight_active: true,
            highlight_color: (0x9A, 0xE6, 0x3C),
            show_frames: false,
            frame_color: (0x6F, 0xC3, 0xD9),
            show_overlay: true,
            label_size: 16,
            label_color: (0x6F, 0xC3, 0xD9),
            label_at_bottom: false,
            remember_positions: true,
            unique_layout_per_client: false,
            snap_to_grid: false,
            snap_grid_x: 50,
            snap_grid_y: 50,
            zoom_on_hover: false,
            zoom_factor: 1.6,
            zoom_anchor: 4,
            force_hidden: HashMap::new(),
            layouts: HashMap::new(),
            hotkeys: HashMap::new(),
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = tauri::Manager::path(app).app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("multibox_settings.json"))
}

pub fn load_settings(app: &tauri::AppHandle) -> MultiboxSettings {
    let Ok(path) = settings_path(app) else { return MultiboxSettings::default() };
    let Ok(contents) = std::fs::read_to_string(&path) else { return MultiboxSettings::default() };
    serde_json::from_str(&contents).unwrap_or_default()
}

/// Same atomic temp-file + rename pattern characters.rs uses, for the same
/// reason: never let a reader observe a half-written file.
fn save_settings(app: &tauri::AppHandle, settings: &MultiboxSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let contents = serde_json::to_string_pretty(settings).map_err(|e| format!("could not serialize multibox settings: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(|e| format!("could not write multibox settings: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("could not save multibox settings: {e}"))
}

/// Whichever platform's overlay is currently running (if any) registers its
/// live settings handle here - shared across all three implementations so
/// `update_settings` doesn't need its own per-platform branch.
static LIVE_SETTINGS: std::sync::OnceLock<std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<MultiboxSettings>>>>> = std::sync::OnceLock::new();

pub(crate) fn live_settings_cell() -> &'static std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<MultiboxSettings>>>> {
    LIVE_SETTINGS.get_or_init(|| std::sync::Mutex::new(None))
}

/// Persists the settings, and if the overlay is currently running, pushes
/// them into its live shared context too - the controller's own refresh
/// tick (at most a second later) then applies anything that needs re-doing
/// on existing windows/previews (opacity, topmost, hidden state, highlight
/// color).
pub fn update_settings(app: &tauri::AppHandle, settings: MultiboxSettings) -> Result<(), String> {
    save_settings(app, &settings)?;
    if let Some(shared) = live_settings_cell().lock().unwrap().as_ref() {
        *shared.lock().unwrap() = settings;
    }
    Ok(())
}

/// Persists one client's remembered position/size, keyed by character name -
/// shared by the Linux/macOS overlay drivers on window move/resize (Windows
/// does the equivalent inline in its own WM_LBUTTONUP handler instead, since
/// it already holds the settings lock there for other reasons).
pub(crate) fn save_client_layout(app: &tauri::AppHandle, name: String, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    let mut settings = load_settings(app);
    let entry = settings.layouts.entry(name).or_default();
    entry.x = x;
    entry.y = y;
    entry.width = width;
    entry.height = height;
    update_settings(app, settings)
}

/// A whole named snapshot of `MultiboxSettings` - lets a user swap between
/// e.g. a "PvP" layout and a "Mining" layout in one click instead of
/// re-configuring every toggle by hand each time.
#[derive(Serialize, Deserialize, Clone)]
pub struct MultiboxProfile {
    pub name: String,
    pub settings: MultiboxSettings,
}

fn profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = tauri::Manager::path(app).app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("multibox_profiles.json"))
}

pub fn list_profiles(app: &tauri::AppHandle) -> Vec<MultiboxProfile> {
    let Ok(path) = profiles_path(app) else { return Vec::new() };
    let Ok(contents) = std::fs::read_to_string(&path) else { return Vec::new() };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn write_profiles(app: &tauri::AppHandle, profiles: &[MultiboxProfile]) -> Result<(), String> {
    let path = profiles_path(app)?;
    let contents = serde_json::to_string_pretty(profiles).map_err(|e| format!("could not serialize multibox profiles: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(|e| format!("could not write multibox profiles: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("could not save multibox profiles: {e}"))
}

/// Saves the given settings as a named profile, overwriting any existing
/// profile with the same name rather than creating a duplicate.
pub fn save_profile(app: &tauri::AppHandle, name: String, settings: MultiboxSettings) -> Result<(), String> {
    let mut profiles = list_profiles(app);
    match profiles.iter_mut().find(|p| p.name == name) {
        Some(existing) => existing.settings = settings,
        None => profiles.push(MultiboxProfile { name, settings }),
    }
    write_profiles(app, &profiles)
}

pub fn delete_profile(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    let mut profiles = list_profiles(app);
    profiles.retain(|p| p.name != name);
    write_profiles(app, &profiles)
}

#[cfg(windows)]
pub(crate) use multibox_windows::{close_overlay, enumerate_eve_clients, is_overlay_open, open_overlay};
#[cfg(target_os = "linux")]
pub(crate) use multibox_linux::{close_overlay, enumerate_eve_clients, is_overlay_open, open_overlay};
#[cfg(target_os = "macos")]
pub(crate) use multibox_macos::{close_overlay, enumerate_eve_clients, is_overlay_open, open_overlay};

/// Best-effort focus request from a preview window's click handler - a
/// no-op stub on Windows, which instead handles this as a direct window
/// message inside multibox_windows.rs's own click handler.
#[cfg(target_os = "linux")]
pub(crate) use multibox_linux::focus_client;
#[cfg(target_os = "macos")]
pub(crate) use multibox_macos::focus_client;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn focus_client(_id: &str) -> Result<(), String> {
    Ok(())
}

/// No running EVE clients can be detected on a platform with neither a DWM
/// equivalent nor the Linux/macOS screenshot-based overlay wired up.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn enumerate_eve_clients() -> Vec<MultiboxClient> {
    Vec::new()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn is_overlay_open() -> bool {
    false
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn open_overlay(_app: tauri::AppHandle, _settings: MultiboxSettings) {}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn close_overlay() {}
