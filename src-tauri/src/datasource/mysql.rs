use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::Row;
use std::time::{Duration, Instant};

use super::{ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities, ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, SqlDialect, TableMeta, TableStat, TableStatInfo, ViewMeta};
use crate::{AppError, AppResult};

/// 驱动内部方言标记（与 SqlDialect 用途不同：此枚举控制驱动内部 SQL 分支逻辑）
#[derive(Debug, Clone, PartialEq)]
pub enum Dialect {
    MySQL,
    Doris,
    TiDB,
}

/// MySQL information_schema 的某些列（如 TABLE_NAME）使用 binary 排序规则，
/// sqlx 将其识别为 VARBINARY 而非 VARCHAR。此函数先尝试 String，再降级为 Vec<u8>→UTF-8。
fn get_str(row: &sqlx::mysql::MySqlRow, index: usize) -> String {
    if let Ok(s) = row.try_get::<String, _>(index) {
        return s;
    }
    if let Ok(bytes) = row.try_get::<Vec<u8>, _>(index) {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    String::new()
}

fn get_opt_str(row: &sqlx::mysql::MySqlRow, index: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

fn format_size(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

pub struct MySqlDataSource {
    pool: MySqlPool,
    dialect: Dialect,
}

impl MySqlDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        Self::new_with_dialect(config, Dialect::MySQL).await
    }

    pub async fn new_with_dialect(config: &ConnectionConfig, dialect: Dialect) -> AppResult<Self> {
        let host = config.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        let port = config.port
            .ok_or_else(|| AppError::Datasource("Missing port".into()))?;
        let username = config.username.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing username".into()))?;
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");
        let url = format!(
            "mysql://{}:{}@{}:{}/{}",
            username, password, host, port, database
        );
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(30))
            .idle_timeout(Duration::from_secs(300))
            .connect(&url)
            .await?;
        Ok(Self { pool, dialect })
    }
}

#[async_trait]
impl DataSource for MySqlDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        use sqlx::Column;
        let start = Instant::now();
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
        let duration_ms = start.elapsed().as_millis() as u64;

        let columns: Vec<String> = if let Some(first) = rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                (0..columns.len())
                    .map(|i| {
                        // Try multiple types in order of preference
                        if let Ok(val) = row.try_get::<Option<String>, _>(i) {
                            val.map(serde_json::Value::String)
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
                            // DATETIME / TIMESTAMP
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
                            // DATE
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveTime>, _>(i) {
                            // TIME
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
                            // DECIMAL / NUMERIC — 保留原始精度（如 10.90 不变为 10.9）
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<u64>, _>(i) {
                            // BIGINT UNSIGNED / BIT(n) — 必须在 i64 之前，避免大无符号值精度丢失
                            val.map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<i64>, _>(i) {
                            val.map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<u16>, _>(i) {
                            // YEAR
                            val.map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<f64>, _>(i) {
                            val.map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<bool>, _>(i) {
                            val.map(|v| serde_json::json!(v))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<serde_json::Value>, _>(i) {
                            // JSON 列
                            val.unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<Vec<u8>>, _>(i) {
                            // VARBINARY / BLOB 列：转为 UTF-8 字符串展示，非 UTF-8 则显示为十六进制
                            val.map(|b| {
                                serde_json::Value::String(
                                    String::from_utf8(b.clone())
                                        .unwrap_or_else(|_| format!("0x{}", hex::encode(&b)))
                                )
                            }).unwrap_or(serde_json::Value::Null)
                        } else {
                            serde_json::Value::Null
                        }
                    })
                    .collect()
            })
            .collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.iter().map(|r| TableMeta {
            schema: None,
            name: get_str(r, 0),
            table_type: get_str(r, 1),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION"
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| ColumnMeta {
            name: get_str(r, 0),
            data_type: get_str(r, 1),
            is_nullable: get_str(r, 2) == "YES",
            column_default: get_opt_str(r, 3),
            is_primary_key: get_str(r, 4) == "PRI",
            extra: get_opt_str(r, 5).filter(|s| !s.is_empty()),
            comment: {
                let v = get_str(r, 6);
                if v.is_empty() { None } else { Some(v) }
            },
        }).collect())
    }

    async fn get_indexes(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        let rows = sqlx::query(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX"
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        let mut map: std::collections::BTreeMap<String, IndexMeta> = Default::default();
        for r in &rows {
            let idx_name = get_str(r, 0);
            let non_unique: i64 = r.try_get(1).unwrap_or(1);
            let col = get_str(r, 2);
            map.entry(idx_name.clone()).or_insert_with(|| IndexMeta {
                index_name: idx_name,
                is_unique: non_unique == 0,
                columns: vec![],
            }).columns.push(col);
        }
        Ok(map.into_values().collect())
    }

    async fn get_foreign_keys(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        let rows = sqlx::query(
            "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                    kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                    rc.DELETE_RULE
             FROM information_schema.KEY_COLUMN_USAGE kcu
             LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                 AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
             WHERE kcu.TABLE_SCHEMA = DATABASE()
               AND kcu.TABLE_NAME = ?
               AND kcu.REFERENCED_TABLE_NAME IS NOT NULL"
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| ForeignKeyMeta {
            constraint_name: get_str(r, 0),
            column: get_str(r, 1),
            referenced_table: get_str(r, 2),
            referenced_column: get_str(r, 3),
            on_delete: {
                let v = get_str(r, 4);
                if v.is_empty() { None } else { Some(v) }
            },
        }).collect())
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()"
        ).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| ViewMeta {
            name: get_str(r, 0),
            definition: get_opt_str(r, 1),
        }).collect())
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        // Doris / TiDB 不支持存储过程
        if self.dialect == Dialect::Doris || self.dialect == Dialect::TiDB {
            return Ok(vec![]);
        }
        let rows = sqlx::query(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()"
        ).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| {
            let name = get_str(r, 0);
            let rt = get_str(r, 1);
            ProcedureMeta {
                name,
                routine_type: match rt.as_str() {
                    "PROCEDURE" => RoutineType::Procedure,
                    "FUNCTION" => RoutineType::Function,
                    _ => RoutineType::Unknown,
                },
            }
        }).collect())
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        if self.dialect == Dialect::Doris {
            // Doris DDL 用 information_schema.COLUMNS 手工拼接标准 DDL（用于 AI 上下文注入）
            return self.doris_build_standard_ddl(table).await;
        }
        let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
        let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(get_str(&row, 1))
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let rows = sqlx::query("SHOW DATABASES")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(|r| get_str(r, 0)).collect())
    }

    async fn list_objects(&self, database: &str, _schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
        let names: Vec<String> = match category {
            "tables" => {
                let rows = sqlx::query(
                    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "views" => {
                let rows = sqlx::query(
                    "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "functions" => {
                if self.dialect == Dialect::Doris || self.dialect == Dialect::TiDB {
                    return Ok(vec![]);
                }
                let rows = sqlx::query(
                    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "procedures" => {
                if self.dialect == Dialect::Doris || self.dialect == Dialect::TiDB {
                    return Ok(vec![]);
                }
                let rows = sqlx::query(
                    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "triggers" => {
                if self.dialect == Dialect::Doris || self.dialect == Dialect::TiDB {
                    return Ok(vec![]);
                }
                let rows = sqlx::query(
                    "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "events" => {
                if self.dialect == Dialect::Doris {
                    return Ok(vec![]);
                }
                let rows = sqlx::query(
                    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "materialized_views" => {
                if self.dialect != Dialect::Doris {
                    return Ok(vec![]);
                }
                // Doris 物化视图
                let rows = sqlx::query(
                    "SELECT TABLE_NAME FROM information_schema.MATERIALIZED_VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            _ => vec![],
        };
        Ok(names)
    }

    async fn list_tables_with_stats(&self, database: &str, _schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        // Doris 的 TABLE_ROWS 不准确，改用 DATA_LENGTH
        let row_col = if self.dialect == Dialect::Doris { "DATA_LENGTH" } else { "TABLE_ROWS" };
        let sql = format!(
            "SELECT TABLE_NAME, {}, (DATA_LENGTH + INDEX_LENGTH) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY TABLE_NAME",
            row_col
        );
        let rows = sqlx::query(&sql).bind(database).fetch_all(&self.pool).await?;
        let stats = rows.iter().map(|r| {
            let name = get_str(r, 0);
            let row_count: Option<i64> = r.try_get(1).ok();
            let bytes: Option<i64> = r.try_get(2).ok();
            let size = bytes.map(format_size);
            TableStatInfo { name, row_count, size }
        }).collect();
        Ok(stats)
    }

    fn capabilities(&self) -> DriverCapabilities {
        match self.dialect {
            Dialect::MySQL => DriverCapabilities {
                has_schemas: false,
                has_foreign_keys: true,
                has_stored_procedures: true,
                has_triggers: true,
                has_materialized_views: false,
                has_multi_database: true,
                has_partitions: true,
                sql_dialect: SqlDialect::Standard,
            },
            Dialect::Doris => DriverCapabilities {
                has_schemas: false,
                has_foreign_keys: false,
                has_stored_procedures: false,
                has_triggers: false,
                has_materialized_views: true,
                has_multi_database: true,
                has_partitions: true,
                sql_dialect: SqlDialect::Doris,
            },
            Dialect::TiDB => DriverCapabilities {
                has_schemas: false,
                has_foreign_keys: true,
                has_stored_procedures: false,
                has_triggers: false,
                has_materialized_views: false,
                has_multi_database: true,
                has_partitions: true,
                sql_dialect: SqlDialect::Standard,
            },
        }
    }

    async fn get_db_stats(&self, database: Option<&str>) -> AppResult<DbStats> {
        let db = database.unwrap_or("");
        let sql = if db.is_empty() {
            "SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY DATA_LENGTH DESC".to_string()
        } else {
            "SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY DATA_LENGTH DESC".to_string()
        };
        let query = if db.is_empty() {
            sqlx::query(&sql).fetch_all(&self.pool).await?
        } else {
            sqlx::query(&sql).bind(db).fetch_all(&self.pool).await?
        };

        let mut total_size: i64 = 0;
        let tables: Vec<TableStat> = query.iter().map(|r| {
            let data: i64 = r.try_get(2).unwrap_or(0);
            let idx: i64 = r.try_get(3).unwrap_or(0);
            total_size += data + idx;
            TableStat {
                name: get_str(r, 0),
                row_count: r.try_get(1).ok(),
                data_size_bytes: Some(data),
                index_size_bytes: Some(idx),
            }
        }).collect();

        let version_row = sqlx::query("SELECT VERSION()").fetch_optional(&self.pool).await?;
        let db_version = version_row.and_then(|r| r.try_get::<String, _>(0).ok());

        Ok(DbStats {
            db_summary: DbSummary {
                total_tables: tables.len(),
                total_size_bytes: Some(total_size),
                db_version,
            },
            tables,
        })
    }
}

impl MySqlDataSource {
    /// Doris 专用：用 information_schema.COLUMNS 手工拼接标准 DDL（用于 AI 上下文注入）
    async fn doris_build_standard_ddl(&self, table: &str) -> AppResult<String> {
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION"
        ).bind(table).fetch_all(&self.pool).await?;

        if rows.is_empty() {
            return Err(AppError::Datasource(format!("Table '{}' not found", table)));
        }

        let mut col_defs = vec![];
        let mut pk_cols = vec![];
        for r in &rows {
            let name = get_str(r, 0);
            let data_type = get_str(r, 1);
            let nullable = get_str(r, 2) == "YES";
            let default = get_opt_str(r, 3);
            let key = get_str(r, 4);
            if key == "PRI" { pk_cols.push(format!("`{}`", name)); }

            let mut def = format!("  `{}` {}", name, data_type);
            if !nullable { def.push_str(" NOT NULL"); }
            if let Some(d) = default { def.push_str(&format!(" DEFAULT '{}'", d)); }
            col_defs.push(def);
        }
        if !pk_cols.is_empty() {
            col_defs.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
        }

        Ok(format!("CREATE TABLE `{}` (\n{}\n)", table, col_defs.join(",\n")))
    }
}
