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

// ── Log collector (thread-safe) ──────────────────────────────────────────────

pub struct LogCollector(pub Vec<MigrationLogEvent>);

impl LogCollector {
    fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self(Vec::new())))
    }

    fn emit_and_record(
        &self,
        app: &AppHandle,
        job_id: i64,
        run_id: &str,
        level: &str,
        message: &str,
    ) {
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
        self.0.push(event.clone());
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

        let (msg, logs) = match result {
            Ok((summary, logs)) => (summary, logs),
            Err(e) => (e.to_string(), Vec::new()),
        };

        let log_collector = log_collector_clone.lock().unwrap();
        log_collector.emit_and_record(
            &app_clone,
            job_id,
            &run_id_clone,
            "SYSTEM",
            &format!("Pipeline {}: {}", final_status, msg),
        );
        let logs_json = serde_json::to_string(&log_collector.0).unwrap_or_default();
        drop(log_collector);

        // Persist final status + stats + logs
        {
            let db = crate::db::get().lock().unwrap();
            let _ = db.execute(
                "UPDATE migration_jobs SET last_status=?1 WHERE id=?2",
                params![final_status, job_id],
            );

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
) -> AppResult<(String, Vec<MigrationLogEvent>)> {
    let stats = PipelineStats::new();
    let start = Instant::now();
    let total_mappings = config.table_mappings.len();

    if total_mappings == 0 {
        return Err(AppError::Other("No table mappings configured".into()));
    }

    logs.lock().unwrap().emit_and_record(
        &app,
        job_id,
        &run_id,
        "SYSTEM",
        &format!("Pipeline started: {} table mapping(s)", total_mappings),
    );

    let mut completed = 0usize;
    let mut failed_mappings = Vec::new();

    for (idx, mapping) in config.table_mappings.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            logs.lock().unwrap().emit_and_record(&app, job_id, &run_id, "SYSTEM", "Pipeline cancelled by user");
            return Err(AppError::Other("Cancelled".into()));
        }

        let mapping_label = format!("{}→{}", mapping.source_table, mapping.target.table);
        logs.lock().unwrap().emit_and_record(
            &app,
            job_id,
            &run_id,
            "SYSTEM",
            &format!("[{}/{}] Starting: {}", idx + 1, total_mappings, mapping_label),
        );

        match execute_single_mapping(
            job_id,
            &run_id,
            &config,
            mapping,
            &app,
            &cancel,
            &stats,
            idx,
            total_mappings,
            logs.clone(),
        )
        .await
        {
            Ok(summary) => {
                completed += 1;
                logs.lock().unwrap().emit_and_record(
                    &app,
                    job_id,
                    &run_id,
                    "SYSTEM",
                    &format!(
                        "[{}/{}] Completed: {} — {}",
                        idx + 1,
                        total_mappings,
                        mapping_label,
                        summary
                    ),
                );
            }
            Err(e) => {
                failed_mappings.push(mapping_label.clone());
                logs.lock().unwrap().emit_and_record(
                    &app,
                    job_id,
                    &run_id,
                    "ERROR",
                    &format!(
                        "[{}/{}] Failed: {} — {}",
                        idx + 1,
                        total_mappings,
                        mapping_label,
                        e
                    ),
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
    let logs_snapshot = logs.lock().unwrap().0.clone();

    if failed_mappings.is_empty() {
        Ok((
            format!(
                "rows_read={} rows_written={} rows_failed={} bytes_transferred={} elapsed={:.2}s",
                rows_read, rows_written, rows_failed, bytes, elapsed
            ),
            logs_snapshot,
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
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64))),
            Err(_) => None,
        }
    };

    // ── Pipeline config ───────────────────────────────────────────────────
    let target_table = mapping.target.table.clone();
    let dst_driver = dst_cfg.driver.clone();
    let column_mapping = mapping.column_mappings.clone();
    let conflict_strategy = mapping.target.conflict_strategy.clone();
    let error_limit = config.pipeline.error_limit;
    let read_batch_size = config.pipeline.read_batch_size.max(1);
    let write_batch_size = config.pipeline.write_batch_size.max(1);
    let channel_cap = config.pipeline.channel_capacity.max(1);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Batch>(channel_cap);

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
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if cancel_s.load(Ordering::Relaxed) {
                break;
            }
            let rows_read = ms_clone.rows_read.load(Ordering::Relaxed);
            let rows_written = ms_clone.rows_written.load(Ordering::Relaxed);
            let delta_read = rows_read.saturating_sub(prev_read) as f64;
            let delta_written = rows_written.saturating_sub(prev_written) as f64;
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

    // ── Reader task ───────────────────────────────────────────────────────
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
            if cancel_r.load(Ordering::Relaxed) {
                break;
            }
            let page = src_ds.execute_paginated(&query, read_batch_size, offset).await?;
            if page.rows.is_empty() {
                break;
            }
            let fetched = page.rows.len();
            if columns_opt.is_none() {
                columns_opt = Some(page.columns.clone());
                // Log emitted via event; collector used only for main-thread logs
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

    // ── Writer task ───────────────────────────────────────────────────────
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
        } else {
            None
        };

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
                    let rows_to_write =
                        std::mem::replace(&mut write_buf, Vec::with_capacity(write_batch_size));
                    match write_batch(
                        &*dst_ds,
                        &target_table,
                        &buf_columns,
                        &rows_to_write,
                        &conflict_strategy,
                        &dst_driver,
                    )
                    .await
                    {
                        Ok(n) => {
                            ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            emit_log(
                                &app_writer,
                                job_id,
                                &run_id_w,
                                "ERROR",
                                &format!("[{}] Write error: {}", ml_w, e),
                            );
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
            match write_batch(
                &*dst_ds,
                &target_table,
                &buf_columns,
                &write_buf,
                &conflict_strategy,
                &dst_driver,
            )
            .await
            {
                Ok(n) => {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    let cnt = write_buf.len() as u64;
                    ms_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(cnt, Ordering::Relaxed);
                    emit_log(
                        &app_writer,
                        job_id,
                        &run_id_w,
                        "ERROR",
                        &format!("[{}] Final flush error: {}", ml_w, e),
                    );
                }
            }
        }
        Ok(())
    });

    let reader_result = reader_handle.await;
    let writer_result = writer_handle.await;
    stats_handle.abort();

    // Check results
    if let Err(e) = &reader_result {
        return Err(AppError::Other(format!("Reader panicked: {}", e)));
    }
    if let Err(e) = &writer_result {
        return Err(AppError::Other(format!("Writer panicked: {}", e)));
    }
    if let Ok(Err(e)) = reader_result {
        return Err(e);
    }
    if let Ok(Err(e)) = writer_result {
        return Err(e);
    }

    let written = mapping_stats.rows_written.load(Ordering::Relaxed);
    let failed = mapping_stats.rows_failed.load(Ordering::Relaxed);
    let read = mapping_stats.rows_read.load(Ordering::Relaxed);
    Ok(format!("read={} written={} failed={}", read, written, failed))
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
    driver: &str,
) -> AppResult<usize> {
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }

    let (keyword, suffix) = match (conflict_strategy, driver) {
        (ConflictStrategy::Skip, "sqlite") => ("INSERT OR IGNORE INTO", ""),
        (ConflictStrategy::Replace, "sqlite") => ("INSERT OR REPLACE INTO", ""),
        (ConflictStrategy::Skip, "mysql" | "doris" | "tidb") => ("INSERT IGNORE INTO", ""),
        (ConflictStrategy::Replace, "mysql" | "doris" | "tidb") => ("REPLACE INTO", ""),
        (ConflictStrategy::Skip, "postgres" | "gaussdb") => {
            ("INSERT INTO", " ON CONFLICT DO NOTHING")
        }
        _ => ("INSERT INTO", ""),
    };

    let quote_col: fn(&str) -> String = match driver {
        "mysql" | "doris" | "tidb" | "clickhouse" => |c| format!("`{}`", c.replace('`', "``")),
        "sqlserver" => |c| format!("[{}]", c.replace(']', "]]")),
        _ => |c| format!("\"{}\"", c.replace('"', "\"\"")),
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

    ds.execute(&sql).await?;
    Ok(rows.len())
}
