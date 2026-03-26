use serde_json::{json, Value};
use std::sync::Arc;

/// 统一入口：处理 fs_*(resource="tab.seatunnel", ...) 的所有操作
pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    op: &str,
    target: &str,
    payload: Value,
    _session_id: String,
) -> crate::AppResult<String> {
    match op {
        "read"  => read(&handle, target).await,
        "write" => write(&handle, target, payload).await,
        "open"  => open(&handle, payload).await,
        "exec"  => exec(&handle, payload).await,
        _ => Err(crate::AppError::Other(format!("tab.seatunnel: unsupported op '{}'", op))),
    }
}

/// fs_read("tab.seatunnel", "<job_id>", "struct") → 通过前端获取 Job 内容
async fn read(handle: &Arc<tauri::AppHandle>, target: &str) -> crate::AppResult<String> {
    // 查找 seatunnel_job Tab 并获取内容（复用 get_tab_content 前端逻辑）
    // 先通过 search_tabs 找到 job 对应的 tab_id
    let job_id: i64 = target.parse()
        .map_err(|_| crate::AppError::Other(format!("tab.seatunnel: invalid job_id '{}', expected integer", target)))?;

    // 搜索 seatunnel_job 类型的 Tab
    let tabs_result = super::tab_control::query_frontend(
        handle,
        "search_tabs",
        json!({ "type": "seatunnel_job" }),
    ).await?;

    // 在结果中找到 job_id 匹配的 Tab
    let tab_id = tabs_result.as_array()
        .and_then(|arr| arr.iter().find(|t| t["job_id"].as_i64() == Some(job_id)))
        .and_then(|t| t["tab_id"].as_str())
        .map(|s| s.to_string());

    match tab_id {
        Some(tid) => {
            let content = super::tab_control::query_frontend(
                handle,
                "get_tab_content",
                json!({ "tab_id": tid }),
            ).await?;
            Ok(serde_json::to_string_pretty(&content).unwrap_or_default())
        }
        None => {
            // Tab 未打开，直接从 SQLite 读取 Job 配置
            let conn = crate::db::get().lock().unwrap();
            let result = conn.query_row(
                "SELECT id, name, config_json, category_id, connection_id FROM seatunnel_jobs WHERE id = ?1",
                rusqlite::params![job_id],
                |row| {
                    Ok(json!({
                        "job_id": row.get::<_, i64>(0)?,
                        "job_name": row.get::<_, String>(1)?,
                        "config_json": row.get::<_, Option<String>>(2)?,
                        "category_id": row.get::<_, Option<i64>>(3)?,
                        "connection_id": row.get::<_, Option<i64>>(4)?,
                    }))
                },
            ).map_err(|e| crate::AppError::Other(format!("SeaTunnel Job {} not found: {}", job_id, e)))?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
    }
}

/// fs_write("tab.seatunnel", "<job_id>", { config_json, job_name?, description? })
/// → 更新已有 Job（走 propose_seatunnel_job 的确认流程）
async fn write(handle: &Arc<tauri::AppHandle>, target: &str, patch: Value) -> crate::AppResult<String> {
    let job_id: i64 = target.parse()
        .map_err(|_| crate::AppError::Other(format!("tab.seatunnel write: invalid job_id '{}', expected integer", target)))?;

    let config_json = patch["config_json"].as_str()
        .ok_or_else(|| crate::AppError::Other("tab.seatunnel write: missing config_json".into()))?;
    let default_name = format!("Job #{}", job_id);
    let job_name = patch["job_name"].as_str().unwrap_or(&default_name);
    let description = patch["description"].as_str().unwrap_or("");

    // 复用 propose_seatunnel_job 的前端确认流程
    let result = super::tab_control::send_ui_action(
        handle,
        "propose_seatunnel_job",
        json!({
            "job_name": job_name,
            "config_json": config_json,
            "job_id": job_id,
            "description": description
        }),
    ).await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

/// fs_open("tab.seatunnel", { job_id }) → 打开 SeaTunnel Job Tab
async fn open(handle: &Arc<tauri::AppHandle>, params: Value) -> crate::AppResult<String> {
    let job_id = params["job_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("tab.seatunnel open: missing job_id".into()))?;

    let result = super::tab_control::send_ui_action(
        handle,
        "open_tab",
        json!({
            "type": "seatunnel_job",
            "job_id": job_id
        }),
    ).await?;

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

/// fs_exec("tab.seatunnel", "new", "create", { job_name, config_json, category_id?, description? })
/// → 创建新 Job（走 propose_seatunnel_job 的确认流程）
async fn exec(handle: &Arc<tauri::AppHandle>, payload: Value) -> crate::AppResult<String> {
    let action = payload["action"].as_str().unwrap_or("");
    let params = &payload["params"];

    match action {
        "create" => {
            let job_name = params["job_name"].as_str()
                .ok_or_else(|| crate::AppError::Other("tab.seatunnel exec create: missing job_name".into()))?;
            let config_json = params["config_json"].as_str()
                .ok_or_else(|| crate::AppError::Other("tab.seatunnel exec create: missing config_json".into()))?;
            let category_id = params["category_id"].as_i64();
            let description = params["description"].as_str().unwrap_or("");

            let result = super::tab_control::send_ui_action(
                handle,
                "propose_seatunnel_job",
                json!({
                    "job_name": job_name,
                    "config_json": config_json,
                    "category_id": category_id,
                    "description": description
                }),
            ).await?;

            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        _ => Err(crate::AppError::Other(format!("tab.seatunnel exec: unsupported action '{}'", action))),
    }
}
