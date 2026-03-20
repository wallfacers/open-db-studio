# Graph Virtual Relation Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为图谱新增虚拟关系层，支持列注释解析自动建边（comment）和画布手动编辑（user），三种来源（schema/comment/user）视觉区分，用户数据重建时永不覆盖。

**Architecture:** 数据层新增 `graph_edges.source` 列并移除 `edge_type` CHECK 约束；Rust 解析层在 `graph/comment_parser.rs` 实现注释标记解析，在 `run_graph_build` 新增步骤 3.5 调用；前端新增编辑模式开关、手动连线、视觉区分（颜色+线型+徽章）。

**Tech Stack:** Rust (rusqlite, regex), React 18 + TypeScript, ReactFlow (图谱画布), Tauri invoke

---

## Chunk 1: 数据层 — schema + migrations

### Task 1: `graph_edges` 新增 `source` 列 + 放宽 `edge_type` 约束

**Files:**
- Modify: `schema/init.sql` (graph_edges 建表语句)
- Modify: `src-tauri/src/db/migrations.rs` (新增迁移步骤)

#### 背景

当前 `schema/init.sql` 中 `graph_edges` 建表语句（第115-122行）：
- 没有 `source` 列
- `edge_type` 有 CHECK 约束只允许固定枚举值，不含 `user_defined`

`migrations.rs` 已有 `graph_nodes.source` 迁移，但无 `graph_edges` 相关迁移。

- [ ] **Step 1: 修改 `schema/init.sql` 的 `graph_edges` 建表语句**

将 `schema/init.sql` 第115-122行替换为（新增 `source` 列，移除 `edge_type` CHECK 约束）：

```sql
-- 图谱边
CREATE TABLE IF NOT EXISTS graph_edges (
    id         TEXT PRIMARY KEY,
    from_node  TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    to_node    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    edge_type  TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0,
    metadata   TEXT,
    source     TEXT NOT NULL DEFAULT 'schema'
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
```

注意：`edge_type` CHECK 约束移除（改为 Rust 层校验），新增 `source` 列和 source 索引。

- [ ] **Step 2: 在 `migrations.rs` 末尾（`log::info!("Database migrations completed")` 前）新增迁移 V10**

在 `src-tauri/src/db/migrations.rs` 第300行之前插入：

```rust
    // V10: graph_edges 新增 source 列 + 重建表移除 edge_type CHECK 约束
    // 步骤：检查 edge_type 约束 + source 列是否已迁移，若未迁移则重建表
    let graph_edges_sql: String = conn
        .query_row(
            "SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='table' AND name='graph_edges'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();

    let needs_edge_rebuild = graph_edges_sql.contains("CHECK(edge_type IN")
        || !graph_edges_sql.contains("source");

    if needs_edge_rebuild {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             BEGIN;
             CREATE TABLE graph_edges_new (
                 id        TEXT PRIMARY KEY,
                 from_node TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                 to_node   TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                 edge_type TEXT NOT NULL,
                 weight    REAL NOT NULL DEFAULT 1.0,
                 metadata  TEXT,
                 source    TEXT NOT NULL DEFAULT 'schema'
             );
             INSERT INTO graph_edges_new (id, from_node, to_node, edge_type, weight, metadata, source)
             SELECT id, from_node, to_node, edge_type, weight, metadata, 'schema'
             FROM graph_edges;
             DROP TABLE graph_edges;
             ALTER TABLE graph_edges_new RENAME TO graph_edges;
             CREATE INDEX IF NOT EXISTS idx_graph_edges_from   ON graph_edges(from_node);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_to     ON graph_edges(to_node);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
             COMMIT;
             PRAGMA foreign_keys = ON;",
        )?;
        log::info!("Migrated graph_edges: added source column, removed edge_type CHECK constraint");
    }
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```

期望：无错误（仅 warnings 可接受）

- [ ] **Step 4: Commit**

```bash
git add schema/init.sql src-tauri/src/db/migrations.rs
git commit -m "feat(db): graph_edges 新增 source 列，移除 edge_type CHECK 约束"
```

---

### Task 2: `GraphEdge` 结构体 + 前端接口新增 `source` 字段

**Files:**
- Modify: `src-tauri/src/graph/query.rs` (GraphEdge struct + SELECT 语句)
- Modify: `src/components/GraphExplorer/useGraphData.ts` (GraphEdge interface)

#### 背景

当前 `query.rs` 中 `GraphEdge`（第18-25行）没有 `source` 字段，SELECT 语句只读6列。`useGraphData.ts` 中 `GraphEdge` interface（第16-22行）也无 `source`。

- [ ] **Step 1: 更新 `query.rs` 的 `GraphEdge` 结构体**

将 `src-tauri/src/graph/query.rs` 第17-25行的 `GraphEdge` 替换为：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,
    pub weight: f64,
    pub metadata: Option<serde_json::Value>,
    pub source: Option<String>,
}
```

- [ ] **Step 2: 更新 `find_relevant_subgraph` 中的 edges SELECT（第155-175行）**

将查询语句改为包含 `source` 列：

```rust
    let mut stmt = conn.prepare(
        "SELECT id,from_node,to_node,edge_type,weight,metadata,source
         FROM graph_edges WHERE from_node=?1 OR to_node=?1"
    )?;
    // ...
    let rows = stmt.query_map([node_id], |row| {
        let meta_str: Option<String> = row.get(5)?;
        Ok(GraphEdge {
            id: row.get(0)?,
            from_node: row.get(1)?,
            to_node: row.get(2)?,
            edge_type: row.get(3)?,
            weight: row.get(4)?,
            metadata: meta_str.and_then(|s| serde_json::from_str(&s).ok()),
            source: row.get(6)?,
        })
    })?;
```

- [ ] **Step 3: 更新 `useGraphData.ts` 中 `GraphEdge` interface**

将 `src/components/GraphExplorer/useGraphData.ts` 第16-22行替换：

```typescript
export interface GraphEdge {
  id: string;
  from_node: string;
  to_node: string;
  edge_type: string;
  weight: number;
  source: string;
}
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | head -20
npx tsc --noEmit 2>&1 | head -20
```

期望：无错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/query.rs src/components/GraphExplorer/useGraphData.ts
git commit -m "feat(graph): GraphEdge 新增 source 字段"
```

---

## Chunk 2: 解析层 — 列注释解析器

### Task 3: 实现 `comment_parser.rs`

**Files:**
- Create: `src-tauri/src/graph/comment_parser.rs`
- Modify: `src-tauri/src/graph/mod.rs` (pub mod 注册)

#### 背景

需要支持4种注释标记格式（`@ref:table.col`、`@fk(...)`、`[ref:table.col]`、`$$ref(table.col)$$`），同一列多种格式去重。

- [ ] **Step 1: 写单元测试（TDD）**

创建 `src-tauri/src/graph/comment_parser.rs`，先写测试：

```rust
/// 列注释中提取的虚拟关系引用
#[derive(Debug, PartialEq, Clone)]
pub struct CommentRef {
    pub target_table: String,
    pub target_column: String,
    pub relation_type: String,  // 默认 "fk"
}

/// 解析列注释中的关系标记，返回去重后的引用列表
/// 支持格式：
///   @ref:table.col
///   @fk(table=orders,col=id,type=one_to_many)
///   [ref:table.col]
///   $$ref(table.col)$$
pub fn parse_comment_refs(comment: &str) -> Vec<CommentRef> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_at_ref_simple() {
        let refs = parse_comment_refs("关联用户 @ref:users.id");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "users");
        assert_eq!(refs[0].target_column, "id");
        assert_eq!(refs[0].relation_type, "fk");
    }

    #[test]
    fn test_at_fk_explicit() {
        let refs = parse_comment_refs("@fk(table=orders,col=order_id,type=one_to_many)");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "orders");
        assert_eq!(refs[0].target_column, "order_id");
        assert_eq!(refs[0].relation_type, "one_to_many");
    }

    #[test]
    fn test_bracket_ref() {
        let refs = parse_comment_refs("外键 [ref:products.id] 备注");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "products");
        assert_eq!(refs[0].target_column, "id");
    }

    #[test]
    fn test_dollar_ref() {
        let refs = parse_comment_refs("$$ref(orders.id)$$ 订单外键");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "orders");
        assert_eq!(refs[0].target_column, "id");
    }

    #[test]
    fn test_multiple_refs_dedup() {
        // 同一注释中多个引用，指向同一目标时去重
        let refs = parse_comment_refs("@ref:users.id [ref:users.id]");
        assert_eq!(refs.len(), 1, "同目标去重");
    }

    #[test]
    fn test_multiple_different_refs() {
        let refs = parse_comment_refs("@ref:users.id @ref:orders.order_id");
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn test_no_marker_returns_empty() {
        let refs = parse_comment_refs("普通注释，无标记");
        assert!(refs.is_empty());
    }

    #[test]
    fn test_empty_comment() {
        let refs = parse_comment_refs("");
        assert!(refs.is_empty());
    }

    #[test]
    fn test_at_fk_default_type() {
        // type 字段缺省时默认 "fk"
        let refs = parse_comment_refs("@fk(table=users,col=id)");
        assert_eq!(refs[0].relation_type, "fk");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test graph::comment_parser 2>&1 | tail -20
```

期望：编译错误（todo!() 实现缺失），确认测试框架正常

- [ ] **Step 3: 实现 `parse_comment_refs`**

在同文件中替换 `todo!()` 实现：

```rust
use std::collections::HashSet;

pub fn parse_comment_refs(comment: &str) -> Vec<CommentRef> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut result = Vec::new();

    // 模式1: @ref:table.col
    let re1 = regex::Regex::new(r"@ref:([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    for cap in re1.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    // 模式2: @fk(table=X,col=Y,type=Z) — type 可选
    let re2 = regex::Regex::new(r"@fk\(([^)]+)\)").unwrap();
    for cap in re2.captures_iter(comment) {
        let inner = &cap[1];
        let mut table = String::new();
        let mut col = String::new();
        let mut rel_type = "fk".to_string();
        for part in inner.split(',') {
            let kv: Vec<&str> = part.splitn(2, '=').collect();
            if kv.len() == 2 {
                match kv[0].trim() {
                    "table" => table = kv[1].trim().to_string(),
                    "col"   => col   = kv[1].trim().to_string(),
                    "type"  => rel_type = kv[1].trim().to_string(),
                    _ => {}
                }
            }
        }
        if !table.is_empty() && !col.is_empty() && seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: rel_type });
        }
    }

    // 模式3: [ref:table.col]
    let re3 = regex::Regex::new(r"\[ref:([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\]").unwrap();
    for cap in re3.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    // 模式4: $$ref(table.col)$$
    let re4 = regex::Regex::new(r"\$\$ref\(([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\)\$\$").unwrap();
    for cap in re4.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    result
}
```

- [ ] **Step 4: 在 `Cargo.toml` 中确认 `regex` 依赖存在**

```bash
grep "regex" src-tauri/Cargo.toml
```

若不存在则添加：`regex = "1"`（在 `[dependencies]` 下）

- [ ] **Step 5: 在 `graph/mod.rs` 中注册模块**

在 `src-tauri/src/graph/mod.rs` 第1行（现有 `pub mod cache;` 等之前或之后）添加：

```rust
pub mod comment_parser;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd src-tauri && cargo test graph::comment_parser 2>&1
```

期望：所有9个测试 PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/graph/comment_parser.rs src-tauri/src/graph/mod.rs src-tauri/Cargo.toml
git commit -m "feat(graph): 实现列注释虚拟关系解析器 comment_parser"
```

---

## Chunk 3: 解析层集成 — datasource + run_graph_build

### Task 4: `ColumnMeta` 新增 `comment` 字段 + MySQL/PostgreSQL 读注释

**Files:**
- Modify: `src-tauri/src/datasource/mod.rs` (ColumnMeta)
- Modify: `src-tauri/src/datasource/mysql.rs` (get_columns 读 COLUMN_COMMENT)
- Modify: `src-tauri/src/datasource/postgres.rs` (get_columns 读 pg_description)

#### 背景

`ColumnMeta`（`datasource/mod.rs` 第36-43行）没有 `comment` 字段。MySQL 和 PostgreSQL 的 `get_columns` 已有实现，需要扩展 SQL 读注释。

- [ ] **Step 1: `ColumnMeta` 新增 `comment` 字段**

将 `src-tauri/src/datasource/mod.rs` 第36-43行替换：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,  // 列注释原文
}
```

- [ ] **Step 2: 编译检查，修复所有因新字段导致的结构体初始化错误**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -30
```

找到所有 `ColumnMeta { ... }` 初始化位置，补充 `comment: None`（或适当值）。常见位置：
- `src-tauri/src/datasource/mysql.rs` 的 `get_columns` 实现
- `src-tauri/src/datasource/postgres.rs` 的 `get_columns` 实现
- `src-tauri/src/datasource/sqlite.rs`（如有）
- 其他 datasource 实现文件

- [ ] **Step 3: 扩展 `mysql.rs` 的 `get_columns` SQL 以读取 `COLUMN_COMMENT`**

找到 `mysql.rs` 中 `get_columns` 的 SELECT 语句，在 SELECT 列表中加入 `COLUMN_COMMENT`：

示例改动（具体行号请先 Read mysql.rs 确认）：

```sql
-- 原 SQL（示意，实际以文件为准）
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION

-- 改为
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
```

在结构体映射时读取新列，设置 `comment: Some(comment_str).filter(|s| !s.is_empty())`

- [ ] **Step 4: 扩展 `postgres.rs` 的 `get_columns` SQL 以读取列注释**

找到 `postgres.rs` 中 `get_columns` 的 SELECT 语句，LEFT JOIN `pg_description`：

```sql
-- 改为（示意）
SELECT
    c.column_name, c.data_type, c.is_nullable, c.column_default,
    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
    '' as extra,
    pd.description as comment
FROM information_schema.columns c
LEFT JOIN (
    SELECT a.attname as column_name, d.description
    FROM pg_description d
    JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
    JOIN pg_class cls ON cls.oid = d.objoid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE cls.relname = $2 AND ns.nspname = $1
) pd ON pd.column_name = c.column_name
LEFT JOIN (SELECT ...) pk ON pk.column_name = c.column_name  -- 保持现有 PK 逻辑
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
```

注意：先 Read postgres.rs 确认实际 SQL，仅在现有 SQL 基础上 LEFT JOIN pg_description，不重写整个查询。

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | head -20
```

期望：无错误

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/datasource/mod.rs src-tauri/src/datasource/mysql.rs src-tauri/src/datasource/postgres.rs
git commit -m "feat(datasource): ColumnMeta 新增 comment 字段，MySQL/PG 读取列注释"
```

---

### Task 5: `run_graph_build` 新增步骤 3.5（注释关系解析）

**Files:**
- Modify: `src-tauri/src/graph/mod.rs` (run_graph_build 新增步骤 3.5)
- Create: （步骤 3.5 的辅助函数 `build_comment_links`，写在 `mod.rs` 末尾或单独文件）

#### 背景

`run_graph_build`（`graph/mod.rs` 第120-263行）当前流程：
1. 获取连接配置
2. 获取 SchemaInfo
3. 拉取列/FK 信息
4. 检测变更 → `change_detector`
5. 处理事件 → `event_processor`
6. 同步指标
7. 同步别名

步骤 3.5 在步骤3结束后、步骤4前插入：清除旧 `comment` 节点/边，重新解析注释生成 Link Node。

- [ ] **Step 1: 在 `graph/mod.rs` 中实现 `build_comment_links` 函数**

在 `run_graph_build` 下方（第263行之后）添加：

```rust
/// 步骤 3.5：从列注释解析虚拟关系 Link Node
/// 幂等：先清除旧 comment 来源的节点和边，再重新生成
fn build_comment_links(
    connection_id: i64,
    table_columns: &std::collections::HashMap<String, Vec<crate::datasource::ColumnMeta>>,
    known_tables: &std::collections::HashSet<String>,
) -> crate::AppResult<usize> {
    let conn = crate::db::get().lock().unwrap();

    // 1. 清除旧 source='comment' 的边（级联删除节点引用不适用，需手动清除）
    conn.execute(
        "DELETE FROM graph_edges
         WHERE source = 'comment'
           AND from_node IN (SELECT id FROM graph_nodes WHERE connection_id = ?1)",
        [connection_id],
    )?;
    // 清除旧 source='comment' 的节点（link 类型）
    conn.execute(
        "DELETE FROM graph_nodes
         WHERE connection_id = ?1 AND source = 'comment' AND node_type = 'link'",
        [connection_id],
    )?;

    let mut count = 0;

    for (table_name, columns) in table_columns {
        let table_node_id = format!("{}:table:{}", connection_id, table_name);

        for col in columns {
            let comment = match &col.comment {
                Some(c) if !c.is_empty() => c,
                _ => continue,
            };

            let refs = crate::graph::comment_parser::parse_comment_refs(comment);

            for r in &refs {
                // 目标表不存在于当前 Schema → 跳过
                if !known_tables.contains(&r.target_table) {
                    log::warn!(
                        "[comment_links] 目标表 '{}' 不存在，跳过注释引用 ({}.{})",
                        r.target_table, table_name, col.name
                    );
                    continue;
                }

                // 检查是否已有 source='schema' 的直连关系（避免重复建边）
                let target_node_id = format!("{}:table:{}", connection_id, r.target_table);
                let schema_link_exists: bool = conn.query_row(
                    "SELECT COUNT(*) FROM graph_edges e
                     JOIN graph_nodes n ON n.id = e.from_node
                     WHERE n.id = ?1
                       AND e.to_node LIKE ?2
                       AND e.source = 'schema'",
                    rusqlite::params![
                        table_node_id,
                        format!("{}:link:%", connection_id)
                    ],
                    |row| row.get::<_, i64>(0),
                ).unwrap_or(0) > 0;

                // 也检查直连 link node 是否已在目标表之间存在（避免 schema 边漏检）
                let direct_schema_exists: bool = conn.query_row(
                    "SELECT COUNT(*)
                     FROM graph_nodes ln
                     JOIN graph_edges e1 ON e1.to_node = ln.id
                     JOIN graph_edges e2 ON e2.from_node = ln.id
                     WHERE ln.node_type = 'link'
                       AND ln.connection_id = ?1
                       AND e1.from_node = ?2
                       AND e2.to_node = ?3
                       AND (ln.source = 'schema' OR e1.source = 'schema')",
                    rusqlite::params![connection_id, table_node_id, target_node_id],
                    |row| row.get::<_, i64>(0),
                ).unwrap_or(0) > 0;

                if schema_link_exists || direct_schema_exists {
                    continue;
                }

                // 生成 comment 来源的 Link Node ID
                let link_node_id = format!(
                    "{}:link:comment_{}_{}_{}_{}",
                    connection_id, table_name, r.target_table, col.name, r.target_column
                );

                let metadata = serde_json::json!({
                    "source_table": table_name,
                    "target_table": r.target_table,
                    "via": col.name,
                    "cardinality": "N:1",
                    "on_delete": "NO ACTION",
                    "description": format!("{}.{} → {}.{} (注释推断)", table_name, col.name, r.target_table, r.target_column),
                    "relation_type": r.relation_type,
                    "source_column": col.name,
                    "target_column": r.target_column,
                }).to_string();

                // 插入 Link Node
                conn.execute(
                    "INSERT OR REPLACE INTO graph_nodes
                       (id, node_type, connection_id, name, display_name, metadata, source, is_deleted)
                     VALUES (?1, 'link', ?2, ?3, ?4, ?5, 'comment', 0)",
                    rusqlite::params![
                        link_node_id,
                        connection_id,
                        link_node_id,
                        format!("{}.{} → {}.{}", table_name, col.name, r.target_table, r.target_column),
                        metadata,
                    ],
                )?;

                // 插入两条边: table → link_node, link_node → target_table
                let edge_to_link = format!("{}=>{}", table_node_id, link_node_id);
                let edge_from_link = format!("{}=>{}", link_node_id, target_node_id);

                conn.execute(
                    "INSERT OR IGNORE INTO graph_edges
                       (id, from_node, to_node, edge_type, weight, source)
                     VALUES (?1, ?2, ?3, 'to_link', 1.0, 'comment')",
                    rusqlite::params![edge_to_link, table_node_id, link_node_id],
                )?;

                conn.execute(
                    "INSERT OR IGNORE INTO graph_edges
                       (id, from_node, to_node, edge_type, weight, source)
                     VALUES (?1, ?2, ?3, 'from_link', 1.0, 'comment')",
                    rusqlite::params![edge_from_link, link_node_id, target_node_id],
                )?;

                count += 1;
            }
        }
    }

    Ok(count)
}
```

- [ ] **Step 2: 在 `run_graph_build` 中插入步骤 3.5 调用**

在 `run_graph_build` 的步骤3（拉取列信息循环）结束后，步骤4（`emit_log(..., "正在检测 Schema 变更...")`）之前插入：

```rust
    // 步骤 3.5：解析列注释生成虚拟关系 Link Node（先于 change_detector）
    emit_log(&app, &task_id, "INFO", "正在解析列注释虚拟关系...");
    let known_tables: std::collections::HashSet<String> =
        schema.tables.iter().map(|t| t.name.clone()).collect();
    match build_comment_links(connection_id, &table_columns, &known_tables) {
        Ok(n) => emit_log(&app, &task_id, "INFO", &format!("注释关系解析完成，共 {} 条虚拟边", n)),
        Err(e) => emit_log(&app, &task_id, "WARN", &format!("注释关系解析失败（不影响主流程）: {}", e)),
    }
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```

期望：无错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/graph/mod.rs
git commit -m "feat(graph): run_graph_build 新增步骤 3.5 列注释虚拟关系解析"
```

---

## Chunk 4: Rust 命令层 — 手动编辑接口

### Task 6: 5 个手动编辑 Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands.rs` (新增5个命令)
- Modify: `src-tauri/src/lib.rs` (generate_handler![] 注册)

#### 背景

设计文档要求5个命令：`add_user_node`、`delete_graph_node`、`add_user_edge`、`delete_graph_edge`、`update_graph_edge`。所有操作均有 `source` 校验（`delete/update` 仅限 `user` 或 `comment`，`schema` 只读）。

- [ ] **Step 1: 先写集成测试（在 `commands.rs` 末尾的 `#[cfg(test)]` 块中）**

找到 `commands.rs` 末尾测试块位置，添加：

```rust
#[cfg(test)]
mod virtual_relation_tests {
    // 这些测试验证命令的 SQL 逻辑（不依赖 Tauri，直接操作 rusqlite）

    fn setup_test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE graph_nodes (
                id TEXT PRIMARY KEY, node_type TEXT NOT NULL, connection_id INTEGER,
                name TEXT NOT NULL, display_name TEXT, metadata TEXT,
                source TEXT DEFAULT 'schema', is_deleted INTEGER DEFAULT 0
             );
             CREATE TABLE graph_edges (
                id TEXT PRIMARY KEY, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
                edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0,
                metadata TEXT, source TEXT NOT NULL DEFAULT 'schema'
             );",
        ).unwrap();
        conn
    }

    #[test]
    fn test_add_user_node_writes_source_user() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO graph_nodes (id, node_type, connection_id, name, source)
             VALUES ('new_node', 'table', 1, 'virtual_table', 'user')",
            [],
        ).unwrap();
        let source: String = conn.query_row(
            "SELECT source FROM graph_nodes WHERE id = 'new_node'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(source, "user");
    }

    #[test]
    fn test_delete_schema_node_is_rejected() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO graph_nodes (id, node_type, connection_id, name, source)
             VALUES ('schema_node', 'table', 1, 'orders', 'schema')",
            [],
        ).unwrap();
        let source: String = conn.query_row(
            "SELECT source FROM graph_nodes WHERE id = 'schema_node'", [], |r| r.get(0)
        ).unwrap();
        // 命令层校验：只允许删除 source='user' 节点
        assert_ne!(source, "user", "schema 节点不应允许删除");
    }

    #[test]
    fn test_add_user_edge_valid_type() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO graph_nodes (id, node_type, connection_id, name) VALUES ('n1','table',1,'a'),('n2','table',1,'b')",
            [],
        ).unwrap();
        // user_defined 是合法的 edge_type
        let valid_types = ["foreign_key", "join_path", "user_defined"];
        for t in &valid_types {
            let edge_id = format!("e_{}", t);
            conn.execute(
                "INSERT OR IGNORE INTO graph_edges (id, from_node, to_node, edge_type, source)
                 VALUES (?1, 'n1', 'n2', ?2, 'user')",
                rusqlite::params![edge_id, t],
            ).unwrap();
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM graph_edges WHERE source = 'user'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_update_edge_schema_rejected() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO graph_nodes (id,node_type,connection_id,name) VALUES ('n1','table',1,'a'),('n2','table',1,'b')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO graph_edges (id, from_node, to_node, edge_type, source)
             VALUES ('e1', 'n1', 'n2', 'foreign_key', 'schema')",
            [],
        ).unwrap();
        let source: String = conn.query_row(
            "SELECT source FROM graph_edges WHERE id = 'e1'", [], |r| r.get(0)
        ).unwrap();
        // 命令层必须拒绝修改 source='schema' 的边
        assert_eq!(source, "schema", "schema 边只读，不应被修改");
    }
}
```

- [ ] **Step 2: 运行测试确认通过（测试本身不依赖命令实现，先通过）**

```bash
cd src-tauri && cargo test virtual_relation_tests 2>&1
```

期望：4个测试 PASS（测试只验证 SQL 逻辑，不依赖 Tauri 命令函数）

- [ ] **Step 3: 实现 `add_user_node` 命令**

在 `commands.rs` 中适当位置（图相关命令附近）添加：

```rust
#[tauri::command]
pub async fn add_user_node(
    connection_id: i64,
    name: String,
    display_name: Option<String>,
    node_type: String,
) -> AppResult<String> {
    // 仅允许 table/metric/alias 类型，不允许创建 link/column 等系统类型
    let allowed_types = ["table", "metric", "alias"];
    if !allowed_types.contains(&node_type.as_str()) {
        return Err(crate::AppError::Other(format!(
            "node_type '{}' 不允许手动创建，仅支持: {:?}", node_type, allowed_types
        )));
    }
    let node_id = format!("{}:user:{}:{}", connection_id, node_type, name);
    let disp = display_name.unwrap_or_else(|| name.clone());
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO graph_nodes (id, node_type, connection_id, name, display_name, source, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, 'user', 0)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, is_deleted = 0",
        rusqlite::params![node_id, node_type, connection_id, name, disp],
    )?;
    Ok(node_id)
}
```

- [ ] **Step 4: 实现 `delete_graph_node` 命令**

```rust
#[tauri::command]
pub async fn delete_graph_node(node_id: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_nodes WHERE id = ?1",
        [&node_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") => {
            conn.execute(
                "UPDATE graph_nodes SET is_deleted = 1 WHERE id = ?1",
                [&node_id],
            )?;
            Ok(())
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "节点 source='{}' 不允许删除，仅允许删除 source='user' 节点", s
        ))),
        None => Err(crate::AppError::Other(format!("节点 '{}' 不存在", node_id))),
    }
}
```

- [ ] **Step 5: 实现 `add_user_edge` 命令**

```rust
#[tauri::command]
pub async fn add_user_edge(
    from_node: String,
    to_node: String,
    edge_type: String,
    weight: Option<f64>,
) -> AppResult<String> {
    let allowed_edge_types = ["foreign_key", "join_path", "user_defined"];
    if !allowed_edge_types.contains(&edge_type.as_str()) {
        return Err(crate::AppError::Other(format!(
            "edge_type '{}' 不合法，允许值: {:?}", edge_type, allowed_edge_types
        )));
    }
    let w = weight.unwrap_or(1.0);
    let edge_id = format!("{}=>{}:user", from_node, to_node);
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO graph_edges (id, from_node, to_node, edge_type, weight, source)
         VALUES (?1, ?2, ?3, ?4, ?5, 'user')
         ON CONFLICT(id) DO UPDATE SET edge_type = excluded.edge_type, weight = excluded.weight",
        rusqlite::params![edge_id, from_node, to_node, edge_type, w],
    )?;
    Ok(edge_id)
}
```

- [ ] **Step 6: 实现 `delete_graph_edge` 命令**

```rust
#[tauri::command]
pub async fn delete_graph_edge(edge_id: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_edges WHERE id = ?1",
        [&edge_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") | Some("comment") => {
            conn.execute("DELETE FROM graph_edges WHERE id = ?1", [&edge_id])?;
            Ok(())
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "边 source='{}' 不允许删除，仅允许删除 source='user' 或 'comment' 的边", s
        ))),
        None => Err(crate::AppError::Other(format!("边 '{}' 不存在", edge_id))),
    }
}
```

- [ ] **Step 7: 实现 `update_graph_edge` 命令**

```rust
#[tauri::command]
pub async fn update_graph_edge(
    edge_id: String,
    edge_type: Option<String>,
    weight: Option<f64>,
) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_edges WHERE id = ?1",
        [&edge_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") | Some("comment") => {
            if let Some(ref et) = edge_type {
                // user 边可以修改 edge_type；comment 边仅允许修改 weight
                if source.as_deref() == Some("comment") {
                    // comment 边只允许改 weight，不允许改 edge_type
                    if edge_type.is_some() {
                        return Err(crate::AppError::Other(
                            "comment 来源的边不允许修改 edge_type".to_string()
                        ));
                    }
                }
                let allowed_edge_types = ["foreign_key", "join_path", "user_defined"];
                if !allowed_edge_types.contains(&et.as_str()) {
                    return Err(crate::AppError::Other(format!(
                        "edge_type '{}' 不合法", et
                    )));
                }
            }
            if let Some(et) = edge_type {
                conn.execute(
                    "UPDATE graph_edges SET edge_type = ?1 WHERE id = ?2",
                    rusqlite::params![et, edge_id],
                )?;
            }
            if let Some(w) = weight {
                conn.execute(
                    "UPDATE graph_edges SET weight = ?1 WHERE id = ?2",
                    rusqlite::params![w, edge_id],
                )?;
            }
            Ok(())
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "边 source='{}' 不允许修改，仅允许修改 source='user' 或 'comment' 的边", s
        ))),
        None => Err(crate::AppError::Other(format!("边 '{}' 不存在", edge_id))),
    }
}
```

- [ ] **Step 8: 在 `lib.rs` 中注册5个命令**

找到 `src-tauri/src/lib.rs` 中 `generate_handler![]` 宏，在现有命令列表末尾添加：

```rust
add_user_node,
delete_graph_node,
add_user_edge,
delete_graph_edge,
update_graph_edge,
```

- [ ] **Step 9: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | head -20
```

期望：无错误

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): 新增 5 个虚拟关系手动编辑命令"
```

---

## Chunk 5: 前端 — 视觉区分 + 编辑模式

### Task 7: `useGraphData.ts` + `graphUtils.ts` 适配 source 字段

**Files:**
- Modify: `src/components/GraphExplorer/useGraphData.ts` (GraphEdge.source 已在 Task 2 添加，此处补充 invoke 逻辑)
- Modify: `src/components/GraphExplorer/graphUtils.ts` (边样式按 source 区分)

#### 背景

前端 `GraphEdge.source` 字段已在 Task 2 添加。现在需要让图谱画布按 `source` 渲染不同颜色和线型。

- [ ] **Step 1: 阅读 `graphUtils.ts` 确认现有边样式逻辑**

```bash
# 先 Read graphUtils.ts 确认边样式函数位置和实现
```

- [ ] **Step 2: 在 `graphUtils.ts` 中新增 `getEdgeStyle` 函数**

根据 `source` 返回样式配置：

```typescript
// 三种来源的边样式
export function getEdgeStyleBySource(source: string): {
  stroke: string;
  strokeDasharray?: string;
  animated?: boolean;
} {
  switch (source) {
    case 'comment':
      return { stroke: '#f59e0b', strokeDasharray: '5,3' };  // 琥珀黄虚线
    case 'user':
      return { stroke: '#a855f7', strokeDasharray: '2,2' };  // 紫色点划线
    case 'schema':
    default:
      return { stroke: '#3794ff' };  // 蓝色实线
  }
}

// 来源徽章文本
export function getSourceBadge(source: string): { label: string; color: string } {
  switch (source) {
    case 'comment': return { label: '注释推断', color: '#f59e0b' };
    case 'user':    return { label: '用户自定义', color: '#a855f7' };
    default:        return { label: '数据库外键', color: '#3794ff' };
  }
}
```

- [ ] **Step 3: 更新图谱边渲染，应用 source 样式**

在 `useGraphData.ts` 或 `index.tsx` 中（找到 edges → ReactFlow edge 转换的地方），应用 `getEdgeStyleBySource`：

```typescript
import { getEdgeStyleBySource } from './graphUtils';

// 转换 GraphEdge → ReactFlow edge
const rfEdge = {
  id: edge.id,
  source: edge.from_node,
  target: edge.to_node,
  type: 'smoothstep',
  style: getEdgeStyleBySource(edge.source ?? 'schema'),
  data: { source: edge.source, edge_type: edge.edge_type, weight: edge.weight },
};
```

- [ ] **Step 4: TypeScript 编译验证**

```bash
npx tsc --noEmit 2>&1 | head -20
```

期望：无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/GraphExplorer/graphUtils.ts src/components/GraphExplorer/useGraphData.ts
git commit -m "feat(frontend): 图谱边按 source 渲染不同颜色和线型"
```

---

### Task 8: `NodeDetail.tsx` — 来源徽章 + 删除/编辑权限控制

**Files:**
- Modify: `src/components/GraphExplorer/NodeDetail.tsx`

#### 背景

选中节点/边时，详情面板顶部显示来源徽章，按 source 决定操作权限：
- `schema`：只读，无删除/编辑入口
- `comment`：可删边（调 `delete_graph_edge`），可改 weight
- `user`：可删节点（调 `delete_graph_node`），可改 edge_type + weight

- [ ] **Step 1: 阅读 `NodeDetail.tsx` 确认现有结构**

```bash
# Read NodeDetail.tsx 确认 props 类型和渲染结构
```

- [ ] **Step 2: 新增来源徽章组件**

在 `NodeDetail.tsx` 中添加：

```typescript
import { getSourceBadge } from './graphUtils';

function SourceBadge({ source }: { source: string }) {
  const badge = getSourceBadge(source);
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4,
      backgroundColor: badge.color + '22',
      border: `1px solid ${badge.color}`,
      color: badge.color, fontSize: 12, marginBottom: 8
    }}>
      {source === 'user' ? '✏️ ' : ''}{badge.label}
    </div>
  );
}
```

- [ ] **Step 3: 在节点详情渲染中加入徽章 + 条件操作按钮**

在节点/边详情的顶部加入 `<SourceBadge source={node.source} />`，按 source 条件渲染删除/编辑按钮：

```typescript
// 节点详情
{node.source !== 'schema' && (
  <button
    onClick={() => handleDeleteNode(node.id)}
    style={{ color: '#ef4444', border: '1px solid #ef4444', ... }}
  >
    删除此节点
  </button>
)}

// 边详情
{(selectedEdge?.source === 'user' || selectedEdge?.source === 'comment') && (
  <div>
    <label>权重</label>
    <input
      type="number" step="0.1" min="0" max="2"
      value={editWeight}
      onChange={e => setEditWeight(parseFloat(e.target.value))}
    />
    <button onClick={handleUpdateEdge}>保存</button>
  </div>
)}
{selectedEdge?.source === 'user' && (
  <button onClick={() => handleDeleteEdge(selectedEdge.id)}>删除此边</button>
)}
```

删除/更新调用对应 invoke 命令：

```typescript
import { invoke } from '@tauri-apps/api/core';

async function handleDeleteNode(nodeId: string) {
  if (!confirm('确认删除此用户节点？')) return;
  await invoke('delete_graph_node', { nodeId });
  refetch();
}

async function handleDeleteEdge(edgeId: string) {
  await invoke('delete_graph_edge', { edgeId });
  refetch();
}

async function handleUpdateEdge() {
  await invoke('update_graph_edge', { edgeId: selectedEdge.id, weight: editWeight });
  refetch();
}
```

- [ ] **Step 4: TypeScript 编译验证**

```bash
npx tsc --noEmit 2>&1 | head -20
```

期望：无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/GraphExplorer/NodeDetail.tsx
git commit -m "feat(frontend): NodeDetail 新增来源徽章和按 source 的删除/编辑权限控制"
```

---

### Task 9: `GraphExplorer/index.tsx` — 编辑模式开关 + 手动连线 + 添加虚拟节点

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx`

#### 背景

工具栏新增"编辑模式"切换（默认关闭），开启后：
- 节点 handle 可拖拽连线 → 弹出 edge_type 选择框 → 调 `add_user_edge`
- 工具栏"+ 节点"按钮 → 输入名称 → 调 `add_user_node`

- [ ] **Step 1: 阅读 `index.tsx` 确认工具栏和 ReactFlow 配置位置**

```bash
# Read index.tsx 确认 ReactFlow props、工具栏结构
```

- [ ] **Step 2: 新增编辑模式状态和工具栏开关**

```typescript
const [editMode, setEditMode] = useState(false);

// 工具栏按钮（在现有工具栏中追加）
<button
  onClick={() => setEditMode(v => !v)}
  style={{
    border: editMode ? '1px solid #f59e0b' : '1px solid #374151',
    color: editMode ? '#f59e0b' : '#9ca3af',
    ...
  }}
>
  {editMode ? '✏️ 编辑中' : '编辑模式'}
</button>

{editMode && (
  <button onClick={handleAddVirtualNode}>+ 节点</button>
)}
```

- [ ] **Step 3: 实现手动连线（`onConnect` 回调）**

```typescript
const [pendingConnect, setPendingConnect] = useState<{source: string; target: string} | null>(null);
const [edgeTypeChoice, setEdgeTypeChoice] = useState('user_defined');

const onConnect = useCallback(async (params: Connection) => {
  if (!editMode) return;
  // 弹出选择框让用户选 edge_type
  setPendingConnect({ source: params.source!, target: params.target! });
}, [editMode]);

// 确认连线
async function confirmConnect() {
  if (!pendingConnect) return;
  await invoke('add_user_edge', {
    fromNode: pendingConnect.source,
    toNode: pendingConnect.target,
    edgeType: edgeTypeChoice,
    weight: 1.0,
  });
  setPendingConnect(null);
  refetch();
}
```

- [ ] **Step 4: 实现添加虚拟节点**

```typescript
async function handleAddVirtualNode() {
  const name = prompt('输入虚拟节点名称');
  if (!name || !connectionId) return;
  await invoke('add_user_node', {
    connectionId,
    name,
    displayName: name,
    nodeType: 'table',
  });
  refetch();
}
```

- [ ] **Step 5: ReactFlow 中按 `editMode` 控制 `nodesDraggable` 和 `nodesConnectable`**

```typescript
<ReactFlow
  nodes={rfNodes}
  edges={rfEdges}
  onConnect={onConnect}
  nodesConnectable={editMode}
  nodesDraggable={true}
  ...
/>
```

- [ ] **Step 6: TypeScript 编译验证**

```bash
npx tsc --noEmit 2>&1 | head -20
```

期望：无错误

- [ ] **Step 7: Commit**

```bash
git add src/components/GraphExplorer/index.tsx
git commit -m "feat(frontend): GraphExplorer 编辑模式开关、手动连线、添加虚拟节点"
```

---

## Chunk 6: 收尾验证

### Task 10: Cargo 全量测试 + TypeScript 检查

- [ ] **Step 1: 运行所有 Rust 单元测试**

```bash
cd src-tauri && cargo test 2>&1 | tail -30
```

期望：所有测试 PASS，无 FAILED

- [ ] **Step 2: TypeScript 全量类型检查**

```bash
npx tsc --noEmit 2>&1
```

期望：无错误

- [ ] **Step 3: cargo check（最终确认）**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | wc -l
```

期望：输出 0

- [ ] **Step 4: 最终汇总 commit（若有未提交改动）**

```bash
git status
# 若有未提交文件：
git add -p  # 逐块确认
git commit -m "chore(graph): 虚拟关系层实现收尾"
```

---

## 文件改动汇总

| 文件 | 任务 | 类型 |
|------|------|------|
| `schema/init.sql` | Task 1 | 修改 graph_edges 建表 |
| `src-tauri/src/db/migrations.rs` | Task 1 | 新增 V10 迁移 |
| `src-tauri/src/graph/query.rs` | Task 2 | GraphEdge 新增 source |
| `src/components/GraphExplorer/useGraphData.ts` | Task 2, 7 | GraphEdge interface + 样式 |
| `src-tauri/src/graph/comment_parser.rs` | Task 3 | 新建解析器 |
| `src-tauri/src/graph/mod.rs` | Task 3, 5 | 注册模块 + 步骤 3.5 |
| `src-tauri/src/datasource/mod.rs` | Task 4 | ColumnMeta.comment |
| `src-tauri/src/datasource/mysql.rs` | Task 4 | get_columns 读注释 |
| `src-tauri/src/datasource/postgres.rs` | Task 4 | get_columns 读注释 |
| `src-tauri/src/commands.rs` | Task 6 | 5 个新命令 |
| `src-tauri/src/lib.rs` | Task 6 | 注册命令 |
| `src/components/GraphExplorer/graphUtils.ts` | Task 7 | 边样式函数 |
| `src/components/GraphExplorer/NodeDetail.tsx` | Task 8 | 来源徽章 + 权限 |
| `src/components/GraphExplorer/index.tsx` | Task 9 | 编辑模式 |
