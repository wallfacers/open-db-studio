mod agent;
mod commands;
mod crypto;
mod datasource;
mod db;
mod error;
mod graph;
mod llm;
mod mcp;
mod metrics;
mod migration;
mod pipeline;
mod seatunnel;
mod skill_sync;
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
            // 运行时设置窗口图标（dev 模式下 .exe 内嵌图标尚未更新时也能生效）
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/icon.png");
                if let Ok(img) = image::load_from_memory(icon_bytes) {
                    let rgba = img.into_rgba8();
                    let (w, h) = rgba.dimensions();
                    let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
                    let _ = window.set_icon(icon);
                }
            }
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data dir");
            crate::db::init(&app_data_dir.to_string_lossy())?;
            crate::db::migrate_legacy_llm_settings()?;

            // MCP server 只绑 TCP 端口，速度极快，需要端口号写入 AppState
            let mcp_port = tauri::async_runtime::block_on(
                crate::mcp::start_mcp_server(app.handle().clone())
            ).expect("Failed to start MCP server");

            // 从 app_settings 读取 serve 基础端口（默认 6686），自动递增避免占用
            let base_port: u16 = crate::db::get_app_setting("serve_port")
                .unwrap_or_default()
                .as_deref()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(6686);
            let serve_port = crate::agent::server::find_available_port(base_port);
            if serve_port != base_port {
                log::info!("Port {} busy, using {} for opencode serve", base_port, serve_port);
            }

            app.manage(crate::state::AppState {
                mcp_port,
                app_data_dir: app_data_dir.clone(),
                serve_child: tokio::sync::Mutex::new(None),
                serve_port,
                current_explain_session_id: tokio::sync::Mutex::new(None),
                editor_sql_map: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                last_active_session_id: tokio::sync::Mutex::new(None),
                pending_diff_response: tokio::sync::Mutex::new(None),
                pending_ui_actions: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                pending_queries: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                auto_mode: tokio::sync::Mutex::new({
                    crate::db::get_app_setting("auto_mode").unwrap_or_default()
                        .as_deref() == Some("true")
                }),
                task_abort_handles: std::sync::Mutex::new(std::collections::HashMap::new()),
                graph_cache: crate::graph::GraphCacheStore::new(),
            });

            // ── 后台初始化（文件 I/O + 进程启动，避免阻塞主线程导致"未响应"）──────
            let handle = app.handle().clone();
            let data_dir_clone = app_data_dir.clone();

            tauri::async_runtime::spawn(async move {
                let opencode_dir = data_dir_clone.join("opencode");

                // 1. 写入 MCP 配置（opencode/opencode.json）
                if let Err(e) = crate::agent::config::write_mcp_config(&opencode_dir, mcp_port) {
                    log::warn!("Failed to write MCP config: {}", e);
                }

                // 1b. 将 DB 中所有 custom provider 的 models 列表同步到 opencode.json
                match crate::db::list_llm_configs() {
                    Ok(configs) => {
                        if let Err(e) = crate::agent::config::sync_all_providers(&opencode_dir, &configs) {
                            log::warn!("Failed to sync providers to opencode.json: {}", e);
                        }
                    }
                    Err(e) => log::warn!("Failed to list llm_configs for sync: {}", e),
                }

                // 2. 写入 Agent 提示词文件（opencode/agents/）
                if let Err(e) = crate::agent::config::write_agent_prompts(&opencode_dir) {
                    log::warn!("Failed to write agent prompts: {}", e);
                }

                // 3. 启动 opencode serve 进程（健康检查最多等 10s）
                if let Err(e) = crate::agent::server::start_serve(handle.clone(), &data_dir_clone, serve_port).await {
                    log::warn!(
                        "opencode serve failed to start (port {}): {}. \
                         Other features remain available.",
                        serve_port, e
                    );
                }

                // 4. 同步 skills 到 opencode 可读取的目录（文件哈希比较 + 复制）
                crate::skill_sync::sync_skills_on_startup(&handle);
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
            commands::ai_explain_sql_acp,
            commands::cancel_explain_acp_session,
            commands::ai_create_table,
            commands::ai_generate_table_schema,
            commands::ai_diagnose_error,
            commands::list_groups,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::move_connection_to_group,
            commands::reorder_connections,
            commands::reorder_groups,
            commands::list_databases,
            commands::list_databases_for_metrics,
            commands::list_schemas_for_metrics,
            commands::get_metric,
            commands::list_metrics_by_node,
            commands::list_metrics_paged,
            commands::count_metrics_batch,
            commands::list_schemas,
            commands::list_objects,
            commands::list_tables_with_stats,
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
            commands::backup_database,
            commands::import_to_table,
            commands::preview_import_file,
            commands::get_table_columns_for_import,
            commands::show_in_folder,
            commands::get_db_version,
            commands::list_metrics,
            commands::save_metric,
            commands::update_metric,
            commands::delete_metric,
            commands::approve_metric,
            commands::build_schema_graph,
            commands::get_graph_nodes,
            commands::search_graph,
            commands::get_graph_edges,
            commands::update_node_alias,
            commands::update_graph_node_metadata,
            commands::ai_generate_metrics,
            commands::list_tables_with_column_count,
            commands::ai_generate_sql_v2,
            commands::acp_permission_respond,
            commands::acp_elicitation_respond,
            commands::mcp_diff_respond,
            commands::get_ui_state,
            commands::set_ui_state,
            commands::delete_ui_state,
            commands::test_connection_by_id,
            commands::read_tab_file,
            commands::write_tab_file,
            commands::delete_tab_file,
            commands::list_tab_files,
            commands::get_auto_mode,
            commands::set_auto_mode,
            commands::mcp_ui_action_respond,
            commands::mcp_query_respond,
            commands::agent_create_session,
            commands::agent_delete_session,
            commands::agent_delete_all_sessions,
            commands::agent_list_sessions,
            commands::agent_get_session_messages,
            commands::agent_clear_session_history,
            commands::agent_cancel_session,
            commands::agent_permission_respond,
            commands::agent_chat,
            commands::agent_request_ai_title,
            commands::agent_apply_config,
            commands::agent_list_providers,
            commands::test_llm_config_inline,
            commands::agent_explain_sql,
            commands::cancel_explain_sql,
            commands::agent_revert_message,
            commands::agent_unrevert_message,
            commands::agent_summarize_session,
            commands::agent_get_last_user_message_id,
            seatunnel::commands::list_st_connections,
            seatunnel::commands::create_st_connection,
            seatunnel::commands::update_st_connection,
            seatunnel::commands::delete_st_connection,
            seatunnel::commands::list_st_categories,
            seatunnel::commands::create_st_category,
            seatunnel::commands::rename_st_category,
            seatunnel::commands::delete_st_category,
            seatunnel::commands::move_st_category,
            seatunnel::commands::list_st_jobs,
            seatunnel::commands::create_st_job,
            seatunnel::commands::update_st_job,
            seatunnel::commands::delete_st_job,
            seatunnel::commands::rename_st_job,
            seatunnel::commands::move_st_job,
            seatunnel::commands::submit_st_job,
            seatunnel::commands::stop_st_job,
            seatunnel::commands::get_st_job_status,
            seatunnel::commands::stream_st_job_logs,
            seatunnel::commands::cancel_st_job_stream,
            seatunnel::commands::test_st_connection,
            commands::add_user_node,
            commands::delete_graph_node,
            commands::add_user_edge,
            commands::delete_graph_edge,
            commands::update_graph_edge,
            commands::find_subgraph,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    // 先关闭数据库连接池，再停止 serve 进程
                    // 此时 Tokio 运行时仍存活，可以正常发送关闭包给 MySQL/Postgres
                    crate::datasource::pool_cache::close_all().await;
                    crate::agent::server::stop_serve(&handle).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
