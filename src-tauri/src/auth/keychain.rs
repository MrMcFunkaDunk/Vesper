use super::sso::StoredTokens;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use std::path::PathBuf;

const SERVICE: &str = "eve-companion";
/// Fixed entry the actual per-character tokens used to live under, before
/// the encrypted-file scheme below. Kept only so store/delete can also
/// clear it out as a courtesy - a stale copy of an old (small-scope, so
/// still valid-sized) token sitting in the OS keychain is harmless but
/// there's no reason to leave it behind once a character re-authenticates.
fn legacy_entry(character_id: i64) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, &character_id.to_string()).ok()
}

/// Windows Credential Manager caps a single credential's value at 2560
/// UTF-16 characters. EVE SSO's access token is a JWT whose size grows with
/// the number of scopes it carries - harmless with a handful of scopes, but
/// this app's character detail tabs now request ~17, and access_token +
/// refresh_token bundled as one JSON blob comfortably exceeds that limit
/// (confirmed live: "Reconnect" started failing the moment the scope list
/// grew past a certain point). Rather than trying to stay under an opaque,
/// still-growing OS ceiling, the token bundle itself now lives in a local
/// file encrypted with AES-256-GCM; only the small, fixed-size encryption
/// key sits in the OS keychain, which is what actually needs OS-level
/// protection. A 32-byte key, base64-encoded, is ~44 characters - nowhere
/// close to any platform's limit no matter how many scopes get added later.
fn master_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "master-key").map_err(|e| format!("could not access OS keychain: {e}"))
}

fn load_or_create_master_key() -> Result<[u8; 32], String> {
    let entry = master_key_entry()?;
    match entry.get_password() {
        Ok(encoded) => {
            let bytes = STANDARD.decode(encoded).map_err(|e| format!("could not decode stored encryption key: {e}"))?;
            bytes.try_into().map_err(|_| "stored encryption key is the wrong length".to_string())
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(|e| format!("could not store encryption key in OS keychain: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("could not read OS keychain: {e}")),
    }
}

fn tokens_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("could not resolve local app data directory")?;
    let dir = base.join("com.vesper.eveonlinecompanionapp").join("tokens");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create token storage directory: {e}"))?;
    Ok(dir)
}

fn token_file_path(character_id: i64) -> Result<PathBuf, String> {
    Ok(tokens_dir()?.join(format!("{character_id}.bin")))
}

pub fn store_tokens(character_id: i64, tokens: &StoredTokens) -> Result<(), String> {
    let json = serde_json::to_vec(tokens).map_err(|e| format!("could not serialize tokens: {e}"))?;

    let key_bytes = load_or_create_master_key()?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher.encrypt(&nonce, json.as_slice()).map_err(|e| format!("could not encrypt tokens: {e}"))?;

    let mut out = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    std::fs::write(token_file_path(character_id)?, out).map_err(|e| format!("could not write token file: {e}"))?;

    if let Some(entry) = legacy_entry(character_id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub fn load_tokens(character_id: i64) -> Result<Option<StoredTokens>, String> {
    let path = token_file_path(character_id)?;
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read token file: {e}")),
    };
    if bytes.len() < 12 {
        return Err("stored token file is corrupt (too short)".to_string());
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(12);

    let key_bytes = load_or_create_master_key()?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key_bytes));
    let nonce = Nonce::try_from(nonce_bytes).map_err(|_| "stored token file has a malformed nonce".to_string())?;
    let plaintext = cipher.decrypt(&nonce, ciphertext).map_err(|e| format!("could not decrypt stored tokens: {e}"))?;

    serde_json::from_slice(&plaintext).map(Some).map_err(|e| format!("could not parse stored tokens: {e}"))
}

pub fn delete_tokens(character_id: i64) -> Result<(), String> {
    if let Some(entry) = legacy_entry(character_id) {
        let _ = entry.delete_credential();
    }
    match std::fs::remove_file(token_file_path(character_id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not delete token file: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for a real bug hit on Windows with keyring 3.6.3: a
    /// write via one Entry object was invisible to a read via a second Entry
    /// object for the same service+username, even immediately afterward in
    /// the same process. Kept because load_or_create_master_key follows the
    /// same "fresh Entry per call" pattern.
    #[test]
    fn round_trip_fresh_entry_instance() {
        let write_entry = keyring::Entry::new("vesper-diag-test", "probe").unwrap();
        write_entry.set_password("hello-again").expect("set_password failed");

        let read_entry = keyring::Entry::new("vesper-diag-test", "probe").unwrap();
        let read_back = read_entry.get_password().expect("get_password failed on a fresh Entry instance");
        assert_eq!(read_back, "hello-again");
        let _ = read_entry.delete_credential();
    }

    /// A large scope list should no longer blow the OS keychain's per-value
    /// limit now that the token bundle lives in an encrypted file instead.
    #[test]
    fn round_trip_large_token_bundle() {
        let character_id = -999_999; // Well outside any real EVE character id range.
        let tokens = StoredTokens {
            access_token: "a".repeat(4000),
            refresh_token: "b".repeat(1000),
            expires_at: 1_900_000_000,
        };
        store_tokens(character_id, &tokens).expect("store_tokens failed");
        let loaded = load_tokens(character_id).expect("load_tokens failed").expect("expected Some(tokens)");
        assert_eq!(loaded.access_token, tokens.access_token);
        assert_eq!(loaded.refresh_token, tokens.refresh_token);
        assert_eq!(loaded.expires_at, tokens.expires_at);
        delete_tokens(character_id).expect("delete_tokens failed");
        assert!(load_tokens(character_id).unwrap().is_none());
    }
}
