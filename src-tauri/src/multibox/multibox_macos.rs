// macOS has nothing equivalent to DWM thumbnail composition either, so this
// supplies the same kind of platform primitives multibox_linux.rs does, for
// the same shared driver in multibox_overlay_driver.rs.
//
// Unlike Windows/Linux, EVE ships a genuine native macOS client (no Wine
// involved), so a window's owner process name is a direct, reliable "is
// this EVE" signal - no title parsing needed just to find the clients.
// Per-character labels ("EVE - Name") still come from the window title,
// which - as of macOS 10.15+ - CGWindowListCopyWindowInfo only reports for
// other processes' windows once the user has granted Screen Recording
// permission; until then, every client just shows as "EVE" until the
// permission dialog (triggered automatically by the first capture attempt)
// is accepted.

use super::multibox_overlay_driver::{self, PlatformCapture};
use super::MultiboxClient;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::data::{CFDataGetBytePtr, CFDataGetLength, CFDataRef};
use std::ffi::c_void;
use std::sync::Mutex;

const EVE_OWNER_NAME: &str = "EVE";

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;
const K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const K_CG_WINDOW_IMAGE_NOMINAL_RESOLUTION: u32 = 1 << 4;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

impl CGRect {
    const NULL: CGRect = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: 0.0, height: 0.0 } };
}

type CGImageRef = *mut c_void;
type CGDataProviderRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> core_foundation_sys::array::CFArrayRef;
    fn CGWindowListCreateImage(bounds: CGRect, list_option: u32, window_id: u32, image_option: u32) -> CGImageRef;
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
    fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
    fn CGImageGetDataProvider(image: CGImageRef) -> CGDataProviderRef;
    fn CGDataProviderCopyData(provider: CGDataProviderRef) -> CFDataRef;
    fn CGImageRelease(image: CGImageRef);
    fn CFRelease(cf: *const c_void);
}

struct WindowInfo {
    window_id: u32,
    owner_pid: i32,
    owner_name: String,
    title: Option<String>,
}

fn copy_window_list() -> Vec<WindowInfo> {
    unsafe {
        let array_ref = CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            K_CG_NULL_WINDOW_ID,
        );
        if array_ref.is_null() {
            return Vec::new();
        }
        let array: CFArray<CFDictionary<CFString, CFType>> = CFArray::wrap_under_create_rule(array_ref);
        array
            .iter()
            .filter_map(|dict| {
                let window_id = dict.find(CFString::new("kCGWindowNumber"))?.downcast::<CFNumber>()?.to_i64()? as u32;
                let owner_pid = dict.find(CFString::new("kCGWindowOwnerPID"))?.downcast::<CFNumber>()?.to_i64()? as i32;
                let owner_name = dict.find(CFString::new("kCGWindowOwnerName"))?.downcast::<CFString>()?.to_string();
                let title = dict.find(CFString::new("kCGWindowName")).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string());
                Some(WindowInfo { window_id, owner_pid, owner_name, title })
            })
            .collect()
    }
}

/// CGWindowListCreateImage captures a specific window's own backing store
/// regardless of what's on top of it - it doesn't need that window to be
/// frontmost, only to exist. Returns raw RGB bytes plus dimensions; the
/// caller encodes to JPEG.
fn capture_rgb(window_id: u32) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let image = CGWindowListCreateImage(
            CGRect::NULL,
            K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
            window_id,
            K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING | K_CG_WINDOW_IMAGE_NOMINAL_RESOLUTION,
        );
        if image.is_null() {
            return None;
        }
        let width = CGImageGetWidth(image);
        let height = CGImageGetHeight(image);
        let bytes_per_row = CGImageGetBytesPerRow(image);
        if width == 0 || height == 0 {
            CGImageRelease(image);
            return None;
        }
        let provider = CGImageGetDataProvider(image);
        let data_ref = CGDataProviderCopyData(provider);
        if data_ref.is_null() {
            CGImageRelease(image);
            return None;
        }
        let ptr = CFDataGetBytePtr(data_ref);
        let len = CFDataGetLength(data_ref) as usize;
        let bytes = std::slice::from_raw_parts(ptr, len);

        // CGWindowListCreateImage's default bitmap layout is 32bpp premultiplied
        // BGRA (kCGImageAlphaPremultipliedFirst + little-endian byte order),
        // matching what real-world macOS screen-capture code assumes for this
        // exact API - unconfirmed against real hardware from here, but this is
        // the standard, documented default for CG bitmap contexts on Apple
        // Silicon and Intel alike.
        let mut rgb = Vec::with_capacity(width * height * 3);
        for row in 0..height {
            let row_start = row * bytes_per_row;
            for col in 0..width {
                let px = row_start + col * 4;
                if px + 2 >= bytes.len() {
                    break;
                }
                rgb.push(bytes[px + 2]);
                rgb.push(bytes[px + 1]);
                rgb.push(bytes[px]);
            }
        }

        CFRelease(data_ref as *const c_void);
        CGImageRelease(image);
        Some((width as u32, height as u32, rgb))
    }
}

fn run_osascript(script: &str) {
    let _ = std::process::Command::new("osascript").arg("-e").arg(script).output();
}

fn activate_pid(pid: i32) {
    run_osascript(&format!(
        "tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true"
    ));
}

fn hide_pid(pid: i32) {
    run_osascript(&format!(
        "tell application \"System Events\" to set visible of (first process whose unix id is {pid}) to false"
    ));
}

struct MacCapture {
    // The frontmost normal-layer window's id, refreshed on every enumerate()
    // call - CGWindowListCopyWindowInfo documents on-screen results as
    // ordered front-to-back, so the first EVE-owned entry is the active one.
    frontmost: Mutex<Option<u32>>,
    // window id -> owner pid, so activate/minimize (given only the id the
    // frontend round-trips) know which process to act on.
    owners: Mutex<std::collections::HashMap<u32, i32>>,
}

impl MacCapture {
    fn new() -> Self {
        MacCapture { frontmost: Mutex::new(None), owners: Mutex::new(std::collections::HashMap::new()) }
    }
}

impl PlatformCapture for MacCapture {
    fn enumerate(&self) -> Vec<MultiboxClient> {
        let windows = copy_window_list();
        let mut frontmost = None;
        let mut owners = self.owners.lock().unwrap();
        owners.clear();

        let clients: Vec<MultiboxClient> = windows
            .into_iter()
            .filter(|w| w.owner_name == EVE_OWNER_NAME)
            .map(|w| {
                if frontmost.is_none() {
                    frontmost = Some(w.window_id);
                }
                owners.insert(w.window_id, w.owner_pid);
                let character_name = w.title.as_deref().and_then(|t| t.strip_prefix("EVE - ")).map(|s| s.to_string());
                MultiboxClient { hwnd: w.window_id as isize, character_name }
            })
            .collect();

        *self.frontmost.lock().unwrap() = frontmost;
        clients
    }

    fn capture_jpeg(&self, id: isize) -> Option<Vec<u8>> {
        let (width, height, rgb) = capture_rgb(id as u32)?;
        let mut out = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut out, 70);
        encoder.encode(&rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb).ok()?;
        Some(out)
    }

    fn is_active(&self, id: isize) -> bool {
        *self.frontmost.lock().unwrap() == Some(id as u32)
    }

    fn activate(&self, id: isize) {
        if let Some(&pid) = self.owners.lock().unwrap().get(&(id as u32)) {
            activate_pid(pid);
        }
    }

    fn minimize(&self, id: isize) {
        if let Some(&pid) = self.owners.lock().unwrap().get(&(id as u32)) {
            hide_pid(pid);
        }
    }
}

pub(crate) fn is_overlay_open() -> bool {
    multibox_overlay_driver::is_overlay_open()
}

pub(crate) fn close_overlay() {
    multibox_overlay_driver::close_overlay()
}

pub(crate) fn enumerate_eve_clients() -> Vec<MultiboxClient> {
    MacCapture::new().enumerate()
}

pub(crate) fn focus_client(id: &str) -> Result<(), String> {
    let id: isize = id.parse().map_err(|_| "not a real client id".to_string())?;
    multibox_overlay_driver::focus_client(id);
    Ok(())
}

pub(crate) fn open_overlay(app: tauri::AppHandle, settings: super::MultiboxSettings) {
    multibox_overlay_driver::open_overlay(app, settings, MacCapture::new());
}
