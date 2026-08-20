use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// EVE writes one log file per channel per client session to
/// `Documents\EVE\logs\Chatlogs\` (confirmed live on this machine - exact
/// casing matters on non-Windows but Windows itself is case-insensitive).
/// Filenames look like `{channel}_{yyyyMMdd}_{HHmmss}_{sessionId}.txt` and
/// the whole file (header block + chat lines) is UTF-16LE with a BOM.
fn chatlogs_dir() -> Option<PathBuf> {
    let profile = std::env::var("USERPROFILE").ok()?;
    let dir = PathBuf::from(profile).join("Documents").join("EVE").join("logs").join("Chatlogs");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

fn decode_utf16le_units(bytes: &[u8]) -> Vec<u16> {
    bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
}

fn read_utf16_file(path: &PathBuf) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let bytes = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE { &bytes[2..] } else { &bytes[..] };
    let usable = bytes.len() - (bytes.len() % 2);
    let units = decode_utf16le_units(&bytes[..usable]);
    Ok(String::from_utf16_lossy(&units).replace('\u{FEFF}', ""))
}

/// Channel name is everything before the trailing `_{date}_{time}_{sessionId}`
/// - channel names themselves can contain underscores/spaces/apostrophes
/// (e.g. "Brucey's Mining Lounge"), so this only ever splits off the known
/// fixed trailing shape rather than splitting on the first/last underscore.
fn parse_channel_name_from_filename(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".txt")?;
    let parts: Vec<&str> = stem.rsplitn(4, '_').collect();
    if parts.len() != 4 {
        return None;
    }
    if parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].len() == 6
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && parts[2].len() == 8
        && parts[2].chars().all(|c| c.is_ascii_digit())
    {
        Some(parts[3].to_string())
    } else {
        None
    }
}

struct LogHeader {
    channel_id: Option<String>,
    listener: Option<String>,
}

fn read_header(path: &PathBuf) -> LogHeader {
    let mut header = LogHeader { channel_id: None, listener: None };
    let Ok(text) = read_utf16_file(path) else { return header };
    for line in text.lines().take(10) {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Channel ID:") {
            header.channel_id = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Listener:") {
            header.listener = Some(rest.trim().to_string());
        }
    }
    header
}

/// One-on-one conversations are logged the same way named channels are, but
/// EVE gives them a `private_...` Channel ID and a "Private Chat (N)" name -
/// those aren't intel sources and shouldn't clutter the channel picker.
fn is_private_conversation(header: &LogHeader) -> bool {
    header.channel_id.as_deref().is_some_and(|id| id.starts_with("private_"))
}

fn file_modified_unix(entry: &fs::DirEntry) -> i64 {
    entry
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
pub struct IntelChannelInfo {
    pub channel_name: String,
    /// Which of your logged-in characters has been listening to this
    /// channel - the same channel name can appear once per character.
    pub listener: String,
    pub last_active: i64,
}

/// Every distinct (channel, character) pair seen in the logs folder, most
/// recently active first - lets a settings UI show "here's what's
/// available to pick as your intel channel" without the user having to
/// type an exact channel name from memory.
pub fn list_channels() -> Result<Vec<IntelChannelInfo>, String> {
    let dir = chatlogs_dir()
        .ok_or_else(|| "EVE chat logs folder not found - log in-game at least once with chat logging enabled (Settings > Chat > Log chat to file).".to_string())?;

    let mut best: HashMap<(String, String), IntelChannelInfo> = HashMap::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some(channel_name) = parse_channel_name_from_filename(file_name) else { continue };
        let header = read_header(&path);
        if is_private_conversation(&header) {
            continue;
        }
        let listener = header.listener.unwrap_or_else(|| "Unknown".to_string());
        let last_active = file_modified_unix(&entry);

        let key = (channel_name.clone(), listener.clone());
        best.entry(key)
            .and_modify(|existing| {
                if last_active > existing.last_active {
                    existing.last_active = last_active;
                }
            })
            .or_insert(IntelChannelInfo { channel_name, listener, last_active });
    }

    let mut out: Vec<IntelChannelInfo> = best.into_values().collect();
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct IntelLine {
    pub timestamp: String,
    pub speaker: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct IntelChannelPoll {
    pub lines: Vec<IntelLine>,
    pub cursor: u64,
}

/// Roughly how much backlog to show the first time a channel is watched -
/// enough for a bit of context (RIFT's own feed shows a handful of recent
/// entries) without replaying a whole multi-day session log as if it just
/// happened.
const INITIAL_BACKLOG_BYTES: u64 = 32 * 1024;

fn parse_intel_lines(text: &str) -> Vec<IntelLine> {
    let mut out = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        let Some(rest) = line.strip_prefix('[') else { continue };
        let Some(bracket_end) = rest.find(']') else { continue };
        let timestamp = rest[..bracket_end].trim().to_string();
        let after_bracket = rest[bracket_end + 1..].trim_start();
        let Some(sep_idx) = after_bracket.find(" > ") else { continue };
        let speaker = after_bracket[..sep_idx].trim().to_string();
        let message = after_bracket[sep_idx + 3..].trim().to_string();
        if speaker.is_empty() || speaker == "EVE System" {
            continue;
        }
        out.push(IntelLine { timestamp, speaker, message });
    }
    out
}

/// Finds the most-recently-modified session log file for a (channel,
/// character) pair (a channel gets a new file every time that character's
/// client (re)connects), reads whatever's new since `cursor` (a byte
/// offset - always kept 2-byte aligned since the file is UTF-16LE), and
/// returns the parsed lines plus the new cursor. A `cursor` of 0 is
/// treated as "never polled" and seeks near the end of the file instead
/// of replaying the whole session.
///
/// `listener` matters: channel names like "Local" aren't unique to one
/// character - every logged-in character gets their own "Local" log file
/// for whatever system *they're* in. Matching on channel name alone would
/// silently serve back whichever character's file happened to update most
/// recently, regardless of which character was actually selected.
pub fn poll_channel(channel_name: &str, listener: &str, cursor: u64) -> Result<IntelChannelPoll, String> {
    let dir = chatlogs_dir()
        .ok_or_else(|| "EVE chat logs folder not found.".to_string())?;

    let mut best: Option<(PathBuf, i64)> = None;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if parse_channel_name_from_filename(file_name).as_deref() != Some(channel_name) {
            continue;
        }
        let header = read_header(&path);
        if header.listener.as_deref() != Some(listener) {
            continue;
        }
        let modified = file_modified_unix(&entry);
        if best.as_ref().map_or(true, |(_, m)| modified > *m) {
            best = Some((path, modified));
        }
    }
    let Some((path, _)) = best else {
        return Ok(IntelChannelPoll { lines: Vec::new(), cursor: 0 });
    };

    let len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let start = if cursor == 0 {
        len.saturating_sub(INITIAL_BACKLOG_BYTES) / 2 * 2
    } else if cursor > len {
        // The channel reconnected mid-session (new, shorter file) - restart from its beginning.
        0
    } else {
        cursor
    };

    if start >= len {
        return Ok(IntelChannelPoll { lines: Vec::new(), cursor: start });
    }

    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let usable_len = buf.len() - (buf.len() % 2);

    let units = decode_utf16le_units(&buf[..usable_len]);
    let Some(last_newline_idx) = units.iter().rposition(|&u| u == 0x000A) else {
        // No complete line landed yet this poll - wait for the next one.
        return Ok(IntelChannelPoll { lines: Vec::new(), cursor: start });
    };

    let text = String::from_utf16_lossy(&units[..=last_newline_idx]).replace('\u{FEFF}', "");
    let new_cursor = start + ((last_newline_idx + 1) * 2) as u64;
    let lines = parse_intel_lines(&text);
    Ok(IntelChannelPoll { lines, cursor: new_cursor })
}
