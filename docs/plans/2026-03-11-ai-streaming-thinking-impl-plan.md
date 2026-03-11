# AI 流式输出 + 思考模型 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 AI 助手面板实现流式输出和思考模型支持（DeepSeek-R1、Qwen-thinking、Claude Extended Thinking），并为代码块添加语法高亮。

**Architecture:** Rust 端新增 `ai_chat_stream` 命令，通过 Tauri 2.x `Channel<StreamEvent>` 实时推送 `ThinkingChunk`/`ContentChunk`/`Done`/`Error` 事件；前端 `sendChatStream` 监听 channel 追加消息，`StreamingMessage` 组件渲染思考折叠块 + 流式 markdown。

**Tech Stack:** Tauri 2.x Channel, reqwest SSE (stream feature), react-syntax-highlighter, react-markdown + remark-gfm

---

## Task 1: 安装前端依赖

**Files:**
- Modify: `package.json`（自动更新）

**Step 1: 安装 react-syntax-highlighter**

```bash
cd D:/project/java/source/open-db-studio
npm install react-syntax-highlighter
npm install --save-dev @types/react-syntax-highlighter
```

**Step 2: 验证安装**

```bash
npx tsc --noEmit
```

Expected: 无报错

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add react-syntax-highlighter"
```

---

## Task 2: Rust — 定义 StreamEvent + 添加 SSE 解析依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在 Cargo.toml 添加 futures-util**

在 `[dependencies]` 中添加（reqwest stream feature 已有，需要 futures-util 消费流）：

```toml
futures-util = "0.3"
```

**Step 2: 在 `client.rs` 顶部添加 StreamEvent 类型**

在文件顶部 `use` 语句后添加：

```rust
use futures_util::StreamExt;
use tauri::ipc::Channel;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    ThinkingChunk { delta: String },
    ContentChunk   { delta: String },
    Done,
    Error { message: String },
}
```

**Step 3: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished` 无 error

**Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/llm/client.rs
git commit -m "feat(llm): define StreamEvent and add futures-util dep"
```

---

## Task 3: Rust — 实现 OpenAI 流式方法

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在 LlmClient impl 块末尾添加 `chat_stream_openai`**

```rust
pub async fn chat_stream_openai(
    &self,
    messages: Vec<ChatMessage>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    #[derive(serde::Serialize)]
    struct StreamReq {
        model: String,
        messages: Vec<ChatMessage>,
        stream: bool,
    }
    #[derive(serde::Deserialize, Default)]
    struct Delta {
        content: Option<String>,
        reasoning_content: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Choice { delta: Delta }
    #[derive(serde::Deserialize)]
    struct Chunk { choices: Vec<Choice> }

    let req = StreamReq { model: self.model.clone(), messages, stream: true };
    let base = self.base_url.trim_end_matches('/');
    let resp = self.client
        .post(format!("{}/chat/completions", base))
        .bearer_auth(&self.api_key)
        .json(&req)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = channel.send(StreamEvent::Error { message: format!("HTTP {}: {}", status, body) });
        return Ok(());
    }

    // 状态机：跟踪 <think> 标签
    let mut in_thinking = false;
    let mut stream = resp.bytes_stream();

    while let Some(item) = stream.next().await {
        let bytes = match item {
            Ok(b) => b,
            Err(e) => {
                let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                return Ok(());
            }
        };

        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            let line = line.trim();
            if !line.starts_with("data:") { continue; }
            let json_str = line["data:".len()..].trim();
            if json_str == "[DONE]" {
                let _ = channel.send(StreamEvent::Done);
                return Ok(());
            }
            let chunk: Chunk = match serde_json::from_str(json_str) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for choice in chunk.choices {
                // reasoning_content（o1/o3 风格）
                if let Some(rc) = choice.delta.reasoning_content {
                    if !rc.is_empty() {
                        let _ = channel.send(StreamEvent::ThinkingChunk { delta: rc });
                    }
                }
                // content（DeepSeek/Qwen <think> 标签）
                if let Some(content) = choice.delta.content {
                    if content.is_empty() { continue; }
                    // 简单状态机：逐字符处理 <think>/<think> 边界
                    let mut remaining = content.as_str();
                    loop {
                        if in_thinking {
                            if let Some(pos) = remaining.find("</think>") {
                                let thinking_part = &remaining[..pos];
                                if !thinking_part.is_empty() {
                                    let _ = channel.send(StreamEvent::ThinkingChunk { delta: thinking_part.to_string() });
                                }
                                in_thinking = false;
                                remaining = &remaining[pos + "</think>".len()..];
                            } else {
                                let _ = channel.send(StreamEvent::ThinkingChunk { delta: remaining.to_string() });
                                break;
                            }
                        } else {
                            if let Some(pos) = remaining.find("<think>") {
                                let normal_part = &remaining[..pos];
                                if !normal_part.is_empty() {
                                    let _ = channel.send(StreamEvent::ContentChunk { delta: normal_part.to_string() });
                                }
                                in_thinking = true;
                                remaining = &remaining[pos + "<think>".len()..];
                            } else {
                                let _ = channel.send(StreamEvent::ContentChunk { delta: remaining.to_string() });
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}
```

**Step 2: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished` 无 error

**Step 3: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): implement OpenAI SSE streaming with think-tag state machine"
```

---

## Task 4: Rust — 实现 Anthropic 流式方法

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在 LlmClient impl 块末尾添加 `chat_stream_anthropic`**

```rust
pub async fn chat_stream_anthropic(
    &self,
    messages: Vec<ChatMessage>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    // 从 messages 中提取 system
    let mut user_messages: Vec<ChatMessage> = Vec::new();
    let mut system_content: Option<String> = None;
    for msg in messages {
        if msg.role == "system" { system_content = Some(msg.content); }
        else { user_messages.push(msg); }
    }

    #[derive(serde::Serialize)]
    struct Req {
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        system: Option<String>,
        messages: Vec<ChatMessage>,
        max_tokens: u32,
        stream: bool,
    }

    let req = Req {
        model: self.model.clone(),
        system: system_content,
        messages: user_messages,
        max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
        stream: true,
    };

    let base = self.base_url.trim_end_matches('/');
    let resp = self.client
        .post(format!("{}/v1/messages", base))
        .header("x-api-key", &self.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("user-agent", "open-db-studio/1.0")
        .json(&req)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = channel.send(StreamEvent::Error { message: format!("HTTP {}: {}", status, body) });
        return Ok(());
    }

    // 跟踪当前 content block 类型
    let mut current_block_type = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(item) = stream.next().await {
        let bytes = match item {
            Ok(b) => b,
            Err(e) => {
                let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                return Ok(());
            }
        };

        let text = String::from_utf8_lossy(&bytes);
        let mut event_type = String::new();

        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("event:") {
                event_type = line["event:".len()..].trim().to_string();
            } else if line.starts_with("data:") {
                let json_str = line["data:".len()..].trim();
                let v: serde_json::Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                match event_type.as_str() {
                    "content_block_start" => {
                        current_block_type = v["content_block"]["type"]
                            .as_str().unwrap_or("").to_string();
                    }
                    "content_block_delta" => {
                        let delta_type = v["delta"]["type"].as_str().unwrap_or("");
                        let text_val = match delta_type {
                            "thinking_delta" => v["delta"]["thinking"].as_str().unwrap_or(""),
                            "text_delta"     => v["delta"]["text"].as_str().unwrap_or(""),
                            _ => "",
                        };
                        if !text_val.is_empty() {
                            let evt = if current_block_type == "thinking" {
                                StreamEvent::ThinkingChunk { delta: text_val.to_string() }
                            } else {
                                StreamEvent::ContentChunk { delta: text_val.to_string() }
                            };
                            let _ = channel.send(evt);
                        }
                    }
                    "message_stop" => {
                        let _ = channel.send(StreamEvent::Done);
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}
```

**Step 2: 添加统一 `chat_stream` 分发方法**

```rust
pub async fn chat_stream(
    &self,
    messages: Vec<ChatMessage>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    match self.api_type {
        ApiType::Openai    => self.chat_stream_openai(messages, channel).await,
        ApiType::Anthropic => self.chat_stream_anthropic(messages, channel).await,
    }
}
```

**Step 3: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished` 无 error

**Step 4: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): implement Anthropic SSE streaming with thinking block support"
```

---

## Task 5: Rust — 注册 ai_chat_stream 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `commands.rs` 末尾添加命令**

在 `ai_chat` 命令之后添加：

```rust
#[tauri::command]
pub async fn ai_chat_stream(
    message: String,
    context: ChatContext,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_prompt = include_str!("../../prompts/chat_assistant.txt");
    let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt.to_string() }];
    messages.extend(context.history.clone());
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat_stream(messages, &channel).await
}
```

**Step 2: 在 `lib.rs` 的 `generate_handler![]` 中注册**

找到 `commands::ai_chat,` 这行，在其后添加：

```rust
commands::ai_chat_stream,
```

**Step 3: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished` 无 error

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): register ai_chat_stream command"
```

---

## Task 6: 前端 — 扩展 ChatMessage 类型 + sendChatStream

**Files:**
- Modify: `src/types/index.ts`（或 ChatMessage 定义所在文件）
- Modify: `src/store/aiStore.ts`

**Step 1: 找到 ChatMessage 类型定义位置**

```bash
grep -r "interface ChatMessage\|type ChatMessage" src/
```

**Step 2: 扩展 ChatMessage 类型**

```typescript
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;   // 思考模型的推理过程
  isStreaming?: boolean;      // 是否正在流式输出
}
```

**Step 3: 在 aiStore.ts 中添加 `sendChatStream`**

在 store interface 中添加：
```typescript
sendChatStream: (message: string, connectionId: number | null) => Promise<void>;
```

在 store 实现中添加（`sendChat` 之后）：

```typescript
sendChatStream: async (message, _connectionId) => {
  const historyBeforeMessage = get().chatHistory;
  // push 用户消息
  set((s) => ({
    isChatting: true,
    chatHistory: [...s.chatHistory, { role: 'user', content: message }],
  }));
  // push 空 assistant 占位消息
  set((s) => ({
    chatHistory: [
      ...s.chatHistory,
      { role: 'assistant', content: '', thinkingContent: '', isStreaming: true },
    ],
  }));

  try {
    const { Channel } = await import('@tauri-apps/api/core');
    const channel = new Channel<{
      type: 'ThinkingChunk' | 'ContentChunk' | 'Done' | 'Error';
      data?: { delta?: string; message?: string };
    }>();

    channel.onmessage = (event) => {
      if (event.type === 'ThinkingChunk' && event.data?.delta) {
        set((s) => {
          const history = [...s.chatHistory];
          const last = { ...history[history.length - 1] };
          last.thinkingContent = (last.thinkingContent ?? '') + event.data!.delta!;
          history[history.length - 1] = last;
          return { chatHistory: history };
        });
      } else if (event.type === 'ContentChunk' && event.data?.delta) {
        set((s) => {
          const history = [...s.chatHistory];
          const last = { ...history[history.length - 1] };
          last.content = (last.content ?? '') + event.data!.delta!;
          history[history.length - 1] = last;
          return { chatHistory: history };
        });
      } else if (event.type === 'Done') {
        set((s) => {
          const history = [...s.chatHistory];
          const last = { ...history[history.length - 1], isStreaming: false };
          history[history.length - 1] = last;
          return { chatHistory: history, isChatting: false };
        });
      } else if (event.type === 'Error') {
        set((s) => {
          const history = [...s.chatHistory];
          const last = {
            ...history[history.length - 1],
            content: `Error: ${event.data?.message ?? 'Unknown error'}`,
            isStreaming: false,
          };
          history[history.length - 1] = last;
          return { chatHistory: history, isChatting: false };
        });
      }
    };

    await invoke('ai_chat_stream', {
      message,
      context: { history: historyBeforeMessage, model: null },
      channel,
    });
  } catch (e) {
    set((s) => {
      const history = [...s.chatHistory];
      const last = {
        ...history[history.length - 1],
        content: `Error: ${String(e)}`,
        isStreaming: false,
      };
      history[history.length - 1] = last;
      return { chatHistory: history, isChatting: false };
    });
  }
},
```

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: 无报错

**Step 5: Commit**

```bash
git add src/types/index.ts src/store/aiStore.ts
git commit -m "feat(store): add sendChatStream with Tauri Channel support"
```

---

## Task 7: 前端 — ThinkingBlock 组件

**Files:**
- Create: `src/components/Assistant/ThinkingBlock.tsx`

**Step 1: 创建组件**

```tsx
import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming }) => {
  const [expanded, setExpanded] = useState(true);

  // 流式结束后自动折叠
  useEffect(() => {
    if (!isStreaming) {
      setExpanded(false);
    }
  }, [isStreaming]);

  if (!content) return null;

  return (
    <div className="mb-2 border border-[#2a3f5a] rounded bg-[#0d1520]">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Brain size={12} className="text-[#00c9a7] flex-shrink-0" />
        <span className="flex-1 text-left">
          {isStreaming ? (
            <span className="animate-pulse">思考中...</span>
          ) : (
            '思考过程'
          )}
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-xs text-[#5a7a96] font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto border-t border-[#1e2d42]">
          {content}
        </div>
      )}
    </div>
  );
};
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/Assistant/ThinkingBlock.tsx
git commit -m "feat(ui): add ThinkingBlock collapsible component"
```

---

## Task 8: 前端 — 更新 Assistant 组件使用流式 + 语法高亮

**Files:**
- Modify: `src/components/Assistant/index.tsx`

**Step 1: 更新 import**

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ThinkingBlock } from './ThinkingBlock';
```

**Step 2: 将 `sendChat` 替换为 `sendChatStream`**

在组件中：
```tsx
const { chatHistory, isChatting, sendChatStream, clearHistory, ... } = useAiStore();

const handleSendMessage = async () => {
  if (!chatInput.trim() || isChatting) return;
  const prompt = chatInput.trim();
  setChatInput('');
  await sendChatStream(prompt, activeConnectionId);
};
```

**Step 3: 更新 assistant 消息渲染**

将现有 assistant 渲染替换为：

```tsx
// assistant message
return (
  <div key={idx} className="flex flex-col items-start">
    <div className="text-[#c8daea] text-[13px] w-full">
      {/* 思考块 */}
      <ThinkingBlock
        content={msg.thinkingContent ?? ''}
        isStreaming={msg.isStreaming ?? false}
      />
      {/* 正文 */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const language = match ? match[1] : '';
            const isBlock = Boolean(match);
            if (isBlock) {
              return (
                // TODO: 后续支持模型直接操作 SQL 编辑器
                <SyntaxHighlighter
                  style={oneDark}
                  language={language}
                  PreTag="div"
                  customStyle={{
                    margin: '8px 0',
                    borderRadius: '4px',
                    fontSize: '12px',
                    border: '1px solid #1e2d42',
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className="bg-[#111922] text-[#569cd6] px-1 py-0.5 rounded text-xs font-mono" {...props}>
                {children}
              </code>
            );
          },
          p({ children }) {
            return <p className="leading-relaxed mb-2 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return <ul className="list-disc list-inside space-y-1 mb-2 pl-2">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside space-y-1 mb-2 pl-2">{children}</ol>;
          },
          li({ children }) {
            return <li className="text-[#c8daea]">{children}</li>;
          },
          h1({ children }) {
            return <h1 className="text-base font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-sm font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-medium text-[#e8f4fd] mb-1 mt-2 first:mt-0">{children}</h3>;
          },
          strong({ children }) {
            return <strong className="font-semibold text-[#e8f4fd]">{children}</strong>;
          },
          blockquote({ children }) {
            return <blockquote className="border-l-2 border-[#2a3f5a] pl-3 text-[#7a9bb8] italic my-2">{children}</blockquote>;
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse w-full">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return <th className="border border-[#1e2d42] bg-[#111922] px-2 py-1 text-left font-medium text-[#c8daea]">{children}</th>;
          },
          td({ children }) {
            return <td className="border border-[#1e2d42] px-2 py-1 text-[#c8daea]">{children}</td>;
          },
        }}
      >
        {msg.content || (msg.isStreaming ? '' : '')}
      </ReactMarkdown>
      {/* 流式光标 */}
      {msg.isStreaming && msg.content && (
        <span className="inline-block w-0.5 h-3.5 bg-[#00c9a7] animate-pulse ml-0.5 align-middle" />
      )}
    </div>
  </div>
);
```

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: 无报错

**Step 5: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(assistant): streaming output with syntax highlight and thinking block"
```

---

## Task 9: 整体验证

**Step 1: Rust 完整编译**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished` 无 error

**Step 2: 前端完整检查**

```bash
cd .. && npx tsc --noEmit
```

Expected: 无报错

**Step 3: 最终 commit（如有遗漏文件）**

```bash
git status
git add -p   # 检查并暂存未提交的改动
git commit -m "chore: finalize streaming and thinking model integration"
```

---

## 注意事项

- `Channel` 从 `@tauri-apps/api/core` 导入（Tauri 2.x），不是 `@tauri-apps/api/channel`
- OpenAI `<think>` 标签状态机：单个 SSE chunk 可能同时包含 `<think>` 开始和文本，需逐段处理
- Anthropic stream 需要 `stream: true` + 正确的 `anthropic-version` header
- `react-syntax-highlighter` 使用 Prism 版本（`react-syntax-highlighter/dist/esm/styles/prism`），包体积比 highlight.js 版稍大但语言支持更全
