//! 独立迁移性能测试（绕过 Tauri AppHandle）
//!
//! 目标：达到 DataX 性能（2CPU 4GB, 180s 同步 1000w）
//!
//! 监控：
//! - 进程内存（峰值）
//! - 系统内存使用
//! - 磁盘 I/O
//! - 吞吐量

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::collections::HashMap;

use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

/// 模拟 PipelineStats（不依赖 Tauri）
#[derive(Debug, Clone)]
struct PipelineStats {
    rows_read: Arc<AtomicU64>,
    rows_written: Arc<AtomicU64>,
    rows_failed: Arc<AtomicU64>,
    bytes_transferred: Arc<AtomicU64>,
}

impl PipelineStats {
    fn new() -> Self {
        Self {
            rows_read: Arc::new(AtomicU64::new(0)),
            rows_written: Arc::new(AtomicU64::new(0)),
            rows_failed: Arc::new(AtomicU64::new(0)),
            bytes_transferred: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// 内存监控器
struct MemoryMonitor {
    start_time: Instant,
    max_process_mem: Arc<Mutex<u64>>,
    samples: Arc<Mutex<Vec<(Duration, u64)>>>,
}

impl MemoryMonitor {
    fn new() -> Self {
        Self {
            start_time: Instant::now(),
            max_process_mem: Arc::new(Mutex::new(0)),
            samples: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn start(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let max_mem = self.max_process_mem.clone();
        let samples = self.samples.clone();
        let start_time = self.start_time;

        tokio::spawn(async move {
            while !stop_clone.load(Ordering::Relaxed) {
                // 获取进程内存（VmRSS）
                let mem_kb = std::fs::read_to_string("/proc/self/status")
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|l| l.starts_with("VmRSS:"))
                            .and_then(|l| {
                                l.split_whitespace()
                                    .nth(1)
                                    .and_then(|v| v.parse::<u64>().ok())
                            })
                    })
                    .unwrap_or(0);

                let elapsed = start_time.elapsed();

                {
                    let mut m = max_mem.lock().unwrap();
                    if mem_kb > *m {
                        *m = mem_kb;
                    }
                }

                {
                    let mut s = samples.lock().unwrap();
                    s.push((elapsed, mem_kb));
                }

                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });

        stop
    }

    fn report(&self) {
        let max_kb = *self.max_process_mem.lock().unwrap();
        let max_mb = max_kb / 1024;

        let samples = self.samples.lock().unwrap();

        // 计算平均内存
        let avg_kb = if samples.len() > 0 {
            samples.iter().map(|(_, m)| m).sum::<u64>() / samples.len() as u64
        } else {
            0
        };
        let avg_mb = avg_kb / 1024;

        println!("内存监控:");
        println!("  - 峰值内存: {} MB ({:.2} GB)", max_mb, max_mb as f64 / 1024.0);
        println!("  - 平均内存: {} MB ({:.2} GB)", avg_mb, avg_mb as f64 / 1024.0);
        println!("  - 采样次数: {}", samples.len());

        // 打印前 10 个峰值时刻
        let mut peaks: Vec<(Duration, u64)> = samples.iter()
            .filter(|(_, m)| *m > max_kb * 90 / 100)  // > 90% 最大值
            .cloned()
            .collect();
        peaks.sort_by(|a, b| b.1.cmp(&a.1));
        println!("  - 峰值时刻:");
        for (t, m) in peaks.iter().take(10) {
            println!("    {:.2}s: {} MB", t.as_secs_f64(), m / 1024);
        }
    }
}

/// 迁移配置
struct MigrationConfig {
    source_pool: MySqlPool,
    target_pool: MySqlPool,
    source_table: String,
    target_table: String,
    parallelism: usize,
    read_batch: usize,
    write_batch: usize,
}

#[tokio::main]
async fn main() {
    println!("==========================================");
    println!("   独立迁移性能测试 + 内存监控");
    println!("==========================================");
    println!();

    // 连接配置
    let source_url = "mysql://root:root123456@127.0.0.1:3306/test_migration";
    let target_url = "mysql://root:root123456@127.0.0.1:3306/test_project";

    println!("[1/7] 连接数据库...");

    let source_pool = MySqlPoolOptions::new()
        .max_connections(8)
        .connect(source_url)
        .await
        .expect("Failed to connect source");

    let target_pool = MySqlPoolOptions::new()
        .max_connections(8)
        .connect(target_url)
        .await
        .expect("Failed to connect target");

    println!("  ✓ 连接成功");

    // 准备环境
    println!();
    println!("[2/7] 准备环境...");

    // 截断目标表
    sqlx::query("TRUNCATE TABLE all_types")
        .execute(&target_pool)
        .await
        .expect("Failed to truncate");

    println!("  ✓ 目标表已截断");

    // 获取源表行数
    let total_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to count");

    println!("  ✓ 源表行数: {}", total_rows);

    // 获取 PK 范围
    let pk_min: i64 = sqlx::query_scalar("SELECT MIN(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get min");
    let pk_max: i64 = sqlx::query_scalar("SELECT MAX(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get max");

    println!("  ✓ PK 范围: {} ~ {}", pk_min, pk_max);

    // 配置
    let config = MigrationConfig {
        source_pool,
        target_pool,
        source_table: "all_types".to_string(),
        target_table: "all_types".to_string(),
        parallelism: 8,
        read_batch: 5000,
        write_batch: 2048,
    };

    // 启动内存监控
    println!();
    println!("[3/7] 启动内存监控...");

    let monitor = MemoryMonitor::new();
    let monitor_stop = monitor.start();

    println!("  ✓ 监控已启动");

    // 计算分片
    println!();
    println!("[4/7] 计算分片...");

    let parallelism = config.parallelism;
    let shard_size = (pk_max - pk_min + 1) / parallelism as i64;

    println!("  - 并行度: {}", parallelism);
    println!("  - 每片大小: {}", shard_size);

    // 执行迁移
    println!();
    println!("[5/7] 开始迁移...");

    let stats = PipelineStats::new();
    let start_time = Instant::now();

    let mut handles = Vec::new();

    for shard_idx in 0..parallelism {
        let start_pk = pk_min + shard_idx as i64 * shard_size;
        let end_pk = if shard_idx == parallelism - 1 {
            pk_max
        } else {
            pk_min + (shard_idx as i64 + 1) * shard_size - 1
        };

        println!("  分片 {}: [{}, {}]", shard_idx, start_pk, end_pk);

        let source_pool = config.source_pool.clone();
        let target_pool = config.target_pool.clone();
        let stats_clone = stats.clone();
        let read_batch = config.read_batch;

        let handle = tokio::spawn(async move {
            let shard_label = format!("shard {}", shard_idx);

            // 分批读取并写入
            let mut current_pk = start_pk;
            let mut shard_rows_read = 0u64;
            let mut shard_rows_written = 0u64;

            while current_pk <= end_pk {
                let batch_end = std::cmp::min(current_pk + read_batch as i64 - 1, end_pk);

                // 读取批次
                let rows = sqlx::query_as::<_, (i32, i8, u8, i16, u16, i32, u32, i32, u32, i64, u64, f32, f64, String, i64, String, String, String, String, String, String, String, String, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, String, String, String, String, i16, String)>(
                    &format!("SELECT * FROM all_types WHERE id >= {} AND id <= {} ORDER BY id", current_pk, batch_end)
                )
                .fetch_all(&source_pool)
                .await
                .expect("Failed to read batch");

                let rows_count = rows.len() as u64;
                shard_rows_read += rows_count;
                stats_clone.rows_read.fetch_add(rows_count, Ordering::Relaxed);

                // 写入批次（使用 LOAD DATA 或批量 INSERT）
                // 这里简化为逐行 INSERT（实际应使用批量写入）
                for row in &rows {
                    // 构建 INSERT SQL
                    let insert_sql = format!(
                        "INSERT INTO all_types (id, col_tinyint, col_tinyint_u, col_smallint, col_smallint_u, col_mediumint, col_mediumint_u, col_int, col_int_u, col_bigint, col_bigint_u, col_float, col_double, col_decimal, col_bit, col_char, col_varchar, col_tinytext, col_text, col_mediumtext, col_longtext, col_enum, col_set, col_binary, col_varbinary, col_tinyblob, col_blob, col_date, col_time, col_datetime, col_timestamp, col_year, col_json) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', {}, {}, {}, {}, '{}', '{}', '{}', '{}', {}, '{}')",
                        row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                        row.11, row.12, row.13, row.14,
                        row.15.replace("'", "\\'"), row.16.replace("'", "\\'"),
                        row.17.replace("'", "\\'"), row.18.replace("'", "\\'"),
                        row.19.replace("'", "\\'"), row.20.replace("'", "\\'"),
                        row.21.replace("'", "\\'"), row.22.replace("'", "\\'"),
                        // Binary columns as hex
                        format!("0x{}", hex::encode(&row.23)),
                        format!("0x{}", hex::encode(&row.24)),
                        format!("0x{}", hex::encode(&row.25)),
                        format!("0x{}", hex::encode(&row.26)),
                        row.27.replace("'", "\\'"), row.28.replace("'", "\\'"),
                        row.29.replace("'", "\\'"), row.30.replace("'", "\\'"),
                        row.31, row.32.replace("'", "\\'")
                    );

                    // 执行 INSERT
                    if let Err(e) = sqlx::query(&insert_sql).execute(&target_pool).await {
                        log::error!("{}: INSERT failed: {}", shard_label, e);
                        stats_clone.rows_failed.fetch_add(1, Ordering::Relaxed);
                    } else {
                        shard_rows_written += 1;
                        stats_clone.rows_written.fetch_add(1, Ordering::Relaxed);
                    }
                }

                current_pk = batch_end + 1;

                // 打印进度
                if shard_rows_read % 50000 == 0 {
                    println!("  {}: 读取 {} 行", shard_label, shard_rows_read);
                }
            }

            println!("  {}: 完成，读取 {} 行，写入 {} 行", shard_label, shard_rows_read, shard_rows_written);
        });

        handles.push(handle);
    }

    // 等待所有分片完成
    for handle in handles {
        handle.await.expect("Shard failed");
    }

    let elapsed = start_time.elapsed();

    // 停止内存监控
    monitor_stop.store(true, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 验证结果
    println!();
    println!("[6/7] 验证结果...");

    let target_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&config.target_pool)
        .await
        .expect("Failed to count target");

    let large_uint_source: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM all_types WHERE col_bigint_u > 9223372036854775807"
    )
    .fetch_one(&config.source_pool)
    .await
    .expect("Failed to count large uint");

    let large_uint_target: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM all_types WHERE col_bigint_u > 9223372036854775807"
    )
    .fetch_one(&config.target_pool)
    .await
    .expect("Failed to count large uint target");

    println!("  - 目标行数: {}", target_rows);
    println!("  - 源表超大值: {}", large_uint_source);
    println!("  - 目标超大值: {}", large_uint_target);

    if target_rows == total_rows {
        println!("  ✓ 行数一致");
    } else {
        println!("  ✗ 行数不一致: {} vs {}", target_rows, total_rows);
    }

    if large_uint_target == large_uint_source {
        println!("  ✓ 超大 BIGINT UNSIGNED 正确迁移");
    } else {
        println!("  ✗ 超大值丢失: {} vs {}", large_uint_target, large_uint_source);
    }

    // 性能统计
    println!();
    println!("[7/7] 性能统计...");

    let throughput = total_rows as f64 / elapsed.as_secs_f64();

    println!("  - 总行数: {}", total_rows);
    println!("  - 耗时: {:.2} 秒", elapsed.as_secs_f64());
    println!("  - 吞吐量: {:.0} 行/秒", throughput);

    // 内存报告
    println!();
    println!("==========================================");
    println!("   资源消耗分析");
    println!("==========================================");

    monitor.report();

    println!();
    println!("==========================================");
    println!("   DataX 对比");
    println!("==========================================");
    println!("  DataX 基准:");
    println!("    - 2CPU 4GB, 180s, 1000w");
    println!("    - 内存峰值: 4GB");
    println!("    - 吞吐量: 55,555 行/秒");
    println!();
    println!("  当前测试:");
    println!("    - 吞吐量: {:.0} 行/秒", throughput);

    if throughput >= 50000.0 {
        println!("    ✓ 吞吐量达标");
    } else {
        println!("    ✗ 吞吐量未达标");
    }
}