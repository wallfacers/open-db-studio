# Migration Table Mapping & Incremental Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the migration center with multi-table mapping (1:1, N:1, 1:N with condition routing), target database selection, DataX-style incremental sync, and AI-powered column mapping — all backed by a structured, AI-friendly config model.

**Architecture:** Refactor `MigrationJobConfig` from single-source/single-target to a `tableMappings[]` array where each entry pairs a source table with a target (connection + database + table + column mappings). The pipeline orchestrator loops over mappings sequentially. Incremental sync appends WHERE conditions based on stored checkpoint values.

**Tech Stack:** Rust (Tauri 2.x, rusqlite, serde), React 18 + TypeScript, Zustand, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-09-migration-table-mapping-design.md`

---

## File Map

### Files to modify

| File | Responsibility | Changes |
|------|---------------|---------|
| `src-tauri/src/migration/task_mgr.rs` | Data models | Replace config structs with new schema; add backward-compat deserializer |
| `src-tauri/src/migration/pipeline.rs` | ETL engine | Refactor to orchestration loop over `tableMappings`; add incremental WHERE; add auto-create-table |
| `src-tauri/src/migration/mig_commands.rs` | Tauri commands | Add `ai_recommend_column_mappings` command |
| `src-tauri/src/migration/precheck.rs` | Pre-checks | Update to iterate `tableMappings` |
| `src-tauri/src/migration/repository.rs` | DB access | Add config migration helper |
| `src-tauri/src/lib.rs` | Handler registration | Register new command |
| `schema/init.sql` | SQLite DDL | Add `PARTIAL_FAILED` to CHECK constraints |
| `src/components/MigrationJobTab/ConfigTab.tsx` | Config UI | Full rewrite: sync mode, table mapping panel, column mapping subpanel |
| `src/store/migrationStore.ts` | Zustand store | Extend `MigrationStatsEvent` with `mappingProgress` |
| `src/components/MigrationJobTab/LogTab.tsx` | Log display | Show mapping progress prefix |

### Files to create

| File | Responsibility |
|------|---------------|
| `src/components/MigrationJobTab/TableMappingPanel.tsx` | Table mapping grid (source→target rows, dropdown actions) |
| `src/components/MigrationJobTab/ColumnMappingPanel.tsx` | Inline-expand column mapping subpanel per mapping row |
| `src/components/MigrationJobTab/SyncModeSection.tsx` | Sync mode selector + incremental config |

---

## Task 1: Refactor Rust Data Model (`task_mgr.rs`)

**Files:**
- Modify: `src-tauri/src/migration/task_mgr.rs`

- [ ] **Step 1: Write test for backward-compatible deserialization**

Add at the bottom of `task_mgr.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib migration::task_mgr::tests -v`
Expected: FAIL — new types don't exist yet.

- [ ] **Step 3: Replace the config structs**

Replace the entire contents of `task_mgr.rs` (lines 1–205) with the new data model. Key changes:
- `MigrationJobConfig` gains `sync_mode`, `incremental_config`, `table_mappings`; loses top-level `target` and `column_mapping`
- New types: `SyncMode`, `IncrementalConfig`, `IncrementalFieldType`, `TableMapping`
- `SourceConfig` gains `database`, `tables`, `custom_query`; loses `query`
- `TargetConfig` gains `database`
- `ColumnMapping` field names change from `source_expr`/`target_col`/`target_type` to use `#[serde(rename_all = "camelCase")]`
- `MigrationStatsEvent` gains `current_mapping` and `mapping_progress`
- Custom `Deserialize` impl on `MigrationJobConfig` for backward compat

Full replacement for `task_mgr.rs`:

```rust
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
            serde_json::from_value(raw.source.clone()).map_err(serde::de::Error::custom)?;

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
    pub config_json: String,
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
            config_json: row.get(3)?,
            last_status: row.get(4)?,
            last_run_at: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }
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
        })
    }
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
// (tests from Step 1 go here)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib migration::task_mgr::tests -v`
Expected: All 3 tests PASS.

- [ ] **Step 5: Run cargo check to verify no compilation errors in dependent modules**

Run: `cd src-tauri && cargo check 2>&1 | head -50`
Expected: Compilation errors in `pipeline.rs`, `mig_commands.rs`, `precheck.rs`, `repository.rs` — these reference old field names. This is expected; we fix them in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/migration/task_mgr.rs
git commit -m "refactor(migration): replace config model with table-mapping based schema

New MigrationJobConfig supports tableMappings[], syncMode, incrementalConfig.
Custom deserializer handles backward-compat with old single-target format."
```

---

## Task 2: Update Repository & SQLite Schema

**Files:**
- Modify: `src-tauri/src/migration/repository.rs`
- Modify: `schema/init.sql`

- [ ] **Step 1: Update `init.sql` CHECK constraints**

In `schema/init.sql`, find the `migration_jobs` table and update `last_status` CHECK:

```sql
-- Old:
last_status TEXT CHECK(last_status IN ('RUNNING','FINISHED','FAILED','STOPPED')),
-- New:
last_status TEXT CHECK(last_status IN ('RUNNING','FINISHED','FAILED','STOPPED','PARTIAL_FAILED')),
```

Also update `migration_run_history.status` CHECK:

```sql
-- Old:
status TEXT NOT NULL CHECK(status IN ('RUNNING','FINISHED','FAILED','STOPPED')),
-- New:
status TEXT NOT NULL CHECK(status IN ('RUNNING','FINISHED','FAILED','STOPPED','PARTIAL_FAILED')),
```

- [ ] **Step 2: Update `repository.rs` — update_job_config validation**

The `update_job_config` function validates by deserializing. Since the new `MigrationJobConfig` has a custom deserializer that handles both formats, no change is needed. But we need to add a migration function for upgrading old configs.

Add to `repository.rs`:

```rust
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
```

- [ ] **Step 3: Call migration at app startup**

In `src-tauri/src/lib.rs`, find where the database is initialized (look for `db::init` or similar setup), and add after it:

```rust
migration::repository::migrate_legacy_configs().ok();
```

- [ ] **Step 4: Run cargo check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`
Expected: Still errors from `pipeline.rs` and `precheck.rs` (fixed in next tasks), but `repository.rs` compiles clean.

- [ ] **Step 5: Commit**

```bash
git add schema/init.sql src-tauri/src/migration/repository.rs src-tauri/src/lib.rs
git commit -m "feat(migration): add PARTIAL_FAILED status and legacy config migration"
```

---

## Task 3: Refactor Pipeline Orchestration (`pipeline.rs`)

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs`

This is the largest backend change. The pipeline must go from executing a single source query against a single target to looping over `tableMappings`.

- [ ] **Step 1: Refactor `execute_pipeline` to orchestration loop**

Replace the `execute_pipeline` function body. The new structure:

1. Parse config, iterate `table_mappings`
2. For each mapping: build source SQL, optionally create target table, run reader→writer sub-pipeline
3. Track per-mapping stats, aggregate to job level
4. Handle `PARTIAL_FAILED` when some mappings fail

Key code changes in `pipeline.rs`:

The existing `execute_pipeline` function (starting around line 230) gets replaced. Here is the new structure:

```rust
async fn execute_pipeline(
    job_id: i64,
    run_id: String,
    config: MigrationJobConfig,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
) -> AppResult<String> {
    let stats = PipelineStats::new();
    let start = Instant::now();
    let total_mappings = config.table_mappings.len();

    if total_mappings == 0 {
        return Err(AppError::Other("No table mappings configured".into()));
    }

    emit_log(&app, job_id, &run_id, "SYSTEM",
        &format!("Pipeline started: {} table mapping(s)", total_mappings));

    let mut completed = 0usize;
    let mut failed_mappings = Vec::new();

    for (idx, mapping) in config.table_mappings.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            emit_log(&app, job_id, &run_id, "SYSTEM", "Pipeline cancelled by user");
            return Err(AppError::Other("Cancelled".into()));
        }

        let mapping_label = format!("{}→{}", mapping.source_table, mapping.target.table);
        emit_log(&app, job_id, &run_id, "SYSTEM",
            &format!("[{}/{}] Starting: {}", idx + 1, total_mappings, mapping_label));

        match execute_single_mapping(
            job_id, &run_id, &config, mapping, &app, &cancel, &stats,
            idx, total_mappings,
        ).await {
            Ok(summary) => {
                completed += 1;
                emit_log(&app, job_id, &run_id, "SYSTEM",
                    &format!("[{}/{}] Completed: {} — {}", idx + 1, total_mappings, mapping_label, summary));
            }
            Err(e) => {
                failed_mappings.push(mapping_label.clone());
                emit_log(&app, job_id, &run_id, "ERROR",
                    &format!("[{}/{}] Failed: {} — {}", idx + 1, total_mappings, mapping_label, e));
            }
        }
    }

    // Write back incremental lastValue if applicable
    if config.sync_mode == SyncMode::Incremental {
        writeback_incremental_checkpoint(job_id, &config, &app, &run_id).await;
    }

    let elapsed = start.elapsed().as_secs_f64();
    let rows_written = stats.rows_written.load(Ordering::Relaxed);
    let rows_failed = stats.rows_failed.load(Ordering::Relaxed);

    if failed_mappings.is_empty() {
        Ok(format!("rows_written={} rows_failed={} elapsed={:.2}s", rows_written, rows_failed, elapsed))
    } else if completed > 0 {
        // Return Ok but mark as PARTIAL_FAILED in the caller
        Err(AppError::Other(format!(
            "PARTIAL_FAILED: {}/{} succeeded, failed=[{}] rows_written={} elapsed={:.2}s",
            completed, total_mappings, failed_mappings.join(", "), rows_written, elapsed
        )))
    } else {
        Err(AppError::Other(format!(
            "All {} mapping(s) failed: [{}]",
            total_mappings, failed_mappings.join(", ")
        )))
    }
}
```

- [ ] **Step 2: Extract single-mapping execution**

Add the `execute_single_mapping` function. This is essentially the old `execute_pipeline` body adapted to work on one `TableMapping`:

```rust
async fn execute_single_mapping(
    job_id: i64,
    run_id: &str,
    config: &MigrationJobConfig,
    mapping: &TableMapping,
    app: &AppHandle,
    cancel: &Arc<AtomicBool>,
    global_stats: &Arc<PipelineStats>,
    mapping_idx: usize,
    total_mappings: usize,
) -> AppResult<String> {
    let mapping_label = format!("{}→{}", mapping.source_table, mapping.target.table);

    // ── Build source SQL ──────────────────────────────────────
    let source_query = build_source_query(config, mapping)?;
    emit_log(app, job_id, run_id, "SYSTEM",
        &format!("[{}] Source SQL: {}", mapping_label,
            if source_query.len() > 200 { &source_query[..200] } else { &source_query }));

    // ── Resolve source datasource ─────────────────────────────
    let src_conn_id = config.source.connection_id;
    let src_cfg = crate::db::get_connection_config(src_conn_id)?;
    let src_ds = crate::datasource::pool_cache::get_or_create(
        src_conn_id, &src_cfg,
        if config.source.database.is_empty() { src_cfg.database.as_deref().unwrap_or("") } else { &config.source.database },
        "",
    ).await?;

    // ── Resolve target datasource ─────────────────────────────
    let dst_conn_id = mapping.target.connection_id;
    let dst_cfg = crate::db::get_connection_config(dst_conn_id)?;
    let dst_ds = crate::datasource::pool_cache::get_or_create(
        dst_conn_id, &dst_cfg,
        if mapping.target.database.is_empty() { dst_cfg.database.as_deref().unwrap_or("") } else { &mapping.target.database },
        "",
    ).await?;

    // ── Auto-create table if needed ───────────────────────────
    if mapping.target.create_if_not_exists {
        auto_create_target_table(
            &*src_ds, &*dst_ds, &src_cfg.driver, &dst_cfg.driver,
            &mapping.source_table, &mapping.target.table,
            &mapping.column_mappings, app, job_id, run_id, &mapping_label,
        ).await?;
    }

    // ── Estimate row count ────────────────────────────────────
    let total_rows: Option<u64> = {
        let count_sql = format!("SELECT COUNT(*) FROM ({}) AS _mig_count_", source_query);
        match src_ds.execute(&count_sql).await {
            Ok(result) => result.rows.first()
                .and_then(|r| r.first())
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64))),
            Err(_) => None,
        }
    };

    // ── Run reader → writer pipeline (reuse existing channel logic) ──
    let target_table = mapping.target.table.clone();
    let dst_driver = dst_cfg.driver.clone();
    let column_mapping = mapping.column_mappings.clone();
    let conflict_strategy = mapping.target.conflict_strategy.clone();
    let error_limit = config.pipeline.error_limit;
    let read_batch_size = config.pipeline.read_batch_size.max(1);
    let write_batch_size = config.pipeline.write_batch_size.max(1);
    let channel_cap = config.pipeline.channel_capacity.max(1);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Batch>(channel_cap);

    // Stats broadcaster for this mapping
    let mapping_stats = PipelineStats::new();
    let ms_clone = mapping_stats.clone();
    let app_stats = app.clone();
    let run_id_s = run_id.to_string();
    let cancel_s = cancel.clone();
    let gs = global_stats.clone();
    let ml = mapping_label.clone();
    let stats_handle = tokio::spawn(async move {
        let mut prev_read = 0u64;
        let mut prev_written = 0u64;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if cancel_s.load(Ordering::Relaxed) { break; }
            let rows_read = ms_clone.rows_read.load(Ordering::Relaxed);
            let rows_written = ms_clone.rows_written.load(Ordering::Relaxed);
            let delta_read = rows_read.saturating_sub(prev_read) as f64;
            let delta_written = rows_written.saturating_sub(prev_written) as f64;
            let (eta, pct) = if let Some(total) = total_rows {
                if rows_read < total {
                    let elapsed = rows_read as f64; // simplified
                    let rps = delta_read.max(1.0);
                    let eta_secs = (total - rows_read) as f64 / rps;
                    (Some(eta_secs), Some((rows_read as f64 / total as f64 * 100.0).min(100.0)))
                } else { (Some(0.0), Some(100.0)) }
            } else { (None, None) };

            let event = MigrationStatsEvent {
                job_id,
                run_id: run_id_s.clone(),
                rows_read: gs.rows_read.load(Ordering::Relaxed),
                rows_written: gs.rows_written.load(Ordering::Relaxed),
                rows_failed: gs.rows_failed.load(Ordering::Relaxed),
                bytes_transferred: gs.bytes_transferred.load(Ordering::Relaxed),
                read_speed_rps: delta_read,
                write_speed_rps: delta_written,
                eta_seconds: eta,
                progress_pct: pct,
                current_mapping: Some(ml.clone()),
                mapping_progress: Some(MappingProgress {
                    total: total_mappings,
                    completed: mapping_idx,
                    current: mapping_idx + 1,
                }),
            };
            let _ = app_stats.emit(MIGRATION_STATS_EVENT, &event);
            prev_read = rows_read;
            prev_written = rows_written;
        }
    });

    // Reader
    let ms_reader = mapping_stats.clone();
    let gs_reader = global_stats.clone();
    let app_reader = app.clone();
    let run_id_r = run_id.to_string();
    let cancel_r = cancel.clone();
    let query = source_query.clone();
    let ml_r = mapping_label.clone();
    let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let mut offset = 0usize;
        let mut columns_opt: Option<Vec<String>> = None;
        loop {
            if cancel_r.load(Ordering::Relaxed) { break; }
            let page = src_ds.execute_paginated(&query, read_batch_size, offset).await?;
            if page.rows.is_empty() { break; }
            let fetched = page.rows.len();
            if columns_opt.is_none() {
                columns_opt = Some(page.columns.clone());
                emit_log(&app_reader, job_id, &run_id_r, "SYSTEM",
                    &format!("[{}] Columns: {}", ml_r, page.columns.join(", ")));
            }
            for row in &page.rows {
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
            }
            ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            let batch = Batch { rows: page.rows, column_names: columns_opt.as_ref().unwrap().clone() };
            if tx.send(batch).await.is_err() { break; }
            if fetched < read_batch_size { break; }
            offset += fetched;
        }
        Ok(())
    });

    // Writer (same logic as existing, but uses mapping-level column_mapping and target)
    let ms_writer = mapping_stats.clone();
    let gs_writer = global_stats.clone();
    let app_writer = app.clone();
    let run_id_w = run_id.to_string();
    let cancel_w = cancel.clone();
    let ml_w = mapping_label.clone();
    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let mut error_count = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_columns: Vec<String> = Vec::new();
        let mapped_cols: Option<Vec<String>> = if !column_mapping.is_empty() {
            Some(column_mapping.iter().map(|m| m.target_col.clone()).collect())
        } else { None };

        while let Some(batch) = rx.recv().await {
            if cancel_w.load(Ordering::Relaxed) { break; }
            if buf_columns.is_empty() {
                buf_columns = mapped_cols.clone().unwrap_or_else(|| batch.column_names.clone());
            }
            for row in batch.rows {
                write_buf.push(row);
                if write_buf.len() >= write_batch_size {
                    let rows_to_write = std::mem::replace(&mut write_buf, Vec::with_capacity(write_batch_size));
                    match write_batch(&*dst_ds, &target_table, &buf_columns, &rows_to_write, &conflict_strategy, &dst_driver).await {
                        Ok(n) => {
                            ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                &format!("[{}] Write error: {}", ml_w, e));
                            let cnt = rows_to_write.len() as u64;
                            ms_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                            error_count += rows_to_write.len();
                            if error_limit > 0 && error_count >= error_limit {
                                return Err(e);
                            }
                        }
                    }
                }
            }
        }
        // Flush remainder
        if !write_buf.is_empty() {
            match write_batch(&*dst_ds, &target_table, &buf_columns, &write_buf, &conflict_strategy, &dst_driver).await {
                Ok(n) => {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    let cnt = write_buf.len() as u64;
                    ms_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                        &format!("[{}] Final flush error: {}", ml_w, e));
                }
            }
        }
        Ok(())
    });

    let reader_result = reader_handle.await;
    let writer_result = writer_handle.await;
    stats_handle.abort();

    // Check results
    if let Err(e) = &reader_result { return Err(AppError::Other(format!("Reader panicked: {}", e))); }
    if let Err(e) = &writer_result { return Err(AppError::Other(format!("Writer panicked: {}", e))); }
    if let Ok(Err(e)) = reader_result { return Err(e); }
    if let Ok(Err(e)) = writer_result { return Err(e); }

    let written = mapping_stats.rows_written.load(Ordering::Relaxed);
    let failed = mapping_stats.rows_failed.load(Ordering::Relaxed);
    Ok(format!("written={} failed={}", written, failed))
}
```

- [ ] **Step 3: Add `build_source_query` helper**

```rust
fn build_source_query(config: &MigrationJobConfig, mapping: &TableMapping) -> AppResult<String> {
    let base_query = if config.source.query_mode == QueryMode::Custom {
        config.source.custom_query.clone()
            .unwrap_or_default()
    } else {
        format!("SELECT * FROM {}", mapping.source_table)
    };

    if base_query.trim().is_empty() {
        return Err(AppError::Other(format!(
            "Empty source query for mapping {}→{}", mapping.source_table, mapping.target.table
        )));
    }

    let mut conditions = Vec::new();

    // Incremental WHERE
    if config.sync_mode == SyncMode::Incremental {
        if let Some(ref inc) = config.incremental_config {
            if let Some(ref last_val) = inc.last_value {
                if !last_val.is_empty() {
                    match inc.field_type {
                        IncrementalFieldType::Timestamp => {
                            conditions.push(format!("{} > '{}'", inc.field, last_val));
                        }
                        IncrementalFieldType::Numeric => {
                            conditions.push(format!("{} > {}", inc.field, last_val));
                        }
                    }
                }
            }
        }
    }

    // Filter condition (for 1:N routing)
    if let Some(ref filter) = mapping.filter_condition {
        if !filter.trim().is_empty() {
            conditions.push(filter.clone());
        }
    }

    if conditions.is_empty() {
        Ok(base_query)
    } else {
        // Wrap base query and add WHERE conditions
        Ok(format!("SELECT * FROM ({}) AS _mig_src_ WHERE {}",
            base_query, conditions.join(" AND ")))
    }
}
```

- [ ] **Step 4: Add `auto_create_target_table` helper**

```rust
async fn auto_create_target_table(
    src_ds: &dyn crate::datasource::DataSource,
    dst_ds: &dyn crate::datasource::DataSource,
    src_driver: &str,
    dst_driver: &str,
    source_table: &str,
    target_table: &str,
    column_mappings: &[ColumnMapping],
    app: &AppHandle,
    job_id: i64,
    run_id: &str,
    mapping_label: &str,
) -> AppResult<()> {
    let columns = src_ds.get_columns(source_table, None).await?;
    if columns.is_empty() {
        emit_log(app, job_id, run_id, "WARN",
            &format!("[{}] Cannot auto-create: source table schema unavailable", mapping_label));
        return Ok(());
    }

    // Build type overrides from column_mappings
    let type_overrides: std::collections::HashMap<String, String> = column_mappings.iter()
        .filter(|m| !m.target_type.is_empty())
        .map(|m| (m.source_expr.clone(), m.target_type.clone()))
        .collect();

    let ddl = super::ddl_convert::generate_create_table_ddl(
        src_driver, dst_driver, target_table, &columns, &type_overrides,
    );

    emit_log(app, job_id, run_id, "DDL",
        &format!("[{}] Auto-create DDL: {}", mapping_label,
            if ddl.len() > 300 { &ddl[..300] } else { &ddl }));

    dst_ds.execute(&ddl).await?;
    Ok(())
}
```

- [ ] **Step 5: Add `writeback_incremental_checkpoint` helper**

```rust
async fn writeback_incremental_checkpoint(
    job_id: i64,
    config: &MigrationJobConfig,
    app: &AppHandle,
    run_id: &str,
) {
    if let Some(ref inc) = config.incremental_config {
        // Query the max value of the incremental field from source
        let src_conn_id = config.source.connection_id;
        let Ok(src_cfg) = crate::db::get_connection_config(src_conn_id) else { return };
        let Ok(src_ds) = crate::datasource::pool_cache::get_or_create(
            src_conn_id, &src_cfg,
            if config.source.database.is_empty() { src_cfg.database.as_deref().unwrap_or("") } else { &config.source.database },
            "",
        ).await else { return };

        // Get max value across all source tables
        for mapping in &config.table_mappings {
            let sql = format!("SELECT MAX({}) FROM {}", inc.field, mapping.source_table);
            if let Ok(result) = src_ds.execute(&sql).await {
                if let Some(max_val) = result.rows.first()
                    .and_then(|r| r.first())
                    .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| Some(v.to_string())))
                {
                    if max_val != "null" {
                        // Write back to config_json
                        let mut new_config = config.clone();
                        if let Some(ref mut ic) = new_config.incremental_config {
                            ic.last_value = Some(max_val.clone());
                        }
                        if let Ok(json) = serde_json::to_string(&new_config) {
                            let db = crate::db::get().lock().unwrap();
                            let _ = db.execute(
                                "UPDATE migration_jobs SET config_json=?1 WHERE id=?2",
                                rusqlite::params![json, job_id],
                            );
                        }
                        emit_log(app, job_id, run_id, "SYSTEM",
                            &format!("Incremental checkpoint updated: {} = {}", inc.field, max_val));
                        return; // Only need the max across all tables
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 6: Update `run_pipeline` — handle PARTIAL_FAILED status**

In the `tokio::spawn` block of `run_pipeline`, update the final status logic:

```rust
let final_status = match &result {
    Ok(_) => "FINISHED",
    Err(e) if e.to_string().starts_with("PARTIAL_FAILED") => "PARTIAL_FAILED",
    Err(_) => "FAILED",
};
```

- [ ] **Step 7: Remove old `emit_stats` calls from the top-level (they're now per-mapping)**

Update the `emit_stats` function signature to accept the new `MigrationStatsEvent` fields (current_mapping, mapping_progress). Or simply remove the old top-level stats broadcaster since each mapping now has its own.

- [ ] **Step 8: Run cargo check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`
Expected: Errors only from `precheck.rs` (which references `config.target`). Fix in next task.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): refactor pipeline to orchestrate over tableMappings

Each mapping runs its own reader→writer sub-pipeline sequentially.
Supports incremental WHERE conditions and auto-create target table.
PARTIAL_FAILED status when some mappings succeed and others fail."
```

---

## Task 4: Update Precheck for New Config

**Files:**
- Modify: `src-tauri/src/migration/precheck.rs`

- [ ] **Step 1: Update `run_precheck_for_job` to iterate `table_mappings`**

Replace the function body to loop over `config.table_mappings` instead of reading from `config.target.table`:

```rust
pub async fn run_precheck_for_job(
    job_id: i64,
    config: &super::task_mgr::MigrationJobConfig,
) -> AppResult<PreCheckResult> {
    let src_connection_id = config.source.connection_id;
    let src_config = crate::db::get_connection_config(src_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;

    let mut all_items = Vec::new();

    for mapping in &config.table_mappings {
        let dst_config = crate::db::get_connection_config(mapping.target.connection_id)?;
        let table_name = &mapping.source_table;
        if table_name.is_empty() || table_name == "custom_query" {
            continue;
        }

        let src_cols = src_ds.get_columns(table_name, None).await.unwrap_or_default();
        if src_cols.is_empty() {
            all_items.push(CheckItem {
                check_type: "other".into(),
                table_name: table_name.clone(),
                column_name: None,
                severity: "error".into(),
                message: format!("Source table {} not found or has no columns", table_name),
            });
            continue;
        }

        let type_issues = super::ddl_convert::check_type_compatibility(
            &src_config.driver, &dst_config.driver, table_name, &src_cols,
        );
        all_items.extend(type_issues);

        for col in &src_cols {
            if !col.is_nullable && col.column_default.is_none() && !col.is_primary_key {
                all_items.push(CheckItem {
                    check_type: "null_constraint".into(),
                    table_name: table_name.clone(),
                    column_name: Some(col.name.clone()),
                    severity: "info".into(),
                    message: format!("Column {} is NOT NULL without default", col.name),
                });
            }
        }

        let has_pk = src_cols.iter().any(|c| c.is_primary_key);
        if !has_pk {
            all_items.push(CheckItem {
                check_type: "pk_conflict".into(),
                table_name: table_name.clone(),
                column_name: None,
                severity: "warning".into(),
                message: "Source table has no primary key, duplicates may occur".into(),
            });
        }
    }

    save_check_items(job_id, &all_items)?;
    let has_errors = all_items.iter().any(|i| i.severity == "error");
    let has_warnings = all_items.iter().any(|i| i.severity == "warning");
    Ok(PreCheckResult { job_id, items: all_items, has_errors, has_warnings })
}
```

- [ ] **Step 2: Run cargo check — full project should compile**

Run: `cd src-tauri && cargo check`
Expected: PASS — all Rust compilation errors resolved.

- [ ] **Step 3: Run existing tests**

Run: `cd src-tauri && cargo test --lib`
Expected: All tests pass (task_mgr tests, ddl_convert tests, precheck tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/precheck.rs
git commit -m "fix(migration): update precheck to iterate tableMappings"
```

---

## Task 5: Add AI Column Mapping Command

**Files:**
- Modify: `src-tauri/src/migration/mig_commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the Tauri command**

In `mig_commands.rs`, add at the end:

```rust
// ── AI Column Mapping ──────────────────────────────────────────

#[tauri::command]
pub async fn ai_recommend_column_mappings(
    source_connection_id: i64,
    source_database: String,
    source_table: String,
    target_connection_id: i64,
    target_database: String,
    target_table: String,
    app: tauri::AppHandle,
) -> AppResult<Vec<super::task_mgr::ColumnMapping>> {
    use crate::datasource;

    // Get source columns
    let src_cfg = crate::db::get_connection_config(source_connection_id)?;
    let src_ds = if source_database.is_empty() {
        datasource::create_datasource(&src_cfg).await?
    } else {
        datasource::create_datasource_with_db(&src_cfg, &source_database).await?
    };
    let src_cols = src_ds.get_columns(&source_table, None).await?;

    if src_cols.is_empty() {
        return Err(crate::error::AppError::Other(
            format!("Source table {} has no columns", source_table),
        ));
    }

    // Try to get target columns (may not exist yet)
    let dst_cfg = crate::db::get_connection_config(target_connection_id)?;
    let dst_ds = if target_database.is_empty() {
        datasource::create_datasource(&dst_cfg).await?
    } else {
        datasource::create_datasource_with_db(&dst_cfg, &target_database).await?
    };
    let dst_cols = dst_ds.get_columns(&target_table, None).await.unwrap_or_default();

    // Build prompt
    let src_schema_str = src_cols.iter()
        .map(|c| format!("  {} {} {}{}", c.name, c.data_type,
            if c.is_primary_key { " PK" } else { "" },
            if !c.is_nullable { " NOT NULL" } else { "" }))
        .collect::<Vec<_>>().join("\n");

    let dst_schema_str = if dst_cols.is_empty() {
        format!("Target table does not exist yet. Target database driver: {}. Suggest appropriate target column names and types.", dst_cfg.driver)
    } else {
        dst_cols.iter()
            .map(|c| format!("  {} {} {}{}", c.name, c.data_type,
                if c.is_primary_key { " PK" } else { "" },
                if !c.is_nullable { " NOT NULL" } else { "" }))
            .collect::<Vec<_>>().join("\n")
    };

    let prompt = format!(
        "Generate column mappings for a data migration.\n\n\
         Source table: {source_table} (driver: {src_driver})\n{src_schema_str}\n\n\
         Target table: {target_table} (driver: {dst_driver})\n{dst_schema_str}\n\n\
         Return a JSON array of objects with fields: sourceExpr, targetCol, targetType.\n\
         Only return the JSON array, no markdown or explanation.",
        src_driver = src_cfg.driver,
        dst_driver = dst_cfg.driver,
    );

    // Call AI
    let ai_result = crate::llm::client::ai_request(&app, &prompt).await?;

    // Parse response — extract JSON array
    let trimmed = ai_result.trim();
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            &trimmed[start..=end]
        } else { trimmed }
    } else { trimmed };

    let mappings: Vec<super::task_mgr::ColumnMapping> = serde_json::from_str(json_str)
        .map_err(|e| crate::error::AppError::Other(
            format!("Failed to parse AI response as column mappings: {}", e),
        ))?;

    Ok(mappings)
}
```

- [ ] **Step 2: Register in `lib.rs`**

In `lib.rs`, add to the `generate_handler![]` macro, after the existing migration commands:

```rust
migration::mig_commands::ai_recommend_column_mappings,
```

- [ ] **Step 3: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: PASS. (Note: `ai_request` function must exist in `llm::client`. If it doesn't match this exact signature, adapt the call. Check with `grep -n "pub async fn ai_request" src-tauri/src/llm/client.rs`.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/mig_commands.rs src-tauri/src/lib.rs
git commit -m "feat(migration): add ai_recommend_column_mappings command"
```

---

## Task 6: Frontend Types & Store Update

**Files:**
- Modify: `src/store/migrationStore.ts`

- [ ] **Step 1: Update `MigrationStatsEvent` interface**

In `migrationStore.ts`, update the `MigrationStatsEvent` interface (around line 52):

```typescript
export interface MigrationStatsEvent {
  jobId: number
  runId: string
  rowsRead: number
  rowsWritten: number
  rowsFailed: number
  bytesTransferred: number
  readSpeedRps: number
  writeSpeedRps: number
  etaSeconds: number | null
  progressPct: number | null
  currentMapping: string | null
  mappingProgress: { total: number; completed: number; current: number } | null
}
```

- [ ] **Step 2: Update `MigrationJob.lastStatus` to include `PARTIAL_FAILED`**

```typescript
export interface MigrationJob {
  // ...
  lastStatus: 'RUNNING' | 'FINISHED' | 'FAILED' | 'STOPPED' | 'PARTIAL_FAILED' | null
  // ...
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors in ConfigTab.tsx (because we haven't updated it yet). Store file itself should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/store/migrationStore.ts
git commit -m "feat(migration): extend store types for mapping progress and PARTIAL_FAILED"
```

---

## Task 7: SyncModeSection Component

**Files:**
- Create: `src/components/MigrationJobTab/SyncModeSection.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useTranslation } from 'react-i18next'
import { DropdownSelect } from '../common/DropdownSelect'

interface IncrementalConfig {
  field: string
  fieldType: 'timestamp' | 'numeric'
  lastValue?: string
}

interface Props {
  syncMode: 'full' | 'incremental'
  incrementalConfig?: IncrementalConfig
  onChange: (syncMode: 'full' | 'incremental', incrementalConfig?: IncrementalConfig) => void
}

export function SyncModeSection({ syncMode, incrementalConfig, onChange }: Props) {
  const { t } = useTranslation()

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  return (
    <div className="bg-background-panel border border-border-subtle rounded p-3">
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.syncMode')}</span>
        <DropdownSelect
          value={syncMode}
          onChange={val => {
            const mode = val as 'full' | 'incremental'
            onChange(mode, mode === 'incremental'
              ? (incrementalConfig ?? { field: '', fieldType: 'timestamp' })
              : undefined)
          }}
          options={[
            { value: 'full', label: t('migration.fullSync') },
            { value: 'incremental', label: t('migration.incrementalSync') },
          ]}
          className="w-40"
        />
      </div>

      {syncMode === 'incremental' && incrementalConfig && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-foreground-subtle">{t('migration.incrementalField')}</span>
            <input
              value={incrementalConfig.field}
              onChange={e => onChange(syncMode, { ...incrementalConfig, field: e.target.value })}
              placeholder="updated_at"
              className={inputCls + " w-full"}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-foreground-subtle">{t('migration.fieldType')}</span>
            <DropdownSelect
              value={incrementalConfig.fieldType}
              onChange={val => onChange(syncMode, { ...incrementalConfig, fieldType: val as 'timestamp' | 'numeric' })}
              options={[
                { value: 'timestamp', label: 'Timestamp' },
                { value: 'numeric', label: 'Numeric (ID)' },
              ]}
              className="w-full"
            />
          </label>
          {incrementalConfig.lastValue && (
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-foreground-subtle">{t('migration.lastCheckpoint')}</span>
              <input value={incrementalConfig.lastValue} readOnly className={inputCls + " w-full opacity-60"} />
            </label>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/SyncModeSection.tsx
git commit -m "feat(migration): add SyncModeSection component"
```

---

## Task 8: TableMappingPanel Component

**Files:**
- Create: `src/components/MigrationJobTab/TableMappingPanel.tsx`

- [ ] **Step 1: Create the component**

This is the core table mapping grid. It renders the source→target mapping rows with action dropdowns.

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ChevronDown, Copy, Trash2, Columns3, Sparkles } from 'lucide-react'
import { ColumnMappingPanel } from './ColumnMappingPanel'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface TargetConfig {
  connectionId: number; database: string; table: string
  conflictStrategy: string; createIfNotExists: boolean; upsertKeys: string[]
}
interface TableMapping {
  sourceTable: string; target: TargetConfig
  filterCondition?: string; columnMappings: ColumnMapping[]
}

interface Props {
  mappings: TableMapping[]
  defaultTarget: { connectionId: number; database: string }
  targetTables: Array<{ name: string }>
  onUpdate: (mappings: TableMapping[]) => void
  hasAi: boolean
  onAiRecommend: (mappingIdx: number) => void
  aiLoadingMap: Record<number, boolean>
}

export function TableMappingPanel({ mappings, defaultTarget, targetTables, onUpdate, hasAi, onAiRecommend, aiLoadingMap }: Props) {
  const { t } = useTranslation()
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [openMenu, setOpenMenu] = useState<number | null>(null)

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  const updateMapping = (idx: number, patch: Partial<TableMapping>) => {
    const next = [...mappings]
    next[idx] = { ...next[idx], ...patch }
    onUpdate(next)
  }

  const updateTarget = (idx: number, patch: Partial<TargetConfig>) => {
    const next = [...mappings]
    next[idx] = { ...next[idx], target: { ...next[idx].target, ...patch } }
    onUpdate(next)
  }

  const duplicateRow = (idx: number) => {
    const next = [...mappings]
    next.splice(idx + 1, 0, { ...JSON.parse(JSON.stringify(mappings[idx])), filterCondition: '' })
    onUpdate(next)
    setOpenMenu(null)
  }

  const removeRow = (idx: number) => {
    onUpdate(mappings.filter((_, i) => i !== idx))
    if (expandedIdx === idx) setExpandedIdx(null)
    setOpenMenu(null)
  }

  const addRow = () => {
    onUpdate([...mappings, {
      sourceTable: '',
      target: { connectionId: defaultTarget.connectionId, database: defaultTarget.database, table: '', conflictStrategy: 'INSERT', createIfNotExists: false, upsertKeys: [] },
      columnMappings: [],
    }])
  }

  // Detect multi-source → same target (N:1)
  const targetCounts = new Map<string, number>()
  mappings.forEach(m => {
    const key = `${m.target.connectionId}:${m.target.database}:${m.target.table}`
    if (m.target.table) targetCounts.set(key, (targetCounts.get(key) || 0) + 1)
  })

  // Detect same source appearing multiple times (1:N)
  const sourceCounts = new Map<string, number>()
  mappings.forEach(m => {
    if (m.sourceTable) sourceCounts.set(m.sourceTable, (sourceCounts.get(m.sourceTable) || 0) + 1)
  })

  return (
    <div className="bg-background-panel border border-border-subtle rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-foreground-default">{t('migration.tableMapping')}</span>
        {hasAi && (
          <button onClick={() => mappings.forEach((_, i) => onAiRecommend(i))}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors">
            <Sparkles size={12} />{t('migration.aiRecommendAll')}
          </button>
        )}
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_1fr_36px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
        <span>{t('migration.sourceTable')}</span>
        <span>{t('migration.targetTable')}</span>
        <span>{t('migration.filterCondition')}</span>
        <span />
      </div>

      {/* Rows */}
      {mappings.map((m, idx) => {
        const tKey = `${m.target.connectionId}:${m.target.database}:${m.target.table}`
        const isMultiTarget = m.target.table && (targetCounts.get(tKey) || 0) > 1
        const isMultiSource = m.sourceTable && (sourceCounts.get(m.sourceTable) || 0) > 1
        return (
          <div key={idx}>
            <div className="grid grid-cols-[1fr_1fr_1fr_36px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors">
              <input value={m.sourceTable} readOnly className={inputCls + " w-full opacity-70"} />
              <input
                value={m.target.table}
                onChange={e => updateTarget(idx, { table: e.target.value })}
                placeholder="target_table"
                list={`target-tables-${idx}`}
                className={inputCls + " w-full"}
              />
              <datalist id={`target-tables-${idx}`}>
                {targetTables.map(t => <option key={t.name} value={t.name} />)}
              </datalist>
              <input
                value={m.filterCondition || ''}
                onChange={e => updateMapping(idx, { filterCondition: e.target.value })}
                placeholder={isMultiSource ? "WHERE ..." : ""}
                className={inputCls + " w-full"}
              />
              <div className="relative">
                <button onClick={() => setOpenMenu(openMenu === idx ? null : idx)}
                  className="p-1 text-foreground-muted hover:text-foreground transition-colors">
                  <ChevronDown size={14} />
                </button>
                {openMenu === idx && (
                  <div className="absolute right-0 top-full z-50 bg-background-panel border border-border-subtle rounded shadow-lg py-1 min-w-[120px]">
                    <button onClick={() => { setExpandedIdx(expandedIdx === idx ? null : idx); setOpenMenu(null) }}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover flex items-center gap-2">
                      <Columns3 size={12} />{t('migration.columnMapping')}
                    </button>
                    <button onClick={() => duplicateRow(idx)}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover flex items-center gap-2">
                      <Copy size={12} />{t('migration.duplicateRow')}
                    </button>
                    <button onClick={() => removeRow(idx)}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover text-error flex items-center gap-2">
                      <Trash2 size={12} />{t('migration.delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Inline expand: column mapping */}
            {expandedIdx === idx && (
              <div className="ml-2 mr-2 mb-2">
                <ColumnMappingPanel
                  mapping={m}
                  onUpdate={patch => updateMapping(idx, patch)}
                  onUpdateTarget={patch => updateTarget(idx, patch)}
                  hasAi={hasAi}
                  aiLoading={aiLoadingMap[idx] || false}
                  onAiRecommend={() => onAiRecommend(idx)}
                />
              </div>
            )}

            {/* Warnings */}
            {isMultiTarget && idx === mappings.findIndex(mm => `${mm.target.connectionId}:${mm.target.database}:${mm.target.table}` === tKey) && (
              <div className="text-[10px] text-warning px-1 mb-1">
                {t('migration.multiTargetWarning', { table: m.target.table })}
              </div>
            )}
            {isMultiSource && idx === mappings.findIndex(mm => mm.sourceTable === m.sourceTable) && (
              <div className="text-[10px] text-info px-1 mb-1">
                {t('migration.conditionRouteInfo', { table: m.sourceTable, count: sourceCounts.get(m.sourceTable) })}
              </div>
            )}
          </div>
        )
      })}

      <button onClick={addRow} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors">
        <Plus size={12} />{t('migration.addMappingRow')}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/TableMappingPanel.tsx
git commit -m "feat(migration): add TableMappingPanel component"
```

---

## Task 9: ColumnMappingPanel Component

**Files:**
- Create: `src/components/MigrationJobTab/ColumnMappingPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useTranslation } from 'react-i18next'
import { Sparkles, Plus, Trash2, TableProperties } from 'lucide-react'
import { DropdownSelect } from '../common/DropdownSelect'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface TargetConfig {
  connectionId: number; database: string; table: string
  conflictStrategy: string; createIfNotExists: boolean; upsertKeys: string[]
}
interface TableMapping {
  sourceTable: string; target: TargetConfig
  filterCondition?: string; columnMappings: ColumnMapping[]
}

interface Props {
  mapping: TableMapping
  onUpdate: (patch: Partial<TableMapping>) => void
  onUpdateTarget: (patch: Partial<TargetConfig>) => void
  hasAi: boolean
  aiLoading: boolean
  onAiRecommend: () => void
}

export function ColumnMappingPanel({ mapping, onUpdate, onUpdateTarget, hasAi, aiLoading, onAiRecommend }: Props) {
  const { t } = useTranslation()
  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  const cms = mapping.columnMappings

  const updateCm = (idx: number, patch: Partial<ColumnMapping>) => {
    const next = [...cms]
    next[idx] = { ...next[idx], ...patch }
    onUpdate({ columnMappings: next })
  }

  const removeCm = (idx: number) => onUpdate({ columnMappings: cms.filter((_, i) => i !== idx) })
  const addCm = () => onUpdate({ columnMappings: [...cms, { sourceExpr: '', targetCol: '', targetType: 'TEXT' }] })

  return (
    <div className="bg-background-elevated border border-border-subtle rounded p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium text-foreground-default">
          {mapping.sourceTable} → {mapping.target.table || '?'} {t('migration.columnMapping')}
        </span>
        <div className="flex items-center gap-2">
          {hasAi && (
            <button onClick={onAiRecommend} disabled={aiLoading}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors disabled:opacity-50">
              <Sparkles size={10} />{aiLoading ? t('migration.generating') : t('migration.aiRecommend')}
            </button>
          )}
          <button onClick={async () => {
              try {
                const detail = await invoke<{ columns: Array<{ name: string; dataType: string }> }>(
                  'get_table_detail', {
                    connectionId: mapping.target.connectionId,
                    database: mapping.target.database || undefined,
                    table: mapping.sourceTable,
                  })
                const derived = detail.columns.map(c => ({
                  sourceExpr: c.name, targetCol: c.name, targetType: c.dataType,
                }))
                onUpdate({ columnMappings: derived })
              } catch (e) { console.error('Derive from source failed:', e) }
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors">
            <TableProperties size={10} />{t('migration.deriveFromSource')}
          </button>
        </div>
      </div>

      {/* Column mapping rows */}
      <div className="grid grid-cols-[1fr_1fr_100px_24px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
        <span>{t('migration.sourceFieldExpr')}</span>
        <span>{t('migration.targetField')}</span>
        <span>{t('migration.targetType')}</span>
        <span />
      </div>

      {cms.map((cm, idx) => (
        <div key={idx} className="grid grid-cols-[1fr_1fr_100px_24px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors">
          <input value={cm.sourceExpr} onChange={e => updateCm(idx, { sourceExpr: e.target.value })} className={inputCls + " w-full"} placeholder="col or expr" />
          <input value={cm.targetCol} onChange={e => updateCm(idx, { targetCol: e.target.value })} className={inputCls + " w-full"} placeholder="target_col" />
          <input value={cm.targetType} onChange={e => updateCm(idx, { targetType: e.target.value })} className={inputCls + " w-full"} placeholder="TEXT" />
          <button onClick={() => removeCm(idx)} className="p-0.5 text-foreground-muted hover:text-error transition-colors">
            <Trash2 size={11} />
          </button>
        </div>
      ))}

      <button onClick={addCm} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors">
        <Plus size={12} />{t('migration.addField')}
      </button>

      {/* Target options row */}
      <div className="mt-2 pt-2 border-t border-border-subtle flex items-center gap-4 text-[11px]">
        <label className="flex items-center gap-1.5 text-foreground-muted cursor-pointer">
          <input type="checkbox" checked={mapping.target.createIfNotExists}
            onChange={e => onUpdateTarget({ createIfNotExists: e.target.checked })}
            className="accent-accent" />
          {t('migration.autoCreateTable')}
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground-subtle">{t('migration.conflictStrategy')}:</span>
          <DropdownSelect
            value={mapping.target.conflictStrategy}
            onChange={val => onUpdateTarget({ conflictStrategy: val })}
            options={['INSERT', 'UPSERT', 'REPLACE', 'SKIP'].map(s => ({ value: s, label: s }))}
            className="w-24"
          />
        </div>
        {mapping.target.conflictStrategy === 'UPSERT' && (
          <div className="flex items-center gap-1.5">
            <span className="text-foreground-subtle">Keys:</span>
            <input
              value={mapping.target.upsertKeys.join(', ')}
              onChange={e => onUpdateTarget({ upsertKeys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              className={inputCls + " w-32"}
              placeholder="id"
            />
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/ColumnMappingPanel.tsx
git commit -m "feat(migration): add ColumnMappingPanel component"
```

---

## Task 10: Rewrite ConfigTab

**Files:**
- Modify: `src/components/MigrationJobTab/ConfigTab.tsx`

This is the main integration task. Rewrite ConfigTab to use the new config model and subcomponents.

- [ ] **Step 1: Rewrite ConfigTab.tsx**

Replace the entire file. The new ConfigTab:
- Uses `SyncModeSection` at the top
- Source panel: connection → database → query mode → table selection
- Target defaults panel: connection → database (replaces old single-table target)
- `TableMappingPanel` in the middle
- Pipeline params at the bottom
- Auto-generates table mappings when source tables change

The new config type (matching Rust `MigrationJobConfig`):

```typescript
interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface TargetConfig {
  connectionId: number; database: string; table: string
  conflictStrategy: string; createIfNotExists: boolean; upsertKeys: string[]
}
interface TableMapping {
  sourceTable: string; target: TargetConfig
  filterCondition?: string; columnMappings: ColumnMapping[]
}
interface IncrementalConfig {
  field: string; fieldType: 'timestamp' | 'numeric'; lastValue?: string
}
interface PipelineConfig {
  readBatchSize: number; writeBatchSize: number; parallelism: number
  channelCapacity: number; speedLimitRps: number | null; errorLimit: number
  shardCount: number | null
}
interface JobConfig {
  syncMode: 'full' | 'incremental'
  incrementalConfig?: IncrementalConfig
  source: {
    connectionId: number; database: string
    queryMode: 'auto' | 'custom'
    tables: string[]; customQuery?: string
  }
  tableMappings: TableMapping[]
  pipeline: PipelineConfig
}
```

The component structure:

```tsx
import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Play, ShieldCheck, Save } from 'lucide-react'
import { DropdownSelect } from '../common/DropdownSelect'
import { TableSelector } from '../ImportExport/TableSelector'
import { SyncModeSection } from './SyncModeSection'
import { TableMappingPanel } from './TableMappingPanel'

// ... interfaces above ...

function defaultConfig(): JobConfig {
  return {
    syncMode: 'full',
    source: { connectionId: 0, database: '', queryMode: 'auto', tables: [] },
    tableMappings: [],
    pipeline: { readBatchSize: 10000, writeBatchSize: 1000, parallelism: 1, channelCapacity: 16, speedLimitRps: null, errorLimit: 0, shardCount: null },
  }
}

// Default target tracked separately in component state (not in config)
// When user changes default target, all mappings that haven't been individually modified inherit it

export function ConfigTab({ jobId: _jobId, configJson, onSave, onRun, onPrecheck }: Props) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<Array<{ id: number; name: string }>>([])
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([])
  const [targetDatabases, setTargetDatabases] = useState<string[]>([])
  const [sourceTables, setSourceTables] = useState<Array<{ name: string }>>([])
  const [targetTables, setTargetTables] = useState<Array<{ name: string }>>([])
  const [dbsLoading, setDbsLoading] = useState(false)
  const [targetDbsLoading, setTargetDbsLoading] = useState(false)
  const [tablesLoading, setTablesLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [aiLoadingMap, setAiLoadingMap] = useState<Record<number, boolean>>({})
  const [hasAi, setHasAi] = useState(false)

  // Default target (UI-only, not stored in config directly)
  const [defaultTargetConnId, setDefaultTargetConnId] = useState(0)
  const [defaultTargetDb, setDefaultTargetDb] = useState('')

  const [config, setConfig] = useState<JobConfig>(() => {
    try {
      const parsed = JSON.parse(configJson)
      const def = defaultConfig()
      return { ...def, ...parsed, source: { ...def.source, ...(parsed.source || {}) }, pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) }, tableMappings: parsed.tableMappings || [] }
    } catch { return defaultConfig() }
  })

  // Sync from external configJson changes
  useEffect(() => {
    if (!dirty && configJson) {
      try {
        const parsed = JSON.parse(configJson)
        const def = defaultConfig()
        setConfig({ ...def, ...parsed, source: { ...def.source, ...(parsed.source || {}) }, pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) }, tableMappings: parsed.tableMappings || [] })
        // Infer default target from first mapping
        if (parsed.tableMappings?.[0]?.target) {
          setDefaultTargetConnId(parsed.tableMappings[0].target.connectionId || 0)
          setDefaultTargetDb(parsed.tableMappings[0].target.database || '')
        }
      } catch {}
    }
  }, [configJson, dirty])

  // Load connections + check AI availability
  useEffect(() => {
    invoke<Array<{ id: number; name: string }>>('list_connections').then(setConnections).catch(() => {})
    invoke<any>('get_default_llm_config').then(r => setHasAi(!!r)).catch(() => setHasAi(false))
  }, [])

  // Source databases
  useEffect(() => {
    if (!config.source.connectionId) { setSourceDatabases([]); setSourceTables([]); return }
    setDbsLoading(true)
    invoke<string[]>('list_databases', { connectionId: config.source.connectionId })
      .then(setSourceDatabases).catch(() => setSourceDatabases([])).finally(() => setDbsLoading(false))
  }, [config.source.connectionId])

  // Source tables
  useEffect(() => {
    if (!config.source.connectionId || !config.source.database) { setSourceTables([]); return }
    setTablesLoading(true)
    invoke<Array<{ name: string }>>('get_tables', { connectionId: config.source.connectionId, database: config.source.database })
      .then(setSourceTables).catch(() => setSourceTables([])).finally(() => setTablesLoading(false))
  }, [config.source.connectionId, config.source.database])

  // Target databases
  useEffect(() => {
    if (!defaultTargetConnId) { setTargetDatabases([]); setTargetTables([]); return }
    setTargetDbsLoading(true)
    invoke<string[]>('list_databases', { connectionId: defaultTargetConnId })
      .then(setTargetDatabases).catch(() => setTargetDatabases([])).finally(() => setTargetDbsLoading(false))
  }, [defaultTargetConnId])

  // Target tables
  useEffect(() => {
    if (!defaultTargetConnId || !defaultTargetDb) { setTargetTables([]); return }
    invoke<Array<{ name: string }>>('get_tables', { connectionId: defaultTargetConnId, database: defaultTargetDb })
      .then(setTargetTables).catch(() => setTargetTables([]))
  }, [defaultTargetConnId, defaultTargetDb])

  const update = (patch: Partial<JobConfig>) => { setConfig(prev => ({ ...prev, ...patch })); setDirty(true) }

  // Auto-generate table mappings when source tables change
  const prevTablesRef = useRef<string[]>([])
  useEffect(() => {
    if (config.source.queryMode !== 'auto') return
    const prev = prevTablesRef.current
    const curr = config.source.tables
    prevTablesRef.current = curr

    // Only add new tables, don't remove existing mappings
    const existingSources = new Set(config.tableMappings.map(m => m.sourceTable))
    const newTables = curr.filter(t => !existingSources.has(t))
    const removedTables = prev.filter(t => !curr.includes(t))

    if (newTables.length === 0 && removedTables.length === 0) return

    let next = config.tableMappings.filter(m => curr.includes(m.sourceTable) || m.sourceTable === 'custom_query')
    for (const t of newTables) {
      next.push({
        sourceTable: t,
        target: { connectionId: defaultTargetConnId, database: defaultTargetDb, table: t, conflictStrategy: 'INSERT', createIfNotExists: false, upsertKeys: [] },
        columnMappings: [],
      })
    }
    update({ tableMappings: next })
  }, [config.source.tables])

  const handleAiRecommend = async (mappingIdx: number) => {
    const m = config.tableMappings[mappingIdx]
    if (!m) return
    setAiLoadingMap(prev => ({ ...prev, [mappingIdx]: true }))
    try {
      const result = await invoke<Array<{ sourceExpr: string; targetCol: string; targetType: string }>>(
        'ai_recommend_column_mappings', {
          sourceConnectionId: config.source.connectionId,
          sourceDatabase: config.source.database,
          sourceTable: m.sourceTable,
          targetConnectionId: m.target.connectionId,
          targetDatabase: m.target.database,
          targetTable: m.target.table,
        })
      const next = [...config.tableMappings]
      next[mappingIdx] = { ...next[mappingIdx], columnMappings: result }
      update({ tableMappings: next })
    } catch (e) {
      console.error('AI recommend failed:', e)
    } finally {
      setAiLoadingMap(prev => ({ ...prev, [mappingIdx]: false }))
    }
  }

  const handleSave = () => { onSave(JSON.stringify(config, null, 2)); setDirty(false) }

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Sync Mode */}
      <SyncModeSection
        syncMode={config.syncMode}
        incrementalConfig={config.incrementalConfig}
        onChange={(syncMode, incrementalConfig) => update({ syncMode, incrementalConfig })}
      />

      {/* Source + Target defaults */}
      <div className="grid grid-cols-2 gap-4">
        {/* Source */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.sourceEnd')}</div>
          <DropdownSelect
            value={config.source.connectionId ? String(config.source.connectionId) : ''}
            onChange={val => update({ source: { ...config.source, connectionId: val ? Number(val) : 0, database: '', tables: [] }, tableMappings: [] })}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.sourceConn')}
            className="w-full"
          />
          <DropdownSelect
            value={config.source.database}
            onChange={val => update({ source: { ...config.source, database: val, tables: [] }, tableMappings: [] })}
            options={sourceDatabases.map(db => ({ value: db, label: db }))}
            placeholder={dbsLoading ? t('migration.loadingDatabases') : t('migration.sourceDatabase')}
            className="w-full"
          />
          <div className="flex gap-2 text-[12px]">
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'auto'} onChange={() => update({ source: { ...config.source, queryMode: 'auto' } })} className="accent-accent" />
              {t('migration.tableMode')}
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'custom'} onChange={() => update({ source: { ...config.source, queryMode: 'custom' } })} className="accent-accent" />
              {t('migration.sqlMode')}
            </label>
          </div>
          {config.source.queryMode === 'auto' && (
            <div className="h-[300px] overflow-hidden flex flex-col">
              {tablesLoading ? (
                <div className="text-[11px] text-foreground-muted py-2">{t('migration.loadingTables')}</div>
              ) : (
                <TableSelector
                  tables={sourceTables}
                  selected={config.source.tables}
                  onChange={tables => update({ source: { ...config.source, tables } })}
                />
              )}
            </div>
          )}
          {config.source.queryMode === 'custom' && (
            <textarea
              value={config.source.customQuery || ''}
              onChange={e => update({ source: { ...config.source, customQuery: e.target.value } })}
              placeholder="SELECT ..."
              rows={6}
              className={inputCls + " w-full resize-none font-mono text-[11px]"}
            />
          )}
        </div>

        {/* Target defaults */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.targetEnd')} ({t('migration.defaults')})</div>
          <DropdownSelect
            value={defaultTargetConnId ? String(defaultTargetConnId) : ''}
            onChange={val => { setDefaultTargetConnId(val ? Number(val) : 0); setDefaultTargetDb(''); setDirty(true) }}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.targetConn')}
            className="w-full"
          />
          <DropdownSelect
            value={defaultTargetDb}
            onChange={val => { setDefaultTargetDb(val); setDirty(true) }}
            options={targetDatabases.map(db => ({ value: db, label: db }))}
            placeholder={targetDbsLoading ? t('migration.loadingDatabases') : t('migration.targetDatabase')}
            className="w-full"
          />
          {/* Pipeline params */}
          <div className="border-t border-border-subtle pt-2 mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {([
              ['readBatchSize', t('migration.readBatch')],
              ['writeBatchSize', t('migration.writeBatch')],
              ['parallelism', t('migration.parallelism')],
              ['errorLimit', t('migration.errorLimit')],
            ] as [keyof PipelineConfig, string][]).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-foreground-subtle">{label}</span>
                <input
                  type="number" min={0}
                  value={config.pipeline[key] as number ?? 0}
                  onChange={e => update({ pipeline: { ...config.pipeline, [key]: Number(e.target.value) } })}
                  className={inputCls + " w-full"}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Table Mapping */}
      <TableMappingPanel
        mappings={config.tableMappings}
        defaultTarget={{ connectionId: defaultTargetConnId, database: defaultTargetDb }}
        targetTables={targetTables}
        onUpdate={tableMappings => update({ tableMappings })}
        hasAi={hasAi}
        onAiRecommend={handleAiRecommend}
        aiLoadingMap={aiLoadingMap}
      />

      {/* Action Bar */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3 mt-auto">
        <button onClick={onPrecheck} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors">
          <ShieldCheck size={13} />{t('migration.precheck')}
        </button>
        <button onClick={handleSave} disabled={!dirty} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors disabled:opacity-40">
          <Save size={13} />{t('migration.save')}
        </button>
        <button onClick={onRun} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors">
          <Play size={13} />{t('migration.run')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: PASS or only unrelated warnings.

- [ ] **Step 3: Commit**

```bash
git add src/components/MigrationJobTab/ConfigTab.tsx
git commit -m "feat(migration): rewrite ConfigTab with table mapping, sync mode, target database selection"
```

---

## Task 11: Update LogTab for Mapping Progress

**Files:**
- Modify: `src/components/MigrationJobTab/LogTab.tsx`

- [ ] **Step 1: Update LogTab to show mapping progress**

Find the stats bar section in LogTab.tsx. Add a mapping progress indicator. Look for where `stats.progressPct` or the progress bar is rendered and add before it:

```tsx
{stats?.currentMapping && stats?.mappingProgress && (
  <div className="text-[11px] text-foreground-muted mb-1">
    [{stats.mappingProgress.current}/{stats.mappingProgress.total}] {t('migration.migrating')} {stats.currentMapping} ...
  </div>
)}
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/MigrationJobTab/LogTab.tsx
git commit -m "feat(migration): show mapping progress in LogTab"
```

---

## Task 12: Add i18n Keys

**Files:**
- Modify: the i18n translation files (find with `grep -r "migration\." src/i18n/` or similar)

- [ ] **Step 1: Find and update translation files**

Run: `find src -name '*.json' -path '*/i18n/*' | head -5` to locate translation files.

Add new keys under the `migration` namespace:

```json
{
  "migration": {
    "syncMode": "Sync Mode",
    "fullSync": "Full",
    "incrementalSync": "Incremental",
    "incrementalField": "Incremental Field",
    "fieldType": "Field Type",
    "lastCheckpoint": "Last Checkpoint",
    "tableMapping": "Table Mapping",
    "sourceTable": "Source Table",
    "targetTable": "Target Table",
    "filterCondition": "Filter Condition",
    "columnMapping": "Column Mapping",
    "duplicateRow": "Duplicate Row",
    "addMappingRow": "Add Mapping",
    "multiTargetWarning": "Multiple sources point to {table}, verify column mapping compatibility",
    "conditionRouteInfo": "{table} routed to {count} target tables (condition routing)",
    "aiRecommend": "AI Recommend",
    "aiRecommendAll": "AI Recommend All",
    "deriveFromSource": "Derive from Source",
    "defaults": "Defaults",
    "targetDatabase": "Target Database",
    "migrating": "Migrating",
    "conflictStrategy": "Conflict Strategy"
  }
}
```

Also add Chinese translations in the zh-CN file.

- [ ] **Step 2: Commit**

```bash
git add src/i18n/
git commit -m "feat(migration): add i18n keys for table mapping UI"
```

---

## Task 13: Final Verification

- [ ] **Step 1: Run full Rust check**

Run: `cd src-tauri && cargo check`
Expected: PASS — zero errors.

- [ ] **Step 2: Run Rust tests**

Run: `cd src-tauri && cargo test --lib`
Expected: All tests pass.

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Start dev server and verify UI loads**

Run: `npm run dev`
Open browser, navigate to migration center, verify:
- Sync mode selector renders
- Source panel shows connection → database → table selection
- Target defaults panel shows connection → database
- Table mapping panel auto-generates rows when source tables are selected
- Column mapping expands inline
- Config saves and reloads correctly

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(migration): address verification issues"
```
