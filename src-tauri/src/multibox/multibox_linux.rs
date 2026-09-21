// Linux has nothing equivalent to DWM thumbnail composition, so this
// supplies just the platform primitives (enumerate/capture/focus) that
// multibox_overlay_driver.rs's shared loop needs; the loop itself opens an
// ordinary Tauri webview window per client (public/multibox-preview.html)
// and pushes it a periodic screenshot rather than a live composited
// thumbnail.
//
// EVE clients are identified the same way as on Windows: by window title
// ("EVE" at character-select, "EVE - Name" once logged in) - the game sets
// this itself regardless of OS, and under Wine it reaches X11's _NET_WM_NAME
// unchanged. There's no Windows-style exe-name cross-check available here
// (Wine's own process naming varies too much to be a reliable signal), so
// the title match carries the whole job.

use super::multibox_overlay_driver::{self, PlatformCapture};
use super::MultiboxClient;
use std::sync::Mutex;
use x11rb::connection::Connection;
use x11rb::protocol::composite::{self, Redirect};
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt, ConfigureWindowAux, EventMask, GetPropertyReply, ImageFormat, StackMode, Window,
};
use x11rb::rust_connection::RustConnection;

struct Atoms {
    net_client_list: u32,
    net_wm_name: u32,
    utf8_string: u32,
    net_active_window: u32,
    wm_change_state: u32,
}

impl Atoms {
    fn intern(conn: &RustConnection) -> Option<Self> {
        let names: [&[u8]; 5] = [b"_NET_CLIENT_LIST", b"_NET_WM_NAME", b"UTF8_STRING", b"_NET_ACTIVE_WINDOW", b"WM_CHANGE_STATE"];
        let cookies: Vec<_> = names.iter().map(|n| conn.intern_atom(false, n)).collect::<Result<_, _>>().ok()?;
        let atoms: Vec<u32> = cookies.into_iter().map(|c| c.reply().map(|r| r.atom)).collect::<Result<_, _>>().ok()?;
        Some(Atoms {
            net_client_list: atoms[0],
            net_wm_name: atoms[1],
            utf8_string: atoms[2],
            net_active_window: atoms[3],
            wm_change_state: atoms[4],
        })
    }
}

struct LinuxCapture {
    // A fresh connection per call would work too, but holding one open for
    // the overlay's lifetime avoids reconnecting every second.
    conn: Mutex<RustConnection>,
    root: Window,
    atoms: Atoms,
}

impl LinuxCapture {
    fn connect() -> Option<Self> {
        let (conn, screen_num) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots[screen_num].root;
        let atoms = Atoms::intern(&conn)?;
        Some(LinuxCapture { conn: Mutex::new(conn), root, atoms })
    }
}

fn window_property(conn: &RustConnection, window: Window, property: u32, type_: u32) -> Option<GetPropertyReply> {
    conn.get_property(false, window, property, type_, 0, u32::MAX).ok()?.reply().ok()
}

fn window_title(conn: &RustConnection, window: Window, atoms: &Atoms) -> Option<String> {
    let reply = window_property(conn, window, atoms.net_wm_name, atoms.utf8_string)?;
    if reply.value.is_empty() {
        return None;
    }
    String::from_utf8(reply.value).ok()
}

/// Captures the window's current contents via XComposite's off-screen
/// redirect + a plain GetImage over the wire - no MIT-SHM, which keeps this
/// simple at the cost of copying the full frame through the X11 socket every
/// tick. Fine at a deliberately low refresh rate for a thumbnail-sized use
/// case.
fn capture_rgb(conn: &RustConnection, window: Window) -> Option<(u16, u16, Vec<u8>)> {
    let geom = conn.get_geometry(window).ok()?.reply().ok()?;
    if geom.width == 0 || geom.height == 0 {
        return None;
    }
    composite::redirect_window(conn, window, Redirect::AUTOMATIC).ok()?.check().ok()?;
    let pixmap = conn.generate_id().ok()?;
    composite::name_window_pixmap(conn, window, pixmap).ok()?.check().ok()?;
    let image = conn
        .get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, geom.width, geom.height, !0)
        .ok()?
        .reply()
        .ok();
    let _ = conn.free_pixmap(pixmap);
    let image = image?;

    // X11's Z_PIXMAP over a TrueColor visual is BGRX/BGRA on essentially
    // every real desktop.
    let bgrx = image.data;
    let expected = geom.width as usize * geom.height as usize * 4;
    if bgrx.len() < expected {
        return None;
    }
    let mut rgb = Vec::with_capacity(geom.width as usize * geom.height as usize * 3);
    for px in bgrx.chunks_exact(4) {
        rgb.push(px[2]);
        rgb.push(px[1]);
        rgb.push(px[0]);
    }
    Some((geom.width, geom.height, rgb))
}

impl PlatformCapture for LinuxCapture {
    fn enumerate(&self) -> Vec<MultiboxClient> {
        let conn = self.conn.lock().unwrap();
        let Some(reply) = window_property(&conn, self.root, self.atoms.net_client_list, AtomEnum::WINDOW.into()) else { return Vec::new() };
        let Some(windows) = reply.value32() else { return Vec::new() };
        windows
            .filter_map(|window| {
                let title = window_title(&conn, window, &self.atoms)?;
                if title != "EVE" && !title.starts_with("EVE - ") {
                    return None;
                }
                let character_name = title.strip_prefix("EVE - ").map(|s| s.to_string());
                Some(MultiboxClient { hwnd: window as isize, character_name })
            })
            .collect()
    }

    fn capture_jpeg(&self, id: isize) -> Option<Vec<u8>> {
        let conn = self.conn.lock().unwrap();
        let (width, height, rgb) = capture_rgb(&conn, id as Window)?;
        let mut out = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut out, 70);
        encoder.encode(&rgb, width, height, jpeg_encoder::ColorType::Rgb).ok()?;
        Some(out)
    }

    fn is_active(&self, id: isize) -> bool {
        let conn = self.conn.lock().unwrap();
        let Some(reply) = window_property(&conn, self.root, self.atoms.net_active_window, AtomEnum::WINDOW.into()) else { return false };
        reply.value32().and_then(|mut v| v.next()) == Some(id as Window)
    }

    fn activate(&self, id: isize) {
        let conn = self.conn.lock().unwrap();
        let window = id as Window;
        // Ask the window manager to deiconify + raise + focus per the EWMH
        // spec - the same request a taskbar click sends. Falls back to a
        // plain map+raise for window managers that don't implement
        // _NET_ACTIVE_WINDOW.
        let event = ClientMessageEvent::new(32, window, self.atoms.net_active_window, ClientMessageData::from([1u32, 0, 0, 0, 0]));
        let sent = conn
            .send_event(false, self.root, EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT, event)
            .ok()
            .and_then(|c| c.check().ok())
            .is_some();
        if !sent {
            let _ = conn.map_window(window);
            let _ = conn.configure_window(window, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
        }
        let _ = conn.flush();
    }

    fn minimize(&self, id: isize) {
        let conn = self.conn.lock().unwrap();
        let window = id as Window;
        // ICCCM WM_CHANGE_STATE(IconicState) is the standard "please
        // iconify this window for me" request, same shape as
        // _NET_ACTIVE_WINDOW above.
        let event = ClientMessageEvent::new(32, window, self.atoms.wm_change_state, ClientMessageData::from([3u32, 0, 0, 0, 0]));
        let _ = conn
            .send_event(false, self.root, EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT, event)
            .ok()
            .and_then(|c| c.check().ok());
        let _ = conn.flush();
    }
}

pub(crate) fn is_overlay_open() -> bool {
    multibox_overlay_driver::is_overlay_open()
}

pub(crate) fn close_overlay() {
    multibox_overlay_driver::close_overlay()
}

pub(crate) fn enumerate_eve_clients() -> Vec<MultiboxClient> {
    LinuxCapture::connect().map(|c| c.enumerate()).unwrap_or_default()
}

pub(crate) fn focus_client(id: &str) -> Result<(), String> {
    let id: isize = id.parse().map_err(|_| "not a real client id".to_string())?;
    multibox_overlay_driver::focus_client(id);
    Ok(())
}

pub(crate) fn open_overlay(app: tauri::AppHandle, settings: super::MultiboxSettings) {
    let Some(capture) = LinuxCapture::connect() else { return };
    multibox_overlay_driver::open_overlay(app, settings, capture);
}
