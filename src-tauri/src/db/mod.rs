pub mod migrations;
pub mod models;

use chrono::Utc;
use once_cell::sync::OnceCell;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use std::sync::Mutex;
use crate::AppResult;

static DB: OnceCell<Mutex<Connection>> = OnceCell::new();

/// 初始化内置 SQLite 数据库
pub fn init(app_data_dir: &str) -> AppResult<()> {
    let db_path = format!("{}/open-db-studio.db", app_data_dir);
    let conn = Connection::open(&db_path)?;

    // 开启 WAL 模式提升并发性能
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    migrations::run_migrations(&conn)?;

    DB.set(Mutex::new(conn))
        .map_err(|_| crate::AppError::Other("DB already initialized".into()))?;

    log::info!("SQLite initialized at {}", db_path);
    Ok(())
}

/// 获取数据库连接引用
pub fn get() -> &'static Mutex<Connection> {
    DB.get().expect("DB not initialized. Call db::init() first.")
}

/// 列出所有连接配置（不包含密码）
pub fn list_connections() -> AppResult<Vec<models::Connection>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, created_at, updated_at
         FROM connections ORDER BY name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(models::Connection {
            id: row.get(0)?,
            name: row.get(1)?,
            group_id: row.get(2)?,
            driver: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database_name: row.get(6)?,
            username: row.get(7)?,
            extra_params: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// 创建连接，密码加密存储
pub fn create_connection(req: &models::CreateConnectionRequest) -> AppResult<models::Connection> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();

    let password_enc = match &req.password {
        Some(pwd) if !pwd.is_empty() => Some(crate::crypto::encrypt(pwd)?),
        _ => None,
    };

    conn.execute(
        "INSERT INTO connections (name, group_id, driver, host, port, database_name, username, password_enc, extra_params, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            req.name, req.group_id, req.driver, req.host, req.port,
            req.database_name, req.username, password_enc,
            req.extra_params, now
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, created_at, updated_at
         FROM connections WHERE id = ?1",
        [id],
        |row| Ok(models::Connection {
            id: row.get(0)?,
            name: row.get(1)?,
            group_id: row.get(2)?,
            driver: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database_name: row.get(6)?,
            username: row.get(7)?,
            extra_params: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        }),
    )?;
    Ok(result)
}

/// 删除连接（CASCADE 删除关联历史）
pub fn delete_connection(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let affected = conn.execute("DELETE FROM connections WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("Connection {} not found", id)));
    }
    Ok(())
}

/// 通过 ID 获取连接配置（含解密密码）
pub fn get_connection_config(id: i64) -> AppResult<crate::datasource::ConnectionConfig> {
    let conn = get().lock().unwrap();
    let row = conn.query_row(
        "SELECT driver, host, port, database_name, username, password_enc, extra_params
         FROM connections WHERE id = ?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
        )),
    ).optional()?
    .ok_or_else(|| crate::AppError::Other(format!("Connection {} not found", id)))?;

    let password = match row.5 {
        Some(enc) => crate::crypto::decrypt(&enc)?,
        None => String::new(),
    };

    Ok(crate::datasource::ConnectionConfig {
        driver: row.0,
        host: row.1.unwrap_or_default(),
        port: row.2.unwrap_or(3306) as u16,
        database: row.3.unwrap_or_default(),
        username: row.4.unwrap_or_default(),
        password,
        extra_params: row.6,
    })
}

/// 保存查询历史
pub fn save_query_history(
    connection_id: i64,
    sql: &str,
    duration_ms: i64,
    row_count: Option<i64>,
    error_msg: Option<&str>,
) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO query_history (connection_id, sql, executed_at, duration_ms, row_count, error_msg)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![connection_id, sql, now, duration_ms, row_count, error_msg],
    )?;
    Ok(())
}

/// 查询历史列表（最近 500 条）
pub fn list_query_history(connection_id: i64) -> AppResult<Vec<models::QueryHistory>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, sql, executed_at, duration_ms, row_count, error_msg
         FROM query_history
         WHERE connection_id = ?1
         ORDER BY executed_at DESC
         LIMIT 500"
    )?;
    let rows = stmt.query_map([connection_id], |row| {
        Ok(models::QueryHistory {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            sql: row.get(2)?,
            executed_at: row.get(3)?,
            duration_ms: row.get(4)?,
            row_count: row.get(5)?,
            error_msg: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows { results.push(row?); }
    Ok(results)
}

/// 读取配置项
pub fn get_setting(key: &str) -> AppResult<Option<String>> {
    let conn = get().lock().unwrap();
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// 写入配置项（upsert）
pub fn set_setting(key: &str, value: &str) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    Ok(())
}
