use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

const AUTHORIZE_URL: &str = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL: &str = "https://login.eveonline.com/v2/oauth/token";
const METADATA_URL: &str = "https://login.eveonline.com/.well-known/oauth-authorization-server";

#[derive(Debug, Clone)]
pub struct SsoConfig {
    pub client_id: String,
    pub callback_port: u16,
}

impl SsoConfig {
    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}/callback", self.callback_port)
    }
}

pub fn build_authorize_url(config: &SsoConfig, scopes: &[String], state: &str, code_challenge: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("AUTHORIZE_URL is a valid URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.redirect_uri())
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    url.to_string()
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

pub async fn exchange_code(
    client: &reqwest::Client,
    config: &SsoConfig,
    code: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    post_token_request(
        client,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", code_verifier),
            ("client_id", &config.client_id),
        ],
    )
    .await
}

pub async fn refresh_token(
    client: &reqwest::Client,
    config: &SsoConfig,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    post_token_request(
        client,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &config.client_id),
        ],
    )
    .await
}

async fn post_token_request(client: &reqwest::Client, params: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let response = client
        .post(TOKEN_URL)
        .form(params)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("token endpoint returned {status}: {text}"));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("failed to parse token response: {e}"))
}

#[derive(Debug, Deserialize)]
struct AuthMetadata {
    jwks_uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StringOrVec {
    Single(String),
    Many(Vec<String>),
}

impl StringOrVec {
    fn contains(&self, needle: &str) -> bool {
        match self {
            StringOrVec::Single(s) => s == needle,
            StringOrVec::Many(v) => v.iter().any(|s| s == needle),
        }
    }

    fn into_vec(self) -> Vec<String> {
        match self {
            StringOrVec::Single(s) => vec![s],
            StringOrVec::Many(v) => v,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    name: String,
    iss: String,
    aud: StringOrVec,
    #[serde(default)]
    scp: Option<StringOrVec>,
}

pub struct VerifiedIdentity {
    pub character_id: i64,
    pub character_name: String,
    pub scopes: Vec<String>,
}

/// Verifies an EVE SSO access token's signature against CCP's published
/// JWKS and checks issuer/audience, rather than trusting the JWT's claims
/// (or its self-declared `alg`) unverified.
pub async fn verify_access_token(
    client: &reqwest::Client,
    config: &SsoConfig,
    access_token: &str,
) -> Result<VerifiedIdentity, String> {
    let metadata: AuthMetadata = client
        .get(METADATA_URL)
        .send()
        .await
        .map_err(|e| format!("failed to fetch SSO metadata: {e}"))?
        .json()
        .await
        .map_err(|e| format!("failed to parse SSO metadata: {e}"))?;

    let jwks: JwkSet = client
        .get(&metadata.jwks_uri)
        .send()
        .await
        .map_err(|e| format!("failed to fetch JWKS: {e}"))?
        .json()
        .await
        .map_err(|e| format!("failed to parse JWKS: {e}"))?;

    let header = decode_header(access_token).map_err(|e| format!("invalid token header: {e}"))?;
    let kid = header.kid.ok_or("token header is missing 'kid'")?;
    let jwk = jwks.find(&kid).ok_or("no matching signing key in CCP's JWKS")?;
    let decoding_key = DecodingKey::from_jwk(jwk).map_err(|e| format!("invalid signing key: {e}"))?;

    // Algorithm is pinned to RS256 (what EVE SSO actually issues) rather than
    // trusted from the token header, to rule out algorithm-confusion attacks.
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_aud = false; // checked manually below - EVE's aud mixes client_id with a literal "EVE Online"

    let decoded = decode::<Claims>(access_token, &decoding_key, &validation)
        .map_err(|e| format!("token signature or claims invalid: {e}"))?;
    let claims = decoded.claims;

    let iss_ok = matches!(
        claims.iss.as_str(),
        "login.eveonline.com" | "https://login.eveonline.com" | "https://login.eveonline.com/"
    );
    if !iss_ok {
        return Err(format!("unexpected token issuer: {}", claims.iss));
    }
    if !claims.aud.contains(&config.client_id) {
        return Err("token audience does not match this application's client ID".to_string());
    }

    let character_id = claims
        .sub
        .strip_prefix("CHARACTER:EVE:")
        .and_then(|id| id.parse::<i64>().ok())
        .ok_or("could not parse character ID from token subject")?;

    Ok(VerifiedIdentity {
        character_id,
        character_name: claims.name,
        scopes: claims.scp.map(StringOrVec::into_vec).unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}
