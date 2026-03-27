use serde_json::{json, Value};
use std::sync::Arc;

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

    // 执行更新（支持完整字段）
    let input = crate::metrics::UpdateMetricInput {
        display_name: args["display_name"].as_str().map(|s| s.to_string()),
        description: args["description"].as_str().map(|s| s.to_string()),
        table_name: args["table_name"].as_str().map(|s| s.to_string()),
        column_name: args["column_name"].as_str().map(|s| s.to_string()),
        filter_sql: args["filter_sql"].as_str().map(|s| s.to_string()),
        aggregation: args["aggregation"].as_str().map(|s| s.to_string()),
        name: None,
        metric_type: None,
        composite_components: None,
        composite_formula: None,
        category: None,
        data_caliber: None,
        version: None,
        scope_database: None,
        scope_schema: None,
    };

    // 收集已更新的字段名用于消息描述
    let updated_fields: Vec<&str> = [
        ("display_name", input.display_name.is_some()),
        ("description", input.description.is_some()),
        ("table_name", input.table_name.is_some()),
        ("column_name", input.column_name.is_some()),
        ("filter_sql", input.filter_sql.is_some()),
        ("aggregation", input.aggregation.is_some()),
    ]
    .iter()
    .filter_map(|(name, present)| if *present { Some(*name) } else { None })
    .collect();

    let result = crate::metrics::crud::update_metric(metric_id, &input);

    match result {
        Ok(updated) => {
            let new_value = serde_json::to_string(&updated).unwrap_or_default();
            crate::db::complete_change_history(history_id, Some(&new_value), "success")?;
            let fields_desc = if updated_fields.is_empty() {
                "（无字段变更）".to_string()
            } else {
                updated_fields.join("、")
            };
            Ok(json!({
                "success": true,
                "message": format!("指标 {} 已更新字段 [{}]，可输入「撤销」回滚", metric_id, fields_desc),
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

