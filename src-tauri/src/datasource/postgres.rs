use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgPool, PgSslMode};
use std::time::Instant;

use super::{ColumnMeta, ConnectionConfig, DataSource, ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, TableMeta, ViewMeta};
use crate::AppResult;
use sqlx::Row;

pub struct PostgresDataSource {
    pool: PgPool,
}

impl PostgresDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        Self::new_with_schema(config, None).await
    }

    pub async fn new_with_schema(config: &ConnectionConfig, schema: Option<&str>) -> AppResult<Self> {
        let mut opts = PgConnectOptions::new()
            .host(&config.host)
            .port(config.port as u16)
            .username(&config.username)
            .password(&config.password)
            .ssl_mode(PgSslMode::Disable);
        // database 为空时不设置，sqlx 默认使用用户名作为库名（PG 规范）
        if !config.database.is_empty() {
            opts = opts.database(&config.database);
        }
        // 设置 search_path：未指定时默认 public
        let search_path = schema.filter(|s| !s.is_empty()).unwrap_or("public");
        opts = opts.options([("search_path", search_path)]);
        let pool = PgPool::connect_with(opts).await?;
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

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
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
                    ) AS is_pk
             FROM information_schema.columns c
             WHERE c.table_schema = $2 AND c.table_name = $1
             ORDER BY c.ordinal_position"
        )
        .bind(table)
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| ColumnMeta {
            name: r.try_get::<String, _>(0).unwrap_or_default(),
            data_type: r.try_get::<String, _>(1).unwrap_or_default(),
            is_nullable: r.try_get::<String, _>(2).unwrap_or_default() == "YES",
            column_default: r.try_get::<Option<String>, _>(3).ok().flatten(),
            is_primary_key: r.try_get::<bool, _>(4).unwrap_or(false),
            extra: None,
        }).collect())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT i.relname AS index_name, ix.indisunique, a.attname AS column_name
             FROM pg_class t
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_index ix ON t.oid = ix.indrelid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
             WHERE t.relname = $1 AND t.relkind = 'r' AND n.nspname = $2
             ORDER BY i.relname, a.attnum"
        )
        .bind(table)
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
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

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT tc.constraint_name, kcu.column_name,
                    ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema = $2
               AND tc.table_name = $1"
        )
        .bind(table)
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| ForeignKeyMeta {
            constraint_name: r.try_get::<String, _>(0).unwrap_or_default(),
            column: r.try_get::<String, _>(1).unwrap_or_default(),
            referenced_table: r.try_get::<String, _>(2).unwrap_or_default(),
            referenced_column: r.try_get::<String, _>(3).unwrap_or_default(),
        }).collect())
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let rows = sqlx::query(
            "SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = 'public'"
        ).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| ViewMeta {
            name: r.try_get::<String, _>(0).unwrap_or_default(),
            definition: r.try_get::<Option<String>, _>(1).ok().flatten(),
        }).collect())
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
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
        let columns = self.get_columns(table, None).await?;
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
        Ok(format!("CREATE TABLE {} (\n{}\n);", table, col_defs.join(",\n")))
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
        ).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        // _database 参数忽略：已通过 create_datasource_with_db 连接到目标库
        // 只过滤真正的内部 schema（pg_toast、临时 schema），保留 pg_catalog / information_schema
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT nspname FROM pg_namespace
             WHERE nspname NOT IN ('pg_toast')
               AND nspname NOT LIKE 'pg_temp_%'
               AND nspname NOT LIKE 'pg_toast_temp_%'
             ORDER BY
               CASE nspname
                 WHEN 'public'             THEN 0
                 WHEN 'information_schema' THEN 2
                 WHEN 'pg_catalog'         THEN 3
                 ELSE 1
               END,
               nspname"
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
                    "SELECT DISTINCT p.proname FROM pg_proc p
                     JOIN pg_namespace n ON p.pronamespace = n.oid
                     WHERE n.nspname = $1 AND p.prokind = 'f'
                     ORDER BY p.proname"
                ).bind(schema).fetch_all(&self.pool).await?;
                rows.into_iter().map(|(n,)| n).collect()
            }
            "procedures" => {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT DISTINCT p.proname FROM pg_proc p
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
}

// ============================================================
// 集成测试：验证 PG schema 相关查询行为
// 运行：cargo test pg_ -- --nocapture
// 前提：本地 PG localhost:5432，用户 postgres，密码 123456
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::create_datasource_with_db;

    fn base_config() -> ConnectionConfig {
        ConnectionConfig {
            driver: "postgres".to_string(),
            host: std::env::var("PG_HOST").unwrap_or_else(|_| "localhost".to_string()),
            port: std::env::var("PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(5432),
            database: std::env::var("PG_DB").unwrap_or_else(|_| "postgres".to_string()),
            username: std::env::var("PG_USER").unwrap_or_else(|_| "postgres".to_string()),
            password: std::env::var("PG_PASSWORD").unwrap_or_else(|_| "123456".to_string()),
            extra_params: None,
        }
    }

    /// 诊断：列出所有数据库，以及每个数据库下的所有 schema
    #[tokio::test]
    async fn pg_diag_list_databases_and_schemas() {
        let ds = PostgresDataSource::new(&base_config()).await
            .expect("连接失败，请检查 PG_HOST/PG_PORT/PG_USER/PG_PASSWORD");

        let databases = ds.list_databases().await.expect("list_databases 失败");
        println!("\n=== 数据库列表 ({} 个) ===", databases.len());
        for db in &databases {
            println!("  DB: {}", db);
        }

        println!("\n=== 各数据库 schema 列表 ===");
        let cfg = base_config();
        for db in &databases {
            match create_datasource_with_db(&cfg, db).await {
                Ok(db_ds) => {
                    match db_ds.list_schemas(db).await {
                        Ok(schemas) => println!("  {} -> schemas: {:?}", db, schemas),
                        Err(e) => println!("  {} -> list_schemas 错误: {}", db, e),
                    }
                }
                Err(e) => println!("  {} -> 连接失败: {}", db, e),
            }
        }
    }

    /// 核心验证：创建测试 schema → list_schemas 必须能看到它
    #[tokio::test]
    async fn pg_list_schemas_detects_new_schema() {
        let schema_name = "ods_test_verify_schema";
        let cfg = base_config();
        let ds = PostgresDataSource::new(&cfg).await.expect("连接失败");

        // 准备：建测试 schema
        ds.execute(&format!("CREATE SCHEMA IF NOT EXISTS {}", schema_name))
            .await
            .expect("CREATE SCHEMA 失败");
        println!("已创建 schema: {}", schema_name);

        // 执行：调 list_schemas
        let schemas = ds.list_schemas(&cfg.database).await.expect("list_schemas 失败");
        println!("list_schemas 返回: {:?}", schemas);

        // 断言
        assert!(
            schemas.contains(&schema_name.to_string()),
            "期望 list_schemas 包含 '{}', 实际: {:?}",
            schema_name,
            schemas
        );

        // 清理
        let _ = ds.execute(&format!("DROP SCHEMA IF EXISTS {} CASCADE", schema_name)).await;
        println!("已清理 schema: {}", schema_name);
    }

    /// 验证：非 public schema 下建表，list_objects 和 get_columns 必须正确返回
    #[tokio::test]
    async fn pg_non_public_schema_table_columns() {
        let schema_name = "ods_test_schema_cols";
        let table_name = "test_users";
        let cfg = base_config();
        let ds = PostgresDataSource::new(&cfg).await.expect("连接失败");

        // 准备
        ds.execute(&format!("DROP SCHEMA IF EXISTS {} CASCADE", schema_name))
            .await.ok();
        ds.execute(&format!("CREATE SCHEMA {}", schema_name))
            .await.expect("CREATE SCHEMA 失败");
        ds.execute(&format!(
            "CREATE TABLE {}.{} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, age INT)",
            schema_name, table_name
        )).await.expect("CREATE TABLE 失败");
        println!("已创建 {}.{}", schema_name, table_name);

        // 验证 list_schemas 能看到该 schema
        let schemas = ds.list_schemas(&cfg.database).await.expect("list_schemas 失败");
        println!("list_schemas: {:?}", schemas);
        assert!(schemas.contains(&schema_name.to_string()),
            "list_schemas 未返回 '{}': {:?}", schema_name, schemas);

        // 验证 list_objects 能列出该表
        let tables = ds.list_objects(&cfg.database, Some(schema_name), "tables")
            .await.expect("list_objects 失败");
        println!("list_objects({}): {:?}", schema_name, tables);
        assert!(tables.contains(&table_name.to_string()),
            "list_objects 未返回 '{}': {:?}", table_name, tables);

        // 验证 get_columns 用正确 schema 能拿到列
        let columns = ds.get_columns(table_name, Some(schema_name))
            .await.expect("get_columns 失败");
        println!("get_columns({}, {}): {:?}", table_name, schema_name,
            columns.iter().map(|c| &c.name).collect::<Vec<_>>());
        assert_eq!(columns.len(), 3, "期望 3 列, 实际: {:?}", columns);
        assert!(columns[0].is_primary_key, "id 列应为主键");

        // 验证 get_columns 用 public schema 拿不到该表（隔离验证）
        let cols_wrong = ds.get_columns(table_name, Some("public"))
            .await.expect("get_columns(public) 失败");
        println!("get_columns({}, public): {} 列（期望 0）", table_name, cols_wrong.len());
        assert!(cols_wrong.is_empty(),
            "public schema 不应能看到 {} 的列", table_name);

        // 清理
        let _ = ds.execute(&format!("DROP SCHEMA {} CASCADE", schema_name)).await;
        println!("已清理 schema: {}", schema_name);
    }

    /// 验证：list_schemas 的 SQL 过滤规则（只过滤系统 schema）
    #[tokio::test]
    async fn pg_list_schemas_filter_rules() {
        let ds = PostgresDataSource::new(&base_config()).await.expect("连接失败");
        let schemas = ds.list_schemas("").await.expect("list_schemas 失败");
        println!("\nlist_schemas 结果: {:?}", schemas);

        // 系统 schema 不应出现
        for forbidden in &["pg_catalog", "information_schema", "pg_toast"] {
            assert!(!schemas.contains(&forbidden.to_string()),
                "系统 schema '{}' 不应出现在结果中", forbidden);
        }
        // public 应该存在
        assert!(schemas.contains(&"public".to_string()),
            "public schema 应存在, 实际: {:?}", schemas);

        println!("过滤规则验证通过");
    }
}
