use std::sync::Arc;
use serde_json::{json, Value};

pub async fn handle(
    _handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;

    let conn = crate::db::get().lock()
        .map_err(|e| crate::AppError::Other(format!("DB mutex poisoned: {}", e)))?;

    // 查询表节点的 metadata（包含列信息）
    let result: rusqlite::Result<Option<String>> = conn.query_row(
        "SELECT metadata FROM graph_nodes
         WHERE connection_id=?1 AND name=?2 AND node_type='table' AND is_deleted=0
         LIMIT 1",
        rusqlite::params![connection_id, table_name],
        |row| row.get(0),
    ).map(Some).or_else(|e| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            Ok(None)
        } else {
            Err(e)
        }
    });

    let metadata_str = match result? {
        None => {
            return Ok(serde_json::to_string_pretty(&json!({
                "ddl": "",
                "not_found": true,
            })).unwrap_or_default());
        }
        Some(s) => s,
    };

    // 解析 metadata，提取列信息
    let meta: Value = serde_json::from_str(&metadata_str)
        .unwrap_or(Value::Null);

    // 生成简化 DDL
    let columns = meta.get("columns").and_then(|v| v.as_array());
    let ddl = if let Some(cols) = columns {
        let col_defs: Vec<String> = cols.iter().map(|c| {
            let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let col_type = c.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
            let comment = c.get("comment").and_then(|v| v.as_str()).unwrap_or("");
            if comment.is_empty() {
                format!("  {} {}", name, col_type)
            } else {
                format!("  {} {} COMMENT '{}'", name, col_type, comment)
            }
        }).collect();
        format!("CREATE TABLE {} (\n{}\n);", table_name, col_defs.join(",\n"))
    } else {
        format!("CREATE TABLE {} (\n  -- schema not available\n);", table_name)
    };

    Ok(serde_json::to_string_pretty(&json!({
        "ddl": ddl,
        "not_found": false,
    })).unwrap_or_default())
}
