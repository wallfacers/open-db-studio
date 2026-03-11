# AI 流式输出 + 思考模型支持 设计文档

**日期**：2026-03-11
**状态**：已批准

## 背景

当前 AI 助手面板为阻塞式请求（等待完整响应后一次性渲染），无法：
1. 流式展示回答过程（用户体验差）
2. 支持思考模型（DeepSeek-R1、Qwen-thinking、Claude Extended Thinking）的推理过程展示
3. 对代码块做语法高亮

## 目标

- 助手面板支持流式输出（字符级实时渲染）
- 支持三类思考模型协议，思考过程折叠展示
- 代码块支持多语言语法高亮

## 架构

### 通信方式：Tauri Channel

前端创建 `Channel<StreamEvent>` 传入新命令 `ai_chat_stream`，Rust 按块推送事件。

### StreamEvent（Rust → 前端）

```rust
#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
enum StreamEvent {
    ThinkingChunk { delta: String },
    ContentChunk   { delta: String },
    Done,
    Error { message: String },
}
```

### 新增 Rust 命令

```rust
#[tauri::command]
pub async fn ai_chat_stream(
    message: String,
    context: ChatContext,
    channel: Channel<StreamEvent>,
) -> AppResult<()>
```

## Rust 流式解析

### OpenAI 兼容（DeepSeek-R1 / Qwen-thinking）

SSE delta 状态机：

```
收到 delta.content:
  ├─ 含 <think>  → 切换 InThinking，emit ThinkingChunk
  ├─ 含 </think> → 切换 Normal，emit ContentChunk
  ├─ InThinking  → emit ThinkingChunk
  └─ Normal      → emit ContentChunk

收到 delta.reasoning_content（o1/o3）:
  └─ 直接 emit ThinkingChunk
```

### Anthropic SSE（Claude Extended Thinking）

```
content_block_start  → 记录当前块类型（thinking / text）
content_block_delta  → 按块类型 emit ThinkingChunk / ContentChunk
message_stop         → emit Done
```

## 前端状态

### ChatMessage 扩展

```typescript
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinkingContent?: string;  // 思考过程
  isStreaming?: boolean;
}
```

### sendChatStream 流程

1. 快照当前历史 → `historyBeforeMessage`
2. push 用户消息到 `chatHistory`
3. push 空 assistant 消息（`isStreaming: true`）
4. 创建 Channel，调用 `ai_chat_stream`
5. `ThinkingChunk` → 追加到最后消息的 `thinkingContent`
6. `ContentChunk`  → 追加到最后消息的 `content`
7. `Done`          → `isStreaming: false`
8. `Error`         → 写入错误文字，`isStreaming: false`

## UI 设计

### 思考阶段

- 思考块展开，显示实时流入的思考文字（小字、可滚动）
- 顶部显示 "思考中..." 动画指示器

### 回答阶段

- 收到第一个 ContentChunk 时，思考块自动折叠
- 正文流式渲染，末尾光标闪烁动画

### 完成后

- 思考块默认折叠，点击可展开/收起
- 无思考内容时不显示思考块
- 正文通过 `react-markdown` + `react-syntax-highlighter` 渲染

### 代码块语法高亮

- 使用 `react-syntax-highlighter`（`oneDark` 主题）
- 支持 sql、javascript、python、shell、json 等常用语言

### 错误处理

- Error 事件 → 红色提示，保留已流入内容

## 兼容性

- 保留原 `sendChat`（非流式），供 `generateSql` / `explainSql` 等功能继续使用
- `ai_chat`（非流式对话命令）保留，不删除

## 新增依赖

| 层 | 包 | 用途 |
|---|---|---|
| Rust | `eventsource-stream` 或手解析 | SSE 流解析 |
| 前端 | `react-syntax-highlighter` | 代码块高亮 |
| 前端 | `@types/react-syntax-highlighter` | 类型声明 |
