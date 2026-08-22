//! Abyssal (mutaplasmid-rolled) module pricing - the one item on VESPER's
//! roadmap that genuinely needs a third-party data source, since a rolled
//! item's real stats are unique per-item and aren't in the SDE at all.
//! Two public, unauthenticated APIs combine to answer "what's this
//! specific owned item actually worth": ESI's own dynamic-item endpoint
//! (confirms an item is mutated at all, and returns its real rolled dogma
//! attributes) and MutaMarket's public API (a community-run site with a
//! machine-learning price estimate trained on real abyssal module sales -
//! verified live against mutamarket.com's own API before writing any of
//! this, not guessed: base URL is `https://mutamarket.com/api`, no auth
//! required, confirmed by fetching `/abyssal-type-statistics` directly).
use crate::esi::ESI_BASE;
use serde::{Deserialize, Serialize};

const MUTAMARKET_BASE: &str = "https://mutamarket.com/api";

#[derive(Deserialize)]
struct EsiDynamicAttribute {
    attribute_id: i64,
    value: f64,
}

#[derive(Deserialize)]
struct EsiDynamicItem {
    #[serde(default)]
    dogma_attributes: Vec<EsiDynamicAttribute>,
    mutator_type_id: i64,
    source_type_id: i64,
}

/// Checks whether one specific owned item (its real ESI item_id, not just
/// its type_id) is actually a mutated/dynamic item - there's no flag on
/// the asset list itself, the only way to know is to ask this endpoint
/// directly. A 404 here just means "not mutated," a completely normal,
/// expected outcome for the vast majority of items - not an error.
async fn fetch_dynamic_item(client: &reqwest::Client, type_id: i64, item_id: i64) -> Result<Option<EsiDynamicItem>, String> {
    let url = format!("{ESI_BASE}/dogma/dynamic/items/{type_id}/{item_id}/");
    let response = client.get(&url).send().await.map_err(|e| format!("ESI dynamic-item request failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("ESI {status} on dynamic item lookup: {text}"));
    }
    response.json::<EsiDynamicItem>().await.map(Some).map_err(|e| format!("failed to parse ESI dynamic item response: {e}"))
}

#[derive(Deserialize)]
struct MutaMarketUnit {
    display_name: String,
}

#[derive(Deserialize)]
struct MutaMarketAttribute {
    display_name: String,
    value: f64,
    base_value: f64,
    #[serde(default)]
    unit: Option<MutaMarketUnit>,
}

#[derive(Deserialize)]
struct MutaMarketModuleResponse {
    estimated_value: Option<f64>,
    #[serde(default)]
    mutated_attributes: Vec<MutaMarketAttribute>,
}

/// Asks MutaMarket (a community-run site, not CCP/ESI) for its
/// machine-learning ISK estimate for one specific item - it re-imports the
/// item from ESI itself using the same ids, so this only needs to be
/// called once mutation is already confirmed above.
async fn fetch_mutamarket_estimate(client: &reqwest::Client, type_id: i64, item_id: i64) -> Result<MutaMarketModuleResponse, String> {
    let response = client
        .post(format!("{MUTAMARKET_BASE}/modules"))
        .json(&serde_json::json!({ "type_id": type_id, "item_id": item_id }))
        .send()
        .await
        .map_err(|e| format!("MutaMarket request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("MutaMarket {status}: {text}"));
    }
    response.json::<MutaMarketModuleResponse>().await.map_err(|e| format!("failed to parse MutaMarket response: {e}"))
}

#[derive(Serialize, Clone)]
pub struct AbyssalRolledAttribute {
    pub name: String,
    pub value: f64,
    pub base_value: f64,
    pub unit: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AbyssalValueResult {
    pub source_type_id: i64,
    pub mutator_type_id: i64,
    /// MutaMarket occasionally has no estimate yet for a very rare roll -
    /// still worth showing the rolled attributes even without a number.
    pub estimated_value: Option<f64>,
    pub rolled_attributes: Vec<AbyssalRolledAttribute>,
}

/// None means "not a mutated item" (the normal case for almost every
/// asset) - Some means it genuinely is one, with MutaMarket's estimate
/// attached.
pub async fn check_abyssal_value(client: &reqwest::Client, type_id: i64, item_id: i64) -> Result<Option<AbyssalValueResult>, String> {
    let Some(dynamic) = fetch_dynamic_item(client, type_id, item_id).await? else {
        return Ok(None);
    };
    let estimate = fetch_mutamarket_estimate(client, type_id, item_id).await?;
    let rolled_attributes = if !estimate.mutated_attributes.is_empty() {
        estimate
            .mutated_attributes
            .into_iter()
            .map(|a| AbyssalRolledAttribute { name: a.display_name, value: a.value, base_value: a.base_value, unit: a.unit.map(|u| u.display_name) })
            .collect()
    } else {
        // Fall back to ESI's own raw attribute list (id only, no display
        // name) if MutaMarket's response didn't carry the named breakdown
        // for some reason - still real numbers, just less readable.
        dynamic
            .dogma_attributes
            .iter()
            .map(|a| AbyssalRolledAttribute { name: format!("Attribute #{}", a.attribute_id), value: a.value, base_value: 0.0, unit: None })
            .collect()
    };
    Ok(Some(AbyssalValueResult {
        source_type_id: dynamic.source_type_id,
        mutator_type_id: dynamic.mutator_type_id,
        estimated_value: estimate.estimated_value,
        rolled_attributes,
    }))
}
