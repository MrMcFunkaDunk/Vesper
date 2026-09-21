// The overlay lifecycle (poll for clients, open/close a preview window per
// client, push a frame at a steady low rate, clean up on close) is
// identical on Linux and macOS - only how you enumerate/capture/focus a
// window differs. Each platform module implements PlatformCapture with
// just those primitives and hands it to open_overlay() here, instead of
// each reimplementing this same driver loop.

use super::{MultiboxClient, MultiboxSettings};
use base64::Engine;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

const POLL_INTERVAL_MS: u64 = 1000;
const FRAME_INTERVAL_MS: u64 = 250;
const PREVIEW_LABEL_PREFIX: &str = "multibox-";

pub(crate) trait PlatformCapture: Send + Sync + 'static {
    fn enumerate(&self) -> Vec<MultiboxClient>;
    fn capture_jpeg(&self, id: isize) -> Option<Vec<u8>>;
    fn is_active(&self, id: isize) -> bool;
    fn activate(&self, id: isize);
    fn minimize(&self, id: isize);
}

struct Overlay {
    stop: Arc<AtomicBool>,
    capture: Arc<dyn PlatformCapture>,
}

static OVERLAY: OnceLock<Mutex<Option<Overlay>>> = OnceLock::new();

fn overlay_cell() -> &'static Mutex<Option<Overlay>> {
    OVERLAY.get_or_init(|| Mutex::new(None))
}

pub(crate) fn is_overlay_open() -> bool {
    overlay_cell().lock().unwrap().is_some()
}

pub(crate) fn close_overlay() {
    if let Some(overlay) = overlay_cell().lock().unwrap().take() {
        overlay.stop.store(true, Ordering::SeqCst);
    }
}

/// Best-effort - a stale/unknown id (the window closed a moment ago) is
/// simply ignored rather than surfaced as an error.
pub(crate) fn focus_client(id: isize) {
    if let Some(overlay) = overlay_cell().lock().unwrap().as_ref() {
        overlay.capture.activate(id);
    }
}

fn preview_label(client_id: isize) -> String {
    format!("{PREVIEW_LABEL_PREFIX}{client_id}")
}

fn css_rgb((r, g, b): (u8, u8, u8)) -> String {
    format!("rgb({r},{g},{b})")
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(crate) fn open_overlay(app: tauri::AppHandle, settings: MultiboxSettings, capture: impl PlatformCapture) {
    if is_overlay_open() {
        return;
    }
    let capture: Arc<dyn PlatformCapture> = Arc::new(capture);
    let stop = Arc::new(AtomicBool::new(false));
    *overlay_cell().lock().unwrap() = Some(Overlay { stop: stop.clone(), capture: capture.clone() });

    let shared_settings = Arc::new(Mutex::new(settings));
    *super::live_settings_cell().lock().unwrap() = Some(shared_settings.clone());

    std::thread::spawn(move || {
        let mut open_windows: HashMap<isize, MultiboxClient> = HashMap::new();
        let mut last_frame = std::time::Instant::now() - std::time::Duration::from_secs(1);

        while !stop.load(Ordering::SeqCst) {
            let live = capture.enumerate();
            let live_ids: Vec<isize> = live.iter().map(|c| c.hwnd).collect();

            let gone: Vec<isize> = open_windows.keys().copied().filter(|id| !live_ids.contains(id)).collect();
            for id in gone {
                open_windows.remove(&id);
                close_preview_window(&app, id);
            }

            for client in &live {
                if open_windows.contains_key(&client.hwnd) {
                    continue;
                }
                open_windows.insert(client.hwnd, client.clone());
                spawn_preview_window(&app, client, &shared_settings);
            }

            if last_frame.elapsed().as_millis() as u64 >= FRAME_INTERVAL_MS {
                last_frame = std::time::Instant::now();
                let settings = shared_settings.lock().unwrap().clone();
                for client in &live {
                    push_frame(&app, capture.as_ref(), client, &settings);
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS.min(FRAME_INTERVAL_MS)));
        }

        let ids: Vec<isize> = open_windows.keys().copied().collect();
        for id in ids {
            close_preview_window(&app, id);
        }
        *super::live_settings_cell().lock().unwrap() = None;
    });
}

fn close_preview_window(app: &tauri::AppHandle, id: isize) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window(&preview_label(id)) {
            let _ = win.close();
        }
    });
}

fn spawn_preview_window(app: &tauri::AppHandle, client: &MultiboxClient, shared_settings: &Arc<Mutex<MultiboxSettings>>) {
    let app = app.clone();
    let client = client.clone();
    let shared_settings = shared_settings.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let label = preview_label(client.hwnd);
        if app.get_webview_window(&label).is_some() {
            return;
        }
        let name = client.character_name.clone().unwrap_or_else(|| "Character Select".to_string());
        let settings = shared_settings.lock().unwrap();
        let layout = settings.layouts.get(&name).copied();
        let (x, y) = if settings.remember_positions { layout.filter(|l| l.x != 0 || l.y != 0).map(|l| (l.x, l.y)) } else { None }
            .unwrap_or((60, 60));
        let (width, height) = if settings.unique_layout_per_client {
            layout.filter(|l| l.width > 0 && l.height > 0).map(|l| (l.width, l.height))
        } else {
            None
        }
        .unwrap_or((settings.default_width, settings.default_height));
        let always_on_top = settings.always_on_top;
        drop(settings);

        let url = format!("multibox-preview.html?client={}&label={}", client.hwnd, urlencoding_encode(&name));
        let built = tauri::WebviewWindowBuilder::new(&app, label.clone(), tauri::WebviewUrl::App(url.into()))
            .title(name.as_str())
            .position(x as f64, y as f64)
            .inner_size(width as f64, height as f64)
            .decorations(false)
            .always_on_top(always_on_top)
            .skip_taskbar(true)
            .resizable(true)
            .build();

        if let Ok(win) = built {
            let win_for_layout = win.clone();
            let label_for_layout = name.clone();
            let app_for_layout = app.clone();
            win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                    if let (Ok(pos), Ok(size)) = (win_for_layout.outer_position(), win_for_layout.outer_size()) {
                        let _ =
                            super::save_client_layout(&app_for_layout, label_for_layout.clone(), pos.x, pos.y, size.width as i32, size.height as i32);
                    }
                }
            });
        }
    });
}

fn push_frame(app: &tauri::AppHandle, capture: &dyn PlatformCapture, client: &MultiboxClient, settings: &MultiboxSettings) {
    let Some(jpeg) = capture.capture_jpeg(client.hwnd) else { return };
    let name = client.character_name.clone().unwrap_or_else(|| "Character Select".to_string());
    let active = capture.is_active(client.hwnd);
    let force_hidden = settings.force_hidden.get(&name).copied().unwrap_or(false);
    let hidden = force_hidden || (settings.hide_active_preview && active);

    if settings.minimize_inactive_clients && !active {
        capture.minimize(client.hwnd);
    }

    let payload = serde_json::json!({
        "image": base64::engine::general_purpose::STANDARD.encode(jpeg),
        "opacity": settings.opacity as f32 / 255.0,
        "showOverlay": settings.show_overlay,
        "labelAtBottom": settings.label_at_bottom,
        "labelSize": settings.label_size,
        "labelColor": css_rgb(settings.label_color),
        "name": name,
        "active": active,
        "highlightActive": settings.highlight_active,
        "highlightColor": css_rgb(settings.highlight_color),
        "showFrames": settings.show_frames,
        "frameColor": css_rgb(settings.frame_color),
        "zoomFactor": settings.zoom_factor,
        "zoomAnchor": settings.zoom_anchor,
        "zoomOnHover": settings.zoom_on_hover,
        "hidden": hidden,
    });
    let _ = app.emit_to(preview_label(client.hwnd), "multibox-frame", payload);
}
