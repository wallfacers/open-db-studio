<!-- STATUS: ✅ 已实现 -->
# 数据导入导出 + 任务中心 设计文档

> **版本**: 1.0
> **日期**: 2026-03-13
> **状态**: 待实现

---

## 1. 概述

### 1.1 目标

实现完整的数据库导入导出功能，并建立统一的任务中心基础设施：
- 表级别导入导出（支持多表选择）
- 数据库级别导入导出
- 跨连接数据迁移
- 新建数据库功能
- 统一任务中心（可扩展支持后续任务类型）

### 1.2 范围

| 功能 | 描述 |
|------|------|
| 表导出 | 单表/多表导出为 CSV/JSON/SQL，支持 WHERE 条件 |
| 表导入 | 从 CSV/JSON/Excel/SQL 导入，支持字段映射 |
| 数据库导出 | 整库备份（结构+数据），支持选择表 |
| 数据库导入 | SQL Dump 执行 / 跨连接迁移 |
| 新建数据库 | 右键连接创建新库，支持字符集等选项 |
| 任务中心 | 独立窗口，显示进度、支持取消/重试、持久化 100 条 |

### 1.3 数据库层级差异

| 数据库 | 层级结构 |
|--------|----------|
| MySQL | connection → database → tables |
| PostgreSQL | connection → database → schema → tables |
| SQLite | 单文件，无层级 |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              App Shell                                   │
├──────────────┬──────────────────────────────────────────┬───────────────┤
│  ActivityBar │              MainContent                  │  Assistant    │
│    (48px)    │                                          │   (可调)      │
│              │  ┌────────────────────────────────────┐  │               │
│              │  │  Toolbar                           │  │               │
│              │  │  [📤 导出] [📥 导入] [📋 任务中心]   │  │               │
│              │  └────────────────────────────────────┘  │               │
├──────────────┴──────────────────────────────────────────┴───────────────┤
│                                                                          │
│                    TaskCenter Panel（独立窗口/抽屉）                      │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 任务列表                                              [×]           │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 🔄 导出 users 表                      ████████░░ 80%    [取消]     │  │
│  │ ✅ 导出 orders 表                     已完成 2,340 行              │  │
│  │ ❌ 导入 products.csv                  失败: 第5行类型错误 [重试]   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 前端设计

### 3.1 文件结构

```
src/
├── components/
│   ├── TaskCenter/           # 任务中心（新增）
│   │   ├── index.tsx         # 主面板
│   │   ├── TaskItem.tsx      # 单个任务卡片
│   │   └── TaskDetail.tsx    # 任务详情展开
│   ├── ImportExport/         # 导入导出向导（新增）
│   │   ├── ExportWizard.tsx  # 导出向导（3步）
│   │   ├── ImportWizard.tsx  # 导入向导（3步）
│   │   ├── FieldMapper.tsx   # 字段映射组件
│   │   └── TableSelector.tsx # 多表选择器
│   ├── DatabaseManager/      # 数据库管理（新增）
│   │   └── CreateDatabaseDialog.tsx
│   └── Toolbar/              # 顶部工具栏（修改）
│       └── ExportImportButtons.tsx
├── store/
│   └── taskStore.ts          # 任务状态管理（新增）
```

### 3.2 主题色（与现有项目一致）

| 用途 | 颜色值 |
|------|--------|
| 最深背景 | `#0d1117`, `#0d1520` |
| 弹窗背景 | `#111922` |
| 悬停背景 | `#1a2639`, `#1e2d42` |
| 边框 | `#1e2d42`, `#253347` |
| 文字主色 | `#c8daea`, `#e8f4ff` |
| 文字次色 | `#7a9bb8` |
| 强调蓝 | `#3794ff` |
| 成功绿 | `#00c9a7` |
| 错误红 | `#f44747` |

### 3.3 TaskCenter 面板设计

**面板结构**：
```
┌──────────────────────────────────────────────────────────────┐
│  任务中心                                      🔽 全部 ▼  [×]  │
├──────────────────────────────────────────────────────────────┤
│  进行中 (1)  已完成 (3)  失败 (1)                             │  ← Tab 切换
├──────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐│
│  │ 🔄 导出 production_db (12表)                             ││
│  │ ████████████████░░░░░░░░░░░░░░░░░░░░░░░░  45%            ││
│  │ 已处理: users (15,234行) → orders...                     ││
│  │ 耗时: 2m 34s                              [取消]          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**任务状态与样式**：

| 状态 | 图标 | 进度条颜色 | 操作按钮 |
|------|------|-----------|---------|
| 进行中 | 🔄 | `#3794ff`（蓝） | 取消 |
| 已完成 | ✅ | `#00c9a7`（绿） | 打开目录 |
| 已失败 | ❌ | `#f44747`（红） | 重试、详情 |
| 已取消 | ⏹ | `#7a9bb8`（灰） | 重试 |

### 3.4 ExportWizard（导出向导）

**Step 1: 选择数据源**

MySQL 模式：
```
┌─────────────────────────────────────────────────────┐
│ 导出范围:                                           │
│ ○ 当前表（右键触发时默认选中）                       │
│ ○ 多表选择                                          │
│ ○ 整个数据库                                        │
│                                                     │
│ 数据源:                                             │
│ 连接: [MySQL-Production ▼]                          │
│ 数据库: [my_database    ▼]                          │
│                                                     │
│ [取消]                                   [下一步 →] │
└─────────────────────────────────────────────────────┘
```

PostgreSQL 模式（多 schema 层级）：
```
┌─────────────────────────────────────────────────────┐
│ 导出范围:                                           │
│ ○ 当前表                                            │
│ ○ 多表选择                                          │
│ ○ 整个 Schema                                       │
│ ○ 整个数据库（所有 Schema）                         │
│                                                     │
│ 数据源:                                             │
│ 连接: [PG-Production ▼]                             │
│ 数据库: [postgres     ▼]                            │
│ Schema: [public      ▼]  ← PG 专属                  │
│                                                     │
│ [取消]                                   [下一步 →] │
└─────────────────────────────────────────────────────┘
```

**Step 2: 选择表**
```
┌─────────────────────────────────────────────────────┐
│ 🔍 搜索表名...                      [全选] [反选]   │
├─────────────────────────────────────────────────────┤
│  表名              行数(估算)       大小            │
├─────────────────────────────────────────────────────┤
│ ☑ users            15,234           2.3 MB         │
│ ☑ orders           89,456           12.1 MB        │
│ ☐ products         3,421            856 KB         │
│ ☐ categories       128              32 KB          │
└─────────────────────────────────────────────────────┘
│ 已选: 2 个表                                        │
│                    [上一步]           [下一步 →]    │
└─────────────────────────────────────────────────────┘
```

**Step 3: 配置选项**
```
┌─────────────────────────────────────────────────────┐
│ 格式: [CSV ▼]                                       │
│ ☑ 包含表头                                          │
│ ☑ 包含 DDL                                          │
│                                                     │
│ WHERE 条件 (单表时可用):                             │
│ ┌─────────────────────────────────────────────────┐ │
│ │ id > 100                                        │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│                    [上一步]           [开始导出]    │
└─────────────────────────────────────────────────────┘
```

**导出格式选项**：

| 格式 | 可配置项 |
|------|---------|
| CSV | 分隔符、包含表头、编码（UTF-8/GBK） |
| JSON | 格式（数组/NDJSON）、美化输出 |
| SQL | 包含 DDL、批量 INSERT 大小、USE DATABASE 语句 |

### 3.5 ImportWizard（导入向导）

**Step 1: 选择文件**
```
┌──────────────────────────────────────────────────────┐
│ 文件类型: [CSV ▼]                                    │
│                                                      │
│ ┌──────────────────────────────────────────────────┐ │
│ │ 📄 users.csv                                     │ │
│ │ 选择文件或拖放                                   │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ 预览 (前5行):                                        │
│ ┌──────────────────────────────────────────────────┐ │
│ │ id,name,email                                    │ │
│ │ 1,张三,a@b.com                                   │ │
│ │ 2,李四,c@d.com                                   │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ [取消]                                    [下一步 →] │
└──────────────────────────────────────────────────────┘
```

**Step 2: 字段映射**
```
┌──────────────────────────────────────────────────────────────┐
│ 目标表: [users ▼]                                            │
│                                                              │
│ 源文件列 (6)                      目标表列 (8)               │
├──────────────────────────────────────────────────────────────┤
│  ☑ id         ────────────────→  ☑ id (INT, PK)            │
│  ☑ name       ────────────────→  ☑ name (VARCHAR)          │
│  ☑ email      ────────────────→  ☑ email (VARCHAR)         │
│  ☑ age        ────────────────→  ☑ age (INT)               │
│  ☑ address    ──────────┬─────→  ☑ addr (VARCHAR)          │
│  ☐ country    ──────────┘        ☐ created_at (DATETIME)   │
│                                  ☐ updated_at (DATETIME)    │
│                                                              │
│  [自动匹配列名]  [清空映射]  [添加常量值]                    │
│                                                              │
│                    [上一步]           [下一步 →]             │
└──────────────────────────────────────────────────────────────┘
```

**Step 3: 确认执行**
```
┌──────────────────────────────────────────────────────────────┐
│ 导入摘要:                                                    │
│ 源文件: users.csv                                            │
│ 目标表: users                                                │
│ 预览行数: 1,234                                              │
│ 映射字段: 5/6                                                │
│                                                              │
│ 错误处理:                                                    │
│ ○ 遇错停止                                                   │
│ ● 跳过错误行继续                                             │
│                                                              │
│                    [上一步]           [开始导入]             │
└──────────────────────────────────────────────────────────────┘
```

**支持的文件格式**：

| 格式 | 解析方式 | 特殊处理 |
|------|---------|---------|
| CSV | 按分隔符拆分 | 自动检测编码、分隔符 |
| JSON | `json` array / NDJSON | 支持嵌套对象 flatten |
| Excel | 读取第一个 Sheet | 支持 .xlsx |
| SQL | 解析 INSERT 语句 | 批量执行 |

### 3.6 CreateDatabaseDialog（新建数据库）

```
┌────────────────────────────────────────┐
│ 新建数据库                          [×] │
├────────────────────────────────────────┤
│                                        │
│ 数据库名称 *                           │
│ ┌────────────────────────────────────┐ │
│ │ my_new_db                          │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 字符集 (MySQL 专属)                    │
│ ┌────────────────────────────────────┐ │
│ │ utf8mb4                        ▼   │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 排序规则 (MySQL 专属)                  │
│ ┌────────────────────────────────────┐ │
│ │ utf8mb4_general_ci             ▼   │ │
│ └────────────────────────────────────┘ │
│                                        │
│ ────── PostgreSQL 专属 ───────         │
│ Schema 名称                            │
│ ┌────────────────────────────────────┐ │
│ │ public                             │ │
│ └────────────────────────────────────┘ │
│                                        │
│ ☑ 创建后立即切换到该数据库              │
│                                        │
├────────────────────────────────────────┤
│                    [取消]  [创建]       │
└────────────────────────────────────────┘
```

**不同数据库选项**：

| 数据库 | 必填项 | 可选项 |
|--------|-------|--------|
| MySQL | 名称 | 字符集、排序规则 |
| PostgreSQL | 名称 | 默认 Schema 名、表空间 |
| SQLite | 文件路径 | -（直接创建文件） |

**触发入口**：
- 右键 connection 节点 → "新建数据库"
- 连接必须是**已打开**状态才可用

### 3.7 TaskStore 数据结构

```typescript
interface Task {
  id: string;
  type: 'export' | 'import' | 'migration';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  title: string;
  progress: number;        // 0-100
  processedRows: number;
  totalRows: number | null;
  currentTarget: string;   // 当前处理的表名
  error: string | null;
  errorDetails: string[];  // 失败行详情
  outputPath: string | null;
  startTime: string;       // ISO 8601
  endTime: string | null;
}

interface TaskStore {
  tasks: Task[];
  visible: boolean;

  // Actions
  addTask: (task: Omit<Task, 'id' | 'startTime'>) => string;
  updateTask: (id: string, updates: Partial<Task>) => void;
  removeTask: (id: string) => void;
  cancelTask: (id: string) => void;
  retryTask: (id: string) => void;
  setVisible: (visible: boolean) => void;
  loadFromDb: () => Promise<void>;
}
```

---

## 4. 后端设计

### 4.1 新增 Tauri 命令

```rust
// ============ 任务管理 ============

/// 获取任务列表（从 SQLite 读取，最多 100 条）
#[tauri::command]
pub async fn get_task_list(limit: Option<i32>) -> AppResult<Vec<TaskRecord>>;

/// 取消正在执行的任务
#[tauri::command]
pub async fn cancel_task(task_id: String) -> AppResult<()>;

/// 重试失败的任务
#[tauri::command]
pub async fn retry_task(
    task_id: String,
    channel: Channel<TaskProgress>
) -> AppResult<()>;

// ============ 导出 ============

/// 导出表数据（支持多表，流式进度推送）
#[tauri::command]
pub async fn export_tables(
    params: ExportParams,
    channel: Channel<TaskProgress>,
) -> AppResult<String>;  // 返回 task_id

/// 导出整个数据库
#[tauri::command]
pub async fn export_database(
    params: DatabaseExportParams,
    channel: Channel<TaskProgress>,
) -> AppResult<String>;

// ============ 导入 ============

/// 导入文件到表（CSV/JSON/Excel/SQL）
#[tauri::command]
pub async fn import_to_table(
    params: ImportParams,
    channel: Channel<TaskProgress>,
) -> AppResult<ImportResult>;

/// 执行 SQL Dump 文件
#[tauri::command]
pub async fn execute_sql_dump(
    params: SqlDumpParams,
    channel: Channel<TaskProgress>,
) -> AppResult<String>;

/// 跨连接迁移数据
#[tauri::command]
pub async fn migrate_data(
    params: MigrationParams,
    channel: Channel<TaskProgress>,
) -> AppResult<String>;

// ============ 数据库管理 ============

/// 创建新数据库
#[tauri::command]
pub async fn create_database(
    connection_id: i64,
    name: String,
    options: CreateDatabaseOptions,
) -> AppResult<()>;

/// 删除数据库（危险操作，需二次确认）
#[tauri::command]
pub async fn drop_database(
    connection_id: i64,
    name: String,
) -> AppResult<()>;
```

### 4.2 数据结构定义

```rust
#[derive(Clone, Serialize)]
pub struct TaskProgress {
    pub task_id: String,
    pub status: TaskStatus,
    pub progress: u8,            // 0-100
    pub processed_rows: u64,
    pub total_rows: Option<u64>,
    pub current_target: String,  // 当前处理的表
    pub error: Option<String>,
    pub output_path: Option<String>,
}

#[derive(Clone, Serialize)]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,      // PG 专属
    pub tables: Vec<String>,         // 表名列表
    pub format: String,              // csv/json/sql
    pub output_dir: String,
    pub options: ExportOptions,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportOptions {
    pub include_header: bool,        // CSV 表头
    pub include_ddl: bool,           // SQL 包含建表语句
    pub where_clause: Option<String>,// 单表 WHERE 条件
    pub encoding: String,            // UTF-8 / GBK
    pub delimiter: char,             // CSV 分隔符
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub file_path: String,
    pub file_type: String,           // csv/json/excel/sql
    pub field_mapping: HashMap<String, String>,  // 源列 -> 目标列
    pub error_strategy: ErrorStrategy,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum ErrorStrategy {
    StopOnError,      // 遇错停止
    SkipAndContinue,  // 跳过错误行继续
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub success_count: u64,
    pub failed_count: u64,
    pub errors: Vec<ImportError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportError {
    pub row_number: u64,
    pub column: String,
    pub value: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateDatabaseOptions {
    // MySQL
    pub charset: Option<String>,
    pub collation: Option<String>,
    // PostgreSQL
    pub default_schema: Option<String>,
    pub tablespace: Option<String>,
}
```

### 4.3 SQLite 任务记录表

```sql
CREATE TABLE IF NOT EXISTS task_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,           -- export/import/migration
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    params TEXT,                  -- JSON 序列化参数（用于重试）
    progress INTEGER DEFAULT 0,
    processed_rows INTEGER DEFAULT 0,
    total_rows INTEGER,
    current_target TEXT,
    error TEXT,
    error_details TEXT,           -- JSON 数组，错误行详情
    output_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

-- 保留最近 100 条的查询索引
CREATE INDEX idx_task_records_created ON task_records(created_at DESC);
```

### 4.4 大数据量处理策略

1. **流式导出**：分批读取数据（每批 1000 行），通过 Channel 推送进度
2. **批量导入**：使用批量 INSERT（每批 100 行），失败时记录错误行
3. **进度计算**：`progress = (processed_rows / total_rows) * 100`
4. **取消机制**：通过 `CancellationToken` 支持中途取消

---

## 5. 交互入口

### 5.1 表级别导入导出

| 操作 | 入口 |
|------|------|
| 导出表 | 右键表节点 → "导出数据" |
| 导入到表 | 右键表节点 → "导入数据" |

### 5.2 数据库级别导入导出

| 操作 | 入口 |
|------|------|
| 导出数据库 | 右键 database 节点 → "导出数据库" / 顶部工具栏导出按钮 |
| 导入数据库 | 右键 database 节点 → "导入数据" / 顶部工具栏导入按钮 |

### 5.3 新建数据库

| 操作 | 入口 |
|------|------|
| 新建数据库 | 右键 connection 节点 → "新建数据库"（连接需已打开） |

### 5.4 任务中心

| 操作 | 入口 |
|------|------|
| 打开任务中心 | 顶部工具栏 "任务中心" 按钮 / 快捷键 |

---

## 6. 实现计划

### 6.1 模块依赖

```
TaskCenter UI
      │
      ├── ExportWizard
      ├── ImportWizard
      └── DatabaseManager
              │
              ▼
         TaskStore (Zustand + SQLite)
              │
              ▼
         Rust Backend (Tauri 命令)
```

### 6.2 实现阶段

| 阶段 | 任务 | 优先级 |
|------|------|--------|
| **P1 基础设施** | SQLite 任务表 + TaskStore + TaskCenter 面板骨架 | 高 |
| **P2 导出增强** | ExportWizard 多表选择 + 流式进度 + 数据库级导出 | 高 |
| **P3 导入功能** | ImportWizard + 字段映射 + 多格式解析 | 高 |
| **P4 数据库管理** | CreateDatabaseDialog + drop_database | 中 |
| **P5 顶部工具栏** | 全局导出/导入按钮 + 连接/库选择器 | 中 |
| **P6 跨库迁移** | MigrationWizard + migrate_data 命令 | 低 |

---

## 7. 扩展性考虑

### 7.1 任务调度

当前为即时执行，后续可扩展：
- 定时任务
- 任务队列（串行/并行）
- 任务依赖

---

## 8. 附录

### 8.1 现有导出功能

当前 `export_table_data` 命令已支持：
- CSV/JSON/SQL 格式
- WHERE 条件过滤
- 单表导出

本设计在此基础上扩展为：
- 多表选择
- 数据库级导出
- 任务进度追踪
- 任务中心管理
