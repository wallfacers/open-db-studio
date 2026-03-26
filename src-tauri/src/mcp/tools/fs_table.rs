use serde_json::{json, Value};
use std::sync::Arc;

/// 统一入口：处理 fs_*(resource="tab.table", ...) 的所有操作
pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    op: &str,
    target: &str,
    payload: Value,
    session_id: String,
) -> crate::AppResult<String> {
    match op {
        "read"  => read(Arc::clone(&handle), target).await,
        "write" => write(&handle, target, payload, session_id).await,
        "open"  => open(&handle, payload).await,
        "exec"  => exec(&handle, target, payload, session_id).await,
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

/// fs_write — 根据 action 分发到不同的表操作
///
/// action="update_comment" (默认):
///   {column_name:"user_id", comment:"..."}
///   {mode:"struct", path:"/column_name/comment", value:"..."}
///
/// action="modify_column":
///   {action:"modify_column", column_name:"old_name", changes:{name?, data_type?, length?, ...}}
async fn write(
    handle: &Arc<tauri::AppHandle>,
    target: &str,
    patch: Value,
    session_id: String,
) -> crate::AppResult<String> {
    let action = patch.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let (table_name, conn_id, target_db) = parse_target(target)?;
    let database = patch["database"].as_str().map(|s| s.to_string())
        .or(target_db).unwrap_or_default();

    match action {
        "modify_column" => {
            let args = json!({
                "connection_id": conn_id,
                "table_name":    table_name,
                "database":      database,
                "column_name":   patch["column_name"],
                "changes":       patch["changes"]
            });
            super::table_edit::modify_column(Arc::clone(handle), args, session_id).await
        }
        // 默认：update_comment（兼容旧格式）
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
            super::table_edit::update_column_comment(Arc::clone(handle), args, session_id).await
        }
    }
}

/// fs_exec("tab.table", ...) — 执行表结构操作
///
/// action="create_table":  { action:"create_table", params:{ connection_id, table_name, database?, columns:[...] } }
/// action="add_column":    { action:"add_column",   params:{ connection_id, table_name, database?, column:{...}, after_column? } }
/// action="drop_column":   { action:"drop_column",  params:{ connection_id, table_name, database?, column_name } }
async fn exec(
    handle: &Arc<tauri::AppHandle>,
    _target: &str,
    payload: Value,
    session_id: String,
) -> crate::AppResult<String> {
    let action = payload["action"].as_str().unwrap_or("");
    let params = &payload["params"];

    match action {
        "create_table" => {
            super::table_edit::create_table(Arc::clone(handle), params.clone(), session_id).await
        }
        "add_column" => {
            super::table_edit::add_column(Arc::clone(handle), params.clone(), session_id).await
        }
        "drop_column" => {
            super::table_edit::drop_column(Arc::clone(handle), params.clone(), session_id).await
        }
        _ => Err(crate::AppError::Other(format!("tab.table exec: unsupported action '{}'", action))),
    }
}

/// fs_open("tab.table", {table, database, connection_id}) → 打开表结构 Tab
async fn open(handle: &Arc<tauri::AppHandle>, params: Value) -> crate::AppResult<String> {
    let result = super::tab_control::send_ui_action(
        handle,
        "open_tab",
        json!({
            "type":          "table_structure",
            "table_name":    params["table"],
            "database":      params["database"],
            "connection_id": params["connection_id"]
        }),
    )
    .await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
