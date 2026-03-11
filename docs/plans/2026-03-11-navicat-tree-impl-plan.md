# Navicat 风格数据库导航树 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有扁平的"连接→表"树改造为多层级资源导航树，支持分组/连接/数据库/Schema/虚拟分类/对象/列六层结构，并行兼容 MySQL/PostgreSQL/Oracle。

**Architecture:** 节点类型系统（NodeType + TreeNode interface）+ 独立 Zustand treeStore + 新 Explorer 子组件树。Rust 层新增 `list_databases`/`list_schemas`/`list_objects` 命令，通过覆盖连接 config 中的 database 字段实现跨库查询。

**Tech Stack:** React 18 + TypeScript + Zustand + Tauri invoke + Rust sqlx

**设计文档:** `docs/plans/2026-03-11-navicat-style-db-tree-design.md`

---

## Task 1: SQLite Schema — 更新 `connection_groups` 表结构

**Files:**
- Modify: `schema/init.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/models.rs`

**背景:** 现有 `connection_groups` 表有 `parent_id` 字段，设计改为 `color` + `sort_order`（扁平分组，不嵌套）。`connections` 表已有 `group_id`，但缺少 `sort_order`。

**Step 1: 更新 `schema/init.sql`**

把 `connection_groups` 的 CREATE TABLE 改为：

```sql
CREATE TABLE IF NOT EXISTS connection_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

把 `connections` 的 CREATE TABLE 追加 `sort_order`：

```sql
CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_id INTEGER REFERENCES connection_groups(id) ON DELETE SET NULL,
    driver TEXT NOT NULL CHECK(driver IN ('mysql','postgres','oracle','sqlserver','sqlite')),
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    password_enc TEXT,
    extra_params TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 2: 更新 `migrations.rs` — 处理已存在的数据库**

SQLite 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，用 PRAGMA trick：

```rust
pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    let schema = include_str!("../../../schema/init.sql");
    conn.execute_batch(schema)?;

    // 处理已有数据库的字段迁移（忽略"column already exists"错误）
    let alter_stmts = [
        "ALTER TABLE connection_groups ADD COLUMN color TEXT",
        "ALTER TABLE connection_groups ADD COLUMN sort_order INTEGER DEFAULT 0",
        "ALTER TABLE connections ADD COLUMN sort_order INTEGER DEFAULT 0",
    ];
    for stmt in &alter_stmts {
        if let Err(e) = conn.execute_batch(stmt) {
            // SQLite 返回 "duplicate column name" 时静默忽略
            if !e.to_string().contains("duplicate column name") {
                return Err(crate::AppError::Other(format!("Migration failed: {}", e)));
            }
        }
    }

    log::info!("Database migrations completed");
    Ok(())
}
```

**Step 3: 更新 `models.rs` — ConnectionGroup 结构体**

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionGroup {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}
```

**Step 4: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译成功（可能有 dead_code 警告，忽略）

**Step 5: Commit**

```bash
git add schema/init.sql src-tauri/src/db/migrations.rs src-tauri/src/db/models.rs
git commit -m "feat: update connection_groups schema - replace parent_id with color/sort_order"
```

---

## Task 2: Rust — Group CRUD 函数 + Tauri 命令

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `db/mod.rs` 末尾添加 Group CRUD 函数**

```rust
/// 列出所有连接分组
pub fn list_groups() -> AppResult<Vec<models::ConnectionGroup>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups ORDER BY sort_order, name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows { results.push(row?); }
    Ok(results)
}

/// 创建连接分组
pub fn create_group(name: &str, color: Option<&str>) -> AppResult<models::ConnectionGroup> {
    let conn = get().lock().unwrap();
    conn.execute(
        "INSERT INTO connection_groups (name, color) VALUES (?1, ?2)",
        rusqlite::params![name, color],
    )?;
    let id = conn.last_insert_rowid();
    let group = conn.query_row(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups WHERE id = ?1",
        [id],
        |row| Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        }),
    )?;
    Ok(group)
}

/// 更新连接分组
pub fn update_group(id: i64, name: &str, color: Option<&str>) -> AppResult<models::ConnectionGroup> {
    let conn = get().lock().unwrap();
    conn.execute(
        "UPDATE connection_groups SET name = ?1, color = ?2 WHERE id = ?3",
        rusqlite::params![name, color, id],
    )?;
    let group = conn.query_row(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups WHERE id = ?1",
        [id],
        |row| Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        }),
    )?;
    Ok(group)
}

/// 删除连接分组（连接的 group_id 自动设为 NULL）
pub fn delete_group(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute("DELETE FROM connection_groups WHERE id = ?1", [id])?;
    Ok(())
}

/// 将连接移动到分组（group_id 为 None 表示移出分组）
pub fn move_connection_to_group(connection_id: i64, group_id: Option<i64>) -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute(
        "UPDATE connections SET group_id = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![group_id, connection_id],
    )?;
    Ok(())
}
```

**Step 2: 在 `commands.rs` 末尾添加 Group Tauri 命令**

```rust
// ============ 连接分组管理 ============

#[tauri::command]
pub async fn list_groups() -> AppResult<Vec<crate::db::models::ConnectionGroup>> {
    crate::db::list_groups()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn create_group(req: CreateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::create_group(&req.name, req.color.as_deref())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct UpdateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn update_group(id: i64, req: UpdateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::update_group(id, &req.name, req.color.as_deref())
}

#[tauri::command]
pub async fn delete_group(id: i64) -> AppResult<()> {
    crate::db::delete_group(id)
}

#[tauri::command]
pub async fn move_connection_to_group(connection_id: i64, group_id: Option<i64>) -> AppResult<()> {
    crate::db::move_connection_to_group(connection_id, group_id)
}
```

**Step 3: 在 `lib.rs` 的 `generate_handler![]` 中注册新命令**

在现有命令列表末尾追加：

```rust
commands::list_groups,
commands::create_group,
commands::update_group,
commands::delete_group,
commands::move_connection_to_group,
```

**Step 4: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译成功

**Step 5: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add group CRUD Rust commands (list/create/update/delete/move)"
```

---

## Task 3: Rust — DataSource Trait 扩展（list_databases / list_schemas / list_objects）

**Files:**
- Modify: `src-tauri/src/datasource/mod.rs`

**Step 1: 在 `datasource/mod.rs` 中添加新 trait 方法**

在 `DataSource` trait 末尾（`get_full_schema` 之前）添加默认空实现：

```rust
/// 列出所有数据库（MySQL: SHOW DATABASES / PG: pg_database）
async fn list_databases(&self) -> AppResult<Vec<String>> {
    Ok(vec![])
}

/// 列出 Schema（PostgreSQL/Oracle 专用，MySQL 无此层）
async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
    Ok(vec![])
}

/// 列出指定 category 的对象（tables/views/functions/procedures/triggers/events/sequences）
async fn list_objects(&self, _database: &str, _schema: Option<&str>, _category: &str) -> AppResult<Vec<String>> {
    Ok(vec![])
}
```

**Step 2: 添加辅助函数 `create_datasource_with_db`**

在 `create_datasource` 函数下方追加：

```rust
/// 用覆盖的 database 创建数据源（用于跨库查询）
pub async fn create_datasource_with_db(
    config: &ConnectionConfig,
    database: &str,
) -> AppResult<Box<dyn DataSource>> {
    let mut cfg = config.clone();
    cfg.database = database.to_string();
    create_datasource(&cfg).await
}
```

同时为 `ConnectionConfig` 派生 `Clone`（如果还没有的话）：
检查 `ConnectionConfig` 是否已有 `#[derive(Clone)]`。若没有，在其 derive 中添加 `Clone`。

**Step 3: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译成功

**Step 4: Commit**

```bash
git add src-tauri/src/datasource/mod.rs
git commit -m "feat: extend DataSource trait with list_databases/list_schemas/list_objects"
```

---

## Task 4: Rust — MySQL DataSource 实现新 trait 方法

**Files:**
- Modify: `src-tauri/src/datasource/mysql.rs`

**Step 1: 在 MySQL DataSource 的 `impl DataSource` 块中添加实现**

在 `get_procedures` 实现之后添加：

```rust
async fn list_databases(&self) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
        .fetch_all(&self.pool)
        .await?;
    Ok(rows.into_iter().map(|(name,)| name).collect())
}

async fn list_objects(&self, database: &str, _schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
    let names: Vec<String> = match category {
        "tables" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "views" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "functions" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "procedures" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "triggers" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "events" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME"
            ).bind(database).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        _ => vec![],
    };
    Ok(names)
}
```

**Step 2: 验证编译**

```bash
cd src-tauri && cargo check
```

**Step 3: Commit**

```bash
git add src-tauri/src/datasource/mysql.rs
git commit -m "feat: implement list_databases + list_objects for MySQL"
```

---

## Task 5: Rust — PostgreSQL DataSource 实现新 trait 方法

**Files:**
- Modify: `src-tauri/src/datasource/postgres.rs`

**Step 1: 在 PostgreSQL DataSource 的 `impl DataSource` 块中添加实现**

```rust
async fn list_databases(&self) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
    ).fetch_all(&self.pool).await?;
    Ok(rows.into_iter().map(|(n,)| n).collect())
}

async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
    // _database 参数忽略：已通过 create_datasource_with_db 连接到目标库
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
           AND nspname NOT LIKE 'pg_temp_%'
           AND nspname NOT LIKE 'pg_toast_temp_%'
         ORDER BY nspname"
    ).fetch_all(&self.pool).await?;
    Ok(rows.into_iter().map(|(n,)| n).collect())
}

async fn list_objects(&self, _database: &str, schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
    let schema = schema.unwrap_or("public");
    let names: Vec<String> = match category {
        "tables" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "views" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT viewname FROM pg_views WHERE schemaname = $1 ORDER BY viewname"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "functions" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT p.proname FROM pg_proc p
                 JOIN pg_namespace n ON p.pronamespace = n.oid
                 WHERE n.nspname = $1 AND p.prokind = 'f'
                 ORDER BY p.proname"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "procedures" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT p.proname FROM pg_proc p
                 JOIN pg_namespace n ON p.pronamespace = n.oid
                 WHERE n.nspname = $1 AND p.prokind = 'p'
                 ORDER BY p.proname"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "triggers" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT DISTINCT trigger_name FROM information_schema.triggers
                 WHERE trigger_schema = $1 ORDER BY trigger_name"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        "sequences" => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT sequence_name FROM information_schema.sequences
                 WHERE sequence_schema = $1 ORDER BY sequence_name"
            ).bind(schema).fetch_all(&self.pool).await?;
            rows.into_iter().map(|(n,)| n).collect()
        }
        _ => vec![],
    };
    Ok(names)
}
```

**Step 2: 验证编译**

```bash
cd src-tauri && cargo check
```

**Step 3: Commit**

```bash
git add src-tauri/src/datasource/postgres.rs
git commit -m "feat: implement list_databases/list_schemas/list_objects for PostgreSQL"
```

---

## Task 6: Rust — 新增树查询 Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `commands.rs` 末尾追加三个树查询命令**

```rust
// ============ 导航树查询命令 ============

#[tauri::command]
pub async fn list_databases(connection_id: i64) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.list_databases().await
}

#[tauri::command]
pub async fn list_schemas(connection_id: i64, database: String) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_schemas(&database).await
}

#[tauri::command]
pub async fn list_objects(
    connection_id: i64,
    database: String,
    schema: Option<String>,
    category: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_objects(&database, schema.as_deref(), &category).await
}
```

**Step 2: 在 `lib.rs` 中注册新命令**

```rust
commands::list_databases,
commands::list_schemas,
commands::list_objects,
```

**Step 3: 验证编译**

```bash
cd src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add list_databases/list_schemas/list_objects Tauri commands"
```

---

## Task 7: TypeScript — 类型定义

**Files:**
- Modify: `src/types/index.ts`

**Step 1: 在 `types/index.ts` 末尾追加新类型**

```typescript
// ============ 导航树类型 ============

export type NodeType =
  | 'group'
  | 'connection'
  | 'database'
  | 'schema'
  | 'category'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'event'
  | 'sequence'
  | 'column';

export type CategoryKey = 'tables' | 'views' | 'functions' | 'procedures' | 'triggers' | 'events' | 'sequences';

export interface NodeMeta {
  connectionId?: number;
  driver?: string;
  database?: string;
  schema?: string;
  objectName?: string;
}

export interface TreeNode {
  id: string;           // 路径式唯一 ID: "conn_1/db_mydb/schema_public/cat_tables/table_users"
  nodeType: NodeType;
  label: string;
  parentId: string | null;
  hasChildren: boolean;
  loaded: boolean;      // 子节点是否已从后端加载
  meta: NodeMeta;
}

export interface ConnectionGroup {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
}
```

**Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add TreeNode, NodeType, ConnectionGroup TypeScript types"
```

---

## Task 8: TypeScript — 创建 Zustand Tree Store

**Files:**
- Create: `src/store/treeStore.ts`
- Modify: `src/store/index.ts`

**Step 1: 创建 `src/store/treeStore.ts`**

```typescript
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode, NodeType, CategoryKey, ConnectionGroup } from '../types';

// 各数据库方言支持的 Category 列表
const CATEGORIES_BY_DRIVER: Record<string, CategoryKey[]> = {
  mysql: ['tables', 'views', 'functions', 'procedures', 'triggers', 'events'],
  postgres: ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  oracle: ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  sqlserver: ['tables', 'views', 'functions', 'procedures', 'triggers'],
};

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  tables: 'Tables',
  views: 'Views',
  functions: 'Functions',
  procedures: 'Procedures',
  triggers: 'Triggers',
  events: 'Events',
  sequences: 'Sequences',
};

function makeCategoryNodes(parentId: string, driver: string, meta: TreeNode['meta']): TreeNode[] {
  const cats = CATEGORIES_BY_DRIVER[driver] ?? ['tables', 'views'];
  return cats.map((cat): TreeNode => ({
    id: `${parentId}/cat_${cat}`,
    nodeType: 'category',
    label: CATEGORY_LABELS[cat],
    parentId,
    hasChildren: true,
    loaded: false,
    meta: { ...meta, objectName: cat },
  }));
}

interface TreeStore {
  nodes: Map<string, TreeNode>;
  searchIndex: Map<string, TreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  loadingIds: Set<string>;

  // 启动时初始化：加载 Groups + Connections
  init: () => Promise<void>;
  // 懒加载子节点
  loadChildren: (nodeId: string) => Promise<void>;
  // 展开/折叠
  toggleExpand: (nodeId: string) => void;
  // 选中
  selectNode: (nodeId: string) => void;
  // 刷新某节点的子节点
  refreshNode: (nodeId: string) => Promise<void>;
  // 前端搜索
  search: (query: string) => TreeNode[];
  // 添加一批节点到 store
  _addNodes: (nodes: TreeNode[]) => void;
  // 删除某节点及其所有子孙节点
  _removeSubtree: (nodeId: string) => void;
}

export const useTreeStore = create<TreeStore>((set, get) => ({
  nodes: new Map(),
  searchIndex: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  loadingIds: new Set(),

  init: async () => {
    const [groups, connections] = await Promise.all([
      invoke<{ id: number; name: string; color: string | null; sort_order: number; created_at: string }[]>('list_groups'),
      invoke<{ id: number; name: string; group_id: number | null; driver: string }[]>('list_connections'),
    ]);

    const newNodes = new Map<string, TreeNode>();

    // 创建 Group 节点
    for (const g of groups) {
      const node: TreeNode = {
        id: `group_${g.id}`,
        nodeType: 'group',
        label: g.name,
        parentId: null,
        hasChildren: true,
        loaded: false,
        meta: {},
      };
      newNodes.set(node.id, node);
    }

    // 创建 Connection 节点
    for (const c of connections) {
      const parentId = c.group_id ? `group_${c.group_id}` : null;
      const node: TreeNode = {
        id: `conn_${c.id}`,
        nodeType: 'connection',
        label: c.name,
        parentId,
        hasChildren: true,
        loaded: false,
        meta: { connectionId: c.id, driver: c.driver },
      };
      newNodes.set(node.id, node);
    }

    set({ nodes: newNodes, searchIndex: new Map(newNodes) });
  },

  loadChildren: async (nodeId: string) => {
    const { nodes, loadingIds } = get();
    const node = nodes.get(nodeId);
    if (!node || node.loaded || loadingIds.has(nodeId)) return;

    set(s => ({ loadingIds: new Set([...s.loadingIds, nodeId]) }));

    try {
      let children: TreeNode[] = [];

      if (node.nodeType === 'connection') {
        // 连接打开：加载数据库列表 + 预建 Category 节点
        const databases = await invoke<string[]>('list_databases', {
          connectionId: node.meta.connectionId,
        });
        const driver = node.meta.driver ?? 'mysql';
        const needsSchema = ['postgres', 'oracle'].includes(driver);

        for (const db of databases) {
          const dbId = `${nodeId}/db_${db}`;
          const dbNode: TreeNode = {
            id: dbId,
            nodeType: 'database',
            label: db,
            parentId: nodeId,
            hasChildren: true,
            loaded: needsSchema ? false : true,  // MySQL: 直接预建 Category
            meta: { ...node.meta, database: db },
          };
          children.push(dbNode);

          if (!needsSchema) {
            // MySQL: database 下直接挂 Category
            children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
          }
        }
      } else if (node.nodeType === 'database') {
        const driver = node.meta.driver ?? 'postgres';
        if (['postgres', 'oracle'].includes(driver)) {
          // PG/Oracle: 加载 Schema 列表
          const schemas = await invoke<string[]>('list_schemas', {
            connectionId: node.meta.connectionId,
            database: node.meta.database,
          });
          for (const schema of schemas) {
            const schemaId = `${nodeId}/schema_${schema}`;
            const schemaNode: TreeNode = {
              id: schemaId,
              nodeType: 'schema',
              label: schema,
              parentId: nodeId,
              hasChildren: true,
              loaded: true,  // 直接预建 Category
              meta: { ...node.meta, schema },
            };
            children.push(schemaNode);
            children.push(...makeCategoryNodes(schemaId, driver, { ...node.meta, schema }));
          }
        }
      } else if (node.nodeType === 'category') {
        // 加载具体对象列表
        const category = node.meta.objectName ?? 'tables';
        const objects = await invoke<string[]>('list_objects', {
          connectionId: node.meta.connectionId,
          database: node.meta.database,
          schema: node.meta.schema ?? null,
          category,
        });
        const leafType = category.slice(0, -1) as NodeType; // 'tables' -> 'table'
        for (const name of objects) {
          const leafId = `${nodeId}/${leafType}_${name}`;
          const hasChildren = ['table', 'view'].includes(leafType);
          children.push({
            id: leafId,
            nodeType: leafType,
            label: name,
            parentId: nodeId,
            hasChildren,
            loaded: false,
            meta: { ...node.meta, objectName: name },
          });
        }
      } else if (node.nodeType === 'table' || node.nodeType === 'view') {
        // 加载列详情
        const detail = await invoke<{ columns: { name: string; data_type: string; is_primary_key: boolean }[] }>(
          'get_table_detail',
          { connectionId: node.meta.connectionId, table: node.meta.objectName }
        );
        for (const col of detail.columns) {
          children.push({
            id: `${nodeId}/col_${col.name}`,
            nodeType: 'column',
            label: col.name,
            parentId: nodeId,
            hasChildren: false,
            loaded: true,
            meta: { ...node.meta, objectName: col.name },
          });
        }
      }

      get()._addNodes(children);

      // 标记当前节点已加载
      set(s => {
        const newNodes = new Map(s.nodes);
        const updated = newNodes.get(nodeId);
        if (updated) newNodes.set(nodeId, { ...updated, loaded: true });
        return { nodes: newNodes };
      });
    } finally {
      set(s => {
        const newLoading = new Set(s.loadingIds);
        newLoading.delete(nodeId);
        return { loadingIds: newLoading };
      });
    }
  },

  toggleExpand: (nodeId: string) => {
    const node = get().nodes.get(nodeId);
    if (!node) return;
    set(s => {
      const newExpanded = new Set(s.expandedIds);
      if (newExpanded.has(nodeId)) {
        newExpanded.delete(nodeId);
      } else {
        newExpanded.add(nodeId);
        // 触发懒加载（不阻塞 UI）
        if (!node.loaded) {
          get().loadChildren(nodeId);
        }
      }
      return { expandedIds: newExpanded };
    });
  },

  selectNode: (nodeId: string) => set({ selectedId: nodeId }),

  refreshNode: async (nodeId: string) => {
    get()._removeSubtree(nodeId);
    // 重置 loaded 状态
    set(s => {
      const newNodes = new Map(s.nodes);
      const node = newNodes.get(nodeId);
      if (node) newNodes.set(nodeId, { ...node, loaded: false });
      return { nodes: newNodes };
    });
    await get().loadChildren(nodeId);
  },

  search: (query: string): TreeNode[] => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return Array.from(get().searchIndex.values()).filter(n =>
      n.label.toLowerCase().includes(q)
    );
  },

  _addNodes: (newNodes: TreeNode[]) => {
    set(s => {
      const nodes = new Map(s.nodes);
      const searchIndex = new Map(s.searchIndex);
      for (const n of newNodes) {
        nodes.set(n.id, n);
        searchIndex.set(n.id, n);
      }
      return { nodes, searchIndex };
    });
  },

  _removeSubtree: (nodeId: string) => {
    set(s => {
      const nodes = new Map(s.nodes);
      const searchIndex = new Map(s.searchIndex);
      const expandedIds = new Set(s.expandedIds);
      // 递归找所有子孙节点
      const toRemove: string[] = [];
      const queue = [nodeId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const [key, node] of nodes.entries()) {
          if (node.parentId === id) {
            toRemove.push(key);
            queue.push(key);
          }
        }
      }
      for (const id of toRemove) {
        nodes.delete(id);
        searchIndex.delete(id);
        expandedIds.delete(id);
      }
      return { nodes, searchIndex, expandedIds };
    });
  },
}));
```

**Step 2: 在 `src/store/index.ts` 中导出 treeStore**

```typescript
export { useTreeStore } from './treeStore';
```

**Step 3: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/store/treeStore.ts src/store/index.ts
git commit -m "feat: create Zustand treeStore with lazy-load and search support"
```

---

## Task 9: Frontend — TreeNode 组件

**Files:**
- Create: `src/components/Explorer/TreeNode.tsx`

**注意:** 本文件替代现有 `TreeItem.tsx` 的角色，但保留 `TreeItem.tsx` 不删除（仍可能被其他地方引用），等全部迁移完再清理。

**Step 1: 创建 `src/components/Explorer/TreeNode.tsx`**

```tsx
import React from 'react';
import {
  ChevronDown, ChevronRight, Loader2,
  FolderOpen, DatabaseZap, Database, Layers, TableProperties,
  LayoutDashboard, Code2, GitBranch, Zap, List, Columns3,
  Eye, Hash
} from 'lucide-react';
import type { NodeType, TreeNode as TreeNodeType } from '../../types';

// 每种 nodeType 对应的图标
const NODE_ICONS: Record<NodeType, React.ElementType> = {
  group: FolderOpen,
  connection: DatabaseZap,
  database: Database,
  schema: Layers,
  category: List,
  table: TableProperties,
  view: Eye,
  function: Code2,
  procedure: GitBranch,
  trigger: Zap,
  event: Hash,
  sequence: Hash,
  column: Columns3,
};

interface TreeNodeProps {
  node: TreeNodeType;
  indent: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  indent,
  isExpanded,
  isSelected,
  isLoading,
  onClick,
  onDoubleClick,
  onContextMenu,
}) => {
  const Icon = NODE_ICONS[node.nodeType] ?? LayoutDashboard;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      navigator.clipboard.writeText(node.label);
    }
    if (e.key === 'Enter' && onDoubleClick) {
      onDoubleClick();
    }
  };

  return (
    <div
      className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none select-none ${
        isSelected ? 'bg-[#1e2d42]' : ''
      }`}
      style={{ paddingLeft: `${indent * 12 + 8}px` }}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* 展开箭头 / 加载 spinner */}
      <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
        {isLoading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : node.hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </div>

      {/* 节点图标 */}
      <Icon
        size={14}
        className={`mr-1.5 flex-shrink-0 ${isSelected ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`}
      />

      {/* 节点标签 */}
      <span
        className={`text-[13px] truncate ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}
      >
        {node.label}
      </span>
    </div>
  );
};
```

**Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/Explorer/TreeNode.tsx
git commit -m "feat: add TreeNode component with nodeType-based icons"
```

---

## Task 10: Frontend — ContextMenu 组件

**Files:**
- Create: `src/components/Explorer/ContextMenu.tsx`

**Step 1: 创建 `src/components/Explorer/ContextMenu.tsx`**

```tsx
import React, { useEffect, useRef } from 'react';
import {
  PlugZap, Unplug, FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, Sparkles
} from 'lucide-react';
import type { TreeNode } from '../../types';

interface MenuItem {
  label: string;
  icon: React.ElementType;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
}

interface ContextMenuProps {
  node: TreeNode;
  x: number;
  y: number;
  isConnected: boolean;  // connection 节点是否已连接
  onClose: () => void;
  onOpenConnection: () => void;
  onCloseConnection: () => void;
  onNewQuery: () => void;
  onRefresh: () => void;
  onEditConnection: () => void;
  onDeleteConnection: () => void;
  onCreateTable: () => void;
  onAiCreateTable: () => void;
  onOpenTableData: () => void;
  onEditTable: () => void;
  onManageIndexes: () => void;
  onDropTable: () => void;
  onCopyName: () => void;
  onCreateGroup: () => void;
  onRenameGroup: () => void;
  onDeleteGroup: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  node, x, y, isConnected, onClose,
  onOpenConnection, onCloseConnection, onNewQuery, onRefresh,
  onEditConnection, onDeleteConnection, onCreateTable, onAiCreateTable,
  onOpenTableData, onEditTable, onManageIndexes, onDropTable, onCopyName,
  onCreateGroup, onRenameGroup, onDeleteGroup,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const getMenuItems = (): MenuItem[] => {
    switch (node.nodeType) {
      case 'group':
        return [
          { label: '新建连接', icon: FilePlus, onClick: onCreateGroup },
          { label: '重命名分组', icon: Pencil, onClick: onRenameGroup },
          { label: '删除分组', icon: Trash2, onClick: onDeleteGroup, danger: true, dividerBefore: true },
        ];
      case 'connection':
        return [
          { label: '打开连接', icon: PlugZap, onClick: onOpenConnection, disabled: isConnected },
          { label: '关闭连接', icon: Unplug, onClick: onCloseConnection, disabled: !isConnected },
          { label: '新建查询', icon: FilePlus, onClick: onNewQuery, disabled: !isConnected },
          { label: '刷新', icon: RefreshCw, onClick: onRefresh, dividerBefore: true },
          { label: '编辑连接', icon: Pencil, onClick: onEditConnection },
          { label: '删除连接', icon: Trash2, onClick: onDeleteConnection, danger: true, dividerBefore: true },
        ];
      case 'database':
      case 'schema':
        return [
          { label: '新建查询', icon: FilePlus, onClick: onNewQuery },
          { label: '刷新', icon: RefreshCw, onClick: onRefresh },
        ];
      case 'category':
        if (node.meta.objectName === 'tables') {
          return [
            { label: '新建表', icon: FilePlus2, onClick: onCreateTable },
            { label: 'AI 建表', icon: Sparkles, onClick: onAiCreateTable },
            { label: '刷新', icon: RefreshCw, onClick: onRefresh },
          ];
        }
        return [{ label: '刷新', icon: RefreshCw, onClick: onRefresh }];
      case 'table':
        return [
          { label: '打开表数据', icon: Eye, onClick: onOpenTableData },
          { label: '新建查询', icon: FilePlus, onClick: onNewQuery },
          { label: '编辑表结构', icon: FileEdit, onClick: onEditTable, dividerBefore: true },
          { label: '管理索引', icon: ListTree, onClick: onManageIndexes },
          { label: '删除表', icon: Trash2, onClick: onDropTable, danger: true, dividerBefore: true },
        ];
      case 'view':
        return [
          { label: '打开视图数据', icon: Eye, onClick: onOpenTableData },
          { label: '新建查询', icon: FilePlus, onClick: onNewQuery },
          { label: '删除视图', icon: Trash2, onClick: onDropTable, danger: true, dividerBefore: true },
        ];
      case 'column':
        return [
          { label: '复制列名', icon: Copy, onClick: onCopyName },
        ];
      default:
        return [{ label: '刷新', icon: RefreshCw, onClick: onRefresh }];
    }
  };

  const items = getMenuItems();

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.dividerBefore && <div className="h-px bg-[#2a3f5a] my-1" />}
          <button
            disabled={item.disabled}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
              item.disabled
                ? 'opacity-40 cursor-not-allowed text-[#7a9bb8]'
                : item.danger
                ? 'text-red-400 hover:bg-[#003d2f] hover:text-red-300'
                : 'text-[#c8daea] hover:bg-[#003d2f] hover:text-white'
            }`}
            onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
          >
            <item.icon size={13} />
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
```

**Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/Explorer/ContextMenu.tsx
git commit -m "feat: add unified ContextMenu component dispatched by nodeType"
```

---

## Task 11: Frontend — DBTree 渲染引擎

**Files:**
- Create: `src/components/Explorer/DBTree.tsx`

**Step 1: 创建 `src/components/Explorer/DBTree.tsx`**

```tsx
import React, { useState } from 'react';
import { useTreeStore } from '../../store/treeStore';
import { TreeNode } from './TreeNode';
import { ContextMenu } from './ContextMenu';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode as TreeNodeType } from '../../types';
import { TableManageDialog } from '../TableManageDialog';
import { IndexManager } from '../IndexManager';
import { AiCreateTableDialog } from '../AiCreateTableDialog';
import { ConnectionModal } from '../ConnectionModal';

interface DBTreeProps {
  searchQuery: string;
  showToast: (msg: string) => void;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string) => void;
  activeConnectionIds: Set<number>;  // 已打开的连接 ID 集合
  onOpenConnection: (connectionId: number) => void;
  onCloseConnection: (connectionId: number) => void;
}

// 从 nodes Map 计算当前可见节点列表（扁平有序）
function computeVisibleNodes(
  nodes: Map<string, TreeNodeType>,
  expandedIds: Set<string>
): TreeNodeType[] {
  const result: TreeNodeType[] = [];

  function visit(parentId: string | null, depth: number) {
    // 找所有 parentId 匹配且排序一致的子节点
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const node of children) {
      result.push(node);
      if (expandedIds.has(node.id)) {
        visit(node.id, depth + 1);
      }
    }
  }

  visit(null, 0);
  return result;
}

// 计算节点的缩进层级（通过 parentId 链长度）
function getIndentLevel(node: TreeNodeType, nodes: Map<string, TreeNodeType>): number {
  let level = 0;
  let current = node;
  while (current.parentId !== null) {
    const parent = nodes.get(current.parentId);
    if (!parent) break;
    level++;
    current = parent;
  }
  return level;
}

export const DBTree: React.FC<DBTreeProps> = ({
  searchQuery,
  showToast,
  onNewQuery,
  onOpenTableData,
  activeConnectionIds,
  onOpenConnection,
  onCloseConnection,
}) => {
  const { nodes, expandedIds, selectedId, loadingIds, toggleExpand, selectNode, refreshNode, search } = useTreeStore();

  const [contextMenu, setContextMenu] = useState<{ node: TreeNodeType; x: number; y: number } | null>(null);
  const [tableManageDialog, setTableManageDialog] = useState<{ connectionId: number; tableName?: string } | null>(null);
  const [indexManagerState, setIndexManagerState] = useState<{ connectionId: number; tableName: string } | null>(null);
  const [showAiCreateTable, setShowAiCreateTable] = useState(false);
  const [editingConn, setEditingConn] = useState<number | null>(null);

  // 搜索模式 vs 正常树模式
  const visibleNodes: TreeNodeType[] = searchQuery.trim()
    ? search(searchQuery)
    : computeVisibleNodes(nodes, expandedIds);

  const handleNodeClick = (node: TreeNodeType) => {
    selectNode(node.id);
    if (node.hasChildren) {
      toggleExpand(node.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, node: TreeNodeType) => {
    e.preventDefault();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  };

  const getConnectionId = (node: TreeNodeType): number => node.meta.connectionId ?? 0;

  if (visibleNodes.length === 0 && !searchQuery) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
        <p>暂无连接</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {visibleNodes.map(node => (
        <TreeNode
          key={node.id}
          node={node}
          indent={searchQuery ? 0 : getIndentLevel(node, nodes)}
          isExpanded={expandedIds.has(node.id)}
          isSelected={selectedId === node.id}
          isLoading={loadingIds.has(node.id)}
          onClick={() => handleNodeClick(node)}
          onDoubleClick={
            node.nodeType === 'connection'
              ? () => onOpenConnection(getConnectionId(node))
              : node.nodeType === 'table' || node.nodeType === 'view'
              ? () => onOpenTableData(node.label, getConnectionId(node), node.meta.database)
              : undefined
          }
          onContextMenu={(e) => handleContextMenu(e, node)}
        />
      ))}

      {contextMenu && (
        <ContextMenu
          node={contextMenu.node}
          x={contextMenu.x}
          y={contextMenu.y}
          isConnected={activeConnectionIds.has(getConnectionId(contextMenu.node))}
          onClose={() => setContextMenu(null)}
          onOpenConnection={() => onOpenConnection(getConnectionId(contextMenu.node))}
          onCloseConnection={() => onCloseConnection(getConnectionId(contextMenu.node))}
          onNewQuery={() => {
            const n = contextMenu.node;
            onNewQuery(getConnectionId(n), n.label, n.meta.database, n.meta.schema);
          }}
          onRefresh={() => refreshNode(contextMenu.node.id)}
          onEditConnection={() => setEditingConn(getConnectionId(contextMenu.node))}
          onDeleteConnection={async () => {
            if (!window.confirm('确定要删除此连接？')) return;
            await invoke('delete_connection', { id: getConnectionId(contextMenu.node) });
            useTreeStore.getState().init();
            showToast('连接已删除');
          }}
          onCreateTable={() => setTableManageDialog({ connectionId: getConnectionId(contextMenu.node) })}
          onAiCreateTable={() => setShowAiCreateTable(true)}
          onOpenTableData={() => {
            const n = contextMenu.node;
            onOpenTableData(n.label, getConnectionId(n), n.meta.database);
          }}
          onEditTable={() => {
            const n = contextMenu.node;
            setTableManageDialog({ connectionId: getConnectionId(n), tableName: n.label });
          }}
          onManageIndexes={() => {
            const n = contextMenu.node;
            setIndexManagerState({ connectionId: getConnectionId(n), tableName: n.label });
          }}
          onDropTable={async () => {
            const n = contextMenu.node;
            if (!window.confirm(`确定要删除表 ${n.label}？`)) return;
            setTableManageDialog({ connectionId: getConnectionId(n), tableName: n.label });
          }}
          onCopyName={() => {
            navigator.clipboard.writeText(contextMenu.node.label);
            showToast('已复制');
          }}
          onCreateGroup={() => showToast('新建分组功能开发中')}
          onRenameGroup={() => showToast('重命名分组功能开发中')}
          onDeleteGroup={async () => {
            if (!window.confirm('确定要删除此分组？连接将移至未分组。')) return;
            const id = parseInt(contextMenu.node.id.replace('group_', ''));
            await invoke('delete_group', { id });
            useTreeStore.getState().init();
            showToast('分组已删除');
          }}
        />
      )}

      {tableManageDialog && (
        <TableManageDialog
          connectionId={tableManageDialog.connectionId}
          tableName={tableManageDialog.tableName}
          onClose={() => setTableManageDialog(null)}
          onSuccess={() => {
            setTableManageDialog(null);
            showToast('操作成功');
          }}
          showToast={showToast}
        />
      )}

      {indexManagerState && (
        <IndexManager
          connectionId={indexManagerState.connectionId}
          tableName={indexManagerState.tableName}
          onClose={() => setIndexManagerState(null)}
          showToast={showToast}
        />
      )}

      {showAiCreateTable && (
        <AiCreateTableDialog
          onClose={() => setShowAiCreateTable(false)}
          showToast={showToast}
          onRefresh={() => {}}
        />
      )}

      {editingConn !== null && (
        <ConnectionModal
          connection={undefined}
          onClose={() => { setEditingConn(null); useTreeStore.getState().init(); }}
        />
      )}
    </div>
  );
};
```

**Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/Explorer/DBTree.tsx
git commit -m "feat: add DBTree rendering engine with lazy-load and context menu"
```

---

## Task 12: Frontend — 重构 Explorer/index.tsx

**Files:**
- Modify: `src/components/Explorer/index.tsx`

**Step 1: 替换 `Explorer/index.tsx` 内容**

新实现聚焦于：搜索栏、顶部操作按钮、初始化 treeStore、渲染 DBTree。

```tsx
import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, X, DatabaseZap } from 'lucide-react';
import { useTreeStore } from '../../store/treeStore';
import { DBTree } from './DBTree';
import { ConnectionModal } from '../ConnectionModal';

interface ExplorerProps {
  isSidebarOpen: boolean;
  sidebarWidth: number;
  handleSidebarResize: (e: React.MouseEvent) => void;
  showToast: (msg: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  activeActivity: string;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string) => void;
}

export const Explorer: React.FC<ExplorerProps> = ({
  isSidebarOpen,
  sidebarWidth,
  handleSidebarResize,
  showToast,
  searchQuery,
  setSearchQuery,
  activeActivity,
  onNewQuery,
  onOpenTableData,
}) => {
  const { init, nodes } = useTreeStore();
  const [showModal, setShowModal] = useState(false);
  const [activeConnectionIds, setActiveConnectionIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    init();
  }, []);

  const handleOpenConnection = (connectionId: number) => {
    setActiveConnectionIds(prev => new Set([...prev, connectionId]));
    // 触发连接节点加载子节点
    const nodeId = `conn_${connectionId}`;
    const { nodes: n, toggleExpand, expandedIds } = useTreeStore.getState();
    if (!expandedIds.has(nodeId)) toggleExpand(nodeId);
  };

  const handleCloseConnection = (connectionId: number) => {
    setActiveConnectionIds(prev => {
      const next = new Set(prev);
      next.delete(connectionId);
      return next;
    });
  };

  if (!isSidebarOpen) return null;

  return (
    <>
      <div
        className="flex flex-col border-r border-[#1e2d42] bg-[#0d1117] flex-shrink-0 relative"
        style={{ width: sidebarWidth }}
      >
        {/* 可拖拽调整宽度手柄 */}
        <div
          className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-10 transition-colors"
          onMouseDown={handleSidebarResize}
        />

        {activeActivity === 'database' ? (
          <>
            {/* 顶部标题栏 */}
            <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42]">
              <span className="font-medium text-[#c8daea]">数据库</span>
              <div className="flex items-center space-x-2 text-[#7a9bb8]">
                <Plus
                  size={16}
                  className="cursor-pointer hover:text-[#c8daea]"
                  onClick={() => setShowModal(true)}
                />
                <RefreshCw
                  size={16}
                  className="cursor-pointer hover:text-[#c8daea]"
                  onClick={() => init()}
                />
              </div>
            </div>

            {/* 搜索栏 */}
            <div className="p-2 border-b border-[#1e2d42]">
              <div className="flex items-center bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 focus-within:border-[#00a98f] transition-colors">
                <Search size={14} className="text-[#7a9bb8] mr-1" />
                <input
                  type="text"
                  placeholder="搜索..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-transparent border-none outline-none text-[#c8daea] w-full text-xs placeholder-[#7a9bb8]"
                />
                {searchQuery && (
                  <X
                    size={14}
                    className="text-[#7a9bb8] ml-1 cursor-pointer hover:text-[#c8daea]"
                    onClick={() => setSearchQuery('')}
                  />
                )}
              </div>
            </div>

            {/* 树主体 */}
            {nodes.size === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
                <DatabaseZap size={24} className="mx-auto mb-2 opacity-30" />
                <p>暂无连接</p>
                <p
                  className="mt-1 text-[#00c9a7] cursor-pointer hover:underline"
                  onClick={() => setShowModal(true)}
                >
                  新建连接
                </p>
              </div>
            ) : (
              <DBTree
                searchQuery={searchQuery}
                showToast={showToast}
                onNewQuery={onNewQuery}
                onOpenTableData={onOpenTableData}
                activeConnectionIds={activeConnectionIds}
                onOpenConnection={handleOpenConnection}
                onCloseConnection={handleCloseConnection}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[#7a9bb8]">
            <p className="text-sm">选择左侧活动栏</p>
          </div>
        )}
      </div>

      {showModal && (
        <ConnectionModal
          onClose={() => { setShowModal(false); init(); }}
        />
      )}
    </>
  );
};
```

**Step 2: 更新 `App.tsx` 中对 Explorer 的调用**

`App.tsx` 中 `Explorer` 的 props 调用已有 `onTableClick` 和 `onNewQuery`，需调整为新的 props：

在 `App.tsx` 找到 `<Explorer` 标签，更新 props：

```tsx
<Explorer
  isSidebarOpen={isSidebarOpen}
  sidebarWidth={sidebarWidth}
  handleSidebarResize={handleSidebarResize}
  showToast={showToast}
  searchQuery={searchQuery}
  setSearchQuery={setSearchQuery}
  activeActivity={activeActivity}
  onNewQuery={(connectionId, connName, database, schema) =>
    handleNewQuery(connectionId, connName)
  }
  onOpenTableData={(tableName, connectionId, database) =>
    handleTableClick(tableName, database ?? connName)
  }
/>
```

同时删除 Explorer 中不再需要的 props：`expandedFolders`、`toggleFolder`。

**Step 3: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

Expected: 可能有 props 不匹配警告，逐一修复。

**Step 4: 运行前端开发服务验证**

```bash
npm run dev
```

在浏览器打开 http://localhost:1420 检查：
- 侧边栏正常显示连接列表（作为 tree 节点）
- 右键点击连接节点出现正确的菜单
- 双击连接节点触发展开

**Step 5: Commit**

```bash
git add src/components/Explorer/index.tsx src/App.tsx
git commit -m "feat: refactor Explorer to use DBTree + treeStore"
```

---

## Task 13: Frontend — SQL 编辑器上下文选择器

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/MainContent/index.tsx`（或新建查询 Tab 头部）

**背景:** 新建查询时，Tab 顶部需要显示"连接 ▼ › 数据库 ▼ › Schema ▼"选择器。

**Step 1: 在 `types/index.ts` 中补充查询上下文类型**

```typescript
export interface QueryContext {
  connectionId: number | null;
  database: string | null;
  schema: string | null;  // 仅 PG/Oracle
}
```

**Step 2: 在 `App.tsx` 中更新 `handleNewQuery`**

将函数签名扩展以接收可选的 database 和 schema：

```typescript
const handleNewQuery = (connId: number, connName: string, database?: string, schema?: string) => {
  const tabId = `query_${connId}_${Date.now()}`;
  const queryCount = tabs.filter(t => t.type === 'query').length + 1;
  setTabs(prev => [...prev, {
    id: tabId,
    type: 'query',
    title: `查询${queryCount}`,
    db: connName,
    queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
  }]);
  setActiveTab(tabId);
};
```

同时更新 `TabData` interface：

```typescript
export interface TabData {
  id: string;
  type: 'query' | 'table' | 'er_diagram';
  title: string;
  db?: string;
  queryContext?: {
    connectionId: number | null;
    database: string | null;
    schema: string | null;
  };
}
```

**Step 3: 在 `MainContent/index.tsx` 的 query Tab 顶部添加上下文选择器**

找到渲染 query Tab 内容的区域，在 Monaco Editor 上方添加上下文选择栏：

```tsx
{activeTabData?.type === 'query' && (
  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1e2d42] bg-[#0d1117] text-xs">
    <span className="text-[#7a9bb8]">上下文：</span>
    <select
      className="bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-0.5 text-[#c8daea] text-xs outline-none"
      value={activeTabData.queryContext?.connectionId ?? ''}
      onChange={(e) => {/* 更新 tab 的 queryContext.connectionId */}}
    >
      <option value="">选择连接...</option>
      {/* 从 useTreeStore 的 nodes 中筛选 connection 节点 */}
    </select>
    <span className="text-[#7a9bb8]">›</span>
    <select
      className="bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-0.5 text-[#c8daea] text-xs outline-none"
      value={activeTabData.queryContext?.database ?? ''}
      onChange={(e) => {/* 更新 database */}}
    >
      <option value="">选择数据库...</option>
    </select>
    {/* Schema 选择器（仅 PG/Oracle 显示） */}
  </div>
)}
```

**注意:** 上下文选择器的完整实现需要根据 `MainContent/index.tsx` 的具体结构调整。核心逻辑是：
1. 执行 SQL 前检查 `queryContext.connectionId` 和 `database` 是否已选
2. 若未选，`showToast('请先选择连接和数据库')`，阻止执行

**Step 4: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

**Step 5: 运行完整联调**

```bash
npm run tauri:dev
```

验证：
- 树展开正常（Group → Connection → Database → Category → Tables）
- MySQL 不显示 Schema 层
- PostgreSQL 显示 Schema 层
- 右键菜单按节点类型正确显示
- 新建查询 Tab 显示上下文选择器

**Step 6: Commit**

```bash
git add src/App.tsx src/components/MainContent/index.tsx
git commit -m "feat: add SQL editor context selector (connection/database/schema)"
```

---

## 完成检查清单

- [ ] `cargo check` 无错误
- [ ] `npx tsc --noEmit` 无类型错误
- [ ] MySQL 连接展开：Connection → Database(s) → 6个Category节点
- [ ] PostgreSQL 连接展开：Connection → Database(s) → Schema(s) → 6个Category节点
- [ ] Tables Category 展开：显示实际表名列表
- [ ] 表节点展开：显示列列表
- [ ] 视图节点展开：显示列列表（无视图定义）
- [ ] 右键 Connection：打开/关闭/新建查询/编辑/删除
- [ ] 右键 Database：新建查询/刷新
- [ ] 右键 Category(Tables)：新建表/AI建表/刷新
- [ ] 右键 Table：打开数据/新建查询/编辑/索引/删除
- [ ] 右键 Column：复制列名
- [ ] 搜索框：前端实时过滤，O(n) 无递归
- [ ] 新建查询 Tab 顶部显示上下文选择器
