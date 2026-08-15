use crate::auth::sso::SsoConfig;

pub fn load() -> Result<SsoConfig, String> {
    let client_id = std::env::var("EVE_SSO_CLIENT_ID")
        .map_err(|_| "EVE_SSO_CLIENT_ID is not set (check src-tauri/.env)".to_string())?;
    let callback_port: u16 = std::env::var("EVE_SSO_CALLBACK_PORT")
        .map_err(|_| "EVE_SSO_CALLBACK_PORT is not set (check src-tauri/.env)".to_string())?
        .parse()
        .map_err(|_| "EVE_SSO_CALLBACK_PORT must be a number".to_string())?;
    Ok(SsoConfig { client_id, callback_port })
}
