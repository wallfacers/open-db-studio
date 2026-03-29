<!-- STATUS: ✅ 已实现 -->
# ACP Elicitation 统一 UI 层设计文档

**日期：** 2026-03-17
**状态：** 已批准，待实现
**背景：** AI Agent 在多轮对话中需要用户做出选择时，当前缺乏结构化 UI 支持，用户只能手动输入，体验差且易卡住。

---

## 问题背景

两种场景下用户体验断裂：

1. **ACP `request_permission`**：opencode 执行工具前发起权限请求，当前代码自动全部 allow，用户无感知、无法拒绝。对于写操作（未来）或需用户确认的操作，这不安全。
2. **文字选项 fallback**：AI 以纯文字输出选项列表（如 `1. 创建表\n2. 查询表`），要求用户在输入框手动回复，体验割裂。

> **关于 ACP `session/elicitation`**：当前依赖的 `agent-client-protocol` 0.10.2 中不存在该方法。本设计使用 **已有的 `request_permission` 回调**作为 ACP native 路径，文字检测作为补充路径。若未来 ACP crate 升级支持原生 elicitation，可在统一 UI 层基础上扩展，无需架构重设计。

---

## 解决方案：统一 Elicitation UI 层

两种触发路径共享同一套数据结构和渲染组件：

| 路径 | 触发时机 | `isChatting` 状态 | UI 类型 |
|------|---------|-------------------|---------|
| ACP `request_permission` | Agent 执行工具前 | **true**（prompt 尚未完成） | 确认/拒绝面板 |
| 文字检测 | AI 消息流式结束后 | **false**（commitAssistant 已执行） | 选项按钮面板 |

---

## 架构总览

```
ACP request_permission 路径               文字检测路径
─────────────────────────────────────    ──────────────────────────────────────
opencode → session/request_permission    AI 消息流式结束（commitAssistant）
  │                                        │
  ▼                                        ▼
AcpClientHandler::request_permission()  前端 detectElicitation(content)
  │ 生成 permission_id                     │ 解析数字/字母选项列表
  │ 存 oneshot tx → pending_permissions    │
  │ send StreamEvent::PermissionRequest    │
  │ rx.await（LocalSet 内安全等待）          │
  │                                        │
  ▼                                        ▼
StreamEvent::PermissionRequest           ElicitationRequest { source: 'text' }
  │                                        │
  │ → chatStates[sessionId]               │ → chatStates[sessionId]
  │   .pendingPermission = req             │   .pendingElicitation = req
  │   （isChatting=true 时显示）            │   （isChatting=false 时显示）
  └─────────────────┬───────────────────── ┘
                    ▼
        UnifiedElicitationPanel 渲染
        ┌──────────────────────────────┐
        │  permission: [允许一次][拒绝] │
        │  select: 选项按钮列表         │
        └──────────────────────────────┘
                    │
            用户操作
                    │
        ┌───────────┴────────────┐
        │                        │
  source=permission          source=text
        │                        │
  invoke(acp_permission_     sendAgentChatStream
  respond)                   (selectedText)
        │
  pending_permissions[id]
  → oneshot tx.send(outcome)
  → request_permission 返回
  → agent 继续执行（或取消）
```

---

## LocalSet 内 `rx.await` 可行性说明

`AcpClientHandler` 运行在专用 `LocalSet` 单线程（见 `acp/client.rs` `spawn_local_thread()`）。`request_permission` 是 `async fn`，在其内部执行 `rx.await` 时：

1. 当前 dispatch loop task **挂起**（yield 出执行权）
2. LocalSet 线程继续轮询其他已 spawn 的 local task（`io_future`、状态更新等）
3. Tauri 命令 `acp_permission_respond` 在多线程 tokio runtime 上执行，调用 `tx.send(outcome)`
4. `tokio::sync::oneshot::Sender` 是 `Send`，可安全跨线程发送
5. `rx` 的 waker 被唤醒，LocalSet 下次轮询时恢复 `request_permission` future
6. 返回响应给 ACP dispatch loop，agent 继续

**结论**：`tokio::sync::oneshot` 的 Sender/Receiver 天然支持跨线程唤醒，在 LocalSet 内 `rx.await` 不会产生死锁，这与 `request_permission` 的语义一致（agent 在等客户端响应时不会发送新消息）。

---

## 核心数据结构

### 前端类型（`src/types/index.ts` 新增）

```typescript
// 文字检测路径使用
export interface ElicitationOption {
  value: string
  label: string
  description?: string
}

export interface ElicitationRequest {
  id: string                    // 唯一 ID（随机 UUID）
  sessionId: string
  source: 'text'                // 仅文字检测
  type: 'select'
  message: string               // 提示语（解析自 AI 消息末尾问句）
  options: ElicitationOption[]  // 解析出的选项列表
}

// ACP request_permission 路径使用
export interface PermissionRequest {
  id: string                    // permission_id（Rust 生成）
  sessionId: string
  source: 'acp'
  message: string               // 工具名称 + 参数说明
  options: Array<{
    option_id: string
    label: string               // "允许一次" | "总是允许" | "拒绝"
    kind: 'allow_once' | 'allow_always' | 'deny'
  }>
}
```

### Rust 新增 StreamEvent variant（`src-tauri/src/llm/client.rs`）

```rust
// 注意：定义位置是 client.rs，不是 mod.rs（mod.rs 仅做 pub use）
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    // ...现有 variants...
    PermissionRequest {
        permission_id: String,
        message: String,
        options: Vec<PermissionOption>,
    },
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
    pub kind: String,   // "allow_once" | "allow_always" | "deny"
}
```

### Rust `PersistentAcpSession` 扩展（`src-tauri/src/state.rs`）

```rust
pub struct PersistentAcpSession {
    pub config_id: i64,
    pub config_fingerprint: String,
    pub request_tx: UnboundedSender<AcpRequest>,
    pub abort_tx: tokio::sync::oneshot::Sender<()>,
    // 新增：待处理的权限确认，key = permission_id
    pub pending_permissions: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                String,
                tokio::sync::oneshot::Sender<PermissionReply>
            >
        >
    >,
}

/// 用户对权限请求的回复（内部类型，避免与 ACP crate 命名冲突）
pub struct PermissionReply {
    pub selected_option_id: String,  // 用户选择的 option_id
    pub cancelled: bool,             // true = 用户关闭面板（取消）
}
```

---

## ACP Native 路径：增强 `request_permission`

### `AcpClientHandler::request_permission` 新实现

```rust
async fn request_permission(
    &self,
    req: RequestPermissionRequest,
) -> agent_client_protocol::Result<RequestPermissionResponse> {
    let permission_id = uuid::Uuid::new_v4().to_string();

    // 1. 构建选项列表（从 ACP 的 options 转换）
    let options: Vec<PermissionOption> = req.options.iter().map(|o| PermissionOption {
        option_id: o.option_id.to_string(),
        label: permission_option_label(&o.kind),
        // 使用 match 显式映射，避免 Debug 格式产生错误字符串（如 "allowonce" 而非 "allow_once"）
        kind: match o.kind {
            PermissionOptionKind::AllowOnce   => "allow_once",
            PermissionOptionKind::AllowAlways => "allow_always",
            PermissionOptionKind::Deny        => "deny",
            _                                 => "deny",  // 未知变体视为拒绝
        }.to_string(),
    }).collect();

    // 2. 创建 oneshot channel，tx 存入 pending map
    let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::PermissionReply>();
    self.pending_permissions
        .lock().unwrap()
        .insert(permission_id.clone(), tx);

    // 3. 发送 PermissionRequest 事件给前端（短暂持锁，不跨 await）
    {
        let tx_opt = self.tx.lock().unwrap().clone();
        if let Some(ref event_tx) = tx_opt {
            let _ = event_tx.send(StreamEvent::PermissionRequest {
                permission_id: permission_id.clone(),
                message: format_permission_message(&req),
                options,
            });
        }
    }

    // 4. 等待用户响应（LocalSet 内安全 await，见架构说明）
    let reply = rx.await.unwrap_or(crate::state::PermissionReply {
        selected_option_id: String::new(),
        cancelled: true,
    });

    // 5. 清理 pending map（防止泄漏，rx.await 正常消费，此处兜底）
    self.pending_permissions.lock().unwrap().remove(&permission_id);

    // 6. 转换为 ACP 响应
    let outcome = if reply.cancelled {
        RequestPermissionOutcome::Cancelled
    } else {
        RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(reply.selected_option_id.clone()),
        )
    };
    Ok(RequestPermissionResponse::new(outcome))
}
```

> `AcpClientHandler` 需新增 `pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionReply>>>>` 字段，与 `PersistentAcpSession` 中的 Arc 共享同一实例。

### 新增 Tauri 命令

```rust
#[tauri::command]
pub async fn acp_permission_respond(
    session_id: String,
    permission_id: String,
    selected_option_id: String,   // 空字符串 = 取消
    cancelled: bool,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(&session_id)
        .ok_or_else(|| AppError::Other("Session not found".into()))?;

    let tx = session.pending_permissions
        .lock().unwrap()
        .remove(&permission_id)
        .ok_or_else(|| AppError::Other("Permission request not found or already responded".into()))?;

    let _ = tx.send(crate::state::PermissionReply { selected_option_id, cancelled });
    Ok(())
}
```

---

## 文字检测路径（前端）

### 检测逻辑（`src/utils/elicitationDetector.ts` 新建）

**触发条件**（两者均满足）：

| 条件类型 | 规则 |
|---------|------|
| **选项格式**（满足一种） | 数字列表 `1. xxx` 或 `1) xxx`；字母选项 `A. xxx` 或 `A) xxx`；至少 2 项 |
| **问句特征**（满足一种） | 消息末尾含 `?`/`？`；含关键词 `请选择`/`请问`/`哪个`/`哪种`/`您需要`/`你需要` |

```typescript
export function detectElicitation(
  content: string,
  sessionId: string,
): ElicitationRequest | null
```

**调用时机**：在 `commitAssistant` 内，**在同一个 `set()` 调用中**同时写入消息和 `pendingElicitation`，避免两步 set 之间的竞态：

```typescript
// commitAssistant 内部（关键：合并进同一个 set）
const detected = detectElicitation(content, sessionId);

set((s) => {
  // ...构建 updatedSessions...
  return {
    sessions: updatedSessions,
    chatStates: {
      ...s.chatStates,
      [sessionId]: {
        ...defaultRuntimeState(),                  // isChatting=false
        pendingElicitation: detected ?? null,      // 同步写入，无竞态
      },
    },
    ...(isCurrentSession ? { chatHistory: updatedMessages } : {}),
  };
});
// 注意：不再单独 set pendingElicitation，全部在此合并
```

---

## 前端状态管理

### `SessionRuntimeState` 扩展（`src/store/aiStore.ts`）

```typescript
interface SessionRuntimeState {
  isChatting: boolean
  streamingContent: string
  streamingThinkingContent: string
  activeToolName: string | null
  sessionStatus: string | null
  pendingElicitation: ElicitationRequest | null   // 新增（文字检测，isChatting=false 时显示）
  pendingPermission: PermissionRequest | null     // 新增（ACP permission，isChatting=true 时显示）
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  isChatting: false,
  streamingContent: '',
  streamingThinkingContent: '',
  activeToolName: null,
  sessionStatus: null,
  pendingElicitation: null,
  pendingPermission: null,
})
```

### `channel.onmessage` 新增 PermissionRequest 处理

```typescript
} else if (event.type === 'PermissionRequest') {
  // PermissionRequest 在 isChatting=true 时到达（agent 暂停中）
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: {
        ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
        pendingPermission: {
          id: event.data.permission_id,
          sessionId,
          source: 'acp' as const,
          message: event.data.message,
          options: event.data.options,
        },
      },
    },
  }));
}
```

### 新增 Store Actions

```typescript
// 响应 ACP permission 请求
respondPermission: async (
  sessionId: string,
  permissionId: string,
  selectedOptionId: string,
  cancelled: boolean,
) => Promise<void>

// 响应文字检测 elicitation（用户选了某项）
respondElicitation: async (
  sessionId: string,
  selectedText: string,
) => Promise<void>
```

**`respondPermission` 实现要点：**

```typescript
respondPermission: async (sessionId, permissionId, selectedOptionId, cancelled) => {
  // 立即清空 pendingPermission（UI 响应优先）
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: { ...s.chatStates[sessionId], pendingPermission: null },
    },
  }));
  await invoke('acp_permission_respond', {
    sessionId, permissionId, selectedOptionId, cancelled,
  });
},

respondElicitation: async (sessionId, selectedText) => {
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
    },
  }));
  // activeConnectionId 在 connectionStore 中，不在 aiStore
  const { useConnectionStore } = await import('./connectionStore');
  const connectionId = useConnectionStore.getState().activeConnectionId;
  // sendAgentChatStream 内部捕获 get().currentSessionId，
  // ElicitationPanel 仅在对应 session 显示，用户无法跨 session 触发，
  // 因此此处 sessionId 与 currentSessionId 一致，无需额外传递
  await get().sendAgentChatStream(selectedText, connectionId);
},
```

---

## UI 组件：UnifiedElicitationPanel

**文件：** `src/components/Assistant/ElicitationPanel.tsx`

**挂载位置**：在 `Assistant/index.tsx` 中，紧接 `StreamingMessage` 或最后一条消息之后、输入框之前。具体 DOM 顺序：

```tsx
{/* 消息列表 */}
{chatHistory.map(...)}

{/* 流式消息（isChatting=true 时） */}
{isChatting && <StreamingMessage sessionId={currentSessionId} />}

{/* 权限确认面板（isChatting=true 时，ACP 路径） */}
{pendingPermission && (
  <ElicitationPanel
    type="permission"
    request={pendingPermission}
    onRespond={(optionId, cancelled) =>
      respondPermission(sessionId, pendingPermission.id, optionId, cancelled)
    }
  />
)}

{/* 选项选择面板（isChatting=false 时，文字检测路径） */}
{!isChatting && pendingElicitation && (
  <ElicitationPanel
    type="elicitation"
    request={pendingElicitation}
    onSelect={(text) => respondElicitation(sessionId, text)}
    onCancel={() => clearElicitation(sessionId)}
  />
)}

{/* 滚动锚点 */}
<div ref={chatEndRef} />

{/* 输入框 */}
```

**两种渲染模式：**

```
Permission 模式（isChatting=true）：
┌──────────────────────────────────────────────────┐
│ 🔐 工具执行确认                                    │
│ execute_sql: SELECT * FROM users LIMIT 10         │
│                                                  │
│  [允许一次]  [总是允许]  [拒绝]                    │
└──────────────────────────────────────────────────┘

Elicitation 模式（isChatting=false）：
┌──────────────────────────────────────────────────┐
│ 📋 请选择操作                                     │
│                                                  │
│  ┌────────────────────────┐                      │
│  │  1. 创建新表            │  ← 点击即提交         │
│  └────────────────────────┘                      │
│  ┌────────────────────────┐                      │
│  │  2. 修改现有表结构      │                      │
│  └────────────────────────┘                      │
│                          [取消]                   │
└──────────────────────────────────────────────────┘
```

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/types/index.ts` | 修改 | 新增 `ElicitationOption`、`ElicitationRequest`、`PermissionRequest` 类型 |
| `src-tauri/src/llm/client.rs` | 修改 | `StreamEvent` 新增 `PermissionRequest` variant；新增 `PermissionOption` 结构体 |
| `src-tauri/src/state.rs` | 修改 | `PersistentAcpSession` 新增 `pending_permissions`；新增 `PermissionReply` 类型 |
| `src-tauri/src/acp/client.rs` | 修改 | `AcpClientHandler` 新增 `pending_permissions` 字段；实现 `request_permission` UI 路径 |
| `src-tauri/src/acp/session.rs` | 修改 | `spawn_acp_session_thread` 创建 `pending_permissions` Arc，传给 handler 和 session |
| `src-tauri/src/commands.rs` | 修改 | 新增 `acp_permission_respond` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册 `acp_permission_respond` 到 `generate_handler!` |
| `src/utils/elicitationDetector.ts` | 新建 | 文字选项检测逻辑 |
| `src/store/aiStore.ts` | 修改 | `SessionRuntimeState` 扩展；新增 `respondPermission`、`respondElicitation`、`clearElicitation` |
| `src/components/Assistant/ElicitationPanel.tsx` | 新建 | 统一 Elicitation/Permission UI 组件 |
| `src/components/Assistant/index.tsx` | 修改 | 引入并按条件渲染 `ElicitationPanel`（两个挂载点） |

---

## 数据流（完整时序）

### ACP `request_permission` 场景

```
用户发消息 → agent 推理 → 调用 execute_sql 前
  → request_permission() 回调被触发（agent 暂停）
    → isChatting=true（invoke 尚未 resolve）
    → StreamEvent::PermissionRequest → channel → 前端
      → chatStates[sessionId].pendingPermission = req
      → ElicitationPanel（permission 模式）渲染
      → 用户点击"允许一次"
      → respondPermission(sessionId, id, optionId, false)
        → 清空 pendingPermission（UI 立即消失）
        → invoke('acp_permission_respond', ...)
          → pending_permissions[id] → tx.send(PermissionReply)
            → rx.await 解除阻塞 → 返回 AllowOnce 给 ACP
              → agent 执行工具 → 继续推理 → 输出结果
```

### 文字检测场景

```
AI 输出 "1. 创建表\n2. 查询表\n您需要哪个？" → 流式结束
  → commitAssistant(content, thinking)
    → detectElicitation(content) → 命中
    → 在同一 set() 中：
      isChatting=false + pendingElicitation=req
    → ElicitationPanel（elicitation 模式）渲染按钮
    → 用户点击"1. 创建表"
    → respondElicitation(sessionId, "1. 创建表")
      → 清空 pendingElicitation → sendAgentChatStream("1. 创建表", connectionId)
        → 发起新一轮 ACP prompt → agent 继续
```

---

## Abort 路径说明

当 session 被 abort（用户取消生成或切换配置）时，`request_permission` 的 `rx.await` 未完成，`pending_permissions` 中的 oneshot sender 随 session Arc drop 而释放，无持久泄漏。

但前端 `pendingPermission` 状态仍存在，需要在 `Done` 或 `Error` 事件到达时清除：

```typescript
// channel.onmessage 中 Done/Error 分支新增：
} else if (event.type === 'Done' || event.type === 'Error') {
  // ...现有逻辑...
  // 同时清空任何未完成的 pendingPermission（abort 场景兜底）
  setChatStateField({ pendingPermission: null });
}
```

---

## 不在本次范围内

- ACP 原生 `session/elicitation`（等待 ACP crate 版本升级后扩展）
- URL mode elicitation（OAuth 等浏览器外跳场景）
- 复杂 JSON Schema 渲染（嵌套对象、数组字段）
- 多个并发 permission 请求排队（当前按序处理，单 session 单线程）
- Elicitation 历史记录持久化

---

## 成功验收标准

1. **ACP permission**：opencode 执行工具前弹出权限面板（isChatting=true），用户点"允许一次"后 agent 继续，点"拒绝"后 agent 收到 Cancelled 响应
2. **文字检测**：AI 输出 `1. xxx\n2. yyy` + 问句 → 流式结束后自动渲染按钮，点击后发起新一轮对话
3. **状态隔离**：Session A 显示权限面板时，切换到 Session B 不受影响；切回 Session A 仍显示面板
4. **取消行为**：关闭权限面板 → agent 收到 Cancelled → 当前 prompt 以 cancelled 结束；关闭选项面板 → 直接消失，不发消息
5. **竞态安全**：commitAssistant 写入 `pendingElicitation` 和 `isChatting=false` 在同一 set() 调用中完成，无中间状态
6. **重启恢复**：应用重启后 `pendingPermission`/`pendingElicitation` 均为 null（runtime state，不持久化），符合预期
