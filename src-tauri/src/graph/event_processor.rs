//! event_processor.rs
//!
//! 消费 schema_change_log 中未处理的变更事件，以增量方式更新 graph_nodes 和 FTS5 索引。

use anyhow::Result;
use chrono::Utc;
use rusqlite::OptionalExtension;
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
pub(super) fn get_node_source(
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
#[cfg(test)]
pub(super) fn get_node_rowid(
    conn: &rusqlite::Connection,
    node_id: &str,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT rowid FROM graph_nodes WHERE id = ?1",
        [node_id],
        |row| row.get(0),
    ).optional()
}

/// FTS5 全量重建：事务提交后调用，将 graph_nodes 全量同步到 FTS5 索引。
/// 外部 content FTS5 表不能在同一事务内同时写 content 表和做 DELETE/INSERT，
/// 否则 FTS5 读回倒排索引时会报 "database disk image is malformed"。
/// 使用官方推荐的 rebuild 命令替代增量 upsert。
pub(super) fn rebuild_fts(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("INSERT INTO graph_nodes_fts(graph_nodes_fts) VALUES('rebuild')")
}

/// node_id 生成规则（与 builder.rs 保持一致）
pub(super) fn make_node_id(connection_id: i64, node_type: &str, parts: &[&str]) -> String {
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
                        }
                        Some("user") => {
                            // 保护用户标注，跳过
                            stats.skipped += 1;
                        }
                        _ => {
                            // source='schema' 或 source='ai' → UPDATE（含软删除节点复活）
                            db_conn.execute(
                                "UPDATE graph_nodes SET metadata = ?1, source = 'schema', is_deleted = 0
                                 WHERE id = ?2",
                                rusqlite::params![ev.metadata, node_id],
                            )?;
                            stats.updated += 1;
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
                        }
                        Some("user") => {
                            stats.skipped += 1;
                        }
                        _ => {
                            db_conn.execute(
                                "UPDATE graph_nodes SET metadata = ?1, source = 'schema', is_deleted = 0
                                 WHERE id = ?2",
                                rusqlite::params![ev.metadata, col_node_id],
                            )?;
                            stats.updated += 1;
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
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
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
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
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
                }

                "ADD_FK" => {
                    if let Some(meta_str) = &ev.metadata {
                        if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(meta_str) {
                            let ref_table = meta_val
                                .get("referenced_table")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let via_col = meta_val
                                .get("column")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let on_delete = meta_val
                                .get("on_delete")
                                .and_then(|v| v.as_str())
                                .unwrap_or("NO ACTION");

                            let table_node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
                            let ref_table_node_id = make_node_id(conn_id, "table", &[ref_table]);
                            let link_id = format!(
                                "link:{}:{}:{}:{}",
                                conn_id, ev.table_name, ref_table, via_col
                            );

                            // 推断 cardinality（简化：固定 N:1）
                            let cardinality = "N:1";

                            // Link Node metadata
                            let link_metadata = serde_json::json!({
                                "edge_type": "fk",
                                "cardinality": cardinality,
                                "via": via_col,
                                "on_delete": on_delete,
                                "description": "",
                                "weight": 0.95,
                                "is_inferred": true,
                                "source_table": ev.table_name,
                                "target_table": ref_table,
                                "source_node_id": table_node_id,
                                "target_node_id": ref_table_node_id,
                            });

                            let display_name = format!("{} → {}", ev.table_name, ref_table);

                            // 插入 Link Node（INSERT OR IGNORE 保证幂等）
                            // name = "fk"（edge_type 标识符）; display_name = "table → ref_table"（可读标签）
                            let inserted = db_conn.execute(
                                "INSERT OR IGNORE INTO graph_nodes
                                   (id, node_type, connection_id, name, display_name, metadata, source)
                                 VALUES (?1, 'link', ?2, ?3, ?4, ?5, 'schema')",
                                rusqlite::params![
                                    link_id,
                                    conn_id,
                                    "fk",
                                    display_name,
                                    link_metadata.to_string(),
                                ],
                            ).unwrap_or(0);

                            // 插入两条边（INSERT OR IGNORE 保证幂等）
                            let edge1_id = format!("{}=>{}", table_node_id, link_id);
                            let _ = db_conn.execute(
                                "INSERT OR IGNORE INTO graph_edges
                                   (id, from_node, to_node, edge_type)
                                 VALUES (?1, ?2, ?3, 'to_link')",
                                rusqlite::params![edge1_id, table_node_id, link_id],
                            );

                            let edge2_id = format!("{}=>{}", link_id, ref_table_node_id);
                            let _ = db_conn.execute(
                                "INSERT OR IGNORE INTO graph_edges
                                   (id, from_node, to_node, edge_type)
                                 VALUES (?1, ?2, ?3, 'from_link')",
                                rusqlite::params![edge2_id, link_id, ref_table_node_id],
                            );

                            // 仅真正插入时计数（IGNORE 时 inserted == 0）
                            if inserted > 0 {
                                stats.inserted += 1;
                            }
                        }
                    }
                }

                other => {
                    log::warn!("[event_processor] 未知事件类型: {}", other);
                }
            }
        }

        // ── 步骤3：标记完成 ────────────────────────────────────────────────────

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

    // ── 步骤5：FTS5 全量重建（事务提交后执行，避免与 content 表同事务操作）──
    {
        let db_conn = crate::db::get().lock()
            .map_err(|e| anyhow::anyhow!("DB mutex poisoned: {e}"))?;
        rebuild_fts(&db_conn)?;
        stats.fts_updated = stats.inserted + stats.updated;
    }
    emit_log(app, task_id, "INFO", "FTS5 索引已重建");

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

// ─── 单元测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    // ── 测试用 DDL ──────────────────────────────────────────────────────────────

    /// 在内存数据库中建立测试所需的全部表结构（含 FTS5）
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("内存数据库创建失败");
        conn.execute_batch(
            r#"
            CREATE TABLE graph_nodes (
                id            TEXT PRIMARY KEY,
                node_type     TEXT NOT NULL,
                connection_id INTEGER,
                name          TEXT NOT NULL,
                display_name  TEXT,
                aliases       TEXT,
                source        TEXT DEFAULT 'schema',
                is_deleted    INTEGER NOT NULL DEFAULT 0,
                metadata      TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE graph_edges (
                id         TEXT PRIMARY KEY,
                from_node  TEXT NOT NULL,
                to_node    TEXT NOT NULL,
                edge_type  TEXT NOT NULL,
                weight     REAL NOT NULL DEFAULT 1.0,
                metadata   TEXT
            );
            CREATE TABLE schema_change_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id INTEGER NOT NULL,
                event_type    TEXT NOT NULL,
                database      TEXT,
                schema        TEXT,
                table_name    TEXT NOT NULL,
                column_name   TEXT,
                metadata      TEXT,
                processed     INTEGER DEFAULT 0,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                processed_at  TEXT
            );
            CREATE VIRTUAL TABLE graph_nodes_fts
            USING fts5(
                id    UNINDEXED,
                name,
                display_name,
                aliases,
                content='graph_nodes',
                content_rowid='rowid'
            );
            "#,
        )
        .expect("建表失败");
        conn
    }

    // ── 辅助：插入节点 ──────────────────────────────────────────────────────────

    fn insert_node(
        conn: &Connection,
        id: &str,
        node_type: &str,
        name: &str,
        source: &str,
        metadata: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO graph_nodes (id, node_type, connection_id, name, display_name, source, metadata)
             VALUES (?1, ?2, 1, ?3, ?3, ?4, ?5)",
            rusqlite::params![id, node_type, name, source, metadata],
        )
        .expect("insert_node 失败");
    }

    // ── 辅助：插入 schema_change_log 事件 ──────────────────────────────────────

    fn insert_event(
        conn: &Connection,
        event_type: &str,
        table_name: &str,
        column_name: Option<&str>,
        metadata: Option<&str>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO schema_change_log
               (connection_id, event_type, table_name, column_name, metadata, processed, created_at)
             VALUES (1, ?1, ?2, ?3, ?4, 0, datetime('now'))",
            rusqlite::params![event_type, table_name, column_name, metadata],
        )
        .expect("insert_event 失败");
        conn.last_insert_rowid()
    }

    // ── 测试 1：make_node_id 格式正确 ──────────────────────────────────────────

    #[test]
    fn test_make_node_id_format() {
        assert_eq!(make_node_id(1, "table", &["orders"]), "1:table:orders");
        assert_eq!(
            make_node_id(2, "column", &["orders", "id"]),
            "2:column:orders:id"
        );
    }

    // ── 测试 2：ADD_TABLE 新节点插入 ────────────────────────────────────────────

    #[test]
    fn test_add_table_inserts_node() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let node_id = make_node_id(conn_id, "table", &["orders"]);

        // 执行 ADD_TABLE 插入逻辑
        conn.execute(
            "INSERT INTO graph_nodes
               (id, node_type, connection_id, name, display_name, metadata, source)
             VALUES (?1, 'table', ?2, ?3, ?4, ?5, 'schema')",
            rusqlite::params![node_id, conn_id, "orders", "orders", Option::<String>::None],
        )
        .unwrap();

        // 验证节点存在且 source 为 'schema'
        let source: String = conn
            .query_row(
                "SELECT source FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source, "schema");

        let name: String = conn
            .query_row(
                "SELECT name FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "orders");
    }

    // ── 测试 3：get_node_source 返回正确值 ────────────────────────────────────

    #[test]
    fn test_get_node_source_returns_correct_value() {
        let conn = setup_db();
        insert_node(&conn, "1:table:users", "table", "users", "user", None);

        let src = get_node_source(&conn, "1:table:users").unwrap();
        assert_eq!(src, Some("user".to_string()));

        // 不存在的节点返回 None
        let missing = get_node_source(&conn, "99:table:ghost").unwrap();
        assert!(missing.is_none());
    }

    // ── 测试 4：source='user' 节点不被 ADD_TABLE 覆盖 ──────────────────────────

    #[test]
    fn test_user_source_node_not_overwritten() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let node_id = make_node_id(conn_id, "table", &["customers"]);

        // 预插入 source='user' 的节点，带有用户自定义 metadata
        insert_node(&conn, &node_id, "table", "customers", "user", Some(r#"{"note":"vip"}"#));

        // 模拟 ADD_TABLE 事件处理：检查 source，若为 'user' 则跳过
        let existing_source = get_node_source(&conn, &node_id).unwrap();
        let skipped = existing_source.as_deref() == Some("user");
        assert!(skipped, "source='user' 的节点应被跳过");

        // 验证 metadata 和 source 未被改变
        let (source, metadata): (String, Option<String>) = conn
            .query_row(
                "SELECT source, metadata FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(source, "user");
        assert_eq!(metadata.as_deref(), Some(r#"{"note":"vip"}"#));
    }

    // ── 测试 5：DROP_TABLE 软删除（source='schema'） ──────────────────────────

    #[test]
    fn test_drop_table_marks_is_deleted() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let node_id = make_node_id(conn_id, "table", &["temp_data"]);

        insert_node(&conn, &node_id, "table", "temp_data", "schema", None);

        // 执行 DROP_TABLE 逻辑（source != 'user'，直接软删除）
        conn.execute(
            "UPDATE graph_nodes SET is_deleted = 1 WHERE id = ?1",
            [&node_id],
        )
        .unwrap();

        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1);
    }

    // ── 测试 6：DROP_TABLE 对 source='user' 节点添加 _warning ─────────────────

    #[test]
    fn test_drop_table_warns_user_source() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let node_id = make_node_id(conn_id, "table", &["important"]);

        insert_node(
            &conn,
            &node_id,
            "table",
            "important",
            "user",
            Some(r#"{"owner":"alice"}"#),
        );

        // 模拟 DROP_TABLE user-source 处理逻辑
        let existing_meta: Option<String> = conn
            .query_row(
                "SELECT metadata FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap();

        let mut meta_val: serde_json::Value = existing_meta
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Object(Default::default()));
        if let Some(obj) = meta_val.as_object_mut() {
            obj.insert(
                "_warning".to_string(),
                serde_json::json!("table dropped in source schema"),
            );
        }
        conn.execute(
            "UPDATE graph_nodes SET is_deleted = 1, metadata = ?1 WHERE id = ?2",
            rusqlite::params![meta_val.to_string(), node_id],
        )
        .unwrap();

        // 验证 is_deleted=1 且 metadata 含 _warning
        let (is_deleted, metadata): (i64, String) = conn
            .query_row(
                "SELECT is_deleted, metadata FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(is_deleted, 1);
        let meta: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(
            meta["_warning"],
            serde_json::json!("table dropped in source schema")
        );
        // 确保原有字段仍保留
        assert_eq!(meta["owner"], serde_json::json!("alice"));
    }

    // ── 测试 7：ADD_COLUMN 新增列节点及 has_column 边 ──────────────────────────

    #[test]
    fn test_add_column_inserts_column_node() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let table_node_id = make_node_id(conn_id, "table", &["orders"]);
        let col_node_id = make_node_id(conn_id, "column", &["orders", "amount"]);

        // 先插入父表节点
        insert_node(&conn, &table_node_id, "table", "orders", "schema", None);

        // 执行 ADD_COLUMN 列节点插入逻辑
        conn.execute(
            "INSERT INTO graph_nodes
               (id, node_type, connection_id, name, display_name, metadata, source)
             VALUES (?1, 'column', ?2, ?3, NULL, ?4, 'schema')",
            rusqlite::params![col_node_id, conn_id, "amount", Option::<String>::None],
        )
        .unwrap();

        let edge_id = format!("{}->{}", table_node_id, col_node_id);
        conn.execute(
            "INSERT OR IGNORE INTO graph_edges
               (id, from_node, to_node, edge_type)
             VALUES (?1, ?2, ?3, 'has_column')",
            rusqlite::params![edge_id, table_node_id, col_node_id],
        )
        .unwrap();

        // 验证列节点存在，node_type='column'
        let node_type: String = conn
            .query_row(
                "SELECT node_type FROM graph_nodes WHERE id = ?1",
                [&col_node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(node_type, "column");

        // 验证 has_column 边已插入
        let edge_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM graph_edges WHERE id = ?1 AND edge_type = 'has_column'",
                [&edge_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(edge_count, 1);
    }

    // ── 测试 9：无待处理事件时统计数全为 0 ────────────────────────────────────

    #[test]
    fn test_no_pending_events_returns_zero_stats() {
        let conn = setup_db();

        // 插入一条 processed=1 的已处理事件（不应被消费）
        conn.execute(
            "INSERT INTO schema_change_log
               (connection_id, event_type, table_name, processed, created_at)
             VALUES (1, 'ADD_TABLE', 'old_table', 1, datetime('now'))",
            [],
        )
        .unwrap();

        // 查询 processed=0 的事件数量（模拟 process_pending_events 的第一步）
        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_change_log
                 WHERE processed = 0 AND connection_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending_count, 0, "无未处理事件，pending_count 应为 0");
    }

    // ── 测试 10：处理后 schema_change_log.processed 置为 1 ────────────────────

    #[test]
    fn test_events_marked_processed_after_handling() {
        let conn = setup_db();

        // 插入两条待处理事件
        let id1 = insert_event(&conn, "ADD_TABLE", "table_a", None, None);
        let id2 = insert_event(&conn, "ADD_TABLE", "table_b", None, None);

        // 模拟步骤4：批量标记 processed=1
        let processed_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            &format!(
                "UPDATE schema_change_log SET processed = 1, processed_at = ?1
                 WHERE id IN ({}, {})",
                id1, id2
            ),
            rusqlite::params![processed_at],
        )
        .unwrap();

        // 验证两条事件均已标记为 processed=1
        let unprocessed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_change_log WHERE processed = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unprocessed, 0, "所有事件应已被标记为 processed=1");

        let processed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_change_log WHERE processed = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(processed, 2);
    }

    // ── 测试 11：DROP_COLUMN 软删除列节点 ─────────────────────────────────────

    #[test]
    fn test_drop_column_marks_is_deleted() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let col_node_id = make_node_id(conn_id, "column", &["orders", "old_col"]);

        insert_node(&conn, &col_node_id, "column", "old_col", "schema", None);

        // 执行 DROP_COLUMN 逻辑（source='schema'，直接软删除）
        conn.execute(
            "UPDATE graph_nodes SET is_deleted = 1 WHERE id = ?1",
            [&col_node_id],
        )
        .unwrap();

        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM graph_nodes WHERE id = ?1",
                [&col_node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1);
    }

    // ── 测试 12：ADD_TABLE 更新 source='schema' 的已有节点 ────────────────────

    #[test]
    fn test_add_table_updates_existing_schema_node() {
        let conn = setup_db();
        let conn_id: i64 = 1;
        let node_id = make_node_id(conn_id, "table", &["products"]);

        // 预插入 source='schema' 的旧节点
        insert_node(
            &conn,
            &node_id,
            "table",
            "products",
            "schema",
            Some(r#"{"old":"data"}"#),
        );

        // 执行 ADD_TABLE 更新逻辑（source='schema' → UPDATE）
        let new_meta = r#"{"columns":5}"#;
        conn.execute(
            "UPDATE graph_nodes SET metadata = ?1, source = 'schema' WHERE id = ?2",
            rusqlite::params![new_meta, node_id],
        )
        .unwrap();

        let metadata: String = conn
            .query_row(
                "SELECT metadata FROM graph_nodes WHERE id = ?1",
                [&node_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(metadata, new_meta);
    }

    // ── 测试 13：get_node_rowid 返回正确 rowid ─────────────────────────────────

    #[test]
    fn test_get_node_rowid_returns_value() {
        let conn = setup_db();
        insert_node(&conn, "1:table:foo", "table", "foo", "schema", None);

        let rowid = get_node_rowid(&conn, "1:table:foo").unwrap();
        assert!(rowid.is_some(), "已存在节点应有 rowid");
        assert!(rowid.unwrap() > 0);

        let missing = get_node_rowid(&conn, "99:table:bar").unwrap();
        assert!(missing.is_none(), "不存在的节点 rowid 应为 None");
    }
}
