use std::sync::Arc;
use serde_json::{json, Value};

pub async fn handle(
    _handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let keyword = args["keyword"].as_str().unwrap_or("");
    let table_name_filter = args["table_name"].as_str();
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;

    if keyword.is_empty() && table_name_filter.is_none() {
        return Err(crate::AppError::Other("keyword or table_name is required".into()));
    }

    let conn = crate::db::get().lock()
        .map_err(|e| crate::AppError::Other(format!("DB mutex poisoned: {}", e)))?;

    // 按 table_name 精确查询（覆盖"X表有哪些指标"场景），
    // 或按 keyword 模糊匹配 name/display_name
    let raw_rows = if let Some(tbl) = table_name_filter {
        let mut stmt = conn.prepare(
            "SELECT name, display_name, metadata
             FROM graph_nodes
             WHERE connection_id=?1
               AND node_type='metric'
               AND is_deleted=0
               AND json_extract(metadata, '$.table_name') = ?2"
        )?;
        let mut rows = stmt.query(rusqlite::params![connection_id, tbl])?;
        let mut out: Vec<(String, String, Option<String>)> = Vec::new();
        while let Some(row) = rows.next()? {
            out.push((row.get(0)?, row.get(1)?, row.get(2)?));
        }
        out
    } else {
        let pattern = format!("%{}%", keyword);
        let mut stmt = conn.prepare(
            "SELECT name, display_name, metadata
             FROM graph_nodes
             WHERE connection_id=?1
               AND node_type='metric'
               AND is_deleted=0
               AND (name LIKE ?2 OR display_name LIKE ?2)"
        )?;
        let mut rows = stmt.query(rusqlite::params![connection_id, pattern])?;
        let mut out: Vec<(String, String, Option<String>)> = Vec::new();
        while let Some(row) = rows.next()? {
            out.push((row.get(0)?, row.get(1)?, row.get(2)?));
        }
        out
    };

    let results: Vec<Value> = raw_rows.into_iter()
        .map(|(name, display_name, meta_str)| {
            let meta: Value = meta_str
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            let table_name = meta.get("table_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let description = meta.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let aggregation = meta.get("aggregation").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let calculation = if !aggregation.is_empty() && !table_name.is_empty() {
                format!("{}({}.*)", aggregation, table_name)
            } else {
                String::new()
            };
            json!({
                "name": name,
                "display_name": display_name,
                "table_name": table_name,
                "description": description,
                "calculation": calculation,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
}
