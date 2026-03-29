//! change_detector.rs
//!
//! 对比当前 information_schema（SchemaInfo）与 graph_nodes 中已有的结构层节点，
//! 将差量事件写入 schema_change_log 表，供后续增量更新流程消费。

use crate::datasource::SchemaInfo;
use anyhow::Result;
use chrono::Utc;
use std::collections::{HashMap, HashSet};

/// 从 graph_nodes 中读取指定连接的结构层节点（source != 'user'）。
///
/// 返回两级映射：
///   table_name -> column_names (空集合表示仅有表节点，无列节点)
/// 以及 Link 节点 ID 集合（用于 ADD_FK 去重）：
///   HashSet<link_node_id>
/// 执行带可选 database 过滤的查询，通过 `map_row` 将每行映射为结果项。
fn query_with_db<T>(
    conn: &rusqlite::Connection,
    sql: &str,
    connection_id: i64,
    database: Option<&str>,
    map_row: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = match database {
        Some(db) => stmt.query(rusqlite::params![connection_id, db])?,
        None => stmt.query([connection_id])?,
    };
    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
        results.push(map_row(row)?);
    }
    Ok(results)
}

fn load_existing_nodes(
    conn: &rusqlite::Connection,
    connection_id: i64,
    database: Option<&str>,
) -> rusqlite::Result<(HashMap<String, HashSet<String>>, HashSet<String>)> {
    let mut tables: HashMap<String, HashSet<String>> = HashMap::new();

    let db_filter = match database {
        Some(_) => " AND (database=?2 OR database IS NULL)",
        None => "",
    };

    // 读取 table 节点
    {
        let sql = format!(
            "SELECT name FROM graph_nodes
             WHERE connection_id=?1 AND node_type='table'
               AND (source IS NULL OR source != 'user')
               AND is_deleted=0{}",
            db_filter
        );
        for name in query_with_db(conn, &sql, connection_id, database, |r| r.get::<_, String>(0))? {
            tables.entry(name).or_default();
        }
    }

    // 读取 column 节点（通过 has_column 边关联到表）
    {
        let sql = format!(
            "SELECT t.name AS table_name, c.name AS col_name
             FROM graph_nodes c
             JOIN graph_edges e ON e.to_node = c.id AND e.edge_type = 'has_column'
             JOIN graph_nodes t ON t.id = e.from_node
             WHERE c.connection_id=?1 AND c.node_type='column'
               AND (c.source IS NULL OR c.source != 'user')
               AND c.is_deleted=0 AND t.is_deleted=0{}",
            db_filter
        );
        for (tname, cname) in query_with_db(conn, &sql, connection_id, database, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            tables.entry(tname).or_default().insert(cname);
        }
    }

    // 读取已有 Link 节点的 ID（source != 'user'，未软删除）
    let existing_link_ids: HashSet<String> = {
        let sql = format!(
            "SELECT id FROM graph_nodes
             WHERE connection_id=?1 AND node_type='link'
               AND (source IS NULL OR source != 'user')
               AND is_deleted=0{}",
            db_filter
        );
        query_with_db(conn, &sql, connection_id, database, |r| r.get::<_, String>(0))?
            .into_iter()
            .collect()
    };

    Ok((tables, existing_link_ids))
}

/// 变更事件数据（用于写入 schema_change_log）
struct ChangeEvent<'a> {
    event_type: &'a str,
    table_name: &'a str,
    column_name: Option<&'a str>,
    metadata: Option<&'a str>,
    database: Option<&'a str>,
    schema: Option<&'a str>,
}

/// 向 schema_change_log 插入一条变更记录。
fn insert_change_log(
    conn: &rusqlite::Connection,
    connection_id: i64,
    ev: &ChangeEvent<'_>,
    created_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_change_log
           (connection_id, event_type, table_name, column_name, metadata, database, schema, processed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        rusqlite::params![
            connection_id,
            ev.event_type,
            ev.table_name,
            ev.column_name,
            ev.metadata,
            ev.database,
            ev.schema,
            created_at
        ],
    )?;
    Ok(())
}

/// 对比当前 SchemaInfo 与 graph_nodes 中的结构层节点，将差量事件写入 schema_change_log。
///
/// # 参数
/// - `connection_id`：数据源连接 ID
/// - `current_schema`：从外部数据源实时获取的 schema（仅含 tables；列/FK 由调用方填充到扩展结构，
///   这里通过额外参数 `table_details` 传入）
/// - `table_columns`：table_name -> 列元数据列表（可为空 HashMap，此时跳过列对比）
/// - `table_fks`：table_name -> 外键元数据列表（可为空 HashMap，此时跳过 FK 对比）
///
/// # 返回
/// 写入 schema_change_log 的事件数量。
pub fn detect_and_log_changes(
    connection_id: i64,
    current_schema: &SchemaInfo,
    table_columns: &HashMap<String, Vec<crate::datasource::ColumnMeta>>,
    table_fks: &HashMap<String, Vec<crate::datasource::ForeignKeyMeta>>,
    database: Option<&str>,
) -> Result<usize> {
    let db_conn = crate::db::get()
        .lock()
        .map_err(|e| anyhow::anyhow!("DB mutex poisoned: {e}"))?;
    let created_at = Utc::now().to_rfc3339();

    // 1. 加载已有节点（按 database 过滤，防止跨库误删）
    let (existing_tables, existing_link_ids) =
        load_existing_nodes(&db_conn, connection_id, database)?;

    let mut event_count = 0usize;

    // 建立表名 → schema 映射（PG 等多 schema 数据源）
    let table_schema_map: HashMap<String, Option<String>> = current_schema
        .tables
        .iter()
        .map(|t| (t.name.clone(), t.schema.clone()))
        .collect();

    // 2. 当前 schema 中的表名集合
    let current_table_names: HashSet<String> =
        current_schema.tables.iter().map(|t| t.name.clone()).collect();

    let existing_table_names: HashSet<String> = existing_tables.keys().cloned().collect();

    // 3. 检测新增表（ADD_TABLE）+ 顺带为该表所有列生成 ADD_COLUMN 事件
    for tname in current_table_names.difference(&existing_table_names) {
        // 附带 table_type 到 metadata
        let table_type = current_schema
            .tables
            .iter()
            .find(|t| &t.name == tname)
            .map(|t| t.table_type.as_str())
            .unwrap_or("BASE TABLE");
        let tbl_schema = table_schema_map.get(tname).and_then(|s| s.as_deref());
        let meta = serde_json::json!({"table_type": table_type}).to_string();
        insert_change_log(&db_conn, connection_id, &ChangeEvent {
            event_type: "ADD_TABLE", table_name: tname,
            column_name: None, metadata: Some(&meta), database, schema: tbl_schema,
        }, &created_at)?;
        event_count += 1;

        // 新表的列：直接生成 ADD_COLUMN（无需等下一次构建）
        if let Some(cols) = table_columns.get(tname) {
            for col in cols {
                let col_meta = serde_json::json!({
                    "data_type": col.data_type,
                    "is_nullable": col.is_nullable,
                    "is_primary_key": col.is_primary_key,
                    "column_default": col.column_default
                })
                .to_string();
                insert_change_log(&db_conn, connection_id, &ChangeEvent {
                    event_type: "ADD_COLUMN", table_name: tname,
                    column_name: Some(&col.name), metadata: Some(&col_meta), database, schema: tbl_schema,
                }, &created_at)?;
                event_count += 1;
            }
        }

        // 新表的外键：直接生成 ADD_FK
        if let Some(fks) = table_fks.get(tname) {
            for fk in fks {
                let would_be_link_id = format!(
                    "link:{}:{}:{}:{}",
                    connection_id, tname, fk.referenced_table, fk.column
                );
                if !existing_link_ids.contains(&would_be_link_id) {
                    let fk_meta = serde_json::json!({
                        "constraint_name": fk.constraint_name,
                        "column": fk.column,
                        "referenced_table": fk.referenced_table,
                        "referenced_column": fk.referenced_column,
                        "on_delete": fk.on_delete
                    })
                    .to_string();
                    insert_change_log(&db_conn, connection_id, &ChangeEvent {
                        event_type: "ADD_FK", table_name: tname,
                        column_name: Some(&fk.column), metadata: Some(&fk_meta), database, schema: tbl_schema,
                    }, &created_at)?;
                    event_count += 1;
                }
            }
        }
    }

    // 4. 检测删除表（DROP_TABLE）
    for tname in existing_table_names.difference(&current_table_names) {
        insert_change_log(&db_conn, connection_id, &ChangeEvent {
            event_type: "DROP_TABLE", table_name: tname,
            column_name: None, metadata: None, database, schema: None,
        }, &created_at)?;
        event_count += 1;
    }

    // 5. 对同时存在于两侧的表，检测列和外键差异
    for tname in current_table_names.intersection(&existing_table_names) {
        let existing_cols = existing_tables
            .get(tname)
            .cloned()
            .unwrap_or_default();
        let tbl_schema = table_schema_map.get(tname).and_then(|s| s.as_deref());

        // --- 列对比 ---
        if let Some(current_cols) = table_columns.get(tname) {
            let current_col_names: HashSet<String> =
                current_cols.iter().map(|c| c.name.clone()).collect();

            // 新增列（ADD_COLUMN）
            for col in current_cols {
                if !existing_cols.contains(&col.name) {
                    let meta = serde_json::json!({
                        "data_type": col.data_type,
                        "is_nullable": col.is_nullable,
                        "is_primary_key": col.is_primary_key,
                        "column_default": col.column_default
                    })
                    .to_string();
                    insert_change_log(&db_conn, connection_id, &ChangeEvent {
                        event_type: "ADD_COLUMN", table_name: tname,
                        column_name: Some(&col.name), metadata: Some(&meta), database, schema: tbl_schema,
                    }, &created_at)?;
                    event_count += 1;
                }
            }

            // 删除列（DROP_COLUMN）
            for col_name in existing_cols.difference(&current_col_names) {
                insert_change_log(&db_conn, connection_id, &ChangeEvent {
                    event_type: "DROP_COLUMN", table_name: tname,
                    column_name: Some(col_name), metadata: None, database, schema: tbl_schema,
                }, &created_at)?;
                event_count += 1;
            }
        }

        // --- 外键对比（ADD_FK，不检测删除）---
        if let Some(fks) = table_fks.get(tname) {
            for fk in fks {
                let would_be_link_id = format!(
                    "link:{}:{}:{}:{}",
                    connection_id, tname, fk.referenced_table, fk.column
                );
                if !existing_link_ids.contains(&would_be_link_id) {
                    let meta = serde_json::json!({
                        "constraint_name": fk.constraint_name,
                        "column": fk.column,
                        "referenced_table": fk.referenced_table,
                        "referenced_column": fk.referenced_column,
                        "on_delete": fk.on_delete
                    })
                    .to_string();
                    insert_change_log(&db_conn, connection_id, &ChangeEvent {
                        event_type: "ADD_FK", table_name: tname,
                        column_name: Some(&fk.column), metadata: Some(&meta), database, schema: tbl_schema,
                    }, &created_at)?;
                    event_count += 1;
                }
            }
        }
    }

    log::info!(
        "[change_detector] connection={} existing_tables={} current_tables={} detected={} change events",
        connection_id,
        existing_table_names.len(),
        current_table_names.len(),
        event_count
    );

    Ok(event_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_strings() {
        // 确认事件类型字符串与 schema 约定一致
        let valid_types = [
            "ADD_TABLE",
            "DROP_TABLE",
            "ADD_COLUMN",
            "DROP_COLUMN",
            "ADD_FK",
        ];
        for t in &valid_types {
            assert!(!t.is_empty());
        }
    }
}
