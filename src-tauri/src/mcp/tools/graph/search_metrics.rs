use std::sync::Arc;
use serde_json::{json, Value};

pub async fn handle(
    _handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let keyword = args["keyword"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing keyword".into()))?;
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;

    let conn = crate::db::get().lock()
        .map_err(|e| crate::AppError::Other(format!("DB mutex poisoned: {}", e)))?;

    let pattern = format!("%{}%", keyword);
    let mut stmt = conn.prepare(
        "SELECT name, display_name, metadata
         FROM graph_nodes
         WHERE connection_id=?1
           AND node_type='metric'
           AND is_deleted=0
           AND (name LIKE ?2 OR display_name LIKE ?2)"
    )?;

    let results: Vec<Value> = stmt.query_map(
        rusqlite::params![connection_id, pattern],
        |row| {
            let name: String = row.get(0)?;
            let display_name: String = row.get(1)?;
            let metadata_str: Option<String> = row.get(2)?;
            Ok((name, display_name, metadata_str))
        }
    )?
    .filter_map(|r| r.ok())
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
