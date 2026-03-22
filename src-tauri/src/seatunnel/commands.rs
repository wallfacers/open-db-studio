use crate::state::AppState;
use serde_json::json;
use tauri::Emitter;

// ─── 事件结构体 ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct StLogEvent {
    job_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct StStreamErrorEvent {
    job_id: String,
    reason: String,
}

#[derive(serde::Serialize, Clone)]
struct StJobFinishedEvent {
    job_id: String,
    status: String,
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/// 从 DB 读取 seatunnel_connections，解密 token，创建 SeaTunnelClient
pub(crate) fn get_st_client(
    _state: &AppState,
    connection_id: i64,
) -> Result<super::client::SeaTunnelClient, String> {
    let conn = crate::db::get().lock().unwrap();
    let result: rusqlite::Result<(String, Option<String>)> = conn.query_row(
        "SELECT url, auth_token_enc FROM seatunnel_connections WHERE id = ?1",
        rusqlite::params![connection_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );

    let (url, auth_token_enc) = result.map_err(|e| format!("Connection not found: {}", e))?;

    let auth_token = match auth_token_enc {
        Some(enc) if !enc.is_empty() => {
            Some(crate::crypto::decrypt(&enc).map_err(|e| format!("Decrypt token failed: {}", e))?)
        }
        _ => None,
    };

    Ok(super::client::SeaTunnelClient::new(url, auth_token))
}

// ─── 连接管理 CRUD ────────────────────────────────────────────────────────────

/// 列出所有 SeaTunnel 连接（不含明文 token）
#[tauri::command]
pub async fn list_st_connections(
    _state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, url, created_at FROM seatunnel_connections ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "url": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 新建 SeaTunnel 连接，token AES-256-GCM 加密存储
#[tauri::command]
pub async fn create_st_connection(
    _state: tauri::State<'_, AppState>,
    name: String,
    url: String,
    auth_token: Option<String>,
) -> Result<i64, String> {
    let auth_token_enc = match auth_token {
        Some(t) if !t.is_empty() => {
            Some(crate::crypto::encrypt(&t).map_err(|e| format!("Encrypt token failed: {}", e))?)
        }
        _ => None,
    };

    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO seatunnel_connections (name, url, auth_token_enc, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, url, auth_token_enc, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

/// 编辑 SeaTunnel 连接
#[tauri::command]
pub async fn update_st_connection(
    _state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    url: String,
    auth_token: Option<String>,
) -> Result<(), String> {
    let auth_token_enc = match auth_token {
        Some(t) if !t.is_empty() => {
            Some(crate::crypto::encrypt(&t).map_err(|e| format!("Encrypt token failed: {}", e))?)
        }
        _ => None,
    };

    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE seatunnel_connections SET name = ?1, url = ?2, auth_token_enc = ?3 WHERE id = ?4",
        rusqlite::params![name, url, auth_token_enc, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 删除 SeaTunnel 连接
#[tauri::command]
pub async fn delete_st_connection(
    _state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    // 先删除直属集群且无 category 的孤儿 Job，再删连接（DDL CASCADE 会删根目录及子目录）
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM seatunnel_jobs WHERE connection_id = ?1 AND category_id IS NULL",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM seatunnel_connections WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ─── 分类管理 ─────────────────────────────────────────────────────────────────

/// 获取全部分类
#[tauri::command]
pub async fn list_st_categories(
    _state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, parent_id, connection_id, sort_order FROM seatunnel_categories ORDER BY sort_order, name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "parent_id": row.get::<_, Option<i64>>(2)?,
                "connection_id": row.get::<_, Option<i64>>(3)?,
                "sort_order": row.get::<_, i64>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 新建分类
#[tauri::command]
pub async fn create_st_category(
    _state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<i64>,
    connection_id: Option<i64>,
) -> Result<i64, String> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM seatunnel_categories WHERE parent_id IS ?1",
            rusqlite::params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(1);

    conn.execute(
        "INSERT INTO seatunnel_categories (name, parent_id, connection_id, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![name, parent_id, connection_id, sort_order, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

/// 重命名分类
#[tauri::command]
pub async fn rename_st_category(
    _state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE seatunnel_categories SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除分类（级联删除子分类由 DDL ON DELETE CASCADE 保证）
#[tauri::command]
pub async fn delete_st_category(
    _state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "DELETE FROM seatunnel_categories WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 移动分类
#[tauri::command]
pub async fn move_st_category(
    _state: tauri::State<'_, AppState>,
    id: i64,
    parent_id: Option<i64>,
    sort_order: i64,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE seatunnel_categories SET parent_id = ?1, sort_order = ?2 WHERE id = ?3",
        rusqlite::params![parent_id, sort_order, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Job 管理 ─────────────────────────────────────────────────────────────────

/// 列出所有 Job
#[tauri::command]
pub async fn list_st_jobs(
    _state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, category_id, connection_id, config_json, last_job_id, last_status, submitted_at, created_at, updated_at \
             FROM seatunnel_jobs ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "category_id": row.get::<_, Option<i64>>(2)?,
                "connection_id": row.get::<_, Option<i64>>(3)?,
                "config_json": row.get::<_, Option<String>>(4)?,
                "last_job_id": row.get::<_, Option<String>>(5)?,
                "last_status": row.get::<_, Option<String>>(6)?,
                "submitted_at": row.get::<_, Option<String>>(7)?,
                "created_at": row.get::<_, String>(8)?,
                "updated_at": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// 新建 Job
#[tauri::command]
pub async fn create_st_job(
    _state: tauri::State<'_, AppState>,
    name: String,
    category_id: Option<i64>,
    connection_id: Option<i64>,
) -> Result<i64, String> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO seatunnel_jobs (name, category_id, connection_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![name, category_id, connection_id, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// 保存 Job 配置（部分字段更新）
#[tauri::command]
pub async fn update_st_job(
    _state: tauri::State<'_, AppState>,
    id: i64,
    name: Option<String>,
    category_id: Option<i64>,
    connection_id: Option<i64>,
    config_json: Option<String>,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // 读取现有值
    let (cur_name, cur_category_id, cur_connection_id, cur_config_json): (
        String,
        Option<i64>,
        Option<i64>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT name, category_id, connection_id, config_json FROM seatunnel_jobs WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("Job not found: {}", e))?;

    let new_name = name.unwrap_or(cur_name);
    let new_category_id = category_id.or(cur_category_id);
    let new_connection_id = connection_id.or(cur_connection_id);
    let new_config_json = config_json.or(cur_config_json);

    conn.execute(
        "UPDATE seatunnel_jobs SET name = ?1, category_id = ?2, connection_id = ?3, config_json = ?4, updated_at = ?5 WHERE id = ?6",
        rusqlite::params![new_name, new_category_id, new_connection_id, new_config_json, now, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 删除 Job
#[tauri::command]
pub async fn delete_st_job(
    _state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "DELETE FROM seatunnel_jobs WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名 Job
#[tauri::command]
pub async fn rename_st_job(
    _state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE seatunnel_jobs SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![name, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err(format!("Job {} not found", id));
    }
    Ok(())
}

/// 移动 Job 到指定分类
#[tauri::command]
pub async fn move_st_job(
    _state: tauri::State<'_, AppState>,
    job_id: i64,
    category_id: Option<i64>,
) -> Result<(), String> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE seatunnel_jobs SET category_id = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![category_id, now, job_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── 运行控制 ─────────────────────────────────────────────────────────────────

/// 提交 Job 到 SeaTunnel，返回 SeaTunnel jobId，同时更新 DB
#[tauri::command]
pub async fn submit_st_job(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    job_id: i64,
) -> Result<String, String> {
    // 读取 job 信息
    let (config_json, connection_id): (Option<String>, Option<i64>) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT config_json, connection_id FROM seatunnel_jobs WHERE id = ?1",
            rusqlite::params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Job not found: {}", e))?
    };

    let config = config_json.ok_or("Job has no config_json")?;
    let conn_id = connection_id.ok_or("Job has no connection_id")?;

    let client = get_st_client(&state, conn_id)?;
    let st_job_id = client.submit_job(&config).await?;

    // 更新 DB
    {
        let conn = crate::db::get().lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE seatunnel_jobs SET last_job_id = ?1, last_status = 'RUNNING', submitted_at = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![st_job_id, now, now, job_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(st_job_id)
}

/// 停止 SeaTunnel Job
#[tauri::command]
pub async fn stop_st_job(
    state: tauri::State<'_, AppState>,
    job_id: i64,
) -> Result<(), String> {
    // 读取 last_job_id 和 connection_id
    let (last_job_id, connection_id): (Option<String>, Option<i64>) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT last_job_id, connection_id FROM seatunnel_jobs WHERE id = ?1",
            rusqlite::params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Job not found: {}", e))?
    };

    let st_job_id = last_job_id.ok_or("Job has not been submitted yet")?;
    let conn_id = connection_id.ok_or("Job has no connection_id")?;

    let client = get_st_client(&state, conn_id)?;
    client.stop_job(&st_job_id).await?;

    // 更新状态
    {
        let conn = crate::db::get().lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE seatunnel_jobs SET last_status = 'CANCELED', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, job_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 查询 SeaTunnel Job 当前状态（job_id 为 SeaTunnel jobId 字符串）
/// 通过 last_job_id 查找对应的 connection_id
#[tauri::command]
pub async fn get_st_job_status(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<String, String> {
    // 通过 SeaTunnel job_id 查找对应的 connection_id
    let connection_id: Option<i64> = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT connection_id FROM seatunnel_jobs WHERE last_job_id = ?1 LIMIT 1",
            rusqlite::params![job_id],
            |row| row.get(0),
        )
        .ok()
        .flatten()
    };

    let conn_id = connection_id.ok_or_else(|| format!("No job found with SeaTunnel job_id: {}", job_id))?;
    let client = get_st_client(&state, conn_id)?;
    client.get_job_status(&job_id).await
}

/// 流式拉取日志，emit "st_job_log" / "st_job_finished" / "st_job_stream_error" 事件
#[tauri::command]
pub async fn stream_st_job_logs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: i64,
    job_id: String,
) -> Result<(), String> {
    let key = format!("st_log_{}", job_id);

    // 先取消同 job_id 的已有流
    {
        let mut handles = state.task_abort_handles.lock().unwrap();
        if let Some(h) = handles.remove(&key) {
            h.abort();
        }
    } // MutexGuard drop

    let client = get_st_client(&state, connection_id)?;
    let job_id_clone = job_id.clone();
    let app_clone = app.clone();

    let handle = tokio::spawn(async move {
        let job_id_cb = job_id_clone.clone();
        let app_log = app_clone.clone();
        let result = client
            .stream_logs_with_callback(&job_id_clone, move |line| {
                let _ = app_log.emit(
                    "st_job_log",
                    StLogEvent {
                        job_id: job_id_cb.clone(),
                        line,
                    },
                );
            })
            .await;

        match result {
            Ok(final_status) => {
                let _ = app_clone.emit(
                    "st_job_finished",
                    StJobFinishedEvent {
                        job_id: job_id_clone,
                        status: final_status,
                    },
                );
            }
            Err(reason) => {
                let _ = app_clone.emit(
                    "st_job_stream_error",
                    StStreamErrorEvent {
                        job_id: job_id_clone,
                        reason,
                    },
                );
            }
        }
    });

    // 注册 AbortHandle
    {
        let mut handles = state.task_abort_handles.lock().unwrap();
        handles.insert(key, handle.abort_handle());
    } // MutexGuard drop

    Ok(())
}

/// 测试 SeaTunnel 连接（使用运行中任务列表接口验证连通性）
#[tauri::command]
pub async fn test_st_connection(
    _state: tauri::State<'_, AppState>,
    url: String,
    auth_token: Option<String>,
) -> Result<(), String> {
    let client = super::client::SeaTunnelClient::new(url, auth_token);
    client.test_connection().await
}

/// 取消日志流
#[tauri::command]
pub async fn cancel_st_job_stream(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let key = format!("st_log_{}", job_id);
    {
        let mut handles = state.task_abort_handles.lock().unwrap();
        if let Some(h) = handles.remove(&key) {
            h.abort();
        }
    }
    Ok(())
}
