<!-- STATUS: ✅ 已实现 -->
# SQL Optimize ACP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SQL 优化功能从直接 LLM 调用改为 ACP Agent session，使用受限 MCP 端点（仅 4 个只读 DB 工具），流式输出并支持取消，优化结果直接替换编辑器内容（纯 SQL，无解释文本）。

**Architecture:**
- Rust 新增 `/mcp/optimize` HTTP 端点，只暴露 4 个只读工具
- `ai_optimize_sql` 改为 Channel 流式命令，每次调用创建新 ACP session（不复用），存入 `AppState.optimize_acp_session` 供取消
- 前端 aiStore 改为流式处理；按钮在优化中显示 spinner，悬停显示"停止"

**Tech Stack:** Rust (Tauri, axum, tokio), TypeScript (React, Zustand, Monaco Editor)

---

## Chunk 1: Rust 后端改造

### Task 1: MCP `/mcp/optimize` 端点

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

当前 Router 只有 `/mcp`，新增 `/mcp/optimize` 路由，只暴露 4 个工具。

- [ ] **Step 1: 在 `mcp/mod.rs` 中提取 optimize_tool_definitions**

在现有 `tool_definitions()` 函数后面添加：

```rust
fn optimize_tool_definitions() -> Value {
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
            }
        ]
    })
}
```

- [ ] **Step 2: 添加 `/mcp/optimize` 的 handler**

```rust
async fn handle_optimize_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_optimize_mcp(
    State(handle): State<Arc<tauri::AppHandle>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "initialize" => Json(JsonRpcResponse::ok(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-db-studio-optimize", "version": "0.1.0" }
        }))),
        "notifications/initialized" => Json(JsonRpcResponse::ok(id, json!(null))),
        "tools/list" => Json(JsonRpcResponse::ok(id, optimize_tool_definitions())),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            // 白名单校验：只允许 4 个只读工具
            let allowed = ["list_databases", "list_tables", "get_table_schema", "get_table_sample"];
            if !allowed.contains(&name.as_str()) {
                return Json(JsonRpcResponse::err(id, -32601, "Tool not available in optimize mode"));
            }
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
```

- [ ] **Step 3: 在 `start_mcp_server` 中注册新路由**

将：
```rust
let app = Router::new()
    .route("/mcp", get(handle_mcp_sse))
    .route("/mcp", post(handle_mcp))
    .with_state(Arc::new(app_handle));
```

改为：
```rust
let app = Router::new()
    .route("/mcp", get(handle_mcp_sse))
    .route("/mcp", post(handle_mcp))
    .route("/mcp/optimize", get(handle_optimize_mcp_sse))
    .route("/mcp/optimize", post(handle_optimize_mcp))
    .with_state(Arc::new(app_handle));
```

- [ ] **Step 4: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 无 error

---

### Task 2: ACP session 支持自定义 MCP URL

**Files:**
- Modify: `src-tauri/src/acp/session.rs`
- Modify: `src-tauri/src/acp/client.rs`

`spawn_acp_session_thread` 当前把 `mcp_port: u16` 传给 `session_loop`，再由 `start_acp_session` 构造 URL。
改为传入完整的 `mcp_url: String`，让调用方控制使用哪个端点。

- [ ] **Step 1: 修改 `session.rs` 的 `spawn_acp_session_thread` 签名**

将参数 `mcp_port: u16` 改为 `mcp_url: String`：

```rust
pub async fn spawn_acp_session_thread(
    api_key: String,
    base_url: String,
    model: String,
    api_type: String,
    preset: Option<String>,
    config_id: i64,
    mcp_url: String,          // ← 由调用方传入完整 URL
    cwd: PathBuf,
    status_tx: Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>,
) -> AppResult<PersistentAcpSession> {
    // ...（其余不变）
    std::thread::spawn(move || {
        // ...
        local.block_on(&rt, async move {
            session_loop(mcp_url, cwd, request_rx, setup_tx, status_tx).await;
        });
    });
    // ...
}
```

同步修改 `session_loop` 签名：
```rust
async fn session_loop(
    mcp_url: String,          // ← 替换 mcp_port: u16
    cwd: PathBuf,
    // ...
) {
    // ...
    match crate::acp::client::start_acp_session(
        &mcp_url,             // ← 传入
        &cwd,
        // ...
    ).await { ... }
}
```

- [ ] **Step 2: 修改 `client.rs` 的 `start_acp_session` 签名**

将参数 `mcp_port: u16` 改为 `mcp_url: &str`：

```rust
pub async fn start_acp_session(
    mcp_url: &str,            // ← 替换 mcp_port: u16
    cwd: &std::path::Path,
    // ...
) -> ... {
    // ...
    // 找到这行，改为直接使用 mcp_url：
    // 原来: let mcp_url = format!("http://127.0.0.1:{}/mcp", mcp_port);
    // 现在: 直接用参数 mcp_url
    let session_resp: NewSessionResponse = {
        let conn = connection.lock().await;
        conn.new_session(
            NewSessionRequest::new(cwd).mcp_servers(vec![McpServer::Http(
                McpServerHttp::new("db-tools", mcp_url),   // ← 直接用
            )]),
        )
        .await
        .map_err(|e| crate::AppError::Other(format!("ACP new_session failed: {}", e)))?
    };
    // ...
}
```

- [ ] **Step 3: 修复 `commands.rs` 中调用 `spawn_acp_session_thread` 的地方**

在 `get_or_create_session` 函数中，找到：
```rust
let new_session = crate::acp::session::spawn_acp_session_thread(
    config.api_key.clone(),
    config.base_url.clone(),
    config.model.clone(),
    config.api_type.clone(),
    config.preset.clone(),
    config.id,
    mcp_port,                 // ← 旧参数
    cwd.to_path_buf(),
    Some(event_tx.clone()),
).await?;
```

改为：
```rust
let mcp_url = format!("http://127.0.0.1:{}/mcp", mcp_port);
let new_session = crate::acp::session::spawn_acp_session_thread(
    config.api_key.clone(),
    config.base_url.clone(),
    config.model.clone(),
    config.api_type.clone(),
    config.preset.clone(),
    config.id,
    mcp_url,                  // ← 新参数
    cwd.to_path_buf(),
    Some(event_tx.clone()),
).await?;
```

- [ ] **Step 4: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 无 error

---

### Task 3: AppState 添加 optimize_acp_session 字段

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `state.rs` 中添加字段**

```rust
pub struct AppState {
    pub mcp_port: u16,
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
    /// SQL 优化专用 ACP session（每次优化创建新 session，存储仅用于取消）
    pub optimize_acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
}
```

- [ ] **Step 2: 在 `lib.rs` 中初始化新字段**

找到 `app.manage(crate::state::AppState { ... })` 的地方，添加：
```rust
app.manage(crate::state::AppState {
    mcp_port,
    acp_session: tokio::sync::Mutex::new(None),
    current_editor_sql: tokio::sync::Mutex::new(None),
    optimize_acp_session: tokio::sync::Mutex::new(None),  // ← 新增
});
```

- [ ] **Step 3: cargo check 确认编译通过**

---

### Task 4: 改写 `ai_optimize_sql` 命令 + 新增取消命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Create: `src-tauri/assets/AGENTS_OPTIMIZE.md`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 `AGENTS_OPTIMIZE.md`**

文件路径：`src-tauri/assets/AGENTS_OPTIMIZE.md`

```markdown
你是 SQL 性能优化专家。

## 规则

- **只输出优化后的 SQL，不输出任何解释、注释或其他文字。**
- 不得调用 `propose_sql_diff`、`get_editor_sql`、`execute_sql` 等工具。
- 允许调用 `list_databases`、`list_tables`、`get_table_schema`、`get_table_sample` 了解库表结构。

## 优化目标

1. **性能优化**：消除全表扫描、优化 JOIN 顺序、合理使用索引、避免 SELECT *（除非必要）
2. **语法优化**：规范大小写、统一缩进（4 空格）、关键字大写、标识符按需加引号

## 输出格式

只允许输出 SQL 本身，不加 markdown 代码块，不加解释，不加注释。

示例输入：
select * from user where id=1

示例输出：
SELECT *
FROM user
WHERE id = 1
```

- [ ] **Step 2: 改写 `ai_optimize_sql` 命令**

将现有的 `ai_optimize_sql` 函数替换为：

```rust
/// SQL 优化：每次调用创建新 ACP session，流式输出，支持取消。
/// 不复用上次的 optimize session。
#[tauri::command]
pub async fn ai_optimize_sql(
    sql: String,
    connection_id: Option<i64>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = ai_optimize_sql_inner(sql, connection_id, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    let _ = channel.send(crate::llm::StreamEvent::Done);
    result
}

async fn ai_optimize_sql_inner(
    sql: String,
    connection_id: Option<i64>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;

    // 获取默认 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    // optimize session 专用工作目录（与 chat session 隔离）
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into()),
    ).join("open-db-studio-optimize");
    std::fs::create_dir_all(&cwd).ok();

    // 写入 optimize 专用 AGENTS.md
    let agents_content = include_str!("../assets/AGENTS_OPTIMIZE.md");
    if let Err(e) = std::fs::write(cwd.join("AGENTS.md"), agents_content) {
        log::warn!("[optimize] Failed to write AGENTS.md: {}", e);
    }

    // 构建 prompt
    let conn_context = if let Some(conn_id) = connection_id {
        format!("当前数据库连接 ID: {}\n\n", conn_id)
    } else {
        String::new()
    };
    let prompt_text = format!(
        "{}优化以下 SQL：\n\n{}",
        conn_context, sql
    );

    // 创建事件转发通道
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<crate::llm::StreamEvent>();
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 先 drop 旧的 optimize session（如有）
    {
        let mut guard = state.optimize_acp_session.lock().await;
        if guard.is_some() {
            *guard = None;
            log::info!("[optimize] Dropped previous optimize session");
        }
    }

    // 总是创建新 session，使用 /mcp/optimize 端点
    let optimize_mcp_url = format!("http://127.0.0.1:{}/mcp/optimize", state.mcp_port);
    let new_session = crate::acp::session::spawn_acp_session_thread(
        config.api_key.clone(),
        config.base_url.clone(),
        config.model.clone(),
        config.api_type.clone(),
        config.preset.clone(),
        config.id,
        optimize_mcp_url,
        cwd.clone(),
        Some(event_tx.clone()),
    ).await?;

    // 存入 AppState（用于取消）
    let request_tx = new_session.request_tx.clone();
    {
        let mut guard = state.optimize_acp_session.lock().await;
        *guard = Some(crate::state::PersistentAcpSession {
            config_id: new_session.config_id,
            config_fingerprint: String::new(),
            request_tx: new_session.request_tx,
        });
    }

    // 发送 prompt，等待完成
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();
    request_tx
        .send(AcpRequest { prompt_text, event_tx, done_tx })
        .map_err(|_| AppError::Other("Optimize ACP session closed unexpectedly".into()))?;

    let result = done_rx
        .await
        .map_err(|_| AppError::Other("Optimize ACP session thread dropped before responding".into()))?;

    // 完成后清理 session
    {
        let mut guard = state.optimize_acp_session.lock().await;
        *guard = None;
    }

    result
}
```

- [ ] **Step 3: 添加 `cancel_optimize_acp_session` 命令**

在 `ai_optimize_sql` 函数后面添加：

```rust
#[tauri::command]
pub async fn cancel_optimize_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut guard = state.optimize_acp_session.lock().await;
    if guard.is_some() {
        *guard = None;
        log::info!("[optimize] Session cancelled by user");
    }
    Ok(())
}
```

- [ ] **Step 4: 在 `lib.rs` 中注册新命令**

在 `invoke_handler` 列表中找到 `commands::ai_optimize_sql,`，在其下方添加：

```rust
commands::cancel_optimize_acp_session,
```

- [ ] **Step 5: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 无 error

---

### Task 5: 更新提示词

**Files:**
- Modify: `prompts/sql_optimize.txt`

现有提示词让模型输出 `ISSUES/OPTIMIZED SQL/CHANGES` 三段式，与新需求（只输出 SQL）冲突。
AGENTS_OPTIMIZE.md 已承担系统指令职责，`sql_optimize.txt` 不再被调用（`ai_optimize_sql` 已不再使用 `LlmClient.optimize_sql`）。

- [ ] **Step 1: 保留文件但标注已废弃**

```
[DEPRECATED] This file is no longer used.
SQL optimization now uses the ACP agent session with AGENTS_OPTIMIZE.md.
See src-tauri/assets/AGENTS_OPTIMIZE.md for the current prompt.
```

---

## Chunk 2: 前端改造

### Task 6: aiStore 改为流式 optimizeSql

**Files:**
- Modify: `src/store/aiStore.ts`

`optimizeSql` 现在是非流式的（直接 invoke 返回字符串）。
改为接受 Channel 事件、累积 ContentChunk、在 Done 时 resolve 最终 SQL 字符串。

- [ ] **Step 1: 修改 `optimizeSql` 的类型签名**

在 `AiState` interface 中，将：
```typescript
optimizeSql: (sql: string, connectionId: number) => Promise<string>;
```
改为：
```typescript
optimizeSql: (sql: string, connectionId: number | null) => Promise<string>;
cancelOptimizeSql: () => Promise<void>;
```

- [ ] **Step 2: 重写 `optimizeSql` 实现**

将现有的 `optimizeSql` 实现替换为：

```typescript
optimizeSql: async (sql, connectionId) => {
  set({ isOptimizing: true, error: null });
  return new Promise<string>(async (resolve, reject) => {
    try {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{
        type: 'ContentChunk' | 'ThinkingChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
        data?: { delta?: string; message?: string };
      }>();

      let resultBuf = '';

      channel.onmessage = (event) => {
        if (event.type === 'ContentChunk' && event.data?.delta) {
          resultBuf += event.data.delta;
        } else if (event.type === 'Done') {
          set({ isOptimizing: false });
          resolve(resultBuf.trim());
        } else if (event.type === 'Error') {
          set({ isOptimizing: false, error: event.data?.message ?? 'Unknown error' });
          reject(new Error(event.data?.message ?? 'Unknown error'));
        }
      };

      await invoke('ai_optimize_sql', {
        sql,
        connectionId,
        channel,
      });
    } catch (e) {
      set({ isOptimizing: false, error: String(e) });
      reject(e);
    }
  });
},

cancelOptimizeSql: async () => {
  await invoke('cancel_optimize_acp_session').catch(() => {});
  set({ isOptimizing: false });
},
```

- [ ] **Step 3: 在初始值中添加 cancelOptimizeSql 占位**

在 store 的初始 state 里不需要改动（`cancelOptimizeSql` 是方法），但确认 `isOptimizing: false` 已在初始值中。

---

### Task 7: MainContent 按钮 spinner + 停止交互

**Files:**
- Modify: `src/components/MainContent/index.tsx`

需求：
1. 优化进行中时，Zap 图标替换为转圈动画
2. 鼠标悬停时，转圈替换为 X 图标 + tooltip "停止优化"
3. 点击此时触发 `cancelOptimizeSql`

- [ ] **Step 1: 引入 cancelOptimizeSql**

找到：
```typescript
const { explainSql, isExplaining, optimizeSql, isOptimizing } = useAiStore();
```
改为：
```typescript
const { explainSql, isExplaining, optimizeSql, isOptimizing, cancelOptimizeSql } = useAiStore();
```

- [ ] **Step 2: 更新 handleOptimize 中的 cancelOptimizeSql 调用**

`handleOptimize` 无需改动（已在上一次代码改动中实现了正确的替换逻辑）。
但需确保 `optimizeSql` 调用签名兼容（connectionId 可为 null）。

- [ ] **Step 3: 将 Zap 按钮替换为带状态的版本**

找到当前的优化按钮：
```tsx
<Tooltip content={isOptimizing ? t('mainContent.optimizing') : t('mainContent.optimizeSql')}>
  <button
    className={`p-1.5 rounded transition-colors ${isOptimizing || !currentSql.trim() ? 'text-[#7a9bb8] cursor-not-allowed opacity-30' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
    onClick={handleOptimize}
    disabled={isOptimizing || !currentSql.trim() || !activeTabObj?.queryContext?.connectionId}
  >
    <Zap size={16} />
  </button>
</Tooltip>
```

替换为带 hover 状态的版本：
```tsx
{isOptimizing ? (
  <Tooltip content={t('mainContent.stopOptimizing')}>
    <button
      className="p-1.5 rounded transition-colors text-[#f59e0b] hover:text-red-400 hover:bg-[#1e2d42] group"
      onClick={() => cancelOptimizeSql()}
    >
      {/* 默认转圈，hover 变 X */}
      <span className="block group-hover:hidden">
        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </span>
      <span className="hidden group-hover:block">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </button>
  </Tooltip>
) : (
  <Tooltip content={!currentSql.trim() ? '' : t('mainContent.optimizeSql')}>
    <button
      className={`p-1.5 rounded transition-colors ${!currentSql.trim() ? 'text-[#7a9bb8] cursor-not-allowed opacity-30' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
      onClick={handleOptimize}
      disabled={!currentSql.trim() || !activeTabObj?.queryContext?.connectionId}
    >
      <Zap size={16} />
    </button>
  </Tooltip>
)}
```

- [ ] **Step 4: 在 i18n 文件中添加 stopOptimizing key**

`src/i18n/locales/zh.json`：找到 `"optimizeSql"` 附近，添加：
```json
"stopOptimizing": "停止优化"
```

`src/i18n/locales/en.json`：
```json
"stopOptimizing": "Stop Optimizing"
```

- [ ] **Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: 无 error（或仅非相关警告）

---

### Task 8: 验证与收尾

- [ ] **Step 1: 完整 Rust 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```

- [ ] **Step 2: 手动验证流程**

1. 打开 SQL 编辑器，输入 `SELECT * FROM some_table LIMIT 100`
2. 点击优化（Zap）按钮 → 按钮变为转圈动画
3. 悬停转圈按钮 → 变为 X 图标
4. 等待完成 → 编辑器内容被替换为优化后的纯 SQL（无解释文字）
5. 选中部分 SQL → 点击优化 → 仅选中部分被替换
6. 优化进行中点击 X → 停止，按钮恢复为 Zap

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/mod.rs \
        src-tauri/src/state.rs \
        src-tauri/src/acp/session.rs \
        src-tauri/src/acp/client.rs \
        src-tauri/src/commands.rs \
        src-tauri/src/lib.rs \
        src-tauri/assets/AGENTS_OPTIMIZE.md \
        prompts/sql_optimize.txt \
        src/store/aiStore.ts \
        src/components/MainContent/index.tsx \
        src/i18n/locales/zh.json \
        src/i18n/locales/en.json
git commit -m "feat(optimize): ACP agent session + /mcp/optimize endpoint + streaming + stop button"
```
