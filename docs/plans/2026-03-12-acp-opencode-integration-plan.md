# ACP + opencode 集成实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 opencode（via ACP 协议）替换现有自建 Agent Loop，让 Anthropic 和 OpenAI 模型都能原生支持工具调用，实现真正的 think-act-think 循环。

**Architecture:** Rust 实现 ACP Client（`agent-client-protocol` crate）启动 `opencode acp` 子进程，Rust 同时运行 MCP HTTP Server（axum）暴露数据库工具，前端 aiStore 改调新的 `ai_chat_acp` Tauri 命令，删除旧的 agentLoop.ts / toolCatalog.ts。

**Tech Stack:** Rust + `agent-client-protocol 0.10` + `axum 0.7`（MCP server）+ TypeScript/Zustand（前端）

**前置条件：** 系统已安装 opencode（`opencode acp` 可执行）

---

## 现有代码概览（实现前必读）

| 文件 | 关键内容 |
|------|---------|
| `src-tauri/Cargo.toml` | 现有依赖，需新增 `agent-client-protocol`、`axum` |
| `src-tauri/src/lib.rs` | Tauri 命令注册、app setup |
| `src-tauri/src/commands.rs` | 现有命令，含 `ai_chat_stream_with_tools`、`agent_*` |
| `src-tauri/src/llm/client.rs` | LlmClient、StreamEvent |
| `src/store/aiStore.ts` | `sendAgentChatStream`（需改造） |
| `src/agent/agentLoop.ts` | 旧循环（待删除） |
| `src/agent/toolCatalog.ts` | 旧工具目录（待删除） |

---

## Task 1：新增 Cargo 依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Step 1: 在 `[dependencies]` 末尾添加新依赖**

在 `once_cell` 行后面追加：
```toml
# ACP 协议客户端（连接 opencode agent）
agent-client-protocol = "0.10"

# MCP HTTP Server（暴露数据库工具给 opencode）
axum = { version = "0.7", features = ["http1", "json"] }
tower = "0.4"
```

**Step 2: 验证编译**

```bash
cd src-tauri && cargo check 2>&1
```

期望：无报错（可能有 warning，忽略）

**Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "feat(deps): add agent-client-protocol and axum for ACP+MCP integration"
```

---

## Task 2：AppState — 共享状态结构体

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 创建 `src-tauri/src/state.rs`**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    /// MCP HTTP Server 监听的端口（App 启动后设置，之后只读）
    pub mcp_port: u16,
    /// 当前活跃的 ACP 会话（None = 尚未建立）
    pub acp_session: Arc<Mutex<Option<AcpSession>>>,
}

/// ACP 会话上下文
pub struct AcpSession {
    pub session_id: String,
    pub connection: Arc<agent_client_protocol::ClientSideConnection>,
    pub child_handle: tokio::process::Child,
}
```

**Step 2: 修改 `src-tauri/src/lib.rs`，在 mod 列表中加入新模块**

在 `mod commands;` 之前加：
```rust
mod acp;
mod mcp;
mod state;
```

在 `pub use error::{AppError, AppResult};` 后加：
```rust
pub use state::AppState;
```

**Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

期望：无报错

**Step 4: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(state): add AppState and AcpSession shared state structs"
```

---

## Task 3：MCP HTTP Server — 骨架

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`

MCP 协议（JSON-RPC 2.0）说明：
- `tools/list`：返回工具列表
- `tools/call`：调用工具，返回结果

**Step 1: 创建目录和文件 `src-tauri/src/mcp/mod.rs`**

```rust
use axum::{routing::post, Router, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;

// JSON-RPC 2.0 请求
#[derive(Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

// JSON-RPC 2.0 响应
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

/// 工具定义（tools/list 返回格式）
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
                        "limit": { "type": "integer", "description": "Max rows (default 5, max 20)" }
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
            }
        ]
    })
}

/// MCP 请求 handler
async fn handle_mcp(Json(req): Json<JsonRpcRequest>) -> Json<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "tools/list" => {
            Json(JsonRpcResponse::ok(id, tool_definitions()))
        }
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            match call_tool(&name, args).await {
                Ok(text) => Json(JsonRpcResponse::ok(id, json!({
                    "content": [{ "type": "text", "text": text }]
                }))),
                Err(e) => Json(JsonRpcResponse::err(id, -32000, &e.to_string())),
            }
        }
        _ => Json(JsonRpcResponse::err(id, -32601, "Method not found")),
    }
}

/// 执行工具调用
async fn call_tool(name: &str, args: Value) -> crate::AppResult<String> {
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
            let database = args["database"].as_str().map(|s| s.to_string());
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_context(
                &config, database.as_deref(), None
            ).await?;
            let tables = ds.list_objects("tables").await?;
            Ok(serde_json::to_string_pretty(&tables).unwrap_or_default())
        }
        "get_table_schema" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            let database = args["database"].as_str().map(|s| s.to_string());
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_context(
                &config, database.as_deref(), None
            ).await?;
            let detail = ds.get_table_detail(table, None).await?;
            Ok(serde_json::to_string_pretty(&detail).unwrap_or_default())
        }
        "get_table_sample" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            let database = args["database"].as_str().map(|s| s.to_string());
            let limit = args["limit"].as_u64().unwrap_or(5).min(20);
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_context(
                &config, database.as_deref(), None
            ).await?;
            let sql = format!("SELECT * FROM {} LIMIT {}", table, limit);
            let result = ds.execute(&sql).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "execute_sql" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let sql = args["sql"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing sql".into()))?;
            let database = args["database"].as_str().map(|s| s.to_string());
            // 安全检查：仅允许 SELECT/WITH/SHOW
            let trimmed = sql.trim().to_uppercase();
            if !trimmed.starts_with("SELECT")
                && !trimmed.starts_with("WITH")
                && !trimmed.starts_with("SHOW") {
                return Err(crate::AppError::Other("Only SELECT/WITH/SHOW allowed".into()));
            }
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_context(
                &config, database.as_deref(), None
            ).await?;
            let mut result = ds.execute(sql).await?;
            // 截断到100行
            if let Some(rows) = &mut result.rows {
                rows.truncate(100);
            }
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        _ => Err(crate::AppError::Other(format!("Unknown tool: {}", name))),
    }
}

/// 启动 MCP HTTP Server，返回实际绑定的端口
pub async fn start_mcp_server() -> crate::AppResult<u16> {
    // 绑定 0 让 OS 分配随机端口
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| crate::AppError::Other(format!("MCP server bind failed: {}", e)))?;
    let port = listener.local_addr()
        .map_err(|e| crate::AppError::Other(e.to_string()))?.port();

    let app = Router::new().route("/mcp", post(handle_mcp));

    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("listener convert");
        axum::serve(listener, app).await.expect("MCP server failed");
    });

    log::info!("MCP server started on port {}", port);
    Ok(port)
}
```

**Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

期望：无报错（需确认 `list_objects`、`get_table_detail` 方法名与实际 datasource trait 一致，如不一致按实际方法名修改）

**Step 3: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): add MCP HTTP server exposing 5 database tools"
```

---

## Task 4：Config Bridge — LLM 配置写入 opencode.json

**Files:**
- Create: `src-tauri/src/acp/mod.rs`
- Create: `src-tauri/src/acp/config.rs`

**Step 1: 创建 `src-tauri/src/acp/mod.rs`**

```rust
pub mod config;
pub mod client;
```

**Step 2: 创建 `src-tauri/src/acp/config.rs`**

```rust
use serde_json::json;
use std::path::PathBuf;

/// 将我们的 LLM 配置写入 opencode.json（在 cwd 目录），供 opencode 读取
/// 返回写入的文件路径
pub fn write_opencode_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,  // "openai" | "anthropic"
    cwd: &PathBuf,
) -> crate::AppResult<()> {
    let config = match api_type {
        "anthropic" => {
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("anthropic/{}", model)
            };
            json!({
                "model": model_str,
                "providers": {
                    "anthropic": {
                        "apiKey": api_key
                    }
                }
            })
        }
        _ => {
            // openai 兼容
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("openai/{}", model)
            };
            let mut provider = json!({ "apiKey": api_key });
            if let Some(url) = base_url {
                if !url.is_empty() {
                    provider["baseURL"] = json!(url);
                }
            }
            json!({
                "model": model_str,
                "providers": {
                    "openai": provider
                }
            })
        }
    };

    let config_path = cwd.join("opencode.json");
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| crate::AppError::Other(format!("Config serialize error: {}", e)))?;
    std::fs::write(&config_path, content)
        .map_err(|e| crate::AppError::Other(format!("Config write error: {}", e)))?;

    log::info!("Wrote opencode.json to {:?}", config_path);
    Ok(())
}
```

**Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

期望：无报错

**Step 4: Commit**

```bash
git add src-tauri/src/acp/mod.rs src-tauri/src/acp/config.rs
git commit -m "feat(acp): add config bridge to write opencode.json from LLM settings"
```

---

## Task 5：ACP Client — 实现 Client trait 并管理 opencode 进程

**Files:**
- Create: `src-tauri/src/acp/client.rs`

**Step 1: 创建 `src-tauri/src/acp/client.rs`**

```rust
use agent_client_protocol::{
    Client, ClientSideConnection, InitializeRequest, NewSessionRequest,
    PromptRequest, ContentBlock, TextContent, SessionNotification, SessionUpdate,
    RequestPermissionRequest, RequestPermissionResponse, ProtocolVersion,
};
use async_trait::async_trait;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::process::Command;
use std::process::Stdio;

use crate::llm::StreamEvent;

/// 实现 ACP Client trait — 将 opencode 的流式事件转为 StreamEvent 发送给前端
pub struct AcpClientHandler {
    pub tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
}

#[async_trait]
impl Client for AcpClientHandler {
    async fn session_notification(
        &self,
        notif: SessionNotification,
    ) -> anyhow::Result<()> {
        if let Some(update) = notif.update {
            match update {
                SessionUpdate::AgentMessageChunk(chunk) => {
                    if let ContentBlock::Text(t) = chunk.content {
                        let _ = self.tx.send(StreamEvent::ContentChunk { delta: t.text });
                    }
                }
                SessionUpdate::AgentThoughtChunk(chunk) => {
                    if let ContentBlock::Text(t) = chunk.content {
                        let _ = self.tx.send(StreamEvent::ThinkingChunk { delta: t.text });
                    }
                }
                SessionUpdate::ToolCall(tc) => {
                    // 通知前端当前正在调用哪个工具
                    let _ = self.tx.send(StreamEvent::ToolCallRequest {
                        call_id: tc.id.to_string(),
                        name: tc.title.unwrap_or_else(|| "unknown".into()),
                        arguments: String::new(),
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn request_permission(
        &self,
        _req: RequestPermissionRequest,
    ) -> anyhow::Result<RequestPermissionResponse> {
        // 数据库工具都是只读的，直接 allow
        Ok(RequestPermissionResponse::allow_once())
    }
}

/// 启动 opencode ACP 子进程并完成握手，返回连接和会话 ID
pub async fn start_acp_session(
    mcp_port: u16,
    cwd: &std::path::Path,
    tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
) -> crate::AppResult<(
    Arc<ClientSideConnection>,
    String,
    tokio::process::Child,
)> {
    // 启动 opencode 子进程（ACP 模式）
    let mut child = Command::new("opencode")
        .arg("acp")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode: {}", e)))?;

    let stdin = child.stdin.take()
        .ok_or_else(|| crate::AppError::Other("No stdin".into()))?;
    let stdout = child.stdout.take()
        .ok_or_else(|| crate::AppError::Other("No stdout".into()))?;

    let handler = Arc::new(AcpClientHandler { tx });

    let (connection, io_future) = ClientSideConnection::new(
        handler,
        stdin,
        stdout,
        |fut| { tokio::spawn(fut); },
    );
    tokio::spawn(io_future);

    let connection = Arc::new(connection);

    // 握手
    connection.initialize(
        InitializeRequest::new(ProtocolVersion::LATEST)
    ).await
        .map_err(|e| crate::AppError::Other(format!("ACP initialize failed: {}", e)))?;

    // 创建会话（注入 MCP server）
    let mcp_url = format!("http://127.0.0.1:{}/mcp", mcp_port);
    let session_resp = connection.new_session(
        NewSessionRequest::new(cwd)
            .mcp_servers(vec![
                agent_client_protocol::McpServer::new_http("db-tools", &mcp_url),
            ])
    ).await
        .map_err(|e| crate::AppError::Other(format!("ACP new_session failed: {}", e)))?;

    let session_id = session_resp.session_id.to_string();
    Ok((connection, session_id, child))
}
```

> **注意：** `McpServer::new_http`、`RequestPermissionResponse::allow_once()`、`ToolCall.id`、`ToolCall.title` 等 API 名称需根据实际 `agent-client-protocol 0.10` docs.rs 文档确认，如有差异按实际 API 调整。

**Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

如报错 `McpServer::new_http` 不存在，查阅 docs.rs 找正确的构造方式：
```bash
# 查看 McpServer 类型
cd src-tauri && cargo doc --open 2>&1
```

**Step 3: Commit**

```bash
git add src-tauri/src/acp/client.rs
git commit -m "feat(acp): implement ACP client handler and session setup"
```

---

## Task 6：新 Tauri 命令 — `ai_chat_acp` + `cancel_acp_session`

**Files:**
- Modify: `src-tauri/src/commands.rs`（末尾追加）
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `commands.rs` 末尾追加两个新命令**

```rust
// ============ ACP Agent 模式 ============

/// ACP 对话：通过 opencode agent 处理用户消息
/// - 首次调用：写 opencode.json → spawn opencode → initialize → new_session → prompt
/// - 后续调用：复用已有 session → prompt
#[tauri::command]
pub async fn ai_chat_acp(
    prompt: String,
    connection_id: Option<i64>,
    tab_sql: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    // 获取活跃 LLM 配置
    let config = crate::db::get_default_llm_config()?;
    let api_key = crate::db::get_llm_config_key(config.id)?;

    // 工作目录：app data dir（已存在）
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into())
    ).join("open-db-studio");
    std::fs::create_dir_all(&cwd).ok();

    // 写 opencode.json
    crate::acp::config::write_opencode_config(
        &api_key,
        Some(&config.base_url),
        &config.model,
        &config.api_type,
        &cwd,
    )?;

    // 创建流事件 channel (tx → channel, rx → streaming loop)
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::llm::StreamEvent>();

    // 转发 rx → Tauri Channel（在独立 task 中）
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 获取或创建 ACP session
    let mut session_guard = state.acp_session.lock().await;
    let (connection, session_id) = if let Some(sess) = session_guard.as_ref() {
        (sess.connection.clone(), sess.session_id.clone())
    } else {
        let (conn, sid, child) = crate::acp::client::start_acp_session(
            state.mcp_port, &cwd, tx.clone()
        ).await?;
        *session_guard = Some(crate::state::AcpSession {
            session_id: sid.clone(),
            connection: conn.clone(),
            child_handle: child,
        });
        (conn, sid)
    };
    drop(session_guard);

    // 构建 prompt 内容块（注入当前 SQL 作为上下文）
    let mut content_blocks = vec![
        agent_client_protocol::ContentBlock::Text(
            agent_client_protocol::TextContent {
                text: prompt.clone(),
                ..Default::default()
            }
        )
    ];
    if let Some(sql) = tab_sql {
        if !sql.trim().is_empty() {
            content_blocks.insert(0, agent_client_protocol::ContentBlock::Text(
                agent_client_protocol::TextContent {
                    text: format!("当前编辑器 SQL：\n```sql\n{}\n```\n", sql),
                    ..Default::default()
                }
            ));
        }
    }

    // 发送 prompt（阻塞直到 opencode 完成本轮）
    let session_id_typed = agent_client_protocol::SessionId::from(session_id);
    let resp = connection.prompt(
        agent_client_protocol::PromptRequest::new(session_id_typed, content_blocks)
    ).await
        .map_err(|e| AppError::Other(format!("ACP prompt failed: {}", e)))?;

    log::info!("ACP prompt done, stop_reason: {:?}", resp.stop_reason);
    let _ = channel.send(crate::llm::StreamEvent::Done);
    Ok(())
}

/// 取消当前 ACP 会话（用户点击停止）
#[tauri::command]
pub async fn cancel_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut session_guard = state.acp_session.lock().await;
    if let Some(mut sess) = session_guard.take() {
        let _ = sess.child_handle.kill().await;
    }
    Ok(())
}
```

**Step 2: 修改 `lib.rs` — 注册命令 + 启动 MCP server + 注入 AppState**

将 `lib.rs` 中的 `setup` 回调和 `invoke_handler` 修改为：

```rust
mod acp;
mod mcp;
mod state;

// ... 其余 mod 保留 ...

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            use tauri::Manager;
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data dir")
                .to_string_lossy()
                .to_string();
            crate::db::init(&app_data_dir)?;
            crate::db::migrate_legacy_llm_settings()?;

            // 启动 MCP HTTP server
            let mcp_port = tauri::async_runtime::block_on(
                crate::mcp::start_mcp_server()
            ).expect("Failed to start MCP server");

            // 注入 AppState
            app.manage(crate::state::AppState {
                mcp_port,
                acp_session: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ... 所有现有命令保留 ...
            commands::ai_chat_acp,        // 新增
            commands::cancel_acp_session, // 新增
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

期望：无报错（SessionId 的构造方式需按实际 API 调整）

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add ai_chat_acp and cancel_acp_session commands"
```

---

## Task 7：前端 — 改造 aiStore，删除旧 agent 文件

**Files:**
- Modify: `src/store/aiStore.ts`
- Delete: `src/agent/agentLoop.ts`
- Delete: `src/agent/toolCatalog.ts`

**Step 1: 修改 `src/store/aiStore.ts`**

删除顶部两行 import：
```typescript
// 删除这两行
import { runAgentLoop } from '../agent/agentLoop';
import { getToolDefinitions } from '../agent/toolCatalog';
```

将 `sendAgentChatStream` 函数整体替换为：
```typescript
sendAgentChatStream: async (message, connectionId) => {
  // 获取当前 tab SQL（用于注入上下文）
  const { useQueryStore } = await import('./queryStore');
  const queryStore = useQueryStore.getState();
  const activeTabId = queryStore.activeTabId;
  const tabSql = activeTabId
    ? queryStore.tabs.find(t => t.id === activeTabId)?.sql ?? null
    : null;

  // 展示用户消息 + 占位 assistant 消息
  set((s) => ({
    isChatting: true,
    chatHistory: [
      ...s.chatHistory,
      { role: 'user' as const, content: message },
      { role: 'assistant' as const, content: '', thinkingContent: '', isStreaming: true },
    ],
  }));

  try {
    const { Channel } = await import('@tauri-apps/api/core');
    const channel = new Channel<{
      type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'Done' | 'Error';
      data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
    }>();

    channel.onmessage = (event) => {
      if (event.type === 'ThinkingChunk' && event.data?.delta) {
        set((s) => {
          const h = [...s.chatHistory];
          const last = { ...h[h.length - 1] };
          last.thinkingContent = (last.thinkingContent ?? '') + event.data!.delta!;
          h[h.length - 1] = last;
          return { chatHistory: h };
        });
      } else if (event.type === 'ContentChunk' && event.data?.delta) {
        set((s) => {
          const h = [...s.chatHistory];
          const last = { ...h[h.length - 1] };
          last.content = (last.content ?? '') + event.data!.delta!;
          h[h.length - 1] = last;
          return { chatHistory: h };
        });
      } else if (event.type === 'ToolCallRequest' && event.data?.name) {
        set({ activeToolName: event.data.name });
      } else if (event.type === 'Done') {
        set((s) => {
          const h = [...s.chatHistory];
          h[h.length - 1] = { ...h[h.length - 1], isStreaming: false };
          return { chatHistory: h, isChatting: false, activeToolName: null };
        });
      } else if (event.type === 'Error') {
        set((s) => {
          const h = [...s.chatHistory];
          h[h.length - 1] = {
            ...h[h.length - 1],
            content: `Error: ${event.data?.message ?? 'Unknown error'}`,
            isStreaming: false,
          };
          return { chatHistory: h, isChatting: false, activeToolName: null };
        });
      }
    };

    await invoke('ai_chat_acp', {
      prompt: message,
      connectionId,
      tabSql,
      channel,
    });
  } catch (e) {
    set((s) => {
      const h = [...s.chatHistory];
      h[h.length - 1] = {
        ...h[h.length - 1],
        content: `Error: ${String(e)}`,
        isStreaming: false,
      };
      return { chatHistory: h, isChatting: false, activeToolName: null };
    });
  }
},
```

同时删除 `AiState` 接口中已不再需要的字段（`agentHistory` 现在由 opencode 内部管理，无需在前端维护）：
```typescript
// 删除 agentHistory 相关（opencode 内部管理会话历史）
// agentHistory: AgentMessage[];  ← 删除
```

并从 types 导入中删除 `AgentMessage`、`ToolDefinition`（如无其他引用）。

**Step 2: 删除旧 agent 文件**

```bash
rm src/agent/agentLoop.ts
rm src/agent/toolCatalog.ts
# 如果目录为空则删除
rmdir src/agent 2>/dev/null || true
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1
```

期望：无报错（如有 AgentMessage 类型残留引用，逐一修复）

**Step 4: Commit**

```bash
git add src/store/aiStore.ts
git commit -m "feat(store): replace agentLoop with ai_chat_acp invoke, delete old agent files"
```

---

## Task 8：端到端验证

**Step 1: 确认 opencode 已在 PATH**

```bash
opencode --version
```

期望：输出版本号（如 `opencode 0.x.x`）

**Step 2: 启动开发服务器**

```bash
npm run tauri:dev
```

**Step 3: 验证 MCP Server 启动**

在 Tauri 日志（终端）中应看到：
```
MCP server started on port XXXXX
```

**Step 4: 验证 ACP 连通**

在 AI 助手中输入：`你好，你是谁？`

期望：
- 日志中出现 `opencode acp` 进程启动
- 日志中出现 `ACP initialize` 成功
- 聊天框出现正常回复

**Step 5: 验证工具调用**

选择一个已连接的数据库，在 AI 助手中输入：`列出当前连接的所有表`

期望：
- UI 显示 "⚙ 调用工具：list_tables..."
- AI 返回表列表

**Step 6: 验证 Anthropic 模型工具调用**

切换到 Anthropic 协议的模型配置，输入相同问题。

期望：工具调用正常工作（不再假装调用）

---

## 废弃代码对照表

实现完成后，以下旧命令从 `lib.rs` 的 `generate_handler![]` 中移除：

```rust
// 从 generate_handler! 中删除：
commands::ai_chat_stream_with_tools,
commands::ai_chat_continue,
commands::agent_get_table_sample,
commands::agent_execute_sql,
```

对应的 Rust 函数也可从 `commands.rs` 中删除（可选，不影响编译）。

---

## 常见问题排查

| 问题 | 排查步骤 |
|------|---------|
| `opencode acp` 启动失败 | 确认 `opencode` 在 PATH：`which opencode` |
| ACP initialize 失败 | 检查 opencode 版本是否支持 ACP：`opencode --help \| grep acp` |
| MCP 工具调用失败 | 检查 MCP server 是否在运行（查看日志端口），确认连接 ID 正确 |
| `McpServer::new_http` 编译失败 | 查阅 `cargo doc` 找实际 API，可能是 `McpServer::http(name, url)` |
| opencode.json 未生效 | 确认文件写入 cwd 目录，检查模型名格式（`provider/model`） |
