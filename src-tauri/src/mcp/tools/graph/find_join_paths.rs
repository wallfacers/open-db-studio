use std::sync::Arc;
use serde_json::{json, Value};

pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let from_table = args["from_table"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing from_table".into()))?
        .to_string();
    let to_table = args["to_table"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing to_table".into()))?
        .to_string();
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let max_depth = args["max_depth"].as_u64().unwrap_or(4).min(6) as usize;

    let paths = crate::graph::traversal::find_join_paths_structured(
        connection_id, &from_table, &to_table, max_depth, &handle,
    ).await?;

    let no_path = paths.is_empty();
    let path_values: Vec<Value> = paths.iter().map(|jp| json!({
        "path": jp.path,
        "via": jp.via,
        "cardinality": jp.cardinality,
        "on_delete": jp.on_delete,
        "description": jp.description,
        "sql_hint": jp.sql_hint,
    })).collect();

    let result = json!({
        "paths": path_values,
        "no_path": no_path,
    });

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
