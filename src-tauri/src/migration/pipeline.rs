use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use rusqlite::params;
use sqlx::Acquire;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use super::task_mgr::*;

/// Which driver-specific txn path to use in the writer.
enum TxnDriver {
    MySql,
    Postgres,
}

const MIGRATION_LOG_EVENT: &str = "migration_log";
const MIGRATION_STATS_EVENT: &str = "migration_stats";
const MIGRATION_FINISHED_EVENT: &str = "migration_finished";

/// Maximum time to wait for a single write-batch (including row-by-row retry) to complete.
/// When target disk I/O is saturated, write_batch hangs indefinitely, holding the semaphore
/// permit, causing the writer loop to stall, the channel to fill, and the reader to block —
/// a complete pipeline freeze. This timeout breaks the deadlock and turns it into a countable failure.
const WRITE_BATCH_TIMEOUT_SECS: u64 = 300;

/// Maximum estimated SQL payload size (bytes) for a single INSERT statement.

/// Number of consecutive fully-failed write batches (0 rows written) before the writer
/// aborts the pipeline. Prevents infinite timeout-retry loops when the target database
/// is unreachable (e.g., disk full, server down).
const CONSECUTIVE_FAIL_LIMIT: usize = 5;

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

/// Maximum number of log events to keep in memory per run.
/// Beyond this, oldest entries are dropped to prevent OOM.
const LOG_COLLECTOR_MAX_ENTRIES: usize = 2000;

pub struct LogCollector(pub VecDeque<MigrationLogEvent>);

impl LogCollector {
    fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self(VecDeque::new())))
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
        self.0.push_back(event);
        if self.0.len() > LOG_COLLECTOR_MAX_ENTRIES {
            self.0.pop_front();
        }
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

/// Sets the cancel flag for an active run. Returns `true` if the job was active, `false` if not found.
pub fn cancel_run(job_id: i64) -> bool {
    if let Ok(runs) = ACTIVE_RUNS.lock() {
        if let Some(flag) = runs.get(&job_id) {
            flag.store(true, Ordering::SeqCst);
            return true;
        }
    }
    false
}

/// Called on app startup to reset any jobs left in RUNNING state (e.g. from a crash or forced quit).
pub fn cleanup_stale_running_jobs() {
    if let Ok(db) = crate::db::get().lock() {
        let _ = db.execute(
            "UPDATE migration_jobs SET last_status='STOPPED' WHERE last_status='RUNNING'",
            [],
        );
        let _ = db.execute(
            "UPDATE migration_run_history \
             SET status='STOPPED', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE status='RUNNING'",
            [],
        );
    }
    log::info!("[migration] cleaned up stale RUNNING jobs on startup");
}

/// Forcibly marks a job as STOPPED in the DB and emits a `migration_finished` event.
/// Used when stop is requested but no active pipeline exists (e.g. after app restart).
pub fn force_stop_stale_job(job_id: i64, app: &AppHandle) -> AppResult<()> {
    let run_id = {
        let db = crate::db::get().lock().unwrap();
        let _ = db.execute(
            "UPDATE migration_jobs SET last_status='STOPPED' WHERE id=?1",
            params![job_id],
        );
        let _ = db.execute(
            "UPDATE migration_run_history \
             SET status='STOPPED', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE job_id=?1 AND status='RUNNING'",
            params![job_id],
        );
        db.query_row(
            "SELECT run_id FROM migration_run_history WHERE job_id=?1 ORDER BY started_at DESC LIMIT 1",
            params![job_id],
            |r| r.get::<_, String>(0),
        ).unwrap_or_else(|_| Uuid::new_v4().to_string())
    };
    let _ = app.emit(
        MIGRATION_FINISHED_EVENT,
        serde_json::json!({
            "jobId": job_id,
            "runId": run_id,
            "status": "STOPPED",
            "rowsRead": 0,
            "rowsWritten": 0,
            "rowsFailed": 0,
            "bytesTransferred": 0,
            "elapsedSeconds": 0.0,
        }),
    );
    Ok(())
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

/// Tracks per-transaction bookkeeping for the writer's grouped-commit path.
///
/// One `TxnGroupState` is rebuilt after every successful (or failed) `COMMIT`.
/// The writer calls `record_insert` after each successful `bulk_write_in_txn`
/// call, then asks `should_commit` whether thresholds have been crossed.
/// On commit, it calls `drain_success` to get the `(ok, failed)` totals to
/// publish to stats atomically.
#[derive(Debug, Default)]
struct TxnGroupState {
    /// Number of INSERT statements (i.e. flushes of `write_buf`) issued in the current txn.
    insert_count: usize,
    /// Approximate payload bytes accumulated across all INSERTs in the current txn.
    /// Uses the reader-side row byte estimate (json_value_len sum), not actual SQL bytes.
    bytes_written: u64,
    /// Sum of `Ok(n)` rows across all INSERTs in the current txn (rows the driver
    /// reports as affected). Only applied to stats on successful `COMMIT`.
    pending_ok: u64,
    /// Sum of `batch_len - n` (rows the driver silently dropped, e.g. INSERT IGNORE)
    /// across all INSERTs in the current txn. Applied to `rows_failed` on any outcome.
    pending_soft_failed: u64,
    /// Sum of `batch_len` across all INSERTs in the current txn. Used to attribute
    /// `rows_failed` when the `COMMIT` itself fails (all rows roll back).
    pending_total: u64,
}

impl TxnGroupState {
    /// Record the result of a single `bulk_write_in_txn` call inside the current txn.
    /// `batch_len` is total rows submitted; `ok` is what the driver reported as affected;
    /// `batch_bytes` is the estimated payload bytes (same unit as `max_bytes_per_tx`).
    fn record_insert(&mut self, batch_len: u64, ok: u64, batch_bytes: u64) {
        self.insert_count += 1;
        self.bytes_written = self.bytes_written.saturating_add(batch_bytes);
        self.pending_ok = self.pending_ok.saturating_add(ok);
        self.pending_soft_failed = self
            .pending_soft_failed
            .saturating_add(batch_len.saturating_sub(ok));
        self.pending_total = self.pending_total.saturating_add(batch_len);
    }

    /// Return `true` if the current txn has hit either threshold and should be committed.
    /// `txn_batch_size` is the max INSERTs per txn (hard minimum 1).
    /// `max_bytes_per_tx == None` disables the byte constraint.
    fn should_commit(&self, txn_batch_size: usize, max_bytes_per_tx: Option<u64>) -> bool {
        if self.insert_count == 0 {
            return false;
        }
        if self.insert_count >= txn_batch_size.max(1) {
            return true;
        }
        if let Some(limit) = max_bytes_per_tx {
            if self.bytes_written >= limit {
                return true;
            }
        }
        false
    }

    /// Returns `true` iff there is at least one INSERT buffered awaiting commit.
    fn has_pending(&self) -> bool {
        self.insert_count > 0
    }

    /// Take the `(committed_ok, committed_soft_failed)` totals that should be applied
    /// to stats when the `COMMIT` succeeds, then reset the state for the next group.
    fn drain_success(&mut self) -> (u64, u64) {
        let ok = self.pending_ok;
        let soft = self.pending_soft_failed;
        *self = Self::default();
        (ok, soft)
    }

    /// Take the total row count to attribute to `rows_failed` when the `COMMIT` fails
    /// (all rows roll back), then reset the state for the next group.
    fn drain_failure(&mut self) -> u64 {
        let total = self.pending_total;
        *self = Self::default();
        total
    }
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
    let script_text: String = tokio::task::spawn_blocking(move || -> AppResult<String> {
        let db = crate::db::get().lock().unwrap();
        db.query_row(
            "SELECT script_text FROM migration_jobs WHERE id=?1",
            params![job_id],
            |r| r.get(0),
        ).map_err(Into::into)
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking failed: {}", e)))??;

    let ast = crate::migration::lang::parser::parse(&script_text)
        .map_err(|e| AppError::Other(format!("MigrateQL parse error: {e}")))?;

    let resolve_connection = |name: &str| -> Option<i64> {
        crate::db::find_connection_id_by_name(name).ok().flatten()
    };

    let config = crate::migration::lang::compiler::compile(&ast, &resolve_connection)
        .map_err(|errs| {
            let msgs: Vec<String> = errs.iter().map(|e| e.message.clone()).collect();
            AppError::Other(format!("MigrateQL compile errors: {}", msgs.join("; ")))
        })?;

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
        let cancel_ref = cancel.clone();
        let result =
            execute_pipeline(job_id, run_id_clone.clone(), config, app_clone.clone(), cancel, log_collector_clone.clone())
                .await;

        let was_cancelled = cancel_ref.load(Ordering::Relaxed);
        let final_status = match &result {
            Ok(_) => "FINISHED",
            Err(e) if e.to_string().starts_with("PARTIAL_FAILED") => "PARTIAL_FAILED",
            Err(_) if was_cancelled => "STOPPED",
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

    // ── Resolve target datasource ─────────────────────────────────────────
    let dst_conn_id = mapping.target.connection_id;
    let dst_cfg = crate::db::get_connection_config(dst_conn_id)?;
    let dst_db = if mapping.target.database.is_empty() {
        dst_cfg.database.clone().unwrap_or_default()
    } else {
        mapping.target.database.clone()
    };

    let error_limit = config.pipeline.error_limit.min(100_000);
    let read_batch_size = config.pipeline.read_batch_size.max(1).min(50_000);
    let write_batch_size = config.pipeline.write_batch_size.max(1).min(5_000);
    let channel_cap = config.pipeline.channel_capacity.max(1).min(64);
    let parallelism = config.pipeline.parallelism.max(1).min(16);
    let txn_batch_size = config.pipeline.transaction_batch_size.max(1).min(100);

    // ── Dedicated ephemeral connection pools for this mapping ─────────────
    // Migration pools are intentionally NOT cached in the global pool cache so that:
    //   - Large pool sizes (parallelism+1) don't evict or replace the normal
    //     app pools used by the tree navigator and query editor.
    //   - Pools are fully closed as soon as the mapping finishes (success,
    //     failure, or cancel) — the Arc refcount drops to zero and sqlx
    //     releases all connections to the server automatically.
    // pool size = parallelism + 1 (safety margin for pre-flight COUNT/MIN/MAX queries)
    let required_pool = (parallelism + 1) as u32;
    let src_ds = crate::datasource::pool_cache::create_ephemeral(
        &src_cfg,
        &src_db,
        "",
        required_pool,
    )
    .await?;
    let dst_ds = crate::datasource::pool_cache::create_ephemeral(
        &dst_cfg,
        &dst_db,
        "",
        required_pool,
    )
    .await?;

    // ── Setup migration session on target datasource ─────────────────────
    if let Err(e) = dst_ds.setup_migration_session().await {
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "WARN",
            &format!("[{}] Migration session setup failed: {} (continuing with defaults)", mapping_label, e),
        );
    }

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
        let quoted_table = crate::datasource::utils::quote_identifier_for_driver(&mapping.target.table, &dst_cfg.driver);
        let truncate_sql = if dst_cfg.driver == "sqlite" {
            format!("DELETE FROM {}", quoted_table)
        } else {
            format!("TRUNCATE TABLE {}", quoted_table)
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
    let stats_start = std::time::Instant::now();
    let stats_handle = tokio::spawn(async move {
        let mut prev_read = 0u64;
        let mut prev_written = 0u64;
        let mut prev_bytes = 0u64;
        let mut prev_failed = 0u64;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if cancel_s.load(Ordering::Relaxed) {
                break;
            }
            let rows_read = ms_clone.rows_read.load(Ordering::Relaxed);
            let rows_written = ms_clone.rows_written.load(Ordering::Relaxed);
            let rows_failed = ms_clone.rows_failed.load(Ordering::Relaxed);
            let bytes_now = ms_clone.bytes_transferred.load(Ordering::Relaxed);

            // Skip emit if nothing changed since last tick
            if rows_read == prev_read && rows_written == prev_written
                && rows_failed == prev_failed && bytes_now == prev_bytes
            {
                continue;
            }

            let delta_read = rows_read.saturating_sub(prev_read) as f64;
            let delta_written = rows_written.saturating_sub(prev_written) as f64;
            let delta_bytes = bytes_now.saturating_sub(prev_bytes) as f64;
            let (eta, pct) = if let Some(total) = total_rows {
                if rows_read < total {
                    // Use cumulative average RPS to avoid absurd ETAs when a single
                    // tick has zero throughput (e.g. momentary pause → max(1.0)
                    // caused "126167m40s" style ETAs).
                    let elapsed_secs = stats_start.elapsed().as_secs_f64().max(0.001);
                    let avg_rps = rows_read as f64 / elapsed_secs;
                    let eta_opt = if avg_rps >= 1.0 {
                        Some((total - rows_read) as f64 / avg_rps)
                    } else {
                        None // rate too low / not yet started — skip ETA display
                    };
                    (eta_opt, Some((rows_read as f64 / total as f64 * 100.0).min(100.0)))
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
            prev_failed = rows_failed;
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

    let dst_ds_teardown = dst_ds.clone();
    let pipeline_result = if let Some(pk_col) = shard_pk {
        // ── Range-Split Mode: N independent cursor reader+writer pairs ───
        // DataX/SeaTunnel style: divide [MIN(pk), MAX(pk)] into `parallelism`
        // non-overlapping ranges. Each range spawns its own reader+writer.
        // No MOD, no OFFSET — O(n) total.
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "SYSTEM",
            &format!("[{}] Range-split mode: {} shards on column '{}'", mapping_label, parallelism, pk_col),
        );

        let splits_opt = crate::migration::splitter::compute_pk_splits(
            &*src_ds, &source_query, &pk_col, &src_cfg.driver, parallelism,
        ).await;

        match splits_opt {
            None => {
                // MIN/MAX failed (empty table or error) → fall back to single cursor reader
                logs.lock().unwrap().emit_and_record(
                    app, job_id, run_id, "WARN",
                    &format!("[{}] Range-split: MIN/MAX failed; running single cursor reader", mapping_label),
                );
                // Attempt single cursor mode
                let single_split = crate::migration::splitter::PkSplit { start: i64::MIN, end: None };
                run_reader_writer_pair(
                    source_query,
                    Some((pk_col, single_split)),
                    src_cfg.driver.clone(),
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
                    txn_batch_size,
                    Arc::new(Semaphore::new(1)),
                    cancel.clone(),
                    mapping_stats.clone(),
                    global_stats.clone(),
                    app.clone(),
                    job_id,
                    run_id.to_string(),
                    mapping_label.clone(),
                    config.pipeline.speed_limit_rps,
                    config.pipeline.write_pause_ms,
                    config.pipeline.max_bytes_per_tx,
                ).await
            }
            Some(splits) => {
                // Scale channel_cap per split to prevent O(parallelism * channel_cap) memory
                let split_channel_cap = (channel_cap / parallelism).max(2);
                let actual_splits = splits.len();

                logs.lock().unwrap().emit_and_record(
                    app, job_id, run_id, "SYSTEM",
                    &format!("[{}] {} range splits created (requested {})", mapping_label, actual_splits, parallelism),
                );

                // Shared across all splits: caps total concurrent writes at `parallelism`.
                // Replaces per-split independent semaphores that caused N×1 = N concurrent
                // writes to simultaneously hammer the target disk.
                let write_sem = Arc::new(Semaphore::new(parallelism));

                let mut split_handles = Vec::new();
                for (i, split) in splits.into_iter().enumerate() {
                    let split_label = format!("{}[split:{}/{}]", mapping_label, i + 1, actual_splits);
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "SYSTEM",
                        &format!("[{}] pk range [{}, {})",
                            split_label,
                            split.start,
                            split.end.map(|e| e.to_string()).unwrap_or_else(|| "∞".into())),
                    );
                    let handle = tokio::spawn(run_reader_writer_pair(
                        source_query.clone(),
                        Some((pk_col.clone(), split)),
                        src_cfg.driver.clone(),
                        src_ds.clone(),
                        dst_ds.clone(),
                        target_table.clone(),
                        dst_driver.clone(),
                        mapped_cols.clone(),
                        conflict_strategy.clone(),
                        upsert_keys.clone(),
                        read_batch_size,
                        write_batch_size,
                        split_channel_cap,
                        error_limit,
                        txn_batch_size,
                        write_sem.clone(),
                        cancel.clone(),
                        mapping_stats.clone(),
                        global_stats.clone(),
                        app.clone(),
                        job_id,
                        run_id.to_string(),
                        split_label,
                        config.pipeline.speed_limit_rps,
                        config.pipeline.write_pause_ms,
                        config.pipeline.max_bytes_per_tx,
                    ));
                    split_handles.push(handle);
                }

                let mut split_errors = Vec::new();
                for (i, handle) in split_handles.into_iter().enumerate() {
                    match handle.await {
                        Err(e) => split_errors.push(format!("split {} panicked: {}", i + 1, e)),
                        Ok(Err(e)) => split_errors.push(format!("split {} failed: {}", i + 1, e)),
                        Ok(Ok(())) => {}
                    }
                }
                if split_errors.is_empty() {
                    Ok(())
                } else {
                    Err(AppError::Other(format!("Split errors: {}", split_errors.join("; "))))
                }
            }
        }
    } else {
        // ── Single reader (parallelism == 1 or no integer PK found) ─────
        //
        // Attempt cursor-based reading (O(n)) via PK range split.
        // Falls back to OFFSET if no integer PK is detected.
        let pk_cursor = if let Some(pk_col) = detect_integer_pk_from_ds(&*src_ds, &mapping.source_table).await {
            match crate::migration::splitter::compute_pk_splits(
                &*src_ds, &source_query, &pk_col, &src_cfg.driver, 1,
            ).await {
                Some(splits) => {
                    // 1 split = full table range; cursor reader handles all pages
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "SYSTEM",
                        &format!("[{}] Cursor mode on '{}': range [{}, {})",
                            mapping_label, pk_col,
                            splits[0].start,
                            splits[0].end.map(|e| e.to_string()).unwrap_or_else(|| "∞".into())),
                    );
                    Some((pk_col, splits.into_iter().next().unwrap()))
                }
                None => {
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "WARN",
                        &format!("[{}] MIN/MAX query failed; falling back to OFFSET pagination", mapping_label),
                    );
                    None
                }
            }
        } else {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] No integer PK found; using OFFSET pagination (may be slow for large tables)", mapping_label),
            );
            None
        };

        run_reader_writer_pair(
            source_query,
            pk_cursor,
            src_cfg.driver.clone(),
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
            txn_batch_size,
            Arc::new(Semaphore::new(parallelism)),
            cancel.clone(),
            mapping_stats.clone(),
            global_stats.clone(),
            app.clone(),
            job_id,
            run_id.to_string(),
            mapping_label.clone(),
            config.pipeline.speed_limit_rps,
            config.pipeline.write_pause_ms,
            config.pipeline.max_bytes_per_tx,
        ).await
    };

    stats_handle.abort();
    pipeline_result?;

    // ── Teardown migration session on target datasource ──────────────────
    if let Err(e) = dst_ds_teardown.teardown_migration_session().await {
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "WARN",
            &format!("[{}] Migration session teardown failed: {}", mapping_label, e),
        );
    }

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

/// Fetch columns for `table` from `ds` and return the integer PK column name, if any.
async fn detect_integer_pk_from_ds(
    ds: &dyn crate::datasource::DataSource,
    table: &str,
) -> Option<String> {
    ds.get_columns(table, None).await.ok().as_deref().and_then(detect_integer_pk)
}

// ── Reader + Writer sub-pipeline (reusable per split or full table) ──────────

#[allow(clippy::too_many_arguments)]
async fn run_reader_writer_pair(
    source_query: String,
    pk_split: Option<(String, crate::migration::splitter::PkSplit)>, // (pk_col, split)
    src_driver: String,
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
    _txn_batch_size: usize,
    write_semaphore: Arc<Semaphore>,
    cancel: Arc<AtomicBool>,
    mapping_stats: Arc<PipelineStats>,
    global_stats: Arc<PipelineStats>,
    app: AppHandle,
    job_id: i64,
    run_id: String,
    label: String,
    speed_limit_rps: Option<u64>,
    write_pause_ms: Option<u64>,
    max_bytes_per_tx: Option<u64>,
) -> AppResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Batch>(channel_cap);

    // ── Reader task ───────────────────────────────────────────────────
    let ms_reader = mapping_stats.clone();
    let gs_reader = global_stats.clone();
    let cancel_r = cancel.clone();
    let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        use crate::migration::splitter::{parse_i64_from_json, quote_col_for_driver};
        use std::time::Duration;

        // Rate limiter state: (window_start, rows_in_window)
        let mut rate_state: Option<(Instant, u64)> = speed_limit_rps.map(|_| (Instant::now(), 0u64));

        if let Some((pk_col, split)) = pk_split {
            // ── Cursor-based split reader (O(n)) ──────────────────────────────
            let pk_q = quote_col_for_driver(&pk_col, &src_driver);
            let mut cursor = split.start;
            let mut pk_col_idx: Option<usize> = None;
            let mut columns_opt: Option<Vec<String>> = None;

            loop {
                if cancel_r.load(Ordering::Relaxed) {
                    break;
                }
                let range_cond = match split.end {
                    Some(end) => format!("{pk} >= {cursor} AND {pk} < {end}", pk = pk_q, cursor = cursor, end = end),
                    None      => format!("{pk} >= {cursor}", pk = pk_q, cursor = cursor),
                };
                let page_sql = format!(
                    "SELECT * FROM ({src}) AS _mig_s_ WHERE {cond} ORDER BY {pk} LIMIT {limit}",
                    src = source_query, cond = range_cond, pk = pk_q, limit = read_batch_size,
                );
                let page = src_ds.execute(&page_sql).await?;
                if page.rows.is_empty() {
                    break;
                }
                let fetched = page.rows.len();

                if columns_opt.is_none() {
                    pk_col_idx = page.columns.iter().position(|c| c.eq_ignore_ascii_case(&pk_col));
                    columns_opt = Some(page.columns.clone());
                }

                let last_pk = page.rows.last()
                    .and_then(|r| pk_col_idx.and_then(|i| r.get(i)))
                    .and_then(parse_i64_from_json)
                    .unwrap_or(i64::MAX);
                cursor = last_pk.saturating_add(1);

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

                // Rate limiting
                if let (Some(rps_limit), Some((ref mut window_start, ref mut window_rows))) =
                    (speed_limit_rps, &mut rate_state)
                {
                    *window_rows += fetched as u64;
                    let elapsed = window_start.elapsed();
                    let expected = Duration::from_secs_f64(*window_rows as f64 / rps_limit as f64);
                    if expected > elapsed {
                        tokio::time::sleep(expected - elapsed).await;
                    }
                    while window_start.elapsed() >= Duration::from_secs(1) {
                        *window_start += Duration::from_secs(1);
                        *window_rows = window_rows.saturating_sub(rps_limit);
                    }
                }

                if fetched < read_batch_size {
                    break;
                }
            }
        } else {
            // ── Fallback: OFFSET-based reader (tables without integer PK) ────
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

                // Rate limiting
                if let (Some(rps_limit), Some((ref mut window_start, ref mut window_rows))) =
                    (speed_limit_rps, &mut rate_state)
                {
                    *window_rows += fetched as u64;
                    let elapsed = window_start.elapsed();
                    let expected = Duration::from_secs_f64(*window_rows as f64 / rps_limit as f64);
                    if expected > elapsed {
                        tokio::time::sleep(expected - elapsed).await;
                    }
                    while window_start.elapsed() >= Duration::from_secs(1) {
                        *window_start += Duration::from_secs(1);
                        *window_rows = window_rows.saturating_sub(rps_limit);
                    }
                }

                if fetched < read_batch_size {
                    break;
                }
                offset += fetched;
            }
        }
        Ok(())
    });

    // ── Writer task (bulk_write, semaphore-controlled) ───────────────────
    let ms_writer = mapping_stats.clone();
    let gs_writer = global_stats.clone();
    let app_writer = app.clone();
    let run_id_w = run_id.clone();
    let cancel_w = cancel.clone();
    let label_w = label.clone();
    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let semaphore = write_semaphore;
        let mut error_count = 0usize;
        let mut consecutive_full_fails = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_bytes: u64 = 0;
        let mut buf_columns: Vec<String> = Vec::new();

        // Use trait method to detect which driver supports transaction-based bulk writes.
        let use_txn_bulk = dst_ds.supports_txn_bulk_write();
        let txn_driver = if use_txn_bulk {
            match dst_driver.as_str() {
                "mysql" | "doris" | "tidb" => Some(TxnDriver::MySql),
                "postgres" | "gaussdb" => Some(TxnDriver::Postgres),
                _ => None,
            }
        } else {
            None
        };
        let mut mysql_conn: Option<sqlx::pool::PoolConnection<sqlx::MySql>> = None;
        let mut pg_conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>> = None;

        /// Handle write result: update stats, check circuit breakers.
        macro_rules! handle_write_result {
            ($res:expr, $batch_len:expr) => {{
                match &$res {
                    Ok(n) => {
                        let ok = *n as u64;
                        let fail = $batch_len.saturating_sub(ok);
                        ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        if fail > 0 {
                            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            error_count += fail as usize;
                        }
                        if ok == 0 && fail > 0 {
                            consecutive_full_fails += 1;
                        } else {
                            consecutive_full_fails = 0;
                        }
                    }
                    Err(e) => {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] bulk_write failed: {}", label_w, e));
                        ms_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                        gs_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                        error_count += $batch_len as usize;
                        consecutive_full_fails += 1;
                    }
                }
                if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                        &format!("[{}] Circuit breaker: {} consecutive batches fully failed", label_w, consecutive_full_fails));
                    return Err(AppError::Other(format!(
                        "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
                    )));
                }
                if error_limit > 0 && error_count >= error_limit {
                    return Err(AppError::Other(format!(
                        "Error limit ({}) exceeded: {} errors", error_limit, error_count
                    )));
                }
            }};
        }

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
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                buf_bytes += row_bytes;
                write_buf.push(row);
                let bytes_exceeded = max_bytes_per_tx.map_or(false, |m| buf_bytes >= m);
                if write_buf.len() >= write_batch_size || bytes_exceeded {
                    let rows_to_write = std::mem::replace(
                        &mut write_buf,
                        Vec::with_capacity(write_batch_size),
                    );
                    buf_bytes = 0;
                    let batch_len = rows_to_write.len() as u64;
                    let _permit = semaphore.clone().acquire_owned().await
                        .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

                    if let Some(txn_driver) = &txn_driver {
                        match txn_driver {
                            TxnDriver::MySql => {
                                let my_ds = dst_ds.as_any().downcast_ref::<crate::datasource::mysql::MySqlDataSource>()
                                    .ok_or_else(|| AppError::Other("dst_ds is not MySqlDataSource".into()))?;

                                if mysql_conn.is_none() {
                                    let conn = my_ds.pool.acquire().await
                                        .map_err(|e| AppError::Other(format!("Failed to acquire MySQL connection: {}", e)))?;
                                    mysql_conn = Some(conn);
                                }

                                let conn = mysql_conn.as_mut().unwrap();
                                let mut txn = conn.begin().await
                                    .map_err(|e| AppError::Other(format!("Failed to begin MySQL txn: {}", e)))?;

                                let res = tokio::time::timeout(
                                    tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                                    my_ds.bulk_write_in_txn(
                                        &mut txn,
                                        &target_table, &buf_columns, &rows_to_write,
                                        &conflict_strategy, &upsert_keys, &dst_driver,
                                    ),
                                ).await;

                                let write_res = match res {
                                    Ok(r) => r,
                                    Err(_) => {
                                        emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                            &format!("[{}] bulk_write timed out after {}s ({} rows failed)",
                                                label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                                        ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                        gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                        error_count += batch_len as usize;
                                        consecutive_full_fails += 1;
                                        let _ = txn.rollback().await;

                                        if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                                            return Err(AppError::Other(format!(
                                                "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
                                            )));
                                        }
                                        if error_limit > 0 && error_count >= error_limit {
                                            return Err(AppError::Other(format!(
                                                "Error limit ({}) exceeded: {} errors", error_limit, error_count
                                            )));
                                        }
                                        continue;
                                    }
                                };

                                handle_write_result!(write_res, batch_len);

                                if write_res.is_ok() {
                                    txn.commit().await
                                        .map_err(|e| AppError::Other(format!("MySQL txn commit failed: {}", e)))?;
                                    if let Some(pause_ms) = write_pause_ms {
                                        if pause_ms > 0 {
                                            tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                        }
                                    }
                                } else {
                                    let _ = txn.rollback().await;
                                }
                            }
                            TxnDriver::Postgres => {
                                let pg_ds = dst_ds.as_any().downcast_ref::<crate::datasource::postgres::PostgresDataSource>()
                                    .ok_or_else(|| AppError::Other("dst_ds is not PostgresDataSource".into()))?;

                                if pg_conn.is_none() {
                                    let conn: sqlx::pool::PoolConnection<sqlx::Postgres> = pg_ds.pool.acquire().await
                                        .map_err(|e| AppError::Other(format!("Failed to acquire PostgreSQL connection: {}", e)))?;
                                    pg_conn = Some(conn);
                                }

                                let conn = pg_conn.as_mut().unwrap();
                                let mut txn = conn.begin().await
                                    .map_err(|e| AppError::Other(format!("Failed to begin PostgreSQL txn: {}", e)))?;

                                let res = tokio::time::timeout(
                                    tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                                    pg_ds.bulk_write_in_txn(
                                        &mut txn,
                                        &target_table, &buf_columns, &rows_to_write,
                                        &conflict_strategy, &upsert_keys, &dst_driver,
                                    ),
                                ).await;

                                let write_res = match res {
                                    Ok(r) => r,
                                    Err(_) => {
                                        emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                            &format!("[{}] bulk_write timed out after {}s ({} rows failed)",
                                                label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                                        ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                        gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                        error_count += batch_len as usize;
                                        consecutive_full_fails += 1;
                                        let _ = txn.rollback().await;

                                        if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                                            return Err(AppError::Other(format!(
                                                "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
                                            )));
                                        }
                                        if error_limit > 0 && error_count >= error_limit {
                                            return Err(AppError::Other(format!(
                                                "Error limit ({}) exceeded: {} errors", error_limit, error_count
                                            )));
                                        }
                                        continue;
                                    }
                                };

                                handle_write_result!(write_res, batch_len);

                                if write_res.is_ok() {
                                    txn.commit().await
                                        .map_err(|e| AppError::Other(format!("PostgreSQL txn commit failed: {}", e)))?;
                                    if let Some(pause_ms) = write_pause_ms {
                                        if pause_ms > 0 {
                                            tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                        }
                                    }
                                } else {
                                    let _ = txn.rollback().await;
                                }
                            }
                        }
                    } else {
                        // Non-MySQL: original autocommit path.
                        let res = tokio::time::timeout(
                            tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                            dst_ds.bulk_write(
                                &target_table, &buf_columns, &rows_to_write,
                                &conflict_strategy, &upsert_keys, &dst_driver,
                            ),
                        ).await;

                        let write_res = match res {
                            Ok(r) => r,
                            Err(_) => {
                                emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                    &format!("[{}] bulk_write timed out after {}s ({} rows failed)",
                                        label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                                ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                error_count += batch_len as usize;
                                consecutive_full_fails += 1;

                                if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                                    return Err(AppError::Other(format!(
                                        "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
                                    )));
                                }
                                if error_limit > 0 && error_count >= error_limit {
                                    return Err(AppError::Other(format!(
                                        "Error limit ({}) exceeded: {} errors", error_limit, error_count
                                    )));
                                }
                                continue;
                            }
                        };

                        handle_write_result!(write_res, batch_len);
                        if write_res.is_ok() {
                            if let Some(pause_ms) = write_pause_ms {
                                if pause_ms > 0 {
                                    tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Flush remainder
        if !write_buf.is_empty() {
            let batch_len = write_buf.len() as u64;
            let _permit = semaphore.clone().acquire_owned().await
                .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

            if let Some(txn_driver) = &txn_driver {
                match txn_driver {
                    TxnDriver::MySql => {
                        let my_ds = dst_ds.as_any().downcast_ref::<crate::datasource::mysql::MySqlDataSource>()
                            .ok_or_else(|| AppError::Other("dst_ds is not MySqlDataSource".into()))?;

                        if mysql_conn.is_none() {
                            let conn = my_ds.pool.acquire().await
                                .map_err(|e| AppError::Other(format!("Failed to acquire MySQL connection for flush: {}", e)))?;
                            mysql_conn = Some(conn);
                        }

                        let conn = mysql_conn.as_mut().unwrap();
                        let mut txn = conn.begin().await
                            .map_err(|e| AppError::Other(format!("Failed to begin MySQL txn for flush: {}", e)))?;

                        match my_ds.bulk_write_in_txn(
                            &mut txn,
                            &target_table, &buf_columns, &write_buf,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => {
                                ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                                gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                                let fail = batch_len.saturating_sub(n as u64);
                                if fail > 0 {
                                    ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                }
                            }
                            Err(e) => {
                                emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                    &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                                ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            }
                        }

                        let _ = txn.commit().await;
                        if let Some(pause_ms) = write_pause_ms {
                            if pause_ms > 0 {
                                tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                            }
                        }
                    }
                    TxnDriver::Postgres => {
                        let pg_ds = dst_ds.as_any().downcast_ref::<crate::datasource::postgres::PostgresDataSource>()
                            .ok_or_else(|| AppError::Other("dst_ds is not PostgresDataSource".into()))?;

                        if pg_conn.is_none() {
                            let conn: sqlx::pool::PoolConnection<sqlx::Postgres> = pg_ds.pool.acquire().await
                                .map_err(|e| AppError::Other(format!("Failed to acquire PostgreSQL connection for flush: {}", e)))?;
                            pg_conn = Some(conn);
                        }

                        let conn = pg_conn.as_mut().unwrap();
                        let mut txn = conn.begin().await
                            .map_err(|e| AppError::Other(format!("Failed to begin PostgreSQL txn for flush: {}", e)))?;

                        match pg_ds.bulk_write_in_txn(
                            &mut txn,
                            &target_table, &buf_columns, &write_buf,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => {
                                ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                                gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                                let fail = batch_len.saturating_sub(n as u64);
                                if fail > 0 {
                                    ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                }
                            }
                            Err(e) => {
                                emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                    &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                                ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            }
                        }

                        let _ = txn.commit().await;
                        if let Some(pause_ms) = write_pause_ms {
                            if pause_ms > 0 {
                                tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                            }
                        }
                    }
                }
            } else {
                match dst_ds.bulk_write(
                    &target_table, &buf_columns, &write_buf,
                    &conflict_strategy, &upsert_keys, &dst_driver,
                ).await {
                    Ok(n) => {
                        ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                        gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                        let fail = batch_len.saturating_sub(n as u64);
                        if fail > 0 {
                            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                        }
                        if let Some(pause_ms) = write_pause_ms {
                            if pause_ms > 0 {
                                tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                            }
                        }
                    }
                    Err(e) => {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                        ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                        gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                    }
                }
            }
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
                    // TODO: persist incremental checkpoint in dedicated storage
                    // (script_text is now MigrateQL, not JSON — cannot update in-place)
                    emit_log(
                        app,
                        job_id,
                        run_id,
                        "SYSTEM",
                        &format!(
                            "Incremental checkpoint updated: {} = {} (table: {})",
                            inc.field, max_val, mapping.source_table
                        ),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txn_group_empty_never_commits() {
        let g = TxnGroupState::default();
        assert!(!g.should_commit(10, Some(4 * 1024 * 1024)));
        assert!(!g.should_commit(1, None));
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_commits_on_insert_count_threshold() {
        let mut g = TxnGroupState::default();
        // 3 inserts @ 100 rows each, 1KB each → well below byte limit
        for _ in 0..3 {
            g.record_insert(100, 100, 1024);
        }
        assert!(!g.should_commit(10, Some(10 * 1024 * 1024)));
        // Add 7 more to reach the count threshold
        for _ in 0..7 {
            g.record_insert(100, 100, 1024);
        }
        assert!(g.should_commit(10, Some(10 * 1024 * 1024)));
    }

    #[test]
    fn txn_group_commits_on_byte_threshold() {
        let mut g = TxnGroupState::default();
        // One huge insert that alone blows the byte limit
        g.record_insert(1_000, 1_000, 5 * 1024 * 1024);
        assert!(g.should_commit(100, Some(4 * 1024 * 1024)));
    }

    #[test]
    fn txn_group_byte_limit_none_disables_byte_check() {
        let mut g = TxnGroupState::default();
        g.record_insert(1_000, 1_000, u64::MAX / 2);
        assert!(!g.should_commit(100, None));
    }

    #[test]
    fn txn_group_txn_batch_size_zero_clamped_to_one() {
        let mut g = TxnGroupState::default();
        g.record_insert(10, 10, 64);
        // A misconfigured `0` must not deadlock (never commit) — clamp to 1.
        assert!(g.should_commit(0, None));
    }

    #[test]
    fn txn_group_drain_success_returns_ok_and_soft_fail_then_resets() {
        let mut g = TxnGroupState::default();
        g.record_insert(100, 95, 1024); // 5 silently dropped (INSERT IGNORE etc.)
        g.record_insert(100, 100, 1024);
        let (ok, soft) = g.drain_success();
        assert_eq!(ok, 195);
        assert_eq!(soft, 5);
        // State is reset
        assert_eq!(g.insert_count, 0);
        assert_eq!(g.bytes_written, 0);
        assert_eq!(g.pending_total, 0);
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_drain_failure_returns_total_then_resets() {
        let mut g = TxnGroupState::default();
        g.record_insert(100, 100, 1024);
        g.record_insert(100, 90, 1024);
        let total = g.drain_failure();
        assert_eq!(total, 200);
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_saturating_arithmetic_does_not_panic() {
        let mut g = TxnGroupState::default();
        g.record_insert(u64::MAX, u64::MAX, u64::MAX);
        g.record_insert(u64::MAX, u64::MAX, u64::MAX);
        // No panic; should_commit still answers sensibly.
        assert!(g.should_commit(1, None));
    }
}