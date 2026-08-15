mod auth;
mod characters;
mod commands;
mod config;
mod esi;
mod kills;
mod map;

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
            commands::get_session,
            commands::set_active_character,
            commands::logout_character,
            commands::get_character_overview,
            commands::get_character_skills,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
