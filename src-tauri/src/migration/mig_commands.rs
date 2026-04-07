use rusqlite::params;
use serde_json;
use crate::error::AppResult;
use super::task_mgr::*;

// ── Categories ───────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_categories() -> AppResult<Vec<MigrationCategory>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, parent_id, sort_order, created_at
         FROM migration_categories ORDER BY sort_order, name"
    )?;
    let rows = stmt.query_map([], |row| Ok(MigrationCategory {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_migration_category(
    name: String,
    parent_id: Option<i64>,
) -> AppResult<MigrationCategory> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "INSERT INTO migration_categories (name, parent_id) VALUES (?1, ?2)",
        params![name, parent_id],
    )?;
    let id = db.last_insert_rowid();
    let cat = db.query_row(
        "SELECT id, name, parent_id, sort_order, created_at FROM migration_categories WHERE id=?1",
        params![id],
        |row| Ok(MigrationCategory {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        }),
    )?;
    Ok(cat)
}

#[tauri::command]
pub async fn rename_migration_category(id: i64, name: String) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute("UPDATE migration_categories SET name=?1 WHERE id=?2", params![name, id])?;
    Ok(())
}

#[tauri::command]
pub async fn delete_migration_category(id: i64) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute("DELETE FROM migration_categories WHERE id=?1", params![id])?;
    Ok(())
}

// ── Jobs ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_jobs() -> AppResult<Vec<MigrationJob>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, category_id, config_json, last_status, last_run_at, created_at, updated_at
         FROM migration_jobs ORDER BY updated_at DESC"
    )?;
    let rows = stmt.query_map([], |row| Ok(MigrationJob {
        id: row.get(0)?,
        name: row.get(1)?,
        category_id: row.get(2)?,
        config_json: row.get(3)?,
        last_status: row.get(4)?,
        last_run_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_migration_job(
    name: String,
    category_id: Option<i64>,
) -> AppResult<MigrationJob> {
    let default_config = serde_json::to_string(&MigrationJobConfig::default())?;
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "INSERT INTO migration_jobs (name, category_id, config_json) VALUES (?1, ?2, ?3)",
        params![name, category_id, default_config],
    )?;
    let id = db.last_insert_rowid();
    let job = db.query_row(
        "SELECT id, name, category_id, config_json, last_status, last_run_at, created_at, updated_at
         FROM migration_jobs WHERE id=?1",
        params![id],
        |row| Ok(MigrationJob {
            id: row.get(0)?,
            name: row.get(1)?,
            category_id: row.get(2)?,
            config_json: row.get(3)?,
            last_status: row.get(4)?,
            last_run_at: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        }),
    )?;
    Ok(job)
}

#[tauri::command]
pub async fn update_migration_job_config(id: i64, config_json: String) -> AppResult<()> {
    // Validate JSON before saving
    serde_json::from_str::<MigrationJobConfig>(&config_json)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET config_json=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![config_json, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn rename_migration_job(id: i64, name: String) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET name=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_migration_job(id: i64) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute("DELETE FROM migration_jobs WHERE id=?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub async fn move_migration_job(id: i64, category_id: Option<i64>) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET category_id=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![category_id, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_migration_dirty_records(
    job_id: i64,
    run_id: String,
) -> AppResult<Vec<MigrationDirtyRecord>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, row_index, field_name, raw_value, error_msg, created_at
         FROM migration_dirty_records WHERE job_id=?1 AND run_id=?2 ORDER BY id LIMIT 500"
    )?;
    let rows = stmt.query_map(params![job_id, run_id], |row| Ok(MigrationDirtyRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        run_id: row.get(2)?,
        row_index: row.get(3)?,
        field_name: row.get(4)?,
        raw_value: row.get(5)?,
        error_msg: row.get(6)?,
        created_at: row.get(7)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn run_migration_job(
    job_id: i64,
    app: tauri::AppHandle,
) -> crate::error::AppResult<String> {
    super::pipeline::run_pipeline(job_id, app).await
}

#[tauri::command]
pub async fn stop_migration_job(job_id: i64) -> crate::error::AppResult<()> {
    super::pipeline::cancel_run(job_id);
    Ok(())
}

#[tauri::command]
pub async fn get_migration_run_history(job_id: i64) -> AppResult<Vec<MigrationRunHistory>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, status, rows_read, rows_written, rows_failed,
                bytes_transferred, duration_ms, started_at, finished_at
         FROM migration_run_history WHERE job_id=?1 ORDER BY started_at DESC LIMIT 20"
    )?;
    let rows = stmt.query_map(params![job_id], |row| Ok(MigrationRunHistory {
        id: row.get(0)?,
        job_id: row.get(1)?,
        run_id: row.get(2)?,
        status: row.get(3)?,
        rows_read: row.get(4)?,
        rows_written: row.get(5)?,
        rows_failed: row.get(6)?,
        bytes_transferred: row.get(7)?,
        duration_ms: row.get(8)?,
        started_at: row.get(9)?,
        finished_at: row.get(10)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
