# 迁移速度统计设计文档

**日期：** 2026-04-10  
**状态：** 已批准

## 背景

迁移中心的运行日志（实时）和历史记录目前缺乏数据传输速度的直观展示。用户需要在两处均能看到 **行/s** 和 **KB/s（或 MB/s）**，颜色采用主题绿（`text-accent`）并足够醒目。

## 目标

1. 实时日志 stats bar：在现有行速基础上补充字节速度
2. 历史记录 table：新增"速度"列，同时展示行速和字节速度
3. 格式规则：< 1 MB/s → KB/s（1位小数），≥ 1 MB/s → MB/s（2位小数）

## 不在范围内

- 不修改读速度（readSpeedRps）的展示
- 不修改历史记录的分页逻辑
- 不改变 Tauri event 推送频率（保持每秒一次）

---

## 方案选择

选择**方案 A**：Rust 后端添加字节速度字段。

理由：
- 与现有 `read_speed_rps` / `write_speed_rps` 对称，语义清晰
- 前端无需维护额外的差分状态
- Rust 改动量极小（~5 行）

---

## 详细设计

### 1. Rust 后端

#### 文件：`src-tauri/src/migration/task_mgr.rs`

在 `MigrationStatsEvent` 结构体中新增字段：

```rust
pub bytes_speed_bps: f64,  // 瞬时字节速度（字节/秒），每秒差分计算
```

#### 文件：`src-tauri/src/migration/pipeline.rs`

在 stats 采样 loop 中：
- 在 loop 外初始化 `let mut prev_bytes: u64 = 0;`
- 每次循环内：`let delta_bytes = bytes_now.saturating_sub(prev_bytes) as f64;`
- 更新 `prev_bytes = bytes_now;`
- 写入 event：`bytes_speed_bps: delta_bytes,`

### 2. 前端 store

#### 文件：`src/store/migrationStore.ts`

`MigrationStatsEvent` interface 新增字段：
```typescript
bytesSpeedBps: number  // 对应 Rust 的 bytes_speed_bps
```

### 3. 实时日志 stats bar

#### 文件：`src/components/MigrationJobTab/LogTab.tsx`

在 stats bar 中，现有 `writeSpeedRps` 显示（`text-accent`）右侧紧跟字节速度：

```
... | 12,345 r/s  1.2 MB/s | ETA 30s | ...
         绿色加粗   绿色
```

- 使用辅助函数 `fmtBytesSpeed(bps: number): string`
  - `bps < 1_048_576` → `${(bps / 1024).toFixed(1)} KB/s`
  - `bps >= 1_048_576` → `${(bps / 1_048_576).toFixed(2)} MB/s`
- 颜色：与 `writeSpeedRps` 相同，使用 `text-accent`
- 仅在 `stats` 不为 null 时渲染

### 4. 历史记录 table

#### 文件：`src/components/MigrationJobTab/StatsTab.tsx`

在"传输大小"列（第6列）后插入新列 **"速度"**（第7列，原第7、8列右移）。

列内容（两行叠加）：

```
12,345 r/s   ← text-accent text-[11px] font-medium
1.2 MB/s     ← text-accent text-[11px]
```

计算逻辑：
```typescript
const durationSec = (run.durationMs ?? 0) / 1000
const rowsPerSec = durationSec > 0 ? run.rowsWritten / durationSec : null
const bytesPerSec = durationSec > 0 ? (run.bytesTransferred ?? 0) / durationSec : null
```

仅在 `durationMs > 0` 时显示计算值，否则显示 `-`。

复用 `fmtBytesSpeed` 函数（可提取到 `migrationLogParser.ts` 中供两处共用）。

---

## 数据流

```
Rust pipeline (每秒)
  ├─ delta_bytes = bytes_now - prev_bytes
  └─ emit MigrationStatsEvent { bytes_speed_bps, ... }
           │
           ▼
migrationStore.ts (activeRuns.stats)
           │
     ┌─────┴─────┐
     ▼           ▼
 LogTab        StatsTab
 stats bar     历史记录表
 实时 KB/s     平均 rows/s + KB/s
```

---

## 格式规范

| 场景 | 函数 | 示例 |
|------|------|------|
| 实时字节速度 | `fmtBytesSpeed(bps)` | `512.3 KB/s` / `2.45 MB/s` |
| 历史平均行速 | `Math.round(rowsPerSec).toLocaleString() + ' r/s'` | `12,345 r/s` |
| 历史平均字节速 | `fmtBytesSpeed(bytesPerSec)` | `1.2 MB/s` |

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src-tauri/src/migration/task_mgr.rs` | 修改 | `MigrationStatsEvent` 加 `bytes_speed_bps` |
| `src-tauri/src/migration/pipeline.rs` | 修改 | stats loop 加字节差分逻辑 |
| `src/store/migrationStore.ts` | 修改 | `MigrationStatsEvent` interface 加 `bytesSpeedBps` |
| `src/utils/migrationLogParser.ts` | 修改 | 提取并导出 `fmtBytesSpeed` 工具函数 |
| `src/components/MigrationJobTab/LogTab.tsx` | 修改 | stats bar 加字节速度显示 |
| `src/components/MigrationJobTab/StatsTab.tsx` | 修改 | 历史记录表加"速度"列 |
