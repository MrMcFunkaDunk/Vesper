pub mod callback_server;
pub mod keychain;
pub mod pkce;
pub mod sso;

use sso::SsoConfig;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use tokio::sync::Mutex;

// EVE SSO rotates the refresh token on each use, so two concurrent refreshes
// for the same (or even different) characters can race and clobber each
// other's write to the keychain. A single global lock serializes all
// refreshes; they're infrequent and fast enough that this costs nothing
// noticeable for a personal app with a handful of characters.
static REFRESH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

// Bumped at the start of every login attempt. Lets an abandoned attempt's
// callback listener (browser closed without finishing, app reloaded
// mid-flow) notice it's been superseded and give up the port promptly
// instead of holding it for its full 5-minute timeout, which would make
// every login attempt after it silently fail to bind.
static LOGIN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Cancels whatever login attempt is currently in flight (if any) by the
/// same mechanism an abandoned attempt gets superseded by: its callback
/// listener notices within one poll interval and gives up the port, which
/// makes the in-flight `login()` call return an error promptly instead of
/// the caller being stuck until the 5-minute timeout.
pub fn cancel_login() {
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub struct LoginOutcome {
    pub character_id: i64,
    pub character_name: String,
    pub scopes: Vec<String>,
}

/// Runs one full EVE SSO login: opens the system browser, waits on the
/// loopback server for the redirect, exchanges the code via PKCE, verifies
/// the resulting JWT against CCP's JWKS, and stores tokens in the keychain.
pub async fn login(
    client: &reqwest::Client,
    config: &SsoConfig,
    scopes: Vec<String>,
) -> Result<LoginOutcome, String> {
    let pair = pkce::generate_pkce_pair();
    let state = pkce::generate_state();
    let authorize_url = sso::build_authorize_url(config, &scopes, &state, &pair.challenge);

    // Superseding the generation first means an old abandoned attempt's
    // listener notices and releases the port within one poll interval,
    // rather than racing it for the bind below.
    let my_generation = LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // Bind before opening the browser so the redirect always has a listener.
    let port = config.callback_port;
    let server = tauri::async_runtime::spawn_blocking(move || callback_server::bind(port))
        .await
        .map_err(|e| format!("callback server setup task failed: {e}"))??;
    let callback_task = tauri::async_runtime::spawn_blocking(move || {
        callback_server::wait_for_request(server, my_generation, &LOGIN_GENERATION)
    });

    open::that(&authorize_url).map_err(|e| format!("could not open system browser: {e}"))?;

    let callback = callback_task
        .await
        .map_err(|e| format!("callback server task failed: {e}"))??;

    if let Some(error) = callback.error {
        return Err(format!("EVE SSO login was not completed: {error}"));
    }
    let code = callback.code.ok_or("EVE SSO did not return an authorization code")?;
    let returned_state = callback.state.ok_or("EVE SSO callback was missing state")?;
    if returned_state != state {
        return Err("OAuth state did not match - possible tampering, login aborted".to_string());
    }

    let token_response = sso::exchange_code(client, config, &code, &pair.verifier).await?;
    let identity = sso::verify_access_token(client, config, &token_response.access_token).await?;

    keychain::store_tokens(
        identity.character_id,
        &sso::StoredTokens {
            access_token: token_response.access_token,
            refresh_token: token_response.refresh_token,
            expires_at: now_unix() + token_response.expires_in,
        },
    )?;

    Ok(LoginOutcome {
        character_id: identity.character_id,
        character_name: identity.character_name,
        scopes: identity.scopes,
    })
}

/// Refreshes a character's stored access token if it's expired or close to it.
pub async fn ensure_fresh_token(
    client: &reqwest::Client,
    config: &SsoConfig,
    character_id: i64,
) -> Result<(), String> {
    let _guard = REFRESH_LOCK.lock().await;

    let Some(tokens) = keychain::load_tokens(character_id)? else {
        return Err("no stored session for this character".to_string());
    };

    if tokens.expires_at - now_unix() > 60 {
        return Ok(());
    }

    let refreshed = sso::refresh_token(client, config, &tokens.refresh_token).await?;
    keychain::store_tokens(
        character_id,
        &sso::StoredTokens {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            expires_at: now_unix() + refreshed.expires_in,
        },
    )
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
