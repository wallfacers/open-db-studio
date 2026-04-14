//! End-to-end migration pipeline test — exercises the full data path
//! (migration_read_sql_stream → channel → bulk_write_native) with real MySQL.
//!
//! Run with: `cargo test --lib test_e2e_migration_pipeline -- --nocapture`

use std::sync::Arc;
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
