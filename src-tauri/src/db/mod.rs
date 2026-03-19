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

/// 根据 ID 获取单个连接配置
pub fn get_connection_by_id(id: i64) -> AppResult<Option<models::Connection>> {
    let conn = get().lock().unwrap();
    let result = conn.query_row(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, sort_order, created_at, updated_at
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
            sort_order: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        }),
    ).optional()?;
    Ok(result)
}

/// 列出所有连接配置（不包含密码）
pub fn list_connections() -> AppResult<Vec<models::Connection>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, sort_order, created_at, updated_at
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
            sort_order: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
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
    pub group_id: Option<i64>,
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
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, sort_order, created_at, updated_at
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
            sort_order: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
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
                 extra_params=?8, group_id=?9, updated_at=?10 WHERE id=?11",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username, password_enc,
                    req.extra_params, req.group_id, now, id
                ],
            )?;
        }
        _ => {
            conn.execute(
                "UPDATE connections SET name=?1, driver=?2, host=?3, port=?4,
                 database_name=?5, username=?6,
                 extra_params=?7, group_id=?8, updated_at=?9 WHERE id=?10",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username,
                    req.extra_params, req.group_id, now, id
                ],
            )?;
        }
    }

    let result = conn.query_row(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, sort_order, created_at, updated_at
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
            sort_order: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        }),
    )?;
    Ok(result)
}

/// 返回指定连接的明文密码（仅供编辑弹窗"小眼睛"功能使用）
pub fn get_connection_password(id: i64) -> AppResult<String> {
    let conn = get().lock().unwrap();
    let enc: Option<String> = conn.query_row(
        "SELECT password_enc FROM connections WHERE id = ?1",
        [id],
        |row| row.get(0),
    ).optional()?.flatten();
    match enc {
        Some(e) if !e.is_empty() => Ok(crate::crypto::decrypt(&e)?),
        _ => Ok(String::new()),
    }
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

/// 批量更新连接 sort_order
pub fn reorder_connections(items: &[models::ReorderItem]) -> AppResult<()> {
    let conn = get().lock().unwrap();
    for item in items {
        conn.execute(
            "UPDATE connections SET sort_order = ?1 WHERE id = ?2",
            rusqlite::params![item.sort_order, item.id],
        )?;
    }
    Ok(())
}

/// 批量更新分组 sort_order
pub fn reorder_groups(items: &[models::ReorderItem]) -> AppResult<()> {
    let conn = get().lock().unwrap();
    for item in items {
        conn.execute(
            "UPDATE connection_groups SET sort_order = ?1 WHERE id = ?2",
            rusqlite::params![item.sort_order, item.id],
        )?;
    }
    Ok(())
}

// ============ LLM 配置 CRUD ============

fn row_to_llm_config_raw(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String, String, String, String, String, String)> {
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
        row.get(12)?,  // opencode_provider_id
        row.get(13)?,  // config_mode
        row.get(14)?,  // opencode_display_name
        row.get(15)?,  // opencode_model_options
        row.get(16)?,  // opencode_provider_name
    ))
}

fn decrypt_llm_config(raw: (i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String, String, String, String, String, String)) -> AppResult<models::LlmConfig> {
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
        opencode_provider_id: raw.12,
        config_mode: raw.13,
        opencode_display_name: raw.14,
        opencode_model_options: raw.15,
        opencode_provider_name: raw.16,
    })
}

const LLM_CONFIG_SELECT: &str =
    "SELECT id, name, api_key_enc, base_url, model, api_type, preset, is_default,
            test_status, test_error, tested_at, created_at,
            opencode_provider_id, config_mode,
            opencode_display_name, opencode_model_options, opencode_provider_name
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
    let provider_hint = if !input.opencode_provider_id.is_empty() {
        input.opencode_provider_id.clone()
    } else {
        input.api_type.clone()
    };
    let name = input.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        format!("{} · {}", input.model, provider_hint)
    });
    let opencode_display_name = input.opencode_display_name.clone().unwrap_or_default();
    let opencode_model_options = input.opencode_model_options.clone().unwrap_or_default();
    let opencode_provider_name = input.opencode_provider_name.clone().unwrap_or_default();
    conn.execute(
        "INSERT INTO llm_configs (name, api_key_enc, base_url, model, api_type, preset, is_default,
                                  opencode_provider_id, config_mode, created_at,
                                  opencode_display_name, opencode_model_options, opencode_provider_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            name, api_key_enc, input.base_url, input.model, input.api_type, input.preset,
            is_default, input.opencode_provider_id, input.config_mode, now,
            opencode_display_name, opencode_model_options, opencode_provider_name
        ],
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
    let new_opencode_provider_id = input.opencode_provider_id.clone().unwrap_or(current.12.clone());
    let new_config_mode = input.config_mode.clone().unwrap_or(current.13.clone());
    let new_opencode_display_name = input.opencode_display_name.clone().unwrap_or(current.14.clone());
    let new_opencode_model_options = input.opencode_model_options.clone().unwrap_or(current.15.clone());
    let new_opencode_provider_name = input.opencode_provider_name.clone().unwrap_or(current.16.clone());

    conn.execute(
        "UPDATE llm_configs SET name=?1, api_key_enc=?2, base_url=?3, model=?4, api_type=?5,
                preset=?6, opencode_provider_id=?7, config_mode=?8,
                opencode_display_name=?9, opencode_model_options=?10, opencode_provider_name=?11
         WHERE id=?12",
        rusqlite::params![
            new_name, new_api_key_enc, new_base_url, new_model, new_api_type,
            new_preset, new_opencode_provider_id, new_config_mode,
            new_opencode_display_name, new_opencode_model_options, new_opencode_provider_name, id
        ],
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
    conn.execute_batch("BEGIN;")?;
    conn.execute("UPDATE llm_configs SET is_default = 0", [])?;
    conn.execute("UPDATE llm_configs SET is_default = 1 WHERE id = ?1", [id])?;
    conn.execute_batch("COMMIT;")?;
    Ok(())
}

pub fn update_llm_config_test_status(id: i64, status: &str, error: Option<&str>) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    // 0 rows affected = config was deleted concurrently; silently ignore
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

// ============ 任务记录 CRUD ============

/// 创建任务记录
pub fn create_task(task: &models::CreateTaskInput) -> AppResult<models::TaskRecord> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    let progress = task.progress.unwrap_or(0);
    let processed_rows = task.processed_rows.unwrap_or(0);

    conn.execute(
        "INSERT INTO task_records (id, type, status, title, params, progress, processed_rows, total_rows, current_target, error, error_details, output_path, description, connection_id, scope_database, scope_schema, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)",
        rusqlite::params![
            id,
            task.type_,
            task.status,
            task.title,
            task.params,
            progress,
            processed_rows,
            task.total_rows,
            task.current_target,
            task.error,
            task.error_details,
            task.output_path,
            task.description,
            task.connection_id,
            task.scope_database,
            task.scope_schema,
            now,
        ],
    )?;

    Ok(models::TaskRecord {
        id: id.clone(),
        type_: task.type_.clone(),
        status: task.status.clone(),
        title: task.title.clone(),
        params: task.params.clone(),
        progress,
        processed_rows,
        total_rows: task.total_rows,
        current_target: task.current_target.clone(),
        error: task.error.clone(),
        error_details: task.error_details.clone(),
        output_path: task.output_path.clone(),
        description: task.description.clone(),
        connection_id: task.connection_id,
        scope_database: task.scope_database.clone(),
        scope_schema: task.scope_schema.clone(),
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
    })
}

/// 获取任务列表（最近 limit 条）
pub fn list_tasks(limit: i32) -> AppResult<Vec<models::TaskRecord>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, type, status, title, params, progress, processed_rows, total_rows, current_target, error, error_details, output_path, description, created_at, updated_at, completed_at, connection_id, scope_database, scope_schema
         FROM task_records
         ORDER BY created_at DESC
         LIMIT ?1"
    )?;
    let rows = stmt.query_map([limit], |row| {
        Ok(models::TaskRecord {
            id: row.get(0)?,
            type_: row.get(1)?,
            status: row.get(2)?,
            title: row.get(3)?,
            params: row.get(4)?,
            progress: row.get(5)?,
            processed_rows: row.get(6)?,
            total_rows: row.get(7)?,
            current_target: row.get(8)?,
            error: row.get(9)?,
            error_details: row.get(10)?,
            output_path: row.get(11)?,
            description: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            completed_at: row.get(15)?,
            connection_id: row.get(16)?,
            scope_database: row.get(17)?,
            scope_schema: row.get(18)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// 更新任务状态
pub fn update_task(id: &str, updates: &models::UpdateTaskInput) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();

    let mut set_clauses = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(v) = &updates.status {
        set_clauses.push("status = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = updates.progress {
        set_clauses.push("progress = ?");
        params.push(Box::new(v));
    }
    if let Some(v) = updates.processed_rows {
        set_clauses.push("processed_rows = ?");
        params.push(Box::new(v));
    }
    if let Some(v) = updates.total_rows {
        set_clauses.push("total_rows = ?");
        params.push(Box::new(v));
    }
    if let Some(v) = &updates.current_target {
        set_clauses.push("current_target = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &updates.error {
        set_clauses.push("error = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &updates.error_details {
        set_clauses.push("error_details = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &updates.output_path {
        set_clauses.push("output_path = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &updates.completed_at {
        set_clauses.push("completed_at = ?");
        params.push(Box::new(v.clone()));
    }

    if set_clauses.is_empty() {
        return Ok(());
    }

    set_clauses.push("updated_at = ?");
    params.push(Box::new(now));
    params.push(Box::new(id.to_string()));

    let sql = format!(
        "UPDATE task_records SET {} WHERE id = ?",
        set_clauses.join(", ")
    );

    let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())?;
    Ok(())
}

/// 删除任务记录
pub fn delete_task(id: &str) -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute("DELETE FROM task_records WHERE id = ?1", [id])?;
    Ok(())
}

// ============ app_settings CRUD ============

pub fn get_app_setting(key: &str) -> AppResult<Option<String>> {
    let conn = get().lock().unwrap();
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(result)
}

pub fn set_app_setting(key: &str, value: &str) -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// 根据 ID 获取任务
pub fn get_task_by_id(id: &str) -> AppResult<Option<models::TaskRecord>> {
    let conn = get().lock().unwrap();
    let task = conn.query_row(
        "SELECT id, type, status, title, params, progress, processed_rows, total_rows, current_target, error, error_details, output_path, description, created_at, updated_at, completed_at, connection_id, scope_database, scope_schema
         FROM task_records WHERE id = ?1",
        [id],
        |row| Ok(models::TaskRecord {
            id: row.get(0)?,
            type_: row.get(1)?,
            status: row.get(2)?,
            title: row.get(3)?,
            params: row.get(4)?,
            progress: row.get(5)?,
            processed_rows: row.get(6)?,
            total_rows: row.get(7)?,
            current_target: row.get(8)?,
            error: row.get(9)?,
            error_details: row.get(10)?,
            output_path: row.get(11)?,
            description: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            completed_at: row.get(15)?,
            connection_id: row.get(16)?,
            scope_database: row.get(17)?,
            scope_schema: row.get(18)?,
        }),
    ).optional()?;
    Ok(task)
}

// ============ change_history ============

pub fn insert_change_history(
    session_id: &str,
    tool_name: &str,
    target_type: &str,
    target_id: &str,
    old_value: &str,
) -> crate::AppResult<i64> {
    let conn = get().lock().unwrap();
    conn.execute(
        "INSERT INTO change_history (session_id, tool_name, target_type, target_id, old_value, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
        rusqlite::params![session_id, tool_name, target_type, target_id, old_value],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn complete_change_history(id: i64, new_value: Option<&str>, status: &str) -> crate::AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute(
        "UPDATE change_history SET new_value = ?1, status = ?2 WHERE id = ?3",
        rusqlite::params![new_value, status, id],
    )?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct ChangeHistoryRecord {
    pub id: i64,
    pub session_id: String,
    pub tool_name: String,
    pub target_type: String,
    pub target_id: String,
    pub old_value: String,
    pub new_value: Option<String>,
    pub status: String,
    pub created_at: String,
}

pub fn list_change_history(session_id: &str, limit: i64) -> crate::AppResult<Vec<ChangeHistoryRecord>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, tool_name, target_type, target_id, old_value, new_value, status, created_at
         FROM change_history WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2"
    )?;
    let records = stmt.query_map(rusqlite::params![session_id, limit], |row| {
        Ok(ChangeHistoryRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            tool_name: row.get(2)?,
            target_type: row.get(3)?,
            target_id: row.get(4)?,
            old_value: row.get(5)?,
            new_value: row.get(6)?,
            status: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?.filter_map(|r| r.ok()).collect();
    Ok(records)
}

pub fn get_last_success_change(session_id: &str) -> crate::AppResult<Option<ChangeHistoryRecord>> {
    let conn = get().lock().unwrap();
    let result = conn.query_row(
        "SELECT id, session_id, tool_name, target_type, target_id, old_value, new_value, status, created_at
         FROM change_history WHERE session_id = ?1 AND status = 'success' ORDER BY id DESC LIMIT 1",
        rusqlite::params![session_id],
        |row| Ok(ChangeHistoryRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            tool_name: row.get(2)?,
            target_type: row.get(3)?,
            target_id: row.get(4)?,
            old_value: row.get(5)?,
            new_value: row.get(6)?,
            status: row.get(7)?,
            created_at: row.get(8)?,
        }),
    ).optional().map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(result)
}

pub fn mark_change_undone(id: i64) -> crate::AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute(
        "UPDATE change_history SET status = 'undone' WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

// ============ Metric helpers for MCP tools ============

pub fn get_metric_by_id(metric_id: i64) -> crate::AppResult<Option<crate::metrics::Metric>> {
    let conn = get().lock().unwrap();
    let result = conn.query_row(
        "SELECT id,connection_id,name,display_name,table_name,column_name,aggregation,\
         filter_sql,description,status,source,metric_type,composite_components,\
         composite_formula,category,data_caliber,version,scope_database,scope_schema,\
         created_at,updated_at FROM metrics WHERE id=?1",
        [metric_id],
        |row| Ok(crate::metrics::Metric {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            name: row.get(2)?,
            display_name: row.get(3)?,
            table_name: row.get(4)?,
            column_name: row.get(5)?,
            aggregation: row.get(6)?,
            filter_sql: row.get(7)?,
            description: row.get(8)?,
            status: row.get(9)?,
            source: row.get(10)?,
            metric_type: row.get(11)?,
            composite_components: row.get(12)?,
            composite_formula: row.get(13)?,
            category: row.get(14)?,
            data_caliber: row.get(15)?,
            version: row.get(16)?,
            scope_database: row.get(17)?,
            scope_schema: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
        }),
    ).optional().map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(result)
}

pub fn update_metric_fields(
    metric_id: i64,
    description: Option<&str>,
    display_name: Option<&str>,
) -> crate::AppResult<crate::metrics::Metric> {
    let conn = get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET
            description = COALESCE(?2, description),
            display_name = COALESCE(?3, display_name),
            updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![metric_id, description, display_name],
    )?;
    let updated = conn.query_row(
        "SELECT id,connection_id,name,display_name,table_name,column_name,aggregation,\
         filter_sql,description,status,source,metric_type,composite_components,\
         composite_formula,category,data_caliber,version,scope_database,scope_schema,\
         created_at,updated_at FROM metrics WHERE id=?1",
        [metric_id],
        |row| Ok(crate::metrics::Metric {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            name: row.get(2)?,
            display_name: row.get(3)?,
            table_name: row.get(4)?,
            column_name: row.get(5)?,
            aggregation: row.get(6)?,
            filter_sql: row.get(7)?,
            description: row.get(8)?,
            status: row.get(9)?,
            source: row.get(10)?,
            metric_type: row.get(11)?,
            composite_components: row.get(12)?,
            composite_formula: row.get(13)?,
            category: row.get(14)?,
            data_caliber: row.get(15)?,
            version: row.get(16)?,
            scope_database: row.get(17)?,
            scope_schema: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
        }),
    ).map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(updated)
}

// ============ agent_sessions CRUD ============

/// 插入 agent session 记录
pub fn insert_agent_session(
    id: &str,
    title: Option<&str>,
    config_id: Option<i64>,
    is_temp: bool,
) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO agent_sessions (id, title, config_id, is_temp, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![id, title, config_id, is_temp as i64, now],
    )?;
    Ok(())
}

/// 删除指定 agent session 记录
pub fn delete_agent_session(id: &str) -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute("DELETE FROM agent_sessions WHERE id = ?1", [id])?;
    Ok(())
}

/// 查询 agent session 列表
/// include_temp=true 包含 is_temp=1 的临时 session
pub fn list_agent_sessions(include_temp: bool) -> AppResult<Vec<crate::commands::AgentSessionRecord>> {
    let conn = get().lock().unwrap();
    let sql = if include_temp {
        "SELECT id, title, config_id, created_at, updated_at FROM agent_sessions ORDER BY created_at DESC"
    } else {
        "SELECT id, title, config_id, created_at, updated_at FROM agent_sessions WHERE is_temp = 0 ORDER BY created_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(crate::commands::AgentSessionRecord {
            id: row.get(0)?,
            title: row.get(1)?,
            config_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// 删除所有 agent session 记录（包括临时 session）
pub fn delete_all_agent_sessions() -> AppResult<()> {
    let conn = get().lock().unwrap();
    conn.execute("DELETE FROM agent_sessions", [])?;
    Ok(())
}

pub fn create_metric_from_mcp(
    connection_id: i64,
    name: &str,
    display_name: &str,
    table_name: &str,
    description: &str,
) -> crate::AppResult<crate::metrics::Metric> {
    let input = crate::metrics::CreateMetricInput {
        connection_id,
        name: name.to_string(),
        display_name: display_name.to_string(),
        table_name: if table_name.is_empty() { None } else { Some(table_name.to_string()) },
        column_name: None,
        aggregation: None,
        filter_sql: None,
        description: if description.is_empty() { None } else { Some(description.to_string()) },
        source: Some("ai".to_string()),
        metric_type: Some("atomic".to_string()),
        composite_components: None,
        composite_formula: None,
        category: None,
        data_caliber: None,
        version: None,
        scope_database: None,
        scope_schema: None,
    };
    crate::metrics::save_metric(&input)
}
