# Migration Performance Optimization Design

> **修订 2026-04-14 (evening)**：基于 `dev` 分支现状重新评估。经对照 `bulk_write.rs`、
> `mysql.rs`、`pipeline.rs` 实现后确认：**原计划 P2（多值 INSERT 合并）与 P3（LOAD DATA 流式化）
> 已在现有代码路径中实现**。本次优化仅需完成 P1（同实例直通 + 策略分派）并放宽若干参数上限。

## Overview

前期排查发现 10M 行迁移耗时 ~81 分钟（DataX 基准 ~180s）。目标是通过同实例直通（服务端
`INSERT ... SELECT`）消除 read→channel→SQL→INSERT 环节，并把默认批量参数调整到合理范围。

## Current State Analysis

| 指标 | 当前 | 目标 |
|------|------|------|
| 10M 行迁移（同实例）| ~81 分钟 | ≤180s（DataX 基准）|
| `write_batch_size` 上限 | 5,000 | 20,000 |
| 同实例数据路径 | read→channel→SQL→INSERT | 服务端 `INSERT ... SELECT` |
| 内存峰值 | 无硬限制（依赖 byte_gate）| ≤500MB |

## 现状评估（与原设计对照）

### 已实现，无需重做

| 原设计模块 | 实际代码位置 | 说明 |
|-----------|-------------|------|
| P2 `batch_optimizer.rs` 多值 INSERT | `datasource/bulk_write.rs:188` `InsertTemplate::build_chunk_sql` | 单条 SQL 内已拼接 `VALUES (..),(..),(..)`，并在 `mysql.rs:1058` `bulk_write_chunked_impl` 中基于 `max_allowed_packet` 做二分回退 |
| P3 `load_data_stream.rs` LOAD DATA 流式化 | `datasource/mysql.rs` `mig_async_pool` + `load_data_disabled` + `set_migration_pool_size` | 已有独立的 mysql_async 池专供 LOAD DATA LOCAL INFILE；超过 max_allowed_packet 时自动降级到 INSERT |
| 字节级背压 | `migration/byte_gate.rs` | 读写侧共享 `ByteGate` 信号量，内存不会无限上涨 |
| 并行分片 | `migration/splitter.rs` | 按整型 PK 分 N 段，每段独立 reader+writer |

原设计里 "write_batch_size max 5,000 → 20,000" 和 "memory peak unbounded" 两项仍然有效，
是本轮唯一的配置层调整点。

### 仍需完成（本轮实施范围）

已在仓库里落盘但**未编译进去**的孤立文件：

- `src-tauri/src/migration/strategy_selector.rs`：类型错误
  - 引用 `crate::db::ConnectionConfig`，真实类型是 `crate::datasource::ConnectionConfig`
  - 使用 `src_config.host`（`String`）/ `port`（`u16`）——实际字段是 `Option<String>` / `Option<u16>`
  - 缺少 `AppResult` / `AppError` 导入
- `src-tauri/src/migration/direct_transfer.rs`：字段错误
  - 访问 `m.target_column`，而 `task_mgr::ColumnMapping` 的字段叫 `target_col`
- `src-tauri/src/migration/mod.rs`：没有声明这两个模块（因此 `cargo check` 误以为一切正常）
- `src-tauri/src/migration/pipeline.rs`：没有任何分派调用 `select_strategy`

## 本轮实施计划（单阶段）

### 1. Strategy Selector（修复版）

**位置：** `src-tauri/src/migration/strategy_selector.rs`

**职责：** 基于 host/port + conflict_strategy + column_mappings 选择四选一策略：
`DirectTransfer` / `BatchOptimized` / `LoadDataStream` / `LegacyPipeline`。

- host/port 取自 `datasource::ConnectionConfig`，Option 字段要显式解包（`unwrap_or_default()` / `unwrap_or(0)`）
- 按需延迟做 `SELECT @@server_uuid` 二次确认（慢路径）。本期不强制：host+port 相同 + driver 相同即视为同实例
- `query_server_uuid` 返回值用 `result.rows`（`Vec<Vec<serde_json::Value>>`）首行首列的 `as_str()`
- 所有 `AppResult` 都要从 `crate::error` 导入

### 2. Direct Transfer Executor（修复版）

**位置：** `src-tauri/src/migration/direct_transfer.rs`

**产出 SQL：**

```sql
INSERT INTO `dst_db`.`target_table` (`col_a`, `col_b`)
SELECT col_a, UPPER(col_source)
FROM `src_db`.`source_table`
WHERE created_at > '2024-01-01'
```

支持：`column_mappings` 为 `source_expr → target_col` 列表；`source_expr = *` 时退化为 `SELECT *`；
`WHERE` 清理前缀 `WHERE`/`where` 再拼接。字段名必须用 `target_col`（注意末尾无 `umn`）。

### 3. Pipeline 分派接入

**位置：** `src-tauri/src/migration/pipeline.rs::execute_single_mapping`

在原本的 reader/writer 路径之前插入判断：

```rust
let decision = strategy_selector::select_strategy(&src_cfg, &dst_cfg, mapping);
if decision.strategy == MigrationStrategy::DirectTransfer {
    match direct_transfer::DirectTransferExecutor::execute(&*dst_ds, &cfg, &dst_cfg.driver).await {
        Ok(r) => { /* 更新 stats 并早返回 */ }
        Err(e) => { /* 记日志，降级到后续 reader/writer 分支 */ }
    }
}
```

关键约束：
- 同一事务内完成 `INSERT ... SELECT`，不再经过 byte_gate/channel
- 失败（权限不足、函数跨库不兼容等）必须回退到旧流程，不能让整单 mapping 失败
- `mapping_stats.rows_written` / `bytes_written` 需要等 `execute` 返回后补一次计数，以保证进度条和 finish 事件一致

### 4. 参数上限调整

`src-tauri/src/migration/pipeline.rs`：

| 常量 | 原值 | 新值 | 原因 |
|------|------|------|------|
| `write_batch_size.min(5_000)` | 5,000 | 20,000 | 降低 commit 频次，跟上 DataX 默认 |
| `WRITE_BATCH_RECOMMENDED_MAX` | 2,000 | 5,000 | 推荐上限同步提高，超过仍会告警 |

`read_batch_size` / `channel_capacity` / `byte_capacity` 保持不动。

## Tests

### 单元测试

- `strategy_selector`
  - `is_same_instance_by_config` 基本 true/false 覆盖
  - `select_strategy` 四种路径命中：同实例 DirectTransfer、MySQL 非 upsert LoadDataStream、一般跨实例 BatchOptimized、upsert LegacyPipeline
- `direct_transfer`
  - `MAPPING(*)` 场景的 `SELECT *`
  - 简单列重命名
  - 表达式映射（如 `UPPER(col)`）
  - WHERE 带 `WHERE` 前缀与不带前缀的两种输入

### 集成/回归

后续 `e2e_test_migration.sh` 覆盖直通路径（同库）与降级路径（人为造成列不匹配），本 PR 不含。

## 验收标准

- `cd src-tauri && cargo check` 通过
- `cargo test -p app migration::` 相关新增单测全部通过
- 迁移任务流程（无直通命中）行为完全等价于改前
- 直通命中时 `pipeline_finished` 事件 `rowsWritten` > 0 且 `elapsedSeconds` 合理

## 后续（不在本轮范围）

- 真实 MySQL 实例上验证 10M 行 ≤180s
- 跨节点 LoadDataStream 的显式分派（当前由底层 mysql.rs 自动走 LOAD DATA，但没有策略层标注）
- 脏行收集在直通模式下的替代方案
