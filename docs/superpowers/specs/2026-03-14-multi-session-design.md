# Multi-Session Background Streaming Design

**Date**: 2026-03-14
**Status**: Approved
**Feature**: AI 助手多 session 后台流式输出（类 ChatGPT 后台静默模式）

---

## 目标

用户在 Session A 流式输出期间可切走开启 Session B 聊新话题；切回 Session A 时，若已完成则展示完整内容，若仍在输出则继续显示流式内容并自动滚底。每个 session 独立并发推理，互不干扰。

---

## 范围

| 层 | 文件 | 变更类型 |
|----|------|---------|
| Rust 后端 | `src-tauri/src/state.rs` | 重构 |
| Rust 后端 | `src-tauri/src/commands.rs` | 修改 |
| 前端 Store | `src/store/aiStore.ts` | 重构 |
| 前端类型 | `src/types/index.ts` | 扩展 |
| 前端 UI | `src/components/Assistant/index.tsx` | 修改 |

---

## 后端设计

### AppState 变更

```rust
// 当前
pub struct AppState {
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
}

// 改后
pub struct AppState {
    // key = frontend_session_id（UUID 字符串）
    pub acp_sessions: tokio::sync::Mutex<HashMap<String, PersistentAcpSession>>,
    // key = frontend_session_id
    pub editor_sql_map: tokio::sync::Mutex<HashMap<String, Option<String>>>,
}
```

**key 选择理由**：ACP 进程内部维护对话上下文，每个前端 session 必须拥有独立 ACP 进程。即使两个 session 使用相同模型配置，也不能共享 ACP 进程（否则对话上下文混用）。

### `PersistentAcpSession` 不变

继续保留 `config_id` 和 `config_fingerprint` 字段，用于检测配置变更。

### `ai_chat_acp` 命令新增参数

```rust
pub async fn ai_chat_acp(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,          // 新增：前端 session UUID
    channel: tauri::ipc::Channel<StreamEvent>,
    state: tauri::State<'_, AppState>,
) -> AppResult<()>
```

`session_id` 用于：
1. 在 `acp_sessions` HashMap 中定位或创建对应的 ACP 进程
2. 写入 `editor_sql_map[session_id]`，供 MCP `get_editor_sql` 工具读取

### `cancel_acp_session` 新增参数

```rust
pub async fn cancel_acp_session(
    session_id: String,          // 新增：只取消指定 session
    state: tauri::State<'_, AppState>,
) -> AppResult<()>
```

取消逻辑：drop 对应 session 的 `request_tx`，ACP 进程检测到 sender 关闭后自行退出。

### 配置变更处理

| 场景 | 处理方式 |
|------|---------|
| Settings 修改配置内容（API Key / URL / model） | `config_fingerprint` 不匹配，下次请求时关闭旧 ACP 进程并创建新进程 |
| Session 内切换模型（`config_id` 变化） | `config_id` 不匹配，关闭旧 ACP 进程并创建新进程；前端提示"ACP 上下文已重置" |
| 配置被删除 | 找不到 config → 返回错误，前端显示提示；后端清理对应 `acp_sessions` 条目 |

### `get_or_create_session` 逻辑变更

```
输入：session_id, config
1. 从 acp_sessions[session_id] 取现有 session
2. 若存在且 config_id 匹配且 fingerprint 匹配且 request_tx 未关闭 → 复用
3. 否则 → 关闭旧进程（若存在），spawn 新 ACP 进程，存入 acp_sessions[session_id]
```

---

## 前端类型变更

### `ChatSession` 扩展

```ts
// src/types/index.ts
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  titleGenerated: boolean
  configId: number | null    // 新增：该 session 使用的模型配置 ID
}
```

### `SessionRuntimeState` 新增类型

```ts
// src/store/aiStore.ts（新增）
interface SessionRuntimeState {
  isChatting: boolean
  streamingContent: string
  streamingThinkingContent: string
  activeToolName: string | null
  sessionStatus: string | null
}
```

---

## 前端 Store 重构（aiStore.ts）

### 状态结构变更

```ts
// 移除
activeConfigId: number | null
isChatting: boolean
streamingContent: string
streamingThinkingContent: string
activeToolName: string | null
sessionStatus: string | null

// 新增
chatStates: Record<string, SessionRuntimeState>  // key = sessionId
```

`chatStates` 为纯运行时状态，**不持久化**到 localStorage。`sessions` 持久化范围不变。

### 新增 action

```ts
setSessionConfigId: (sessionId: string, configId: number | null) => void
```

### `sendAgentChatStream` 变更要点

1. 从 `chatStates[sessionId].configId ?? sessions.find(s=>s.id===sessionId)?.configId` 读取 `configId`
2. 向后端传递 `session_id: sessionId`
3. `channel.onmessage` 回调闭包捕获 `sessionId`，所有状态更新写入 `chatStates[sessionId]`
4. Done/Error 守卫改为 `if (!get().chatStates[sessionId]?.isChatting) return`
5. AI 回复完成后自动保存 session 快照逻辑不变

### `switchSession` 变更

```ts
// 移除
invoke('cancel_acp_session').catch(() => {})
set({ streamingContent: '', streamingThinkingContent: '', isChatting: false })

// 保留
_saveCurrentSession()
set({ currentSessionId: id, chatHistory: target.messages })
// 注意：不重置 chatStates，后台 channel 继续接收
```

### `newSession` 变更

```ts
// 移除
invoke('cancel_acp_session').catch(() => {})

// 新增：初始化新 session 的 chatStates 条目
set((s) => ({
  chatStates: {
    ...s.chatStates,
    [newId]: defaultRuntimeState(),
  }
}))
```

### `cancelChat` 变更

```ts
// 新增 sessionId 参数
cancelChat: async (sessionId: string) => void

// 调用
invoke('cancel_acp_session', { sessionId })
```

### `deleteSession` 变更

```ts
deleteSession: (id) => {
  // 若正在流式，先取消
  if (get().chatStates[id]?.isChatting) {
    get().cancelChat(id)
  }
  // 清理 chatStates
  set((s) => {
    const { [id]: _, ...rest } = s.chatStates
    return { chatStates: rest }
  })
  // 原有删除逻辑不变
}
```

---

## 前端 UI 变更（Assistant/index.tsx）

### `StreamingMessage` per-session 化

```ts
// 接收 sessionId prop
const StreamingMessage: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const content = useAiStore((s) => s.chatStates[sessionId]?.streamingContent ?? '')
  const thinking = useAiStore((s) => s.chatStates[sessionId]?.streamingThinkingContent ?? '')
  const sessionStatus = useAiStore((s) => s.chatStates[sessionId]?.sessionStatus ?? null)
  // ...渲染逻辑不变
}
```

### 自动滚底

```ts
const streamingContent = useAiStore(
  (s) => s.chatStates[currentSessionId]?.streamingContent
)
useEffect(() => {
  chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [chatHistory, streamingContent])
// currentSessionId 切换时 effect 重新执行，自动滚底
```

### 输入框禁用条件

```ts
const isChatting = useAiStore(
  (s) => s.chatStates[currentSessionId]?.isChatting ?? false
)
```

### 历史会话列表角标

正在后台流式输出的 session 在列表中显示旋转图标：

```tsx
{get().chatStates[session.id]?.isChatting && (
  <RefreshCw size={12} className="animate-spin text-[#00c9a7]" />
)}
```

### 模型选择器

```ts
// 当前
setActiveConfigId(c.id)

// 改后
setSessionConfigId(currentSessionId, c.id)
// 若该 session 已有对话历史，同时显示提示：
// "已切换模型，新消息将使用新模型，ACP 上下文已重置"
```

---

## 数据流（正常场景）

```
用户在 Session A 发消息
  → sendAgentChatStream(msg, connId)  [捕获 sessionId=A]
  → chatStates[A].isChatting = true
  → invoke('ai_chat_acp', { session_id: A, ... })
  → Rust: acp_sessions[A] 启动/复用 ACP 进程
  → channel.onmessage → chatStates[A].streamingContent 追加

用户切换到 Session B
  → switchSession(B)（不 cancel，不清 chatStates）
  → chatStates[A] 继续被 channel 回调更新（后台）
  → 历史列表中 Session A 显示旋转图标

Session A 的 ACP 进程推理完成
  → channel: Done event
  → chatStates[A].isChatting = false
  → chatHistory 追加完整消息，session 快照自动保存
  → 历史列表中 Session A 旋转图标消失

用户切回 Session A
  → chatHistory 已包含完整消息，直接展示
  → streamingContent 为空，无流式气泡
```

---

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 后台 session 推理失败 | `chatStates[id]` 追加 `Error: ...` 消息，`isChatting = false`，列表角标消失 |
| 配置被删除后发送消息 | 返回明确错误，前端 toast 提示"模型配置不存在，请重新选择" |
| 模型切换导致 ACP 重建 | 前端提示"已切换模型，ACP 上下文已重置"，对话历史保留 |
| 应用重启 | `chatStates` 不持久化，重启后所有 session 的 `isChatting = false`；`sessions` 历史消息保留 |

---

## 不在本次范围内

- 多面板并排 UI
- session 间消息引用/跨 session 上下文
- ACP 进程数量上限与内存管理策略
