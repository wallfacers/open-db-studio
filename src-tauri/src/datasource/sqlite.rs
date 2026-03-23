use async_trait::async_trait;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;
use std::time::Instant;

use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

pub struct SqliteDataSource {
    conn: Arc<Mutex<Connection>>,
    file_path: String,
}

impl SqliteDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let file_path = config
            .file_path
            .as_deref()
            .ok_or_else(|| AppError::Datasource("SQLite requires file_path".into()))?
            .to_string();

        let path = file_path.clone();
        let conn = tokio::task::spawn_blocking(move || -> AppResult<Connection> {
            let conn = Connection::open(&path)
                .map_err(|e| AppError::Datasource(format!("Cannot open SQLite file: {}", e)))?;
            // 开启 WAL 模式以支持并发读
            conn.execute_batch("PRAGMA journal_mode=WAL;")
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            Ok(conn)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))??;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            file_path,
        })
    }
}

#[async_trait]
impl DataSource for SqliteDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let guard = conn.blocking_lock();
            guard
                .execute_batch("SELECT 1")
                .map_err(|e| AppError::Datasource(e.to_string()))
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let conn = Arc::clone(&self.conn);
        let sql = sql.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<QueryResult> {
            let guard = conn.blocking_lock();
            let start = Instant::now();
            let mut stmt = guard
                .prepare(&sql)
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let col_count = stmt.column_count();
            let columns: Vec<String> = (0..col_count)
                .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
                .collect();

            let rows_result: Result<Vec<Vec<serde_json::Value>>, _> = stmt
                .query_map([], |row| {
                    let values: Vec<serde_json::Value> = (0..col_count)
                        .map(|i| sqlite_value_to_json(row, i))
                        .collect();
                    Ok(values)
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::Datasource(e.to_string()));

            let rows = rows_result?;
            let duration_ms = start.elapsed().as_millis() as u64;
            let row_count = rows.len();
            Ok(QueryResult { columns, rows, row_count, duration_ms })
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || -> AppResult<Vec<TableMeta>> {
            let guard = conn.blocking_lock();
            let mut stmt = guard
                .prepare(
                    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
                )
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let tables = stmt
                .query_map([], |row| {
                    let name: String = row.get(0)?;
                    let ttype: String = row.get(1)?;
                    Ok(TableMeta {
                        schema: None,
                        name,
                        table_type: ttype.to_uppercase(),
                    })
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(tables)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let conn = Arc::clone(&self.conn);
        let table = table.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<ColumnMeta>> {
            let guard = conn.blocking_lock();
            let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
            let mut stmt = guard
                .prepare(&sql)
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
            let cols = stmt
                .query_map([], |row| {
                    let name: String = row.get(1)?;
                    let data_type: String = row.get(2)?;
                    let notnull: i32 = row.get(3)?;
                    let default: Option<String> = row.get(4)?;
                    let pk: i32 = row.get(5)?;
                    Ok(ColumnMeta {
                        name,
                        data_type,
                        is_nullable: notnull == 0,
                        column_default: default,
                        is_primary_key: pk > 0,
                        extra: None,
                        comment: None,
                    })
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(cols)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_indexes(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        let conn = Arc::clone(&self.conn);
        let table = table.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<IndexMeta>> {
            let guard = conn.blocking_lock();
            // 先获取索引列表
            let index_sql = format!("PRAGMA index_list(\"{}\")", table.replace('"', "\"\""));
            let mut idx_stmt = guard
                .prepare(&index_sql)
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            // PRAGMA index_list: seq, name, unique, origin, partial
            let index_names: Vec<(String, bool)> = idx_stmt
                .query_map([], |row| {
                    let name: String = row.get(1)?;
                    let unique: i32 = row.get(2)?;
                    Ok((name, unique != 0))
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();

            let mut indexes = vec![];
            for (idx_name, is_unique) in index_names {
                let info_sql = format!("PRAGMA index_info(\"{}\")", idx_name.replace('"', "\"\""));
                if let Ok(mut info_stmt) = guard.prepare(&info_sql) {
                    // PRAGMA index_info: seqno, cid, name
                    let cols: Vec<String> = match info_stmt.query_map([], |row| row.get::<_, String>(2)) {
                        Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
                        Err(_) => vec![],
                    };
                    indexes.push(IndexMeta { index_name: idx_name, is_unique, columns: cols });
                }
            }
            Ok(indexes)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_foreign_keys(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        let conn = Arc::clone(&self.conn);
        let table = table.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<ForeignKeyMeta>> {
            let guard = conn.blocking_lock();
            let sql = format!("PRAGMA foreign_key_list(\"{}\")", table.replace('"', "\"\""));
            let mut stmt = guard
                .prepare(&sql)
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
            let fks = stmt
                .query_map([], |row| {
                    let id: i64 = row.get(0)?;
                    let from_col: String = row.get(3)?;
                    let to_table: String = row.get(2)?;
                    let to_col: String = row.get(4)?;
                    let on_delete: Option<String> = row.get(6)?;
                    Ok(ForeignKeyMeta {
                        constraint_name: format!("fk_{}", id),
                        column: from_col,
                        referenced_table: to_table,
                        referenced_column: to_col,
                        on_delete: on_delete.filter(|s| s != "NO ACTION"),
                    })
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(fks)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || -> AppResult<Vec<ViewMeta>> {
            let guard = conn.blocking_lock();
            let mut stmt = guard
                .prepare("SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name")
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let views = stmt
                .query_map([], |row| {
                    Ok(ViewMeta {
                        name: row.get(0)?,
                        definition: row.get(1)?,
                    })
                })
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(views)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        // SQLite 不支持存储过程
        Ok(vec![])
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        let conn = Arc::clone(&self.conn);
        let table = table.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<String> {
            let guard = conn.blocking_lock();
            let mut stmt = guard
                .prepare("SELECT sql FROM sqlite_master WHERE name = ?1")
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let ddl: Option<String> = stmt
                .query_row(rusqlite::params![table], |row| row.get(0))
                .ok();
            Ok(ddl.unwrap_or_default())
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    /// SQLite 无多数据库概念（单文件），返回空列表
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    async fn list_objects(&self, _database: &str, _schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
        let conn = Arc::clone(&self.conn);
        let category = category.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<String>> {
            let guard = conn.blocking_lock();
            let type_filter = match category.as_str() {
                "tables" => "table",
                "views" => "view",
                "triggers" => "trigger",
                _ => return Ok(vec![]),
            };
            let sql = "SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name";
            let mut stmt = guard
                .prepare(sql)
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let names: Vec<String> = stmt
                .query_map(rusqlite::params![type_filter], |row| row.get(0))
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(names)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    async fn list_tables_with_stats(&self, _database: &str, _schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || -> AppResult<Vec<TableStatInfo>> {
            let guard = conn.blocking_lock();
            // 获取所有表名
            let mut stmt = guard
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let table_names: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();

            let mut stats = vec![];
            for name in table_names {
                let row_count = count_rows_sqlite(&guard, &name);
                stats.push(TableStatInfo { name, row_count, size: None });
            }
            Ok(stats)
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: false,
            has_foreign_keys: true,
            has_stored_procedures: false,
            has_triggers: true,
            has_materialized_views: false,
            has_multi_database: false,
            has_partitions: false,
            sql_dialect: SqlDialect::Standard,
        }
    }

    async fn get_db_stats(&self, _database: Option<&str>) -> AppResult<DbStats> {
        let conn = Arc::clone(&self.conn);
        let file_path = self.file_path.clone();
        tokio::task::spawn_blocking(move || -> AppResult<DbStats> {
            let guard = conn.blocking_lock();

            // 磁盘大小：page_count * page_size
            let page_count: i64 = guard
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap_or(0);
            let page_size: i64 = guard
                .query_row("PRAGMA page_size", [], |r| r.get(0))
                .unwrap_or(4096);
            let total_bytes = page_count * page_size;

            // SQLite 版本
            let db_version: Option<String> = guard
                .query_row("SELECT sqlite_version()", [], |r| r.get(0))
                .ok();

            // 表列表
            let mut stmt = guard
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .map_err(|e| AppError::Datasource(e.to_string()))?;
            let table_names: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| AppError::Datasource(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();

            // 尝试从 sqlite_stat1 读取估算行数，最多对 20 张表执行 COUNT
            let stat1_available = guard
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'",
                    [],
                    |_| Ok(true),
                )
                .unwrap_or(false);

            let mut tables = vec![];
            let mut count_remaining = 20usize;
            for name in &table_names {
                let row_count = if stat1_available {
                    // 尝试从 sqlite_stat1 取估算值
                    let stat_val: Option<String> = guard
                        .query_row(
                            "SELECT stat FROM sqlite_stat1 WHERE tbl = ?1 AND idx IS NULL",
                            rusqlite::params![name],
                            |r| r.get(0),
                        )
                        .ok();
                    if let Some(s) = stat_val {
                        // stat 格式：row_count [index_stats...]，取第一个数字
                        s.split_whitespace()
                            .next()
                            .and_then(|v| v.parse::<i64>().ok())
                    } else if count_remaining > 0 {
                        count_remaining -= 1;
                        count_rows_sqlite(&guard, name)
                    } else {
                        None
                    }
                } else if count_remaining > 0 {
                    count_remaining -= 1;
                    count_rows_sqlite(&guard, name)
                } else {
                    None
                };

                tables.push(TableStat {
                    name: name.clone(),
                    row_count,
                    data_size_bytes: None,
                    index_size_bytes: None,
                });
            }

            let _ = file_path; // 路径已用于 open，此处仅保留以备将来使用

            Ok(DbStats {
                tables,
                db_summary: DbSummary {
                    total_tables: table_names.len(),
                    total_size_bytes: Some(total_bytes),
                    db_version,
                },
            })
        })
        .await
        .map_err(|e| AppError::Datasource(e.to_string()))?
    }
}

/// 对单张表执行 SELECT COUNT(*)，失败时返回 None
fn count_rows_sqlite(conn: &Connection, table: &str) -> Option<i64> {
    let sql = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
    conn.query_row(&sql, [], |r| r.get(0)).ok()
}

/// 将 rusqlite 行中指定列转换为 serde_json::Value
fn sqlite_value_to_json(row: &rusqlite::Row<'_>, idx: usize) -> serde_json::Value {
    use rusqlite::types::ValueRef;
    match row.get_ref(idx) {
        Ok(ValueRef::Null) => serde_json::Value::Null,
        Ok(ValueRef::Integer(i)) => serde_json::json!(i),
        Ok(ValueRef::Real(f)) => serde_json::json!(f),
        Ok(ValueRef::Text(s)) => {
            serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
        }
        Ok(ValueRef::Blob(b)) => {
            serde_json::Value::String(format!("0x{}", hex::encode(b)))
        }
        Err(_) => serde_json::Value::Null,
    }
}
