<!-- STATUS: ✅ 已实现 -->
# ACP Elicitation 统一 UI 层实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 助手多轮对话中的人机交互场景提供结构化 UI——ACP `request_permission` 触发确认面板，文字选项列表自动渲染为可点击按钮。

**Architecture:** 两条路径共享统一数据结构和 `ElicitationPanel` 组件。ACP native 路径通过增强 `request_permission` 回调（oneshot channel 暂停 agent、Tauri 命令回传）实现；文字检测路径在 `commitAssistant` 的同一 `set()` 调用中写入 `pendingElicitation`，避免竞态。两种状态字段（`pendingPermission`/`pendingElicitation`）分别对应 `isChatting=true/false` 时显示。

**Tech Stack:** Rust / Tauri 2.x, agent-client-protocol 0.10.2, React 18 / TypeScript, Zustand, tokio::sync::oneshot

**Spec:** `docs/superpowers/specs/2026-03-17-acp-elicitation-design.md`

---

## Chunk 1: Rust 后端

### Task 1: 扩展 StreamEvent 和 state 类型

**Files:**
- Modify: `src-tauri/src/llm/client.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 在 `src-tauri/src/llm/client.rs` 的 `StreamEvent` 枚举中新增 `PermissionRequest` variant**

找到第 9 行的 `pub enum StreamEvent {`，在 `Error { message: String },` 之后新增：

```rust
    PermissionRequest {
        permission_id: String,
        message: String,
        options: Vec<PermissionOption>,
    },
```

同时在枚举定义之后（`ToolDefinition` 结构体之前）新增 `PermissionOption` 结构体：

```rust
/// ACP request_permission 的选项，序列化后发往前端
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
    pub kind: String, // "allow_once" | "allow_always" | "deny"
}
```

- [ ] **Step 2: 在 `src-tauri/src/state.rs` 中扩展 `PersistentAcpSession` 并添加 `PermissionReply`**

在文件末尾（`AppState` 定义之后）新增：

```rust
/// 用户对权限请求的回复（内部类型，避免与 ACP crate 命名冲突）
pub struct PermissionReply {
    pub selected_option_id: String, // 用户选择的 option_id；取消时为空字符串
    pub cancelled: bool,            // true = 用户关闭面板（取消）
}
```

然后在 `PersistentAcpSession` 结构体末尾新增字段：

```rust
    /// 待处理的权限确认请求，key = permission_id（UUID）
    /// Arc 与 AcpClientHandler 中的字段共享同一实例
    pub pending_permissions: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                String,
                tokio::sync::oneshot::Sender<PermissionReply>,
            >,
        >,
    >,
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：无 error（`session.rs`、`acp/client.rs` 的引用错误会在后续步骤修复，此时 `state.rs` 和 `llm/client.rs` 本身应无 error）

---

### Task 2: 增强 `AcpClientHandler::request_permission`

**Files:**
- Modify: `src-tauri/src/acp/client.rs`

- [ ] **Step 1: 在 `AcpClientHandler` 结构体中新增 `pending_permissions` 字段**

找到第 23 行的 `pub struct AcpClientHandler {`，在 `pub(crate) tx: ...` 字段后新增：

```rust
    pub(crate) pending_permissions: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                String,
                tokio::sync::oneshot::Sender<crate::state::PermissionReply>,
            >,
        >,
    >,
```

- [ ] **Step 2: 在 import 列表中补充缺失的 ACP 类型**

找到文件顶部的 `use agent_client_protocol::{...};`，确认包含以下类型（如缺少则补充）：

```rust
use agent_client_protocol::{
    Agent, Client, ClientSideConnection, InitializeRequest, InitializeResponse,
    NewSessionRequest, NewSessionResponse, ProtocolVersion,
    RequestPermissionRequest, RequestPermissionResponse, RequestPermissionOutcome,
    SelectedPermissionOutcome, PermissionOptionKind,   // 新增这两项
    SessionNotification, SessionUpdate, ContentBlock,
    McpServer, McpServerHttp,
};
```

**注意：** 此步骤是替换整个 `use agent_client_protocol` 语句块，确保 `SelectedPermissionOutcome` 和 `PermissionOptionKind` 都包含在内。现有代码中 `SelectedPermissionOutcome` 已在 `request_permission` 方法体内通过局部 `use` 引入，替换后改为顶层导入。

- [ ] **Step 3: 用新实现替换 `request_permission` 方法**

找到现有的 `async fn request_permission` 实现（第 76–96 行），整体替换为：

```rust
    async fn request_permission(
        &self,
        req: RequestPermissionRequest,
    ) -> agent_client_protocol::Result<RequestPermissionResponse> {
        let permission_id = uuid::Uuid::new_v4().to_string();

        // 1. 构建选项列表（单次 match 同时解构 label/kind，避免对非 Copy 枚举二次移动）
        let options: Vec<crate::llm::PermissionOption> = req.options.iter().map(|o| {
            // ⚠️ 实现注意：若 PermissionOptionKind 是穷举枚举（无 #[non_exhaustive]），
            // `_` 分支会触发 "unreachable pattern" 警告（-D warnings 配置下变为 error）。
            // 实现时先运行 cargo check，若出现此警告则删除 `_` 分支改为三分支穷举。
            let (label, kind) = match o.kind {
                PermissionOptionKind::AllowOnce   => ("允许一次", "allow_once"),
                PermissionOptionKind::AllowAlways => ("总是允许", "allow_always"),
                PermissionOptionKind::Deny        => ("拒绝",     "deny"),
                _                                 => ("拒绝",     "deny"),
            };
            crate::llm::PermissionOption {
                option_id: o.option_id.to_string(),
                label: label.to_string(),
                kind: kind.to_string(),
            }
        }).collect();

        // 2. 创建 oneshot channel，tx 存入 pending map（短暂持锁，不跨 await）
        let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::PermissionReply>();
        {
            self.pending_permissions
                .lock().unwrap()
                .insert(permission_id.clone(), tx);
        }

        // 3. 构建工具描述信息（从 req 的 title/description 中获取）
        let message = req.description
            .as_deref()
            .unwrap_or(req.title.as_deref().unwrap_or("工具执行"))
            .to_string();

        // 4. 发送 PermissionRequest 事件给前端（短暂持锁，不跨 await）
        {
            let tx_opt = self.tx.lock().unwrap().clone();
            if let Some(ref event_tx) = tx_opt {
                let _ = event_tx.send(crate::llm::StreamEvent::PermissionRequest {
                    permission_id: permission_id.clone(),
                    message,
                    options,
                });
            }
        }

        // 5. 等待用户响应
        // LocalSet 内 rx.await 的安全性：
        // - rx.await 挂起当前 task，LocalSet 继续轮询 io_future 等其他 task
        // - Tauri 命令（多线程 runtime）调用 tx.send()，oneshot::Sender 是 Send 可跨线程
        // - tx.send() 触发 waker，LocalSet 下次轮询时恢复此 future
        let reply = rx.await.unwrap_or(crate::state::PermissionReply {
            selected_option_id: String::new(),
            cancelled: true,
        });

        // 6. 兜底清理（正常情况 rx.await 已消费，此处防止异常泄漏）
        self.pending_permissions.lock().unwrap().remove(&permission_id);

        // 7. 转换为 ACP 响应
        let outcome = if reply.cancelled {
            RequestPermissionOutcome::Cancelled
        } else {
            RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(reply.selected_option_id),
            )
        };
        Ok(RequestPermissionResponse::new(outcome))
    }
```

- [ ] **Step 4: 在 `start_acp_session` 函数中更新 handler 创建**

找到 `let handler = AcpClientHandler { tx: shared_event_tx };`，替换为：

```rust
    let handler = AcpClientHandler {
        tx: shared_event_tx,
        pending_permissions: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };
```

同时修改函数返回值，将 `pending_permissions` Arc 一起返回（返回类型从三元组改为含 Arc 的结构）。实际上更简洁的做法是：在返回的三元组之外，将 `pending_permissions` 的 Arc 作为第四个返回值传出，供 `session.rs` 使用。

修改 `start_acp_session` 返回类型：

```rust
pub async fn start_acp_session(
    mcp_url: &str,
    cwd: &std::path::Path,
    shared_event_tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>>>,
    status_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamEvent>>,
) -> crate::AppResult<(
    Arc<tokio::sync::Mutex<ClientSideConnection>>,
    String,
    tokio::process::Child,
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<crate::state::PermissionReply>>>>,
)>
```

在函数末尾将 `Ok((connection, session_id, child))` 改为：

```rust
    Ok((connection, session_id, child, handler_pending_permissions))
```

注意需要在创建 handler 时先把 Arc clone 出来：

```rust
    let pending_permissions_arc = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let handler = AcpClientHandler {
        tx: shared_event_tx,
        pending_permissions: Arc::clone(&pending_permissions_arc),
    };
    // ...（原有 connection 创建逻辑不变）...
    Ok((connection, session_id, child, pending_permissions_arc))
```

- [ ] **Step 5: 在 `src-tauri/src/acp/mod.rs` 确认 `use std::sync::Arc;` 已导入**

打开 `src-tauri/src/acp/client.rs` 第 1 行，确认有：

```rust
use std::sync::Arc;
```

若无则添加。同时在 Cargo.toml 中确认 uuid crate 存在（用于生成 permission_id）：

```bash
grep -n "uuid" src-tauri/Cargo.toml
```

若不存在，在 `[dependencies]` 中添加：

```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 6: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：只有 `session.rs` 中关于 `start_acp_session` 返回类型变化的 error，其余无错。

---

### Task 3: 更新 `session.rs` 传递 `pending_permissions`

**Files:**
- Modify: `src-tauri/src/acp/session.rs`

- [ ] **Step 1: 更新 `session_loop` 函数，处理四元组返回值**

找到 `session.rs` 中调用 `start_acp_session` 的部分（约第 96–110 行）：

```rust
    let (connection, session_id, mut child) =
        match crate::acp::client::start_acp_session(...)
```

替换为：

```rust
    let (connection, session_id, mut child, pending_permissions_arc) =
        match crate::acp::client::start_acp_session(
            &mcp_url,
            &cwd,
            Arc::clone(&shared_event_tx),
            status_tx.as_ref(),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let _ = setup_tx.send(Err(e));
                return;
            }
        };
```

- [ ] **Step 2: 将 `pending_permissions_arc` 通过 setup channel 传给调用方**

将 `setup_tx`/`setup_rx` 的类型从 `AppResult<()>` 改为传出 Arc。

**关键：** `PendingMap` 类型别名必须定义在**模块顶层**（文件顶部），而非函数内部，否则 `session_loop` 的参数签名无法引用它。

在 `session.rs` 文件顶部（`use` 语句之后、函数定义之前）新增类型别名：

```rust
/// pending_permissions 的共享类型，用于在 spawn_acp_session_thread 和 session_loop 间传递
type PendingPermissionsMap = std::sync::Arc<
    std::sync::Mutex<
        std::collections::HashMap<
            String,
            tokio::sync::oneshot::Sender<crate::state::PermissionReply>,
        >,
    >,
>;
```

然后修改 `spawn_acp_session_thread` 中的 setup channel：

```rust
// 将原来的 oneshot channel 类型由 AppResult<()> 改为 AppResult<PendingPermissionsMap>
let (setup_tx, setup_rx) = tokio::sync::oneshot::channel::<crate::error::AppResult<PendingPermissionsMap>>();
```

同时修改 `session_loop` 的函数签名，将 `setup_tx` 参数类型由 `Sender<AppResult<()>>` 改为：

```rust
async fn session_loop(
    mcp_url: String,
    cwd: PathBuf,
    mut request_rx: tokio::sync::mpsc::UnboundedReceiver<AcpRequest>,
    abort_rx: tokio::sync::oneshot::Receiver<()>,
    setup_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<PendingPermissionsMap>>,  // 类型变更
    status_tx: Option<UnboundedSender<StreamEvent>>,
) {
```

在 `session_loop` 内，握手成功时替换原来的 `let _ = setup_tx.send(Ok(()));`：

```rust
    let _ = setup_tx.send(Ok(pending_permissions_arc));
```

在 `spawn_acp_session_thread` 中，将接收逻辑由 `??` 展开为：

```rust
    let pending_permissions = setup_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread died before setup completed".into()))??;

    Ok(PersistentAcpSession {
        config_id,
        config_fingerprint: String::new(),
        request_tx,
        abort_tx,
        pending_permissions,
    })
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：`session.rs` 和 `state.rs` 相关 error 消失，零 error。

---

### Task 4: 新增 `acp_permission_respond` Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `commands.rs` 末尾新增命令**

在文件末尾添加：

```rust
/// 前端回传用户对 ACP permission 请求的响应
///
/// `selected_option_id` 为用户选择的 option_id；`cancelled=true` 时此值被忽略。
#[tauri::command]
pub async fn acp_permission_respond(
    session_id: String,
    permission_id: String,
    selected_option_id: String,
    cancelled: bool,
    state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    use crate::AppError;
    let sessions = state.acp_sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::Other(format!("ACP session '{}' not found", session_id)))?;

    let tx = session
        .pending_permissions
        .lock()
        .unwrap()
        .remove(&permission_id)
        .ok_or_else(|| {
            AppError::Other(format!(
                "Permission request '{}' not found or already responded",
                permission_id
            ))
        })?;

    let _ = tx.send(crate::state::PermissionReply {
        selected_option_id,
        cancelled,
    });
    Ok(())
}
```

- [ ] **Step 2: 在 `lib.rs` 的 `generate_handler![]` 中注册新命令**

找到 `generate_handler![` 列表，新增 `acp_permission_respond`：

```rust
commands::acp_permission_respond,
```

- [ ] **Step 3: 完整编译验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：`Finished dev profile`，零 error。若有 warnings 可忽略。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llm/client.rs src-tauri/src/state.rs src-tauri/src/acp/client.rs src-tauri/src/acp/session.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add ACP permission UI channel - PermissionRequest event, oneshot wait, respond command"
```

---

## Chunk 2: 前端工具函数与 Store

### Task 5: 扩展 TypeScript 类型定义

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 在 `src/types/index.ts` 末尾新增类型**

在文件末尾添加：

```typescript
// ── ACP Elicitation / Permission 类型 ─────────────────────────────────────

/** 文字检测路径的单个选项 */
export interface ElicitationOption {
  value: string
  label: string
  description?: string
}

/** 文字检测路径的 elicitation 请求（AI 消息结束后由前端构造） */
export interface ElicitationRequest {
  id: string              // 随机 UUID，仅用于 React key
  sessionId: string
  source: 'text'
  type: 'select'
  message: string         // 提示语（解析自消息末尾问句）
  options: ElicitationOption[]
}

/** ACP request_permission 路径的权限确认请求（来自 Rust StreamEvent） */
export interface PermissionRequest {
  id: string              // permission_id（Rust 生成的 UUID）
  sessionId: string
  source: 'acp'
  message: string         // 工具名称 + 操作描述
  options: Array<{
    option_id: string
    label: string         // "允许一次" | "总是允许" | "拒绝"
    kind: 'allow_once' | 'allow_always' | 'deny'
  }>
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error（新类型不会引入 error，只有其他文件引用时才可能报）

---

### Task 6: 新建文字选项检测器

**Files:**
- Create: `src/utils/elicitationDetector.ts`

- [ ] **Step 1: 创建检测器文件**

```typescript
import type { ElicitationRequest, ElicitationOption } from '../types'

/**
 * 检测 AI 消息内容中是否包含结构化的选项列表，若包含则返回 ElicitationRequest。
 *
 * 触发条件（两者均须满足）：
 * 1. 选项格式：数字列表（`1. xxx` 或 `1) xxx`）或字母选项（`A. xxx` 或 `A) xxx`），至少 2 项
 * 2. 问句特征：消息末尾含 `?`/`？`，或含关键词 请选择/请问/哪个/哪种/您需要/你需要
 */
export function detectElicitation(
  content: string,
  sessionId: string,
): ElicitationRequest | null {
  // ── 1. 尝试解析选项 ──────────────────────────────────────────────────────
  const options = parseOptions(content)
  if (options.length < 2) return null

  // ── 2. 问句特征检测 ───────────────────────────────────────────────────────
  const trimmed = content.trim()
  const hasQuestionMark = /[?？]/.test(trimmed.slice(-50))
  const hasKeyword = /请选择|请问|哪个|哪种|您需要|你需要/.test(content)
  if (!hasQuestionMark && !hasKeyword) return null

  // ── 3. 提取提示语（取选项列表之前的最后一段非空文本） ───────────────────
  const message = extractMessage(content) || '请选择以下选项之一：'

  return {
    id: crypto.randomUUID(),
    sessionId,
    source: 'text',
    type: 'select',
    message,
    options,
  }
}

// ── 内部工具函数 ─────────────────────────────────────────────────────────────

/** 从内容中解析选项列表 */
function parseOptions(content: string): ElicitationOption[] {
  const lines = content.split('\n')

  // 数字列表：`1. xxx` 或 `1) xxx`
  const numDotPattern = /^\s*(\d+)[.)]\s+(.+)$/
  const numMatches = lines
    .map((l) => numDotPattern.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)

  if (numMatches.length >= 2) {
    return numMatches.map((m) => ({
      value: m[0].trim(),   // 完整行文本作为发送内容（保留序号）
      label: m[2].trim(),   // 选项文本（不含序号）
    }))
  }

  // 字母选项：`A. xxx` 或 `A) xxx`（仅大写字母，防止误匹配正文句子）
  const alphaPattern = /^\s*([A-Z])[.)]\s+(.+)$/
  const alphaMatches = lines
    .map((l) => alphaPattern.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)

  if (alphaMatches.length >= 2) {
    return alphaMatches.map((m) => ({
      value: m[0].trim(),
      label: m[2].trim(),
    }))
  }

  return []
}

/** 提取选项列表之前的最后一段非空文本作为提示语 */
function extractMessage(content: string): string {
  const lines = content.split('\n')
  // 找到第一个选项行的位置
  const optionLineIndex = lines.findIndex((l) =>
    /^\s*[\dA-Z][.)]\s+/.test(l)
  )
  if (optionLineIndex <= 0) return ''

  // 取选项行之前的文本，逆序找最后一段非空行
  const beforeOptions = lines.slice(0, optionLineIndex)
  for (let i = beforeOptions.length - 1; i >= 0; i--) {
    const line = beforeOptions[i].trim()
    if (line) return line
  }
  return ''
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：零 error

---

### Task 7: 扩展 aiStore 状态和 actions

**Files:**
- Modify: `src/store/aiStore.ts`

- [ ] **Step 1: 在文件顶部的 import 中新增类型导入**

找到第 4 行的 import：

```typescript
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage, ChatSession } from '../types';
```

替换为：

```typescript
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage, ChatSession, ElicitationRequest, PermissionRequest } from '../types';
```

- [ ] **Step 2: 扩展 `SessionRuntimeState` 接口（第 46–52 行）**

找到 `interface SessionRuntimeState {`，在 `sessionStatus: string | null;` 后新增：

```typescript
  pendingElicitation: ElicitationRequest | null;  // 文字检测路径（isChatting=false 时显示）
  pendingPermission: PermissionRequest | null;     // ACP permission 路径（isChatting=true 时显示）
```

- [ ] **Step 3: 扩展 `defaultRuntimeState()`（第 54–60 行）**

在 `sessionStatus: null,` 后新增：

```typescript
  pendingElicitation: null,
  pendingPermission: null,
```

- [ ] **Step 4: 扩展 `AiState` 接口**

在 `cancelChat: (sessionId: string) => Promise<void>;` 后新增：

```typescript
  respondPermission: (sessionId: string, permissionId: string, selectedOptionId: string, cancelled: boolean) => Promise<void>;
  respondElicitation: (sessionId: string, selectedText: string) => Promise<void>;
  clearElicitation: (sessionId: string) => void;
```

- [ ] **Step 5: 扩展 `channel.onmessage` 类型声明**

找到第 450–453 行的 Channel 类型声明：

```typescript
          const channel = new Channel<{
            type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
            data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
          }>();
```

替换为：

```typescript
          const channel = new Channel<{
            type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error' | 'PermissionRequest';
            data?: {
              delta?: string;
              message?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              // PermissionRequest 字段
              permission_id?: string;
              options?: Array<{ option_id: string; label: string; kind: string }>;
            };
          }>();
```

- [ ] **Step 6: 在 `channel.onmessage` 中新增 `PermissionRequest` 处理**

找到第 518 行的 `} else if (event.type === 'Done') {`，在其**之前**插入：

```typescript
            } else if (event.type === 'PermissionRequest' && event.data?.permission_id) {
              // PermissionRequest 在 isChatting=true 时到达（agent 暂停等待响应）
              setChatStateField({
                pendingPermission: {
                  id: event.data.permission_id,
                  sessionId,
                  source: 'acp' as const,
                  message: event.data.message ?? '工具执行确认',
                  options: (event.data.options ?? []).map((o) => ({
                    option_id: o.option_id,
                    label: o.label,
                    kind: o.kind as 'allow_once' | 'allow_always' | 'deny',
                  })),
                },
              });
```

- [ ] **Step 7: 在 Done/Error 分支新增 `pendingPermission` 清理**

找到 `} else if (event.type === 'Done') {` 分支内的 `commitAssistant(...)` 调用前，新增：

```typescript
              // 清空任何未完成的 pendingPermission（abort 场景兜底）
              setChatStateField({ pendingPermission: null });
```

对 `} else if (event.type === 'Error') {` 分支同样操作。

- [ ] **Step 8: 修改 `commitAssistant` 中的 `set()` 调用，同时写入 `pendingElicitation`**

找到 `commitAssistant` 内部的 `set()` 调用（第 410–441 行），在 `set((s) => {` 函数体最顶部（`const existing = ...` 之前）新增 elicitation 检测调用：

在 `commitAssistant` 函数体开头（`const newMsg = ...` 之前）新增：

```typescript
          // 检测是否含文字选项（需在 set() 之前计算，以便合并进同一次 set）
          const { detectElicitation } = await import('../utils/elicitationDetector');
          const detected = detectElicitation(content, sessionId);
```

然后修改 `set()` 内的 `chatStates` 部分：

```typescript
              chatStates: {
                ...s.chatStates,
                [sessionId]: {
                  ...defaultRuntimeState(),
                  pendingElicitation: detected ?? null,  // 与 isChatting=false 同步写入，无竞态
                },
              },
```

**注意：** `commitAssistant` 目前是同步函数，新增 `await import(...)` 后需改为 `async`。将函数声明从：

```typescript
          const commitAssistant = (content: string, thinking: string) => {
```

改为：

```typescript
          const commitAssistant = async (content: string, thinking: string) => {
```

并更新所有调用处（两处 `commitAssistant(...)` 调用前加 `await`）：

```typescript
              await commitAssistant(state?.streamingContent ?? '', state?.streamingThinkingContent ?? '');
              // 和
              await commitAssistant(`Error: ${event.data?.message ?? 'Unknown error'}`, '');
              // 和
              await commitAssistant(`Error: ${String(e)}`, '');
```

**同时，必须将 `channel.onmessage` 的回调声明为 `async`：**

找到 `channel.onmessage = (event) => {`，改为：

```typescript
          channel.onmessage = async (event) => {
```

**说明：** `commitAssistant` 变为 `async` 后，**必须**将 `channel.onmessage` 声明为 `async`，否则 `await commitAssistant(...)` 会产生 TypeScript 编译错误（"'await' expressions are only allowed within async functions"）。`async (event) => { ... }` 赋值给 `onmessage: (event: T) => void` 在 TypeScript 类型层面兼容，不产生类型错误，运行时 Promise 会正常等待。

**已知边界情况：** `async` 回调意味着 MessageChannel 消息处理变为非阻塞。若 ACP 同时发出多条流消息，第 N 条消息的 `commitAssistant` 可能在第 N+1 条消息的 `isChatting` 更新完成前尚未完成。该场景在当前实现中概率极低（ACP 仅在 `Done`/`Error` 时调用 `commitAssistant`，非多并发），可接受。

- [ ] **Step 9: 在 store 实现中新增三个 action**

在 `cancelChat:` action 之后新增：

```typescript
      respondPermission: async (sessionId, permissionId, selectedOptionId, cancelled) => {
        // 立即清空（UI 响应优先，不等待 Rust 确认）
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingPermission: null },
          },
        }));
        try {
          await invoke('acp_permission_respond', {
            sessionId,
            permissionId,
            selectedOptionId,
            cancelled,
          });
        } catch (e) {
          log.error('[elicitation] acp_permission_respond failed:', e);
        }
      },

      respondElicitation: async (sessionId, selectedText) => {
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
          },
        }));
        // activeConnectionId 在 connectionStore，不在 aiStore
        const { useConnectionStore } = await import('./connectionStore');
        const connectionId = useConnectionStore.getState().activeConnectionId;
        // ElicitationPanel 仅在当前 session 显示，用户无法跨 session 触发，
        // 故 sessionId 与 get().currentSessionId 一致，无需额外传递。
        //
        // ⚠️ 已知边界情况（I4）：sendAgentChatStream 内部读取 get().currentSessionId，
        // 如果用户在点击选项按钮后、此 await 执行前迅速切换了 session，
        // sendAgentChatStream 会把消息发送到新的当前 session 而非 sessionId 对应的 session。
        // 该场景概率极低（UI 按钮点击到 await 执行间隔 < 1ms），且文字选项面板切换 session 后
        // 会立即隐藏（chatStates 按 session 隔离），故此处不做额外保护。
        await get().sendAgentChatStream(selectedText, connectionId);
      },

      clearElicitation: (sessionId) => {
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
          },
        }));
      },
```

- [ ] **Step 10: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

预期：零 error（若 `Assistant/index.tsx` 有引用旧字段的 error，属正常，下一 Task 修复）

- [ ] **Step 11: Commit**

```bash
git add src/types/index.ts src/utils/elicitationDetector.ts src/store/aiStore.ts
git commit -m "feat(frontend): add elicitation detector, extend aiStore with pendingElicitation/Permission state"
```

---

## Chunk 3: UI 组件

### Task 8: 新建 ElicitationPanel 组件

**Files:**
- Create: `src/components/Assistant/ElicitationPanel.tsx`

- [ ] **Step 1: 创建组件文件**

```tsx
import React from 'react'
import type { ElicitationRequest, PermissionRequest } from '../../types'

// ── Props ─────────────────────────────────────────────────────────────────────

interface PermissionPanelProps {
  type: 'permission'
  request: PermissionRequest
  onRespond: (optionId: string, cancelled: boolean) => void
}

interface ElicitationPanelProps {
  type: 'elicitation'
  request: ElicitationRequest
  onSelect: (text: string) => void
  onCancel: () => void
}

type Props = PermissionPanelProps | ElicitationPanelProps

// ── Component ─────────────────────────────────────────────────────────────────

const ElicitationPanel: React.FC<Props> = (props) => {
  if (props.type === 'permission') {
    return <PermissionPanel {...props} />
  }
  return <ElicitationSelectPanel {...props} />
}

export default ElicitationPanel

// ── Permission Panel（ACP request_permission 路径） ───────────────────────────

const PermissionPanel: React.FC<PermissionPanelProps> = ({ request, onRespond }) => {
  const kindOrder = ['allow_once', 'allow_always', 'deny'] as const
  const sorted = [...request.options].sort(
    (a, b) => kindOrder.indexOf(a.kind as typeof kindOrder[number]) - kindOrder.indexOf(b.kind as typeof kindOrder[number])
  )

  return (
    <div className="mx-3 mb-3 rounded-lg border border-[#1e3a5f] bg-[#0d2137] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">🔐</span>
        <span className="text-[12px] font-semibold text-[#8ab0cc]">工具执行确认</span>
      </div>
      <p className="mb-3 text-[12px] text-[#c8daea] leading-relaxed">{request.message}</p>
      <div className="flex flex-wrap gap-2">
        {sorted.map((opt) => (
          <button
            key={opt.option_id}
            onClick={() => onRespond(opt.option_id, false)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              opt.kind === 'deny'
                ? 'border border-[#3a1a1a] bg-[#1a0a0a] text-[#e05c5c] hover:bg-[#2a1010]'
                : 'border border-[#1e4a7f] bg-[#0d2a4a] text-[#4a9eff] hover:bg-[#0d3060]'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => onRespond('', true)}
          className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1.5 text-[12px] text-[#5b8ab0] transition-colors hover:border-[#3a5a7a] hover:text-[#8ab0cc]"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ── Elicitation Select Panel（文字检测路径） ──────────────────────────────────

const ElicitationSelectPanel: React.FC<ElicitationPanelProps> = ({ request, onSelect, onCancel }) => {
  return (
    <div className="mx-3 mb-3 rounded-lg border border-[#1e3a5f] bg-[#0d2137] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">📋</span>
        <span className="text-[12px] font-semibold text-[#8ab0cc]">{request.message}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {request.options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            className="w-full rounded border border-[#1e3a5f] bg-[#0a1a2e] px-3 py-2 text-left text-[12px] text-[#c8daea] transition-colors hover:border-[#2a5a8f] hover:bg-[#0d2a4a]"
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={onCancel}
          className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1 text-[11px] text-[#5b8ab0] transition-colors hover:text-[#8ab0cc]"
        >
          取消
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "ElicitationPanel" | head -10
```

预期：零 error

---

### Task 9: 在 `Assistant/index.tsx` 中集成 ElicitationPanel

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: 在文件顶部 import 区新增导入**

找到现有 import 列表，新增：

```tsx
import ElicitationPanel from './ElicitationPanel'
import type { ElicitationRequest, PermissionRequest } from '../../types'
```

- [ ] **Step 2: 从 store 中解构新增的状态和 actions**

找到 `useAiStore()` 的解构，新增：

```tsx
const {
  // ...现有字段...
  respondPermission,
  respondElicitation,
  clearElicitation,
  chatStates,
} = useAiStore()
```

在组件内新增 per-session 状态读取（放在 `isChatting` 读取附近）：

```tsx
const pendingPermission = chatStates[currentSessionId]?.pendingPermission ?? null
const pendingElicitation = chatStates[currentSessionId]?.pendingElicitation ?? null
```

- [ ] **Step 3: 在 JSX 中插入两个 ElicitationPanel 挂载点**

找到 `{isChatting && <StreamingMessage sessionId={currentSessionId} />}` 这行，在其**后面**、滚动锚点 `<div ref={chatEndRef} />` **之前**插入：

```tsx
              {/* 权限确认面板（isChatting=true 时，ACP native 路径） */}
              {pendingPermission && (
                <ElicitationPanel
                  type="permission"
                  request={pendingPermission}
                  onRespond={(optionId, cancelled) =>
                    respondPermission(currentSessionId, pendingPermission.id, optionId, cancelled)
                  }
                />
              )}

              {/* 选项选择面板（isChatting=false 时，文字检测路径） */}
              {!isChatting && pendingElicitation && (
                <ElicitationPanel
                  type="elicitation"
                  request={pendingElicitation}
                  onSelect={(text) => respondElicitation(currentSessionId, text)}
                  onCancel={() => clearElicitation(currentSessionId)}
                />
              )}
```

- [ ] **Step 4: 完整 TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1
```

预期：**零 error**

- [ ] **Step 5: Rust 编译最终验证**

```bash
cd src-tauri && cargo check 2>&1
```

预期：**零 error**

- [ ] **Step 6: Commit**

```bash
git add src/components/Assistant/ElicitationPanel.tsx src/components/Assistant/index.tsx
git commit -m "feat(ui): add ElicitationPanel for ACP permission and text option selection"
```

---

## 手动验证清单

完成所有 Task 后，执行 `npm run tauri:dev` 并验证：

- [ ] **场景 1（文字检测）**：在 AI 助手中发送"帮我设计一个用户表，请选择：1. 只有基础字段 2. 包含扩展字段"，然后直接发送含选项的消息。验证流式结束后消息下方出现选项按钮，点击后发起新一轮对话。
- [ ] **场景 2（ACP permission）**：向 AI 提问需要执行 SQL 工具的问题，验证工具执行前弹出权限面板，`isChatting` 仍为 true（输入框禁用），点"允许一次"后 agent 继续输出。
- [ ] **场景 3（拒绝权限）**：重复场景 2，点"拒绝"，验证 agent 收到 Cancelled 后对话正常结束。
- [ ] **场景 4（取消面板）**：文字选项面板点"取消" → 面板消失，无消息发送；权限面板点"取消" → agent Cancelled。
- [ ] **场景 5（状态隔离）**：Session A 显示选项面板时，切换到 Session B，面板消失；切回 Session A，面板恢复显示。
- [ ] **场景 6（重启）**：关闭应用重启，两种面板均不显示（runtime state 不持久化）。
