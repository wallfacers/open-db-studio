mod commands;
mod datasource;
mod db;
mod error;
mod llm;

pub use error::{AppError, AppResult};

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::create_connection,
            commands::test_connection,
            commands::delete_connection,
            commands::execute_query,
            commands::get_tables,
            commands::get_schema,
            commands::ai_chat,
            commands::ai_generate_sql,
            commands::get_query_history,
            commands::save_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
