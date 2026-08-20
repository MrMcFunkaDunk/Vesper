use crate::auth::sso::SsoConfig;

// A packaged installer has no src-tauri/.env to read at runtime (dotenvy only
// ever found it in dev because the cwd sits inside the project). These are
// the EVE SSO client id and PKCE callback port - not secrets (the client id
// is visible in the browser's address bar during login regardless), so
// baking in the same real values dev already uses is safe, and keeps env
// vars / .env working as an override for local testing.
const DEFAULT_CLIENT_ID: &str = "4a73ec879b6346a3a4c96a90723c18d5";
const DEFAULT_CALLBACK_PORT: u16 = 34761;

pub fn load() -> Result<SsoConfig, String> {
    let client_id = std::env::var("EVE_SSO_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID.to_string());
    let callback_port: u16 = match std::env::var("EVE_SSO_CALLBACK_PORT") {
        Ok(value) => value.parse().map_err(|_| "EVE_SSO_CALLBACK_PORT must be a number".to_string())?,
        Err(_) => DEFAULT_CALLBACK_PORT,
    };
    Ok(SsoConfig { client_id, callback_port })
}
