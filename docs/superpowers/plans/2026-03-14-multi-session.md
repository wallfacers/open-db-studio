# Multi-Session Background Streaming Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AI 助手多 session 后台流式输出，切换 session 时不中断流，切回时展示已完成或继续流式的内容。

**Architecture:** 后端 `AppState` 改为 HashMap 管理多个 ACP 进程（key = frontend_session_id）；前端 Store 将流式状态从全局单值改为 per-session `chatStates` Map；UI 订阅当前 session 的状态，历史列表显示后台运行角标。

**Tech Stack:** Rust / Tauri 2.x, React 18 / TypeScript, Zustand, tokio async, Tauri IPC Channel

**Spec:** `docs/superpowers/specs/2026-03-14-multi-session-design.md`

---

## Chunk 1: 后端重构

### Task 1: AppState 改为 HashMap 结构

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 修改 `state.rs`，将单 session 字段改为 HashMap**

```rust
// src-tauri/src/state.rs — 完整替换
use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;
use crate::llm::StreamEvent;

/// 一条 ACP prompt 请求，通过 channel 发往 session 线程
pub struct AcpRequest {
    pub prompt_text: String,
    pub event_tx: UnboundedSender<StreamEvent>,
    pub done_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<()>>,
}

/// 持久化 ACP session 句柄，存于 AppState
pub struct PersistentAcpSession {
    pub config_id: i64,
    pub config_fingerprint: String,
    pub request_tx: UnboundedSender<AcpRequest>,
    /// 取消信号：drop 时触发 session 线程 kill child process（oneshot sender）
    pub abort_tx: tokio::sync::oneshot::Sender<()>,
}

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    pub mcp_port: u16,
    /// key = frontend_session_id（UUID 字符串），每个前端 session 独立 ACP 进程
    pub acp_sessions: tokio::sync::Mutex<HashMap<String, PersistentAcpSession>>,
    /// 编辑器 SQL per session，供 MCP get_editor_sql 工具读取
    pub editor_sql_map: tokio::sync::Mutex<HashMap<String, Option<String>>>,
    /// 最近活跃的 session_id（MCP 工具调用时用于查找对应 SQL）
    pub last_active_session_id: tokio::sync::Mutex<Option<String>>,
}
```

- [ ] **Step 2: 修改 `lib.rs`，更新 AppState 初始化**

在 `lib.rs` 顶部确认有 `use std::collections::HashMap;`（若无则添加），找到以下代码块：

```rust
// 当前（lib.rs ~50行附近）
app.manage(crate::state::AppState {
    mcp_port,
    acp_session: tokio::sync::Mutex::new(None),
    current_editor_sql: tokio::sync::Mutex::new(None),
});
```

替换为：

```rust
app.manage(crate::state::AppState {
    mcp_port,
    acp_sessions: tokio::sync::Mutex::new(std::collections::HashMap::new()),
    editor_sql_map: tokio::sync::Mutex::new(std::collections::HashMap::new()),
    last_active_session_id: tokio::sync::Mutex::new(None),
});
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：无 error（`acp_session` / `current_editor_sql` 字段被 commands.rs 引用的编译错误会在 Task 2 中修复，此时可能出现 error，属正常）

---

### Task 2: 重构 `commands.rs` 中的 ACP 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（修改函数 `ai_chat_acp`、`ai_chat_acp_inner`、`get_or_create_session`、`cancel_acp_session`）

- [ ] **Step 1: 更新 `get_or_create_session` 签名与实现**

找到当前 `get_or_create_session`（`commands.rs` ~978 行），整体替换：

```rust
/// 获取当前 session（配置未变）或创建新 session（首次 / 配置变更 / session 已关闭）
async fn get_or_create_session(
    session_id: &str,
    config: &crate::db::models::LlmConfig,
    mcp_port: u16,
    cwd: &std::path::Path,
    state: &tauri::State<'_, crate::AppState>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<crate::llm::StreamEvent>,
) -> AppResult<tokio::sync::mpsc::UnboundedSender<crate::state::AcpRequest>> {
    let mut sessions_guard = state.acp_sessions.lock().await;
    let fingerprint = config_fingerprint(config);

    // 检查现有 session 是否可复用
    if let Some(session) = sessions_guard.get(session_id) {
        if session.config_id == config.id
            && session.config_fingerprint == fingerprint
            && !session.request_tx.is_closed()
        {
            log::debug!(
                "[acp] Reusing existing session (session_id={}, config_id={})",
                session_id, config.id
            );
            return Ok(session.request_tx.clone());
        }
        log::info!(
            "[acp] Session invalid (config changed or closed), rebuilding for session_id={}",
            session_id
        );
        sessions_guard.remove(session_id);
    }

    log::info!(
        "[acp] Creating new session for session_id={} config_id={} model={}",
        session_id, config.id, config.model
    );
    let new_session = crate::acp::session::spawn_acp_session_thread(
        config.api_key.clone(),
        config.base_url.clone(),
        config.model.clone(),
        config.api_type.clone(),
        config.preset.clone(),
        config.id,
        mcp_port,
        cwd.to_path_buf(),
        Some(event_tx.clone()),
    )
    .await?;

    let tx = new_session.request_tx.clone();
    sessions_guard.insert(
        session_id.to_string(),
        crate::state::PersistentAcpSession {
            config_id: new_session.config_id,
            config_fingerprint: fingerprint,
            request_tx: new_session.request_tx,
        },
    );
    Ok(tx)
}
```

- [ ] **Step 2: 更新 `ai_chat_acp_inner` 签名与实现**

找到 `ai_chat_acp_inner`（`commands.rs` ~894 行），整体替换：

```rust
async fn ai_chat_acp_inner(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,          // 新增
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;
    use crate::llm::StreamEvent;

    // 写入编辑器 SQL 到 per-session map，并更新 last_active_session_id
    {
        let mut map = state.editor_sql_map.lock().await;
        map.insert(session_id.clone(), tab_sql.clone());
    }
    {
        let mut last = state.last_active_session_id.lock().await;
        *last = Some(session_id.clone());
    }

    // 1. 获取指定配置（未指定则用默认）
    let config = match config_id {
        Some(id) => crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?,
        None => crate::db::get_default_llm_config()?
            .ok_or_else(|| AppError::Other("No default LLM config found".into()))?,
    };

    // 2. 构建 prompt 文本
    let mut prompt_text = prompt;
    if let Some(conn_id) = connection_id {
        prompt_text = format!("当前数据库连接 ID: {}\n\n{}", conn_id, prompt_text);
    }
    if let Some(sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!(
                "当前编辑器 SQL：\n```sql\n{}\n```\n\n{}",
                sql, prompt_text
            );
        }
    }

    // 3. 工作目录
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into()),
    )
    .join("open-db-studio");
    std::fs::create_dir_all(&cwd).ok();

    // 4. 创建事件转发通道
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 5. 获取或创建 ACP session（传入 session_id）
    let request_tx = get_or_create_session(
        &session_id, &config, state.mcp_port, &cwd, state, &event_tx,
    ).await?;

    // 6. 创建完成信号 channel
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

    // 7. 发送请求给 session 线程
    request_tx
        .send(AcpRequest { prompt_text, event_tx, done_tx })
        .map_err(|_| AppError::Other("ACP session closed unexpectedly".into()))?;

    // 8. 等待完成
    done_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread dropped before responding".into()))?
}
```

- [ ] **Step 3: 更新 `ai_chat_acp` 外层 wrapper，新增 `session_id` 参数**

找到 `ai_chat_acp`（`commands.rs` ~874 行），整体替换：

```rust
#[tauri::command]
pub async fn ai_chat_acp(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,          // 新增
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = ai_chat_acp_inner(
        prompt, tab_sql, connection_id, config_id, session_id, &channel, &state,
    ).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error {
            message: e.to_string(),
        });
    }
    result
}
```

- [ ] **Step 4: 更新 `cancel_acp_session`，新增 `session_id` 参数**

找到 `cancel_acp_session`（`commands.rs` ~1028 行），整体替换：

```rust
#[tauri::command]
pub async fn cancel_acp_session(
    session_id: String,          // 新增：只取消指定 session
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut sessions_guard = state.acp_sessions.lock().await;
    if sessions_guard.remove(&session_id).is_some() {
        log::info!("[acp] Session {} cancelled, thread will exit on next idle", session_id);
    }
    Ok(())
}
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：`state.rs` / `commands.rs` 相关 error 消失，只剩 `mcp/mod.rs` 中 `current_editor_sql` 的 error（下个 Task 修复）

---

### Task 3: 更新 MCP `get_editor_sql` 处理器

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`（仅修改 `"get_editor_sql"` 分支）

- [ ] **Step 1: 替换 `get_editor_sql` 分支**

找到 `mcp/mod.rs` 中 `"get_editor_sql" =>` 分支（~284 行），替换：

```rust
"get_editor_sql" => {
    use tauri::Manager;
    let app_state = handle.state::<crate::AppState>();
    let last_id = app_state.last_active_session_id.lock().await.clone();
    let sql = if let Some(sid) = last_id {
        let map = app_state.editor_sql_map.lock().await;
        map.get(&sid).cloned().flatten()
    } else {
        None
    };
    match sql {
        Some(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok("(编辑器为空)".to_string()),
    }
}
```

- [ ] **Step 2: 完整编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：**0 errors**。若有 warning 可忽略。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands.rs src-tauri/src/mcp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(backend): refactor AppState to HashMap for multi-session ACP support"
```

---

## Chunk 2: 前端 Store 重构

### Task 4: 扩展 TypeScript 类型

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 为 `ChatSession` 添加 `configId` 字段**

找到 `types/index.ts` 中 `ChatSession` 接口（~161 行），替换：

```ts
export interface ChatSession {
  id: string;
  title: string;             // AI 生成的标题，初始为第一条消息的截断
  messages: ChatMessage[];
  createdAt: number;         // Unix timestamp ms
  updatedAt: number;
  titleGenerated: boolean;   // AI 标题是否已生成
  configId: number | null;   // 该 session 使用的模型配置 ID（null = 使用全局默认）
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit 2>&1
```

预期：`ChatSession` 相关 error 出现（`aiStore.ts` 中 sessions 尚未更新），属正常，后续 Task 修复。

---

### Task 5: 重构 aiStore — 状态结构与基础 actions

**Files:**
- Modify: `src/store/aiStore.ts`

此 Task 分步进行，最终完成完整重构。整个文件是核心，仔细替换。

- [ ] **Step 1: 在文件顶部（import 后、`makeDefaultTitle` 前）添加类型定义与 helper**

找到第 7 行 `const makeDefaultTitle` 前，插入：

```ts
// ── per-session 运行时状态（不持久化）────────────────────────────────────────
interface SessionRuntimeState {
  isChatting: boolean;
  streamingContent: string;
  streamingThinkingContent: string;
  activeToolName: string | null;
  sessionStatus: string | null;
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  isChatting: false,
  streamingContent: '',
  streamingThinkingContent: '',
  activeToolName: null,
  sessionStatus: null,
});
```

- [ ] **Step 2: 更新 `AiState` interface**

找到 `interface AiState {`（~47 行），将以下字段替换：

```ts
// 移除这些全局字段：
// activeConfigId: number | null;
// setActiveConfigId: (id: number | null) => void;
// chatHistory: ChatMessage[];
// streamingContent: string;
// streamingThinkingContent: string;
// isChatting: boolean;
// activeToolName: string | null;
// sessionStatus: string | null;
// clearHistory: () => void;
// cancelChat: () => Promise<void>;
```

替换为完整新版 `AiState`：

```ts
interface AiState {
  // ── LLM 配置 ──
  configs: LlmConfig[];
  loadConfigs: () => Promise<void>;
  createConfig: (input: CreateLlmConfigInput) => Promise<void>;
  updateConfig: (id: number, input: UpdateLlmConfigInput) => Promise<void>;
  deleteConfig: (id: number) => Promise<void>;
  setDefaultConfig: (id: number) => Promise<void>;
  testConfig: (id: number) => Promise<void>;

  // ── 多会话管理 ──
  sessions: ChatSession[];
  currentSessionId: string;
  _saveCurrentSession: () => void;
  newSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  setSessionConfigId: (sessionId: string, configId: number | null) => void;

  // ── 当前对话视图缓存 ──
  chatHistory: ChatMessage[];

  // ── per-session 运行时状态（不持久化）──
  chatStates: Record<string, SessionRuntimeState>;

  // ── 对话操作 ──
  clearHistory: (sessionId: string) => Promise<void>;
  cancelChat: (sessionId: string) => Promise<void>;
  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;

  // ── AI 工具功能（per-tab，不与 AI 助手 session 共享状态）──
  // 注意：isExplaining / isOptimizing 是 Record<tabId, boolean>，不是全局 boolean
  isExplaining: Record<string, boolean>;
  isOptimizing: Record<string, boolean>;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  draftMessage: string;
  setDraftMessage: (msg: string) => void;
  explainSql: (
    sql: string,
    connectionId: number | null,
    database: string | null | undefined,
    tabId: string,
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (err: string) => void,
  ) => Promise<void>;
  cancelExplainSql: (tabId: string) => Promise<void>;
  optimizeSql: (sql: string, connectionId: number | null, database: string | null | undefined, tabId: string) => Promise<string>;
  cancelOptimizeSql: (tabId: string) => Promise<void>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}
```

- [ ] **Step 3: 更新 store 初始值**

在 `create<AiState>()` 的初始值中：

```ts
// 移除
activeConfigId: null,
streamingContent: '',
streamingThinkingContent: '',
isChatting: false,
activeToolName: null,
sessionStatus: null,

// 新增
chatStates: {},
```

同时确保初始值包含 `chatHistory: []`（原有，保留）。

- [ ] **Step 4: 替换 `setActiveConfigId` → `setSessionConfigId`**

移除：
```ts
setActiveConfigId: (id) => set({ activeConfigId: id }),
```

新增：
```ts
setSessionConfigId: (sessionId, configId) => {
  set((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, configId } : sess
    ),
  }));
},
```

- [ ] **Step 5: 更新 `newSession`**

找到 `newSession:`，替换整个函数体：

```ts
newSession: () => {
  get()._saveCurrentSession();
  const newId = uuid();
  set((s) => ({
    currentSessionId: newId,
    chatHistory: [],
    chatStates: {
      ...s.chatStates,
      [newId]: defaultRuntimeState(),
    },
  }));
  // 注意：不再调用 cancel_acp_session，后台 session 继续运行
},
```

- [ ] **Step 6: 更新 `switchSession`**

找到 `switchSession:`，替换整个函数体：

```ts
switchSession: (id) => {
  get()._saveCurrentSession();
  // 从 sessions 取最新 messages（可能已被后台 commitAssistant 更新）
  const target = get().sessions.find((s) => s.id === id);
  if (!target) return;
  set({
    currentSessionId: id,
    chatHistory: target.messages,
    // 注意：不重置 chatStates，后台 channel 继续运行
  });
  // 注意：不再调用 cancel_acp_session
},
```

- [ ] **Step 7: 更新 `deleteSession`（改为 async）**

找到 `deleteSession:`，替换：

```ts
deleteSession: async (id) => {
  // 若正在流式，先取消（必须 await，确保 commitAssistant 不再触发）
  if (get().chatStates[id]?.isChatting) {
    await get().cancelChat(id);
  }
  // 清理 chatStates
  set((s) => {
    const { [id]: _removed, ...restStates } = s.chatStates;
    return { chatStates: restStates };
  });
  const { currentSessionId, sessions } = get();
  set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
  // 若删除的是当前 session，切换到其他会话
  if (id === currentSessionId) {
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length > 0) {
      const next = remaining[0];
      set({ currentSessionId: next.id, chatHistory: next.messages });
    } else {
      const newId = uuid();
      set({ currentSessionId: newId, chatHistory: [] });
    }
  }
},
```

- [ ] **Step 8: 更新 `cancelChat`（改为接收 sessionId 参数）**

找到 `cancelChat:`，替换：

```ts
cancelChat: async (sessionId) => {
  const state = get().chatStates[sessionId];
  const streamingContent = state?.streamingContent ?? '';
  const streamingThinkingContent = state?.streamingThinkingContent ?? '';
  const isCurrentSession = get().currentSessionId === sessionId;

  // 将截断的流式内容保存到正确的 session
  if (streamingContent) {
    const truncatedMsg = {
      role: 'assistant' as const,
      content: streamingContent,
      thinkingContent: streamingThinkingContent || undefined,
    };
    const now = Date.now();
    set((s) => {
      const existing = s.sessions.find((sess) => sess.id === sessionId);
      const updatedMessages = existing
        ? [...existing.messages, truncatedMsg]
        : [...s.chatHistory, truncatedMsg];
      const updatedSessions = existing
        ? s.sessions.map((sess) =>
            sess.id === sessionId
              ? { ...sess, messages: updatedMessages, updatedAt: now }
              : sess
          )
        : [
            {
              id: sessionId,
              title: makeDefaultTitle(
                updatedMessages.find((m) => m.role === 'user')?.content ?? '新对话'
              ),
              messages: updatedMessages,
              createdAt: now,
              updatedAt: now,
              titleGenerated: false,
              configId: null,
            },
            ...s.sessions,
          ];
      return {
        sessions: updatedSessions,
        chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
        ...(isCurrentSession ? { chatHistory: updatedMessages } : {}),
      };
    });
  } else {
    // 无截断内容，只重置运行时状态
    set((s) => ({
      chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
    }));
  }

  try {
    await invoke('cancel_acp_session', { sessionId });
  } catch (_) {
    // session 可能已不存在
  }
},
```

- [ ] **Step 9: 更新 `clearHistory`（改为 async，接收 sessionId 参数）**

找到 `clearHistory:`，替换：

```ts
clearHistory: async (sessionId) => {
  // 必须 await cancelChat，防止 cancel 完成前 commitAssistant 仍写入
  if (get().chatStates[sessionId]?.isChatting) {
    await get().cancelChat(sessionId);
  }
  const isCurrentSession = get().currentSessionId === sessionId;
  set((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, messages: [], updatedAt: Date.now() } : sess
    ),
    chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
    ...(isCurrentSession ? { chatHistory: [] } : {}),
  }));
  // 注意：不在此处调用 cancel_acp_session
  // 若 isChatting 为 true，cancelChat 已处理取消；
  // 若 isChatting 为 false，ACP 进程应保持活跃供下次复用
},
```

- [ ] **Step 10: 类型检查验证**

```bash
npx tsc --noEmit 2>&1
```

预期：`aiStore.ts` 相关 error 减少，`sendAgentChatStream` 相关 error 在 Task 6 修复。

---

### Task 6: 重构 `sendAgentChatStream` 与 `commitAssistant`

**Files:**
- Modify: `src/store/aiStore.ts`（仅 `sendAgentChatStream` 函数体）

- [ ] **Step 1: 完整替换 `sendAgentChatStream` 函数体**

找到 `sendAgentChatStream: async (message, connectionId) => {`（~282 行），替换整个函数体：

```ts
sendAgentChatStream: async (message, connectionId) => {
  // 捕获发送时的 sessionId（后续所有操作基于此，不使用 get().currentSessionId）
  const sessionId = get().currentSessionId;

  // 读取 tabSql（当前编辑器 SQL）
  const { useQueryStore } = await import('./queryStore');
  const queryStore = useQueryStore.getState();
  const activeTabId = queryStore.activeTabId;
  const tabSql: string | null = activeTabId
    ? queryStore.sqlContent[activeTabId] ?? null
    : null;

  // 并发上限检查（不超过 10 个同时 isChatting 的 session）
  const activeChatCount = Object.values(get().chatStates).filter((s) => s.isChatting).length;
  if (activeChatCount >= 10) {
    // 由 UI 层检查并展示 toast，此处直接 return
    return;
  }

  // 从 sessions 读取该 session 的 configId（不从 chatStates 读）
  const configId = get().sessions.find((s) => s.id === sessionId)?.configId ?? null;

  // 追加用户消息到 chatHistory（当前 session 的视图缓存）
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: {
        ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
        isChatting: true,
        streamingContent: '',
        streamingThinkingContent: '',
        activeToolName: null,
        sessionStatus: null,
      },
    },
    chatHistory: [...s.chatHistory, { role: 'user' as const, content: message }],
  }));

  // 记录是否是本次 session 的第一轮对话（用于触发 AI 标题生成）
  const isFirstRound = get().chatHistory.filter((m) => m.role === 'assistant').length === 0;

  // commitAssistant：将完整 AI 回复写入正确 session，不依赖全局 chatHistory
  const commitAssistant = (content: string, thinking: string) => {
    // Guard 1: session 已被删除
    if (!get().sessions.find((s) => s.id === sessionId)) return;
    // Guard 2: 已被 cancel
    if (!get().chatStates[sessionId]?.isChatting) return;

    const newMsg = {
      role: 'assistant' as const,
      content,
      thinkingContent: thinking || undefined,
    };
    const now = Date.now();
    const isCurrentSession = get().currentSessionId === sessionId;

    set((s) => {
      const existing = s.sessions.find((sess) => sess.id === sessionId);
      // existing.messages 是正确的源（可能已被 _saveCurrentSession 写入）
      const baseMessages = existing ? existing.messages : s.chatHistory;
      const updatedMessages = [...baseMessages, newMsg];

      const updatedSessions = existing
        ? s.sessions.map((sess) =>
            sess.id === sessionId
              ? { ...sess, messages: updatedMessages, updatedAt: now }
              : sess
          )
        : [
            {
              id: sessionId,
              title: makeDefaultTitle(
                updatedMessages.find((m) => m.role === 'user')?.content ?? '新对话'
              ),
              messages: updatedMessages,
              createdAt: now,
              updatedAt: now,
              titleGenerated: false,
              configId,
            },
            ...s.sessions,
          ];

      return {
        sessions: updatedSessions,
        chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
        // 若是当前 session，同步更新视图缓存
        ...(isCurrentSession ? { chatHistory: updatedMessages } : {}),
      };
    });

    // 使用闭包捕获的 sessionId，不使用 get().currentSessionId
    if (isFirstRound && content && !content.startsWith('Error:')) {
      requestAiTitle(sessionId, message, content);
    }
  };

  try {
    const { Channel } = await import('@tauri-apps/api/core');
    const channel = new Channel<{
      type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
      data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
    }>();

    let contentBuf = '';
    let thinkingBuf = '';
    let rafId: number | null = null;

    const flushBuffers = () => {
      rafId = null;
      if (contentBuf) {
        const delta = contentBuf; contentBuf = '';
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: {
              ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
              streamingContent: (s.chatStates[sessionId]?.streamingContent ?? '') + delta,
            },
          },
        }));
      }
      if (thinkingBuf) {
        const delta = thinkingBuf; thinkingBuf = '';
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: {
              ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
              streamingThinkingContent: (s.chatStates[sessionId]?.streamingThinkingContent ?? '') + delta,
            },
          },
        }));
      }
    };

    const scheduleFlush = () => {
      if (!rafId) rafId = requestAnimationFrame(flushBuffers);
    };

    const flushNow = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; flushBuffers(); }
    };

    const setChatStateField = (fields: Partial<SessionRuntimeState>) => {
      set((s) => ({
        chatStates: {
          ...s.chatStates,
          [sessionId]: { ...(s.chatStates[sessionId] ?? defaultRuntimeState()), ...fields },
        },
      }));
    };

    channel.onmessage = (event) => {
      if (event.type === 'StatusUpdate' && event.data?.message) {
        setChatStateField({ sessionStatus: event.data.message });
      } else if (event.type === 'ThinkingChunk' && event.data?.delta) {
        setChatStateField({ sessionStatus: null });
        thinkingBuf += event.data.delta;
        scheduleFlush();
      } else if (event.type === 'ContentChunk' && event.data?.delta) {
        setChatStateField({ sessionStatus: null });
        contentBuf += event.data.delta;
        scheduleFlush();
      } else if (event.type === 'ToolCallRequest' && event.data?.name) {
        flushNow();
        setChatStateField({ activeToolName: event.data.name, sessionStatus: null });
      } else if (event.type === 'Done') {
        flushNow();
        if (!get().chatStates[sessionId]?.isChatting) return;
        const state = get().chatStates[sessionId];
        commitAssistant(state?.streamingContent ?? '', state?.streamingThinkingContent ?? '');
      } else if (event.type === 'Error') {
        flushNow();
        if (!get().chatStates[sessionId]?.isChatting) return;
        commitAssistant(`Error: ${event.data?.message ?? 'Unknown error'}`, '');
      }
    };

    await invoke('ai_chat_acp', {
      prompt: message,
      tabSql,
      connectionId,
      configId,
      sessionId,    // 新增
      channel,
    });
  } catch (e) {
    commitAssistant(`Error: ${String(e)}`, '');
  }
},
```

- [ ] **Step 2: 删除 store 初始值中遗留的全局流式字段**

确认 store 初始值中已移除（若仍存在则删除）：
- `activeConfigId: null`
- `streamingContent: ''`
- `streamingThinkingContent: ''`
- `isChatting: false`
- `activeToolName: null`
- `sessionStatus: null`

- [ ] **Step 3: 类型检查验证**

```bash
npx tsc --noEmit 2>&1
```

预期：aiStore 相关 error 归零（Assistant/index.tsx 中引用旧字段的 error 在 Task 7 修复）。

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/store/aiStore.ts
git commit -m "feat(store): refactor aiStore to per-session chatStates for background streaming"
```

---

## Chunk 3: 前端 UI 适配

### Task 7: 更新 `Assistant/index.tsx`

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: 更新 store 字段引用**

找到 `useAiStore()` 的解构（~176 行），替换：

```ts
const {
  sendAgentChatStream, clearHistory, newSession, switchSession, deleteSession,
  sessions, currentSessionId, configs, setSessionConfigId, loadConfigs, cancelChat,
  chatStates,
} = useAiStore();

// per-session 运行时状态（只读当前 session）
const isChatting = chatStates[currentSessionId]?.isChatting ?? false;
const activeToolName = chatStates[currentSessionId]?.activeToolName ?? null;
```

- [ ] **Step 2: 更新 `StreamingMessage` 组件，接收 `sessionId` prop**

找到 `const StreamingMessage: React.FC = () => {`（~132 行），替换整个组件：

```ts
const StreamingMessage: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const content = useAiStore((s) => s.chatStates[sessionId]?.streamingContent ?? '');
  const thinking = useAiStore((s) => s.chatStates[sessionId]?.streamingThinkingContent ?? '');
  const sessionStatus = useAiStore((s) => s.chatStates[sessionId]?.sessionStatus ?? null);

  return (
    <div className="flex flex-col items-start">
      <div className="text-[#c8daea] text-[13px] w-full">
        {thinking && <ThinkingBlock content={thinking} isStreaming={true} />}
        {content ? (
          <MarkdownContent content={content} />
        ) : sessionStatus ? (
          <div className="flex items-center gap-2 py-1">
            <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
            <span className="text-xs text-[#5b8ab0] animate-pulse">{sessionStatus}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
```

- [ ] **Step 3: 更新自动滚底 useEffect，订阅当前 session 的 streamingContent**

找到以下 useEffect（~200 行）：

```ts
const streamingContent = useAiStore((s) => s.streamingContent);
useEffect(() => {
  chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
}, [chatHistory, streamingContent]);
```

替换为：

```ts
const streamingContent = useAiStore(
  (s) => s.chatStates[currentSessionId]?.streamingContent
);
useEffect(() => {
  chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
}, [chatHistory, streamingContent, currentSessionId]);
```

- [ ] **Step 4: 更新 `handleSendMessage` — 添加并发上限检查**

找到 `handleSendMessage`（~209 行），在 `const prompt = chatInput.trim();` 后添加：

```ts
// 并发上限检查
const activeChatCount = Object.values(chatStates).filter((s) => s.isChatting).length;
if (activeChatCount >= 10) {
  showToast('已有多个对话正在进行，请等待其完成后再发送新消息', 'warning');
  return;
}
```

- [ ] **Step 5: 更新 header 中 `clearHistory` 和 `cancelChat` 调用**

找到 header 区域（~329 行），更新调用：

```tsx
// clearHistory 按钮（~329行）
onClick={() => { clearHistory(currentSessionId); showToast(t('assistant.historyCleared'), 'info'); }}

// cancelChat 按钮（~295-302行）
onClick={() => cancelChat(currentSessionId)}
```

- [ ] **Step 6: 更新模型选择器，使用 `setSessionConfigId`**

找到模型选择器中 `setActiveConfigId(c.id)` 的调用（~275 行），替换：

```ts
// 读取当前 session 的 configId
const activeConfigId = sessions.find((s) => s.id === currentSessionId)?.configId ?? null;

// 点击事件（~276行）
onClick={() => {
  if (!isConnected) return;
  const hasHistory = (sessions.find(s => s.id === currentSessionId)?.messages.length ?? 0) > 0;
  setSessionConfigId(currentSessionId, c.id);
  setIsModelMenuOpen(false);
  if (hasHistory) {
    showToast('已切换模型，新消息将使用新模型，ACP 上下文已重置', 'info');
  }
}}
```

同时更新 `isActive` 判断（~266 行）：

```ts
const isActive = activeConfigId === c.id || (!activeConfigId && c.is_default);
```

- [ ] **Step 7: 更新历史列表 — 添加后台流式角标**

找到历史列表中 `sess.title` 的渲染块（~386 行），在 `{sess.title}` 旁添加角标：

```tsx
<div className={`text-[12px] font-medium truncate leading-tight flex items-center gap-1.5 ${isActive ? 'text-[#c8daea]' : 'text-[#8ab0cc]'}`}>
  <span className="truncate">{sess.title}</span>
  {!sess.titleGenerated && (
    <span className="text-[10px] text-[#4a6a8a] animate-pulse flex-shrink-0">•</span>
  )}
  {chatStates[sess.id]?.isChatting && (
    <RefreshCw size={10} className="animate-spin text-[#00c9a7] flex-shrink-0" />
  )}
</div>
```

- [ ] **Step 8: 更新 `<StreamingMessage />` 渲染，传入 sessionId**

找到 `{isChatting && <StreamingMessage />}`（~456 行），替换：

```tsx
{isChatting && <StreamingMessage sessionId={currentSessionId} />}
```

- [ ] **Step 9: 更新 `isEmpty` 判断**

找到 `const isEmpty = chatHistory.length === 0 && !isChatting;`（~317 行），确认 `isChatting` 已是 per-session 版本（Step 1 已更新，此处无需修改）。

- [ ] **Step 10: 完整类型检查**

```bash
npx tsc --noEmit 2>&1
```

预期：**0 errors**。

- [ ] **Step 11: Rust 编译再次验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：**0 errors**。

- [ ] **Step 12: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(ui): update Assistant to per-session streaming state and background indicator"
```

---

## 手动验证清单

完成所有 Task 后，执行 `npm run tauri:dev` 并验证以下场景：

- [ ] **场景 1（基础功能）**：打开助手，发送消息，验证流式输出正常，AI 回复完整显示。
- [ ] **场景 2（后台流式）**：Session A 流式输出中，点击"新建对话"→ 发送 Session B 消息 → 切回 Session A：若已完成则显示完整消息，若仍在流式则继续显示。
- [ ] **场景 3（后台角标）**：Session A 后台流式时，历史列表中 Session A 标题旁显示旋转绿色图标；完成后消失。
- [ ] **场景 4（模型切换）**：有历史消息的 session 中切换模型，出现"已切换模型，ACP 上下文已重置"提示。
- [ ] **场景 5（停止生成）**：流式中点击停止按钮，截断内容正确保存，不影响其他 session。
- [ ] **场景 6（删除 session）**：删除后台仍在流式的 session，流停止，其他 session 不受影响。
- [ ] **场景 7（清空历史）**：对当前 session 清空历史，消息列表清空，后台未运行的其他 session 不受影响。
- [ ] **场景 8（应用重启）**：关闭重启应用，历史会话列表保留，`isChatting` 全部为 false，无旋转图标。
