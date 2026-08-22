//! A tiny always-on-top native window with a live item-price lookup - type
//! a name, pick from a suggestion list (so you don't need to remember an
//! item's exact name), see its current sell-min price in whichever region
//! the Market Browser was showing when you pinned it, all without
//! alt-tabbing back into VESPER. Deliberately much simpler than
//! multibox.rs's preview windows: there's only ever one of these, no DWM
//! thumbnail composition, and no per-client rescan loop - just one
//! WS_POPUP window with two native child controls (an EDIT box and a
//! LISTBOX for suggestions), redrawn whenever a debounced search or a
//! price fetch resolves.
use crate::market;
use std::sync::{Arc, Mutex, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    FillRect, InvalidateRect, LineTo, MoveToEx, RoundRect, SelectObject, SetBkColor, SetBkMode, SetTextColor,
    SetWindowRgn, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DEFAULT_QUALITY, DRAW_TEXT_FORMAT,
    DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_BOLD, FW_NORMAL, FW_SEMIBOLD, HDC,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage,
    RegisterClassExW, SendMessageW, SetTimer, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    TranslateMessage, CS_DROPSHADOW, CS_HREDRAW, CS_VREDRAW, EN_CHANGE, GWLP_USERDATA, HMENU, IDC_ARROW, LBN_SELCHANGE,
    LB_ADDSTRING, LB_GETCURSEL, LB_RESETCONTENT, MSG, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOW,
    WM_CLOSE, WM_COMMAND, WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_DESTROY, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_PAINT, WM_SETFONT, WM_TIMER, WNDCLASSEXW, WS_CHILD, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

const WIDGET_CLASS_NAME: &str = "VesperPriceWidget";
const EDIT_CTRL_ID: i32 = 101;
const LISTBOX_CTRL_ID: i32 = 102;
const SEARCH_DEBOUNCE_TIMER_ID: usize = 1;
const SEARCH_DEBOUNCE_MS: u32 = 350;
/// WM_APP (0x8000) + 1/+2 - "a suggestion search finished" / "a price fetch
/// for the selected item finished", posted from an async task back onto
/// this window since it can't touch the UI directly from a tokio task.
const WM_SUGGESTIONS_READY: u32 = 0x8001;
const WM_PRICE_READY: u32 = 0x8002;
const MAX_SUGGESTIONS: usize = 8;

const WIDGET_WIDTH: i32 = 300;
const HEADER_HEIGHT: i32 = 30;
const EDIT_HEIGHT: i32 = 26;
const PADDING: i32 = 12;
/// Vertical space shared by the suggestion listbox and the price-result
/// card - only one of the two is ever visible at a time, so they can
/// occupy the same reserved rect instead of the window resizing at runtime.
const RESULT_AREA_HEIGHT: i32 = 82;
const WIDGET_HEIGHT: i32 = HEADER_HEIGHT + PADDING + EDIT_HEIGHT + PADDING + RESULT_AREA_HEIGHT + PADDING;
const BORDER_THICKNESS: i32 = 1;
/// Corner radius for both the window's own shape (SetWindowRgn) and the
/// card/input panels drawn inside it - matches App.css's --radius-md.
const CORNER_RADIUS: i32 = 10;
const INPUT_RADIUS: i32 = 6;
const ACCENT_RAIL_WIDTH: i32 = 3;

// VESPER's own design tokens (App.css), hard-coded here since GDI has no
// CSS to read from - this widget is a native window, not a webview.
const BG_COLOR: (u8, u8, u8) = (0x0A, 0x0A, 0x0C); // --bg
const PANEL_COLOR: (u8, u8, u8) = (0x13, 0x14, 0x18); // --bg-elevated
const INPUT_BG_COLOR: (u8, u8, u8) = (0x1A, 0x1C, 0x21); // --bg-elevated-2
const BORDER_COLOR: (u8, u8, u8) = (0x24, 0x26, 0x2B); // --border
const ACCENT_COLOR: (u8, u8, u8) = (0x6F, 0xC3, 0xD9); // --accent
const TEXT_COLOR: (u8, u8, u8) = (0xE8, 0xEA, 0xED); // --text
const TEXT_SECONDARY_COLOR: (u8, u8, u8) = (0xA3, 0xA8, 0xB0); // --text-secondary
const TEXT_MUTED_COLOR: (u8, u8, u8) = (0x6B, 0x70, 0x78); // --text-muted
const SUCCESS_COLOR: (u8, u8, u8) = (0x5F, 0xBF, 0x8A); // --success
const FONT_FACE: &str = "Segoe UI";

#[derive(Clone)]
struct Suggestion {
    type_id: i64,
    name: String,
}

#[derive(Clone)]
struct PriceResult {
    name: String,
    sell_min: Option<f64>,
}

struct SharedState {
    app: tauri::AppHandle,
    client: reqwest::Client,
    region_id: i64,
    suggestions: Mutex<Vec<Suggestion>>,
    result: Mutex<Option<PriceResult>>,
    searching: Mutex<bool>,
}

struct WidgetState {
    shared: Arc<SharedState>,
    edit_hwnd: isize,
    listbox_hwnd: isize,
    input_bg_brush: isize,
    ui_font: isize,
    drag_from: Option<(POINT, POINT)>,
    /// Set right before this window programmatically rewrites the edit
    /// box's text (after a suggestion is clicked) - without this, that
    /// text change would itself fire EN_CHANGE and re-open the suggestion
    /// list we just closed.
    suppress_next_change: bool,
}

static WIDGET_HWND: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

fn widget_hwnd_cell() -> &'static Mutex<Option<isize>> {
    WIDGET_HWND.get_or_init(|| Mutex::new(None))
}

pub fn is_widget_open() -> bool {
    widget_hwnd_cell().lock().unwrap().is_some()
}

pub fn close_widget() {
    let hwnd_raw = *widget_hwnd_cell().lock().unwrap();
    if let Some(hwnd_raw) = hwnd_raw {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd_raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn rgb(color: (u8, u8, u8)) -> COLORREF {
    let (r, g, b) = color;
    COLORREF((r as u32) | (g as u32) << 8 | (b as u32) << 16)
}

fn group_thousands(n: i64) -> String {
    let neg = n < 0;
    let digits = n.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let result: String = grouped.chars().rev().collect();
    if neg {
        format!("-{result}")
    } else {
        result
    }
}

fn format_isk(value: f64) -> String {
    format!("{} ISK", group_thousands(value.round() as i64))
}

fn widget_state_ptr(hwnd: HWND) -> *mut WidgetState {
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WidgetState }
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn make_ui_font(size: i32, weight: i32) -> windows::Win32::Graphics::Gdi::HFONT {
    let face = to_wide(FONT_FACE);
    unsafe {
        CreateFontW(
            size,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            DEFAULT_QUALITY,
            (DEFAULT_PITCH.0 as u32) | (FF_DONTCARE.0 as u32),
            PCWSTR(face.as_ptr()),
        )
    }
}

/// Kicks off (or re-kicks-off) a debounced suggestion search: reads the
/// edit box, resolves matching items via the same local search VESPER's
/// other type-search boxes use, and posts the results back as a
/// clickable list - no auto-guessing which one you meant.
fn trigger_search(hwnd: HWND) {
    let state_ref = widget_state_ptr(hwnd);
    if state_ref.is_null() {
        return;
    }
    let state = unsafe { &*state_ref };
    let query = window_text(HWND(state.edit_hwnd as *mut _));
    if query.trim().is_empty() {
        *state.shared.suggestions.lock().unwrap() = Vec::new();
        *state.shared.result.lock().unwrap() = None;
        unsafe {
            let _ = ShowWindow(HWND(state.listbox_hwnd as *mut _), SW_HIDE);
            let _ = InvalidateRect(Some(hwnd), None, true);
        }
        return;
    }

    let shared = state.shared.clone();
    let hwnd_raw = hwnd.0 as isize;
    tauri::async_runtime::spawn(async move {
        let matches = market::search_types(shared.app.clone(), &shared.client, query).await.unwrap_or_default();
        let suggestions: Vec<Suggestion> = matches.into_iter().take(MAX_SUGGESTIONS).map(|m| Suggestion { type_id: m.id, name: m.name }).collect();
        *shared.suggestions.lock().unwrap() = suggestions;
        *shared.result.lock().unwrap() = None;
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd_raw as *mut _)), WM_SUGGESTIONS_READY, WPARAM(0), LPARAM(0));
        }
    });
}

/// Fetches the sell-min price for one explicitly-chosen item (a suggestion
/// the user clicked), rather than guessing from free text.
fn fetch_price_for(hwnd: HWND, type_id: i64, name: String) {
    let state_ref = widget_state_ptr(hwnd);
    if state_ref.is_null() {
        return;
    }
    let state = unsafe { &*state_ref };
    let shared = state.shared.clone();
    let hwnd_raw = hwnd.0 as isize;
    *shared.searching.lock().unwrap() = true;
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
    tauri::async_runtime::spawn(async move {
        let sell_min = market::fetch_region_sell_min(&shared.client, shared.region_id, type_id).await.ok().flatten();
        *shared.searching.lock().unwrap() = false;
        *shared.result.lock().unwrap() = Some(PriceResult { name, sell_min });
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd_raw as *mut _)), WM_PRICE_READY, WPARAM(0), LPARAM(0));
        }
    });
}

fn select_suggestion(hwnd: HWND, index: i32) {
    let state_ref = widget_state_ptr(hwnd);
    if state_ref.is_null() {
        return;
    }
    let state = unsafe { &mut *state_ref };
    let chosen = {
        let suggestions = state.shared.suggestions.lock().unwrap();
        if index < 0 || index as usize >= suggestions.len() {
            return;
        }
        suggestions[index as usize].clone()
    };

    state.suppress_next_change = true;
    unsafe {
        let wide = to_wide(&chosen.name);
        let _ = SetWindowTextW(HWND(state.edit_hwnd as *mut _), PCWSTR(wide.as_ptr()));
        let _ = ShowWindow(HWND(state.listbox_hwnd as *mut _), SW_HIDE);
    }
    *state.shared.suggestions.lock().unwrap() = Vec::new();
    fetch_price_for(hwnd, chosen.type_id, chosen.name);
}

/// Draws a flat-bordered, rounded panel filled with `fill` - the one
/// repeated visual unit this whole widget is built from (header bar, input
/// frame, result card), matching the app's own card/input treatment
/// instead of GDI's default sharp-cornered look.
unsafe fn draw_panel(hdc: HDC, rect: RECT, fill: (u8, u8, u8), border: Option<(u8, u8, u8)>, radius: i32) {
    let brush = CreateSolidBrush(rgb(fill));
    let old_brush = SelectObject(hdc, brush.into());
    let pen = match border {
        Some(color) => CreatePen(PS_SOLID, BORDER_THICKNESS, rgb(color)),
        None => CreatePen(PS_SOLID, 1, rgb(fill)),
    };
    let old_pen = SelectObject(hdc, pen.into());
    let _ = RoundRect(hdc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    let _ = DeleteObject(pen.into());
    let _ = DeleteObject(brush.into());
}

unsafe fn draw_text(hdc: HDC, mut rect: RECT, text: &str, color: (u8, u8, u8), size: i32, weight: i32, flags: DRAW_TEXT_FORMAT) {
    let font = make_ui_font(size, weight);
    let old_font = SelectObject(hdc, font.into());
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, rgb(color));
    let mut wide = to_wide(text);
    DrawTextW(hdc, &mut wide, &mut rect, flags);
    SelectObject(hdc, old_font);
    let _ = DeleteObject(font.into());
}

unsafe fn paint_widget(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut client_rect = RECT::default();
    let _ = GetClientRect(hwnd, &mut client_rect);

    // The window's own background sits one shade darker than every panel
    // drawn on top of it - the same base/elevated-surface layering the
    // rest of the app uses (page background vs. card background).
    let bg_brush = CreateSolidBrush(rgb(BG_COLOR));
    FillRect(hdc, &client_rect, bg_brush);
    let _ = DeleteObject(bg_brush.into());

    // Header bar: an elevated panel of its own, with a bottom divider,
    // rather than bare text floating on the page background - reads as a
    // proper title bar the same way the app's own section headers do.
    let header_rect = RECT { left: client_rect.left, top: client_rect.top, right: client_rect.right, bottom: client_rect.top + HEADER_HEIGHT };
    let header_brush = CreateSolidBrush(rgb(PANEL_COLOR));
    FillRect(hdc, &header_rect, header_brush);
    let _ = DeleteObject(header_brush.into());
    let divider_pen = CreatePen(PS_SOLID, 1, rgb(BORDER_COLOR));
    let old_pen = SelectObject(hdc, divider_pen.into());
    let _ = MoveToEx(hdc, header_rect.left, header_rect.bottom, None);
    let _ = LineTo(hdc, header_rect.right, header_rect.bottom);
    SelectObject(hdc, old_pen);
    let _ = DeleteObject(divider_pen.into());

    draw_text(
        hdc,
        RECT { left: header_rect.left + PADDING, ..header_rect },
        "VESPER \u{00B7} PRICE CHECK",
        ACCENT_COLOR,
        13,
        FW_SEMIBOLD.0 as i32,
        DT_LEFT | DT_VCENTER | DT_SINGLELINE,
    );

    // The edit control sits inside its own rounded frame (the control
    // itself is borderless - see WS_CHILD without WS_BORDER at creation -
    // so this is the only border it gets, drawn flat instead of the OS's
    // default sunken 3D edge).
    let edit_rect = RECT {
        left: client_rect.left + PADDING,
        top: HEADER_HEIGHT + PADDING,
        right: client_rect.right - PADDING,
        bottom: HEADER_HEIGHT + PADDING + EDIT_HEIGHT,
    };
    draw_panel(hdc, edit_rect, INPUT_BG_COLOR, Some(BORDER_COLOR), INPUT_RADIUS);

    let result_rect = RECT {
        left: client_rect.left + PADDING,
        top: HEADER_HEIGHT + PADDING + EDIT_HEIGHT + PADDING,
        right: client_rect.right - PADDING,
        bottom: HEADER_HEIGHT + PADDING + EDIT_HEIGHT + PADDING + RESULT_AREA_HEIGHT,
    };

    let state_ref = widget_state_ptr(hwnd);
    if !state_ref.is_null() {
        let state = &*state_ref;
        let has_suggestions = !state.shared.suggestions.lock().unwrap().is_empty();

        if !has_suggestions {
            let searching = *state.shared.searching.lock().unwrap();
            let result = state.shared.result.lock().unwrap().clone();
            let query_text = window_text(HWND(state.edit_hwnd as *mut _));

            draw_panel(hdc, result_rect, PANEL_COLOR, Some(BORDER_COLOR), INPUT_RADIUS);

            let (rail_color, label, value, value_color) = if searching {
                (ACCENT_COLOR, "Looking it up...".to_string(), String::new(), TEXT_COLOR)
            } else if let Some(r) = result {
                match r.sell_min {
                    Some(price) => (SUCCESS_COLOR, r.name, format_isk(price), TEXT_COLOR),
                    None => (TEXT_MUTED_COLOR, r.name, "No sell orders in region".to_string(), TEXT_MUTED_COLOR),
                }
            } else if query_text.trim().is_empty() {
                (BORDER_COLOR, "Type an item name above".to_string(), String::new(), TEXT_MUTED_COLOR)
            } else {
                (TEXT_MUTED_COLOR, "No matches found".to_string(), String::new(), TEXT_MUTED_COLOR)
            };

            // A thin accent-colored rail on the card's left edge - the
            // same "status rail" motif VESPER's own dashboard-style
            // summaries use to color-code a card at a glance.
            let rail_rect = RECT { left: result_rect.left, top: result_rect.top + 2, right: result_rect.left + ACCENT_RAIL_WIDTH, bottom: result_rect.bottom - 2 };
            let rail_brush = CreateSolidBrush(rgb(rail_color));
            FillRect(hdc, &rail_rect, rail_brush);
            let _ = DeleteObject(rail_brush.into());

            let text_left = result_rect.left + ACCENT_RAIL_WIDTH + PADDING;
            if value.is_empty() {
                // Placeholder / no-matches / searching - a single centered
                // message rather than an empty label-plus-value pair.
                draw_text(
                    hdc,
                    RECT { left: text_left, top: result_rect.top, right: result_rect.right - PADDING, bottom: result_rect.bottom },
                    &label,
                    TEXT_MUTED_COLOR,
                    13,
                    FW_NORMAL.0 as i32,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE,
                );
            } else {
                draw_text(
                    hdc,
                    RECT { left: text_left, top: result_rect.top + 14, right: result_rect.right - PADDING, bottom: result_rect.top + 32 },
                    &label,
                    TEXT_SECONDARY_COLOR,
                    12,
                    FW_NORMAL.0 as i32,
                    DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
                );
                draw_text(
                    hdc,
                    RECT { left: text_left, top: result_rect.top + 34, right: result_rect.right - PADDING, bottom: result_rect.bottom - 8 },
                    &value,
                    value_color,
                    21,
                    FW_BOLD.0 as i32,
                    DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
                );
            }
        }
    }

    let _ = EndPaint(hwnd, &ps);
}

unsafe extern "system" fn widget_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            let hdc = HDC(wparam.0 as *mut _);
            SetTextColor(hdc, rgb(TEXT_COLOR));
            SetBkColor(hdc, rgb(INPUT_BG_COLOR));
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                return LRESULT((&*state_ref).input_bg_brush);
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            let notif = ((wparam.0 >> 16) & 0xFFFF) as u32;
            let ctrl_id = (wparam.0 & 0xFFFF) as i32;
            if ctrl_id == EDIT_CTRL_ID && notif == EN_CHANGE {
                let state_ref = widget_state_ptr(hwnd);
                if !state_ref.is_null() {
                    let state = &mut *state_ref;
                    if state.suppress_next_change {
                        state.suppress_next_change = false;
                    } else {
                        let _ = SetTimer(Some(hwnd), SEARCH_DEBOUNCE_TIMER_ID, SEARCH_DEBOUNCE_MS, None);
                    }
                }
            } else if ctrl_id == LISTBOX_CTRL_ID && notif == LBN_SELCHANGE {
                let state_ref = widget_state_ptr(hwnd);
                if !state_ref.is_null() {
                    let listbox_hwnd = HWND((&*state_ref).listbox_hwnd as *mut _);
                    let index = SendMessageW(listbox_hwnd, LB_GETCURSEL, Some(WPARAM(0)), Some(LPARAM(0))).0 as i32;
                    select_suggestion(hwnd, index);
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == SEARCH_DEBOUNCE_TIMER_ID {
                let _ = KillTimer(Some(hwnd), SEARCH_DEBOUNCE_TIMER_ID);
                trigger_search(hwnd);
            }
            LRESULT(0)
        }
        WM_SUGGESTIONS_READY => {
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &*state_ref;
                let suggestions = state.shared.suggestions.lock().unwrap().clone();
                let listbox_hwnd = HWND(state.listbox_hwnd as *mut _);
                SendMessageW(listbox_hwnd, LB_RESETCONTENT, Some(WPARAM(0)), Some(LPARAM(0)));
                for s in &suggestions {
                    let wide = to_wide(&s.name);
                    SendMessageW(listbox_hwnd, LB_ADDSTRING, Some(WPARAM(0)), Some(LPARAM(wide.as_ptr() as isize)));
                }
                let _ = ShowWindow(listbox_hwnd, if suggestions.is_empty() { SW_HIDE } else { SW_SHOW });
                let _ = InvalidateRect(Some(hwnd), None, true);
            }
            LRESULT(0)
        }
        WM_PRICE_READY => {
            let _ = InvalidateRect(Some(hwnd), None, true);
            LRESULT(0)
        }
        WM_PAINT => {
            paint_widget(hwnd);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &mut *state_ref;
                let mut cursor = POINT::default();
                let _ = GetCursorPos(&mut cursor);
                let mut window_rect = RECT::default();
                let _ = GetWindowRect(hwnd, &mut window_rect);
                state.drag_from = Some((cursor, POINT { x: window_rect.left, y: window_rect.top }));
                SetCapture(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &*state_ref;
                if let Some((start_cursor, start_window)) = state.drag_from {
                    let mut cursor = POINT::default();
                    let _ = GetCursorPos(&mut cursor);
                    let dx = cursor.x - start_cursor.x;
                    let dy = cursor.y - start_cursor.y;
                    let _ = SetWindowPos(hwnd, None, start_window.x + dx, start_window.y + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let _ = ReleaseCapture();
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                (&mut *state_ref).drag_from = None;
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = Box::from_raw(state_ref);
                let _ = DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ(state.input_bg_brush as *mut _));
                let _ = DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ(state.ui_font as *mut _));
            }
            *widget_hwnd_cell().lock().unwrap() = None;
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn create_widget_window(app: tauri::AppHandle, client: reqwest::Client, region_id: i64) -> Option<HWND> {
    let instance = GetModuleHandleW(None).unwrap_or_default();
    let class_name = to_wide(WIDGET_CLASS_NAME);
    let bg_brush = CreateSolidBrush(rgb(BG_COLOR));
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW | CS_DROPSHADOW,
        lpfnWndProc: Some(widget_wndproc),
        hInstance: instance.into(),
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        hbrBackground: bg_brush,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    // Ignore failure: re-opening the widget after closing it once hits this
    // again with the same class name already registered from last time,
    // which is expected and harmless (the class is process-scoped, not
    // tied to the thread that registered it).
    RegisterClassExW(&wc);

    // Spawns right where the user is already looking - wherever the cursor
    // is at the moment of opening it - rather than a fixed screen corner
    // that might be on a completely different monitor on a multi-monitor
    // setup. A small offset keeps the window from appearing directly under
    // the cursor.
    let mut cursor = POINT::default();
    let _ = GetCursorPos(&mut cursor);
    let origin_x = cursor.x + 16;
    let origin_y = cursor.y + 16;

    let title = to_wide("VESPER Price Widget");
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        PCWSTR(class_name.as_ptr()),
        PCWSTR(title.as_ptr()),
        WS_POPUP | WS_VISIBLE,
        origin_x,
        origin_y,
        WIDGET_WIDTH,
        WIDGET_HEIGHT,
        None,
        None,
        Some(instance.into()),
        None,
    )
    .ok()?;

    // Rounds the window's own shape to match --radius-md instead of GDI's
    // default sharp rectangle - CreateRoundRectRgn's ellipse size is a full
    // diameter, so this doubles the radius constant.
    let region = CreateRoundRectRgn(0, 0, WIDGET_WIDTH + 1, WIDGET_HEIGHT + 1, CORNER_RADIUS * 2, CORNER_RADIUS * 2);
    let _ = SetWindowRgn(hwnd, Some(region), true);

    let edit_class = to_wide("EDIT");
    let edit_hwnd = CreateWindowExW(
        Default::default(),
        PCWSTR(edit_class.as_ptr()),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE,
        PADDING,
        HEADER_HEIGHT + PADDING,
        WIDGET_WIDTH - PADDING * 2,
        EDIT_HEIGHT,
        Some(hwnd),
        Some(HMENU(EDIT_CTRL_ID as isize as *mut _)),
        Some(instance.into()),
        None,
    )
    .ok()?;

    let listbox_class = to_wide("LISTBOX");
    // LBS_NOTIFY (0x0001) isn't in the strongly-typed WINDOW_STYLE set the
    // other flags come from, so it's OR'd in as a raw bit.
    const LBS_NOTIFY: u32 = 0x0001;
    let listbox_style = windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE((WS_CHILD | WS_VISIBLE).0 | LBS_NOTIFY);
    let listbox_hwnd = CreateWindowExW(
        Default::default(),
        PCWSTR(listbox_class.as_ptr()),
        PCWSTR::null(),
        listbox_style,
        PADDING,
        HEADER_HEIGHT + PADDING + EDIT_HEIGHT + PADDING,
        WIDGET_WIDTH - PADDING * 2,
        RESULT_AREA_HEIGHT - 4,
        Some(hwnd),
        Some(HMENU(LISTBOX_CTRL_ID as isize as *mut _)),
        Some(instance.into()),
        None,
    )
    .ok()?;
    let _ = ShowWindow(listbox_hwnd, SW_HIDE);

    let input_bg_brush = CreateSolidBrush(rgb(INPUT_BG_COLOR));
    let ui_font = make_ui_font(15, FW_NORMAL.0 as i32);
    SendMessageW(edit_hwnd, WM_SETFONT, Some(WPARAM(ui_font.0 as usize)), Some(LPARAM(1)));
    SendMessageW(listbox_hwnd, WM_SETFONT, Some(WPARAM(ui_font.0 as usize)), Some(LPARAM(1)));

    let shared = Arc::new(SharedState {
        app,
        client,
        region_id,
        suggestions: Mutex::new(Vec::new()),
        result: Mutex::new(None),
        searching: Mutex::new(false),
    });
    let state = Box::new(WidgetState {
        shared,
        edit_hwnd: edit_hwnd.0 as isize,
        listbox_hwnd: listbox_hwnd.0 as isize,
        input_bg_brush: input_bg_brush.0 as isize,
        ui_font: ui_font.0 as isize,
        drag_from: None,
        suppress_next_change: false,
    });
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);

    let _ = ShowWindow(hwnd, SW_SHOW);
    Some(hwnd)
}

/// Opens the widget (a no-op if already open) on a dedicated thread that
/// owns its own Win32 message loop for as long as the window lives - the
/// same reason multibox's controller thread exists: a native window needs
/// something pumping its message queue, and that can't be Tauri's own
/// event loop for a window Tauri doesn't know about.
pub fn open_widget(app: tauri::AppHandle, client: reqwest::Client, region_id: i64) {
    if is_widget_open() {
        return;
    }
    std::thread::spawn(move || unsafe {
        let Some(hwnd) = create_widget_window(app, client, region_id) else { return };
        *widget_hwnd_cell().lock().unwrap() = Some(hwnd.0 as isize);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        *widget_hwnd_cell().lock().unwrap() = None;
    });
}
