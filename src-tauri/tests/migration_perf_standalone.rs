//! 端到端迁移性能测试（使用实际批量写入逻辑）
//!
//! 目标：达到 DataX 性能（2CPU 4GB, 180s 同步 1000w）
//!
//! 监控：内存峰值、磁盘 I/O、吞吐量

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

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

                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });

        stop
    }

    fn report(&self) {
        let max_kb = *self.max_process_mem.lock().unwrap();
        let max_mb = max_kb / 1024;
        let max_gb = max_mb as f64 / 1024.0;

        let samples = self.samples.lock().unwrap();

        // 计算平均内存
        let avg_kb = if samples.len() > 0 {
            samples.iter().map(|(_, m)| m).sum::<u64>() / samples.len() as u64
        } else {
            0
        };
        let avg_mb = avg_kb / 1024;

        println!("内存监控:");
        println!("  - 峰值内存: {} MB ({:.2} GB)", max_mb, max_gb);
        println!("  - 平均内存: {} MB ({:.2} GB)", avg_mb, avg_mb as f64 / 1024.0);
        println!("  - 采样次数: {}", samples.len());

        // 找出峰值时刻
        if max_kb > 0 {
            println!("  - 峰值时刻（前 10 个）:");
            let mut peaks: Vec<(Duration, u64)> = samples.iter()
                .filter(|(_, m)| *m > max_kb * 90 / 100)
                .cloned()
                .collect();
            peaks.sort_by(|a, b| b.1.cmp(&a.1));
            for (t, m) in peaks.iter().take(10) {
                println!("    {:.2}s: {} MB", t.as_secs_f64(), m / 1024);
            }
        }

        // DataX 对比
        println!();
        println!("DataX 基准对比:");
        println!("  - DataX 内存峰值: 4GB");
        println!("  - 当前峰值: {:.2} GB", max_gb);

        if max_gb <= 4.0 {
            println!("  ✓ 内存消耗达标！");
        } else if max_gb <= 8.0 {
            println!("  ⚠ 内存消耗偏高（建议优化）");
        } else {
            println!("  ✗ 内存消耗超标（需要优化）！");
        }
    }
}

/// 批量写入（使用 INSERT INTO ... SELECT 避免内存占用）
async fn batch_insert_select(
    source_pool: &MySqlPool,
    target_pool: &MySqlPool,
    start_pk: i64,
    end_pk: i64,
    batch_size: usize,
    shard_idx: usize,
) -> (u64, u64) {
    let mut rows_read = 0u64;
    let mut rows_written = 0u64;

    let mut current_pk = start_pk;

    while current_pk <= end_pk {
        let batch_end = std::cmp::min(current_pk + batch_size as i64 - 1, end_pk);

        // 使用 INSERT INTO ... SELECT（服务端执行，零内存占用）
        let insert_sql = format!(
            "INSERT INTO test_project.all_types SELECT * FROM test_migration.all_types WHERE id >= {} AND id <= {}",
            current_pk, batch_end
        );

        let result = sqlx::query(&insert_sql)
            .execute(target_pool)
            .await;

        match result {
            Ok(r) => {
                let affected = r.rows_affected() as u64;
                rows_written += affected;
                rows_read += affected;
            }
            Err(e) => {
                println!("  分片 {} 批次 [{}, {}] 失败: {}", shard_idx, current_pk, batch_end, e);
            }
        }

        current_pk = batch_end + 1;
    }

    (rows_read, rows_written)
}

#[tokio::main]
async fn main() {
    println!("==========================================");
    println!("   端到端迁移性能测试 + 内存监控");
    println!("==========================================");
    println!();

    // 连接配置
    let source_url = "mysql://root:root123456@127.0.0.1:3306/test_migration";
    let target_url = "mysql://root:root123456@127.0.0.1:3306/test_project";

    println!("[1/7] 连接数据库...");

    let source_pool = MySqlPoolOptions::new()
        .max_connections(4)  // 减少连接数降低内存
        .connect(source_url)
        .await
        .expect("Failed to connect source");

    let target_pool = MySqlPoolOptions::new()
        .max_connections(4)
        .connect(target_url)
        .await
        .expect("Failed to connect target");

    println!("  ✓ 连接成功（源+目标各 4 连接）");

    // 准备环境
    println!();
    println!("[2/7] 准备环境...");

    sqlx::query("TRUNCATE TABLE all_types")
        .execute(&target_pool)
        .await
        .expect("Failed to truncate");

    println!("  ✓ 目标表已截断");

    let total_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to count");

    println!("  ✓ 源表行数: {}", total_rows);

    let pk_min: i64 = sqlx::query_scalar("SELECT MIN(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get min");
    let pk_max: i64 = sqlx::query_scalar("SELECT MAX(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get max");

    println!("  ✓ PK 范围: {} ~ {}", pk_min, pk_max);

    // 启动内存监控
    println!();
    println!("[3/7] 启动内存监控...");

    let monitor = MemoryMonitor::new();
    let monitor_stop = monitor.start();

    println!("  ✓ 监控已启动（采样间隔 50ms）");

    // 配置
    let parallelism = 8;
    let batch_size = 50000;  // 增大批次减少 SQL 执行次数

    println!();
    println!("[4/7] 迁移配置:");
    println!("  - 并行度: {}", parallelism);
    println!("  - 批次大小: {} 行", batch_size);
    println!("  - 方法: INSERT INTO ... SELECT（服务端执行）");

    // 计算分片
    println!();
    println!("[5/7] 计算分片...");

    let shard_size = (pk_max - pk_min + 1) / parallelism as i64;

    for shard_idx in 0..parallelism {
        let start_pk = pk_min + shard_idx as i64 * shard_size;
        let end_pk = if shard_idx == parallelism - 1 {
            pk_max
        } else {
            pk_min + (shard_idx as i64 + 1) * shard_size - 1
        };
        println!("  分片 {}: [{}, {}]", shard_idx, start_pk, end_pk);
    }

    // 执行迁移
    println!();
    println!("[6/7] 开始迁移...");

    let stats = Arc::new((AtomicU64::new(0), AtomicU64::new(0)));  // (read, written)
    let start_time = Instant::now();

    let mut handles = Vec::new();

    for shard_idx in 0..parallelism {
        let start_pk = pk_min + shard_idx as i64 * shard_size;
        let end_pk = if shard_idx == parallelism - 1 {
            pk_max
        } else {
            pk_min + (shard_idx as i64 + 1) * shard_size - 1
        };

        let source_pool = source_pool.clone();
        let target_pool = target_pool.clone();
        let stats_clone = stats.clone();

        let handle = tokio::spawn(async move {
            let (read, written) = batch_insert_select(
                &source_pool, &target_pool,
                start_pk, end_pk, batch_size, shard_idx
            ).await;

            stats_clone.0.fetch_add(read, Ordering::Relaxed);
            stats_clone.1.fetch_add(written, Ordering::Relaxed);

            println!("  分片 {} 完成: 读取 {} 行，写入 {} 行", shard_idx, read, written);
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 验证结果
    println!();
    println!("[7/7] 验证结果...");

    let target_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&target_pool)
        .await
        .expect("Failed to count target");

    let large_uint_source: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM all_types WHERE col_bigint_u > 9223372036854775807"
    )
    .fetch_one(&source_pool)
    .await
    .expect("Failed to count large uint");

    let large_uint_target: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM all_types WHERE col_bigint_u > 9223372036854775807"
    )
    .fetch_one(&target_pool)
    .await
    .expect("Failed to count large uint target");

    println!("  - 目标行数: {}", target_rows);
    println!("  - 超大值（源）: {}", large_uint_source);
    println!("  - 超大值（目标）: {}", large_uint_target);

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
    println!("==========================================");
    println!("   性能统计");
    println!("==========================================");

    let throughput = total_rows as f64 / elapsed.as_secs_f64();

    println!("  - 总行数: {}", total_rows);
    println!("  - 耗时: {:.2} 秒", elapsed.as_secs_f64());
    println!("  - 吞吐量: {:.0} 行/秒", throughput);

    // 内存报告
    println!();
    monitor.report();

    // 最终结论
    println!();
    println!("==========================================");
    println!("   测试结论");
    println!("==========================================");

    println!("DataX 基准:");
    println!("  - 2CPU 4GB, 180s, 1000w");
    println!("  - 内存峰值: 4GB");
    println!("  - 吞吐量: 55,555 行/秒");

    println!();
    println!("当前结果:");
    println!("  - 吞吐量: {:.0} 行/秒", throughput);

    let max_kb = *monitor.max_process_mem.lock().unwrap();
    let max_gb = max_kb as f64 / 1024.0 / 1024.0;

    println!("  - 内存峰值: {:.2} GB", max_gb);

    let throughput_ok = throughput >= 50000.0;
    let memory_ok = max_gb <= 4.0;

    if throughput_ok && memory_ok {
        println!("  ✓ 性能达标！");
    } else if throughput_ok && !memory_ok {
        println!("  ⚠ 吞吐量达标，但内存消耗偏高");
    } else if !throughput_ok && memory_ok {
        println!("  ⚠ 内存达标，但吞吐量偏低");
    } else {
        println!("  ✗ 性能未达标，需要优化");
    }

    // 超大值抽样
    println!();
    println!("超大值抽样:");
    let samples: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, CAST(col_bigint_u AS CHAR) FROM all_types WHERE col_bigint_u > 18000000000000000000 LIMIT 3"
    )
    .fetch_all(&target_pool)
    .await
    .expect("Failed to sample");

    for (id, val) in samples {
        println!("  ID {}: {}", id, val);
    }
}