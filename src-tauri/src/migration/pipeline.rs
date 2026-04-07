use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use once_cell::sync::Lazy;
use rusqlite::params;
use tauri::AppHandle;
use tauri::Emitter;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use super::task_mgr::*;

const MIGRATION_LOG_EVENT: &str = "migration_log";
const MIGRATION_STATS_EVENT: &str = "migration_stats";
const MIGRATION_FINISHED_EVENT: &str = "migration_finished";

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

// ── Emit helpers ──────────────────────────────────────────────────────────────

fn emit_log(app: &AppHandle, job_id: i64, run_id: &str, level: &str, message: &str) {
    let event = MigrationLogEvent {
        job_id,
        run_id: run_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        timestamp: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    };
    let _ = app.emit(MIGRATION_LOG_EVENT, &event);
}

fn emit_stats(
    app: &AppHandle,
    job_id: i64,
    run_id: &str,
    stats: &Arc<PipelineStats>,
    elapsed: f64,
    total_rows: Option<u64>,
    prev_read: u64,
    prev_written: u64,
) {
    let rows_read = stats.rows_read.load(Ordering::Relaxed);
    let rows_written = stats.rows_written.load(Ordering::Relaxed);
    let delta_read = rows_read.saturating_sub(prev_read) as f64;
    let delta_written = rows_written.saturating_sub(prev_written) as f64;
    let (eta, pct) = if let Some(total) = total_rows {
        if rows_read < total {
            let rps = if elapsed > 0.0 {
                rows_read as f64 / elapsed
            } else {
                1.0
            };
            let eta_secs = (total - rows_read) as f64 / rps.max(1.0);
            let pct = (rows_read as f64 / total as f64 * 100.0).min(100.0);
            (Some(eta_secs), Some(pct))
        } else {
            (Some(0.0), Some(100.0))
        }
    } else {
        (None, None)
    };

    let event = MigrationStatsEvent {
        job_id,
        run_id: run_id.to_string(),
        rows_read,
        rows_written,
        rows_failed: stats.rows_failed.load(Ordering::Relaxed),
        bytes_transferred: stats.bytes_transferred.load(Ordering::Relaxed),
        read_speed_rps: delta_read,
        write_speed_rps: delta_written,
        eta_seconds: eta,
        progress_pct: pct,
    };
    let _ = app.emit(MIGRATION_STATS_EVENT, &event);
}

// ── Internal batch type ───────────────────────────────────────────────────────

type Row = Vec<serde_json::Value>;

struct Batch {
    rows: Vec<Row>,
    column_names: Vec<String>,
}

// ── Public entry-point ────────────────────────────────────────────────────────

/// Launch the ETL pipeline for `job_id`.
/// Returns the `run_id` immediately — the pipeline runs in a background task.
pub async fn run_pipeline(job_id: i64, app: AppHandle) -> AppResult<String> {
    // Load job config from SQLite
    let config_json: String = {
        let db = crate::db::get().lock().unwrap();
        db.query_row(
            "SELECT config_json FROM migration_jobs WHERE id=?1",
            params![job_id],
            |r| r.get(0),
        )?
    };
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

    emit_log(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!("Pipeline started: job_id={}", job_id),
    );

    let run_id_clone = run_id.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        let result =
            execute_pipeline(job_id, run_id_clone.clone(), config, app_clone.clone(), cancel)
                .await;

        let final_status = match &result {
            Ok(_) => "FINISHED",
            Err(_) => "FAILED",
        };

        // Remove from active runs
        {
            let mut runs = ACTIVE_RUNS.lock().unwrap();
            runs.remove(&job_id);
        }

        let msg = match &result {
            Ok(summary) => summary.clone(),
            Err(e) => e.to_string(),
        };

        // Persist final status
        {
            let db = crate::db::get().lock().unwrap();
            let _ = db.execute(
                "UPDATE migration_jobs SET last_status=?1 WHERE id=?2",
                params![final_status, job_id],
            );
            let _ = db.execute(
                "UPDATE migration_run_history \
                 SET status=?1, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                 WHERE run_id=?2",
                params![final_status, &run_id_clone],
            );
        }

        emit_log(
            &app_clone,
            job_id,
            &run_id_clone,
            "SYSTEM",
            &format!("Pipeline {}: {}", final_status, msg),
        );
        let _ = app_clone.emit(
            MIGRATION_FINISHED_EVENT,
            serde_json::json!({
                "job_id": job_id,
                "run_id": run_id_clone,
                "status": final_status,
            }),
        );
    });

    Ok(run_id)
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

async fn execute_pipeline(
    job_id: i64,
    run_id: String,
    config: MigrationJobConfig,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
) -> AppResult<String> {
    let stats = PipelineStats::new();
    let start = Instant::now();

    // ── Resolve source datasource ──────────────────────────────────────────
    let src_conn_id = config.source.connection_id;
    let src_cfg = crate::db::get_connection_config(src_conn_id)?;

    emit_log(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!(
            "Connecting to source: connection_id={} driver={}",
            src_conn_id, src_cfg.driver
        ),
    );

    let src_ds = crate::datasource::pool_cache::get_or_create(
        src_conn_id,
        &src_cfg,
        src_cfg.database.as_deref().unwrap_or(""),
        "",
    )
    .await?;

    // ── Estimate row count ─────────────────────────────────────────────────
    let source_query = config.source.query.trim().to_string();
    let total_rows: Option<u64> = {
        let count_sql = format!("SELECT COUNT(*) FROM ({}) AS _mig_count_", source_query);
        match src_ds.execute(&count_sql).await {
            Ok(result) => {
                result
                    .rows
                    .first()
                    .and_then(|r| r.first())
                    .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)))
            }
            Err(e) => {
                emit_log(
                    &app,
                    job_id,
                    &run_id,
                    "WARN",
                    &format!("Could not estimate row count: {}", e),
                );
                None
            }
        }
    };

    if let Some(total) = total_rows {
        emit_log(
            &app,
            job_id,
            &run_id,
            "SYSTEM",
            &format!("Estimated rows: {}", total),
        );
    }

    // ── Resolve target datasource ──────────────────────────────────────────
    let dst_conn_id = config.target.connection_id;
    let dst_cfg = crate::db::get_connection_config(dst_conn_id)?;
    let target_table = config.target.table.clone();

    emit_log(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!(
            "Connecting to target: connection_id={} driver={} table={}",
            dst_conn_id, dst_cfg.driver, target_table
        ),
    );

    let dst_ds = crate::datasource::pool_cache::get_or_create(
        dst_conn_id,
        &dst_cfg,
        dst_cfg.database.as_deref().unwrap_or(""),
        "",
    )
    .await?;

    // ── mpsc channel: Reader → Writer ──────────────────────────────────────
    let channel_cap = config.pipeline.channel_capacity.max(1);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Batch>(channel_cap);

    let read_batch_size = config.pipeline.read_batch_size.max(1);
    let write_batch_size = config.pipeline.write_batch_size.max(1);

    // ── Stats broadcaster ──────────────────────────────────────────────────
    let stats_clone = stats.clone();
    let app_stats = app.clone();
    let run_id_stats = run_id.clone();
    let cancel_stats = cancel.clone();
    let stats_handle = tokio::spawn(async move {
        let mut prev_read = 0u64;
        let mut prev_written = 0u64;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if cancel_stats.load(Ordering::Relaxed) {
                break;
            }
            let elapsed = start.elapsed().as_secs_f64();
            emit_stats(
                &app_stats,
                job_id,
                &run_id_stats,
                &stats_clone,
                elapsed,
                total_rows,
                prev_read,
                prev_written,
            );
            prev_read = stats_clone.rows_read.load(Ordering::Relaxed);
            prev_written = stats_clone.rows_written.load(Ordering::Relaxed);
        }
    });

    // ── Reader task ────────────────────────────────────────────────────────
    let stats_reader = stats.clone();
    let app_reader = app.clone();
    let run_id_reader = run_id.clone();
    let cancel_reader = cancel.clone();
    let query = source_query.clone();

    let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        emit_log(&app_reader, job_id, &run_id_reader, "SYSTEM", "Reader started");

        // Execute source query
        let result = src_ds.execute(&query).await?;
        let columns = result.columns.clone();
        let all_rows = result.rows;

        let total = all_rows.len();
        emit_log(
            &app_reader,
            job_id,
            &run_id_reader,
            "SYSTEM",
            &format!("Reader fetched {} rows", total),
        );

        // Send rows in batches
        let mut batch_buf: Vec<Row> = Vec::with_capacity(read_batch_size);
        for row in all_rows {
            if cancel_reader.load(Ordering::Relaxed) {
                emit_log(&app_reader, job_id, &run_id_reader, "SYSTEM", "Reader cancelled");
                break;
            }
            // Estimate bytes
            let row_bytes: u64 = row
                .iter()
                .map(|v| v.to_string().len() as u64)
                .sum();
            stats_reader
                .bytes_transferred
                .fetch_add(row_bytes, Ordering::Relaxed);
            stats_reader.rows_read.fetch_add(1, Ordering::Relaxed);
            batch_buf.push(row);

            if batch_buf.len() >= read_batch_size {
                let batch = Batch {
                    rows: std::mem::replace(&mut batch_buf, Vec::with_capacity(read_batch_size)),
                    column_names: columns.clone(),
                };
                if tx.send(batch).await.is_err() {
                    // Writer closed — cancelled or error
                    break;
                }
            }
        }
        // Flush remainder
        if !batch_buf.is_empty() {
            let batch = Batch {
                rows: batch_buf,
                column_names: columns,
            };
            let _ = tx.send(batch).await;
        }
        emit_log(&app_reader, job_id, &run_id_reader, "SYSTEM", "Reader finished");
        Ok(())
    });

    // ── Writer task ────────────────────────────────────────────────────────
    let stats_writer = stats.clone();
    let app_writer = app.clone();
    let run_id_writer = run_id.clone();
    let cancel_writer = cancel.clone();
    let column_mapping = config.column_mapping.clone();
    let conflict_strategy = config.target.conflict_strategy.clone();
    let error_limit = config.pipeline.error_limit;

    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        emit_log(&app_writer, job_id, &run_id_writer, "SYSTEM", "Writer started");

        let mut error_count = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_columns: Vec<String> = Vec::new();

        while let Some(batch) = rx.recv().await {
            if cancel_writer.load(Ordering::Relaxed) {
                emit_log(
                    &app_writer,
                    job_id,
                    &run_id_writer,
                    "SYSTEM",
                    "Writer cancelled",
                );
                break;
            }

            // Determine effective column names (use mapping if provided)
            let effective_cols: Vec<String> = if !column_mapping.is_empty() {
                column_mapping
                    .iter()
                    .map(|m| m.target_col.clone())
                    .collect()
            } else {
                batch.column_names.clone()
            };

            for row in batch.rows {
                write_buf.push(row);
                if buf_columns.is_empty() {
                    buf_columns = effective_cols.clone();
                }

                if write_buf.len() >= write_batch_size {
                    let rows_to_write =
                        std::mem::replace(&mut write_buf, Vec::with_capacity(write_batch_size));
                    match write_batch(
                        &*dst_ds,
                        &target_table,
                        &buf_columns,
                        &rows_to_write,
                        &conflict_strategy,
                    )
                    .await
                    {
                        Ok(n) => {
                            stats_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            emit_log(
                                &app_writer,
                                job_id,
                                &run_id_writer,
                                "ERROR",
                                &format!("Write error: {}", e),
                            );
                            stats_writer
                                .rows_failed
                                .fetch_add(rows_to_write.len() as u64, Ordering::Relaxed);
                            error_count += rows_to_write.len();
                            if error_limit > 0 && error_count >= error_limit {
                                emit_log(
                                    &app_writer,
                                    job_id,
                                    &run_id_writer,
                                    "ERROR",
                                    &format!(
                                        "Error limit {} reached, aborting",
                                        error_limit
                                    ),
                                );
                                return Err(e);
                            }
                        }
                    }
                }
            }
        }

        // Flush remainder
        if !write_buf.is_empty() {
            match write_batch(
                &*dst_ds,
                &target_table,
                &buf_columns,
                &write_buf,
                &conflict_strategy,
            )
            .await
            {
                Ok(n) => {
                    stats_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    emit_log(
                        &app_writer,
                        job_id,
                        &run_id_writer,
                        "ERROR",
                        &format!("Final flush error: {}", e),
                    );
                    stats_writer
                        .rows_failed
                        .fetch_add(write_buf.len() as u64, Ordering::Relaxed);
                }
            }
        }

        emit_log(&app_writer, job_id, &run_id_writer, "SYSTEM", "Writer finished");
        Ok(())
    });

    // ── Wait for reader and writer ─────────────────────────────────────────
    let reader_result = reader_handle.await;
    let writer_result = writer_handle.await;

    // Stop stats broadcaster
    stats_handle.abort();

    // Check results
    if let Err(e) = reader_result {
        return Err(AppError::Other(format!("Reader task panicked: {}", e)));
    }
    if let Err(e) = writer_result {
        return Err(AppError::Other(format!("Writer task panicked: {}", e)));
    }

    // Check for inner errors
    if let Ok(Err(e)) = reader_result {
        return Err(e);
    }
    if let Ok(Err(e)) = writer_result {
        return Err(e);
    }

    let rows_written = stats.rows_written.load(Ordering::Relaxed);
    let rows_failed = stats.rows_failed.load(Ordering::Relaxed);
    let elapsed = start.elapsed().as_secs_f64();

    Ok(format!(
        "rows_written={} rows_failed={} elapsed={:.2}s",
        rows_written, rows_failed, elapsed
    ))
}

// ── Batch write helper ────────────────────────────────────────────────────────

/// Build and execute a multi-row INSERT for `table` using the active datasource.
/// Returns the number of rows that were inserted.
async fn write_batch(
    ds: &dyn crate::datasource::DataSource,
    table: &str,
    columns: &[String],
    rows: &[Row],
    conflict_strategy: &ConflictStrategy,
) -> AppResult<usize> {
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }

    // Build: INSERT [OR IGNORE|OR REPLACE] INTO table (cols) VALUES (…),(…)
    let keyword = match conflict_strategy {
        ConflictStrategy::Skip => "INSERT OR IGNORE INTO",
        ConflictStrategy::Replace => "INSERT OR REPLACE INTO",
        _ => "INSERT INTO",
    };

    let col_list = columns
        .iter()
        .map(|c| format!("`{}`", c))
        .collect::<Vec<_>>()
        .join(", ");

    let row_placeholders: Vec<String> = rows
        .iter()
        .map(|row| {
            let vals: Vec<String> = row
                .iter()
                .map(|v| super::data_pump::value_to_sql(v))
                .collect();
            format!("({})", vals.join(", "))
        })
        .collect();

    let sql = format!(
        "{} {} ({}) VALUES {}",
        keyword,
        table,
        col_list,
        row_placeholders.join(", ")
    );

    ds.execute(&sql).await?;
    Ok(rows.len())
}

