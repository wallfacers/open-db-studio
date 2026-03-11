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
    // 确保目录存在（Windows 上 Tauri 不一定自动创建）
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create app data dir: {}", e)))?;
    let db_path = std::path::Path::new(app_data_dir).join("open-db-studio.db");
    let conn = Connection::open(&db_path)?;

    // 开启 WAL 模式提升并发性能
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    migrations::run_migrations(&conn)?;

    DB.set(Mutex::new(conn))
        .map_err(|_| crate::AppError::Other("DB already initialized".into()))?;

    log::info!("SQLite initialized at {}", db_path.display());
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
         FROM connections ORDER BY sort_order, name"
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

/// 更新连接请求（password 为 None 时保留原加密密码）
#[derive(Debug, serde::Deserialize)]
pub struct UpdateConnectionRequest {
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub extra_params: Option<String>,
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

/// 更新连接，password 为 None 时保留原值
pub fn update_connection(id: i64, req: &UpdateConnectionRequest) -> AppResult<models::Connection> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();

    match &req.password {
        Some(pwd) if !pwd.is_empty() => {
            let password_enc = crate::crypto::encrypt(pwd)?;
            conn.execute(
                "UPDATE connections SET name=?1, driver=?2, host=?3, port=?4,
                 database_name=?5, username=?6, password_enc=?7,
                 extra_params=?8, updated_at=?9 WHERE id=?10",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username, password_enc,
                    req.extra_params, now, id
                ],
            )?;
        }
        _ => {
            conn.execute(
                "UPDATE connections SET name=?1, driver=?2, host=?3, port=?4,
                 database_name=?5, username=?6,
                 extra_params=?7, updated_at=?8 WHERE id=?9",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username,
                    req.extra_params, now, id
                ],
            )?;
        }
    }

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

    let driver = row.0;
    let default_port: i64 = match driver.as_str() {
        "postgres" => 5432,
        "sqlserver" => 1433,
        "oracle" => 1521,
        _ => 3306, // mysql
    };
    let username = row.4.unwrap_or_default();
    // PostgreSQL 数据库名为空时默认使用用户名（pg 规范），避免连接到 pg_catalog
    let database = match row.3 {
        Some(db) if !db.is_empty() => db,
        _ => if driver == "postgres" { username.clone() } else { String::new() },
    };

    Ok(crate::datasource::ConnectionConfig {
        driver,
        host: row.1.unwrap_or_default(),
        port: row.2.unwrap_or(default_port) as u16,
        database,
        username,
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

/// 列出所有连接分组
pub fn list_groups() -> AppResult<Vec<models::ConnectionGroup>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups ORDER BY sort_order, name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows { results.push(row?); }
    Ok(results)
}

/// 创建连接分组
pub fn create_group(name: &str, color: Option<&str>) -> AppResult<models::ConnectionGroup> {
    let conn = get().lock().unwrap();
    conn.execute(
        "INSERT INTO connection_groups (name, color) VALUES (?1, ?2)",
        rusqlite::params![name, color],
    )?;
    let id = conn.last_insert_rowid();
    let group = conn.query_row(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups WHERE id = ?1",
        [id],
        |row| Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        }),
    )?;
    Ok(group)
}

/// 更新连接分组
pub fn update_group(id: i64, name: &str, color: Option<&str>) -> AppResult<models::ConnectionGroup> {
    let conn = get().lock().unwrap();
    let affected = conn.execute(
        "UPDATE connection_groups SET name = ?1, color = ?2 WHERE id = ?3",
        rusqlite::params![name, color, id],
    )?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("Group {} not found", id)));
    }
    let group = conn.query_row(
        "SELECT id, name, color, sort_order, created_at FROM connection_groups WHERE id = ?1",
        [id],
        |row| Ok(models::ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        }),
    )?;
    Ok(group)
}

/// 删除连接分组（连接的 group_id 自动设为 NULL）
pub fn delete_group(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let affected = conn.execute("DELETE FROM connection_groups WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("Group {} not found", id)));
    }
    Ok(())
}

/// 将连接移动到分组（group_id 为 None 表示移出分组）
pub fn move_connection_to_group(connection_id: i64, group_id: Option<i64>) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE connections SET group_id = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![group_id, now, connection_id],
    )?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("Connection {} not found", connection_id)));
    }
    Ok(())
}

// ============ LLM 配置 CRUD ============

fn row_to_llm_config_raw(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String)> {
    Ok((
        row.get(0)?,   // id
        row.get(1)?,   // name
        row.get(2)?,   // api_key_enc
        row.get(3)?,   // base_url
        row.get(4)?,   // model
        row.get(5)?,   // api_type
        row.get(6)?,   // preset
        row.get::<_, i64>(7)? != 0, // is_default
        row.get(8)?,   // test_status
        row.get(9)?,   // test_error
        row.get(10)?,  // tested_at
        row.get(11)?,  // created_at
    ))
}

fn decrypt_llm_config(raw: (i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String)) -> AppResult<models::LlmConfig> {
    let api_key = if raw.2.is_empty() {
        String::new()
    } else {
        crate::crypto::decrypt(&raw.2)?
    };
    Ok(models::LlmConfig {
        id: raw.0,
        name: raw.1,
        api_key,
        base_url: raw.3,
        model: raw.4,
        api_type: raw.5,
        preset: raw.6,
        is_default: raw.7,
        test_status: raw.8,
        test_error: raw.9,
        tested_at: raw.10,
        created_at: raw.11,
    })
}

const LLM_CONFIG_SELECT: &str =
    "SELECT id, name, api_key_enc, base_url, model, api_type, preset, is_default,
            test_status, test_error, tested_at, created_at
     FROM llm_configs";

pub fn list_llm_configs() -> AppResult<Vec<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "{} ORDER BY is_default DESC, created_at ASC",
        LLM_CONFIG_SELECT
    ))?;
    let rows = stmt.query_map([], |row| row_to_llm_config_raw(row))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(decrypt_llm_config(row?)?);
    }
    Ok(results)
}

pub fn create_llm_config(input: &models::CreateLlmConfigInput) -> AppResult<models::LlmConfig> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let api_key_enc = if input.api_key.is_empty() {
        String::new()
    } else {
        crate::crypto::encrypt(&input.api_key)?
    };
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM llm_configs", [], |r| r.get(0))?;
    let is_default = if count == 0 { 1i64 } else { 0i64 };
    let name = input.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        format!("{} · {}", input.model, input.api_type)
    });
    conn.execute(
        "INSERT INTO llm_configs (name, api_key_enc, base_url, model, api_type, preset, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![name, api_key_enc, input.base_url, input.model, input.api_type, input.preset, is_default, now],
    )?;
    let id = conn.last_insert_rowid();
    let raw = conn.query_row(
        &format!("{} WHERE id = ?1", LLM_CONFIG_SELECT),
        [id],
        |row| row_to_llm_config_raw(row),
    )?;
    decrypt_llm_config(raw)
}

pub fn update_llm_config(id: i64, input: &models::UpdateLlmConfigInput) -> AppResult<models::LlmConfig> {
    let conn = get().lock().unwrap();
    let current = conn.query_row(
        &format!("{} WHERE id = ?1", LLM_CONFIG_SELECT),
        [id],
        |row| row_to_llm_config_raw(row),
    ).optional()?.ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;

    let new_name = input.name.clone().filter(|n| !n.is_empty()).unwrap_or(current.1.clone());
    let new_api_key_enc = match &input.api_key {
        Some(k) if !k.is_empty() => crate::crypto::encrypt(k)?,
        Some(_) => String::new(),
        None => current.2.clone(),
    };
    let new_base_url = input.base_url.clone().unwrap_or(current.3.clone());
    let new_model = input.model.clone().unwrap_or(current.4.clone());
    let new_api_type = input.api_type.clone().unwrap_or(current.5.clone());
    let new_preset = input.preset.clone().or(current.6.clone());

    conn.execute(
        "UPDATE llm_configs SET name=?1, api_key_enc=?2, base_url=?3, model=?4, api_type=?5, preset=?6 WHERE id=?7",
        rusqlite::params![new_name, new_api_key_enc, new_base_url, new_model, new_api_type, new_preset, id],
    )?;
    let raw = conn.query_row(
        &format!("{} WHERE id = ?1", LLM_CONFIG_SELECT),
        [id],
        |row| row_to_llm_config_raw(row),
    )?;
    decrypt_llm_config(raw)
}

pub fn delete_llm_config(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let is_default: i64 = conn.query_row(
        "SELECT is_default FROM llm_configs WHERE id = ?1",
        [id],
        |r| r.get(0),
    ).optional()?.ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;
    conn.execute("DELETE FROM llm_configs WHERE id = ?1", [id])?;
    if is_default != 0 {
        conn.execute(
            "UPDATE llm_configs SET is_default = 1 WHERE id = (SELECT id FROM llm_configs ORDER BY created_at ASC LIMIT 1)",
            [],
        )?;
    }
    Ok(())
}

pub fn set_default_llm_config(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM llm_configs WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Err(crate::AppError::Other(format!("LlmConfig {} not found", id)));
    }
    conn.execute("UPDATE llm_configs SET is_default = 0", [])?;
    conn.execute("UPDATE llm_configs SET is_default = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn update_llm_config_test_status(id: i64, status: &str, error: Option<&str>) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE llm_configs SET test_status=?1, test_error=?2, tested_at=?3 WHERE id=?4",
        rusqlite::params![status, error, now, id],
    )?;
    Ok(())
}

pub fn get_default_llm_config() -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    let raw = conn.query_row(
        &format!("{} WHERE is_default = 1 LIMIT 1", LLM_CONFIG_SELECT),
        [],
        |row| row_to_llm_config_raw(row),
    ).optional()?;
    match raw {
        Some(r) => Ok(Some(decrypt_llm_config(r)?)),
        None => Ok(None),
    }
}

pub fn get_llm_config_by_id(id: i64) -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    let raw = conn.query_row(
        &format!("{} WHERE id = ?1", LLM_CONFIG_SELECT),
        [id],
        |row| row_to_llm_config_raw(row),
    ).optional()?;
    match raw {
        Some(r) => Ok(Some(decrypt_llm_config(r)?)),
        None => Ok(None),
    }
}

/// 迁移旧 key-value LLM 配置到 llm_configs 表（仅当表为空时执行）
pub fn migrate_legacy_llm_settings() -> AppResult<()> {
    let conn = get().lock().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM llm_configs", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let api_key_enc = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.api_key'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_default();
    let base_url = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.base_url'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let model = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.model'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "gpt-4o-mini".to_string());
    let api_type = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.api_type'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "openai".to_string());

    if api_key_enc.is_empty() {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let name = format!("{} · {}", model, api_type);
    conn.execute(
        "INSERT INTO llm_configs (name, api_key_enc, base_url, model, api_type, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        rusqlite::params![name, api_key_enc, base_url, model, api_type, now],
    )?;
    conn.execute("DELETE FROM app_settings WHERE key LIKE 'llm.%'", [])?;
    log::info!("Migrated legacy LLM settings to llm_configs table");
    Ok(())
}
