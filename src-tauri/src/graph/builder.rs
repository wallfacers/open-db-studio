use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BuildProgress {
    pub step: String,
    pub done: usize,
    pub total: usize,
}

fn node_id(connection_id: i64, node_type: &str, parts: &[&str]) -> String {
    format!("{}:{}:{}", connection_id, node_type, parts.join(":"))
}

fn upsert_node(
    conn: &rusqlite::Connection,
    id: &str,
    node_type: &str,
    connection_id: i64,
    name: &str,
    display_name: Option<&str>,
    metadata: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO graph_nodes (id, node_type, connection_id, name, display_name, metadata, source)
         VALUES (?1,?2,?3,?4,?5,?6,'schema')
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, display_name=excluded.display_name,
           metadata=excluded.metadata,
           source=CASE WHEN source='user' THEN 'user' ELSE 'schema' END",
        rusqlite::params![id, node_type, connection_id, name, display_name, metadata],
    )?;
    Ok(())
}

fn upsert_edge(
    conn: &rusqlite::Connection,
    id: &str,
    from_node: &str,
    to_node: &str,
    edge_type: &str,
    metadata: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO graph_edges (id, from_node, to_node, edge_type, metadata)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET edge_type=excluded.edge_type, metadata=excluded.metadata",
        rusqlite::params![id, from_node, to_node, edge_type, metadata],
    )?;
    Ok(())
}

pub async fn build_schema_graph_full(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    // 1. 获取数据源 schema
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    let total = schema.tables.len();
    let mut node_count = 0usize;

    for (i, table) in schema.tables.iter().enumerate() {
        let _ = app_handle.emit("graph:build_progress", BuildProgress {
            step: format!("处理表 {}", table.name),
            done: i,
            total,
        });

        // ⚠️ 先在锁外 await 获取远程数据（MutexGuard 不能跨 await）
        let columns = ds.get_columns(&table.name, None).await.unwrap_or_default();
        let fks = ds.get_foreign_keys(&table.name, None).await.unwrap_or_default();

        let table_id = node_id(connection_id, "table", &[&table.name]);

        {
            let db_conn = crate::db::get().lock().unwrap();
            let meta = serde_json::json!({"table_type": table.table_type}).to_string();
            upsert_node(&db_conn, &table_id, "table", connection_id,
                        &table.name, Some(&table.name), Some(&meta))?;
            node_count += 1;

            // 列节点（同步写入，无 await）
            for col in &columns {
                let col_id = node_id(connection_id, "column", &[&table.name, &col.name]);
                let col_meta = serde_json::json!({
                    "data_type": col.data_type,
                    "is_nullable": col.is_nullable,
                    "is_primary_key": col.is_primary_key,
                    "column_default": col.column_default
                }).to_string();
                upsert_node(&db_conn, &col_id, "column", connection_id,
                            &col.name, None, Some(&col_meta))?;
                let edge_id = format!("{}->{}", table_id, col_id);
                upsert_edge(&db_conn, &edge_id, &table_id, &col_id, "has_column", None)?;
                node_count += 1;
            }

            // 外键边
            for fk in &fks {
                let ref_table_id = node_id(connection_id, "table", &[&fk.referenced_table]);
                let fk_meta = serde_json::json!({
                    "constraint_name": fk.constraint_name,
                    "column": fk.column,
                    "referenced_column": fk.referenced_column
                }).to_string();
                let edge_id = format!("fk:{}", fk.constraint_name);
                upsert_edge(&db_conn, &edge_id, &table_id, &ref_table_id,
                            "foreign_key", Some(&fk_meta))?;
            }
        }
    }

    let _ = app_handle.emit("graph:build_progress", BuildProgress {
        step: "完成".to_string(),
        done: total,
        total,
    });

    log::info!("[graph] Built {} nodes for connection {}", node_count, connection_id);
    Ok(node_count)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_node_id_format() {
        let table_id = format!("{}:table:{}", 1i64, "orders");
        assert_eq!(table_id, "1:table:orders");
        let col_id = format!("{}:column:{}:{}", 1i64, "orders", "user_id");
        assert_eq!(col_id, "1:column:orders:user_id");
    }
}
