# Agent Phase 2 — Tool Loop 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现工具驱动 Agent Loop：Rust 侧支持 OpenAI function calling，前端 TypeScript 编排 Agent Loop，工具目录覆盖 A/B/C/D 四类（编辑器/数据库结构/数据查询/写回），AI 助手默认走 Agent 路径。

**Architecture:** Rust 作为 LLM 网关发送带工具定义的请求，检测 `finish_reason=tool_calls` 时通过 Channel 发送 `ToolCallRequest` 事件；前端 Agent Loop 接收事件、执行工具（读 queryStore 或 invoke）、将结果追加到历史、调用 `ai_chat_continue` 继续；循环直至 LLM 返回纯文本响应。Anthropic 协议不支持工具调用，自动降级为普通流式对话。

**Tech Stack:** Rust + Tauri Channel（已有）、TypeScript + Zustand（已有）、OpenAI function calling 格式、`src/agent/` 新目录

---

## 现有代码可直接复用

| 现有命令/函数 | 用途 |
|---|---|
| `list_databases(connectionId)` | B类: 列出数据库 |
| `list_objects(connectionId, database, schema, category)` | B类: tables/views/procedures |
| `get_table_detail(connectionId, table, schema)` | B类: 表结构 |
| `get_query_history(connectionId, limit)` | C类: 查询历史 |
| `execute_query` (已有，无限制版) | C类基础（新建受限版） |
| `parseStatements` (sqlParser.ts) | A类: 解析语句 |
| `proposeSqlDiff` (queryStore) | D类: diff 写回（已实现） |
| `setActiveTab` (queryStore) | D类: 切换 tab |

---

### Task 1: sqlParser.ts 扩展 — 添加 startLine/endLine

**Files:**
- Modify: `src/utils/sqlParser.ts`
- Modify: `src/types/index.ts`（`SqlStatementInfo` 接口）

**Step 1: 在 `src/types/index.ts` 中找到 `SqlStatementInfo` 并添加 line 字段**

找到（或新增）接口：
```typescript
export interface SqlStatementInfo {
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;  // 新增（0-based）
  endLine: number;    // 新增（0-based）
}
```

**Step 2: 修改 `src/utils/sqlParser.ts` 的 `pushStatement`**

将 `pushStatement` 改为接受完整 sql 字符串来计算行号：

```typescript
function pushStatement(
  sql: string,
  rawStart: number,
  rawEnd: number,
  results: SqlStatementInfo[]
): void {
  const slice = sql.slice(rawStart, rawEnd);
  const trimmedStart = rawStart + (slice.length - slice.trimStart().length);
  const text = slice.trim();
  if (text.length > 0) {
    const startLine = countNewlines(sql, 0, trimmedStart);
    const endLine = countNewlines(sql, 0, trimmedStart + text.length);
    results.push({ text, startOffset: trimmedStart, endOffset: trimmedStart + text.length, startLine, endLine });
  }
}

function countNewlines(sql: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (sql[i] === '\n') count++;
  }
  return count;
}
```

**Step 3: 验证编译通过**

```bash
npx tsc --noEmit
```
期望：无错误

**Step 4: Commit**

```bash
git add src/utils/sqlParser.ts src/types/index.ts
git commit -m "feat(parser): add startLine/endLine to SqlStatementInfo"
```

---

### Task 2: Rust — 扩展 StreamEvent + 新增 Agent 类型

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在 `client.rs` 的 `StreamEvent` 枚举中添加 `ToolCallRequest` 变体**

在 `StreamEvent` 枚举中追加：
```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    ThinkingChunk { delta: String },
    ContentChunk   { delta: String },
    ToolCallRequest { call_id: String, name: String, arguments: String },  // NEW
    Done,
    Error { message: String },
}
```

**Step 2: 在 `client.rs` 中添加工具相关结构体**（在 `StreamEvent` 下方）

```rust
/// OpenAI tool definition（从前端传入）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Agent 对话消息（支持 tool_calls / tool result）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentMessage {
    pub role: String,                          // "user" | "assistant" | "tool"
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AgentToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,   // "function"
    pub function: AgentToolCallFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolCallFunction {
    pub name: String,
    pub arguments: String,
}
```

**Step 3: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | head -20
```
期望：无错误

**Step 4: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): add ToolCallRequest event and Agent message types"
```

---

### Task 3: Rust — LlmClient 实现 chat_stream_with_tools

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在 `client.rs` 中添加 `chat_stream_with_tools_openai` 方法**

在 `chat_stream_openai` 方法之后添加：

```rust
pub async fn chat_stream_with_tools_openai(
    &self,
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    #[derive(serde::Serialize)]
    struct FunctionDef<'a> {
        name: &'a str,
        description: &'a str,
        parameters: &'a serde_json::Value,
    }
    #[derive(serde::Serialize)]
    struct OpenAITool<'a> {
        #[serde(rename = "type")]
        tool_type: &'static str,
        function: FunctionDef<'a>,
    }
    #[derive(serde::Serialize)]
    struct StreamReq<'a> {
        model: String,
        messages: &'a Vec<AgentMessage>,
        tools: Vec<OpenAITool<'a>>,
        stream: bool,
    }

    let openai_tools: Vec<OpenAITool> = tools.iter().map(|t| OpenAITool {
        tool_type: "function",
        function: FunctionDef {
            name: &t.name,
            description: &t.description,
            parameters: &t.parameters,
        },
    }).collect();

    let req = StreamReq {
        model: self.model.clone(),
        messages: &messages,
        tools: openai_tools,
        stream: true,
    };

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

    // 累积 tool_calls（可能跨多个 chunk）
    let mut tool_calls_acc: Vec<(String, String, String)> = Vec::new(); // (id, name, arguments)
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
                // 如果有工具调用，发送 ToolCallRequest 事件
                for (id, name, args) in &tool_calls_acc {
                    let _ = channel.send(StreamEvent::ToolCallRequest {
                        call_id: id.clone(),
                        name: name.clone(),
                        arguments: args.clone(),
                    });
                }
                let _ = channel.send(StreamEvent::Done);
                return Ok(());
            }
            let v: serde_json::Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // 处理 tool_calls delta
            if let Some(tool_calls) = v["choices"][0]["delta"]["tool_calls"].as_array() {
                for tc in tool_calls {
                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                    while tool_calls_acc.len() <= idx {
                        tool_calls_acc.push((String::new(), String::new(), String::new()));
                    }
                    if let Some(id) = tc["id"].as_str() {
                        tool_calls_acc[idx].0 = id.to_string();
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        tool_calls_acc[idx].1 = name.to_string();
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        tool_calls_acc[idx].2.push_str(args);
                    }
                }
            }

            // 处理普通 content delta（回退到普通流式输出）
            if let Some(content) = v["choices"][0]["delta"]["content"].as_str() {
                if !content.is_empty() {
                    let _ = channel.send(StreamEvent::ContentChunk { delta: content.to_string() });
                }
            }
        }
    }

    // 流结束但未收到 [DONE]，发送已累积的工具调用
    for (id, name, args) in &tool_calls_acc {
        if !name.is_empty() {
            let _ = channel.send(StreamEvent::ToolCallRequest {
                call_id: id.clone(),
                name: name.clone(),
                arguments: args.clone(),
            });
        }
    }
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

pub async fn chat_stream_with_tools(
    &self,
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    match self.api_type {
        ApiType::Openai => self.chat_stream_with_tools_openai(messages, tools, channel).await,
        // Anthropic 不支持工具，降级为普通流式（将 content 拼接后发送）
        ApiType::Anthropic => {
            let msgs: Vec<ChatMessage> = messages.into_iter().filter_map(|m| {
                m.content.map(|c| ChatMessage { role: m.role, content: c })
            }).collect();
            self.chat_stream_anthropic(msgs, channel).await
        }
    }
}
```

**Step 2: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```
期望：无错误

**Step 3: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): implement chat_stream_with_tools for OpenAI function calling"
```

---

### Task 4: Rust — ai_chat_stream_with_tools + ai_chat_continue 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `commands.rs` 顶部 import 中添加 AgentMessage + ToolDefinition**

在文件第一行找到 `use crate::llm::{ChatContext, ChatMessage};` 并修改为：
```rust
use crate::llm::{ChatContext, ChatMessage, AgentMessage, ToolDefinition};
```

**Step 2: 在 `commands.rs` 末尾添加两个 Agent 命令**

```rust
#[tauri::command]
pub async fn ai_chat_stream_with_tools(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_msg = AgentMessage {
        role: "system".into(),
        content: Some(include_str!("../../prompts/chat_assistant.txt").to_string()),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    };
    let mut all_messages = vec![system_msg];
    all_messages.extend(messages);
    client.chat_stream_with_tools(all_messages, tools, &channel).await
}

#[tauri::command]
pub async fn ai_chat_continue(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    // ai_chat_continue 不再追加 system prompt（messages 中已含），直接继续
    client.chat_stream_with_tools(messages, tools, &channel).await
}
```

**Step 3: 在 `src-tauri/src/lib.rs` 注册新命令**

在 `commands::list_objects,` 后追加：
```rust
commands::ai_chat_stream_with_tools,
commands::ai_chat_continue,
```

**Step 4: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```
期望：无错误

**Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add ai_chat_stream_with_tools and ai_chat_continue"
```

---

### Task 5: Rust — Agent 安全查询命令（C 类工具）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `commands.rs` 末尾添加 agent_get_table_sample**

```rust
/// Agent 工具：获取表样本数据（最多 20 行）
#[tauri::command]
pub async fn agent_get_table_sample(
    connection_id: i64,
    table: String,
    schema: Option<String>,
    limit: Option<usize>,
) -> AppResult<QueryResult> {
    let safe_limit = limit.unwrap_or(5).min(20);
    let sql = match schema {
        Some(ref s) if !s.is_empty() => format!("SELECT * FROM \"{}\".\"{}\" LIMIT {}", s, table, safe_limit),
        _ => format!("SELECT * FROM \"{}\" LIMIT {}", table, safe_limit),
    };
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.execute(&sql).await
}

/// Agent 工具：执行只读 SQL（仅 SELECT，最多 100 行）
#[tauri::command]
pub async fn agent_execute_sql(
    connection_id: i64,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<QueryResult> {
    let trimmed = sql.trim().to_uppercase();
    if !trimmed.starts_with("SELECT") && !trimmed.starts_with("WITH") && !trimmed.starts_with("SHOW") {
        return Err(crate::AppError::Other("agent_execute_sql only allows SELECT/WITH/SHOW queries".into()));
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    ).await?;
    let mut result = ds.execute(&sql).await?;
    if result.rows.len() > 100 {
        result.rows.truncate(100);
        result.row_count = 100;
    }
    Ok(result)
}
```

**Step 2: 在 `lib.rs` 注册**

在 `commands::ai_chat_continue,` 后追加：
```rust
commands::agent_get_table_sample,
commands::agent_execute_sql,
```

**Step 3: 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | head -30
```
期望：无错误

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add agent_get_table_sample and agent_execute_sql with safety limits"
```

---

### Task 6: TypeScript — Tool Catalog

**Files:**
- Create: `src/agent/toolCatalog.ts`
- Modify: `src/types/index.ts`（添加 Agent 类型）

**Step 1: 在 `src/types/index.ts` 末尾添加 Agent 类型**

```typescript
// ---- Agent / Tool Loop 类型 ----

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolContext {
  connectionId: number | null;
}
```

**Step 2: 创建 `src/agent/toolCatalog.ts`**

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolContext, QueryResult } from '../types';
import { useQueryStore } from '../store/queryStore';
import { parseStatements } from '../utils/sqlParser';

// =============================================
// A. 编辑器工具（读 queryStore）
// =============================================

function getEditorTools(): ToolDefinition[] {
  return [
    {
      name: 'get_current_tab',
      description: 'Get the current active SQL editor tab: its id, title, full SQL content, parsed statements with line numbers, and cursor position.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_tab_sql',
      description: 'Get the full SQL content of a specific tab by its id.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'The tab id to read SQL from' },
        },
        required: ['tab_id'],
      },
    },
    {
      name: 'list_tabs',
      description: 'List all open SQL editor tabs (id, title, type).',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_selected_text',
      description: 'Get the currently selected text in the active editor, along with start and end line numbers.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'parse_sql_statements',
      description: 'Parse the SQL in the current tab into individual statements, each with text and line numbers.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

// =============================================
// B. 数据库结构工具（invoke 现有命令）
// =============================================

function getDbStructureTools(): ToolDefinition[] {
  return [
    {
      name: 'list_databases',
      description: 'List all databases available on the current connection.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
        },
        required: ['connection_id'],
      },
    },
    {
      name: 'list_tables',
      description: 'List all table names in a database (and optionally a schema).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
          schema: { type: 'string', description: 'Schema name (optional, for PostgreSQL/Oracle)' },
        },
        required: ['connection_id', 'database'],
      },
    },
    {
      name: 'get_table_schema',
      description: 'Get detailed schema for a table: columns (name, type, nullable, default, primary key), indexes, and foreign keys.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          table: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
        },
        required: ['connection_id', 'table'],
      },
    },
    {
      name: 'list_views',
      description: 'List all view names in a database.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
        },
        required: ['connection_id', 'database'],
      },
    },
    {
      name: 'list_procedures',
      description: 'List all stored procedure and function names in a database.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
        },
        required: ['connection_id', 'database'],
      },
    },
  ];
}

// =============================================
// C. 数据工具（新建受限 invoke 命令）
// =============================================

function getDataTools(): ToolDefinition[] {
  return [
    {
      name: 'get_table_sample',
      description: 'Fetch a sample of rows from a table (max 20 rows) to understand the data format.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          table: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
          limit: { type: 'number', description: 'Max rows to return, capped at 20' },
        },
        required: ['connection_id', 'table'],
      },
    },
    {
      name: 'execute_sql',
      description: 'Execute a read-only SQL query (SELECT/WITH/SHOW only). Returns at most 100 rows.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          sql: { type: 'string', description: 'SQL query to execute (SELECT/WITH/SHOW only)' },
          database: { type: 'string', description: 'Database context (optional)' },
        },
        required: ['connection_id', 'sql'],
      },
    },
    {
      name: 'get_last_error',
      description: 'Get the most recent SQL execution error message from the current session.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_query_history',
      description: 'Get recently executed SQL statements for the current connection (max 50).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          limit: { type: 'number', description: 'Number of records to return, max 50' },
        },
        required: ['connection_id'],
      },
    },
  ];
}

// =============================================
// D. 写回工具（操作编辑器）
// =============================================

function getWriteBackTools(): ToolDefinition[] {
  return [
    {
      name: 'propose_sql_diff',
      description: 'Propose a SQL change: show the user a diff preview and wait for them to confirm before applying to the editor.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Tab id to modify' },
          original: { type: 'string', description: 'The original SQL text to replace' },
          modified: { type: 'string', description: 'The new SQL text' },
          reason: { type: 'string', description: 'Brief explanation of what changed and why' },
        },
        required: ['tab_id', 'original', 'modified', 'reason'],
      },
    },
    {
      name: 'switch_tab',
      description: 'Switch the active editor tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'The tab id to switch to' },
        },
        required: ['tab_id'],
      },
    },
  ];
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    ...getEditorTools(),
    ...getDbStructureTools(),
    ...getDataTools(),
    ...getWriteBackTools(),
  ];
}

// =============================================
// Tool Executor — 根据 name 分发执行
// =============================================

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  _context: ToolContext
): Promise<string> {
  const store = useQueryStore.getState();

  try {
    switch (name) {
      // -- A: Editor tools --
      case 'get_current_tab': {
        const tabId = store.activeTabId;
        const sql = store.sqlContent[tabId] ?? '';
        const editorInfo = store.editorInfo[tabId];
        const statements = parseStatements(sql);
        return JSON.stringify({
          tabId,
          title: store.tabs.find(t => t.id === tabId)?.title ?? tabId,
          sql,
          statements,
          cursorLine: editorInfo?.cursorLine ?? 0,
        });
      }

      case 'get_tab_sql': {
        const tabId = String(args.tab_id ?? '');
        return JSON.stringify({ tabId, sql: store.sqlContent[tabId] ?? '' });
      }

      case 'list_tabs': {
        return JSON.stringify(store.tabs.map(t => ({ id: t.id, title: t.title, type: t.type })));
      }

      case 'get_selected_text': {
        const tabId = store.activeTabId;
        const editorInfo = store.editorInfo[tabId];
        return JSON.stringify({
          text: editorInfo?.selectedText ?? '',
          startLine: editorInfo?.selectionStartLine ?? 0,
          endLine: editorInfo?.selectionEndLine ?? 0,
        });
      }

      case 'parse_sql_statements': {
        const sql = store.sqlContent[store.activeTabId] ?? '';
        return JSON.stringify(parseStatements(sql));
      }

      // -- B: Database structure tools --
      case 'list_databases': {
        const result = await invoke<string[]>('list_databases', { connectionId: args.connection_id });
        return JSON.stringify(result);
      }

      case 'list_tables': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: args.schema ?? null,
          category: 'tables',
        });
        return JSON.stringify(result);
      }

      case 'get_table_schema': {
        const result = await invoke('get_table_detail', {
          connectionId: args.connection_id,
          table: args.table,
          schema: args.schema ?? null,
        });
        return JSON.stringify(result);
      }

      case 'list_views': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: null,
          category: 'views',
        });
        return JSON.stringify(result);
      }

      case 'list_procedures': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: null,
          category: 'procedures',
        });
        return JSON.stringify(result);
      }

      // -- C: Data tools --
      case 'get_table_sample': {
        const result = await invoke<QueryResult>('agent_get_table_sample', {
          connectionId: args.connection_id,
          table: args.table,
          schema: args.schema ?? null,
          limit: args.limit ?? 5,
        });
        return JSON.stringify(result);
      }

      case 'execute_sql': {
        const result = await invoke<QueryResult>('agent_execute_sql', {
          connectionId: args.connection_id,
          sql: args.sql,
          database: args.database ?? null,
          schema: null,
        });
        return JSON.stringify(result);
      }

      case 'get_last_error': {
        return JSON.stringify({ error: store.error });
      }

      case 'get_query_history': {
        const safeLimit = Math.min(Number(args.limit ?? 10), 50);
        const result = await invoke('get_query_history', {
          connectionId: args.connection_id,
          limit: safeLimit,
        });
        return JSON.stringify(result);
      }

      // -- D: Write-back tools --
      case 'propose_sql_diff': {
        const tabId = String(args.tab_id);
        const sql = store.sqlContent[tabId] ?? '';
        const startOffset = sql.indexOf(String(args.original));
        if (startOffset === -1) {
          return JSON.stringify({ error: 'Original text not found in tab SQL' });
        }
        store.proposeSqlDiff({
          tabId,
          original: String(args.original),
          modified: String(args.modified),
          reason: String(args.reason),
          startOffset,
          endOffset: startOffset + String(args.original).length,
        });
        return JSON.stringify({ status: 'diff proposed, awaiting user confirmation' });
      }

      case 'switch_tab': {
        store.setActiveTab(String(args.tab_id));
        return JSON.stringify({ status: 'switched', tabId: args.tab_id });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}
```

**Step 3: 检查 `EditorInfo` 类型是否有 selectedText/selectionStartLine/selectionEndLine 字段**

在 `src/types/index.ts` 中找到 `EditorInfo`（或 `EditInfo`），确保有以下字段，缺少的需补充：

```typescript
export interface EditorInfo {
  cursorLine: number;
  cursorColumn: number;
  selectedText: string;
  selectionStartLine: number;
  selectionEndLine: number;
}
```

如不存在该接口，则新增；如已存在但缺字段则补充缺少的字段。

**Step 4: 检查 queryStore 的 SqlDiffProposal 是否有 original/reason 字段**

在 `src/types/index.ts` 中找到 `SqlDiffProposal`：

```typescript
export interface SqlDiffProposal {
  tabId: string;
  original: string;      // 新增（如果缺少）
  modified: string;
  reason: string;        // 新增（如果缺少）
  startOffset: number;
  endOffset: number;
}
```

**Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit
```
期望：无错误

**Step 6: Commit**

```bash
git add src/agent/toolCatalog.ts src/types/index.ts
git commit -m "feat(agent): implement Tool Catalog with A/B/C/D tool categories"
```

---

### Task 7: TypeScript — Agent Loop

**Files:**
- Create: `src/agent/agentLoop.ts`

**Step 1: 创建 `src/agent/agentLoop.ts`**

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { AgentMessage, AgentToolCall, ToolDefinition, ToolContext } from '../types';
import { executeTool } from './toolCatalog';

const MAX_TOOL_ITERATIONS = 10;

export interface AgentStreamCallbacks {
  onThinkingChunk: (delta: string) => void;
  onContentChunk: (delta: string) => void;
  onToolCall: (name: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/**
 * 执行一轮 LLM 请求（stream_with_tools 或 continue）。
 * 返回：{ toolCalls: [...] } 如果 LLM 请求工具调用，否则 { toolCalls: [] }
 */
async function invokeAgentRound(
  command: 'ai_chat_stream_with_tools' | 'ai_chat_continue',
  messages: AgentMessage[],
  tools: ToolDefinition[],
  callbacks: AgentStreamCallbacks
): Promise<{ toolCalls: Array<{ call_id: string; name: string; arguments: string }> }> {
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<{
    type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'Done' | 'Error';
    data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
  }>();

  const pendingToolCalls: Array<{ call_id: string; name: string; arguments: string }> = [];
  let done = false;

  return new Promise((resolve, reject) => {
    channel.onmessage = (event) => {
      if (event.type === 'ThinkingChunk' && event.data?.delta) {
        callbacks.onThinkingChunk(event.data.delta);
      } else if (event.type === 'ContentChunk' && event.data?.delta) {
        callbacks.onContentChunk(event.data.delta);
      } else if (event.type === 'ToolCallRequest') {
        pendingToolCalls.push({
          call_id: event.data?.call_id ?? '',
          name: event.data?.name ?? '',
          arguments: event.data?.arguments ?? '{}',
        });
      } else if (event.type === 'Done') {
        if (!done) {
          done = true;
          resolve({ toolCalls: pendingToolCalls });
        }
      } else if (event.type === 'Error') {
        if (!done) {
          done = true;
          callbacks.onError(event.data?.message ?? 'Unknown error');
          resolve({ toolCalls: [] });
        }
      }
    };

    invoke(command, { messages, tools, channel })
      .catch((e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
  });
}

/**
 * 完整 Agent Loop：
 * 1. 调用 ai_chat_stream_with_tools
 * 2. 若有工具调用 → 执行工具 → 追加消息 → 调用 ai_chat_continue
 * 3. 重复直至 LLM 返回纯文本或达到最大迭代次数
 */
export async function runAgentLoop(
  userMessage: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  context: ToolContext,
  callbacks: AgentStreamCallbacks
): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  let command: 'ai_chat_stream_with_tools' | 'ai_chat_continue' = 'ai_chat_stream_with_tools';
  let assistantContent = '';
  let assistantThinking = '';

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    assistantContent = '';
    assistantThinking = '';

    const wrappedCallbacks: AgentStreamCallbacks = {
      ...callbacks,
      onThinkingChunk: (delta) => {
        assistantThinking += delta;
        callbacks.onThinkingChunk(delta);
      },
      onContentChunk: (delta) => {
        assistantContent += delta;
        callbacks.onContentChunk(delta);
      },
    };

    const { toolCalls } = await invokeAgentRound(command, messages, tools, wrappedCallbacks);

    if (toolCalls.length === 0) {
      // LLM 返回了纯文本，对话结束
      break;
    }

    // 构造 assistant 消息（含 tool_calls）
    const assistantMsg: AgentMessage = {
      role: 'assistant',
      content: assistantContent || undefined,
      tool_calls: toolCalls.map(tc => ({
        id: tc.call_id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    // 执行工具并追加结果
    for (const tc of toolCalls) {
      callbacks.onToolCall(tc.name);
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.arguments); } catch {}
      const result = await executeTool(tc.name, parsedArgs, context);
      messages.push({
        role: 'tool',
        tool_call_id: tc.call_id,
        name: tc.name,
        content: result,
      });
    }

    command = 'ai_chat_continue';
  }

  callbacks.onDone();
  return messages;
}
```

**Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```
期望：无错误

**Step 3: Commit**

```bash
git add src/agent/agentLoop.ts
git commit -m "feat(agent): implement Agent Loop with tool call orchestration"
```

---

### Task 8: TypeScript — aiStore 集成 Agent Loop

**Files:**
- Modify: `src/store/aiStore.ts`

**Step 1: 在 `aiStore.ts` 中添加 Agent Loop 相关 import 和类型**

在文件顶部 import 中添加：
```typescript
import type { AgentMessage, ToolDefinition } from '../types';
import { runAgentLoop } from '../agent/agentLoop';
import { getToolDefinitions } from '../agent/toolCatalog';
```

**Step 2: 在 `AiState` interface 中添加新方法和状态**

在 `clearHistory: () => void;` 之后添加：
```typescript
// Agent 模式扩展历史（AgentMessage 格式）
agentHistory: AgentMessage[];
sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;
clearAgentHistory: () => void;
// 当前工具调用状态
activeToolName: string | null;
```

**Step 3: 在 `create()` 初始值中添加**

在 `isChatting: false,` 附近添加：
```typescript
agentHistory: [],
activeToolName: null,
```

**Step 4: 在 `clearHistory` 后添加新方法实现**

```typescript
clearAgentHistory: () => set({ agentHistory: [], chatHistory: [] }),

sendAgentChatStream: async (message, connectionId) => {
  const tools: ToolDefinition[] = getToolDefinitions();

  // 先在 chatHistory 显示用户消息
  set((s) => ({
    isChatting: true,
    chatHistory: [...s.chatHistory, { role: 'user', content: message }],
  }));
  // 预插入流式 assistant 消息占位
  set((s) => ({
    chatHistory: [
      ...s.chatHistory,
      { role: 'assistant', content: '', thinkingContent: '', isStreaming: true },
    ],
  }));

  const history = get().agentHistory;

  try {
    const finalMessages = await runAgentLoop(
      message,
      history,
      tools,
      { connectionId },
      {
        onThinkingChunk: (delta) => {
          set((s) => {
            const h = [...s.chatHistory];
            const last = { ...h[h.length - 1] };
            last.thinkingContent = (last.thinkingContent ?? '') + delta;
            h[h.length - 1] = last;
            return { chatHistory: h };
          });
        },
        onContentChunk: (delta) => {
          set((s) => {
            const h = [...s.chatHistory];
            const last = { ...h[h.length - 1] };
            last.content = (last.content ?? '') + delta;
            h[h.length - 1] = last;
            return { chatHistory: h };
          });
        },
        onToolCall: (toolName) => {
          set({ activeToolName: toolName });
        },
        onDone: () => {
          set((s) => {
            const h = [...s.chatHistory];
            h[h.length - 1] = { ...h[h.length - 1], isStreaming: false };
            return { chatHistory: h, isChatting: false, activeToolName: null };
          });
        },
        onError: (msg) => {
          set((s) => {
            const h = [...s.chatHistory];
            h[h.length - 1] = {
              ...h[h.length - 1],
              content: `Error: ${msg}`,
              isStreaming: false,
            };
            return { chatHistory: h, isChatting: false, activeToolName: null };
          });
        },
      }
    );
    // 保存完整 Agent 历史（含 tool_calls / tool results）
    set({ agentHistory: finalMessages });
  } catch (e) {
    set((s) => {
      const h = [...s.chatHistory];
      h[h.length - 1] = {
        ...h[h.length - 1],
        content: `Error: ${String(e)}`,
        isStreaming: false,
      };
      return { chatHistory: h, isChatting: false, activeToolName: null };
    });
  }
},
```

**Step 5: 在 `clearHistory` 实现中同时清理 agentHistory**

将：
```typescript
clearHistory: () => set({ chatHistory: [] }),
```
改为：
```typescript
clearHistory: () => set({ chatHistory: [], agentHistory: [] }),
```

**Step 6: TypeScript 类型检查**

```bash
npx tsc --noEmit
```
期望：无错误

**Step 7: Commit**

```bash
git add src/store/aiStore.ts
git commit -m "feat(store): add sendAgentChatStream to aiStore"
```

---

### Task 9: 将 Assistant 切换到 Agent 模式

**Files:**
- Modify: `src/components/Assistant/index.tsx`

**Step 1: 在 Assistant 中将 sendChatStream 替换为 sendAgentChatStream**

找到 `useAiStore` 解构，添加 `sendAgentChatStream, activeToolName`：
```typescript
const { chatHistory, isChatting, sendChatStream, sendAgentChatStream, activeToolName, clearHistory } = useAiStore();
```

找到 `handleSendMessage` 函数中调用 `sendChatStream` 的行，改为：
```typescript
await sendAgentChatStream(prompt, activeConnectionId);
```

**Step 2: 在 Assistant UI 中显示工具调用状态**

在加载动画区域（`isChatting` 判断附近），找到显示"等待中"动画的位置，在其上方添加工具状态提示：

```tsx
{isChatting && activeToolName && (
  <div className="text-xs text-[#5b8ab0] px-3 py-1 italic">
    ⚙ 调用工具：{activeToolName}...
  </div>
)}
```

**Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit
```
期望：无错误

**Step 4: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(assistant): switch to Agent Loop with tool call status display"
```

---

### Task 10: 系统提示词更新

**Files:**
- Modify: `prompts/chat_assistant.txt`

**Step 1: 读取现有 `prompts/chat_assistant.txt` 内容，在末尾追加工具说明**

在文件末尾追加（不替换原有内容）：

```
## 可用工具

你有以下工具可以调用，用于探索用户的数据库和 SQL 编辑器：

**编辑器工具**（了解当前编辑内容）
- get_current_tab：获取当前 Tab 的 SQL 内容和语句列表
- get_tab_sql：获取指定 Tab 的 SQL
- list_tabs：列出所有打开的 Tab
- get_selected_text：获取选中文本
- parse_sql_statements：解析当前 SQL 为语句列表

**数据库结构工具**（探索数据库 Schema）
- list_databases：列出所有数据库
- list_tables：列出指定数据库的表
- get_table_schema：获取表的列定义、索引、外键
- list_views：列出视图
- list_procedures：列出存储过程/函数

**数据查询工具**（查看数据样本）
- get_table_sample：获取表的样本数据（最多 20 行）
- execute_sql：执行只读 SQL（仅 SELECT，最多 100 行）
- get_last_error：获取最近的 SQL 错误信息
- get_query_history：获取最近执行的 SQL 历史

**写回工具**（修改编辑器内容）
- propose_sql_diff：提议 SQL 修改（展示 diff，用户确认后写入）
- switch_tab：切换到指定 Tab

**使用原则：**
- 回答涉及数据库/表/SQL 的问题前，先用工具获取上下文
- 不要一次性调用所有工具，按需探索
- 修改 SQL 时使用 propose_sql_diff，不要直接在回复中给出 SQL 让用户手动粘贴
```

**Step 2: Commit**

```bash
git add prompts/chat_assistant.txt
git commit -m "feat(prompts): add tool catalog description to chat assistant system prompt"
```

---

## 完成后验证

1. `npm run dev` 启动前端，打开 AI 助手
2. 输入："当前 Tab 里有哪些 SQL 语句？" → 预期 Agent 调用 `get_current_tab` 工具，然后回答
3. 输入："users 表有哪些字段？" → 预期 Agent 调用 `get_table_schema` 工具（需先有连接）
4. 输入："帮我优化一下当前 Tab 的 SQL" → 预期 Agent 调用 `get_current_tab` 然后 `propose_sql_diff`
5. 验证工具调用状态 "⚙ 调用工具：xxx..." 在执行时可见

如无 LLM 配置或无连接，以上测试会优雅降级（普通对话或报错）。
