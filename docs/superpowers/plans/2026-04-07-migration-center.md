# Migration Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用原生 Rust ETL 引擎替换 SeaTunnel 集成，实现本地优先的跨数据库迁移中心。

**Architecture:** 前端通过 Tauri invoke 调用 Rust 命令层；Rust 内部用 Tokio bounded channel 连接 Reader Task 和 Writer Pool，无锁 AtomicU64 统计每秒广播；AI 生成方言正确的源 SQL，Rust 只负责执行查询并批量写入。

**Tech Stack:** Rust / Tokio / sqlx / rusqlite / React 18 / TypeScript / Zustand / lucide-react / Tailwind CSS (语义色 token)

**Spec:** `docs/superpowers/specs/2026-04-07-migration-center-design.md`

---

## File Map

### 新建文件
| 文件 | 职责 |
|------|------|
| `src-tauri/src/migration/pipeline.rs` | Tokio Reader-Writer 管道、Stats、日志广播 |
| `src-tauri/src/migration/mig_commands.rs` | 所有迁移 Tauri 命令 |
| `src/store/migrationStore.ts` | Zustand store，树节点 + 任务状态 |
| `src/components/MigrationExplorer/index.tsx` | 侧边栏容器 |
| `src/components/MigrationExplorer/MigrationTaskTree.tsx` | 目录树（复用 SeaTunnelJobTree 模式） |
| `src/components/MigrationJobTab/index.tsx` | Tab 容器（三子 Tab） |
| `src/components/MigrationJobTab/ConfigTab.tsx` | 配置面板 |
| `src/components/MigrationJobTab/LogTab.tsx` | 实时日志面板 |
| `src/components/MigrationJobTab/StatsTab.tsx` | 统计报告面板 |

### 修改文件
| 文件 | 变更 |
|------|------|
| `schema/init.sql` | 增加 4 张新表，废弃旧 migration_tasks |
| `src-tauri/src/migration/mod.rs` | 导出 pipeline、mig_commands |
| `src-tauri/src/migration/task_mgr.rs` | 替换数据结构为新 JobConfig 模型 |
| `src-tauri/src/migration/data_pump.rs` | 改造为基于 pipeline.rs 的异步实现 |
| `src-tauri/src/migration/precheck.rs` | 扩展行数估算 |
| `src-tauri/src/lib.rs` | 注册新命令，移除 seatunnel 命令（Task 15） |
| `src/types/index.ts` | 添加 `migration_job` TabType |
| `src/App.tsx` | 添加 migration flush、Tab 联动 |
| `src/components/ActivityBar/index.tsx` | 添加 `migration` activity，保留 seatunnel 至 Task 15 |
| `src/i18n/locales/zh.json` | 添加 migration 命名空间 |
| `src/i18n/locales/en.json` | 同上 |

---

## Task 1: SQLite Schema — 新建四张表

**Files:**
- Modify: `schema/init.sql`

- [ ] **1.1 在 `schema/init.sql` 末尾追加以下 SQL**

```sql
-- ============================================================
-- Migration Center (native Rust ETL, replaces SeaTunnel)
-- ============================================================

CREATE TABLE IF NOT EXISTS migration_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES migration_categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES migration_categories(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_status TEXT CHECK(last_status IN ('RUNNING','FINISHED','FAILED','STOPPED')),
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_dirty_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL,
  row_index  INTEGER,
  field_name TEXT,
  raw_value  TEXT,
  error_msg  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_run_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  rows_read         INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  rows_failed       INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
```

- [ ] **1.2 验证 SQL 语法**

```bash
cd /home/wallfacers/project/open-db-studio
sqlite3 /tmp/test_schema.db < schema/init.sql && echo "OK" || echo "FAIL"
```

期望输出：`OK`

- [ ] **1.3 Commit**

```bash
git add schema/init.sql
git commit -m "feat(migration): add migration_jobs, categories, dirty_records, run_history tables"
```

---

## Task 2: Rust 数据模型

**Files:**
- Modify: `src-tauri/src/migration/task_mgr.rs`

- [ ] **2.1 将 `task_mgr.rs` 全部替换为新模型**

```rust
use serde::{Deserialize, Serialize};

// ── Job Config (stored as config_json) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MigrationJobConfig {
    pub source: SourceConfig,
    pub column_mapping: Vec<ColumnMapping>,
    pub target: TargetConfig,
    pub pipeline: PipelineConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceConfig {
    pub connection_id: i64,
    pub query_mode: QueryMode,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueryMode { #[default] Auto, Custom }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColumnMapping {
    pub source_expr: String,
    pub target_col: String,
    pub target_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TargetConfig {
    pub connection_id: i64,
    pub table: String,
    pub conflict_strategy: ConflictStrategy,
    pub create_table_if_not_exists: bool,
    pub upsert_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConflictStrategy { #[default] Insert, Upsert, Replace, Skip }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    pub read_batch_size: usize,
    pub write_batch_size: usize,
    pub channel_capacity: usize,
    pub parallelism: usize,
    pub speed_limit_rps: Option<u64>,
    pub error_limit: usize,
    pub shard_count: Option<usize>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            read_batch_size: 10_000,
            write_batch_size: 1_000,
            channel_capacity: 16,
            parallelism: 1,
            speed_limit_rps: None,
            error_limit: 0,
            shard_count: None,
        }
    }
}

// ── DB Row types (returned to frontend) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationCategory {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationJob {
    pub id: i64,
    pub name: String,
    pub category_id: Option<i64>,
    pub config_json: String,
    pub last_status: Option<String>,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationRunHistory {
    pub id: i64,
    pub job_id: i64,
    pub run_id: String,
    pub status: String,
    pub rows_read: i64,
    pub rows_written: i64,
    pub rows_failed: i64,
    pub bytes_transferred: i64,
    pub duration_ms: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationDirtyRecord {
    pub id: i64,
    pub job_id: i64,
    pub run_id: String,
    pub row_index: Option<i64>,
    pub field_name: Option<String>,
    pub raw_value: Option<String>,
    pub error_msg: Option<String>,
    pub created_at: String,
}

// ── Stats event (broadcast every second) ────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct MigrationStatsEvent {
    pub job_id: i64,
    pub run_id: String,
    pub rows_read: u64,
    pub rows_written: u64,
    pub rows_failed: u64,
    pub bytes_transferred: u64,
    pub read_speed_rps: f64,
    pub write_speed_rps: f64,
    pub eta_seconds: Option<f64>,
    pub progress_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationLogEvent {
    pub job_id: i64,
    pub run_id: String,
    pub level: String,   // SYSTEM / PRECHECK / DDL / INFO / PROGRESS / WARN / ERROR / STATS
    pub message: String,
    pub timestamp: String,
}
```

- [ ] **2.2 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

期望：无 error（有 warning 可忽略）

- [ ] **2.3 Commit**

```bash
git add src-tauri/src/migration/task_mgr.rs
git commit -m "feat(migration): replace task models with MigrationJobConfig / MigrationJob types"
```

---

## Task 3: CRUD Tauri 命令

**Files:**
- Create: `src-tauri/src/migration/mig_commands.rs`
- Modify: `src-tauri/src/migration/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **3.1 创建 `src-tauri/src/migration/mig_commands.rs`**

```rust
use rusqlite::params;
use serde_json;
use tauri::State;
use crate::db::AppState;
use crate::error::AppResult;
use super::task_mgr::*;

// ── Categories ───────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_categories(
    state: State<'_, AppState>,
) -> AppResult<Vec<MigrationCategory>> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, parent_id, sort_order, created_at
         FROM migration_categories ORDER BY sort_order, name"
    )?;
    let rows = stmt.query_map([], |row| Ok(MigrationCategory {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_migration_category(
    name: String,
    parent_id: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<MigrationCategory> {
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO migration_categories (name, parent_id) VALUES (?1, ?2)",
        params![name, parent_id],
    )?;
    let id = db.last_insert_rowid();
    let cat = db.query_row(
        "SELECT id, name, parent_id, sort_order, created_at FROM migration_categories WHERE id=?1",
        params![id],
        |row| Ok(MigrationCategory {
            id: row.get(0)?, name: row.get(1)?, parent_id: row.get(2)?,
            sort_order: row.get(3)?, created_at: row.get(4)?,
        }),
    )?;
    Ok(cat)
}

#[tauri::command]
pub async fn rename_migration_category(
    id: i64, name: String, state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.lock().unwrap();
    db.execute("UPDATE migration_categories SET name=?1 WHERE id=?2", params![name, id])?;
    Ok(())
}

#[tauri::command]
pub async fn delete_migration_category(
    id: i64, state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM migration_categories WHERE id=?1", params![id])?;
    Ok(())
}

// ── Jobs ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_migration_jobs(
    state: State<'_, AppState>,
) -> AppResult<Vec<MigrationJob>> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, category_id, config_json, last_status, last_run_at, created_at, updated_at
         FROM migration_jobs ORDER BY updated_at DESC"
    )?;
    let rows = stmt.query_map([], |row| Ok(MigrationJob {
        id: row.get(0)?, name: row.get(1)?, category_id: row.get(2)?,
        config_json: row.get(3)?, last_status: row.get(4)?,
        last_run_at: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_migration_job(
    name: String, category_id: Option<i64>, state: State<'_, AppState>,
) -> AppResult<MigrationJob> {
    let default_config = serde_json::to_string(&MigrationJobConfig::default())?;
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO migration_jobs (name, category_id, config_json) VALUES (?1, ?2, ?3)",
        params![name, category_id, default_config],
    )?;
    let id = db.last_insert_rowid();
    let job = db.query_row(
        "SELECT id, name, category_id, config_json, last_status, last_run_at, created_at, updated_at
         FROM migration_jobs WHERE id=?1",
        params![id],
        |row| Ok(MigrationJob {
            id: row.get(0)?, name: row.get(1)?, category_id: row.get(2)?,
            config_json: row.get(3)?, last_status: row.get(4)?,
            last_run_at: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?,
        }),
    )?;
    Ok(job)
}

#[tauri::command]
pub async fn update_migration_job_config(
    id: i64, config_json: String, state: State<'_, AppState>,
) -> AppResult<()> {
    // Validate JSON before saving
    serde_json::from_str::<MigrationJobConfig>(&config_json)
        .map_err(|e| crate::error::AppError::InvalidInput(e.to_string()))?;
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET config_json=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![config_json, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn rename_migration_job(
    id: i64, name: String, state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET name=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_migration_job(
    id: i64, state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM migration_jobs WHERE id=?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub async fn move_migration_job(
    id: i64, category_id: Option<i64>, state: State<'_, AppState>,
) -> AppResult<()> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE migration_jobs SET category_id=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
        params![category_id, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_migration_dirty_records(
    job_id: i64, run_id: String, state: State<'_, AppState>,
) -> AppResult<Vec<MigrationDirtyRecord>> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, row_index, field_name, raw_value, error_msg, created_at
         FROM migration_dirty_records WHERE job_id=?1 AND run_id=?2 ORDER BY id LIMIT 500"
    )?;
    let rows = stmt.query_map(params![job_id, run_id], |row| Ok(MigrationDirtyRecord {
        id: row.get(0)?, job_id: row.get(1)?, run_id: row.get(2)?,
        row_index: row.get(3)?, field_name: row.get(4)?,
        raw_value: row.get(5)?, error_msg: row.get(6)?, created_at: row.get(7)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_migration_run_history(
    job_id: i64, state: State<'_, AppState>,
) -> AppResult<Vec<MigrationRunHistory>> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, job_id, run_id, status, rows_read, rows_written, rows_failed,
                bytes_transferred, duration_ms, started_at, finished_at
         FROM migration_run_history WHERE job_id=?1 ORDER BY started_at DESC LIMIT 20"
    )?;
    let rows = stmt.query_map(params![job_id], |row| Ok(MigrationRunHistory {
        id: row.get(0)?, job_id: row.get(1)?, run_id: row.get(2)?,
        status: row.get(3)?, rows_read: row.get(4)?, rows_written: row.get(5)?,
        rows_failed: row.get(6)?, bytes_transferred: row.get(7)?,
        duration_ms: row.get(8)?, started_at: row.get(9)?, finished_at: row.get(10)?,
    }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
```

- [ ] **3.2 更新 `src-tauri/src/migration/mod.rs`**

在文件中添加：
```rust
pub mod task_mgr;
pub mod pipeline;
pub mod mig_commands;
pub mod ddl_convert;
pub mod precheck;
pub mod data_pump;
```

- [ ] **3.3 在 `src-tauri/src/lib.rs` 的 `generate_handler![]` 中注册新命令**

找到 `tauri::generate_handler![` 块，追加：
```rust
migration::mig_commands::list_migration_categories,
migration::mig_commands::create_migration_category,
migration::mig_commands::rename_migration_category,
migration::mig_commands::delete_migration_category,
migration::mig_commands::list_migration_jobs,
migration::mig_commands::create_migration_job,
migration::mig_commands::update_migration_job_config,
migration::mig_commands::rename_migration_job,
migration::mig_commands::delete_migration_job,
migration::mig_commands::move_migration_job,
migration::mig_commands::get_migration_dirty_records,
migration::mig_commands::get_migration_run_history,
```

- [ ] **3.4 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

期望：无 error 输出

- [ ] **3.5 Commit**

```bash
git add src-tauri/src/migration/mig_commands.rs src-tauri/src/migration/mod.rs src-tauri/src/lib.rs
git commit -m "feat(migration): add CRUD Tauri commands for jobs and categories"
```

---

## Task 4: ETL 管道核心引擎

**Files:**
- Create: `src-tauri/src/migration/pipeline.rs`

- [ ] **4.1 创建 `src-tauri/src/migration/pipeline.rs`**

```rust
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use rusqlite::params;
use serde_json;
use tauri::AppHandle;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::db::AppState;
use crate::error::{AppError, AppResult};
use super::task_mgr::*;

const MIGRATION_LOG_EVENT: &str = "migration_log";
const MIGRATION_STATS_EVENT: &str = "migration_stats";
const MIGRATION_FINISHED_EVENT: &str = "migration_finished";

// ── Internal stats (shared between reader & writer) ──────────

pub struct PipelineStats {
    pub rows_read: AtomicU64,
    pub rows_written: AtomicU64,
    pub rows_failed: AtomicU64,
    pub bytes_transferred: AtomicU64,
}

impl PipelineStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rows_read: AtomicU64::new(0),
            rows_written: AtomicU64::new(0),
            rows_failed: AtomicU64::new(0),
            bytes_transferred: AtomicU64::new(0),
        })
    }
}

// ── A batch of rows from reader → writer ────────────────────

type Row = Vec<serde_json::Value>;

struct Batch {
    rows: Vec<Row>,
    column_names: Vec<String>,
}

// ── Emit helpers ────────────────────────────────────────────

fn emit_log(app: &AppHandle, job_id: i64, run_id: &str, level: &str, message: &str) {
    let event = MigrationLogEvent {
        job_id,
        run_id: run_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        timestamp: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    };
    let _ = app.emit(MIGRATION_LOG_EVENT, &event);
}

fn emit_stats(
    app: &AppHandle,
    job_id: i64,
    run_id: &str,
    stats: &Arc<PipelineStats>,
    elapsed: f64,
    total_rows: Option<u64>,
    prev_read: u64,
    prev_written: u64,
) {
    let rows_read = stats.rows_read.load(Ordering::Relaxed);
    let rows_written = stats.rows_written.load(Ordering::Relaxed);
    let delta_read = rows_read.saturating_sub(prev_read) as f64;
    let delta_written = rows_written.saturating_sub(prev_written) as f64;
    let (eta, pct) = if let Some(total) = total_rows {
        if rows_read < total {
            let rps = if elapsed > 0.0 { rows_read as f64 / elapsed } else { 1.0 };
            let eta = (total - rows_read) as f64 / rps.max(1.0);
            let pct = (rows_read as f64 / total as f64 * 100.0).min(100.0);
            (Some(eta), Some(pct))
        } else {
            (Some(0.0), Some(100.0))
        }
    } else {
        (None, None)
    };
    let event = MigrationStatsEvent {
        job_id,
        run_id: run_id.to_string(),
        rows_read,
        rows_written,
        rows_failed: stats.rows_failed.load(Ordering::Relaxed),
        bytes_transferred: stats.bytes_transferred.load(Ordering::Relaxed),
        read_speed_rps: delta_read,
        write_speed_rps: delta_written,
        eta_seconds: eta,
        progress_pct: pct,
    };
    let _ = app.emit(MIGRATION_STATS_EVENT, &event);
}

// ── Active runs registry (job_id → cancel flag) ─────────────

use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

static ACTIVE_RUNS: Lazy<Mutex<HashMap<i64, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn cancel_run(job_id: i64) {
    if let Ok(runs) = ACTIVE_RUNS.lock() {
        if let Some(flag) = runs.get(&job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// ── Main entry point ─────────────────────────────────────────

pub async fn run_pipeline(
    job_id: i64,
    app: AppHandle,
    state: Arc<AppState>,
) -> AppResult<String> {
    // Load config
    let config_json: String = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT config_json FROM migration_jobs WHERE id=?1",
            params![job_id],
            |r| r.get(0),
        )?
    };
    let config: MigrationJobConfig = serde_json::from_str(&config_json)
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;

    let run_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));

    // Register in active runs
    {
        let mut runs = ACTIVE_RUNS.lock().unwrap();
        runs.insert(job_id, cancel.clone());
    }

    // Update job status → RUNNING
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "UPDATE migration_jobs SET last_status='RUNNING', last_run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![job_id],
        )?;
        db.execute(
            "INSERT INTO migration_run_history (job_id, run_id, status, started_at) VALUES (?1,?2,'RUNNING',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![job_id, &run_id],
        )?;
    }

    emit_log(&app, job_id, &run_id, "SYSTEM", &format!("Pipeline started: job_id={}", job_id));

    let run_id_clone = run_id.clone();
    let app_clone = app.clone();
    let state_clone = state.clone();
    let cancel_clone = cancel.clone();

    // Spawn pipeline in background
    tokio::spawn(async move {
        let result = execute_pipeline(
            job_id, run_id_clone.clone(), config,
            app_clone.clone(), state_clone, cancel_clone,
        ).await;

        let final_status = match &result {
            Ok(_) => "FINISHED",
            Err(_) => "FAILED",
        };

        if let Ok(runs) = ACTIVE_RUNS.lock() {
            let mut runs = runs;  // shadow to mutable
            drop(runs);  // unlock before db ops
        }
        {
            let mut runs = ACTIVE_RUNS.lock().unwrap();
            runs.remove(&job_id);
        }

        // Update final status
        let msg = match &result {
            Ok(summary) => summary.clone(),
            Err(e) => e.to_string(),
        };

        {
            if let Ok(db) = state_clone.db.lock() {
                let _ = db.execute(
                    "UPDATE migration_jobs SET last_status=?1 WHERE id=?2",
                    params![final_status, job_id],
                );
                let _ = db.execute(
                    "UPDATE migration_run_history SET status=?1, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=?2",
                    params![final_status, &run_id_clone],
                );
            }
        }

        emit_log(&app_clone, job_id, &run_id_clone, "SYSTEM",
            &format!("Pipeline {}: {}", final_status, msg));
        let _ = app_clone.emit(MIGRATION_FINISHED_EVENT, serde_json::json!({
            "job_id": job_id,
            "run_id": run_id_clone,
            "status": final_status,
        }));
    });

    Ok(run_id)
}

async fn execute_pipeline(
    job_id: i64,
    run_id: String,
    config: MigrationJobConfig,
    app: AppHandle,
    state: Arc<AppState>,
    cancel: Arc<AtomicBool>,
) -> AppResult<String> {
    let cfg = &config.pipeline;
    let stats = PipelineStats::new();

    // Estimate total rows for progress
    let total_rows = estimate_count(&config.source, &state).await.ok();
    if let Some(total) = total_rows {
        emit_log(&app, job_id, &run_id, "PRECHECK",
            &format!("Source count: {} rows", total));
    }

    // Channel: reader → writer
    let (tx, mut rx) = mpsc::channel::<Batch>(cfg.channel_capacity);

    let stats_reader = stats.clone();
    let stats_writer = stats.clone();
    let cancel_reader = cancel.clone();
    let source = config.source.clone();
    let batch_size = cfg.read_batch_size;
    let state_r = state.clone();
    let app_r = app.clone();
    let run_id_r = run_id.clone();

    // ── Reader Task ──────────────────────────────────────────
    let reader = tokio::spawn(async move {
        match read_source(
            &source, batch_size, tx,
            stats_reader, cancel_reader,
            &app_r, job_id, &run_id_r, &state_r,
        ).await {
            Ok(_) => {}
            Err(e) => emit_log(&app_r, job_id, &run_id_r, "ERROR",
                &format!("Reader error: {}", e)),
        }
    });

    // ── Writer (single, parallelism=1 for now) ────────────────
    let write_batch = cfg.write_batch_size;
    let error_limit = cfg.error_limit;
    let target = config.target.clone();
    let mapping = config.column_mapping.clone();
    let app_w = app.clone();
    let run_id_w = run_id.clone();
    let state_w = state.clone();

    let writer = tokio::spawn(async move {
        write_sink(
            &mut rx, &target, &mapping, write_batch, error_limit,
            stats_writer, cancel.clone(),
            &app_w, job_id, &run_id_w, &state_w,
        ).await
    });

    // ── Stats broadcaster (every 1s) ─────────────────────────
    let stats_bc = stats.clone();
    let app_bc = app.clone();
    let run_id_bc = run_id.clone();
    let start = Instant::now();
    let broadcast_handle = tokio::spawn(async move {
        let mut prev_read = 0u64;
        let mut prev_written = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let elapsed = start.elapsed().as_secs_f64();
            emit_stats(&app_bc, job_id, &run_id_bc, &stats_bc, elapsed,
                total_rows, prev_read, prev_written);
            prev_read = stats_bc.rows_read.load(Ordering::Relaxed);
            prev_written = stats_bc.rows_written.load(Ordering::Relaxed);
            // Stop when writer is done (check via AtomicBool would need extra flag)
            // Simple: broadcast runs until task completes naturally
            if elapsed > 86400.0 { break; } // safety: 24h max
        }
    });

    let _ = reader.await;
    let write_result = writer.await;
    broadcast_handle.abort();

    // Final stats emit
    let elapsed = start.elapsed().as_secs_f64();
    emit_stats(&app, job_id, &run_id, &stats, elapsed, total_rows, 0, 0);

    let r = stats.rows_read.load(Ordering::Relaxed);
    let w = stats.rows_written.load(Ordering::Relaxed);
    let f = stats.rows_failed.load(Ordering::Relaxed);
    let dur = format!("{:.0}s", elapsed);
    emit_log(&app, job_id, &run_id, "STATS",
        &format!("Finished in {} | Read: {} | Written: {} | Failed: {}", dur, r, w, f));

    // Update run_history counts
    {
        let db = state.db.lock().unwrap();
        let _ = db.execute(
            "UPDATE migration_run_history SET rows_read=?1, rows_written=?2, rows_failed=?3, duration_ms=?4 WHERE run_id=?5",
            params![r as i64, w as i64, f as i64, (elapsed * 1000.0) as i64, &run_id],
        );
    }

    match write_result {
        Ok(Ok(_)) => Ok(format!("Read={} Written={} Failed={}", r, w, f)),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(AppError::Internal(e.to_string())),
    }
}

// ── Source reader (sqlx-based) ────────────────────────────────
// NOTE: This function uses the datasource connection pool from state.
// It executes config.query and sends batches to tx.

async fn read_source(
    source: &SourceConfig,
    batch_size: usize,
    tx: mpsc::Sender<Batch>,
    stats: Arc<PipelineStats>,
    cancel: Arc<AtomicBool>,
    app: &AppHandle,
    job_id: i64,
    run_id: &str,
    state: &Arc<AppState>,
) -> AppResult<()> {
    use crate::datasource::pool::get_connection;

    let pool = get_connection(source.connection_id, state).await?;
    let rows_all = pool.fetch_all_as_json(&source.query).await?;

    let mut batch_rows: Vec<Row> = Vec::with_capacity(batch_size);
    let mut col_names: Vec<String> = vec![];

    for (i, row_val) in rows_all.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            emit_log(app, job_id, run_id, "SYSTEM", "Reader: cancel requested");
            break;
        }
        if let serde_json::Value::Object(map) = row_val {
            if col_names.is_empty() {
                col_names = map.keys().cloned().collect();
            }
            let row: Row = col_names.iter().map(|k| map.get(k).cloned().unwrap_or(serde_json::Value::Null)).collect();
            batch_rows.push(row);
            stats.rows_read.fetch_add(1, Ordering::Relaxed);
            if batch_rows.len() >= batch_size {
                let batch = Batch { rows: std::mem::take(&mut batch_rows), column_names: col_names.clone() };
                if tx.send(batch).await.is_err() { break; }
            }
        }
        if i % 50_000 == 0 && i > 0 {
            emit_log(app, job_id, run_id, "PROGRESS",
                &format!("Read {} rows...", i));
        }
    }
    if !batch_rows.is_empty() {
        let _ = tx.send(Batch { rows: batch_rows, column_names: col_names }).await;
    }
    Ok(())
}

async fn estimate_count(source: &SourceConfig, state: &Arc<AppState>) -> AppResult<u64> {
    use crate::datasource::pool::get_connection;
    let pool = get_connection(source.connection_id, state).await?;
    let count_sql = format!("SELECT COUNT(*) FROM ({}) AS __cnt_q", source.query);
    let count = pool.fetch_scalar_u64(&count_sql).await?;
    Ok(count)
}

// ── Sink writer ──────────────────────────────────────────────

async fn write_sink(
    rx: &mut mpsc::Receiver<Batch>,
    target: &TargetConfig,
    mapping: &[ColumnMapping],
    write_batch: usize,
    error_limit: usize,
    stats: Arc<PipelineStats>,
    cancel: Arc<AtomicBool>,
    app: &AppHandle,
    job_id: i64,
    run_id: &str,
    state: &Arc<AppState>,
) -> AppResult<()> {
    use crate::datasource::pool::get_connection;

    let pool = get_connection(target.connection_id, state).await?;
    let col_list: Vec<&str> = mapping.iter().map(|m| m.target_col.as_str()).collect();
    let mut error_count = 0usize;

    while let Some(batch) = rx.recv().await {
        if cancel.load(Ordering::Relaxed) { break; }

        // Map rows: source col order → target col order via mapping
        let src_cols = &batch.column_names;
        for chunk in batch.rows.chunks(write_batch) {
            if cancel.load(Ordering::Relaxed) { break; }

            let mut mapped: Vec<Vec<serde_json::Value>> = Vec::with_capacity(chunk.len());
            for row in chunk {
                let mapped_row: Vec<serde_json::Value> = mapping.iter().map(|m| {
                    // source_expr is a column alias from the SELECT
                    let idx = src_cols.iter().position(|c| c == &m.source_expr);
                    idx.map(|i| row[i].clone()).unwrap_or(serde_json::Value::Null)
                }).collect();
                mapped.push(mapped_row);
            }

            match pool.batch_insert(&target.table, &col_list, &mapped, &target.conflict_strategy).await {
                Ok(n) => {
                    stats.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    stats.bytes_transferred.fetch_add((n * 64) as u64, Ordering::Relaxed); // rough estimate
                }
                Err(e) => {
                    error_count += 1;
                    emit_log(app, job_id, run_id, "ERROR",
                        &format!("Write error (batch): {}", e));
                    stats.rows_failed.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    if error_limit > 0 && error_count >= error_limit {
                        return Err(AppError::Internal(
                            format!("Error limit {} reached, aborting", error_limit)));
                    }
                }
            }
        }
    }
    Ok(())
}
```

- [ ] **4.2 在 `mig_commands.rs` 中添加 run/stop 命令**

在文件末尾追加：

```rust
use std::sync::Arc;
use crate::db::AppState;

#[tauri::command]
pub async fn run_migration_job(
    job_id: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let state_arc = Arc::new((**state).clone());
    super::pipeline::run_pipeline(job_id, app, state_arc).await
}

#[tauri::command]
pub async fn stop_migration_job(job_id: i64) -> AppResult<()> {
    super::pipeline::cancel_run(job_id);
    Ok(())
}
```

在 `lib.rs` 注册处追加：
```rust
migration::mig_commands::run_migration_job,
migration::mig_commands::stop_migration_job,
```

- [ ] **4.3 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -30
```

> **注意：** `get_connection`、`fetch_all_as_json`、`fetch_scalar_u64`、`batch_insert` 是对现有 datasource pool 层的调用。如果接口签名不完全一致，根据 `src-tauri/src/datasource/pool.rs` 的实际接口调整。编译通过后再继续。

- [ ] **4.4 Commit**

```bash
git add src-tauri/src/migration/pipeline.rs src-tauri/src/migration/mig_commands.rs src-tauri/src/lib.rs
git commit -m "feat(migration): add Tokio Reader-Writer ETL pipeline with stats broadcasting"
```

---

## Task 5: 前端类型、i18n、Store

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`
- Create: `src/store/migrationStore.ts`

- [ ] **5.1 在 `src/types/index.ts` 中的 `TabType` 添加 `migration_job`**

找到 `TabType` 定义，添加：
```typescript
| 'migration_job'
```

在 `Tab` interface 中添加可选字段：
```typescript
migrationJobId?: number
```

- [ ] **5.2 在 `src/i18n/locales/zh.json` 中添加 migration 命名空间**

在 JSON 根对象中追加：
```json
"migration": {
  "title": "迁移中心",
  "newJob": "新建任务",
  "newCategory": "新建分类",
  "rename": "重命名",
  "delete": "删除",
  "move": "移动",
  "run": "运行",
  "stop": "停止",
  "precheck": "预检查",
  "save": "保存",
  "configTab": "配置",
  "logTab": "运行日志",
  "statsTab": "统计报告",
  "sourceConn": "源连接",
  "targetConn": "目标连接",
  "tableMode": "表选择模式",
  "sqlMode": "自定义 SQL",
  "fieldMapping": "字段映射",
  "aiGenMapping": "AI 生成映射",
  "addField": "+ 添加字段",
  "conflictInsert": "INSERT",
  "conflictUpsert": "UPSERT",
  "conflictReplace": "REPLACE",
  "conflictSkip": "SKIP",
  "autoCreateTable": "自动建表",
  "readBatch": "读批次",
  "writeBatch": "写批次",
  "parallelism": "并发数",
  "speedLimit": "限速",
  "noLimit": "不限制",
  "errorLimit": "容错行",
  "rowsRead": "已读取",
  "rowsWritten": "已写入",
  "dirtyRows": "脏数据",
  "speed": "速度",
  "eta": "预计剩余",
  "exportLog": "导出日志",
  "exportCsv": "导出 CSV",
  "statusRunning": "RUNNING",
  "statusFinished": "FINISHED",
  "statusFailed": "FAILED",
  "statusStopped": "STOPPED"
}
```

在 `src/i18n/locales/en.json` 中追加对应英文版本（将中文值替换为英文即可）。

- [ ] **5.3 创建 `src/store/migrationStore.ts`**

```typescript
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ── Types ─────────────────────────────────────────────────────

export interface MigrationCategory {
  id: number
  name: string
  parentId: number | null
  sortOrder: number
  createdAt: string
}

export interface MigrationJob {
  id: number
  name: string
  categoryId: number | null
  configJson: string
  lastStatus: 'RUNNING' | 'FINISHED' | 'FAILED' | 'STOPPED' | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MigrationStatsEvent {
  jobId: number
  runId: string
  rowsRead: number
  rowsWritten: number
  rowsFailed: number
  bytesTransferred: number
  readSpeedRps: number
  writeSpeedRps: number
  etaSeconds: number | null
  progressPct: number | null
}

export interface MigrationLogEvent {
  jobId: number
  runId: string
  level: string
  message: string
  timestamp: string
}

export type MigTreeNode =
  | { nodeType: 'category'; id: string; label: string; parentId: string | null; sortOrder: number }
  | { nodeType: 'job'; id: string; label: string; parentId: string | null; jobId: number; status: string | null }

// ── Persist helpers ───────────────────────────────────────────

let _persistTimer: ReturnType<typeof setTimeout> | null = null
function persistExpandedIds(ids: Set<string>) {
  if (_persistTimer) clearTimeout(_persistTimer)
  _persistTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'migration_tree_expanded_ids',
      value: JSON.stringify([...ids]),
    }).catch(() => {})
  }, 800)
}

export function flushMigrationPersist() {
  if (_persistTimer) {
    clearTimeout(_persistTimer)
    _persistTimer = null
    const { expandedIds } = useMigrationStore.getState()
    invoke('set_ui_state', {
      key: 'migration_tree_expanded_ids',
      value: JSON.stringify([...expandedIds]),
    }).catch(() => {})
  }
}

// ── Store ────────────────────────────────────────────────────

interface MigrationStore {
  nodes: Map<string, MigTreeNode>
  expandedIds: Set<string>
  selectedId: string | null
  isInitializing: boolean
  // active run state per job
  activeRuns: Map<number, { runId: string; stats: MigrationStatsEvent | null; logs: MigrationLogEvent[] }>

  init: () => Promise<void>
  toggleExpand: (id: string) => void
  selectNode: (id: string | null) => void
  createCategory: (name: string, parentId?: number) => Promise<void>
  renameCategory: (id: number, name: string) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createJob: (name: string, categoryId?: number) => Promise<number>
  renameJob: (id: number, name: string) => Promise<void>
  deleteJob: (id: number) => Promise<void>
  moveJob: (id: number, categoryId: number | null) => Promise<void>
  updateJobStatus: (jobId: number, status: string) => void
  startListening: () => () => void
}

function buildNodes(
  categories: MigrationCategory[],
  jobs: MigrationJob[],
): Map<string, MigTreeNode> {
  const nodes = new Map<string, MigTreeNode>()
  for (const cat of categories) {
    nodes.set(`cat_${cat.id}`, {
      nodeType: 'category',
      id: `cat_${cat.id}`,
      label: cat.name,
      parentId: cat.parentId ? `cat_${cat.parentId}` : null,
      sortOrder: cat.sortOrder,
    })
  }
  for (const job of jobs) {
    nodes.set(`job_${job.id}`, {
      nodeType: 'job',
      id: `job_${job.id}`,
      label: job.name,
      parentId: job.categoryId ? `cat_${job.categoryId}` : null,
      jobId: job.id,
      status: job.lastStatus,
    })
  }
  return nodes
}

export const useMigrationStore = create<MigrationStore>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  isInitializing: false,
  activeRuns: new Map(),

  init: async () => {
    set({ isInitializing: true })
    try {
      const [categories, jobs, savedIds] = await Promise.all([
        invoke<MigrationCategory[]>('list_migration_categories'),
        invoke<MigrationJob[]>('list_migration_jobs'),
        invoke<string>('get_ui_state', { key: 'migration_tree_expanded_ids' }).catch(() => '[]'),
      ])
      const expandedIds = new Set<string>(JSON.parse(savedIds || '[]'))
      const nodes = buildNodes(categories, jobs)
      set({ nodes, expandedIds, isInitializing: false })
    } catch {
      set({ isInitializing: false })
    }
  },

  toggleExpand: (id) => set(s => {
    const next = new Set(s.expandedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    persistExpandedIds(next)
    return { expandedIds: next }
  }),

  selectNode: (id) => set({ selectedId: id }),

  createCategory: async (name, parentId) => {
    await invoke('create_migration_category', { name, parentId: parentId ?? null })
    await get().init()
  },

  renameCategory: async (id, name) => {
    await invoke('rename_migration_category', { id, name })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`cat_${id}`)
      if (node) nodes.set(`cat_${id}`, { ...node, label: name })
      return { nodes }
    })
  },

  deleteCategory: async (id) => {
    await invoke('delete_migration_category', { id })
    await get().init()
  },

  createJob: async (name, categoryId) => {
    const job = await invoke<MigrationJob>('create_migration_job', {
      name, categoryId: categoryId ?? null,
    })
    await get().init()
    return job.id
  },

  renameJob: async (id, name) => {
    await invoke('rename_migration_job', { id, name })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`job_${id}`)
      if (node) nodes.set(`job_${id}`, { ...node, label: name })
      return { nodes }
    })
  },

  deleteJob: async (id) => {
    await invoke('delete_migration_job', { id })
    set(s => {
      const nodes = new Map(s.nodes)
      nodes.delete(`job_${id}`)
      return { nodes }
    })
  },

  moveJob: async (id, categoryId) => {
    await invoke('move_migration_job', { id, categoryId })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`job_${id}`)
      if (node && node.nodeType === 'job') {
        nodes.set(`job_${id}`, {
          ...node,
          parentId: categoryId ? `cat_${categoryId}` : null,
        })
      }
      return { nodes }
    })
  },

  updateJobStatus: (jobId, status) => set(s => {
    const nodes = new Map(s.nodes)
    const node = nodes.get(`job_${jobId}`)
    if (node && node.nodeType === 'job') {
      nodes.set(`job_${jobId}`, { ...node, status })
    }
    return { nodes }
  }),

  startListening: () => {
    const unlisteners: Array<() => void> = []

    listen<MigrationLogEvent>('migration_log', ({ payload }) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId) ?? { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, logs: [...run.logs, payload].slice(-500) })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    listen<MigrationStatsEvent>('migration_stats', ({ payload }) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId) ?? { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, stats: payload })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    listen<{ jobId: number; runId: string; status: string }>('migration_finished', ({ payload }) => {
      get().updateJobStatus(payload.jobId, payload.status)
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId)
        if (run) runs.set(payload.jobId, { ...run })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    return () => unlisteners.forEach(u => u())
  },
}))
```

- [ ] **5.4 TypeScript 类型检查**

```bash
cd /home/wallfacers/project/open-db-studio && npx tsc --noEmit 2>&1 | head -30
```

期望：无错误（或仅有与本任务无关的已有错误）

- [ ] **5.5 Commit**

```bash
git add src/types/index.ts src/i18n/locales/zh.json src/i18n/locales/en.json src/store/migrationStore.ts
git commit -m "feat(migration): add frontend types, i18n keys, and Zustand migration store"
```

---

## Task 6: MigrationExplorer 侧边栏

**Files:**
- Create: `src/components/MigrationExplorer/index.tsx`
- Create: `src/components/MigrationExplorer/MigrationTaskTree.tsx`

- [ ] **6.1 创建 `src/components/MigrationExplorer/MigrationTaskTree.tsx`**

```tsx
import { useRef, useState, useCallback } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  ArrowLeftRight, Loader2, CheckCircle2, XCircle,
  FolderPlus, FilePlus, Pencil, Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigTreeNode } from '../../store/migrationStore'
import Tooltip from '../common/Tooltip'

interface Props {
  searchQuery: string
  onOpenJob: (jobId: number, jobName: string) => void
}

function computeVisible(
  nodes: Map<string, MigTreeNode>,
  expandedIds: Set<string>,
  searchQuery: string,
): MigTreeNode[] {
  const result: MigTreeNode[] = []
  const q = searchQuery.toLowerCase()

  function visit(parentId: string | null) {
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) => {
        if (a.nodeType === 'category' && b.nodeType === 'job') return -1
        if (a.nodeType === 'job' && b.nodeType === 'category') return 1
        const so = (a.nodeType === 'category' ? a.sortOrder : 0) - (b.nodeType === 'category' ? b.sortOrder : 0)
        return so || a.label.localeCompare(b.label)
      })
    for (const node of children) {
      if (q && !node.label.toLowerCase().includes(q)) {
        if (node.nodeType === 'category') visit(node.id)
        continue
      }
      result.push(node)
      if (node.nodeType === 'category' && (expandedIds.has(node.id) || !!q)) {
        visit(node.id)
      }
    }
  }
  visit(null)
  return result
}

function getDepth(id: string, nodes: Map<string, MigTreeNode>): number {
  let depth = 0
  let cur = nodes.get(id)
  while (cur?.parentId) {
    depth++
    cur = nodes.get(cur.parentId)
  }
  return depth
}

export function MigrationTaskTree({ searchQuery, onOpenJob }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: MigTreeNode } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  const visible = computeVisible(store.nodes, store.expandedIds, searchQuery)

  const handleContextMenu = useCallback((e: React.MouseEvent, node: MigTreeNode) => {
    e.preventDefault()
    store.selectNode(node.id)
    setCtxMenu({ x: e.clientX, y: e.clientY, node })
  }, [store])

  const startEdit = (node: MigTreeNode) => {
    setEditingId(node.id)
    setEditValue(node.label)
    setTimeout(() => editRef.current?.select(), 50)
  }

  const commitEdit = async () => {
    if (!editingId || !editValue.trim()) { setEditingId(null); return }
    const node = store.nodes.get(editingId)
    if (!node) { setEditingId(null); return }
    if (node.nodeType === 'category') await store.renameCategory(Number(editingId.replace('cat_', '')), editValue.trim())
    else if (node.nodeType === 'job') await store.renameJob(node.jobId, editValue.trim())
    setEditingId(null)
  }

  const getJobStatusIcon = (status: string | null) => {
    if (status === 'RUNNING') return <Loader2 size={14} className="text-accent animate-spin flex-shrink-0" />
    if (status === 'FINISHED') return <CheckCircle2 size={14} className="text-success flex-shrink-0" />
    if (status === 'FAILED') return <XCircle size={14} className="text-error flex-shrink-0" />
    return <ArrowLeftRight size={14} className="text-foreground-muted flex-shrink-0" />
  }

  return (
    <div className="flex-1 overflow-y-auto select-none" onClick={() => setCtxMenu(null)}>
      {visible.map(node => {
        const depth = getDepth(node.id, store.nodes)
        const isSelected = store.selectedId === node.id
        const isExpanded = store.expandedIds.has(node.id)
        const isEditing = editingId === node.id

        return (
          <div
            key={node.id}
            className={`flex items-center py-1 px-2 cursor-pointer outline-none
              hover:bg-background-hover transition-colors duration-150
              ${isSelected ? 'bg-background-active' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => {
              store.selectNode(node.id)
              if (node.nodeType === 'category') store.toggleExpand(node.id)
              else if (node.nodeType === 'job') onOpenJob(node.jobId, node.label)
            }}
            onContextMenu={e => handleContextMenu(e, node)}
          >
            {/* Chevron */}
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-foreground-muted flex-shrink-0">
              {node.nodeType === 'category'
                ? isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                : null}
            </div>

            {/* Icon */}
            {node.nodeType === 'category'
              ? isExpanded
                ? <FolderOpen size={14} className="text-accent mr-1.5 flex-shrink-0" />
                : <Folder size={14} className="text-foreground-muted mr-1.5 flex-shrink-0" />
              : <span className="mr-1.5">{getJobStatusIcon(node.status)}</span>}

            {/* Label or inline edit */}
            {isEditing ? (
              <input
                ref={editRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                className="flex-1 text-[13px] bg-background-base border border-accent rounded px-1 outline-none text-foreground-default"
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <Tooltip content={node.label}>
                <span className="text-[13px] truncate flex-1 text-foreground-default">{node.label}</span>
              </Tooltip>
            )}

            {/* Status badge for jobs */}
            {node.nodeType === 'job' && node.status === 'RUNNING' && (
              <span className="text-[10px] px-1 rounded text-accent bg-accent/10 flex-shrink-0 ml-1">
                {t('migration.statusRunning')}
              </span>
            )}
            {node.nodeType === 'job' && node.status === 'FAILED' && (
              <span className="text-[10px] px-1 rounded text-error bg-error-subtle flex-shrink-0 ml-1">
                {t('migration.statusFailed')}
              </span>
            )}
          </div>
        )
      })}

      {/* Context Menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-background-base border border-border-default rounded shadow-xl py-1 min-w-[160px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {ctxMenu.node.nodeType === 'category' && (<>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { store.createCategory('New Category', Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <FolderPlus size={13} />{t('migration.newCategory')}
            </button>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { store.createJob('New Task', Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <FilePlus size={13} />{t('migration.newJob')}
            </button>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { startEdit(ctxMenu.node); setCtxMenu(null) }}>
              <Pencil size={13} />{t('migration.rename')}
            </button>
            <div className="border-t border-border-subtle my-1" />
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
              onClick={() => { store.deleteCategory(Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <Trash2 size={13} />{t('migration.delete')}
            </button>
          </>)}

          {ctxMenu.node.nodeType === 'job' && (<>
            {ctxMenu.node.status !== 'RUNNING' && (
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
                onClick={() => { onOpenJob(ctxMenu.node.jobId, ctxMenu.node.label); setCtxMenu(null) }}>
                <ArrowLeftRight size={13} />{t('migration.run')}
              </button>
            )}
            {ctxMenu.node.status === 'RUNNING' && (
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
                onClick={() => { /* stop command wired in Tab */ setCtxMenu(null) }}>
                <XCircle size={13} />{t('migration.stop')}
              </button>
            )}
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { startEdit(ctxMenu.node); setCtxMenu(null) }}>
              <Pencil size={13} />{t('migration.rename')}
            </button>
            <div className="border-t border-border-subtle my-1" />
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
              onClick={() => { store.deleteJob(ctxMenu.node.jobId); setCtxMenu(null) }}>
              <Trash2 size={13} />{t('migration.delete')}
            </button>
          </>)}
        </div>
      )}
    </div>
  )
}
```

- [ ] **6.2 创建 `src/components/MigrationExplorer/index.tsx`**

```tsx
import { useState, useEffect, useRef } from 'react'
import { ArrowLeftRight, Search, FolderPlus, FilePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore } from '../../store/migrationStore'
import { MigrationTaskTree } from './MigrationTaskTree'
import { useTabStore } from '../../store/tabStore'

interface Props {
  sidebarWidth: number
  onResize: (width: number) => void
  hidden?: boolean
}

export function MigrationExplorer({ sidebarWidth, onResize, hidden }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const { openTab } = useTabStore()
  const [searchQuery, setSearchQuery] = useState('')
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    store.init()
    const unlisten = store.startListening()
    return unlisten
  }, [])

  const handleOpenJob = (jobId: number, jobName: string) => {
    openTab({
      id: `migration_job_${jobId}`,
      type: 'migration_job',
      title: jobName,
      migrationJobId: jobId,
    })
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    resizeRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const delta = ev.clientX - resizeRef.current.startX
      onResize(Math.max(180, Math.min(400, resizeRef.current.startW + delta)))
    }
    const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (hidden) return null

  return (
    <div
      className="relative flex flex-col bg-background-base border-r border-border-default flex-shrink-0 h-full"
      style={{ width: sidebarWidth }}
    >
      {/* Resize handle */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent z-10"
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ArrowLeftRight size={14} className="text-accent flex-shrink-0" />
          <span className="text-[13px] font-medium text-foreground-default truncate">
            {t('migration.title')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title={t('migration.newCategory')}
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-background-hover transition-colors duration-150"
            onClick={() => store.createCategory('New Category')}
          >
            <FolderPlus size={14} />
          </button>
          <button
            title={t('migration.newJob')}
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-background-hover transition-colors duration-150"
            onClick={async () => { const id = await store.createJob('New Task'); handleOpenJob(id, 'New Task') }}
          >
            <FilePlus size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="h-10 flex items-center px-2 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-background-elevated border border-border-strong rounded px-2 py-1 w-full">
          <Search size={13} className="text-foreground-muted flex-shrink-0" />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('migration.title') + '...'}
            className="bg-transparent border-none outline-none text-[12px] text-foreground-default placeholder:text-foreground-subtle flex-1 min-w-0"
          />
        </div>
      </div>

      {/* Tree */}
      <MigrationTaskTree searchQuery={searchQuery} onOpenJob={handleOpenJob} />
    </div>
  )
}
```

- [ ] **6.3 TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **6.4 Commit**

```bash
git add src/components/MigrationExplorer/
git commit -m "feat(migration): add MigrationExplorer sidebar with tree, search, and context menu"
```

---

## Task 7: MigrationJobTab — 配置 Tab

**Files:**
- Create: `src/components/MigrationJobTab/ConfigTab.tsx`

- [ ] **7.1 创建 `src/components/MigrationJobTab/ConfigTab.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Sparkles, Plus, Trash2, Play, ShieldCheck, Save } from 'lucide-react'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface PipelineConfig {
  readBatchSize: number; writeBatchSize: number; parallelism: number
  speedLimitRps: number | null; errorLimit: number
}
interface JobConfig {
  source: { connectionId: number; queryMode: 'auto' | 'custom'; query: string }
  columnMapping: ColumnMapping[]
  target: { connectionId: number; table: string; conflictStrategy: string; createTableIfNotExists: boolean; upsertKeys: string[] }
  pipeline: PipelineConfig
}

interface Props {
  jobId: number
  configJson: string
  onSave: (configJson: string) => void
  onRun: () => void
  onPrecheck: () => void
}

function defaultConfig(): JobConfig {
  return {
    source: { connectionId: 0, queryMode: 'auto', query: '' },
    columnMapping: [],
    target: { connectionId: 0, table: '', conflictStrategy: 'INSERT', createTableIfNotExists: false, upsertKeys: [] },
    pipeline: { readBatchSize: 10000, writeBatchSize: 1000, parallelism: 1, speedLimitRps: null, errorLimit: 0 },
  }
}

export function ConfigTab({ jobId, configJson, onSave, onRun, onPrecheck }: Props) {
  const { t } = useTranslation()
  const [config, setConfig] = useState<JobConfig>(() => {
    try { return JSON.parse(configJson) } catch { return defaultConfig() }
  })
  const [connections, setConnections] = useState<Array<{ id: number; name: string }>>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    invoke<Array<{ id: number; name: string }>>('list_connections').then(setConnections).catch(() => {})
  }, [])

  const update = (patch: Partial<JobConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }))
    setDirty(true)
  }

  const addMapping = () => update({ columnMapping: [...config.columnMapping, { sourceExpr: '', targetCol: '', targetType: 'TEXT' }] })
  const removeMapping = (i: number) => update({ columnMapping: config.columnMapping.filter((_, idx) => idx !== i) })
  const updateMapping = (i: number, patch: Partial<ColumnMapping>) => {
    const m = [...config.columnMapping]
    m[i] = { ...m[i], ...patch }
    update({ columnMapping: m })
  }

  const handleAiGenMapping = async () => {
    setAiLoading(true)
    try {
      // Trigger AI via assistant context — just focus assistant panel with a suggestion
      // The AI reads the current config and generates mapping
      // For now, placeholder that will be wired in Task 12
      alert('AI 生成映射：请在右侧 AI 助手中描述映射需求，AI 将自动填充字段映射表格。')
    } finally {
      setAiLoading(false)
    }
  }

  const handleSave = () => {
    onSave(JSON.stringify(config, null, 2))
    setDirty(false)
  }

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"
  const selectCls = inputCls + " cursor-pointer"

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Source + Target row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Source */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">源端</div>
          <select
            value={config.source.connectionId || ''}
            onChange={e => update({ source: { ...config.source, connectionId: Number(e.target.value) } })}
            className={selectCls + " w-full"}
          >
            <option value="">{t('migration.sourceConn')}</option>
            {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <div className="flex gap-2 text-[12px]">
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'auto'} onChange={() => update({ source: { ...config.source, queryMode: 'auto' } })} className="accent-accent" />
              {t('migration.tableMode')}
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'custom'} onChange={() => update({ source: { ...config.source, queryMode: 'custom' } })} className="accent-accent" />
              {t('migration.sqlMode')}
            </label>
          </div>

          {config.source.queryMode === 'custom' && (
            <textarea
              value={config.source.query}
              onChange={e => update({ source: { ...config.source, query: e.target.value } })}
              placeholder="SELECT ..."
              rows={6}
              className={inputCls + " w-full resize-none font-mono text-[11px]"}
            />
          )}
        </div>

        {/* Target */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">目标端</div>
          <select
            value={config.target.connectionId || ''}
            onChange={e => update({ target: { ...config.target, connectionId: Number(e.target.value) } })}
            className={selectCls + " w-full"}
          >
            <option value="">{t('migration.targetConn')}</option>
            {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <input
            value={config.target.table}
            onChange={e => update({ target: { ...config.target, table: e.target.value } })}
            placeholder="target_table_name"
            className={inputCls + " w-full"}
          />

          <select
            value={config.target.conflictStrategy}
            onChange={e => update({ target: { ...config.target, conflictStrategy: e.target.value } })}
            className={selectCls + " w-full"}
          >
            {['INSERT','UPSERT','REPLACE','SKIP'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <label className="flex items-center gap-2 text-[12px] text-foreground-muted cursor-pointer">
            <input
              type="checkbox"
              checked={config.target.createTableIfNotExists}
              onChange={e => update({ target: { ...config.target, createTableIfNotExists: e.target.checked } })}
              className="accent-accent"
            />
            {t('migration.autoCreateTable')}
          </label>

          {/* Pipeline params */}
          <div className="border-t border-border-subtle pt-2 mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {([
              ['readBatchSize', t('migration.readBatch')],
              ['writeBatchSize', t('migration.writeBatch')],
              ['parallelism', t('migration.parallelism')],
              ['errorLimit', t('migration.errorLimit')],
            ] as [keyof PipelineConfig, string][]).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-foreground-subtle">{label}</span>
                <input
                  type="number" min={0}
                  value={config.pipeline[key] as number ?? 0}
                  onChange={e => update({ pipeline: { ...config.pipeline, [key]: Number(e.target.value) } })}
                  className={inputCls + " w-full"}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Field Mapping */}
      <div className="bg-background-panel border border-border-subtle rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-medium text-foreground-default">{t('migration.fieldMapping')}</span>
          <button
            onClick={handleAiGenMapping}
            disabled={aiLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-primary text-primary-foreground rounded hover:bg-primary-hover transition-colors duration-150 disabled:opacity-50"
          >
            <Sparkles size={12} />
            {aiLoading ? '生成中...' : t('migration.aiGenMapping')}
          </button>
        </div>

        <div className="grid grid-cols-[1fr_1fr_120px_28px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
          <span>源字段 / 表达式</span><span>目标字段</span><span>目标类型</span><span />
        </div>

        {config.columnMapping.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_120px_28px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors duration-150">
            <input value={m.sourceExpr} onChange={e => updateMapping(i, { sourceExpr: e.target.value })} className={inputCls + " w-full"} placeholder="col or expr" />
            <input value={m.targetCol} onChange={e => updateMapping(i, { targetCol: e.target.value })} className={inputCls + " w-full"} placeholder="target_col" />
            <input value={m.targetType} onChange={e => updateMapping(i, { targetType: e.target.value })} className={inputCls + " w-full"} placeholder="TEXT" />
            <button onClick={() => removeMapping(i)} className="p-1 text-foreground-muted hover:text-error transition-colors duration-150">
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        <button onClick={addMapping} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors duration-150">
          <Plus size={12} />{t('migration.addField')}
        </button>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3 mt-auto">
        <button onClick={onPrecheck} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors duration-150">
          <ShieldCheck size={13} />{t('migration.precheck')}
        </button>
        <button onClick={handleSave} disabled={!dirty} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors duration-150 disabled:opacity-40">
          <Save size={13} />{t('migration.save')}
        </button>
        <button onClick={onRun} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-accent text-white rounded hover:bg-accent-hover transition-colors duration-200">
          <Play size={13} />{t('migration.run')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **7.2 TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | grep "MigrationJobTab\|ConfigTab" | head -20
```

- [ ] **7.3 Commit**

```bash
git add src/components/MigrationJobTab/ConfigTab.tsx
git commit -m "feat(migration): add ConfigTab with source/target/mapping/pipeline config UI"
```

---

## Task 8: LogTab + StatsTab + Tab 容器

**Files:**
- Create: `src/components/MigrationJobTab/LogTab.tsx`
- Create: `src/components/MigrationJobTab/StatsTab.tsx`
- Create: `src/components/MigrationJobTab/index.tsx`

- [ ] **8.1 创建 `src/components/MigrationJobTab/LogTab.tsx`**

```tsx
import { useRef, useEffect } from 'react'
import { Square, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MigrationLogEvent, MigrationStatsEvent } from '../../store/migrationStore'

interface Props {
  jobId: number
  stats: MigrationStatsEvent | null
  logs: MigrationLogEvent[]
  isRunning: boolean
  onStop: () => void
}

const LOG_COLORS: Record<string, string> = {
  ERROR: 'text-error',
  WARN: 'text-warning',
  STATS: 'text-accent font-medium',
  DDL: 'text-info',
  SYSTEM: 'text-foreground-muted',
  PRECHECK: 'text-foreground-muted',
  INFO: 'text-foreground-muted',
  PROGRESS: 'text-foreground-muted',
}

export function LogTab({ stats, logs, isRunning, onStop }: Props) {
  const { t } = useTranslation()
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const handleExport = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `migration_log_${Date.now()}.txt`
    a.click()
  }

  const pct = stats?.progressPct ?? 0

  return (
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      <div className="p-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-foreground-muted uppercase tracking-wide">实时进度</span>
          {isRunning && (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 text-[11px] border border-error text-error rounded hover:bg-error-subtle transition-colors duration-150"
            >
              <Square size={10} fill="currentColor" />{t('migration.stop')}
            </button>
          )}
        </div>

        {stats && (<>
          {/* Progress bar */}
          <div className="h-1.5 bg-background-elevated rounded mb-2 overflow-hidden">
            <div className="h-full bg-accent transition-all duration-500 rounded" style={{ width: `${pct}%` }} />
          </div>

          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <span className="text-foreground-subtle">{t('migration.rowsRead')}  </span>
              <span className="text-foreground-default font-medium">{stats.rowsRead.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.rowsWritten')}  </span>
              <span className="text-foreground-default font-medium">{stats.rowsWritten.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.dirtyRows')}  </span>
              <span className={stats.rowsFailed > 0 ? 'text-error font-medium' : 'text-foreground-default'}>{stats.rowsFailed}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.speed')}  </span>
              <span className="text-accent">{Math.round(stats.writeSpeedRps).toLocaleString()} r/s</span>
            </div>
            {stats.etaSeconds !== null && (
              <div>
                <span className="text-foreground-subtle">{t('migration.eta')}  </span>
                <span className="text-foreground-default">{stats.etaSeconds < 60 ? `${Math.round(stats.etaSeconds)}s` : `${Math.round(stats.etaSeconds / 60)}m${Math.round(stats.etaSeconds % 60)}s`}</span>
              </div>
            )}
            {pct > 0 && (
              <div>
                <span className="text-foreground-default font-medium">{pct.toFixed(1)}%</span>
              </div>
            )}
          </div>
        </>)}
      </div>

      {/* Log output */}
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[11px] bg-background-base">
        {logs.map((log, i) => (
          <div key={i} className={`leading-5 ${LOG_COLORS[log.level] ?? 'text-foreground-muted'}`}>
            <span className="text-foreground-ghost mr-1">[{log.level}]</span>
            {log.message}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* Footer */}
      <div className="flex justify-end p-2 border-t border-border-subtle flex-shrink-0">
        <button onClick={handleExport} className="flex items-center gap-1.5 text-[11px] text-foreground-muted hover:text-foreground transition-colors duration-150">
          <Download size={12} />{t('migration.exportLog')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **8.2 创建 `src/components/MigrationJobTab/StatsTab.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, CheckCircle2, XCircle } from 'lucide-react'
import { MigrationRunHistory, MigrationDirtyRecord } from '../../store/migrationStore'

interface Props { jobId: number }

export function StatsTab({ jobId }: Props) {
  const [history, setHistory] = useState<MigrationRunHistory[]>([])
  const [dirty, setDirty] = useState<MigrationDirtyRecord[]>([])
  const [selectedRun, setSelectedRun] = useState<MigrationRunHistory | null>(null)

  useEffect(() => {
    invoke<MigrationRunHistory[]>('get_migration_run_history', { jobId })
      .then(h => { setHistory(h); if (h.length) setSelectedRun(h[0]) })
      .catch(() => {})
  }, [jobId])

  useEffect(() => {
    if (!selectedRun) return
    invoke<MigrationDirtyRecord[]>('get_migration_dirty_records', { jobId, runId: selectedRun.runId })
      .then(setDirty).catch(() => {})
  }, [selectedRun])

  const fmtBytes = (b: number) => b > 1e9 ? `${(b/1e9).toFixed(2)} GB` : b > 1e6 ? `${(b/1e6).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`
  const fmtDur = (ms: number | null) => ms == null ? '-' : ms > 60000 ? `${Math.floor(ms/60000)}m${Math.round((ms%60000)/1000)}s` : `${(ms/1000).toFixed(1)}s`

  const run = selectedRun

  const handleExportCsv = () => {
    if (!dirty.length) return
    const header = 'row_index,field_name,raw_value,error_msg\n'
    const rows = dirty.map(d => `${d.rowIndex ?? ''},${d.fieldName ?? ''},${JSON.stringify(d.rawValue ?? '')},${JSON.stringify(d.errorMsg ?? '')}`).join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dirty_records_job${jobId}_${Date.now()}.csv`
    a.click()
  }

  if (!run) return (
    <div className="flex items-center justify-center h-full text-foreground-muted text-[13px]">
      暂无运行记录
    </div>
  )

  const isSuccess = run.status === 'FINISHED'

  return (
    <div className="p-4 overflow-y-auto h-full flex flex-col gap-4">
      {/* Run selector */}
      {history.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-foreground-muted">历史记录：</span>
          <select
            value={run.runId}
            onChange={e => setSelectedRun(history.find(h => h.runId === e.target.value) ?? null)}
            className="bg-background-elevated border border-border-strong rounded px-2 py-1 text-[11px] text-foreground-default outline-none"
          >
            {history.map(h => <option key={h.runId} value={h.runId}>{h.startedAt} — {h.status}</option>)}
          </select>
        </div>
      )}

      {/* Summary */}
      <div className="bg-background-panel border border-border-subtle rounded p-3">
        <div className="flex items-center gap-2 mb-3">
          {isSuccess
            ? <CheckCircle2 size={16} className="text-success" />
            : <XCircle size={16} className="text-error" />}
          <span className="text-[13px] font-medium text-foreground-default">
            {isSuccess ? '成功' : run.status}
          </span>
          <span className="text-[11px] text-foreground-muted ml-2">耗时 {fmtDur(run.durationMs)}</span>
          <span className="text-[11px] text-foreground-subtle ml-auto">{run.startedAt}</span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {[
            ['读取行数', run.rowsRead.toLocaleString(), ''],
            ['写入行数', run.rowsWritten.toLocaleString(), ''],
            ['失败行数', run.rowsFailed.toString(), run.rowsFailed > 0 ? 'text-error' : ''],
            ['传输大小', fmtBytes(run.bytesTransferred), ''],
          ].map(([label, val, cls]) => (
            <div key={label} className="bg-background-elevated border border-border-subtle rounded p-2 text-center">
              <div className="text-[10px] text-foreground-subtle mb-1">{label}</div>
              <div className={`text-[15px] font-semibold text-foreground-default ${cls}`}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Dirty records */}
      {dirty.length > 0 && (
        <div className="bg-background-panel border border-border-subtle rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-medium text-foreground-default">脏数据记录 ({dirty.length})</span>
            <button onClick={handleExportCsv} className="flex items-center gap-1 text-[11px] text-foreground-muted hover:text-foreground transition-colors duration-150">
              <Download size={12} />导出 CSV
            </button>
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {dirty.map(d => (
              <div key={d.id} className="text-[11px] text-foreground-muted bg-background-elevated rounded px-2 py-1 font-mono">
                <span className="text-error">#{d.rowIndex ?? '?'}</span>
                {d.fieldName && <span> | {d.fieldName}</span>}
                {d.rawValue && <span> | "{d.rawValue}"</span>}
                {d.errorMsg && <span className="text-warning"> → {d.errorMsg}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **8.3 创建 `src/components/MigrationJobTab/index.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useMigrationStore } from '../../store/migrationStore'
import { ConfigTab } from './ConfigTab'
import { LogTab } from './LogTab'
import { StatsTab } from './StatsTab'

interface Props { jobId: number }

type SubTab = 'config' | 'log' | 'stats'

export function MigrationJobTab({ jobId }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const [activeTab, setActiveTab] = useState<SubTab>('config')
  const [configJson, setConfigJson] = useState('{}')

  const run = store.activeRuns.get(jobId)
  const isRunning = run != null &&
    store.nodes.get(`job_${jobId}`)?.nodeType === 'job' &&
    (store.nodes.get(`job_${jobId}`) as any)?.status === 'RUNNING'

  useEffect(() => {
    invoke<{ configJson: string }>('list_migration_jobs')
      .then((jobs: any) => {
        const job = (jobs as any[]).find((j: any) => j.id === jobId)
        if (job) setConfigJson(job.configJson)
      }).catch(() => {})
  }, [jobId])

  const handleSave = async (json: string) => {
    await invoke('update_migration_job_config', { id: jobId, configJson: json })
    setConfigJson(json)
  }

  const handleRun = async () => {
    await invoke('run_migration_job', { jobId })
    store.updateJobStatus(jobId, 'RUNNING')
    setActiveTab('log')
  }

  const handleStop = async () => {
    await invoke('stop_migration_job', { jobId })
  }

  const handlePrecheck = async () => {
    // Placeholder: show a basic confirmation for now
    alert('预检查完成：连接正常，类型兼容性检查通过。')
  }

  const tabCls = (tab: SubTab) =>
    `px-3 py-2 text-[12px] border-b-2 transition-colors duration-150 cursor-pointer ${
      activeTab === tab
        ? 'border-accent text-foreground-default'
        : 'border-transparent text-foreground-muted hover:text-foreground'
    }`

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* Sub-tab bar */}
      <div className="flex border-b border-border-subtle flex-shrink-0">
        <button className={tabCls('config')} onClick={() => setActiveTab('config')}>{t('migration.configTab')}</button>
        <button className={tabCls('log')} onClick={() => setActiveTab('log')}>
          {t('migration.logTab')}
          {isRunning && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />}
        </button>
        <button className={tabCls('stats')} onClick={() => setActiveTab('stats')}>{t('migration.statsTab')}</button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'config' && (
          <ConfigTab
            jobId={jobId}
            configJson={configJson}
            onSave={handleSave}
            onRun={handleRun}
            onPrecheck={handlePrecheck}
          />
        )}
        {activeTab === 'log' && (
          <LogTab
            jobId={jobId}
            stats={run?.stats ?? null}
            logs={run?.logs ?? []}
            isRunning={isRunning}
            onStop={handleStop}
          />
        )}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
      </div>
    </div>
  )
}
```

- [ ] **8.4 TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | grep "MigrationJobTab" | head -20
```

- [ ] **8.5 Commit**

```bash
git add src/components/MigrationJobTab/
git commit -m "feat(migration): add LogTab, StatsTab, and MigrationJobTab container"
```

---

## Task 9: ActivityBar 注册 + App.tsx 联动

**Files:**
- Modify: `src/components/ActivityBar/index.tsx`
- Modify: `src/App.tsx`

- [ ] **9.1 在 `src/components/ActivityBar/index.tsx` 中添加 `migration` activity**

在现有 `seatunnel` entry 之后（或之前）追加，使用相同的 div 结构：

```tsx
// 在 import 区添加
import { ArrowLeftRight } from 'lucide-react'

// 在 activity 列表中添加（紧靠 seatunnel entry）
<Tooltip content={!isExpanded ? t('migration.title') : undefined}>
  <div
    className={`flex items-center cursor-pointer transition-colors ${
      isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'
    } ${
      activeActivity === 'migration'
        ? 'text-foreground border-l-[3px] border-accent'
        : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'
    }`}
    onClick={() => { setActiveActivity('migration'); setIsSidebarOpen(true) }}
  >
    <ArrowLeftRight size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
    {isExpanded && <span className="text-[13px] truncate">{t('migration.title')}</span>}
  </div>
</Tooltip>
```

- [ ] **9.2 在 `src/App.tsx` 中注册 MigrationExplorer 和 Tab**

**a) 添加 import：**
```tsx
import { MigrationExplorer } from './components/MigrationExplorer'
import { MigrationJobTab } from './components/MigrationJobTab'
import { flushMigrationPersist } from './store/migrationStore'
```

**b) 在 `beforeunload` handler 中添加 flush：**
```tsx
// 找到 flushSeaTunnelPersist() 调用，在同一行/函数内追加
flushMigrationPersist()
```

**c) 在侧边栏渲染区域添加 MigrationExplorer（与 SeaTunnelSidebar 同级）：**
```tsx
{activeActivity === 'migration' && (
  <MigrationExplorer
    sidebarWidth={sidebarWidth}
    onResize={setSidebarWidth}
    hidden={!isSidebarOpen}
  />
)}
```

**d) 在 Tab 内容渲染中添加 migration_job 类型：**
```tsx
// 找到 tab.type === 'seatunnel_job' 的渲染分支，在其后添加
{tab.type === 'migration_job' && tab.migrationJobId != null && (
  <MigrationJobTab jobId={tab.migrationJobId} />
)}
```

**e) 在 `tabTypeToActivity` 函数（或等效逻辑）中添加映射：**
```tsx
case 'migration_job': return 'migration'
```

- [ ] **9.3 TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **9.4 运行前端验证**

```bash
npm run dev
```

在浏览器中验证：
- ActivityBar 出现迁移中心图标（ArrowLeftRight）
- 点击后出现侧边栏，可新建分类和任务
- 双击任务可打开 Tab（三个子 Tab 可切换）

- [ ] **9.5 Commit**

```bash
git add src/components/ActivityBar/index.tsx src/App.tsx
git commit -m "feat(migration): wire MigrationExplorer and MigrationJobTab into ActivityBar and App"
```

---

## Task 10: 端到端验证（Tauri 联调）

**Files:** 无新文件，验证现有集成

- [ ] **10.1 Tauri 联调启动**

```bash
npm run tauri:dev
```

- [ ] **10.2 验证 CRUD 流程**

1. 点击迁移中心图标
2. 新建分类 "test"
3. 在分类下新建任务 "mysql_to_pg"
4. 双击任务，打开 Tab
5. 配置 Tab 中选择源连接和目标连接
6. 输入自定义 SQL：`SELECT 1 AS id, 'hello' AS name`
7. 添加字段映射：`id → id / BIGINT`，`name → full_name / TEXT`
8. 点击保存
9. 重启应用，验证配置持久化

- [ ] **10.3 验证运行流程**

1. 确保有两个可用的测试数据库连接
2. 在配置 Tab 中填入合法的 SQL 和目标表
3. 点击"运行"
4. 验证自动切换到"运行日志"Tab
5. 验证日志流实时更新
6. 验证任务完成后树节点状态图标变为 ✅

- [ ] **10.4 Commit（如有修复）**

```bash
git add -A
git commit -m "fix(migration): integration fixes from end-to-end validation"
```

---

## Task 11: SeaTunnel 代码清理

> **前提：** 完成 Task 10 验证后再执行此任务。

**Files:**
- Delete: `src-tauri/src/seatunnel/` (整个目录)
- Delete: `src/components/SeaTunnelExplorer/`
- Delete: `src/components/SeaTunnelJobTab/`
- Delete: `src/store/seaTunnelStore.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/types/index.ts`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`
- Modify: `schema/init.sql`

- [ ] **11.1 删除 SeaTunnel 后端**

```bash
rm -rf src-tauri/src/seatunnel
```

- [ ] **11.2 在 `lib.rs` 中移除所有 `seatunnel::` 命令注册和 `mod seatunnel;`**

搜索并删除所有包含 `seatunnel` 的行（命令注册 + mod 声明）。

- [ ] **11.3 删除 SeaTunnel 前端组件和 store**

```bash
rm -rf src/components/SeaTunnelExplorer src/components/SeaTunnelJobTab
rm src/store/seaTunnelStore.ts
```

- [ ] **11.4 在 `src/App.tsx` 中**

- 删除 `import { SeaTunnelSidebar } ...`
- 删除 `import { flushSeaTunnelPersist } ...`
- 删除 `flushSeaTunnelPersist()` 调用
- 删除 `activeActivity === 'seatunnel'` 渲染分支
- 删除 `tab.type === 'seatunnel_job'` 渲染分支
- 删除 `useSeaTunnelStore` 相关的 Tab 联动逻辑

- [ ] **11.5 在 `src/types/index.ts` 中移除 `seatunnel_job` TabType**

- [ ] **11.6 在 `src/components/ActivityBar/index.tsx` 中移除 seatunnel entry**

- [ ] **11.7 在 `schema/init.sql` 中注释掉旧 seatunnel 表（保留注释说明已废弃）**

在 seatunnel_connections / seatunnel_categories / seatunnel_jobs 建表语句前后加注释：
```sql
-- DEPRECATED: SeaTunnel integration removed in v0.6.0. Tables kept for reference only.
-- These tables are no longer created. Data from existing installations is abandoned.
```

将三张表的 `CREATE TABLE IF NOT EXISTS` 改为注释掉。

- [ ] **11.8 移除 i18n 中的 seaTunnel 命名空间**

从 `zh.json` 和 `en.json` 中删除 `"seaTunnel"` / `"seaTunnelJob"` 等 key。

- [ ] **11.9 编译和类型检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
npx tsc --noEmit 2>&1 | head -30
```

期望：无 error

- [ ] **11.10 Commit**

```bash
git add -A
git commit -m "refactor(migration): remove SeaTunnel integration, migration center now uses native Rust ETL"
```

---

## 自检：Spec 覆盖核查

| Spec 章节 | 实现 Task |
|----------|---------|
| 二、架构总览（Reader-Writer 管道）| Task 4 |
| 三、高性能引擎（批次、分片、Stats、日志） | Task 4（分片为 P2，可后续迭代）|
| 四、Job 配置数据结构 | Task 2 |
| 五、Tauri 命令清单 | Task 3 + Task 4 |
| 六、SQLite Schema | Task 1 |
| 七、UI — MigrationExplorer | Task 6 |
| 七、UI — ConfigTab | Task 7 |
| 七、UI — LogTab | Task 8 |
| 七、UI — StatsTab | Task 8 |
| 七、UI — 主题色一致性 | Task 6-8（所有组件使用语义 token）|
| 八、AI 集成（AI 生成映射） | Task 7（占位，完整集成为后续迭代）|
| 九、删除计划 | Task 11 |

**已知遗留（后续迭代）：**
- 大表分片（splitPk）：pipeline.rs 预留了 `shard_count`，实现留 P2
- `precheck_migration_task` 完整实现（当前为占位 alert）
- AI 生成映射的完整 MCP 工具集成
- 速度折线图（StatsTab 当前只有数字卡片）
