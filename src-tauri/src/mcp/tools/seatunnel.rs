use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// propose_seatunnel_job：AI 生成 SeaTunnel Job 配置后，通过 UI action 向前端发起确认
/// 前端通过已有的 mcp_ui_action_respond Tauri 命令（即 respond_ui_action）返回结果
pub async fn propose_seatunnel_job(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let job_name = args["job_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing job_name".into()))?;
    let config_json = args["config_json"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing config_json".into()))?;
    let category_id = args["category_id"].as_i64(); // 可选
    let description = args["description"].as_str().unwrap_or("");

    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::UiActionResponse>();
    {
        let mut pending = app_state.pending_ui_actions.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    handle.emit("mcp://ui-action", json!({
        "request_id": request_id,
        "action": "propose_seatunnel_job",
        "params": {
            "job_name": job_name,
            "config_json": config_json,
            "category_id": category_id,
            "description": description
        }
    })).map_err(|e| crate::AppError::Other(e.to_string()))?;

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(resp)) => {
            if resp.success {
                Ok(json!({
                    "accepted": true,
                    "message": format!("Job '{}' 配置已被用户接受并创建", job_name),
                    "data": resp.data
                }).to_string())
            } else {
                Ok(json!({
                    "accepted": false,
                    "message": resp.error.unwrap_or_else(|| "用户拒绝了 Job 配置".into())
                }).to_string())
            }
        }
        Ok(Err(_)) => Err(crate::AppError::Other("ui action channel dropped".into())),
        Err(_) => {
            app_state.pending_ui_actions.lock().await.remove(&request_id);
            Err(crate::AppError::Other("用户未在 30s 内响应".into()))
        }
    }
}
