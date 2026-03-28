pub mod clickhouse;
pub mod db2;
pub mod gaussdb;
pub mod mysql;
pub mod oracle;
pub mod pool_cache;
pub mod postgres;
pub mod sqlite;
pub mod sqlserver;
pub mod utils;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;
use crate::{AppError, AppResult};

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

/// 列元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>, // e.g. "auto_increment"
    pub comment: Option<String>, // 列注释原文
}

/// 索引元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexMeta {
    pub index_name: String,
    pub is_unique: bool,
    pub columns: Vec<String>,
}

/// 外键元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ForeignKeyMeta {
    pub constraint_name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_delete: Option<String>,  // CASCADE / SET NULL / RESTRICT / NO ACTION
}

/// 视图元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ViewMeta {
    pub name: String,
    pub definition: Option<String>,
}

/// 存储过程/函数类型
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum RoutineType {
    #[serde(rename = "PROCEDURE")]
    Procedure,
    #[serde(rename = "FUNCTION")]
    Function,
    #[serde(other)]
    Unknown,
}

/// 存储过程元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcedureMeta {
    pub name: String,
    pub routine_type: RoutineType,
}

/// 表统计信息（用于导出向导的表选择列表）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableStatInfo {
    pub name: String,
    pub row_count: Option<i64>,
    pub size: Option<String>,
}

/// 表详细信息（含列/索引/外键）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableDetail {
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
}

/// 完整 schema（含列和外键信息，用于 ERD）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FullSchemaInfo {
    pub tables: Vec<TableDetail>,
    pub views: Vec<ViewMeta>,
    pub procedures: Vec<ProcedureMeta>,
}

/// 连接配置（来自前端）
///
/// `host` / `port` / `database` / `username` / `password` 改为 Option，
/// 以支持 SQLite（仅需 `file_path`）等无需网络的驱动。
/// 已有网络驱动（MySQL/PostgreSQL/Oracle/SQL Server）在构建时
/// 使用 `.as_deref().unwrap_or("")` 或 `.ok_or(AppError::Datasource(...))` 取值。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionConfig {
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub extra_params: Option<String>,
    /// SQLite 专用：.sqlite 文件绝对路径
    pub file_path: Option<String>,

    // === 认证 ===
    /// 认证方式: "password"(默认) | "ssl_cert" | "os_native" | "token"
    pub auth_type: Option<String>,
    /// auth_type=token 时使用的令牌
    pub token: Option<String>,

    // === SSL/TLS ===
    /// SSL 模式: "disable"|"prefer"|"require"|"verify_ca"|"verify_full"
    pub ssl_mode: Option<String>,
    pub ssl_ca_path: Option<String>,
    pub ssl_cert_path: Option<String>,
    pub ssl_key_path: Option<String>,

    // === 超时 ===
    pub connect_timeout_secs: Option<u32>,
    pub read_timeout_secs: Option<u32>,

    // === 连接池 ===
    pub pool_max_connections: Option<u32>,
    pub pool_idle_timeout_secs: Option<u32>,
}

// ─── 配置校验 ────────────────────────────────────────────────────────────────

/// 连接配置校验错误类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConfigError {
    UnsupportedAuth { driver: String, auth_type: String },
    MissingField { field: String, reason: String },
    InvalidValue { field: String, value: String, constraint: String },
    FileNotFound { path: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::UnsupportedAuth { driver, auth_type } => {
                write!(f, "驱动 '{}' 不支持认证方式 '{}', 支持的方式: {}",
                       driver, auth_type, supported_auth_types(driver).join(", "))
            }
            ConfigError::MissingField { field, reason } => {
                write!(f, "缺少必填字段 '{}': {}", field, reason)
            }
            ConfigError::InvalidValue { field, value, constraint } => {
                write!(f, "字段 '{}' 的值 '{}' 不合法: {}", field, value, constraint)
            }
            ConfigError::FileNotFound { path } => {
                write!(f, "文件不存在: {}", path)
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<ConfigError> for AppError {
    fn from(e: ConfigError) -> Self {
        AppError::Datasource(e.to_string())
    }
}

/// 返回指定驱动支持的认证方式列表
pub fn supported_auth_types(driver: &str) -> Vec<&'static str> {
    match driver {
        "mysql" | "doris" | "tidb" => vec!["password", "ssl_cert", "os_native"],
        "postgres" | "gaussdb" => vec!["password", "ssl_cert", "os_native"],
        "sqlite" => vec!["os_native"],
        "oracle" => vec!["password", "os_native"],
        "sqlserver" => vec!["password", "ssl_cert", "os_native"],
        "clickhouse" => vec!["password", "ssl_cert", "token"],
        "db2" => vec!["password", "os_native"],
        _ => vec!["password"],
    }
}

/// 验证驱动与认证方式是否兼容
pub fn validate_auth_compatibility(driver: &str, auth_type: &str) -> AppResult<()> {
    let supported = supported_auth_types(driver);
    if !supported.contains(&auth_type) {
        return Err(AppError::Datasource(format!(
            "驱动 {} 不支持认证方式 '{}', 支持的方式: {}",
            driver, auth_type, supported.join(", ")
        )));
    }
    Ok(())
}

/// 统一校验连接配置的合法性
pub fn validate_connection_config(config: &ConnectionConfig) -> AppResult<()> {
    // 1. driver 有效性
    let valid_drivers = ["mysql", "postgres", "sqlite", "oracle", "sqlserver", "doris", "clickhouse", "tidb", "gaussdb", "db2"];
    if !valid_drivers.contains(&config.driver.as_str()) {
        return Err(AppError::Datasource(format!("不支持的驱动: {}", config.driver)));
    }

    // 2. auth_type 兼容性
    let auth_type = config.auth_type.as_deref().unwrap_or("password");
    validate_auth_compatibility(&config.driver, auth_type)?;

    // 3. 必填字段完整性（根据 driver）
    match config.driver.as_str() {
        "sqlite" => {
            if config.file_path.is_none() || config.file_path.as_ref().map_or(true, |s| s.is_empty()) {
                return Err(AppError::Datasource("SQLite 必须指定文件路径".to_string()));
            }
        }
        _ => {
            // 网络驱动需要 host
            if config.host.is_none() || config.host.as_ref().map_or(true, |s| s.is_empty()) {
                return Err(AppError::Datasource(format!("{} 必须指定主机地址", config.driver)));
            }
        }
    }

    // 4. SSL 证书文件存在性（仅在指定了路径时检查）
    if let Some(ref path) = config.ssl_ca_path {
        if !path.is_empty() && !std::path::Path::new(path).exists() {
            return Err(AppError::Datasource(format!("CA 证书文件不存在: {}", path)));
        }
    }
    if let Some(ref path) = config.ssl_cert_path {
        if !path.is_empty() && !std::path::Path::new(path).exists() {
            return Err(AppError::Datasource(format!("客户端证书文件不存在: {}", path)));
        }
    }
    if let Some(ref path) = config.ssl_key_path {
        if !path.is_empty() && !std::path::Path::new(path).exists() {
            return Err(AppError::Datasource(format!("客户端密钥文件不存在: {}", path)));
        }
    }

    // 5. 端口/超时范围合法性
    if let Some(port) = config.port {
        if port == 0 {
            return Err(AppError::Datasource("端口号不能为 0".to_string()));
        }
    }
    if let Some(timeout) = config.connect_timeout_secs {
        if timeout == 0 {
            return Err(AppError::Datasource("连接超时不能为 0".to_string()));
        }
    }

    Ok(())
}

// ─── 驱动能力声明 ────────────────────────────────────────────────────────────

/// SQL 方言（供前端 AI Prompt 注入使用）
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum SqlDialect {
    /// MySQL / TiDB / SQLite / PostgreSQL 标准方言
    Standard,
    /// Apache Doris 专有函数
    Doris,
    /// ClickHouse 专有函数（arrayJoin / groupArray / countIf 等）
    ClickHouse,
}

/// 驱动能力声明结构体，各驱动自报支持项。
/// 前端根据此声明动态决定 DBTree 中哪些类别节点可见。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DriverCapabilities {
    pub has_schemas: bool,
    pub has_foreign_keys: bool,
    pub has_stored_procedures: bool,
    pub has_triggers: bool,
    pub has_materialized_views: bool,
    pub has_multi_database: bool,
    pub has_partitions: bool,
    pub sql_dialect: SqlDialect,
    /// 支持的认证方式列表
    pub supported_auth_types: Vec<String>,
    /// 是否支持连接池配置
    pub has_pool_config: bool,
    /// 是否支持超时配置
    pub has_timeout_config: bool,
    /// 是否支持 SSL 配置
    pub has_ssl_config: bool,
}

impl Default for DriverCapabilities {
    fn default() -> Self {
        Self {
            has_schemas: false,
            has_foreign_keys: false,
            has_stored_procedures: false,
            has_triggers: false,
            has_materialized_views: false,
            has_multi_database: false,
            has_partitions: false,
            sql_dialect: SqlDialect::Standard,
            supported_auth_types: vec!["password".to_string()],
            has_pool_config: false,
            has_timeout_config: false,
            has_ssl_config: false,
        }
    }
}

// ─── 数据库统计信息 ──────────────────────────────────────────────────────────

/// 单表统计
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableStat {
    pub name: String,
    pub row_count: Option<i64>,
    pub data_size_bytes: Option<i64>,
    pub index_size_bytes: Option<i64>,
}

/// 库级摘要
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbSummary {
    pub total_tables: usize,
    pub total_size_bytes: Option<i64>,
    pub db_version: Option<String>,
}

/// 数据库统计信息（用于性能监控图表）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbStats {
    pub tables: Vec<TableStat>,
    pub db_summary: DbSummary,
}

// ─── DataSource Trait ────────────────────────────────────────────────────────

/// 数据源统一抽象 trait
#[async_trait]
pub trait DataSource: Send + Sync {
    async fn test_connection(&self) -> AppResult<()>;
    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>>;
    async fn get_schema(&self) -> AppResult<SchemaInfo>;

    // V1 新增：带默认空实现（Oracle/MSSQL 不强制实现）
    async fn get_columns(&self, _table: &str, _schema: Option<&str>) -> AppResult<Vec<ColumnMeta>> {
        Ok(vec![])
    }
    async fn get_indexes(&self, _table: &str, _schema: Option<&str>) -> AppResult<Vec<IndexMeta>> {
        Ok(vec![])
    }
    async fn get_foreign_keys(&self, _table: &str, _schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
        Ok(vec![])
    }
    async fn get_views(&self) -> AppResult<Vec<ViewMeta>> {
        Ok(vec![])
    }
    async fn get_procedures(&self) -> AppResult<Vec<ProcedureMeta>> {
        Ok(vec![])
    }
    async fn get_table_ddl(&self, _table: &str) -> AppResult<String> {
        Ok(String::new())
    }
    async fn get_table_ddl_with_schema(&self, table: &str, schema: Option<&str>) -> AppResult<String> {
        let _ = schema;
        self.get_table_ddl(table).await
    }

    /// 供前端"查看 DDL"和导出使用的原生 DDL（默认与 get_table_ddl_with_schema 相同）。
    /// Doris 覆盖此方法返回 SHOW CREATE TABLE（含专有子句），
    /// 而 get_table_ddl 仍返回标准 DDL 用于 AI 上下文注入。
    async fn get_table_ddl_for_display(&self, table: &str, schema: Option<&str>) -> AppResult<String> {
        self.get_table_ddl_with_schema(table, schema).await
    }

    /// 列出所有数据库（MySQL: SHOW DATABASES / PG: pg_database）
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    /// 列出指定数据库中的 Schema（PostgreSQL/Oracle 专用）。
    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    /// 列出指定 category 的对象（tables/views/functions/procedures/triggers/events/sequences）
    async fn list_objects(&self, _database: &str, _schema: Option<&str>, _category: &str) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    /// 列出表并附带行数和大小统计（用于导出向导）
    async fn list_tables_with_stats(&self, _database: &str, _schema: Option<&str>) -> AppResult<Vec<TableStatInfo>> {
        Ok(vec![])
    }

    /// 返回驱动能力声明（默认：全保守 false）
    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities::default()
    }

    /// 返回库级 + 表级统计信息（用于性能监控图表）
    async fn get_db_stats(&self, _database: Option<&str>) -> AppResult<DbStats> {
        Ok(DbStats {
            tables: vec![],
            db_summary: DbSummary {
                total_tables: 0,
                total_size_bytes: None,
                db_version: None,
            },
        })
    }

    async fn get_full_schema(&self) -> AppResult<FullSchemaInfo> {
        let tables_meta = self.get_tables().await?;
        let mut tables = vec![];
        for t in &tables_meta {
            let schema = t.schema.as_deref();
            let columns = self.get_columns(&t.name, schema).await.unwrap_or_default();
            let indexes = self.get_indexes(&t.name, schema).await.unwrap_or_default();
            let foreign_keys = self.get_foreign_keys(&t.name, schema).await.unwrap_or_default();
            tables.push(TableDetail { name: t.name.clone(), columns, indexes, foreign_keys });
        }
        let views = self.get_views().await.unwrap_or_default();
        let procedures = self.get_procedures().await.unwrap_or_default();
        Ok(FullSchemaInfo { tables, views, procedures })
    }
}

// ─── 工厂函数 ────────────────────────────────────────────────────────────────

/// 根据配置创建对应数据源实例
pub async fn create_datasource(
    config: &ConnectionConfig,
) -> AppResult<Box<dyn DataSource>> {
    validate_connection_config(config)?;
    match config.driver.as_str() {
        "mysql"  => Ok(Box::new(mysql::MySqlDataSource::new(config).await?)),
        "postgres" => Ok(Box::new(postgres::PostgresDataSource::new(config).await?)),
        "oracle"   => Ok(Box::new(oracle::OracleDataSource::new(config).await?)),
        "sqlserver" => Ok(Box::new(sqlserver::SqlServerDataSource::new(config).await?)),
        "sqlite"    => Ok(Box::new(sqlite::SqliteDataSource::new(config).await?)),
        "doris"     => Ok(Box::new(mysql::MySqlDataSource::new_with_dialect(config, mysql::Dialect::Doris).await?)),
        "tidb"      => Ok(Box::new(mysql::MySqlDataSource::new_with_dialect(config, mysql::Dialect::TiDB).await?)),
        "clickhouse" => Ok(Box::new(clickhouse::ClickHouseDataSource::new(config).await?)),
        "gaussdb" => Ok(Box::new(gaussdb::GaussDbDataSource::new(config).await?)),
        "db2" => Ok(Box::new(db2::Db2DataSource::new(config).await?)),
        d => Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    }
}

/// 用覆盖的 database 创建数据源（用于跨库查询）
pub async fn create_datasource_with_db(
    config: &ConnectionConfig,
    database: &str,
) -> AppResult<Box<dyn DataSource>> {
    let mut cfg = config.clone();
    cfg.database = Some(database.to_string());
    create_datasource(&cfg).await
}

/// 用覆盖的 database + schema 创建数据源（用于 SQL 编辑器上下文执行）
pub async fn create_datasource_with_context(
    config: &ConnectionConfig,
    database: Option<&str>,
    schema: Option<&str>,
) -> AppResult<Box<dyn DataSource>> {
    let mut cfg = config.clone();
    if let Some(db) = database {
        if !db.is_empty() {
            cfg.database = Some(db.to_string());
        }
    }
    match cfg.driver.as_str() {
        "mysql"  => Ok(Box::new(mysql::MySqlDataSource::new(&cfg).await?)),
        "postgres" => Ok(Box::new(postgres::PostgresDataSource::new_with_schema(&cfg, schema).await?)),
        "oracle"   => Ok(Box::new(oracle::OracleDataSource::new(&cfg).await?)),
        "sqlserver" => Ok(Box::new(sqlserver::SqlServerDataSource::new(&cfg).await?)),
        "sqlite"    => Ok(Box::new(sqlite::SqliteDataSource::new(&cfg).await?)),
        "doris"     => Ok(Box::new(mysql::MySqlDataSource::new_with_dialect(&cfg, mysql::Dialect::Doris).await?)),
        "tidb"      => Ok(Box::new(mysql::MySqlDataSource::new_with_dialect(&cfg, mysql::Dialect::TiDB).await?)),
        "clickhouse" => Ok(Box::new(clickhouse::ClickHouseDataSource::new(&cfg).await?)),
        "gaussdb" => Ok(Box::new(gaussdb::GaussDbDataSource::new_with_schema(&cfg, schema).await?)),
        "db2" => Ok(Box::new(db2::Db2DataSource::new(&cfg).await?)),
        d => Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    }
}
