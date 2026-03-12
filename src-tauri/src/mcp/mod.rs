use axum::{routing::{get, post}, Router, Json, extract::State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    pub _jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self { jsonrpc: "2.0".into(), id, result: Some(result), error: None }
    }
    pub fn err(id: Option<Value>, code: i32, msg: &str) -> Self {
        Self {
            jsonrpc: "2.0".into(), id,
            result: None,
            error: Some(json!({ "code": code, "message": msg })),
        }
    }
}

#[derive(Serialize, Clone)]
struct DiffProposalPayload {
    original: String,
    modified: String,
    reason: String,
}

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "list_databases",
                "description": "List all databases for a connection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Connection ID" }
                    },
                    "required": ["connection_id"]
                }
            },
            {
                "name": "list_tables",
                "description": "List all tables in a database",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "database"]
                }
            },
            {
                "name": "get_table_schema",
                "description": "Get column definitions, indexes, and foreign keys for a table",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "table"]
                }
            },
            {
                "name": "get_table_sample",
                "description": "Get sample rows from a table (max 20 rows)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["connection_id", "table"]
                }
            },
            {
                "name": "execute_sql",
                "description": "Execute a read-only SQL query (SELECT/WITH/SHOW only, max 100 rows)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "sql": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "sql"]
                }
            },
            {
                "name": "propose_sql_diff",
                "description": "Propose a SQL modification to the active editor tab. Shows a diff preview that the user must confirm before it takes effect. Always call this after reading the current SQL to ensure 'original' matches exactly.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "original": {
                            "type": "string",
                            "description": "The exact original SQL statement text as it appears in the editor (must match precisely)"
                        },
                        "modified": {
                            "type": "string",
                            "description": "The new SQL statement text after modification"
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief explanation of why this change is being proposed (shown to user)"
                        }
                    },
                    "required": ["original", "modified", "reason"]
                }
            }
        ]
    })
}

async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value) -> crate::AppResult<String> {
    match name {
        "list_databases" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let dbs = ds.list_databases().await?;
            Ok(serde_json::to_string_pretty(&dbs).unwrap_or_default())
        }
        "list_tables" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let database = args["database"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing database".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_db(&config, database).await?;
            let tables = ds.list_objects(database, None, "tables").await?;
            Ok(serde_json::to_string_pretty(&tables).unwrap_or_default())
        }
        "get_table_schema" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            // 验证表名只含合法字符（防止 SQL 注入）
            if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err(crate::AppError::Other("Invalid table name".into()));
            }
            let database = args["database"].as_str();
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let columns = ds.get_columns(table, None).await?;
            let indexes = ds.get_indexes(table, None).await?;
            let foreign_keys = ds.get_foreign_keys(table, None).await?;
            let detail = crate::datasource::TableDetail {
                name: table.to_string(),
                columns,
                indexes,
                foreign_keys,
            };
            Ok(serde_json::to_string_pretty(&detail).unwrap_or_default())
        }
        "get_table_sample" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            // 验证表名只含合法字符（防止 SQL 注入）
            if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err(crate::AppError::Other("Invalid table name".into()));
            }
            let database = args["database"].as_str();
            let limit = args["limit"].as_u64().unwrap_or(5).min(20);
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let sql = format!("SELECT * FROM `{}` LIMIT {}", table, limit);
            let result = ds.execute(&sql).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "execute_sql" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let sql = args["sql"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing sql".into()))?;
            let database = args["database"].as_str();
            let trimmed = sql.trim().to_uppercase();
            if !trimmed.starts_with("SELECT")
                && !trimmed.starts_with("WITH")
                && !trimmed.starts_with("SHOW") {
                return Err(crate::AppError::Other("Only SELECT/WITH/SHOW allowed".into()));
            }
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let mut result = ds.execute(sql).await?;
            result.rows.truncate(100);
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "propose_sql_diff" => {
            use tauri::Emitter;
            let original = args["original"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing original".into()))?
                .to_string();
            let modified = args["modified"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing modified".into()))?
                .to_string();
            let reason = args["reason"].as_str()
                .unwrap_or("")
                .to_string();
            handle.emit("sql-diff-proposal", DiffProposalPayload { original, modified, reason })
                .map_err(|e| crate::AppError::Other(e.to_string()))?;
            Ok("diff proposed, waiting for user confirmation".to_string())
        }
        _ => Err(crate::AppError::Other(format!("Unknown tool: {}", name))),
    }
}

/// GET /mcp — SSE endpoint for Streamable HTTP transport.
///
/// The MCP Streamable HTTP spec (2025-03-26) allows clients to open a GET SSE
/// connection to receive server-initiated events. This server never pushes events,
/// but we must respond to GET immediately (with a keep-alive SSE stream) so that
/// opencode-cli does not wait for a timeout before falling back to POST-only mode.
async fn handle_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_mcp(
    State(handle): State<Arc<tauri::AppHandle>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        // MCP 握手：必须在 tools/list 之前完成，否则客户端会重试/超时
        "initialize" => Json(JsonRpcResponse::ok(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-db-studio", "version": "0.1.0" }
        }))),
        // 通知类型（无 id），客户端不等响应，返回空 result 即可
        "notifications/initialized" => Json(JsonRpcResponse::ok(id, json!(null))),
        "tools/list" => Json(JsonRpcResponse::ok(id, tool_definitions())),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            match call_tool(Arc::clone(&handle), &name, args).await {
                Ok(text) => Json(JsonRpcResponse::ok(id, json!({
                    "content": [{ "type": "text", "text": text }]
                }))),
                Err(e) => Json(JsonRpcResponse::err(id, -32000, &e.to_string())),
            }
        }
        _ => Json(JsonRpcResponse::err(id, -32601, "Method not found")),
    }
}

pub async fn start_mcp_server(app_handle: tauri::AppHandle) -> crate::AppResult<u16> {
    // 优先使用固定端口便于调试；若已被占用则退回随机端口
    let listener = TcpListener::bind("127.0.0.1:19876")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| crate::AppError::Other(format!("MCP server bind failed: {}", e)))?;
    let port = listener.local_addr()
        .map_err(|e| crate::AppError::Other(e.to_string()))?.port();

    let app = Router::new()
        .route("/mcp", get(handle_mcp_sse))
        .route("/mcp", post(handle_mcp))
        .with_state(Arc::new(app_handle));

    listener.set_nonblocking(true)
        .map_err(|e| crate::AppError::Other(format!("MCP set_nonblocking failed: {}", e)))?;
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("listener convert");
        axum::serve(listener, app).await.expect("MCP server failed");
    });

    log::info!("MCP server started on port {}", port);
    Ok(port)
}
