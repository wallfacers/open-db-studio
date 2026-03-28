# Question-Asked Deadlock Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle OpenCode `question.asked` SSE events so the AI can ask follow-up questions without deadlocking the input.

**Architecture:** Add a `QuestionRequest` variant to the Rust `StreamEvent` enum, handle `question.asked` in `stream.rs`, add `question_reply`/`question_reject` to `client.rs`, expose Tauri commands, and update the frontend store + UI to show "等待用户回答" state with enabled input.

**Tech Stack:** Rust (Tauri backend), TypeScript/React (Zustand store + components)

---

## Root Cause

When OpenCode's AI agent asks a follow-up question, it publishes a `question.asked` SSE event and blocks via `Deferred.await()`. The session stays **busy** (never reaches `idle`). In `stream.rs`, this event falls to `_ => {}` — ignored. The frontend's `isChatting` stays `true` forever, disabling the input box. **Deadlock.**

## UX Flow (Target)

1. AI generates text content → streams normally (thinking indicator + content)
2. `question.asked` arrives → streaming content is committed, status changes to "等待用户回答..." (pulsing), input **enabled**, stop button changes to amber "waiting" style
3. User types answer + Enter → answer sent via `POST /question/:id/reply`, status reverts to "思考中...", input disabled, button reverts to red stop
4. AI finishes → normal `session.idle` → Done flow

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/src/llm/client.rs` | Add `QuestionRequest` variant to `StreamEvent` |
| Modify | `src-tauri/src/agent/stream.rs` | Handle `question.asked` SSE → emit `QuestionRequest` |
| Modify | `src-tauri/src/agent/client.rs` | Add `question_reply()` and `question_reject()` HTTP helpers |
| Modify | `src-tauri/src/commands.rs` | Add `agent_question_reply` and `agent_question_reject` Tauri commands |
| Modify | `src-tauri/src/lib.rs` | Register new commands in `generate_handler![]` |
| Modify | `src/types/index.ts` | Add `QuestionRequest` TypeScript type |
| Modify | `src/store/aiStore.ts` | Add `pendingQuestion` state, handle question events, add `respondQuestion` action |
| Modify | `src/components/Assistant/index.tsx` | Enable input during question, change button/status, send answer on Enter |
| Modify | `src/i18n/locales/zh.json` | Add `waitingForAnswer` i18n key |
| Modify | `src/i18n/locales/en.json` | Add `waitingForAnswer` i18n key |

---

### Task 1: Add `QuestionRequest` to Rust `StreamEvent`

**Files:**
- Modify: `src-tauri/src/llm/client.rs:7-15`

- [ ] **Step 1: Add QuestionRequest variant**

In `src-tauri/src/llm/client.rs`, add a new variant to `StreamEvent`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    ThinkingChunk { delta: String },
    ContentChunk   { delta: String },
    ToolCallRequest { call_id: String, name: String, arguments: String },
    QuestionRequest {
        question_id: String,
        session_id: String,
        questions: serde_json::Value,
    },
    Done,
    Error { message: String },
}
```

`questions` is `serde_json::Value` to pass through OpenCode's question array without redefining schemas.

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS (new variant is unused but compiles)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat: add QuestionRequest variant to StreamEvent"
```

---

### Task 2: Handle `question.asked` in SSE stream

**Files:**
- Modify: `src-tauri/src/agent/stream.rs:221-336` (the `match event_type` block in `stream_global_events`)

- [ ] **Step 1: Add question.asked handler**

In `stream_global_events`, add a new arm **before** the `_ => {}` fallthrough in the `match event_type` block (after the `"permission.updated"` arm):

```rust
// question.asked：AI agent 请求用户输入（选择题/自定义输入）
"question.asked" => {
    let q_session = props["sessionID"].as_str().unwrap_or("");
    if q_session != session_id {
        continue;
    }
    let question_id = props["id"].as_str().unwrap_or("");
    if question_id.is_empty() {
        continue;
    }

    // 先 flush 已缓冲的 content/thinking
    flushNow();

    let _ = channel.send(StreamEvent::QuestionRequest {
        question_id: question_id.to_string(),
        session_id: session_id.to_string(),
        questions: props["questions"].clone(),
    });
}
```

Note: `flushNow()` doesn't exist in `stream_global_events` (it exists in the JS store). In this Rust function, the content is sent immediately via `channel.send()` — no buffering. So no `flushNow` needed here. The handler is just:

```rust
"question.asked" => {
    let q_session = props["sessionID"].as_str().unwrap_or("");
    if q_session != session_id {
        continue;
    }
    let question_id = props["id"].as_str().unwrap_or("");
    if question_id.is_empty() {
        continue;
    }
    let _ = channel.send(StreamEvent::QuestionRequest {
        question_id: question_id.to_string(),
        session_id: session_id.to_string(),
        questions: props["questions"].clone(),
    });
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/stream.rs
git commit -m "feat: forward question.asked SSE events to frontend channel"
```

---

### Task 3: Add question HTTP helpers to `client.rs`

**Files:**
- Modify: `src-tauri/src/agent/client.rs` (append after `patch_config`)

- [ ] **Step 1: Add `question_reply` function**

Append to `src-tauri/src/agent/client.rs`:

```rust
/// Reply to a question request from the AI agent.
/// POST /question/:requestID/reply { "answers": [[...], ...] }
pub async fn question_reply(
    port: u16,
    request_id: &str,
    answers: serde_json::Value,
) -> AppResult<()> {
    let url = format!("{}/question/{}/reply", base_url(port), request_id);
    let body = serde_json::json!({ "answers": answers });

    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("question_reply request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "question_reply failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}

/// Reject a question request from the AI agent.
/// POST /question/:requestID/reject
pub async fn question_reject(port: u16, request_id: &str) -> AppResult<()> {
    let url = format!("{}/question/{}/reject", base_url(port), request_id);

    let resp = client()
        .post(&url)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("question_reject request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "question_reject failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS (functions unused for now)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/client.rs
git commit -m "feat: add question_reply and question_reject HTTP helpers"
```

---

### Task 4: Add Tauri commands + register in lib.rs

**Files:**
- Modify: `src-tauri/src/commands.rs` (add commands near `agent_permission_respond`)
- Modify: `src-tauri/src/lib.rs` (register in `generate_handler![]`)

- [ ] **Step 1: Add `agent_question_reply` command**

Add after the `agent_permission_respond` function in `commands.rs`:

```rust
/// Reply to a question from the AI agent.
/// answers: array of arrays, e.g. [["选项1"], ["自定义输入"]]
#[tauri::command]
pub async fn agent_question_reply(
    question_id: String,
    answers: serde_json::Value,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::question_reply(state.serve_port, &question_id, answers).await
}

/// Reject a question from the AI agent.
#[tauri::command]
pub async fn agent_question_reject(
    question_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::question_reject(state.serve_port, &question_id).await
}
```

- [ ] **Step 2: Register in generate_handler**

In `src-tauri/src/lib.rs`, add the two commands in the `generate_handler![]` macro, near `agent_permission_respond`:

```rust
commands::agent_question_reply,
commands::agent_question_reject,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add agent_question_reply and agent_question_reject Tauri commands"
```

---

### Task 5: Add `QuestionRequest` TypeScript type

**Files:**
- Modify: `src/types/index.ts` (after `PermissionRequest` interface, ~line 391)

- [ ] **Step 1: Add type definition**

Add after the `PermissionRequest` interface:

```typescript
/** OpenCode question.asked — AI agent 请求用户回答选择题/自定义输入 */
export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean    // 默认 true，允许自定义输入
}

export interface QuestionRequest {
  question_id: string
  session_id: string
  questions: QuestionInfo[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add QuestionRequest TypeScript types"
```

---

### Task 6: Add i18n keys

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: Add zh.json keys**

In the `"assistant"` section, add:

```json
"waitingForAnswer": "等待用户回答...",
"answerPlaceholder": "输入你的回答... (Enter 发送)",
"rejectQuestion": "跳过问题"
```

- [ ] **Step 2: Add en.json keys**

In the `"assistant"` section, add:

```json
"waitingForAnswer": "Waiting for your answer...",
"answerPlaceholder": "Type your answer... (Enter to send)",
"rejectQuestion": "Skip question"
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat: add i18n keys for question-asked flow"
```

---

### Task 7: Update Zustand store — `pendingQuestion` state + `respondQuestion` action

**Files:**
- Modify: `src/store/aiStore.ts`

This is the most critical task. Changes across 4 areas of the file:

- [ ] **Step 1: Add `pendingQuestion` to `SessionRuntimeState`**

In the `SessionRuntimeState` interface (~line 46), add after `pendingPermission`:

```typescript
pendingQuestion: QuestionRequest | null;         // question.asked 路径（isChatting=true, 输入框启用）
```

In `defaultRuntimeState()` (~line 59), add after `pendingPermission: null`:

```typescript
pendingQuestion: null,
```

Add the import at the top of the file:

```typescript
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage, ChatSession, PermissionRequest, QuestionRequest } from '../types';
```

- [ ] **Step 2: Add `respondQuestion` action to `AiState` interface**

In the `AiState` interface (~line 113), add after `respondPermission`:

```typescript
respondQuestion: (sessionId: string, questionId: string, answers: string[][], cancelled: boolean) => Promise<void>;
```

- [ ] **Step 3: Implement `respondQuestion` action**

Add the implementation after the `respondPermission` implementation (~line 391):

```typescript
respondQuestion: async (sessionId, questionId, answers, cancelled) => {
  // 立即清空 pendingQuestion，UI 先响应
  set((s) => ({
    chatStates: {
      ...s.chatStates,
      [sessionId]: {
        ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
        pendingQuestion: null,
      },
    },
  }));
  try {
    if (cancelled) {
      await invoke('agent_question_reject', { questionId });
    } else {
      await invoke('agent_question_reply', { questionId, answers });
    }
  } catch (e) {
    console.error('[question] respond failed:', e);
  }
},
```

- [ ] **Step 4: Handle `QuestionRequest` in channel.onmessage**

In the `channel.onmessage` handler (~line 786), add a new `else if` branch after the `PermissionRequest` handler (before `Done`):

```typescript
} else if (event.type === 'QuestionRequest' && event.data?.question_id) {
  // question.asked 到达：flush 当前 streaming 内容，展示 question 面板
  flushNow();
  setChatStateField({
    pendingQuestion: {
      question_id: event.data.question_id,
      session_id: event.data.session_id ?? sessionId,
      questions: event.data.questions ?? [],
    },
    activeToolName: null,
    sessionStatus: null,
  });
}
```

Also update the channel type declaration (~line 720) to include the new event:

```typescript
const channel = new Channel<{
  type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error' | 'PermissionRequest' | 'QuestionRequest';
  data?: {
    delta?: string;
    message?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    // PermissionRequest 字段
    permission_id?: string;
    options?: Array<{ option_id: string; label: string; kind: string }>;
    // QuestionRequest 字段
    question_id?: string;
    session_id?: string;
    questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean; custom?: boolean }>;
  };
}>();
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/aiStore.ts
git commit -m "feat: add pendingQuestion state and respondQuestion action to aiStore"
```

---

### Task 8: Update Assistant UI — input, button, and status

**Files:**
- Modify: `src/components/Assistant/index.tsx`

Three changes: (A) subscribe to `pendingQuestion`, (B) change input/button behavior, (C) change `StreamingMessage` to show waiting status.

- [ ] **Step 1: Subscribe to pendingQuestion in main component**

Near the existing `pendingPermission` selector (~line 118), add:

```typescript
const pendingQuestion = useAiStore((s) => s.chatStates[currentSessionId]?.pendingQuestion ?? null);
```

Also destructure `respondQuestion` from the store (~line 112):

```typescript
const { sendAgentChatStream, clearHistory, newSession, switchSession, deleteSession, deleteAllSessions, sessions, currentSessionId, configs, setSessionConfigId, loadConfigs, loadSessions, cancelChat, respondPermission, respondQuestion, linkedConnectionId, setLinkedConnectionId, undoMessage, redoMessage, compactSession } = useAiStore();
```

- [ ] **Step 2: Derive `isWaitingForAnswer` boolean**

Add after the subscriptions:

```typescript
const isWaitingForAnswer = isChatting && !!pendingQuestion;
```

- [ ] **Step 3: Update handleSendMessage to handle question answer**

Replace the existing `handleSendMessage` (~line 270):

```typescript
const handleSendMessage = async () => {
  if (!chatInput.trim()) return;

  // 如果有 pending question，发送答案而非新消息
  if (isWaitingForAnswer && pendingQuestion) {
    const answer = chatInput.trim();
    setChatInput('');
    await respondQuestion(
      currentSessionId,
      pendingQuestion.question_id,
      [[answer]],  // 单个答案包装为 answers 格式
      false,
    );
    return;
  }

  if (isChatting) return;
  const prompt = chatInput.trim();
  const activeChatCount = Object.values(useAiStore.getState().chatStates).filter((s) => s.isChatting).length;
  if (activeChatCount >= 10) {
    showToast(t('assistant.concurrentChatLimit'), 'warning');
    return;
  }
  setChatInput('');
  await sendAgentChatStream(prompt, effectiveConnectionId);
};
```

- [ ] **Step 4: Update textarea disabled state**

Change the textarea `disabled` prop (~line 385):

```typescript
disabled={isChatting && !isWaitingForAnswer}
```

Change the textarea `placeholder` prop (~line 372):

```typescript
placeholder={isWaitingForAnswer ? t('assistant.answerPlaceholder') : t('assistant.inputPlaceholder')}
```

- [ ] **Step 5: Update send/stop button area**

Replace the button section (~lines 470-489) with a 3-state button:

```typescript
{isChatting ? (
  isWaitingForAnswer ? (
    <>
      {/* 等待回答模式：amber 等待按钮 + 跳过 */}
      <Tooltip content={t('assistant.rejectQuestion')} className="contents">
        <button
          className="p-1.5 rounded transition-colors bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
          onClick={() => {
            if (pendingQuestion) {
              respondQuestion(currentSessionId, pendingQuestion.question_id, [], true);
            }
          }}
        >
          <X size={14} />
        </button>
      </Tooltip>
      <Tooltip content={t('assistant.sendMessage')} className="contents">
        <button
          className={`p-1.5 rounded transition-colors ${chatInput.trim() ? 'bg-[#00c9a7] text-white hover:bg-[#00a98f]' : 'bg-[#1e2d42] text-[#7a9bb8]'}`}
          onClick={handleSendMessage}
          disabled={!chatInput.trim()}
        >
          <Send size={14} />
        </button>
      </Tooltip>
    </>
  ) : (
    <Tooltip content={t('assistant.stopGeneration')} className="contents">
      <button
        className="p-1.5 rounded transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30"
        onClick={() => cancelChat(currentSessionId)}
      >
        <Square size={14} />
      </button>
    </Tooltip>
  )
) : (
  <Tooltip content={t('assistant.sendMessage')} className="contents">
    <button
      className={`p-1.5 rounded transition-colors ${chatInput.trim() ? 'bg-[#00c9a7] text-white hover:bg-[#00a98f]' : 'bg-[#1e2d42] text-[#7a9bb8]'}`}
      onClick={handleSendMessage}
      disabled={!chatInput.trim()}
    >
      <Send size={14} />
    </button>
  </Tooltip>
)}
```

Note: `X` is already imported from `lucide-react` in the existing imports.

- [ ] **Step 6: Update `StreamingMessage` to show waiting status**

In the `StreamingMessage` component (~line 56), add a subscription to `pendingQuestion`:

```typescript
const StreamingMessage: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const content = useAiStore((s) => s.chatStates[sessionId]?.streamingContent ?? '');
  const thinking = useAiStore((s) => s.chatStates[sessionId]?.streamingThinkingContent ?? '');
  const sessionStatus = useAiStore((s) => s.chatStates[sessionId]?.sessionStatus ?? null);
  const pendingQuestion = useAiStore((s) => s.chatStates[sessionId]?.pendingQuestion ?? null);
  const { t } = useTranslation();

  const hasFirstToken = !!(content || thinking);

  return (
    <div className="flex flex-col items-start">
      <div className="text-[#c8daea] text-[13px] w-full">
        {thinking && <ThinkingBlock content={thinking} isStreaming={!pendingQuestion} />}
        {content && <MarkdownContent content={content} isStreaming={!pendingQuestion} />}
        {pendingQuestion ? (
          <div className="flex items-center gap-2 py-1 mt-1">
            <span className="ai-dot w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
            <span className="text-xs text-amber-400 animate-pulse">{t('assistant.waitingForAnswer')}</span>
          </div>
        ) : !hasFirstToken && (
          sessionStatus ? (
            <div className="flex items-center gap-2 py-1">
              <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
              <span className="text-xs text-[#5b8ab0] animate-pulse">{sessionStatus}</span>
            </div>
          ) : (
            <TypingIndicator />
          )
        )}
      </div>
    </div>
  );
};
```

Key visual changes:
- Dot color: `bg-[#00c9a7]` (teal, thinking) → `bg-amber-400` (amber, waiting)
- Text color: `text-[#5b8ab0]` → `text-amber-400`
- `isStreaming` on ThinkingBlock/MarkdownContent becomes `false` when question arrives (stops streaming cursor animation)

- [ ] **Step 7: Add pendingQuestion to scroll-to-bottom dependencies**

Update the scroll effect (~line 263):

```typescript
}, [chatHistory, streamingContent, streamingThinking, pendingPermission, pendingQuestion, currentSessionId]);
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat: enable input during question.asked, show waiting-for-answer status"
```

---

### Task 9: Clear pendingQuestion on Done/Error/Cancel

**Files:**
- Modify: `src/store/aiStore.ts`

Ensure `pendingQuestion` is cleaned up in all exit paths.

- [ ] **Step 1: Verify Done/Error already clean up via defaultRuntimeState**

In the `commitAssistant` function (~line 700-710), the code does:

```typescript
chatStates: {
  ...s.chatStates,
  [sessionId]: {
    ...defaultRuntimeState(),  // ← resets everything including pendingQuestion
  },
},
```

`defaultRuntimeState()` has `pendingQuestion: null` (added in Task 7 Step 1). So Done/Error paths already clean up.

- [ ] **Step 2: Verify cancelChat cleans up**

In `cancelChat` (~line 355-370), the flow calls `abort_session` which triggers `session.idle` or `session.error` on the SSE stream, which calls `commitAssistant` → resets to `defaultRuntimeState()`. Additionally, `cancelChat` sets `isChatting: false` directly if the session state exists.

Check that the cancel path in `cancelChat` also resets `pendingQuestion`. Read the cancel implementation:

The `cancelChat` function likely does a direct state reset. If it does `...defaultRuntimeState()`, it's fine. If it only sets `isChatting: false`, we need to also clear `pendingQuestion`. Let me note this as something to verify during implementation.

- [ ] **Step 3: Verify and fix cancelChat if needed**

Read `cancelChat` implementation. If it does NOT reset `pendingQuestion`, add it. The fix would be:

```typescript
set((s) => ({
  chatStates: {
    ...s.chatStates,
    [sessionId]: {
      ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
      isChatting: false,
      pendingQuestion: null,        // ← ensure cleanup
      pendingPermission: null,
    },
  },
}));
```

- [ ] **Step 4: Commit (if changes needed)**

```bash
git add src/store/aiStore.ts
git commit -m "fix: ensure pendingQuestion is cleared on cancel"
```

---

### Task 10: Manual integration test

- [ ] **Step 1: Build and run**

```bash
npm run tauri:dev
```

- [ ] **Step 2: Test the question flow**

1. Open the AI assistant
2. Send a message that would trigger a follow-up question (e.g., "帮我创建一个操作日志表" with a connection that has multiple databases)
3. Verify:
   - AI streams its response normally
   - When `question.asked` arrives, the status changes to "等待用户回答..." (amber, pulsing)
   - Input box is enabled
   - Stop button changes to amber X (skip) + send button
   - Type an answer and press Enter
   - Status reverts to "思考中..." (teal)
   - Input box disables again
   - AI continues processing and eventually completes

- [ ] **Step 3: Test cancel during question**

1. Trigger a question flow
2. Click the amber X button to skip/reject
3. Verify: AI session ends or continues without the answer

- [ ] **Step 4: Test stop during normal generation**

1. Send a normal message
2. Click the red stop button during generation
3. Verify: Still works as before (no regression)

- [ ] **Step 5: Final commit (if any tweaks)**

```bash
git add -A
git commit -m "fix: integration test tweaks for question-asked flow"
```
