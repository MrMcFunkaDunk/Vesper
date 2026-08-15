mod auth;
mod characters;
mod commands;
mod config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState { http_client: reqwest::Client::new() })
        .invoke_handler(tauri::generate_handler![
            commands::start_login,
            commands::get_session,
            commands::set_active_character,
            commands::logout_character,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
