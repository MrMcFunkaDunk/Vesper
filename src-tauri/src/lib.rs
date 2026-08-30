mod abyssal;
mod asset_history;
mod auth;
mod characters;
mod combat_overlay;
mod commands;
mod config;
mod esi;
mod fittings;
mod intel_feed;
mod kill_history;
mod kills;
mod map;
mod market;
mod multibox;
mod news;
mod pi;
mod price_widget;
mod route;
mod scout;
mod settings_sync;
mod skillplans;
mod tracked_entities;
mod wars;
mod wormholes;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();

    let http_client = reqwest::Client::builder()
        .user_agent("vesper-capsuleer-ops/0.1 (contact: barry.millard22@gmail.com)")
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::AppState { http_client })
        .setup(|app| {
            let handle = app.handle().clone();
            let client = handle.state::<commands::AppState>().http_client.clone();
            tauri::async_runtime::spawn(map::run_jump_history_sampler(handle.clone(), client.clone()));
            tauri::async_runtime::spawn(kill_history::run_kill_history_recorder(handle.clone(), client.clone()));
            tauri::async_runtime::spawn(kill_history::run_startup_backfill(handle, client));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_login,
            commands::cancel_login,
            commands::get_server_status,
            commands::get_session,
            commands::set_active_character,
            commands::logout_character,
            commands::get_character_overview,
            commands::get_character_skills,
            commands::get_character_location,
            commands::get_all_skills,
            commands::get_character_skill_queue,
            commands::get_character_employment_history,
            commands::get_character_clones,
            commands::search_blueprints,
            commands::get_blueprint_detail,
            commands::find_blueprint_for_product,
            commands::get_reprocessing_materials,
            commands::get_industry_system_cost_indices,
            commands::get_character_attributes,
            commands::get_character_research,
            commands::get_character_fw_stats,
            commands::get_character_standings,
            commands::get_character_contacts,
            commands::get_character_medals,
            commands::get_character_loyalty,
            commands::get_character_mining_ledger,
            commands::get_loyalty_store_offers,
            commands::check_abyssal_value,
            commands::record_asset_snapshot,
            commands::get_asset_history,
            commands::get_character_assets,
            commands::get_character_market_orders,
            commands::get_character_contracts,
            commands::get_contract_items,
            commands::get_character_calendar,
            commands::get_calendar_event_detail,
            commands::list_fits,
            commands::get_fit,
            commands::save_fit,
            commands::delete_fit,
            commands::sync_character_fittings,
            commands::send_fit_to_character,
            commands::get_fit_cost,
            commands::export_fit_eft,
            commands::export_fit_dna,
            commands::get_public_contracts,
            commands::get_character_industry_jobs,
            commands::get_character_transactions,
            commands::get_character_wallet_journal,
            commands::get_character_mail,
            commands::get_mail_detail,
            commands::get_character_notifications,
            commands::get_character_planets,
            commands::get_character_planet_detail,
            commands::get_tracked_entities,
            commands::add_tracked_entity,
            commands::remove_tracked_entity,
            commands::search_system,
            commands::search_character,
            commands::search_characters_live,
            commands::search_entities_live,
            commands::get_recent_kills,
            commands::get_constellation_kills,
            commands::get_region_kills,
            commands::get_system_kills_history,
            commands::get_constellation_kills_history,
            commands::get_region_kills_history,
            commands::get_kill_detail,
            commands::get_recent_activity_kills,
            commands::query_kill_reports,
            commands::get_kill_top_stats,
            commands::start_kill_history_backfill,
            commands::get_kill_history_backfill_progress,
            commands::poll_recent_activity_kills,
            commands::poll_tracked_system_kills,
            commands::get_character_profile,
            commands::get_character_kills,
            commands::get_character_losses,
            commands::get_character_stats,
            commands::check_intel,
            commands::get_insurance_levels,
            commands::list_insurable_ship_ids,
            commands::list_intel_channels,
            commands::poll_intel_channel,
            commands::get_corporation_kills,
            commands::get_alliance_kills,
            commands::get_location_kills,
            commands::get_corporation_profile,
            commands::get_alliance_profile,
            commands::get_corporation_stats,
            commands::get_alliance_stats,
            commands::get_alliance_corporations,
            commands::get_corporation_supers,
            commands::get_alliance_supers,
            commands::get_corporation_losses,
            commands::get_alliance_losses,
            commands::get_map_data,
            commands::get_system_detail,
            commands::get_system_kill_history,
            commands::get_system_jump_history,
            commands::get_character_home_systems,
            commands::get_player_structures,
            commands::get_news_feed,
            commands::get_live_activity_feed,
            commands::get_wars_for_entity,
            commands::get_war_detail,
            commands::resolve_entity_names,
            commands::search_systems_live,
            commands::get_system_positions,
            commands::plan_gate_check,
            commands::get_gate_activity,
            commands::get_likely_gate_camps,
            commands::get_system_kill_heat,
            commands::get_system_gates,
            commands::get_item_categories,
            commands::get_category_groups,
            commands::get_group_items,
            commands::get_inventable_blueprint_groups,
            commands::get_inventable_blueprints_in_group,
            commands::get_researchable_blueprint_groups,
            commands::get_researchable_blueprints_in_group,
            commands::get_item_detail,
            commands::get_ship_stats,
            commands::get_jump_drive_info,
            commands::get_item_resource_costs,
            commands::get_skill_requirements_bulk,
            commands::search_market_types,
            commands::get_market_groups,
            commands::get_pi_data,
            commands::get_market_group_types,
            commands::resolve_type_ids_by_name,
            commands::get_region_market_orders,
            commands::get_region_sell_min_price,
            commands::get_region_sell_min_prices,
            commands::get_scout_connections,
            commands::resync_market_data,
            commands::get_region_market_history,
            commands::get_market_prices,
            commands::get_item_description,
            commands::resolve_market_locations,
            commands::list_chains,
            commands::get_chain,
            commands::create_chain,
            commands::rename_chain,
            commands::delete_chain,
            commands::upsert_chain_system,
            commands::delete_chain_system,
            commands::upsert_connection,
            commands::delete_connection,
            commands::upsert_signature,
            commands::import_signatures,
            commands::delete_signature,
            commands::import_structures,
            commands::delete_chain_structure,
            commands::list_plans,
            commands::get_plan,
            commands::create_plan,
            commands::rename_plan,
            commands::delete_plan,
            commands::add_plan_entries,
            commands::update_plan_entry,
            commands::reorder_plan_entries,
            commands::delete_plan_entry,
            commands::find_chain_route,
            commands::get_multibox_clients,
            commands::is_multibox_overlay_open,
            commands::open_multibox_overlay,
            commands::close_multibox_overlay,
            commands::get_multibox_settings,
            commands::set_multibox_settings,
            commands::list_multibox_profiles,
            commands::save_multibox_profile,
            commands::delete_multibox_profile,
            commands::is_price_widget_open,
            commands::open_price_widget,
            commands::close_price_widget,
            commands::is_combat_overlay_open,
            commands::open_combat_overlay,
            commands::close_combat_overlay,
            commands::get_default_eve_settings_path,
            commands::list_eve_settings_servers,
            commands::list_eve_settings_profiles,
            commands::list_eve_settings_files,
            commands::sync_eve_settings_file,
            commands::list_settings_backups,
            commands::create_settings_file_backup,
            commands::create_settings_profile_backup,
            commands::restore_settings_backup,
            commands::delete_settings_backup,
            commands::create_eve_settings_profile,
            commands::rename_eve_settings_profile,
            commands::duplicate_eve_settings_profile,
            commands::delete_eve_settings_profile,
            commands::set_chain_auto_map,
            commands::upsert_mass_log,
            commands::delete_mass_log_entry,
            commands::clear_mass_log,
            commands::get_type_mass,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
