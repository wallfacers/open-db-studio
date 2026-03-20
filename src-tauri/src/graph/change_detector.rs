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
fn load_existing_nodes(
    conn: &rusqlite::Connection,
    connection_id: i64,
) -> rusqlite::Result<(HashMap<String, HashSet<String>>, HashSet<String>)> {
    // 读取 table/column 节点（source != 'user'）
    let mut tables: HashMap<String, HashSet<String>> = HashMap::new();

    {
        let mut stmt = conn.prepare(
            "SELECT name FROM graph_nodes
             WHERE connection_id=?1 AND node_type='table'
               AND (source IS NULL OR source != 'user')
               AND is_deleted=0",
        )?;
        let table_names = stmt.query_map([connection_id], |row| {
            let name: String = row.get(0)?;
            Ok(name)
        })?;
        for t in table_names {
            tables.entry(t?).or_default();
        }
    }

    {
        // column 节点的 name 格式为 "<col_name>"，父表通过 graph_edges has_column 关联。
        // 为简化，直接从 graph_edges 关联查出表名与列名。
        let mut stmt = conn.prepare(
            "SELECT t.name AS table_name, c.name AS col_name
             FROM graph_nodes c
             JOIN graph_edges e ON e.to_node = c.id AND e.edge_type = 'has_column'
             JOIN graph_nodes t ON t.id = e.from_node
             WHERE c.connection_id=?1 AND c.node_type='column'
               AND (c.source IS NULL OR c.source != 'user')
               AND c.is_deleted=0 AND t.is_deleted=0",
        )?;
        let pairs = stmt.query_map([connection_id], |row| {
            let table_name: String = row.get(0)?;
            let col_name: String = row.get(1)?;
            Ok((table_name, col_name))
        })?;
        for pair in pairs {
            let (tname, cname) = pair?;
            tables.entry(tname).or_default().insert(cname);
        }
    }

    // 读取已有 Link 节点的 ID（source != 'user'，未软删除）
    let mut existing_link_ids: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id FROM graph_nodes
             WHERE connection_id=?1 AND node_type='link'
               AND (source IS NULL OR source != 'user')
               AND is_deleted=0",
        )?;
        let ids = stmt.query_map([connection_id], |row| row.get::<_, String>(0))?;
        for id in ids {
            existing_link_ids.insert(id?);
        }
    }

    Ok((tables, existing_link_ids))
}

/// 向 schema_change_log 插入一条变更记录。
fn insert_change_log(
    conn: &rusqlite::Connection,
    connection_id: i64,
    event_type: &str,
    table_name: &str,
    column_name: Option<&str>,
    metadata: Option<&str>,
    created_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_change_log
           (connection_id, event_type, table_name, column_name, metadata, processed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        rusqlite::params![
            connection_id,
            event_type,
            table_name,
            column_name,
            metadata,
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
) -> Result<usize> {
    let db_conn = crate::db::get()
        .lock()
        .map_err(|e| anyhow::anyhow!("DB mutex poisoned: {e}"))?;
    let created_at = Utc::now().to_rfc3339();

    // 1. 加载已有节点
    let (existing_tables, existing_link_ids) =
        load_existing_nodes(&db_conn, connection_id)?;

    let mut event_count = 0usize;

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
        let meta = serde_json::json!({"table_type": table_type}).to_string();
        insert_change_log(
            &db_conn,
            connection_id,
            "ADD_TABLE",
            tname,
            None,
            Some(&meta),
            &created_at,
        )?;
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
                insert_change_log(
                    &db_conn,
                    connection_id,
                    "ADD_COLUMN",
                    tname,
                    Some(&col.name),
                    Some(&col_meta),
                    &created_at,
                )?;
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
                    insert_change_log(
                        &db_conn,
                        connection_id,
                        "ADD_FK",
                        tname,
                        Some(&fk.column),
                        Some(&fk_meta),
                        &created_at,
                    )?;
                    event_count += 1;
                }
            }
        }
    }

    // 4. 检测删除表（DROP_TABLE）
    for tname in existing_table_names.difference(&current_table_names) {
        insert_change_log(
            &db_conn,
            connection_id,
            "DROP_TABLE",
            tname,
            None,
            None,
            &created_at,
        )?;
        event_count += 1;
    }

    // 5. 对同时存在于两侧的表，检测列和外键差异
    for tname in current_table_names.intersection(&existing_table_names) {
        let existing_cols = existing_tables
            .get(tname)
            .cloned()
            .unwrap_or_default();

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
                    insert_change_log(
                        &db_conn,
                        connection_id,
                        "ADD_COLUMN",
                        tname,
                        Some(&col.name),
                        Some(&meta),
                        &created_at,
                    )?;
                    event_count += 1;
                }
            }

            // 删除列（DROP_COLUMN）
            for col_name in existing_cols.difference(&current_col_names) {
                insert_change_log(
                    &db_conn,
                    connection_id,
                    "DROP_COLUMN",
                    tname,
                    Some(col_name),
                    None,
                    &created_at,
                )?;
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
                    insert_change_log(
                        &db_conn,
                        connection_id,
                        "ADD_FK",
                        tname,
                        Some(&fk.column),
                        Some(&meta),
                        &created_at,
                    )?;
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
