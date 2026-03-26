use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;
use std::time::Instant;
use reqwest;

use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

pub struct ClickHouseDataSource {
    client: Client,
    database: String,
    /// HTTP 基础 URL（用于 execute() 的 raw JSON 查询）
    http_url: String,
    http_user: Option<String>,
    http_password: Option<String>,
}

impl ClickHouseDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let host = config.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        let port = config.port.unwrap_or(8123);
        let database = config.database.as_deref().unwrap_or("default").to_string();

        let url = format!("http://{}:{}", host, port);
        let mut client = Client::default().with_url(&url).with_database(&database);

        if let Some(user) = config.username.as_deref() {
            client = client.with_user(user);
        }
        if let Some(pw) = config.password.as_deref() {
            client = client.with_password(pw);
        }

        // 测试连通性
        client
            .query("SELECT 1")
            .fetch_one::<u8>()
            .await
            .map_err(|e| AppError::Datasource(format!("ClickHouse connection failed: {}", e)))?;

        Ok(Self {
            client,
            database,
            http_url: url,
            http_user: config.username.clone(),
            http_password: config.password.clone(),
        })
    }
}

// ─── 内部辅助结构（用于 clickhouse crate 的行反序列化）─────────────────────

#[derive(Deserialize, clickhouse::Row)]
struct StringRow {
    value: String,
}

#[derive(Deserialize, clickhouse::Row)]
struct TableRow {
    name: String,
    engine: String,
}

#[derive(Deserialize, clickhouse::Row)]
struct ColumnRow {
    name: String,
    #[serde(rename = "type")]
    col_type: String,
    is_in_primary_key: u8,
}

#[derive(Deserialize, clickhouse::Row)]
struct TableStatRow {
    name: String,
    total_rows: Option<u64>,
    total_bytes: Option<u64>,
}

// ─── DataSource 实现 ──────────────────────────────────────────────────────────

#[async_trait]
impl DataSource for ClickHouseDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        self.client
            .query("SELECT 1")
            .fetch_one::<u8>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        // ClickHouse HTTP 接口：附加 FORMAT JSONEachRow，用 reqwest 发送原始 JSON
        let start = Instant::now();
        let query_sql = format!("{} FORMAT JSONEachRow", sql);

        let mut req = reqwest::Client::new()
            .post(&self.http_url)
            .query(&[("database", self.database.as_str())])
            .body(query_sql);

        if let Some(user) = &self.http_user {
            req = req.header("X-ClickHouse-User", user);
        }
        if let Some(pw) = &self.http_password {
            req = req.header("X-ClickHouse-Key", pw);
        }

        let resp = req.send().await.map_err(|e| AppError::Datasource(e.to_string()))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| AppError::Datasource(e.to_string()))?;
        let duration_ms = start.elapsed().as_millis() as u64;

        if !status.is_success() {
            return Err(AppError::Datasource(body));
        }

        // JSONEachRow 每行一个 JSON 对象（换行分隔）
        let mut columns: Vec<String> = vec![];
        let mut rows: Vec<Vec<serde_json::Value>> = vec![];
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let obj: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(line).map_err(|e| AppError::Datasource(e.to_string()))?;
            if columns.is_empty() {
                columns = obj.keys().cloned().collect();
            }
            let row: Vec<serde_json::Value> = columns
                .iter()
                .map(|k| {
                    let v = obj.get(k).cloned().unwrap_or(serde_json::Value::Null);
                    // 将可能超出 JS 安全整数范围的整数转为字符串（JS 精度上限 2^53 - 1）
                    if let serde_json::Value::Number(ref n) = v {
                        let s = n.to_string();
                        if !s.contains('.') && !s.contains('e') && !s.contains('E') {
                            const MAX_SAFE: i64 = 9_007_199_254_740_991;
                            let out_of_range = s.strip_prefix('-')
                                .map(|abs| abs.parse::<i64>().map_or(true, |i| i > MAX_SAFE))
                                .unwrap_or_else(|| s.parse::<i64>().map_or(true, |i| i > MAX_SAFE));
                            if out_of_range {
                                return serde_json::Value::String(s);
                            }
                        }
                    }
                    v
                })
                .collect();
            rows.push(row);
        }

        let row_count = rows.len();
        Ok(QueryResult { columns, rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows = self
            .client
            .query("SELECT name, engine FROM system.tables WHERE database = ? ORDER BY name")
            .bind(self.database.as_str())
            .fetch_all::<TableRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| TableMeta {
                schema: None,
                name: r.name,
                table_type: if r.engine.contains("View") { "VIEW".to_string() } else { "TABLE".to_string() },
            })
            .collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let rows = self
            .client
            .query(
                "SELECT name, type, is_in_primary_key \
                 FROM system.columns \
                 WHERE database = ? AND table = ? \
                 ORDER BY position",
            )
            .bind(self.database.as_str())
            .bind(table)
            .fetch_all::<ColumnRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let is_nullable = r.col_type.starts_with("Nullable(");
                let data_type = if is_nullable {
                    r.col_type
                        .trim_start_matches("Nullable(")
                        .trim_end_matches(')')
                        .to_string()
                } else {
                    r.col_type
                };
                ColumnMeta {
                    name: r.name,
                    data_type,
                    is_nullable,
                    column_default: None,
                    is_primary_key: r.is_in_primary_key != 0,
                    extra: None,
                    comment: None,
                }
            })
            .collect())
    }

    async fn get_indexes(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        // ClickHouse 没有传统二级索引，通过 system.tables 暴露主键和排序键
        #[derive(Deserialize, clickhouse::Row)]
        struct TableKeyRow {
            primary_key: String,
            sorting_key: String,
        }

        let rows = self
            .client
            .query("SELECT primary_key, sorting_key FROM system.tables WHERE database = ? AND name = ?")
            .bind(self.database.as_str())
            .bind(table)
            .fetch_all::<TableKeyRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let mut indexes = vec![];
        if let Some(r) = rows.into_iter().next() {
            if !r.primary_key.is_empty() {
                indexes.push(IndexMeta {
                    index_name: "PRIMARY_KEY".to_string(),
                    is_unique: true,
                    columns: r.primary_key.split(", ").map(String::from).collect(),
                });
            }
            // 仅当排序键与主键不同时才单独展示
            if !r.sorting_key.is_empty() && r.sorting_key != r.primary_key {
                indexes.push(IndexMeta {
                    index_name: "SORTING_KEY".to_string(),
                    is_unique: false,
                    columns: r.sorting_key.split(", ").map(String::from).collect(),
                });
            }
        }
        Ok(indexes)
    }

    async fn get_foreign_keys(&self, _table: &str, _schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        // ClickHouse 不支持外键
        Ok(vec![])
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let rows = self
            .client
            .query(
                "SELECT name FROM system.tables \
                 WHERE database = ? AND engine IN ('View','MaterializedView') \
                 ORDER BY name",
            )
            .bind(self.database.as_str())
            .fetch_all::<StringRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| ViewMeta { name: r.value, definition: None })
            .collect())
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        // ClickHouse 不支持存储过程
        Ok(vec![])
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        let sql = format!("SHOW CREATE TABLE `{}`.`{}`", self.database, table);
        let row = self
            .client
            .query(&sql)
            .fetch_one::<StringRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        Ok(row.value)
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let rows = self
            .client
            .query("SELECT name FROM system.databases ORDER BY name")
            .fetch_all::<StringRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        Ok(rows.into_iter().map(|r| r.value).collect())
    }

    async fn list_objects(&self, database: &str, _schema: Option<&str>, category: &str) -> AppResult<Vec<String>> {
        let names: Vec<String> = match category {
            "tables" => {
                let rows = self
                    .client
                    .query(
                        "SELECT name FROM system.tables \
                         WHERE database = ? AND engine NOT IN ('View','MaterializedView','Dictionary') \
                         ORDER BY name",
                    )
                    .bind(database)
                    .fetch_all::<StringRow>()
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.into_iter().map(|r| r.value).collect()
            }
            "views" => {
                let rows = self
                    .client
                    .query(
                        "SELECT name FROM system.tables \
                         WHERE database = ? AND engine IN ('View','MaterializedView') \
                         ORDER BY name",
                    )
                    .bind(database)
                    .fetch_all::<StringRow>()
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.into_iter().map(|r| r.value).collect()
            }
            "dictionaries" => {
                let rows = self
                    .client
                    .query(
                        "SELECT name FROM system.dictionaries WHERE database = ? ORDER BY name",
                    )
                    .bind(database)
                    .fetch_all::<StringRow>()
                    .await
                    .map_err(|e| AppError::Datasource(e.to_string()))?;
                rows.into_iter().map(|r| r.value).collect()
            }
            // ClickHouse 无触发器、存储过程、函数（用户自定义函数在 system.functions，暂不暴露）
            _ => vec![],
        };
        Ok(names)
    }

    async fn list_tables_with_stats(&self, database: &str, _schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        let rows = self
            .client
            .query(
                "SELECT name, total_rows, total_bytes \
                 FROM system.tables \
                 WHERE database = ? AND engine NOT IN ('View','MaterializedView','Dictionary') \
                 ORDER BY name",
            )
            .bind(database)
            .fetch_all::<TableStatRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let bytes = r.total_bytes.map(|b| b as i64);
                let size = bytes.map(format_size);
                TableStatInfo {
                    name: r.name,
                    row_count: r.total_rows.map(|v| v as i64),
                    size,
                }
            })
            .collect())
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: false,
            has_foreign_keys: false,
            has_stored_procedures: false,
            has_triggers: false,
            has_materialized_views: false, // ClickHouse 物化视图通过 views category 暴露
            has_multi_database: true,
            has_partitions: true,
            sql_dialect: SqlDialect::ClickHouse,
        }
    }

    async fn get_db_stats(&self, database: Option<&str>) -> AppResult<DbStats> {
        let db = database.unwrap_or(&self.database).to_string();

        let rows = self
            .client
            .query(
                "SELECT name, total_rows, total_bytes \
                 FROM system.tables \
                 WHERE database = ? AND engine NOT IN ('View','MaterializedView','Dictionary') \
                 ORDER BY total_bytes DESC",
            )
            .bind(db.as_str())
            .fetch_all::<TableStatRow>()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let mut total_bytes: i64 = 0;
        let tables: Vec<TableStat> = rows
            .into_iter()
            .map(|r| {
                let bytes = r.total_bytes.map(|b| b as i64).unwrap_or(0);
                total_bytes += bytes;
                TableStat {
                    name: r.name,
                    row_count: r.total_rows.map(|v| v as i64),
                    data_size_bytes: Some(bytes),
                    index_size_bytes: None,
                }
            })
            .collect();

        // ClickHouse 版本
        let db_version = self
            .client
            .query("SELECT version()")
            .fetch_one::<StringRow>()
            .await
            .ok()
            .map(|r| r.value);

        Ok(DbStats {
            db_summary: DbSummary {
                total_tables: tables.len(),
                total_size_bytes: Some(total_bytes),
                db_version,
            },
            tables,
        })
    }
}

fn format_size(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}
