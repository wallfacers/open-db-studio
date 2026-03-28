use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;
use std::time::{Duration, Instant};
use reqwest;

use super::{
    ColumnMeta, ConnectionConfig, DataSource, DbStats, DbSummary, DriverCapabilities,
    ForeignKeyMeta, IndexMeta, ProcedureMeta, QueryResult, SchemaInfo, SqlDialect,
    TableMeta, TableStat, TableStatInfo, ViewMeta,
};
use crate::{AppError, AppResult};

use super::utils::format_size;

pub struct ClickHouseDataSource {
    client: Client,
    database: String,
    /// HTTP 基础 URL（用于 execute() 的 raw JSON 查询)
    http_url: String,
    http_user: Option<String>,
    http_password: Option<String>,
    /// Token 认证时用于 Authorization header
 http_token: Option<String>,
    /// HTTP 请求超时
 connect_timeout: Duration,
}

impl ClickHouseDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let host = config.host.as_deref()
            .ok_or_else(|| AppError::Datasource("Missing host".into()))?;
        let port = config.port.unwrap_or(8123);
        let database = config.database.as_deref().unwrap_or("default").to_string();

        // SSL 模式
        let ssl_mode = config.ssl_mode.as_deref().unwrap_or("disable");
        let scheme = if ssl_mode == "disable" { "http" } else { "https" };
        let url = format!("{}://{}:{}", scheme, host, port);

        let mut client = Client::default().with_url(&url).with_database(&database);

        // Token 认证
        let auth_type = config.auth_type.as_deref().unwrap_or("password");
        if auth_type == "token" {
            // token 认证: 不设置 username/password，在 header 中发送
        } else {
            if let Some(user) = config.username.as_deref() {
                client = client.with_user(user);
            }
            if let Some(pw) = config.password.as_deref() {
                client = client.with_password(pw);
            }
        }

        // 超时
        let connect_timeout_secs = config.connect_timeout_secs.unwrap_or(30) as u64;
        let connect_timeout = Duration::from_secs(connect_timeout_secs);

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
            http_token: config.token.clone(),
            connect_timeout,
        })
    }
}

