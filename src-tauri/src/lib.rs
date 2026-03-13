mod acp;
mod commands;
mod crypto;
mod datasource;
mod db;
mod error;
mod llm;
mod mcp;
mod state;

pub use error::{AppError, AppResult};
pub use state::AppState;

pub fn run() {
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

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
            // 写入 AGENTS.md 到 opencode 工作目录，指导 AI 使用工具
            {
                use std::path::PathBuf;
                let agents_dir = PathBuf::from(
                    std::env::var("APPDATA").unwrap_or_else(|_| ".".into())
                ).join("open-db-studio");
                std::fs::create_dir_all(&agents_dir).ok();
                let agents_path = agents_dir.join("AGENTS.md");
                let agents_content = include_str!("../assets/AGENTS.md");
                if let Err(e) = std::fs::write(&agents_path, agents_content) {
                    log::error!("Failed to write AGENTS.md: {}", e);
                    // 降级：继续启动，AI 使用 opencode 默认行为
                } else {
                    log::info!("Wrote AGENTS.md to {:?}", agents_path);
                }
            }
            let mcp_port = tauri::async_runtime::block_on(
                crate::mcp::start_mcp_server(app.handle().clone())
            ).expect("Failed to start MCP server");
            app.manage(crate::state::AppState {
                mcp_port,
                acp_session: tokio::sync::Mutex::new(None),
                current_editor_sql: tokio::sync::Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::create_connection,
            commands::test_connection,
            commands::delete_connection,
            commands::update_connection,
            commands::get_connection_password,
            commands::execute_query,
            commands::get_tables,
            commands::get_schema,
            commands::ai_chat,
            commands::ai_chat_stream,
            commands::ai_generate_sql,
            commands::ai_explain_sql,
            commands::get_query_history,
            commands::list_llm_configs,
            commands::get_llm_config_key,
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
            commands::ai_chat_stream_with_tools,
            commands::ai_chat_continue,
            commands::agent_get_table_sample,
            commands::agent_execute_sql,
            commands::ai_chat_acp,
            commands::cancel_acp_session,
            commands::get_task_list,
            commands::create_task,
            commands::update_task,
            commands::delete_task,
            commands::get_task_by_id,
            commands::cancel_task,
            commands::retry_task,
            commands::create_database,
            commands::drop_database,
            commands::export_tables,
            commands::import_to_table,
            commands::preview_import_file,
            commands::get_table_columns_for_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
