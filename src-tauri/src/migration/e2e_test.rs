//! End-to-end migration pipeline test — exercises the full data path
//! (migration_read_sql_stream → channel → bulk_write_native) with real MySQL.
//!
//! Run with: `cargo test --lib test_e2e_migration_pipeline -- --nocapture`

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn make_config(db: &str) -> crate::datasource::ConnectionConfig {
    crate::datasource::ConnectionConfig {
        driver: "mysql".into(),
        host: Some("localhost".into()),
        port: Some(3306),
        database: Some(db.into()),
        username: Some("root".into()),
        password: Some("root123456".into()),
        extra_params: None,
        file_path: None,
        auth_type: None,
        token: None,
        ssl_mode: None,
        ssl_ca_path: None,
        ssl_cert_path: None,
        ssl_key_path: None,
        connect_timeout_secs: Some(10),
        read_timeout_secs: Some(30),
        pool_max_connections: Some(4),
        pool_idle_timeout_secs: Some(300),
    }
}

fn extract_count(qr: &crate::datasource::QueryResult) -> u64 {
    qr.rows.first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_u64()
            .or_else(|| v.as_i64().map(|n| n as u64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())))
        .unwrap_or(0)
}

#[tokio::test]
async fn test_e2e_migration_pipeline() {
    use crate::datasource::DataSource;
    use crate::datasource::mysql::{MySqlDataSource, Dialect};
    use crate::migration::native_row::MigrationRow;
    use crate::migration::task_mgr::ConflictStrategy;

    let src_cfg = make_config("e2e_src_test");
    let dst_cfg = make_config("e2e_dst_test");

    let src: Arc<dyn DataSource> = Arc::new(
        MySqlDataSource::new_for_migration(&src_cfg, Dialect::MySQL)
            .await
            .expect("connect source"),
    );
    let dst: Arc<dyn DataSource> = Arc::new(
        MySqlDataSource::new_for_migration(&dst_cfg, Dialect::MySQL)
            .await
            .expect("connect target"),
    );

    // Verify source data
    let src_qr = src
        .execute("SELECT COUNT(*) FROM e2e_src_test.migration_test")
        .await
        .expect("count source");
    let total_rows = extract_count(&src_qr);
    println!("[1] Source table: {} rows", total_rows);
    assert!(total_rows > 0, "Source table must have data");

    // Clear target
    dst.execute("DELETE FROM e2e_dst_test.migration_test")
        .await
        .expect("clear target");
    println!("[2] Target cleared");

    // ── Core migration path: reader → channel → writer ──────────────────
    let cancel = CancellationToken::new();
    let sql = "SELECT * FROM e2e_src_test.migration_test ORDER BY id";

    let (columns, mut rx): (Vec<String>, tokio::sync::mpsc::Receiver<MigrationRow>) = src
        .migration_read_sql_stream(sql, 8, &cancel)
        .await
        .expect("start reader stream");
    println!("[3] Reader started: {} columns", columns.len());

    let write_batch_size = 512;
    let mut rows_read: u64 = 0;
    let mut rows_written: u64 = 0;
    let mut rows_failed: u64 = 0;
    let mut batch: Vec<MigrationRow> = Vec::with_capacity(write_batch_size);
    let mut write_columns: Vec<String> = Vec::new();
    let start = Instant::now();

    loop {
        let row = tokio::select! {
            row = rx.recv() => match row { Some(r) => r, None => break },
            _ = tokio::time::sleep(Duration::from_secs(120)) => {
                eprintln!("[WARN] Reader timeout after 120s — breaking");
                break;
            }
        };

        batch.push(row);
        rows_read += 1;

        if batch.len() >= write_batch_size {
            let rows = std::mem::replace(&mut batch, Vec::with_capacity(write_batch_size));
            if write_columns.is_empty() {
                write_columns = columns.clone();
            }
            match dst
                .bulk_write_native(
                    "migration_test",
                    &write_columns,
                    rows,
                    &ConflictStrategy::Insert,
                    &[],
                    "mysql",
                )
                .await
            {
                Ok(n) => rows_written += n as u64,
                Err(e) => {
                    rows_failed += write_batch_size as u64;
                    eprintln!("[ERROR] bulk_write_native: {}", e);
                }
            }
        }

        if rows_read % 2000 == 0 {
            let elapsed = start.elapsed().as_secs_f64();
            let rps = rows_read as f64 / elapsed.max(0.001);
            println!(
                "[PROGRESS] read={} written={} failed={} ({:.0} rows/s, {:.2}s)",
                rows_read, rows_written, rows_failed, rps, elapsed
            );
        }
    }

    // Drain remainder
    if !batch.is_empty() {
        let row_count = batch.len();
        let rows = std::mem::take(&mut batch);
        if write_columns.is_empty() {
            write_columns = columns.clone();
        }
        match dst
            .bulk_write_native(
                "migration_test",
                &write_columns,
                rows,
                &ConflictStrategy::Insert,
                &[],
                "mysql",
            )
            .await
        {
            Ok(n) => rows_written += n as u64,
            Err(e) => {
                rows_failed += row_count as u64;
                eprintln!("[ERROR] bulk_write_native (remainder): {}", e);
            }
        }
    }

    let elapsed = start.elapsed().as_secs_f64();
    println!("\n[4] Migration summary:");
    println!(
        "    read={}  written={}  failed={}",
        rows_read, rows_written, rows_failed
    );
    println!(
        "    elapsed={:.2}s  throughput={:.0} rows/s",
        elapsed,
        rows_read as f64 / elapsed.max(0.001)
    );

    // Verify target
    let dst_qr = dst
        .execute("SELECT COUNT(*) FROM e2e_dst_test.migration_test")
        .await
        .expect("count target");
    let dst_after = extract_count(&dst_qr);
    println!("[5] Target after: {} rows", dst_after);

    let sample = dst
        .execute("SELECT id, name, score FROM e2e_dst_test.migration_test ORDER BY id LIMIT 1")
        .await
        .expect("sample");
    if let Some(row) = sample.rows.first() {
        println!("[6] Sample: id={}, name={}, score={}", row[0], row[1], row[2]);
    }

    assert_eq!(rows_read, total_rows, "Should read all source rows");
    assert_eq!(rows_written, total_rows, "Should write all rows to target");
    assert_eq!(rows_failed, 0, "No rows should fail");
    assert_eq!(dst_after, total_rows, "Target count must match source");
    println!("\n=== ALL ASSERTIONS PASSED ===");
}

/// Plan test 8: regression guard for the "UI shows 0% until completion" bug.
///
/// Seeds 10k rows into a source table, computes 8 PK splits, and runs
/// `DirectTransferExecutor::execute_batched` against real MySQL with an
/// on_chunk callback that drives a synthesized `rows_written` counter —
/// mirroring how `pipeline.rs::try_direct_transfer` wires callbacks into
/// `PipelineStats`.
///
/// A probe task samples the counter every 50 ms for the whole run. The
/// assertion is that at least one sample lands in the open interval
/// `(0, 10_000)`: if all samples were 0 or 10_000, the batched path
/// regressed back to "stats only update on completion" — which is the
/// exact bug this feature fixes.
///
/// Run with:
///   cargo test --lib test_e2e_direct_transfer_batched_progress_visible -- --ignored --nocapture
#[tokio::test]
#[ignore = "requires local MySQL at localhost:3306 with e2e_src_test/e2e_dst_test DBs"]
async fn test_e2e_direct_transfer_batched_progress_visible() {
    use crate::datasource::DataSource;
    use crate::datasource::mysql::{MySqlDataSource, Dialect};
    use crate::migration::direct_transfer::{
        DirectTransferConfig, DirectTransferExecutor,
    };
    use crate::migration::splitter::compute_pk_splits;

    const TOTAL_ROWS: u64 = 10_000;
    const SPLIT_COUNT: usize = 8; // parallelism=4 * 2 per the pipeline formula
    const SRC_DB: &str = "e2e_src_test";
    const DST_DB: &str = "e2e_dst_test";
    const SRC_TABLE: &str = "e2e_dt_batched_src";
    const DST_TABLE: &str = "e2e_dt_batched_dst";

    let src_cfg = make_config(SRC_DB);
    let dst_cfg = make_config(DST_DB);

    let src: Arc<dyn DataSource> = Arc::new(
        MySqlDataSource::new_for_migration(&src_cfg, Dialect::MySQL)
            .await
            .expect("connect source"),
    );
    let dst: Arc<dyn DataSource> = Arc::new(
        MySqlDataSource::new_for_migration(&dst_cfg, Dialect::MySQL)
            .await
            .expect("connect target"),
    );

    // ── Setup: fresh tables on both sides ─────────────────────────────
    // Idempotent so rerunning the test doesn't leak prior state.
    let create_src = format!(
        "CREATE TABLE IF NOT EXISTS {}.{} (id BIGINT PRIMARY KEY, val VARCHAR(64))",
        SRC_DB, SRC_TABLE,
    );
    let create_dst = format!(
        "CREATE TABLE IF NOT EXISTS {}.{} (id BIGINT PRIMARY KEY, val VARCHAR(64))",
        DST_DB, DST_TABLE,
    );
    src.execute(&create_src).await.expect("create src table");
    dst.execute(&create_dst).await.expect("create dst table");

    let truncate_src = format!("TRUNCATE TABLE {}.{}", SRC_DB, SRC_TABLE);
    let truncate_dst = format!("TRUNCATE TABLE {}.{}", DST_DB, DST_TABLE);
    src.execute(&truncate_src).await.expect("truncate src");
    dst.execute(&truncate_dst).await.expect("truncate dst");

    // ── Seed: 10k rows via chunked multi-value INSERTs ────────────────
    const INSERT_CHUNK: u64 = 1000;
    let mut id = 0u64;
    while id < TOTAL_ROWS {
        let upper = (id + INSERT_CHUNK).min(TOTAL_ROWS);
        let values: Vec<String> = (id..upper).map(|i| format!("({}, 'v{}')", i, i)).collect();
        let sql = format!(
            "INSERT INTO {}.{} (id, val) VALUES {}",
            SRC_DB, SRC_TABLE, values.join(", "),
        );
        src.execute(&sql).await.expect("seed source");
        id = upper;
    }
    println!("[seed] inserted {} rows into {}.{}", TOTAL_ROWS, SRC_DB, SRC_TABLE);

    // ── Compute splits (matches pipeline.rs batched path) ─────────────
    let src_query = format!("SELECT * FROM {}.{}", SRC_DB, SRC_TABLE);
    let splits = compute_pk_splits(&*src, &src_query, "id", "mysql", SPLIT_COUNT)
        .await
        .expect("compute splits");
    assert_eq!(
        splits.len(),
        SPLIT_COUNT,
        "expected {} splits for 10k rows, got {:?}",
        SPLIT_COUNT, splits
    );

    // ── Probe task: samples rows_written every 50 ms during the run ───
    // Mirrors how the production heartbeat reads `PipelineStats`.
    let rows_written = Arc::new(AtomicU64::new(0));
    let probe_stop = Arc::new(AtomicBool::new(false));
    let observations: Arc<std::sync::Mutex<Vec<u64>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    let probe_rows = rows_written.clone();
    let probe_stop_flag = probe_stop.clone();
    let probe_obs = observations.clone();
    let probe = tokio::spawn(async move {
        while !probe_stop_flag.load(Ordering::Relaxed) {
            let w = probe_rows.load(Ordering::Relaxed);
            probe_obs.lock().unwrap().push(w);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });

    // ── Run: batched DirectTransfer with per-chunk callback ───────────
    let cfg = DirectTransferConfig {
        src_db: SRC_DB.into(),
        src_table: SRC_TABLE.into(),
        dst_db: DST_DB.into(),
        dst_table: DST_TABLE.into(),
        column_mappings: vec![], // wildcard → SELECT *
        where_clause: None,
    };
    let cancel = CancellationToken::new();
    let cb_rows = rows_written.clone();
    let on_chunk = move |_i: usize, n: u64| {
        cb_rows.fetch_add(n, Ordering::Relaxed);
    };

    let start = Instant::now();
    let result = DirectTransferExecutor::execute_batched(
        &*dst, &cfg, "mysql", "id", &splits, &cancel, on_chunk,
    )
    .await
    .expect("batched direct transfer");
    let elapsed = start.elapsed().as_secs_f64();

    // Stop the probe and collect observations.
    probe_stop.store(true, Ordering::Relaxed);
    probe.await.expect("probe task");

    // ── Correctness checks ────────────────────────────────────────────
    assert_eq!(result.rows_written, TOTAL_ROWS, "all rows should land in dst");
    assert_eq!(result.chunk_count as usize, SPLIT_COUNT, "expected chunked run");
    assert!(result.already_accounted, "batched path must set already_accounted");
    assert_eq!(
        rows_written.load(Ordering::Relaxed),
        TOTAL_ROWS,
        "callback must accumulate exactly total rows"
    );

    // Verify target via COUNT(*).
    let dst_qr = dst
        .execute(&format!("SELECT COUNT(*) FROM {}.{}", DST_DB, DST_TABLE))
        .await
        .expect("count target");
    assert_eq!(extract_count(&dst_qr), TOTAL_ROWS, "target count mismatch");

    // ── Progress-visibility assertion (the regression guard) ──────────
    // At least one probe sample must land strictly between 0 and TOTAL_ROWS.
    // If stats only update on completion, every sample will be 0 or 10_000.
    let obs = observations.lock().unwrap();
    let intermediate = obs
        .iter()
        .filter(|&&w| w > 0 && w < TOTAL_ROWS)
        .count();
    println!(
        "[probe] {} samples collected in {:.3}s, {} intermediate (0 < w < {}): {:?}",
        obs.len(), elapsed, intermediate, TOTAL_ROWS, &*obs,
    );
    assert!(
        intermediate >= 1,
        "expected at least one probe sample with 0 < rows_written < {} \
         (progress visibility regressed to end-of-run updates). Samples: {:?}",
        TOTAL_ROWS, &*obs,
    );

    println!("=== batched-progress-visible ASSERTIONS PASSED ===");
}
