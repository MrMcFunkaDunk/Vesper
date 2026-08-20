use serde::{Deserialize, Serialize};

/// EvE-Scout / Signal Cartel's public Thera & Turnur wormhole tracking
/// service - confirmed live via a direct request against the real endpoint
/// (not from stale docs, whose Swagger UI is JS-rendered and didn't expose
/// the schema through a plain fetch): no auth needed, returns every
/// currently-tracked signature for the named system. Response shape
/// verified against a live sample, 2026-08-20 - only the fields VESPER
/// actually renders are kept in RawScoutSignature; serde silently ignores
/// the rest (created_by_name, updated_at, completed_by_id, etc).
const SCOUT_API_BASE: &str = "https://api.eve-scout.com/v2/public/signatures";

#[derive(Deserialize)]
struct RawScoutSignature {
    id: String,
    completed: bool,
    signature_type: String,
    wh_type: Option<String>,
    max_ship_size: Option<String>,
    expires_at: String,
    remaining_hours: i64,
    out_system_name: String,
    out_signature: String,
    in_system_id: i64,
    in_system_name: String,
    in_system_class: String,
    in_region_id: i64,
    in_region_name: String,
    in_signature: String,
}

#[derive(Serialize, Clone)]
pub struct ScoutConnection {
    pub id: String,
    pub wh_type: String,
    pub max_ship_size: String,
    pub expires_at: String,
    pub remaining_hours: i64,
    pub out_system_name: String,
    pub out_signature: String,
    pub in_system_id: i64,
    pub in_system_name: String,
    pub in_system_class: String,
    pub in_region_id: i64,
    pub in_region_name: String,
    pub in_signature: String,
}

/// Live Thera or Turnur wormhole connections, filtered to confirmed
/// ("completed") wormhole signatures only - an in-progress/unconfirmed scan
/// isn't a usable connection yet. `system_name` must be "Thera" or "Turnur"
/// (eve-scout's only two tracked systems).
pub async fn fetch_scout_connections(client: &reqwest::Client, system_name: &str) -> Result<Vec<ScoutConnection>, String> {
    let url = format!("{SCOUT_API_BASE}?system_name={system_name}");
    let response = client.get(&url).send().await.map_err(|e| format!("eve-scout request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("eve-scout returned {status}"));
    }
    let raw: Vec<RawScoutSignature> = response.json().await.map_err(|e| format!("failed to parse eve-scout response: {e}"))?;

    Ok(raw
        .into_iter()
        .filter(|s| s.completed && s.signature_type == "wormhole")
        .map(|s| ScoutConnection {
            id: s.id,
            wh_type: s.wh_type.unwrap_or_else(|| "Unknown".to_string()),
            max_ship_size: s.max_ship_size.unwrap_or_else(|| "unknown".to_string()),
            expires_at: s.expires_at,
            remaining_hours: s.remaining_hours,
            out_system_name: s.out_system_name,
            out_signature: s.out_signature,
            in_system_id: s.in_system_id,
            in_system_name: s.in_system_name,
            in_system_class: s.in_system_class,
            in_region_id: s.in_region_id,
            in_region_name: s.in_region_name,
            in_signature: s.in_signature,
        })
        .collect())
}
