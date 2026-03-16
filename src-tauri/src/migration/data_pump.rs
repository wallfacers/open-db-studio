use crate::AppResult;
use super::task_mgr::MigrationProgress;

/// 广播迁移进度的 Tauri Event 名称
pub const MIGRATION_PROGRESS_EVENT: &str = "migration:progress";

/// 分批读取源表数据并写入目标表，通过 Tauri Event 广播进度
/// B3 Task 实现
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
    let _ = (task_id, src_connection_id, dst_connection_id, src_table, dst_table, batch_size, skip_errors, app_handle);
    Ok(MigrationProgress {
        task_id,
        current_table: src_table.to_string(),
        done_rows: 0,
        total_rows: 0,
        error_count: 0,
    })
}
