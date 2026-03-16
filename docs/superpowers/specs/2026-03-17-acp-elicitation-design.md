# ACP Elicitation 统一 UI 层设计文档

**日期：** 2026-03-17
**状态：** 已批准，待实现
**背景：** AI Agent 在多轮对话中需要用户做出选择时（ACP native elicitation 或文字选项列表），当前缺乏结构化 UI 支持，用户只能手动输入，体验差且易卡住。

---

## 问题背景

当 AI 模型输出一段文字选项列表要求用户选择时，存在两个问题：

1. **ACP native elicitation**：opencode 通过 `session/elicitation` 发起结构化表单请求，当前 `AcpClientHandler` 未实现该回调，agent 暂停等待但前端无 UI 响应，导致对话卡住。
2. **文字选项 fallback**：模型以纯文字输出选项列表（如 `1. xxx\n2. yyy`），用户需手动在输入框回复，体验割裂，且没有对用户输入做任何引导。

---

## 解决方案：统一 Elicitation UI 层

两种触发路径（ACP native + 文字检测）共享同一套数据结构和渲染组件，体验一致，代码收敛。

---

## 架构总览

```
ACP native 路径                          文字检测路径
─────────────────────────────────────    ──────────────────────────────────────
opencode → session/elicitation           AI 消息流式结束
  │                                        │
  ▼                                        ▼
AcpClientHandler::elicitation_request()  前端检测数字/字母选项列表
  │ 生成 elicitation_id                    │ 解析选项
  │ 存 oneshot tx → pending_elicitations  │
  │                                        │
  ▼                                        ▼
StreamEvent::ElicitationRequest          ElicitationRequest { source: 'text' }
  │                                        │
  └──────────────┬─────────────────────────┘
                 ▼
     chatStates[sessionId].pendingElicitation
                 │
                 ▼
         ElicitationPanel 渲染
         ┌──────────────────┐
         │  select: 按钮列表 │
         │  form: 表单字段   │
         └──────────────────┘
                 │
         用户选择/填写/取消
                 │
         ┌───────┴───────┐
         │               │
    source=acp       source=text
         │               │
  invoke(acp_         sendAgentChatStream
  elicitation_        (selectedText)
  respond)
         │
  pending_elicitations[id]
  → oneshot tx.send(response)
  → ACP handler 解除阻塞
  → agent 继续
```

---

## 核心数据结构

### 前端类型（`src/types/index.ts` 新增）

```typescript
export interface ElicitationOption {
  value: string
  label: string
  description?: string
}

export interface ElicitationRequest {
  id: string                    // 唯一 ID，用于 ACP 回传关联
  sessionId: string             // 所属 chat session
  source: 'acp' | 'text'       // 来源
  type: 'select' | 'form'      // 渲染类型
  message: string               // 用户提示语
  options?: ElicitationOption[] // select 模式：选项列表
  schema?: object               // form 模式：ACP JSON Schema（扁平对象，仅原始类型）
}
```

### Rust StreamEvent 新增（`src-tauri/src/llm/mod.rs`）

```rust
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    // ...现有 variants...
    ElicitationRequest {
        elicitation_id: String,
        message: String,
        options: Option<Vec<ElicitationOption>>,
        schema: Option<serde_json::Value>,
    },
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ElicitationOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}
```

### Rust PersistentAcpSession 扩展（`src-tauri/src/state.rs`）

```rust
pub struct PersistentAcpSession {
    pub config_id: i64,
    pub config_fingerprint: String,
    pub request_tx: UnboundedSender<AcpRequest>,
    pub abort_tx: tokio::sync::oneshot::Sender<()>,
    // 新增：待处理的 elicitation 回调，key = elicitation_id
    pub pending_elicitations: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<ElicitationResponse>>
        >
    >,
}

#[derive(serde::Deserialize)]
pub struct ElicitationResponse {
    pub action: String,       // "accept" | "decline" | "cancel"
    pub content: Option<serde_json::Value>,
}
```

---

## ACP Native 路径（Rust）

### `AcpClientHandler` 新增 `elicitation_request`

```rust
async fn elicitation_request(
    &self,
    req: ElicitationRequest,  // ACP crate 类型
) -> Result<ElicitationResponse> {
    let elicitation_id = uuid::Uuid::new_v4().to_string();

    // 1. 解析选项（若 schema 是枚举类型则提取为 options）
    let options = extract_options_from_schema(&req.requested_schema);

    // 2. 创建 oneshot channel
    let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::ElicitationResponse>();

    // 3. 存入 pending map
    self.pending_elicitations
        .lock().unwrap()
        .insert(elicitation_id.clone(), tx);

    // 4. 发送事件给前端
    let tx_opt = { self.tx.lock().unwrap().clone() };
    if let Some(ref tx) = tx_opt {
        let _ = tx.send(StreamEvent::ElicitationRequest {
            elicitation_id: elicitation_id.clone(),
            message: req.message.unwrap_or_default(),
            options,
            schema: req.requested_schema,
        });
    }

    // 5. 阻塞等待用户响应
    let resp = rx.await
        .map_err(|_| anyhow::anyhow!("Elicitation cancelled"))?;

    // 6. 转换为 ACP 响应格式
    Ok(match resp.action.as_str() {
        "accept"  => ElicitationResponse::accept(resp.content),
        "decline" => ElicitationResponse::decline(),
        _         => ElicitationResponse::cancel(),
    })
}
```

### 新增 Tauri 命令

```rust
#[tauri::command]
pub async fn acp_elicitation_respond(
    session_id: String,
    elicitation_id: String,
    action: String,           // "accept" | "decline" | "cancel"
    content: Option<serde_json::Value>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(&session_id)
        .ok_or_else(|| AppError::Other("Session not found".into()))?;

    let tx = session.pending_elicitations
        .lock().unwrap()
        .remove(&elicitation_id)
        .ok_or_else(|| AppError::Other("Elicitation not found".into()))?;

    let _ = tx.send(crate::state::ElicitationResponse { action, content });
    Ok(())
}
```

---

## 文字检测路径（前端）

### 检测逻辑（`src/utils/elicitationDetector.ts` 新增）

**检测规则（按优先级）：**

| 规则 | 示例 | 最低条数 |
|------|------|---------|
| 数字列表 `N. xxx` | `1. 选项A\n2. 选项B` | 2 |
| 数字列表 `N) xxx` | `1) 选项A\n2) 选项B` | 2 |
| 字母选项 `A. xxx` | `A. 选项A\nB. 选项B` | 2 |
| 字母选项 `A) xxx` | `A) 选项A\nB) 选项B` | 2 |

**触发附加条件**（满足一项即可）：
- 消息末尾包含 `?`、`？`
- 消息包含关键词：`请选择`、`请问`、`哪个`、`哪种`、`您需要`、`你需要`

```typescript
export function detectElicitation(
  content: string,
  sessionId: string
): ElicitationRequest | null {
  // 解析选项列表...
  // 检查触发条件...
  // 返回 ElicitationRequest 或 null
}
```

**调用时机**：在 `commitAssistant` 内，消息写入后立即调用检测器，若命中则写入 `chatStates[sessionId].pendingElicitation`。

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
  pendingElicitation: ElicitationRequest | null  // 新增
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  // ...
  pendingElicitation: null,
})
```

### 新增 Store Actions

```typescript
// 响应 elicitation（ACP native 和文字检测统一入口）
respondElicitation: async (
  sessionId: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown> | string
) => void

// 清除待处理的 elicitation
clearElicitation: (sessionId: string) => void
```

**`respondElicitation` 实现要点：**

```typescript
respondElicitation: async (sessionId, action, content) => {
  const elicitation = get().chatStates[sessionId]?.pendingElicitation
  if (!elicitation) return

  // 清空 pendingElicitation
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
    },
  }))

  if (elicitation.source === 'acp') {
    // ACP native：通过 Tauri 命令回传
    await invoke('acp_elicitation_respond', {
      sessionId,
      elicitationId: elicitation.id,
      action,
      content: typeof content === 'string' ? { selected: content } : content,
    })
  } else {
    // 文字来源：accept 时直接发下一轮消息
    if (action === 'accept' && typeof content === 'string') {
      await get().sendAgentChatStream(content, null)
    }
  }
},
```

---

## UI 组件：ElicitationPanel

**文件：** `src/components/Assistant/ElicitationPanel.tsx`

**渲染位置：** 最后一条 assistant 消息正下方，`!isChatting && pendingElicitation != null` 时显示。

**两种渲染模式：**

```
┌─────────────────────────────────────────────┐
│ 📋 请选择操作                                 │
│                                             │
│  ┌──────────────────────┐                   │
│  │  1. 创建新表          │  ← 点击即提交      │
│  └──────────────────────┘                   │
│  ┌──────────────────────┐                   │
│  │  2. 修改现有表结构    │                   │
│  └──────────────────────┘                   │
│  ┌──────────────────────┐                   │
│  │  3. 仅查询不修改      │                   │
│  └──────────────────────┘                   │
│                                             │
│                          [取消]              │
└─────────────────────────────────────────────┘
```

**form 模式**（ACP schema 驱动，支持 string / number / boolean / enum）：

```
┌─────────────────────────────────────────────┐
│ 📋 请填写以下信息                             │
│                                             │
│  表名：  [___________________]              │
│  行数：  [___________________]              │
│  包含示例数据：  ○ 是  ● 否                  │
│                                             │
│              [取消]  [确认]                  │
└─────────────────────────────────────────────┘
```

**组件 Props：**

```typescript
interface ElicitationPanelProps {
  elicitation: ElicitationRequest
  onAccept: (content: Record<string, unknown> | string) => void
  onDecline: () => void
  onCancel: () => void
}
```

---

## 数据流（完整时序）

### ACP Native 场景

```
用户发消息 → agent 推理 → session/elicitation 请求
  → Rust AcpClientHandler::elicitation_request()
    → 存 oneshot tx → pending_elicitations[id]
    → StreamEvent::ElicitationRequest → channel → 前端
      → chatStates[sessionId].pendingElicitation = request
      → ElicitationPanel 渲染选项/表单
      → 用户选择
      → respondElicitation('accept', selected)
        → invoke('acp_elicitation_respond', ...)
          → Rust 查 pending_elicitations[id] → tx.send(response)
            → ACP handler 解除阻塞 → 返回响应给 opencode
              → agent 继续推理 → 输出最终结果
```

### 文字检测场景

```
AI 输出文字选项列表 → 流式结束 → commitAssistant()
  → detectElicitation(content) → 命中
    → chatStates[sessionId].pendingElicitation = request
    → ElicitationPanel 渲染按钮
    → 用户点击选项
    → respondElicitation('accept', '1. 创建新表')
      → sendAgentChatStream('1. 创建新表', connectionId)
        → 发起新一轮 ACP prompt → agent 继续
```

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/types/index.ts` | 修改 | 新增 `ElicitationOption`、`ElicitationRequest` 类型 |
| `src-tauri/src/llm/mod.rs` | 修改 | `StreamEvent` 新增 `ElicitationRequest` variant |
| `src-tauri/src/state.rs` | 修改 | `PersistentAcpSession` 新增 `pending_elicitations` |
| `src-tauri/src/acp/client.rs` | 修改 | 实现 `elicitation_request` 回调 |
| `src-tauri/src/commands.rs` | 修改 | 新增 `acp_elicitation_respond` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册 `acp_elicitation_respond` 到 `generate_handler!` |
| `src/utils/elicitationDetector.ts` | 新建 | 文字选项检测逻辑 |
| `src/store/aiStore.ts` | 修改 | `SessionRuntimeState` 新增 `pendingElicitation`；新增 `respondElicitation`、`clearElicitation` actions |
| `src/components/Assistant/ElicitationPanel.tsx` | 新建 | 统一 Elicitation UI 组件 |
| `src/components/Assistant/index.tsx` | 修改 | 引入并渲染 `ElicitationPanel` |

---

## 不在本次范围内

- URL mode elicitation（OAuth 等浏览器外跳场景）
- Elicitation 历史记录持久化（用户选择什么不写入聊天记录）
- 多个并发 elicitation 请求排队处理
- 复杂 JSON Schema（嵌套对象、数组字段）

---

## 成功验收标准

1. opencode 发起 `session/elicitation` → 前端弹出选项面板，agent 暂停；用户点选后 agent 继续输出
2. AI 文字输出 `1. xxx\n2. yyy` + 问句 → 自动渲染选项按钮，点击后发下一轮消息
3. 用户点"取消"→ ACP native 收到 cancel 响应，文字来源直接关闭面板
4. 面板仅在 `!isChatting` 时显示，流式中不显示
5. 切换 session 后，当前 session 的 `pendingElicitation` 正确恢复显示
