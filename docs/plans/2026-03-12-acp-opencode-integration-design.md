<!-- STATUS: ✅ 已实现（架构已迭代升级）
# ACP + opencode 集成设计文档

**日期：** 2026-03-12  
**状态：** 已批准，待实现  
**背景：** 现有 Agent Loop 在 Anthropic 协议下完全失效（无工具调用），需用 opencode 替换 LLM 客户端层。

---

## 问题背景

当前 `ai_chat_stream_with_tools` 在 Anthropic 协议下静默降级为普通流式对话，不发送工具定义，导致：
- 模型在文字里"假装"调用工具（如输出 `get_current_tab()`）
- 前端收到 0 个 `ToolCallRequest` 事件，Agent Loop 一轮即结束
- 用户体验完全断裂

---

## 解决方案：opencode via ACP

用 opencode 作为 AI 后端，通过 ACP（Agent Communication Protocol）协议对接。opencode 原生支持 Anthropic 和 OpenAI 的工具调用，内置成熟的 think-act-think 循环。

### 核心哲学

| 旧架构 | 新架构 |
|--------|--------|
| 我们自己编排 Agent Loop | opencode 编排，我们观察 |
| OpenAI function calling 格式 | ACP JSON-RPC over stdio |
| Anthropic 降级为无工具 | opencode 原生支持 Anthropic 工具调用 |
| 工具在前端 TypeScript 执行 | DB 工具在 MCP HTTP server 执行 |

---

## 架构

```
Chat UI (React)
  │ invoke('ai_chat_acp')
  ▼
Tauri Rust
  ├─ ACP Client (agent-client-protocol crate)
  │    │ JSON-RPC over stdio
  │    ▼
  │  opencode acp 子进程
  │    ├── LLM（Anthropic/OpenAI，原生工具调用）
  │    └── MCP client → 调用我们的 MCP server
  │
  ├─ MCP HTTP Server (axum, 127.0.0.1:随机端口)
  │    ├── list_databases
  │    ├── list_tables
  │    ├── get_table_schema
  │    ├── get_table_sample
  │    └── execute_sql（SELECT-only）
  │
  └─ Channel → StreamEvent → 前端
```

---

## 工具分层（三通道）

| 通道 | 原工具类别 | 实现方式 |
|------|-----------|---------|
| 上下文注入 | A类（编辑器） | 发送 prompt 时注入当前 SQL 为 ACP Resource block |
| MCP HTTP | B/C类（DB结构/数据） | axum HTTP server，opencode 按需调用 |
| ACP diff block | D类（写回） | 解析 opencode 输出的 diff content block → DiffPanel |

---

## 关键组件

### 1. ACP Client（Rust）

**依赖：**
```toml
agent-client-protocol = "0.10"
tokio = { version = "1", features = ["full"] }
```

**实现 `Client` trait：**
```rust
struct AcpClientHandler {
    tx: mpsc::UnboundedSender<StreamEvent>,
}

impl Client for AcpClientHandler {
    async fn session_notification(&self, notif: SessionNotification) -> Result<()> {
        match notif.update {
            Some(SessionUpdate::AgentMessageChunk(chunk)) => {
                // ContentBlock::Text → StreamEvent::ContentChunk
            }
            Some(SessionUpdate::AgentThoughtChunk(chunk)) => {
                // → StreamEvent::ThinkingChunk
            }
            Some(SessionUpdate::ToolCall(tc)) => {
                // → StreamEvent::ToolCallRequest (for UI status)
            }
            _ => {}
        }
        Ok(())
    }

    async fn request_permission(&self, req: RequestPermissionRequest) -> Result<RequestPermissionResponse> {
        // 自动 allow-once（数据库工具无危险操作）
        Ok(RequestPermissionResponse::allow_once())
    }
}
```

**连接流程：**
```rust
// 1. 写 opencode.json 配置
write_opencode_config(&llm_config, &config_path)?;

// 2. 启动子进程
let mut child = Command::new("opencode")
    .arg("acp")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()?;

// 3. 建立连接
let (conn, io_future) = ClientSideConnection::new(
    handler, child.stdin.take(), child.stdout.take(),
    |fut| { tokio::spawn(fut); }
);
tokio::spawn(io_future);

// 4. 握手 + 创建会话
conn.initialize(InitializeRequest::new(ProtocolVersion::LATEST)).await?;
let session = conn.new_session(
    NewSessionRequest::new(cwd)
        .mcp_servers(vec![our_mcp_server])
).await?;

// 5. 发送 prompt
conn.prompt(PromptRequest::new(session.session_id, content_blocks)).await?;
```

### 2. Config Bridge（Rust）

读取活跃 LLM 配置（解密 API key），写入临时 `opencode.json`：

```json
// OpenAI 兼容
{
  "model": "openai/gpt-4o",
  "providers": {
    "openai": { "apiKey": "sk-xxx", "baseURL": "https://custom-endpoint/v1" }
  }
}

// Anthropic
{
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-xxx" }
  }
}
```

模型名称映射规则：
- `api_type=openai` → `"openai/{model}"`，provider key `openai`
- `api_type=anthropic` → `"anthropic/{model}"`，provider key `anthropic`

### 3. MCP HTTP Server（Rust + axum）

启动时机：App 启动时，绑定 `127.0.0.1:0`（随机端口），记录实际端口。

端点：`POST /mcp`，JSON-RPC 2.0 格式。

支持方法：
- `tools/list` → 返回工具 schema 列表
- `tools/call` → 调用具体工具，参数透传给 Tauri 内部命令

暴露工具：

| 工具名 | 参数 | 说明 |
|--------|------|------|
| `list_databases` | `connection_id` | 列出所有数据库 |
| `list_tables` | `connection_id, database` | 列出表 |
| `get_table_schema` | `connection_id, table, database?` | 获取表结构 |
| `get_table_sample` | `connection_id, table, limit?` | 样本数据（≤20行） |
| `execute_sql` | `connection_id, sql, database?` | SELECT-only，≤100行 |

### 4. 新 Tauri 命令

```rust
// 替换 ai_chat_stream_with_tools + ai_chat_continue
#[tauri::command]
pub async fn ai_chat_acp(
    prompt: String,
    connection_id: Option<i64>,
    tab_sql: Option<String>,     // 当前 tab SQL（上下文注入）
    channel: Channel<StreamEvent>,
    state: State<AppState>,
) -> AppResult<()>

// 取消当前会话
#[tauri::command]
pub async fn cancel_acp_session(state: State<AppState>) -> AppResult<()>
```

### 5. 前端变更（最小化）

- `aiStore.sendAgentChatStream` → 改调 `ai_chat_acp`，传入 `tabSql` 参数
- 删除 `src/agent/agentLoop.ts`
- 删除 `src/agent/toolCatalog.ts`
- 保留 `DiffPanel.tsx`（解析 diff block 后触发）

---

## Session 生命周期

```
App 启动
  └─ MCP HTTP Server 启动（随机端口）

用户发送消息
  ├─ 无活跃 session → 写 opencode.json → spawn opencode → initialize → new_session
  └─ 有活跃 session → 复用（同一 opencode 进程）

用户清空对话（clearHistory）
  └─ cancel + terminate opencode 进程 + 清空 session

App 关闭
  └─ terminate opencode 进程 + stop MCP server
```

---

## 废弃的旧代码

| 文件 | 状态 |
|------|------|
| `src/agent/agentLoop.ts` | 删除 |
| `src/agent/toolCatalog.ts` | 删除 |
| `src-tauri/src/llm/client.rs` 中 `chat_stream_with_tools*` | 删除 |
| Tauri 命令 `ai_chat_stream_with_tools`、`ai_chat_continue` | 删除 |
| Tauri 命令 `agent_get_table_sample`、`agent_execute_sql` | 移入 MCP server（逻辑复用） |

---

## 依赖新增

```toml
# src-tauri/Cargo.toml
[dependencies]
agent-client-protocol = "0.10"
axum = "0.7"
tokio = { version = "1", features = ["full"] }
```

---

## 成功验收标准

1. 输入"users 表有哪些字段" → opencode 调用 MCP `get_table_schema`，返回正确结果
2. 输入"帮我优化当前 SQL" → opencode 读到注入的 SQL，输出 diff block，DiffPanel 弹出
3. Anthropic 模型下工具调用正常工作（不再假装调用）
4. 工具调用状态 "⚙ 调用工具：xxx..." 在执行时可见
