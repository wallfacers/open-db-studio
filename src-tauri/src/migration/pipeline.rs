use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use rusqlite::params;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use super::task_mgr::*;

const MIGRATION_LOG_EVENT: &str = "migration_log";
const MIGRATION_STATS_EVENT: &str = "migration_stats";
const MIGRATION_FINISHED_EVENT: &str = "migration_finished";

// ── Log collector (thread-safe) ──────────────────────────────────────────────

fn build_log_event(job_id: i64, run_id: &str, level: &str, message: &str) -> MigrationLogEvent {
    MigrationLogEvent {
        job_id,
        run_id: run_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        timestamp: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    }
}

pub struct LogCollector(pub Vec<MigrationLogEvent>);

impl LogCollector {
    fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self(Vec::new())))
    }

    fn emit_and_record(
        &mut self,
        app: &AppHandle,
        job_id: i64,
        run_id: &str,
        level: &str,
        message: &str,
    ) {
        let event = build_log_event(job_id, run_id, level, message);
        let _ = app.emit(MIGRATION_LOG_EVENT, &event);
        self.0.push(event);
    }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

pub struct PipelineStats {
    pub rows_read: AtomicU64,
    pub rows_written: AtomicU64,
    pub rows_failed: AtomicU64,
    pub bytes_transferred: AtomicU64,
}

impl PipelineStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rows_read: AtomicU64::new(0),
            rows_written: AtomicU64::new(0),
            rows_failed: AtomicU64::new(0),
            bytes_transferred: AtomicU64::new(0),
        })
    }
}

// ── Cancel registry ───────────────────────────────────────────────────────────

static ACTIVE_RUNS: Lazy<Mutex<HashMap<i64, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn cancel_run(job_id: i64) {
    if let Ok(runs) = ACTIVE_RUNS.lock() {
        if let Some(flag) = runs.get(&job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// ── Standalone emit (for helpers that don't collect logs) ─────────────────────

fn emit_log(app: &AppHandle, job_id: i64, run_id: &str, level: &str, message: &str) {
    let _ = app.emit(MIGRATION_LOG_EVENT, &build_log_event(job_id, run_id, level, message));
}

// ── Internal batch type ───────────────────────────────────────────────────────

type Row = Vec<serde_json::Value>;

struct Batch {
    rows: Vec<Row>,
    column_names: Vec<String>,
}

fn json_value_len(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Null => 4, // "NULL"
        serde_json::Value::Bool(_) => 1,
        serde_json::Value::Number(n) => n.to_string().len() as u64,
        serde_json::Value::String(s) => s.len() as u64,
        other => other.to_string().len() as u64,
    }
}

// ── Public entry-point ────────────────────────────────────────────────────────

/// Launch the ETL pipeline for `job_id`.
/// Returns the `run_id` immediately — the pipeline runs in a background task.
pub async fn run_pipeline(job_id: i64, app: AppHandle) -> AppResult<String> {
    let config_json: String = tokio::task::spawn_blocking(move || -> AppResult<String> {
        let db = crate::db::get().lock().unwrap();
        db.query_row(
            "SELECT config_json FROM migration_jobs WHERE id=?1",
            params![job_id],
            |r| r.get(0),
        ).map_err(Into::into)
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking failed: {}", e)))??;
    let config: MigrationJobConfig = serde_json::from_str(&config_json)
        .map_err(|e| AppError::Other(e.to_string()))?;

    let run_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut runs = ACTIVE_RUNS.lock().unwrap();
        runs.insert(job_id, cancel.clone());
    }

    // Write RUNNING status + run history row
    {
        let db = crate::db::get().lock().unwrap();
        db.execute(
            "UPDATE migration_jobs \
             SET last_status='RUNNING', last_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id=?1",
            params![job_id],
        )?;
        db.execute(
            "INSERT INTO migration_run_history (job_id, run_id, status, started_at) \
             VALUES (?1, ?2, 'RUNNING', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![job_id, &run_id],
        )?;
    }

    let log_collector = LogCollector::new();

    log_collector.lock().unwrap().emit_and_record(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!("Pipeline started: job_id={}", job_id),
    );

    let run_id_clone = run_id.clone();
    let app_clone = app.clone();
    let log_collector_clone = log_collector.clone();

    tokio::spawn(async move {
        let result =
            execute_pipeline(job_id, run_id_clone.clone(), config, app_clone.clone(), cancel, log_collector_clone.clone())
                .await;

        let final_status = match &result {
            Ok(_) => "FINISHED",
            Err(e) if e.to_string().starts_with("PARTIAL_FAILED") => "PARTIAL_FAILED",
            Err(_) => "FAILED",
        };

        // Remove from active runs
        {
            let mut runs = ACTIVE_RUNS.lock().unwrap();
            runs.remove(&job_id);
        }

        let msg = match result {
            Ok(summary) => summary,
            Err(e) => e.to_string(),
        };

        let mut log_collector = log_collector_clone.lock().unwrap();
        log_collector.emit_and_record(
            &app_clone,
            job_id,
            &run_id_clone,
            "SYSTEM",
            &format!("Pipeline {}: {}", final_status, msg),
        );
        let logs_json = serde_json::to_string(&log_collector.0).unwrap_or_default();
        drop(log_collector);

        // Parse stats from summary message
        let mut final_rows_read = 0u64;
        let mut final_rows_written = 0u64;
        let mut final_rows_failed = 0u64;
        let mut final_bytes = 0u64;
        let mut final_elapsed = 0f64;

        for part in msg.split_whitespace() {
            if let Some(val) = part.strip_prefix("rows_read=") {
                final_rows_read = val.parse().unwrap_or(0);
            }
            if let Some(val) = part.strip_prefix("rows_written=") {
                final_rows_written = val.parse().unwrap_or(0);
            }
            if let Some(val) = part.strip_prefix("rows_failed=") {
                final_rows_failed = val.parse().unwrap_or(0);
            }
            if let Some(val) = part.strip_prefix("bytes_transferred=") {
                final_bytes = val.parse().unwrap_or(0);
            }
            if let Some(val) = part.strip_prefix("elapsed=") {
                final_elapsed = val.replace('s', "").parse().unwrap_or(0.0);
            }
        }

        // Persist final status + stats + logs
        {
            let db = crate::db::get().lock().unwrap();
            let _ = db.execute(
                "UPDATE migration_jobs SET last_status=?1 WHERE id=?2",
                params![final_status, job_id],
            );

            let duration_ms = (final_elapsed * 1000.0) as i64;
            let _ = db.execute(
                "UPDATE migration_run_history \
                 SET status=?1, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
                     rows_read=?2, rows_written=?3, rows_failed=?4, \
                     bytes_transferred=?5, duration_ms=?6, log_content=?7 \
                 WHERE run_id=?8",
                params![
                    final_status,
                    final_rows_read as i64,
                    final_rows_written as i64,
                    final_rows_failed as i64,
                    final_bytes as i64,
                    duration_ms,
                    logs_json,
                    &run_id_clone,
                ],
            );
        }

        let _ = app_clone.emit(
            MIGRATION_FINISHED_EVENT,
            serde_json::json!({
                "jobId": job_id,
                "runId": run_id_clone,
                "status": final_status,
                "rowsRead": final_rows_read,
                "rowsWritten": final_rows_written,
                "rowsFailed": final_rows_failed,
                "bytesTransferred": final_bytes,
                "elapsedSeconds": final_elapsed,
            }),
        );
    });

    Ok(run_id)
}

// ── Orchestrator: iterate over all table mappings ─────────────────────────────

async fn execute_pipeline(
    job_id: i64,
    run_id: String,
    config: MigrationJobConfig,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    logs: Arc<Mutex<LogCollector>>,
) -> AppResult<String> {
    let stats = PipelineStats::new();
    let start = Instant::now();
    let total_mappings = config.table_mappings.len();

    if total_mappings == 0 {
        return Err(AppError::Other("No table mappings configured".into()));
    }

    let parallelism = config.pipeline.parallelism.max(1).min(16);

    logs.lock().unwrap().emit_and_record(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!("Executing: {} table mapping(s), parallelism={}", total_mappings, parallelism),
    );

    let config = Arc::new(config);

    // Build futures for each table mapping
    let mapping_futures: Vec<_> = config.table_mappings.iter().enumerate().map(|(idx, mapping)| {
        let config = config.clone();
        let mapping = mapping.clone();
        let app = app.clone();
        let cancel = cancel.clone();
        let stats = stats.clone();
        let logs = logs.clone();
        let run_id = run_id.clone();
        async move {
            let mapping_label = format!("{}→{}", mapping.source_table, mapping.target.table);
            if cancel.load(Ordering::Relaxed) {
                return (idx, mapping_label, Err(AppError::Other("Cancelled".into())));
            }
            logs.lock().unwrap().emit_and_record(
                &app, job_id, &run_id, "SYSTEM",
                &format!("[{}/{}] Starting: {}", idx + 1, total_mappings, mapping_label),
            );
            let result = execute_single_mapping(
                job_id, &run_id, &config, &mapping, &app, &cancel, &stats,
                idx, total_mappings, logs.clone(),
            ).await;
            (idx, mapping_label, result)
        }
    }).collect();

    // Execute mappings concurrently with buffer_unordered
    let mapping_results: Vec<_> = stream::iter(mapping_futures)
        .buffer_unordered(parallelism)
        .collect()
        .await;

    let mut completed = 0usize;
    let mut failed_mappings = Vec::new();

    for (idx, mapping_label, result) in mapping_results {
        match result {
            Ok(summary) => {
                completed += 1;
                logs.lock().unwrap().emit_and_record(
                    &app, job_id, &run_id, "SYSTEM",
                    &format!("[{}/{}] Completed: {} — {}", idx + 1, total_mappings, mapping_label, summary),
                );
            }
            Err(e) => {
                failed_mappings.push(mapping_label.clone());
                logs.lock().unwrap().emit_and_record(
                    &app, job_id, &run_id, "ERROR",
                    &format!("[{}/{}] Failed: {} — {}", idx + 1, total_mappings, mapping_label, e),
                );
            }
        }
    }

    // Write back incremental lastValue if applicable
    if config.sync_mode == SyncMode::Incremental {
        writeback_incremental_checkpoint(job_id, &config, &app, &run_id).await;
    }

    let elapsed = start.elapsed().as_secs_f64();
    let rows_read = stats.rows_read.load(Ordering::Relaxed);
    let rows_written = stats.rows_written.load(Ordering::Relaxed);
    let rows_failed = stats.rows_failed.load(Ordering::Relaxed);
    let bytes = stats.bytes_transferred.load(Ordering::Relaxed);

    if failed_mappings.is_empty() {
        Ok(format!(
            "rows_read={} rows_written={} rows_failed={} bytes_transferred={} elapsed={:.2}s",
            rows_read, rows_written, rows_failed, bytes, elapsed
        ))
    } else if completed > 0 {
        Err(AppError::Other(format!(
            "PARTIAL_FAILED: {}/{} succeeded, failed=[{}] rows_read={} rows_written={} rows_failed={} bytes_transferred={} elapsed={:.2}s",
            completed,
            total_mappings,
            failed_mappings.join(", "),
            rows_read,
            rows_written,
            rows_failed,
            bytes,
            elapsed
        )))
    } else {
        Err(AppError::Other(format!(
            "All {} mapping(s) failed: [{}] rows_read={} rows_written={} rows_failed={} bytes_transferred={} elapsed={:.2}s",
            total_mappings,
            failed_mappings.join(", "),
            rows_read,
            rows_written,
            rows_failed,
            bytes,
            elapsed
        )))
    }
}

// ── Single-mapping reader→writer sub-pipeline ─────────────────────────────────

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
    logs: Arc<Mutex<LogCollector>>,
) -> AppResult<String> {
    let mapping_label = format!("{}→{}", mapping.source_table, mapping.target.table);

    // ── Build source SQL ──────────────────────────────────────────────────
    let source_query = build_source_query(config, mapping)?;
    logs.lock().unwrap().emit_and_record(
        app,
        job_id,
        run_id,
        "SYSTEM",
        &format!(
            "[{}] Source SQL: {}",
            mapping_label,
            if source_query.len() > 200 {
                &source_query[..200]
            } else {
                &source_query
            }
        ),
    );

    // ── Resolve source datasource ─────────────────────────────────────────
    let src_conn_id = config.source.connection_id;
    let src_cfg = crate::db::get_connection_config(src_conn_id)?;
    let src_db = if config.source.database.is_empty() {
        src_cfg.database.clone().unwrap_or_default()
    } else {
        config.source.database.clone()
    };
    let src_ds = crate::datasource::pool_cache::get_or_create(
        src_conn_id,
        &src_cfg,
        &src_db,
        "",
    )
    .await?;

    // ── Resolve target datasource ─────────────────────────────────────────
    let dst_conn_id = mapping.target.connection_id;
    let dst_cfg = crate::db::get_connection_config(dst_conn_id)?;
    let dst_db = if mapping.target.database.is_empty() {
        dst_cfg.database.clone().unwrap_or_default()
    } else {
        mapping.target.database.clone()
    };
    let dst_ds = crate::datasource::pool_cache::get_or_create(
        dst_conn_id,
        &dst_cfg,
        &dst_db,
        "",
    )
    .await?;

    // ── Auto-create table if needed ───────────────────────────────────────
    if mapping.target.create_if_not_exists {
        if let Err(e) = auto_create_target_table(
            &*src_ds,
            &*dst_ds,
            &src_cfg.driver,
            &dst_cfg.driver,
            &mapping.source_table,
            &mapping.target.table,
            &mapping.column_mappings,
            app,
            job_id,
            run_id,
            &mapping_label,
        )
        .await
        {
            logs.lock().unwrap().emit_and_record(
                app,
                job_id,
                run_id,
                "WARN",
                &format!(
                    "[{}] Auto-create table failed (continuing): {}",
                    mapping_label, e
                ),
            );
        }
    }

    // ── Estimate row count ────────────────────────────────────────────────
    let total_rows: Option<u64> = {
        let count_sql = format!(
            "SELECT COUNT(*) FROM ({}) AS _mig_count_",
            source_query
        );
        match src_ds.execute(&count_sql).await {
            Ok(result) => result
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_i64().map(|n| n as u64))
                        .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
                }),
            Err(_) => None,
        }
    };

    // ── Pipeline config ───────────────────────────────────────────────────
    let target_table = mapping.target.table.clone();
    let dst_driver = dst_cfg.driver.clone();
    let column_mapping = mapping.column_mappings.clone();
    let conflict_strategy = mapping.target.conflict_strategy.clone();
    let upsert_keys = mapping.target.upsert_keys.clone();

    // ── Pre-flight warnings for conflict strategy misconfigurations ───────
    match (&conflict_strategy, dst_cfg.driver.as_str()) {
        (ConflictStrategy::Upsert, "postgres" | "gaussdb") if upsert_keys.is_empty() => {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] Upsert on PostgreSQL requires upsert_keys; falling back to Skip (ON CONFLICT DO NOTHING)", mapping_label),
            );
        }
        (ConflictStrategy::Upsert, "sqlite") if upsert_keys.is_empty() => {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] Upsert on SQLite requires upsert_keys; falling back to Replace (INSERT OR REPLACE INTO)", mapping_label),
            );
        }
        (ConflictStrategy::Replace, "postgres" | "gaussdb") if upsert_keys.is_empty() => {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] Replace on PostgreSQL requires upsert_keys to identify conflict target; falling back to Skip (ON CONFLICT DO NOTHING)", mapping_label),
            );
        }
        _ => {}
    }

    // ── Overwrite: truncate target table before pipeline starts ──────────
    if conflict_strategy == ConflictStrategy::Overwrite {
        let truncate_sql = match dst_cfg.driver.as_str() {
            "sqlite" => format!("DELETE FROM \"{}\"", mapping.target.table.replace('"', "\"\"")),
            "sqlserver" => format!("TRUNCATE TABLE [{}]", mapping.target.table.replace(']', "]]")),
            _ => format!("TRUNCATE TABLE `{}`", mapping.target.table.replace('`', "``")),
        };
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "SYSTEM",
            &format!("[{}] Overwrite: truncating target table — {}", mapping_label, truncate_sql),
        );
        if let Err(e) = dst_ds.execute(&truncate_sql).await {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] Truncate failed (continuing): {}", mapping_label, e),
            );
        }
    }

    let error_limit = config.pipeline.error_limit.min(100_000);
    let read_batch_size = config.pipeline.read_batch_size.max(1).min(50_000);
    let write_batch_size = config.pipeline.write_batch_size.max(1).min(5_000);
    let channel_cap = config.pipeline.channel_capacity.max(1).min(64);
    let parallelism = config.pipeline.parallelism.max(1).min(16);

    // ── Mapped columns ───────────────────────────────────────────────────
    let mapped_cols: Option<Vec<String>> = if !column_mapping.is_empty() {
        Some(column_mapping.iter().map(|m| m.target_col.clone()).collect())
    } else {
        None
    };

    // ── Per-mapping stats ─────────────────────────────────────────────────
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
        let mut prev_bytes = 0u64;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if cancel_s.load(Ordering::Relaxed) {
                break;
            }
            let rows_read = ms_clone.rows_read.load(Ordering::Relaxed);
            let rows_written = ms_clone.rows_written.load(Ordering::Relaxed);
            let delta_read = rows_read.saturating_sub(prev_read) as f64;
            let delta_written = rows_written.saturating_sub(prev_written) as f64;
            let bytes_now = ms_clone.bytes_transferred.load(Ordering::Relaxed);
            let delta_bytes = bytes_now.saturating_sub(prev_bytes) as f64;
            let (eta, pct) = if let Some(total) = total_rows {
                if rows_read < total {
                    let rps = delta_read.max(1.0);
                    let eta_secs = (total - rows_read) as f64 / rps;
                    (
                        Some(eta_secs),
                        Some((rows_read as f64 / total as f64 * 100.0).min(100.0)),
                    )
                } else {
                    (Some(0.0), Some(100.0))
                }
            } else {
                (None, None)
            };

            let event = MigrationStatsEvent {
                job_id,
                run_id: run_id_s.clone(),
                rows_read: gs.rows_read.load(Ordering::Relaxed),
                rows_written: gs.rows_written.load(Ordering::Relaxed),
                rows_failed: gs.rows_failed.load(Ordering::Relaxed),
                bytes_transferred: gs.bytes_transferred.load(Ordering::Relaxed),
                read_speed_rps: delta_read,
                write_speed_rps: delta_written,
                bytes_speed_bps: delta_bytes,
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
            prev_bytes = bytes_now;
        }
    });

    // ── Detect parallelism mode ──────────────────────────────────────────
    let shard_pk = if parallelism > 1 {
        match src_ds.get_columns(&mapping.source_table, None).await {
            Ok(columns) => detect_integer_pk(&columns),
            Err(_) => None,
        }
    } else {
        None
    };

    let pipeline_result = if let Some(pk_col) = shard_pk {
        // ── Shard Mode: N independent reader+writer pipelines ────────────
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "SYSTEM",
            &format!("[{}] Using Shard mode: {} shards on column '{}'", mapping_label, parallelism, pk_col),
        );
        if parallelism > 5 {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] parallelism({}) exceeds default pool_max_connections(5); writes may queue", mapping_label, parallelism),
            );
        }

        let mut shard_handles = Vec::new();
        for shard_id in 0..parallelism {
            let shard_query = build_shard_query(&source_query, &pk_col, shard_id, parallelism, &src_cfg.driver);
            let shard_label = format!("{}[shard:{}/{}]", mapping_label, shard_id, parallelism);
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "SYSTEM",
                &format!("[{}] SQL: {}", shard_label,
                    if shard_query.len() > 200 { &shard_query[..200] } else { &shard_query }),
            );
            let handle = tokio::spawn(run_reader_writer_pair(
                shard_query,
                src_ds.clone(),
                dst_ds.clone(),
                target_table.clone(),
                dst_driver.clone(),
                mapped_cols.clone(),
                conflict_strategy.clone(),
                upsert_keys.clone(),
                read_batch_size,
                write_batch_size,
                channel_cap,
                error_limit,
                1, // each shard is single-writer
                cancel.clone(),
                mapping_stats.clone(),
                global_stats.clone(),
                app.clone(),
                job_id,
                run_id.to_string(),
                shard_label,
            ));
            shard_handles.push(handle);
        }

        let mut shard_errors = Vec::new();
        for (i, handle) in shard_handles.into_iter().enumerate() {
            match handle.await {
                Err(e) => shard_errors.push(format!("shard {} panicked: {}", i, e)),
                Ok(Err(e)) => shard_errors.push(format!("shard {} failed: {}", i, e)),
                Ok(Ok(())) => {}
            }
        }
        if shard_errors.is_empty() { Ok(()) } else {
            Err(AppError::Other(format!("Shard errors: {}", shard_errors.join("; "))))
        }
    } else {
        // ── Semaphore Mode: 1 reader + N concurrent writers ──────────────
        // When parallelism=1, semaphore degenerates to sequential (no overhead)
        if parallelism > 1 {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "SYSTEM",
                &format!("[{}] Using Semaphore mode: 1 reader + {} concurrent writers", mapping_label, parallelism),
            );
            if parallelism > 5 {
                logs.lock().unwrap().emit_and_record(
                    app, job_id, run_id, "WARN",
                    &format!("[{}] parallelism({}) exceeds default pool_max_connections(5); writes may queue", mapping_label, parallelism),
                );
            }
        }
        run_reader_writer_pair(
            source_query,
            src_ds,
            dst_ds,
            target_table.clone(),
            dst_driver.clone(),
            mapped_cols,
            conflict_strategy.clone(),
            upsert_keys.clone(),
            read_batch_size,
            write_batch_size,
            channel_cap,
            error_limit,
            parallelism,
            cancel.clone(),
            mapping_stats.clone(),
            global_stats.clone(),
            app.clone(),
            job_id,
            run_id.to_string(),
            mapping_label.clone(),
        ).await
    };

    stats_handle.abort();
    pipeline_result?;

    let written = mapping_stats.rows_written.load(Ordering::Relaxed);
    let failed = mapping_stats.rows_failed.load(Ordering::Relaxed);
    let read = mapping_stats.rows_read.load(Ordering::Relaxed);
    Ok(format!("read={} written={} failed={}", read, written, failed))
}

// ── PK detection for shard mode ──────────────────────────────────────────────

fn detect_integer_pk(columns: &[crate::datasource::ColumnMeta]) -> Option<String> {
    let integer_patterns = [
        "int", "integer", "bigint", "smallint", "tinyint", "mediumint",
        "serial", "bigserial", "smallserial", "int2", "int4", "int8", "number",
    ];
    columns.iter()
        .find(|c| {
            c.is_primary_key && {
                let dt = c.data_type.to_lowercase();
                integer_patterns.iter().any(|p| dt.contains(p))
            }
        })
        .map(|c| c.name.clone())
}

// ── Shard query builder ──────────────────────────────────────────────────────

fn build_shard_query(
    original_query: &str,
    pk_col: &str,
    shard_id: usize,
    total_shards: usize,
    driver: &str,
) -> String {
    let shard_condition = match driver {
        "mysql" | "tidb" | "doris" => format!(
            "MOD(`{}`, {}) = {}", pk_col.replace('`', "``"), total_shards, shard_id
        ),
        "clickhouse" => format!(
            "modulo(`{}`, {}) = {}", pk_col.replace('`', "``"), total_shards, shard_id
        ),
        "sqlserver" => format!(
            "([{}] % {}) = {}", pk_col.replace(']', "]]"), total_shards, shard_id
        ),
        "sqlite" => format!(
            "(\"{}\" % {}) = {}", pk_col.replace('"', "\"\""), total_shards, shard_id
        ),
        // postgres, gaussdb, db2
        _ => format!(
            "MOD(\"{}\", {}) = {}", pk_col.replace('"', "\"\""), total_shards, shard_id
        ),
    };
    format!(
        "SELECT * FROM ({}) AS _mig_shard_ WHERE {}",
        original_query, shard_condition
    )
}

// ── Reader + Writer sub-pipeline (reusable per shard or full table) ──────────

#[allow(clippy::too_many_arguments)]
async fn run_reader_writer_pair(
    source_query: String,
    src_ds: Arc<dyn crate::datasource::DataSource>,
    dst_ds: Arc<dyn crate::datasource::DataSource>,
    target_table: String,
    dst_driver: String,
    mapped_cols: Option<Vec<String>>,
    conflict_strategy: ConflictStrategy,
    upsert_keys: Vec<String>,
    read_batch_size: usize,
    write_batch_size: usize,
    channel_cap: usize,
    error_limit: usize,
    writer_parallelism: usize,
    cancel: Arc<AtomicBool>,
    mapping_stats: Arc<PipelineStats>,
    global_stats: Arc<PipelineStats>,
    app: AppHandle,
    job_id: i64,
    run_id: String,
    label: String,
) -> AppResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Batch>(channel_cap);

    // ── Reader task ───────────────────────────────────────────────────
    let ms_reader = mapping_stats.clone();
    let gs_reader = global_stats.clone();
    let cancel_r = cancel.clone();
    let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let mut offset = 0usize;
        let mut columns_opt: Option<Vec<String>> = None;
        loop {
            if cancel_r.load(Ordering::Relaxed) {
                break;
            }
            let page = src_ds.execute_paginated(&source_query, read_batch_size, offset).await?;
            if page.rows.is_empty() {
                break;
            }
            let fetched = page.rows.len();
            if columns_opt.is_none() {
                columns_opt = Some(page.columns.clone());
            }
            for row in &page.rows {
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
            }
            ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            let batch = Batch {
                rows: page.rows,
                column_names: columns_opt.as_ref().unwrap().clone(),
            };
            if tx.send(batch).await.is_err() {
                break;
            }
            if fetched < read_batch_size {
                break;
            }
            offset += fetched;
        }
        Ok(())
    });

    // ── Writer task (semaphore-controlled concurrent writes) ──────────
    let ms_writer = mapping_stats.clone();
    let gs_writer = global_stats.clone();
    let app_writer = app.clone();
    let run_id_w = run_id.clone();
    let cancel_w = cancel.clone();
    let label_w = label.clone();
    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(writer_parallelism));
        let (result_tx, mut result_rx) =
            tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();
        let mut error_count = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_columns: Vec<String> = Vec::new();

        while let Some(batch) = rx.recv().await {
            if cancel_w.load(Ordering::Relaxed) {
                break;
            }
            if buf_columns.is_empty() {
                buf_columns = mapped_cols
                    .clone()
                    .unwrap_or_else(|| batch.column_names.clone());
            }
            for row in batch.rows {
                write_buf.push(row);
                if write_buf.len() >= write_batch_size {
                    // Drain completed writes (non-blocking)
                    while let Ok((ok, fail)) = result_rx.try_recv() {
                        ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                        gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                        error_count += fail as usize;
                    }
                    if error_limit > 0 && error_count >= error_limit {
                        return Err(AppError::Other(format!(
                            "Error limit ({}) exceeded: {} errors", error_limit, error_count
                        )));
                    }

                    let rows_to_write = std::mem::replace(
                        &mut write_buf,
                        Vec::with_capacity(write_batch_size),
                    );
                    let permit = semaphore.clone().acquire_owned().await
                        .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
                    let dst_clone = dst_ds.clone();
                    let table_clone = target_table.clone();
                    let cols_clone = buf_columns.clone();
                    let cs_clone = conflict_strategy.clone();
                    let uk_clone = upsert_keys.clone();
                    let drv_clone = dst_driver.clone();
                    let rtx = result_tx.clone();
                    let app_clone = app_writer.clone();
                    let lbl = label_w.clone();
                    let rid = run_id_w.clone();

                    tokio::spawn(async move {
                        let (ok, fail) = match write_batch(
                            &*dst_clone, &table_clone, &cols_clone,
                            &rows_to_write, &cs_clone, &uk_clone, &drv_clone,
                        ).await {
                            Ok(n) => (n as u64, 0u64),
                            Err(e) => {
                                emit_log(&app_clone, job_id, &rid, "WARN",
                                    &format!("[{}] Batch write failed ({}), retrying row-by-row…", lbl, e));
                                let mut row_ok = 0u64;
                                let mut row_fail = 0u64;
                                for single_row in &rows_to_write {
                                    match write_batch(
                                        &*dst_clone, &table_clone, &cols_clone,
                                        std::slice::from_ref(single_row),
                                        &cs_clone, &uk_clone, &drv_clone,
                                    ).await {
                                        Ok(n) => row_ok += n as u64,
                                        Err(_) => row_fail += 1,
                                    }
                                }
                                if row_fail > 0 {
                                    emit_log(&app_clone, job_id, &rid, "ERROR",
                                        &format!("[{}] Row-by-row retry: {} succeeded, {} failed", lbl, row_ok, row_fail));
                                }
                                (row_ok, row_fail)
                            }
                        };
                        let _ = rtx.send((ok, fail));
                        drop(permit);
                    });
                }
            }
        }

        // Flush remainder
        if !write_buf.is_empty() {
            let _permit = semaphore.clone().acquire_owned().await
                .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
            match write_batch(
                &*dst_ds, &target_table, &buf_columns, &write_buf,
                &conflict_strategy, &upsert_keys, &dst_driver,
            ).await {
                Ok(n) => {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    emit_log(&app_writer, job_id, &run_id_w, "WARN",
                        &format!("[{}] Final flush failed ({}), retrying row-by-row…", label_w, e));
                    let mut row_ok = 0u64;
                    let mut row_fail = 0u64;
                    for single_row in &write_buf {
                        match write_batch(
                            &*dst_ds, &target_table, &buf_columns,
                            std::slice::from_ref(single_row),
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => row_ok += n as u64,
                            Err(_) => row_fail += 1,
                        }
                    }
                    ms_writer.rows_written.fetch_add(row_ok, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(row_ok, Ordering::Relaxed);
                    ms_writer.rows_failed.fetch_add(row_fail, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(row_fail, Ordering::Relaxed);
                    error_count += row_fail as usize;
                    if row_fail > 0 {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] Final flush row-by-row: {} succeeded, {} failed", label_w, row_ok, row_fail));
                    }
                }
            }
        }

        // Wait for all pending concurrent writes to complete
        drop(result_tx);
        while let Some((ok, fail)) = result_rx.recv().await {
            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
            error_count += fail as usize;
        }

        // Final error limit check (covers flush remainder + all pending writes)
        if error_limit > 0 && error_count >= error_limit {
            return Err(AppError::Other(format!(
                "Error limit ({}) exceeded: {} errors", error_limit, error_count
            )));
        }

        Ok(())
    });

    // ── Await both tasks ─────────────────────────────────────────────
    let reader_result = reader_handle.await;
    let writer_result = writer_handle.await;

    if let Err(e) = &reader_result {
        return Err(AppError::Other(format!("[{}] Reader panicked: {}", label, e)));
    }
    if let Err(e) = &writer_result {
        return Err(AppError::Other(format!("[{}] Writer panicked: {}", label, e)));
    }
    if let Ok(Err(e)) = reader_result {
        return Err(e);
    }
    if let Ok(Err(e)) = writer_result {
        return Err(e);
    }

    Ok(())
}

// ── Build source SQL ──────────────────────────────────────────────────────────

fn build_source_query(config: &MigrationJobConfig, mapping: &TableMapping) -> AppResult<String> {
    let base_query = if config.source.query_mode == QueryMode::Custom {
        config.source.custom_query.clone().unwrap_or_default()
    } else {
        format!("SELECT * FROM {}", mapping.source_table)
    };

    if base_query.trim().is_empty() {
        return Err(AppError::Other(format!(
            "Empty source query for mapping {}→{}",
            mapping.source_table, mapping.target.table
        )));
    }

    let mut conditions = Vec::new();

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

    if let Some(ref filter) = mapping.filter_condition {
        let trimmed = filter.trim();
        if !trimmed.is_empty() {
            let condition = trimmed
                .strip_prefix("WHERE ")
                .or_else(|| trimmed.strip_prefix("where "))
                .unwrap_or(trimmed);
            conditions.push(condition.to_string());
        }
    }

    if conditions.is_empty() {
        Ok(base_query)
    } else {
        Ok(format!(
            "SELECT * FROM ({}) AS _mig_src_ WHERE {}",
            base_query,
            conditions.join(" AND ")
        ))
    }
}

// ── Auto-create target table ──────────────────────────────────────────────────

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
        emit_log(
            app,
            job_id,
            run_id,
            "WARN",
            &format!(
                "[{}] Cannot auto-create: source table schema unavailable",
                mapping_label
            ),
        );
        return Ok(());
    }

    let type_overrides: HashMap<String, String> = column_mappings
        .iter()
        .filter(|m| !m.target_type.is_empty())
        .map(|m| (m.source_expr.clone(), m.target_type.clone()))
        .collect();

    let ddl = super::ddl_convert::generate_create_table_ddl(
        src_driver,
        dst_driver,
        target_table,
        &columns,
        &type_overrides,
    );

    emit_log(
        app,
        job_id,
        run_id,
        "DDL",
        &format!(
            "[{}] Auto-create DDL: {}",
            mapping_label,
            if ddl.len() > 300 { &ddl[..300] } else { &ddl }
        ),
    );

    dst_ds.execute(&ddl).await?;
    Ok(())
}

// ── Writeback incremental checkpoint ─────────────────────────────────────────

async fn writeback_incremental_checkpoint(
    job_id: i64,
    config: &MigrationJobConfig,
    app: &AppHandle,
    run_id: &str,
) {
    let Some(ref inc) = config.incremental_config else {
        return;
    };
    let src_conn_id = config.source.connection_id;
    let Ok(src_cfg) = crate::db::get_connection_config(src_conn_id) else {
        return;
    };
    let src_db = if config.source.database.is_empty() {
        src_cfg.database.clone().unwrap_or_default()
    } else {
        config.source.database.clone()
    };
    let Ok(src_ds) = crate::datasource::pool_cache::get_or_create(
        src_conn_id,
        &src_cfg,
        &src_db,
        "",
    )
    .await
    else {
        return;
    };

    for mapping in &config.table_mappings {
        let sql = format!("SELECT MAX({}) FROM {}", inc.field, mapping.source_table);
        if let Ok(result) = src_ds.execute(&sql).await {
            if let Some(max_val) = result
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| Some(v.to_string())))
            {
                if max_val != "null" {
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
                    emit_log(
                        app,
                        job_id,
                        run_id,
                        "SYSTEM",
                        &format!(
                            "Incremental checkpoint updated: {} = {}",
                            inc.field, max_val
                        ),
                    );
                    return;
                }
            }
        }
    }
}

// ── Batch write helper ────────────────────────────────────────────────────────

/// Build and execute a multi-row INSERT for `table` using the active datasource.
/// Uses driver-aware escaping and conflict strategy to avoid SQL injection and data corruption.
/// Returns the number of rows that were inserted.
async fn write_batch(
    ds: &dyn crate::datasource::DataSource,
    table: &str,
    columns: &[String],
    rows: &[Row],
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> AppResult<usize> {
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }

    let quote_col: fn(&str) -> String = match driver {
        "mysql" | "doris" | "tidb" | "clickhouse" => |c| format!("`{}`", c.replace('`', "``")),
        "sqlserver" => |c| format!("[{}]", c.replace(']', "]]")),
        _ => |c| format!("\"{}\"", c.replace('"', "\"\"")),
    };

    let key_set: std::collections::HashSet<&str> =
        upsert_keys.iter().map(|s| s.as_str()).collect();

    let (keyword, suffix): (&str, std::borrow::Cow<str>) = match (conflict_strategy, driver) {
        (ConflictStrategy::Skip, "sqlite") => ("INSERT OR IGNORE INTO", "".into()),
        (ConflictStrategy::Replace, "sqlite") => ("INSERT OR REPLACE INTO", "".into()),
        (ConflictStrategy::Skip, "mysql" | "doris" | "tidb") => ("INSERT IGNORE INTO", "".into()),
        (ConflictStrategy::Replace, "mysql" | "doris" | "tidb") => ("REPLACE INTO", "".into()),
        (ConflictStrategy::Skip, "postgres" | "gaussdb") => {
            ("INSERT INTO", " ON CONFLICT DO NOTHING".into())
        }
        // Upsert for MySQL-compatible: INSERT INTO ... ON DUPLICATE KEY UPDATE col=VALUES(col)
        (ConflictStrategy::Upsert, "mysql" | "doris" | "tidb") => {
            let update_parts: Vec<String> = columns
                .iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=VALUES({})", quote_col(c), quote_col(c)))
                .collect();
            if update_parts.is_empty() {
                ("INSERT IGNORE INTO", "".into())
            } else {
                (
                    "INSERT INTO",
                    format!(" ON DUPLICATE KEY UPDATE {}", update_parts.join(", ")).into(),
                )
            }
        }
        // Upsert for PostgreSQL / GaussDB: INSERT INTO ... ON CONFLICT (keys) DO UPDATE SET col=EXCLUDED.col
        (ConflictStrategy::Upsert, "postgres" | "gaussdb") => {
            let update_parts: Vec<String> = columns
                .iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=EXCLUDED.{}", quote_col(c), quote_col(c)))
                .collect();
            if upsert_keys.is_empty() || update_parts.is_empty() {
                ("INSERT INTO", " ON CONFLICT DO NOTHING".into())
            } else {
                let key_cols = upsert_keys
                    .iter()
                    .map(|k| quote_col(k))
                    .collect::<Vec<_>>()
                    .join(", ");
                (
                    "INSERT INTO",
                    format!(
                        " ON CONFLICT ({}) DO UPDATE SET {}",
                        key_cols,
                        update_parts.join(", ")
                    )
                    .into(),
                )
            }
        }
        // Upsert for SQLite (3.24+): INSERT INTO ... ON CONFLICT (keys) DO UPDATE SET col=excluded.col
        (ConflictStrategy::Upsert, "sqlite") => {
            let update_parts: Vec<String> = columns
                .iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=excluded.{}", quote_col(c), quote_col(c)))
                .collect();
            if upsert_keys.is_empty() || update_parts.is_empty() {
                ("INSERT OR REPLACE INTO", "".into())
            } else {
                let key_cols = upsert_keys
                    .iter()
                    .map(|k| quote_col(k))
                    .collect::<Vec<_>>()
                    .join(", ");
                (
                    "INSERT INTO",
                    format!(
                        " ON CONFLICT ({}) DO UPDATE SET {}",
                        key_cols,
                        update_parts.join(", ")
                    )
                    .into(),
                )
            }
        }
        // Replace for PostgreSQL/GaussDB: INSERT INTO ... ON CONFLICT (keys) DO UPDATE SET all_cols=EXCLUDED.col
        // Without upsert_keys, fall back to Skip (ON CONFLICT DO NOTHING) — warning already emitted upstream
        (ConflictStrategy::Replace, "postgres" | "gaussdb") => {
            if upsert_keys.is_empty() {
                ("INSERT INTO", " ON CONFLICT DO NOTHING".into())
            } else {
                let update_parts: Vec<String> = columns
                    .iter()
                    .map(|c| format!("{}=EXCLUDED.{}", quote_col(c), quote_col(c)))
                    .collect();
                let key_cols = upsert_keys
                    .iter()
                    .map(|k| quote_col(k))
                    .collect::<Vec<_>>()
                    .join(", ");
                (
                    "INSERT INTO",
                    format!(
                        " ON CONFLICT ({}) DO UPDATE SET {}",
                        key_cols,
                        update_parts.join(", ")
                    )
                    .into(),
                )
            }
        }
        // Overwrite: table was already truncated; use plain INSERT
        (ConflictStrategy::Overwrite, _) => ("INSERT INTO", "".into()),
        _ => ("INSERT INTO", "".into()),
    };

    let col_list = columns
        .iter()
        .map(|c| quote_col(c))
        .collect::<Vec<_>>()
        .join(", ");
    let quoted_table = quote_col(table);

    let escape_style = ds.string_escape_style();
    let row_placeholders: Vec<String> = rows
        .iter()
        .map(|row| {
            let vals: Vec<String> = row
                .iter()
                .map(|v| crate::datasource::utils::value_to_sql_safe(v, &escape_style))
                .collect();
            format!("({})", vals.join(", "))
        })
        .collect();

    let sql = format!(
        "{} {} ({}) VALUES {}{}",
        keyword,
        quoted_table,
        col_list,
        row_placeholders.join(", "),
        suffix,
    );

    let result = ds.execute(&sql).await?;
    // Use actual rows_affected from the driver (MySQL/PG already return this correctly).
    // Cap at rows.len() to handle MySQL double-count for ON DUPLICATE KEY UPDATE / REPLACE INTO.
    Ok(result.row_count.min(rows.len()))
}
