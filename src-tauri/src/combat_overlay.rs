//! Live outgoing/incoming DPS, armor/shield/hull rep, and capacitor
//! transfer tracking - reads EVE's own combat log (Gamelogs, a different
//! folder and line format than the chat logs intel_feed.rs tails) and
//! aggregates events into a small floating native overlay, the same
//! native-window idiom price_widget.rs already established (WS_POPUP,
//! topmost, rounded + drop-shadowed, GDI-painted).
//!
//! Line format verified against a real, working open-source parser
//! (PyEveLiveDPS) rather than guessed: after EVE's own rich-text markup
//! tags (<color=...>, <b>, etc.) are stripped, a combat log line reads
//! like `(combat) 120 to Some Pilot (Damavik) - Caldari Navy Nova Rocket
//! - Hits`, with "to <name>" meaning damage/effect *you* dealt and "from
//! <name>"/"by <name>" meaning damage/effect done *to you*.
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    FillRect, InvalidateRect, LineTo, MoveToEx, SelectObject, SetBkMode, SetTextColor, SetWindowRgn, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DEFAULT_QUALITY, DT_LEFT, DT_RIGHT, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_BOLD,
    FW_NORMAL, FW_SEMIBOLD, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassExW, SetTimer,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, CS_DROPSHADOW, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA,
    IDC_ARROW, MSG, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOW, WM_CLOSE, WM_DESTROY, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

fn gamelogs_dir() -> Option<PathBuf> {
    let profile = std::env::var("USERPROFILE").ok()?;
    let dir = PathBuf::from(profile).join("Documents").join("EVE").join("logs").join("Gamelogs");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

fn decode_utf16le_units(bytes: &[u8]) -> Vec<u16> {
    bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
}

/// Strips EVE's rich-text markup (<color=...>, <b>, </b>, <font...>, etc.)
/// so the plain-text line can be matched with simple substring checks
/// instead of needing to replicate every tag variant.
fn strip_markup(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_tag = false;
    for c in line.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CombatEventKind {
    DamageOut,
    DamageIn,
    RepOut,
    RepIn,
    CapOut,
}

struct CombatEvent {
    kind: CombatEventKind,
    amount: i64,
}

/// Parses one already-markup-stripped, already-timestamp-stripped combat
/// log line, e.g. "120 to Some Pilot (Damavik) - Caldari Navy Nova Rocket
/// - Hits". Only genuine "(combat) " lines are events at all - a Gamelogs
/// file also carries session start/end notices and other chatter, which
/// this simply doesn't match and skips. Armor/shield/hull reps are folded
/// into one Rep In/Out figure - a fight-side overlay benefits more from
/// "logi is keeping me alive" at a glance than three separate numbers.
fn parse_combat_line(plain: &str) -> Option<CombatEvent> {
    let rest = plain.strip_prefix("(combat) ")?;
    let (amount_str, tail) = rest.split_once(' ')?;
    let amount: i64 = amount_str.parse().ok()?;

    let kind = if tail.contains("repaired to ") || tail.contains("boosted to ") {
        CombatEventKind::RepOut
    } else if tail.contains("repaired by ") || tail.contains("boosted by ") {
        CombatEventKind::RepIn
    } else if tail.contains("capacitor transmitted to ") {
        CombatEventKind::CapOut
    } else if tail.starts_with("to ") {
        CombatEventKind::DamageOut
    } else if tail.starts_with("from ") {
        CombatEventKind::DamageIn
    } else {
        return None;
    };
    Some(CombatEvent { kind, amount })
}

fn file_modified_unix(path: &std::path::Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whichever Gamelogs session file was most recently written to - the
/// overlay follows whichever client most recently had combat activity,
/// the simplest reasonable default for both single- and multi-boxing.
fn latest_gamelog_path() -> Option<PathBuf> {
    let dir = gamelogs_dir()?;
    let mut best: Option<(PathBuf, i64)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        let modified = file_modified_unix(&path);
        if best.as_ref().map_or(true, |(_, m)| modified > *m) {
            best = Some((path, modified));
        }
    }
    best.map(|(p, _)| p)
}

/// Same cursor/rollover handling as intel_feed.rs's chat-log poller
/// (UTF-16LE, byte offset kept 2-byte aligned, a shorter file than the
/// cursor means a new session started and the read restarts from its
/// beginning) - just pointed at Gamelogs and a different line format.
struct GamelogTailer {
    path: Option<PathBuf>,
    cursor: u64,
}

impl GamelogTailer {
    fn new() -> Self {
        Self { path: None, cursor: 0 }
    }

    fn poll(&mut self) -> Vec<CombatEvent> {
        let Some(current) = latest_gamelog_path() else { return Vec::new() };
        if self.path.as_ref() != Some(&current) {
            self.path = Some(current.clone());
            self.cursor = 0;
        }

        let Ok(len) = fs::metadata(&current).map(|m| m.len()) else { return Vec::new() };
        let start = if self.cursor > len { 0 } else { self.cursor };
        if start >= len {
            self.cursor = start;
            return Vec::new();
        }

        let Ok(mut file) = fs::File::open(&current) else { return Vec::new() };
        if file.seek(SeekFrom::Start(start)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        let usable_len = buf.len() - (buf.len() % 2);
        let units = decode_utf16le_units(&buf[..usable_len]);
        let Some(last_newline_idx) = units.iter().rposition(|&u| u == 0x000A) else {
            return Vec::new();
        };
        let text = String::from_utf16_lossy(&units[..=last_newline_idx]).replace('\u{FEFF}', "");
        self.cursor = start + ((last_newline_idx + 1) * 2) as u64;

        let mut events = Vec::new();
        for raw_line in text.lines() {
            let line = raw_line.trim();
            let Some(rest) = line.strip_prefix('[') else { continue };
            let Some(bracket_end) = rest.find(']') else { continue };
            let after_bracket = rest[bracket_end + 1..].trim_start();
            let plain = strip_markup(after_bracket);
            if let Some(event) = parse_combat_line(plain.trim()) {
                events.push(event);
            }
        }
        events
    }
}

/// How far back events count toward the displayed rate - long enough to
/// smooth out burst/miss variance between individual hits, short enough
/// to still feel "live" a couple of seconds after damage stops.
const RATE_WINDOW_SECS: f64 = 10.0;
const POLL_TIMER_ID: usize = 1;
const POLL_INTERVAL_MS: u32 = 1000;

#[derive(Clone, Copy, Default)]
struct CombatRates {
    dps_out: f64,
    dps_in: f64,
    rep_out: f64,
    rep_in: f64,
    cap_out: f64,
}

struct SharedState {
    tailer: Mutex<GamelogTailer>,
    recent: Mutex<VecDeque<(Instant, CombatEventKind, i64)>>,
    rates: Mutex<CombatRates>,
}

struct WidgetState {
    shared: Arc<SharedState>,
    drag_from: Option<(windows::Win32::Foundation::POINT, windows::Win32::Foundation::POINT)>,
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

const WIDGET_WIDTH: i32 = 200;
const WIDGET_HEIGHT: i32 = 190;
const HEADER_HEIGHT: i32 = 26;
const PADDING: i32 = 12;
const ROW_HEIGHT: i32 = 24;
const CORNER_RADIUS: i32 = 10;

const BG_COLOR: (u8, u8, u8) = (0x0A, 0x0A, 0x0C);
const PANEL_COLOR: (u8, u8, u8) = (0x13, 0x14, 0x18);
const BORDER_COLOR: (u8, u8, u8) = (0x24, 0x26, 0x2B);
const ACCENT_COLOR: (u8, u8, u8) = (0x6F, 0xC3, 0xD9);
const TEXT_COLOR: (u8, u8, u8) = (0xE8, 0xEA, 0xED);
const TEXT_MUTED_COLOR: (u8, u8, u8) = (0x6B, 0x70, 0x78);
const SUCCESS_COLOR: (u8, u8, u8) = (0x5F, 0xBF, 0x8A);
const DANGER_COLOR: (u8, u8, u8) = (0xE0, 0x68, 0x5F);
const FONT_FACE: &str = "Segoe UI";

fn make_font(size: i32, weight: i32) -> windows::Win32::Graphics::Gdi::HFONT {
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

fn widget_state_ptr(hwnd: HWND) -> *mut WidgetState {
    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WidgetState }
}

fn recompute_rates(shared: &SharedState) {
    let now = Instant::now();
    let mut recent = shared.recent.lock().unwrap();
    while let Some((t, _, _)) = recent.front() {
        if now.duration_since(*t).as_secs_f64() > RATE_WINDOW_SECS {
            recent.pop_front();
        } else {
            break;
        }
    }
    let mut rates = CombatRates::default();
    for (_, kind, amount) in recent.iter() {
        let bucket = match kind {
            CombatEventKind::DamageOut => &mut rates.dps_out,
            CombatEventKind::DamageIn => &mut rates.dps_in,
            CombatEventKind::RepOut => &mut rates.rep_out,
            CombatEventKind::RepIn => &mut rates.rep_in,
            CombatEventKind::CapOut => &mut rates.cap_out,
        };
        *bucket += *amount as f64;
    }
    rates.dps_out /= RATE_WINDOW_SECS;
    rates.dps_in /= RATE_WINDOW_SECS;
    rates.rep_out /= RATE_WINDOW_SECS;
    rates.rep_in /= RATE_WINDOW_SECS;
    rates.cap_out /= RATE_WINDOW_SECS;
    *shared.rates.lock().unwrap() = rates;
}

fn poll_tick(hwnd: HWND) {
    let state_ref = widget_state_ptr(hwnd);
    if state_ref.is_null() {
        return;
    }
    let shared = unsafe { (*state_ref).shared.clone() };
    let events = shared.tailer.lock().unwrap().poll();
    if !events.is_empty() {
        let now = Instant::now();
        let mut recent = shared.recent.lock().unwrap();
        for e in events {
            recent.push_back((now, e.kind, e.amount));
        }
    }
    recompute_rates(&shared);
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, false);
    }
}

unsafe fn draw_row(hdc: windows::Win32::Graphics::Gdi::HDC, top: i32, width: i32, label: &str, value: f64, color: (u8, u8, u8)) {
    let font_label = make_font(13, FW_NORMAL.0 as i32);
    let old = SelectObject(hdc, font_label.into());
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, rgb(TEXT_MUTED_COLOR));
    let mut label_wide = to_wide(label);
    let mut label_rect = RECT { left: PADDING, top, right: width / 2, bottom: top + ROW_HEIGHT };
    DrawTextW(hdc, &mut label_wide, &mut label_rect, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old);
    let _ = DeleteObject(font_label.into());

    let font_value = make_font(15, FW_BOLD.0 as i32);
    let old = SelectObject(hdc, font_value.into());
    SetTextColor(hdc, rgb(color));
    let mut value_wide = to_wide(&format!("{}", value.round() as i64));
    let mut value_rect = RECT { left: width / 2, top, right: width - PADDING, bottom: top + ROW_HEIGHT };
    DrawTextW(hdc, &mut value_wide, &mut value_rect, DT_RIGHT | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old);
    let _ = DeleteObject(font_value.into());
}

unsafe fn paint_widget(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut client_rect = RECT::default();
    let _ = GetClientRect(hwnd, &mut client_rect);

    let bg_brush = CreateSolidBrush(rgb(BG_COLOR));
    FillRect(hdc, &client_rect, bg_brush);
    let _ = DeleteObject(bg_brush.into());

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

    let header_font = make_font(13, FW_SEMIBOLD.0 as i32);
    let old_font = SelectObject(hdc, header_font.into());
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, rgb(ACCENT_COLOR));
    let mut header_text = to_wide("VESPER \u{00B7} COMBAT");
    let mut header_text_rect = RECT { left: header_rect.left + PADDING, ..header_rect };
    DrawTextW(hdc, &mut header_text, &mut header_text_rect, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, old_font);
    let _ = DeleteObject(header_font.into());

    let state_ref = widget_state_ptr(hwnd);
    if !state_ref.is_null() {
        let shared = &(*state_ref).shared;
        let rates = *shared.rates.lock().unwrap();
        let width = client_rect.right - client_rect.left;
        let mut top = HEADER_HEIGHT + 6;
        draw_row(hdc, top, width, "DPS Out", rates.dps_out, SUCCESS_COLOR);
        top += ROW_HEIGHT;
        draw_row(hdc, top, width, "DPS In", rates.dps_in, DANGER_COLOR);
        top += ROW_HEIGHT;
        draw_row(hdc, top, width, "Rep Out", rates.rep_out, SUCCESS_COLOR);
        top += ROW_HEIGHT;
        draw_row(hdc, top, width, "Rep In", rates.rep_in, TEXT_COLOR);
        top += ROW_HEIGHT;
        draw_row(hdc, top, width, "Cap Out", rates.cap_out, ACCENT_COLOR);
    }

    let _ = EndPaint(hwnd, &ps);
}

unsafe extern "system" fn widget_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            if wparam.0 == POLL_TIMER_ID {
                poll_tick(hwnd);
            }
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
                let mut cursor = windows::Win32::Foundation::POINT::default();
                let _ = GetCursorPos(&mut cursor);
                let mut window_rect = RECT::default();
                let _ = GetWindowRect(hwnd, &mut window_rect);
                state.drag_from = Some((cursor, windows::Win32::Foundation::POINT { x: window_rect.left, y: window_rect.top }));
                SetCapture(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let state_ref = widget_state_ptr(hwnd);
            if !state_ref.is_null() {
                let state = &*state_ref;
                if let Some((start_cursor, start_window)) = state.drag_from {
                    let mut cursor = windows::Win32::Foundation::POINT::default();
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
                let _ = Box::from_raw(state_ref);
            }
            *widget_hwnd_cell().lock().unwrap() = None;
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

const WIDGET_CLASS_NAME: &str = "VesperCombatOverlay";

unsafe fn create_widget_window() -> Option<HWND> {
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
    // Ignore failure: re-opening the overlay after closing it once hits
    // this again with the same class name already registered from last
    // time, which is expected and harmless.
    RegisterClassExW(&wc);

    let mut cursor = windows::Win32::Foundation::POINT::default();
    let _ = GetCursorPos(&mut cursor);

    let title = to_wide("VESPER Combat Overlay");
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        PCWSTR(class_name.as_ptr()),
        PCWSTR(title.as_ptr()),
        WS_POPUP | WS_VISIBLE,
        cursor.x + 16,
        cursor.y + 16,
        WIDGET_WIDTH,
        WIDGET_HEIGHT,
        None,
        None,
        Some(instance.into()),
        None,
    )
    .ok()?;

    let region = CreateRoundRectRgn(0, 0, WIDGET_WIDTH + 1, WIDGET_HEIGHT + 1, CORNER_RADIUS * 2, CORNER_RADIUS * 2);
    let _ = SetWindowRgn(hwnd, Some(region), true);

    let shared = Arc::new(SharedState { tailer: Mutex::new(GamelogTailer::new()), recent: Mutex::new(VecDeque::new()), rates: Mutex::new(CombatRates::default()) });
    let state = Box::new(WidgetState { shared, drag_from: None });
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);

    let _ = ShowWindow(hwnd, SW_SHOW);
    let _ = SetTimer(Some(hwnd), POLL_TIMER_ID, POLL_INTERVAL_MS, None);
    Some(hwnd)
}

/// Opens the overlay (a no-op if already open) on a dedicated thread that
/// owns its own Win32 message loop for as long as the window lives - same
/// reason multibox's controller thread and the price widget both do this:
/// a native window needs something pumping its message queue, and that
/// can't be Tauri's own event loop for a window Tauri doesn't know about.
pub fn open_widget() {
    if is_widget_open() {
        return;
    }
    std::thread::spawn(move || unsafe {
        let Some(hwnd) = create_widget_window() else { return };
        *widget_hwnd_cell().lock().unwrap() = Some(hwnd.0 as isize);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        *widget_hwnd_cell().lock().unwrap() = None;
    });
}
