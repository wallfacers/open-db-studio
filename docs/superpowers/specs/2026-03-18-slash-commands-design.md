# Slash Command Menu — 设计文档

**日期：** 2026-03-18
**状态：** 已批准（v2，修复审查问题）
**范围：** Assistant 面板输入框斜杠命令下拉菜单

---

## 1. 背景与目标

OpenCode TUI 提供 `/undo`、`/redo`、`/compact` 等操作反馈命令。当前 Assistant 面板缺少对这些命令的 GUI 联动支持，用户无法在不离开界面的情况下执行撤销、恢复或压缩会话等操作。

**目标：** 在输入框新增斜杠命令触发机制，用户输入 `/` 后弹出下拉菜单，选择命令后执行对应 OpenCode REST API 操作。

**核心约束：不破坏现有任何功能。** 新增代码与现有逻辑路径严格隔离；`handleKeyDown` 有一处必要的保护性修改（见 4.3 节）。

---

## 2. 支持的命令

| 命令 | 描述 | 后端 API | 禁用条件 |
|------|------|----------|----------|
| `/undo` | 撤销最后一轮对话 | `POST /session/:id/revert` | 无历史 / 正在回复 / 无 messageId / 正在 compact |
| `/redo` | 恢复被撤销的对话 | `POST /session/:id/unrevert` | `canRedo = false` |
| `/compact` | 压缩会话 context | `POST /session/:id/summarize` | 消息 < 4 条 / 正在回复 / `isCompacting = true` |
| `/new` | 新建会话 | 已有 `newSession()` | 无 |
| `/clear` | 清空当前会话 | 已有 `clearHistory()` | 无历史消息时隐藏 |

---

## 3. 交互设计

### 3.1 触发与关闭

- **触发：** textarea 内容以 `/` 开头时激活下拉（`onChange` 检测）
- **过滤：** `/un` → 只显示 `/undo`；空 `/` 显示全部可用命令
- **关闭条件：**
  - Escape 键
  - 输入中出现空格（`/ ` 或 `/undo ` 均关闭）
  - 剩余字符不匹配任何命令前缀
  - 删除 `/` 使内容不以 `/` 开头
  - 命令执行后
  - 点击下拉区域外
- **不使用字符长度上限**（避免用户回删时下拉闪烁）

### 3.2 键盘导航

- `↑` / `↓`：移动游标
- `Enter`：执行当前高亮命令，**同时阻止现有的 send 逻辑**（见 4.3）
- `Escape`：关闭不执行

### 3.3 视觉布局

```
┌─────────────────────────────────────┐
│ ↩ /undo    撤销最后一轮对话          │  ← 高亮选中
│ ↪ /redo    恢复撤销的对话   [禁用]   │
│ ⚡ /compact  压缩会话 context        │
│ +  /new    新建会话                  │
│ 🗑 /clear   清空当前会话             │
├─────────────────────────────────────┤
│  textarea（当前输入 "/"）            │
└─────────────────────────────────────┘
```

- 浮层定位：相对于 `renderInputBox` 最外层 `div`（需加 `relative` className），`absolute bottom-full left-0 w-full z-50`
- 禁用项：显示但置灰（opacity-40），hover 时展示禁用原因 tooltip
- `/undo`、`/redo` 在 `canUndo`/`canRedo` 为 false 时置灰但仍显示

---

## 4. 架构设计

### 4.0 实现前置：API 验证清单

**在编写任何 Rust 代码前**，必须通过运行中的 opencode-cli 实例验证以下接口存在：

```bash
# 向运行中的 opencode serve 发请求，确认以下端点的响应结构
GET  /doc                                          # 获取 OpenAPI spec
GET  /session/:id/message                          # 确认每条消息有顶层 id 字段
POST /session/:id/revert    body: { messageID }    # 确认字段名为 messageID
POST /session/:id/unrevert  body: {}               # 确认端点存在
POST /session/:id/summarize body: { providerID, modelID }  # 确认字段名
```

验证通过后方可开始 Rust 层实现。如果 `GET /session/:id/message` 返回的消息对象没有顶层 `id` 字段，`/undo` 功能需调整为通过其他方式获取 messageID（或降级为禁用状态）。

### 4.1 新增文件

```
src/components/Assistant/
  SlashCommandMenu.tsx     # 下拉菜单 UI 组件
  slashCommands.ts         # 命令注册表（静态配置）
```

### 4.2 slashCommands.ts 核心类型

```typescript
export interface ChatCommandState {
  hasHistory: boolean        // chatHistory.length > 0
  isChatting: boolean        // 当前 session 正在回复
  canUndo: boolean           // lastUserMessageId !== null
  canRedo: boolean           // 执行过 undo 且未发新消息
  isCompacting: boolean      // compact 执行中
  messageCount: number       // chatHistory.length
}

export interface SlashCommand {
  name: string               // 'undo'
  label: string              // '/undo'
  description: string        // '撤销最后一轮对话'
  icon: LucideIcon
  isAvailable: (state: ChatCommandState) => boolean
  disabledReason?: (state: ChatCommandState) => string
  execute: (ctx: CommandContext) => Promise<void>  // 返回 Promise，错误可被捕获
}

export interface CommandContext {
  sessionId: string
  modelId: string | null
  providerId: string | null
  // store actions
  undoMessage: (sessionId: string) => Promise<void>
  redoMessage: (sessionId: string) => Promise<void>
  compactSession: (sessionId: string, modelId: string, providerId: string) => Promise<void>
  newSession: () => Promise<void>
  clearHistory: (sessionId: string) => Promise<void>
  showToast: (msg: string, level?: ToastLevel) => void
}
```

### 4.3 index.tsx 改动

新增两个 local state：

```typescript
const [slashQuery, setSlashQuery] = useState<string | null>(null)  // null = 菜单关闭
const [slashIndex, setSlashIndex] = useState(0)
```

**`onChange` 扩展**（在现有 `setChatInput` 后追加，不影响原有逻辑）：

```typescript
const val = e.target.value
setChatInput(val)
// 斜杠命令检测：以 / 开头且不含空格时激活
if (val.startsWith('/') && !val.includes(' ')) {
  setSlashQuery(val.slice(1))
  setSlashIndex(0)
} else {
  setSlashQuery(null)
}
```

**`handleKeyDown` 保护性修改**（必要的一行修改，非新增）：

```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  // 斜杠菜单打开时，Enter 由 SlashCommandMenu 处理，不触发 send
  if (slashQuery !== null) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSendMessage()
  }
}
```

> **注：** 这是唯一对现有函数体的修改（在函数顶部加一行 early return guard）。
> 语义：菜单打开时 Enter 键完全交由 SlashCommandMenu 处理，不触发消息发送。
> 菜单关闭后行为与现在完全一致。

**`renderInputBox` 中插入 SlashCommandMenu**（在最外层 div 加 `relative`，插入菜单组件）：

```tsx
<div className="bg-[#111922] ... relative">  {/* 加 relative，作为浮层定位父元素 */}
  {slashQuery !== null && (
    <SlashCommandMenu
      query={slashQuery}
      activeIndex={slashIndex}
      commandState={commandState}
      commandContext={commandContext}
      onClose={() => { setSlashQuery(null); setChatInput(''); }}
      onIndexChange={setSlashIndex}
    />
  )}
  {/* 现有内容不变 */}
  ...
</div>
```

### 4.4 aiStore 变更

#### SessionRuntimeState 新增字段（仅追加）

```typescript
lastUserMessageId: string | null   // OpenCode message ID，undo 用
canRedo: boolean                   // redo 可用标志
isCompacting: boolean              // compact 执行中（防重复触发）
```

`defaultRuntimeState()` 对应追加：

```typescript
lastUserMessageId: null,
canRedo: false,
isCompacting: false,
```

#### 新增 3 个 action

```typescript
undoMessage: (sessionId: string) => Promise<void>
redoMessage: (sessionId: string) => Promise<void>
compactSession: (sessionId: string, modelId: string, providerId: string) => Promise<void>
```

**undoMessage 实现：**

```
1. 读 chatStates[sessionId].lastUserMessageId，为 null 则 return
2. invoke('agent_revert_message', { sessionId, messageId })
3. 成功后：
   从 chatHistory 倒序删除：
     a. 最后一条 role==='assistant' 的消息
     b. 最后一条 role==='user' 的消息
     c. 紧接在该 user 消息之前的所有 role==='system' 消息（context pill）
4. setChatStateField({ canRedo: true, lastUserMessageId: null })
5. 同步更新 sessions 中当前 session 的 messages（与 chatHistory 一致）
```

> **system 消息处理：** `sendAgentChatStream` 通过 Rust 的 `split_user_context` 将含上下文前缀的用户消息拆为 `[system, user]` 两条，undo 需将三者一并移除。

**redoMessage 实现：**

```
1. 读 canRedo，false 则 return
2. invoke('agent_unrevert_message', { sessionId })
3. 成功后：
   invoke('agent_get_session_messages', { sessionId })
   → 用返回的消息列表更新 chatHistory 和 sessions[currentSession].messages
4. invoke('agent_get_last_user_message_id', { sessionId })
   → 更新 lastUserMessageId
5. setChatStateField({ canRedo: false })
```

> **注：** redo 后 `canRedo` 重置为 false。`agent_get_session_messages` 返回 `ParsedChatMessage[]`，与本地 `chatHistory` 类型一致。`canRedo` 在 session 切换后保持（OpenCode serve 侧的 unrevert 状态独立于其他 session，切回后仍可 redo）。

**compactSession 实现：**

```
1. isCompacting 为 true 则 return（防重复）
2. setChatStateField({ isCompacting: true })
3. invoke('agent_summarize_session', { sessionId, modelId, providerId })
4. 成功后：
   invoke('agent_get_session_messages', { sessionId })
   → 用返回的消息列表更新 chatHistory（这是 compact 后的实际内容）
5. setChatStateField({ isCompacting: false, canRedo: false, lastUserMessageId: null })
6. 失败时：setChatStateField({ isCompacting: false })，showToast 错误
```

> **注：** compactSession **不调用** `clearHistory()`。`clearHistory` 会删除并重建 session，会破坏 compact 结果。compact 后直接用 `agent_get_session_messages` 拉取最新历史，原地更新 chatHistory。

#### sendAgentChatStream Done 事件扩展（仅追加）

在现有 `commitAssistant(...)` 调用后追加：

```typescript
// 现有逻辑（不变）
await commitAssistant(finalContent, state?.streamingThinkingContent ?? '')

// 新增：后台拉取 lastUserMessageId（静默失败，不影响主流程）
invoke<string>('agent_get_last_user_message_id', { sessionId })
  .then(id => setChatStateField({ lastUserMessageId: id, canRedo: false }))
  .catch(() => {})
```

---

## 5. Rust 层变更

### 5.1 client.rs 新增函数（仅追加）

```rust
/// POST /session/:id/revert { "messageID": "..." }
pub async fn revert_message(port: u16, session_id: &str, message_id: &str) -> AppResult<()>

/// POST /session/:id/unrevert
pub async fn unrevert_message(port: u16, session_id: &str) -> AppResult<()>

/// POST /session/:id/summarize { "providerID": "...", "modelID": "..." }
pub async fn summarize_session(
    port: u16, session_id: &str,
    provider_id: &str, model_id: &str
) -> AppResult<()>
```

### 5.2 commands.rs 新增 4 个 Tauri 命令（仅追加）

```rust
/// 撤销：调用 revert，不修改 parse_opencode_messages 现有逻辑
#[tauri::command]
async fn agent_revert_message(session_id: String, message_id: String, ...) -> AppResult<()>

/// 恢复：调用 unrevert
#[tauri::command]
async fn agent_unrevert_message(session_id: String, ...) -> AppResult<()>

/// 压缩会话：调用 summarize
#[tauri::command]
async fn agent_summarize_session(
    session_id: String, model_id: String, provider_id: String, ...
) -> AppResult<()>

/// 获取最后一条 user 消息的 ID：GET /session/:id/message，
/// 从 JSON 中找最后一条 role=="user" 的 id 字段
#[tauri::command]
async fn agent_get_last_user_message_id(session_id: String, ...) -> AppResult<String>
```

> **注：** `agent_get_last_user_message_id` 直接解析原始 JSON 中的 `id` 字段，
> 不复用 `parse_opencode_messages`（后者会丢弃 id）。这是独立的新函数，不影响现有解析逻辑。

4 个命令均在 `lib.rs` 的 `generate_handler![]` 中注册。

---

## 6. 变更文件一览

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/components/Assistant/SlashCommandMenu.tsx` | 新增 | 下拉菜单组件 |
| `src/components/Assistant/slashCommands.ts` | 新增 | 命令注册表 |
| `src/components/Assistant/index.tsx` | 小改 | 2 个新 state + SlashCommandMenu 插入 + handleKeyDown 1 行 guard |
| `src/store/aiStore.ts` | 追加 | 3 action + 3 state 字段 |
| `src-tauri/src/agent/client.rs` | 追加 | 3 个 API 函数 |
| `src-tauri/src/commands.rs` | 追加 | 4 个 Tauri 命令 + 注册 |

**唯一修改现有代码处：** `handleKeyDown` 函数顶部加一行 early return guard（`if (slashQuery !== null) return`），防止菜单打开时 Enter 触发消息发送。

---

## 7. 风险与降级策略

| 风险 | 缓解措施 |
|------|----------|
| OpenCode message 对象无顶层 `id` 字段 | 实现前通过 GET /doc 验证；如不存在则 `/undo` 保持永久禁用，不影响其他命令 |
| `agent_get_last_user_message_id` 失败 | `.catch(() => {})` 静默处理，`canUndo` 保持 false |
| `revert` API 返回错误 | showToast 提示错误，chatHistory 不变 |
| `summarize` 耗时长 | `isCompacting=true` 期间禁用按钮，完成后恢复 |
| redo 后 chatHistory 与 OpenCode 不一致 | 直接用 `agent_get_session_messages` 重新拉取，以服务端为准 |
| 斜杠菜单误触发 | 含空格时立即关闭，前缀无匹配时关闭 |
