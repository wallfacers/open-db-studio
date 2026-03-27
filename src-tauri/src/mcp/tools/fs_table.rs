use serde_json::{json, Value};
use std::sync::Arc;

/// 统一入口：处理 fs_*(resource="tab.table", ...) 的所有操作
pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    op: &str,
    target: &str,
    payload: Value,
    _session_id: String,
) -> crate::AppResult<String> {
    match op {
        "read"  => read(Arc::clone(&handle), target).await,
        "write" => write(&handle, target, payload).await,
        "open"  => open(&handle, payload).await,
        "exec"  => exec(&handle, payload).await,
        _ => Err(crate::AppError::Other(format!("tab.table: unsupported op '{}'", op))),
    }
}

/// 解析 target 格式 "table_name@conn:N" 或 "table_name@conn:N@db:mydb"
fn parse_target(target: &str) -> crate::AppResult<(String, i64, Option<String>)> {
    let mut parts = target.splitn(2, "@conn:");
    let table_name = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| crate::AppError::Other(format!("tab.table: invalid target '{}', expected 'table@conn:N'", target)))?
        .to_string();

    let rest = parts
        .next()
        .ok_or_else(|| crate::AppError::Other(format!("tab.table: missing @conn: in target '{}'", target)))?;

    let (conn_str, database) = if let Some(idx) = rest.find("@db:") {
        (&rest[..idx], Some(rest[idx + 4..].to_string()))
    } else {
        (rest, None)
    };

    let conn_id: i64 = conn_str
        .parse()
        .map_err(|_| crate::AppError::Other(format!("tab.table: invalid conn_id in target '{}'", target)))?;

    Ok((table_name, conn_id, database))
}

/// fs_read("tab.table", "users@conn:1", "struct") → get_column_meta
async fn read(handle: Arc<tauri::AppHandle>, target: &str) -> crate::AppResult<String> {
    let (table_name, conn_id, database) = parse_target(target)?;
    let args = json!({
        "connection_id": conn_id,
        "table_name":    table_name,
        "database":      database
    });
    super::table_edit::get_column_meta(handle, args).await
}

/// fs_write — 生成 SQL 写入查询 Tab（不直接执行）
///
/// action="modify_column":
///   {action:"modify_column", column_name:"old_name", changes:{name?, data_type?, length?, ...}}
/// 默认 action="update_comment":
///   {column_name:"user_id", comment:"..."}
async fn write(
    handle: &Arc<tauri::AppHandle>,
    target: &str,
    patch: Value,
) -> crate::AppResult<String> {
    let action = patch.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let (table_name, conn_id, target_db) = parse_target(target)?;
    let database = patch["database"].as_str().map(|s| s.to_string())
        .or(target_db).unwrap_or_default();

    let sql = match action {
        "modify_column" => {
            let args = json!({
                "connection_id": conn_id,
                "table_name":    table_name,
                "database":      database,
                "column_name":   patch["column_name"],
                "changes":       patch["changes"]
            });
            super::table_edit::generate_modify_column_sql(&args).await?
        }
        // 默认：update_comment
        _ => {
            let (column_name, comment) = if patch.get("mode").and_then(|v| v.as_str()) == Some("struct") {
                let path = patch["path"].as_str().unwrap_or("").trim_start_matches('/');
                let mut path_parts = path.splitn(2, '/');
                let col = path_parts.next().unwrap_or("").to_string();
                let cmt = patch["value"].as_str().unwrap_or("").to_string();
                (col, cmt)
            } else {
                let col = patch["column_name"].as_str()
                    .ok_or_else(|| crate::AppError::Other("tab.table write: missing column_name".into()))?
                    .to_string();
                let cmt = patch["comment"].as_str()
                    .ok_or_else(|| crate::AppError::Other("tab.table write: missing comment".into()))?
                    .to_string();
                (col, cmt)
            };

            let args = json!({
                "connection_id": conn_id,
                "table_name":    table_name,
                "column_name":   column_name,
                "comment":       comment,
                "database":      database
            });
            super::table_edit::generate_update_comment_sql(&args).await?
        }
    };

    // 写入查询 Tab
    write_sql_to_query_tab(handle, conn_id, &database, &sql, action).await
}

/// fs_exec("tab.table", ...) — 生成 DDL 写入查询 Tab（不直接执行）
///
/// action="create_table":  { action:"create_table", params:{ connection_id, table_name, database?, columns:[...] } }
/// action="add_column":    { action:"add_column",   params:{ connection_id, table_name, database?, column:{...}, after_column? } }
/// action="drop_column":   { action:"drop_column",  params:{ connection_id, table_name, database?, column_name } }
async fn exec(
    handle: &Arc<tauri::AppHandle>,
    payload: Value,
) -> crate::AppResult<String> {
    let action = payload["action"].as_str().unwrap_or("");
    let params = &payload["params"];

    let sql = match action {
        "create_table" => super::table_edit::generate_create_table_sql(params)?,
        "add_column"   => super::table_edit::generate_add_column_sql(params)?,
        "drop_column"  => super::table_edit::generate_drop_column_sql(params)?,
        _ => return Err(crate::AppError::Other(format!("tab.table exec: unsupported action '{}'", action))),
    };

    let conn_id = params["connection_id"].as_i64().unwrap_or(0);
    let database = params["database"].as_str().unwrap_or("");

    write_sql_to_query_tab(handle, conn_id, database, &sql, action).await
}

/// fs_open("tab.table", {table, database, connection_id, initial_columns?, initial_table_name?})
/// → 打开表结构 Tab（支持预填列定义）
async fn open(handle: &Arc<tauri::AppHandle>, params: Value) -> crate::AppResult<String> {
    let mut action_params = json!({
        "type":          "table_structure",
        "table_name":    params["table"],
        "database":      params["database"],
        "connection_id": params["connection_id"]
    });
    // 透传预填列定义（AI 提案式创建表）
    if let Some(cols) = params.get("initial_columns") {
        action_params["initial_columns"] = cols.clone();
    }
    if let Some(name) = params.get("initial_table_name") {
        action_params["initial_table_name"] = name.clone();
    }

    let result = super::tab_control::send_ui_action(handle, "open_tab", action_params).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

// ─── 共享：将 SQL 写入查询 Tab ───────────────────────────────────────────────

/// 打开一个查询 Tab 并将生成的 SQL 写入，返回成功信息
async fn write_sql_to_query_tab(
    handle: &Arc<tauri::AppHandle>,
    conn_id: i64,
    database: &str,
    sql: &str,
    action_label: &str,
) -> crate::AppResult<String> {
    // 1. 打开新查询 Tab
    let open_result = super::tab_control::query_frontend(
        handle, "fs_request",
        json!({
            "op": "open",
            "resource": "tab.query",
            "target": "",
            "payload": { "connection_id": conn_id, "database": database }
        }),
    ).await?;

    let tab_id = open_result["target"].as_str().unwrap_or("active");

    // 2. 将 SQL 写入 Tab
    super::tab_control::query_frontend(
        handle, "fs_request",
        json!({
            "op": "write",
            "resource": "tab.query",
            "target": tab_id,
            "payload": {
                "mode": "text",
                "op": "replace_all",
                "content": sql,
                "reason": format!("AI generated {} SQL", action_label)
            }
        }),
    ).await?;

    Ok(json!({
        "success": true,
        "message": format!("已将 SQL 写入查询标签，请检查后手动执行（F5）。"),
        "tab_id": tab_id,
        "sql": sql
    }).to_string())
}
