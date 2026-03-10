mod commands;
mod crypto;
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
        .setup(|app| {
            use tauri::Manager;
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data dir")
                .to_string_lossy()
                .to_string();
            crate::db::init(&app_data_dir)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::create_connection,
            commands::test_connection,
            commands::delete_connection,
            commands::update_connection,
            commands::execute_query,
            commands::get_tables,
            commands::get_schema,
            commands::ai_chat,
            commands::ai_generate_sql,
            commands::ai_explain_sql,
            commands::get_query_history,
            commands::save_query,
            commands::get_llm_settings,
            commands::set_llm_settings,
            commands::test_llm_connection,
            commands::get_table_detail,
            commands::get_full_schema,
            commands::get_table_ddl,
            commands::get_table_data,
            commands::update_row,
            commands::delete_row,
            commands::export_table_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
