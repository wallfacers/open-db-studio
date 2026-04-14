use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlConnectOptions, MySqlSslMode};
use sqlx::ConnectOptions;
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

use super::utils::format_size;

pub struct MySqlDataSource {
    pub(crate) pool: MySqlPool,
    dialect: Dialect,
    mig_session_active: std::sync::atomic::AtomicBool,
    /// Dedicated mysql_async pool for LOAD DATA LOCAL INFILE (migration only).
    mig_async_pool: tokio::sync::OnceCell<mysql_async::Pool>,
    /// Connection config stored for building mysql_async pool on demand.
    conn_url: String,
    /// Desired max size for the mysql_async migration pool. Set by
    /// `set_migration_pool_size` before the first LOAD DATA call. Must be
    /// written before `mig_async_pool` is initialized — once the OnceCell is
    /// materialized, later changes are ignored.
    mig_async_pool_max: std::sync::atomic::AtomicU32,
    /// Tracks whether LOAD DATA LOCAL INFILE is unsupported by the server.
    /// Once set to true, all future bulk_write calls skip LOAD DATA entirely
    /// and use optimized INSERT directly, avoiding log spam.
    load_data_disabled: std::sync::atomic::AtomicBool,
    /// Cached max_allowed_packet value (queried once from server).
    max_allowed_packet: std::sync::OnceLock<usize>,
}

/// Default max size for the migration-only mysql_async pool. Kept in sync with
/// the historical hardcoded value so non-migration callers behave identically.
const DEFAULT_MIG_ASYNC_POOL_MAX: u32 = 4;
/// Lower bound on mig_async_pool max to preserve keep-alive behavior.
const MIG_ASYNC_POOL_MIN: u32 = 1;
/// Upper bound on mig_async_pool max. Migration `parallelism` is clamped to 16
/// in the pipeline, so any request beyond this is a misconfiguration.
const MIG_ASYNC_POOL_MAX: u32 = 32;

impl MySqlDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        Self::new_with_dialect(config, Dialect::MySQL).await
    }

    pub async fn new_with_dialect(config: &ConnectionConfig, dialect: Dialect) -> AppResult<Self> {
        Self::build(config, dialect, false).await
    }

    /// Constructor for migration pipelines — applies session-level optimizations
    /// (disable binlog, unique checks, FK checks) on every connection via after_connect.
    pub async fn new_for_migration(config: &ConnectionConfig, dialect: Dialect) -> AppResult<Self> {
        Self::build(config, dialect, true).await
    }

    async fn build(config: &ConnectionConfig, dialect: Dialect, for_migration: bool) -> AppResult<Self> {
        let raw_host = config.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        // 将 localhost 替换为 127.0.0.1，避免 IPv6 DNS 解析导致连接延迟 ~21 秒
        let host = if raw_host.eq_ignore_ascii_case("localhost") { "127.0.0.1" } else { raw_host };
        let port = config.port
            .ok_or_else(|| AppError::Datasource("Missing port".into()))?;
        let username = config.username.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing username".into()))?;
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");
        // SSL 模式映射
        let ssl_mode = match config.ssl_mode.as_deref().unwrap_or("disable") {
            "disable" => MySqlSslMode::Disabled,
            "prefer" => MySqlSslMode::Preferred,
            "require" => MySqlSslMode::Required,
            "verify_ca" => MySqlSslMode::VerifyCa,
            "verify_full" => MySqlSslMode::VerifyIdentity,
            _ => MySqlSslMode::Disabled,
        };
        let mut opts = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(username)
            .password(password)
            .database(database)
            .ssl_mode(ssl_mode)
            .log_slow_statements(log::LevelFilter::Off, Duration::from_secs(0));

        // SSL 证书
        if let Some(ref ca) = config.ssl_ca_path {
            if !ca.is_empty() { opts = opts.ssl_ca(ca); }
        }
        if let Some(ref cert) = config.ssl_cert_path {
            if !cert.is_empty() { opts = opts.ssl_client_cert(cert); }
        }
        if let Some(ref key) = config.ssl_key_path {
            if !key.is_empty() { opts = opts.ssl_client_key(key); }
        }

        // 连接池参数
        let max_conn = config.pool_max_connections.unwrap_or(5) as u32;
        let idle_timeout = config.pool_idle_timeout_secs.unwrap_or(300);
        let acquire_timeout = config.connect_timeout_secs.unwrap_or(30);

        let mut pool_opts = MySqlPoolOptions::new()
            .max_connections(max_conn)
            .acquire_timeout(Duration::from_secs(acquire_timeout as u64))
            .idle_timeout(Duration::from_secs(idle_timeout as u64))
            .max_lifetime(Duration::from_secs(600))
            .test_before_acquire(true);

        // Migration pools: apply session optimizations on every connection.
        // Normal pools: no after_connect hook — binlog/checks remain at server defaults.
        if for_migration {
            pool_opts = pool_opts.after_connect(|conn, _meta| Box::pin(async move {
                use sqlx::Executor;
                let _ = conn.execute("SET SESSION unique_checks = 0").await;
                let _ = conn.execute("SET SESSION foreign_key_checks = 0").await;
                let _ = conn.execute("SET SESSION sql_log_bin = 0").await;
                let _ = conn.execute("SET SESSION innodb_strict_mode = 0").await;
                Ok(())
            }));
        }

        let pool = pool_opts.connect_with(opts).await?;
        let conn_url = format!(
            "mysql://{}:{}@{}:{}/{}?local_infile=true",
            urlencoding::encode(username),
            urlencoding::encode(password),
            host,
            port,
            urlencoding::encode(database),
        );
        Ok(Self {
            pool,
            dialect,
            mig_session_active: std::sync::atomic::AtomicBool::new(false),
            mig_async_pool: tokio::sync::OnceCell::new(),
            conn_url,
            mig_async_pool_max: std::sync::atomic::AtomicU32::new(DEFAULT_MIG_ASYNC_POOL_MAX),
            load_data_disabled: std::sync::atomic::AtomicBool::new(false),
            max_allowed_packet: std::sync::OnceLock::new(),
        })
    }
}

#[async_trait]
impl DataSource for MySqlDataSource {
    fn as_any(&self) -> &dyn std::any::Any { self }

    async fn test_connection(&self) -> AppResult<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        use sqlx::Column;
        let start = Instant::now();

        // Non-SELECT statements: execute each statement individually to support multi-statement SQL.
        // sqlx does not enable CLIENT_MULTI_STATEMENTS by default, so sending multiple statements
        // as a single string causes a syntax error on the second statement.
        let trimmed = crate::datasource::utils::strip_leading_comments(sql).to_uppercase();
        if !trimmed.starts_with("SELECT") && !trimmed.starts_with("SHOW") && !trimmed.starts_with("DESCRIBE") && !trimmed.starts_with("EXPLAIN") && !trimmed.starts_with("WITH") {
            let stmts = crate::datasource::utils::split_sql_statements(sql);
            let mut total_affected = 0usize;
            for stmt in &stmts {
                let result = sqlx::query(stmt).execute(&self.pool).await?;
                total_affected += result.rows_affected() as usize;
            }
            let duration_ms = start.elapsed().as_millis() as u64;
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: total_affected, duration_ms });
        }

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
                            // BIGINT UNSIGNED / BIT(n) — 转为字符串，避免 JS Number 精度丢失（> 2^53）
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<i64>, _>(i) {
                            // BIGINT SIGNED — 转为字符串，避免 JS Number 精度丢失（> 2^53）
                            val.map(|v| serde_json::Value::String(v.to_string()))
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
                            // JSON 列：序列化为字符串，避免前端 String(obj) → "[object Object]"
                            val.map(|v| serde_json::Value::String(v.to_string()))
                                .unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<Vec<u8>>, _>(i) {
                            // VARBINARY / BLOB 列：统一转为十六进制表示。
                            // 若直接解为 UTF-8，含 \x1a（CTRL+Z）等控制字节的合法 UTF-8 二进制数据
                            // 会在目标端 INSERT 时破坏 SQL 解析，导致迁移失败。
                            // 写入路径的 is_hex_binary() 会识别 "0x…" 并生成安全的 X'…' 字面量。
                            val.map(|b| {
                                serde_json::Value::String(format!("0x{}", hex::encode(&b)))
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
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
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
                    rc.DELETE_RULE, rc.UPDATE_RULE
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
            on_update: {
                let v = get_str(r, 5);
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
            // Doris AI 上下文注入：用 information_schema.COLUMNS 手工拼接标准 DDL，
            // 避免 ENGINE=OLAP / DISTRIBUTED BY 等专有子句干扰 SQL 生成。
            return self.doris_build_standard_ddl(table).await;
        }
        let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
        let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(get_str(&row, 1))
    }

    async fn get_table_ddl_for_display(&self, table: &str, _schema: Option<&str>) -> AppResult<String> {
        // 所有方言（含 Doris）展示时均直接透传 SHOW CREATE TABLE 原生结果，
        // 让用户看到真实的数据库 DDL（含 Doris 专有子句）。
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
                supported_auth_types: vec!["password".to_string(), "ssl_cert".to_string(), "os_native".to_string()],
                has_pool_config: true,
                has_timeout_config: true,
                has_ssl_config: true,
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
                supported_auth_types: vec!["password".to_string(), "ssl_cert".to_string(), "os_native".to_string()],
                has_pool_config: true,
                has_timeout_config: true,
                has_ssl_config: true,
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
                supported_auth_types: vec!["password".to_string(), "ssl_cert".to_string(), "os_native".to_string()],
                has_pool_config: true,
                has_timeout_config: true,
                has_ssl_config: true,
            },
        }
    }

    #[allow(dead_code)]
    async fn execute_in_transaction(&self, statements: &[String]) -> AppResult<usize> {
        use sqlx::Acquire;
        let mut conn = self.pool.acquire().await?;
        let mut tx = conn.begin().await?;
        let mut total = 0usize;
        for stmt in statements {
            let result = sqlx::query(stmt).execute(&mut *tx).await?;
            total += result.rows_affected() as usize;
        }
        tx.commit().await?;
        Ok(total)
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

    async fn setup_migration_session(&self) -> AppResult<()> {
        let mut conn = self.pool.acquire().await?;
        sqlx::query("SET unique_checks = 0").execute(&mut *conn).await?;
        sqlx::query("SET foreign_key_checks = 0").execute(&mut *conn).await?;
        if let Err(e) = sqlx::query("SET sql_log_bin = 0").execute(&mut *conn).await {
            log::info!("Migration: SET sql_log_bin=0 skipped ({}), binlog will remain active", e);
        }
        // Note: bulk_insert_buffer_size is MyISAM-only; removed. InnoDB uses after_connect hooks.
        self.mig_session_active.store(true, std::sync::atomic::Ordering::Relaxed);
        log::info!("Migration session optimizations applied (driver={})",
            match self.dialect { Dialect::MySQL => "mysql", Dialect::Doris => "doris", Dialect::TiDB => "tidb" });
        Ok(())
    }

    fn set_migration_pool_size(&self, size: u32) {
        let clamped = size.clamp(MIG_ASYNC_POOL_MIN, MIG_ASYNC_POOL_MAX);
        self.mig_async_pool_max
            .store(clamped, std::sync::atomic::Ordering::Relaxed);
        if self.mig_async_pool.initialized() {
            // mysql_async::Pool has no live-resize API; the cap set here only
            // affects pools created after this call. Log so operators can
            // diagnose "parallelism=N but LOAD DATA serialized on 4" reports.
            log::warn!(
                "set_migration_pool_size({}) called after mig_async_pool was initialized; cap will not take effect until teardown",
                clamped
            );
        }
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        if !self.mig_session_active.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let mut conn = self.pool.acquire().await?;
        let _ = sqlx::query("SET unique_checks = 1").execute(&mut *conn).await;
        let _ = sqlx::query("SET foreign_key_checks = 1").execute(&mut *conn).await;
        self.mig_session_active.store(false, std::sync::atomic::Ordering::Relaxed);
        // Tear down the ephem mysql_async pool to release server connections
        self.teardown_mig_pool();
        log::info!("Migration session optimizations reverted");
        Ok(())
    }

    fn supports_txn_bulk_write(&self) -> bool { true }

    async fn begin_bulk_write_txn(&self) -> crate::AppResult<Option<crate::datasource::BulkWriteTxn>> {
        let tx = self.pool.begin().await?;
        Ok(Some(crate::datasource::BulkWriteTxn::MySql(tx)))
    }

    async fn bulk_write_in_txn(
        &self,
        txn: &mut crate::datasource::BulkWriteTxn,
        table: &str,
        columns: &[String],
        rows: Vec<crate::migration::native_row::MigrationRow>,
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> crate::AppResult<usize> {
        match txn {
            crate::datasource::BulkWriteTxn::MySql(tx) => {
                let max_packet = self.query_and_cache_max_allowed_packet().await;
                Self::bulk_write_native_in_txn_static(
                    tx, table, columns, &rows,
                    conflict_strategy, upsert_keys, driver, max_packet,
                ).await
            }
            _ => Err(crate::error::AppError::Other("Invalid txn handle for MySQL".into())),
        }
    }

    async fn commit_bulk_write_txn(&self, txn: crate::datasource::BulkWriteTxn) -> crate::AppResult<()> {
        match txn {
            crate::datasource::BulkWriteTxn::MySql(tx) => {
                tx.commit().await?;
                Ok(())
            }
            _ => Err(crate::error::AppError::Other("Invalid txn handle for MySQL".into())),
        }
    }

    async fn execute_streaming(
        &self,
        sql: &str,
        channel_cap: usize,
    ) -> crate::AppResult<(Vec<String>, tokio::sync::mpsc::Receiver<Vec<serde_json::Value>>)> {
        use sqlx::Column;
        use sqlx::Row;
        use futures_util::TryStreamExt;

        let (tx, rx) = tokio::sync::mpsc::channel(channel_cap);

        // Fetch columns first via a separate query, since streaming loses the
        // column metadata until the first row arrives.
        let col_sql = format!("SELECT * FROM ({}) AS _mig_cols_ LIMIT 0", sql);
        let col_rows = sqlx::query(&col_sql).fetch_all(&self.pool).await?;
        let columns: Vec<String> = if let Some(first) = col_rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        // Stream rows
        let pool = self.pool.clone();
        let sql_owned = sql.to_string();
        let cols = columns.clone();
        tokio::spawn(async move {
            let mut stream = sqlx::query(&sql_owned).fetch(&pool);
            while let Ok(Some(row)) = stream.try_next().await {
                let num_cols = cols.len();
                let values: Vec<serde_json::Value> = (0..num_cols)
                    .map(|i| {
                        if let Ok(val) = row.try_get::<Option<String>, _>(i) {
                            val.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<chrono::NaiveTime>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<u64>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<i64>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<u16>, _>(i) {
                            val.map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<f64>, _>(i) {
                            val.map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<bool>, _>(i) {
                            val.map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<serde_json::Value>, _>(i) {
                            val.map(|v| serde_json::Value::String(v.to_string())).unwrap_or(serde_json::Value::Null)
                        } else if let Ok(val) = row.try_get::<Option<Vec<u8>>, _>(i) {
                            val.map(|b| serde_json::Value::String(format!("0x{}", hex::encode(&b)))).unwrap_or(serde_json::Value::Null)
                        } else {
                            serde_json::Value::Null
                        }
                    })
                    .collect();
                if tx.send(values).await.is_err() {
                    break;
                }
            }
        });

        Ok((columns, rx))
    }

    async fn migration_read_sql_stream(
        &self,
        sql: &str,
        channel_cap: usize,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> crate::AppResult<(Vec<String>, tokio::sync::mpsc::Receiver<crate::migration::native_row::MigrationRow>)> {
        use crate::migration::native_row::decode_mysql_column;
        use crate::migration::native_row::MigrationRow;
        use sqlx::Column;
        use sqlx::Row;
        use futures_util::TryStreamExt;

        let sql_owned = sql.to_string();
        let pool = self.pool.clone();
        let (col_tx, col_rx) = tokio::sync::oneshot::channel();
        let (tx, rx) = tokio::sync::mpsc::channel(channel_cap);
        let cancel_token = cancel.clone();

        log::info!("[migration] sql_stream starting: {}",
            if sql_owned.len() > 200 { &sql_owned[..200] } else { &sql_owned });

        tokio::spawn(async move {
            let mut stream = sqlx::query(&sql_owned).fetch(&pool);
            let mut col_tx = Some(col_tx);

            tokio::select! {
                result = async {
                    match stream.try_next().await {
                        Ok(Some(first_row)) => {
                            log::debug!("[migration] sql_stream first row received");
                            let columns: Vec<String> = first_row.columns().iter()
                                .map(|c| c.name().to_string()).collect();
                            let num_cols = columns.len();

                            if let Some(tx) = col_tx.take() {
                                let _ = tx.send(columns);
                            }

                            let values = (0..num_cols)
                                .map(|i| decode_mysql_column(&first_row, i))
                                .collect();
                            if tx.send(MigrationRow { values }).await.is_err() {
                                return;
                            }

                            while let Ok(Some(row)) = stream.try_next().await {
                                let values = (0..num_cols)
                                    .map(|i| decode_mysql_column(&row, i))
                                    .collect();
                                if tx.send(MigrationRow { values }).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            if let Some(tx) = col_tx.take() {
                                let _ = tx.send(Vec::new());
                            }
                        }
                        Err(e) => {
                            log::error!("[migration] sql_stream query failed: {}", e);
                            // Don't send columns — let col_tx be dropped so col_rx
                            // returns a RecvError and the caller gets a clear failure.
                            drop(col_tx.take());
                        }
                    }
                } => result,
                _ = cancel_token.cancelled() => {
                    if let Some(tx) = col_tx.take() {
                        let _ = tx.send(Vec::new());
                    }
                }
            }
        });

        let columns = col_rx.await.map_err(|_| crate::AppError::Other("Failed to read columns from stream task".to_string()))?;
        Ok((columns, rx))
    }

    async fn bulk_write_native(
        &self,
        table: &str,
        columns: &[String],
        rows: Vec<crate::migration::native_row::MigrationRow>,
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }

        // LOAD DATA doesn't support ON DUPLICATE KEY UPDATE — fall back to INSERT
        if matches!(conflict_strategy, crate::migration::task_mgr::ConflictStrategy::Upsert) {
            return self.bulk_write_native_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await;
        }

        // If LOAD DATA was already disabled (server rejected it), skip straight to INSERT.
        if self.load_data_disabled.load(std::sync::atomic::Ordering::Relaxed) {
            return self.bulk_write_native_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await;
        }

        match self.bulk_write_load_data_native(table, columns, rows.clone(), conflict_strategy).await {
            Ok(n) => Ok(n),
            Err(e) => {
                let prev = self.load_data_disabled.swap(true, std::sync::atomic::Ordering::Relaxed);
                if prev {
                    log::debug!("LOAD DATA unavailable, using native INSERT (suppressed repeat warning)");
                } else {
                    log::warn!("LOAD DATA failed ({}), falling back to native INSERT for this session", e);
                }
                self.bulk_write_native_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await
            }
        }
    }

    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }

        // LOAD DATA doesn't support ON DUPLICATE KEY UPDATE — fall back to INSERT
        if matches!(conflict_strategy, crate::migration::task_mgr::ConflictStrategy::Upsert) {
            return self.bulk_write_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await;
        }

        // If LOAD DATA was already disabled (server rejected it), skip straight to INSERT.
        if self.load_data_disabled.load(std::sync::atomic::Ordering::Relaxed) {
            return self.bulk_write_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await;
        }

        match self.bulk_write_load_data(table, columns, rows, conflict_strategy).await {
            Ok(n) => Ok(n),
            Err(e) => {
                // First failure: log WARN and set the flag so we don't retry LOAD DATA.
                // Subsequent hits: log DEBUG only, avoiding log spam.
                let prev = self.load_data_disabled.swap(true, std::sync::atomic::Ordering::Relaxed);
                if prev {
                    log::debug!("LOAD DATA unavailable, using optimized INSERT (suppressed repeat warning)");
                } else {
                    log::warn!("LOAD DATA failed ({}), falling back to optimized INSERT for this session", e);
                }
                self.bulk_write_insert_chunked(table, columns, rows, conflict_strategy, upsert_keys, driver).await
            }
        }
    }

}

impl MySqlDataSource {
    async fn get_mig_pool(&self) -> AppResult<&mysql_async::Pool> {
        self.mig_async_pool.get_or_try_init(|| async {
            let opts = mysql_async::Opts::from_url(&self.conn_url)
                .map_err(|e| AppError::Datasource(format!("mysql_async URL parse: {}", e)))?;
            // Size the LOAD DATA pool to match the migration's parallelism.
            // Writers serialize on this pool during LOAD DATA; a too-small cap
            // (the historical hardcoded 4) throttles parallelism > 4.
            let max = self
                .mig_async_pool_max
                .load(std::sync::atomic::Ordering::Relaxed)
                .clamp(MIG_ASYNC_POOL_MIN.max(1), MIG_ASYNC_POOL_MAX);
            let constraints = mysql_async::PoolConstraints::new(MIG_ASYNC_POOL_MIN as usize, max as usize)
                .ok_or_else(|| AppError::Datasource(
                    format!("invalid mig_async_pool constraints: min={} max={}", MIG_ASYNC_POOL_MIN, max)
                ))?;
            let pool_opts = mysql_async::PoolOpts::default().with_constraints(constraints);
            let opts = mysql_async::OptsBuilder::from_opts(opts)
                .pool_opts(pool_opts);
            Ok(mysql_async::Pool::new(opts))
        }).await
    }

    /// mysql_async pool teardown: OnceCell doesn't support taking the value out,
    /// so connections are released when the MySqlDataSource is dropped.
    fn teardown_mig_pool(&self) {
        // No-op: the pool lives until MySqlDataSource is dropped.
    }

    /// Build INSERT SQL respecting MySQL's max_allowed_packet by chunking rows.
    /// INSERT fallback with max_allowed_packet-aware chunking.
    ///
    /// Unlike DataX (which relies on JDBC `rewriteBatchedStatements=true` + a
    /// fixed `batchByteSize=32MB` that can *also* exceed default `max_allowed_packet`),
    /// we query the server's actual `max_allowed_packet` at runtime and split
    /// rows so that each generated INSERT SQL stays safely within 75% of that limit.
    async fn bulk_write_insert_chunked(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        let max_packet = self.query_and_cache_max_allowed_packet().await;
        let escape_style = self.string_escape_style();
        bulk_write_chunked_impl(
            &self.pool, max_packet, escape_style,
            table, columns, rows, conflict_strategy, upsert_keys, driver,
        ).await
    }

    /// Same as `bulk_write_insert_chunked` but executes within an explicit
    /// transaction, so that multiple calls share a single COMMIT/fsync.
    #[allow(dead_code)]
    pub async fn bulk_write_in_txn(
        &self,
        txn: &mut sqlx::Transaction<'_, sqlx::MySql>,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        use crate::datasource::bulk_write;

        let max_packet = self.query_and_cache_max_allowed_packet().await;
        let max_sql_bytes = (max_packet as f64 * 0.75).round() as usize;
        let escape_style = self.string_escape_style();
        let num_cols = columns.len();

        let tmpl = bulk_write::InsertTemplate::new(table, columns, conflict_strategy, upsert_keys, driver);

        let row_sizes: Vec<usize> = rows.iter()
            .map(|r| estimate_row_sql_size(r, num_cols))
            .collect();

        let mut total_written = 0usize;
        let mut chunk_start = 0;

        while chunk_start < rows.len() {
            let mut chunk_sql_size = 0usize;
            let mut chunk_end = chunk_start;
            while chunk_end < rows.len() {
                let row_size = row_sizes[chunk_end];
                if chunk_end > chunk_start && chunk_sql_size + row_size > max_sql_bytes {
                    break;
                }
                chunk_sql_size += row_size;
                chunk_end += 1;
            }
            let chunk = &rows[chunk_start..chunk_end];
            let sql = tmpl.build_chunk_sql(chunk, &escape_style, num_cols);

            // Binary search fallback if estimation underestimates.
            if sql.len() > max_sql_bytes && chunk.len() > 1 {
                let mut hi = chunk.len() - 1;
                let mut lo = 1;
                let mut best = 1;
                while lo <= hi {
                    let mid = (lo + hi) / 2;
                    let test_sql = tmpl.build_chunk_sql(&chunk[..mid], &escape_style, num_cols);
                    if test_sql.len() <= max_sql_bytes {
                        best = mid;
                        lo = mid + 1;
                    } else {
                        hi = mid - 1;
                    }
                }
                let sql = tmpl.build_chunk_sql(&chunk[..best], &escape_style, num_cols);
                let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(&mut **txn).await
                    .map_err(|e| AppError::Datasource(format!("INSERT in txn: {}", e)))?;
                total_written += result.rows_affected().min(best as u64) as usize;
                chunk_start += best;
                continue;
            }

            let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(&mut **txn).await
                .map_err(|e| AppError::Datasource(format!("INSERT in txn: {}", e)))?;
            total_written += result.rows_affected().min(chunk.len() as u64) as usize;
            chunk_start = chunk_end;
        }

        Ok(total_written)
    }

}

// Removed: build_native_chunk_sql and estimate_row_sql_size — now in bulk_write.rs
use crate::datasource::bulk_write::{build_native_chunk_sql, estimate_row_sql_size};

/// Shared INSERT chunking logic using a pool reference for execution.
async fn bulk_write_chunked_impl(
    pool: &MySqlPool,
    max_packet: usize,
    escape_style: crate::datasource::StringEscapeStyle,
    table: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> AppResult<usize> {
    use crate::datasource::bulk_write;

    let max_sql_bytes = (max_packet as f64 * 0.75).round() as usize;
    let num_cols = columns.len();

    // Build template once — prefix/suffix are invariant across chunks.
    let tmpl = bulk_write::InsertTemplate::new(table, columns, conflict_strategy, upsert_keys, driver);

    let row_sizes: Vec<usize> = rows.iter()
        .map(|r| estimate_row_sql_size(r, num_cols))
        .collect();

    let mut total_written = 0usize;
    let mut chunk_start = 0;

    while chunk_start < rows.len() {
        let mut chunk_sql_size = 0usize;
        let mut chunk_end = chunk_start;

        while chunk_end < rows.len() {
            let row_size = row_sizes[chunk_end];
            if chunk_end > chunk_start && chunk_sql_size + row_size > max_sql_bytes {
                break;
            }
            chunk_sql_size += row_size;
            chunk_end += 1;
        }

        let chunk = &rows[chunk_start..chunk_end];
        let sql = tmpl.build_chunk_sql(chunk, &escape_style, num_cols);

        if sql.len() > max_sql_bytes && chunk.len() > 1 {
            let mut hi = chunk.len() - 1;
            let mut lo = 1;
            let mut best = 1;
            while lo <= hi {
                let mid = (lo + hi) / 2;
                let test_sql = tmpl.build_chunk_sql(&chunk[..mid], &escape_style, num_cols);
                if test_sql.len() <= max_sql_bytes {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            let sql = tmpl.build_chunk_sql(&chunk[..best], &escape_style, num_cols);
            let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(pool).await
                .map_err(|e| AppError::Datasource(format!("INSERT chunk execute: {}", e)))?;
            total_written += result.rows_affected().min(best as u64) as usize;
            chunk_start += best;
            continue;
        }

        let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(pool).await
            .map_err(|e| AppError::Datasource(format!("INSERT chunk execute: {}", e)))?;
        total_written += result.rows_affected().min(chunk.len() as u64) as usize;
        chunk_start = chunk_end;
    }

    Ok(total_written)
}

impl MySqlDataSource {
    /// Async: query the server's max_allowed_packet and cache the result.
    /// Subsequent calls return the cached value without network round-trip.
    async fn query_and_cache_max_allowed_packet(&self) -> usize {
        if let Some(&v) = self.max_allowed_packet.get() {
            return v;
        }
        const DEFAULT: usize = 48 * 1024 * 1024;
        let val = match sqlx::query_scalar::<_, i64>("SELECT @@max_allowed_packet")
            .fetch_optional(&self.pool)
            .await
        {
            Ok(Some(v)) if v > 0 => v as usize,
            _ => DEFAULT,
        };
        let _ = self.max_allowed_packet.set(val);
        val
    }
}

// estimate_row_sql_size moved to bulk_write.rs — imported above

impl MySqlDataSource {
    /// LOAD DATA LOCAL INFILE from native MigrationRows (avoids serde_json::Value).
    async fn bulk_write_load_data_native(
        &self,
        table: &str,
        columns: &[String],
        rows: Vec<crate::migration::native_row::MigrationRow>,
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
    ) -> AppResult<usize> {
        use mysql_async::prelude::*;
        use futures_util::StreamExt;

        let pool = self.get_mig_pool().await?;
        let mut conn = pool.get_conn().await
            .map_err(|e| AppError::Datasource(format!("mysql_async get_conn: {}", e)))?;

        let _ = conn.query_drop("SET SESSION unique_checks = 0; SET SESSION foreign_key_checks = 0; SET SESSION sql_log_bin = 0;").await;

        let rows_arc = std::sync::Arc::new(rows);
        conn.set_infile_handler(async move {
            let len = rows_arc.len();
            let stream = futures_util::stream::iter(0..len)
                .chunks(1000) // Batch 1000 rows into one TSV chunk for better throughput
                .map(move |chunk_indices| {
                    let mut buf = Vec::with_capacity(chunk_indices.len() * 128);
                    for idx in chunk_indices {
                        rows_arc[idx].to_tsv_line(&mut buf);
                    }
                    Ok(bytes::Bytes::from(buf))
                });
            Ok(stream.boxed())
        });

        let quote = |c: &str| crate::datasource::utils::quote_identifier_for_driver(c, "mysql");
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let replace_keyword = match conflict_strategy {
            crate::migration::task_mgr::ConflictStrategy::Replace => " REPLACE",
            crate::migration::task_mgr::ConflictStrategy::Skip => " IGNORE",
            _ => "",
        };

        let load_sql = format!(
            "LOAD DATA LOCAL INFILE 'migration_batch.tsv'{} INTO TABLE {} \
             FIELDS TERMINATED BY '\\t' \
             LINES TERMINATED BY '\\n' \
             ({})",
            replace_keyword,
            quote(table),
            col_list,
        );

        conn.query_drop(&load_sql).await
            .map_err(|e| AppError::Datasource(format!("LOAD DATA native: {}", e)))?;

        let affected = conn.affected_rows();
        Ok(affected as usize)
    }

    /// Static method for bulk_write_native_in_txn (called from trait impl).
    /// Executes chunked INSERT within a transaction, respecting max_allowed_packet.
    async fn bulk_write_native_in_txn_static(
        txn: &mut sqlx::Transaction<'_, sqlx::MySql>,
        table: &str,
        columns: &[String],
        rows: &[crate::migration::native_row::MigrationRow],
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
        max_packet: usize,
    ) -> AppResult<usize> {
        use crate::datasource::bulk_write::{InsertTemplate, build_native_chunk_sql};

        let max_sql_bytes = (max_packet as f64 * 0.75).round() as usize;
        let escape_style = crate::datasource::StringEscapeStyle::Standard;
        let num_cols = columns.len();

        let tmpl = InsertTemplate::new(table, columns, conflict_strategy, upsert_keys, driver);

        let row_sizes: Vec<usize> = rows.iter()
            .map(|r| {
                let mut size = num_cols * 3;
                for v in &r.values {
                    size += v.estimated_sql_size();
                }
                size
            })
            .collect();

        let mut total_written = 0usize;
        let mut chunk_start = 0;

        while chunk_start < rows.len() {
            let mut chunk_sql_size = 0usize;
            let mut chunk_end = chunk_start;

            while chunk_end < rows.len() {
                let row_size = row_sizes[chunk_end];
                if chunk_end > chunk_start && chunk_sql_size + row_size > max_sql_bytes {
                    break;
                }
                chunk_sql_size += row_size;
                chunk_end += 1;
            }

            let chunk = &rows[chunk_start..chunk_end];
            let sql = build_native_chunk_sql(&tmpl, chunk, &escape_style);

            // Binary search fallback if estimation underestimates
            if sql.len() > max_sql_bytes && chunk.len() > 1 {
                let mut hi = chunk.len() - 1;
                let mut lo = 1;
                let mut best = 1;
                while lo <= hi {
                    let mid = (lo + hi) / 2;
                    let test_sql = build_native_chunk_sql(&tmpl, &chunk[..mid], &escape_style);
                    if test_sql.len() <= max_sql_bytes {
                        best = mid;
                        lo = mid + 1;
                    } else {
                        hi = mid - 1;
                    }
                }
                let sql = build_native_chunk_sql(&tmpl, &chunk[..best], &escape_style);
                let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql)
                    .execute(&mut **txn).await
                    .map_err(|e| crate::error::AppError::Datasource(format!("INSERT in txn: {}", e)))?;
                total_written += result.rows_affected().min(best as u64) as usize;
                chunk_start += best;
                continue;
            }

            let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql)
                .execute(&mut **txn).await
                .map_err(|e| crate::error::AppError::Datasource(format!("INSERT in txn: {}", e)))?;
            total_written += result.rows_affected().min(chunk.len() as u64) as usize;
            chunk_start = chunk_end;
        }

        Ok(total_written)
    }

    /// Native INSERT chunked: MigrationRow -> multi-row INSERT SQL directly.
    ///
    /// All conflict strategies use chunked multi-row INSERT
    /// (`INSERT INTO t VALUES (...),(...),...`) so a single round-trip flushes
    /// thousands of rows. This is the LOAD DATA fallback path.
    ///
    /// Historical note: an earlier revision routed non-Upsert strategies to a
    /// single-row parametrized INSERT loop ("memory-friendly") which silently
    /// degraded write throughput by 1-2 orders of magnitude (N round-trips per
    /// batch vs. 1). Memory is bounded by chunking on `max_allowed_packet`
    /// inside `bulk_write_native_insert_chunked_sql_string`, not per-row binds.
    async fn bulk_write_native_insert_chunked(
        &self,
        table: &str,
        columns: &[String],
        rows: Vec<crate::migration::native_row::MigrationRow>,
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        self.bulk_write_native_insert_chunked_sql_string(
            table, columns, rows, conflict_strategy, upsert_keys, driver
        ).await
    }

    /// Chunked multi-row INSERT, one SQL string per chunk.
    ///
    /// Works for every `ConflictStrategy` (Insert / Replace / Skip / Upsert /
    /// Overwrite). Chunk size is bounded by 75% of `max_allowed_packet` with a
    /// binary-search fallback when the pre-estimate underbounds.
    ///
    /// TEXT-heavy rows briefly inflate ~3-5x during SQL construction; chunking
    /// on `max_allowed_packet` keeps peak per-batch memory predictable.
    async fn bulk_write_native_insert_chunked_sql_string(
        &self,
        table: &str,
        columns: &[String],
        rows: Vec<crate::migration::native_row::MigrationRow>,
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        let max_packet = self.query_and_cache_max_allowed_packet().await;
        let max_sql_bytes = (max_packet as f64 * 0.75).round() as usize;
        let escape_style = self.string_escape_style();
        let num_cols = columns.len();

        use crate::datasource::bulk_write::InsertTemplate;
        let tmpl = InsertTemplate::new(table, columns, conflict_strategy, upsert_keys, driver);

        let row_sizes: Vec<usize> = rows.iter()
            .map(|r| {
                let mut size = num_cols * 3;
                for v in &r.values {
                    size += v.estimated_sql_size();
                }
                size
            })
            .collect();

        let mut total_written = 0usize;
        let mut chunk_start = 0;

        while chunk_start < rows.len() {
            let mut chunk_sql_size = 0usize;
            let mut chunk_end = chunk_start;

            while chunk_end < rows.len() {
                let row_size = row_sizes[chunk_end];
                if chunk_end > chunk_start && chunk_sql_size + row_size > max_sql_bytes {
                    break;
                }
                chunk_sql_size += row_size;
                chunk_end += 1;
            }

            let chunk = &rows[chunk_start..chunk_end];
            let sql = build_native_chunk_sql(&tmpl, chunk, &escape_style);

            if sql.len() > max_sql_bytes && chunk.len() > 1 {
                // Binary search fallback
                let mut hi = chunk.len() - 1;
                let mut lo = 1;
                let mut best = 1;
                while lo <= hi {
                    let mid = (lo + hi) / 2;
                    let test_sql = build_native_chunk_sql(&tmpl, &chunk[..mid], &escape_style);
                    if test_sql.len() <= max_sql_bytes {
                        best = mid;
                        lo = mid + 1;
                    } else {
                        hi = mid - 1;
                    }
                }
                let sql = build_native_chunk_sql(&tmpl, &chunk[..best], &escape_style);
                let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(&self.pool).await
                    .map_err(|e| AppError::Datasource(format!("Native INSERT chunk: {}", e)))?;
                total_written += result.rows_affected().min(best as u64) as usize;
                chunk_start += best;
                continue;
            }

            let result: sqlx::mysql::MySqlQueryResult = sqlx::query(&sql).execute(&self.pool).await
                .map_err(|e| AppError::Datasource(format!("Native INSERT chunk: {}", e)))?;
            total_written += result.rows_affected().min(chunk.len() as u64) as usize;
            chunk_start = chunk_end;
        }

        Ok(total_written)
    }

    async fn bulk_write_load_data(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &crate::migration::task_mgr::ConflictStrategy,
    ) -> AppResult<usize> {
        use mysql_async::prelude::*;
        use futures_util::StreamExt;
        use crate::datasource::bulk_write::rows_to_tsv;

        let pool = self.get_mig_pool().await?;
        let mut conn = pool.get_conn().await
            .map_err(|e| AppError::Datasource(format!("mysql_async get_conn: {}", e)))?;

        // Session optimizations for LOAD DATA (this pool is separate from sqlx,
        // so after_connect on the sqlx pool does NOT affect these connections).
        let _ = conn.query_drop("SET SESSION unique_checks = 0; SET SESSION foreign_key_checks = 0; SET SESSION sql_log_bin = 0;").await;

        let tsv_data = rows_to_tsv(rows);
        let tsv_bytes = bytes::Bytes::from(tsv_data);

        // Local infile handler: returns a stream that yields the TSV data in one chunk.
        conn.set_infile_handler(async move {
            Ok(futures_util::stream::once(
                async move { Ok(tsv_bytes) }
            ).boxed())
        });

        let quote = |c: &str| crate::datasource::utils::quote_identifier_for_driver(c, "mysql");
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let replace_keyword = match conflict_strategy {
            crate::migration::task_mgr::ConflictStrategy::Replace => " REPLACE",
            crate::migration::task_mgr::ConflictStrategy::Skip => " IGNORE",
            _ => "",
        };

        let load_sql = format!(
            "LOAD DATA LOCAL INFILE 'migration_batch.tsv'{} INTO TABLE {} \
             FIELDS TERMINATED BY '\\t' \
             LINES TERMINATED BY '\\n' \
             ({})",
            replace_keyword,
            quote(table),
            col_list,
        );

        conn.query_drop(&load_sql).await
            .map_err(|e| AppError::Datasource(format!("LOAD DATA: {}", e)))?;

        let affected = conn.affected_rows();
        Ok(affected as usize)
    }

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
