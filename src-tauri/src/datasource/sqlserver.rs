use async_trait::async_trait;
use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, RoutineType, SchemaInfo,
    SqlDialect, TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};
use tiberius::{AuthMethod, Client, Config, Row};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

pub struct SqlServerDataSource {
    config: tiberius::Config,
}

impl SqlServerDataSource {
    pub async fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let host = cfg.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        let port = cfg.port
            .ok_or_else(|| AppError::Datasource("Missing port".into()))?;
        let username = cfg.username.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing username".into()))?;
        let password = cfg.password.as_deref().unwrap_or("");
        let mut config = Config::new();
        config.host(host);
        config.port(port);
        if let Some(db) = cfg.database.as_deref().filter(|s| !s.is_empty()) {
            config.database(db);
        }
        config.authentication(AuthMethod::sql_server(username, password));
        config.trust_cert(); // MVP 阶段跳过证书验证
        Ok(Self { config })
    }

    async fn connect(&self) -> AppResult<Client<tokio_util::compat::Compat<TcpStream>>> {
        let tcp = TcpStream::connect(self.config.get_addr())
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        tcp.set_nodelay(true)
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        Client::connect(self.config.clone(), tcp.compat_write())
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))
    }

    /// 带参数查询，返回第一个结果集的所有行。
    async fn fetch_rows(&self, sql: &str, params: &[&dyn tiberius::ToSql]) -> AppResult<Vec<Row>> {
        let mut client = self.connect().await?;
        let stream = client.query(sql, params)
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        let results = stream.into_results()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;
        Ok(results.into_iter().next().unwrap_or_default())
    }
}

// ─── Row 辅助函数 ─────────────────────────────────────────────────────────────

fn row_str(row: &Row, idx: usize) -> String {
    row.try_get::<&str, _>(idx)
        .ok()
        .flatten()
        .map(String::from)
        .unwrap_or_default()
}

fn row_opt_str(row: &Row, idx: usize) -> Option<String> {
    row.try_get::<&str, _>(idx)
        .ok()
        .flatten()
        .map(String::from)
}

fn row_bool(row: &Row, idx: usize) -> bool {
    row.try_get::<bool, _>(idx).ok().flatten().unwrap_or(false)
}

fn row_i32(row: &Row, idx: usize) -> i32 {
    row.try_get::<i32, _>(idx).ok().flatten().unwrap_or(0)
}

fn row_i64(row: &Row, idx: usize) -> i64 {
    row.try_get::<i64, _>(idx).ok().flatten().unwrap_or(0)
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

// ─── DataSource 实现 ──────────────────────────────────────────────────────────

#[async_trait]
impl DataSource for SqlServerDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        self.connect().await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let mut client = self.connect().await?;
        let start = std::time::Instant::now();

        let stream = client.query(sql, &[])
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let rows = stream.into_results()
            .await
            .map_err(|e| AppError::Datasource(e.to_string()))?;

        let duration_ms = start.elapsed().as_millis() as u64;

        if rows.is_empty() {
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0, duration_ms });
        }

        let first_set = &rows[0];
        let columns: Vec<String> = if let Some(first_row) = first_set.first() {
            first_row.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = first_set.iter().map(|row| {
            (0..columns.len()).map(|i| {
                if let Ok(Some(val)) = row.try_get::<&str, _>(i) {
                    serde_json::Value::String(val.to_string())
                } else if let Ok(Some(val)) = row.try_get::<i64, _>(i) {
                    serde_json::json!(val)
                } else if let Ok(Some(val)) = row.try_get::<i32, _>(i) {
                    serde_json::json!(val)
                } else if let Ok(Some(val)) = row.try_get::<f64, _>(i) {
                    serde_json::json!(val)
                } else if let Ok(Some(val)) = row.try_get::<f32, _>(i) {
                    serde_json::json!(val)
                } else if let Ok(Some(val)) = row.try_get::<bool, _>(i) {
                    serde_json::json!(val)
                } else {
                    serde_json::Value::Null
                }
            }).collect()
        }).collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let result = self.execute(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME"
        ).await?;

        Ok(result.rows.into_iter().map(|row| TableMeta {
            schema: row.first().and_then(|v| v.as_str().map(String::from)),
            name: row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            table_type: row.get(2).and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }

    async fn get_columns(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        let schema = schema.unwrap_or("dbo");
        let sql = "SELECT \
                       c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
                       ISNULL(( \
                           SELECT TOP 1 1 \
                           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
                               ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
                               AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
                           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
                             AND tc.TABLE_NAME  = c.TABLE_NAME \
                             AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA \
                             AND kcu.COLUMN_NAME = c.COLUMN_NAME \
                       ), 0) AS IS_PK, \
                       COLUMNPROPERTY( \
                           OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), \
                           c.COLUMN_NAME, 'IsIdentity' \
                       ) AS IS_IDENTITY \
                   FROM INFORMATION_SCHEMA.COLUMNS c \
                   WHERE c.TABLE_NAME = @P1 AND c.TABLE_SCHEMA = @P2 \
                   ORDER BY c.ORDINAL_POSITION";
        let rows = self.fetch_rows(sql, &[&table, &schema]).await?;
        Ok(rows.iter().map(|r| ColumnMeta {
            name: row_str(r, 0),
            data_type: row_str(r, 1),
            is_nullable: row_str(r, 2) == "YES",
            column_default: row_opt_str(r, 3),
            is_primary_key: row_i32(r, 4) == 1,
            extra: if row_i32(r, 5) == 1 { Some("identity".to_string()) } else { None },
            comment: None,
        }).collect())
    }

    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        let schema = schema.unwrap_or("dbo");
        let sql = "SELECT i.name, i.is_unique, c.name AS col_name \
                   FROM sys.indexes i \
                   JOIN sys.index_columns ic \
                       ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                   JOIN sys.columns c \
                       ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
                   JOIN sys.objects o ON i.object_id = o.object_id \
                   JOIN sys.schemas s ON o.schema_id = s.schema_id \
                   WHERE o.name = @P1 AND s.name = @P2 \
                     AND i.type > 0 AND i.is_disabled = 0 \
                   ORDER BY i.name, ic.key_ordinal";
        let rows = self.fetch_rows(sql, &[&table, &schema]).await?;
        let mut map: std::collections::BTreeMap<String, IndexMeta> = Default::default();
        for r in &rows {
            let idx_name = row_str(r, 0);
            let is_unique = row_bool(r, 1);
            let col = row_str(r, 2);
            map.entry(idx_name.clone()).or_insert_with(|| IndexMeta {
                index_name: idx_name,
                is_unique,
                columns: vec![],
            }).columns.push(col);
        }
        Ok(map.into_values().collect())
    }

    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        let schema = schema.unwrap_or("dbo");
        let sql = "SELECT \
                       fk.name, \
                       COL_NAME(fkc.parent_object_id, fkc.parent_column_id), \
                       OBJECT_NAME(fkc.referenced_object_id), \
                       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id), \
                       CASE fk.delete_referential_action \
                           WHEN 1 THEN 'CASCADE' \
                           WHEN 2 THEN 'SET NULL' \
                           WHEN 3 THEN 'SET DEFAULT' \
                           ELSE 'NO ACTION' \
                       END \
                   FROM sys.foreign_keys fk \
                   JOIN sys.foreign_key_columns fkc \
                       ON fk.object_id = fkc.constraint_object_id \
                   JOIN sys.objects o ON fk.parent_object_id = o.object_id \
                   JOIN sys.schemas s ON o.schema_id = s.schema_id \
                   WHERE o.name = @P1 AND s.name = @P2";
        let rows = self.fetch_rows(sql, &[&table, &schema]).await?;
        Ok(rows.iter().map(|r| ForeignKeyMeta {
            constraint_name: row_str(r, 0),
            column: row_str(r, 1),
            referenced_table: row_str(r, 2),
            referenced_column: row_str(r, 3),
            on_delete: Some(row_str(r, 4)),
        }).collect())
    }

    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        let rows = self.fetch_rows(
            "SELECT TABLE_NAME, VIEW_DEFINITION \
             FROM INFORMATION_SCHEMA.VIEWS \
             ORDER BY TABLE_NAME",
            &[],
        ).await?;
        Ok(rows.iter().map(|r| ViewMeta {
            name: row_str(r, 0),
            definition: row_opt_str(r, 1),
        }).collect())
    }

    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        let rows = self.fetch_rows(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE \
             FROM INFORMATION_SCHEMA.ROUTINES \
             WHERE ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION') \
             ORDER BY ROUTINE_NAME",
            &[],
        ).await?;
        Ok(rows.iter().map(|r| {
            let rt = row_str(r, 1);
            ProcedureMeta {
                name: row_str(r, 0),
                routine_type: match rt.as_str() {
                    "PROCEDURE" => RoutineType::Procedure,
                    "FUNCTION"  => RoutineType::Function,
                    _           => RoutineType::Unknown,
                },
            }
        }).collect())
    }

    async fn get_table_ddl(&self, table: &str) -> AppResult<String> {
        self.get_table_ddl_with_schema(table, None).await
    }

    /// SQL Server 无 SHOW CREATE TABLE，基于 INFORMATION_SCHEMA.COLUMNS 手工拼接 DDL。
    async fn get_table_ddl_with_schema(&self, table: &str, schema: Option<&str>) -> AppResult<String> {
        let schema = schema.unwrap_or("dbo");
        let sql = "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT \
                   FROM INFORMATION_SCHEMA.COLUMNS c \
                   WHERE c.TABLE_NAME = @P1 AND c.TABLE_SCHEMA = @P2 \
                   ORDER BY c.ORDINAL_POSITION";
        let rows = self.fetch_rows(sql, &[&table, &schema]).await?;
        if rows.is_empty() {
            return Ok(format!("-- Table '[{}].[{}]' not found", schema, table));
        }
        let col_defs: Vec<String> = rows.iter().map(|r| {
            let name = row_str(r, 0);
            let data_type = row_str(r, 1);
            let nullable = row_str(r, 2) == "YES";
            let default = row_opt_str(r, 3);
            let mut def = format!("    [{}] {}", name, data_type);
            if let Some(d) = default { def.push_str(&format!(" DEFAULT {}", d)); }
            if !nullable { def.push_str(" NOT NULL"); }
            def
        }).collect();
        Ok(format!("CREATE TABLE [{}].[{}] (\n{}\n)", schema, table, col_defs.join(",\n")))
    }

    /// database_id > 4 排除系统库（master / tempdb / model / msdb）
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let rows = self.fetch_rows(
            "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
            &[],
        ).await?;
        Ok(rows.iter().map(|r| row_str(r, 0)).collect())
    }

    // list_schemas / list_objects 暂缓：需配套前端 Schema 层级实现后再处理。

    async fn list_tables_with_stats(&self, database: &str, schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        let schema = schema.unwrap_or("dbo");
        // 切换数据库上下文
        let use_db = if !database.is_empty() {
            format!("USE [{}]; ", database)
        } else {
            String::new()
        };
        let sql = format!(
            "{}SELECT t.name, \
                    SUM(ps.row_count), \
                    SUM(ps.reserved_page_count) * 8192 \
             FROM sys.tables t \
             JOIN sys.schemas s ON t.schema_id = s.schema_id \
             JOIN sys.dm_db_partition_stats ps \
                 ON t.object_id = ps.object_id AND ps.index_id <= 1 \
             WHERE s.name = @P1 AND t.is_ms_shipped = 0 \
             GROUP BY t.name \
             ORDER BY t.name",
            use_db
        );
        let rows = self.fetch_rows(&sql, &[&schema]).await?;
        Ok(rows.iter().map(|r| {
            let row_count: Option<i64> = r.try_get(1).ok().flatten();
            let bytes: Option<i64> = r.try_get(2).ok().flatten();
            let size = bytes.map(format_size);
            TableStatInfo { name: row_str(r, 0), row_count, size }
        }).collect())
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            has_schemas: false, // list_schemas/list_objects deferred，暂不开启
            has_foreign_keys: true,
            has_stored_procedures: true,
            has_triggers: true,
            has_materialized_views: false,
            has_multi_database: true,
            has_partitions: true,
            sql_dialect: SqlDialect::Standard,
        }
    }

    async fn get_db_stats(&self, _database: Option<&str>) -> AppResult<DbStats> {
        // sys.dm_db_partition_stats 作用于当前连接的数据库上下文
        let rows = self.fetch_rows(
            "SELECT \
                 OBJECT_NAME(ps.object_id), \
                 CAST(SUM(ps.row_count) AS BIGINT), \
                 CAST(SUM(ps.reserved_page_count) * 8192 AS BIGINT) \
             FROM sys.dm_db_partition_stats ps \
             JOIN sys.objects o ON ps.object_id = o.object_id \
             WHERE o.type = 'U' AND ps.index_id <= 1 \
             GROUP BY ps.object_id \
             ORDER BY SUM(ps.reserved_page_count) DESC",
            &[],
        ).await?;

        let mut total_bytes: i64 = 0;
        let tables: Vec<TableStat> = rows.iter().map(|r| {
            let row_count = row_i64(r, 1);
            let bytes = row_i64(r, 2);
            total_bytes += bytes;
            TableStat {
                name: row_str(r, 0),
                row_count: Some(row_count),
                data_size_bytes: Some(bytes),
                index_size_bytes: None,
            }
        }).collect();

        let ver_rows = self.fetch_rows("SELECT @@VERSION", &[]).await.unwrap_or_default();
        let db_version = ver_rows.first().map(|r| row_str(r, 0));

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
