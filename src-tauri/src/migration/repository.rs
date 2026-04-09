use rusqlite::params;
use crate::error::AppResult;
use super::task_mgr::*;

// ── Categories ───────────────────────────────────────────────

pub fn list_categories() -> AppResult<Vec<MigrationCategory>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, parent_id, sort_order, created_at
         FROM migration_categories ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([], MigrationCategory::from_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_category(name: &str, parent_id: Option<i64>) -> AppResult<MigrationCategory> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "INSERT INTO migration_categories (name, parent_id) VALUES (?1, ?2)",
        params![name, parent_id],
    )?;
    let id = db.last_insert_rowid();
    let cat = db.query_row(
        "SELECT id, name, parent_id, sort_order, created_at
         FROM migration_categories WHERE id=?1",
        params![id],
        MigrationCategory::from_row,
    )?;
    Ok(cat)
}

pub fn rename_category(id: i64, name: &str) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_categories SET name=?1 WHERE id=?2",
        params![name, id],
    )?;
    Ok(())
}

pub fn delete_category(id: i64) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "DELETE FROM migration_categories WHERE id=?1",
        params![id],
    )?;
    Ok(())
}

// ── Jobs ─────────────────────────────────────────────────────

pub fn list_jobs() -> AppResult<Vec<MigrationJob>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, category_id, config_json, last_status, last_run_at, created_at, updated_at
         FROM migration_jobs ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], MigrationJob::from_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_job(name: &str, category_id: Option<i64>) -> AppResult<MigrationJob> {
    let default_config = serde_json::to_string(&MigrationJobConfig::default())
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
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
        MigrationJob::from_row,
    )?;
    Ok(job)
}

pub fn update_job_config(id: i64, config_json: &str) -> AppResult<()> {
    serde_json::from_str::<MigrationJobConfig>(config_json)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs \
         SET config_json=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id=?2",
        params![config_json, id],
    )?;
    Ok(())
}

pub fn rename_job(id: i64, name: &str) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs \
         SET name=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id=?2",
        params![name, id],
    )?;
    Ok(())
}

pub fn delete_job(id: i64) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute("DELETE FROM migration_jobs WHERE id=?1", params![id])?;
    Ok(())
}

pub fn move_job(id: i64, category_id: Option<i64>) -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    db.execute(
        "UPDATE migration_jobs \
         SET category_id=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id=?2",
        params![category_id, id],
    )?;
    Ok(())
}

// ── Dirty records & Run history ──────────────────────────────

pub fn get_dirty_records(job_id: i64, run_id: &str) -> AppResult<Vec<MigrationDirtyRecord>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, row_index, field_name, raw_value, error_msg, created_at
         FROM migration_dirty_records
         WHERE job_id=?1 AND run_id=?2
         ORDER BY id LIMIT 500",
    )?;
    let rows = stmt.query_map(params![job_id, run_id], MigrationDirtyRecord::from_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_run_history(job_id: i64) -> AppResult<Vec<MigrationRunHistory>> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, status, rows_read, rows_written, rows_failed,
                bytes_transferred, duration_ms, started_at, finished_at, log_content
         FROM migration_run_history
         WHERE job_id=?1
         ORDER BY started_at DESC",
    )?;
    let rows = stmt.query_map(params![job_id], MigrationRunHistory::from_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Migrate all jobs from old config format (top-level target) to new format (tableMappings).
/// Called once at startup. Idempotent — already-migrated configs are unchanged.
pub fn migrate_legacy_configs() -> AppResult<()> {
    let db = crate::db::get().lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, config_json FROM migration_jobs",
    )?;
    let jobs: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    for (id, config_json) in jobs {
        // Try to parse. The custom deserializer handles migration automatically.
        if let Ok(config) = serde_json::from_str::<MigrationJobConfig>(&config_json) {
            // Re-serialize in new format
            let new_json = serde_json::to_string(&config)
                .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
            if new_json != config_json {
                db.execute(
                    "UPDATE migration_jobs SET config_json=?1 WHERE id=?2",
                    params![new_json, id],
                )?;
            }
        }
    }
    Ok(())
}
