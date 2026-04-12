use async_trait::async_trait;
use super::{ConnectionConfig, DataSource, DriverCapabilities, QueryResult, SchemaInfo, SqlDialect, TableMeta};
use crate::{AppError, AppResult};

#[cfg(feature = "oracle-driver")]
use oracle as oracle_crate;

pub struct OracleDataSource {
    #[cfg(feature = "oracle-driver")]
    connection_string: String,
    #[cfg(feature = "oracle-driver")]
    username: String,
    #[cfg(feature = "oracle-driver")]
    password: String,
    mig_session_active: std::sync::atomic::AtomicBool,
}

/// Convert a serde_json::Value to an Oracle-compatible parameter type.
#[cfg(feature = "oracle-driver")]
fn json_to_oracle_param(val: &serde_json::Value) -> oracle_crate::Param {
    match val {
        serde_json::Value::Null => oracle_crate::Param::Null,
        serde_json::Value::Bool(b) => oracle_crate::Param::from(if *b { 1i32 } else { 0i32 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                oracle_crate::Param::from(i)
            } else if let Some(f) = n.as_f64() {
                oracle_crate::Param::from(f)
            } else {
                oracle_crate::Param::from(n.to_string())
            }
        }
        serde_json::Value::String(s) => oracle_crate::Param::from(s.as_str()),
        other => oracle_crate::Param::from(other.to_string()),
    }
}

impl OracleDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        #[cfg(not(feature = "oracle-driver"))]
        {
            let _ = config;
            Err(AppError::Datasource(
                "Oracle driver not enabled. Build with --features oracle-driver (requires Oracle Instant Client).".into()
            ))
        }
        #[cfg(feature = "oracle-driver")]
        {
            // 将 localhost 替换为 127.0.0.1，避免 IPv6 DNS 解析导致连接延迟
            let host = match config.host.as_deref().unwrap_or("localhost") {
                h if h.eq_ignore_ascii_case("localhost") => "127.0.0.1",
                h => h,
            };
            let port = config.port.unwrap_or(1521);
            let database = config.database.as_deref().unwrap_or("");
            Ok(Self {
                connection_string: format!("//{}:{}/{}", host, port, database),
                username: config.username.as_deref().unwrap_or("").to_string(),
                password: config.password.as_deref().unwrap_or("").to_string(),
                mig_session_active: std::sync::atomic::AtomicBool::new(false),
            })
        }
    }
}

#[async_trait]
impl DataSource for OracleDataSource {
    fn as_any(&self) -> &dyn std::any::Any { self }

    async fn test_connection(&self) -> AppResult<()> {
        #[cfg(not(feature = "oracle-driver"))]
        return Err(AppError::Datasource("Oracle driver not enabled.".into()));

        #[cfg(feature = "oracle-driver")]
        {
            let conn_str = self.connection_string.clone();
            let user = self.username.clone();
            let pass = self.password.clone();
            tokio::task::spawn_blocking(move || {
                oracle_crate::Connection::connect(&user, &pass, &conn_str)
                    .map(|_| ())
                    .map_err(|e| AppError::Datasource(e.to_string()))
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        #[cfg(not(feature = "oracle-driver"))]
        {
            let _ = sql;
            return Err(AppError::Datasource("Oracle driver not enabled.".into()));
        }

        #[cfg(feature = "oracle-driver")]
        {
            let conn_str = self.connection_string.clone();
            let user = self.username.clone();
            let pass = self.password.clone();
            let sql = sql.to_string();
            let start = std::time::Instant::now();

            tokio::task::spawn_blocking(move || {
                let conn = oracle_crate::Connection::connect(&user, &pass, &conn_str)
                    .map_err(|e| AppError::Datasource(e.to_string()))?;

                // Non-SELECT statements: split into individual statements and execute each,
                // then commit once. oracle-crate does not support multi-statement strings.
                let trimmed = crate::datasource::utils::strip_leading_comments(sql).to_uppercase();
                if !trimmed.starts_with("SELECT") && !trimmed.starts_with("WITH") {
                    let stmts = crate::datasource::utils::split_sql_statements(&sql);
                    let mut total_affected = 0usize;
                    for s in &stmts {
                        let mut stmt = conn.statement(s).build()
                            .map_err(|e| AppError::Datasource(e.to_string()))?;
                        stmt.execute(&[])
                            .map_err(|e| AppError::Datasource(e.to_string()))?;
                        total_affected += stmt.row_count()
                            .map_err(|e| AppError::Datasource(e.to_string()))? as usize;
                    }
                    conn.commit()
                        .map_err(|e| AppError::Datasource(e.to_string()))?;
                    let duration_ms = start.elapsed().as_millis() as u64;
                    return Ok(QueryResult { columns: vec![], rows: vec![], row_count: total_affected, duration_ms });
                }

                let mut stmt = conn.statement(&sql).build()
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                let rows = stmt.query(&[])
                    .map_err(|e| AppError::Datasource(e.to_string()))?;

                let column_info = rows.column_info();
                let columns: Vec<String> = column_info.iter().map(|c| c.name().to_string()).collect();
                let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();

                for row_result in rows {
                    let row = row_result.map_err(|e| AppError::Datasource(e.to_string()))?;
                    let values: Vec<serde_json::Value> = (0..columns.len())
                        .map(|i| {
                            // Try multiple types in order of preference
                            if let Ok(val) = row.get::<Option<String>>(i) {
                                val.map(serde_json::Value::String)
                                    .unwrap_or(serde_json::Value::Null)
                            } else if let Ok(val) = row.get::<Option<i64>>(i) {
                                val.map(|v| serde_json::json!(v))
                                    .unwrap_or(serde_json::Value::Null)
                            } else if let Ok(val) = row.get::<Option<f64>>(i) {
                                val.map(|v| serde_json::json!(v))
                                    .unwrap_or(serde_json::Value::Null)
                            } else if let Ok(val) = row.get::<Option<bool>>(i) {
                                val.map(|v| serde_json::json!(v))
                                    .unwrap_or(serde_json::Value::Null)
                            } else {
                                serde_json::Value::Null
                            }
                        })
                        .collect();
                    result_rows.push(values);
                }

                let duration_ms = start.elapsed().as_millis() as u64;
                let row_count = result_rows.len();
                Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let result = self.execute(
            "SELECT owner, table_name, 'TABLE' as table_type FROM all_tables \
             WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY table_name"
        ).await?;

        Ok(result.rows.into_iter().map(|row| TableMeta {
            schema: row.first().and_then(|v| v.as_str().map(String::from)),
            name: row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            table_type: "TABLE".to_string(),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: true,
            has_foreign_keys: true,
            has_stored_procedures: true,
            has_triggers: true,
            has_materialized_views: false,
            has_multi_database: false, // Oracle 使用 Schema 而非多数据库
            has_partitions: true,
            sql_dialect: SqlDialect::Standard,
            supported_auth_types: vec!["password".to_string(), "os_native".to_string()],
            has_pool_config: false,
            has_timeout_config: true,
            has_ssl_config: false,
        }
    }

    fn string_escape_style(&self) -> crate::datasource::StringEscapeStyle {
        crate::datasource::StringEscapeStyle::TSql
    }

    async fn setup_migration_session(&self) -> AppResult<()> {
        // Oracle: disable constraints and optimize session for bulk inserts.
        // These are applied per-connection in the execute() path.
        self.mig_session_active.store(true, std::sync::atomic::Ordering::Relaxed);
        log::info!("Oracle migration session optimizations enabled (per-connection)");
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        self.mig_session_active.store(false, std::sync::atomic::Ordering::Relaxed);
        log::info!("Oracle migration session optimizations reverted");
        Ok(())
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

        #[cfg(not(feature = "oracle-driver"))]
        {
            let _ = (table, columns, rows, conflict_strategy, upsert_keys, driver);
            return Err(AppError::Datasource("Oracle driver not enabled.".into()));
        }

        #[cfg(feature = "oracle-driver")]
        {
            use oracle_crate::Batch;

            let conn_str = self.connection_string.clone();
            let user = self.username.clone();
            let pass = self.password.clone();
            let table = table.to_string();
            let columns = columns.to_vec();
            let rows = rows.to_vec();
            let conflict_strategy = conflict_strategy.clone();
            let upsert_keys = upsert_keys.to_vec();
            let driver = driver.to_string();

            // Oracle per-query connection: open connection, do batch insert in txn.
            let total = tokio::task::spawn_blocking(move || {
                let conn = oracle_crate::Connection::connect(&user, &pass, &conn_str)
                    .map_err(|e| AppError::Datasource(e.to_string()))?;

                // Session optimizations
                let _ = conn.execute("ALTER SESSION SET SKIP_UNUSABLE_INDEXES = TRUE", &[]);
                let _ = conn.execute("ALTER SESSION SET COMMIT_WRITE = 'BATCH,NOWAIT'", &[]);

                let quote = |c: &str| crate::datasource::utils::quote_identifier_for_driver(c, "oracle");
                let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
                let placeholders: Vec<String> = (0..columns.len())
                    .map(|i| format!(":{}", i + 1))
                    .collect();
                let values_clause = placeholders.join(", ");

                let sql = match &conflict_strategy {
                    crate::migration::task_mgr::ConflictStrategy::Insert => {
                        format!("INSERT INTO {} ({}) VALUES ({})", quote(&table), col_list, values_clause)
                    }
                    crate::migration::task_mgr::ConflictStrategy::Replace => {
                        // Oracle uses MERGE for replace semantics
                        let pk_cols = if upsert_keys.is_empty() {
                            columns.iter().take(1).map(|c| quote(c)).collect::<Vec<_>>()
                        } else {
                            upsert_keys.iter().map(|c| quote(c)).collect::<Vec<_>>()
                        };
                        let merge_on = pk_cols.iter()
                            .map(|c| format!("T.{0} = S.{0}", c))
                            .collect::<Vec<_>>().join(" AND ");
                        let update_set = columns.iter().map(|c| {
                            let q = quote(c);
                            format!("T.{q} = S.{q}")
                        }).collect::<Vec<_>>().join(", ");
                        format!(
                            "MERGE INTO {} T USING (SELECT {} FROM DUAL) S ({}) \
                             ON ({}) \
                             WHEN MATCHED THEN UPDATE SET {} \
                             WHEN NOT MATCHED THEN INSERT ({}) VALUES ({})",
                            quote(&table), values_clause, col_list, merge_on,
                            update_set, col_list, values_clause,
                        )
                    }
                    crate::migration::task_mgr::ConflictStrategy::Skip => {
                        format!(
                            "INSERT /*+ IGNORE_ROW_ON_DUPKEY_INDEX({}) */ INTO {} ({}) VALUES ({})",
                            quote(&table), quote(&table), col_list, values_clause
                        )
                    }
                    crate::migration::task_mgr::ConflictStrategy::Overwrite => {
                        format!("INSERT INTO {} ({}) VALUES ({})", quote(&table), col_list, values_clause)
                    }
                };

                let mut stmt = conn.statement(&sql).build()
                    .map_err(|e| AppError::Datasource(e.to_string()))?;

                // Batch insert: bind rows and execute in a single transaction
                let mut batch = Batch::new();
                for row in &rows {
                    let mut params: Vec<oracle_crate::Param> = Vec::with_capacity(columns.len());
                    for val in row {
                        params.push(json_to_oracle_param(val));
                    }
                    batch.add_row(&params);
                }

                let total_executed = stmt.execute_batch(&batch)
                    .map_err(|e| AppError::Datasource(format!("Oracle batch insert: {}", e)))?;

                conn.commit()
                    .map_err(|e| AppError::Datasource(e.to_string()))?;

                Ok::<usize, AppError>(total_executed as usize)
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))??;

            Ok(total)
        }
    }
}
