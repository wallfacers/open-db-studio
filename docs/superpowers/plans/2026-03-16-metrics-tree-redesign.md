<!-- STATUS: ✅ 已实现 -->
# 业务指标树重构 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将业务指标模块从扁平列表重构为树形导航 + Tab 编辑器，支持原子/复合指标，数据按数据库/Schema 组织。

**Architecture:** MetricsTree 独立加载连接树节点（不依赖 treeStore），新建 metricsTreeStore 管理状态；指标编辑通过 MetricTab 组件（复用 queryStore Tab 机制）；MetricListPanel 提供批量管理视图。

**Tech Stack:** Rust (rusqlite, serde_json), React 18 + TypeScript, Zustand, Tauri invoke, Lucide icons

**Spec:** `docs/superpowers/specs/2026-03-16-metrics-tree-redesign.md`

---

## Chunk 1: Rust 后端变更（Track A）

### Task 1: 更新 schema/init.sql 和迁移脚本

**Files:**
- Modify: `schema/init.sql` (metrics 表定义)
- Modify: `src-tauri/src/db/mod.rs` (迁移脚本执行)

- [ ] **Step 1: 更新 init.sql 中 metrics 表 DDL**

将 `schema/init.sql` 中现有的 metrics 表定义替换为：

```sql
CREATE TABLE IF NOT EXISTS metrics (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id        INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    table_name           TEXT NOT NULL DEFAULT '',
    column_name          TEXT,
    aggregation          TEXT CHECK(aggregation IN ('SUM','COUNT','AVG','MAX','MIN','CUSTOM')),
    filter_sql           TEXT,
    description          TEXT,
    status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
    source               TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),
    metric_type          TEXT NOT NULL DEFAULT 'atomic' CHECK(metric_type IN ('atomic','composite')),
    composite_components TEXT,
    composite_formula    TEXT,
    category             TEXT,
    data_caliber         TEXT,
    version              TEXT,
    scope_database       TEXT,
    scope_schema         TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_conn ON metrics(connection_id);
CREATE INDEX IF NOT EXISTS idx_metrics_status ON metrics(status);
CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(connection_id, scope_database, scope_schema);
```

- [ ] **Step 2: 在 db/mod.rs 的 `ensure_schema` 函数中加入迁移语句**

在现有 `init.sql` 执行之后，追加以下迁移代码（存量数据库兼容）：

```rust
// 存量数据库迁移 — metrics 表新增字段
let migration_stmts = [
    "ALTER TABLE metrics ADD COLUMN metric_type TEXT NOT NULL DEFAULT 'atomic'",
    "ALTER TABLE metrics ADD COLUMN composite_components TEXT",
    "ALTER TABLE metrics ADD COLUMN composite_formula TEXT",
    "ALTER TABLE metrics ADD COLUMN category TEXT",
    "ALTER TABLE metrics ADD COLUMN data_caliber TEXT",
    "ALTER TABLE metrics ADD COLUMN version TEXT",
    "ALTER TABLE metrics ADD COLUMN scope_database TEXT",
    "ALTER TABLE metrics ADD COLUMN scope_schema TEXT",
];
for stmt in &migration_stmts {
    // SQLite: 忽略 "duplicate column name" 错误
    let _ = conn.execute(stmt, []);
}
// 修正旧 source 值
let _ = conn.execute("UPDATE metrics SET source='manual' WHERE source='user'", []);
// 新索引
let _ = conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(connection_id, scope_database, scope_schema)",
    [],
);
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```
期望：无错误

- [ ] **Step 4: Commit**

```bash
git add schema/init.sql src-tauri/src/db/mod.rs
git commit -m "feat(db): extend metrics table — new fields for tree redesign"
```

---

### Task 2: 更新 Rust Metric 结构体和 CRUD

**Files:**
- Modify: `src-tauri/src/metrics/crud.rs`

- [ ] **Step 1: 替换 Metric 结构体**

```rust
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
    pub status: String,
    pub source: String,
    pub metric_type: String,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: 替换 CreateMetricInput**

```rust
#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
    pub metric_type: Option<String>,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
}
```

- [ ] **Step 3: 替换 UpdateMetricInput**

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateMetricInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub metric_type: Option<String>,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
}
```

- [ ] **Step 4: 更新 SELECT_COLS 和 row_to_metric**

```rust
const SELECT_COLS: &str =
    "id,connection_id,name,display_name,table_name,column_name,aggregation,\
     filter_sql,description,status,source,metric_type,composite_components,\
     composite_formula,category,data_caliber,version,scope_database,scope_schema,\
     created_at,updated_at";

fn row_to_metric(row: &rusqlite::Row<'_>) -> rusqlite::Result<Metric> {
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
        metric_type: row.get(11)?,
        composite_components: row.get(12)?,
        composite_formula: row.get(13)?,
        category: row.get(14)?,
        data_caliber: row.get(15)?,
        version: row.get(16)?,
        scope_database: row.get(17)?,
        scope_schema: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}
```

- [ ] **Step 5: 更新 save_metric 函数**

```rust
pub fn save_metric(input: &CreateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    let source = input.source.as_deref().unwrap_or("manual");
    let metric_type = input.metric_type.as_deref().unwrap_or("atomic");
    let table_name = input.table_name.as_deref().unwrap_or("");
    conn.execute(
        "INSERT INTO metrics
            (connection_id,name,display_name,table_name,column_name,aggregation,
             filter_sql,description,source,metric_type,composite_components,
             composite_formula,category,data_caliber,version,scope_database,scope_schema)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        rusqlite::params![
            input.connection_id, input.name, input.display_name, table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description,
            source, metric_type, input.composite_components, input.composite_formula,
            input.category, input.data_caliber, input.version,
            input.scope_database, input.scope_schema
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_metric_by_id(&conn, id)
}
```

- [ ] **Step 6: 更新 update_metric 函数**

```rust
pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET
            name=COALESCE(?2,name),
            display_name=COALESCE(?3,display_name),
            table_name=COALESCE(?4,table_name),
            column_name=COALESCE(?5,column_name),
            aggregation=COALESCE(?6,aggregation),
            filter_sql=COALESCE(?7,filter_sql),
            description=COALESCE(?8,description),
            metric_type=COALESCE(?9,metric_type),
            composite_components=COALESCE(?10,composite_components),
            composite_formula=COALESCE(?11,composite_formula),
            category=COALESCE(?12,category),
            data_caliber=COALESCE(?13,data_caliber),
            version=COALESCE(?14,version),
            scope_database=COALESCE(?15,scope_database),
            scope_schema=COALESCE(?16,scope_schema),
            updated_at=datetime('now')
         WHERE id=?1",
        rusqlite::params![
            id,
            input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description,
            input.metric_type, input.composite_components, input.composite_formula,
            input.category, input.data_caliber, input.version,
            input.scope_database, input.scope_schema
        ],
    )?;
    get_metric_by_id(&conn, id)
}
```

- [ ] **Step 7: 更新 delete_metric 函数（加引用检查）**

```rust
pub fn delete_metric(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    // 检查是否被复合指标引用
    let referencing: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT display_name FROM metrics WHERE metric_type='composite'
             AND composite_components LIKE '%\"metric_id\":' || ?1 || '%'"
        )?;
        stmt.query_map([id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if !referencing.is_empty() {
        return Err(crate::AppError::Other(format!(
            "该指标被以下复合指标引用，无法删除：{}",
            referencing.join("、")
        )));
    }
    conn.execute("DELETE FROM metrics WHERE id=?1", [id])?;
    Ok(())
}
```

- [ ] **Step 8: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```
期望：无错误

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/metrics/crud.rs
git commit -m "feat(metrics): extend Metric struct and CRUD for tree redesign"
```

---

### Task 3: 新增 Tauri 命令 + 系统库过滤

**Files:**
- Modify: `src-tauri/src/metrics/crud.rs` (新增 list_metrics_by_node, count_metrics_batch)
- Modify: `src-tauri/src/commands.rs` (新增命令 + list_databases/list_schemas 过滤)
- Modify: `src-tauri/src/lib.rs` (注册新命令)

- [ ] **Step 1: 在 crud.rs 末尾新增两个函数**

```rust
pub fn list_metrics_by_node(
    connection_id: i64,
    database: Option<&str>,
    schema: Option<&str>,
    status: Option<&str>,
) -> AppResult<Vec<Metric>> {
    let conn = crate::db::get().lock().unwrap();
    let mut conditions = vec!["connection_id=?1".to_string()];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];
    let mut idx = 2usize;

    if let Some(db) = database {
        conditions.push(format!("scope_database=?{}", idx));
        params.push(Box::new(db.to_string()));
        idx += 1;
    }
    if let Some(sc) = schema {
        conditions.push(format!("scope_schema=?{}", idx));
        params.push(Box::new(sc.to_string()));
        idx += 1;
    }
    if let Some(st) = status {
        conditions.push(format!("status=?{}", idx));
        params.push(Box::new(st.to_string()));
    }

    let sql = format!(
        "SELECT {} FROM metrics WHERE {} ORDER BY created_at DESC",
        SELECT_COLS,
        conditions.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        row_to_metric,
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 批量获取节点下指标计数
/// - database=None  → 返回各 scope_database 的计数 (key = database name)
/// - database=Some  → 返回各 scope_schema 的计数 (key = schema name)
pub fn count_metrics_batch(
    connection_id: i64,
    database: Option<&str>,
) -> AppResult<std::collections::HashMap<String, i64>> {
    let conn = crate::db::get().lock().unwrap();
    let (group_col, sql) = match database {
        None => (
            "scope_database",
            format!(
                "SELECT scope_database, COUNT(*) FROM metrics
                 WHERE connection_id=?1 AND scope_database IS NOT NULL
                 GROUP BY scope_database"
            ),
        ),
        Some(db) => (
            "scope_schema",
            format!(
                "SELECT scope_schema, COUNT(*) FROM metrics
                 WHERE connection_id=?1 AND scope_database=?2 AND scope_schema IS NOT NULL
                 GROUP BY scope_schema"
            ),
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = match database {
        None => stmt.query_map(rusqlite::params![connection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?,
        Some(db) => stmt.query_map(rusqlite::params![connection_id, db], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?,
    };
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}
```

- [ ] **Step 2: 在 commands.rs 中添加系统库过滤常量和新命令**

在 `list_databases` 命令后插入：

```rust
/// 在指标树场景下，过滤掉系统库/Schema，前端无需关心
const SYSTEM_SCHEMAS: &[&str] = &[
    "information_schema", "pg_catalog",
    "performance_schema", "sys", "mysql",
];

#[tauri::command]
pub async fn list_databases_for_metrics(connection_id: i64) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let dbs = ds.list_databases().await?;
    Ok(dbs.into_iter().filter(|d| !SYSTEM_SCHEMAS.contains(&d.as_str())).collect())
}

#[tauri::command]
pub async fn list_schemas_for_metrics(
    connection_id: i64,
    database: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    let schemas = ds.list_schemas(&database).await?;
    Ok(schemas.into_iter().filter(|s| !SYSTEM_SCHEMAS.contains(&s.as_str())).collect())
}

#[tauri::command]
pub async fn list_metrics_by_node(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::crud::list_metrics_by_node(
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        status.as_deref(),
    )
}

#[tauri::command]
pub async fn count_metrics_batch(
    connection_id: i64,
    database: Option<String>,
) -> AppResult<std::collections::HashMap<String, i64>> {
    crate::metrics::crud::count_metrics_batch(connection_id, database.as_deref())
}
```

- [ ] **Step 3: 在 lib.rs 的 generate_handler![] 中注册新命令**

在现有 `commands::list_databases,` 之后追加：

```rust
commands::list_databases_for_metrics,
commands::list_schemas_for_metrics,
commands::list_metrics_by_node,
commands::count_metrics_batch,
```

- [ ] **Step 4: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error"
```
期望：无错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metrics/crud.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(metrics): add list_metrics_by_node, count_metrics_batch, system DB filter"
```

---

## Chunk 2: 前端类型 + Store（Track B，可与 Chunk 1 并行）

### Task 4: 扩展 types/index.ts

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 将现有 TabType 和 Tab 替换为扩展版本**

将 `src/types/index.ts` 中：
```typescript
export type TabType = 'query' | 'table' | 'er_diagram';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
}
```
替换为：
```typescript
export type TabType = 'query' | 'table' | 'er_diagram' | 'metric' | 'metric_list';

export interface MetricScope {
  connectionId: number;
  database?: string;
  schema?: string;
}

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;       // metric Tab 专用
  metricScope?: MetricScope; // metric_list Tab 专用
}
```

- [ ] **Step 2: 在文件末尾添加 Metric 相关类型**

```typescript
export type MetricType = 'atomic' | 'composite';
export type MetricStatus = 'draft' | 'approved' | 'rejected';
export type MetricSource = 'manual' | 'ai';

export interface CompositeComponent {
  metric_id: number;
  metric_name: string;    // 英文标识
  display_name: string;   // 显示名称
}

export interface Metric {
  id: number;
  connection_id: number;
  name: string;
  display_name: string;
  table_name: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  status: MetricStatus;
  source: MetricSource;
  metric_type: MetricType;
  composite_components?: CompositeComponent[];
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateMetricPayload {
  connection_id: number;
  name: string;
  display_name: string;
  table_name?: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  metric_type?: MetricType;
  composite_components?: string; // JSON
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
}

export interface UpdateMetricPayload {
  name?: string;
  display_name?: string;
  table_name?: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  metric_type?: MetricType;
  composite_components?: string;
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
}
```

- [ ] **Step 3: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```
期望：无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): extend Tab and add Metric types for tree redesign"
```

---

### Task 5: 创建 metricsTreeStore.ts

**Files:**
- Create: `src/store/metricsTreeStore.ts`

- [ ] **Step 1: 创建 store 文件**

```typescript
// src/store/metricsTreeStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Metric, MetricScope } from '../types';

export type MetricsNodeType = 'connection' | 'database' | 'schema' | 'metric';

export interface MetricsTreeNode {
  id: string;           // 格式: "conn_{id}" | "db_{connId}_{db}" | "schema_{connId}_{db}_{sc}" | "metric_{id}"
  nodeType: MetricsNodeType;
  label: string;
  parentId: string | null;
  hasChildren: boolean;
  loaded: boolean;
  meta: {
    connectionId?: number;
    database?: string;
    schema?: string;
    metricId?: number;
    metricType?: string;  // 'atomic' | 'composite'
  };
}

interface MetricsTreeState {
  nodes: Map<string, MetricsTreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  metricCounts: Map<string, number>;
  loadingIds: Set<string>;

  init: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  getChildNodes: (parentId: string | null) => MetricsTreeNode[];
}

export const useMetricsTreeStore = create<MetricsTreeState>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  metricCounts: new Map(),
  loadingIds: new Set(),

  init: async () => {
    const conns: Array<{ id: number; name: string; driver: string }> =
      await invoke('list_connections');
    const nodes = new Map<string, MetricsTreeNode>();
    for (const c of conns) {
      const id = `conn_${c.id}`;
      nodes.set(id, {
        id,
        nodeType: 'connection',
        label: c.name,
        parentId: null,
        hasChildren: true,
        loaded: false,
        meta: { connectionId: c.id },
      });
    }
    set({ nodes });
  },

  loadChildren: async (nodeId: string) => {
    const { nodes, loadingIds } = get();
    if (loadingIds.has(nodeId)) return;
    const node = nodes.get(nodeId);
    if (!node) return;

    set(s => ({ loadingIds: new Set([...s.loadingIds, nodeId]) }));

    try {
      const newNodes = new Map(get().nodes);

      if (node.nodeType === 'connection') {
        const { connectionId } = node.meta;
        const dbs: string[] = await invoke('list_databases_for_metrics', { connectionId });
        // 批量加载计数
        const counts: Record<string, number> = await invoke('count_metrics_batch', {
          connectionId,
          database: null,
        });
        const newCounts = new Map(get().metricCounts);
        for (const db of dbs) {
          const id = `db_${connectionId}_${db}`;
          newNodes.set(id, {
            id,
            nodeType: 'database',
            label: db,
            parentId: nodeId,
            hasChildren: true,
            loaded: false,
            meta: { connectionId, database: db },
          });
          newCounts.set(id, counts[db] ?? 0);
        }
        newNodes.set(nodeId, { ...node, loaded: true });
        set({ nodes: newNodes, metricCounts: newCounts });

      } else if (node.nodeType === 'database') {
        const { connectionId, database } = node.meta;
        // 尝试获取 schema 列表
        const schemas: string[] = await invoke('list_schemas_for_metrics', {
          connectionId,
          database,
        });

        if (schemas.length > 0) {
          // PG/Oracle 风格：有 schema 层
          const counts: Record<string, number> = await invoke('count_metrics_batch', {
            connectionId,
            database,
          });
          const newCounts = new Map(get().metricCounts);
          for (const sc of schemas) {
            const id = `schema_${connectionId}_${database}_${sc}`;
            newNodes.set(id, {
              id,
              nodeType: 'schema',
              label: sc,
              parentId: nodeId,
              hasChildren: true,
              loaded: false,
              meta: { connectionId, database, schema: sc },
            });
            newCounts.set(id, counts[sc] ?? 0);
          }
          newNodes.set(nodeId, { ...node, loaded: true });
          set({ nodes: newNodes, metricCounts: newCounts });
        } else {
          // MySQL 风格：直接加载指标
          const metrics: Metric[] = await invoke('list_metrics_by_node', {
            connectionId,
            database,
            schema: null,
          });
          for (const m of metrics) {
            const id = `metric_${m.id}`;
            newNodes.set(id, {
              id,
              nodeType: 'metric',
              label: m.display_name,
              parentId: nodeId,
              hasChildren: false,
              loaded: true,
              meta: { connectionId, database, metricId: m.id, metricType: m.metric_type },
            });
          }
          newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
          set({ nodes: newNodes });
        }

      } else if (node.nodeType === 'schema') {
        const { connectionId, database, schema } = node.meta;
        const metrics: Metric[] = await invoke('list_metrics_by_node', {
          connectionId,
          database,
          schema,
        });
        for (const m of metrics) {
          const id = `metric_${m.id}`;
          newNodes.set(id, {
            id,
            nodeType: 'metric',
            label: m.display_name,
            parentId: nodeId,
            hasChildren: false,
            loaded: true,
            meta: {
              connectionId,
              database,
              schema,
              metricId: m.id,
              metricType: m.metric_type,
            },
          });
        }
        newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
        set({ nodes: newNodes });
      }
    } finally {
      set(s => {
        const ids = new Set(s.loadingIds);
        ids.delete(nodeId);
        return { loadingIds: ids };
      });
    }
  },

  toggleExpand: (nodeId: string) => {
    const { expandedIds, nodes } = get();
    const node = nodes.get(nodeId);
    if (!node) return;
    const next = new Set(expandedIds);
    if (next.has(nodeId)) {
      next.delete(nodeId);
    } else {
      next.add(nodeId);
      if (!node.loaded && node.hasChildren) {
        get().loadChildren(nodeId);
      }
    }
    set({ expandedIds: next });
  },

  selectNode: (nodeId: string | null) => set({ selectedId: nodeId }),

  refreshNode: async (nodeId: string) => {
    const { nodes } = get();
    const node = nodes.get(nodeId);
    if (!node) return;
    // 清除所有子节点
    const newNodes = new Map(nodes);
    for (const [id, n] of newNodes) {
      if (n.parentId === nodeId) newNodes.delete(id);
    }
    newNodes.set(nodeId, { ...node, loaded: false });
    set({ nodes: newNodes });
    await get().loadChildren(nodeId);
  },

  getChildNodes: (parentId: string | null) => {
    const { nodes } = get();
    return [...nodes.values()].filter(n => n.parentId === parentId);
  },
}));
```

- [ ] **Step 2: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```
期望：无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/store/metricsTreeStore.ts
git commit -m "feat(store): add metricsTreeStore for metrics tree navigation"
```

---

## Chunk 3: 前端树组件（Track C，依赖 Chunk 1+2）

### Task 6: 创建 MetricsExplorer 容器和 MetricsTree

**Files:**
- Create: `src/components/MetricsExplorer/index.tsx`
- Create: `src/components/MetricsExplorer/MetricsTree.tsx`

- [ ] **Step 1: 创建 MetricsTree.tsx**

```tsx
// src/components/MetricsExplorer/MetricsTree.tsx
import React, { useEffect } from 'react';
import {
  Database, Server, Layers, BarChart2, GitMerge,
  ChevronRight, ChevronDown, RefreshCw, TableProperties, FolderOpen,
} from 'lucide-react';
import { useMetricsTreeStore, MetricsTreeNode } from '../../store/metricsTreeStore';
import { useQueryStore } from '../../store/queryStore';

interface ContextMenuState {
  node: MetricsTreeNode;
  x: number;
  y: number;
}

export function MetricsTree() {
  const {
    nodes, expandedIds, selectedId, metricCounts, loadingIds,
    init, toggleExpand, selectNode, refreshNode, getChildNodes,
  } = useMetricsTreeStore();
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

  useEffect(() => { init(); }, []);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, node: MetricsTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  };

  const openMetricTab = (node: MetricsTreeNode) => {
    if (node.nodeType !== 'metric' || !node.meta.metricId) return;
    useQueryStore.getState().openMetricTab(node.meta.metricId, node.label);
  };

  const openMetricListTab = (node: MetricsTreeNode) => {
    const { connectionId, database, schema } = node.meta;
    if (!connectionId) return;
    useQueryStore.getState().openMetricListTab(
      { connectionId, database, schema },
      schema ?? database ?? 'Metrics',
    );
  };

  const renderNode = (node: MetricsTreeNode, depth: number) => {
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedId === node.id;
    const isLoading = loadingIds.has(node.id);
    const count = metricCounts.get(node.id);
    const children = isExpanded ? getChildNodes(node.id) : [];

    const NodeIcon = () => {
      switch (node.nodeType) {
        case 'connection': return <Server size={14} className="text-blue-400 flex-shrink-0" />;
        case 'database':   return <Database size={14} className="text-cyan-400 flex-shrink-0" />;
        case 'schema':     return <Layers size={14} className="text-indigo-400 flex-shrink-0" />;
        case 'metric':
          return node.meta.metricType === 'composite'
            ? <GitMerge size={14} className="text-purple-400 flex-shrink-0" />
            : <BarChart2 size={14} className="text-green-400 flex-shrink-0" />;
      }
    };

    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer rounded select-none
            ${isSelected ? 'bg-[#1a3a5c] text-white' : 'text-[#a0b4c8] hover:bg-[#1a2a3a] hover:text-white'}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => {
            selectNode(node.id);
            if (node.nodeType !== 'metric') toggleExpand(node.id);
          }}
          onDoubleClick={() => { if (node.nodeType === 'metric') openMetricTab(node); }}
          onContextMenu={e => handleContextMenu(e, node)}
        >
          {node.hasChildren || node.nodeType !== 'metric' ? (
            <span className="w-4 flex-shrink-0">
              {isLoading
                ? <RefreshCw size={12} className="animate-spin text-[#7a9bb8]" />
                : isExpanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />
              }
            </span>
          ) : <span className="w-4" />}

          <NodeIcon />
          <span className="text-xs truncate flex-1">{node.label}</span>
          {count !== undefined && (
            <span className="text-[10px] text-[#7a9bb8] flex-shrink-0">[{count}]</span>
          )}
        </div>

        {isExpanded && children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  const rootNodes = getChildNodes(null);

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {rootNodes.map(n => renderNode(n, 0))}

      {contextMenu && (
        <div
          className="fixed z-50 bg-[#1e2d42] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.nodeType === 'metric' ? (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => { openMetricTab(contextMenu.node); setContextMenu(null); }}
              >
                📂 打开
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => { openMetricTab(contextMenu.node); setContextMenu(null); }}
              >
                ✏️ 编辑
              </button>
              <div className="border-t border-[#2a3f5a] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-[#3d1a1a]"
                onClick={async () => {
                  const { metricId } = contextMenu.node.meta;
                  if (!metricId) return;
                  try {
                    await invoke('delete_metric', { id: metricId });
                    refreshNode(contextMenu.node.parentId!);
                  } catch (e: any) {
                    alert(e?.message ?? '删除失败');
                  }
                  setContextMenu(null);
                }}
              >
                🗑️ 删除
              </button>
            </>
          ) : (
            <>
              {(contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema') && (
                <>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                    onClick={() => { openMetricListTab(contextMenu.node); setContextMenu(null); }}
                  >
                    📋 打开指标列表
                  </button>
                  <div className="border-t border-[#2a3f5a] my-1" />
                </>
              )}
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => { refreshNode(contextMenu.node.id); setContextMenu(null); }}
              >
                🔄 刷新
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

需要在文件顶部引入 invoke：
```typescript
import { invoke } from '@tauri-apps/api/core';
```

- [ ] **Step 2: 创建 MetricsExplorer/index.tsx**

```tsx
// src/components/MetricsExplorer/index.tsx
import React from 'react';
import { BarChart2 } from 'lucide-react';
import { MetricsTree } from './MetricsTree';

export function MetricsExplorer() {
  return (
    <div className="flex flex-col h-full bg-[#111922]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e2d42]">
        <BarChart2 size={14} className="text-[#00c9a7]" />
        <span className="text-xs font-semibold text-[#a0b4c8] uppercase tracking-wider">
          业务指标
        </span>
      </div>
      <MetricsTree />
    </div>
  );
}
```

- [ ] **Step 3: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```
期望：无新增错误（openMetricTab/openMetricListTab 暂时可能报错，Task 7 处理）

- [ ] **Step 4: Commit**

```bash
git add src/components/MetricsExplorer/
git commit -m "feat(ui): add MetricsTree and MetricsExplorer container"
```

---

### Task 7: 在 queryStore 中添加 metric Tab 方法，并接入 App.tsx

**Files:**
- Modify: `src/store/queryStore.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: 在 queryStore 中添加 openMetricTab 和 openMetricListTab**

在 queryStore 的 interface 和 create 中追加（找到 `setActiveTabId` 位置后添加）：

```typescript
// 在 QueryState interface 中添加
openMetricTab: (metricId: number, title: string) => void;
openMetricListTab: (scope: MetricScope, title: string) => void;
```

在 create 实现中添加：

```typescript
openMetricTab: (metricId, title) => {
  set(s => {
    const existing = s.tabs.find(t => t.type === 'metric' && t.metricId === metricId);
    if (existing) return { activeTabId: existing.id };
    const id = `metric_${metricId}_${Date.now()}`;
    const tab: Tab = { id, type: 'metric', title, metricId };
    return { tabs: [...s.tabs, tab], activeTabId: id };
  });
},
openMetricListTab: (scope, title) => {
  const key = `ml_${scope.connectionId}_${scope.database ?? ''}_${scope.schema ?? ''}`;
  set(s => {
    const existing = s.tabs.find(t => t.id === key);
    if (existing) return { activeTabId: key };
    const tab: Tab = { id: key, type: 'metric_list', title, metricScope: scope };
    return { tabs: [...s.tabs, tab], activeTabId: key };
  });
},
```

需要在 queryStore.ts 顶部引入 `MetricScope` 类型：
```typescript
import type { QueryResult, QueryHistory, Tab, SqlDiffProposal, EditorInfo, MetricScope } from '../types';
```

- [ ] **Step 2: 将 App.tsx 中 MetricsPanel 替换为 MetricsExplorer**

找到：
```tsx
import { MetricsPanel } from './components/MetricsPanel';
```
替换为：
```tsx
import { MetricsExplorer } from './components/MetricsExplorer';
```

找到：
```tsx
} : activeActivity === 'metrics' ? (
  <MetricsPanel connectionId={tabs.find(t => t.id === activeTab)?.queryContext?.connectionId ?? null} />
```
替换为：
```tsx
} : activeActivity === 'metrics' ? (
  <MetricsExplorer />
```

- [ ] **Step 3: 在主内容区的 Tab 渲染处理 metric / metric_list Tab 类型**

在 App.tsx 中找到渲染 Tab 内容的地方（通常是 `activeTab` 对应的组件渲染），添加 metric 类型的处理。找到类似以下结构：

```tsx
{activeTab && tabs.find(t => t.id === activeTab)?.type === 'query' && (
  <QueryEditor ... />
)}
```

在其后添加：

```tsx
{activeTab && tabs.find(t => t.id === activeTab)?.type === 'metric' && (
  <MetricTab metricId={tabs.find(t => t.id === activeTab)!.metricId!} />
)}
{activeTab && tabs.find(t => t.id === activeTab)?.type === 'metric_list' && (
  <MetricListPanel scope={tabs.find(t => t.id === activeTab)!.metricScope!} />
)}
```

同时在文件顶部添加（占位导入，Task 8 和 9 完成后才实现）：
```tsx
// import { MetricTab } from './components/MetricsExplorer/MetricTab';
// import { MetricListPanel } from './components/MetricsExplorer/MetricListPanel';
```

- [ ] **Step 4: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: 启动前端验证树能正常渲染**

```bash
npm run dev
```
在浏览器中切换到"业务指标"面板，验证：连接树节点展示、展开/折叠、右键菜单出现。

- [ ] **Step 6: Commit**

```bash
git add src/store/queryStore.ts src/App.tsx
git commit -m "feat(ui): wire MetricsExplorer into App, add metric Tab support in queryStore"
```

---

## Chunk 4: MetricTab 原子指标编辑（P1）

### Task 8: 创建 MetricTab.tsx

**Files:**
- Create: `src/components/MetricsExplorer/MetricTab.tsx`

- [ ] **Step 1: 创建 MetricTab 组件**

```tsx
// src/components/MetricsExplorer/MetricTab.tsx
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Metric, UpdateMetricPayload } from '../../types';

interface Props {
  metricId: number;
}

export function MetricTab({ metricId }: Props) {
  const [metric, setMetric] = useState<Metric | null>(null);
  const [form, setForm] = useState<UpdateMetricPayload>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Metric[]>('list_metrics_by_node', { connectionId: -1 }).then(() => {});
    // 使用单独的 get_metric 命令（如有），否则通过 list_metrics_by_node 过滤
    // 这里简化：直接通过 connection_id=-1 查询不到，改用现有 list_metrics 拿全量后过滤
    // TODO: 后续可优化为 get_metric_by_id 命令
    loadMetric();
  }, [metricId]);

  const loadMetric = async () => {
    // 临时方案：前端通过 metricsTreeStore 的 loadedMetrics 缓存获取
    // 或直接调用 list_metrics_by_node with no filters，然后找 id
    // 最简实现：新增 get_metric Tauri 命令（见下方说明）
    try {
      const m = await invoke<Metric>('get_metric', { id: metricId });
      setMetric(m);
      setForm({
        name: m.name, display_name: m.display_name,
        table_name: m.table_name, column_name: m.column_name,
        aggregation: m.aggregation, filter_sql: m.filter_sql,
        description: m.description, metric_type: m.metric_type,
        category: m.category, data_caliber: m.data_caliber, version: m.version,
      });
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke('update_metric', { id: metricId, input: form });
      await loadMetric();
    } catch (e: any) {
      setError(e?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof UpdateMetricPayload, required = false) => (
    <div className="flex items-start gap-3 mb-3">
      <label className="w-28 text-xs text-[#7a9bb8] pt-1.5 flex-shrink-0 text-right">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-white
                   focus:outline-none focus:border-[#00c9a7]"
        value={(form[key] as string) ?? ''}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value || undefined }))}
      />
    </div>
  );

  if (!metric) return (
    <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">
      {error ?? '加载中...'}
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-[#111922] text-white">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e2d42]">
        <span className="text-sm font-medium text-[#a0b4c8]">{metric.display_name}</span>
        <button
          className="px-3 py-1 bg-[#00c9a7] text-black text-xs rounded hover:bg-[#00b090] disabled:opacity-50"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-[#3d1a1a] text-red-400 text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {/* 表单区域 */}
        <div className="mb-4">
          <div className="flex items-center gap-4 mb-4">
            <label className="w-28 text-xs text-[#7a9bb8] text-right flex-shrink-0">指标类型</label>
            <div className="flex gap-4">
              {(['atomic', 'composite'] as const).map(t => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    value={t}
                    checked={(form.metric_type ?? metric.metric_type) === t}
                    onChange={() => setForm(f => ({ ...f, metric_type: t }))}
                    className="accent-[#00c9a7]"
                  />
                  <span className="text-xs text-[#a0b4c8]">
                    {t === 'atomic' ? '原子指标' : '复合指标'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {field('显示名称', 'display_name', true)}
          {field('英文标识', 'name', true)}
          {(form.metric_type ?? metric.metric_type) === 'atomic' && (
            <>
              {field('关联表', 'table_name', true)}
              {field('关联列', 'column_name')}
              <div className="flex items-center gap-3 mb-3">
                <label className="w-28 text-xs text-[#7a9bb8] text-right flex-shrink-0">聚合方式</label>
                <select
                  className="bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-white
                             focus:outline-none focus:border-[#00c9a7]"
                  value={form.aggregation ?? metric.aggregation ?? ''}
                  onChange={e => setForm(f => ({ ...f, aggregation: e.target.value || undefined }))}
                >
                  <option value="">不设置</option>
                  {['SUM', 'COUNT', 'AVG', 'MAX', 'MIN'].map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </>
          )}
          {field('分类标签', 'category')}
          {field('版本号', 'version')}

          <div className="flex items-start gap-3 mb-3">
            <label className="w-28 text-xs text-[#7a9bb8] pt-1.5 text-right flex-shrink-0">描述</label>
            <textarea
              className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-white
                         focus:outline-none focus:border-[#00c9a7] resize-none h-16"
              value={(form.description as string) ?? ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value || undefined }))}
            />
          </div>
          <div className="flex items-start gap-3 mb-3">
            <label className="w-28 text-xs text-[#7a9bb8] pt-1.5 text-right flex-shrink-0">数据口径说明</label>
            <textarea
              className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-white
                         focus:outline-none focus:border-[#00c9a7] resize-none h-16"
              value={(form.data_caliber as string) ?? ''}
              onChange={e => setForm(f => ({ ...f, data_caliber: e.target.value || undefined }))}
            />
          </div>
        </div>

        {/* filter_sql 编辑器（仅原子指标） */}
        {(form.metric_type ?? metric.metric_type) === 'atomic' && (
          <div className="border border-[#2a3f5a] rounded">
            <div className="px-3 py-1.5 bg-[#1a2a3a] border-b border-[#2a3f5a] text-xs text-[#7a9bb8]">
              WHERE 条件 (filter_sql)
            </div>
            <textarea
              className="w-full bg-[#0d1821] px-3 py-2 text-xs text-white font-mono
                         focus:outline-none resize-none h-32"
              placeholder="-- 不含 WHERE 关键字，例如: created_at >= '2024-01-01'"
              value={(form.filter_sql as string) ?? ''}
              onChange={e => setForm(f => ({ ...f, filter_sql: e.target.value || undefined }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

> **注意**：Task 8 依赖一个新的 `get_metric` Tauri 命令（按 id 返回单个指标）。需在 Rust 侧添加：
> ```rust
> #[tauri::command]
> pub async fn get_metric(id: i64) -> AppResult<crate::metrics::Metric> {
>     crate::metrics::crud::get_metric_pub(id)
> }
> ```
> 在 crud.rs 中暴露 `get_metric_pub`（将现有 `get_metric_by_id` 包一层 pub 函数），并注册到 lib.rs。

- [ ] **Step 2: 在 App.tsx 中取消 MetricTab 导入注释**

```tsx
import { MetricTab } from './components/MetricsExplorer/MetricTab';
```

- [ ] **Step 3: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add src/components/MetricsExplorer/MetricTab.tsx src-tauri/src/metrics/crud.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(ui): add MetricTab for atomic metric editing"
```

---

## Chunk 5: MetricListPanel 指标管理（P1）

### Task 9: 创建 MetricListPanel.tsx

**Files:**
- Create: `src/components/MetricsExplorer/MetricListPanel.tsx`

- [ ] **Step 1: 创建 MetricListPanel 组件**

```tsx
// src/components/MetricsExplorer/MetricListPanel.tsx
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, ExternalLink, Pencil, Plus, Sparkles } from 'lucide-react';
import type { Metric, MetricScope, MetricStatus } from '../../types';
import { useQueryStore } from '../../store/queryStore';

interface Props {
  scope: MetricScope;
}

type FilterTab = 'all' | MetricStatus;

export function MetricListPanel({ scope }: Props) {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = async (status?: MetricStatus) => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Metric[]>('list_metrics_by_node', {
        connectionId: scope.connectionId,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        status: status ?? null,
      });
      setMetrics(data);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(filterTab === 'all' ? undefined : filterTab);
  }, [filterTab, scope.connectionId, scope.database, scope.schema]);

  const filtered = metrics.filter(m =>
    !search || m.display_name.includes(search) || m.name.includes(search)
  );

  const toggleSelect = (id: number) => {
    setSelected(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const allSelected = filtered.length > 0 && filtered.every(m => selected.has(m.id));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map(m => m.id)));
  };

  const doDelete = async (ids: number[]) => {
    for (const id of ids) {
      try { await invoke('delete_metric', { id }); } catch (e: any) { alert(e?.message); }
    }
    setSelected(new Set());
    load(filterTab === 'all' ? undefined : filterTab);
  };

  const doSetStatus = async (ids: number[], status: string) => {
    for (const id of ids) {
      await invoke('approve_metric', { id, status });
    }
    setSelected(new Set());
    load(filterTab === 'all' ? undefined : filterTab);
  };

  const statusBadge = (status: MetricStatus) => {
    const map: Record<MetricStatus, { bg: string; text: string; label: string }> = {
      approved: { bg: 'bg-[#0d3d2e]', text: 'text-[#00c9a7]', label: '✅ 已通过' },
      rejected: { bg: 'bg-[#3d1a1a]', text: 'text-[#f87171]', label: '❌ 已拒绝' },
      draft:    { bg: 'bg-[#1e2d42]', text: 'text-[#7a9bb8]', label: '📝 草稿' },
    };
    const s = map[status];
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] ${s.bg} ${s.text}`}>{s.label}</span>
    );
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'draft', label: '草稿' },
    { key: 'approved', label: '已通过' },
    { key: 'rejected', label: '已拒绝' },
  ];

  return (
    <div className="flex flex-col h-full bg-[#111922] text-white">
      {/* 顶部过滤栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e2d42] flex-wrap">
        <div className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`px-2 py-1 text-xs rounded ${filterTab === t.key
                ? 'bg-[#00c9a7] text-black font-medium'
                : 'text-[#7a9bb8] hover:bg-[#1a2a3a]'}`}
              onClick={() => setFilterTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="flex-1 min-w-[120px] bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs
                     text-white placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7]"
          placeholder="搜索指标名称..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a]
                     rounded text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => {/* TODO: 新增指标 */}}
        >
          <Plus size={12} /> 新增
        </button>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a]
                     rounded text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => {/* TODO: AI 生成 */}}
        >
          <Sparkles size={12} /> AI 生成
        </button>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0d1821] text-[#7a9bb8] uppercase text-[10px] tracking-wider">
            <tr>
              <th className="w-8 px-3 py-2 text-left">
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                  className="accent-[#00c9a7]" />
              </th>
              <th className="px-3 py-2 text-left">显示名称</th>
              <th className="px-3 py-2 text-left">关联表</th>
              <th className="px-3 py-2 text-left">聚合</th>
              <th className="px-3 py-2 text-left">类型</th>
              <th className="px-3 py-2 text-left">状态</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center py-8 text-[#7a9bb8]">加载中...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[#7a9bb8]">暂无指标</td></tr>
            )}
            {filtered.map(m => (
              <tr key={m.id} className="border-b border-[#1a2a3a] hover:bg-[#1a2a3a]">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(m.id)}
                    onChange={() => toggleSelect(m.id)} className="accent-[#00c9a7]" />
                </td>
                <td className="px-3 py-2 text-white">{m.display_name}</td>
                <td className="px-3 py-2 text-[#a0b4c8]">{m.table_name || '-'}</td>
                <td className="px-3 py-2 text-[#a0b4c8]">{m.aggregation ?? '-'}</td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    m.metric_type === 'composite'
                      ? 'bg-[#2d1a4a] text-[#c084fc]'
                      : 'bg-[#1a2a3a] text-[#7a9bb8]'
                  }`}>
                    {m.metric_type === 'composite' ? '复合' : '原子'}
                  </span>
                </td>
                <td className="px-3 py-2">{statusBadge(m.status)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      className="text-[#7a9bb8] hover:text-white"
                      onClick={() => useQueryStore.getState().openMetricTab(m.id, m.display_name)}
                      title="打开"
                    ><ExternalLink size={12} /></button>
                    <button
                      className="text-[#7a9bb8] hover:text-white"
                      onClick={() => useQueryStore.getState().openMetricTab(m.id, m.display_name)}
                      title="编辑"
                    ><Pencil size={12} /></button>
                    <button
                      className="text-red-400 hover:text-red-300"
                      onClick={() => doDelete([m.id])}
                      title="删除"
                    ><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[#1a2a3a] border-t border-[#2a3f5a] text-xs">
          <span className="text-[#7a9bb8]">已选 {selected.size} 项</span>
          <button
            className="text-red-400 hover:text-red-300"
            onClick={() => doDelete([...selected])}
          >批量删除</button>
          <button
            className="text-[#00c9a7] hover:text-[#00b090]"
            onClick={() => doSetStatus([...selected], 'approved')}
          >批量通过</button>
          <button
            className="text-[#f87171] hover:text-red-300"
            onClick={() => doSetStatus([...selected], 'rejected')}
          >批量拒绝</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 在 App.tsx 中取消 MetricListPanel 导入注释**

```tsx
import { MetricListPanel } from './components/MetricsExplorer/MetricListPanel';
```

- [ ] **Step 3: TS 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: 启动前端端到端验证**

```bash
npm run tauri:dev
```
验证：
1. 业务指标面板展示连接树
2. 展开数据库节点，系统库不出现
3. 右键数据库节点 → "打开指标列表" → 弹出指标管理 Tab
4. 点击指标节点 → 打开 MetricTab 编辑表单

- [ ] **Step 5: Commit**

```bash
git add src/components/MetricsExplorer/MetricListPanel.tsx src/App.tsx
git commit -m "feat(ui): add MetricListPanel with batch operations"
```

---

## 并行执行说明

以下两个 Track 可以同时进行：

| Track | 包含任务 | 依赖 |
|-------|---------|------|
| **Track A（后端）** | Task 1 → Task 2 → Task 3 | 无 |
| **Track B（前端类型+Store）** | Task 4 → Task 5 | 无 |
| **Track C（前端组件）** | Task 6 → Task 7 → Task 8 → Task 9 | 需要 Track A 和 Track B 完成后才能完整运行 |

Track A 和 Track B 可以**完全并行**执行。Track C 在开发阶段可以先写组件（TS 类型先写），等 Track A 和 B 完成后再做联调测试。
