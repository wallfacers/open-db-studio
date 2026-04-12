use serde::{Deserialize, Serialize};

// ── Job Config (stored as config_json) ──────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrationJobConfig {
    pub sync_mode: SyncMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incremental_config: Option<IncrementalConfig>,
    pub source: SourceConfig,
    pub table_mappings: Vec<TableMapping>,
    pub pipeline: PipelineConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SyncMode {
    #[default]
    Full,
    Incremental,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalConfig {
    pub field: String,
    pub field_type: IncrementalFieldType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum IncrementalFieldType {
    #[default]
    Timestamp,
    Numeric,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    pub connection_id: i64,
    #[serde(default)]
    pub database: String,
    pub query_mode: QueryMode,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_query: Option<String>,
    /// Legacy field — kept for backward-compat deserialization only
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum QueryMode {
    #[default]
    Auto,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableMapping {
    pub source_table: String,
    pub target: TargetConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_condition: Option<String>,
    pub column_mappings: Vec<ColumnMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub source_expr: String,
    pub target_col: String,
    pub target_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetConfig {
    pub connection_id: i64,
    #[serde(default)]
    pub database: String,
    pub table: String,
    pub conflict_strategy: ConflictStrategy,
    pub create_if_not_exists: bool,
    #[serde(default)]
    pub upsert_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConflictStrategy {
    #[default]
    Insert,
    Upsert,
    Replace,
    Skip,
    /// Truncate the target table first, then plain INSERT (full overwrite)
    Overwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineConfig {
    pub read_batch_size: usize,
    pub write_batch_size: usize,
    pub channel_capacity: usize,
    pub parallelism: usize,
    pub speed_limit_rps: Option<u64>,
    pub error_limit: usize,
    pub shard_count: Option<usize>,
    /// Number of write batches to group into a single database transaction (COMMIT).
    /// Higher values reduce fsync count but increase memory usage and failure blast radius.
    /// Default: 3. Clamped to [1, 100].
    #[serde(default = "default_transaction_batch_size")]
    pub transaction_batch_size: usize,
    /// Optional cooldown (ms) between transaction commits, giving disk I/O breathing room.
    /// Default: None — no pause; set manually only if target disk is slow.
    #[serde(default = "default_write_pause_ms")]
    pub write_pause_ms: Option<u64>,
    /// Maximum bytes per transaction. Flush early when accumulated row bytes exceed this
    /// threshold, even if write_batch_size rows have not been reached.
    /// Default: Some(4MB) — matches DataX typical batch size, avoids 36MB redo log spikes.
    #[serde(default = "default_max_bytes_per_tx")]
    pub max_bytes_per_tx: Option<u64>,
    /// Maximum bytes allowed in the reader→writer channel at any time (byte-level backpressure).
    /// When the channel's in-flight data exceeds this limit, the reader blocks until the writer
    /// consumes messages. Mirrors DataX's `byteCapacity` (default 8MB).
    /// Default: Some(8MB). Set to None to disable byte gating (legacy behavior).
    #[serde(default = "default_byte_capacity")]
    pub byte_capacity: Option<u64>,
}

fn default_transaction_batch_size() -> usize {
    3
}

fn default_write_pause_ms() -> Option<u64> {
    None
}

fn default_max_bytes_per_tx() -> Option<u64> {
    Some(4 * 1024 * 1024)
}

fn default_byte_capacity() -> Option<u64> {
    Some(64 * 1024 * 1024) // 64 MB — increased for better throughput on home PCs
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            read_batch_size: 1_024,
            write_batch_size: 1_024,
            channel_capacity: 32,
            parallelism: 4,
            speed_limit_rps: None,
            error_limit: 0,
            shard_count: None,
            transaction_batch_size: 3,
            write_pause_ms: None,
            max_bytes_per_tx: Some(4 * 1024 * 1024),
            byte_capacity: Some(16 * 1024 * 1024),
        }
    }
}

// ── Backward-compatible deserialization ──────────────────────

/// Intermediate struct that accepts both old and new JSON formats.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawJobConfig {
    #[serde(default)]
    sync_mode: SyncMode,
    incremental_config: Option<IncrementalConfig>,
    source: serde_json::Value,
    #[serde(default)]
    table_mappings: Vec<TableMapping>,
    pipeline: PipelineConfig,
    // Legacy top-level fields
    target: Option<serde_json::Value>,
    column_mapping: Option<Vec<ColumnMapping>>,
}

impl<'de> Deserialize<'de> for MigrationJobConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawJobConfig::deserialize(deserializer)?;
        let source: SourceConfig =
            serde_json::from_value(raw.source).map_err(serde::de::Error::custom)?;

        let table_mappings = if !raw.table_mappings.is_empty() {
            raw.table_mappings
        } else if let Some(target_val) = raw.target {
            // Legacy format: top-level target + column_mapping → single TableMapping
            let legacy_target: LegacyTargetConfig =
                serde_json::from_value(target_val).map_err(serde::de::Error::custom)?;
            let column_mappings = raw.column_mapping.unwrap_or_default();
            vec![TableMapping {
                source_table: "custom_query".to_string(),
                target: TargetConfig {
                    connection_id: legacy_target.connection_id,
                    database: String::new(),
                    table: legacy_target.table,
                    conflict_strategy: legacy_target.conflict_strategy,
                    create_if_not_exists: legacy_target.create_table_if_not_exists,
                    upsert_keys: legacy_target.upsert_keys,
                },
                filter_condition: None,
                column_mappings,
            }]
        } else {
            Vec::new()
        };

        Ok(MigrationJobConfig {
            sync_mode: raw.sync_mode,
            incremental_config: raw.incremental_config,
            source,
            table_mappings,
            pipeline: raw.pipeline,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTargetConfig {
    connection_id: i64,
    table: String,
    conflict_strategy: ConflictStrategy,
    #[serde(default)]
    create_table_if_not_exists: bool,
    #[serde(default)]
    upsert_keys: Vec<String>,
}

// ── DB Row types (returned to frontend) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCategory {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
    pub created_at: String,
}

impl MigrationCategory {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationJob {
    pub id: i64,
    pub name: String,
    pub category_id: Option<i64>,
    pub script_text: String,
    pub last_status: Option<String>,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl MigrationJob {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            category_id: row.get(2)?,
            script_text: row.get(3)?,
            last_status: row.get(4)?,
            last_run_at: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub log_content: Option<String>,
}

impl MigrationRunHistory {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
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
            log_content: row.get(11)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

impl MigrationDirtyRecord {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            job_id: row.get(1)?,
            run_id: row.get(2)?,
            row_index: row.get(3)?,
            field_name: row.get(4)?,
            raw_value: row.get(5)?,
            error_msg: row.get(6)?,
            created_at: row.get(7)?,
        })
    }
}

// ── Stats event (broadcast every second) ────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatsEvent {
    pub job_id: i64,
    pub run_id: String,
    pub rows_read: u64,
    pub rows_written: u64,
    pub rows_failed: u64,
    pub bytes_transferred: u64,
    pub read_speed_rps: f64,
    pub write_speed_rps: f64,
    pub bytes_speed_bps: f64,  // 瞬时字节速度（字节/秒），每秒差分计算
    pub eta_seconds: Option<f64>,
    pub progress_pct: Option<f64>,
    pub current_mapping: Option<String>,
    pub mapping_progress: Option<MappingProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingProgress {
    pub total: usize,
    pub completed: usize,
    pub current: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationLogEvent {
    pub job_id: i64,
    pub run_id: String,
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

// ── Tests ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_new_config_format() {
        let json = r#"{
            "syncMode": "full",
            "source": {
                "connectionId": 1,
                "database": "mydb",
                "queryMode": "auto",
                "tables": ["users", "orders"],
                "customQuery": null
            },
            "tableMappings": [{
                "sourceTable": "users",
                "target": {
                    "connectionId": 2,
                    "database": "warehouse",
                    "table": "t_users",
                    "conflictStrategy": "INSERT",
                    "createIfNotExists": false,
                    "upsertKeys": []
                },
                "filterCondition": null,
                "columnMappings": [
                    {"sourceExpr": "id", "targetCol": "id", "targetType": "BIGINT"}
                ]
            }],
            "pipeline": {
                "readBatchSize": 10000,
                "writeBatchSize": 1000,
                "channelCapacity": 16,
                "parallelism": 1,
                "speedLimitRps": null,
                "errorLimit": 0,
                "shardCount": null
            }
        }"#;
        let config: MigrationJobConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.sync_mode, SyncMode::Full);
        assert_eq!(config.table_mappings.len(), 1);
        assert_eq!(config.table_mappings[0].source_table, "users");
        assert_eq!(config.table_mappings[0].target.database, "warehouse");
        assert_eq!(config.source.tables.len(), 2);
    }

    #[test]
    fn test_deserialize_old_config_format() {
        let json = r#"{
            "source": {"connectionId": 1, "queryMode": "auto", "query": "SELECT * FROM users"},
            "columnMapping": [{"sourceExpr": "id", "targetCol": "id", "targetType": "INT"}],
            "target": {"connectionId": 2, "table": "t_users", "conflictStrategy": "INSERT", "createTableIfNotExists": false, "upsertKeys": []},
            "pipeline": {"readBatchSize": 10000, "writeBatchSize": 1000, "channelCapacity": 16, "parallelism": 1, "speedLimitRps": null, "errorLimit": 0, "shardCount": null}
        }"#;
        let config: MigrationJobConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.sync_mode, SyncMode::Full);
        assert_eq!(config.table_mappings.len(), 1);
        assert_eq!(config.table_mappings[0].target.table, "t_users");
        assert_eq!(config.table_mappings[0].column_mappings.len(), 1);
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = MigrationJobConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: MigrationJobConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sync_mode, SyncMode::Full);
        assert!(parsed.table_mappings.is_empty());
    }
}
