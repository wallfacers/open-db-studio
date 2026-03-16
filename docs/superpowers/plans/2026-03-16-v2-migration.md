# V2 跨数据源迁移 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现跨数据源迁移功能：DDL 跨方言转换（异构优先）、分批数据迁移、迁移预检、任务管理（暂停/恢复/重试），以及 4 步向导前端。

**Architecture:** 在 Rust 后端新增 `migration/` 模块（4 个子文件），任务状态持久化到 SQLite `migration_tasks` 表，进度通过 Tauri Event `migration:progress` 广播前端，TaskCenter 展示摘要条目。

**Tech Stack:** Rust (rusqlite, async, tokio), React 18 + TypeScript, Tauri 2.x Events

> **依赖说明：** `schema/init.sql` 中的 `migration_tasks` 和 `migration_checks` 表由 Plan A Task 1 已添加。本计划可与 Plan A 并行开发，无运行时依赖。

---

## Chunk 1: Rust migration/ 模块 — DDL 转换 + 预检

### Task 1: migration/ 模块骨架

**Files:**
- Create: `src-tauri/src/migration/mod.rs`
- Create: `src-tauri/src/migration/ddl_convert.rs`
- Create: `src-tauri/src/migration/precheck.rs`
- Create: `src-tauri/src/migration/data_pump.rs`
- Create: `src-tauri/src/migration/task_mgr.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 migration/mod.rs**

```rust
// src-tauri/src/migration/mod.rs
pub mod data_pump;
pub mod ddl_convert;
pub mod precheck;
pub mod task_mgr;

pub use task_mgr::{
    MigrationTask, MigrationConfig, MigrationStatus,
    create_task, get_task, list_tasks, start_migration, pause_migration,
};
pub use precheck::{run_precheck, PreCheckResult, CheckItem};
```

- [ ] **Step 2: 创建模型类型（migration/task_mgr.rs 骨架）**

```rust
// src-tauri/src/migration/task_mgr.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MigrationStatus {
    Pending,
    Running,
    Paused,
    Done,
    Failed,
}

impl std::fmt::Display for MigrationStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Paused => write!(f, "paused"),
            Self::Done => write!(f, "done"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationTableConfig {
    pub src_table: String,
    pub dst_table: String,
    /// 类型映射覆盖 {"old_col": "new_type"}
    pub type_overrides: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationConfig {
    pub tables: Vec<MigrationTableConfig>,
    pub batch_size: usize,
    pub skip_errors: bool,
}

impl Default for MigrationConfig {
    fn default() -> Self {
        Self { tables: vec![], batch_size: 500, skip_errors: true }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationProgress {
    pub task_id: i64,
    pub current_table: String,
    pub done_rows: i64,
    pub total_rows: i64,
    pub error_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MigrationTask {
    pub id: i64,
    pub name: String,
    pub src_connection_id: i64,
    pub dst_connection_id: i64,
    pub config: MigrationConfig,
    pub status: MigrationStatus,
    pub progress: Option<MigrationProgress>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_task(
    name: &str,
    src_connection_id: i64,
    dst_connection_id: i64,
    config: &MigrationConfig,
) -> AppResult<MigrationTask> {
    let conn = crate::db::get().lock().unwrap();
    let config_json = serde_json::to_string(config)
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO migration_tasks (name, src_connection_id, dst_connection_id, config, status)
         VALUES (?1, ?2, ?3, ?4, 'pending')",
        rusqlite::params![name, src_connection_id, dst_connection_id, config_json],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    get_task(id)
}

pub fn get_task(id: i64) -> AppResult<MigrationTask> {
    let conn = crate::db::get().lock().unwrap();
    conn.query_row(
        "SELECT id,name,src_connection_id,dst_connection_id,config,status,progress,created_at,updated_at
         FROM migration_tasks WHERE id=?1",
        [id],
        |row| {
            let config_str: String = row.get(4)?;
            let status_str: String = row.get(5)?;
            let progress_str: Option<String> = row.get(6)?;
            Ok(MigrationTask {
                id: row.get(0)?,
                name: row.get(1)?,
                src_connection_id: row.get(2)?,
                dst_connection_id: row.get(3)?,
                config: serde_json::from_str(&config_str).unwrap_or_default(),
                status: match status_str.as_str() {
                    "running" => MigrationStatus::Running,
                    "paused" => MigrationStatus::Paused,
                    "done" => MigrationStatus::Done,
                    "failed" => MigrationStatus::Failed,
                    _ => MigrationStatus::Pending,
                },
                progress: progress_str
                    .and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }
    ).map_err(Into::into)
}

pub fn list_tasks() -> AppResult<Vec<MigrationTask>> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id FROM migration_tasks ORDER BY created_at DESC LIMIT 100"
    )?;
    let ids: Vec<i64> = stmt.query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(conn);
    ids.iter().map(|&id| get_task(id)).collect()
}

pub fn set_status(id: i64, status: &MigrationStatus) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE migration_tasks SET status=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, status.to_string()],
    )?;
    Ok(())
}

pub fn save_progress(id: i64, progress: &MigrationProgress) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let json = serde_json::to_string(progress)
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE migration_tasks SET progress=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, json],
    )?;
    Ok(())
}

pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    // Task 3 实现
    let _ = (task_id, app_handle);
    Ok(())
}

pub fn pause_migration(task_id: i64) -> AppResult<()> {
    set_status(task_id, &MigrationStatus::Paused)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_display() {
        assert_eq!(MigrationStatus::Running.to_string(), "running");
        assert_eq!(MigrationStatus::Done.to_string(), "done");
    }

    #[test]
    fn test_config_serialization() {
        let cfg = MigrationConfig {
            tables: vec![MigrationTableConfig {
                src_table: "orders".into(),
                dst_table: "orders".into(),
                type_overrides: None,
            }],
            batch_size: 100,
            skip_errors: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let restored: MigrationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.batch_size, 100);
        assert_eq!(restored.tables[0].src_table, "orders");
    }
}
```

- [ ] **Step 3: 在 lib.rs 注册模块**

在 `src-tauri/src/lib.rs` 顶部添加：

```rust
mod migration;
```

- [ ] **Step 4: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: 运行骨架测试**

```bash
cd src-tauri && cargo test migration::task_mgr::tests
```

期望：2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/migration/ src-tauri/src/lib.rs
git commit -m "feat(migration): add migration module skeleton with task model and status machine"
```

---

### Task 2: 实现 ddl_convert.rs — DDL 跨方言转换

**Files:**
- Modify: `src-tauri/src/migration/ddl_convert.rs`

- [ ] **Step 1: 写类型映射失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mysql_to_pg_int() {
        let pg_type = convert_type("mysql", "postgres", "INT");
        assert_eq!(pg_type, "INTEGER");
    }

    #[test]
    fn test_mysql_to_pg_datetime() {
        let pg_type = convert_type("mysql", "postgres", "DATETIME");
        assert_eq!(pg_type, "TIMESTAMP");
    }

    #[test]
    fn test_pg_to_mysql_boolean() {
        let mysql_type = convert_type("postgres", "mysql", "BOOLEAN");
        assert_eq!(mysql_type, "TINYINT(1)");
    }

    #[test]
    fn test_unknown_type_passthrough() {
        let t = convert_type("mysql", "postgres", "JSONB");
        assert_eq!(t, "JSONB"); // 未知类型原样保留
    }
}
```

- [ ] **Step 2: 运行测试（FAIL）**

```bash
cd src-tauri && cargo test migration::ddl_convert::tests
```

- [ ] **Step 3: 实现 ddl_convert.rs**

```rust
// src-tauri/src/migration/ddl_convert.rs
use crate::AppResult;
use crate::datasource::ColumnMeta;

/// 将 src_driver 的类型名转换为 dst_driver 的类型名
pub fn convert_type(src_driver: &str, dst_driver: &str, src_type: &str) -> String {
    let normalized = src_type.to_uppercase();
    // 去掉括号部分（INT(11) -> INT）
    let base = normalized.split('(').next().unwrap_or(&normalized).trim();

    match (src_driver, dst_driver, base) {
        // MySQL → PostgreSQL
        ("mysql", "postgres", "INT") | ("mysql", "postgres", "INTEGER") => "INTEGER".into(),
        // ⚠️ TINYINT(1) 特殊处理：需在 base 之前检查原始字符串
        ("mysql", "postgres", t) if t == "TINYINT" && src_type.contains("(1)") => "BOOLEAN".into(),
        ("mysql", "postgres", "TINYINT") => "SMALLINT".into(),
        ("mysql", "postgres", "BIGINT") => "BIGINT".into(),
        ("mysql", "postgres", "FLOAT") => "REAL".into(),
        ("mysql", "postgres", "DOUBLE") => "DOUBLE PRECISION".into(),
        ("mysql", "postgres", "DECIMAL") | ("mysql", "postgres", "NUMERIC") => {
            // 保留原始精度
            src_type.to_uppercase()
        }
        ("mysql", "postgres", "VARCHAR") => src_type.to_uppercase().replace("VARCHAR", "VARCHAR"),
        ("mysql", "postgres", "TEXT") | ("mysql", "postgres", "LONGTEXT")
        | ("mysql", "postgres", "MEDIUMTEXT") | ("mysql", "postgres", "TINYTEXT") => "TEXT".into(),
        ("mysql", "postgres", "DATETIME") => "TIMESTAMP".into(),
        ("mysql", "postgres", "TIMESTAMP") => "TIMESTAMPTZ".into(),
        ("mysql", "postgres", "DATE") => "DATE".into(),
        ("mysql", "postgres", "TIME") => "TIME".into(),
        ("mysql", "postgres", "BLOB") | ("mysql", "postgres", "LONGBLOB")
        | ("mysql", "postgres", "MEDIUMBLOB") | ("mysql", "postgres", "TINYBLOB") => "BYTEA".into(),
        ("mysql", "postgres", "JSON") => "JSONB".into(),
        ("mysql", "postgres", "TINYINT") if src_type.to_uppercase().contains("(1)") => "BOOLEAN".into(),
        ("mysql", "postgres", "ENUM") => "TEXT".into(),
        ("mysql", "postgres", "SET") => "TEXT".into(),

        // PostgreSQL → MySQL
        ("postgres", "mysql", "INTEGER") | ("postgres", "mysql", "INT4") => "INT".into(),
        ("postgres", "mysql", "BIGINT") | ("postgres", "mysql", "INT8") => "BIGINT".into(),
        ("postgres", "mysql", "SMALLINT") | ("postgres", "mysql", "INT2") => "SMALLINT".into(),
        ("postgres", "mysql", "REAL") | ("postgres", "mysql", "FLOAT4") => "FLOAT".into(),
        ("postgres", "mysql", "DOUBLE PRECISION") | ("postgres", "mysql", "FLOAT8") => "DOUBLE".into(),
        ("postgres", "mysql", "BOOLEAN") | ("postgres", "mysql", "BOOL") => "TINYINT(1)".into(),
        ("postgres", "mysql", "TEXT") => "LONGTEXT".into(),
        ("postgres", "mysql", "BYTEA") => "LONGBLOB".into(),
        ("postgres", "mysql", "JSONB") | ("postgres", "mysql", "JSON") => "JSON".into(),
        ("postgres", "mysql", "TIMESTAMP") | ("postgres", "mysql", "TIMESTAMPTZ") => "DATETIME".into(),
        ("postgres", "mysql", "UUID") => "CHAR(36)".into(),
        ("postgres", "mysql", "SERIAL") => "INT AUTO_INCREMENT".into(),
        ("postgres", "mysql", "BIGSERIAL") => "BIGINT AUTO_INCREMENT".into(),

        // MySQL → SQLServer
        ("mysql", "sqlserver", "INT") | ("mysql", "sqlserver", "INTEGER") => "INT".into(),
        ("mysql", "sqlserver", "BIGINT") => "BIGINT".into(),
        ("mysql", "sqlserver", "TINYINT") => "TINYINT".into(),
        ("mysql", "sqlserver", "FLOAT") | ("mysql", "sqlserver", "DOUBLE") => "FLOAT".into(),
        ("mysql", "sqlserver", "DATETIME") | ("mysql", "sqlserver", "TIMESTAMP") => "DATETIME2".into(),
        ("mysql", "sqlserver", "TEXT") | ("mysql", "sqlserver", "LONGTEXT") => "NVARCHAR(MAX)".into(),
        ("mysql", "sqlserver", "JSON") => "NVARCHAR(MAX)".into(),
        ("mysql", "sqlserver", "BLOB") | ("mysql", "sqlserver", "LONGBLOB") => "VARBINARY(MAX)".into(),

        // PostgreSQL → SQLServer
        ("postgres", "sqlserver", "INTEGER") | ("postgres", "sqlserver", "INT4") => "INT".into(),
        ("postgres", "sqlserver", "BIGINT") => "BIGINT".into(),
        ("postgres", "sqlserver", "BOOLEAN") | ("postgres", "sqlserver", "BOOL") => "BIT".into(),
        ("postgres", "sqlserver", "TEXT") => "NVARCHAR(MAX)".into(),
        ("postgres", "sqlserver", "BYTEA") => "VARBINARY(MAX)".into(),
        ("postgres", "sqlserver", "TIMESTAMP") | ("postgres", "sqlserver", "TIMESTAMPTZ") => "DATETIME2".into(),
        ("postgres", "sqlserver", "JSONB") | ("postgres", "sqlserver", "JSON") => "NVARCHAR(MAX)".into(),

        // 同构或未知：原样保留
        _ => src_type.to_uppercase(),
    }
}

/// 生成目标表的 CREATE TABLE DDL
pub fn generate_create_table_ddl(
    src_driver: &str,
    dst_driver: &str,
    table_name: &str,
    columns: &[ColumnMeta],
    type_overrides: &std::collections::HashMap<String, String>,
) -> String {
    let mut lines = Vec::new();
    let mut pk_cols = Vec::new();

    for col in columns {
        let src_type = &col.data_type;
        let dst_type = if let Some(override_type) = type_overrides.get(&col.name) {
            override_type.clone()
        } else {
            convert_type(src_driver, dst_driver, src_type)
        };

        let nullable = if col.is_nullable { "" } else { " NOT NULL" };
        let default = col.column_default.as_deref()
            .map(|d| format!(" DEFAULT {}", d))
            .unwrap_or_default();

        lines.push(format!("    {} {}{}{}", col.name, dst_type, nullable, default));

        if col.is_primary_key {
            pk_cols.push(col.name.clone());
        }
    }

    if !pk_cols.is_empty() {
        lines.push(format!("    PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    format!(
        "CREATE TABLE IF NOT EXISTS {} (\n{}\n);",
        table_name,
        lines.join(",\n")
    )
}

/// 检测类型映射兼容性问题
pub fn check_type_compatibility(
    src_driver: &str,
    dst_driver: &str,
    table_name: &str,
    columns: &[ColumnMeta],
) -> Vec<super::precheck::CheckItem> {
    let mut issues = Vec::new();
    let problematic_pairs = [
        ("mysql", "postgres", "ENUM", "warning", "ENUM 将转换为 TEXT，丢失约束"),
        ("mysql", "postgres", "SET", "warning", "SET 将转换为 TEXT，丢失约束"),
        ("mysql", "postgres", "TINYINT", "info", "TINYINT 转为 SMALLINT，注意范围差异"),
        ("postgres", "mysql", "UUID", "warning", "UUID 转为 CHAR(36)，性能可能下降"),
        ("postgres", "mysql", "ARRAY", "error", "MySQL 不支持 ARRAY 类型"),
        ("postgres", "mysql", "JSONB", "warning", "JSONB 转为 JSON，丢失 GIN 索引特性"),
    ];

    for col in columns {
        let base = col.data_type.to_uppercase();
        let base = base.split('(').next().unwrap_or(&base).trim();
        for (src, dst, t, severity, msg) in &problematic_pairs {
            if src_driver == *src && dst_driver == *dst && base == *t {
                issues.push(super::precheck::CheckItem {
                    check_type: "type_compat".into(),
                    table_name: table_name.into(),
                    column_name: Some(col.name.clone()),
                    severity: severity.to_string(),
                    message: msg.to_string(),
                });
            }
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mysql_to_pg_int() {
        assert_eq!(convert_type("mysql", "postgres", "INT"), "INTEGER");
    }

    #[test]
    fn test_mysql_to_pg_datetime() {
        assert_eq!(convert_type("mysql", "postgres", "DATETIME"), "TIMESTAMP");
    }

    #[test]
    fn test_pg_to_mysql_boolean() {
        assert_eq!(convert_type("postgres", "mysql", "BOOLEAN"), "TINYINT(1)");
    }

    #[test]
    fn test_unknown_type_passthrough() {
        assert_eq!(convert_type("mysql", "postgres", "JSONB"), "JSONB");
    }

    #[test]
    fn test_generate_ddl_basic() {
        use crate::datasource::ColumnMeta;
        let cols = vec![
            ColumnMeta { name: "id".into(), data_type: "INT".into(), is_nullable: false,
                         column_default: None, is_primary_key: true, extra: None },
            ColumnMeta { name: "name".into(), data_type: "VARCHAR(255)".into(), is_nullable: true,
                         column_default: None, is_primary_key: false, extra: None },
        ];
        let ddl = generate_create_table_ddl("mysql", "postgres", "users", &cols, &Default::default());
        assert!(ddl.contains("CREATE TABLE IF NOT EXISTS users"));
        assert!(ddl.contains("PRIMARY KEY"));
    }
}
```

- [ ] **Step 4: 运行测试**

```bash
cd src-tauri && cargo test migration::ddl_convert::tests
```

期望：5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migration/ddl_convert.rs
git commit -m "feat(migration): implement DDL cross-dialect converter with type mapping table"
```

---

### Task 3: 实现 precheck.rs — 迁移前兼容性检查

**Files:**
- Modify: `src-tauri/src/migration/precheck.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写预检测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_item_severity_order() {
        let items = vec![
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "warning".into(), message: "w".into() },
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "error".into(), message: "e".into() },
        ];
        let has_error = items.iter().any(|i| i.severity == "error");
        assert!(has_error);
    }
}
```

- [ ] **Step 2: 运行测试（应通过，CheckItem 已定义）**

```bash
cd src-tauri && cargo test migration::precheck::tests
```

- [ ] **Step 3: 实现 precheck.rs**

```rust
// src-tauri/src/migration/precheck.rs
use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckItem {
    pub check_type: String,  // type_compat | null_constraint | pk_conflict | other
    pub table_name: String,
    pub column_name: Option<String>,
    pub severity: String,    // error | warning | info
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreCheckResult {
    pub task_id: i64,
    pub items: Vec<CheckItem>,
    pub has_errors: bool,
    pub has_warnings: bool,
}

fn save_check_items(task_id: i64, items: &[CheckItem]) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    // 先清除旧记录
    conn.execute("DELETE FROM migration_checks WHERE task_id=?1", [task_id])?;
    for item in items {
        conn.execute(
            "INSERT INTO migration_checks (task_id,check_type,table_name,column_name,severity,message)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                task_id, item.check_type, item.table_name,
                item.column_name, item.severity, item.message
            ],
        )?;
    }
    Ok(())
}

pub async fn run_precheck(task_id: i64) -> AppResult<PreCheckResult> {
    let task = super::task_mgr::get_task(task_id)?;

    let src_config = crate::db::get_connection_config(task.src_connection_id)?;
    let dst_config = crate::db::get_connection_config(task.dst_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;

    let mut all_items = Vec::new();

    for table_cfg in &task.config.tables {
        let src_cols = src_ds.get_columns(&table_cfg.src_table).await
            .unwrap_or_default();

        if src_cols.is_empty() {
            all_items.push(CheckItem {
                check_type: "other".into(),
                table_name: table_cfg.src_table.clone(),
                column_name: None,
                severity: "error".into(),
                message: format!("源表 {} 不存在或无字段", table_cfg.src_table),
            });
            continue;
        }

        // 1. 类型兼容性检查
        let type_issues = super::ddl_convert::check_type_compatibility(
            &src_config.driver,
            &dst_config.driver,
            &table_cfg.src_table,
            &src_cols,
        );
        all_items.extend(type_issues);

        // 2. NOT NULL 约束检查（源表有 NOT NULL 但无默认值的字段）
        for col in &src_cols {
            if !col.is_nullable && col.column_default.is_none() && !col.is_primary_key {
                // 这些字段在迁移时若有空值会报错，给 info 提示
                all_items.push(CheckItem {
                    check_type: "null_constraint".into(),
                    table_name: table_cfg.src_table.clone(),
                    column_name: Some(col.name.clone()),
                    severity: "info".into(),
                    message: format!(
                        "字段 {} 为 NOT NULL 且无默认值，请确保源数据无空值",
                        col.name
                    ),
                });
            }
        }

        // 3. 主键检查
        let pk_cols: Vec<_> = src_cols.iter().filter(|c| c.is_primary_key).collect();
        if pk_cols.is_empty() {
            all_items.push(CheckItem {
                check_type: "pk_conflict".into(),
                table_name: table_cfg.src_table.clone(),
                column_name: None,
                severity: "warning".into(),
                message: "源表无主键，迁移时可能产生重复数据".into(),
            });
        }
    }

    save_check_items(task_id, &all_items)?;

    let has_errors = all_items.iter().any(|i| i.severity == "error");
    let has_warnings = all_items.iter().any(|i| i.severity == "warning");

    Ok(PreCheckResult { task_id, items: all_items, has_errors, has_warnings })
}

pub fn get_precheck_result(task_id: i64) -> AppResult<PreCheckResult> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT check_type,table_name,column_name,severity,message
         FROM migration_checks WHERE task_id=?1 ORDER BY severity DESC, table_name"
    )?;
    let items: Vec<CheckItem> = stmt.query_map([task_id], |row| {
        Ok(CheckItem {
            check_type: row.get(0)?,
            table_name: row.get(1)?,
            column_name: row.get(2)?,
            severity: row.get(3)?,
            message: row.get(4)?,
        })
    })?.collect::<Result<Vec<_>, _>>()?;

    let has_errors = items.iter().any(|i| i.severity == "error");
    let has_warnings = items.iter().any(|i| i.severity == "warning");
    Ok(PreCheckResult { task_id, items, has_errors, has_warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_item_severity_order() {
        let items = vec![
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "warning".into(), message: "w".into() },
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "error".into(), message: "e".into() },
        ];
        let has_error = items.iter().any(|i| i.severity == "error");
        assert!(has_error);
    }
}
```

- [ ] **Step 4: 在 commands.rs 添加 migration commands（第一批）**

```rust
// ============ 跨数据源迁移 ============

#[tauri::command]
pub async fn create_migration_task(
    name: String,
    src_connection_id: i64,
    dst_connection_id: i64,
    config: crate::migration::MigrationConfig,
) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::create_task(&name, src_connection_id, dst_connection_id, &config)
}

#[tauri::command]
pub async fn list_migration_tasks() -> AppResult<Vec<crate::migration::MigrationTask>> {
    crate::migration::list_tasks()
}

#[tauri::command]
pub async fn run_migration_precheck(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::run_precheck(task_id).await
}

#[tauri::command]
pub async fn get_precheck_report(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::get_precheck_result(task_id)
}

#[tauri::command]
pub async fn pause_migration(task_id: i64) -> AppResult<()> {
    crate::migration::pause_migration(task_id)
}

#[tauri::command]
pub async fn get_migration_progress(
    task_id: i64,
) -> AppResult<Option<crate::migration::task_mgr::MigrationProgress>> {
    let task = crate::migration::get_task(task_id)?;
    Ok(task.progress)
}
```

- [ ] **Step 5: 注册 commands 到 lib.rs**

```rust
commands::create_migration_task,
commands::list_migration_tasks,
commands::run_migration_precheck,
commands::get_precheck_report,
commands::pause_migration,
```

- [ ] **Step 6: 验证 + 测试**

```bash
cd src-tauri && cargo check && cargo test migration::
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/migration/precheck.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(migration): implement precheck — type compat, null constraint, PK validation"
```

---

## Chunk 2: Data Pump + Task Manager

### Task 4: 实现 data_pump.rs — 分批数据迁移

**Files:**
- Modify: `src-tauri/src/migration/data_pump.rs`
- Modify: `src-tauri/src/migration/task_mgr.rs`（实现 start_migration）
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 实现 data_pump.rs**

```rust
// src-tauri/src/migration/data_pump.rs
use crate::AppResult;
use super::task_mgr::{MigrationStatus, MigrationProgress, save_progress, set_status};
use tauri::Emitter;

pub struct PumpResult {
    pub migrated_rows: i64,
    pub error_rows: i64,
    pub error_details: Vec<String>,
}

pub async fn pump_table(
    task_id: i64,
    src_ds: &dyn crate::datasource::DataSource,
    dst_ds: &dyn crate::datasource::DataSource,
    src_table: &str,
    dst_table: &str,
    batch_size: usize,
    skip_errors: bool,
    app_handle: &tauri::AppHandle,
) -> AppResult<PumpResult> {
    // 1. 获取总行数
    let count_result = src_ds.execute(&format!("SELECT COUNT(*) FROM {}", src_table)).await?;
    let total_rows = count_result.rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let mut offset = 0i64;
    let mut migrated = 0i64;
    let mut error_count = 0i64;
    let mut error_details = Vec::new();

    loop {
        // 检查任务是否被暂停
        let task = super::task_mgr::get_task(task_id)?;
        if task.status == MigrationStatus::Paused {
            log::info!("[migration] Task {} paused at {} rows", task_id, migrated);
            break;
        }

        // 分批读取
        let batch_sql = format!(
            "SELECT * FROM {} LIMIT {} OFFSET {}",
            src_table, batch_size, offset
        );
        let batch = match src_ds.execute(&batch_sql).await {
            Ok(r) => r,
            Err(e) => {
                if skip_errors {
                    log::warn!("[migration] Batch read error: {}", e);
                    break;
                }
                return Err(e);
            }
        };

        if batch.rows.is_empty() { break; }

        let row_count = batch.rows.len() as i64;

        // 逐行写入目标（INSERT）
        for row in &batch.rows {
            let placeholders: Vec<String> = (1..=batch.columns.len())
                .map(|i| format!("?{}", i))
                .collect();
            let cols = batch.columns.join(", ");
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                dst_table, cols, placeholders.join(", ")
            );

            // 将 JSON Value 序列化为字符串参数（简化实现）
            let params: Vec<String> = row.iter()
                .map(|v| match v {
                    serde_json::Value::Null => "NULL".to_string(),
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();

            // 直接构建完整 SQL（简化参数绑定，避免跨数据源 trait 差异）
            let mut final_sql = format!("INSERT INTO {} ({}) VALUES (", dst_table, cols);
            for (i, p) in params.iter().enumerate() {
                if i > 0 { final_sql.push_str(", "); }
                if p == "NULL" {
                    final_sql.push_str("NULL");
                } else {
                    final_sql.push_str(&format!("'{}'", p.replace('\'', "''")));
                }
            }
            final_sql.push(')');

            if let Err(e) = dst_ds.execute(&final_sql).await {
                error_count += 1;
                let detail = format!("行写入失败 (offset {}): {}", offset + migrated, e);
                error_details.push(detail);
                if !skip_errors { break; }
            } else {
                migrated += 1;
            }
        }

        // 广播进度
        let progress = MigrationProgress {
            task_id,
            current_table: src_table.to_string(),
            done_rows: migrated,
            total_rows,
            error_count,
        };
        let _ = save_progress(task_id, &progress);
        let _ = app_handle.emit("migration:progress", &progress);

        offset += row_count;
        if row_count < batch_size as i64 { break; }
    }

    Ok(PumpResult {
        migrated_rows: migrated,
        error_rows: error_count,
        error_details,
    })
}
```

- [ ] **Step 2: 实现 task_mgr.rs 中的 start_migration**

替换 `task_mgr.rs` 中的 `start_migration` 占位：

```rust
pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    let task = get_task(task_id)?;

    // 只有 pending 或 paused 状态才能启动
    if task.status != MigrationStatus::Pending && task.status != MigrationStatus::Paused {
        return Err(crate::AppError::Other(
            format!("任务状态为 {}，不能启动", task.status)
        ));
    }

    set_status(task_id, &MigrationStatus::Running)?;

    // 在后台 tokio task 中执行，不阻塞 Tauri command
    let app_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_migration_job(task_id, app_clone).await {
            log::error!("[migration] Task {} failed: {}", task_id, e);
            let _ = set_status(task_id, &MigrationStatus::Failed);
        }
    });

    Ok(())
}

async fn run_migration_job(task_id: i64, app_handle: tauri::AppHandle) -> AppResult<()> {
    let task = get_task(task_id)?;
    let src_config = crate::db::get_connection_config(task.src_connection_id)?;
    let dst_config = crate::db::get_connection_config(task.dst_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;
    let dst_ds = crate::datasource::create_datasource(&dst_config).await?;

    let mut total_errors = 0i64;
    let mut all_error_details = Vec::new();

    for table_cfg in &task.config.tables {
        // 1. 生成目标表 DDL
        let src_cols = src_ds.get_columns(&table_cfg.src_table).await?;
        let type_overrides = table_cfg.type_overrides.clone().unwrap_or_default();
        let ddl = crate::migration::ddl_convert::generate_create_table_ddl(
            &src_config.driver,
            &dst_config.driver,
            &table_cfg.dst_table,
            &src_cols,
            &type_overrides,
        );

        // 2. 在目标库创建表
        if let Err(e) = dst_ds.execute(&ddl).await {
            log::warn!("[migration] DDL failed for {}: {}", table_cfg.dst_table, e);
        }

        // 3. 数据泵
        let result = crate::migration::data_pump::pump_table(
            task_id,
            src_ds.as_ref(),
            dst_ds.as_ref(),
            &table_cfg.src_table,
            &table_cfg.dst_table,
            task.config.batch_size,
            task.config.skip_errors,
            &app_handle,
        ).await?;

        total_errors += result.error_rows;
        all_error_details.extend(result.error_details);

        // 检查是否已暂停
        let current_status = get_task(task_id)?.status;
        if current_status == MigrationStatus::Paused {
            return Ok(());
        }
    }

    // 保存错误报告
    if !all_error_details.is_empty() {
        let conn = crate::db::get().lock().unwrap();
        let report = serde_json::to_string(&all_error_details).unwrap_or_default();
        conn.execute(
            "UPDATE migration_tasks SET error_report=?2 WHERE id=?1",
            rusqlite::params![task_id, report],
        )?;
    }

    let final_status = if total_errors > 0 && !task.config.skip_errors {
        MigrationStatus::Failed
    } else {
        MigrationStatus::Done
    };
    set_status(task_id, &final_status)?;
    use tauri::Emitter;
    let _ = app_handle.emit("migration:complete", task_id);

    log::info!("[migration] Task {} completed with {} errors", task_id, total_errors);
    Ok(())
}
```

- [ ] **Step 3: 在 commands.rs 添加 start_migration command**

```rust
#[tauri::command]
pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    crate::migration::start_migration(task_id, app_handle).await
}

#[tauri::command]
pub async fn get_migration_task(task_id: i64) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::get_task(task_id)
}
```

- [ ] **Step 4: 注册 commands**

```rust
commands::start_migration,
commands::get_migration_task,
commands::get_migration_progress,
```

- [ ] **Step 4.5: 确认 DataSource trait 接口（执行前必做）**

在编译之前，先确认 `src-tauri/src/datasource/mod.rs` 中：
1. `create_datasource` 返回类型是 `Box<dyn DataSource>` 或 `Box<dyn DataSource + Send + Sync>`
2. `DataSource` trait 已标注 `#[async_trait]`
3. 若不满足，在 `datasource/mod.rs` 中修改返回类型和 trait 标注

```bash
grep -n "create_datasource\|DataSource" src-tauri/src/datasource/mod.rs | head -20
```

期望输出中应包含 `pub async fn create_datasource(...) -> AppResult<Box<dyn DataSource`

- [ ] **Step 5: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/migration/
git commit -m "feat(migration): implement data pump — batch read/write with progress events and pause support"
```

---

## Chunk 3: 前端 MigrationWizard

### Task 5: MigrationWizard 前端组件

**Files:**
- Create: `src/components/MigrationWizard/index.tsx`
- Create: `src/components/MigrationWizard/Step1_Source.tsx`
- Create: `src/components/MigrationWizard/Step2_Tables.tsx`
- Create: `src/components/MigrationWizard/Step3_Precheck.tsx`
- Create: `src/components/MigrationWizard/Step4_Progress.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 创建 MigrationWizard/index.tsx（向导容器）**

```tsx
// src/components/MigrationWizard/index.tsx
import { useState } from 'react'
import Step1_Source from './Step1_Source'
import Step2_Tables from './Step2_Tables'
import Step3_Precheck from './Step3_Precheck'
import Step4_Progress from './Step4_Progress'

export interface MigrationState {
  srcConnectionId: number | null
  dstConnectionId: number | null
  taskId: number | null
  selectedTables: string[]
}

export default function MigrationWizard() {
  const [step, setStep] = useState(1)
  const [state, setState] = useState<MigrationState>({
    srcConnectionId: null,
    dstConnectionId: null,
    taskId: null,
    selectedTables: [],
  })

  const steps = ['选择数据源', '选择表', '兼容性预检', '执行迁移']

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* 步骤指示器 */}
      <div className="flex items-center px-6 py-4 border-b border-gray-700 gap-0">
        {steps.map((label, i) => {
          const n = i + 1
          const isActive = step === n
          const isDone = step > n
          return (
            <div key={n} className="flex items-center">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
                isActive ? 'bg-blue-600 text-white' :
                isDone ? 'text-green-400' : 'text-gray-500'
              }`}>
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                  isActive ? 'bg-white text-blue-600' :
                  isDone ? 'bg-green-500 text-white' : 'bg-gray-700 text-gray-400'
                }`}>
                  {isDone ? '✓' : n}
                </span>
                {label}
              </div>
              {i < steps.length - 1 && (
                <div className={`w-8 h-px mx-1 ${isDone ? 'bg-green-500' : 'bg-gray-700'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* 步骤内容 */}
      <div className="flex-1 overflow-y-auto">
        {step === 1 && (
          <Step1_Source
            state={state}
            onNext={(srcId, dstId) => {
              setState(s => ({ ...s, srcConnectionId: srcId, dstConnectionId: dstId }))
              setStep(2)
            }}
          />
        )}
        {step === 2 && (
          <Step2_Tables
            state={state}
            onBack={() => setStep(1)}
            onNext={(tables, taskId) => {
              setState(s => ({ ...s, selectedTables: tables, taskId }))
              setStep(3)
            }}
          />
        )}
        {step === 3 && (
          <Step3_Precheck
            state={state}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <Step4_Progress
            state={state}
            onBack={() => setStep(3)}
            onReset={() => {
              setState({ srcConnectionId: null, dstConnectionId: null, taskId: null, selectedTables: [] })
              setStep(1)
            }}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 Step1_Source.tsx**

```tsx
// src/components/MigrationWizard/Step1_Source.tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MigrationState } from './index'

interface Connection { id: number; name: string; driver: string }

interface Props {
  state: MigrationState
  onNext: (srcId: number, dstId: number) => void
}

export default function Step1_Source({ state, onNext }: Props) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [srcId, setSrcId] = useState<number>(state.srcConnectionId ?? 0)
  const [dstId, setDstId] = useState<number>(state.dstConnectionId ?? 0)
  const [error, setError] = useState('')

  useEffect(() => {
    invoke<Connection[]>('list_connections').then(setConnections)
  }, [])

  const handleNext = () => {
    if (!srcId || !dstId) { setError('请选择源库和目标库'); return }
    if (srcId === dstId) { setError('源库和目标库不能相同'); return }
    onNext(srcId, dstId)
  }

  return (
    <div className="p-8 max-w-lg">
      <h2 className="text-base font-medium mb-6">选择迁移数据源</h2>
      <div className="space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">源数据库</label>
          <select
            className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white"
            value={srcId}
            onChange={e => setSrcId(Number(e.target.value))}
          >
            <option value={0}>-- 请选择 --</option>
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.driver})</option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-center text-gray-500 text-xl">→</div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">目标数据库</label>
          <select
            className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white"
            value={dstId}
            onChange={e => setDstId(Number(e.target.value))}
          >
            <option value={0}>-- 请选择 --</option>
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.driver})</option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      <div className="flex justify-end mt-6">
        <button
          onClick={handleNext}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
        >
          下一步
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 创建 Step2_Tables.tsx**

```tsx
// src/components/MigrationWizard/Step2_Tables.tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MigrationState } from './index'

interface Props {
  state: MigrationState
  onBack: () => void
  onNext: (tables: string[], taskId: number) => void
}

export default function Step2_Tables({ state, onBack, onNext }: Props) {
  const [tables, setTables] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [batchSize, setBatchSize] = useState(500)
  const [skipErrors, setSkipErrors] = useState(true)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!state.srcConnectionId) return
    setLoading(true)
    invoke<{ tables: { name: string }[] }>('get_schema_info', {
      connectionId: state.srcConnectionId
    }).then(schema => {
      setTables(schema.tables.map(t => t.name))
      setSelected(schema.tables.map(t => t.name)) // 默认全选
    }).finally(() => setLoading(false))
  }, [state.srcConnectionId])

  const toggle = (name: string) => {
    setSelected(s => s.includes(name) ? s.filter(t => t !== name) : [...s, name])
  }

  const handleNext = async () => {
    if (selected.length === 0) return
    setCreating(true)
    try {
      const config = {
        tables: selected.map(t => ({ src_table: t, dst_table: t, type_overrides: null })),
        batch_size: batchSize,
        skip_errors: skipErrors,
      }
      const task = await invoke<{ id: number }>('create_migration_task', {
        name: `迁移任务 ${new Date().toLocaleString()}`,
        srcConnectionId: state.srcConnectionId,
        dstConnectionId: state.dstConnectionId,
        config,
      })
      onNext(selected, task.id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-base font-medium mb-4">选择迁移的表</h2>
      <div className="flex items-center gap-4 mb-4">
        <label className="text-xs text-gray-400">
          批量大小：
          <input
            type="number" min={1} max={10000}
            className="ml-2 w-20 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-xs"
            value={batchSize}
            onChange={e => setBatchSize(Number(e.target.value))}
          />
        </label>
        <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox" checked={skipErrors}
            onChange={e => setSkipErrors(e.target.checked)}
          />
          跳过错误行继续
        </label>
      </div>
      <div className="flex gap-2 mb-2">
        <button onClick={() => setSelected(tables)} className="text-xs text-blue-400 hover:text-blue-300">
          全选
        </button>
        <button onClick={() => setSelected([])} className="text-xs text-gray-400 hover:text-gray-300">
          全不选
        </button>
        <span className="text-xs text-gray-500">已选 {selected.length}/{tables.length}</span>
      </div>
      <div className="border border-gray-700 rounded overflow-y-auto max-h-64">
        {loading ? (
          <div className="text-center text-gray-400 text-xs py-8">加载中...</div>
        ) : tables.map(t => (
          <label key={t} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800 cursor-pointer border-b border-gray-800 last:border-0">
            <input
              type="checkbox"
              checked={selected.includes(t)}
              onChange={() => toggle(t)}
            />
            <span className="text-sm">{t}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-between mt-6">
        <button onClick={onBack} className="px-4 py-2 text-sm text-gray-400 hover:text-white">
          ← 上一步
        </button>
        <button
          onClick={handleNext}
          disabled={selected.length === 0 || creating}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
        >
          {creating ? '创建任务...' : '下一步 →'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 Step3_Precheck.tsx**

```tsx
// src/components/MigrationWizard/Step3_Precheck.tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MigrationState } from './index'

interface CheckItem {
  check_type: string
  table_name: string
  column_name?: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

interface PreCheckResult {
  task_id: number
  items: CheckItem[]
  has_errors: boolean
  has_warnings: boolean
}

interface Props {
  state: MigrationState
  onBack: () => void
  onNext: () => void
}

export default function Step3_Precheck({ state, onBack, onNext }: Props) {
  const [result, setResult] = useState<PreCheckResult | null>(null)
  const [loading, setLoading] = useState(false)

  const runCheck = async () => {
    if (!state.taskId) return
    setLoading(true)
    try {
      const r = await invoke<PreCheckResult>('run_migration_precheck', { taskId: state.taskId })
      setResult(r)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { runCheck() }, [state.taskId])

  const severityStyle = {
    error: 'text-red-400 bg-red-900/30 border-red-800',
    warning: 'text-yellow-400 bg-yellow-900/30 border-yellow-800',
    info: 'text-blue-400 bg-blue-900/20 border-blue-800',
  }

  const severityIcon = { error: '✗', warning: '⚠', info: 'ℹ' }

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium">兼容性预检</h2>
        <button
          onClick={runCheck}
          disabled={loading}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
        >
          {loading ? '检查中...' : '重新检查'}
        </button>
      </div>

      {loading && (
        <div className="text-center text-gray-400 text-sm py-8">正在检查兼容性...</div>
      )}

      {result && !loading && (
        <>
          <div className="flex gap-3 mb-4 text-xs">
            <span className={result.has_errors ? 'text-red-400' : 'text-gray-500'}>
              {result.items.filter(i => i.severity === 'error').length} 错误
            </span>
            <span className={result.has_warnings ? 'text-yellow-400' : 'text-gray-500'}>
              {result.items.filter(i => i.severity === 'warning').length} 警告
            </span>
            <span className="text-blue-400">
              {result.items.filter(i => i.severity === 'info').length} 提示
            </span>
          </div>

          {result.items.length === 0 && (
            <div className="text-center text-green-400 text-sm py-6">✓ 未发现兼容性问题，可以继续迁移</div>
          )}

          <div className="space-y-1 max-h-64 overflow-y-auto">
            {result.items.map((item, i) => (
              <div
                key={i}
                className={`flex gap-2 p-2 rounded border text-xs ${severityStyle[item.severity]}`}
              >
                <span>{severityIcon[item.severity]}</span>
                <div>
                  <span className="font-medium">{item.table_name}</span>
                  {item.column_name && <span className="text-gray-400">.{item.column_name}</span>}
                  <span className="ml-2">{item.message}</span>
                </div>
              </div>
            ))}
          </div>

          {result.has_errors && (
            <div className="mt-3 p-3 bg-red-900/20 border border-red-800 rounded text-xs text-red-300">
              存在错误项，可能导致迁移失败。建议修复后再继续，或确认跳过错误行。
            </div>
          )}
        </>
      )}

      <div className="flex justify-between mt-6">
        <button onClick={onBack} className="px-4 py-2 text-sm text-gray-400 hover:text-white">
          ← 上一步
        </button>
        <button
          onClick={onNext}
          disabled={loading || !result}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
        >
          {result?.has_errors ? '忽略错误，继续 →' : '开始迁移 →'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 创建 Step4_Progress.tsx**

```tsx
// src/components/MigrationWizard/Step4_Progress.tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { MigrationState } from './index'

interface MigrationProgress {
  task_id: number
  current_table: string
  done_rows: number
  total_rows: number
  error_count: number
}

interface Props {
  state: MigrationState
  onBack: () => void
  onReset: () => void
}

export default function Step4_Progress({ state, onBack, onReset }: Props) {
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'done' | 'failed'>('idle')
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    const unlisten = listen<MigrationProgress>('migration:progress', e => {
      setProgress(e.payload)
    })
    const unlistenComplete = listen<number>('migration:complete', async () => {
      const task = await invoke<{ status: string; error_report?: string }>('get_migration_task', {
        taskId: state.taskId
      })
      setStatus(task.status as any)
      if (task.error_report) {
        try { setErrorDetails(JSON.parse(task.error_report)) } catch { /**/ }
      }
    })
    return () => {
      unlisten.then(f => f())
      unlistenComplete.then(f => f())
    }
  }, [state.taskId])

  const handleStart = async () => {
    if (!state.taskId) return
    setStarting(true)
    setStatus('running')
    try {
      await invoke('start_migration', { taskId: state.taskId })
    } catch (e) {
      setStatus('failed')
    } finally {
      setStarting(false)
    }
  }

  const handlePause = async () => {
    if (!state.taskId) return
    await invoke('pause_migration', { taskId: state.taskId })
    setStatus('paused')
  }

  const pct = progress && progress.total_rows > 0
    ? Math.round((progress.done_rows / progress.total_rows) * 100)
    : 0

  return (
    <div className="p-8 max-w-xl">
      <h2 className="text-base font-medium mb-6">执行迁移</h2>

      {/* 进度条 */}
      <div className="mb-6">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>{progress?.current_table || '等待开始'}</span>
          <span>{pct}%</span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all duration-300 ${
              status === 'done' ? 'bg-green-500' :
              status === 'failed' ? 'bg-red-500' : 'bg-blue-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {progress && (
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{progress.done_rows.toLocaleString()} / {progress.total_rows.toLocaleString()} 行</span>
            {progress.error_count > 0 && (
              <span className="text-yellow-500">{progress.error_count} 个错误</span>
            )}
          </div>
        )}
      </div>

      {/* 状态区 */}
      {status === 'done' && (
        <div className="p-3 bg-green-900/20 border border-green-700 rounded text-sm text-green-300 mb-4">
          ✓ 迁移完成！
          {errorDetails.length > 0 && (
            <span className="text-yellow-400 ml-2">（{errorDetails.length} 行跳过）</span>
          )}
        </div>
      )}
      {status === 'failed' && (
        <div className="p-3 bg-red-900/20 border border-red-700 rounded text-sm text-red-300 mb-4">
          ✗ 迁移失败
        </div>
      )}

      {/* 错误详情 */}
      {errorDetails.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-medium text-gray-400 mb-1">跳过的错误行（前 10 条）</div>
          <div className="bg-gray-800 rounded p-2 max-h-32 overflow-y-auto space-y-0.5">
            {errorDetails.slice(0, 10).map((d, i) => (
              <div key={i} className="text-xs text-red-300">{d}</div>
            ))}
          </div>
        </div>
      )}

      {/* 控制按钮 */}
      <div className="flex justify-between">
        <button
          onClick={onBack}
          disabled={status === 'running'}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-30"
        >
          ← 上一步
        </button>
        <div className="flex gap-2">
          {(status === 'idle' || status === 'paused') && (
            <button
              onClick={handleStart}
              disabled={starting}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
            >
              {status === 'paused' ? '继续迁移' : starting ? '启动中...' : '开始迁移'}
            </button>
          )}
          {status === 'running' && (
            <button
              onClick={handlePause}
              className="px-6 py-2 bg-yellow-600 hover:bg-yellow-700 rounded text-sm"
            >
              暂停
            </button>
          )}
          {(status === 'done' || status === 'failed') && (
            <button
              onClick={onReset}
              className="px-6 py-2 bg-gray-600 hover:bg-gray-700 rounded text-sm"
            >
              新建迁移
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: 开发模式验证**

```bash
npm run dev
```

在 ActivityBar 添加迁移入口，验证 4 步向导能正常切换。

- [ ] **Step 8: Commit**

```bash
git add src/components/MigrationWizard/
git commit -m "feat(ui): add MigrationWizard — 4-step wizard with progress tracking and pause support"
```

---

## 最终验证

- [ ] **全量 Rust 编译**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

- [ ] **Rust 测试全量**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```

期望：`migration::task_mgr::tests` 2 tests、`migration::ddl_convert::tests` 5 tests 全通过

- [ ] **TypeScript 检查**

```bash
npx tsc --noEmit
```

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "feat(v2): complete cross-datasource migration — DDL convert, precheck, data pump, wizard UI"
```
