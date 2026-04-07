use serde::{Deserialize, Serialize};

// ── Job Config (stored as config_json) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MigrationJobConfig {
    pub source: SourceConfig,
    pub column_mapping: Vec<ColumnMapping>,
    pub target: TargetConfig,
    pub pipeline: PipelineConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceConfig {
    pub connection_id: i64,
    pub query_mode: QueryMode,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueryMode { #[default] Auto, Custom }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColumnMapping {
    pub source_expr: String,
    pub target_col: String,
    pub target_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TargetConfig {
    pub connection_id: i64,
    pub table: String,
    pub conflict_strategy: ConflictStrategy,
    pub create_table_if_not_exists: bool,
    pub upsert_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConflictStrategy { #[default] Insert, Upsert, Replace, Skip }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    pub read_batch_size: usize,
    pub write_batch_size: usize,
    pub channel_capacity: usize,
    pub parallelism: usize,
    pub speed_limit_rps: Option<u64>,
    pub error_limit: usize,
    pub shard_count: Option<usize>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            read_batch_size: 10_000,
            write_batch_size: 1_000,
            channel_capacity: 16,
            parallelism: 1,
            speed_limit_rps: None,
            error_limit: 0,
            shard_count: None,
        }
    }
}

// ── DB Row types (returned to frontend) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationCategory {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationJob {
    pub id: i64,
    pub name: String,
    pub category_id: Option<i64>,
    pub config_json: String,
    pub last_status: Option<String>,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationRunHistory {
    pub id: i64,
    pub job_id: i64,
    pub run_id: String,
    pub status: String,
    pub rows_read: i64,
    pub rows_written: i64,
    pub rows_failed: i64,
    pub bytes_transferred: i64,
    pub duration_ms: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationDirtyRecord {
    pub id: i64,
    pub job_id: i64,
    pub run_id: String,
    pub row_index: Option<i64>,
    pub field_name: Option<String>,
    pub raw_value: Option<String>,
    pub error_msg: Option<String>,
    pub created_at: String,
}

// ── Stats event (broadcast every second) ────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct MigrationStatsEvent {
    pub job_id: i64,
    pub run_id: String,
    pub rows_read: u64,
    pub rows_written: u64,
    pub rows_failed: u64,
    pub bytes_transferred: u64,
    pub read_speed_rps: f64,
    pub write_speed_rps: f64,
    pub eta_seconds: Option<f64>,
    pub progress_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationLogEvent {
    pub job_id: i64,
    pub run_id: String,
    pub level: String,   // SYSTEM / PRECHECK / DDL / INFO / PROGRESS / WARN / ERROR / STATS
    pub message: String,
    pub timestamp: String,
}
