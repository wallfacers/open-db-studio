use serde_json::Value;
use std::sync::Arc;

/// 统一入口：处理 fs_*(resource="panel.history", ...) 的所有操作
pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    op: &str,
    _target: &str,
    payload: Value,
    session_id: String,
) -> crate::AppResult<String> {
    match op {
        "read" => {
            // fs_read("panel.history", "active", "struct") → get_change_history
            let args = serde_json::json!({
                "limit": payload.get("limit").cloned().unwrap_or(serde_json::json!(10))
            });
            super::history::get_change_history(handle, args, session_id).await
        }
        "exec" => {
            // fs_exec("panel.history", "active", {action:"undo"}) → undo_last_change
            let action = payload["action"].as_str().unwrap_or("");
            match action {
                "undo" => {
                    super::history::undo_last_change(handle, serde_json::json!({}), session_id).await
                }
                _ => Err(crate::AppError::Other(format!("panel.history exec: unsupported action '{}'", action))),
            }
        }
        _ => Err(crate::AppError::Other(format!("panel.history: unsupported op '{}'", op))),
    }
}
