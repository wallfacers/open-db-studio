//! event_processor.rs
//!
//! 消费 schema_change_log 中未处理的变更事件，以增量方式更新 graph_nodes 和 FTS5 索引。

use anyhow::Result;
use chrono::Utc;
use std::collections::HashMap;

use super::emit_log;

// ─── 结果统计 ─────────────────────────────────────────────────────────────────

pub struct ProcessStats {
    pub inserted: usize,
    pub updated: usize,
    pub skipped: usize,
    pub fts_updated: usize,
}

// ─── 内部数据结构 ──────────────────────────────────────────────────────────────

#[derive(Debug)]
struct PendingEvent {
    id: i64,
    event_type: String,
    table_name: String,
    column_name: Option<String>,
    metadata: Option<String>,
}

/// 查询 source 字段（仅在需要时）
fn get_node_source(
    conn: &rusqlite::Connection,
    node_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT source FROM graph_nodes WHERE id = ?1",
        [node_id],
        |row| row.get(0),
    ).optional()
}

/// 获取节点的 rowid（用于 FTS5 更新）
fn get_node_rowid(
    conn: &rusqlite::Connection,
    node_id: &str,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT rowid FROM graph_nodes WHERE id = ?1",
        [node_id],
        |row| row.get(0),
    ).optional()
}

/// FTS5 增量 Upsert：先 DELETE 旧条目再 INSERT 新条目
fn upsert_fts(conn: &rusqlite::Connection, rowid: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM graph_nodes_fts WHERE rowid = ?1",
        [rowid],
    )?;
    conn.execute(
        "INSERT INTO graph_nodes_fts(rowid, node_id, name, display_name, aliases)
         SELECT rowid, id, name, display_name, aliases
         FROM graph_nodes WHERE rowid = ?1",
        [rowid],
    )?;
    Ok(())
}

/// node_id 生成规则（与 builder.rs 保持一致）
fn make_node_id(connection_id: i64, node_type: &str, parts: &[&str]) -> String {
    format!("{}:{}:{}", connection_id, node_type, parts.join(":"))
}

// ─── 核心函数 ──────────────────────────────────────────────────────────────────

pub async fn process_pending_events(
    app: &tauri::AppHandle,
    conn_id: i64,
    task_id: &str,
) -> Result<ProcessStats> {
    let mut stats = ProcessStats {
        inserted: 0,
        updated: 0,
        skipped: 0,
        fts_updated: 0,
    };

    // ── 步骤1：局部提取 ──────────────────────────────────────────────────────

    let events: Vec<PendingEvent> = {
        let db_conn = crate::db::get().lock()
            .map_err(|e| anyhow::anyhow!("DB mutex poisoned: {e}"))?;
        let mut stmt = db_conn.prepare(
            "SELECT id, event_type, table_name, column_name, metadata
             FROM schema_change_log
             WHERE processed = 0 AND connection_id = ?1
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([conn_id], |row| {
            Ok(PendingEvent {
                id: row.get(0)?,
                event_type: row.get(1)?,
                table_name: row.get(2)?,
                column_name: row.get(3)?,
                metadata: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    if events.is_empty() {
        emit_log(app, task_id, "INFO", "无变更，跳过更新");
        return Ok(stats);
    }

    // 按 table_name 分组（用于日志）
    let mut by_table: HashMap<String, Vec<&PendingEvent>> = HashMap::new();
    for ev in &events {
        by_table.entry(ev.table_name.clone()).or_default().push(ev);
    }

    // 统计新表数量（ADD_TABLE 事件）和列变更数量
    let new_table_count = events.iter().filter(|e| e.event_type == "ADD_TABLE").count();
    let col_change_count = events.iter()
        .filter(|e| e.event_type == "ADD_COLUMN" || e.event_type == "DROP_COLUMN")
        .count();

    emit_log(
        app,
        task_id,
        "INFO",
        &format!("检测到 {} 张新表，{} 列变更", new_table_count, col_change_count),
    );

    // 构建日志行：显示各表变更信息
    let table_summary: Vec<String> = by_table
        .iter()
        .map(|(tname, evs)| {
            let col_count = evs.iter()
                .filter(|e| e.event_type == "ADD_COLUMN" || e.event_type == "DROP_COLUMN")
                .count();
            format!("{}({}列)", tname, col_count)
        })
        .collect();
    emit_log(
        app,
        task_id,
        "INFO",
        &format!("构建节点：{}", table_summary.join(", ")),
    );

    // ── 步骤2：Set Union 合并（访问 graph_nodes）──────────────────────────

    let processed_at = Utc::now().to_rfc3339();
    let processed_ids: Vec<i64> = events.iter().map(|e| e.id).collect();
    let mut changed_rowids: Vec<i64> = Vec::new();

    // Acquire the lock once and run steps 2-4 inside a single transaction.
    // On any error we ROLLBACK before propagating, ensuring atomicity.
    let txn_result: anyhow::Result<()> = {
        let db_conn = crate::db::get().lock()
            .map_err(|e| anyhow::anyhow!("DB mutex poisoned: {e}"))?;

        db_conn.execute_batch("BEGIN")?;

        let step_result: anyhow::Result<()> = (|| -> anyhow::Result<()> { for ev in &events {
            match ev.event_type.as_str() {
                "ADD_TABLE" => {
                    let node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
                    let existing_source = get_node_source(&db_conn, &node_id)?;

                    match existing_source.as_deref() {
                        None => {
                            // 新节点 → INSERT
                            db_conn.execute(
                                "INSERT INTO graph_nodes
                                   (id, node_type, connection_id, name, display_name, metadata, source)
                                 VALUES (?1, 'table', ?2, ?3, ?4, ?5, 'schema')",
                                rusqlite::params![
                                    node_id,
                                    conn_id,
                                    ev.table_name,
                                    ev.table_name,
                                    ev.metadata,
                                ],
                            )?;
                            stats.inserted += 1;
                            if let Some(rowid) = get_node_rowid(&db_conn, &node_id)? {
                                changed_rowids.push(rowid);
                            }
                        }
                        Some("user") => {
                            // 保护用户标注，跳过
                            stats.skipped += 1;
                        }
                        _ => {
                            // source='schema' 或 source='ai' → UPDATE
                            db_conn.execute(
                                "UPDATE graph_nodes SET metadata = ?1, source = 'schema'
                                 WHERE id = ?2",
                                rusqlite::params![ev.metadata, node_id],
                            )?;
                            stats.updated += 1;
                            if let Some(rowid) = get_node_rowid(&db_conn, &node_id)? {
                                changed_rowids.push(rowid);
                            }
                        }
                    }
                }

                "ADD_COLUMN" => {
                    let col_name = match ev.column_name.as_deref() {
                        Some(c) => c,
                        None => continue,
                    };
                    let col_node_id = make_node_id(conn_id, "column", &[&ev.table_name, col_name]);
                    let existing_source = get_node_source(&db_conn, &col_node_id)?;

                    match existing_source.as_deref() {
                        None => {
                            // 新列节点 → INSERT
                            db_conn.execute(
                                "INSERT INTO graph_nodes
                                   (id, node_type, connection_id, name, display_name, metadata, source)
                                 VALUES (?1, 'column', ?2, ?3, NULL, ?4, 'schema')",
                                rusqlite::params![
                                    col_node_id,
                                    conn_id,
                                    col_name,
                                    ev.metadata,
                                ],
                            )?;
                            // 也需要更新 has_column 边（若表节点已存在）
                            let table_node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
                            let edge_id = format!("{}->{}", table_node_id, col_node_id);
                            let _ = db_conn.execute(
                                "INSERT OR IGNORE INTO graph_edges
                                   (id, from_node, to_node, edge_type)
                                 VALUES (?1, ?2, ?3, 'has_column')",
                                rusqlite::params![edge_id, table_node_id, col_node_id],
                            );
                            stats.inserted += 1;
                            if let Some(rowid) = get_node_rowid(&db_conn, &col_node_id)? {
                                changed_rowids.push(rowid);
                            }
                        }
                        Some("user") => {
                            stats.skipped += 1;
                        }
                        _ => {
                            db_conn.execute(
                                "UPDATE graph_nodes SET metadata = ?1, source = 'schema'
                                 WHERE id = ?2",
                                rusqlite::params![ev.metadata, col_node_id],
                            )?;
                            stats.updated += 1;
                            if let Some(rowid) = get_node_rowid(&db_conn, &col_node_id)? {
                                changed_rowids.push(rowid);
                            }
                        }
                    }
                }

                "DROP_TABLE" => {
                    let node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
                    let existing_source = get_node_source(&db_conn, &node_id)?;

                    // 若 source='user' 则打⚠️标记到 metadata，不直接删除
                    if existing_source.as_deref() == Some("user") {
                        // 读取现有 metadata，在其中加入 warning 标记
                        let existing_meta: Option<String> = db_conn.query_row(
                            "SELECT metadata FROM graph_nodes WHERE id = ?1",
                            [&node_id],
                            |row| row.get(0),
                        ).optional()?;
                        let mut meta_val: serde_json::Value = existing_meta
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or(serde_json::Value::Object(Default::default()));
                        if let Some(obj) = meta_val.as_object_mut() {
                            obj.insert("_warning".to_string(), serde_json::json!("table dropped in source schema"));
                        }
                        db_conn.execute(
                            "UPDATE graph_nodes SET is_deleted = 1, metadata = ?1
                             WHERE id = ?2",
                            rusqlite::params![meta_val.to_string(), node_id],
                        )?;
                    } else {
                        db_conn.execute(
                            "UPDATE graph_nodes SET is_deleted = 1
                             WHERE id = ?1",
                            [&node_id],
                        )?;
                    }

                    stats.updated += 1;
                    if let Some(rowid) = get_node_rowid(&db_conn, &node_id)? {
                        changed_rowids.push(rowid);
                    }
                }

                "DROP_COLUMN" => {
                    let col_name = match ev.column_name.as_deref() {
                        Some(c) => c,
                        None => continue,
                    };
                    let col_node_id = make_node_id(conn_id, "column", &[&ev.table_name, col_name]);
                    let existing_source = get_node_source(&db_conn, &col_node_id)?;

                    if existing_source.as_deref() == Some("user") {
                        let existing_meta: Option<String> = db_conn.query_row(
                            "SELECT metadata FROM graph_nodes WHERE id = ?1",
                            [&col_node_id],
                            |row| row.get(0),
                        ).optional()?;
                        let mut meta_val: serde_json::Value = existing_meta
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or(serde_json::Value::Object(Default::default()));
                        if let Some(obj) = meta_val.as_object_mut() {
                            obj.insert("_warning".to_string(), serde_json::json!("column dropped in source schema"));
                        }
                        db_conn.execute(
                            "UPDATE graph_nodes SET is_deleted = 1, metadata = ?1
                             WHERE id = ?2",
                            rusqlite::params![meta_val.to_string(), col_node_id],
                        )?;
                    } else {
                        db_conn.execute(
                            "UPDATE graph_nodes SET is_deleted = 1
                             WHERE id = ?1",
                            [&col_node_id],
                        )?;
                    }

                    stats.updated += 1;
                    if let Some(rowid) = get_node_rowid(&db_conn, &col_node_id)? {
                        changed_rowids.push(rowid);
                    }
                }

                "ADD_FK" => {
                    // FK 边不对应 node，只需更新 graph_edges，
                    // metadata 中含 constraint_name/column/referenced_table/referenced_column
                    if let Some(meta_str) = &ev.metadata {
                        if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(meta_str) {
                            let constraint_name = meta_val
                                .get("constraint_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let ref_table = meta_val
                                .get("referenced_table")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let table_node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
                            let ref_table_node_id = make_node_id(conn_id, "table", &[ref_table]);
                            let edge_id = format!("fk:{}", constraint_name);
                            let _ = db_conn.execute(
                                "INSERT OR IGNORE INTO graph_edges
                                   (id, from_node, to_node, edge_type, metadata)
                                 VALUES (?1, ?2, ?3, 'foreign_key', ?4)",
                                rusqlite::params![
                                    edge_id,
                                    table_node_id,
                                    ref_table_node_id,
                                    meta_str,
                                ],
                            );
                        }
                    }
                    // FK 不影响 FTS5
                }

                other => {
                    log::warn!("[event_processor] 未知事件类型: {}", other);
                }
            }
        }

        // ── 步骤3：增量 FTS5 Upsert ─────────────────────────────────────────

        // 去重 rowid
        changed_rowids.sort_unstable();
        changed_rowids.dedup();

        for rowid in &changed_rowids {
            upsert_fts(&db_conn, *rowid)?;
            stats.fts_updated += 1;
        }

        emit_log(
            app,
            task_id,
            "INFO",
            &format!("更新 FTS5 索引（{} 个节点）", stats.fts_updated),
        );

        // ── 步骤4：标记完成 ────────────────────────────────────────────────────

        if !processed_ids.is_empty() {
            // 生成 IN 占位符
            let placeholders: String = processed_ids
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 2))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "UPDATE schema_change_log SET processed = 1, processed_at = ?1 WHERE id IN ({})",
                placeholders
            );
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(processed_at.clone())];
            for id in &processed_ids {
                params.push(Box::new(*id));
            }
            db_conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
        }
        Ok(())
        })();

        match step_result {
            Ok(()) => match db_conn.execute_batch("COMMIT") {
                Ok(()) => Ok(()),
                Err(e) => {
                    let _ = db_conn.execute_batch("ROLLBACK");
                    Err(anyhow::anyhow!("Transaction COMMIT failed: {e}"))
                }
            },
            Err(e) => {
                let _ = db_conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    };
    txn_result?;

    emit_log(
        app,
        task_id,
        "INFO",
        &format!(
            "✅ 完成，新增 {} 节点，更新 {} 节点，跳过 {} 节点（未变更）",
            stats.inserted, stats.updated, stats.skipped
        ),
    );

    log::info!(
        "[event_processor] connection={} inserted={} updated={} skipped={} fts_updated={}",
        conn_id,
        stats.inserted,
        stats.updated,
        stats.skipped,
        stats.fts_updated
    );

    Ok(stats)
}
