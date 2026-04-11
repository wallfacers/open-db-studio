/// 全局连接池缓存
///
/// 避免每次树导航（list_databases / list_schemas / list_objects 等）
/// 都重新创建 MySQL/Postgres 连接池，从而消除重复的 TCP 握手和认证开销。
///
/// 缓存 key：(connection_id, database, schema)
/// - connection_id：来自内置 SQLite 的连接记录 ID
/// - database：目标数据库名（空串表示使用配置默认库）
/// - schema：目标 schema（空串表示无 schema 上下文，如 MySQL）
///
/// 缓存生命周期：
/// - 进程生命周期内长期保持（连接池本身会管理空闲连接超时）
/// - 连接被删除或更新时，调用 `invalidate(connection_id)` 清除对应缓存

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::{ConnectionConfig, DataSource, validate_connection_config};
use crate::AppResult;

type CacheKey = (i64, String, String);

static POOL_CACHE: Lazy<Mutex<HashMap<CacheKey, Arc<dyn DataSource>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 获取或创建缓存的数据源。
/// 首次调用时建立连接池；后续调用直接复用已有连接池，无额外握手开销。
///
/// SQLite 驱动例外：基于文件锁，不入缓存，每次直接新建（开销可接受）。
pub async fn get_or_create(
    connection_id: i64,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
) -> AppResult<Arc<dyn DataSource>> {
    // SQLite 不走缓存
    if config.driver == "sqlite" {
        return create_datasource_arc(config, database, schema).await;
    }

    let key: CacheKey = (connection_id, database.to_string(), schema.to_string());

    // 快速路径：已有缓存直接返回
    {
        let cache = POOL_CACHE.lock().await;
        if let Some(ds) = cache.get(&key) {
            return Ok(Arc::clone(ds));
        }
    }

    // 慢路径：创建新连接池
    let ds = create_datasource_arc(config, database, schema).await?;

    let mut cache = POOL_CACHE.lock().await;
    // Double-checked：等锁期间可能已被其他任务插入
    if let Some(existing) = cache.get(&key) {
        return Ok(Arc::clone(existing));
    }
    cache.insert(key, Arc::clone(&ds));
    log::info!(
        "Pool cache created: connection_id={} database={:?} schema={:?}",
        connection_id, database, schema
    );
    Ok(ds)
}

/// 获取或创建缓存的数据源，可指定最小连接池大小。
/// 用于迁移管道等场景需要根据并行度动态扩展连接池。
pub async fn get_or_create_with_pool_size(
    connection_id: i64,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    min_pool_size: u32,
) -> AppResult<Arc<dyn DataSource>> {
    // SQLite 不走缓存
    if config.driver == "sqlite" {
        return create_datasource_arc(config, database, schema).await;
    }

    let key: CacheKey = (connection_id, database.to_string(), schema.to_string());

    // 快速路径：已有缓存直接返回
    {
        let cache = POOL_CACHE.lock().await;
        if let Some(ds) = cache.get(&key) {
            return Ok(Arc::clone(ds));
        }
    }

    // 慢路径：创建新连接池（覆盖 pool_max_connections）
    let mut cfg = config.clone();
    let current = cfg.pool_max_connections.unwrap_or(0) as u32;
    if min_pool_size > current {
        cfg.pool_max_connections = Some(min_pool_size);
    }
    let ds = create_datasource_arc(&cfg, database, schema).await?;

    let mut cache = POOL_CACHE.lock().await;
    if let Some(existing) = cache.get(&key) {
        return Ok(Arc::clone(existing));
    }
    cache.insert(key, Arc::clone(&ds));
    log::info!(
        "Pool cache created (pool_size={}): connection_id={} database={:?} schema={:?}",
        cfg.pool_max_connections.unwrap_or(0), connection_id, database, schema
    );
    Ok(ds)
}

/// 删除或更新连接时调用，清除该连接的所有缓存连接池
pub async fn invalidate(connection_id: i64) {
    let mut cache = POOL_CACHE.lock().await;
    let before = cache.len();
    cache.retain(|(id, _, _), _| *id != connection_id);
    let removed = before - cache.len();
    if removed > 0 {
        log::info!("Pool cache invalidated: connection_id={}, removed {} entries", connection_id, removed);
    }
}

/// App 退出时调用，主动关闭所有缓存的连接池。
///
/// 必须在 Tokio 运行时仍然存活时调用（即在 `on_window_event: Destroyed` 中，
/// 而非静态析构阶段），否则 SQLx 的异步关闭信号无法被处理，
/// 导致 MySQL/Postgres 服务器端连接无法收到正常的关闭包（COM_QUIT / Terminate）。
pub async fn close_all() {
    let mut cache = POOL_CACHE.lock().await;
    let count = cache.len();
    cache.clear();
    if count > 0 {
        log::info!("Pool cache: closed all {} cached pool(s) on app exit", count);
    }
}

async fn create_datasource_arc(
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
) -> AppResult<Arc<dyn DataSource>> {
    let mut cfg = config.clone();
    if !database.is_empty() {
        cfg.database = Some(database.to_string());
    }
    validate_connection_config(&cfg)?;
    let ds: Arc<dyn DataSource> = match cfg.driver.as_str() {
        "mysql" => Arc::new(super::mysql::MySqlDataSource::new(&cfg).await?),
        "postgres" => {
            let s = if schema.is_empty() { None } else { Some(schema) };
            Arc::new(super::postgres::PostgresDataSource::new_with_schema(&cfg, s).await?)
        }
        "oracle" => Arc::new(super::oracle::OracleDataSource::new(&cfg).await?),
        "sqlserver" => Arc::new(super::sqlserver::SqlServerDataSource::new(&cfg).await?),
        // SQLite 基于文件锁，不使用连接池；直接新建，不存入缓存
        "sqlite" => Arc::new(super::sqlite::SqliteDataSource::new(&cfg).await?),
        "doris" => Arc::new(super::mysql::MySqlDataSource::new_with_dialect(&cfg, super::mysql::Dialect::Doris).await?),
        "tidb" => Arc::new(super::mysql::MySqlDataSource::new_with_dialect(&cfg, super::mysql::Dialect::TiDB).await?),
        "clickhouse" => Arc::new(super::clickhouse::ClickHouseDataSource::new(&cfg).await?),
        "gaussdb" => {
            let s = if schema.is_empty() { None } else { Some(schema) };
            Arc::new(super::gaussdb::GaussDbDataSource::new_with_schema(&cfg, s).await?)
        }
        "db2" => Arc::new(super::db2::Db2DataSource::new(&cfg).await?),
        d => return Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    };
    Ok(ds)
}
