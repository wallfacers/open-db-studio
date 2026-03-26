use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub(crate) async fn query_frontend(handle: &Arc<tauri::AppHandle>, query_type: &str, params: Value) -> crate::AppResult<Value> {
    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = app_state.pending_queries.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    handle.emit("mcp://query-request", json!({
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

async fn send_ui_action(handle: &Arc<tauri::AppHandle>, action: &str, params: Value) -> crate::AppResult<Value> {
    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::UiActionResponse>();
    {
        let mut pending = app_state.pending_ui_actions.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    handle.emit("mcp://ui-action", json!({
        "request_id": request_id,
        "action": action,
        "params": params
    })).map_err(|e| crate::AppError::Other(e.to_string()))?;

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(resp)) => {
            if resp.success {
                Ok(resp.data.unwrap_or(Value::Null))
            } else {
                Err(crate::AppError::Other(resp.error.unwrap_or_else(|| "UI action failed".into())))
            }
        }
        Ok(Err(_)) => Err(crate::AppError::Other("ui action channel dropped".into())),
        Err(_) => {
            app_state.pending_ui_actions.lock().await.remove(&request_id);
            Err(crate::AppError::Other("UI 操作超时（30s）".into()))
        }
    }
}

pub async fn search_tabs(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let result = query_frontend(&handle, "search_tabs", args).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

pub async fn get_tab_content(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let result = query_frontend(&handle, "get_tab_content", args).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

pub async fn focus_tab(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let result = send_ui_action(&handle, "focus_tab", args).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

pub async fn open_tab(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let result = send_ui_action(&handle, "open_tab", args).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
