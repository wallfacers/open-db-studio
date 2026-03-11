use async_trait::async_trait;
use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::{AppError, AppResult};
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

pub struct SqlServerDataSource {
    config: tiberius::Config,
}

impl SqlServerDataSource {
    pub async fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let mut config = Config::new();
        config.host(&cfg.host);
        config.port(cfg.port);
        config.database(&cfg.database);
        config.authentication(AuthMethod::sql_server(&cfg.username, &cfg.password));
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
}

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
                // tiberius try_get returns Result<Option<R>> where R is the target type
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
}
