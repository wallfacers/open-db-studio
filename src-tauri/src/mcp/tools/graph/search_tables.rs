use std::sync::Arc;
use serde_json::{json, Value};

pub async fn handle(
    _handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let question = args["question"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing question".into()))?;
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;

    let nodes = crate::graph::query::search_graph(connection_id, question)
        .unwrap_or_default();

    let results: Vec<Value> = nodes.iter()
        .filter(|n| matches!(n.node_type.as_str(), "table" | "metric" | "alias"))
        .map(|n| json!({
            "id": n.id,
            "name": n.name,
            "display_name": n.display_name.as_deref().unwrap_or(""),
            "node_type": n.node_type,
        }))
        .collect();

    Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
}
