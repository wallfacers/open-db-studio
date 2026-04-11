use crate::error::{AppError, AppResult};
use super::task_mgr::*;

// ── Categories ───────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_categories() -> AppResult<Vec<MigrationCategory>> {
    tokio::task::spawn_blocking(|| super::repository::list_categories())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_migration_category(
    name: String,
    parent_id: Option<i64>,
) -> AppResult<MigrationCategory> {
    tokio::task::spawn_blocking(move || super::repository::create_category(&name, parent_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn rename_migration_category(id: i64, name: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::rename_category(id, &name))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_migration_category(id: i64) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::delete_category(id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn move_migration_category(id: i64, parent_id: Option<i64>) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::move_category(id, parent_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ── Jobs ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_jobs() -> AppResult<Vec<MigrationJob>> {
    tokio::task::spawn_blocking(|| super::repository::list_jobs())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_migration_job(
    name: String,
    category_id: Option<i64>,
) -> AppResult<MigrationJob> {
    tokio::task::spawn_blocking(move || super::repository::create_job(&name, category_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn update_migration_job_script(id: i64, script_text: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::update_job_script(id, &script_text))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn rename_migration_job(id: i64, name: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::rename_job(id, &name))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_migration_job(id: i64) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::delete_job(id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn move_migration_job(id: i64, category_id: Option<i64>) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::move_job(id, category_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ── Execution ─────────────────────────────────────────────────

#[tauri::command]
pub async fn run_migration_job(
    job_id: i64,
    app: tauri::AppHandle,
) -> AppResult<String> {
    super::pipeline::run_pipeline(job_id, app).await
}

#[tauri::command]
pub async fn stop_migration_job(job_id: i64) -> AppResult<()> {
    super::pipeline::cancel_run(job_id);
    Ok(())
}

// ── History & dirty records ────────────────────────────────────

#[tauri::command]
pub async fn get_migration_dirty_records(
    job_id: i64,
    run_id: String,
) -> AppResult<Vec<MigrationDirtyRecord>> {
    tokio::task::spawn_blocking(move || super::repository::get_dirty_records(job_id, &run_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn get_migration_run_history(job_id: i64) -> AppResult<Vec<MigrationRunHistory>> {
    tokio::task::spawn_blocking(move || super::repository::get_run_history(job_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_migration_run_history(job_id: i64, run_id: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::delete_run_history(job_id, &run_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ── LSP ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn lsp_request(
    method: String,
    params: serde_json::Value,
    app: tauri::AppHandle,
) -> AppResult<serde_json::Value> {
    super::lsp::handler::handle_request(&method, params, &app).await
}

