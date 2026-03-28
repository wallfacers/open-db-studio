use async_trait::async_trait;
#[cfg(feature = "db2-driver")]
use std::sync::Arc;

#[allow(unused_imports)]
use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

/// Escape special characters in ODBC connection string values.
/// Values containing `;`, `{`, `}`, or `=` are wrapped in `{...}` with `}` escaped as `}}`.
#[allow(dead_code)]
fn escape_odbc_value(s: &str) -> String {
    if s.contains(';') || s.contains('{') || s.contains('}') || s.contains('=') {
        format!("{{{}}}", s.replace('}', "}}"))
    } else {
        s.to_string()
    }
}

// ─── Global ODBC Environment (process lifetime, shared by all DB2 connections) ──

#[cfg(feature = "db2-driver")]
static ODBC_ENV: once_cell::sync::Lazy<odbc_api::Environment> =
    once_cell::sync::Lazy::new(|| {
        odbc_api::Environment::new().expect("Failed to initialize ODBC environment")
    });

pub struct Db2DataSource {
    #[cfg(feature = "db2-driver")]
    conn_str: Arc<str>,
    #[cfg(feature = "db2-driver")]
    schema: Arc<str>,
    #[cfg(feature = "db2-driver")]
    conn: Arc<std::sync::Mutex<Option<odbc_api::Connection<'static>>>>,
}

impl Db2DataSource {
    #[allow(unused_variables)]
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        #[cfg(feature = "db2-driver")]
        let host = config.host.as_deref().unwrap_or("localhost");
        #[cfg(feature = "db2-driver")]
        let port = config.port.unwrap_or(50000);
        #[cfg(feature = "db2-driver")]
        let database = config.database.as_deref().unwrap_or("");
        #[cfg(feature = "db2-driver")]
        let username = config.username.as_deref().unwrap_or("");
        #[cfg(feature = "db2-driver")]
        let password = config.password.as_deref().unwrap_or("");

        #[cfg(feature = "db2-driver")]
        let schema: Arc<str> = username.to_uppercase().into();

        #[cfg(feature = "db2-driver")]
        let conn_str: Arc<str> = format!(
            "Driver={{IBM DB2 ODBC DRIVER}};Database={};Hostname={};Port={};Protocol=TCPIP;Uid={};Pwd={};",
            escape_odbc_value(database), escape_odbc_value(host), port,
            escape_odbc_value(username), escape_odbc_value(password)
        ).into();

        Ok(Self {
            #[cfg(feature = "db2-driver")]
            conn_str,
            #[cfg(feature = "db2-driver")]
            schema,
            #[cfg(feature = "db2-driver")]
            conn: Arc::new(std::sync::Mutex::new(None)),
        })
    }
}

// ─── Helper functions ────────────────────────────────────────────────────────

#[allow(unused_imports)]
use super::utils::format_size;

/// Use persistent connection to execute operations. Establishes on first call,
/// reconnects only on connection-level errors (ODBC SQLSTATE 08xxx).
///
/// Serializes all access via Mutex (ODBC Connection is not thread-safe).
#[cfg(feature = "db2-driver")]
fn with_connection<F, T>(
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

    if guard.is_none() {
        let c = ODBC_ENV
            .connect_with_connection_string(conn_str, ConnectionOptions::default())
            .map_err(|e| AppError::Datasource(format!("DB2 connection failed: {}", e)))?;
        *guard = Some(c);
        log::debug!("DB2 persistent connection established");
    }

    let conn = guard.as_ref().unwrap();
    match f(conn) {
        Ok(result) => Ok(result),
        Err(e) => {
            let error_msg = e.to_string();
            let is_connection_error = error_msg.contains("08S01")
                || error_msg.contains("08003")
                || error_msg.contains("08007")
                || error_msg.contains("Communication link failure")
                || error_msg.contains("connection")
                    && error_msg.to_lowercase().contains("lost");

            if !is_connection_error {
                return Err(e);
            }

            log::warn!("DB2 connection error, attempting reconnection: {}", error_msg);
            *guard = None;

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

#[cfg(feature = "db2-driver")]
impl Db2DataSource {
    /// Run a blocking closure with the persistent ODBC connection.
    /// Handles Arc cloning, spawn_blocking, and JoinError mapping.
    async fn run_blocking<F, T>(&self, f: F) -> AppResult<T>
    where
        F: Fn(&odbc_api::Connection<'static>) -> AppResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn_str = self.conn_str.clone();
        let conn_mutex = self.conn.clone();
        tokio::task::spawn_blocking(move || with_connection(&conn_str, &conn_mutex, f))
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?
    }
}

/// Execute a SQL query with parameterized bindings and return a QueryResult.
#[cfg(feature = "db2-driver")]
fn execute_query<P: odbc_api::ParameterCollectionRef>(
    conn: &odbc_api::Connection<'static>,
    sql: &str,
    params: P,
) -> AppResult<QueryResult> {
    use std::time::Instant;
    use odbc_api::{buffers::TextRowSet, Cursor, ResultSetMetadata};

    let start = Instant::now();

    let cursor_opt = conn
        .execute(sql, params, None)
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
        // 64KB per column to avoid truncating view DDL / CLOB values
        let buffer = TextRowSet::for_cursor(batch_size, &mut cursor, Some(65536))
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
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms,
        })
    }
}

/// Fetch a single column of strings from a parameterized query.
#[cfg(feature = "db2-driver")]
fn fetch_string_list<P: odbc_api::ParameterCollectionRef>(
    conn: &odbc_api::Connection<'static>,
    sql: &str,
    params: P,
) -> AppResult<Vec<String>> {
    let result = execute_query(conn, sql, params)?;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().and_then(|v| v.as_str().map(String::from)))
        .collect())
}

/// Parse table stats from a query result row.
/// Returns (name, row_count, size_bytes). Shared by `list_tables_with_stats` and `get_db_stats`.
#[cfg(feature = "db2-driver")]
fn parse_table_stats_row(row: &[serde_json::Value]) -> (String, Option<i64>, Option<i64>) {
    let name = row.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
    let row_count = row.get(1).and_then(|v| {
        v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
    }).filter(|&n| n >= 0);
    let size_bytes = row.get(2).and_then(|v| {
        v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
    }).filter(|&n| n >= 0);
    (name, row_count, size_bytes)
}

#[cfg(feature = "db2-driver")]
const TABLE_STATS_SQL: &str = "SELECT TABNAME, CARD, NPAGES * PAGESIZE AS SIZE_BYTES \
    FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE = 'T' ORDER BY TABNAME";

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
                // Clear cached connection to force fresh connectivity test
                {
                    let mut guard = conn_mutex.lock().map_err(|e| {
                        AppError::Datasource(format!("Mutex poisoned: {}", e))
                    })?;
                    *guard = None;
                }
                with_connection(&conn_str, &conn_mutex, |conn| {
                    execute_query(conn, "SELECT 1 FROM SYSIBM.SYSDUMMY1", ()).map(|_| ())
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
            let sql = sql.to_string();
            self.run_blocking(move |conn| execute_query(conn, &sql, ())).await
        }
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            use odbc_api::IntoParameter;
            let schema = self.schema.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT TABSCHEMA, TABNAME, TYPE FROM SYSCAT.TABLES \
                     WHERE TABSCHEMA = ? AND TYPE IN ('T', 'V') ORDER BY TABNAME",
                    &schema_param,
                )?;
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
            }).await
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
            use odbc_api::IntoParameter;
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let table_param = table.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT COLNAME, TYPENAME, NULLS, DEFAULT, KEYSEQ, REMARKS \
                     FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO",
                    (&schema_param, &table_param),
                )?;
                Ok(result.rows.into_iter().map(|row| {
                    let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let data_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let is_nullable = row.get(2).and_then(|v| v.as_str()).unwrap_or("N") == "Y";
                    let column_default = row.get(3).and_then(|v| {
                        if v.is_null() { None } else { v.as_str().map(String::from) }
                    });
                    let is_primary_key = row.get(4).and_then(|v| {
                        v.as_str().and_then(|s| s.trim().parse::<i32>().ok())
                    }).unwrap_or(0) > 0;
                    let comment = row.get(5).and_then(|v| {
                        if v.is_null() { None } else { v.as_str().map(String::from) }
                    });
                    ColumnMeta {
                        name, data_type, is_nullable, column_default,
                        is_primary_key, extra: None, comment,
                    }
                }).collect())
            }).await
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
            use odbc_api::IntoParameter;
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let table_param = table.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT INDNAME, UNIQUERULE, COLNAMES FROM SYSCAT.INDEXES \
                     WHERE TABSCHEMA = ? AND TABNAME = ?",
                    (&schema_param, &table_param),
                )?;
                Ok(result.rows.into_iter().map(|row| {
                    let index_name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let unique_rule = row.get(1).and_then(|v| v.as_str()).unwrap_or("D");
                    // UNIQUERULE: 'U' = unique, 'P' = primary key, 'D' = non-unique
                    let is_unique = matches!(unique_rule, "U" | "P");
                    // COLNAMES format: "+COL1+COL2-COL3" (+ = ASC, - = DESC)
                    let colnames_raw = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
                    let columns: Vec<String> = colnames_raw
                        .split(|c| c == '+' || c == '-')
                        .filter(|s| !s.is_empty())
                        .map(|s| s.trim().to_string())
                        .collect();
                    IndexMeta { index_name, is_unique, columns }
                }).collect())
            }).await
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
            use odbc_api::IntoParameter;
            let schema = schema.unwrap_or(&self.schema).to_string();
            let table = table.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let table_param = table.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT R.CONSTNAME, FK.COLNAME, R.REFTABNAME, PK.COLNAME AS REFCOLNAME, R.DELETERULE \
                     FROM SYSCAT.REFERENCES R \
                     JOIN SYSCAT.KEYCOLUSE FK ON FK.CONSTNAME = R.CONSTNAME AND FK.TABSCHEMA = R.TABSCHEMA \
                     JOIN SYSCAT.KEYCOLUSE PK ON PK.CONSTNAME = R.REFKEYNAME AND PK.TABSCHEMA = R.REFTABSCHEMA \
                     WHERE R.TABSCHEMA = ? AND R.TABNAME = ? AND FK.COLSEQ = PK.COLSEQ",
                    (&schema_param, &table_param),
                )?;
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
            }).await
        }
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            use odbc_api::IntoParameter;
            let schema = self.schema.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT VIEWNAME, TEXT FROM SYSCAT.VIEWS WHERE VIEWSCHEMA = ? ORDER BY VIEWNAME",
                    &schema_param,
                )?;
                Ok(result.rows.into_iter().map(|row| {
                    let name = row.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let definition = row.get(1).and_then(|v| {
                        if v.is_null() { None } else { v.as_str().map(String::from) }
                    });
                    ViewMeta { name, definition }
                }).collect())
            }).await
        }
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            use odbc_api::IntoParameter;
            let schema = self.schema.to_string();
            self.run_blocking(move |conn| {
                let p1 = schema.as_str().into_parameter();
                let p2 = schema.as_str().into_parameter();
                let result = execute_query(
                    conn,
                    "SELECT PROCNAME, 'PROCEDURE' AS TYPE FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = ? \
                     UNION ALL \
                     SELECT FUNCNAME, 'FUNCTION' AS TYPE FROM SYSCAT.FUNCTIONS WHERE FUNCSCHEMA = ? \
                     ORDER BY 1",
                    (&p1, &p2),
                )?;
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
            }).await
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
                return Ok(format!("-- Table \"{}\".\"{}\" not found", effective_schema, table));
            }

            let pk_cols: Vec<String> = columns
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
                effective_schema, table, parts.join(",\n")
            ))
        }
    }

    /// DB2 schemas serve as the "database" concept for tree navigation.
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        #[cfg(not(feature = "db2-driver"))]
        return Ok(vec![]);

        #[cfg(feature = "db2-driver")]
        {
            self.run_blocking(|conn| {
                fetch_string_list(
                    conn,
                    "SELECT SCHEMANAME FROM SYSCAT.SCHEMATA WHERE OWNERTYPE = 'U' ORDER BY SCHEMANAME",
                    (),
                )
            }).await
        }
    }

    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        self.list_databases().await
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
            use odbc_api::IntoParameter;
            let schema = schema.unwrap_or(&self.schema).to_string();
            let category = category.to_string();
            self.run_blocking(move |conn| {
                let sql = match category.as_str() {
                    "tables" => "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE = 'T' ORDER BY TABNAME",
                    "views" => "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE = 'V' ORDER BY TABNAME",
                    "functions" => "SELECT FUNCNAME FROM SYSCAT.FUNCTIONS WHERE FUNCSCHEMA = ? ORDER BY FUNCNAME",
                    "procedures" => "SELECT PROCNAME FROM SYSCAT.PROCEDURES WHERE PROCSCHEMA = ? ORDER BY PROCNAME",
                    "triggers" => "SELECT TRIGNAME FROM SYSCAT.TRIGGERS WHERE TRIGSCHEMA = ? ORDER BY TRIGNAME",
                    "materialized_views" => "SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE = 'S' ORDER BY TABNAME",
                    _ => return Ok(vec![]),
                };
                let schema_param = schema.as_str().into_parameter();
                fetch_string_list(conn, sql, &schema_param)
            }).await
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
            use odbc_api::IntoParameter;
            let schema = schema.unwrap_or(&self.schema).to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let result = execute_query(conn, TABLE_STATS_SQL, &schema_param)?;
                Ok(result.rows.iter().map(|row| {
                    let (name, row_count, size_bytes) = parse_table_stats_row(row);
                    TableStatInfo { name, row_count, size: size_bytes.map(format_size) }
                }).collect())
            }).await
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
            use odbc_api::IntoParameter;
            let schema = self.schema.to_string();
            self.run_blocking(move |conn| {
                let schema_param = schema.as_str().into_parameter();
                let result = execute_query(conn, TABLE_STATS_SQL, &schema_param)?;

                let mut total_bytes: i64 = 0;
                let tables: Vec<TableStat> = result.rows.iter().map(|row| {
                    let (name, row_count, size_bytes) = parse_table_stats_row(row);
                    if let Some(b) = size_bytes {
                        total_bytes += b;
                    }
                    TableStat {
                        name, row_count,
                        data_size_bytes: size_bytes,
                        index_size_bytes: None,
                    }
                }).collect();

                let total_tables = tables.len();

                let ver_result = execute_query(
                    conn,
                    "SELECT SERVICE_LEVEL FROM SYSIBMADM.ENV_INST_INFO",
                    (),
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
            }).await
        }
    }
}
