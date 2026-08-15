use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub struct CallbackResult {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

const CALLBACK_HTML: &str = r#"<!doctype html>
<html>
<head><meta charset="utf-8"><title>EVE Companion</title></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background:#0a0c11; color:#e7e9ee; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
<p>You're signed in. You can close this window and return to EVE Companion.</p>
</body>
</html>"#;

/// Binds the loopback listener. Callers should open the system browser only
/// after this succeeds, so the redirect always has a listener waiting.
///
/// Retries briefly on failure: if a previous login attempt was abandoned
/// (browser closed without finishing, app reloaded mid-flow), its listener
/// is still holding the port until `wait_for_request` notices the login
/// generation moved on and gives it up - this covers that short window
/// instead of failing the new attempt outright.
pub fn bind(port: u16) -> Result<tiny_http::Server, String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(server) => return Ok(server),
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("failed to bind local callback server on port {port}: {e}"));
                }
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
}

/// Blocks the calling thread until the OAuth redirect hits `/callback`,
/// then serves a short confirmation page and returns the parsed params.
///
/// Polls in short slices rather than waiting the full remaining timeout in
/// one blocking call, so it can notice `current_generation` moving past
/// `my_generation` (a newer login superseded this one) and give up the port
/// promptly instead of holding it for the rest of the 5-minute timeout.
pub fn wait_for_request(
    server: tiny_http::Server,
    my_generation: u64,
    current_generation: &AtomicU64,
) -> Result<CallbackResult, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let poll_interval = Duration::from_millis(500);

    loop {
        if current_generation.load(Ordering::SeqCst) != my_generation {
            return Err("superseded by a newer sign-in attempt".to_string());
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for the EVE SSO login to complete".to_string());
        }

        let request = match server.recv_timeout(remaining.min(poll_interval)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(e) => return Err(format!("local callback server error: {e}")),
        };

        if !request.url().starts_with("/callback") {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        }

        let query = request.url().split_once('?').map(|(_, q)| q).unwrap_or("");
        let params: HashMap<String, String> =
            url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();

        let header =
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .expect("static header is valid");
        let response = tiny_http::Response::from_string(CALLBACK_HTML).with_header(header);
        let _ = request.respond(response);

        return Ok(CallbackResult {
            code: params.get("code").cloned(),
            state: params.get("state").cloned(),
            error: params.get("error").cloned(),
        });
    }
}
