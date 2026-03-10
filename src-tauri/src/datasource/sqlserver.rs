// TODO: SQL Server 支持，当前为占位实现
use async_trait::async_trait;
use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::{AppError, AppResult};

pub struct SqlServerDataSource;

impl SqlServerDataSource {
    pub async fn new(_config: &ConnectionConfig) -> AppResult<Self> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
}

#[async_trait]
impl DataSource for SqlServerDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
}
