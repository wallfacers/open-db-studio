use serde_json::{json, Value};
use std::sync::Arc;

/// 统一入口：处理 fs_*(resource="tab.metric", ...) 的所有操作
pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    op: &str,
    target: &str,
    payload: Value,
    session_id: String,
) -> crate::AppResult<String> {
    match op {
        "read"   => read(target).await,
        "write"  => write(&handle, target, payload, session_id).await,
        "search" => search(payload).await,
        "open"   => open(&handle, payload).await,
        "exec"   => exec(&handle, target, payload).await,
        _ => Err(crate::AppError::Other(format!("tab.metric: unsupported op '{}'", op))),
    }
}

/// fs_read("tab.metric", "<metric_id>", "struct") → get_metric
async fn read(target: &str) -> crate::AppResult<String> {
    let metric_id: i64 = target
        .parse()
        .map_err(|_| crate::AppError::Other(format!("tab.metric read: invalid target '{}', expected metric_id", target)))?;
    let metric = crate::db::get_metric_by_id(metric_id)?;
    Ok(serde_json::to_string_pretty(&metric).unwrap_or_default())
}

/// fs_write("tab.metric", "<metric_id>", {mode:"struct", path:"/field", value:...})
/// → update_metric_definition（包含 auto_mode 检查和变更历史记录）
async fn write(
    handle: &Arc<tauri::AppHandle>,
    target: &str,
    patch: Value,
    session_id: String,
) -> crate::AppResult<String> {
    let metric_id: i64 = target
        .parse()
        .map_err(|_| crate::AppError::Other("tab.metric write: invalid target, expected metric_id".into()))?;

    // 将 struct patch 转换为 update_metric_definition 的参数格式
    let args = if patch.get("mode").and_then(|v| v.as_str()) == Some("struct") {
        let path = patch["path"].as_str().unwrap_or("").trim_start_matches('/');
        let value = patch["value"].clone();
        json!({ "metric_id": metric_id, path: value })
    } else {
        // 允许直接传 { metric_id, display_name?, description?, ... }
        let mut a = patch;
        a["metric_id"] = json!(metric_id);
        a
    };

    super::metric_edit::update_metric_definition(
        Arc::clone(handle),
        args,
        session_id,
    )
    .await
}

/// fs_search("tab.metric", {connection_id, keyword?, status?, limit?})
/// keyword 非空 → search_metrics；否则 → list_metrics
async fn search(filter: Value) -> crate::AppResult<String> {
    let connection_id = filter["connection_id"]
        .as_i64()
        .ok_or_else(|| crate::AppError::Other("tab.metric search: missing connection_id".into()))?;

    let results: Vec<Value> = if let Some(kw) = filter["keyword"].as_str().filter(|k| !k.is_empty()) {
        let keywords: Vec<String> = kw.split_whitespace().map(|s| s.to_string()).collect();
        let metrics = crate::metrics::search_metrics(connection_id, &keywords)?;
        metrics
            .iter()
            .map(|m| json!({
                "resource": "tab.metric",
                "target":   m.id.to_string(),
                "label":    format!("metric · {}", m.display_name),
                "meta": { "connection_id": connection_id, "status": m.status, "id": m.id }
            }))
            .collect()
    } else {
        let status = filter["status"].as_str().map(|s| s.to_string());
        let limit = filter["limit"].as_u64().unwrap_or(50).min(200) as usize;
        let mut metrics = crate::metrics::list_metrics(connection_id, status.as_deref())?;
        metrics.truncate(limit);
        metrics
            .iter()
            .map(|m| json!({
                "resource": "tab.metric",
                "target":   m.id.to_string(),
                "label":    format!("metric · {}", m.display_name),
                "meta": { "connection_id": connection_id, "status": m.status, "id": m.id }
            }))
            .collect()
    };

    Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
}

/// fs_open("tab.metric", {metric_id: N}) → 打开指标 Tab（UI 操作）
async fn open(handle: &Arc<tauri::AppHandle>, params: Value) -> crate::AppResult<String> {
    let result = super::tab_control::send_ui_action(
        handle,
        "open_tab",
        json!({
            "type":      "metric",
            "metric_id": params["metric_id"]
        }),
    )
    .await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

/// fs_exec("tab.metric", "new", {action:"create", params:{connection_id, name, display_name, ...}})
/// → create_metric
async fn exec(
    handle: &Arc<tauri::AppHandle>,
    _target: &str,
    payload: Value,
) -> crate::AppResult<String> {
    let action = payload["action"].as_str().unwrap_or("");
    match action {
        "create" => {
            let params = payload["params"].clone();
            super::metric_edit::create_metric(Arc::clone(handle), params).await
        }
        _ => Err(crate::AppError::Other(format!("tab.metric exec: unsupported action '{}'", action))),
    }
}
