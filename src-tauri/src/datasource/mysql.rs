use async_trait::async_trait;
use sqlx::mysql::MySqlPool;
use std::time::Instant;

use super::{ColumnMeta, ConnectionConfig, DataSource, ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, TableMeta, ViewMeta};
use crate::AppResult;

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
        use sqlx::{Column, Row};
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
                        row.try_get::<Option<String>, _>(i)
                            .ok()
                            .flatten()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|(name, table_type)| TableMeta {
            schema: None,
            name,
            table_type,
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

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

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()"
        ).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| {
            let rt: String = r.try_get::<String, _>(1).unwrap_or_default();
            ProcedureMeta {
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                routine_type: match rt.as_str() {
                    "PROCEDURE" => RoutineType::Procedure,
                    "FUNCTION" => RoutineType::Function,
                    _ => RoutineType::Unknown,
                },
            }
        }).collect())
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        use sqlx::Row;
        let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
        let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(row.try_get::<String, _>(1).unwrap_or_default())
    }
}
