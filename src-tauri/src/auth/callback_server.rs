use std::collections::HashMap;
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
pub fn bind(port: u16) -> Result<tiny_http::Server, String> {
    tiny_http::Server::http(("127.0.0.1", port))
        .map_err(|e| format!("failed to bind local callback server on port {port}: {e}"))
}

/// Blocks the calling thread until the OAuth redirect hits `/callback`,
/// then serves a short confirmation page and returns the parsed params.
pub fn wait_for_request(server: tiny_http::Server) -> Result<CallbackResult, String> {
    let deadline = Instant::now() + Duration::from_secs(300);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for the EVE SSO login to complete".to_string());
        }

        let request = match server.recv_timeout(remaining) {
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
