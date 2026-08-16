mod auth;
mod characters;
mod commands;
mod config;
mod esi;
mod kills;
mod map;
mod route;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();

    let http_client = reqwest::Client::builder()
        .user_agent("vesper-capsuleer-ops/0.1 (contact: barry.millard22@gmail.com)")
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState { http_client })
        .invoke_handler(tauri::generate_handler![
            commands::start_login,
            commands::cancel_login,
            commands::get_server_status,
            commands::get_session,
            commands::set_active_character,
            commands::logout_character,
            commands::get_character_overview,
            commands::get_character_skills,
            commands::get_all_skills,
            commands::get_character_skill_queue,
            commands::get_character_employment_history,
            commands::get_character_clones,
            commands::get_character_standings,
            commands::get_character_contacts,
            commands::get_character_medals,
            commands::get_character_loyalty,
            commands::get_character_assets,
            commands::get_character_market_orders,
            commands::get_character_contracts,
            commands::get_character_industry_jobs,
            commands::get_character_transactions,
            commands::get_character_wallet_journal,
            commands::get_character_mail,
            commands::get_mail_detail,
            commands::get_character_notifications,
            commands::get_character_planets,
            commands::search_system,
            commands::get_recent_kills,
            commands::get_kill_detail,
            commands::get_recent_activity_kills,
            commands::poll_recent_activity_kills,
            commands::poll_tracked_system_kills,
            commands::get_character_profile,
            commands::get_character_kills,
            commands::get_character_losses,
            commands::get_character_stats,
            commands::get_map_data,
            commands::search_systems_live,
            commands::plan_gate_check,
            commands::get_gate_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
