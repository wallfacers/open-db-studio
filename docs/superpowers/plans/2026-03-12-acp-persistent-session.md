# ACP 持久化 Session + 配置选择修复 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan.

> **状态: ⚠️ 已废弃（目标已通过不同架构实现）**
> ACP 协议已整体替换为 opencode HTTP Serve 模式（`start_serve` / `agent_chat`）。
> `ai_chat_acp` 已降级为废弃桩函数，`state.rs` 中用 `serve_child`（长驻进程）取代了本计划的 `acp_session` 字段。
> 消除冷启动的目标由 Serve 模式的长驻 HTTP 进程实现，本计划无需执行。

**Goal:** 复用 opencode-cli 进程跨多轮对话（消除冷启动延迟），同时修复 AI 助手面板的配置选择不生效问题。

**Architecture:** 将 ACP session 生命周期从"每次请求新建/销毁"改为"首次或配置变更时建立，之后复用"。由于 `ClientSideConnection` 是 `!Send`，通过 channel 代理模式把 connection 锁定在专用线程，`AppState` 只存 `UnboundedSender<AcpRequest>`（`Send + Sync`）。前端传 `configId`，Rust 按 ID 查配置，配置变更时自动重建 session。

**Tech Stack:** Rust / Tauri 2.x / tokio / agent-client-protocol 0.10.2 / TypeScript / Zustand

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/state.rs` | 修改 | `AppState` + `PersistentAcpSession` + `AcpRequest` 类型定义 |
| `src-tauri/src/acp/client.rs` | 修改 | `AcpClientHandler` 改为共享可换 sender；`start_acp_session` 签名更新 |
| `src-tauri/src/acp/session.rs` | 新建 | `spawn_acp_session_thread()` — 启动持久化 session 线程 |
| `src-tauri/src/acp/mod.rs` | 修改 | 导出 `session` 模块 |
| `src-tauri/src/commands.rs` | 修改 | `ai_chat_acp` 接收 `config_id`；`get_or_create_session` 复用/重建逻辑；`cancel_acp_session` 清空 session |
| `src-tauri/src/lib.rs` | 修改 | `AppState` 初始化去掉 `active_acp_pid` |
| `src/store/aiStore.ts` | 修改 | `sendAgentChatStream` 传 `configId`；`invoke` 带 `configId` 参数 |

---

## Chunk 1: Rust 后端重构

### Task 1: 更新 state.rs — 新类型定义

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 替换 state.rs 全部内容**

```rust
use tokio::sync::mpsc::UnboundedSender;
use crate::llm::StreamEvent;

/// 一条 ACP prompt 请求，通过 channel 发往 session 线程
pub struct AcpRequest {
    /// 已构建好的完整 prompt 文本（含 SQL 上下文）
    pub prompt_text: String,
    /// 流式事件回传通道（ContentChunk / ThinkingChunk / ToolCallRequest）
    pub event_tx: UnboundedSender<StreamEvent>,
    /// 请求完成信号（Ok = 成功，Err = 失败消息）
    pub done_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<()>>,
}

/// 持久化 ACP session 句柄，存于 AppState
pub struct PersistentAcpSession {
    /// 创建此 session 时使用的 LLM 配置 ID（用于检测配置变更）
    pub config_id: i64,
    /// 向 session 线程发送 prompt 请求
    pub request_tx: UnboundedSender<AcpRequest>,
}

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    /// MCP HTTP Server 监听端口
    pub mcp_port: u16,
    /// 当前持久化 ACP session（None = 尚未建立）
    /// 使用 tokio::sync::Mutex 以便在 async 函数中跨 await 持锁
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
}
```

- [ ] **Step 2: cargo check 确认编译通过（预期 lib.rs 报错，下一步修）**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

---

### Task 2: 更新 acp/client.rs — 共享可换 event sender

**Files:**
- Modify: `src-tauri/src/acp/client.rs` 第 18-20 行（`AcpClientHandler` 结构体）及 `session_notification` 实现
- Modify: `start_acp_session` 函数签名和 handler 创建

- [ ] **Step 1: 更新 `AcpClientHandler` 结构体和 `session_notification`**

将原来的：
```rust
pub struct AcpClientHandler {
    pub(crate) tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
}
```

改为：
```rust
/// `tx` 是共享的可替换 sender：
/// - session 线程在每次 prompt 前将其设为当前请求的 event_tx
/// - session 线程在 prompt 完成后将其清为 None
/// - 使用 std::sync::Mutex（不跨 await 持锁，性能足够）
pub struct AcpClientHandler {
    pub(crate) tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>>>,
}
```

- [ ] **Step 2: 更新 `session_notification` 中所有 `self.tx.send(...)` 调用**

将每处 `self.tx.send(ev)` 替换为：
```rust
// 克隆 sender（短暂持锁，不跨 await）
let tx_opt = { self.tx.lock().unwrap().clone() };
if let Some(ref tx) = tx_opt {
    if tx.send(ev).is_err() {
        log::debug!("[acp] tx send failed, receiver dropped");
    }
}
```

具体需要修改的三处：
1. `SessionUpdate::AgentMessageChunk` 块内
2. `SessionUpdate::AgentThoughtChunk` 块内
3. `SessionUpdate::ToolCall` 块内

- [ ] **Step 3: 更新 `start_acp_session` 函数签名**

将参数 `tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>` 改为：
```rust
shared_event_tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>>>,
```

- [ ] **Step 4: 更新 `start_acp_session` 内部 handler 创建**

将：
```rust
let handler = AcpClientHandler { tx };
```
改为：
```rust
let handler = AcpClientHandler { tx: shared_event_tx };
```

- [ ] **Step 5: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

---

### Task 3: 新建 acp/session.rs — 持久化 session 线程

**Files:**
- Create: `src-tauri/src/acp/session.rs`

- [ ] **Step 1: 创建文件，写入完整内容**

```rust
//! 持久化 ACP session 管理
//!
//! `spawn_acp_session_thread` 启动一个专用线程，该线程：
//! 1. 写 opencode.json → 启动 opencode-cli → ACP 握手
//! 2. 握手成功后删除 opencode.json（进程已读取，无需保留明文 key）
//! 3. 进入循环：等待 AcpRequest → 设 event_tx → prompt → 清 event_tx → 发 done
//! 4. request_tx 全部 drop 后退出循环，kill 子进程

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use agent_client_protocol::{Agent, ContentBlock, PromptRequest, TextContent};

use crate::error::{AppError, AppResult};
use crate::llm::StreamEvent;
use crate::state::{AcpRequest, PersistentAcpSession};

/// 启动持久化 ACP session 线程。
///
/// 函数会阻塞直到 ACP 握手完成（或失败）。
/// 成功后返回 `PersistentAcpSession`，调用方可通过其 `request_tx` 发送 prompt 请求。
pub async fn spawn_acp_session_thread(
    api_key: String,
    base_url: String,
    model: String,
    api_type: String,
    config_id: i64,
    mcp_port: u16,
    cwd: PathBuf,
) -> AppResult<PersistentAcpSession> {
    // 写 opencode.json（进程启动后会读取它）
    crate::acp::config::write_opencode_config(&api_key, Some(&base_url), &model, &api_type, &cwd)?;

    // 创建 prompt 请求 channel（tx 存入 AppState，rx 传入线程）
    let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel::<AcpRequest>();

    // 用于等待线程完成握手的 oneshot channel
    let (setup_tx, setup_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("acp session local runtime");
        let local = tokio::task::LocalSet::new();

        local.block_on(&rt, async move {
            session_loop(
                mcp_port,
                cwd,
                request_rx,
                setup_tx,
            )
            .await;
        });
    });

    // 等待握手结果
    setup_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread died before setup completed".into()))??;

    Ok(PersistentAcpSession { config_id, request_tx })
}

/// session 线程主循环（在专用 current-thread 运行时 + LocalSet 内执行）
async fn session_loop(
    mcp_port: u16,
    cwd: PathBuf,
    mut request_rx: tokio::sync::mpsc::UnboundedReceiver<AcpRequest>,
    setup_tx: tokio::sync::oneshot::Sender<AppResult<()>>,
) {
    // 共享 event sender：每次 prompt 前由循环设置，prompt 后清空
    let shared_event_tx: Arc<Mutex<Option<UnboundedSender<StreamEvent>>>> =
        Arc::new(Mutex::new(None));

    // 启动 ACP session（握手）
    let (connection, session_id, mut child) =
        match crate::acp::client::start_acp_session(
            mcp_port,
            &cwd,
            Arc::clone(&shared_event_tx),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let _ = setup_tx.send(Err(e));
                return;
            }
        };

    // 握手成功，删除含明文 API key 的 opencode.json
    let config_path = cwd.join("opencode.json");
    if let Err(e) = std::fs::remove_file(&config_path) {
        log::warn!("[acp] Failed to delete opencode.json after session start: {}", e);
    } else {
        log::info!("[acp] Deleted opencode.json after session start");
    }

    // 通知调用方握手成功
    let _ = setup_tx.send(Ok(()));

    log::info!("[acp] Persistent session ready (session_id={})", session_id);

    // Prompt 处理循环
    while let Some(req) = request_rx.recv().await {
        // 设置当前请求的 event sender
        *shared_event_tx.lock().unwrap() = Some(req.event_tx);

        // 发送 prompt
        let content_blocks = vec![ContentBlock::Text(TextContent::new(req.prompt_text))];
        let result = {
            let conn = connection.lock().await;
            conn.prompt(PromptRequest::new(session_id.clone(), content_blocks))
                .await
        };

        // 清空 event sender（下一个请求到来前不应有事件流出）
        *shared_event_tx.lock().unwrap() = None;

        // 回传结果
        let outcome = match result {
            Ok(resp) => {
                log::info!("[acp] Prompt done, stop_reason: {:?}", resp.stop_reason);
                Ok(())
            }
            Err(e) => Err(AppError::Other(format!("ACP prompt failed: {}", e))),
        };
        let _ = req.done_tx.send(outcome);
    }

    // request_tx 全部 drop 后退出循环，清理进程
    log::info!("[acp] Session loop exiting, killing opencode-cli");
    let _ = child.kill().await;
}
```

- [ ] **Step 2: 更新 acp/mod.rs 导出 session 模块**

```rust
pub mod config;
pub mod client;
pub mod session;
```

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

---

### Task 4: 更新 commands.rs

**Files:**
- Modify: `src-tauri/src/commands.rs` — `ai_chat_acp`、`ai_chat_acp_inner`、`cancel_acp_session`

- [ ] **Step 1: 更新 `ai_chat_acp` 命令签名，增加 `config_id` 参数**

将：
```rust
pub async fn ai_chat_acp(
    prompt: String,
    tab_sql: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()>
```

改为：
```rust
pub async fn ai_chat_acp(
    prompt: String,
    tab_sql: Option<String>,
    config_id: Option<i64>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()>
```

并将 `ai_chat_acp_inner` 调用传入 `config_id`：
```rust
let result = ai_chat_acp_inner(prompt, tab_sql, config_id, &channel, &state).await;
```

- [ ] **Step 2: 完整替换 `ai_chat_acp_inner`**

用以下实现完整替换（删除旧的 `ai_chat_acp_inner` 函数）：

```rust
async fn ai_chat_acp_inner(
    prompt: String,
    tab_sql: Option<String>,
    config_id: Option<i64>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;
    use crate::llm::StreamEvent;

    // 1. 获取指定配置（未指定则用默认）
    let config = match config_id {
        Some(id) => crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?,
        None => crate::db::get_default_llm_config()?
            .ok_or_else(|| AppError::Other("No default LLM config found".into()))?,
    };

    // 2. 构建 prompt 文本（注入 SQL 上下文）
    let mut prompt_text = prompt;
    if let Some(sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!(
                "当前编辑器 SQL：\n```sql\n{}\n```\n\n{}",
                sql, prompt_text
            );
        }
    }

    // 3. 获取或创建 persistent session
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into()),
    )
    .join("open-db-studio");
    std::fs::create_dir_all(&cwd).ok();

    let request_tx = get_or_create_session(&config, state.mcp_port, &cwd, state).await?;

    // 4. 创建事件转发：session 线程 → Tauri Channel
    let (event_tx, mut event_rx) =
        tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 5. 创建完成信号 channel
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

    // 6. 发送请求给 session 线程
    request_tx
        .send(AcpRequest { prompt_text, event_tx, done_tx })
        .map_err(|_| AppError::Other("ACP session closed unexpectedly".into()))?;

    // 7. 等待 session 线程完成 prompt
    done_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread dropped before responding".into()))?
}

/// 获取当前 session（配置未变）或创建新 session（首次 / 配置变更 / session 已关闭）
async fn get_or_create_session(
    config: &crate::db::models::LlmConfig,
    mcp_port: u16,
    cwd: &std::path::Path,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<tokio::sync::mpsc::UnboundedSender<crate::state::AcpRequest>> {
    let mut session_guard = state.acp_session.lock().await;

    // 检查现有 session 是否可复用
    if let Some(ref session) = *session_guard {
        if session.config_id == config.id && !session.request_tx.is_closed() {
            log::debug!("[acp] Reusing existing session (config_id={})", config.id);
            return Ok(session.request_tx.clone());
        }
        log::info!(
            "[acp] Session invalid (config changed or closed), rebuilding"
        );
    }

    // 创建新 session
    log::info!(
        "[acp] Creating new session for config_id={} model={}",
        config.id,
        config.model
    );
    let new_session = crate::acp::session::spawn_acp_session_thread(
        config.api_key.clone(),
        config.base_url.clone(),
        config.model.clone(),
        config.api_type.clone(),
        config.id,
        mcp_port,
        cwd.to_path_buf(),
    )
    .await?;

    let tx = new_session.request_tx.clone();
    *session_guard = Some(new_session);
    Ok(tx)
}
```

- [ ] **Step 3: 替换 `cancel_acp_session`**

将原来基于 PID 的 kill 逻辑替换为：

```rust
#[tauri::command]
pub async fn cancel_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut session_guard = state.acp_session.lock().await;
    if session_guard.is_some() {
        // Drop PersistentAcpSession → request_tx 被 drop →
        // session 线程 request_rx.recv() 返回 None → 线程退出 → kill 子进程
        *session_guard = None;
        log::info!("[acp] Session cancelled, thread will exit on next idle");
    }
    Ok(())
}
```

- [ ] **Step 4: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

---

### Task 5: 更新 lib.rs — AppState 初始化

**Files:**
- Modify: `src-tauri/src/lib.rs` 第 32-35 行

- [ ] **Step 1: 更新 AppState 初始化**

将：
```rust
app.manage(crate::state::AppState {
    mcp_port,
    active_acp_pid: std::sync::Arc::new(std::sync::Mutex::new(None)),
});
```

改为：
```rust
app.manage(crate::state::AppState {
    mcp_port,
    acp_session: tokio::sync::Mutex::new(None),
});
```

- [ ] **Step 2: 完整 cargo check，确认零 error**

```bash
cd src-tauri && cargo check 2>&1
```

预期：`Finished dev profile` 无 error（warnings 可接受）

---

## Chunk 2: 前端修复

### Task 6: 更新 aiStore.ts — 传递 configId

**Files:**
- Modify: `src/store/aiStore.ts` 第 123-175 行

- [ ] **Step 1: 更新 `sendAgentChatStream` — 读取并传递 `activeConfigId`**

在 `sendAgentChatStream` 函数体内，找到 `await invoke('ai_chat_acp', ...)` 调用处：

```typescript
// 旧代码
await invoke('ai_chat_acp', {
  prompt: message,
  tabSql,
  channel,
});
```

替换为：

```typescript
// 读取当前选中的配置 ID（null 表示使用默认）
const configId = get().activeConfigId;

await invoke('ai_chat_acp', {
  prompt: message,
  tabSql,
  configId,   // Rust 侧接收为 Option<i64>，null 序列化为 None
  channel,
});
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1
```

预期：无新增 error

---

## Chunk 3: 集成验证

### Task 7: 编译 + 手动验证

- [ ] **Step 1: 完整 cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

预期：Finished，零 error

- [ ] **Step 2: 启动应用，发送第一条消息**

```bash
npm run tauri:dev
```

观察控制台日志，预期看到：
```
[acp] Creating new session for config_id=X model=...
[acp] Deleted opencode.json after session start
[acp] Persistent session ready (session_id=...)
[acp] Prompt done, stop_reason: ...
```

- [ ] **Step 3: 发送第二条消息**

预期控制台日志：
```
[acp] Reusing existing session (config_id=X)
```
（不再看到 "Creating new session" 或 "Deleted opencode.json"）

- [ ] **Step 4: 切换 AI 配置后发送消息**

在 AI 助手面板切换到不同配置，发送消息。
预期控制台日志：
```
[acp] Session invalid (config changed or closed), rebuilding
[acp] Creating new session for config_id=Y model=...
```

- [ ] **Step 5: 验证响应速度明显提升（第二条及之后的消息）**

第二条消息的响应起始时间应比第一条快（无冷启动）。
