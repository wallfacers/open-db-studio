use async_trait::async_trait;
use sqlx::postgres::PgPool;
use std::time::Instant;

use super::{ColumnMeta, ConnectionConfig, DataSource, ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, TableMeta, ViewMeta};
use crate::AppResult;

pub struct PostgresDataSource {
    pool: PgPool,
}

impl PostgresDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let url = format!(
            "postgresql://{}:{}@{}:{}/{}?sslmode=disable",
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

    async fn get_columns(&self, table: &str) -> AppResult<Vec<ColumnMeta>> {
        let sql = format!(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                    COALESCE(
                        (SELECT true FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                             ON tc.constraint_name = kcu.constraint_name
                             AND tc.table_schema = kcu.table_schema
                         WHERE tc.constraint_type = 'PRIMARY KEY'
                           AND tc.table_name = '{0}'
                           AND kcu.column_name = c.column_name
                         LIMIT 1),
                        false
                    ) AS is_pk
             FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = '{0}'
             ORDER BY c.ordinal_position",
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

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = 'public'"
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
        let columns = self.get_columns(table).await?;
        if columns.is_empty() {
            return Ok(format!("-- Table '{}' not found", table));
        }
        let col_defs: Vec<String> = columns.iter().map(|c| {
            let nullable = if c.is_nullable { "" } else { " NOT NULL" };
            let pk = if c.is_primary_key { " PRIMARY KEY" } else { "" };
            let default = c.column_default.as_ref()
                .map(|d| format!(" DEFAULT {}", d))
                .unwrap_or_default();
            format!("  {} {}{}{}{}", c.name, c.data_type, nullable, default, pk)
        }).collect();
        Ok(format!("CREATE TABLE {} (\n{}\n);", table, col_defs.join(",\n")))
    }
}
