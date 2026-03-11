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

/// 列元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>, // e.g. "auto_increment"
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

    /// 列出所有数据库（MySQL: SHOW DATABASES / PG: pg_database）
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    /// 列出指定数据库中的 Schema（PostgreSQL/Oracle 专用）。
    /// **重要：** 调用方应先使用 `create_datasource_with_db(config, database)` 创建连接到目标数据库的数据源，
    /// `_database` 参数仅为接口一致性保留，具体实现通常忽略它（连接池已绑定到目标数据库）。
    async fn list_schemas(&self, _database: &str) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    /// 列出指定 category 的对象（tables/views/functions/procedures/triggers/events/sequences）
    async fn list_objects(&self, _database: &str, _schema: Option<&str>, _category: &str) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    async fn get_full_schema(&self) -> AppResult<FullSchemaInfo> {
        let tables_meta = self.get_tables().await?;
        let mut tables = vec![];
        for t in &tables_meta {
            // 默认实现对每张表的 metadata 查询采用 unwrap_or_default：
            // 这是为了让未实现扩展方法的驱动（Oracle/MSSQL stub）能静默返回空数据。
            // 真实驱动实现（MySQL/PostgreSQL）应覆盖本方法并传播错误。
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

/// 用覆盖的 database 创建数据源（用于跨库查询）
pub async fn create_datasource_with_db(
    config: &ConnectionConfig,
    database: &str,
) -> AppResult<Box<dyn DataSource>> {
    let mut cfg = config.clone();
    cfg.database = database.to_string();
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
            cfg.database = db.to_string();
        }
    }
    match cfg.driver.as_str() {
        "mysql" => Ok(Box::new(mysql::MySqlDataSource::new(&cfg).await?)),
        "postgres" => Ok(Box::new(postgres::PostgresDataSource::new_with_schema(&cfg, schema).await?)),
        "oracle" => Ok(Box::new(oracle::OracleDataSource::new(&cfg).await?)),
        "sqlserver" => Ok(Box::new(sqlserver::SqlServerDataSource::new(&cfg).await?)),
        d => Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    }
}
