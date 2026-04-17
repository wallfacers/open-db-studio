# 迁移中心设计文档

**日期**：2026-04-07  
**状态**：已确认，待实现  
**替换**：SeaTunnel 集成（`src-tauri/src/seatunnel/`、`src/components/SeaTunnelExplorer/`、`src/components/SeaTunnelJobTab/`）

---

## 一、背景与决策

### 问题

当前迁移中心深度依赖外部 SeaTunnel 集群（REST API on port 5801）。目标用户是**个人开发者 / 小团队**，他们不会也不应该被要求搭建 SeaTunnel 集群。这与项目"本地优先"的核心定位根本矛盾。

### 决策

**废弃 SeaTunnel 集成，改用原生 Rust ETL 引擎。**

核心洞察："复杂映射"（JOIN、过滤、值转换）可以完全交给**源数据库的 SQL 引擎**处理——用 AI 生成方言正确的 SQL 查询，Rust 只负责执行查询并批量写入目标库。表达式引擎的复杂度转移给 AI。

### 保留现有骨架

`src-tauri/src/migration/` 已有以下可复用模块：

| 文件 | 复用方式 |
|------|---------|
| `task_mgr.rs` | 扩展任务模型，加入 job config、分片配置 |
| `ddl_convert.rs` | 自动建表时的跨方言类型映射 |
| `data_pump.rs` | 核心批量泵，改造为 Tokio 异步 Reader-Writer 管道 |
| `precheck.rs` | 前置兼容性检查，扩展统计行数逻辑 |

---

## 二、架构总览

```
用户自然语言描述 / 可视化配置
         ↓
    AI 生成源 SQL + 字段映射
         ↓
┌────────────────────────────────────────────────────┐
│               MigrationPipeline (Rust)             │
│                                                    │
│  ┌─────────────┐  bounded_channel  ┌────────────┐ │
│  │ Reader Task │ ──── batches ────▶│Writer Pool │ │
│  │ 执行源 SQL  │  capacity=16      │parallelism │ │
│  │ 按批推送    │  (背压控制)        │BATCH INSERT│ │
│  └─────────────┘                  └────────────┘ │
│        │                               │          │
│        └───────────┐  ┌────────────────┘          │
│                    ▼  ▼                            │
│             Arc<MigrationStats>                    │
│        (AtomicU64，无锁，实时累计)                  │
│                    │                               │
│                    ▼                               │
│        Tauri Event 广播（每秒一次）                 │
└────────────────────────────────────────────────────┘
```

**AI 的职责**：
- 将用户自然语言转化为方言正确的 SQL 查询（处理 JOIN / WHERE / 值表达式）
- 自动适配 MySQL / PostgreSQL / SQL Server / Oracle 方言差异
- 根据源表和目标表 schema 生成字段映射规则

**Rust 引擎的职责（极简）**：
- 执行源 SQL 查询，逐批读取结果集
- 批量写入目标库（INSERT / UPSERT / REPLACE / SKIP）
- 进度与统计事件广播
- 前置检查（行数估算、类型兼容性）

---

## 三、高性能引擎设计

### 3.1 管道配置

```rust
pub struct PipelineConfig {
    pub read_batch_size: usize,       // 默认 10_000，每次 fetch 行数
    pub write_batch_size: usize,      // 默认 1_000，每条 INSERT 行数
    pub channel_capacity: usize,      // 默认 16，管道缓冲批次数（背压）
    pub parallelism: usize,           // 默认 1，Writer 并发数，最大 8
    pub speed_limit_rps: Option<u64>, // 可选限速（行/秒），保护生产库
    pub error_limit: usize,           // 脏数据容忍上限，超出中止任务
}
```

### 3.2 大表分片（参考 DataX splitPk）

对数值型主键的大表，自动按主键范围分片：

```
大表（1 亿行，主键 id）
  ├── Shard 1: WHERE id BETWEEN 1        AND 25_000_000
  ├── Shard 2: WHERE id BETWEEN 25_000_001 AND 50_000_000
  ├── Shard 3: WHERE id BETWEEN 50_000_001 AND 75_000_000
  └── Shard 4: WHERE id BETWEEN 75_000_001 AND 100_000_000

每个 Shard = 独立 Reader Task → 共享 Writer Pool
```

触发条件：表有数值型主键 + 预估行数 > 100 万时，UI 自动提示是否开启分片及分片数。

### 3.3 统计结构

```rust
pub struct MigrationStats {
    pub rows_read: AtomicU64,
    pub rows_written: AtomicU64,
    pub rows_failed: AtomicU64,
    pub bytes_transferred: AtomicU64,
    pub start_time: Instant,
}
```

每秒向前端广播 Tauri Event `migration_stats`：

```typescript
interface MigrationStatsEvent {
  task_id: number
  rows_read: number
  rows_written: number
  rows_failed: number
  bytes_transferred: number
  read_speed_rps: number     // 当前读取速度
  write_speed_rps: number    // 当前写入速度
  eta_seconds: number | null // 有行数预估时才有值
  progress_pct: number | null
}
```

### 3.4 日志分级（参考 DataX 格式）

```
[2026-04-07 10:23:01] [SYSTEM]   Pipeline started: mysql-prod → pg-dw, table: orders
[2026-04-07 10:23:01] [PRECHECK] Source count: 8,432,100 rows (~2.1 GB)
[2026-04-07 10:23:02] [DDL]      Created target table: pg.orders_new
[2026-04-07 10:23:02] [INFO]     Sharding: 4 shards by primary key
[2026-04-07 10:23:05] [PROGRESS] Read: 120,000 | Write: 98,000 | Speed: 38,200r/s | ETA: 3m42s
[2026-04-07 10:25:30] [WARN]     Type coercion: orders.amount DECIMAL(10,4)→NUMERIC
[2026-04-07 10:25:31] [ERROR]    Dirty record #1: row_id=9982 | field: created_at | value: "2999-13-01"
[2026-04-07 10:26:44] [STATS]    Finished in 4m42s | Read: 8,432,100 | Written: 8,432,099 | Failed: 1
[2026-04-07 10:26:44] [STATS]    Avg: 29,900 r/s | Peak: 42,100 r/s | Transferred: 2.08 GB
```

日志级别：`SYSTEM` / `PRECHECK` / `DDL` / `INFO` / `PROGRESS` / `WARN` / `ERROR` / `STATS`

脏数据行写入 SQLite `migration_dirty_records` 表，UI 可查看并导出 CSV。

---

## 四、Job 配置数据结构

```rust
pub struct MigrationJobConfig {
    pub source: SourceConfig,
    pub column_mapping: Vec<ColumnMapping>,
    pub target: TargetConfig,
    pub pipeline: PipelineConfig,
}

pub struct SourceConfig {
    pub connection_id: i64,
    pub query_mode: QueryMode,   // Auto（从表选择生成）或 Custom（手写 SQL）
    pub query: String,           // 最终执行的 SQL，Auto 模式由 UI 生成
}

pub struct ColumnMapping {
    pub source_expr: String,     // 源字段名或 SQL 表达式（AI 生成）
    pub target_col: String,      // 目标字段名
    pub target_type: String,     // 目标字段类型（方言相关）
}

pub struct TargetConfig {
    pub connection_id: i64,
    pub table: String,
    pub conflict_strategy: ConflictStrategy, // Insert / Upsert / Replace / Skip
    pub create_table_if_not_exists: bool,
    pub upsert_keys: Vec<String>,            // Upsert 时的唯一键列
}

pub enum ConflictStrategy { Insert, Upsert, Replace, Skip }
pub enum QueryMode { Auto, Custom }
```

---

## 五、Tauri 命令清单

### 任务管理（扩展现有 task_mgr.rs）

| 命令 | 说明 |
|------|------|
| `list_migration_tasks` | 列出所有任务（含分类） |
| `create_migration_task` | 新建任务（含 job config JSON） |
| `update_migration_task` | 保存配置变更 |
| `delete_migration_task` | 删除任务（级联删除脏数据记录） |
| `rename_migration_task` | 重命名 |
| `move_migration_task` | 移动到其他分类 |

### 分类管理

| 命令 | 说明 |
|------|------|
| `list_migration_categories` | 列表 |
| `create_migration_category` | 新建 |
| `rename_migration_category` | 重命名 |
| `delete_migration_category` | 删除（级联） |
| `move_migration_category` | 移动 |

### 执行控制

| 命令 | 说明 |
|------|------|
| `run_migration_task` | 启动管道，返回 run_id |
| `stop_migration_task` | 中止运行中的任务 |
| `get_migration_task_status` | 查询当前状态 |
| `get_migration_dirty_records` | 查询脏数据记录 |
| `export_dirty_records_csv` | 导出脏数据为 CSV |

### 辅助

| 命令 | 说明 |
|------|------|
| `precheck_migration_task` | 前置检查（行数估算、类型兼容） |
| `estimate_source_count` | 执行 COUNT(*) 获取预估进度基准 |

---

## 六、SQLite Schema 变更

```sql
-- 任务分类（与 seatunnel_categories 结构一致）
CREATE TABLE migration_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES migration_categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 迁移任务
CREATE TABLE migration_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES migration_categories(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',   -- MigrationJobConfig 序列化
  last_status TEXT,                          -- RUNNING/FINISHED/FAILED/STOPPED
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 脏数据记录
CREATE TABLE migration_dirty_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL,
  row_index  INTEGER,
  field_name TEXT,
  raw_value  TEXT,
  error_msg  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 历史运行记录（摘要统计）
CREATE TABLE migration_run_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL,
  rows_read        INTEGER NOT NULL DEFAULT 0,
  rows_written     INTEGER NOT NULL DEFAULT 0,
  rows_failed      INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);
```

---

## 七、前端 UI 设计

### 7.1 整体布局

```
ActivityBar（迁移中心图标：ArrowLeftRight）
  → MigrationExplorer（左侧侧边栏）
  → MigrationJobTab（主区域，三个子 Tab）
  → Assistant（右侧 AI 助手，已有）
```

### 7.2 MigrationExplorer 侧边栏

**完全复用 SeaTunnelExplorer 的实现模式**，包括：
- 侧边栏容器：`bg-background-base border-r border-border-default`
- 标题栏：`h-10`，图标 `ArrowLeftRight`（`text-accent`），字号、间距与现有一致
- 搜索框：与 SeaTunnelExplorer 完全相同的样式
- 拖拽调整宽度：`hover:bg-accent` 拖拽条

**目录树节点类型**：`category`（分类） / `task`（迁移任务）

**树节点样式**（与 SeaTunnelJobTree 完全一致）：
```tsx
// hover、选中、缩进、图标颜色、chevron 动画全部复用
className="flex items-center py-1 px-2 cursor-pointer
  hover:bg-background-hover outline-none select-none
  transition-colors duration-150"
style={{ paddingLeft: `${depth * 16 + 8}px` }}
```

**节点图标**：
- 分类（折叠）：`Folder`（`text-foreground-muted`）
- 分类（展开）：`FolderOpen`（`text-accent`）
- 任务（待运行）：`ArrowLeftRight size={14}`（`text-foreground-muted`）
- 任务（运行中）：`Loader2 size={14} animate-spin`（`text-accent`）
- 任务（成功）：`CheckCircle2 size={14}`（`text-success`）
- 任务（失败）：`XCircle size={14}`（`text-error`）

**状态徽章**（同 SeaTunnelJobTree badge 样式）：
```tsx
// RUNNING
<span className="text-[10px] px-1 rounded text-accent bg-accent/10">RUNNING</span>
// FAILED
<span className="text-[10px] px-1 rounded text-error bg-error-subtle">FAILED</span>
```

**Tooltip**：文字截断时显示完整标签，复用 `../common/Tooltip`（同 DBTree）

**右键菜单**（同 SeaTunnelJobTree 样式）：
```tsx
// 容器
className="fixed z-50 bg-background-base border border-border-default rounded shadow-xl py-1 min-w-[160px]"
// 普通菜单项
className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2
  text-foreground-default hover:bg-background-hover hover:text-foreground
  transition-colors duration-150"
// 危险操作
className="... text-error hover:bg-background-hover ..."
```

| 节点类型 | 右键菜单项 |
|---------|----------|
| 分类 | 新建子分类、新建任务、重命名、删除 |
| 任务（空闲） | 运行、复制、重命名、移动、删除 |
| 任务（运行中） | 停止、查看日志 |

### 7.3 MigrationJobTab 主区域

三个子 Tab：**配置 / 运行日志 / 统计报告**

任务开始运行时自动切换到"运行日志"Tab；完成后"统计报告"Tab 标题出现完成标记。

#### Tab 1：配置

```
┌─────────────────────────────────────────────────────────┐
│  源端                              目标端               │
│  ┌──────────────────────┐  →  ┌──────────────────────┐ │
│  │ 连接: mysql-prod  ▼  │      │ 连接: pg-dw       ▼  │ │
│  │                      │      │ 表名: orders_new     │ │
│  │ ○ 表选择模式           │      │ 冲突: [INSERT    ▼]  │ │
│  │   ☑ orders           │      │ ☑ 自动建表            │ │
│  │   ☑ order_items      │      └──────────────────────┘ │
│  │                      │                               │
│  │ ● 自定义 SQL 模式      │      性能参数                  │
│  │  ┌──────────────────┐│      读批次  [10000  ]         │
│  │  │ SELECT u.id, ... ││      写批次  [1000   ]         │
│  │  └──────────────────┘│      并发数  [1      ]         │
│  └──────────────────────┘      限速     [不限制 ]         │
│                                容错行   [0      ]         │
│  字段映射                [✨ AI 生成映射]                  │
│  ┌─────────────────────────────────────────────────┐    │
│  │ 源字段 / 表达式            目标字段    目标类型   │    │
│  │ ──────────────────────────────────────────────  │    │
│  │ id                    → user_id    BIGINT       │    │
│  │ CONCAT(first,' ',last)→ full_name  VARCHAR(255) │    │
│  │ [+ 添加字段]                                    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│                         [▶ 运行]  [预检查]  [保存]       │
└─────────────────────────────────────────────────────────┘
```

颜色规范：
- 表格行 hover：`hover:bg-background-hover`
- "AI 生成映射"按钮：`bg-primary text-primary-foreground hover:bg-primary-hover`
- "运行"按钮：`bg-accent text-white hover:bg-accent-hover`
- 边框分隔线：`border-border-subtle`

#### Tab 2：运行日志

```
┌─────────────────────────────────────────────────────────┐
│  实时进度                                   [■ 停止]     │
│                                                         │
│  已读取  8,120,000 / 8,432,100  ████████████░  96.3%    │
│  已写入  8,118,500               写入速度: 31,200 r/s    │
│  脏数据  1                       预计剩余: 0m38s         │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  [SYSTEM]   Pipeline started                            │
│  [PRECHECK] Source: 8,432,100 rows (~2.1 GB)            │
│  [DDL]      Created target table orders_new             │
│  [PROGRESS] Read:120,000 | Write:98,000 | 38,200r/s     │
│  [WARN]     Type coercion: amount DECIMAL→NUMERIC       │
│  [ERROR]    Dirty #1: row=9982 created_at "2999-13-01"  │
│                                              [导出日志]  │
└─────────────────────────────────────────────────────────┘
```

日志行颜色：
- `[ERROR]`：`text-error`
- `[WARN]`：`text-warning`
- `[STATS]`：`text-accent font-medium`
- `[DDL]`：`text-info`
- 其余：`text-foreground-muted`

进度条：`bg-accent`（已完成） + `bg-background-elevated`（未完成）

#### Tab 3：统计报告

```
┌─────────────────────────────────────────────────────────┐
│  执行摘要                                               │
│  状态: ✅ 成功   耗时: 4m 42s   完成: 2026-04-07 10:26  │
│                                                         │
│  ┌──────────┬──────────┬──────────┬────────────┐       │
│  │ 读取行数  │ 写入行数  │ 失败行数  │  传输大小  │       │
│  │8,432,100 │8,432,099 │    1     │   2.08 GB  │       │
│  └──────────┴──────────┴──────────┴────────────┘       │
│                                                         │
│  速度曲线  [折线图: 读取速度 / 写入速度，双线]             │
│                                                         │
│  脏数据记录 (1条)                         [导出 CSV]     │
│  ┌───────────────────────────────────────────────┐     │
│  │ #1 row=9982 | field: created_at | "2999-13-01"│     │
│  └───────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

数字卡片样式：`bg-background-elevated rounded border border-border-subtle`

---

## 八、AI 集成

### 触发点 1：✨ AI 生成映射（配置 Tab 按钮）

用户选定源连接 + 表（或填入自定义 SQL）及目标表后触发：

```
输入（系统 Prompt）：
  - 源表 schema（字段名、类型）
  - 目标表 schema（已有时）或目标表名（自动建表时）
  - 源数据库方言 + 目标数据库方言

输出：
  column_mapping: [
    { source_expr: "id", target_col: "id", target_type: "BIGINT" },
    { source_expr: "CONCAT(first_name,' ',last_name)", target_col: "full_name", target_type: "VARCHAR(255)" },
    { source_expr: "DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ')", target_col: "created_at", target_type: "TIMESTAMP" }
  ]
```

### 触发点 2：Assistant 自然语言驱动

用户在右侧 AI 助手面板描述迁移需求，AI 生成完整 job config（源 SQL + 字段映射 + 目标配置），通过 MCP 工具 `propose_migration_job` 写入配置面板，用户确认后保存运行。

---

## 九、删除计划（废弃 SeaTunnel 集成）

待本模块实现完成并验证后，删除以下内容：

| 路径 | 操作 |
|------|------|
| `src-tauri/src/seatunnel/` | 整体删除 |
| `src/components/SeaTunnelExplorer/` | 整体删除 |
| `src/components/SeaTunnelJobTab/` | 整体删除 |
| `src/store/seaTunnelStore.ts` | 删除 |
| `schema/init.sql` seatunnel_* 三张表 | 删除（迁移脚本置空） |
| `src-tauri/src/lib.rs` seatunnel handler 注册 | 删除 |
| `src/i18n/locales/zh.json` seaTunnel 命名空间 | 删除 |

---

## 十、实现优先级

| 阶段 | 内容 |
|------|------|
| P0 | Rust 管道引擎核心（Reader-Writer、批量写入、Stats 广播、日志事件） |
| P0 | SQLite schema 变更 + 基础 CRUD 命令 |
| P1 | 前端 MigrationExplorer（目录树、右键菜单） |
| P1 | MigrationJobTab 配置 Tab + 运行日志 Tab |
| P1 | 预检查命令（行数估算、类型兼容） |
| P2 | 大表分片支持 |
| P2 | 统计报告 Tab + 速度折线图 |
| P2 | AI 生成映射集成 |
| P3 | 删除 SeaTunnel 相关代码 |
