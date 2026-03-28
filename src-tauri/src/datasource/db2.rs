use async_trait::async_trait;

#[allow(unused_imports)]
use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

#[allow(unused_imports)]
use super::utils::quote_identifier;

/// 转义 DB2 SQL 字符串字面值中的单引号，防止 SQL 注入。
/// DB2 SYSCAT 视图需要单引号包裹的字符串值（非标识符），不能用参数化查询。
#[allow(dead_code)]
fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

// ─── 全局 ODBC Environment（进程生命周期，所有 DB2 连接共享） ─────────────────

#[cfg(feature = "db2-driver")]
static ODBC_ENV: once_cell::sync::Lazy<odbc_api::Environment> =
    once_cell::sync::Lazy::new(|| {
        odbc_api::Environment::new().expect("Failed to initialize ODBC environment")
    });

#[allow(dead_code)]
pub struct Db2DataSource {
    conn_str: String,
    database: String,
    schema: String,
    #[cfg(feature = "db2-driver")]
    conn: std::sync::Arc<std::sync::Mutex<Option<odbc_api::Connection<'static>>>>,
}

impl Db2DataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(50000);
        let database = config.database.as_deref().unwrap_or("").to_string();
        let username = config.username.as_deref().unwrap_or("");
        let password = config.password.as_deref().unwrap_or("");

        // DB2 convention: schema defaults to uppercase username
        let schema = username.to_uppercase();

        let conn_str = format!(
            "Driver={{IBM DB2 ODBC DRIVER}};Database={};Hostname={};Port={};Protocol=TCPIP;Uid={};Pwd={};",
            database, host, port, username, password
        );

        Ok(Self {
            conn_str,
            database,
            schema,
            #[cfg(feature = "db2-driver")]
            conn: std::sync::Arc::new(std::sync::Mutex::new(None)),
        })
    }
}

// ─── Helper functions ────────────────────────────────────────────────────────

#[allow(unused_imports)]
use super::utils::format_size;

/// 使用持久连接执行操作。首次调用时建立连接，查询失败时自动重连一次。
///
/// 通过 Mutex 序列化所有对同一连接的访问（ODBC Connection 不是线程安全的）。
/// conn_str 仅在需要（重新）建连时使用。
#[cfg(feature = "db2-driver")]
fn with_connection_impl<F, T>(
    conn_str: &str,
    conn_mutex: &std::sync::Mutex<Option<odbc_api::Connection<'static>>>,
    f: F,
) -> AppResult<T>
where
    F: Fn(&odbc_api::Connection<'static>) -> AppResult<T>,
{
    use odbc_api::ConnectionOptions;

    let mut guard = conn_mutex.lock().map_err(|e| {
        AppError::Datasource(format!("DB2 connection mutex poisoned: {}", e))
    })?;

    // 确保连接存在
    if guard.is_none() {
        let c = ODBC_ENV
            .connect_with_connection_string(conn_str, ConnectionOptions::default())
            .map_err(|e| AppError::Datasource(format!("DB2 connection failed: {}", e)))?;
        *guard = Some(c);
        log::debug!("DB2 persistent connection established");
    }

    // 尝试执行
    let conn = guard.as_ref().unwrap();
    match f(conn) {
        Ok(result) => Ok(result),
        Err(e) => {
            // 查询失败，尝试重连一次
            let error_msg = e.to_string();
            log::warn!("DB2 query failed, attempting reconnection: {}", error_msg);

            *guard = None; // 丢弃旧连接

            let new_conn = ODBC_ENV
                .connect_with_connection_string(conn_str, ConnectionOptions::default())
                .map_err(|e2| AppError::Datasource(format!(
                    "DB2 reconnection failed: {} (original error: {})", e2, error_msg
                )))?;
            *guard = Some(new_conn);
            log::debug!("DB2 reconnection successful, retrying query");

            let conn = guard.as_ref().unwrap();
            f(conn)
        }
    }
}

/// Execute a SQL query using persistent ODBC connection and return a QueryResult.
/// Must be called from within `spawn_blocking` via `with_connection_impl`.
#[cfg(feature = "db2-driver")]
fn execute_query_with_conn(conn: &odbc_api::Connection<'static>, sql: &str) -> AppResult<QueryResult> {
    use std::time::Instant;
    use odbc_api::{buffers::TextRowSet, Cursor, ResultSetMetadata};

    let start = Instant::now();

    let cursor_opt = conn
        .execute(sql, (), None)
        .map_err(|e| AppError::Datasource(format!("DB2 query error: {}", e)))?;

    let duration_ms = start.elapsed().as_millis() as u64;

    if let Some(mut cursor) = cursor_opt {
        let num_cols = cursor
            .num_result_cols()
            .map_err(|e| AppError::Datasource(format!("DB2 column count error: {}", e)))?
            as usize;

        let mut columns = Vec::with_capacity(num_cols);
        for i in 1..=(num_cols as u16) {
            let name = cursor
                .col_name(i)
                .map_err(|e| AppError::Datasource(format!("DB2 col_name error: {}", e)))?;
            columns.push(name);
        }

        let batch_size = 1000_usize;
        let buffer = TextRowSet::for_cursor(batch_size, &mut cursor, Some(4096))
            .map_err(|e| AppError::Datasource(format!("DB2 buffer error: {}", e)))?;
        let mut row_set_cursor = cursor
            .bind_buffer(buffer)
            .map_err(|e| AppError::Datasource(format!("DB2 bind_buffer error: {}", e)))?;

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        loop {
            let batch_opt = row_set_cursor
                .fetch()
                .map_err(|e| AppError::Datasource(format!("DB2 fetch error: {}", e)))?;
            match batch_opt {
                None => break,
                Some(batch) => {
                    for row_idx in 0..batch.num_rows() {
                        let mut row = Vec::with_capacity(num_cols);
                        for col_idx in 0..num_cols {
                            let val = batch.at(col_idx, row_idx).map(|bytes| {
                                String::from_utf8_lossy(bytes).to_string()
                            });
                            row.push(match val {
                                Some(s) => serde_json::Value::String(s),
                                None => serde_json::Value::Null,
                            });
                        }
                        rows.push(row);
                    }
                }
            }
        }

        let row_count = rows.len();
        Ok(QueryResult { columns, rows, row_count, duration_ms })
    } else {
        // Non-SELECT statement (INSERT/UPDATE/DELETE/DDL)
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms,
        })
    }
}

/// Fetch a single column of strings from a query. Used for list_* helpers.
#[cfg(feature = "db2-driver")]
fn fetch_string_list_with_conn(conn: &odbc_api::Connection<'static>, sql: &str) -> AppResult<Vec<String>> {
    let result = execute_query_with_conn(conn, sql)?;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().and_then(|v| v.as_str().map(String::from)))
        .collect())
}

// ─── DataSource implementation ───────────────────────────────────────────────

#[async_trait]
impl DataSource for Db2DataSource {
    async fn test_connection(&self) -> AppResult<()> {
        #[cfg(not(feature = "db2-driver"))]
        return Err(AppError::Datasource(
            "DB2 driver not enabled. Build with --features db2-driver (requires IBM DB2 ODBC Driver).".into(),
        ));

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            tokio::task::spawn_blocking(move || {
                // 清空缓存连接，强制重新建连以测试连通性
                {
                    let mut guard = conn_mutex.lock().map_err(|e| {
                        AppError::Datasource(format!("Mutex poisoned: {}", e))
                    })?;
                    *guard = None;
                }
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    execute_query_with_conn(conn, "SELECT 1 FROM SYSIBM.SYSDUMMY1").map(|_| ())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = sql;
            return Err(AppError::Datasource("DB2 driver not enabled.".into()));
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let sql = sql.to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    execute_query_with_conn(conn, &sql)
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = self.schema.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT TABSCHEMA, TABNAME, TYPE FROM SYSCAT.TABLES \
                         WHERE TABSCHEMA = '{}' AND TYPE IN ('T', 'V') \
                         ORDER BY TABNAME",
                        escape_sql_string(&schema)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let schema_val = row.first().and_then(|v| v.as_str().map(String::from));
                        let name = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let type_char = row.get(2).and_then(|v| v.as_str()).unwrap_or("T");
                        let table_type = match type_char {
                            "V" => "VIEW".to_string(),
                            _ => "TABLE".to_string(),
                        };
                        TableMeta { schema: schema_val, name, table_type }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = (table, schema);
            return Ok(vec![]);
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT COLNAME, TYPENAME, NULLS, DEFAULT, KEYSEQ, REMARKS \
                         FROM SYSCAT.COLUMNS \
                         WHERE TABSCHEMA = '{}' AND TABNAME = '{}' \
                         ORDER BY COLNO",
                        escape_sql_string(&schema), escape_sql_string(&table)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let data_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let nulls = row.get(2).and_then(|v| v.as_str()).unwrap_or("N");
                        let is_nullable = nulls == "Y";
                        let column_default = row.get(3).and_then(|v| {
                            if v.is_null() { None } else { v.as_str().map(String::from) }
                        });
                        let keyseq = row.get(4).and_then(|v| {
                            // KEYSEQ can be numeric string or null
                            v.as_str().and_then(|s| s.trim().parse::<i32>().ok())
                        }).unwrap_or(0);
                        let is_primary_key = keyseq > 0;
                        let comment = row.get(5).and_then(|v| {
                            if v.is_null() { None } else { v.as_str().map(String::from) }
                        });
                        ColumnMeta {
                            name,
                            data_type,
                            is_nullable,
                            column_default,
                            is_primary_key,
                            extra: None,
                            comment,
                        }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = (table, schema);
            return Ok(vec![]);
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT INDNAME, UNIQUERULE, COLNAMES FROM SYSCAT.INDEXES \
                         WHERE TABSCHEMA = '{}' AND TABNAME = '{}'",
                        escape_sql_string(&schema), escape_sql_string(&table)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    let indexes = result.rows.into_iter().map(|row| {
                        let index_name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let unique_rule = row.get(1).and_then(|v| v.as_str()).unwrap_or("D");
                        // UNIQUERULE: 'U' = unique user index, 'P' = primary key index, 'D' = non-unique
                        let is_unique = matches!(unique_rule, "U" | "P");
                        // COLNAMES format: "+COL1+COL2-COL3" (+ = ASC, - = DESC)
                        let colnames_raw = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
                        let columns: Vec<String> = colnames_raw
                            .split(|c| c == '+' || c == '-')
                            .filter(|s| !s.is_empty())
                            .map(|s| s.trim().to_string())
                            .collect();
                        IndexMeta { index_name, is_unique, columns }
                    }).collect();
                    Ok(indexes)
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = (table, schema);
            return Ok(vec![]);
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT R.CONSTNAME, FK.COLNAME, R.REFTABNAME, PK.COLNAME AS REFCOLNAME, R.DELETERULE \
                         FROM SYSCAT.REFERENCES R \
                         JOIN SYSCAT.KEYCOLUSE FK ON FK.CONSTNAME = R.CONSTNAME AND FK.TABSCHEMA = R.TABSCHEMA \
                         JOIN SYSCAT.KEYCOLUSE PK ON PK.CONSTNAME = R.REFKEYNAME AND PK.TABSCHEMA = R.REFTABSCHEMA \
                         WHERE R.TABSCHEMA = '{}' AND R.TABNAME = '{}' \
                         AND FK.COLSEQ = PK.COLSEQ",
                        escape_sql_string(&schema), escape_sql_string(&table)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let constraint_name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let column = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let referenced_table = row.get(2).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let referenced_column = row.get(3).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        // DELETERULE: 'A' = NO ACTION, 'C' = CASCADE, 'N' = SET NULL, 'R' = RESTRICT
                        let delete_rule = row.get(4).and_then(|v| v.as_str()).unwrap_or("A");
                        let on_delete = Some(match delete_rule {
                            "C" => "CASCADE".to_string(),
                            "N" => "SET NULL".to_string(),
                            "R" => "RESTRICT".to_string(),
                            _ => "NO ACTION".to_string(),
                        });
                        ForeignKeyMeta { constraint_name, column, referenced_table, referenced_column, on_delete }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = self.schema.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT VIEWNAME, TEXT FROM SYSCAT.VIEWS \
                         WHERE VIEWSCHEMA = '{}' ORDER BY VIEWNAME",
                        escape_sql_string(&schema)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let definition = row.get(1).and_then(|v| {
                            if v.is_null() { None } else { v.as_str().map(String::from) }
                        });
                        ViewMeta { name, definition }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = self.schema.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT PROCNAME, 'PROCEDURE' AS TYPE FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = '{}' \
                         UNION ALL \
                         SELECT FUNCNAME, 'FUNCTION' AS TYPE FROM SYSCAT.FUNCTIONS WHERE FUNCSCHEMA = '{}' \
                         ORDER BY 1",
                        escape_sql_string(&schema), escape_sql_string(&schema)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let rt = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
                        let routine_type = match rt {
                            "PROCEDURE" => RoutineType::Procedure,
                            "FUNCTION" => RoutineType::Function,
                            _ => RoutineType::Unknown,
                        };
                        ProcedureMeta { name, routine_type }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        self.get_table_ddl_with_schema(table, None).await
    }

    /// DB2 has no SHOW CREATE TABLE — assemble DDL manually from SYSCAT.COLUMNS.
    async fn get_table_ddl_with_schema(&self, table: &str, schema: Option<&str>) -> AppResult<String> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = (table, schema);
            return Ok(String::new());
        }

        #[cfg(feature = "db2-driver")]
        {
            let effective_schema = schema.unwrap_or(&self.schema).to_string();
            let columns = self.get_columns(table, Some(&effective_schema)).await?;

            if columns.is_empty() {
                return Ok(format!(
                    "-- Table \"{}\".\"{}\" not found",
                    effective_schema, table
                ));
            }

            let mut pk_cols: Vec<String> = columns
                .iter()
                .filter(|c| c.is_primary_key)
                .map(|c| format!("    {}", c.name))
                .collect();

            let col_defs: Vec<String> = columns
                .iter()
                .map(|c| {
                    let mut def = format!("    {} {}", c.name, c.data_type);
                    if let Some(ref d) = c.column_default {
                        def.push_str(&format!(" DEFAULT {}", d));
                    }
                    if !c.is_nullable {
                        def.push_str(" NOT NULL");
                    }
                    if let Some(ref comment) = c.comment {
                        def.push_str(&format!(" -- {}", comment));
                    }
                    def
                })
                .collect();

            let mut parts = col_defs;
            if !pk_cols.is_empty() {
                parts.push(format!(
                    "    PRIMARY KEY ({})",
                    pk_cols.iter().map(|s| s.trim()).collect::<Vec<_>>().join(", ")
                ));
            }

            Ok(format!(
                "CREATE TABLE \"{}\".\"{}\" (\n{}\n)",
                effective_schema,
                table,
                parts.join(",\n")
            ))
        }
    }

    /// DB2 schemas serve as the "database" concept for tree navigation.
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    fetch_string_list_with_conn(
                        conn,
                        "SELECT SCHEMANAME FROM SYSCAT.SCHEMATA WHERE OWNERTYPE = 'U' ORDER BY SCHEMANAME",
                    )
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    fetch_string_list_with_conn(
                        conn,
                        "SELECT SCHEMANAME FROM SYSCAT.SCHEMATA WHERE OWNERTYPE = 'U' ORDER BY SCHEMANAME",
                    )
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn list_objects(
        &self,
        _database: &str,
        schema: Option<&str>,
        category: &str,
    ) -> AppResult<Vec<String>> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = (schema, category);
            return Ok(vec![]);
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = schema.unwrap_or(&self.schema).to_string();
            let category = category.to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let esc_schema = escape_sql_string(&schema);
                    let sql = match category.as_str() {
                        "tables" => format!(
                            "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = '{}' AND TYPE = 'T' ORDER BY TABNAME",
                            esc_schema
                        ),
                        "views" => format!(
                            "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = '{}' AND TYPE = 'V' ORDER BY TABNAME",
                            esc_schema
                        ),
                        "functions" => format!(
                            "SELECT FUNCNAME FROM SYSCAT.FUNCTIONS WHERE FUNCSCHEMA = '{}' ORDER BY FUNCNAME",
                            esc_schema
                        ),
                        "procedures" => format!(
                            "SELECT PROCNAME FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = '{}' ORDER BY PROCNAME",
                            esc_schema
                        ),
                        "triggers" => format!(
                            "SELECT TRIGNAME FROM SYSCAT.TRIGGERS WHERE TRIGSCHEMA = '{}' ORDER BY TRIGNAME",
                            esc_schema
                        ),
                        "materialized_views" => format!(
                            "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = '{}' AND TYPE = 'S' ORDER BY TABNAME",
                            esc_schema
                        ),
                        _ => return Ok(vec![]),
                    };
                    fetch_string_list_with_conn(conn, &sql)
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    async fn list_tables_with_stats(
        &self,
        _database: &str,
        schema: Option<&str>,
    ) -> AppResult<Vec<TableStatInfo>> {
        #[cfg(not(feature = "db2-driver"))]
        {
            let _ = schema;
            return Ok(vec![]);
        }

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = schema.unwrap_or(&self.schema).to_string();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    let sql = format!(
                        "SELECT TABNAME, CARD, NPAGES * PAGESIZE AS SIZE_BYTES \
                         FROM SYSCAT.TABLES WHERE TABSCHEMA = '{}' AND TYPE = 'T' \
                         ORDER BY TABNAME",
                        escape_sql_string(&schema)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;
                    Ok(result.rows.into_iter().map(|row| {
                        let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        // CARD = cardinality (row count estimate), -1 means unknown
                        let row_count = row.get(1).and_then(|v| {
                            v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
                        }).filter(|&n| n >= 0);
                        let size_bytes = row.get(2).and_then(|v| {
                            v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
                        }).filter(|&n| n >= 0);
                        let size = size_bytes.map(format_size);
                        TableStatInfo { name, row_count, size }
                    }).collect())
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: true,
            has_foreign_keys: true,
            has_stored_procedures: true,
            has_triggers: true,
            has_materialized_views: true, // DB2 MQT (Materialized Query Tables)
            has_multi_database: true,
            has_partitions: true,
            sql_dialect: SqlDialect::Standard,
            supported_auth_types: vec!["password".to_string(), "os_native".to_string()],
            has_pool_config: false,
            has_timeout_config: true,
            has_ssl_config: false,
        }
    }

    async fn get_db_stats(&self, _database: Option<&str>) -> AppResult<DbStats> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(DbStats {
            tables: vec![],
            db_summary: DbSummary {
                total_tables: 0,
                total_size_bytes: None,
                db_version: None,
            },
        });

        #[cfg(feature = "db2-driver")]
        {
            let conn_str = self.conn_str.clone();
            let conn_mutex = self.conn.clone();
            let schema = self.schema.clone();
            tokio::task::spawn_blocking(move || {
                with_connection_impl(&conn_str, &conn_mutex, |conn| {
                    // Query table stats from SYSCAT.TABLES
                    let sql = format!(
                        "SELECT TABNAME, CARD, NPAGES * PAGESIZE AS SIZE_BYTES \
                         FROM SYSCAT.TABLES WHERE TABSCHEMA = '{}' AND TYPE = 'T' \
                         ORDER BY TABNAME",
                        escape_sql_string(&schema)
                    );
                    let result = execute_query_with_conn(conn, &sql)?;

                    let mut total_bytes: i64 = 0;
                    let tables: Vec<TableStat> = result.rows.into_iter().map(|row| {
                        let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let row_count = row.get(1).and_then(|v| {
                            v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
                        }).filter(|&n| n >= 0);
                        let size_bytes = row.get(2).and_then(|v| {
                            v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
                        }).filter(|&n| n >= 0);
                        if let Some(b) = size_bytes {
                            total_bytes += b;
                        }
                        TableStat {
                            name,
                            row_count,
                            data_size_bytes: size_bytes,
                            index_size_bytes: None,
                        }
                    }).collect();

                    let total_tables = tables.len();

                    // Get DB2 version (use same connection — no extra connect overhead)
                    let ver_result = execute_query_with_conn(
                        conn,
                        "SELECT SERVICE_LEVEL FROM SYSIBMADM.ENV_INST_INFO",
                    );
                    let db_version = ver_result.ok().and_then(|r| {
                        r.rows.into_iter().next().and_then(|row| {
                            row.into_iter().next().and_then(|v| {
                                if v.is_null() { None } else { v.as_str().map(String::from) }
                            })
                        })
                    });

                    Ok(DbStats {
                        tables,
                        db_summary: DbSummary {
                            total_tables,
                            total_size_bytes: Some(total_bytes),
                            db_version,
                        },
                    })
                })
            })
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
        }
    }
}
