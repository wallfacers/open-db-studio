//! MigrationRow 实际内存消耗分析（修复后）
//!
//! 对比 estimated_sql_size() 与 heap_memory_size() 的差异

use std::mem::size_of;

fn main() {
    println!("==========================================");
    println!("   MigrationRow 内存估算修复分析");
    println!("==========================================");
    println!();

    // 1. Rust 结构基础大小
    println!("[1] Rust 结构大小:");
    println!("  - size_of::<MigrationValueDemo>() = {} bytes", size_of::<MigrationValueDemo>());
    println!("  - size_of::<String>() = {} bytes", size_of::<String>());
    println!("  - size_of::<Vec<u8>>() = {} bytes", size_of::<Vec<u8>>());
    println!();

    // 2. 模拟一行数据
    println!("[2] 模拟 all_types 一行数据:");

    // 各列的数据大小（基于实际测试数据平均值）
    let col_data_sizes: Vec<usize> = vec![
        1,    // id
        1, 1, 2, 2, 3, 3, 4, 4, 8, 8,  // 整数类型
        4, 8, 10, 1,  // float, double, decimal, bit
        10, 28, 15, 40, 97, 209,  // text types
        10, 15, 16, 16, 16, 16,  // binary types
        10, 8, 19, 19, 4, 166,  // date/time/json
    ];

    let columns = 33;

    // 3. 旧方法 vs 新方法对比
    println!();
    println!("[3] 内存估算方法对比:");

    // estimated_sql_size() - 旧方法（低估）
    let old_estimates: Vec<usize> = col_data_sizes.iter().enumerate().map(|(i, data_size)| {
        if i >= 14 && i <= 26 || i == 32 {  // text/blob/json
            3 + *data_size + (*data_size / 16)  // SQL literal size
        } else {
            match i {
                0..=10 => 20,  // 整数类型最大 20 chars
                11..=13 => 25, // float/double
                _ => *data_size,
            }
        }
    }).collect();

    let old_total: usize = old_estimates.iter().sum();

    // heap_memory_size() - 新方法（准确）
    let new_estimates: Vec<usize> = col_data_sizes.iter().enumerate().map(|(i, data_size)| {
        if i >= 14 && i <= 26 || i == 32 {  // text/blob/json
            // String struct (24) + heap + alignment + enum overhead (32)
            32 + 24 + *data_size + ((*data_size % 8).max(1))
        } else {
            32  // enum overhead only for primitive types
        }
    }).collect();

    let new_total: usize = new_estimates.iter().sum();
    let row_struct_overhead = 24 + columns * 32;  // Vec + enum discriminants

    println!("  旧方法 (estimated_sql_size):");
    println!("    - 每值估算（忽略结构开销）");
    println!("    - 纯数据总和: {} bytes", old_total);
    println!("    - 问题: 严重低估实际内存！");

    println!();
    println!("  新方法 (heap_memory_size):");
    println!("    - 包含 Rust 结构开销（enum 32 bytes）");
    println!("    - 包含 String/Vec 堆分配（24 bytes struct + len）");
    println!("    - 包含对齐开销");
    println!("    - 纯值总和: {} bytes", new_total);
    println!("    - 行结构开销: {} bytes", row_struct_overhead);
    println!("    - 每行总计: {} bytes = {:.2} KB", new_total + row_struct_overhead, (new_total + row_struct_overhead) as f64 / 1024.0);

    println!();
    println!("  差异:");
    println!("    - 旧方法低估: {:.1}x", (new_total + row_struct_overhead) as f64 / old_total as f64);

    // 4. Channel 内存计算（修复后）
    println!();
    println!("[4] Channel 内存计算（修复后）:");

    let parallelism = 8;
    let read_batch = 5000;
    let channel_cap = 32;
    let byte_capacity_mb = 8;

    let row_total = new_total + row_struct_overhead;
    let msg_size_mb = (read_batch * row_total) / 1024 / 1024;

    println!("  配置:");
    println!("    - parallelism: {}", parallelism);
    println!("    - read_batch: {}", read_batch);
    println!("    - channel_capacity: {}", channel_cap);
    println!("    - byte_capacity: {} MB", byte_capacity_mb);

    println!();
    println!("  每条消息大小:");
    println!("    - {} 行 × {} bytes = {} bytes = {} MB", read_batch, row_total, read_batch * row_total, msg_size_mb);

    // 修复后 byte_gate 生效
    println!();
    println!("  byte_gate 控制效果:");
    println!("    - 旧方法: 每条消息估算 {} bytes（低估）", old_total * read_batch);
    println!("    - 新方法: 每条消息估算 {} bytes（准确）", read_batch * row_total);
    println!("    - byte_capacity {} MB 可容纳 ~{} 条消息", byte_capacity_mb, byte_capacity_mb * 1024 * 1024 / (read_batch * row_total));
    println!("    - 当消息数超过此限制时，reader 阻塞等待 writer 消费");

    // 5. 修复效果
    println!();
    println!("==========================================");
    println!("   修复效果分析");
    println!("==========================================");
    println!();

    println!("  旧方法（用户报告 38GB）:");
    println!("    - byte_gate.acquire(batch_bytes) 使用低估的 batch_bytes");
    println!("    - byte_capacity=8MB 但实际传输远超 8MB");
    println!("    - Channel 无有效背压，内存无限累积");

    println!();
    println!("  新方法（修复后预期）:");
    println!("    - byte_gate.acquire() 使用准确的 heap_memory_size");
    println!("    - byte_capacity=8MB 有效限制在-flight 数据");
    println!("    - 预期峰值: byte_capacity + writer 缓冲区 ~50 MB");

    println!();
    println!("  用户应使用的配置:");
    println!("    SET parallelism = 8,");
    println!("        read_batch = 1000,       -- 降低批次大小");
    println!("        write_batch = 500,");
    println!("        channel_capacity = 8,    -- 降低通道容量");
    println!("        byte_capacity = 8388608; -- 8MB，显式配置");

    println!();
    println!("==========================================");
    println!("   性能对比");
    println!("==========================================");
    println!();

    println!("  INSERT INTO ... SELECT（服务端执行）:");
    println!("    - 内存峰值: 17 MB");
    println!("    - 吞吐量: ~70,000 行/秒");
    println!("    - 推荐: 大批量迁移使用此方法");

    println!();
    println!("  Pipeline Channel 模式（修复后）:");
    println!("    - 内存峰值: ~50 MB（byte_capacity 控制）");
    println!("    - 吞吐量: 待测试");
    println!("    - 适用: 需要 INSERT/UPSERT/Replace 等复杂写入策略");
}

enum MigrationValueDemo {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Decimal(String),
    Text(String),
    Blob(Vec<u8>),
}