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
pub async fn update_migration_job_config(id: i64, config_json: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || super::repository::update_job_config(id, &config_json))
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

// ── AI Column Mapping ──────────────────────────────────────────

#[tauri::command]
pub async fn ai_recommend_column_mappings(
    source_connection_id: i64,
    source_database: String,
    source_table: String,
    target_connection_id: i64,
    target_database: String,
    target_table: String,
) -> AppResult<Vec<ColumnMapping>> {
    use crate::datasource;

    // Build LLM client from default config
    let llm_client = {
        let config = crate::db::get_default_llm_config()?
            .ok_or_else(|| AppError::Other(
                "No AI model configured. Please add one in Settings → AI Model.".into(),
            ))?;
        let api_type = match config.api_type.as_str() {
            "anthropic" => crate::llm::ApiType::Anthropic,
            _ => crate::llm::ApiType::Openai,
        };
        let base_url = if !config.base_url.is_empty() {
            config.base_url.clone()
        } else if !config.opencode_provider_id.is_empty() {
            crate::agent::config::resolve_opencode_base_url(&config.opencode_provider_id)
                .unwrap_or_default()
        } else {
            String::new()
        };
        crate::llm::client::LlmClient::new(
            config.api_key,
            Some(base_url),
            Some(config.model),
            Some(api_type),
        )
    };

    // Get source columns
    let src_cfg = crate::db::get_connection_config(source_connection_id)?;
    let src_ds = if source_database.is_empty() {
        datasource::create_datasource(&src_cfg).await?
    } else {
        datasource::create_datasource_with_db(&src_cfg, &source_database).await?
    };
    let src_cols = src_ds.get_columns(&source_table, None).await?;

    if src_cols.is_empty() {
        return Err(AppError::Other(
            format!("Source table '{}' has no columns", source_table),
        ));
    }

    // Try to get target columns (table may not exist yet)
    let dst_cfg = crate::db::get_connection_config(target_connection_id)?;
    let dst_ds = if target_database.is_empty() {
        datasource::create_datasource(&dst_cfg).await?
    } else {
        datasource::create_datasource_with_db(&dst_cfg, &target_database).await?
    };
    let dst_cols = dst_ds.get_columns(&target_table, None).await.unwrap_or_default();

    // Build schema strings for prompt
    let src_schema_str = src_cols
        .iter()
        .map(|c| format!(
            "  {} {}{}{}",
            c.name,
            c.data_type,
            if c.is_primary_key { " PK" } else { "" },
            if !c.is_nullable { " NOT NULL" } else { "" }
        ))
        .collect::<Vec<_>>()
        .join("\n");

    let dst_schema_str = if dst_cols.is_empty() {
        format!(
            "Target table does not exist yet. Target database driver: {}. \
             Suggest appropriate target column names and types.",
            dst_cfg.driver
        )
    } else {
        dst_cols
            .iter()
            .map(|c| format!(
                "  {} {}{}{}",
                c.name,
                c.data_type,
                if c.is_primary_key { " PK" } else { "" },
                if !c.is_nullable { " NOT NULL" } else { "" }
            ))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let prompt = format!(
        "Generate column mappings for a data migration.\n\n\
         Source table: {source_table} (driver: {src_driver})\n{src_schema_str}\n\n\
         Target table: {target_table} (driver: {dst_driver})\n{dst_schema_str}\n\n\
         Return a JSON array of objects with fields: sourceExpr, targetCol, targetType.\n\
         Each object maps one source column expression to a target column.\n\
         Only return the JSON array, no markdown fences or explanation.",
        src_driver = src_cfg.driver,
        dst_driver = dst_cfg.driver,
    );

    let messages = vec![crate::llm::client::ChatMessage {
        role: "user".to_string(),
        content: prompt,
    }];
    let ai_result = llm_client.chat(messages).await?;

    // Extract the JSON array from the response
    let trimmed = ai_result.trim();
    let json_str = match (trimmed.find('['), trimmed.rfind(']')) {
        (Some(start), Some(end)) if end >= start => &trimmed[start..=end],
        _ => trimmed,
    };

    let mappings: Vec<ColumnMapping> = serde_json::from_str(json_str)
        .map_err(|e| AppError::Other(
            format!("Failed to parse AI response as column mappings: {}", e),
        ))?;

    Ok(mappings)
}
