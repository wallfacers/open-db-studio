pub mod cache;
pub mod change_detector;
pub mod comment_parser;
pub mod event_processor;
pub mod query;
pub mod traversal;

pub use cache::{JoinPath, GraphCacheStore};
pub use query::{GraphNode, GraphEdge, search_graph, SubGraph};

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

fn emit_completed(app: &tauri::AppHandle, task_id: &str, logs: &[TaskLogLine]) {
    let now = chrono::Utc::now().to_rfc3339();
    let logs_json = serde_json::to_string(logs).unwrap_or_default();
    let _ = crate::db::update_task(task_id, &crate::db::models::UpdateTaskInput {
        status: Some("completed".to_string()),
        progress: Some(100),
        completed_at: Some(now),
        logs: Some(logs_json),
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

fn emit_failed(app: &tauri::AppHandle, task_id: &str, error: &str, logs: &[TaskLogLine]) {
    let now = chrono::Utc::now().to_rfc3339();
    let logs_json = serde_json::to_string(logs).unwrap_or_default();
    let _ = crate::db::update_task(task_id, &crate::db::models::UpdateTaskInput {
        status: Some("failed".to_string()),
        error: Some(error.to_string()),
        completed_at: Some(now),
        logs: Some(logs_json),
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
/// 构建单个数据库的图谱（schema fetch + change detect + event process + comment links）
async fn build_single_database(
    app: &tauri::AppHandle,
    task_id: &str,
    logs: &mut Vec<TaskLogLine>,
    connection_id: i64,
    config: &crate::datasource::ConnectionConfig,
) -> Result<(), String> {
    macro_rules! log_emit_inner {
        ($level:expr, $msg:expr) => {{
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            logs.push(TaskLogLine {
                level: $level.to_string(),
                message: $msg.to_string(),
                timestamp_ms: ts,
            });
            emit_log(app, task_id, $level, $msg);
        }};
    }

    let ds = crate::datasource::create_datasource(config)
        .await
        .map_err(|e| format!("连接数据源失败: {}", e))?;

    let db_label = config.database.as_deref().unwrap_or("(default)");
    log_emit_inner!("INFO", &format!("已连接数据源 [{}]，正在获取 Schema...", db_label));

    let schema = ds.get_schema().await.map_err(|e| format!("获取 Schema 失败: {}", e))?;
    log_emit_inner!("INFO", &format!("Schema 获取完成，共 {} 张表", schema.tables.len()));

    let mut table_columns = HashMap::new();
    let mut table_fks = HashMap::new();
    let is_pg = config.driver == "postgres" || config.driver == "gaussdb";

    for table in &schema.tables {
        let cols = match ds.get_columns(&table.name, table.schema.as_deref()).await {
            Ok(c) => c,
            Err(e) => {
                log_emit_inner!("WARN", &format!("获取表 {} 列信息失败: {}", table.name, e));
                vec![]
            }
        };
        let fks = match ds.get_foreign_keys(&table.name, table.schema.as_deref()).await {
            Ok(f) => f,
            Err(e) => {
                log_emit_inner!("WARN", &format!("获取表 {} 外键信息失败: {}", table.name, e));
                vec![]
            }
        };
        // PG/GaussDB: 使用 schema.table_name 作为 key，避免不同 schema 同名表冲突
        let key = if is_pg {
            match &table.schema {
                Some(s) => format!("{}.{}", s, table.name),
                None => table.name.clone(),
            }
        } else {
            table.name.clone()
        };
        table_columns.insert(key.clone(), cols);
        table_fks.insert(key, fks);
    }

    // 对 PG，schema 也要重写到 SchemaInfo 中使 detect_and_log_changes 使用限定名
    let schema_for_detect = if is_pg {
        let tables = schema.tables.iter().map(|t| {
            let mut t2 = t.clone();
            if let Some(s) = &t.schema {
                t2.name = format!("{}.{}", s, t.name);
            }
            t2
        }).collect();
        crate::datasource::SchemaInfo { tables }
    } else {
        schema
    };

    // 解析列注释生成虚拟关系 Link Node
    let known_tables: std::collections::HashSet<String> =
        schema_for_detect.tables.iter().map(|t| t.name.clone()).collect();
    match build_comment_links(connection_id, &table_columns, &known_tables, config.database.as_deref(), None) {
        Ok(n) => log_emit_inner!("INFO", &format!("注释关系解析完成，共 {} 条虚拟边", n)),
        Err(e) => log_emit_inner!("WARN", &format!("注释关系解析失败: {}", e)),
    }

    // 检测变更并写入 schema_change_log
    crate::graph::change_detector::detect_and_log_changes(
        connection_id,
        &schema_for_detect,
        &table_columns,
        &table_fks,
        config.database.as_deref(),
    )
    .map_err(|e| format!("变更检测失败: {}", e))?;

    // 处理待消费事件
    event_processor::process_pending_events(app, connection_id, task_id)
        .await
        .map_err(|e| format!("增量更新失败: {}", e))?;

    Ok(())
}

pub async fn run_graph_build(
    app: tauri::AppHandle,
    task_id: String,
    connection_id: i64,
    database: Option<String>,
) {
    let mut logs: Vec<TaskLogLine> = Vec::new();

    // 同时 emit 事件到前端 + 追加到 logs Vec（完成后持久化）
    macro_rules! log_emit {
        ($level:expr, $msg:expr) => {{
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            logs.push(TaskLogLine {
                level: $level.to_string(),
                message: $msg.to_string(),
                timestamp_ms: ts,
            });
            emit_log(&app, &task_id, $level, $msg);
        }};
    }

    log_emit!("INFO", "开始构建知识图谱...");

    // 1. 获取连接配置并连接外部数据源
    let mut config = match crate::db::get_connection_config(connection_id) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("获取连接配置失败: {}", e);
            log_emit!("ERROR", &msg);
            emit_failed(&app, &task_id, &msg, &logs);
            return;
        }
    };
    // 若调用方指定了 database（如 MySQL 多库场景），覆盖连接配置中存储的默认库名
    if let Some(db) = database.filter(|s| !s.is_empty()) {
        config.database = Some(db);
    }

    // 判断是否需要遍历多数据库（连接维度构建）
    let effective_db = config.database.as_deref().unwrap_or("");
    let is_multi_db_driver = matches!(config.driver.as_str(), "mysql" | "postgres" | "doris" | "tidb" | "clickhouse" | "gaussdb");

    if effective_db.is_empty() && is_multi_db_driver {
        // ── 连接维度构建：遍历所有数据库 ──────────────────────────────────
        log_emit!("INFO", "未指定数据库，将遍历所有数据库进行构建...");

        // 先用默认配置创建临时 datasource 获取数据库列表
        let tmp_ds = match crate::datasource::create_datasource(&config).await {
            Ok(ds) => ds,
            Err(e) => {
                let msg = format!("连接数据源失败: {}", e);
                log_emit!("ERROR", &msg);
                emit_failed(&app, &task_id, &msg, &logs);
                return;
            }
        };

        let all_dbs = match tmp_ds.list_databases().await {
            Ok(dbs) => dbs,
            Err(e) => {
                let msg = format!("获取数据库列表失败: {}", e);
                log_emit!("ERROR", &msg);
                emit_failed(&app, &task_id, &msg, &logs);
                return;
            }
        };
        drop(tmp_ds);

        // 过滤系统库
        const SYSTEM_DBS: &[&str] = &[
            "information_schema", "pg_catalog", "performance_schema",
            "sys", "mysql", "template0", "template1",
        ];
        let user_dbs: Vec<String> = all_dbs
            .into_iter()
            .filter(|d| !SYSTEM_DBS.contains(&d.as_str()))
            .collect();

        if user_dbs.is_empty() {
            log_emit!("WARN", "未发现用户数据库，跳过构建");
            emit_completed(&app, &task_id, &logs);
            return;
        }

        let total = user_dbs.len();
        log_emit!("INFO", &format!("发现 {} 个数据库，开始逐一构建...", total));

        for (i, db_name) in user_dbs.iter().enumerate() {
            log_emit!("INFO", &format!("正在构建数据库 {} ({}/{})...", db_name, i + 1, total));

            let mut db_config = config.clone();
            db_config.database = Some(db_name.clone());

            if let Err(msg) = build_single_database(
                &app, &task_id, &mut logs, connection_id, &db_config,
            ).await {
                log_emit!("WARN", &format!("数据库 {} 构建失败: {}", db_name, msg));
                // 不中断整体流程，继续下一个数据库
            }
        }
    } else {
        // ── 单数据库构建（原有逻辑）────────────────────────────────────────
        if let Err(msg) = build_single_database(
            &app, &task_id, &mut logs, connection_id, &config,
        ).await {
            log_emit!("ERROR", &msg);
            emit_failed(&app, &task_id, &msg, &logs);
            return;
        }
    }

    // 6. 同步指标节点
    log_emit!("INFO", "同步指标节点到图谱...");
    match sync_metrics_to_graph(connection_id) {
        Ok(n) => log_emit!("INFO", &format!("指标节点同步完成，共 {} 个", n)),
        Err(e) => log_emit!("WARN", &format!("指标同步失败（不影响主流程）: {}", e)),
    }

    // 7. 同步语义别名节点
    log_emit!("INFO", "同步语义别名节点到图谱...");
    match sync_aliases_to_graph(connection_id) {
        Ok(n) => log_emit!("INFO", &format!("别名节点同步完成，共 {} 个", n)),
        Err(e) => log_emit!("WARN", &format!("别名同步失败（不影响主流程）: {}", e)),
    }

    // 8. 失效图缓存，确保下次 find_join_paths 使用最新数据
    {
        use tauri::Manager;
        let app_state = app.state::<crate::AppState>();
        app_state.graph_cache.invalidate(connection_id).await;
        log_emit!("INFO", "图缓存已失效，下次查询将重新加载");
    }

    emit_completed(&app, &task_id, &logs);
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
        // 去除 AI 返回的 table_name 可能携带的前后空白
        let table_name = m.table_name.trim();

        let metadata = serde_json::json!({
            "metric_id": m.id,
            "table_name": table_name,
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

        // 先删除该指标的旧 metric_ref 边，避免 table_name 变更后留下死链
        conn.execute(
            "DELETE FROM graph_edges WHERE from_node = ?1 AND edge_type = 'metric_ref'",
            [&node_id],
        )?;

        // 仅在目标表节点存在（is_deleted=0）时建立边，防止死链
        if !table_name.is_empty() {
            let table_node_id = format!("{}:table:{}", connection_id, table_name);
            let table_exists: bool = conn.query_row(
                "SELECT COUNT(*) FROM graph_nodes WHERE id = ?1 AND is_deleted = 0",
                [&table_node_id],
                |row| row.get::<_, i64>(0),
            ).unwrap_or(0) > 0;

            if table_exists {
                let edge_id = format!("{}=>{}", node_id, table_node_id);
                conn.execute(
                    "INSERT OR IGNORE INTO graph_edges (id, from_node, to_node, edge_type, weight)
                     VALUES (?1, ?2, ?3, 'metric_ref', 0.9)",
                    rusqlite::params![edge_id, node_id, table_node_id],
                )?;
            } else {
                log::warn!(
                    "[sync_metrics] 指标 {} 的目标表节点 {} 不存在或已被软删除，跳过建边",
                    m.name, table_node_id
                );
            }
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

/// 步骤 3.5：从列注释解析虚拟关系 Link Node
/// 幂等：先清除旧 source='comment' 的节点和边，再重新生成
fn build_comment_links(
    connection_id: i64,
    table_columns: &std::collections::HashMap<String, Vec<crate::datasource::ColumnMeta>>,
    known_tables: &std::collections::HashSet<String>,
    database: Option<&str>,
    _schema_name: Option<&str>,
) -> crate::AppResult<usize> {
    let conn = crate::db::get().lock().unwrap();

    // 开启事务：批量写入减少锁竞争，同时保证原子性
    conn.execute_batch("BEGIN")?;

    let result = (|| -> crate::AppResult<usize> {
    // 1. 清除旧 source='comment' 的边
    conn.execute(
        "DELETE FROM graph_edges
         WHERE source = 'comment'
           AND (from_node IN (SELECT id FROM graph_nodes WHERE connection_id = ?1)
                OR to_node IN (SELECT id FROM graph_nodes WHERE connection_id = ?1))",
        [connection_id],
    )?;
    // 清除旧 source='comment' 的 link 节点
    conn.execute(
        "DELETE FROM graph_nodes
         WHERE connection_id = ?1 AND source = 'comment' AND node_type = 'link'",
        [connection_id],
    )?;

    let mut count = 0;

    for (table_name, columns) in table_columns {
        let table_node_id = format!("{}:table:{}", connection_id, table_name);

        for col in columns {
            let comment = match &col.comment {
                Some(c) if !c.is_empty() => c,
                _ => continue,
            };

            let refs = crate::graph::comment_parser::parse_comment_refs(comment);

            for r in &refs {
                // 目标表不存在于当前 Schema → 跳过
                if !known_tables.contains(&r.target_table) {
                    log::warn!(
                        "[comment_links] 目标表 '{}' 不存在，跳过注释引用 ({}.{})",
                        r.target_table, table_name, col.name
                    );
                    continue;
                }

                let target_node_id = format!("{}:table:{}", connection_id, r.target_table);

                // 检查是否已有 source='schema' 的 Link Node 连接这两张表
                let schema_link_exists: bool = match conn.query_row(
                    "SELECT COUNT(*)
                     FROM graph_nodes ln
                     JOIN graph_edges e1 ON e1.to_node = ln.id
                     JOIN graph_edges e2 ON e2.from_node = ln.id
                     WHERE ln.node_type = 'link'
                       AND ln.connection_id = ?1
                       AND ln.source = 'schema'
                       AND e1.from_node = ?2
                       AND e2.to_node = ?3",
                    rusqlite::params![connection_id, table_node_id, target_node_id],
                    |row| row.get::<_, i64>(0),
                ) {
                    Ok(n) => n > 0,
                    Err(e) => {
                        log::warn!(
                            "[comment_links] 检查 schema link 失败，跳过 {}.{}: {}",
                            table_name, col.name, e
                        );
                        continue;
                    }
                };

                if schema_link_exists {
                    continue;
                }

                // 生成 comment 来源的 Link Node ID
                let link_node_id = format!(
                    "{}:link:comment_{}_{}_{}",
                    connection_id, table_name, r.target_table, col.name
                );

                let metadata = serde_json::json!({
                    "source_table": table_name,
                    "target_table": r.target_table,
                    "via": col.name,
                    "cardinality": "N:1",
                    "on_delete": "NO ACTION",
                    "description": format!("{}.{} → {}.{} (注释推断)", table_name, col.name, r.target_table, r.target_column),
                    "relation_type": r.relation_type,
                    "source_column": col.name,
                    "target_column": r.target_column,
                }).to_string();

                // 插入 Link Node
                conn.execute(
                    "INSERT OR REPLACE INTO graph_nodes
                       (id, node_type, connection_id, database, name, display_name, metadata, source, is_deleted)
                     VALUES (?1, 'link', ?2, ?6, ?3, ?4, ?5, 'comment', 0)",
                    rusqlite::params![
                        link_node_id,
                        connection_id,
                        link_node_id,
                        format!("{}.{} → {}.{}", table_name, col.name, r.target_table, r.target_column),
                        metadata,
                        database,
                    ],
                )?;

                // 两条边: table → link_node, link_node → target_table
                let edge_to_link = format!("{}=>{}", table_node_id, link_node_id);
                let edge_from_link = format!("{}=>{}", link_node_id, target_node_id);

                conn.execute(
                    "INSERT OR IGNORE INTO graph_edges
                       (id, from_node, to_node, edge_type, weight, source)
                     VALUES (?1, ?2, ?3, 'to_link', 1.0, 'comment')",
                    rusqlite::params![edge_to_link, table_node_id, link_node_id],
                )?;

                conn.execute(
                    "INSERT OR IGNORE INTO graph_edges
                       (id, from_node, to_node, edge_type, weight, source)
                     VALUES (?1, ?2, ?3, 'from_link', 1.0, 'comment')",
                    rusqlite::params![edge_from_link, link_node_id, target_node_id],
                )?;

                count += 1;
            }
        }
    }

    Ok(count)
    })();

    match &result {
        Ok(_) => { let _ = conn.execute_batch("COMMIT"); }
        Err(_) => { let _ = conn.execute_batch("ROLLBACK"); }
    }

    result
}

/// Lightweight incremental schema graph refresh.
/// Detects table additions/removals and column changes, updates graph nodes accordingly.
/// Does NOT re-parse comment links, sync metrics, or sync aliases.
pub async fn refresh_schema_graph(connection_id: i64, database: Option<String>) -> crate::AppResult<()> {
    use sha2::{Sha256, Digest};

    // 1. Get connection config and reuse pooled datasource
    let config = match crate::db::get_connection_config(connection_id) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[refresh_schema_graph] Failed to get config: {}", e);
            return Ok(());
        }
    };
    let db_name = database.filter(|s| !s.is_empty())
        .or_else(|| config.database.clone())
        .unwrap_or_default();

    let ds = match crate::datasource::pool_cache::get_or_create(
        connection_id, &config, &db_name, "",
    ).await {
        Ok(ds) => ds,
        Err(e) => {
            log::warn!("[refresh_schema_graph] Failed to get datasource: {}", e);
            return Ok(());
        }
    };

    // 2. Fetch current tables from datasource
    let current_tables = match ds.get_tables().await {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[refresh_schema_graph] Failed to get tables: {}", e);
            return Ok(());
        }
    };

    // 3. Fetch existing graph table nodes
    let existing_nodes = match crate::graph::query::get_nodes(connection_id, Some("table")) {
        Ok(n) => n,
        Err(e) => {
            log::warn!("[refresh_schema_graph] Failed to get graph nodes: {}", e);
            return Ok(());
        }
    };

    // Build lookup maps (PG: use schema.table_name as key)
    let is_pg = config.driver == "postgres" || config.driver == "gaussdb";
    let current_set: std::collections::HashMap<String, &crate::datasource::TableMeta> =
        current_tables.iter().map(|t| {
            let key = if is_pg {
                match &t.schema {
                    Some(s) => format!("{}.{}", s, t.name),
                    None => t.name.clone(),
                }
            } else {
                t.name.clone()
            };
            (key, t)
        }).collect();
    let existing_set: std::collections::HashMap<String, &crate::graph::query::GraphNode> =
        existing_nodes.iter()
            .filter(|n| n.is_deleted.unwrap_or(0) == 0)
            .map(|n| (n.name.clone(), n))
            .collect();

    // 4. Detect added tables — insert new nodes (sync DB block, drop before await)
    {
        let conn = crate::db::get().lock().unwrap();
        for (name, table) in &current_set {
            if !existing_set.contains_key(name) {
                let node_id = format!("{}:table:{}", connection_id, name);
                let metadata = serde_json::json!({
                    "schema": table.schema,
                    "table_type": table.table_type,
                }).to_string();
                conn.execute(
                    "INSERT INTO graph_nodes (id, node_type, connection_id, database, schema_name, name, display_name, metadata, source, is_deleted)
                     VALUES (?1, 'table', ?2, ?5, ?6, ?3, ?3, ?4, 'schema', 0)
                     ON CONFLICT(id) DO UPDATE SET is_deleted = 0, metadata = excluded.metadata",
                    rusqlite::params![node_id, connection_id, name, metadata, db_name, table.schema],
                ).unwrap_or(0);
                log::info!("[refresh_schema_graph] Added table node: {}", name);
            }
        }

        // 5. Detect removed tables — soft delete
        for name in existing_set.keys() {
            if !current_set.contains_key(name) {
                let node_id = format!("{}:table:{}", connection_id, name);
                conn.execute(
                    "UPDATE graph_nodes SET is_deleted = 1 WHERE id = ?1",
                    [&node_id],
                ).unwrap_or(0);
                log::info!("[refresh_schema_graph] Soft-deleted table node: {}", name);
            }
        }
    } // conn dropped here — safe to await below

    // 6. For unchanged tables, check column hash changes (async fetch + sync update)
    // Collect column hashes asynchronously first
    let mut hash_updates: Vec<(String, String, serde_json::Value)> = Vec::new(); // (node_id, new_hash, table_meta)
    for (name, _node) in &existing_set {
        if !current_set.contains_key(name) {
            continue;
        }
        let schema_hint = current_set[name].schema.as_deref();
        let cols = match ds.get_columns(name, schema_hint).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut col_names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        col_names.sort();
        let mut hasher = Sha256::new();
        for cn in &col_names {
            hasher.update(cn.as_bytes());
            hasher.update(b"|");
        }
        let new_hash = format!("{:x}", hasher.finalize());
        let node_id = format!("{}:table:{}", connection_id, name);
        let table = current_set[name];
        let meta = serde_json::json!({
            "schema": table.schema,
            "table_type": table.table_type,
            "col_hash": new_hash,
        });
        hash_updates.push((node_id, new_hash, meta));
    }

    // Now do sync DB updates with a fresh lock
    {
        let conn = crate::db::get().lock().unwrap();
        for (node_id, new_hash, meta) in &hash_updates {
            let stored_hash: Option<String> = conn.query_row(
                "SELECT metadata FROM graph_nodes WHERE id = ?1",
                [node_id.as_str()],
                |row| row.get::<_, Option<String>>(0),
            ).unwrap_or(None).and_then(|m| {
                serde_json::from_str::<serde_json::Value>(&m).ok()
                    .and_then(|v| v.get("col_hash").and_then(|h| h.as_str().map(String::from)))
            });

            if stored_hash.as_deref() != Some(new_hash.as_str()) {
                let metadata_str = meta.to_string();
                conn.execute(
                    "UPDATE graph_nodes SET metadata = ?1 WHERE id = ?2",
                    rusqlite::params![metadata_str, node_id],
                ).unwrap_or(0);
                log::info!("[refresh_schema_graph] Updated column hash for table node: {}", node_id);
            }
        }

        // 7. Rebuild FTS index
        let _ = conn.execute_batch("INSERT INTO graph_nodes_fts(graph_nodes_fts) VALUES('rebuild')");
    }

    Ok(())
}
