pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod sqlserver;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use crate::AppResult;

/// 查询结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub duration_ms: u64,
}

/// 表元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableMeta {
    pub schema: Option<String>,
    pub name: String,
    pub table_type: String,
}

/// 数据库 schema 信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SchemaInfo {
    pub tables: Vec<TableMeta>,
}

/// 连接配置（来自前端）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionConfig {
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub extra_params: Option<String>,
}

/// 数据源统一抽象 trait
#[async_trait]
pub trait DataSource: Send + Sync {
    async fn test_connection(&self) -> AppResult<()>;
    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>>;
    async fn get_schema(&self) -> AppResult<SchemaInfo>;
}

/// 根据配置创建对应数据源实例
pub async fn create_datasource(
    config: &ConnectionConfig,
) -> AppResult<Box<dyn DataSource>> {
    match config.driver.as_str() {
        "mysql" => Ok(Box::new(mysql::MySqlDataSource::new(config).await?)),
        "postgres" => Ok(Box::new(postgres::PostgresDataSource::new(config).await?)),
        "oracle" => Ok(Box::new(oracle::OracleDataSource::new(config).await?)),
        "sqlserver" => Ok(Box::new(sqlserver::SqlServerDataSource::new(config).await?)),
        d => Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    }
}
