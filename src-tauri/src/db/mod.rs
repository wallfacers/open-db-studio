pub mod migrations;
pub mod models;

use once_cell::sync::OnceCell;
use rusqlite::Connection;
use std::sync::Mutex;
use crate::AppResult;

pub use models::*;

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
