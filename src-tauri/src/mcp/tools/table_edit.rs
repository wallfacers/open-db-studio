use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

pub async fn get_column_meta(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    if !table_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid table name".into()));
    }
    let database = args["database"].as_str();
    let config = crate::db::get_connection_config(conn_id)?;
    let ds = match database.filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let columns = ds.get_columns(table_name, None).await?;
    Ok(serde_json::to_string_pretty(&columns).unwrap_or_default())
}

pub async fn update_column_comment(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
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

    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    let comment = args["comment"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing comment".into()))?;
    let database = args["database"].as_str().unwrap_or("");

    // 验证表名和列名安全性
    if !table_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid table name".into()));
    }
    if !column_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid column name".into()));
    }

    let config = crate::db::get_connection_config(conn_id)?;
    let ds = if database.is_empty() {
        crate::datasource::create_datasource(&config).await?
    } else {
        crate::datasource::create_datasource_with_db(&config, database).await?
    };

    // 读取当前列信息
    let columns = ds.get_columns(table_name, None).await?;
    let col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;
    let old_value = serde_json::to_string(col).unwrap_or_default();

    let target_id = format!("{}:{}.{}", conn_id, table_name, column_name);
    let history_id = crate::db::insert_change_history(
        &session_id,
        "update_column_comment",
        "column",
        &target_id,
        &old_value,
    )?;

    // 执行 ALTER TABLE
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "ALTER TABLE `{}` MODIFY COLUMN `{}` {} COMMENT '{}'",
            table_name,
            column_name,
            col.data_type,
            comment.replace('\'', "''")
        ),
        "postgres" => format!(
            "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}'",
            table_name,
            column_name,
            comment.replace('\'', "''")
        ),
        _ => return Err(crate::AppError::Other("update_column_comment only supports mysql/postgres".into())),
    };

    let result = ds.execute(&sql).await;

    match result {
        Ok(_) => {
            let new_value = json!({ "comment": comment }).to_string();
            crate::db::complete_change_history(history_id, Some(&new_value), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("{}.{} 注释已更新为「{}」，可输入「撤销」回滚", table_name, column_name, comment)
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}
