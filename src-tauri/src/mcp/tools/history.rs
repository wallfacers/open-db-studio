use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

pub async fn get_change_history(_handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    let limit = args["limit"].as_i64().unwrap_or(10).min(50) as i64;
    let records = crate::db::list_change_history(&session_id, limit)?;
    Ok(serde_json::to_string_pretty(&records).unwrap_or_default())
}

pub async fn undo_last_change(handle: Arc<tauri::AppHandle>, _args: Value, session_id: String) -> crate::AppResult<String> {
    // 找到最后一条 status='success' 的记录
    let record = crate::db::get_last_success_change(&session_id)?
        .ok_or_else(|| crate::AppError::Other("没有可撤销的操作".into()))?;

    let auto_mode = {
        let app_state = handle.state::<crate::AppState>();
        let x = *app_state.auto_mode.lock().await; x
    };
    if !auto_mode {
        return Err(crate::AppError::Other("Auto 模式已关闭，请通过 ACP 确认后执行撤销操作".into()));
    }

    match record.target_type.as_str() {
        "metric" => {
            let metric_id: i64 = record.target_id.parse()
                .map_err(|_| crate::AppError::Other("invalid metric target_id".into()))?;
            let old: serde_json::Value = serde_json::from_str(&record.old_value)
                .map_err(|e| crate::AppError::Other(e.to_string()))?;
            let input = crate::metrics::UpdateMetricInput {
                display_name: old["display_name"].as_str().map(|s| s.to_string()),
                description: old["description"].as_str().map(|s| s.to_string()),
                table_name: old["table_name"].as_str().map(|s| s.to_string()),
                column_name: old["column_name"].as_str().map(|s| s.to_string()),
                filter_sql: old["filter_sql"].as_str().map(|s| s.to_string()),
                aggregation: old["aggregation"].as_str().map(|s| s.to_string()),
                name: old["name"].as_str().map(|s| s.to_string()),
                metric_type: old["metric_type"].as_str().map(|s| s.to_string()),
                composite_components: old["composite_components"].as_str().map(|s| s.to_string()),
                composite_formula: old["composite_formula"].as_str().map(|s| s.to_string()),
                category: old["category"].as_str().map(|s| s.to_string()),
                data_caliber: old["data_caliber"].as_str().map(|s| s.to_string()),
                version: old["version"].as_str().map(|s| s.to_string()),
                scope_database: old["scope_database"].as_str().map(|s| s.to_string()),
                scope_schema: old["scope_schema"].as_str().map(|s| s.to_string()),
            };
            crate::metrics::crud::update_metric(metric_id, &input)?;
            crate::db::mark_change_undone(record.id)?;
            Ok(json!({ "success": true, "message": format!("已撤销指标 {} 的修改", metric_id) }).to_string())
        }
        "column" => {
            // target_id 格式: conn_id:table_name.column_name
            let parts: Vec<&str> = record.target_id.splitn(2, ':').collect();
            if parts.len() != 2 {
                return Err(crate::AppError::Other("invalid column target_id format".into()));
            }
            let conn_id: i64 = parts[0].parse()
                .map_err(|_| crate::AppError::Other("invalid conn_id in target_id".into()))?;
            let table_col: Vec<&str> = parts[1].splitn(2, '.').collect();
            if table_col.len() != 2 {
                return Err(crate::AppError::Other("invalid table.column in target_id".into()));
            }
            let table_name = table_col[0];
            let column_name = table_col[1];

            let old: serde_json::Value = serde_json::from_str(&record.old_value)
                .map_err(|e| crate::AppError::Other(e.to_string()))?;
            let old_comment = old.get("extra")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource(&config).await?;

            let sql = match config.driver.as_str() {
                "mysql" => format!(
                    "ALTER TABLE `{}` MODIFY COLUMN `{}` {} COMMENT '{}'",
                    table_name, column_name,
                    old["data_type"].as_str().unwrap_or("VARCHAR(255)"),
                    old_comment.replace('\'', "''")
                ),
                "postgres" => format!(
                    "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}'",
                    table_name, column_name,
                    old_comment.replace('\'', "''")
                ),
                _ => return Err(crate::AppError::Other("undo_last_change only supports mysql/postgres for column type".into())),
            };

            ds.execute(&sql).await?;
            crate::db::mark_change_undone(record.id)?;
            Ok(json!({ "success": true, "message": format!("已撤销 {}.{} 注释的修改", table_name, column_name) }).to_string())
        }
        _ => Err(crate::AppError::Other(format!("不支持撤销 target_type={}", record.target_type))),
    }
}
