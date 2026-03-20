pub mod cache;
pub mod change_detector;
pub mod event_processor;
pub mod query;
pub mod traversal;

pub use cache::{JoinPath, GraphCacheStore};
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
        }
        Err(e) => {
            let msg = format!("增量更新失败: {}", e);
            emit_log(&app, &task_id, "ERROR", &msg);
            emit_failed(&app, &task_id, &msg);
            return;
        }
    }

    // 6. 同步指标节点
    emit_log(&app, &task_id, "INFO", "同步指标节点到图谱...");
    match sync_metrics_to_graph(connection_id) {
        Ok(n) => emit_log(&app, &task_id, "INFO", &format!("指标节点同步完成，共 {} 个", n)),
        Err(e) => emit_log(&app, &task_id, "WARN", &format!("指标同步失败（不影响主流程）: {}", e)),
    }

    // 7. 同步语义别名节点
    emit_log(&app, &task_id, "INFO", "同步语义别名节点到图谱...");
    match sync_aliases_to_graph(connection_id) {
        Ok(n) => emit_log(&app, &task_id, "INFO", &format!("别名节点同步完成，共 {} 个", n)),
        Err(e) => emit_log(&app, &task_id, "WARN", &format!("别名同步失败（不影响主流程）: {}", e)),
    }

    emit_completed(&app, &task_id);
}

/// 将 metrics 表中的活跃指标同步到 graph_nodes，并建立 metric_ref 边
pub fn sync_metrics_to_graph(connection_id: i64) -> crate::AppResult<usize> {
    let conn = crate::db::get().lock().unwrap();

    // 查询所有未拒绝的指标
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, table_name, aggregation, description, status
         FROM metrics
         WHERE connection_id = ?1 AND status != 'rejected'",
    )?;
    struct MetricRow {
        id: i64,
        name: String,
        display_name: String,
        table_name: String,
        aggregation: Option<String>,
        description: Option<String>,
        status: String,
    }
    let metrics: Vec<MetricRow> = stmt
        .query_map([connection_id], |row| {
            Ok(MetricRow {
                id: row.get(0)?,
                name: row.get(1)?,
                display_name: row.get(2)?,
                table_name: row.get(3)?,
                aggregation: row.get(4)?,
                description: row.get(5)?,
                status: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let count = metrics.len();
    let active_node_ids: Vec<String> = metrics
        .iter()
        .map(|m| format!("{}:metric:{}", connection_id, m.id))
        .collect();

    for m in &metrics {
        let node_id = format!("{}:metric:{}", connection_id, m.id);
        let table_node_id = format!("{}:table:{}", connection_id, m.table_name);

        let metadata = serde_json::json!({
            "metric_id": m.id,
            "table_name": m.table_name,
            "aggregation": m.aggregation,
            "description": m.description,
            "status": m.status,
        })
        .to_string();

        conn.execute(
            "INSERT INTO graph_nodes
               (id, node_type, connection_id, name, display_name, metadata, source, is_deleted)
             VALUES (?1, 'metric', ?2, ?3, ?4, ?5, 'schema', 0)
             ON CONFLICT(id) DO UPDATE SET
               name        = excluded.name,
               display_name = excluded.display_name,
               metadata    = excluded.metadata,
               is_deleted  = 0",
            rusqlite::params![node_id, connection_id, m.name, m.display_name, metadata],
        )?;

        if !m.table_name.is_empty() {
            let edge_id = format!("{}=>{}", node_id, table_node_id);
            conn.execute(
                "INSERT OR IGNORE INTO graph_edges (id, from_node, to_node, edge_type, weight)
                 VALUES (?1, ?2, ?3, 'metric_ref', 0.9)",
                rusqlite::params![edge_id, node_id, table_node_id],
            )?;
        }
    }

    // 软删除已不存在于 metrics 表的旧节点
    if active_node_ids.is_empty() {
        conn.execute(
            "UPDATE graph_nodes SET is_deleted=1
             WHERE connection_id=?1 AND node_type='metric'",
            [connection_id],
        )?;
    } else {
        let n = active_node_ids.len();
        let ph: String = (2..=n + 1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE graph_nodes SET is_deleted=1
             WHERE connection_id=?1 AND node_type='metric' AND id NOT IN ({ph})"
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];
        for id in &active_node_ids {
            params.push(Box::new(id.clone()));
        }
        conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
    }

    // 刷新 FTS5 索引
    conn.execute_batch("INSERT INTO graph_nodes_fts(graph_nodes_fts) VALUES('rebuild')")?;

    Ok(count)
}

/// 将 semantic_aliases 中的别名同步到 graph_nodes，并建立 alias_of 边
pub fn sync_aliases_to_graph(connection_id: i64) -> crate::AppResult<usize> {
    let conn = crate::db::get().lock().unwrap();

    let mut stmt = conn.prepare(
        "SELECT id, alias, node_id FROM semantic_aliases WHERE connection_id = ?1",
    )?;
    let aliases: Vec<(i64, String, String)> = stmt
        .query_map([connection_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()?;

    let count = aliases.len();
    let active_node_ids: Vec<String> = aliases
        .iter()
        .map(|(id, ..)| format!("{}:alias:{}", connection_id, id))
        .collect();

    for (alias_id, alias_text, source_node_id) in &aliases {
        let node_id = format!("{}:alias:{}", connection_id, alias_id);

        conn.execute(
            "INSERT INTO graph_nodes
               (id, node_type, connection_id, name, display_name, metadata, source, is_deleted)
             VALUES (?1, 'alias', ?2, ?3, ?3, NULL, 'user', 0)
             ON CONFLICT(id) DO UPDATE SET
               name         = excluded.name,
               display_name = excluded.display_name,
               is_deleted   = 0",
            rusqlite::params![node_id, connection_id, alias_text],
        )?;

        let edge_id = format!("{}=>{}", node_id, source_node_id);
        conn.execute(
            "INSERT OR IGNORE INTO graph_edges (id, from_node, to_node, edge_type, weight)
             VALUES (?1, ?2, ?3, 'alias_of', 0.8)",
            rusqlite::params![edge_id, node_id, source_node_id],
        )?;
    }

    // 软删除已不存在的别名节点
    if active_node_ids.is_empty() {
        conn.execute(
            "UPDATE graph_nodes SET is_deleted=1
             WHERE connection_id=?1 AND node_type='alias'",
            [connection_id],
        )?;
    } else {
        let n = active_node_ids.len();
        let ph: String = (2..=n + 1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE graph_nodes SET is_deleted=1
             WHERE connection_id=?1 AND node_type='alias' AND id NOT IN ({ph})"
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];
        for id in &active_node_ids {
            params.push(Box::new(id.clone()));
        }
        conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
    }

    conn.execute_batch("INSERT INTO graph_nodes_fts(graph_nodes_fts) VALUES('rebuild')")?;

    Ok(count)
}
