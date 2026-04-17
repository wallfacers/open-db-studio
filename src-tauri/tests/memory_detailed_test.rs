//! 详细内存监控测试 - 每 10 秒采样
//!
//! 监控迁移过程中的内存消耗，找出内存增长来源

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::mysql::MySqlPoolOptions;

/// 内存采样记录
#[derive(Debug, Clone)]
struct MemorySample {
    timestamp_secs: f64,
    process_mem_mb: u64,
    heap_mem_mb: u64,
    rows_read: u64,
    rows_written: u64,
    mysql_rows_inserted: u64,
}

/// 每 10 秒采样一次内存
struct MemorySampler {
    samples: Arc<Mutex<Vec<MemorySample>>>,
    stop: Arc<AtomicBool>,
    start_time: Instant,
    rows_read: Arc<AtomicU64>,
    rows_written: Arc<AtomicU64>,
}

impl MemorySampler {
    fn new(rows_read: Arc<AtomicU64>, rows_written: Arc<AtomicU64>) -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            stop: Arc::new(AtomicBool::new(false)),
            start_time: Instant::now(),
            rows_read,
            rows_written,
        }
    }

    fn start(&self) {
        let samples = self.samples.clone();
        let stop = self.stop.clone();
        let start_time = self.start_time;
        let rows_read = self.rows_read.clone();
        let rows_written = self.rows_written.clone();

        tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let elapsed = start_time.elapsed();
                let ts = elapsed.as_secs_f64();

                // 进程内存（VmRSS - 实际物理内存使用）
                let process_mem_kb = std::fs::read_to_string("/proc/self/status")
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

                // 进程堆内存（VmSize - 虚拟内存）
                let heap_mem_kb = std::fs::read_to_string("/proc/self/status")
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|l| l.starts_with("VmSize:"))
                            .and_then(|l| {
                                l.split_whitespace()
                                    .nth(1)
                                    .and_then(|v| v.parse::<u64>().ok())
                            })
                    })
                    .unwrap_or(0);

                // MySQL rows_inserted（通过 docker 执行）
                let mysql_rows = std::process::Command::new("docker")
                    .args(["exec", "open-db-studio-mysql", "mysql", "-uroot", "-proot123456", "-N", "-e"])
                    .arg("SHOW STATUS LIKE 'Rows_inserted'")
                    .output()
                    .ok()
                    .and_then(|o| {
                        let output = String::from_utf8_lossy(&o.stdout);
                        output.lines()
                            .last()
                            .and_then(|l| {
                                l.split_whitespace()
                                    .last()
                                    .and_then(|v| v.parse::<u64>().ok())
                            })
                    })
                    .unwrap_or(0);

                let sample = MemorySample {
                    timestamp_secs: ts,
                    process_mem_mb: process_mem_kb / 1024,
                    heap_mem_mb: heap_mem_kb / 1024,
                    rows_read: rows_read.load(Ordering::Relaxed),
                    rows_written: rows_written.load(Ordering::Relaxed),
                    mysql_rows_inserted: mysql_rows,
                };

                // 打印当前状态（使用 sample.clone() 避免移动）
                println!(
                    "[{:7.1}s] 进程内存: {:>5} MB | 堆内存: {:>5} MB | 已读: {:>8} | 已写: {:>8} | MySQL插入: {:>10}",
                    sample.timestamp_secs,
                    sample.process_mem_mb,
                    sample.heap_mem_mb,
                    sample.rows_read,
                    sample.rows_written,
                    sample.mysql_rows_inserted
                );

                {
                    let mut s = samples.lock().unwrap();
                    s.push(sample);
                }

                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    fn report(&self) {
        let samples = self.samples.lock().unwrap();

        if samples.is_empty() {
            println!("无采样数据");
            return;
        }

        println!();
        println!("==========================================");
        println!("   内存消耗详细报告");
        println!("==========================================");
        println!();

        // 找出峰值
        let max_sample = samples.iter().max_by_key(|s| s.process_mem_mb);
        let min_sample = samples.iter().min_by_key(|s| s.process_mem_mb);

        if let (Some(max), Some(min)) = (max_sample, min_sample) {
            println!("峰值分析:");
            println!(
                "  - 最小内存: {} MB (时间: {:.1}s)",
                min.process_mem_mb,
                min.timestamp_secs
            );
            println!(
                "  - 最大内存: {} MB ({:.2} GB) (时间: {:.1}s)",
                max.process_mem_mb,
                max.process_mem_mb as f64 / 1024.0,
                max.timestamp_secs
            );
            println!(
                "  - 内存增长: {} MB ({:.2} GB)",
                max.process_mem_mb - min.process_mem_mb,
                (max.process_mem_mb - min.process_mem_mb) as f64 / 1024.0
            );
        }

        // 内存增长分析
        if samples.len() >= 2 {
            let first = &samples[0];
            let last = &samples[samples.len() - 1];

            let duration_secs = last.timestamp_secs - first.timestamp_secs;
            let mem_growth_mb = last.process_mem_mb - first.process_mem_mb;
            let rows_total = last.rows_written;

            println!();
            println!("增长分析:");
            println!("  - 迁移时长: {:.1} 秒", duration_secs);
            println!("  - 内存增长: {} MB", mem_growth_mb);

            if rows_total > 0 && mem_growth_mb > 0 {
                println!(
                    "  - 每行内存消耗: {:.2} bytes",
                    mem_growth_mb as f64 * 1024.0 * 1024.0 / rows_total as f64
                );
                println!(
                    "  - 内存增长速率: {:.2} MB/秒",
                    mem_growth_mb as f64 / duration_secs
                );
            }
        }

        // 打印时间线
        println!();
        println!("时间线（每 10 秒）:");
        println!("{:-<100}", "");
        println!(
            "{:>10} | {:>12} | {:>12} | {:>10} | {:>10}",
            "时间", "进程内存MB", "堆内存MB", "已读", "已写"
        );
        println!("{:-<100}", "");

        for s in samples.iter() {
            println!(
                "{:>10.1}s | {:>12} | {:>12} | {:>10} | {:>10}",
                s.timestamp_secs,
                s.process_mem_mb,
                s.heap_mem_mb,
                s.rows_read,
                s.rows_written
            );
        }
    }
}

#[tokio::main]
async fn main() {
    println!("==========================================");
    println!("   详细内存监控测试（每 10 秒采样）");
    println!("==========================================");
    println!();

    // 连接数据库
    let source_url = "mysql://root:root123456@127.0.0.1:3306/test_migration";
    let target_url = "mysql://root:root123456@127.0.0.1:3306/test_project";

    println!("[1/5] 连接数据库...");

    let source_pool = MySqlPoolOptions::new()
        .max_connections(4)
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
    println!("[2/5] 准备环境...");

    sqlx::query("TRUNCATE TABLE all_types")
        .execute(&target_pool)
        .await
        .expect("Failed to truncate");

    let total_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to count");

    let pk_min: i64 = sqlx::query_scalar("SELECT MIN(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get min");
    let pk_max: i64 = sqlx::query_scalar("SELECT MAX(id) FROM all_types")
        .fetch_one(&source_pool)
        .await
        .expect("Failed to get max");

    println!("  ✓ 源表行数: {}", total_rows);
    println!("  ✓ PK 范围: {} ~ {}", pk_min, pk_max);

    // 启动内存采样
    println!();
    println!("[3/5] 启动内存采样（每 10 秒）...");

    let rows_read = Arc::new(AtomicU64::new(0));
    let rows_written = Arc::new(AtomicU64::new(0));

    let sampler = MemorySampler::new(rows_read.clone(), rows_written.clone());
    sampler.start();
    println!("  ✓ 采样已启动");

    // 配置
    let parallelism = 8;
    let read_batch = 50000;  // 大批次减少 SQL 执行次数

    println!();
    println!("[4/5] 迁移配置:");
    println!("  - parallelism: {}", parallelism);
    println!("  - read_batch: {}", read_batch);
    println!("  - 方法: INSERT INTO ... SELECT（服务端执行）");

    println!();
    println!("[5/5] 开始迁移...");

    let start_time = Instant::now();

    let shard_size = (pk_max - pk_min + 1) / parallelism as i64;

    let mut handles = Vec::new();

    for shard_idx in 0..parallelism {
        let start_pk = pk_min + shard_idx as i64 * shard_size;
        let end_pk = if shard_idx == parallelism - 1 {
            pk_max
        } else {
            pk_min + (shard_idx as i64 + 1) * shard_size - 1
        };

        let target_pool_c = target_pool.clone();
        let rows_read_c = rows_read.clone();
        let rows_written_c = rows_written.clone();

        let handle = tokio::spawn(async move {
            let mut current_pk = start_pk;

            while current_pk <= end_pk {
                let batch_end = std::cmp::min(current_pk + read_batch as i64 - 1, end_pk);

                // 使用 INSERT INTO ... SELECT（服务端执行，零内存）
                let sql = format!(
                    "INSERT INTO test_project.all_types SELECT * FROM test_migration.all_types WHERE id >= {} AND id <= {}",
                    current_pk, batch_end
                );

                let result = sqlx::query(&sql)
                    .execute(&target_pool_c)
                    .await;

                if let Ok(r) = result {
                    let affected = r.rows_affected() as u64;
                    rows_read_c.fetch_add(affected, Ordering::Relaxed);
                    rows_written_c.fetch_add(affected, Ordering::Relaxed);
                }

                current_pk = batch_end + 1;
            }
        });

        handles.push(handle);
    }

    // 等待完成
    for handle in handles {
        handle.await.expect("Shard failed");
    }

    let elapsed = start_time.elapsed();

    // 等待最后采样
    tokio::time::sleep(Duration::from_secs(1)).await;

    // 停止采样
    sampler.stop();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 输出报告
    sampler.report();

    // 性能统计
    println!();
    println!("==========================================");
    println!("   性能统计");
    println!("==========================================");

    let throughput = total_rows as f64 / elapsed.as_secs_f64();
    println!("  总行数: {}", total_rows);
    println!("  耗时: {:.2} 秒", elapsed.as_secs_f64());
    println!("  吞吐量: {:.0} 行/秒", throughput);

    // 验证数据
    let target_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM all_types")
        .fetch_one(&target_pool)
        .await
        .expect("Failed to count");

    println!();
    println!("数据验证:");
    println!("  目标行数: {}", target_rows);

    if target_rows == total_rows {
        println!("  ✓ 行数一致");
    } else {
        println!("  ✗ 行数不一致");
    }

    // 内存分析对比
    println!();
    println!("==========================================");
    println!("   内存消耗分析");
    println!("==========================================");
    println!();
    println!("当前测试使用 INSERT INTO ... SELECT:");
    println!("  - 数据不传输到应用层（服务端直接复制）");
    println!("  - 内存消耗: 仅 SQL 字符串 + 连接缓冲");
    println!();
    println!("用户报告的 38GB 内存消耗来源:");
    println!("  1. pipeline 使用 channel + MigrationRow");
    println!("  2. 每行数据完整复制到应用层");
    println!("  3. MigrationRow 包含 Vec<MigrationValue>");
    println!("  4. MigrationValue 包含 String/Vec<u8>（堆分配）");
    println!();
    println!("估算（用户配置 parallelism=8, read_batch=5000, channel_cap=32）:");
    println!("  - 通道最大消息数: 8 × 32 = 256 条");
    println!("  - 每条消息包含: 5000 行 × 33 列 × ~626 bytes = ~3 MB");
    println!("  - 通道总容量: 256 × 3 MB = 768 MB（理论）");
    println!("  - 但实际包含 Rust 结构开销:");
    println!("    - MigrationValue enum: 32 bytes");
    println!("    - Vec overhead: 24 bytes");
    println!("    - String heap allocation: 实际长度 + overhead");
    println!("  - 实际每行内存可能 >> 626 bytes");
    println!();
    println!("建议优化:");
    println!("  1. 降低 read_batch: 5000 -> 1000");
    println!("  2. 降低 channel_capacity: 32 -> 8");
    println!("  3. 设置 byte_capacity: 4MB（已添加参数支持）");
    println!("  4. 使用 INSERT INTO ... SELECT（服务端执行）");
}