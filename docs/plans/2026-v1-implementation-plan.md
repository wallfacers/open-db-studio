# V1 阶段实施计划（Q3 2026）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 open-db-studio V1 阶段全部功能：完整 DB 管理 + SQL 编辑器增强 + 数据导入导出 + AI 能力增强。

**Architecture:** Rust 后端先行（扩展 DataSource trait → 新增命令），前端后接入真实数据，Mock 数据全部替换。

**Tech Stack:** Tauri 2.x · React 18 + TypeScript · Zustand · Rust · sqlx (mysql/postgres) · sql-formatter · @monaco-editor/react

---

## 依赖顺序

```
Task 1 (扩展数据结构)
  → Task 2 (扩展 DataSource trait)
    → Task 3 (MySQL 实现)
    → Task 4 (PostgreSQL 实现)
      → Task 5 (get_table_data 命令)
      → Task 6 (行 CRUD 命令)
      → Task 7 (get_table_ddl 命令)
      → Task 8 (export_table_data 命令)

Task 9  (ai_optimize_sql 命令)   — 独立
Task 10 (ai_diagnose_error 命令) — 独立
Task 11 (ai_create_table 命令)   — 独立

Task 12 (TableDataView 接真实数据)    → 依赖 Task 5
Task 13 (行内编辑)                    → 依赖 Task 6
Task 14 (条件过滤真实执行)            → 依赖 Task 5
Task 15 (Explorer 展示列/索引)        → 依赖 Task 2,3,4
Task 16 (表管理 GUI)                  → 依赖 Task 7
Task 17 (索引管理面板)                → 依赖 Task 2,3,4
Task 18 (ERDiagram 接真实 FK)         → 依赖 Task 2,3,4
Task 19 (Monaco Schema 自动补全)      → 依赖 Task 2,3,4
Task 20 (多语句 + 多结果集 Tab)       — 纯前端
Task 21 (sql-formatter 格式化)        — 纯前端
Task 22 (导出 UI)                     → 依赖 Task 8
Task 23 (导入 UI)                     — 依赖 Task 5 (预览)
Task 24 (AI 多轮对话)                 — 纯前端重构
Task 25 (AI 建表对话框)               → 依赖 Task 11
Task 26 (AI SQL 优化面板)             → 依赖 Task 9
Task 27 (AI 错误诊断)                 → 依赖 Task 10
Task 28 (视图/存储过程面板)           → 依赖 Task 2,3,4
```

---

## Task 1：扩展数据结构（ColumnMeta / IndexMeta / ForeignKeyMeta）

**Files:**
- Modify: `src-tauri/src/datasource/mod.rs`

**Step 1: 添加新数据结构**

在 `datasource/mod.rs` 的 `SchemaInfo` 之后添加：

```rust
/// 列元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>, // e.g. "auto_increment"
}

/// 索引元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexMeta {
    pub index_name: String,
    pub is_unique: bool,
    pub columns: Vec<String>,
}

/// 外键元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ForeignKeyMeta {
    pub constraint_name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
}

/// 视图元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ViewMeta {
    pub name: String,
    pub definition: Option<String>,
}

/// 存储过程元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcedureMeta {
    pub name: String,
    pub routine_type: String, // PROCEDURE / FUNCTION
}

/// 表详细信息（含列/索引/外键）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableDetail {
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
}

/// 完整 schema（含列和外键信息，用于 ERD）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FullSchemaInfo {
    pub tables: Vec<TableDetail>,
    pub views: Vec<ViewMeta>,
    pub procedures: Vec<ProcedureMeta>,
}
```

**Step 2: 更新 DataSource trait，添加可选的扩展方法**

```rust
#[async_trait]
pub trait DataSource: Send + Sync {
    // 已有方法（保持不变）
    async fn test_connection(&self) -> AppResult<()>;
    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>>;
    async fn get_schema(&self) -> AppResult<SchemaInfo>;

    // V1 新增：带默认空实现（Oracle/MSSQL 不强制实现）
    async fn get_columns(&self, _table: &str) -> AppResult<Vec<ColumnMeta>> {
        Ok(vec![])
    }
    async fn get_indexes(&self, _table: &str) -> AppResult<Vec<IndexMeta>> {
        Ok(vec![])
    }
    async fn get_foreign_keys(&self, _table: &str) -> AppResult<Vec<ForeignKeyMeta>> {
        Ok(vec![])
    }
    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        Ok(vec![])
    }
    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        Ok(vec![])
    }
    async fn get_table_ddl(&self, _table: &str) -> AppResult<String> {
        Ok(String::new())
    }
    async fn get_full_schema(&self) -> AppResult<FullSchemaInfo> {
        let tables_meta = self.get_tables().await?;
        let mut tables = vec![];
        for t in &tables_meta {
            let columns = self.get_columns(&t.name).await.unwrap_or_default();
            let indexes = self.get_indexes(&t.name).await.unwrap_or_default();
            let foreign_keys = self.get_foreign_keys(&t.name).await.unwrap_or_default();
            tables.push(TableDetail { name: t.name.clone(), columns, indexes, foreign_keys });
        }
        let views = self.get_views().await.unwrap_or_default();
        let procedures = self.get_procedures().await.unwrap_or_default();
        Ok(FullSchemaInfo { tables, views, procedures })
    }
}
```

**Step 3: 在 `create_datasource` 返回类型不变，确认编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

预期：无错误

**Step 4: Commit**

```bash
git add src-tauri/src/datasource/mod.rs
git commit -m "feat(datasource): extend DataSource trait with column/index/fk/view/procedure metadata"
```

---

## Task 2：MySQL 实现扩展 trait 方法

**Files:**
- Modify: `src-tauri/src/datasource/mysql.rs`

**Step 1: 实现 `get_columns`**

在 `MySqlDataSource` 的 `impl DataSource for MySqlDataSource` 块中添加：

```rust
async fn get_columns(&self, table: &str) -> AppResult<Vec<ColumnMeta>> {
    let sql = format!(
        "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'
         ORDER BY ORDINAL_POSITION",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ColumnMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        data_type: r.try_get::<String, _>(1).unwrap_or_default(),
        is_nullable: r.try_get::<String, _>(2).unwrap_or_default() == "YES",
        column_default: r.try_get::<Option<String>, _>(3).unwrap_or(None),
        is_primary_key: r.try_get::<String, _>(4).unwrap_or_default() == "PRI",
        extra: r.try_get::<Option<String>, _>(5).ok().flatten().filter(|s| !s.is_empty()),
    }).collect())
}
```

**Step 2: 实现 `get_indexes`**

```rust
async fn get_indexes(&self, table: &str) -> AppResult<Vec<IndexMeta>> {
    let sql = format!(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    let mut map: std::collections::BTreeMap<String, IndexMeta> = Default::default();
    for r in &rows {
        let idx_name: String = r.try_get(0).unwrap_or_default();
        let non_unique: i64 = r.try_get(1).unwrap_or(1);
        let col: String = r.try_get(2).unwrap_or_default();
        map.entry(idx_name.clone()).or_insert_with(|| IndexMeta {
            index_name: idx_name,
            is_unique: non_unique == 0,
            columns: vec![],
        }).columns.push(col);
    }
    Ok(map.into_values().collect())
}
```

**Step 3: 实现 `get_foreign_keys`**

```rust
async fn get_foreign_keys(&self, table: &str) -> AppResult<Vec<ForeignKeyMeta>> {
    let sql = format!(
        "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND REFERENCED_TABLE_NAME IS NOT NULL",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ForeignKeyMeta {
        constraint_name: r.try_get::<String, _>(0).unwrap_or_default(),
        column: r.try_get::<String, _>(1).unwrap_or_default(),
        referenced_table: r.try_get::<String, _>(2).unwrap_or_default(),
        referenced_column: r.try_get::<String, _>(3).unwrap_or_default(),
    }).collect())
}
```

**Step 4: 实现 `get_views`**

```rust
async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()"
    ).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ViewMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        definition: r.try_get::<Option<String>, _>(1).ok().flatten(),
    }).collect())
}
```

**Step 5: 实现 `get_procedures`**

```rust
async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()"
    ).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ProcedureMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        routine_type: r.try_get::<String, _>(1).unwrap_or_default(),
    }).collect())
}
```

**Step 6: 实现 `get_table_ddl`**

```rust
async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
    use sqlx::Row;
    let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
    let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
    Ok(row.try_get::<String, _>(1).unwrap_or_default())
}
```

**Step 7: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

预期：无错误

**Step 8: Commit**

```bash
git add src-tauri/src/datasource/mysql.rs
git commit -m "feat(mysql): implement get_columns/indexes/fk/views/procedures/ddl"
```

---

## Task 3：PostgreSQL 实现扩展 trait 方法

**Files:**
- Modify: `src-tauri/src/datasource/postgres.rs`

**Step 1: 实现 `get_columns`**

```rust
async fn get_columns(&self, table: &str) -> AppResult<Vec<ColumnMeta>> {
    let sql = format!(
        "SELECT column_name, data_type, is_nullable, column_default,
                CASE WHEN column_name IN (
                    SELECT kcu.column_name FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                        ON tc.constraint_name = kcu.constraint_name
                        AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = '{0}'
                ) THEN true ELSE false END as is_pk
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = '{0}'
         ORDER BY ordinal_position",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ColumnMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        data_type: r.try_get::<String, _>(1).unwrap_or_default(),
        is_nullable: r.try_get::<String, _>(2).unwrap_or_default() == "YES",
        column_default: r.try_get::<Option<String>, _>(3).ok().flatten(),
        is_primary_key: r.try_get::<bool, _>(4).unwrap_or(false),
        extra: None,
    }).collect())
}
```

**Step 2: 实现 `get_indexes`**

```rust
async fn get_indexes(&self, table: &str) -> AppResult<Vec<IndexMeta>> {
    let sql = format!(
        "SELECT i.relname AS index_name, ix.indisunique, a.attname AS column_name
         FROM pg_class t
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE t.relname = '{}' AND t.relkind = 'r'
         ORDER BY i.relname",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    let mut map: std::collections::BTreeMap<String, IndexMeta> = Default::default();
    for r in &rows {
        let idx_name: String = r.try_get(0).unwrap_or_default();
        let is_unique: bool = r.try_get(1).unwrap_or(false);
        let col: String = r.try_get(2).unwrap_or_default();
        map.entry(idx_name.clone()).or_insert_with(|| IndexMeta {
            index_name: idx_name,
            is_unique,
            columns: vec![],
        }).columns.push(col);
    }
    Ok(map.into_values().collect())
}
```

**Step 3: 实现 `get_foreign_keys`**

```rust
async fn get_foreign_keys(&self, table: &str) -> AppResult<Vec<ForeignKeyMeta>> {
    let sql = format!(
        "SELECT tc.constraint_name, kcu.column_name,
                ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{}'",
        table.replace('\'', "''")
    );
    use sqlx::Row;
    let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ForeignKeyMeta {
        constraint_name: r.try_get::<String, _>(0).unwrap_or_default(),
        column: r.try_get::<String, _>(1).unwrap_or_default(),
        referenced_table: r.try_get::<String, _>(2).unwrap_or_default(),
        referenced_column: r.try_get::<String, _>(3).unwrap_or_default(),
    }).collect())
}
```

**Step 4: 实现 `get_views`**

```rust
async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = 'public'"
    ).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ViewMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        definition: r.try_get::<Option<String>, _>(1).ok().flatten(),
    }).collect())
}
```

**Step 5: 实现 `get_procedures`**

```rust
async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = 'public'"
    ).fetch_all(&self.pool).await?;
    Ok(rows.iter().map(|r| ProcedureMeta {
        name: r.try_get::<String, _>(0).unwrap_or_default(),
        routine_type: r.try_get::<String, _>(1).unwrap_or_default(),
    }).collect())
}
```

**Step 6: 实现 `get_table_ddl`（PostgreSQL 用 pg_get_tabledef）**

```rust
async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
    // PostgreSQL 没有内置 SHOW CREATE TABLE，用 information_schema 重建
    let columns = self.get_columns(table).await?;
    if columns.is_empty() {
        return Ok(format!("-- Table '{}' not found", table));
    }
    let col_defs: Vec<String> = columns.iter().map(|c| {
        let nullable = if c.is_nullable { "" } else { " NOT NULL" };
        let pk = if c.is_primary_key { " PRIMARY KEY" } else { "" };
        let default = c.column_default.as_ref().map(|d| format!(" DEFAULT {}", d)).unwrap_or_default();
        format!("  {} {}{}{}{}", c.name, c.data_type, nullable, default, pk)
    }).collect();
    Ok(format!("CREATE TABLE {} (\n{}\n);", table, col_defs.join(",\n")))
}
```

**Step 7: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

**Step 8: Commit**

```bash
git add src-tauri/src/datasource/postgres.rs
git commit -m "feat(postgres): implement get_columns/indexes/fk/views/procedures/ddl"
```

---

## Task 4：新增 Rust 命令（表详情 / DDL / 分页数据）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 commands.rs 添加 `get_table_detail`**

```rust
// ============ DB 管理 ============

#[tauri::command]
pub async fn get_table_detail(connection_id: i64, table: String) -> AppResult<crate::datasource::TableDetail> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let columns = ds.get_columns(&table).await?;
    let indexes = ds.get_indexes(&table).await?;
    let foreign_keys = ds.get_foreign_keys(&table).await?;
    Ok(crate::datasource::TableDetail { name: table, columns, indexes, foreign_keys })
}

#[tauri::command]
pub async fn get_full_schema(connection_id: i64) -> AppResult<crate::datasource::FullSchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_full_schema().await
}

#[tauri::command]
pub async fn get_table_ddl(connection_id: i64, table: String) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_table_ddl(&table).await
}
```

**Step 2: 添加 `get_table_data` 分页命令**

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    pub connection_id: i64,
    pub table: String,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,
    pub order_clause: Option<String>,
}

#[tauri::command]
pub async fn get_table_data(params: TableDataParams) -> AppResult<crate::datasource::QueryResult> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let offset = params.page.saturating_sub(1) * params.page_size;
    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();
    let order_part = params.order_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" ORDER BY {}", s))
        .unwrap_or_default();

    // 使用 driver-aware 引号
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "SELECT * FROM `{}`{}{} LIMIT {} OFFSET {}",
            params.table.replace('`', "``"), where_part, order_part, params.page_size, offset
        ),
        _ => format!(
            "SELECT * FROM \"{}\"{}{} LIMIT {} OFFSET {}",
            params.table.replace('"', "\"\""), where_part, order_part, params.page_size, offset
        ),
    };

    ds.execute(&sql).await
}
```

**Step 3: 添加行 CRUD 命令**

```rust
#[tauri::command]
pub async fn update_row(
    connection_id: i64,
    table: String,
    pk_column: String,
    pk_value: String,
    column: String,
    new_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "UPDATE `{}` SET `{}` = '{}' WHERE `{}` = '{}'",
            table.replace('`', "``"),
            column.replace('`', "``"),
            new_value.replace('\'', "\\'"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "UPDATE \"{}\" SET \"{}\" = '{}' WHERE \"{}\" = '{}'",
            table.replace('"', "\"\""),
            column.replace('"', "\"\""),
            new_value.replace('\'', "''"),
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    ds.execute(&sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_row(
    connection_id: i64,
    table: String,
    pk_column: String,
    pk_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "DELETE FROM `{}` WHERE `{}` = '{}'",
            table.replace('`', "``"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "DELETE FROM \"{}\" WHERE \"{}\" = '{}'",
            table.replace('"', "\"\""),
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    ds.execute(&sql).await?;
    Ok(())
}
```

**Step 4: 注册新命令到 lib.rs**

在 `generate_handler![]` 中追加：

```rust
commands::get_table_detail,
commands::get_full_schema,
commands::get_table_ddl,
commands::get_table_data,
commands::update_row,
commands::delete_row,
```

**Step 5: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

**Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add get_table_detail/ddl/data, update_row, delete_row"
```

---

## Task 5：数据导出命令（CSV / JSON / SQL Dump）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 添加 `export_table_data` 命令**

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportParams {
    pub connection_id: i64,
    pub table: String,
    pub format: String, // "csv" | "json" | "sql"
    pub where_clause: Option<String>,
    pub output_path: String,
}

#[tauri::command]
pub async fn export_table_data(params: ExportParams) -> AppResult<String> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();

    let sql = match config.driver.as_str() {
        "mysql" => format!("SELECT * FROM `{}`{}", params.table.replace('`', "``"), where_part),
        _ => format!("SELECT * FROM \"{}\"{}", params.table.replace('"', "\"\""), where_part),
    };

    let result = ds.execute(&sql).await?;

    let content = match params.format.as_str() {
        "json" => serde_json::to_string_pretty(&result.rows)
            .map_err(|e| crate::AppError::Other(e.to_string()))?,
        "csv" => {
            let mut out = result.columns.join(",") + "\n";
            for row in &result.rows {
                let line: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => String::new(),
                    serde_json::Value::String(s) => format!("\"{}\"", s.replace('"', "\"\"")),
                    other => other.to_string(),
                }).collect();
                out += &(line.join(",") + "\n");
            }
            out
        }
        "sql" => {
            let mut out = format!("-- Export: {}\n", params.table);
            for row in &result.rows {
                let values: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => "NULL".into(),
                    serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => if *b { "1".into() } else { "0".into() },
                    other => format!("'{}'", other.to_string().replace('\'', "''")),
                }).collect();
                out += &format!("INSERT INTO {} VALUES ({});\n", params.table, values.join(", "));
            }
            out
        }
        _ => return Err(crate::AppError::Other(format!("Unsupported format: {}", params.format))),
    };

    std::fs::write(&params.output_path, content)
        .map_err(|e| crate::AppError::Other(format!("Failed to write file: {}", e)))?;

    Ok(params.output_path)
}
```

**Step 2: 注册命令**

在 `generate_handler![]` 追加 `commands::export_table_data,`

**Step 3: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add export_table_data (csv/json/sql)"
```

---

## Task 6：AI 新增命令（优化 / 诊断 / 建表）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/llm/client.rs`
- Create: `prompts/sql_create_table.txt`
- Create: `prompts/sql_diagnose.txt`

**Step 1: 创建 AI 建表 prompt**

```
# prompts/sql_create_table.txt
You are an expert database architect. Generate a CREATE TABLE SQL statement based on the user's natural language description.

Database Dialect: {{DIALECT}}

Requirements:
- Use appropriate data types for the dialect
- Include primary key
- Add relevant indexes for frequently queried columns
- Use NOT NULL where appropriate
- Include brief comments if helpful

Return ONLY the SQL statement, no explanation.
```

**Step 2: 创建 AI 错误诊断 prompt**

```
# prompts/sql_diagnose.txt
You are an expert SQL debugger. Analyze the following SQL error and provide a diagnosis.

Database Dialect: {{DIALECT}}

Database Schema:
{{SCHEMA}}

SQL that failed:
{{SQL}}

Error message:
{{ERROR}}

Provide:
1. Root cause of the error
2. Fixed SQL (if applicable)
3. Prevention tips

Respond in Chinese.
```

**Step 3: 在 LlmClient 添加新方法**

在 `client.rs` 添加：

```rust
/// AI 优化 SQL（已有 prompt 文件）
pub async fn optimize_sql(
    &self,
    sql: &str,
    schema_context: &str,
    dialect: &str,
) -> AppResult<String> {
    let system_prompt = include_str!("../../../prompts/sql_optimize.txt")
        .replace("{{DIALECT}}", dialect)
        .replace("{{SCHEMA}}", schema_context);
    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: sql.to_string() },
    ];
    self.chat(messages).await
}

/// AI 建表
pub async fn create_table_ddl(
    &self,
    description: &str,
    dialect: &str,
) -> AppResult<String> {
    let system_prompt = include_str!("../../../prompts/sql_create_table.txt")
        .replace("{{DIALECT}}", dialect);
    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: description.to_string() },
    ];
    self.chat(messages).await
}

/// AI 错误诊断
pub async fn diagnose_error(
    &self,
    sql: &str,
    error_msg: &str,
    schema_context: &str,
    dialect: &str,
) -> AppResult<String> {
    let system_prompt = include_str!("../../../prompts/sql_diagnose.txt")
        .replace("{{DIALECT}}", dialect)
        .replace("{{SCHEMA}}", schema_context)
        .replace("{{SQL}}", sql)
        .replace("{{ERROR}}", error_msg);
    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: "请诊断此错误".to_string() },
    ];
    self.chat(messages).await
}
```

**Step 4: 在 commands.rs 添加新 AI 命令**

```rust
#[tauri::command]
pub async fn ai_optimize_sql(sql: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;
    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>().join("\n");
    client.optimize_sql(&sql, &schema_context, &config.driver).await
}

#[tauri::command]
pub async fn ai_create_table(description: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    client.create_table_ddl(&description, &config.driver).await
}

#[tauri::command]
pub async fn ai_diagnose_error(sql: String, error_msg: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;
    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>().join("\n");
    client.diagnose_error(&sql, &error_msg, &schema_context, &config.driver).await
}
```

**Step 5: 注册命令到 lib.rs**

```rust
commands::ai_optimize_sql,
commands::ai_create_table,
commands::ai_diagnose_error,
```

**Step 6: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

**Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/llm/client.rs prompts/
git commit -m "feat(ai): add optimize_sql, create_table, diagnose_error commands"
```

---

## Task 7：前端 Types 扩展 + Store 扩展

**Files:**
- Modify: `src/types.ts`（或 `src/types/index.ts`，视当前实际路径）
- Modify: `src/store/aiStore.ts`

**Step 1: 确认 types 文件位置**

```bash
find src -name "types*" -not -path "*/node_modules/*"
```

**Step 2: 在 types 中添加新类型**

```typescript
export interface ColumnMeta {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  extra: string | null;
}

export interface IndexMeta {
  index_name: string;
  is_unique: boolean;
  columns: string[];
}

export interface ForeignKeyMeta {
  constraint_name: string;
  column: string;
  referenced_table: string;
  referenced_column: string;
}

export interface TableDetail {
  name: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreign_keys: ForeignKeyMeta[];
}

export interface ViewMeta {
  name: string;
  definition: string | null;
}

export interface ProcedureMeta {
  name: string;
  routine_type: string;
}

export interface FullSchemaInfo {
  tables: TableDetail[];
  views: ViewMeta[];
  procedures: ProcedureMeta[];
}

export interface TableDataParams {
  connectionId: number;
  table: string;
  page: number;
  pageSize: number;
  whereClause?: string;
  orderClause?: string;
}
```

**Step 3: 在 aiStore.ts 添加新 AI 方法**

在 `AiState` interface 和 store 实现中添加：

```typescript
// interface 中：
optimizeSql: (sql: string, connectionId: number) => Promise<string>;
createTable: (description: string, connectionId: number) => Promise<string>;
diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
isOptimizing: boolean;
isDiagnosing: boolean;
isCreatingTable: boolean;

// store 实现中：
isOptimizing: false,
isDiagnosing: false,
isCreatingTable: false,

optimizeSql: async (sql, connectionId) => {
  set({ isOptimizing: true, error: null });
  try {
    return await invoke<string>('ai_optimize_sql', { sql, connectionId });
  } catch (e) {
    set({ error: String(e) });
    throw e;
  } finally {
    set({ isOptimizing: false });
  }
},

createTable: async (description, connectionId) => {
  set({ isCreatingTable: true, error: null });
  try {
    return await invoke<string>('ai_create_table', { description, connectionId });
  } catch (e) {
    set({ error: String(e) });
    throw e;
  } finally {
    set({ isCreatingTable: false });
  }
},

diagnoseError: async (sql, errorMsg, connectionId) => {
  set({ isDiagnosing: true, error: null });
  try {
    return await invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId });
  } catch (e) {
    set({ error: String(e) });
    throw e;
  } finally {
    set({ isDiagnosing: false });
  }
},
```

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 5: Commit**

```bash
git add src/types.ts src/store/aiStore.ts
git commit -m "feat(frontend): extend types and aiStore for V1 features"
```

---

## Task 8：TableDataView 接入真实数据

**Files:**
- Modify: `src/components/MainContent/TableDataView.tsx`

**Step 1: 替换 Mock 数据，改为真实数据获取**

将 `TableDataView` 组件重构为：

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Plus, Minus, Download, Filter, Search } from 'lucide-react';

interface TableDataViewProps {
  tableName: string;
  dbName: string;
  showToast: (msg: string) => void;
}

export const TableDataView: React.FC<TableDataViewProps> = ({ tableName, showToast }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const [data, setData] = useState<QueryResult | null>(null);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [total, setTotal] = useState(0);
  const [whereClause, setWhereClause] = useState('');
  const [orderClause, setOrderClause] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [editingCell, setEditingCell] = useState<{row: number; col: string; value: string} | null>(null);

  const loadData = useCallback(async () => {
    if (!activeConnectionId || !tableName) return;
    setIsLoading(true);
    try {
      const result = await invoke<QueryResult>('get_table_data', {
        params: {
          connection_id: activeConnectionId,
          table: tableName,
          page,
          page_size: pageSize,
          where_clause: whereClause || null,
          order_clause: orderClause || null,
        }
      });
      setData(result);
      setTotal(result.row_count);
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, tableName, page, pageSize, whereClause, orderClause]);

  // 加载列元数据（确认 PK）
  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', { connectionId: activeConnectionId, table: tableName })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find(c => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCellDoubleClick = (rowIdx: number, colName: string, currentValue: string) => {
    setEditingCell({ row: rowIdx, col: colName, value: currentValue });
  };

  const handleCellSave = async () => {
    if (!editingCell || !activeConnectionId || !data) return;
    const pkValue = String(data.rows[editingCell.row][data.columns.indexOf(pkColumn)] ?? '');
    try {
      await invoke('update_row', {
        connectionId: activeConnectionId,
        table: tableName,
        pkColumn,
        pkValue,
        column: editingCell.col,
        newValue: editingCell.value,
      });
      showToast(t('tableDataView.updateSuccess'));
      setEditingCell(null);
      loadData();
    } catch (e) {
      showToast(String(e));
    }
  };

  const handleDeleteRow = async (rowIdx: number) => {
    if (!activeConnectionId || !data) return;
    const pkValue = String(data.rows[rowIdx][data.columns.indexOf(pkColumn)] ?? '');
    if (!window.confirm(t('tableDataView.confirmDelete'))) return;
    try {
      await invoke('delete_row', { connectionId: activeConnectionId, table: tableName, pkColumn, pkValue });
      showToast(t('tableDataView.deleteSuccess'));
      loadData();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#1e1e1e] h-full">
      {/* Toolbar */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs">
        <div className="flex items-center space-x-2 text-[#858585]">
          <button disabled={page <= 1} onClick={() => setPage(1)} className="p-1 hover:bg-[#2b2b2b] rounded disabled:opacity-30">|&lt;</button>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="p-1 hover:bg-[#2b2b2b] rounded disabled:opacity-30"><ChevronLeft size={14}/></button>
          <span className="text-[#d4d4d4]">{page}</span>
          <button onClick={() => setPage(p => p + 1)} className="p-1 hover:bg-[#2b2b2b] rounded"><ChevronRight size={14}/></button>
          <span className="text-[#858585]">{t('tableDataView.total')} {total}</span>
          <button onClick={loadData} className="p-1 hover:bg-[#2b2b2b] rounded" title={t('tableDataView.refreshData')}><RefreshCw size={14}/></button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs gap-3">
        <Filter size={12} className="text-[#858585]"/>
        <span className="text-[#858585]">WHERE</span>
        <input
          className="bg-transparent outline-none text-[#d4d4d4] flex-1"
          placeholder={t('tableDataView.enterCondition')}
          value={whereClause}
          onChange={e => setWhereClause(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadData()}
        />
        <span className="text-[#858585]">ORDER BY</span>
        <input
          className="bg-transparent outline-none text-[#d4d4d4] flex-1"
          placeholder={t('tableDataView.enterOrder')}
          value={orderClause}
          onChange={e => setOrderClause(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadData()}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-[#858585] text-sm">{t('tableDataView.loading')}</div>
        ) : !data ? (
          <div className="p-4 text-[#858585] text-sm">{t('tableDataView.noData')}</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap text-[13px]">
            <thead className="sticky top-0 bg-[#252526] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#2b2b2b] text-[#858585] font-normal">#</th>
                {data.columns.map(col => (
                  <th key={col} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4] font-normal">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-[#2a2d2e] border-b border-[#2b2b2b] group">
                  <td className="px-2 py-1.5 border-r border-[#2b2b2b] text-[#858585] bg-[#252526] text-center text-xs">{(page - 1) * pageSize + ri + 1}</td>
                  {row.map((cell, ci) => {
                    const colName = data.columns[ci];
                    const isEditing = editingCell?.row === ri && editingCell?.col === colName;
                    return (
                      <td
                        key={ci}
                        className="px-3 py-1.5 text-[#d4d4d4] border-r border-[#2b2b2b] max-w-[300px]"
                        onDoubleClick={() => handleCellDoubleClick(ri, colName, cell === null ? '' : String(cell))}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="bg-[#2b2b2b] text-[#d4d4d4] outline-none border border-[#3794ff] rounded px-1 w-full"
                            value={editingCell.value}
                            onChange={e => setEditingCell({ ...editingCell, value: e.target.value })}
                            onKeyDown={e => { if (e.key === 'Enter') handleCellSave(); if (e.key === 'Escape') setEditingCell(null); }}
                            onBlur={handleCellSave}
                          />
                        ) : (
                          <span className="truncate block">{cell === null ? <span className="text-[#858585] italic">NULL</span> : String(cell)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 flex items-center px-3 border-t border-[#2b2b2b] bg-[#181818] text-[#858585] text-xs">
        {data && <span>{data.row_count} {t('tableDataView.row')} · {data.duration_ms}ms</span>}
      </div>
    </div>
  );
};
```

**Step 2: 在 i18n 中添加新 key（如有独立翻译文件，添加 loading/confirmDelete/updateSuccess/deleteSuccess/noData）**

在 `src/i18n/locales/zh-CN.json`（或对应路径）的 `tableDataView` section 中添加：

```json
"loading": "加载中...",
"noData": "暂无数据",
"confirmDelete": "确认删除该行？",
"updateSuccess": "更新成功",
"deleteSuccess": "删除成功"
```

在英文翻译文件中同步添加对应英文。

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/components/MainContent/TableDataView.tsx src/i18n/
git commit -m "feat(table-view): connect to real data with inline editing and row delete"
```

---

## Task 9：ERDiagram 接入真实 Schema（外键生成连线）

**Files:**
- Modify: `src/components/ERDiagram.tsx`
- Check/Modify: `src/data/initialElements.ts`（了解数据格式后决定是否保留）

**Step 1: 读取当前 initialElements 数据格式**

查看 `src/data/initialElements.ts` 了解节点/边格式：

```bash
cat src/data/initialElements.ts | head -50
```

**Step 2: 重构 ERDiagram 改为从 Rust 加载真实 Schema**

在 `ERDiagram.tsx` 顶部添加 import 和 state，替换 `initialNodes/initialEdges`：

```tsx
import { invoke } from '@tauri-apps/api/core';
import { useConnectionStore } from '../store';
import type { FullSchemaInfo } from '../types';

// 在组件内替换 useNodesState 初始值：
const { activeConnectionId } = useConnectionStore();
const [nodes, setNodes, onNodesChange] = useNodesState([]);
const [edges, setEdges, onEdgesChange] = useEdgesState([]);

useEffect(() => {
  if (!activeConnectionId) return;
  invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
    .then(schema => {
      const newNodes = schema.tables.map((t, i) => ({
        id: t.name,
        type: 'table',
        position: { x: i * 300, y: 0 },
        data: {
          name: t.name,
          columns: t.columns.map(c => ({
            name: c.name,
            type: c.data_type,
            pk: c.is_primary_key,
            nullable: c.is_nullable,
          })),
        },
      }));
      const newEdges: Edge[] = [];
      schema.tables.forEach(t => {
        t.foreign_keys.forEach(fk => {
          newEdges.push({
            id: `${fk.constraint_name}`,
            source: t.name,
            target: fk.referenced_table,
            sourceHandle: fk.column,
            targetHandle: fk.referenced_column,
            type: 'smoothstep',
            animated: false,
            style: { stroke: '#3794ff', strokeWidth: 1.5 },
            label: fk.constraint_name,
          });
        });
      });
      // 自动布局
      const { nodes: layouted, edges: layoutedEdges } = getLayoutedElements(newNodes, newEdges);
      setNodes(layouted);
      setEdges(layoutedEdges);
    })
    .catch(console.error);
}, [activeConnectionId]);
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/components/ERDiagram.tsx
git commit -m "feat(erd): connect to real schema with FK edges"
```

---

## Task 10：Monaco Schema-aware 自动补全

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**Step 1: 在 MainContent 中增加 Schema 缓存**

在 `MainContent` 组件加入：

```tsx
import type { FullSchemaInfo } from '../../types';

// 在 useEffect 中加载 schema（当连接切换时）
const [schemaInfo, setSchemaInfo] = useState<FullSchemaInfo | null>(null);

useEffect(() => {
  if (!activeConnectionId) return;
  invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
    .then(setSchemaInfo)
    .catch(console.error);
}, [activeConnectionId]);
```

**Step 2: 注册 Monaco completion provider**

在 `handleEditorWillMount`（BeforeMount 回调）后，创建新函数 `handleEditorDidMount`：

```tsx
import type { OnMount } from '@monaco-editor/react';

const handleEditorDidMount: OnMount = (editor, monaco) => {
  // 注册 SQL completion provider
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems: (model, position) => {
      const suggestions: monaco.languages.CompletionItem[] = [];
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      if (!schemaInfo) return { suggestions: [] };

      // 表名提示
      schemaInfo.tables.forEach(t => {
        suggestions.push({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          range,
          detail: 'Table',
        });
        // 列名提示
        t.columns.forEach(c => {
          suggestions.push({
            label: `${t.name}.${c.name}`,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: c.name,
            range,
            detail: `${t.name} (${c.data_type})`,
          });
        });
      });
      return { suggestions };
    },
  });
};
```

在 `<MonacoEditor>` 添加 `onMount={handleEditorDidMount}` 属性。

**注意:** `schemaInfo` 需要用 `useRef` 或让 provider 能访问最新值。改用 `useRef<FullSchemaInfo | null>` + `schemaRef.current`：

```tsx
const schemaRef = useRef<FullSchemaInfo | null>(null);
useEffect(() => {
  if (!activeConnectionId) return;
  invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
    .then(s => { schemaRef.current = s; })
    .catch(console.error);
}, [activeConnectionId]);
```

在 provider 内用 `schemaRef.current`。

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(editor): add schema-aware SQL autocompletion"
```

---

## Task 11：SQL 格式化（sql-formatter）

**Files:**
- Modify: `package.json`（添加依赖）
- Modify: `src/App.tsx`（handleFormat 函数）或 `MainContent/index.tsx`

**Step 1: 安装 sql-formatter**

```bash
npm install sql-formatter
```

**Step 2: 在 App.tsx 中找到 handleFormat 并替换实现**

当前的 `handleFormat` 可能只是 toast。搜索其位置：

```bash
grep -n "handleFormat" src/App.tsx | head -10
```

替换为真实格式化：

```typescript
import { format as formatSql } from 'sql-formatter';

const handleFormat = () => {
  const activeTabId = queryStore.activeTabId;
  const currentSql = queryStore.sqlContent[activeTabId] ?? '';
  if (!currentSql.trim()) return;
  try {
    const dialect = /* 从连接配置取 */ 'sql'; // 'mysql' | 'postgresql'
    const formatted = formatSql(currentSql, { language: dialect as any, tabWidth: 2, keywordCase: 'upper' });
    queryStore.setSql(activeTabId, formatted);
  } catch {
    showToast('SQL 格式化失败');
  }
};
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/ package.json package-lock.json
git commit -m "feat(editor): implement SQL formatting with sql-formatter"
```

---

## Task 12：多语句分割 + 多结果集 Tab

**Files:**
- Modify: `src/store/queryStore.ts`
- Modify: `src/components/MainContent/index.tsx`

**Step 1: 在 queryStore 中添加多结果集支持**

`results` 已经是 `Record<string, QueryResult | null>`。改造为支持每个 tab 多个结果：

```typescript
// 在 QueryState 中把 results 改为：
results: Record<string, QueryResult[]>;  // tabId -> 多个结果集

// executeQuery 改为按分号分割多条语句：
executeQuery: async (connectionId, tabId) => {
  const sql = get().sqlContent[tabId] ?? '';
  if (!sql.trim()) return;
  // 按分号分割（简单版：避免字符串内分号）
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  set({ isExecuting: true, error: null });
  const results: QueryResult[] = [];
  try {
    for (const stmt of statements) {
      const result = await invoke<QueryResult>('execute_query', { connectionId, sql: stmt });
      results.push(result);
    }
    set(s => ({ results: { ...s.results, [tabId]: results }, isExecuting: false }));
  } catch (e) {
    set({ error: String(e), isExecuting: false });
  }
},
```

**Step 2: 在 MainContent 更新结果区域展示多个结果集**

结果区 Tab 从静态 `result1` / `overview` 改为动态：

```tsx
const currentResults = results[activeTab] ?? [];

// 结果 Tab 列表
{currentResults.map((_, i) => (
  <div key={i} className={`px-4 py-2 text-xs cursor-pointer border-t-2 ${resultsTab === `result${i}` ? 'border-t-[#3794ff]...' : '...'}`}
    onClick={() => setResultsTab(`result${i}`)}>
    {t('mainContent.resultSet')} {i + 1}
  </div>
))}
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/store/queryStore.ts src/components/MainContent/index.tsx
git commit -m "feat(editor): multi-statement execution with separate result tabs"
```

---

## Task 13：Explorer 展示列和索引

**Files:**
- Modify: `src/components/Explorer/index.tsx`

**Step 1: 阅读当前 Explorer 代码，了解树结构**

```bash
wc -l src/components/Explorer/index.tsx
```

**Step 2: 在表节点下展示列和索引**

在表节点点击展开时，调用 `get_table_detail` 获取列和索引信息，并展示到树中：

```tsx
// 在 Explorer 中添加状态：
const [tableDetails, setTableDetails] = useState<Record<string, TableDetail>>({});

const loadTableDetail = async (tableName: string) => {
  if (!activeConnectionId || tableDetails[tableName]) return;
  try {
    const detail = await invoke<TableDetail>('get_table_detail', {
      connectionId: activeConnectionId,
      table: tableName,
    });
    setTableDetails(prev => ({ ...prev, [tableName]: detail }));
  } catch (e) {
    console.error(e);
  }
};
```

在表节点展开时调用 `loadTableDetail`，展示 columns 子节点（显示 `name: type` 格式，PK 用 🔑 标识）和 indexes 子节点。

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 4: Commit**

```bash
git add src/components/Explorer/index.tsx
git commit -m "feat(explorer): show columns and indexes in table tree"
```

---

## Task 14：表管理 GUI（建表 / 删表 + DDL 预览）

**Files:**
- Create: `src/components/TableManageDialog/index.tsx`

**Step 1: 创建表管理对话框组件**

该组件功能：
1. 显示当前表的 DDL（从 `get_table_ddl` 获取）
2. 提供"删除表"按钮（执行 `DROP TABLE`）
3. "新建表"模式：输入 DDL → 执行

```tsx
import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface Props {
  connectionId: number;
  tableName?: string; // undefined = 新建模式
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
}

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [ddl, setDdl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (tableName) {
      invoke<string>('get_table_ddl', { connectionId, table: tableName })
        .then(setDdl)
        .catch(e => showToast(String(e)));
    } else {
      setDdl('CREATE TABLE new_table (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  name VARCHAR(255) NOT NULL\n);');
    }
  }, [tableName, connectionId]);

  const handleExecute = async () => {
    if (!ddl.trim()) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: ddl });
      showToast(tableName ? t('tableManage.alterSuccess') : t('tableManage.createSuccess'));
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async () => {
    if (!tableName || !window.confirm(t('tableManage.confirmDrop', { table: tableName }))) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: `DROP TABLE ${tableName}` });
      showToast(t('tableManage.dropSuccess'));
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#2b2b2b]">
          <span className="text-[#d4d4d4] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#858585] hover:text-[#d4d4d4]"><X size={16}/></button>
        </div>
        <textarea
          className="flex-1 m-4 bg-[#141414] border border-[#2b2b2b] rounded p-3 font-mono text-xs text-[#d4d4d4] outline-none resize-none"
          value={ddl}
          onChange={e => setDdl(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-between p-4 border-t border-[#2b2b2b]">
          {tableName && (
            <button
              onClick={handleDrop}
              disabled={isLoading}
              className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded text-xs"
            >
              {t('tableManage.dropTable')}
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] hover:text-[#d4d4d4] rounded text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={handleExecute}
              disabled={isLoading}
              className="px-3 py-1.5 bg-[#3794ff] text-white hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
            >
              {isLoading ? t('common.executing') : t('common.execute')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
```

**Step 2: 在 Explorer 右键菜单中集成该对话框**

在 Explorer 的表节点右键菜单中添加 "新建表" / "编辑表 DDL" / "删除表" 菜单项，点击时展示 `TableManageDialog`。

**Step 3: 添加 i18n keys**

在中英文翻译文件中添加 `tableManage.*` 相关 keys。

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

**Step 5: Commit**

```bash
git add src/components/TableManageDialog/ src/i18n/
git commit -m "feat(db-manage): add table DDL viewer and create/drop table dialog"
```

---

## Task 15：索引管理面板

**Files:**
- Create: `src/components/IndexManager/index.tsx`

**Step 1: 创建索引管理组件**

```tsx
import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus } from 'lucide-react';
import type { IndexMeta } from '../../types';

interface Props {
  connectionId: number;
  tableName: string;
  showToast: (msg: string) => void;
  onRefresh: () => void;
}

export const IndexManager: React.FC<Props> = ({ connectionId, tableName, showToast, onRefresh }) => {
  const { t } = useTranslation();
  const [indexes, setIndexes] = useState<IndexMeta[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newIndex, setNewIndex] = useState({ name: '', columns: '', unique: false });

  useEffect(() => {
    invoke<{ indexes: IndexMeta[] }>('get_table_detail', { connectionId, table: tableName })
      .then(d => setIndexes(d.indexes))
      .catch(e => showToast(String(e)));
  }, [connectionId, tableName]);

  const handleDrop = async (indexName: string) => {
    if (!window.confirm(`Drop index ${indexName}?`)) return;
    try {
      await invoke('execute_query', {
        connectionId,
        sql: `DROP INDEX ${indexName} ON ${tableName}`,
      });
      showToast(t('indexManager.dropSuccess'));
      onRefresh();
    } catch (e) {
      showToast(String(e));
    }
  };

  const handleCreate = async () => {
    const unique = newIndex.unique ? 'UNIQUE ' : '';
    const sql = `CREATE ${unique}INDEX ${newIndex.name} ON ${tableName} (${newIndex.columns})`;
    try {
      await invoke('execute_query', { connectionId, sql });
      showToast(t('indexManager.createSuccess'));
      setIsAdding(false);
      onRefresh();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-[#d4d4d4]">{t('indexManager.title')}</span>
        <button onClick={() => setIsAdding(true)} className="flex items-center gap-1 text-xs text-[#3794ff] hover:opacity-80">
          <Plus size={12}/> {t('indexManager.addIndex')}
        </button>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[#858585] border-b border-[#2b2b2b]">
            <th className="text-left py-1 pr-3">{t('indexManager.name')}</th>
            <th className="text-left py-1 pr-3">{t('indexManager.columns')}</th>
            <th className="text-left py-1 pr-3">{t('indexManager.unique')}</th>
            <th/>
          </tr>
        </thead>
        <tbody>
          {indexes.map(idx => (
            <tr key={idx.index_name} className="border-b border-[#2b2b2b] text-[#d4d4d4]">
              <td className="py-1.5 pr-3">{idx.index_name}</td>
              <td className="py-1.5 pr-3">{idx.columns.join(', ')}</td>
              <td className="py-1.5 pr-3">{idx.is_unique ? '✓' : ''}</td>
              <td>
                <button onClick={() => handleDrop(idx.index_name)} className="text-[#858585] hover:text-red-400">
                  <Trash2 size={12}/>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdding && (
        <div className="mt-3 p-3 bg-[#141414] border border-[#2b2b2b] rounded space-y-2">
          <input className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] outline-none" placeholder={t('indexManager.indexName')} value={newIndex.name} onChange={e => setNewIndex(p => ({...p, name: e.target.value}))}/>
          <input className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] outline-none" placeholder={t('indexManager.columns')} value={newIndex.columns} onChange={e => setNewIndex(p => ({...p, columns: e.target.value}))}/>
          <label className="flex items-center gap-2 text-xs text-[#d4d4d4]">
            <input type="checkbox" checked={newIndex.unique} onChange={e => setNewIndex(p => ({...p, unique: e.target.checked}))}/>
            {t('indexManager.unique')}
          </label>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1 bg-[#3794ff] text-white text-xs rounded">{t('common.create')}</button>
            <button onClick={() => setIsAdding(false)} className="px-3 py-1 bg-[#2b2b2b] text-[#858585] text-xs rounded">{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
};
```

**Step 2: 在 Explorer 或 TableDataView 右键菜单中集成**

在表节点右键菜单添加 "管理索引" 选项，打开包含 `IndexManager` 的 Modal。

**Step 3: Commit**

```bash
git add src/components/IndexManager/ src/i18n/
git commit -m "feat(db-manage): add index manager panel"
```

---

## Task 16：视图 / 存储过程 / 函数面板

**Files:**
- Create: `src/components/ObjectPanel/index.tsx`
- Modify: `src/components/Explorer/index.tsx`

**Step 1: 创建 ObjectPanel 组件**

```tsx
import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { ViewMeta, ProcedureMeta } from '../../types';

export const ObjectPanel: React.FC<{ showToast: (msg: string) => void }> = ({ showToast }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [procedures, setProcedures] = useState<ProcedureMeta[]>([]);
  const [selectedView, setSelectedView] = useState<ViewMeta | null>(null);

  useEffect(() => {
    if (!activeConnectionId) return;
    invoke<{ tables: any[], views: ViewMeta[], procedures: ProcedureMeta[] }>(
      'get_full_schema', { connectionId: activeConnectionId }
    ).then(schema => {
      setViews(schema.views);
      setProcedures(schema.procedures);
    }).catch(e => showToast(String(e)));
  }, [activeConnectionId]);

  return (
    <div className="h-full flex flex-col text-xs">
      {/* Views Section */}
      <div className="border-b border-[#2b2b2b]">
        <div className="px-3 py-2 text-[#858585] font-medium">{t('objectPanel.views')} ({views.length})</div>
        {views.map(v => (
          <div key={v.name} className="px-4 py-1.5 text-[#d4d4d4] hover:bg-[#2a2d2e] cursor-pointer flex items-center gap-2"
            onClick={() => setSelectedView(v)}>
            <span className="text-[#569cd6]">⬡</span> {v.name}
          </div>
        ))}
      </div>
      {/* Procedures/Functions Section */}
      <div>
        <div className="px-3 py-2 text-[#858585] font-medium">{t('objectPanel.procedures')} ({procedures.length})</div>
        {procedures.map(p => (
          <div key={p.name} className="px-4 py-1.5 text-[#d4d4d4] hover:bg-[#2a2d2e] cursor-pointer flex items-center gap-2">
            <span className="text-[#dcdcaa]">ƒ</span> {p.name} <span className="text-[#858585]">{p.routine_type}</span>
          </div>
        ))}
      </div>
      {/* View Definition Overlay */}
      {selectedView && (
        <div className="absolute inset-0 bg-[#1e1e1e] border border-[#3c3c3c] rounded p-4 flex flex-col">
          <div className="flex justify-between mb-3">
            <span className="text-[#d4d4d4] font-medium">{selectedView.name}</span>
            <button onClick={() => setSelectedView(null)} className="text-[#858585] hover:text-white">✕</button>
          </div>
          <pre className="flex-1 overflow-auto text-xs text-[#d4d4d4] font-mono whitespace-pre-wrap">
            {selectedView.definition ?? t('objectPanel.noDefinition')}
          </pre>
        </div>
      )}
    </div>
  );
};
```

**Step 2: 在 Explorer 的 ActivityBar 中添加 "Objects" 视图入口**

在侧边栏导航中添加图标入口，切换到 `ObjectPanel`。

**Step 3: Commit**

```bash
git add src/components/ObjectPanel/ src/components/Explorer/index.tsx src/i18n/
git commit -m "feat(db-manage): add views/procedures/functions panel"
```

---

## Task 17：导出 UI

**Files:**
- Create: `src/components/ExportDialog/index.tsx`

**Step 1: 创建导出对话框**

```tsx
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

interface Props {
  connectionId: number;
  tableName: string;
  onClose: () => void;
  showToast: (msg: string) => void;
}

export const ExportDialog: React.FC<Props> = ({ connectionId, tableName, onClose, showToast }) => {
  const { t } = useTranslation();
  const [format, setFormat] = useState<'csv' | 'json' | 'sql'>('csv');
  const [whereClause, setWhereClause] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    // 使用 Tauri dialog plugin 选择保存路径
    const path = await save({
      defaultPath: `${tableName}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;

    setIsExporting(true);
    try {
      await invoke('export_table_data', {
        params: {
          connection_id: connectionId,
          table: tableName,
          format,
          where_clause: whereClause || null,
          output_path: path,
        }
      });
      showToast(t('export.success', { path }));
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-96 p-5">
        <h3 className="text-sm text-[#d4d4d4] font-medium mb-4">{t('export.title', { table: tableName })}</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[#858585] mb-1 block">{t('export.format')}</label>
            <div className="flex gap-2">
              {(['csv', 'json', 'sql'] as const).map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`px-3 py-1 text-xs rounded ${format === f ? 'bg-[#3794ff] text-white' : 'bg-[#2b2b2b] text-[#858585]'}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-[#858585] mb-1 block">WHERE {t('export.optional')}</label>
            <input
              className="w-full bg-[#141414] border border-[#2b2b2b] rounded px-2 py-1.5 text-xs text-[#d4d4d4] outline-none"
              placeholder="id > 100"
              value={whereClause}
              onChange={e => setWhereClause(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] text-xs rounded">{t('common.cancel')}</button>
          <button onClick={handleExport} disabled={isExporting}
            className="px-3 py-1.5 bg-[#3794ff] text-white text-xs rounded disabled:opacity-50">
            {isExporting ? t('export.exporting') : t('export.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
```

**注意:** 需要确认 `tauri-plugin-dialog` 是否已在 `lib.rs` 中注册（当前已注册）。`save` 函数来自 `@tauri-apps/plugin-dialog`，确认 npm 包已安装：

```bash
npm list @tauri-apps/plugin-dialog
```

**Step 2: 在 TableDataView 工具栏集成导出按钮**

在 TableDataView 的 export 下拉中添加三个格式选项，点击后打开 ExportDialog。

**Step 3: Commit**

```bash
git add src/components/ExportDialog/ src/components/MainContent/TableDataView.tsx src/i18n/
git commit -m "feat(export): add CSV/JSON/SQL export dialog"
```

---

## Task 18：AI 多轮对话改造

**Files:**
- Modify: `src/components/Assistant/index.tsx`
- Modify: `src/store/aiStore.ts`

**Step 1: 在 aiStore 添加多轮对话方法**

```typescript
// types 中添加：
interface ChatMessage { role: 'user' | 'assistant'; content: string; }

// aiStore 中：
chatHistory: ChatMessage[];
isChatting: boolean;

addToHistory: (msg: ChatMessage) => void;
clearHistory: () => void;
sendChat: (message: string, connectionId: number | null) => Promise<string>;
```

```typescript
sendChat: async (message, connectionId) => {
  set({ isChatting: true });
  try {
    const history = get().chatHistory;
    const context = {
      history: history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      model: null,
    };
    const reply = await invoke<string>('ai_chat', { message, context });
    set(s => ({
      chatHistory: [...s.chatHistory, { role: 'user', content: message }, { role: 'assistant', content: reply }],
      isChatting: false,
    }));
    return reply;
  } catch (e) {
    set({ isChatting: false });
    throw e;
  }
},
```

**Step 2: 改造 Assistant 组件使用持久化 chatHistory**

将 `chatMessages` 状态从 `App.tsx` props 迁移到 `aiStore`，使用 `chatHistory` 和 `sendChat`，不再区分 generate SQL / chat，统一走 `ai_chat` 命令（已支持多轮上下文）。

保留 "插入到编辑器" 功能：当 AI 回复中包含 SQL 代码块时，展示 "Insert to Editor" 按钮。

**Step 3: Commit**

```bash
git add src/components/Assistant/index.tsx src/store/aiStore.ts
git commit -m "feat(ai): multi-turn conversation with persistent history"
```

---

## Task 19：AI 建表对话框

**Files:**
- Create: `src/components/AiCreateTableDialog/index.tsx`

**Step 1: 创建 AI 建表对话框**

```tsx
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore, useAiStore } from '../../store';

interface Props {
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefresh: () => void;
}

export const AiCreateTableDialog: React.FC<Props> = ({ onClose, showToast, onRefresh }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const { createTable, isCreatingTable } = useAiStore();
  const [description, setDescription] = useState('');
  const [generatedDdl, setGeneratedDdl] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);

  const handleGenerate = async () => {
    if (!activeConnectionId || !description.trim()) return;
    try {
      const ddl = await createTable(description, activeConnectionId);
      setGeneratedDdl(ddl);
    } catch (e) {
      showToast(String(e));
    }
  };

  const handleExecute = async () => {
    if (!activeConnectionId || !generatedDdl.trim()) return;
    setIsExecuting(true);
    try {
      await invoke('execute_query', { connectionId: activeConnectionId, sql: generatedDdl });
      showToast(t('aiCreateTable.success'));
      onRefresh();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-[640px] max-h-[80vh] flex flex-col p-5">
        <h3 className="text-sm text-[#d4d4d4] font-medium mb-4">{t('aiCreateTable.title')}</h3>

        <textarea
          className="bg-[#141414] border border-[#2b2b2b] rounded p-3 text-xs text-[#d4d4d4] outline-none resize-none h-24 mb-3"
          placeholder={t('aiCreateTable.descriptionPlaceholder')}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />

        <button onClick={handleGenerate} disabled={isCreatingTable || !description.trim()}
          className="px-4 py-2 bg-[#3794ff] text-white text-xs rounded mb-3 disabled:opacity-50 w-fit">
          {isCreatingTable ? t('aiCreateTable.generating') : t('aiCreateTable.generate')}
        </button>

        {generatedDdl && (
          <>
            <label className="text-xs text-[#858585] mb-1">{t('aiCreateTable.reviewDdl')}</label>
            <textarea
              className="flex-1 bg-[#141414] border border-[#2b2b2b] rounded p-3 font-mono text-xs text-[#d4d4d4] outline-none resize-none mb-3"
              value={generatedDdl}
              onChange={e => setGeneratedDdl(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] text-xs rounded">{t('common.cancel')}</button>
              <button onClick={handleExecute} disabled={isExecuting}
                className="px-3 py-1.5 bg-[#3794ff] text-white text-xs rounded disabled:opacity-50">
                {isExecuting ? t('common.executing') : t('aiCreateTable.executeAndCreate')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
```

**Step 2: 在 Explorer 工具栏添加 "AI 建表" 按钮**

**Step 3: Commit**

```bash
git add src/components/AiCreateTableDialog/ src/i18n/
git commit -m "feat(ai): add AI create table dialog"
```

---

## Task 20：AI SQL 优化面板 + 错误自动诊断

**Files:**
- Modify: `src/components/MainContent/index.tsx`
- Modify: `src/store/queryStore.ts`

**Step 1: 在工具栏添加 "优化 SQL" 按钮**

在 MainContent 的工具栏（已有 Execute / Explain）中添加 "Optimize" 按钮：

```tsx
const handleOptimize = async () => {
  if (!currentSql.trim() || !activeConnectionId) {
    showToast(t('mainContent.inputSqlAndSelectConnection'));
    return;
  }
  try {
    const result = await optimizeSql(currentSql, activeConnectionId);
    setExplanation(result); // 复用 explanation 面板展示
  } catch {
    showToast(t('mainContent.aiOptimizeFailed'));
  }
};
```

**Step 2: 在执行出错时自动触发 AI 诊断**

在 `queryStore.executeQuery` 中，当捕获到错误时，自动调用 `ai_diagnose_error`：

修改 `executeQuery`：

```typescript
} catch (e) {
  const errorMsg = String(e);
  set({ error: errorMsg, isExecuting: false });
  // 自动诊断（非阻塞）
  if (errorMsg.length > 0) {
    invoke<string>('ai_diagnose_error', {
      sql: get().sqlContent[tabId] ?? '',
      errorMsg,
      connectionId,
    }).then(diagnosis => {
      set({ diagnosis });
    }).catch(() => {});
  }
}
```

在 `QueryState` 中添加 `diagnosis: string | null` 字段，在结果区域展示诊断信息。

**Step 3: Commit**

```bash
git add src/components/MainContent/index.tsx src/store/queryStore.ts
git commit -m "feat(ai): add SQL optimize button and auto error diagnosis"
```

---

## Task 21：更新 PLANS.md + 验证

**Files:**
- Modify: `docs/PLANS.md`

**Step 1: 更新 PLANS.md 中 V1 功能状态**

将 V1 阶段所有 `- [ ]` 改为 `- [x]`，并在 "已完成" 列表中添加 V1 功能清单。

**Step 2: TypeScript 全局检查**

```bash
npx tsc --noEmit 2>&1
```

预期：无错误

**Step 3: Rust 全局编译检查**

```bash
cd src-tauri && cargo check 2>&1 | tail -30
```

预期：无错误

**Step 4: Commit**

```bash
git add docs/PLANS.md
git commit -m "docs: mark V1 features as complete in PLANS.md"
```

---

## 注意事项

1. **Tauri plugin-dialog save API**: `@tauri-apps/plugin-dialog` 的 `save()` 函数。如未安装运行 `npm install @tauri-apps/plugin-dialog`。

2. **i18n 文件路径**: 执行前先检查实际路径（`find src -name "*.json" -path "*/locales/*"`）。

3. **get_table_data invoke 参数格式**: Tauri `invoke` 会将 camelCase 参数传给 Rust snake_case 命令参数。结构体字段直接用 snake_case 在前端序列化，`invoke('get_table_data', { params: { connection_id: ... } })`。

4. **ERDiagram `initialElements`**: Task 9 执行前先阅读 `src/data/initialElements.ts` 确认节点数据结构。

5. **Oracle/MSSQL**: Task 2/3 的扩展方法有默认空实现，Oracle/MSSQL 不需要实现，V1 仅保证 MySQL + PG 完整支持。
