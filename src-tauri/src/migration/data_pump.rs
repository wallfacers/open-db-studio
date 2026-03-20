#![allow(dead_code)]

use crate::AppResult;
use super::task_mgr::MigrationProgress;
use tauri::Emitter;

/// 广播迁移进度的 Tauri Event 名称
pub const MIGRATION_PROGRESS_EVENT: &str = "migration:progress";

fn value_to_sql(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            format!("'{}'", v.to_string().replace('\'', "''"))
        }
    }
}

async fn count_rows(ds: &Box<dyn crate::datasource::DataSource>, table: &str) -> i64 {
    ds.execute(&format!("SELECT COUNT(*) FROM {}", table)).await
        .ok()
        .and_then(|r| r.rows.into_iter().next())
        .and_then(|row| row.into_iter().next())
        .and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_i64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        })
        .unwrap_or(0)
}

/// 分批读取源表数据并写入目标表，通过 Tauri Event 广播进度
pub async fn pump_table(
    task_id: i64,
    src_connection_id: i64,
    dst_connection_id: i64,
    src_table: &str,
    dst_table: &str,
    batch_size: usize,
    skip_errors: bool,
    app_handle: &tauri::AppHandle,
) -> AppResult<MigrationProgress> {
    let src_config = crate::db::get_connection_config(src_connection_id)?;
    let dst_config = crate::db::get_connection_config(dst_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;
    let dst_ds = crate::datasource::create_datasource(&dst_config).await?;

    let total_rows = count_rows(&src_ds, src_table).await;
    let mut progress = MigrationProgress {
        task_id,
        current_table: src_table.to_string(),
        done_rows: 0,
        total_rows,
        error_count: 0,
    };

    let mut offset: i64 = 0;
    let batch = batch_size as i64;

    loop {
        let sql = format!("SELECT * FROM {} LIMIT {} OFFSET {}", src_table, batch, offset);
        let result = match src_ds.execute(&sql).await {
            Ok(r) => r,
            Err(e) => {
                if skip_errors {
                    log::warn!("[data_pump] read error table={} offset={}: {}", src_table, offset, e);
                    progress.error_count += 1;
                    break;
                } else {
                    return Err(e);
                }
            }
        };

        if result.rows.is_empty() { break; }

        let fetched = result.rows.len() as i64;
        let columns = &result.columns;

        for row in &result.rows {
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                dst_table,
                columns.join(", "),
                row.iter().map(value_to_sql).collect::<Vec<_>>().join(", ")
            );
            if let Err(e) = dst_ds.execute(&insert_sql).await {
                if skip_errors {
                    log::warn!("[data_pump] insert error: {}", e);
                    progress.error_count += 1;
                } else {
                    return Err(e);
                }
            }
        }

        progress.done_rows += fetched;
        offset += fetched;
        let _ = app_handle.emit(MIGRATION_PROGRESS_EVENT, &progress);
        super::task_mgr::save_progress(task_id, &progress)?;

        if fetched < batch { break; }
    }

    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_value_to_sql_null() {
        assert_eq!(value_to_sql(&serde_json::Value::Null), "NULL");
    }

    #[test]
    fn test_value_to_sql_string_escape() {
        assert_eq!(value_to_sql(&serde_json::Value::String("it's".into())), "'it''s'");
    }

    #[test]
    fn test_value_to_sql_number() {
        assert_eq!(value_to_sql(&serde_json::json!(42)), "42");
    }

    #[test]
    fn test_value_to_sql_bool() {
        assert_eq!(value_to_sql(&serde_json::Value::Bool(true)), "1");
        assert_eq!(value_to_sql(&serde_json::Value::Bool(false)), "0");
    }
}
