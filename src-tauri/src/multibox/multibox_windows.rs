// The actual Win32/DWM/GDI implementation behind multibox.rs's public
// surface - split into its own file so the cross-platform settings/profile
// persistence in the parent module can compile everywhere, while this file
// (and the `windows` crate it depends on) only ever gets built on Windows.

use super::{save_settings, MultiboxClient, MultiboxSettings};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties, DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION,
    DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE, DWM_THUMBNAIL_PROPERTIES,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, Ellipse, EndPaint, FillRect,
    GetStockObject, GetTextExtentPoint32W, InvalidateRect, Rectangle, SelectObject, SetBkMode, SetTextColor,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DEFAULT_QUALITY, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
    FF_DONTCARE, FW_NORMAL, NULL_BRUSH, NULL_PEN, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::System::ProcessStatus::K32GetModuleBaseNameW;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, ReleaseCapture, SetCapture, TrackMouseEvent, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL,
    MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, TME_LEAVE, TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetClientRect, GetCursorPos,
    GetForegroundWindow, GetMessageW, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassExW, SetForegroundWindow, SetTimer,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HTBOTTOM,
    HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCLIENT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT, HWND_NOTOPMOST, HWND_TOP,
    HWND_TOPMOST, IDC_ARROW, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MINIMIZE, SW_RESTORE,
    SW_SHOW, WM_DESTROY, WM_HOTKEY, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCHITTEST, WM_PAINT, WM_SIZE,
    WM_CLOSE, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

/// The EVE client's executable is literally named exefile.exe - a
/// long-documented quirk of the game, not anything proprietary - and the
/// standard way every multiboxing tool in the community identifies a
/// running client.
const EVE_PROCESS_NAME: &str = "exefile.exe";
const REFRESH_TIMER_ID: usize = 1;
const REFRESH_INTERVAL_MS: u32 = 1000;
/// Drives the active-client indicator dot's pulse - much faster than the
/// client-rescan timer, but only ever triggers a repaint (and only of the
/// small dot area) while a preview is actually the active one.
const PULSE_TIMER_ID: usize = 2;
const PULSE_INTERVAL_MS: u32 = 60;
const CONTROLLER_CLASS_NAME: &str = "VesperMultiboxController";
const PREVIEW_CLASS_NAME: &str = "VesperMultiboxPreview";
const LABEL_HEIGHT: i32 = 24;
const RESIZE_MARGIN: i32 = 6;
const DRAG_THRESHOLD: i32 = 4;
const HIGHLIGHT_THICKNESS: i32 = 3;
const FRAME_THICKNESS: i32 = 2;
const LABEL_BG_COLOR: (u8, u8, u8) = (0x20, 0x18, 0x12);
const ACTIVE_DOT_DIAMETER: i32 = 8;
const ACTIVE_DOT_GAP: i32 = 6;
/// New/never-seen-before clients cascade from this corner instead of all
/// stacking on top of one another.
const DEFAULT_ORIGIN: (i32, i32) = (60, 60);
const CASCADE_STEP: i32 = 32;

/// Parses a combo string like "Ctrl+Alt+F1" into the modifier flags and
/// virtual-key code `RegisterHotKey` needs. A combo without at least one
/// modifier is rejected - a bare, unmodified key registered as a truly
/// global hotkey would steal that key from every other application on the
/// system, including normal typing.
fn parse_hotkey(combo: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let (modifier_parts, key_part) = parts.split_at(parts.len() - 1);
    let mut modifiers = HOT_KEY_MODIFIERS(0);
    for part in modifier_parts {
        modifiers |= match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => MOD_CONTROL,
            "alt" => MOD_ALT,
            "shift" => MOD_SHIFT,
            "win" | "meta" => MOD_WIN,
            _ => return None,
        };
    }
    let vk = vk_for_key(key_part[0])?;
    Some((modifiers, vk))
}

/// Virtual-key codes for '0'-'9' and 'A'-'Z' are their own ASCII values -
/// documented Win32 behavior, not a coincidence - so a single letter/digit
/// key needs no lookup table at all; only the function-key row does.
fn vk_for_key(key: &str) -> Option<u32> {
    let upper = key.to_ascii_uppercase();
    if upper.len() == 1 {
        let c = upper.chars().next().unwrap();
        if c.is_ascii_digit() || c.is_ascii_uppercase() {
            return Some(c as u32);
        }
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x6F + n); // VK_F1 == 0x70
            }
        }
    }
    None
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn process_image_name(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid) }.ok()?;
    let mut buf = [0u16; 260];
    let len = unsafe { K32GetModuleBaseNameW(handle, None, &mut buf) };
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
    if len == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let clients = &mut *(lparam.0 as *mut Vec<MultiboxClient>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return true.into();
    }
    let Some(image_name) = process_image_name(pid) else { return true.into() };
    if !image_name.eq_ignore_ascii_case(EVE_PROCESS_NAME) {
        return true.into();
    }
    let title = window_title(hwnd);
    if title.is_empty() {
        return true.into();
    }
    let character_name = title.strip_prefix("EVE - ").map(|s| s.to_string());
    clients.push(MultiboxClient { hwnd: hwnd.0 as isize, character_name });
    true.into()
}

/// Every currently running EVE client window, in no particular order - used
/// both by the Multiboxing tab (to show a live count/list without opening
/// the overlay) and internally by the controller's own refresh timer.
pub(crate) fn enumerate_eve_clients() -> Vec<MultiboxClient> {
    let mut clients: Vec<MultiboxClient> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_windows_callback), LPARAM(&mut clients as *mut _ as isize));
    }
    clients
}

fn label_for(client: &MultiboxClient) -> String {
    client.character_name.clone().unwrap_or_else(|| "Character Select".to_string())
}

fn rgb(color: (u8, u8, u8)) -> COLORREF {
    let (r, g, b) = color;
    COLORREF((r as u32) | (g as u32) << 8 | (b as u32) << 16)
}

/// Matches the exact pulse already used for the "connected"/server-online
/// status dot elsewhere in VESPER (App.css's status-pulse keyframe: opacity
/// 1.0 down to 0.35 and back, 2.4s ease-in-out) rather than inventing a
/// different curve - a sine wave is a close approximation of ease-in-out,
/// and this is the same technique (compositing a color at reduced alpha
/// against the background) expressed for GDI instead of CSS opacity.
fn pulse_intensity() -> f32 {
    const PERIOD_MS: f32 = 2400.0;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as f32;
    let wave = 0.5 + 0.5 * (now * std::f32::consts::TAU / PERIOD_MS).sin();
    0.35 + 0.65 * wave
}

fn lerp_color(from: (u8, u8, u8), to: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    let t = t.clamp(0.0, 1.0);
    let lerp_channel = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
    (lerp_channel(from.0, to.0), lerp_channel(from.1, to.1), lerp_channel(from.2, to.2))
}

/// Which corner/edge/center of `original` stays fixed while it grows to
/// `new_w` x `new_h` - anchor is a 3x3 grid index (0=top-left ...
/// 8=bottom-right, 4=center).
fn anchored_rect(original: RECT, new_w: i32, new_h: i32, anchor: u8) -> RECT {
    let cx = (original.left + original.right) / 2;
    let cy = (original.top + original.bottom) / 2;
    let (left, top) = match anchor {
        0 => (original.left, original.top),
        1 => (cx - new_w / 2, original.top),
        2 => (original.right - new_w, original.top),
        3 => (original.left, cy - new_h / 2),
        5 => (original.right - new_w, cy - new_h / 2),
        6 => (original.left, original.bottom - new_h),
        7 => (cx - new_w / 2, original.bottom - new_h),
        8 => (original.right - new_w, original.bottom - new_h),
        _ => (cx - new_w / 2, cy - new_h / 2), // 4, center, and any out-of-range value
    };
    RECT { left, top, right: left + new_w, bottom: top + new_h }
}

pub(crate) struct SharedContext {
    app: tauri::AppHandle,
    pub(crate) settings: Arc<Mutex<MultiboxSettings>>,
}

struct PreviewState {
    ctx: Arc<SharedContext>,
    client_hwnd: isize,
    label: String,
    thumbnail: Option<isize>,
    drag: Option<DragState>,
    is_active: bool,
    hovering: bool,
    /// The window's real rect, saved right before a hover-zoom temporarily
    /// resizes it - restored on mouse-leave.
    pre_zoom_rect: Option<RECT>,
}

struct DragState {
    start_cursor: POINT,
    start_window: POINT,
    moved: bool,
}

struct ControllerState {
    ctx: Arc<SharedContext>,
    /// EVE client hwnd -> that client's preview window hwnd.
    previews: HashMap<isize, isize>,
    /// Character name -> the id its hotkey is currently registered under.
    hotkey_ids: HashMap<String, i32>,
    next_hotkey_id: i32,
    /// The settings.hotkeys this was last synced against - lets the
    /// per-tick sync skip straight past the common case (nothing changed)
    /// with one HashMap comparison instead of touching the OS every second.
    synced_hotkeys: HashMap<String, String>,
}

/// Registers/unregisters global hotkeys so the OS-level set matches
/// `settings.hotkeys` - called every refresh tick, but a no-op unless a
/// hotkey was actually added, removed, or reassigned since the last tick.
fn sync_hotkeys(controller_hwnd: HWND, state: &mut ControllerState, settings: &MultiboxSettings) {
    if state.synced_hotkeys == settings.hotkeys {
        return;
    }
    for (name, old_combo) in state.synced_hotkeys.clone() {
        let unchanged = settings.hotkeys.get(&name).is_some_and(|c| *c == old_combo);
        if !unchanged {
            if let Some(id) = state.hotkey_ids.remove(&name) {
                unsafe {
                    let _ = UnregisterHotKey(Some(controller_hwnd), id);
                }
            }
        }
    }
    for (name, combo) in &settings.hotkeys {
        if state.hotkey_ids.contains_key(name) {
            continue;
        }
        let Some((modifiers, vk)) = parse_hotkey(combo) else { continue };
        let id = state.next_hotkey_id;
        state.next_hotkey_id += 1;
        let registered = unsafe { RegisterHotKey(Some(controller_hwnd), id, modifiers | MOD_NOREPEAT, vk).is_ok() };
        if registered {
            state.hotkey_ids.insert(name.clone(), id);
        }
    }
    state.synced_hotkeys = settings.hotkeys.clone();
}

fn preview_state_ptr(hwnd: HWND) -> *mut PreviewState {
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PreviewState }
}

fn controller_state_ptr(hwnd: HWND) -> *mut ControllerState {
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ControllerState }
}

/// Registers (or re-registers) this window's DWM thumbnail and positions it
/// to fill whatever's left after the label strip and any frame/highlight
/// border - called on creation and on every resize.
unsafe fn relayout_preview(hwnd: HWND) {
    let state_ref = preview_state_ptr(hwnd);
    if state_ref.is_null() {
        return;
    }
    let state = &mut *state_ref;
    if state.thumbnail.is_none() {
        if let Ok(thumb) = DwmRegisterThumbnail(hwnd, HWND(state.client_hwnd as *mut _)) {
            state.thumbnail = Some(thumb);
        }
    }
    let Some(thumb) = state.thumbnail else { return };

    let mut client_rect = RECT::default();
    let _ = GetClientRect(hwnd, &mut client_rect);
    let settings = state.ctx.settings.lock().unwrap();
    let opacity = settings.opacity;
    let border = if settings.show_overlay && (settings.show_frames || settings.highlight_active) { HIGHLIGHT_THICKNESS } else { 0 };
    let label_space = if settings.show_overlay { LABEL_HEIGHT } else { 0 };
    let label_at_bottom = settings.label_at_bottom;
    drop(settings);

    let dest = RECT {
        left: client_rect.left + border,
        top: client_rect.top + border + if label_at_bottom { 0 } else { label_space },
        right: client_rect.right - border,
        bottom: client_rect.bottom - border - if label_at_bottom { label_space } else { 0 },
    };

    let mut props = DWM_THUMBNAIL_PROPERTIES::default();
    props.dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY;
    props.rcDestination = dest;
    props.fVisible = true.into();
    props.opacity = opacity;
    props.fSourceClientAreaOnly = true.into();
    let _ = DwmUpdateThumbnailProperties(thumb, &props);
}

unsafe fn paint_preview(hwnd: HWND, state: &PreviewState) {
    let settings = state.ctx.settings.lock().unwrap().clone();
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut client_rect = RECT::default();
    let _ = GetClientRect(hwnd, &mut client_rect);

    if !settings.show_overlay {
        let _ = EndPaint(hwnd, &ps);
        return;
    }

    let label_rect = if settings.label_at_bottom {
        RECT { left: client_rect.left, top: client_rect.bottom - LABEL_HEIGHT, right: client_rect.right, bottom: client_rect.bottom }
    } else {
        RECT { left: client_rect.left, top: client_rect.top, right: client_rect.right, bottom: client_rect.top + LABEL_HEIGHT }
    };
    let label_brush = CreateSolidBrush(COLORREF(0x00201812));
    FillRect(hdc, &label_rect, label_brush);
    let _ = DeleteObject(label_brush.into());

    let font = CreateFontW(
        settings.label_size,
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        DEFAULT_QUALITY,
        (DEFAULT_PITCH.0 as u32) | (FF_DONTCARE.0 as u32),
        PCWSTR::null(),
    );
    let old_font = SelectObject(hdc, font.into());
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, rgb(settings.label_color));
    let mut text = to_wide(&state.label);

    // The active-client dot pulses just to the left of the (still
    // centered) name text - measure the rendered text width first so the
    // dot can sit right up against it regardless of how long the name is,
    // rather than shifting the text itself off-center to make room.
    let show_dot = state.is_active && settings.highlight_active;
    if show_dot {
        let mut size = SIZE::default();
        let _ = GetTextExtentPoint32W(hdc, &text, &mut size);
        let text_left = label_rect.left + (label_rect.right - label_rect.left - size.cx) / 2;
        let dot_left = (text_left - ACTIVE_DOT_GAP - ACTIVE_DOT_DIAMETER).max(label_rect.left + 4);
        let dot_top = (label_rect.top + label_rect.bottom) / 2 - ACTIVE_DOT_DIAMETER / 2;

        let pulsed = lerp_color(LABEL_BG_COLOR, settings.highlight_color, pulse_intensity());
        let dot_brush = CreateSolidBrush(rgb(pulsed));
        let old_brush = SelectObject(hdc, dot_brush.into());
        let old_pen = SelectObject(hdc, GetStockObject(NULL_PEN));
        let _ = Ellipse(hdc, dot_left, dot_top, dot_left + ACTIVE_DOT_DIAMETER, dot_top + ACTIVE_DOT_DIAMETER);
        SelectObject(hdc, old_brush);
        SelectObject(hdc, old_pen);
        let _ = DeleteObject(dot_brush.into());
    }

    let mut text_rect = label_rect;
    DrawTextW(hdc, &mut text, &mut text_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old_font);
    let _ = DeleteObject(font.into());

    let border_color = if state.is_active && settings.highlight_active {
        Some(settings.highlight_color)
    } else if settings.show_frames {
        Some(settings.frame_color)
    } else {
        None
    };
    if let Some(color) = border_color {
        let thickness = if state.is_active && settings.highlight_active { HIGHLIGHT_THICKNESS } else { FRAME_THICKNESS };
        let pen = CreatePen(PS_SOLID, thickness, rgb(color));
        let old_pen = SelectObject(hdc, pen.into());
        let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
        let _ = Rectangle(hdc, client_rect.left, client_rect.top, client_rect.right, client_rect.bottom);
        SelectObject(hdc, old_pen);
        SelectObject(hdc, old_brush);
        let _ = DeleteObject(pen.into());
    }

    let _ = EndPaint(hwnd, &ps);
}

/// Distinguishes a click (bring the client to the foreground) from a drag
/// (just reposition this preview, persisted per character name) - the same
/// one-and-only interaction this ever performs on another window: no
/// keyboard/mouse events are ever synthesized or relayed into a client.
unsafe extern "system" fn preview_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            let state_ref = preview_state_ptr(hwnd);
            let locked = if state_ref.is_null() { false } else { (&*state_ref).ctx.settings.lock().unwrap().locked };
            if locked {
                return LRESULT(HTCLIENT as isize);
            }
            let mut client_rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut client_rect);
            let mut window_rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut window_rect);
            let x = (lparam.0 & 0xFFFF) as i16 as i32 - window_rect.left;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32 - window_rect.top;
            let w = client_rect.right - client_rect.left;
            let h = client_rect.bottom - client_rect.top;
            let left = x < RESIZE_MARGIN;
            let right = x >= w - RESIZE_MARGIN;
            let top = y < RESIZE_MARGIN;
            let bottom = y >= h - RESIZE_MARGIN;
            let hit = if top && left {
                HTTOPLEFT
            } else if top && right {
                HTTOPRIGHT
            } else if bottom && left {
                HTBOTTOMLEFT
            } else if bottom && right {
                HTBOTTOMRIGHT
            } else if left {
                HTLEFT
            } else if right {
                HTRIGHT
            } else if top {
                HTTOP
            } else if bottom {
                HTBOTTOM
            } else {
                HTCLIENT
            };
            LRESULT(hit as isize)
        }
        WM_PAINT => {
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                paint_preview(hwnd, &*state_ref);
            }
            LRESULT(0)
        }
        WM_SIZE => {
            relayout_preview(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == PULSE_TIMER_ID {
                let state_ref = preview_state_ptr(hwnd);
                if !state_ref.is_null() {
                    let state = &*state_ref;
                    let settings = state.ctx.settings.lock().unwrap();
                    let pulsing = state.is_active && settings.highlight_active && settings.show_overlay;
                    drop(settings);
                    if pulsing {
                        let label_at_bottom = state.ctx.settings.lock().unwrap().label_at_bottom;
                        let mut client_rect = RECT::default();
                        let _ = GetClientRect(hwnd, &mut client_rect);
                        // Only the label strip actually changes each tick -
                        // invalidating just that (not the whole window,
                        // which would also re-trigger the thumbnail area)
                        // keeps this cheap enough to run at 60ms.
                        let label_rect = if label_at_bottom {
                            RECT { left: client_rect.left, top: client_rect.bottom - LABEL_HEIGHT, right: client_rect.right, bottom: client_rect.bottom }
                        } else {
                            RECT { left: client_rect.left, top: client_rect.top, right: client_rect.right, bottom: client_rect.top + LABEL_HEIGHT }
                        };
                        let _ = InvalidateRect(Some(hwnd), Some(&label_rect), false);
                    }
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &mut *state_ref;
                let locked = state.ctx.settings.lock().unwrap().locked;
                if !locked {
                    // If a hover-zoom is currently active, collapse it back
                    // to the window's real geometry first - otherwise the
                    // drag that's about to start would operate on the
                    // temporarily enlarged rect, and the eventual
                    // mouse-leave (once the drag ends and the cursor moves
                    // away) would restore the *original pre-hover* rect,
                    // silently undoing whatever was just dragged.
                    if let Some(original) = state.pre_zoom_rect.take() {
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            original.left,
                            original.top,
                            original.right - original.left,
                            original.bottom - original.top,
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    let mut cursor = POINT::default();
                    let _ = GetCursorPos(&mut cursor);
                    let mut window_rect = RECT::default();
                    let _ = GetWindowRect(hwnd, &mut window_rect);
                    state.drag = Some(DragState {
                        start_cursor: cursor,
                        start_window: POINT { x: window_rect.left, y: window_rect.top },
                        moved: false,
                    });
                    SetCapture(hwnd);
                }
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &mut *state_ref;
                if let Some(drag) = state.drag.as_mut() {
                    let mut cursor = POINT::default();
                    let _ = GetCursorPos(&mut cursor);
                    let dx = cursor.x - drag.start_cursor.x;
                    let dy = cursor.y - drag.start_cursor.y;
                    if dx.abs() > DRAG_THRESHOLD || dy.abs() > DRAG_THRESHOLD {
                        drag.moved = true;
                    }
                    if drag.moved {
                        let settings = state.ctx.settings.lock().unwrap();
                        let (snap, snap_x, snap_y) = (settings.snap_to_grid, settings.snap_grid_x.max(1), settings.snap_grid_y.max(1));
                        drop(settings);
                        let mut new_x = drag.start_window.x + dx;
                        let mut new_y = drag.start_window.y + dy;
                        if snap {
                            new_x = (new_x as f32 / snap_x as f32).round() as i32 * snap_x;
                            new_y = (new_y as f32 / snap_y as f32).round() as i32 * snap_y;
                        }
                        let _ = SetWindowPos(hwnd, None, new_x, new_y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    }
                } else {
                    // Not dragging - first move after entering starts hover
                    // tracking (Windows doesn't send a "just entered" event
                    // on its own) so a later WM_MOUSELEAVE actually fires.
                    if !state.hovering {
                        state.hovering = true;
                        let mut tme = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                        let _ = TrackMouseEvent(&mut tme);

                        let settings = state.ctx.settings.lock().unwrap();
                        if settings.zoom_on_hover && !settings.locked {
                            let factor = settings.zoom_factor.max(1.0);
                            let anchor = settings.zoom_anchor;
                            drop(settings);
                            let mut window_rect = RECT::default();
                            let _ = GetWindowRect(hwnd, &mut window_rect);
                            state.pre_zoom_rect = Some(window_rect);
                            let w = window_rect.right - window_rect.left;
                            let h = window_rect.bottom - window_rect.top;
                            let zoomed = anchored_rect(window_rect, (w as f32 * factor) as i32, (h as f32 * factor) as i32, anchor);
                            let _ = SetWindowPos(
                                hwnd,
                                Some(HWND_TOP),
                                zoomed.left,
                                zoomed.top,
                                zoomed.right - zoomed.left,
                                zoomed.bottom - zoomed.top,
                                SWP_NOACTIVATE,
                            );
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &mut *state_ref;
                state.hovering = false;
                if let Some(original) = state.pre_zoom_rect.take() {
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        original.left,
                        original.top,
                        original.right - original.left,
                        original.bottom - original.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let _ = ReleaseCapture();
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &mut *state_ref;
                if let Some(drag) = state.drag.take() {
                    if drag.moved {
                        let mut window_rect = RECT::default();
                        let _ = GetWindowRect(hwnd, &mut window_rect);
                        let mut settings = state.ctx.settings.lock().unwrap();
                        let entry = settings.layouts.entry(state.label.clone()).or_default();
                        entry.x = window_rect.left;
                        entry.y = window_rect.top;
                        let _ = save_settings(&state.ctx.app, &settings);
                    } else {
                        let target = HWND(state.client_hwnd as *mut _);
                        let _ = ShowWindow(target, SW_RESTORE);
                        let _ = SetForegroundWindow(target);
                    }
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            let state_ref = preview_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = Box::from_raw(state_ref);
                if let Some(thumb) = state.thumbnail {
                    let _ = DwmUnregisterThumbnail(thumb);
                }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn create_preview_window(
    ctx: Arc<SharedContext>,
    class_name: &[u16],
    instance: windows::Win32::Foundation::HMODULE,
    client: &MultiboxClient,
) -> Option<HWND> {
    let label = label_for(client);
    let ((x, y), (width, height), always_on_top) = {
        let settings = ctx.settings.lock().unwrap();
        let remembered = settings.layouts.get(&label).copied();
        let pos = if settings.remember_positions {
            remembered.filter(|l| l.x != 0 || l.y != 0).map(|l| (l.x, l.y))
        } else {
            None
        }
        .unwrap_or_else(|| {
            let n = settings.layouts.len() as i32 % 8;
            (DEFAULT_ORIGIN.0 + n * CASCADE_STEP, DEFAULT_ORIGIN.1 + n * CASCADE_STEP)
        });
        let size = if settings.unique_layout_per_client {
            remembered.filter(|l| l.width > 0 && l.height > 0).map(|l| (l.width, l.height))
        } else {
            None
        }
        .unwrap_or((settings.default_width, settings.default_height));
        (pos, size, settings.always_on_top)
    };
    let ex_style = (if always_on_top { WS_EX_TOPMOST } else { Default::default() }) | WS_EX_TOOLWINDOW;
    let title = to_wide(&label);
    let hwnd = CreateWindowExW(
        ex_style,
        PCWSTR(class_name.as_ptr()),
        PCWSTR(title.as_ptr()),
        WS_POPUP | WS_VISIBLE,
        x,
        y,
        width,
        height,
        None,
        None,
        Some(instance.into()),
        None,
    )
    .ok()?;

    let state = Box::new(PreviewState {
        ctx,
        client_hwnd: client.hwnd,
        label,
        thumbnail: None,
        drag: None,
        is_active: false,
        hovering: false,
        pre_zoom_rect: None,
    });
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);
    let _ = ShowWindow(hwnd, SW_SHOW);
    relayout_preview(hwnd);
    let _ = SetTimer(Some(hwnd), PULSE_TIMER_ID, PULSE_INTERVAL_MS, None);
    Some(hwnd)
}

unsafe extern "system" fn controller_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            if wparam.0 == REFRESH_TIMER_ID {
                let state_ref = controller_state_ptr(hwnd);
                if !state_ref.is_null() {
                    let state = &mut *state_ref;
                    let live = enumerate_eve_clients();
                    let live_hwnds: Vec<isize> = live.iter().map(|c| c.hwnd).collect();

                    let gone: Vec<isize> = state.previews.keys().copied().filter(|h| !live_hwnds.contains(h)).collect();
                    for client_hwnd in gone {
                        if let Some(preview_hwnd) = state.previews.remove(&client_hwnd) {
                            let _ = DestroyWindow(HWND(preview_hwnd as *mut _));
                        }
                    }

                    let instance = GetModuleHandleW(None).unwrap_or_default();
                    let class_name = to_wide(PREVIEW_CLASS_NAME);
                    for client in &live {
                        if !state.previews.contains_key(&client.hwnd) {
                            if let Some(preview_hwnd) = create_preview_window(state.ctx.clone(), &class_name, instance, client) {
                                state.previews.insert(client.hwnd, preview_hwnd.0 as isize);
                            }
                        }
                    }

                    // Which client currently has OS focus, and the settings
                    // needed to decide visibility/topmost/highlight/minimize
                    // for every preview this tick.
                    let foreground = GetForegroundWindow().0 as isize;
                    let settings = state.ctx.settings.lock().unwrap().clone();
                    sync_hotkeys(hwnd, state, &settings);
                    for client in &live {
                        let Some(&preview_raw) = state.previews.get(&client.hwnd) else { continue };
                        let preview_hwnd = HWND(preview_raw as *mut _);
                        let preview_state = preview_state_ptr(preview_hwnd);
                        if preview_state.is_null() {
                            continue;
                        }
                        let label = (*preview_state).label.clone();
                        let is_active = client.hwnd == foreground;
                        let was_active = (*preview_state).is_active;
                        (*preview_state).is_active = is_active;

                        let force_hidden = settings.force_hidden.get(&label).copied().unwrap_or(false);
                        let hide = force_hidden || (settings.hide_active_preview && is_active);
                        let _ = ShowWindow(preview_hwnd, if hide { SW_HIDE } else { SW_SHOW });

                        let z = if settings.always_on_top { HWND_TOPMOST } else { HWND_NOTOPMOST };
                        let _ = SetWindowPos(preview_hwnd, Some(z), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

                        if settings.minimize_inactive_clients {
                            let client_hwnd = HWND(client.hwnd as *mut _);
                            if !is_active && !IsIconic(client_hwnd).as_bool() {
                                let _ = ShowWindow(client_hwnd, SW_MINIMIZE);
                            }
                        }

                        if is_active != was_active {
                            let _ = InvalidateRect(Some(preview_hwnd), None, true);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_HOTKEY => {
            let state_ref = controller_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &*state_ref;
                let id = wparam.0 as i32;
                if let Some(name) = state.hotkey_ids.iter().find_map(|(k, &v)| (v == id).then(|| k.clone())) {
                    for (&client_hwnd, &preview_raw) in &state.previews {
                        let preview_hwnd = HWND(preview_raw as *mut _);
                        let preview_state = preview_state_ptr(preview_hwnd);
                        if !preview_state.is_null() && (*preview_state).label == name {
                            let target = HWND(client_hwnd as *mut _);
                            let _ = ShowWindow(target, SW_RESTORE);
                            let _ = SetForegroundWindow(target);
                            break;
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            let state_ref = controller_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = Box::from_raw(state_ref);
                for preview_hwnd in state.previews.values() {
                    let _ = DestroyWindow(HWND(*preview_hwnd as *mut _));
                }
                for &id in state.hotkey_ids.values() {
                    let _ = UnregisterHotKey(Some(hwnd), id);
                }
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// The controller's own HWND, once open - stashed so close_overlay (called
/// from a different thread, via a Tauri command) can reach it with a plain
/// DestroyWindow call, which is documented as safe cross-thread. Everything
/// else here is only ever touched from the manager thread itself.
static CONTROLLER_HWND: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

fn controller_hwnd_cell() -> &'static Mutex<Option<isize>> {
    CONTROLLER_HWND.get_or_init(|| Mutex::new(None))
}

pub(crate) fn is_overlay_open() -> bool {
    controller_hwnd_cell().lock().unwrap().is_some()
}

/// Asks the controller to close itself, rather than reaching across
/// threads to destroy its window directly - DestroyWindow only works when
/// called from the thread that created the window, so calling it here (a
/// different thread) would silently fail, leaving the controller and every
/// preview window running while this side believed it was already closed.
/// PostMessageW is documented as safe to call cross-thread; the controller
/// has no explicit WM_CLOSE handler, so DefWindowProc's default behavior
/// (call DestroyWindow on itself, from its own thread) does the rest.
pub(crate) fn close_overlay() {
    let hwnd_raw = *controller_hwnd_cell().lock().unwrap();
    if let Some(hwnd_raw) = hwnd_raw {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd_raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

/// Opens the floating preview windows (a no-op if already open) on a
/// dedicated thread that owns the whole Win32 message loop for its
/// lifetime - one hidden controller window driving a live-updating set of
/// independent, borderless preview windows, one per detected client.
pub(crate) fn open_overlay(app: tauri::AppHandle, settings: MultiboxSettings) {
    if is_overlay_open() {
        return;
    }
    std::thread::spawn(move || unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();

        let controller_class_name = to_wide(CONTROLLER_CLASS_NAME);
        let controller_wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(controller_wndproc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(controller_class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassExW(&controller_wc);

        let preview_class_name = to_wide(PREVIEW_CLASS_NAME);
        // A real background brush is what makes BeginPaint erase the whole
        // client area before every repaint - without one, turning off a
        // highlight/frame border (is_active flipping false) never actually
        // clears the old border pixels, since nothing else in paint_preview
        // draws over that exact area when there's no new border to draw.
        let bg_brush = CreateSolidBrush(COLORREF(0x00161310));
        let preview_wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(preview_wndproc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: bg_brush,
            lpszClassName: PCWSTR(preview_class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassExW(&preview_wc);

        let shared_settings = Arc::new(Mutex::new(settings));
        *super::live_settings_cell().lock().unwrap() = Some(shared_settings.clone());
        let ctx = Arc::new(SharedContext { app: app.clone(), settings: shared_settings });

        let controller_title = to_wide("VESPER Multibox Controller");
        let Ok(controller_hwnd) = CreateWindowExW(
            Default::default(),
            PCWSTR(controller_class_name.as_ptr()),
            PCWSTR(controller_title.as_ptr()),
            Default::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        ) else {
            *super::live_settings_cell().lock().unwrap() = None;
            return;
        };

        let controller_state = Box::new(ControllerState {
            ctx,
            previews: HashMap::new(),
            hotkey_ids: HashMap::new(),
            next_hotkey_id: 1,
            synced_hotkeys: HashMap::new(),
        });
        SetWindowLongPtrW(controller_hwnd, GWLP_USERDATA, Box::into_raw(controller_state) as isize);

        *controller_hwnd_cell().lock().unwrap() = Some(controller_hwnd.0 as isize);
        let _ = SetTimer(Some(controller_hwnd), REFRESH_TIMER_ID, REFRESH_INTERVAL_MS, None);
        // Fire the first refresh immediately rather than waiting a full
        // interval for the initial set of preview windows to appear.
        let _ = PostMessageW(Some(controller_hwnd), WM_TIMER, WPARAM(REFRESH_TIMER_ID), LPARAM(0));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        *controller_hwnd_cell().lock().unwrap() = None;
        *super::live_settings_cell().lock().unwrap() = None;
    });
}
