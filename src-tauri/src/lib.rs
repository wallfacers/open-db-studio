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
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            use tauri::Manager;
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data dir")
                .to_string_lossy()
                .to_string();
            crate::db::init(&app_data_dir)?;
            crate::db::migrate_legacy_llm_settings()?;
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
            commands::ai_chat_stream,
            commands::ai_generate_sql,
            commands::ai_explain_sql,
            commands::get_query_history,
            commands::save_query,
            commands::list_llm_configs,
            commands::create_llm_config,
            commands::update_llm_config,
            commands::delete_llm_config,
            commands::set_default_llm_config,
            commands::get_default_llm_config,
            commands::test_llm_config,
            commands::set_llm_config_test_status,
            commands::get_table_detail,
            commands::get_full_schema,
            commands::get_table_ddl,
            commands::get_table_data,
            commands::update_row,
            commands::delete_row,
            commands::insert_row,
            commands::export_table_data,
            commands::ai_optimize_sql,
            commands::ai_create_table,
            commands::ai_diagnose_error,
            commands::list_groups,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::move_connection_to_group,
            commands::reorder_connections,
            commands::reorder_groups,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
