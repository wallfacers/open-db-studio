# 对话式 SQL 编辑器修改 — 设计文档

**日期：** 2026-03-13
**状态：** 已批准，待实现
**范围：** MVP — 跑通 SQL 编辑器对话式修改，不含 ERD

---

## 背景

用户希望通过 AI 助手对话框直接修改 SQL 编辑器中的内容（如"给这段 SQL 加 LIMIT 100"、"优化这个查询的 WHERE 条件"），AI 提出 diff，用户确认后写入编辑器。

### 现有基础（无需修改）

| 组件 | 状态 |
|------|------|
| `propose_sql_diff` MCP 工具 | ✅ 已实现（`src-tauri/src/mcp/mod.rs`） |
| `DiffPanel` 组件 | ✅ 已实现（`src/components/Assistant/DiffPanel.tsx`） |
| `useToolBridge` 事件监听 | ✅ 已挂载（`src/hooks/useToolBridge.ts`） |
| ACP/opencode 集成 | ✅ 已实现（`src-tauri/src/acp/`） |
| 每条 prompt 注入当前 tab SQL | ✅ 已实现（`commands.rs: ai_chat_acp_inner`） |

### 问题

opencode 没有 SQL 编辑器相关的 instructions，遇到"修改 SQL"需求时默认直接在对话里输出文本，不调用 `propose_sql_diff` 工具 → DiffPanel 永远不会触发。

---

## 解决方案

### 组件 1：`AGENTS.md`（opencode 指令文件）

opencode 启动时自动读取 cwd 下的 `AGENTS.md`，作为持久 system instructions。

**写入时机：** 应用启动时（`src-tauri/src/lib.rs` setup 阶段），写入到 opencode working directory（`%APPDATA%/open-db-studio/AGENTS.md`）。

**内容：**

```markdown
你是 open-db-studio SQL 编辑器 AI 助手。

## 核心规则

- **修改 SQL 时，必须调用 `propose_sql_diff` 工具**，不得在对话中直接输出修改后的 SQL。
- `original` 字段必须与编辑器中的 SQL 语句完全一致（逐字符匹配，包括换行和空格）。
- `reason` 字段用中文简要说明修改原因（展示给用户）。
- 如需确认当前 SQL，调用 `get_editor_sql` 工具获取最新内容。

## 工作流

1. 用户提出修改需求 → 从 prompt 中读取"当前编辑器 SQL"或调用 `get_editor_sql`
2. 确定需要修改的语句及修改内容
3. 调用 `propose_sql_diff`，等待用户确认
4. 向用户说明修改内容（在工具调用之后）

## 数据库工具

- 调用数据库工具（`list_tables`、`get_table_schema` 等）时，使用 prompt 中注明的 connection_id。
- `execute_sql` 仅限 SELECT/WITH/SHOW，最多返回 100 行。
```

---

### 组件 2：`get_editor_sql` MCP 工具

允许 AI 在 agent loop 中按需读取编辑器当前 SQL，而不依赖 prompt 文本（应对多轮对话、空编辑器等边缘情况）。

**数据流：**

```
ai_chat_acp 调用时
  tab_sql → AppState.current_editor_sql（写入）

MCP get_editor_sql 被调用时
  AppState.current_editor_sql（读取）→ 返回 SQL 文本
```

**工具定义（追加到 `tool_definitions()`）：**

```json
{
  "name": "get_editor_sql",
  "description": "Get the current SQL content from the active editor tab. Returns the full SQL text. Use this when you need to read the editor content during a conversation.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**`AppState` 变更（`src-tauri/src/state.rs`）：**

```rust
pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
```

初始化为 `Mutex::new(None)`。

**写入（`commands.rs: ai_chat_acp_inner`）：**

```rust
// 写入共享状态，供 MCP get_editor_sql 读取
*state.current_editor_sql.lock().await = tab_sql.clone();
```

**读取（`mcp/mod.rs: call_tool`）：**

```rust
"get_editor_sql" => {
    // state 通过 app_handle.state() 获取
    let app_state = handle.state::<crate::AppState>();
    let sql = app_state.current_editor_sql.lock().await.clone();
    match sql {
        Some(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok("(编辑器为空)".to_string()),
    }
}
```

---

## 端到端流程

```
用户："给这段 SQL 加 LIMIT 100"

1. Frontend: sendAgentChatStream → ai_chat_acp(prompt, tab_sql, connectionId)
2. Rust: tab_sql → AppState.current_editor_sql（写入）
3. Rust: prompt 前追加 "当前编辑器 SQL: ..."
4. Rust: → opencode ACP session（读取 AGENTS.md instructions）
5. opencode: 读取 prompt 中的 SQL，决定调用 propose_sql_diff
6. opencode → MCP POST /mcp tools/call propose_sql_diff
7. MCP: emit Tauri 事件 "sql-diff-proposal" { original, modified, reason }
8. Frontend: useToolBridge 接收事件 → 在对应 Tab 查找 original → proposeSqlDiff
9. DiffPanel 展示 diff（original vs modified + reason）
10. 用户点 "Apply" → Monaco 编辑器更新对应语句
```

---

## 边缘情况

| 场景 | 处理方式 |
|------|----------|
| `original` 不完全匹配 | `useToolBridge` 打印警告，DiffPanel 不触发；AI 在下一轮可调用 `get_editor_sql` 重读 |
| 编辑器为空 | `get_editor_sql` 返回 `(编辑器为空)`；AI 应提示用户先输入 SQL |
| 用户拒绝 diff | `cancelDiff` 清空 pendingDiff；AI 收到 "diff proposed, waiting for user confirmation" 后可继续对话 |
| 多语句 Tab | `parseStatements` 按分号分割，`useToolBridge` 逐句匹配 `original` |

---

## 不在本次范围

- ERD 对话式修改（后续独立设计）
- `propose_sql_diff` 的 apply 后自动触发 re-execution
- 多 Tab 批量修改
- `get_selected_text` 工具（仅修改选中部分）

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src-tauri/src/state.rs` | 修改 | 新增 `current_editor_sql: Mutex<Option<String>>` |
| `src-tauri/src/lib.rs` | 修改 | setup 阶段写入 `AGENTS.md` |
| `src-tauri/src/commands.rs` | 修改 | `ai_chat_acp_inner` 写入 `current_editor_sql` |
| `src-tauri/src/mcp/mod.rs` | 修改 | 新增 `get_editor_sql` 工具定义 + 实现 |
