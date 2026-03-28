use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub(crate) async fn query_frontend(handle: &Arc<tauri::AppHandle>, event_channel: &str, query_type: &str, params: Value) -> crate::AppResult<Value> {
    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = app_state.pending_queries.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    handle.emit(event_channel, json!({
        "request_id": request_id,
        "query_type": query_type,
        "params": params
    })).map_err(|e| crate::AppError::Other(e.to_string()))?;

    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(data)) => Ok(data),
        Ok(Err(_)) => Err(crate::AppError::Other("query channel dropped".into())),
        Err(_) => {
            app_state.pending_queries.lock().await.remove(&request_id);
            Err(crate::AppError::Other("前端查询超时（10s）".into()))
        }
    }
}


