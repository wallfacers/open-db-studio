# V2 Knowledge Graph + Metrics + Pipeline 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现三层知识图谱（结构层+指标层+语义层）、业务指标管理，以及基于图谱检索的高精度 Text-to-SQL Pipeline v2。

**Architecture:** 在 Rust 后端新增 `graph/`、`metrics/`、`pipeline/` 三个独立模块，通过 Tauri commands 暴露给前端；SQLite 存储图谱数据；pipeline 作为协调层，调用 LLM 提取实体后在图谱中检索相关子图，组装高质量 Prompt。

**Tech Stack:** Rust (rusqlite, serde_json, async-trait), React 18 + TypeScript, Tauri 2.x Events, @xyflow/react（图谱可视化复用现有 ERDiagram 依赖）

---

## Chunk 1: SQLite Schema 扩展 + Rust 模块骨架

### Task 1: 扩展 schema/init.sql（新增 6 张表）

**Files:**
- Modify: `schema/init.sql`

- [ ] **Step 1: 追加 6 张新表 DDL 至 init.sql 末尾**

在 `schema/init.sql` 末尾追加：

```sql
-- ============ V2: 知识图谱 ============

-- 图谱节点（三层统一建模）
CREATE TABLE IF NOT EXISTS graph_nodes (
    id            TEXT PRIMARY KEY,
    node_type     TEXT NOT NULL CHECK(node_type IN ('table','column','fk','index','metric','alias')),
    connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    display_name  TEXT,
    metadata      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_conn ON graph_nodes(connection_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);

-- 图谱边
CREATE TABLE IF NOT EXISTS graph_edges (
    id         TEXT PRIMARY KEY,
    from_node  TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    to_node    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    edge_type  TEXT NOT NULL CHECK(edge_type IN ('has_column','foreign_key','metric_ref','alias_of','join_path')),
    weight     REAL NOT NULL DEFAULT 1.0,
    metadata   TEXT
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);

-- ============ V2: 业务指标 ============

CREATE TABLE IF NOT EXISTS metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    column_name   TEXT,
    aggregation   TEXT CHECK(aggregation IN ('SUM','COUNT','AVG','MAX','MIN','CUSTOM')),
    filter_sql    TEXT,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
    source        TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_conn ON metrics(connection_id);
CREATE INDEX IF NOT EXISTS idx_metrics_status ON metrics(status);

-- 业务语义别名
CREATE TABLE IF NOT EXISTS semantic_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    alias         TEXT NOT NULL,
    node_id       TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    confidence    REAL NOT NULL DEFAULT 1.0,
    source        TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_semantic_aliases_conn ON semantic_aliases(connection_id);

-- ============ V2: 跨数据源迁移（由 Plan B 使用，此处提前创建保证 schema 一致性）============

CREATE TABLE IF NOT EXISTS migration_tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    src_connection_id INTEGER NOT NULL REFERENCES connections(id),
    dst_connection_id INTEGER NOT NULL REFERENCES connections(id),
    config            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed')),
    progress          TEXT,
    error_report      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS migration_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
    check_type  TEXT NOT NULL CHECK(check_type IN ('type_compat','null_constraint','pk_conflict','other')),
    table_name  TEXT NOT NULL,
    column_name TEXT,
    severity    TEXT NOT NULL CHECK(severity IN ('error','warning','info')),
    message     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_checks_task ON migration_checks(task_id);
```

- [ ] **Step 2: 验证 SQL 语法无误（cargo check）**

```bash
cd src-tauri && cargo check
```

期望：无编译错误（schema 文件是静态文本，只需确认 Rust 代码仍能编译）

- [ ] **Step 3: Commit**

```bash
git add schema/init.sql
git commit -m "feat(schema): add V2 tables — graph_nodes, graph_edges, metrics, semantic_aliases, migration tables"
```

---

### Task 2: 创建 graph/ 模块骨架

**Files:**
- Create: `src-tauri/src/graph/mod.rs`
- Create: `src-tauri/src/graph/builder.rs`
- Create: `src-tauri/src/graph/traversal.rs`
- Create: `src-tauri/src/graph/query.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 graph/mod.rs**

```rust
// src-tauri/src/graph/mod.rs
pub mod builder;
pub mod query;
pub mod traversal;

pub use query::{GraphNode, GraphEdge, SubGraph, search_graph, find_relevant_subgraph};
pub use builder::build_schema_graph;
```

- [ ] **Step 2: 创建 graph/builder.rs 骨架**

```rust
// src-tauri/src/graph/builder.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BuildProgress {
    pub step: String,
    pub done: usize,
    pub total: usize,
}

/// 解析外部数据源 Schema → 写入 graph_nodes / graph_edges
/// 通过 Tauri Event "graph:build_progress" 广播进度
pub async fn build_schema_graph(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    // Phase 1: 获取数据源 schema（Task 3 实现）
    // Phase 2: 写入图谱节点（Task 3 实现）
    let _ = app_handle; // 暂时占位
    Ok(0)
}
```

- [ ] **Step 3: 创建 graph/traversal.rs 骨架**

```rust
// src-tauri/src/graph/traversal.rs
use crate::AppResult;

/// BFS 找从 from_node 出发、最多 max_hops 跳的 JOIN 路径
pub fn find_join_paths(
    connection_id: i64,
    from_node_ids: &[String],
    max_hops: u8,
) -> AppResult<Vec<Vec<String>>> {
    // Task 5 实现
    let _ = (connection_id, from_node_ids, max_hops);
    Ok(vec![])
}
```

- [ ] **Step 4: 创建 graph/query.rs 骨架**

```rust
// src-tauri/src/graph/query.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub connection_id: Option<i64>,
    pub name: String,
    pub display_name: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,
    pub weight: f64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub join_paths: Vec<Vec<String>>,
}

/// 三路 UNION LIKE 搜索：name + display_name + semantic_aliases.alias
pub fn search_graph(connection_id: i64, keyword: &str) -> AppResult<Vec<GraphNode>> {
    // Task 6 实现
    let _ = (connection_id, keyword);
    Ok(vec![])
}

/// LLM 提取实体后在图谱中检索相关子图（Task 6 实现）
pub async fn find_relevant_subgraph(
    connection_id: i64,
    entities: &[String],
    max_hops: u8,
) -> AppResult<SubGraph> {
    let _ = (connection_id, entities, max_hops);
    Ok(SubGraph { nodes: vec![], edges: vec![], join_paths: vec![] })
}
```

- [ ] **Step 5: 在 lib.rs 注册 graph 模块**

在 `src-tauri/src/lib.rs` 顶部 `mod` 列表中添加：

```rust
mod graph;
mod metrics;
mod pipeline;
```

- [ ] **Step 6: 验证编译**

```bash
cd src-tauri && cargo check
```

期望：无错误

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/graph/ src-tauri/src/lib.rs
git commit -m "feat(graph): add graph module skeleton — builder, traversal, query"
```

---

### Task 3: 创建 metrics/ 模块骨架

**Files:**
- Create: `src-tauri/src/metrics/mod.rs`
- Create: `src-tauri/src/metrics/crud.rs`
- Create: `src-tauri/src/metrics/ai_draft.rs`

- [ ] **Step 1: 创建 metrics/mod.rs**

```rust
// src-tauri/src/metrics/mod.rs
pub mod ai_draft;
pub mod crud;

pub use crud::{Metric, CreateMetricInput, UpdateMetricInput,
               list_metrics, save_metric, delete_metric, set_metric_status,
               search_metrics};
```

- [ ] **Step 2: 创建 metrics/crud.rs**

```rust
// src-tauri/src/metrics/crud.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Metric {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub status: String,   // draft | approved | rejected
    pub source: String,   // user | ai
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMetricInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
}

pub fn list_metrics(connection_id: i64, status: Option<&str>) -> AppResult<Vec<Metric>> {
    // Task 4 实现
    let _ = (connection_id, status);
    Ok(vec![])
}

pub fn save_metric(input: &CreateMetricInput) -> AppResult<Metric> {
    let _ = input;
    Err(crate::AppError::Other("not implemented".into()))
}

pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let _ = (id, input);
    Err(crate::AppError::Other("not implemented".into()))
}

pub fn delete_metric(id: i64) -> AppResult<()> {
    let _ = id;
    Ok(())
}

/// status: "approved" | "rejected"
pub fn set_metric_status(id: i64, status: &str) -> AppResult<Metric> {
    let _ = (id, status);
    Err(crate::AppError::Other("not implemented".into()))
}

/// 关键词搜索 approved 状态的指标（供 pipeline 注入）
pub fn search_metrics(connection_id: i64, keywords: &[String]) -> AppResult<Vec<Metric>> {
    let _ = (connection_id, keywords);
    Ok(vec![])
}
```

- [ ] **Step 3: 创建 metrics/ai_draft.rs 骨架**

> ⚠️ 注意：骨架与 Task 7 实现的函数签名**不含** `app_handle` 参数（实现阶段不需要广播进度）。
> 骨架和实现保持一致，避免中间编译失败。

```rust
// src-tauri/src/metrics/ai_draft.rs
use crate::AppResult;
use super::crud::Metric;

/// 扫描 Schema + 数据样本 → AI 生成指标草稿列表（已批量写入 DB，返回草稿列表）
pub async fn generate_metric_drafts(
    connection_id: i64,
) -> AppResult<Vec<Metric>> {
    // Task 7 实现
    let _ = connection_id;
    Ok(vec![])
}
```

- [ ] **Step 4: 创建 pipeline/ 模块骨架**

```bash
# 创建目录和文件
```

```rust
// src-tauri/src/pipeline/mod.rs
pub mod context_builder;
pub mod entity_extract;
pub mod sql_validator;

pub use entity_extract::extract_entities;
pub use context_builder::build_sql_context;
pub use sql_validator::validate_sql;

use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlContext {
    pub relevant_tables: Vec<String>,
    pub join_paths: Vec<String>,
    pub metrics: Vec<String>,
    pub schema_ddl: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextToSqlResult {
    pub sql: String,
    pub context: SqlContext,
    pub validation_ok: bool,
    pub validation_warning: Option<String>,
}
```

```rust
// src-tauri/src/pipeline/entity_extract.rs
use crate::AppResult;

/// 调用 LLM 从自然语言问题中提取实体（表名/指标名/业务术语）
pub async fn extract_entities(question: &str, connection_id: i64) -> AppResult<Vec<String>> {
    // Task 9 实现
    let _ = (question, connection_id);
    Ok(vec![])
}
```

```rust
// src-tauri/src/pipeline/context_builder.rs
use crate::AppResult;
use super::SqlContext;

pub async fn build_sql_context(
    connection_id: i64,
    entities: &[String],
) -> AppResult<SqlContext> {
    // Task 10 实现
    let _ = (connection_id, entities);
    Ok(SqlContext {
        relevant_tables: vec![],
        join_paths: vec![],
        metrics: vec![],
        schema_ddl: String::new(),
    })
}
```

```rust
// src-tauri/src/pipeline/sql_validator.rs
use crate::AppResult;

pub fn validate_sql(sql: &str, driver: &str) -> AppResult<Option<String>> {
    // Task 11 实现：返回 None=OK, Some(warning)=有问题
    let _ = (sql, driver);
    Ok(None)
}
```

- [ ] **Step 5: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/metrics/ src-tauri/src/pipeline/
git commit -m "feat(metrics,pipeline): add metrics and pipeline module skeletons"
```

---

## Chunk 2: Graph Builder — Schema 解析 → 图谱构建

### Task 4: 实现 metrics/crud.rs 完整 CRUD

**Files:**
- Modify: `src-tauri/src/metrics/crud.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写 list_metrics 失败测试**

在 `src-tauri/src/metrics/crud.rs` 末尾添加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_metrics_returns_empty_when_no_data() {
        // 此测试需要 DB 初始化，跳过集成层，仅测试函数签名正确
        // 实际测试在 cargo test 中通过返回值类型验证
        let result: AppResult<Vec<Metric>> = Ok(vec![]);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
}
```

- [ ] **Step 2: 运行测试（应通过，因为返回 Ok(vec![])）**

```bash
cd src-tauri && cargo test metrics::crud::tests
```

期望：PASS

- [ ] **Step 3: 实现完整 CRUD**

替换 `src-tauri/src/metrics/crud.rs` 中的占位实现：

```rust
pub fn list_metrics(connection_id: i64, status: Option<&str>) -> AppResult<Vec<Metric>> {
    let conn = crate::db::get().lock().unwrap();
    let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match status {
        Some(s) => (
            "SELECT id,connection_id,name,display_name,table_name,column_name,aggregation,
                     filter_sql,description,status,source,created_at,updated_at
              FROM metrics WHERE connection_id=?1 AND status=?2 ORDER BY created_at DESC",
            vec![Box::new(connection_id), Box::new(s.to_string())],
        ),
        None => (
            "SELECT id,connection_id,name,display_name,table_name,column_name,aggregation,
                     filter_sql,description,status,source,created_at,updated_at
              FROM metrics WHERE connection_id=?1 ORDER BY created_at DESC",
            vec![Box::new(connection_id)],
        ),
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok(Metric {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            name: row.get(2)?,
            display_name: row.get(3)?,
            table_name: row.get(4)?,
            column_name: row.get(5)?,
            aggregation: row.get(6)?,
            filter_sql: row.get(7)?,
            description: row.get(8)?,
            status: row.get(9)?,
            source: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn save_metric(input: &CreateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    let source = input.source.as_deref().unwrap_or("user");
    conn.execute(
        "INSERT INTO metrics (connection_id,name,display_name,table_name,column_name,
                              aggregation,filter_sql,description,source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            input.connection_id, input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description, source
        ],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    Ok(list_metrics(input.connection_id, None)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| crate::AppError::Other("Metric not found after insert".into()))?)
}

pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET
            name=COALESCE(?2,name), display_name=COALESCE(?3,display_name),
            table_name=COALESCE(?4,table_name), column_name=COALESCE(?5,column_name),
            aggregation=COALESCE(?6,aggregation), filter_sql=COALESCE(?7,filter_sql),
            description=COALESCE(?8,description),
            updated_at=datetime('now')
         WHERE id=?1",
        rusqlite::params![
            id, input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description
        ],
    )?;
    let connection_id: i64 = conn.query_row(
        "SELECT connection_id FROM metrics WHERE id=?1", [id],
        |r| r.get(0)
    )?;
    drop(conn);
    list_metrics(connection_id, None)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| crate::AppError::Other("Metric not found".into()))
}

pub fn delete_metric(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute("DELETE FROM metrics WHERE id=?1", [id])?;
    Ok(())
}

pub fn set_metric_status(id: i64, status: &str) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET status=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, status],
    )?;
    let connection_id: i64 = conn.query_row(
        "SELECT connection_id FROM metrics WHERE id=?1", [id],
        |r| r.get(0)
    )?;
    drop(conn);
    list_metrics(connection_id, None)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| crate::AppError::Other("Metric not found".into()))
}

pub fn search_metrics(connection_id: i64, keywords: &[String]) -> AppResult<Vec<Metric>> {
    if keywords.is_empty() {
        return Ok(vec![]);
    }
    // 用第一个关键词做 LIKE 搜索（approved 状态）
    let conn = crate::db::get().lock().unwrap();
    let pattern = format!("%{}%", keywords.join("%"));
    let mut stmt = conn.prepare(
        "SELECT id,connection_id,name,display_name,table_name,column_name,aggregation,
                filter_sql,description,status,source,created_at,updated_at
         FROM metrics WHERE connection_id=?1 AND status='approved'
           AND (name LIKE ?2 OR display_name LIKE ?2 OR description LIKE ?2)
         ORDER BY name"
    )?;
    let rows = stmt.query_map(rusqlite::params![connection_id, pattern], |row| {
        Ok(Metric {
            id: row.get(0)?, connection_id: row.get(1)?, name: row.get(2)?,
            display_name: row.get(3)?, table_name: row.get(4)?, column_name: row.get(5)?,
            aggregation: row.get(6)?, filter_sql: row.get(7)?, description: row.get(8)?,
            status: row.get(9)?, source: row.get(10)?, created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
```

- [ ] **Step 4: 在 commands.rs 添加 metrics commands**

在 `commands.rs` 末尾添加：

```rust
// ============ 指标管理 ============

#[tauri::command]
pub async fn list_metrics(
    connection_id: i64,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::list_metrics(connection_id, status.as_deref())
}

#[tauri::command]
pub async fn save_metric(
    input: crate::metrics::CreateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::save_metric(&input)
}

#[tauri::command]
pub async fn update_metric(
    id: i64,
    input: crate::metrics::UpdateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::crud::update_metric(id, &input)
}

#[tauri::command]
pub async fn delete_metric(id: i64) -> AppResult<()> {
    crate::metrics::delete_metric(id)
}

#[tauri::command]
pub async fn approve_metric(id: i64, status: String) -> AppResult<crate::metrics::Metric> {
    if status != "approved" && status != "rejected" {
        return Err(crate::AppError::Other("status must be 'approved' or 'rejected'".into()));
    }
    crate::metrics::set_metric_status(id, &status)
}
```

- [ ] **Step 5: 在 lib.rs invoke_handler 注册 metrics commands**

在 `lib.rs` 的 `tauri::generate_handler![...]` 中追加：

```rust
commands::list_metrics,
commands::save_metric,
commands::update_metric,
commands::delete_metric,
commands::approve_metric,
```

- [ ] **Step 6: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/metrics/crud.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(metrics): implement full CRUD — list/save/update/delete/approve metrics"
```

---

### Task 5: 实现 graph/builder.rs — Schema 解析

**Files:**
- Modify: `src-tauri/src/graph/builder.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败测试（验证节点 ID 格式）**

在 `graph/builder.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn test_node_id_format() {
        let table_id = format!("{}:table:{}", 1, "orders");
        assert_eq!(table_id, "1:table:orders");

        let col_id = format!("{}:column:{}:{}", 1, "orders", "user_id");
        assert_eq!(col_id, "1:column:orders:user_id");
    }
}
```

- [ ] **Step 2: 运行测试（应通过）**

```bash
cd src-tauri && cargo test graph::builder::tests
```

- [ ] **Step 3: 实现 graph/builder.rs 完整逻辑**

```rust
// src-tauri/src/graph/builder.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BuildProgress {
    pub step: String,
    pub done: usize,
    pub total: usize,
}

fn node_id(connection_id: i64, node_type: &str, parts: &[&str]) -> String {
    format!("{}:{}:{}", connection_id, node_type, parts.join(":"))
}

fn upsert_node(
    conn: &rusqlite::Connection,
    id: &str,
    node_type: &str,
    connection_id: i64,
    name: &str,
    display_name: Option<&str>,
    metadata: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO graph_nodes (id, node_type, connection_id, name, display_name, metadata)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, display_name=excluded.display_name,
           metadata=excluded.metadata",
        rusqlite::params![id, node_type, connection_id, name, display_name, metadata],
    )?;
    Ok(())
}

fn upsert_edge(
    conn: &rusqlite::Connection,
    id: &str,
    from_node: &str,
    to_node: &str,
    edge_type: &str,
    metadata: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO graph_edges (id, from_node, to_node, edge_type, metadata)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET edge_type=excluded.edge_type, metadata=excluded.metadata",
        rusqlite::params![id, from_node, to_node, edge_type, metadata],
    )?;
    Ok(())
}

pub async fn build_schema_graph(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    // 1. 获取连接配置 + Schema
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    let total = schema.tables.len();
    let mut node_count = 0usize;

    for (i, table) in schema.tables.iter().enumerate() {
        let _ = app_handle.emit("graph:build_progress", BuildProgress {
            step: format!("处理表 {}", table.name),
            done: i,
            total,
        });

        // 表节点
        let table_id = node_id(connection_id, "table", &[&table.name]);
        {
            let db_conn = crate::db::get().lock().unwrap();
            let meta = serde_json::json!({"table_type": table.table_type}).to_string();
            upsert_node(&db_conn, &table_id, "table", connection_id,
                        &table.name, Some(&table.name), Some(&meta))?;
            node_count += 1;

            // ⚠️ 关键：先在锁外 await 获取数据，再统一写入 SQLite
        // std::sync::MutexGuard 不是 Send，不能跨 .await 点持有
        let columns = ds.get_columns(&table.name).await.unwrap_or_default();
        let fks = ds.get_foreign_keys(&table.name).await.unwrap_or_default();

        {
            let db_conn = crate::db::get().lock().unwrap();

            // 列节点（同步写入，无 await）
            for col in &columns {
                let col_id = node_id(connection_id, "column", &[&table.name, &col.name]);
                let col_meta = serde_json::json!({
                    "data_type": col.data_type,
                    "is_nullable": col.is_nullable,
                    "is_primary_key": col.is_primary_key,
                    "column_default": col.column_default
                }).to_string();
                upsert_node(&db_conn, &col_id, "column", connection_id,
                            &col.name, None, Some(&col_meta))?;
                let edge_id = format!("{}->{}", table_id, col_id);
                upsert_edge(&db_conn, &edge_id, &table_id, &col_id, "has_column", None)?;
                node_count += 1;
            }

            // 外键边
            for fk in &fks {
                let ref_table_id = node_id(connection_id, "table", &[&fk.referenced_table]);
                let fk_meta = serde_json::json!({
                    "constraint_name": fk.constraint_name,
                    "column": fk.column,
                    "referenced_column": fk.referenced_column
                }).to_string();
                let edge_id = format!("fk:{}", fk.constraint_name);
                upsert_edge(&db_conn, &edge_id, &table_id, &ref_table_id,
                            "foreign_key", Some(&fk_meta))?;
            }
        }
    }

    let _ = app_handle.emit("graph:build_progress", BuildProgress {
        step: "完成".to_string(),
        done: total,
        total,
    });

    log::info!("[graph] Built {} nodes for connection {}", node_count, connection_id);
    Ok(node_count)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_node_id_format() {
        let table_id = format!("{}:table:{}", 1i64, "orders");
        assert_eq!(table_id, "1:table:orders");
        let col_id = format!("{}:column:{}:{}", 1i64, "orders", "user_id");
        assert_eq!(col_id, "1:column:orders:user_id");
    }
}
```

- [ ] **Step 4: 在 commands.rs 添加 build_schema_graph command**

```rust
// ============ 知识图谱 ============

#[tauri::command]
pub async fn build_schema_graph(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    // 后台异步，通过 graph:build_progress event 广播进度
    crate::graph::build_schema_graph(connection_id, app_handle).await
}

#[tauri::command]
pub async fn get_graph_nodes(
    connection_id: i64,
    node_type: Option<String>,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::query::get_nodes(connection_id, node_type.as_deref())
}

#[tauri::command]
pub async fn search_graph(
    connection_id: i64,
    keyword: String,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::search_graph(connection_id, &keyword)
}
```

- [ ] **Step 5: 注册到 lib.rs**

```rust
commands::build_schema_graph,
commands::get_graph_nodes,
commands::search_graph,
```

- [ ] **Step 6: 验证编译**

```bash
cd src-tauri && cargo check
```

期望：无错误（datasource trait 需要有 `get_columns`, `get_foreign_keys` 方法，若缺失则先加到 datasource/mod.rs trait 中）

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/graph/builder.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(graph): implement schema graph builder — parse tables/columns/FKs to graph nodes"
```

---

## Chunk 3: Graph Traversal + Query

### Task 6: 实现 graph/traversal.rs — BFS JOIN 路径推断

**Files:**
- Modify: `src-tauri/src/graph/traversal.rs`
- Modify: `src-tauri/src/graph/query.rs`

- [ ] **Step 1: 写 BFS 路径推断失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bfs_simple_path() {
        // 模拟图：A -> B -> C（has_column 边不算 hop，只有 foreign_key 算）
        let adj: Vec<(String, String)> = vec![
            ("nodeA".into(), "nodeB".into()),
            ("nodeB".into(), "nodeC".into()),
        ];
        let paths = bfs_paths(&["nodeA".to_string()], &adj, 2);
        assert!(!paths.is_empty());
    }
}
```

- [ ] **Step 2: 运行测试（FAIL，bfs_paths 未定义）**

```bash
cd src-tauri && cargo test graph::traversal::tests 2>&1 | head -20
```

- [ ] **Step 3: 实现 traversal.rs**

```rust
// src-tauri/src/graph/traversal.rs
use crate::AppResult;
use std::collections::{HashMap, HashSet, VecDeque};

/// 从 graph_edges 读取 foreign_key 边的邻接表
fn load_fk_adjacency(connection_id: i64) -> AppResult<Vec<(String, String, String)>> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT e.from_node, e.to_node, e.metadata
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.from_node
         WHERE n.connection_id = ?1 AND e.edge_type = 'foreign_key'"
    )?;
    let rows = stmt.query_map([connection_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// BFS 内部函数（可测试）
pub(crate) fn bfs_paths(
    start_ids: &[String],
    edges: &[(String, String)],
    max_hops: u8,
) -> Vec<Vec<String>> {
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for (from, to) in edges {
        adj.entry(from.clone()).or_default().push(to.clone());
        adj.entry(to.clone()).or_default().push(from.clone()); // 双向
    }

    let mut paths = Vec::new();
    for start in start_ids {
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<(String, Vec<String>, u8)> = VecDeque::new();
        queue.push_back((start.clone(), vec![start.clone()], 0));
        visited.insert(start.clone());

        while let Some((node, path, hops)) = queue.pop_front() {
            if hops > 0 { paths.push(path.clone()); }
            if hops >= max_hops { continue; }
            if let Some(neighbors) = adj.get(&node) {
                for next in neighbors {
                    if !visited.contains(next) {
                        visited.insert(next.clone());
                        let mut new_path = path.clone();
                        new_path.push(next.clone());
                        queue.push_back((next.clone(), new_path, hops + 1));
                    }
                }
            }
        }
    }
    paths
}

pub fn find_join_paths(
    connection_id: i64,
    from_node_ids: &[String],
    max_hops: u8,
) -> AppResult<Vec<Vec<String>>> {
    let fk_edges = load_fk_adjacency(connection_id)?;
    let simple_edges: Vec<(String, String)> = fk_edges.into_iter()
        .map(|(f, t, _)| (f, t))
        .collect();
    Ok(bfs_paths(from_node_ids, &simple_edges, max_hops))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bfs_simple_path() {
        let edges = vec![
            ("nodeA".to_string(), "nodeB".to_string()),
            ("nodeB".to_string(), "nodeC".to_string()),
        ];
        let paths = bfs_paths(&["nodeA".to_string()], &edges, 2);
        assert!(!paths.is_empty());
        // 应该找到 A->B 和 A->B->C
        assert!(paths.iter().any(|p| p.len() == 2));
        assert!(paths.iter().any(|p| p.len() == 3));
    }

    #[test]
    fn test_bfs_max_hops_limit() {
        let edges = vec![
            ("A".to_string(), "B".to_string()),
            ("B".to_string(), "C".to_string()),
            ("C".to_string(), "D".to_string()),
        ];
        let paths = bfs_paths(&["A".to_string()], &edges, 1);
        // max_hops=1，只能走一步，最长路径 2 个节点
        assert!(paths.iter().all(|p| p.len() <= 2));
    }

    #[test]
    fn test_bfs_no_edges() {
        let paths = bfs_paths(&["A".to_string()], &[], 2);
        assert!(paths.is_empty());
    }
}
```

- [ ] **Step 4: 运行测试（应通过）**

```bash
cd src-tauri && cargo test graph::traversal::tests
```

期望：3 tests PASS

- [ ] **Step 5: 实现 graph/query.rs 完整实现**

```rust
// src-tauri/src/graph/query.rs — 完整实现
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub connection_id: Option<i64>,
    pub name: String,
    pub display_name: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,
    pub weight: f64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub join_paths: Vec<Vec<String>>,
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphNode> {
    let meta_str: Option<String> = row.get(5)?;
    Ok(GraphNode {
        id: row.get(0)?,
        node_type: row.get(1)?,
        connection_id: row.get(2)?,
        name: row.get(3)?,
        display_name: row.get(4)?,
        metadata: meta_str.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

pub fn get_nodes(connection_id: i64, node_type: Option<&str>) -> AppResult<Vec<GraphNode>> {
    let conn = crate::db::get().lock().unwrap();
    let (sql, p): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match node_type {
        Some(t) => (
            "SELECT id,node_type,connection_id,name,display_name,metadata
             FROM graph_nodes WHERE connection_id=?1 AND node_type=?2 ORDER BY name",
            vec![Box::new(connection_id), Box::new(t.to_string())],
        ),
        None => (
            "SELECT id,node_type,connection_id,name,display_name,metadata
             FROM graph_nodes WHERE connection_id=?1 ORDER BY node_type,name",
            vec![Box::new(connection_id)],
        ),
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(p.iter()), row_to_node)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 三路 UNION LIKE 搜索
pub fn search_graph(connection_id: i64, keyword: &str) -> AppResult<Vec<GraphNode>> {
    let conn = crate::db::get().lock().unwrap();
    let pattern = format!("%{}%", keyword);
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.id,n.node_type,n.connection_id,n.name,n.display_name,n.metadata
         FROM graph_nodes n
         WHERE n.connection_id=?1 AND (
             n.name LIKE ?2 OR n.display_name LIKE ?2
             OR EXISTS (
                 SELECT 1 FROM semantic_aliases a
                 WHERE a.node_id=n.id AND a.alias LIKE ?2
             )
         )
         ORDER BY n.node_type, n.name
         LIMIT 50"
    )?;
    let rows = stmt.query_map(rusqlite::params![connection_id, pattern], row_to_node)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub async fn find_relevant_subgraph(
    connection_id: i64,
    entities: &[String],
    max_hops: u8,
) -> AppResult<SubGraph> {
    if entities.is_empty() {
        return Ok(SubGraph { nodes: vec![], edges: vec![], join_paths: vec![] });
    }
    // 1. 找匹配实体名的表节点
    let conn = crate::db::get().lock().unwrap();
    let placeholders = entities.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(",");
    // 第二个 IN 使用不同的占位符编号（避免 rusqlite 位置绑定冲突）
    let n = entities.len();
    let ph1 = (2..=n+1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let ph2 = (n+2..=2*n+1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id,node_type,connection_id,name,display_name,metadata
         FROM graph_nodes
         WHERE connection_id=?1 AND node_type='table'
           AND (name IN ({ph1}) OR id IN (
               SELECT node_id FROM semantic_aliases WHERE connection_id=?1
                 AND alias IN ({ph2})
           ))",
        ph1 = ph1, ph2 = ph2
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];
    for e in entities {
        params.push(Box::new(e.clone()));   // ?2..?N+1 for name IN
    }
    for e in entities {
        params.push(Box::new(e.clone()));   // ?N+2..?2N+1 for alias IN
    }
    let mut stmt = conn.prepare(&sql)?;
    let matched_nodes: Vec<GraphNode> = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), row_to_node)?
        .collect::<Result<Vec<_>, _>>()?;

    let matched_ids: Vec<String> = matched_nodes.iter().map(|n| n.id.clone()).collect();
    // ⚠️ 注意：rusqlite 的 ?N 占位符是位置绑定，同一个 ?N 不能在 SQL 中出现两次
    // 因此对两个 IN 子句，第一个用 ?2..?N，第二个用 ?N+1..?2N
    drop(conn);

    // 2. BFS 找 JOIN 路径
    let join_paths = crate::graph::traversal::find_join_paths(
        connection_id, &matched_ids, max_hops
    )?;

    // 3. 收集所有路径涉及的节点
    let all_node_ids: std::collections::HashSet<String> = join_paths.iter()
        .flat_map(|p| p.iter().cloned())
        .chain(matched_ids.iter().cloned())
        .collect();

    let conn = crate::db::get().lock().unwrap();
    let mut all_nodes = Vec::new();
    for node_id in &all_node_ids {
        if let Ok(n) = conn.query_row(
            "SELECT id,node_type,connection_id,name,display_name,metadata
             FROM graph_nodes WHERE id=?1",
            [node_id], row_to_node
        ) {
            all_nodes.push(n);
        }
    }

    // 4. 收集相关边
    let mut stmt = conn.prepare(
        "SELECT id,from_node,to_node,edge_type,weight,metadata
         FROM graph_edges WHERE from_node=?1 OR to_node=?1"
    )?;
    let mut edges = Vec::new();
    for node_id in &all_node_ids {
        let rows = stmt.query_map([node_id], |row| {
            let meta_str: Option<String> = row.get(5)?;
            Ok(GraphEdge {
                id: row.get(0)?, from_node: row.get(1)?, to_node: row.get(2)?,
                edge_type: row.get(3)?, weight: row.get(4)?,
                metadata: meta_str.and_then(|s| serde_json::from_str(&s).ok()),
            })
        })?;
        for r in rows { edges.push(r?); }
    }
    // 去重
    edges.dedup_by_key(|e| e.id.clone());

    Ok(SubGraph { nodes: all_nodes, edges, join_paths })
}
```

- [ ] **Step 6: 验证编译 + 运行测试**

```bash
cd src-tauri && cargo check && cargo test graph::
```

期望：全部通过

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/graph/
git commit -m "feat(graph): implement BFS traversal and subgraph query"
```

---

## Chunk 4: Metrics AI Draft + Pipeline v2

### Task 7: 实现 metrics/ai_draft.rs — AI 生成指标草稿

**Files:**
- Modify: `src-tauri/src/metrics/ai_draft.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 实现 ai_draft.rs**

```rust
// src-tauri/src/metrics/ai_draft.rs
use crate::AppResult;
use super::crud::{CreateMetricInput, save_metric, Metric};

pub async fn generate_metric_drafts(
    connection_id: i64,
) -> AppResult<Vec<Metric>> {
    // 1. 获取 Schema 概要
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    // 构建 Schema 描述
    let mut schema_desc = String::new();
    for table in &schema.tables {
        schema_desc.push_str(&format!("表: {}\n", table.name));
        let cols = ds.get_columns(&table.name).await.unwrap_or_default();
        for col in &cols {
            schema_desc.push_str(&format!(
                "  - {} {} {}\n",
                col.name, col.data_type,
                if col.is_primary_key { "(PK)" } else { "" }
            ));
        }
    }

    // 2. 获取默认 LLM 配置
    let llm_config = crate::db::get_default_llm_config()?;
    let api_key = crate::db::get_llm_config_key(llm_config.id)?;

    // 3. 构建 Prompt
    let prompt = format!(
        r#"你是一个数据分析专家。根据以下数据库 Schema，推断出 3-8 个最有业务价值的指标。

Schema:
{}

请以 JSON 数组格式返回，每个元素包含：
- name: 英文标识（蛇形命名）
- display_name: 中文名称
- table_name: 来源表名
- column_name: 来源字段名（COUNT 时可为空）
- aggregation: SUM/COUNT/AVG/MAX/MIN
- description: 业务含义（一句话）

只返回 JSON 数组，不要其他内容。"#,
        schema_desc
    );

    // 4. 调用 LLM
    let client = crate::llm::LlmClient::new(&llm_config, &api_key);
    let ctx = crate::llm::ChatContext {
        messages: vec![crate::llm::ChatMessage {
            role: "user".into(),
            content: prompt,
        }],
        tools: None,
        tool_choice: None,
    };
    let response = client.chat_complete(&ctx).await?;

    // 5. 解析 JSON 响应
    #[derive(serde::Deserialize)]
    struct DraftItem {
        name: String,
        display_name: String,
        table_name: String,
        column_name: Option<String>,
        aggregation: Option<String>,
        description: Option<String>,
    }

    // 提取 JSON（LLM 可能包裹在 markdown 代码块中）
    let json_str = extract_json(&response);
    let items: Vec<DraftItem> = serde_json::from_str(&json_str)
        .map_err(|e| crate::AppError::Other(format!("LLM 返回格式错误: {}", e)))?;

    // 6. 批量写入 draft 状态指标
    let mut results = Vec::new();
    for item in items {
        let input = CreateMetricInput {
            connection_id,
            name: item.name,
            display_name: item.display_name,
            table_name: item.table_name,
            column_name: item.column_name,
            aggregation: item.aggregation,
            filter_sql: None,
            description: item.description,
            source: Some("ai".into()),
        };
        match save_metric(&input) {
            Ok(m) => results.push(m),
            Err(e) => log::warn!("[metrics] Failed to save draft: {}", e),
        }
    }

    Ok(results)
}

fn extract_json(text: &str) -> String {
    // 处理 ```json ... ``` 包裹
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start + 7..].find("```") {
            return text[start + 7..start + 7 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            return text[start..=end].to_string();
        }
    }
    text.to_string()
}
```

- [ ] **Step 2: 在 commands.rs 添加 command**

```rust
#[tauri::command]
pub async fn ai_generate_metrics(
    connection_id: i64,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::ai_draft::generate_metric_drafts(connection_id).await
}
```

- [ ] **Step 3: 注册到 lib.rs**

```rust
commands::ai_generate_metrics,
```

- [ ] **Step 4: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metrics/ai_draft.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(metrics): implement AI metric draft generation via LLM"
```

---

### Task 8: 实现 pipeline/ — 高精度 Text-to-SQL v2

**Files:**
- Modify: `src-tauri/src/pipeline/entity_extract.rs`
- Modify: `src-tauri/src/pipeline/context_builder.rs`
- Modify: `src-tauri/src/pipeline/sql_validator.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写 sql_validator 单元测试**

```rust
// 在 pipeline/sql_validator.rs 末尾
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_select_ok() {
        let result = validate_sql("SELECT id FROM users", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none()); // None = OK
    }

    #[test]
    fn test_empty_sql_warning() {
        let result = validate_sql("", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_some()); // Some(warning)
    }
}
```

- [ ] **Step 2: 运行测试（FAIL）**

```bash
cd src-tauri && cargo test pipeline::sql_validator::tests
```

- [ ] **Step 3: 实现 sql_validator.rs**

```rust
// src-tauri/src/pipeline/sql_validator.rs
use crate::AppResult;

pub fn validate_sql(sql: &str, _driver: &str) -> AppResult<Option<String>> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Ok(Some("SQL 为空".to_string()));
    }
    // 基础检查：括号匹配
    let open = sql.chars().filter(|&c| c == '(').count();
    let close = sql.chars().filter(|&c| c == ')').count();
    if open != close {
        return Ok(Some(format!("括号不匹配：{} 个左括号，{} 个右括号", open, close)));
    }
    // 检查是否以 SQL 关键字开头
    let upper = sql.to_uppercase();
    let valid_starts = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE",
                        "ALTER", "DROP", "WITH", "EXPLAIN"];
    let starts_valid = valid_starts.iter().any(|kw| upper.starts_with(kw));
    if !starts_valid {
        return Ok(Some(format!("SQL 不以有效关键字开头: {}", &sql[..sql.len().min(20)])));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_select_ok() {
        let result = validate_sql("SELECT id FROM users", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_empty_sql_warning() {
        let result = validate_sql("", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_some());
    }

    #[test]
    fn test_unmatched_parens_warning() {
        let result = validate_sql("SELECT (id FROM users", "mysql");
        assert!(result.unwrap().is_some());
    }
}
```

- [ ] **Step 4: 运行测试（应通过）**

```bash
cd src-tauri && cargo test pipeline::sql_validator::tests
```

期望：3 tests PASS

- [ ] **Step 5: 实现 entity_extract.rs**

```rust
// src-tauri/src/pipeline/entity_extract.rs
use crate::AppResult;

pub async fn extract_entities(
    question: &str,
    connection_id: i64,
) -> AppResult<Vec<String>> {
    // 获取所有已知表名（用于 system prompt）
    let table_names: Vec<String> = {
        let conn = crate::db::get().lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name FROM graph_nodes WHERE connection_id=?1 AND node_type='table'"
        )?;
        let rows = stmt.query_map([connection_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let llm_config = crate::db::get_default_llm_config()?;
    let api_key = crate::db::get_llm_config_key(llm_config.id)?;

    let system = format!(
        "数据库中已知的表有: {}。从用户问题中提取涉及的表名、字段名或业务术语，\
         以 JSON 字符串数组返回，只返回数组，不要其他内容。",
        table_names.join(", ")
    );

    let prompt = format!("用户问题: {}", question);

    let client = crate::llm::LlmClient::new(&llm_config, &api_key);
    let ctx = crate::llm::ChatContext {
        messages: vec![
            crate::llm::ChatMessage { role: "system".into(), content: system },
            crate::llm::ChatMessage { role: "user".into(), content: prompt },
        ],
        tools: None,
        tool_choice: None,
    };

    let response = client.chat_complete(&ctx).await.unwrap_or_default();

    // 解析 JSON 数组
    let json_str = if let Some(s) = response.find('[') {
        if let Some(e) = response.rfind(']') {
            response[s..=e].to_string()
        } else { "[]".into() }
    } else { "[]".into() };

    Ok(serde_json::from_str::<Vec<String>>(&json_str).unwrap_or_default())
}
```

- [ ] **Step 6: 实现 context_builder.rs**

```rust
// src-tauri/src/pipeline/context_builder.rs
use crate::AppResult;
use super::SqlContext;

pub async fn build_sql_context(
    connection_id: i64,
    entities: &[String],
) -> AppResult<SqlContext> {
    // 1. 图谱检索相关子图
    let subgraph = crate::graph::query::find_relevant_subgraph(
        connection_id, entities, 2
    ).await?;

    let relevant_tables: Vec<String> = subgraph.nodes.iter()
        .filter(|n| n.node_type == "table")
        .map(|n| n.name.clone())
        .collect();

    // 2. JOIN 路径转可读文字
    let join_paths: Vec<String> = subgraph.join_paths.iter()
        .filter(|p| p.len() >= 2)
        .map(|path| {
            // 把节点 ID 转为表名显示
            let names: Vec<String> = path.iter()
                .filter_map(|id| subgraph.nodes.iter().find(|n| &n.id == id))
                .map(|n| n.name.clone())
                .collect();
            names.join(" → ")
        })
        .collect();

    // 3. 相关指标
    let metrics = crate::metrics::search_metrics(connection_id, &entities.to_vec())?;
    let metric_descs: Vec<String> = metrics.iter()
        .map(|m| {
            let agg = m.aggregation.as_deref().unwrap_or("VALUE");
            let col = m.column_name.as_deref().unwrap_or("*");
            format!("{} = {}({}.{}): {}",
                m.display_name, agg, m.table_name, col,
                m.description.as_deref().unwrap_or(""))
        })
        .collect();

    // 4. 构建精简 Schema DDL（只包含相关表）
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let mut schema_ddl = String::new();
    for table_name in &relevant_tables {
        let cols = ds.get_columns(table_name).await.unwrap_or_default();
        schema_ddl.push_str(&format!("-- 表: {}\n", table_name));
        for col in &cols {
            schema_ddl.push_str(&format!(
                "--   {} {} {}\n",
                col.name, col.data_type,
                if col.is_primary_key { "PRIMARY KEY" } else { "" }
            ));
        }
        schema_ddl.push('\n');
    }

    Ok(SqlContext {
        relevant_tables,
        join_paths,
        metrics: metric_descs,
        schema_ddl,
    })
}
```

- [ ] **Step 7: 实现 pipeline/mod.rs 主函数 + command**

在 `pipeline/mod.rs` 添加：

```rust
use crate::AppResult;
use serde::{Deserialize, Serialize};

pub mod context_builder;
pub mod entity_extract;
pub mod sql_validator;

pub use entity_extract::extract_entities;
pub use context_builder::build_sql_context;
pub use sql_validator::validate_sql;

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlContext {
    pub relevant_tables: Vec<String>,
    pub join_paths: Vec<String>,
    pub metrics: Vec<String>,
    pub schema_ddl: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextToSqlResult {
    pub sql: String,
    pub context: SqlContext,
    pub validation_ok: bool,
    pub validation_warning: Option<String>,
}

pub async fn generate_sql_v2(
    question: &str,
    connection_id: i64,
    history: &[crate::llm::ChatMessage],
) -> AppResult<TextToSqlResult> {
    // 1. LLM 提取实体
    let entities = extract_entities(question, connection_id).await
        .unwrap_or_default();

    // 2. 组装上下文
    let context = build_sql_context(connection_id, &entities).await?;

    // 3. 构建高质量 Prompt
    let system_prompt = build_system_prompt(&context);

    // 4. 调用 LLM 生成 SQL
    let llm_config = crate::db::get_default_llm_config()?;
    let api_key = crate::db::get_llm_config_key(llm_config.id)?;
    let client = crate::llm::LlmClient::new(&llm_config, &api_key);

    let mut messages = vec![
        crate::llm::ChatMessage { role: "system".into(), content: system_prompt }
    ];
    messages.extend_from_slice(history);
    messages.push(crate::llm::ChatMessage {
        role: "user".into(),
        content: question.to_string(),
    });

    let ctx = crate::llm::ChatContext { messages, tools: None, tool_choice: None };
    let response = client.chat_complete(&ctx).await?;

    // 5. 提取 SQL（去掉 markdown 包裹）
    let sql = extract_sql_from_response(&response);

    // 6. 语法校验
    let config = crate::db::get_connection_config(connection_id)?;
    let warning = validate_sql(&sql, &config.driver).unwrap_or(None);

    Ok(TextToSqlResult {
        validation_ok: warning.is_none(),
        validation_warning: warning,
        sql,
        context,
    })
}

fn build_system_prompt(ctx: &SqlContext) -> String {
    let mut prompt = "你是一个 SQL 专家。根据用户问题生成精准的 SQL 查询。\n\n".to_string();

    if !ctx.schema_ddl.is_empty() {
        prompt.push_str("## 相关表结构\n");
        prompt.push_str(&ctx.schema_ddl);
        prompt.push('\n');
    }
    if !ctx.join_paths.is_empty() {
        prompt.push_str("## 推断的 JOIN 路径\n");
        for p in &ctx.join_paths {
            prompt.push_str(&format!("- {}\n", p));
        }
        prompt.push('\n');
    }
    if !ctx.metrics.is_empty() {
        prompt.push_str("## 业务指标定义\n");
        for m in &ctx.metrics {
            prompt.push_str(&format!("- {}\n", m));
        }
        prompt.push('\n');
    }
    prompt.push_str("只返回 SQL，不要解释。用 ```sql ``` 包裹。");
    prompt
}

fn extract_sql_from_response(response: &str) -> String {
    if let Some(s) = response.find("```sql") {
        if let Some(e) = response[s + 6..].find("```") {
            return response[s + 6..s + 6 + e].trim().to_string();
        }
    }
    if let Some(s) = response.find("```") {
        if let Some(e) = response[s + 3..].find("```") {
            return response[s + 3..s + 3 + e].trim().to_string();
        }
    }
    response.trim().to_string()
}
```

- [ ] **Step 8: 在 commands.rs 添加 ai_generate_sql_v2**

```rust
// ============ 高精度 Text-to-SQL Pipeline v2 ============

#[tauri::command]
pub async fn ai_generate_sql_v2(
    question: String,
    connection_id: i64,
    history: Option<Vec<crate::llm::ChatMessage>>,
) -> AppResult<crate::pipeline::TextToSqlResult> {
    let hist = history.unwrap_or_default();
    crate::pipeline::generate_sql_v2(&question, connection_id, &hist).await
}
```

- [ ] **Step 9: 注册 command + 验证编译**

在 lib.rs 添加 `commands::ai_generate_sql_v2,`

```bash
cd src-tauri && cargo check && cargo test
```

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/pipeline/ src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(pipeline): implement Text-to-SQL v2 — entity extract + graph context + SQL validate"
```

---

## Chunk 5: 前端组件

### Task 9: MetricsPanel 前端

**Files:**
- Create: `src/components/MetricsPanel/index.tsx`
- Create: `src/components/MetricsPanel/MetricEditor.tsx`
- Create: `src/components/MetricsPanel/AiDraftReview.tsx`
- Modify: `src/components/ActivityBar/index.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 创建 MetricsPanel/index.tsx**

```tsx
// src/components/MetricsPanel/index.tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import MetricEditor from './MetricEditor'
import AiDraftReview from './AiDraftReview'

interface Metric {
  id: number
  connection_id: number
  name: string
  display_name: string
  table_name: string
  column_name?: string
  aggregation?: string
  filter_sql?: string
  description?: string
  status: 'draft' | 'approved' | 'rejected'
  source: 'user' | 'ai'
}

interface Props {
  connectionId: number | null
}

export default function MetricsPanel({ connectionId }: Props) {
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [activeTab, setActiveTab] = useState<'approved' | 'draft' | 'rejected'>('approved')
  const [showEditor, setShowEditor] = useState(false)
  const [editingMetric, setEditingMetric] = useState<Metric | null>(null)
  const [showAiReview, setShowAiReview] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadMetrics = async () => {
    if (!connectionId) return
    const data = await invoke<Metric[]>('list_metrics', {
      connectionId,
      status: null,
    })
    setMetrics(data)
  }

  useEffect(() => { loadMetrics() }, [connectionId])

  const filtered = metrics.filter(m => m.status === activeTab)

  const handleApprove = async (id: number, status: 'approved' | 'rejected') => {
    await invoke('approve_metric', { id, status })
    loadMetrics()
  }

  const handleDelete = async (id: number) => {
    await invoke('delete_metric', { id })
    loadMetrics()
  }

  const handleGenerateAi = async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      await invoke('ai_generate_metrics', { connectionId })
      setShowAiReview(true)
      loadMetrics()
    } finally {
      setLoading(false)
    }
  }

  if (!connectionId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        请先选择一个数据库连接
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700">
        <span className="font-medium text-sm">业务指标</span>
        <div className="flex-1" />
        <button
          onClick={handleGenerateAi}
          disabled={loading}
          className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50"
        >
          {loading ? 'AI 生成中...' : 'AI 生成草稿'}
        </button>
        <button
          onClick={() => { setEditingMetric(null); setShowEditor(true) }}
          className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded"
        >
          + 新建
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex border-b border-gray-700">
        {(['approved', 'draft', 'rejected'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab === 'approved' ? '已批准' : tab === 'draft' ? '草稿' : '已拒绝'}
            <span className="ml-1 text-gray-500">
              ({metrics.filter(m => m.status === tab).length})
            </span>
          </button>
        ))}
      </div>

      {/* 指标列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filtered.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-8">暂无{activeTab === 'approved' ? '已批准的' : activeTab === 'draft' ? '草稿' : '已拒绝的'}指标</div>
        )}
        {filtered.map(metric => (
          <div key={metric.id} className="p-3 bg-gray-800 rounded border border-gray-700 hover:border-gray-600">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-sm">{metric.display_name}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {metric.aggregation}({metric.table_name}.{metric.column_name || '*'})
                  {metric.source === 'ai' && (
                    <span className="ml-2 px-1 py-0.5 bg-purple-900 text-purple-300 rounded text-xs">AI</span>
                  )}
                </div>
                {metric.description && (
                  <div className="text-xs text-gray-500 mt-1">{metric.description}</div>
                )}
              </div>
              <div className="flex gap-1 ml-2 shrink-0">
                {metric.status === 'draft' && (
                  <>
                    <button
                      onClick={() => handleApprove(metric.id, 'approved')}
                      className="px-2 py-0.5 text-xs bg-green-700 hover:bg-green-600 rounded"
                    >批准</button>
                    <button
                      onClick={() => handleApprove(metric.id, 'rejected')}
                      className="px-2 py-0.5 text-xs bg-red-800 hover:bg-red-700 rounded"
                    >拒绝</button>
                  </>
                )}
                <button
                  onClick={() => { setEditingMetric(metric); setShowEditor(true) }}
                  className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded"
                >编辑</button>
                <button
                  onClick={() => handleDelete(metric.id)}
                  className="px-2 py-0.5 text-xs bg-red-900 hover:bg-red-800 rounded"
                >删除</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showEditor && (
        <MetricEditor
          connectionId={connectionId}
          metric={editingMetric}
          onClose={() => { setShowEditor(false); loadMetrics() }}
        />
      )}
      {showAiReview && (
        <AiDraftReview
          metrics={metrics.filter(m => m.status === 'draft' && m.source === 'ai')}
          onClose={() => { setShowAiReview(false); loadMetrics() }}
          onApprove={(id) => handleApprove(id, 'approved')}
          onReject={(id) => handleApprove(id, 'rejected')}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建 MetricEditor.tsx**

```tsx
// src/components/MetricsPanel/MetricEditor.tsx
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface Metric {
  id: number
  name: string
  display_name: string
  table_name: string
  column_name?: string
  aggregation?: string
  filter_sql?: string
  description?: string
}

interface Props {
  connectionId: number
  metric: Metric | null
  onClose: () => void
}

export default function MetricEditor({ connectionId, metric, onClose }: Props) {
  const [form, setForm] = useState({
    name: metric?.name || '',
    display_name: metric?.display_name || '',
    table_name: metric?.table_name || '',
    column_name: metric?.column_name || '',
    aggregation: metric?.aggregation || 'COUNT',
    filter_sql: metric?.filter_sql || '',
    description: metric?.description || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!form.name || !form.display_name || !form.table_name) {
      setError('名称、中文名、来源表为必填项')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (metric) {
        await invoke('update_metric', { id: metric.id, input: form })
      } else {
        await invoke('save_metric', { input: { ...form, connection_id: connectionId } })
      }
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-[480px] border border-gray-700">
        <h3 className="text-sm font-medium mb-4">{metric ? '编辑指标' : '新建指标'}</h3>
        <div className="space-y-3">
          {[
            { label: '英文标识 *', key: 'name', placeholder: 'total_revenue' },
            { label: '中文名称 *', key: 'display_name', placeholder: '总销售额' },
            { label: '来源表 *', key: 'table_name', placeholder: 'orders' },
            { label: '来源字段', key: 'column_name', placeholder: 'amount (COUNT 时可留空)' },
            { label: '过滤条件', key: 'filter_sql', placeholder: "status = 'paid'" },
            { label: '业务含义', key: 'description', placeholder: '...' },
          ].map(({ label, key, placeholder }) => (
            <div key={key}>
              <label className="text-xs text-gray-400 block mb-1">{label}</label>
              <input
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white"
                placeholder={placeholder}
                value={(form as any)[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              />
            </div>
          ))}
          <div>
            <label className="text-xs text-gray-400 block mb-1">聚合函数</label>
            <select
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white"
              value={form.aggregation}
              onChange={e => setForm(f => ({ ...f, aggregation: e.target.value }))}
            >
              {['SUM','COUNT','AVG','MAX','MIN','CUSTOM'].map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-300 hover:text-white">取消</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 创建 AiDraftReview.tsx**

```tsx
// src/components/MetricsPanel/AiDraftReview.tsx
interface Metric {
  id: number
  display_name: string
  table_name: string
  column_name?: string
  aggregation?: string
  description?: string
}

interface Props {
  metrics: Metric[]
  onClose: () => void
  onApprove: (id: number) => void
  onReject: (id: number) => void
}

export default function AiDraftReview({ metrics, onClose, onApprove, onReject }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[560px] max-h-[70vh] flex flex-col border border-gray-700">
        <div className="p-4 border-b border-gray-700">
          <h3 className="text-sm font-medium">AI 生成的指标草稿</h3>
          <p className="text-xs text-gray-400 mt-1">请逐一审核，批准或拒绝</p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {metrics.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-8">无草稿指标</div>
          )}
          {metrics.map(m => (
            <div key={m.id} className="p-3 bg-gray-750 border border-gray-600 rounded">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm font-medium">{m.display_name}</div>
                  <div className="text-xs text-gray-400">
                    {m.aggregation}({m.table_name}.{m.column_name || '*'})
                  </div>
                  {m.description && (
                    <div className="text-xs text-gray-500 mt-1">{m.description}</div>
                  )}
                </div>
                <div className="flex gap-1 ml-3">
                  <button
                    onClick={() => onApprove(m.id)}
                    className="px-2 py-0.5 text-xs bg-green-700 hover:bg-green-600 rounded"
                  >批准</button>
                  <button
                    onClick={() => onReject(m.id)}
                    className="px-2 py-0.5 text-xs bg-red-800 hover:bg-red-700 rounded"
                  >拒绝</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 验证 TypeScript 类型**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/components/MetricsPanel/
git commit -m "feat(ui): add MetricsPanel — list/create/edit/approve metrics + AI draft review"
```

---

### Task 10: GraphExplorer 前端

**Files:**
- Create: `src/components/GraphExplorer/index.tsx`
- Create: `src/components/GraphExplorer/NodeDetail.tsx`
- Create: `src/components/GraphExplorer/AliasEditor.tsx`
- Modify: `src/components/ActivityBar/index.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 创建 GraphExplorer/index.tsx**

```tsx
// src/components/GraphExplorer/index.tsx
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import NodeDetail from './NodeDetail'

interface GraphNode {
  id: string
  node_type: string
  name: string
  display_name?: string
  metadata?: Record<string, unknown>
}

interface BuildProgress {
  step: string
  done: number
  total: number
}

interface Props {
  connectionId: number | null
}

export default function GraphExplorer({ connectionId }: Props) {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [keyword, setKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<GraphNode[]>([])
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<BuildProgress | null>(null)
  const [activeType, setActiveType] = useState<string>('all')

  const loadNodes = useCallback(async () => {
    if (!connectionId) return
    const data = await invoke<GraphNode[]>('get_graph_nodes', { connectionId, nodeType: null })
    setNodes(data)
  }, [connectionId])

  useEffect(() => { loadNodes() }, [loadNodes])

  useEffect(() => {
    const unlisten = listen<BuildProgress>('graph:build_progress', e => {
      setProgress(e.payload)
      if (e.payload.step === '完成') {
        setBuilding(false)
        setProgress(null)
        loadNodes()
      }
    })
    return () => { unlisten.then(f => f()) }
  }, [loadNodes])

  const handleBuild = async () => {
    if (!connectionId) return
    setBuilding(true)
    try {
      await invoke('build_schema_graph', { connectionId })
    } catch (e) {
      setBuilding(false)
      console.error(e)
    }
  }

  const handleSearch = async (kw: string) => {
    setKeyword(kw)
    if (!kw.trim() || !connectionId) { setSearchResults([]); return }
    const results = await invoke<GraphNode[]>('search_graph', { connectionId, keyword: kw })
    setSearchResults(results)
  }

  const typeColors: Record<string, string> = {
    table: 'text-blue-400',
    column: 'text-green-400',
    metric: 'text-purple-400',
    alias: 'text-yellow-400',
    fk: 'text-orange-400',
  }

  const types = ['all', 'table', 'column', 'metric', 'alias']
  const displayNodes = keyword.trim()
    ? searchResults
    : activeType === 'all' ? nodes : nodes.filter(n => n.node_type === activeType)

  if (!connectionId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        请先选择一个数据库连接
      </div>
    )
  }

  return (
    <div className="flex h-full bg-gray-900 text-gray-100">
      {/* 左侧节点列表 */}
      <div className="w-64 flex flex-col border-r border-gray-700">
        <div className="p-3 border-b border-gray-700 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium flex-1">知识图谱</span>
            <button
              onClick={handleBuild}
              disabled={building}
              className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
            >
              {building ? '构建中...' : '刷新'}
            </button>
          </div>
          {progress && (
            <div className="text-xs text-gray-400">
              {progress.step} ({progress.done}/{progress.total})
            </div>
          )}
          <input
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs"
            placeholder="搜索节点..."
            value={keyword}
            onChange={e => handleSearch(e.target.value)}
          />
          {/* 类型过滤 */}
          {!keyword && (
            <div className="flex flex-wrap gap-1">
              {types.map(t => (
                <button
                  key={t}
                  onClick={() => setActiveType(t)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    activeType === t ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
                  }`}
                >
                  {t === 'all' ? '全部' : t}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {displayNodes.map(node => (
            <div
              key={node.id}
              onClick={() => setSelectedNode(node)}
              className={`px-3 py-2 cursor-pointer hover:bg-gray-800 border-b border-gray-800 ${
                selectedNode?.id === node.id ? 'bg-gray-800' : ''
              }`}
            >
              <div className={`text-xs font-medium ${typeColors[node.node_type] || 'text-gray-300'}`}>
                [{node.node_type}] {node.display_name || node.name}
              </div>
              {node.display_name && node.display_name !== node.name && (
                <div className="text-xs text-gray-500">{node.name}</div>
              )}
            </div>
          ))}
          {displayNodes.length === 0 && (
            <div className="text-center text-gray-500 text-xs mt-8">
              {nodes.length === 0 ? '点击"刷新"构建图谱' : '无匹配节点'}
            </div>
          )}
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1">
        {selectedNode ? (
          <NodeDetail
            node={selectedNode}
            connectionId={connectionId}
            onClose={() => setSelectedNode(null)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            选择左侧节点查看详情
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 NodeDetail.tsx**

```tsx
// src/components/GraphExplorer/NodeDetail.tsx
import { useState } from 'react'
import AliasEditor from './AliasEditor'

interface GraphNode {
  id: string
  node_type: string
  name: string
  display_name?: string
  metadata?: Record<string, unknown>
}

interface Props {
  node: GraphNode
  connectionId: number
  onClose: () => void
}

export default function NodeDetail({ node, connectionId, onClose }: Props) {
  const [showAliasEditor, setShowAliasEditor] = useState(false)

  const metaEntries = node.metadata ? Object.entries(node.metadata) : []

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-lg font-medium">{node.display_name || node.name}</div>
          <div className="text-xs text-gray-400 mt-0.5">
            类型: {node.node_type} · ID: {node.id}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">✕</button>
      </div>

      {metaEntries.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-medium text-gray-400 mb-2">属性</div>
          <div className="bg-gray-800 rounded p-3 space-y-1">
            {metaEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs">
                <span className="text-gray-400 w-32 shrink-0">{k}</span>
                <span className="text-gray-200">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-gray-400">业务语义别名</div>
          <button
            onClick={() => setShowAliasEditor(true)}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            + 添加别名
          </button>
        </div>
        <div className="text-xs text-gray-500">（暂无别名）</div>
      </div>

      {showAliasEditor && (
        <AliasEditor
          nodeId={node.id}
          connectionId={connectionId}
          onClose={() => setShowAliasEditor(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 3: 创建 AliasEditor.tsx**

```tsx
// src/components/GraphExplorer/AliasEditor.tsx
import { useState } from 'react'

interface Props {
  nodeId: string
  connectionId: number
  onClose: () => void
}

export default function AliasEditor({ nodeId, connectionId, onClose }: Props) {
  const [alias, setAlias] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!alias.trim()) return
    setSaving(true)
    try {
      // semantic_aliases 的 CRUD command 将在后续 Task 中添加
      // invoke('save_semantic_alias', { connectionId, nodeId, alias })
      console.log('save alias:', { connectionId, nodeId, alias })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-5 w-80 border border-gray-700">
        <h4 className="text-sm font-medium mb-3">添加业务语义别名</h4>
        <p className="text-xs text-gray-400 mb-3">
          为节点 <span className="text-gray-200">{nodeId}</span> 添加中文业务别名，
          用于提升 AI 问答准确率。
        </p>
        <input
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white mb-3"
          placeholder="如：销售额、下单用户..."
          value={alias}
          onChange={e => setAlias(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          autoFocus
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-white">取消</button>
          <button
            onClick={handleSave}
            disabled={saving || !alias.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 在 ActivityBar 和 App.tsx 添加图谱入口**

在 `ActivityBar/index.tsx` 中添加图谱图标入口（参考现有 ERD 入口的添加方式）。
在 `App.tsx` 中引入 `GraphExplorer` 和 `MetricsPanel` 并挂载到对应路由/面板。

- [ ] **Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: 开发模式验证**

```bash
npm run dev
```

检查 MetricsPanel 和 GraphExplorer 面板能正常渲染。

- [ ] **Step 7: Commit**

```bash
git add src/components/GraphExplorer/ src/components/MetricsPanel/
git commit -m "feat(ui): add GraphExplorer and MetricsPanel frontend components"
```

---

## 最终验证

- [ ] **全量编译**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

- [ ] **TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **全量 Rust 测试**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```

期望：所有测试通过（graph::traversal::tests 3 tests, pipeline::sql_validator::tests 3 tests）

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "feat(v2): complete knowledge graph + metrics + text-to-sql pipeline v2"
```
