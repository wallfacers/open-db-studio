use async_trait::async_trait;
use sqlx::postgres::PgPool;
use std::time::Instant;

use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::AppResult;

pub struct PostgresDataSource {
    pool: PgPool,
}

impl PostgresDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let url = format!(
            "postgresql://{}:{}@{}:{}/{}",
            config.username, config.password, config.host, config.port, config.database
        );
        let pool = PgPool::connect(&url).await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl DataSource for PostgresDataSource {
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
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT table_name, table_type, table_schema
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|(name, table_type, schema)| TableMeta {
            schema: Some(schema),
            name,
            table_type,
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }
}
