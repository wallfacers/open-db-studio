use serde_json::{json, Value};
use std::sync::Arc;

pub async fn get_metric(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let metric_id = args["metric_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing metric_id".into()))?;
    let metric = crate::db::get_metric_by_id(metric_id)?
        .ok_or_else(|| crate::AppError::Other(format!("metric {} not found", metric_id)))?;
    Ok(serde_json::to_string_pretty(&metric).unwrap_or_default())
}

pub async fn update_metric_definition(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    use tauri::Manager;
    let metric_id = args["metric_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing metric_id".into()))?;

    // 检查 auto_mode
    let auto_mode = {
        let app_state = handle.state::<crate::AppState>();
        let x = *app_state.auto_mode.lock().await; x
    };

    if !auto_mode {
        return Err(crate::AppError::Other(
            "Auto 模式已关闭，请通过 ACP 确认后执行写操作".into()
        ));
    }

    // 读取当前值
    let old_metric = crate::db::get_metric_by_id(metric_id)?
        .ok_or_else(|| crate::AppError::Other(format!("metric {} not found", metric_id)))?;
    let old_value = serde_json::to_string(&old_metric).unwrap_or_default();

    // 写入 change_history（status=pending）
    let history_id = crate::db::insert_change_history(
        &session_id,
        "update_metric_definition",
        "metric",
        &metric_id.to_string(),
        &old_value,
    )?;

    // 执行更新
    let description = args["description"].as_str();
    let display_name = args["display_name"].as_str();

    let result = crate::db::update_metric_fields(metric_id, description, display_name);

    match result {
        Ok(updated) => {
            let new_value = serde_json::to_string(&updated).unwrap_or_default();
            crate::db::complete_change_history(history_id, Some(&new_value), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("指标 {} 已更新，可输入「撤销」回滚", metric_id),
                "metric": updated
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

pub async fn create_metric(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let name = args["name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing name".into()))?;
    let display_name = args["display_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing display_name".into()))?;
    let table_name = args["table_name"].as_str().unwrap_or("");
    let description = args["description"].as_str().unwrap_or("");
    let database = args["database"].as_str();
    let schema = args["schema"].as_str();

    let metric = crate::db::create_metric_from_mcp(connection_id, name, display_name, table_name, description, database, schema)?;
    Ok(serde_json::to_string_pretty(&metric).unwrap_or_default())
}

pub async fn list_metrics(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let status = args["status"].as_str();
    let database = args["database"].as_str();
    let schema = args["schema"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(50).min(200) as usize;

    let mut metrics = if database.is_some() || schema.is_some() {
        crate::metrics::list_metrics_by_node(connection_id, database, schema, status)?
    } else {
        crate::metrics::list_metrics(connection_id, status)?
    };
    metrics.truncate(limit);
    Ok(serde_json::to_string_pretty(&metrics).unwrap_or_default())
}

pub async fn search_metrics(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let keyword = args["keyword"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing keyword".into()))?;

    let keywords: Vec<String> = keyword.split_whitespace().map(|s| s.to_string()).collect();
    let metrics = crate::metrics::search_metrics(connection_id, &keywords)?;
    Ok(serde_json::to_string_pretty(&metrics).unwrap_or_default())
}
