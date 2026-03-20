#![allow(dead_code)]

use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MigrationStatus {
    Pending,
    Running,
    Paused,
    Done,
    Failed,
}

impl std::fmt::Display for MigrationStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Paused => write!(f, "paused"),
            Self::Done => write!(f, "done"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationTableConfig {
    pub src_table: String,
    pub dst_table: String,
    pub type_overrides: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationConfig {
    pub tables: Vec<MigrationTableConfig>,
    pub batch_size: usize,
    pub skip_errors: bool,
}

impl Default for MigrationConfig {
    fn default() -> Self {
        Self { tables: vec![], batch_size: 500, skip_errors: true }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationProgress {
    pub task_id: i64,
    pub current_table: String,
    pub done_rows: i64,
    pub total_rows: i64,
    pub error_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationTask {
    pub id: i64,
    pub name: String,
    pub src_connection_id: i64,
    pub dst_connection_id: i64,
    pub config: MigrationConfig,
    pub status: MigrationStatus,
    pub progress: Option<MigrationProgress>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_task(
    name: &str,
    src_connection_id: i64,
    dst_connection_id: i64,
    config: &MigrationConfig,
) -> AppResult<MigrationTask> {
    let conn = crate::db::get().lock().unwrap();
    let config_json = serde_json::to_string(config)
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO migration_tasks (name, src_connection_id, dst_connection_id, config, status)
         VALUES (?1, ?2, ?3, ?4, 'pending')",
        rusqlite::params![name, src_connection_id, dst_connection_id, config_json],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    get_task(id)
}

pub fn get_task(id: i64) -> AppResult<MigrationTask> {
    let conn = crate::db::get().lock().unwrap();
    conn.query_row(
        "SELECT id,name,src_connection_id,dst_connection_id,config,status,progress,created_at,updated_at
         FROM migration_tasks WHERE id=?1",
        [id],
        |row| {
            let config_str: String = row.get(4)?;
            let status_str: String = row.get(5)?;
            let progress_str: Option<String> = row.get(6)?;
            Ok(MigrationTask {
                id: row.get(0)?,
                name: row.get(1)?,
                src_connection_id: row.get(2)?,
                dst_connection_id: row.get(3)?,
                config: serde_json::from_str(&config_str).unwrap_or_default(),
                status: match status_str.as_str() {
                    "running" => MigrationStatus::Running,
                    "paused" => MigrationStatus::Paused,
                    "done" => MigrationStatus::Done,
                    "failed" => MigrationStatus::Failed,
                    _ => MigrationStatus::Pending,
                },
                progress: progress_str.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }
    ).map_err(Into::into)
}

pub fn list_tasks() -> AppResult<Vec<MigrationTask>> {
    let ids: Vec<i64> = {
        let conn = crate::db::get().lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id FROM migration_tasks ORDER BY created_at DESC LIMIT 100"
        )?;
        let result = stmt.query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        result
    };
    ids.iter().map(|&id| get_task(id)).collect()
}

pub fn set_status(id: i64, status: &MigrationStatus) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE migration_tasks SET status=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, status.to_string()],
    )?;
    Ok(())
}

pub fn save_progress(id: i64, progress: &MigrationProgress) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let json = serde_json::to_string(progress)
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE migration_tasks SET progress=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, json],
    )?;
    Ok(())
}

pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    let task = get_task(task_id)?;
    set_status(task_id, &MigrationStatus::Running)?;

    let mut any_error = false;
    for table_cfg in &task.config.tables {
        // 检查是否已暂停
        if get_task(task_id)?.status == MigrationStatus::Paused {
            return Ok(());
        }

        match super::data_pump::pump_table(
            task_id,
            task.src_connection_id,
            task.dst_connection_id,
            &table_cfg.src_table,
            &table_cfg.dst_table,
            task.config.batch_size,
            task.config.skip_errors,
            &app_handle,
        ).await {
            Ok(p) => log::info!("[migration] table {} done: {}/{}", table_cfg.src_table, p.done_rows, p.total_rows),
            Err(e) => {
                log::error!("[migration] table {} failed: {}", table_cfg.src_table, e);
                if !task.config.skip_errors {
                    set_status(task_id, &MigrationStatus::Failed)?;
                    return Err(e);
                }
                any_error = true;
            }
        }
    }

    set_status(task_id, if any_error { &MigrationStatus::Failed } else { &MigrationStatus::Done })?;
    Ok(())
}

pub fn pause_migration(task_id: i64) -> AppResult<()> {
    set_status(task_id, &MigrationStatus::Paused)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_display() {
        assert_eq!(MigrationStatus::Running.to_string(), "running");
        assert_eq!(MigrationStatus::Done.to_string(), "done");
        assert_eq!(MigrationStatus::Paused.to_string(), "paused");
        assert_eq!(MigrationStatus::Failed.to_string(), "failed");
        assert_eq!(MigrationStatus::Pending.to_string(), "pending");
    }

    #[test]
    fn test_config_serialization() {
        let cfg = MigrationConfig {
            tables: vec![MigrationTableConfig {
                src_table: "orders".into(),
                dst_table: "orders".into(),
                type_overrides: None,
            }],
            batch_size: 100,
            skip_errors: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let restored: MigrationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.batch_size, 100);
        assert_eq!(restored.tables[0].src_table, "orders");
    }
}
