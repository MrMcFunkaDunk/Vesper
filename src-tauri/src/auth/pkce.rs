use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

/// RFC 7636 PKCE pair: a random verifier and its S256 challenge.
pub fn generate_pkce_pair() -> PkcePair {
    let verifier = random_url_safe_string(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair { verifier, challenge }
}

/// Random CSRF token for the OAuth `state` parameter.
pub fn generate_state() -> String {
    random_url_safe_string(16)
}

fn random_url_safe_string(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
