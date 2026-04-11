use async_trait::async_trait;
use std::sync::Arc;
use std::time::Instant;
use tokio::task::JoinHandle;
use tokio_gaussdb::types::Type;

use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

/// Escape a value for use in a PostgreSQL/GaussDB connection string.
/// Values containing spaces, quotes, or backslashes must be single-quoted,
/// with internal single quotes and backslashes doubled.
fn escape_conn_value(val: &str) -> String {
    if val.is_empty() {
        return "''".to_string();
    }
    if val.contains(|c: char| c == ' ' || c == '\'' || c == '\\' || c == '=') {
        let escaped = val.replace('\\', "\\\\").replace('\'', "\\'");
        format!("'{}'", escaped)
    } else {
        val.to_string()
    }
}

pub struct GaussDbDataSource {
    client: Arc<tokio_gaussdb::Client>,
    #[allow(dead_code)]
    database: String,
    schema: String,
    _conn_handle: JoinHandle<()>,
}

impl GaussDbDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        Self::new_with_schema(config, None).await
    }

    pub async fn new_with_schema(config: &ConnectionConfig, schema: Option<&str>) -> AppResult<Self> {
        let raw_host = config.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        // 将 localhost 替换为 127.0.0.1，避免 IPv6 DNS 解析导致连接延迟
        let host = if raw_host.eq_ignore_ascii_case("localhost") { "127.0.0.1" } else { raw_host };
        let port = config.port.unwrap_or(8000);
        let username = config.username.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing username".into()))?;
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("postgres").to_string();

        let conn_str = format!(
            "host={} port={} user={} password={} dbname={}",
            escape_conn_value(host), port, escape_conn_value(username),
            escape_conn_value(password), escape_conn_value(&database)
        );

        let (client, connection) = tokio_gaussdb::connect(&conn_str, tokio_gaussdb::NoTls)
            .await
            .map_err(|e| AppError::Datasource(format!("GaussDB connection failed: {}", e)))?;

        let conn_handle = tokio::spawn(async move {
            if let Err(e) = connection.await {
                log::error!("GaussDB connection error: {}", e);
            }
        });

        let schema_name = schema.filter(|s| !s.is_empty()).unwrap_or("public").to_string();

        // 使用双引号包裹 schema 名称防止 SQL 注入
        let quoted_schema = super::utils::quote_identifier(&schema_name);
        client
            .execute(&format!("SET search_path TO {}", quoted_schema), &[])
            .await
            .map_err(|e| AppError::Datasource(format!("Failed to set search_path: {}", e)))?;

        Ok(Self {
            client: Arc::new(client),
            database,
            schema: schema_name,
            _conn_handle: conn_handle,
        })
    }
}

// ─── 行值转换辅助函数 ─────────────────────────────────────────────────────────

/// 将 tokio_gaussdb Row 的第 i 列转换为 serde_json::Value，按列类型派发。
fn gauss_row_value(row: &tokio_gaussdb::Row, i: usize) -> serde_json::Value {
    let col_type = row.columns()[i].type_().clone();

    // 文本族
    if col_type == Type::TEXT || col_type == Type::VARCHAR || col_type == Type::BPCHAR
        || col_type == Type::NAME || col_type == Type::XML
    {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // int8 / bigint — 转字符串避免 JS Number 精度丢失
    if col_type == Type::INT8 {
        return row.get::<_, Option<i64>>(i)
            .map(|v| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    // int4 / integer
    if col_type == Type::INT4 {
        return row.get::<_, Option<i32>>(i)
            .map(|v| serde_json::json!(v))
            .unwrap_or(serde_json::Value::Null);
    }

    // int2 / smallint
    if col_type == Type::INT2 {
        return row.get::<_, Option<i16>>(i)
            .map(|v| serde_json::json!(v))
            .unwrap_or(serde_json::Value::Null);
    }

    // float8 / double precision
    if col_type == Type::FLOAT8 {
        return row.get::<_, Option<f64>>(i)
            .map(|v| serde_json::json!(v))
            .unwrap_or(serde_json::Value::Null);
    }

    // float4 / real
    if col_type == Type::FLOAT4 {
        return row.get::<_, Option<f32>>(i)
            .map(|v| serde_json::json!(v))
            .unwrap_or(serde_json::Value::Null);
    }

    // bool
    if col_type == Type::BOOL {
        return row.get::<_, Option<bool>>(i)
            .map(|v| serde_json::json!(v))
            .unwrap_or(serde_json::Value::Null);
    }

    // numeric / decimal — Display as string for precision
    if col_type == Type::NUMERIC {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // timestamp without timezone
    if col_type == Type::TIMESTAMP {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // timestamptz
    if col_type == Type::TIMESTAMPTZ {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // date
    if col_type == Type::DATE {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // time
    if col_type == Type::TIME {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // json / jsonb — tokio-gaussdb doesn't implement FromSql for serde_json::Value,
    // so read as String and parse
    if col_type == Type::JSON || col_type == Type::JSONB {
        return row.get::<_, Option<String>>(i)
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);
    }

    // uuid
    if col_type == Type::UUID {
        return row.get::<_, Option<String>>(i)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    }

    // bytea — hex encoded
    if col_type == Type::BYTEA {
        return row.get::<_, Option<Vec<u8>>>(i)
            .map(|v| serde_json::Value::String(format!("\\x{}", hex::encode(v))))
            .unwrap_or(serde_json::Value::Null);
    }

    // 未知类型：尝试作字符串读取
    row.get::<_, Option<String>>(i)
        .map(serde_json::Value::String)
        .unwrap_or(serde_json::Value::Null)
}

// ─── DataSource 实现 ──────────────────────────────────────────────────────────

#[async_trait]
impl DataSource for GaussDbDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        self.client
            .query("SELECT 1", &[])
            .await
            .map_err(|e| AppError::Datasource(format!("GaussDB test_connection failed: {}", e)))?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let start = Instant::now();

        // Non-SELECT statements: execute each statement individually to support multi-statement SQL.
        let trimmed = crate::datasource::utils::strip_leading_comments(sql).to_uppercase();
        if !trimmed.starts_with("SELECT") && !trimmed.starts_with("SHOW") && !trimmed.starts_with("EXPLAIN") && !trimmed.starts_with("WITH") {
            let stmts = crate::datasource::utils::split_sql_statements(sql);
            let mut total_affected = 0usize;
            for stmt in &stmts {
                let rows_affected = self.client
                    .execute(stmt.as_str(), &[])
                    .await
                    .map_err(|e| AppError::Datasource(format!("GaussDB execute failed: {}", e)))?;
                total_affected += rows_affected as usize;
            }
            let duration_ms = start.elapsed().as_millis() as u64;
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: total_affected, duration_ms });
        }

        let rows = self.client
            .query(sql, &[])
            .await
            .map_err(|e| AppError::Datasource(format!("GaussDB execute failed: {}", e)))?;
        let duration_ms = start.elapsed().as_millis() as u64;

        let columns: Vec<String> = if let Some(first) = rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| (0..columns.len()).map(|i| gauss_row_value(row, i)).collect())
            .collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows = self.client
            .query(
                "SELECT table_name, table_type, table_schema \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
                &[],
            )
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| TableMeta {
            name: r.get::<_, Option<String>>(0).unwrap_or_default(),
            table_type: r.get::<_, Option<String>>(1).unwrap_or_default(),
            schema: r.get::<_, Option<String>>(2),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let schema_val = schema.unwrap_or("public");
        let sql = "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                    COALESCE(
                        (SELECT true FROM information_schema.table_constraints tc
                         JOIN information_schema.key_column_usage kcu
                             ON tc.constraint_name = kcu.constraint_name
                             AND tc.table_schema = kcu.table_schema
                         WHERE tc.constraint_type = 'PRIMARY KEY'
                           AND tc.table_schema = $2
                           AND tc.table_name = $1
                           AND kcu.column_name = c.column_name
                         LIMIT 1),
                        false
                    ) AS is_pk,
                    pg_desc.description
             FROM information_schema.columns c
             LEFT JOIN (
                 SELECT a.attname AS col_name, d.description
                 FROM pg_description d
                 JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
                 JOIN pg_class cls ON cls.oid = d.objoid
                 JOIN pg_namespace ns ON ns.oid = cls.relnamespace
                 WHERE cls.relname = $1 AND ns.nspname = $2 AND d.objsubid > 0
             ) pg_desc ON pg_desc.col_name = c.column_name
             WHERE c.table_schema = $2 AND c.table_name = $1
             ORDER BY c.ordinal_position";

        let rows = self.client
            .query(sql, &[&table, &schema_val])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| ColumnMeta {
            name: r.get::<_, Option<String>>(0).unwrap_or_default(),
            data_type: r.get::<_, Option<String>>(1).unwrap_or_default(),
            is_nullable: r.get::<_, Option<String>>(2).unwrap_or_default() == "YES",
            column_default: r.get::<_, Option<String>>(3),
            is_primary_key: r.get::<_, Option<bool>>(4).unwrap_or(false),
            extra: None,
            comment: r.get::<_, Option<String>>(5),
        }).collect())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        let schema_val = schema.unwrap_or("public");
        let sql = "SELECT indexname, indexdef \
                   FROM pg_indexes \
                   WHERE schemaname = $1 AND tablename = $2";

        let rows = self.client
            .query(sql, &[&schema_val, &table])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let mut indexes = vec![];
        for r in &rows {
            let index_name: String = r.get::<_, Option<String>>(0).unwrap_or_default();
            let indexdef: String = r.get::<_, Option<String>>(1).unwrap_or_default();
            let is_unique = indexdef.contains("UNIQUE");

            // Parse column list from indexdef: "... (col1, col2)"
            let columns = if let Some(start) = indexdef.rfind('(') {
                if let Some(end) = indexdef.rfind(')') {
                    indexdef[start + 1..end]
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

            indexes.push(IndexMeta {
                index_name,
                is_unique,
                columns,
            });
        }
        Ok(indexes)
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        let schema_val = schema.unwrap_or("public");
        let sql = "SELECT tc.constraint_name, kcu.column_name,
                    ccu.table_name AS referenced_table, ccu.column_name AS referenced_column,
                    rc.delete_rule
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
             LEFT JOIN information_schema.referential_constraints rc
                 ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema = $2
               AND tc.table_name = $1";

        let rows = self.client
            .query(sql, &[&table, &schema_val])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| ForeignKeyMeta {
            constraint_name: r.get::<_, Option<String>>(0).unwrap_or_default(),
            column: r.get::<_, Option<String>>(1).unwrap_or_default(),
            referenced_table: r.get::<_, Option<String>>(2).unwrap_or_default(),
            referenced_column: r.get::<_, Option<String>>(3).unwrap_or_default(),
            on_delete: r.get::<_, Option<String>>(4),
            on_update: None,
        }).collect())
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let schema_val = self.schema.as_str();
        let sql = "SELECT table_name, view_definition \
                   FROM information_schema.views \
                   WHERE table_schema = $1";

        let rows = self.client
            .query(sql, &[&schema_val])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| ViewMeta {
            name: r.get::<_, Option<String>>(0).unwrap_or_default(),
            definition: r.get::<_, Option<String>>(1),
        }).collect())
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        let schema_val = self.schema.as_str();
        let sql = "SELECT routine_name, routine_type \
                   FROM information_schema.routines \
                   WHERE routine_schema = $1";

        let rows = self.client
            .query(sql, &[&schema_val])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| {
            let rt: String = r.get::<_, Option<String>>(1).unwrap_or_default();
            ProcedureMeta {
                name: r.get::<_, Option<String>>(0).unwrap_or_default(),
                routine_type: match rt.as_str() {
                    "PROCEDURE" => RoutineType::Procedure,
                    "FUNCTION" => RoutineType::Function,
                    _ => RoutineType::Unknown,
                },
            }
        }).collect())
    }

    async fn get_table_ddl_with_schema(&self, table: &str, schema: Option<&str>) -> AppResult<String> {
        let columns = self.get_columns(table, schema).await?;
        if columns.is_empty() {
            return Ok(format!("-- Table '{}' not found", table));
        }
        let col_defs: Vec<String> = columns.iter().map(|c| {
            let nullable = if c.is_nullable { "" } else { " NOT NULL" };
            let pk = if c.is_primary_key { " PRIMARY KEY" } else { "" };
            let default = c.column_default.as_ref()
                .map(|d| format!(" DEFAULT {}", d))
                .unwrap_or_default();
            format!("  {} {}{}{}{}", c.name, c.data_type, default, nullable, pk)
        }).collect();
        let qualified = match schema {
            Some(s) => format!("{}.{}", s, table),
            None => table.to_string(),
        };
        Ok(format!("CREATE TABLE {} (\n{}\n);", qualified, col_defs.join(",\n")))
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        self.get_table_ddl_with_schema(table, None).await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let rows = self.client
            .query(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
                &[],
            )
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter()
            .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
            .collect())
    }

    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        let rows = self.client
            .query(
                "SELECT nspname FROM pg_namespace \
                 WHERE nspname NOT IN ('pg_toast', 'pg_catalog', 'information_schema') \
                   AND nspname NOT LIKE 'pg_temp_%' \
                   AND nspname NOT LIKE 'pg_toast_temp_%' \
                 ORDER BY CASE nspname WHEN 'public' THEN 0 ELSE 1 END, nspname",
                &[],
            )
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter()
            .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
            .collect())
    }

    async fn list_objects(&self, _database: &str, schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
        let schema_val = schema.unwrap_or("public");
        let names: Vec<String> = match category {
            "tables" => {
                let rows = self.client
                    .query(
                        "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "views" => {
                let rows = self.client
                    .query(
                        "SELECT viewname FROM pg_views WHERE schemaname = $1 ORDER BY viewname",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "materialized_views" => {
                let rows = self.client
                    .query(
                        "SELECT matviewname FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "functions" => {
                let rows = self.client
                    .query(
                        "SELECT DISTINCT p.proname FROM pg_proc p \
                         JOIN pg_namespace n ON p.pronamespace = n.oid \
                         WHERE n.nspname = $1 AND p.prokind = 'f' \
                         ORDER BY p.proname",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "procedures" => {
                let rows = self.client
                    .query(
                        "SELECT DISTINCT p.proname FROM pg_proc p \
                         JOIN pg_namespace n ON p.pronamespace = n.oid \
                         WHERE n.nspname = $1 AND p.prokind = 'p' \
                         ORDER BY p.proname",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "triggers" => {
                let rows = self.client
                    .query(
                        "SELECT DISTINCT trigger_name FROM information_schema.triggers \
                         WHERE trigger_schema = $1 ORDER BY trigger_name",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            "sequences" => {
                let rows = self.client
                    .query(
                        "SELECT sequence_name FROM information_schema.sequences \
                         WHERE sequence_schema = $1 ORDER BY sequence_name",
                        &[&schema_val],
                    )
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.iter()
                    .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
                    .collect()
            }
            _ => vec![],
        };
        Ok(names)
    }

    async fn list_tables_with_stats(&self, _database: &str, schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        let schema_val = schema.unwrap_or("public");
        let sql = "SELECT s.relname, \
                    COALESCE(st.n_live_tup, 0)::bigint, \
                    pg_total_relation_size(s.oid)::bigint \
             FROM pg_class s \
             JOIN pg_namespace n ON s.relnamespace = n.oid \
             LEFT JOIN pg_stat_user_tables st ON st.relname = s.relname AND st.schemaname = n.nspname \
             WHERE n.nspname = $1 AND s.relkind = 'r' \
             ORDER BY s.relname";

        let rows = self.client
            .query(sql, &[&schema_val])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows.iter().map(|r| {
            let name: String = r.get::<_, Option<String>>(0).unwrap_or_default();
            let row_count: Option<i64> = r.get::<_, Option<i64>>(1);
            let bytes: Option<i64> = r.get::<_, Option<i64>>(2);
            let size = bytes.map(format_size);
            TableStatInfo { name, row_count, size }
        }).collect())
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: true,
            has_foreign_keys: true,
            has_stored_procedures: true,
            has_triggers: true,
            has_materialized_views: true,
            has_multi_database: true,
            has_partitions: true,
            sql_dialect: SqlDialect::Standard,
            supported_auth_types: vec!["password".to_string(), "ssl_cert".to_string(), "os_native".to_string()],
            has_pool_config: false,
            has_timeout_config: false,
            has_ssl_config: false,
        }
    }

    async fn get_db_stats(&self, _database: Option<&str>) -> AppResult<DbStats> {
        let sql = "SELECT t.relname, t.row_count, t.total_size \
             FROM ( \
                 SELECT s.relname, \
                        COALESCE(st.n_live_tup, 0)::bigint AS row_count, \
                        pg_total_relation_size(s.oid)::bigint AS total_size \
                 FROM pg_class s \
                 JOIN pg_namespace n ON s.relnamespace = n.oid \
                 LEFT JOIN pg_stat_user_tables st \
                     ON st.relname = s.relname AND st.schemaname = n.nspname \
                 WHERE s.relkind = 'r' \
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
             ) t \
             ORDER BY t.total_size DESC";

        let rows = self.client
            .query(sql, &[])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let mut total_bytes: i64 = 0;
        let tables: Vec<TableStat> = rows.iter().map(|r| {
            let name: String = r.get::<_, Option<String>>(0).unwrap_or_default();
            let row_count: Option<i64> = r.get::<_, Option<i64>>(1);
            let bytes: i64 = r.get::<_, Option<i64>>(2).unwrap_or(0);
            total_bytes += bytes;
            TableStat {
                name,
                row_count,
                data_size_bytes: Some(bytes),
                index_size_bytes: None,
            }
        }).collect();

        let version_rows = self.client
            .query("SELECT version()", &[])
            .await
            .ok()
            .unwrap_or_default();
        let db_version = version_rows.first()
            .and_then(|r| r.get::<_, Option<String>>(0));

        Ok(DbStats {
            db_summary: DbSummary {
                total_tables: tables.len(),
                total_size_bytes: Some(total_bytes),
                db_version,
            },
            tables,
        })
    }

    fn string_escape_style(&self) -> crate::datasource::StringEscapeStyle {
        crate::datasource::StringEscapeStyle::PostgresLiteral
    }

    async fn setup_migration_session(&self) -> AppResult<()> {
        // GaussDB is PG-compatible; session_replication_role may not be available
        let _ = self.execute("SET synchronous_commit = 'off'").await;
        let _ = self.execute("SET work_mem = '256MB'").await;
        log::info!("GaussDB migration session optimizations applied");
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        let _ = self.execute("SET synchronous_commit = 'on'").await;
        let _ = self.execute("RESET work_mem").await;
        Ok(())
    }
}

use super::utils::format_size;
