pub mod change_detector;
pub mod event_processor;
pub mod query;
pub mod traversal;

pub use query::{GraphNode, GraphEdge, search_graph};

use std::collections::HashMap;
use tauri::Emitter;

// ─── 事件结构（复用 task-progress 格式）─────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct TaskLogLine {
    level: String,
    message: String,
    timestamp_ms: i64,
}

#[derive(serde::Serialize, Clone)]
struct TaskProgressEvent {
    task_id: String,
    status: String,
    progress: f32,
    processed_rows: i64,
    total_rows: Option<i64>,
    current_target: String,
    error: Option<String>,
    output_path: Option<String>,
    log_line: Option<TaskLogLine>,
    connection_id: Option<i64>,
    database: Option<String>,
    schema: Option<String>,
    metric_count: Option<i64>,
    skipped_count: Option<i64>,
}

fn emit_log(app: &tauri::AppHandle, task_id: &str, level: &str, message: &str) {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let _ = app.emit("task-progress", TaskProgressEvent {
        task_id: task_id.to_string(),
        status: "running".to_string(),
        progress: 0.0,
        processed_rows: 0,
        total_rows: None,
        current_target: String::new(),
        error: None,
        output_path: None,
        log_line: Some(TaskLogLine {
            level: level.to_string(),
            message: message.to_string(),
            timestamp_ms,
        }),
        connection_id: None,
        database: None,
        schema: None,
        metric_count: None,
        skipped_count: None,
    });
}

fn emit_completed(app: &tauri::AppHandle, task_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = crate::db::update_task(task_id, &crate::db::models::UpdateTaskInput {
        status: Some("completed".to_string()),
        progress: Some(100),
        completed_at: Some(now),
        ..Default::default()
    });
    let _ = app.emit("task-progress", TaskProgressEvent {
        task_id: task_id.to_string(),
        status: "completed".to_string(),
        progress: 100.0,
        processed_rows: 0,
        total_rows: None,
        current_target: String::new(),
        error: None,
        output_path: None,
        log_line: None,
        connection_id: None,
        database: None,
        schema: None,
        metric_count: None,
        skipped_count: None,
    });
}

fn emit_failed(app: &tauri::AppHandle, task_id: &str, error: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = crate::db::update_task(task_id, &crate::db::models::UpdateTaskInput {
        status: Some("failed".to_string()),
        error: Some(error.to_string()),
        completed_at: Some(now),
        ..Default::default()
    });
    let _ = app.emit("task-progress", TaskProgressEvent {
        task_id: task_id.to_string(),
        status: "failed".to_string(),
        progress: 0.0,
        processed_rows: 0,
        total_rows: None,
        current_target: String::new(),
        error: Some(error.to_string()),
        output_path: None,
        log_line: None,
        connection_id: None,
        database: None,
        schema: None,
        metric_count: None,
        skipped_count: None,
    });
}

/// 协调整个知识图谱构建流程（全量 detect + 增量 process）
pub async fn run_graph_build(
    app: tauri::AppHandle,
    task_id: String,
    connection_id: i64,
    database: Option<String>,
) {
    emit_log(&app, &task_id, "INFO", "开始构建知识图谱...");

    // 1. 获取连接配置并连接外部数据源
    let mut config = match crate::db::get_connection_config(connection_id) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("获取连接配置失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
            return;
        }
    };
    // 若调用方指定了 database（如 MySQL 多库场景），覆盖连接配置中存储的默认库名
    if let Some(db) = database.filter(|s| !s.is_empty()) {
        config.database = db;
    }

    let ds = match crate::datasource::create_datasource(&config).await {
        Ok(ds) => ds,
        Err(e) => {
            let msg = format!("连接数据源失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
            return;
        }
    };

    emit_log(&app, &task_id, "INFO", "已连接数据源，正在获取 Schema...");

    // 2. 获取 SchemaInfo
    let schema = match ds.get_schema().await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("获取 Schema 失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
            return;
        }
    };

    emit_log(
        &app,
        &task_id,
        "INFO",
        &format!("Schema 获取完成，共 {} 张表", schema.tables.len()),
    );

    // 3. 拉取各表的列和外键信息（await 在锁外完成）
    let mut table_columns = HashMap::new();
    let mut table_fks = HashMap::new();

    log::info!(
        "[run_graph_build] connection={} schema has {} tables: {:?}",
        connection_id,
        schema.tables.len(),
        schema.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>()
    );

    for table in &schema.tables {
        let cols = match ds.get_columns(&table.name, table.schema.as_deref()).await {
            Ok(c) => c,
            Err(e) => {
                emit_log(&app, &task_id, "WARN", &format!("获取表 {} 列信息失败: {}", table.name, e));
                vec![]
            }
        };
        let fks = match ds.get_foreign_keys(&table.name, table.schema.as_deref()).await {
            Ok(f) => f,
            Err(e) => {
                emit_log(&app, &task_id, "WARN", &format!("获取表 {} 外键信息失败: {}", table.name, e));
                vec![]
            }
        };
        table_columns.insert(table.name.clone(), cols);
        table_fks.insert(table.name.clone(), fks);
    }

    // 4. 检测变更并写入 schema_change_log
    emit_log(&app, &task_id, "INFO", "正在检测 Schema 变更...");
    match crate::graph::change_detector::detect_and_log_changes(
        connection_id,
        &schema,
        &table_columns,
        &table_fks,
    ) {
        Ok(n) => {
            emit_log(
                &app,
                &task_id,
                "INFO",
                &format!("变更检测完成，共 {} 条变更事件", n),
            );
        }
        Err(e) => {
            let msg = format!("变更检测失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
            return;
        }
    }

    // 5. 处理待消费事件（增量更新 graph_nodes + FTS5）
    emit_log(&app, &task_id, "INFO", "正在增量更新图谱节点...");
    match event_processor::process_pending_events(&app, connection_id, &task_id).await {
        Ok(stats) => {
            log::info!(
                "[run_graph_build] connection={} done: inserted={} updated={} skipped={} fts={}",
                connection_id,
                stats.inserted,
                stats.updated,
                stats.skipped,
                stats.fts_updated
            );
            emit_completed(&app, &task_id);
        }
        Err(e) => {
            let msg = format!("增量更新失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
        }
    }
}
