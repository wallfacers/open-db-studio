<!-- STATUS: ✅ 已实现 -->
# 对话式 SQL 编辑器修改 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 助手能通过 `propose_sql_diff` 工具对话式修改编辑器 SQL，用户确认后写入 Monaco 编辑器。

**Architecture:** 在 AppState 中新增 `current_editor_sql` 共享字段，`ai_chat_acp` 调用时写入当前 tab SQL；MCP server 新增 `get_editor_sql` 工具读取该字段；应用启动时写入 `AGENTS.md` 指令文件，让 opencode 知道使用 `propose_sql_diff` 工具而非直接输出文本。

**Tech Stack:** Rust（tokio::sync::Mutex、axum MCP server、Tauri AppState）

**Spec:** `docs/superpowers/specs/2026-03-13-conversational-sql-editor-design.md`

---

## Chunk 1: AppState 新增 current_editor_sql

### Task 1: state.rs — 新增共享字段

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 在 `AppState` 结构体中新增字段**

打开 `src-tauri/src/state.rs`，在 `acp_session` 字段后追加：

```rust
/// 最近一次 ai_chat_acp 传入的编辑器 SQL（供 MCP get_editor_sql 工具读取）
/// MVP：全局单一字段，仅支持单一活跃 Tab 场景
pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
```

完整结构体改后：

```rust
pub struct AppState {
    pub mcp_port: u16,
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
}
```

- [ ] **Step 2: 更新 lib.rs 中 AppState 的初始化**

打开 `src-tauri/src/lib.rs`，找到 `app.manage(crate::state::AppState { ... })` 块（约第 34 行），添加新字段：

```rust
app.manage(crate::state::AppState {
    mcp_port,
    acp_session: tokio::sync::Mutex::new(None),
    current_editor_sql: tokio::sync::Mutex::new(None),
});
```

- [ ] **Step 3: cargo check 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 无错误（可能有 unused field 警告，正常）

- [ ] **Step 4: commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(state): add current_editor_sql shared field to AppState"
```

---

### Task 2: lib.rs — 启动时写入 AGENTS.md

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 setup 闭包中添加 AGENTS.md 写入逻辑**

在 `src-tauri/src/lib.rs` 的 `setup` 闭包里，**必须在 `crate::db::init(...)` 调用之后**（`db::init` 负责创建 `%APPDATA%/open-db-studio/` 目录），`crate::mcp::start_mcp_server(...)` 调用**之前**，插入以下代码：

```rust
// 写入 AGENTS.md 到 opencode 工作目录，指导 AI 使用工具
{
    use std::path::PathBuf;
    let agents_dir = PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into())
    ).join("open-db-studio");
    std::fs::create_dir_all(&agents_dir).ok();
    let agents_path = agents_dir.join("AGENTS.md");
    let agents_content = include_str!("../assets/AGENTS.md");
    if let Err(e) = std::fs::write(&agents_path, agents_content) {
        log::error!("Failed to write AGENTS.md: {}", e);
        // 降级：继续启动，AI 使用 opencode 默认行为
    } else {
        log::info!("Wrote AGENTS.md to {:?}", agents_path);
    }
}
```

- [ ] **Step 2: 创建 assets 目录和 AGENTS.md 文件**

创建文件 `src-tauri/assets/AGENTS.md`，内容如下：

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

- [ ] **Step 3: 在 Cargo.toml 中确认 assets 可被 include_str! 访问**

`include_str!` 路径相对于 `src-tauri/src/lib.rs`，因此 `"../assets/AGENTS.md"` 指向 `src-tauri/assets/AGENTS.md`。无需额外配置。

- [ ] **Step 4: cargo check 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 无错误

- [ ] **Step 5: commit**

```bash
git add src-tauri/src/lib.rs src-tauri/assets/AGENTS.md
git commit -m "feat(acp): write AGENTS.md on startup to guide AI tool usage"
```

---

## Chunk 2: commands.rs 写入 + MCP get_editor_sql 工具

### Task 3: commands.rs — ai_chat_acp_inner 写入 current_editor_sql

**Files:**
- Modify: `src-tauri/src/commands.rs`（`ai_chat_acp_inner` 函数，约第 854 行）

- [ ] **Step 1: 在 ai_chat_acp_inner 开头写入共享状态**

找到 `async fn ai_chat_acp_inner(` 函数。在函数体内，`// 1. 获取指定配置` 注释**之前**（即函数体最开头的 `use` 声明之后），插入以下代码：

**原因**：写入必须在 opencode agent loop 启动之前完成，这样 opencode 在执行过程中调用 `get_editor_sql` 工具时，读到的就是本次对话对应的 SQL。

```rust
// 写入当前编辑器 SQL 到共享状态（供 MCP get_editor_sql 工具读取）
// 必须在 opencode session 启动前写入
*state.current_editor_sql.lock().await = tab_sql.clone();
```

改后该区域看起来像：

```rust
async fn ai_chat_acp_inner(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;
    use crate::llm::StreamEvent;

    // 写入当前编辑器 SQL 到共享状态（供 MCP get_editor_sql 工具读取）
    *state.current_editor_sql.lock().await = tab_sql.clone();

    // 1. 获取指定配置（未指定则用默认）
    ...
```

- [ ] **Step 2: cargo check 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 无错误

- [ ] **Step 3: commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(acp): store tab_sql in AppState.current_editor_sql on each chat"
```

---

### Task 4: mcp/mod.rs — 新增 get_editor_sql 工具

**前置条件：Task 1 必须已完成**（`AppState.current_editor_sql` 字段已存在，否则此步编译失败）

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: 在 tool_definitions() 中追加工具定义**

找到 `fn tool_definitions() -> Value` 函数，在 `propose_sql_diff` 工具定义的 `}` 后、整个数组 `]` 之前，追加：

```json
{
    "name": "get_editor_sql",
    "description": "Get the current SQL content from the active editor tab. Returns the full SQL text as a plain string. Use this when you need to read the editor content during a multi-step agent loop.",
    "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
    }
}
```

代码形式：

```rust
json!({
    "name": "get_editor_sql",
    "description": "Get the current SQL content from the active editor tab. Returns the full SQL text as a plain string. Use this when you need to read the editor content during a multi-step agent loop.",
    "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
    }
}),
```

- [ ] **Step 2: 在 call_tool 函数中添加 get_editor_sql 实现**

找到 `async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value) -> crate::AppResult<String>` 函数，在 `"propose_sql_diff" => { ... }` 分支之后、`_ => Err(...)` 之前，添加：

**注意**：`handle.state()` 需要 `tauri::Manager` trait 在作用域内，参考同文件 `propose_sql_diff` 分支内 `use tauri::Emitter;` 的写法，在此分支内也需要加 `use tauri::Manager;`。

```rust
"get_editor_sql" => {
    use tauri::Manager;
    let app_state = handle.state::<crate::AppState>();
    let sql = app_state.current_editor_sql.lock().await.clone();
    match sql {
        Some(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok("(编辑器为空)".to_string()),
    }
}
```

- [ ] **Step 3: cargo check 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 无错误

- [ ] **Step 4: commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): add get_editor_sql tool to read current editor SQL"
```

---

## Chunk 3: 端到端验证

### Task 5: 手动验证完整流程

**无代码修改，纯验证步骤。**

- [ ] **Step 1: 启动应用，确认 AGENTS.md 已写入**

```bash
# Windows
ls %APPDATA%/open-db-studio/AGENTS.md
```

Expected: 文件存在，内容与 `src-tauri/assets/AGENTS.md` 一致

- [ ] **Step 2: 打开 SQL 编辑器，输入测试 SQL**

在编辑器 Tab 中输入：

```sql
SELECT * FROM users
```

- [ ] **Step 3: 在 AI 助手中发送修改请求**

输入：`给这段 SQL 加上 WHERE active = 1 的过滤条件`

- [ ] **Step 4: 观察 DiffPanel 是否弹出**

Expected:
- AI 助手显示"正在调用工具..."状态
- DiffPanel 在对话框下方出现，展示：
  - original: `SELECT * FROM users`
  - modified: `SELECT * FROM users WHERE active = 1`
  - reason: 中文说明

- [ ] **Step 5: 点击 Apply，确认编辑器 SQL 已更新**

Expected: Monaco 编辑器内容变为 `SELECT * FROM users WHERE active = 1`

- [ ] **Step 6: 验证 get_editor_sql 工具（多轮对话）**

继续在 AI 助手中输入：`再加一个 ORDER BY id DESC`

Expected:
- opencode 可能先调用 `get_editor_sql` 确认当前 SQL
- 然后调用 `propose_sql_diff` 提出新的修改
- DiffPanel 再次弹出

- [ ] **Step 7: 验证降级场景（编辑器为空）**

清空编辑器，在 AI 助手中输入：`帮我写一个查询用户表的 SQL`

Expected: AI 直接给出建议 SQL（无 DiffPanel，因为原文本为空）

---

## 调试提示

**如果 DiffPanel 没有弹出：**

1. 检查 opencode 日志：`%APPDATA%/open-db-studio/` 目录下是否有 opencode 日志文件
2. 确认 AGENTS.md 已正确写入（Step 1 验证）
3. 检查 `original` 字段是否与编辑器内容完全一致（大小写、空格）——可在浏览器控制台看 `[useToolBridge]` 的警告日志

**如果 cargo check 报 AppState 字段缺失：**

确认 `lib.rs` 的 `app.manage(...)` 已添加 `current_editor_sql: tokio::sync::Mutex::new(None)`。
