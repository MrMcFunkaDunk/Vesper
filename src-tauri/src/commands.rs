use crate::{abyssal, asset_history, auth, characters, combat_overlay, config, esi, fittings, intel_feed, kill_history, kills, map, market, multibox, news, pi, price_widget, route, scout, settings_sync, skillplans, wars, wormholes};
use futures::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, State};

pub struct AppState {
    pub http_client: reqwest::Client,
}

fn portrait_url(id: i64) -> String {
    format!("https://images.evetech.net/characters/{id}/portrait?size=128")
}

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    state: State<'_, AppState>,
    scopes: Vec<String>,
) -> Result<(), String> {
    let config = config::load()?;
    let outcome = auth::login(&state.http_client, &config, scopes).await?;

    characters::upsert_character(
        &app,
        characters::CharacterRecord {
            id: outcome.character_id,
            name: outcome.character_name,
            scopes: outcome.scopes,
            added_at: now_unix(),
        },
    )?;
    characters::set_active(&app, outcome.character_id)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_login() {
    auth::cancel_login();
}

#[tauri::command]
pub async fn get_server_status(state: State<'_, AppState>) -> Result<esi::ServerStatus, String> {
    Ok(esi::fetch_server_status(&state.http_client).await)
}

#[derive(Serialize)]
pub struct SessionCharacter {
    pub id: i64,
    pub name: String,
    pub scopes: Vec<String>,
    pub portrait_url: String,
}

#[derive(Serialize)]
pub struct Session {
    pub characters: Vec<SessionCharacter>,
    pub active_character_id: Option<i64>,
}

#[tauri::command]
pub async fn get_session(app: AppHandle, state: State<'_, AppState>) -> Result<Session, String> {
    let (records, active_id) = characters::list_characters(&app)?;
    let config = config::load()?;

    let out: Vec<SessionCharacter> = records
        .iter()
        .map(|record| SessionCharacter {
            id: record.id,
            name: record.name.clone(),
            scopes: record.scopes.clone(),
            portrait_url: portrait_url(record.id),
        })
        .collect();

    // Best-effort silent refresh, now backgrounded rather than awaited before
    // returning - a stale/revoked token still lets every character show up
    // immediately, and any command that actually needs a token refreshes it
    // itself via get_access_token anyway. Previously this loop blocked the
    // whole session load on one refresh round trip per saved character,
    // which meant startup got slower the more alts were logged in.
    let client = state.http_client.clone();
    tauri::async_runtime::spawn(async move {
        for record in records {
            let _ = auth::ensure_fresh_token(&client, &config, record.id).await;
        }
    });

    Ok(Session { characters: out, active_character_id: active_id })
}

#[tauri::command]
pub fn set_active_character(app: AppHandle, id: i64) -> Result<(), String> {
    characters::set_active(&app, id)
}

#[tauri::command]
pub fn logout_character(app: AppHandle, id: i64) -> Result<(), String> {
    auth::keychain::delete_tokens(id)?;
    characters::remove_character(&app, id)
}

#[tauri::command]
pub async fn get_character_overview(
    state: State<'_, AppState>,
    id: i64,
) -> Result<esi::CharacterOverview, String> {
    let config = config::load()?;
    esi::fetch_character_overview(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_skills(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterSkills, String> {
    let config = config::load()?;
    esi::fetch_character_skills(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_location(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterLocation, String> {
    let config = config::load()?;
    esi::fetch_character_location(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_all_skills(state: State<'_, AppState>) -> Result<Vec<esi::AllSkillEntry>, String> {
    esi::fetch_all_skills(&state.http_client).await
}

#[tauri::command]
pub async fn get_character_skill_queue(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterSkillQueue, String> {
    let config = config::load()?;
    esi::fetch_character_skill_queue(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_employment_history(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<esi::EmploymentEntry>, String> {
    esi::fetch_character_employment_history(&state.http_client, id).await
}

#[tauri::command]
pub async fn get_character_clones(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterClones, String> {
    let config = config::load()?;
    esi::fetch_character_clones(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_attributes(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterAttributes, String> {
    let config = config::load()?;
    esi::fetch_character_attributes(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_research(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterResearch, String> {
    let config = config::load()?;
    esi::fetch_character_research(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_fw_stats(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterFwStats, String> {
    let config = config::load()?;
    esi::fetch_character_fw_stats(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_standings(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterStandings, String> {
    let config = config::load()?;
    esi::fetch_character_standings(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_contacts(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterContacts, String> {
    let config = config::load()?;
    esi::fetch_character_contacts(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_medals(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMedals, String> {
    let config = config::load()?;
    esi::fetch_character_medals(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_loyalty(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterLoyalty, String> {
    let config = config::load()?;
    esi::fetch_character_loyalty(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_mining_ledger(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMiningLedger, String> {
    let config = config::load()?;
    esi::fetch_character_mining_ledger(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_loyalty_store_offers(state: State<'_, AppState>, corporation_id: i64) -> Result<Vec<esi::LoyaltyStoreOffer>, String> {
    esi::fetch_loyalty_store_offers(&state.http_client, corporation_id).await
}

#[tauri::command]
pub async fn check_abyssal_value(state: State<'_, AppState>, type_id: i64, item_id: i64) -> Result<Option<abyssal::AbyssalValueResult>, String> {
    abyssal::check_abyssal_value(&state.http_client, type_id, item_id).await
}

#[tauri::command]
pub fn record_asset_snapshot(app: AppHandle, character_id: i64, total_value: f64) -> Result<(), String> {
    asset_history::record_snapshot(&app, character_id, total_value)
}

#[tauri::command]
pub fn get_asset_history(app: AppHandle, character_id: i64) -> Result<Vec<asset_history::AssetSnapshot>, String> {
    asset_history::get_history(&app, character_id)
}

#[tauri::command]
pub async fn get_character_assets(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterAssets, String> {
    let config = config::load()?;
    esi::fetch_character_assets(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_market_orders(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMarketOrders, String> {
    let config = config::load()?;
    esi::fetch_character_market_orders(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_contracts(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterContracts, String> {
    let config = config::load()?;
    esi::fetch_character_contracts(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_contract_items(
    state: State<'_, AppState>,
    id: i64,
    contract_id: i64,
) -> Result<Vec<esi::ContractItemEntry>, String> {
    let config = config::load()?;
    esi::fetch_contract_items(&state.http_client, &config, id, contract_id).await
}

#[tauri::command]
pub async fn get_character_calendar(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterCalendar, String> {
    let config = config::load()?;
    esi::fetch_character_calendar(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_calendar_event_detail(
    state: State<'_, AppState>,
    id: i64,
    event_id: i64,
) -> Result<esi::CalendarEventDetail, String> {
    let config = config::load()?;
    esi::fetch_calendar_event_detail(&state.http_client, &config, id, event_id).await
}

#[tauri::command]
pub async fn list_fits(app: AppHandle) -> Result<Vec<fittings::FitDetail>, String> {
    fittings::list_fits(app).await
}

#[tauri::command]
pub async fn get_fit(app: AppHandle, id: String) -> Result<fittings::FitDetail, String> {
    fittings::get_fit(app, id).await
}

#[tauri::command]
pub async fn save_fit(app: AppHandle, input: fittings::FitInput) -> Result<String, String> {
    fittings::save_fit(app, input).await
}

#[tauri::command]
pub async fn delete_fit(app: AppHandle, id: String) -> Result<(), String> {
    fittings::delete_fit(app, id).await
}

#[tauri::command]
pub async fn sync_character_fittings(app: AppHandle, state: State<'_, AppState>, character_id: i64) -> Result<usize, String> {
    let config = config::load()?;
    fittings::sync_character_fittings(app, state.http_client.clone(), config, character_id).await
}

#[tauri::command]
pub async fn send_fit_to_character(
    app: AppHandle,
    state: State<'_, AppState>,
    character_id: i64,
    fit_id: String,
) -> Result<i64, String> {
    let config = config::load()?;
    fittings::send_fit_to_character(app, state.http_client.clone(), config, character_id, fit_id).await
}

#[tauri::command]
pub async fn get_fit_cost(app: AppHandle, state: State<'_, AppState>, fit_id: String) -> Result<f64, String> {
    fittings::get_fit_cost(app, state.http_client.clone(), fit_id).await
}

#[tauri::command]
pub async fn export_fit_eft(app: AppHandle, state: State<'_, AppState>, fit_id: String) -> Result<String, String> {
    fittings::export_fit_eft(app, state.http_client.clone(), fit_id).await
}

#[tauri::command]
pub async fn export_fit_dna(app: AppHandle, fit_id: String) -> Result<String, String> {
    fittings::export_fit_dna(app, fit_id).await
}

/// Region-wide public contract browser - a token isn't required for the
/// listing itself, but improves location-name resolution for player
/// structures, so this best-effort-grabs one the same way
/// get_player_structures does.
#[tauri::command]
pub async fn get_public_contracts(app: AppHandle, state: State<'_, AppState>, region_id: i64) -> Result<Vec<esi::PublicContractEntry>, String> {
    let config = config::load()?;
    let (records, _) = characters::list_characters(&app)?;
    let mut access_token = None;
    for record in &records {
        if let Some(token) = esi::get_access_token(&state.http_client, &config, record.id).await {
            access_token = Some(token);
            break;
        }
    }
    esi::fetch_public_contracts(&state.http_client, region_id, access_token.as_deref()).await
}

#[tauri::command]
pub async fn get_character_industry_jobs(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterIndustryJobs, String> {
    let config = config::load()?;
    esi::fetch_character_industry_jobs(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_transactions(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterTransactions, String> {
    let config = config::load()?;
    esi::fetch_character_transactions(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_wallet_journal(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterWalletJournal, String> {
    let config = config::load()?;
    esi::fetch_character_wallet_journal(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_mail(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterMail, String> {
    let config = config::load()?;
    esi::fetch_character_mail(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_mail_detail(state: State<'_, AppState>, id: i64, mail_id: i64) -> Result<esi::MailDetail, String> {
    let config = config::load()?;
    esi::fetch_mail_detail(&state.http_client, &config, id, mail_id).await
}

#[tauri::command]
pub async fn get_character_notifications(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterNotifications, String> {
    let config = config::load()?;
    esi::fetch_character_notifications(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_planets(state: State<'_, AppState>, id: i64) -> Result<esi::CharacterPlanets, String> {
    let config = config::load()?;
    esi::fetch_character_planets(&state.http_client, &config, id).await
}

#[tauri::command]
pub async fn get_character_planet_detail(state: State<'_, AppState>, id: i64, planet_id: i64) -> Result<esi::PlanetDetail, String> {
    let config = config::load()?;
    esi::fetch_character_planet_detail(&state.http_client, &config, id, planet_id).await
}

#[tauri::command]
pub async fn search_system(state: State<'_, AppState>, name: String) -> Result<Option<kills::SystemMatch>, String> {
    kills::search_system(&state.http_client, &name).await
}

#[tauri::command]
pub async fn search_character(state: State<'_, AppState>, name: String) -> Result<Option<kills::CharacterMatch>, String> {
    kills::search_character(&state.http_client, &name).await
}

#[tauri::command]
pub async fn search_characters_live(state: State<'_, AppState>, query: String) -> Result<Vec<kills::CharacterMatch>, String> {
    kills::search_characters_live(&state.http_client, &query).await
}

#[tauri::command]
pub async fn search_entities_live(state: State<'_, AppState>, query: String) -> Result<Vec<kills::EntityMatch>, String> {
    kills::search_entities_live(&state.http_client, &query).await
}

#[tauri::command]
pub async fn get_recent_kills(
    state: State<'_, AppState>,
    system_ids: Vec<i64>,
) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_recent_kills(&state.http_client, &system_ids).await
}

#[tauri::command]
pub async fn get_constellation_kills(state: State<'_, AppState>, constellation_id: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_constellation_kills(&state.http_client, constellation_id).await
}

#[tauri::command]
pub async fn get_region_kills(state: State<'_, AppState>, region_id: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_region_kills(&state.http_client, region_id).await
}

#[tauri::command]
pub async fn get_system_kills_history(state: State<'_, AppState>, system_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_system_kills_history(&state.http_client, system_id, page).await
}

#[tauri::command]
pub async fn get_constellation_kills_history(
    state: State<'_, AppState>,
    constellation_id: i64,
    page: i64,
) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_constellation_kills_history(&state.http_client, constellation_id, page).await
}

#[tauri::command]
pub async fn get_region_kills_history(state: State<'_, AppState>, region_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_region_kills_history(&state.http_client, region_id, page).await
}

#[tauri::command]
pub async fn get_corporation_kills(state: State<'_, AppState>, corporation_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_corporation_kills(&state.http_client, corporation_id, page).await
}

#[tauri::command]
pub async fn get_alliance_kills(state: State<'_, AppState>, alliance_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_alliance_kills(&state.http_client, alliance_id, page).await
}

#[tauri::command]
pub async fn get_location_kills(state: State<'_, AppState>, location_id: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_location_kills(&state.http_client, location_id).await
}

#[tauri::command]
pub async fn get_corporation_profile(state: State<'_, AppState>, corporation_id: i64) -> Result<kills::CorporationProfile, String> {
    kills::fetch_corporation_profile(&state.http_client, corporation_id).await
}

#[tauri::command]
pub async fn get_alliance_profile(state: State<'_, AppState>, alliance_id: i64) -> Result<kills::AllianceProfile, String> {
    kills::fetch_alliance_profile(&state.http_client, alliance_id).await
}

#[tauri::command]
pub async fn get_corporation_stats(state: State<'_, AppState>, corporation_id: i64) -> Result<kills::CharacterStats, String> {
    kills::fetch_corporation_stats(&state.http_client, corporation_id).await
}

#[tauri::command]
pub async fn get_alliance_stats(state: State<'_, AppState>, alliance_id: i64) -> Result<kills::CharacterStats, String> {
    kills::fetch_alliance_stats(&state.http_client, alliance_id).await
}

#[tauri::command]
pub async fn get_alliance_corporations(state: State<'_, AppState>, alliance_id: i64) -> Result<Vec<kills::AllianceMemberCorp>, String> {
    kills::fetch_alliance_corporations(&state.http_client, alliance_id).await
}

#[tauri::command]
pub async fn get_corporation_losses(state: State<'_, AppState>, corporation_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_corporation_losses(&state.http_client, corporation_id, page).await
}

#[tauri::command]
pub async fn get_alliance_losses(state: State<'_, AppState>, alliance_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_alliance_losses(&state.http_client, alliance_id, page).await
}

#[tauri::command]
pub async fn get_corporation_supers(state: State<'_, AppState>, corporation_id: i64) -> Result<kills::SupersReport, String> {
    kills::fetch_supers(&state.http_client, "corporationID", corporation_id).await
}

#[tauri::command]
pub async fn get_alliance_supers(state: State<'_, AppState>, alliance_id: i64) -> Result<kills::SupersReport, String> {
    kills::fetch_supers(&state.http_client, "allianceID", alliance_id).await
}

#[tauri::command]
pub async fn get_kill_detail(state: State<'_, AppState>, killmail_id: i64) -> Result<kills::KillDetail, String> {
    kills::fetch_kill_detail(&state.http_client, killmail_id).await
}

#[tauri::command]
pub async fn get_recent_activity_kills(state: State<'_, AppState>) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_recent_activity(&state.http_client).await
}

#[tauri::command]
pub async fn query_kill_reports(app: AppHandle, category: String) -> Result<Vec<kills::KillEntry>, String> {
    kill_history::query_kill_reports(app, category).await
}

#[tauri::command]
pub async fn get_kill_top_stats(app: AppHandle, window_minutes: i64) -> Result<kill_history::TopStatsResult, String> {
    kill_history::get_top_stats(app, window_minutes).await
}

/// Kicks off the one-time recent-history backfill in the background and
/// returns immediately - a no-op if one is already running. Progress is
/// polled separately via get_kill_history_backfill_progress.
#[tauri::command]
pub async fn start_kill_history_backfill(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.http_client.clone();
    tauri::async_runtime::spawn(kill_history::start_backfill(app, client));
    Ok(())
}

#[tauri::command]
pub async fn get_kill_history_backfill_progress() -> Result<Option<kill_history::BackfillProgress>, String> {
    Ok(kill_history::get_backfill_progress())
}

#[tauri::command]
pub async fn poll_recent_activity_kills(state: State<'_, AppState>) -> Result<Vec<kills::KillEntry>, String> {
    kills::poll_recent_activity(&state.http_client).await
}

#[tauri::command]
pub async fn poll_tracked_system_kills(
    state: State<'_, AppState>,
    system_ids: Vec<i64>,
) -> Result<Vec<kills::KillEntry>, String> {
    kills::poll_tracked_systems(&state.http_client, &system_ids).await
}

#[tauri::command]
pub async fn get_character_profile(state: State<'_, AppState>, character_id: i64) -> Result<kills::CharacterProfile, String> {
    kills::fetch_character_profile(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn get_character_kills(state: State<'_, AppState>, character_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_character_kills(&state.http_client, character_id, page).await
}

#[tauri::command]
pub async fn get_character_losses(state: State<'_, AppState>, character_id: i64, page: i64) -> Result<Vec<kills::KillEntry>, String> {
    kills::fetch_character_losses(&state.http_client, character_id, page).await
}

#[tauri::command]
pub async fn get_character_stats(state: State<'_, AppState>, character_id: i64) -> Result<kills::CharacterStats, String> {
    kills::fetch_character_stats(&state.http_client, character_id).await
}

#[tauri::command]
pub async fn check_intel(state: State<'_, AppState>, names: Vec<String>) -> Result<kills::IntelCheckResult, String> {
    Ok(kills::check_intel(&state.http_client, names).await)
}

/// Cost/payout table for a ship type - a calculator, not a policy tracker.
/// ESI has no endpoint anywhere for a character's actual active insurance
/// policies (confirmed live), only this public price table.
#[tauri::command]
pub async fn get_insurance_levels(state: State<'_, AppState>, ship_type_id: i64) -> Result<Vec<kills::InsuranceLevel>, String> {
    Ok(kills::fetch_insurance_levels(&state.http_client, ship_type_id).await)
}

#[tauri::command]
pub async fn list_insurable_ship_ids(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    Ok(kills::fetch_insurable_ship_ids(&state.http_client).await)
}

#[tauri::command]
pub async fn list_intel_channels() -> Result<Vec<intel_feed::IntelChannelInfo>, String> {
    tauri::async_runtime::spawn_blocking(intel_feed::list_channels)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn poll_intel_channel(channel_name: String, listener: String, cursor: u64) -> Result<intel_feed::IntelChannelPoll, String> {
    tauri::async_runtime::spawn_blocking(move || intel_feed::poll_channel(&channel_name, &listener, cursor))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_map_data(app: AppHandle, state: State<'_, AppState>) -> Result<map::MapData, String> {
    map::get_map_data(app, &state.http_client).await
}

#[tauri::command]
pub async fn get_system_detail(app: AppHandle, state: State<'_, AppState>, system_id: i64) -> Result<map::SystemDetail, String> {
    map::get_system_detail(app, &state.http_client, system_id).await
}

/// Real 48h kill history for the Stats popup's Ship/NPC/Pod Kills graphs -
/// see kills::fetch_system_kill_history_48h for why this can be sourced
/// retroactively (zKillboard has real history) unlike jumps below.
#[tauri::command]
pub async fn get_system_kill_history(state: State<'_, AppState>, system_id: i64) -> Result<Vec<kills::KillHistoryPoint>, String> {
    kills::fetch_system_kill_history_48h(&state.http_client, system_id).await
}

/// Locally-accumulated jump history for the Stats popup's Jumps graph - see
/// map::run_jump_history_sampler, which is what actually populates this.
#[tauri::command]
pub async fn get_system_jump_history(app: AppHandle, system_id: i64) -> Result<Vec<map::JumpHistoryPoint>, String> {
    map::get_jump_history(app, system_id).await
}

#[derive(Serialize)]
pub struct CharacterHomeSystem {
    pub character_id: i64,
    pub system_id: Option<i64>,
}

/// Home-base map pins: each character's home station resolved to a system
/// id. Best-effort per character - no token, no scope, no home location set,
/// or a player-owned structure home (not in the local NPC stations table)
/// all just mean that one character gets no pin, not a broken map.
/// Bounds how many characters' home-system lookups run at once - each is an
/// independent ESI + station-resolve chain per character, so a multi-alt
/// roster no longer pays for them one at a time.
const HOME_SYSTEM_RESOLVE_CONCURRENCY: usize = 6;

#[tauri::command]
pub async fn get_character_home_systems(
    app: AppHandle,
    state: State<'_, AppState>,
    character_ids: Vec<i64>,
) -> Result<Vec<CharacterHomeSystem>, String> {
    let config = config::load()?;
    let client = &state.http_client;
    let results = stream::iter(character_ids)
        .map(|character_id| {
            let config = config.clone();
            let app = app.clone();
            async move {
                let system_id = match esi::fetch_character_home_location_id(client, &config, character_id).await {
                    Some(location_id) => map::resolve_station_system(&app, client, location_id).await,
                    None => None,
                };
                CharacterHomeSystem { character_id, system_id }
            }
        })
        .buffer_unordered(HOME_SYSTEM_RESOLVE_CONCURRENCY)
        .collect()
        .await;
    Ok(results)
}

/// Every public player-owned structure with its system, for the map's
/// citadel/engineering-complex markers. Resolving them needs some valid
/// character token (confirmed live: any logged-in character's works, not
/// specifically one with docking history there), so this picks the first
/// locally saved character with a usable one - if none is available yet
/// (e.g. very first login), falls back to whatever's already cached.
#[tauri::command]
pub async fn get_player_structures(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<map::PlayerStructureInfo>, String> {
    let config = config::load()?;
    let (records, _) = characters::list_characters(&app)?;
    let mut access_token = None;
    for record in &records {
        if let Some(token) = esi::get_access_token(&state.http_client, &config, record.id).await {
            access_token = Some(token);
            break;
        }
    }
    map::get_player_structures(app, &state.http_client, access_token.as_deref()).await
}

/// The Dashboard's news ticker - CCP's official RSS feed, fetched live.
#[tauri::command]
pub async fn get_news_feed(state: State<'_, AppState>) -> Result<Vec<news::NewsItem>, String> {
    news::fetch_news_feed(&state.http_client).await
}

/// The Dashboard's second ticker panel - DOTLAN's live universe activity
/// feed (sovereignty/FW/corp/alliance events), fetched live.
#[tauri::command]
pub async fn get_live_activity_feed(state: State<'_, AppState>) -> Result<Vec<news::ActivityEvent>, String> {
    news::fetch_live_activity_feed(&state.http_client).await
}

/// Active wars touching a given corporation or alliance - see wars.rs for
/// why this is a locally-synced recent window, not an exhaustive index.
#[tauri::command]
pub async fn get_wars_for_entity(app: AppHandle, state: State<'_, AppState>, entity_id: i64) -> Result<Vec<wars::WarSummary>, String> {
    wars::get_wars_for_entity(app, &state.http_client, entity_id).await
}

#[tauri::command]
pub async fn get_war_detail(state: State<'_, AppState>, war_id: i64) -> Result<wars::WarSummary, String> {
    wars::get_war_detail(&state.http_client, war_id).await
}

/// Generic bulk id->name resolver (characters, corporations, alliances,
/// systems, etc - whatever ESI's /universe/names/ accepts) - thin wrapper
/// around the existing esi::resolve_names used internally elsewhere, for
/// pages (like Wars) that need to label arbitrary entity ids.
#[tauri::command]
pub async fn resolve_entity_names(state: State<'_, AppState>, ids: Vec<i64>) -> Result<HashMap<i64, String>, String> {
    Ok(esi::resolve_names(&state.http_client, ids).await)
}

#[tauri::command]
pub async fn search_systems_live(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<map::SystemSearchMatch>, String> {
    map::search_systems(app, &state.http_client, query).await
}

#[tauri::command]
pub async fn get_system_positions(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<map::SystemPosition>, String> {
    map::get_system_positions(app, &state.http_client, ids).await
}

#[tauri::command]
pub async fn plan_gate_check(
    state: State<'_, AppState>,
    waypoints: Vec<i64>,
    avoid: Vec<i64>,
    flag: String,
) -> Result<route::GateCheckResult, String> {
    route::plan_gate_check(&state.http_client, &waypoints, &avoid, &flag).await
}

#[tauri::command]
pub async fn get_gate_activity(state: State<'_, AppState>, system_ids: Vec<i64>) -> Result<Vec<route::GateKillEvent>, String> {
    Ok(route::get_gate_activity(&state.http_client, &system_ids).await)
}

#[tauri::command]
pub async fn get_system_gates(state: State<'_, AppState>, system_id: i64) -> Result<Vec<route::GateSummary>, String> {
    Ok(route::fetch_system_gate_summaries(&state.http_client, system_id).await)
}

#[tauri::command]
pub async fn get_item_categories(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<market::CategorySummary>, String> {
    market::get_item_categories(app, &state.http_client).await
}

#[tauri::command]
pub async fn get_category_groups(app: AppHandle, state: State<'_, AppState>, category_id: i64) -> Result<Vec<market::GroupSummary>, String> {
    market::get_category_groups(app, &state.http_client, category_id).await
}

#[tauri::command]
pub async fn get_group_items(app: AppHandle, state: State<'_, AppState>, group_id: i64) -> Result<Vec<market::TypeSummary>, String> {
    market::get_group_items(app, &state.http_client, group_id).await
}

#[tauri::command]
pub async fn get_item_detail(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<market::ItemDetail, String> {
    market::get_item_detail(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn get_ship_stats(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<market::ShipStats, String> {
    market::get_ship_stats(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn get_jump_drive_info(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<Option<market::JumpDriveInfo>, String> {
    market::get_jump_drive_info(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn get_item_resource_costs(
    app: AppHandle,
    state: State<'_, AppState>,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, market::ItemResourceCost>, String> {
    market::get_item_resource_costs(app, &state.http_client, type_ids).await
}

#[tauri::command]
pub async fn get_skill_requirements_bulk(
    app: AppHandle,
    state: State<'_, AppState>,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<market::SkillRequirement>>, String> {
    market::get_skill_requirements_bulk(app, &state.http_client, type_ids).await
}

#[tauri::command]
pub async fn search_market_types(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<market::TypeSearchMatch>, String> {
    market::search_types(app, &state.http_client, query).await
}

#[tauri::command]
pub async fn get_market_groups(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<market::MarketGroupNode>, String> {
    market::get_market_groups(app, &state.http_client).await
}

#[tauri::command]
pub async fn get_type_mass(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<Option<f64>, String> {
    market::get_type_mass(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn search_blueprints(app: AppHandle, state: State<'_, AppState>, query: String) -> Result<Vec<market::TypeSearchMatch>, String> {
    market::search_blueprints(app, &state.http_client, query).await
}

#[tauri::command]
pub async fn get_blueprint_detail(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<market::BlueprintDetail, String> {
    market::get_blueprint_detail(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn find_blueprint_for_product(app: AppHandle, state: State<'_, AppState>, product_type_id: i64) -> Result<Option<i64>, String> {
    market::find_blueprint_for_product(app, &state.http_client, product_type_id).await
}

#[tauri::command]
pub async fn get_reprocessing_materials(app: AppHandle, state: State<'_, AppState>, type_id: i64) -> Result<market::ReprocessingInfo, String> {
    market::get_reprocessing_materials(app, &state.http_client, type_id).await
}

#[tauri::command]
pub async fn get_industry_system_cost_indices(state: State<'_, AppState>) -> Result<Vec<esi::SystemCostIndices>, String> {
    esi::fetch_industry_system_cost_indices(&state.http_client).await
}

#[tauri::command]
pub async fn get_pi_data(app: AppHandle, state: State<'_, AppState>) -> Result<pi::PiData, String> {
    pi::get_pi_data(app, &state.http_client).await
}

#[tauri::command]
pub async fn get_market_group_types(
    app: AppHandle,
    state: State<'_, AppState>,
    market_group_id: i64,
) -> Result<Vec<market::TypeSummary>, String> {
    market::get_market_group_types(app, &state.http_client, market_group_id).await
}

#[tauri::command]
pub async fn resolve_type_ids_by_name(app: AppHandle, state: State<'_, AppState>, names: Vec<String>) -> Result<HashMap<String, i64>, String> {
    market::resolve_type_ids_by_name(app, &state.http_client, names).await
}

#[tauri::command]
pub async fn get_region_market_orders(
    state: State<'_, AppState>,
    region_id: i64,
    type_id: i64,
) -> Result<Vec<market::MarketOrder>, String> {
    market::fetch_region_orders(&state.http_client, region_id, type_id).await
}

#[tauri::command]
pub async fn get_region_sell_min_price(
    state: State<'_, AppState>,
    region_id: i64,
    type_id: i64,
) -> Result<Option<f64>, String> {
    market::fetch_region_sell_min(&state.http_client, region_id, type_id).await
}

/// Bulk sibling of get_region_sell_min_price: one IPC round trip for a whole
/// material list instead of one call per material (Industry's build-tree
/// pricing used to invoke the singular command once per line item).
#[tauri::command]
pub async fn get_region_sell_min_prices(
    state: State<'_, AppState>,
    region_id: i64,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, f64>, String> {
    Ok(market::fetch_region_sell_min_prices(&state.http_client, region_id, type_ids).await)
}

#[tauri::command]
pub async fn get_scout_connections(state: State<'_, AppState>, system_name: String) -> Result<Vec<scout::ScoutConnection>, String> {
    scout::fetch_scout_connections(&state.http_client, &system_name).await
}

#[tauri::command]
pub async fn resync_market_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    market::force_resync(&app, &state.http_client).await
}

#[tauri::command]
pub async fn get_region_market_history(
    state: State<'_, AppState>,
    region_id: i64,
    type_id: i64,
) -> Result<Vec<market::MarketHistoryPoint>, String> {
    market::fetch_region_history(&state.http_client, region_id, type_id).await
}

#[tauri::command]
pub async fn get_market_prices(state: State<'_, AppState>) -> Result<Vec<market::MarketPrice>, String> {
    market::fetch_market_prices(&state.http_client).await
}

#[tauri::command]
pub async fn get_item_description(state: State<'_, AppState>, type_id: i64) -> Result<String, String> {
    Ok(market::fetch_item_description(&state.http_client, type_id).await)
}

#[tauri::command]
pub async fn resolve_market_locations(
    state: State<'_, AppState>,
    character_id: i64,
    location_ids: Vec<i64>,
) -> Result<std::collections::HashMap<i64, String>, String> {
    let config = config::load()?;
    Ok(esi::resolve_market_locations(&state.http_client, &config, character_id, location_ids).await)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[tauri::command]
pub async fn list_chains(app: AppHandle) -> Result<Vec<wormholes::ChainSummary>, String> {
    wormholes::list_chains(app).await
}

#[tauri::command]
pub async fn get_chain(app: AppHandle, chain_id: String) -> Result<wormholes::ChainDetail, String> {
    wormholes::get_chain(app, chain_id).await
}

#[tauri::command]
pub async fn create_chain(app: AppHandle, name: String) -> Result<String, String> {
    wormholes::create_chain(app, name).await
}

#[tauri::command]
pub async fn rename_chain(app: AppHandle, chain_id: String, name: String) -> Result<(), String> {
    wormholes::rename_chain(app, chain_id, name).await
}

#[tauri::command]
pub async fn set_chain_auto_map(app: AppHandle, chain_id: String, enabled: bool) -> Result<(), String> {
    wormholes::set_chain_auto_map(app, chain_id, enabled).await
}

#[tauri::command]
pub async fn delete_chain(app: AppHandle, chain_id: String) -> Result<(), String> {
    wormholes::delete_chain(app, chain_id).await
}

#[tauri::command]
pub async fn upsert_chain_system(
    app: AppHandle,
    chain_id: String,
    input: wormholes::ChainSystemInput,
) -> Result<String, String> {
    wormholes::upsert_chain_system(app, chain_id, input).await
}

#[tauri::command]
pub async fn delete_chain_system(app: AppHandle, chain_id: String, chain_system_id: String) -> Result<(), String> {
    wormholes::delete_chain_system(app, chain_id, chain_system_id).await
}

#[tauri::command]
pub async fn upsert_connection(
    app: AppHandle,
    chain_id: String,
    input: wormholes::ConnectionInput,
) -> Result<String, String> {
    wormholes::upsert_connection(app, chain_id, input).await
}

#[tauri::command]
pub async fn delete_connection(app: AppHandle, chain_id: String, connection_id: String) -> Result<(), String> {
    wormholes::delete_connection(app, chain_id, connection_id).await
}

#[tauri::command]
pub async fn upsert_signature(
    app: AppHandle,
    chain_id: String,
    input: wormholes::SignatureInput,
) -> Result<String, String> {
    wormholes::upsert_signature(app, chain_id, input).await
}

#[tauri::command]
pub async fn import_signatures(
    app: AppHandle,
    chain_id: String,
    chain_system_id: String,
    signatures: Vec<wormholes::ParsedSignature>,
) -> Result<wormholes::ImportSignaturesResult, String> {
    wormholes::import_signatures(app, chain_id, chain_system_id, signatures).await
}

#[tauri::command]
pub async fn delete_signature(app: AppHandle, chain_id: String, signature_id: String) -> Result<(), String> {
    wormholes::delete_signature(app, chain_id, signature_id).await
}

#[tauri::command]
pub async fn import_structures(
    app: AppHandle,
    chain_id: String,
    chain_system_id: String,
    structures: Vec<wormholes::ParsedStructure>,
) -> Result<wormholes::ImportStructuresResult, String> {
    wormholes::import_structures(app, chain_id, chain_system_id, structures).await
}

#[tauri::command]
pub async fn delete_chain_structure(app: AppHandle, chain_id: String, structure_id: String) -> Result<(), String> {
    wormholes::delete_chain_structure(app, chain_id, structure_id).await
}

#[tauri::command]
pub async fn list_plans(app: AppHandle, character_id: i64) -> Result<Vec<skillplans::PlanSummary>, String> {
    skillplans::list_plans(app, character_id).await
}

#[tauri::command]
pub async fn get_plan(app: AppHandle, plan_id: String) -> Result<skillplans::PlanDetail, String> {
    skillplans::get_plan(app, plan_id).await
}

#[tauri::command]
pub async fn create_plan(app: AppHandle, character_id: i64, name: String) -> Result<String, String> {
    skillplans::create_plan(app, character_id, name).await
}

#[tauri::command]
pub async fn rename_plan(app: AppHandle, plan_id: String, name: String) -> Result<(), String> {
    skillplans::rename_plan(app, plan_id, name).await
}

#[tauri::command]
pub async fn delete_plan(app: AppHandle, plan_id: String) -> Result<(), String> {
    skillplans::delete_plan(app, plan_id).await
}

#[tauri::command]
pub async fn add_plan_entries(app: AppHandle, plan_id: String, entries: Vec<skillplans::NewPlanEntry>) -> Result<(), String> {
    skillplans::add_plan_entries(app, plan_id, entries).await
}

#[tauri::command]
pub async fn update_plan_entry(app: AppHandle, plan_id: String, entry_id: String, priority: i64, notes: String) -> Result<(), String> {
    skillplans::update_plan_entry(app, plan_id, entry_id, priority, notes).await
}

#[tauri::command]
pub async fn reorder_plan_entries(app: AppHandle, plan_id: String, entry_ids_in_order: Vec<String>) -> Result<(), String> {
    skillplans::reorder_plan_entries(app, plan_id, entry_ids_in_order).await
}

#[tauri::command]
pub async fn delete_plan_entry(app: AppHandle, plan_id: String, entry_id: String) -> Result<(), String> {
    skillplans::delete_plan_entry(app, plan_id, entry_id).await
}

#[tauri::command]
pub async fn upsert_mass_log(app: AppHandle, chain_id: String, input: wormholes::MassLogInput) -> Result<String, String> {
    wormholes::upsert_mass_log(app, chain_id, input).await
}

#[tauri::command]
pub async fn delete_mass_log_entry(app: AppHandle, chain_id: String, entry_id: String) -> Result<(), String> {
    wormholes::delete_mass_log_entry(app, chain_id, entry_id).await
}

#[tauri::command]
pub async fn clear_mass_log(app: AppHandle, chain_id: String, connection_id: String) -> Result<(), String> {
    wormholes::clear_mass_log(app, chain_id, connection_id).await
}

#[tauri::command]
pub async fn find_chain_route(
    app: AppHandle,
    state: State<'_, AppState>,
    chain_id: String,
    origin_system_id: i64,
    destination_system_id: i64,
) -> Result<Vec<wormholes::RouteStep>, String> {
    wormholes::find_chain_route(app, state.http_client.clone(), chain_id, origin_system_id, destination_system_id).await
}

#[tauri::command]
pub fn get_multibox_clients() -> Vec<multibox::MultiboxClient> {
    multibox::enumerate_eve_clients()
}

#[tauri::command]
pub fn is_multibox_overlay_open() -> bool {
    multibox::is_overlay_open()
}

#[tauri::command]
pub fn open_multibox_overlay(app: AppHandle) {
    let settings = multibox::load_settings(&app);
    multibox::open_overlay(app, settings);
}

#[tauri::command]
pub fn close_multibox_overlay() {
    multibox::close_overlay();
}

#[tauri::command]
pub fn get_multibox_settings(app: AppHandle) -> multibox::MultiboxSettings {
    multibox::load_settings(&app)
}

#[tauri::command]
pub fn set_multibox_settings(app: AppHandle, settings: multibox::MultiboxSettings) -> Result<(), String> {
    multibox::update_settings(&app, settings)
}

#[tauri::command]
pub fn list_multibox_profiles(app: AppHandle) -> Vec<multibox::MultiboxProfile> {
    multibox::list_profiles(&app)
}

#[tauri::command]
pub fn save_multibox_profile(app: AppHandle, name: String, settings: multibox::MultiboxSettings) -> Result<(), String> {
    multibox::save_profile(&app, name, settings)
}

#[tauri::command]
pub fn delete_multibox_profile(app: AppHandle, name: String) -> Result<(), String> {
    multibox::delete_profile(&app, &name)
}

#[tauri::command]
pub fn is_price_widget_open() -> bool {
    price_widget::is_widget_open()
}

#[tauri::command]
pub fn open_price_widget(app: AppHandle, state: State<'_, AppState>, region_id: i64) {
    price_widget::open_widget(app, state.http_client.clone(), region_id);
}

#[tauri::command]
pub fn close_price_widget() {
    price_widget::close_widget();
}

#[tauri::command]
pub fn is_combat_overlay_open() -> bool {
    combat_overlay::is_widget_open()
}

#[tauri::command]
pub fn open_combat_overlay() {
    combat_overlay::open_widget();
}

#[tauri::command]
pub fn close_combat_overlay() {
    combat_overlay::close_widget();
}

#[tauri::command]
pub fn get_default_eve_settings_path() -> Option<String> {
    settings_sync::default_eve_settings_path().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_eve_settings_servers(base_path: String) -> Result<Vec<settings_sync::EveServerFolder>, String> {
    settings_sync::list_servers(&base_path)
}

#[tauri::command]
pub fn list_eve_settings_profiles(server_path: String) -> Result<Vec<settings_sync::EveSettingsProfile>, String> {
    settings_sync::list_profiles(&server_path)
}

#[tauri::command]
pub fn list_eve_settings_files(profile_path: String) -> Result<Vec<settings_sync::EveSettingsFile>, String> {
    settings_sync::list_settings_files(&profile_path)
}

#[tauri::command]
pub fn sync_eve_settings_file(app: AppHandle, source_path: String, dest_paths: Vec<String>) -> Result<Vec<settings_sync::SyncResult>, String> {
    settings_sync::sync_settings_file(&app, &source_path, dest_paths)
}

#[tauri::command]
pub fn list_settings_backups(app: AppHandle) -> Vec<settings_sync::BackupEntry> {
    settings_sync::list_backups(&app)
}

#[tauri::command]
pub fn create_settings_file_backup(app: AppHandle, source_path: String, display_name: Option<String>) -> Result<settings_sync::BackupEntry, String> {
    settings_sync::create_file_backup(&app, &source_path, display_name)
}

#[tauri::command]
pub fn create_settings_profile_backup(app: AppHandle, profile_path: String, display_name: Option<String>) -> Result<settings_sync::BackupEntry, String> {
    settings_sync::create_profile_backup(&app, &profile_path, display_name)
}

#[tauri::command]
pub fn restore_settings_backup(app: AppHandle, backup_id: String) -> Result<(), String> {
    settings_sync::restore_backup(&app, &backup_id)
}

#[tauri::command]
pub fn delete_settings_backup(app: AppHandle, backup_id: String) -> Result<(), String> {
    settings_sync::delete_backup(&app, &backup_id)
}

#[tauri::command]
pub fn create_eve_settings_profile(server_path: String, name: String) -> Result<settings_sync::EveSettingsProfile, String> {
    settings_sync::create_profile(&server_path, &name)
}

#[tauri::command]
pub fn rename_eve_settings_profile(profile_path: String, new_name: String) -> Result<settings_sync::EveSettingsProfile, String> {
    settings_sync::rename_profile(&profile_path, &new_name)
}

#[tauri::command]
pub fn duplicate_eve_settings_profile(profile_path: String, new_name: String) -> Result<settings_sync::EveSettingsProfile, String> {
    settings_sync::duplicate_profile(&profile_path, &new_name)
}

#[tauri::command]
pub fn delete_eve_settings_profile(profile_path: String) -> Result<(), String> {
    settings_sync::delete_profile(&profile_path)
}
