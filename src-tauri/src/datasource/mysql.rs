use async_trait::async_trait;
use sqlx::mysql::MySqlPool;
use sqlx::Row;
use std::time::Instant;

use super::{ColumnMeta, ConnectionConfig, DataSource, ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, TableMeta, TableStatInfo, ViewMeta};
use crate::AppResult;

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
}

impl MySqlDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let url = format!(
            "mysql://{}:{}@{}:{}/{}",
            config.username, config.password, config.host, config.port, config.database
        );
        let pool = MySqlPool::connect(&url).await?;
        Ok(Self { pool })
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
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
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
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL"
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| ForeignKeyMeta {
            constraint_name: get_str(r, 0),
            column: get_str(r, 1),
            referenced_table: get_str(r, 2),
            referenced_column: get_str(r, 3),
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
                let rows = sqlx::query(
                    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "procedures" => {
                let rows = sqlx::query(
                    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "triggers" => {
                let rows = sqlx::query(
                    "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            "events" => {
                let rows = sqlx::query(
                    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME"
                ).bind(database).fetch_all(&self.pool).await?;
                rows.iter().map(|r| get_str(r, 0)).collect()
            }
            _ => vec![],
        };
        Ok(names)
    }

    async fn list_tables_with_stats(&self, database: &str, _schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_ROWS, (DATA_LENGTH + INDEX_LENGTH) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
             ORDER BY TABLE_NAME"
        ).bind(database).fetch_all(&self.pool).await?;

        let stats = rows.iter().map(|r| {
            let name = get_str(r, 0);
            let row_count: Option<i64> = r.try_get(1).ok();
            let bytes: Option<i64> = r.try_get(2).ok();
            let size = bytes.map(format_size);
            TableStatInfo { name, row_count, size }
        }).collect();
        Ok(stats)
    }
}
