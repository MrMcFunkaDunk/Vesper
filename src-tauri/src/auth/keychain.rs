use super::sso::StoredTokens;

const SERVICE: &str = "eve-companion";

fn entry(character_id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &character_id.to_string())
        .map_err(|e| format!("could not access OS keychain: {e}"))
}

pub fn store_tokens(character_id: i64, tokens: &StoredTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| format!("could not serialize tokens: {e}"))?;
    entry(character_id)?
        .set_password(&json)
        .map_err(|e| format!("could not store tokens in OS keychain: {e}"))
}

pub fn load_tokens(character_id: i64) -> Result<Option<StoredTokens>, String> {
    match entry(character_id)?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("could not parse stored tokens: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read OS keychain: {e}")),
    }
}

pub fn delete_tokens(character_id: i64) -> Result<(), String> {
    match entry(character_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete tokens from OS keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    /// Regression test for a real bug hit on Windows with keyring 3.6.3: a
    /// write via one Entry object was invisible to a read via a second Entry
    /// object for the same service+username, even immediately afterward in
    /// the same process. Our code always creates a fresh Entry per call
    /// (see `entry()` above), so this is the exact pattern that matters.
    /// Fixed by upgrading to keyring 4.
    #[test]
    fn round_trip_fresh_entry_instance() {
        let write_entry = keyring::Entry::new("vesper-diag-test", "probe").unwrap();
        write_entry.set_password("hello-again").expect("set_password failed");

        let read_entry = keyring::Entry::new("vesper-diag-test", "probe").unwrap();
        let read_back = read_entry.get_password().expect("get_password failed on a fresh Entry instance");
        assert_eq!(read_back, "hello-again");
        let _ = read_entry.delete_credential();
    }
}
