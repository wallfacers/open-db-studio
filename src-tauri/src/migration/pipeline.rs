use std::collections::{HashMap, VecDeque};
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

/// Format a number with comma separators (e.g. 100000000 -> "100,000,000").
fn format_number(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result
}

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

/// Which bulk write method to use.
enum WriteMethod<'a> {
    BulkWrite {
        rows: &'a [Row],
    },
    BulkWriteNative {
        rows: &'a [crate::migration::native_row::MigrationRow],
    },
}

/// Execute a batch write with semaphore guard and timeout.
/// Returns (write_result, success). On timeout, logs warning and updates stats.
async fn flush_write_batch(
    dst_ds: Arc<dyn crate::datasource::DataSource>,
    semaphore: Arc<Semaphore>,
    target_table: &str,
    buf_columns: &[String],
    write_method: WriteMethod<'_>,
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    dst_driver: &str,
    batch_len: u64,
    app_writer: &AppHandle,
    job_id: i64,
    run_id_w: &str,
    label_w: &str,
    ms_writer: &PipelineStats,
    gs_writer: &PipelineStats,
) -> Result<(Result<usize, AppError>, bool), AppError> {
    let _permit = semaphore.acquire_owned().await
        .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

    let dst_ds_ref = dst_ds.as_ref();
    let fut = match write_method {
        WriteMethod::BulkWrite { rows } => dst_ds_ref.bulk_write(
            target_table, buf_columns, rows, conflict_strategy, upsert_keys, dst_driver,
        ),
        WriteMethod::BulkWriteNative { rows } => dst_ds_ref.bulk_write_native(
            target_table, buf_columns, rows, conflict_strategy, upsert_keys, dst_driver,
        ),
    };

    let res = tokio::time::timeout(
        tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
        fut,
    ).await;

    match res {
        Err(_) => {
            ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
            gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
            emit_log(app_writer, job_id, run_id_w, "WARN",
                &format!("[{}] Write batch timed out after {}s ({} rows failed)",
                    label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
            Ok((Err(AppError::Other("write timeout".into())), false))
        }
        Ok(r) => Ok((r, true)),
    }
}

/// Handle write result: update stats, check circuit breakers.
macro_rules! handle_write_result {
    ($error_count:expr, $consecutive_full_fails:expr, $res:expr, $batch_len:expr,
     $app_writer:expr, $job_id:expr, $run_id_w:expr, $label_w:expr,
     $ms_writer:expr, $gs_writer:expr, $error_limit:expr) => {{
        match &$res {
            Ok(n) => {
                let ok = *n as u64;
                let fail = $batch_len.saturating_sub(ok);
                $ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                $gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                if fail > 0 {
                    $ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                    $gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                    $error_count = $error_count.saturating_add(fail as usize);
                }
                if ok == 0 && fail > 0 {
                    $consecutive_full_fails += 1;
                } else {
                    $consecutive_full_fails = 0;
                }
            }
            Err(e) => {
                let err_msg = e.to_string();
                if is_connection_death(&err_msg) {
                    emit_log($app_writer, $job_id, $run_id_w, "WARN",
                        &format!("[{}] Connection lost: {} ({} rows failed, will reconnect)", $label_w, err_msg, $batch_len));
                    $ms_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                    $gs_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                    $error_count = $error_count.saturating_add($batch_len as usize);
                } else {
                    emit_log($app_writer, $job_id, $run_id_w, "ERROR",
                        &format!("[{}] bulk_write failed: {}", $label_w, err_msg));
                    $ms_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                    $gs_writer.rows_failed.fetch_add($batch_len, Ordering::Relaxed);
                    $error_count = $error_count.saturating_add($batch_len as usize);
                    $consecutive_full_fails += 1;
                }
            }
        }
        if $consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
            emit_log($app_writer, $job_id, $run_id_w, "ERROR",
                &format!("[{}] Circuit breaker: {} consecutive batches fully failed", $label_w, $consecutive_full_fails));
            return Err(AppError::Other(format!(
                "Circuit breaker: {} consecutive write batches fully failed", $consecutive_full_fails
            )));
        }
        if $error_limit > 0 && $error_count >= $error_limit {
            return Err(AppError::Other(format!(
                "Error limit ({}) exceeded: {} errors", $error_limit, $error_count
            )));
        }
    }};
}

/// Check circuit breaker conditions after a write result (success or timeout).
#[inline]
fn check_circuit_breaker(
    label: &str,
    consecutive_full_fails: usize,
    error_count: usize,
    error_limit: usize,
    job_id: i64,
    run_id: &str,
    app: &tauri::AppHandle,
) -> AppResult<()> {
    if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
        emit_log(app, job_id, run_id, "ERROR",
            &format!("[{}] Circuit breaker: {} consecutive batches fully failed", label, consecutive_full_fails));
        return Err(AppError::Other(format!(
            "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
        )));
    }
    if error_limit > 0 && error_count >= error_limit {
        return Err(AppError::Other(format!(
            "Error limit ({}) exceeded: {} errors", error_limit, error_count
        )));
    }
    Ok(())
}

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

/// Batch of rows sent from reader to writer through the channel.
/// Reduces channel send calls from N_rows to N_pages (e.g., 10M → 5K).
struct RowBatch {
    rows: Vec<Row>,
    /// Byte permit released when the writer consumes this batch.
    /// Tied to the ByteGate semaphore for backpressure.
    #[allow(dead_code)]
    byte_permit: Option<crate::migration::byte_gate::BytePermit>,
}

/// Native-typed row batch for the dedicated migration read path (Phase 3).
/// MySQL/PostgreSQL use this to avoid serde_json::Value stringification.
struct MigrationRowBatch {
    columns: Vec<String>,
    rows: Vec<crate::migration::native_row::MigrationRow>,
    /// Byte permit released when the writer consumes this batch.
    #[allow(dead_code)]
    byte_permit: Option<crate::migration::byte_gate::BytePermit>,
}

/// Messages sent from reader to writer through the channel.
/// Reader sends Columns once, then streams RowBatch or MigrationBatch messages.
enum ChannelMsg {
    Columns(Vec<String>),
    RowBatch(RowBatch),
    MigrationBatch(MigrationRowBatch),
}

/// Detect whether an error message indicates a dead connection (not a business error).
/// Dead connections should NOT increment consecutive_full_fails because the next
/// pool.acquire() will automatically get a healthy connection (test_before_acquire=true).
fn is_connection_death(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("expected to read")
        || e.contains("got 0 bytes at eof")
        || e.contains("broken pipe")
        || e.contains("connection reset")
        || e.contains("connection closed")
        || e.contains("connection was closed")
        || e.contains("pooltimedout")
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

    // Global semaphore to cap TOTAL concurrent reader/writer pairs (channels) across all mappings.
    // Prevents mapping_parallelism * shard_parallelism multiplication (e.g. 16*16=256 channels).
    let global_parallelism_sem = Arc::new(Semaphore::new(parallelism));

    // Global byte gate to cap TOTAL in-flight memory across all mappings and shards.
    let global_byte_gate = config.pipeline.byte_capacity.map(|cap| {
        Arc::new(crate::migration::byte_gate::ByteGate::new(cap as usize))
    });

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
        let global_parallelism_sem = global_parallelism_sem.clone();
        let global_byte_gate = global_byte_gate.clone();
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
                idx, total_mappings, logs.clone(), global_parallelism_sem, global_byte_gate,
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

/// Maximum rows the pipeline will process per single table mapping without an explicit
/// `WHERE` filter. Beyond this threshold, the engine emits a warning and caps the effective
/// parallelism to prevent memory exhaustion. Users should chunk large migrations manually.
const MAX_ROWS_SOFT_THRESHOLD: u64 = 100_000_000; // 100M rows

/// Hard cap on estimated rows — if the source table exceeds this, the pipeline still runs
/// but emits a strong warning. This prevents accidental full-table migrations of billion-row
/// tables that could run for days.
const MAX_ROWS_HARD_CAP: u64 = 1_000_000_000; // 1B rows

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
    global_parallelism_sem: Arc<Semaphore>,
    global_byte_gate: Option<Arc<crate::migration::byte_gate::ByteGate>>,
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

    // ── Large table warnings ──────────────────────────────────────────────
    if let Some(rows) = total_rows {
        if rows >= MAX_ROWS_HARD_CAP {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!(
                    "[{}] Source table has ~{} rows (exceeds {} hard cap). \
                     Consider splitting into smaller chunks with WHERE clauses \
                     (e.g. by date range or ID range) to avoid multi-day migrations.",
                    mapping_label,
                    format_number(rows),
                    format_number(MAX_ROWS_HARD_CAP),
                ),
            );
        } else if rows >= MAX_ROWS_SOFT_THRESHOLD {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!(
                    "[{}] Source table has ~{} rows (exceeds {} soft threshold). \
                     Monitor memory usage and consider chunking with WHERE clauses.",
                    mapping_label,
                    format_number(rows),
                    format_number(MAX_ROWS_SOFT_THRESHOLD),
                ),
            );
        }
    }

    // ── Pipeline config ───────────────────────────────────────────────────
    let target_table = mapping.target.table.clone();
    let dst_driver = dst_cfg.driver.clone();
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
                    global_byte_gate.clone(),
                    global_parallelism_sem.clone(),
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
                        global_byte_gate.clone(),
                        global_parallelism_sem.clone(),
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
            global_byte_gate.clone(),
            global_parallelism_sem.clone(),
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
    conflict_strategy: ConflictStrategy,
    upsert_keys: Vec<String>,
    read_batch_size: usize,
    write_batch_size: usize,
    channel_cap: usize,
    error_limit: usize,
    txn_batch_size: usize,
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
    byte_gate: Option<Arc<crate::migration::byte_gate::ByteGate>>,
    global_parallelism_sem: Arc<Semaphore>,
) -> AppResult<()> {
    // Acquire a permit from the global parallelism semaphore.
    // This caps the total number of concurrent reader-writer pairs (channels)
    // across the entire job.
    let _channel_permit = global_parallelism_sem.acquire().await
        .map_err(|e| AppError::Other(format!("Global semaphore closed: {}", e)))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ChannelMsg>(channel_cap);

    // ── Reader task ───────────────────────────────────────────────────
    let ms_reader = mapping_stats.clone();
    let gs_reader = global_stats.clone();
    let cancel_r = cancel.clone();
    let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        use crate::datasource::utils::quote_identifier_for_driver;
        use std::time::Duration;

        let use_native = matches!(src_driver.as_str(), "mysql" | "doris" | "tidb" | "postgres" | "gaussdb");
        let mut rate_state: Option<(Instant, u64)> = speed_limit_rps.map(|_| (Instant::now(), 0u64));

        if let Some((pk_col, split)) = pk_split {
            // ── Cursor-based split reader (O(n)) ──────────────────────────────
            let pk_q = quote_identifier_for_driver(&pk_col, &src_driver);
            let range_cond = match split.end {
                Some(end) => format!("{pk} >= {start} AND {pk} < {end}", pk = pk_q, start = split.start, end = end),
                None      => format!("{pk} >= {start}", pk = pk_q, start = split.start),
            };

            let shard_sql = format!(
                "SELECT * FROM ({src}) AS _mig_s_ WHERE {cond} ORDER BY {pk}",
                src = source_query, cond = range_cond, pk = pk_q,
            );

            if use_native {
                let (columns, mut rx_db) = src_ds.migration_read_sql_stream(&shard_sql, 1000).await?;
                if columns.is_empty() { return Ok(()); }
                tx.send(ChannelMsg::Columns(columns.clone())).await.ok();

                let mut batch = Vec::with_capacity(read_batch_size);
                let mut batch_bytes = 0u64;

                while let Some(row) = rx_db.recv().await {
                    if cancel_r.load(Ordering::Relaxed) { break; }

                    let row_bytes: u64 = row.values.iter().map(|v| v.estimated_sql_size() as u64).sum();
                    ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    ms_reader.rows_read.fetch_add(1, Ordering::Relaxed);
                    gs_reader.rows_read.fetch_add(1, Ordering::Relaxed);

                    batch.push(row);
                    batch_bytes += row_bytes;

                    if batch.len() >= read_batch_size {
                        let permit = if let Some(ref gate) = byte_gate {
                            match gate.acquire(batch_bytes as usize).await {
                                Ok(p) => Some(p),
                                Err(_) => break,
                            }
                        } else { None };

                        if tx.send(ChannelMsg::MigrationBatch(MigrationRowBatch {
                            columns: columns.clone(),
                            rows: std::mem::replace(&mut batch, Vec::with_capacity(read_batch_size)),
                            byte_permit: permit,
                        })).await.is_err() { break; }
                        batch_bytes = 0;
                    }
                }
                if !batch.is_empty() {
                    let permit = if let Some(ref gate) = byte_gate {
                        match gate.acquire(batch_bytes as usize).await { Ok(p) => Some(p), Err(_) => None }
                    } else { None };
                    tx.send(ChannelMsg::MigrationBatch(MigrationRowBatch { columns, rows: batch, byte_permit: permit })).await.ok();
                }
            } else {
                let mut cursor = split.start;
                let mut pk_col_idx: Option<usize> = None;
                let mut columns_opt: Option<Vec<String>> = None;
                loop {
                    if cancel_r.load(Ordering::Relaxed) { break; }
                    let page_cond = match split.end {
                        Some(end) => format!("{pk} >= {cursor} AND {pk} < {end}", pk = pk_q, cursor = cursor, end = end),
                        None      => format!("{pk} >= {cursor}", pk = pk_q, cursor = cursor),
                    };
                    let page_sql = format!(
                        "SELECT * FROM ({src}) AS _mig_s_ WHERE {cond} ORDER BY {pk} LIMIT {limit}",
                        src = source_query, cond = page_cond, pk = pk_q, limit = read_batch_size,
                    );
                    let page = src_ds.execute(&page_sql).await?;
                    if page.rows.is_empty() { break; }
                    let n = page.rows.len();

                    if columns_opt.is_none() {
                        pk_col_idx = page.columns.iter().position(|c| c.eq_ignore_ascii_case(&pk_col));
                        columns_opt = Some(page.columns.clone());
                        tx.send(ChannelMsg::Columns(page.columns.clone())).await.ok();
                    }

                    let last_pk = page.rows.last()
                        .and_then(|r| pk_col_idx.and_then(|i| r.get(i)))
                        .and_then(crate::migration::splitter::parse_i64_from_json)
                        .unwrap_or(i64::MAX);
                    cursor = last_pk.saturating_add(1);

                    for row in &page.rows {
                        let row_bytes: u64 = row.iter().map(json_value_len).sum();
                        ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                        gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    }
                    ms_reader.rows_read.fetch_add(n as u64, Ordering::Relaxed);
                    gs_reader.rows_read.fetch_add(n as u64, Ordering::Relaxed);

                    let batch_bytes = crate::migration::byte_gate::estimate_batch_bytes(&page.rows);
                    let permit = if let Some(ref gate) = byte_gate {
                        match gate.acquire(batch_bytes as usize).await { Ok(p) => Some(p), Err(_) => break }
                    } else { None };

                    if tx.send(ChannelMsg::RowBatch(RowBatch { rows: page.rows, byte_permit: permit })).await.is_err() { break; }
                    if n < read_batch_size { break; }
                }
            }
        } else {
            // ── Fallback: OFFSET-based reader ────
            if use_native {
                let (columns, mut rx_db) = src_ds.migration_read_sql_stream(&source_query, 1000).await?;
                if columns.is_empty() { return Ok(()); }
                tx.send(ChannelMsg::Columns(columns.clone())).await.ok();

                let mut batch = Vec::with_capacity(read_batch_size);
                let mut batch_bytes = 0u64;
                while let Some(row) = rx_db.recv().await {
                    if cancel_r.load(Ordering::Relaxed) { break; }
                    let row_bytes: u64 = row.values.iter().map(|v| v.estimated_sql_size() as u64).sum();
                    ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    ms_reader.rows_read.fetch_add(1, Ordering::Relaxed);
                    gs_reader.rows_read.fetch_add(1, Ordering::Relaxed);
                    batch.push(row);
                    batch_bytes += row_bytes;
                    if batch.len() >= read_batch_size {
                        let permit = if let Some(ref gate) = byte_gate {
                            match gate.acquire(batch_bytes as usize).await { Ok(p) => Some(p), Err(_) => break }
                        } else { None };
                        if tx.send(ChannelMsg::MigrationBatch(MigrationRowBatch {
                            columns: columns.clone(),
                            rows: std::mem::replace(&mut batch, Vec::with_capacity(read_batch_size)),
                            byte_permit: permit,
                        })).await.is_err() { break; }
                        batch_bytes = 0;
                    }
                }
                if !batch.is_empty() {
                    let permit = if let Some(ref gate) = byte_gate {
                        match gate.acquire(batch_bytes as usize).await { Ok(p) => Some(p), Err(_) => None }
                    } else { None };
                    tx.send(ChannelMsg::MigrationBatch(MigrationRowBatch { columns, rows: batch, byte_permit: permit })).await.ok();
                }
            } else {
                let mut offset = 0usize;
                let mut columns_opt: Option<Vec<String>> = None;
                loop {
                    if cancel_r.load(Ordering::Relaxed) { break; }
                    let page = src_ds.execute_paginated(&source_query, read_batch_size, offset).await?;
                    if page.rows.is_empty() { break; }
                    let fetched = page.rows.len();
                    if columns_opt.is_none() {
                        columns_opt = Some(page.columns.clone());
                        tx.send(ChannelMsg::Columns(page.columns.clone())).await.ok();
                    }
                    for row in &page.rows {
                        let row_bytes: u64 = row.iter().map(json_value_len).sum();
                        ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                        gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                    }
                    ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
                    gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);

                    let batch_bytes = crate::migration::byte_gate::estimate_batch_bytes(&page.rows);
                    let permit = if let Some(ref gate) = byte_gate {
                        match gate.acquire(batch_bytes as usize).await { Ok(p) => Some(p), Err(_) => break }
                    } else { None };

                    if tx.send(ChannelMsg::RowBatch(RowBatch { rows: page.rows, byte_permit: permit })).await.is_err() { break; }
                    if fetched < read_batch_size { break; }
                    offset += fetched;
                }
            }
        }

        // Rate limiting (simplified for the whole reader task)
        if let (Some(rps_limit), Some((ref mut window_start, _))) = (speed_limit_rps, &mut rate_state) {
             let current_read = ms_reader.rows_read.load(Ordering::Relaxed);
             let expected = Duration::from_secs_f64(current_read as f64 / rps_limit as f64);
             let elapsed = window_start.elapsed();
             if expected > elapsed { tokio::time::sleep(expected - elapsed).await; }
        }

        Ok(())
    });

    // ── Writer task (bulk_write with transaction batching) ────────────────────
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
        let mut native_buf: Vec<crate::migration::native_row::MigrationRow> = Vec::with_capacity(write_batch_size);
        let mut buf_columns: Vec<String> = Vec::new();

        let supports_txn = dst_ds.supports_txn_bulk_write();
        let mut txn_handle: Option<crate::datasource::BulkWriteTxn> = None;
        let mut batches_in_txn = 0usize;
        let mut txn_mode_active = supports_txn && txn_batch_size > 1;

        while let Some(msg) = rx.recv().await {
            if cancel_w.load(Ordering::Relaxed) { break; }
            match msg {
                ChannelMsg::Columns(cols) => { buf_columns = cols; }
                ChannelMsg::RowBatch(batch) => {
                    write_buf.extend(batch.rows);
                    while write_buf.len() >= write_batch_size {
                        let rows = std::mem::replace(&mut write_buf, Vec::with_capacity(write_batch_size));
                        let batch_len = rows.len() as u64;
                        let (write_res, wrote_ok) = flush_write_batch(
                            dst_ds.clone(), semaphore.clone(), &target_table, &buf_columns,
                            WriteMethod::BulkWrite { rows: &rows }, &conflict_strategy, &upsert_keys, &dst_driver,
                            batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer,
                        ).await?;
                        if !wrote_ok {
                            consecutive_full_fails += 1; error_count = error_count.saturating_add(batch_len as usize);
                            check_circuit_breaker(&label_w, consecutive_full_fails, error_count, error_limit, job_id, &run_id_w, &app_writer)?;
                            continue;
                        }
                        handle_write_result!(error_count, consecutive_full_fails, write_res, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer, error_limit);
                        if write_res.is_ok() { if let Some(p) = write_pause_ms { if p > 0 { tokio::time::sleep(std::time::Duration::from_millis(p)).await; } } }
                    }
                }
                ChannelMsg::MigrationBatch(batch) => {
                    buf_columns = batch.columns.clone();
                    native_buf.extend(batch.rows);
                    while native_buf.len() >= write_batch_size {
                        let batch_rows: Vec<_> = native_buf.drain(..write_batch_size).collect();
                        let batch_len = batch_rows.len() as u64;

                        if txn_mode_active {
                            if txn_handle.is_none() {
                                if let Ok(Some(txn)) = dst_ds.begin_bulk_write_txn().await {
                                    txn_handle = Some(txn); batches_in_txn = 0;
                                } else { txn_mode_active = false; }
                            }
                            if let Some(ref mut txn) = txn_handle {
                                let _permit = semaphore.clone().acquire_owned().await.map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
                                let write_res = dst_ds.bulk_write_in_txn(txn, &target_table, &buf_columns, &batch_rows, &conflict_strategy, &upsert_keys, &dst_driver).await;
                                match write_res {
                                    Ok(n) => {
                                        let ok = n as u64; let fail = batch_len.saturating_sub(ok);
                                        ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed); gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                                        if fail > 0 { ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed); gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed); error_count = error_count.saturating_add(fail as usize); }
                                        consecutive_full_fails = 0; batches_in_txn += 1;
                                        if batches_in_txn >= txn_batch_size {
                                            let t = txn_handle.take().unwrap(); dst_ds.commit_bulk_write_txn(t).await?;
                                            batches_in_txn = 0;
                                            if let Ok(Some(txn)) = dst_ds.begin_bulk_write_txn().await { txn_handle = Some(txn); } else { txn_mode_active = false; }
                                        }
                                        if let Some(p) = write_pause_ms { if p > 0 { tokio::time::sleep(std::time::Duration::from_millis(p)).await; } }
                                    }
                                    Err(e) => {
                                        emit_log(&app_writer, job_id, &run_id_w, "ERROR", &format!("[{}] bulk_write_in_txn failed: {}", label_w, e));
                                        ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed); gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                                        error_count = error_count.saturating_add(batch_len as usize); consecutive_full_fails += 1;
                                        txn_handle = None; batches_in_txn = 0;
                                        if let Ok(Some(txn)) = dst_ds.begin_bulk_write_txn().await { txn_handle = Some(txn); } else { txn_mode_active = false; }
                                        check_circuit_breaker(&label_w, consecutive_full_fails, error_count, error_limit, job_id, &run_id_w, &app_writer)?;
                                    }
                                }
                                continue;
                            }
                        }
                        let (write_res, wrote_ok) = flush_write_batch(
                            dst_ds.clone(), semaphore.clone(), &target_table, &buf_columns,
                            WriteMethod::BulkWriteNative { rows: &batch_rows }, &conflict_strategy, &upsert_keys, &dst_driver,
                            batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer,
                        ).await?;
                        if !wrote_ok {
                            consecutive_full_fails += 1; error_count = error_count.saturating_add(batch_len as usize);
                            check_circuit_breaker(&label_w, consecutive_full_fails, error_count, error_limit, job_id, &run_id_w, &app_writer)?;
                            continue;
                        }
                        handle_write_result!(error_count, consecutive_full_fails, write_res, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer, error_limit);
                        if write_res.is_ok() { if let Some(p) = write_pause_ms { if p > 0 { tokio::time::sleep(std::time::Duration::from_millis(p)).await; } } }
                    }
                }
            }
        }

        // Drain remainder
        if !write_buf.is_empty() {
            let rows = std::mem::replace(&mut write_buf, Vec::new());
            let batch_len = rows.len() as u64;
            let (r, _) = flush_write_batch(dst_ds.clone(), semaphore.clone(), &target_table, &buf_columns, WriteMethod::BulkWrite { rows: &rows }, &conflict_strategy, &upsert_keys, &dst_driver, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer).await?;
            handle_write_result!(error_count, consecutive_full_fails, r, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer, error_limit);
        }
        if !native_buf.is_empty() {
            let batch_len = native_buf.len() as u64;
            if let Some(ref mut txn) = txn_handle {
                let _permit = semaphore.clone().acquire_owned().await.map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
                let write_res = dst_ds.bulk_write_in_txn(txn, &target_table, &buf_columns, &native_buf, &conflict_strategy, &upsert_keys, &dst_driver).await;
                if let Ok(n) = write_res {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed); gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                } else {
                    ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed); gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                }
            } else {
                let (r, _) = flush_write_batch(dst_ds.clone(), semaphore.clone(), &target_table, &buf_columns, WriteMethod::BulkWriteNative { rows: &native_buf }, &conflict_strategy, &upsert_keys, &dst_driver, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer).await?;
                handle_write_result!(error_count, consecutive_full_fails, r, batch_len, &app_writer, job_id, &run_id_w, &label_w, &ms_writer, &gs_writer, error_limit);
            }
        }
        if let Some(txn) = txn_handle { dst_ds.commit_bulk_write_txn(txn).await?; }
        Ok(())
    });

    let (r1, r2) = tokio::join!(reader_handle, writer_handle);
    r1.map_err(|e| AppError::Other(format!("Reader panicked: {}", e)))??;
    r2.map_err(|e| AppError::Other(format!("Writer panicked: {}", e)))??;
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

