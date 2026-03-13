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

### 并发进程临时上限

当前阶段不设硬性上限，但前端发送请求前需检查：若当前活跃 `isChatting=true` 的 session 数量已达 **10 个**，UI 给出提示"已有多个对话正在进行，请等待其完成后再发送新消息"，并阻止本次发送。后续迭代根据实际内存/性能情况调整上限或实现真正的资源管理策略。

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

`configId` 属于持久化配置，存于 `ChatSession`，不在此类型中。

```ts
// src/store/aiStore.ts（新增）
interface SessionRuntimeState {
  isChatting: boolean
  streamingContent: string
  streamingThinkingContent: string
  activeToolName: string | null
  sessionStatus: string | null
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  isChatting: false,
  streamingContent: '',
  streamingThinkingContent: '',
  activeToolName: null,
  sessionStatus: null,
})
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
chatStates: Record<string, SessionRuntimeState>  // key = sessionId，运行时，不持久化
```

**`chatHistory` 字段保留**，继续作为"当前 session 视图缓存"：切换 session 时通过 `set({ chatHistory: target.messages })` 同步为目标 session 的消息列表，UI 组件渲染 `chatHistory` 不变。后台 session 完成推理时直接写入 `sessions[id].messages`，并在下次该 session 被激活时通过 `switchSession` 同步到 `chatHistory`；若该 session 恰好是当前 session，则同时更新 `chatHistory`。

### 新增 action

```ts
setSessionConfigId: (sessionId: string, configId: number | null) => void
// 实现：更新 sessions 数组中对应 session 的 configId 字段，并持久化
```

### `sendAgentChatStream` 变更要点

1. **`configId` 只从 `sessions` 读取**：`sessions.find(s => s.id === sessionId)?.configId ?? null`（`SessionRuntimeState` 不含 `configId`）
2. 向后端传递 `session_id: sessionId`
3. `channel.onmessage` 回调闭包捕获 `sessionId`，所有 `chatStates` 更新写入 `chatStates[sessionId]`，不使用 `currentSessionId`
4. Done/Error 守卫改为 `if (!get().chatStates[sessionId]?.isChatting) return`
5. **`commitAssistant` 直接写入 `sessions[sessionId].messages`**：不依赖全局 `chatHistory` + `currentSessionId`。若 `sessionId === get().currentSessionId`，同时更新 `chatHistory` 保持视图同步
6. **`requestAiTitle` 使用闭包捕获的 `sessionId`**，不使用 `get().currentSessionId`：`requestAiTitle(sessionId, message, content)`

### `switchSession` 变更

```ts
// 移除
invoke('cancel_acp_session').catch(() => {})
set({ streamingContent: '', streamingThinkingContent: '', isChatting: false })

// 保留（同步当前 session 视图缓存）
_saveCurrentSession()
// 从 sessions 中取目标 session 的最新 messages（可能已被后台 commitAssistant 更新）
const target = get().sessions.find(s => s.id === id)
set({ currentSessionId: id, chatHistory: target?.messages ?? [] })
// 注意：不重置 chatStates，后台 channel 继续接收和写入
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

// 实现要点：
// 1. 从 chatStates[sessionId] 读取 streamingContent（不是全局字段）
// 2. 若有截断内容，直接写入 sessions[sessionId].messages（不写 chatHistory）
// 3. 若 sessionId === currentSessionId，同时更新 chatHistory
// 4. 重置 chatStates[sessionId] 为 defaultRuntimeState()
// 5. invoke('cancel_acp_session', { sessionId })
```

### `clearHistory` 变更

```ts
// 改为 async，新增 sessionId 参数
clearHistory: async (sessionId: string) => Promise<void>

// 实现要点：
// 1. 若 chatStates[sessionId].isChatting，await cancelChat(sessionId)
//    （必须 await，防止 cancel 完成前 commitAssistant 仍触发写入，
//     导致清空后消息被重新写入）
// 2. 清空 sessions[sessionId].messages
// 3. 若 sessionId === currentSessionId，同时清空 chatHistory
// 4. 重置 chatStates[sessionId] 为 defaultRuntimeState()
```

### `deleteSession` 变更

```ts
// 改为 async
deleteSession: async (id: string) => Promise<void>

// 实现要点：
// 1. 若 chatStates[id].isChatting，await cancelChat(id)
//    （必须 await：cancel 完成后 commitAssistant 的 Done 守卫
//     `if (!get().chatStates[id]?.isChatting) return` 会提前退出，
//     确保不再向已删除的 session 写入消息）
// 2. 清理 chatStates[id]
// 3. 从 sessions 数组中移除该 session
// 4. 若删除的是当前 session，切换到剩余会话或新建空会话
```

**`commitAssistant` 额外守卫**：在 `commitAssistant` 内部开头增加检查：
```ts
// session 已被删除时直接 return，防止孤儿回调写入
if (!get().sessions.find(s => s.id === sessionId)) return
```
此守卫作为双重保险，配合 `deleteSession` 的 `await cancelChat` 一起防止竞态。

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
// currentSessionId 切换时 effect 重新执行，自动滚底追上后台已输出的内容
```

### 输入框禁用条件

```ts
const isChatting = useAiStore(
  (s) => s.chatStates[currentSessionId]?.isChatting ?? false
)

// 发送前额外检查并发上限
const activeChatCount = Object.values(chatStates).filter(s => s.isChatting).length
if (activeChatCount >= 10) {
  showToast('已有多个对话正在进行，请等待其完成后再发送', 'warning')
  return
}
```

### 历史会话列表角标

正在后台流式输出的 session 在列表中显示旋转图标：

```tsx
{chatStates[session.id]?.isChatting && (
  <RefreshCw size={12} className="animate-spin text-[#00c9a7]" />
)}
```

### 模型选择器

```ts
// 当前
setActiveConfigId(c.id)

// 改后：写入当前 session 的 configId（持久化到 sessions）
setSessionConfigId(currentSessionId, c.id)
// 若该 session 已有对话历史（messages.length > 0），显示提示：
// "已切换模型，新消息将使用新模型，ACP 上下文已重置"
```

---

## 数据流（正常场景）

```
用户在 Session A 发消息
  → sendAgentChatStream(msg, connId)  [闭包捕获 sessionId=A]
  → chatStates[A].isChatting = true
  → invoke('ai_chat_acp', { session_id: A, config_id: sessions[A].configId, ... })
  → Rust: acp_sessions[A] 启动/复用 ACP 进程
  → channel.onmessage → chatStates[A].streamingContent 追加

用户切换到 Session B
  → switchSession(B)（不 cancel，不清 chatStates）
  → chatHistory = sessions[B].messages（视图切换）
  → chatStates[A] 继续被 channel 回调更新（后台）
  → 历史列表中 Session A 显示旋转图标

Session A 的 ACP 进程推理完成
  → channel: Done event → commitAssistant(content, thinking, sessionId=A)
  → sessions[A].messages 追加完整消息（直接写，不经 chatHistory）
  → chatStates[A].isChatting = false，streamingContent = ''
  → 历史列表中 Session A 旋转图标消失
  → requestAiTitle(sessionId=A, ...)（使用闭包 sessionId，非 currentSessionId）

用户切回 Session A
  → switchSession(A)
  → chatHistory = sessions[A].messages（已包含完整消息）
  → streamingContent 为空，无流式气泡
  → 自动滚底至最新消息
```

---

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 后台 session 推理失败 | `commitAssistant` 写入 `Error: ...` 到 `sessions[sessionId].messages`；`chatStates[sessionId].isChatting = false`；列表角标消失 |
| 配置被删除后发送消息 | 返回明确错误，前端 toast 提示"模型配置不存在，请重新选择" |
| 模型切换导致 ACP 重建 | 前端提示"已切换模型，ACP 上下文已重置"，对话历史保留 |
| 应用重启 | `chatStates` 不持久化，重启后所有 session 的 `isChatting = false`；`sessions` 历史消息保留 |
| 并发 session 超过 10 个 | UI 阻止发送并 toast 提示，不调用后端 |

---

## 不在本次范围内

- 多面板并排 UI
- session 间消息引用/跨 session 上下文
- ACP 进程数量精细化内存管理（当前以 10 并发上限临时保护）
