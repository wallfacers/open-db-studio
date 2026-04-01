use std::sync::Arc;
use serde_json::{json, Value};

/// 诊断工具：全面排查 graph_find_join_paths 返回空路径的原因
/// 检查链路：table 节点 → schema_change_log ADD_FK 事件 → link 节点 → 缓存状态
pub async fn handle(
    _handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_filter = args["table_name"].as_str().map(|s| s.to_string());

    let conn = crate::db::get().lock().unwrap();

    // ── 1. 检查 table 节点（图谱是否构建过）──────────────────────
    let table_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM graph_nodes
         WHERE connection_id = ?1 AND node_type = 'table' AND is_deleted = 0",
        [connection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    // 如果有过滤条件，检查该表节点是否存在（支持 PG schema 限定名 fallback）
    let target_table_exists = if let Some(ref tbl) = table_filter {
        let node_id = format!("{}:table:{}", connection_id, tbl);
        let exists = conn.query_row(
            "SELECT COUNT(*) FROM graph_nodes WHERE id = ?1 AND is_deleted = 0",
            [&node_id],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0) > 0;
        // Fallback: try public.{tbl} for PG tables
        if !exists && !tbl.contains('.') {
            let pg_node_id = format!("{}:table:public.{}", connection_id, tbl);
            conn.query_row(
                "SELECT COUNT(*) FROM graph_nodes WHERE id = ?1 AND is_deleted = 0",
                [&pg_node_id],
                |row| row.get::<_, i64>(0),
            ).unwrap_or(0) > 0
        } else {
            exists
        }
    } else {
        false
    };

    // ── 2. 检查 schema_change_log 中的 ADD_FK 事件 ──────────────
    let total_events: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_change_log WHERE connection_id = ?1",
        [connection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    let fk_events_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_change_log
         WHERE connection_id = ?1 AND event_type = 'ADD_FK'",
        [connection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    let fk_events_unprocessed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_change_log
         WHERE connection_id = ?1 AND event_type = 'ADD_FK' AND processed = 0",
        [connection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    // 获取 ADD_FK 事件详情
    let mut fk_stmt = conn.prepare(
        "SELECT table_name, column_name, metadata, processed
         FROM schema_change_log
         WHERE connection_id = ?1 AND event_type = 'ADD_FK'
         ORDER BY created_at DESC
         LIMIT 20",
    )?;
    let fk_events: Vec<Value> = fk_stmt
        .query_map([connection_id], |row| {
            let table_name: String = row.get(0)?;
            let column_name: Option<String> = row.get(1)?;
            let metadata_str: Option<String> = row.get(2)?;
            let processed: i32 = row.get(3)?;

            let metadata: Value = metadata_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);

            Ok(json!({
                "table": table_name,
                "column": column_name,
                "referenced_table": metadata.get("referenced_table").unwrap_or(&Value::Null),
                "referenced_column": metadata.get("referenced_column").unwrap_or(&Value::Null),
                "on_delete": metadata.get("on_delete").unwrap_or(&Value::Null),
                "processed": processed,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // ── 3. 检查 link 节点 ─────────────────────────────────────
    let mut link_stmt = conn.prepare(
        "SELECT id, display_name, metadata, source, is_deleted
         FROM graph_nodes
         WHERE connection_id = ?1 AND node_type = 'link'
         ORDER BY is_deleted, id",
    )?;
    let link_rows: Vec<Value> = link_stmt
        .query_map([connection_id], |row| {
            let id: String = row.get(0)?;
            let display_name: Option<String> = row.get(1)?;
            let metadata_str: Option<String> = row.get(2)?;
            let source: Option<String> = row.get(3)?;
            let is_deleted: i32 = row.get(4)?;

            let metadata: Value = metadata_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);

            Ok(json!({
                "id": id,
                "display_name": display_name,
                "source_table": metadata.get("source_table").unwrap_or(&Value::Null),
                "target_table": metadata.get("target_table").unwrap_or(&Value::Null),
                "via": metadata.get("via").unwrap_or(&Value::Null),
                "cardinality": metadata.get("cardinality").unwrap_or(&Value::Null),
                "source": source,
                "is_deleted": is_deleted,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // 过滤 link
    let filtered_links: Vec<&Value> = if let Some(ref tbl) = table_filter {
        link_rows.iter().filter(|r| {
            let st = r["source_table"].as_str().unwrap_or("");
            let tt = r["target_table"].as_str().unwrap_or("");
            st == tbl.as_str() || tt == tbl.as_str()
        }).collect()
    } else {
        link_rows.iter().collect()
    };

    // ── 4. 检查 graph_edges 的 to_link / from_link 边 ──────────
    let edge_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM graph_edges
         WHERE edge_type IN ('to_link', 'from_link')
           AND (from_node IN (SELECT id FROM graph_nodes WHERE connection_id = ?1)
                OR to_node IN (SELECT id FROM graph_nodes WHERE connection_id = ?1))",
        [connection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    // ── 5. 诊断结论 ──────────────────────────────────────────
    let mut diagnosis = Vec::new();

    if table_count == 0 {
        diagnosis.push("图谱未构建：没有任何 table 节点。请先在 GraphExplorer 中点击「构建图谱」。".to_string());
    } else {
        diagnosis.push(format!("图谱已构建：共 {} 个 table 节点", table_count));
    }

    if let Some(ref tbl) = table_filter {
        if !target_table_exists && table_count > 0 {
            diagnosis.push(format!("表 '{}' 的 table 节点不存在。可能表名不匹配或未包含在构建范围内。", tbl));
        }
    }

    if fk_events_total == 0 && table_count > 0 {
        diagnosis.push("未检测到任何 ADD_FK 事件：数据库可能没有定义外键约束，或 get_foreign_keys() 返回为空。".to_string());
        diagnosis.push("建议：检查数据库是否使用了外键约束（FOREIGN KEY），或者是否仅靠命名约定关联。".to_string());
    } else if fk_events_total > 0 && link_rows.is_empty() {
        if fk_events_unprocessed > 0 {
            diagnosis.push(format!("有 {} 条 ADD_FK 事件尚未处理（processed=0），event_processor 可能执行失败。", fk_events_unprocessed));
        } else {
            diagnosis.push("ADD_FK 事件已全部处理，但 link 节点为 0。event_processor 处理逻辑可能有问题。".to_string());
        }
    }

    if !link_rows.is_empty() && edge_count == 0 {
        diagnosis.push("Link 节点存在但 to_link/from_link 边为 0，边创建逻辑可能有问题。".to_string());
    }

    let result = json!({
        "connection_id": connection_id,
        "filter": table_filter,
        "diagnosis": diagnosis,
        "graph_status": {
            "table_nodes": table_count,
            "target_table_exists": target_table_exists,
            "link_nodes_total": link_rows.len(),
            "link_nodes_filtered": filtered_links.len(),
            "to_link_from_link_edges": edge_count,
        },
        "change_log": {
            "total_events": total_events,
            "add_fk_total": fk_events_total,
            "add_fk_unprocessed": fk_events_unprocessed,
            "fk_event_details": fk_events,
        },
        "links": filtered_links,
    });

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
