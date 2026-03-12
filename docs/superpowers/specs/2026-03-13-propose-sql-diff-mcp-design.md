# propose_sql_diff — MCP 工具 + Tauri 全局事件桥接 设计文档

**日期：** 2026-03-13
**状态：** 已批准
**背景：** ACP/opencode 架构下，opencode 管理 Agent Loop，MCP server 负责 DB 工具。需为 AI 助手增加"修改 SQL 编辑器内容"能力，让 opencode 通过 MCP 工具提出修改方案，经用户确认后写入编辑器。

---

## 问题

ACP 架构中，opencode 原生支持 DB 读取工具（list_tables、get_table_schema 等），但没有路径触达前端的 `queryStore.proposeSqlDiff`——该函数负责展示 DiffPanel 并等待用户确认。需要一座桥梁连接 MCP server（Rust HTTP）与前端 Zustand store。

---

## 解决方案：MCP 工具 + Tauri 全局事件

```
opencode → POST /mcp tools/call propose_sql_diff
                        { original, modified, reason }
                              ↓
                    mcp/mod.rs call_tool()
                    app_handle.emit("sql-diff-proposal", payload)
                              ↓
                    useToolBridge (useEffect listener, App.tsx 挂载)
                    parseStatements(activeTabSql) → 精确定位 offset
                    queryStore.proposeSqlDiff({ ... })
                              ↓
                    DiffPanel 渲染（已有实现）
                    用户点击"应用"→ Monaco 编辑器内容更新
```

### 为何选择 Tauri 全局事件

| 方案 | 说明 | 问题 |
|------|------|------|
| 文本解析（ContentChunk 扫描） | System prompt 指导 opencode 输出结构化文本 | LLM 遵从率不稳定；原始文本偏差导致 offset 匹配失败 |
| Streaming Channel 桥接 | MCP server → AppState.active_event_tx → 新 StreamEvent 变体 | MCP（长生命周期）与 channel（per-request）生命周期不匹配；需新增 StreamEvent 变体 |
| **Tauri 全局事件（采用）** | `app_handle.emit()` 广播；前端 `listen()` 订阅 | 完全解耦；AppHandle 一次注入；流式对话结束后事件仍可触达 |

---

## 架构

### 组件与职责

| 组件 | 位置 | 职责 |
|------|------|------|
| MCP server | `src-tauri/src/mcp/mod.rs` | 暴露 `propose_sql_diff` 工具；接收 opencode 调用；emit Tauri 事件 |
| Tauri AppHandle | `src-tauri/src/lib.rs` | 启动时注入 MCP server；作为事件广播出口 |
| useToolBridge | `src/hooks/useToolBridge.ts` | 监听 `sql-diff-proposal` 事件；解析 offset；调用 proposeSqlDiff |
| App.tsx | `src/App.tsx` | 调用 `useToolBridge()` 挂载全局监听器 |
| queryStore | `src/store/queryStore.ts` | 现有 `proposeSqlDiff`（不变） |
| DiffPanel | `src/components/Assistant/DiffPanel.tsx` | 现有 diff 展示 + 确认/取消（不变） |

### MCP 工具 Schema

```json
{
  "name": "propose_sql_diff",
  "description": "Propose a SQL modification to the active editor tab. Shows a diff preview that the user must confirm before it takes effect. Use get_current_sql first to get the exact original statement text.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "original": {
        "type": "string",
        "description": "The exact original SQL statement text as it appears in the editor (must match precisely)"
      },
      "modified": {
        "type": "string",
        "description": "The new SQL statement text after modification"
      },
      "reason": {
        "type": "string",
        "description": "Brief explanation of why this change is being proposed (shown to user)"
      }
    },
    "required": ["original", "modified", "reason"]
  }
}
```

> **注：** opencode 在调用前应先通过编辑器上下文（注入到 prompt 的 tabSql）确认 original 的精确文本。

### Tauri 事件 Payload

```typescript
interface DiffProposalPayload {
  original: string;
  modified: string;
  reason: string;
}
// 事件名：'sql-diff-proposal'
```

---

## 数据流详述

### Rust 侧（MCP → emit）

**新签名：**
```rust
pub async fn start_mcp_server(app_handle: tauri::AppHandle) -> crate::AppResult<u16>
```

1. `start_mcp_server` 接收 `AppHandle`，包装为 `Arc<tauri::AppHandle>` 传入 axum router state
2. 通过 `.with_state(Arc::new(app_handle))` 注入到 axum Router；`handle_mcp` 函数签名更新为：
   ```rust
   async fn handle_mcp(
       State(handle): State<Arc<tauri::AppHandle>>,
       Json(req): Json<JsonRpcRequest>,
   ) -> Json<JsonRpcResponse>
   ```
3. `handle_mcp` 将 `Arc<AppHandle>` 透传给 `call_tool(Arc::clone(&handle), name, args)`（call_tool 签名：`async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value) -> AppResult<String>`）
4. `call_tool` 的 `propose_sql_diff` 分支：
   ```rust
   use tauri::Emitter;
   handle.emit("sql-diff-proposal", DiffProposalPayload { original, modified, reason })
         .map_err(|e| AppError::Other(e.to_string()))?;
   Ok("diff proposed".to_string())
   ```
5. 返回 MCP 成功响应（`{ content: [{ type: "text", text: "diff proposed" }] }`）

> **注1：** `tauri::AppHandle::emit` 在 `tauri = { version = "2", features = [] }` 下即可用，通过 `use tauri::Emitter` 引入 trait，无需额外 feature flag。
> **注2：** `tauri::Error` 无 `From` 转换到 `AppError`，需显式 `.map_err(|e| AppError::Other(e.to_string()))`。
> **注3：** `propose_sql_diff` 工具 JSON Schema 需添加到 `tool_definitions()` 函数的 `"tools"` 数组中。

### 前端侧（listen → proposeSqlDiff）

**前置说明：**
- `queryStore.activeTabId` 当前为静态初始值（`'query-1'`），不随用户切 Tab 更新——这是已知的 pre-existing 状态
- Monaco `onChange` 写的是 `queryStore.setSql(activeTab, val)`，所以 `queryStore.sqlContent` 中各 tabId 的 SQL 是准确的
- `aiStore.sendAgentChatStream` 注入的 `tabSql` 同样读自 `queryStore.sqlContent[queryStore.activeTabId]`，两侧行为一致

由于 `activeTabId` 不可靠，`useToolBridge` 采用**全量扫描**策略：遍历所有 `sqlContent` 条目，找到第一个包含 `original` 文本的 tab。

1. `useToolBridge()` 在 `useEffect` 中调用 `listen("sql-diff-proposal", handler)`
2. handler 执行：
   ```
   sqlContent ← queryStore.getState().sqlContent   // Record<tabId, string>
   for each [tabId, full] in Object.entries(sqlContent):
     stmts ← parseStatements(full)
     match ← stmts.find(s => s.text.trim() === original.trim())
     if match:
       queryStore.getState().proposeSqlDiff({
         original, modified, reason,
         tabId,
         startOffset: match.startOffset,
         endOffset: match.endOffset,
       })
       return
   // 所有 tab 均未找到
   console.warn("propose_sql_diff: original not found in any tab")
   ```
3. cleanup：`useEffect` 返回 `() => unlisten()` 函数，React 严格模式安全

---

## 变更文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/mcp/mod.rs` | 修改 | 接收 `Arc<AppHandle>`；工具列表新增 `propose_sql_diff`；`call_tool` 新增分支 |
| `src-tauri/src/lib.rs` | 修改 | 传 `app.handle().clone()` 给 `start_mcp_server` |
| `src/hooks/useToolBridge.ts` | 修改（当前为空） | 实现 Tauri 事件监听 + offset 解析 |
| `src/App.tsx` | 修改 | 调用 `useToolBridge()` |

**不变：** `queryStore.ts`、`DiffPanel.tsx`、`aiStore.ts`、`AppState`、`error.rs`

---

## 边界情况与错误处理

| 场景 | 处理 |
|------|------|
| `original` 在任何 tab 中均找不到 | `console.warn` + 提前返回；MCP 仍返回成功（opencode 不感知）；用户看不到 DiffPanel 出现但对话继续——已接受的 UX 权衡 |
| 多条相同语句 | 取 `parseStatements` 结果中的第一条匹配 |
| 监听器重复挂载（React 严格模式） | `useEffect` 返回 `() => unlisten()` cleanup |
| 已有未确认的 diff 时新 diff 到达 | `proposeSqlDiff` 直接覆盖 `pendingDiff`（现有行为） |
| MCP emit 失败 | Tauri emit 返回 `Result`，用 `?` 传播错误，MCP 返回 JSON-RPC error |

---

## 不在本次范围内

- `get_current_sql` MCP 工具（opencode 通过 prompt 注入的 `tabSql` 已知当前 SQL）
- 多 Tab 感知（opencode 始终操作 activeTabId 的 SQL）
- DiffPanel 的 UI 改动
- Agent Phase 2 中的 `toolCatalog.ts` / `agentLoop.ts`（已废弃，被 ACP 架构取代）
