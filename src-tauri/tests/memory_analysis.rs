//! 内存消耗分析测试
//!
//! 分析 pipeline 各组件的内存消耗：
//! 1. MigrationRow 结构大小
//! 2. 批次大小对内存的影响
//! 3. byte_gate 控制效果

use std::mem::size_of;

fn main() {
    println!("==========================================");
    println!("   Pipeline 内存消耗分析");
    println!("==========================================");
    println!();

    // 1. 分析 MigrationRow 结构大小
    println!("[1] MigrationRow 结构分析:");
    println!("  - MigrationValue enum: {} bytes", size_of::<MigrationValue>());
    println!("  - Vec<MigrationValue> overhead: {} bytes", size_of::<Vec<MigrationValue>>());
    println!("  - MigrationRow struct: {} bytes", size_of::<MigrationRow>());

    // 估算每行实际内存消耗（33 列）
    let cols = 33;
    let row_struct_size = size_of::<MigrationRow>();
    let values_size = cols * size_of::<MigrationValue>();
    let row_total_estimate = row_struct_size + values_size;

    println!("  - 每行估算内存（{} 列）: {} bytes", cols, row_total_estimate);

    // 2. 分析 MigrationValue 各变体大小
    println!();
    println!("[2] MigrationValue 变体大小:");
    println!("  - Null: ~{} bytes", size_of::<Option<String>>());
    println!("  - Bool: {} bytes", size_of::<bool>());
    println!("  - Int (i64): {} bytes", size_of::<i64>());
    println!("  - UInt (u64): {} bytes", size_of::<u64>());
    println!("  - Float (f64): {} bytes", size_of::<f64>());
    println!("  - Decimal (String): {} bytes + string len", size_of::<String>());
    println!("  - Text (String): {} bytes + string len", size_of::<String>());
    println!("  - Blob (Vec<u8>): {} bytes + blob len", size_of::<Vec<u8>>());

    // 3. 分析用户配置下的内存消耗
    println!();
    println!("[3] 用户配置内存消耗计算:");
    println!("  配置:");
    println!("    - parallelism = 8");
    println!("    - read_batch = 5000");
    println!("    - write_batch = 2048");
    println!("    - byte_capacity = 8MB (默认)");
    println!("    - channel_capacity = 32 (默认)");

    // 计算理论最大内存
    let parallelism = 8;
    let read_batch = 5000;
    let write_batch = 2048;
    let channel_capacity = 32;
    let byte_capacity_mb = 8;

    // 每行实际大小估算（基于测试数据）
    let avg_row_bytes = 2048;  // 约 2KB（包含 TEXT/BLOB 列）

    println!();
    println!("  理论计算:");

    // 通道内存（如果不受 byte_capacity 控制）
    let channel_mem: u64 = parallelism as u64 * channel_capacity as u64 * read_batch as u64 * avg_row_bytes as u64;
    let channel_mem_mb = channel_mem / 1024 / 1024;
    println!("    - 通道最大容量（无 byte_gate）: {} MB", channel_mem_mb);

    // writer 缓冲区内存
    let writer_buf_mem = parallelism * write_batch * avg_row_bytes;
    let writer_buf_mem_mb = writer_buf_mem / 1024 / 1024;
    println!("    - writer 缓冲区总计: {} MB", writer_buf_mem_mb);

    // 总峰值（无 byte_gate）
    let total_peak_mb = channel_mem_mb + writer_buf_mem_mb;
    println!("    - 总峰值（无 byte_gate）: {} MB ({:.2} GB)", total_peak_mb, total_peak_mb as f64 / 1024.0);

    // byte_gate 控制
    println!();
    println!("  byte_gate 控制:");
    println!("    - byte_capacity: {} MB", byte_capacity_mb);
    println!("    - 期望峰值: {} MB (加上 writer 缓冲区 {} MB)", byte_capacity_mb + writer_buf_mem_mb, writer_buf_mem_mb);
    println!("    - 期望总计: {} MB ({:.2} GB)", byte_capacity_mb + writer_buf_mem_mb, (byte_capacity_mb + writer_buf_mem_mb) as f64 / 1024.0);

    // 4. 分析用户报告的 20GB 内存消耗来源
    println!();
    println!("[4] 20GB 内存消耗分析:");
    println!("  可能来源:");
    println!("    1. byte_capacity 未生效（配置问题）");
    println!("    2. TEXT/LONGTEXT 列导致 avg_row_bytes >> 2KB");
    println!("    3. 事务批量写入导致累积");

    // 假设 avg_row_bytes = 20KB（包含大文本）
    let large_row_bytes: u64 = 20000;
    let large_channel_mem: u64 = parallelism as u64 * channel_capacity as u64 * read_batch as u64 * large_row_bytes;
    let large_channel_mem_gb = large_channel_mem / 1024 / 1024 / 1024;
    println!("    - 如果 avg_row_bytes = 20KB: {:.2} GB 通道内存", large_channel_mem_gb as f64);

    // 5. 优化建议
    println!();
    println!("[5] 优化建议:");
    println!("  1. 降低 read_batch: 5000 -> 1000");
    println!("     - 减少 5x 通道内存压力");
    println!("  2. 降低 channel_capacity: 32 -> 8");
    println!("     - 减少消息积压");
    println!("  3. 设置 byte_capacity: 4MB（显式配置）");
    println!("     - 确保背压生效");
    println!("  4. 使用 INSERT INTO ... SELECT（服务端执行）");
    println!("     - 零内存占用");

    println!();
    println!("  推荐配置:");
    println!("    SET parallelism = 8,");
    println!("        read_batch = 1000,");
    println!("        write_batch = 500,");
    println!("        channel_capacity = 8,");
    println!("        byte_capacity = 4194304;  -- 4MB");

    println!();
    println!("==========================================");
    println!("   DataX 对比");
    println!("==========================================");
    println!("  DataX 配置:");
    println!("    - byteCapacity = 8MB (默认)");
    println!("    - batchByteSize = 32MB (但实际受 byteCapacity 控制)");
    println!("    - 内存峰值: 4GB（包含 JVM overhead）");
    println!();
    println!("  当前问题:");
    println!("    - byte_capacity 不可通过脚本配置 → 已修复");
    println!("    - writer 缓冲区不受 byte_gate 控制 → 需优化");
}

// 模拟结构体（用于 size_of 分析）
enum MigrationValue {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Decimal(String),
    Text(String),
    Blob(Vec<u8>),
}

struct MigrationRow {
    values: Vec<MigrationValue>,
}