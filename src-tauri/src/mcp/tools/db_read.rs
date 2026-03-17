use serde_json::{json, Value};
use std::sync::Arc;

/// search_db_metadata: 从 treeStore 元数据缓存中搜索（通过前端 query-request 桥接）
pub async fn search_db_metadata(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let keyword = args["keyword"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing keyword".into()))?;

    use tauri::Manager;
    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = app_state.pending_queries.lock().await;
        pending.insert(request_id.clone(), tx);
    }

    use tauri::Emitter;
    handle.emit("mcp://query-request", json!({
        "request_id": request_id,
        "query_type": "search_db_metadata",
        "params": { "keyword": keyword }
    })).map_err(|e| crate::AppError::Other(e.to_string()))?;

    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(data)) => Ok(serde_json::to_string_pretty(&data).unwrap_or_default()),
        Ok(Err(_)) => Err(crate::AppError::Other("query channel dropped".into())),
        Err(_) => {
            app_state.pending_queries.lock().await.remove(&request_id);
            Err(crate::AppError::Other("search_db_metadata 超时（10s）".into()))
        }
    }
}
