<!-- STATUS: ✅ 已实现 -->
# propose_sql_diff MCP 工具 + Tauri 全局事件桥接 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 助手增加"修改 SQL 编辑器"能力：opencode 通过 MCP 工具 `propose_sql_diff` 提出修改方案，经前端 Tauri 事件桥接，最终在 DiffPanel 中等待用户确认。

**Architecture:** MCP server（Rust/axum）新增 `propose_sql_diff` 工具；接收 opencode 调用后通过 `app_handle.emit("sql-diff-proposal", ...)` 广播 Tauri 事件；前端 `useToolBridge` hook 监听该事件，解析 offset，调用已有的 `queryStore.proposeSqlDiff` 触发 DiffPanel。

**Tech Stack:** Rust/axum 0.7（MCP server）、`tauri::Emitter` trait（事件广播）、TypeScript/React/Zustand（前端）、`@tauri-apps/api` `listen()`（事件订阅）、`sqlParser.ts`（offset 解析，已有）

**Spec:** `docs/superpowers/specs/2026-03-13-propose-sql-diff-mcp-design.md`

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/mcp/mod.rs` | 修改 | 接收 `Arc<AppHandle>`；工具列表新增 `propose_sql_diff`；`call_tool` 新增分支 |
| `src-tauri/src/lib.rs` | 修改 | 传 `app.handle().clone()` 给 `start_mcp_server` |
| `src/hooks/useToolBridge.ts` | 修改（当前为空） | 监听 `sql-diff-proposal` 事件；解析 offset；调用 proposeSqlDiff |
| `src/App.tsx` | 修改 | 调用 `useToolBridge()` 挂载全局监听 |

---

## Chunk 1: Rust 后端 — MCP propose_sql_diff 工具

### Task 1: 更新 mcp/mod.rs

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: 更新文件顶部 use 声明，引入 `Arc` 和 axum `State`**

找到 `src-tauri/src/mcp/mod.rs` 第 1-6 行（当前 imports），替换为：

```rust
use axum::{routing::{get, post}, Router, Json, extract::State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::sync::Arc;
```

- [ ] **Step 2: 在 `tool_definitions()` 函数的 `"tools"` 数组末尾追加 `propose_sql_diff`**

找到 `tool_definitions()` 函数中 `execute_sql` 工具的结束 `}` 之后（约第 106 行 `]` 之前），追加：

```rust
            },
            {
                "name": "propose_sql_diff",
                "description": "Propose a SQL modification to the active editor tab. Shows a diff preview that the user must confirm before it takes effect. Always call this after reading the current SQL to ensure 'original' matches exactly.",
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

**注意：** 需要把 `execute_sql` 块结尾的 `}` 改为 `},`（加逗号）再追加，并确保新增的工具对象用 `}` 正确闭合（共两层：`inputSchema` 的 `}` + tool 对象自身的 `}`）。

- [ ] **Step 3: 新增 `DiffProposalPayload` 结构体**

在 `fn tool_definitions()` 函数定义之前添加：

```rust
#[derive(Serialize, Clone)]
struct DiffProposalPayload {
    original: String,
    modified: String,
    reason: String,
}
```

- [ ] **Step 4: 更新 `call_tool` 函数签名，接收 `Arc<AppHandle>`**

找到当前函数签名：
```rust
async fn call_tool(name: &str, args: Value) -> crate::AppResult<String> {
```

替换为：
```rust
async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value) -> crate::AppResult<String> {
```

- [ ] **Step 5: 在 `call_tool` 的 `match` 分支末尾（`_ => Err(...)` 之前）追加 `propose_sql_diff` 分支**

找到 `_ => Err(crate::AppError::Other(format!("Unknown tool: {}", name))),` 这行，在它之前插入：

```rust
        "propose_sql_diff" => {
            use tauri::Emitter;
            let original = args["original"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing original".into()))?
                .to_string();
            let modified = args["modified"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing modified".into()))?
                .to_string();
            let reason = args["reason"].as_str()
                .unwrap_or("")
                .to_string();
            handle.emit("sql-diff-proposal", DiffProposalPayload { original, modified, reason })
                .map_err(|e| crate::AppError::Other(e.to_string()))?;
            Ok("diff proposed, waiting for user confirmation".to_string())
        }
```

- [ ] **Step 6: 更新 `handle_mcp_sse` 和 `handle_mcp` 函数——引入 axum State**

找到：
```rust
async fn handle_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_mcp(Json(req): Json<JsonRpcRequest>) -> Json<JsonRpcResponse> {
```

替换为：
```rust
async fn handle_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_mcp(
    State(handle): State<Arc<tauri::AppHandle>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
```

- [ ] **Step 7: 在 `handle_mcp` 函数体内的 `call_tool` 调用处传入 `handle`**

找到：
```rust
            match call_tool(&name, args).await {
```

替换为：
```rust
            match call_tool(Arc::clone(&handle), &name, args).await {
```

- [ ] **Step 8: 更新 `start_mcp_server` 函数——接收 AppHandle 并注入 router state**

找到当前签名：
```rust
pub async fn start_mcp_server() -> crate::AppResult<u16> {
```

替换为：
```rust
pub async fn start_mcp_server(app_handle: tauri::AppHandle) -> crate::AppResult<u16> {
```

找到：
```rust
    let app = Router::new()
        .route("/mcp", get(handle_mcp_sse))
        .route("/mcp", post(handle_mcp));
```

替换为：
```rust
    let app = Router::new()
        .route("/mcp", get(handle_mcp_sse))
        .route("/mcp", post(handle_mcp))
        .with_state(Arc::new(app_handle));
```

- [ ] **Step 9: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

期望：无 `error` 输出（warning 可忽略）

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): add propose_sql_diff tool with Tauri event bridge"
```

---

### Task 2: 更新 lib.rs — 传入 AppHandle

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 更新 `start_mcp_server` 调用，传入 AppHandle**

找到（约第 29-31 行）：
```rust
            let mcp_port = tauri::async_runtime::block_on(
                crate::mcp::start_mcp_server()
            ).expect("Failed to start MCP server");
```

替换为：
```rust
            let mcp_port = tauri::async_runtime::block_on(
                crate::mcp::start_mcp_server(app.handle().clone())
            ).expect("Failed to start MCP server");
```

- [ ] **Step 2: cargo check 确认全量编译通过**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

期望：无 `error` 输出

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(mcp): pass AppHandle to start_mcp_server"
```

---

## Chunk 2: TypeScript 前端 — 事件监听 + 挂载

### Task 3: 实现 useToolBridge.ts

**Files:**
- Modify: `src/hooks/useToolBridge.ts`（当前内容为 `export {};`）

- [ ] **Step 1: 完整替换 `src/hooks/useToolBridge.ts` 内容**

```typescript
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryStore } from '../store/queryStore';
import { parseStatements } from '../utils/sqlParser';

interface DiffProposalPayload {
  original: string;
  modified: string;
  reason: string;
}

/**
 * 挂载全局 Tauri 事件监听器：
 * - 监听 'sql-diff-proposal' 事件（由 MCP server propose_sql_diff 工具触发）
 * - 在所有打开的 Tab 中查找 original 文本，解析 offset
 * - 调用 queryStore.proposeSqlDiff 展示 DiffPanel
 *
 * 需在 App.tsx 根组件中调用，确保全局唯一且生命周期与应用一致。
 */
export function useToolBridge() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<DiffProposalPayload>('sql-diff-proposal', (event) => {
      const { original, modified, reason } = event.payload;
      const { sqlContent, proposeSqlDiff } = useQueryStore.getState();

      // 全量扫描所有 Tab，找到第一个包含 original 文本的 Tab
      // （queryStore.activeTabId 为静态初始值，不可靠，故遍历所有条目）
      for (const [tabId, full] of Object.entries(sqlContent)) {
        const stmts = parseStatements(full);
        const match = stmts.find(s => s.text.trim() === original.trim());
        if (match) {
          proposeSqlDiff({
            original,
            modified,
            reason,
            tabId,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
          });
          return;
        }
      }

      console.warn(
        '[useToolBridge] propose_sql_diff: original not found in any tab.',
        'original:', original.slice(0, 80)
      );
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []); // 仅挂载一次，无依赖
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useToolBridge.ts
git commit -m "feat(hooks): implement useToolBridge — listen sql-diff-proposal and resolve offset"
```

---

### Task 4: 在 App.tsx 挂载 useToolBridge

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 在 `src/App.tsx` 顶部 import 区末尾追加**

找到最后一个 import 行（约第 12 行 `import { QueryContext } from './types';`），在其后追加：

```typescript
import { useToolBridge } from './hooks/useToolBridge';
```

- [ ] **Step 2: 在 App 组件函数体顶部（其他 hook 调用之后）添加**

找到 `const { results, error: queryError } = useQueryStore();`（约第 79 行），在其后追加：

```typescript
  // 全局挂载 MCP propose_sql_diff 事件监听器
  useToolBridge();
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): mount useToolBridge for global sql-diff-proposal listener"
```

---

## Chunk 3: 验证

### Task 5: 端到端验证

- [ ] **Step 1: 启动开发服务器**

```bash
npm run tauri:dev
```

期望：应用正常启动，控制台无 `error` 报错

- [ ] **Step 2: 验证 MCP 工具列表包含 propose_sql_diff**

浏览器 DevTools Console 或直接用 curl 测试 MCP server：

```bash
curl -s -X POST http://127.0.0.1:19876/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | python -m json.tool
```

期望：响应中 `tools` 数组包含 `"name": "propose_sql_diff"` 的条目

- [ ] **Step 3: 在 SQL 编辑器中输入测试 SQL**

在 Query 编辑器中输入：
```sql
SELECT * FROM users WHERE active = 1
```

- [ ] **Step 4: 手动触发 propose_sql_diff（通过 curl 调用 MCP）**

```bash
curl -s -X POST http://127.0.0.1:19876/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "propose_sql_diff",
      "arguments": {
        "original": "SELECT * FROM users WHERE active = 1",
        "modified": "SELECT * FROM users WHERE active = 1\nORDER BY created_at DESC",
        "reason": "测试：添加排序"
      }
    }
  }' | python -m json.tool
```

期望 MCP 响应：`{ "content": [{ "type": "text", "text": "diff proposed, waiting for user confirmation" }] }`

- [ ] **Step 5: 验证 DiffPanel 出现**

期望：Assistant 面板底部出现 DiffPanel，显示：
- 红色行：`- SELECT * FROM users WHERE active = 1`
- 绿色行：`+ SELECT * FROM users WHERE active = 1`
- 绿色行：`+ ORDER BY created_at DESC`
- 原因文字："测试：添加排序"

- [ ] **Step 6: 验证"应用"按钮**

点击"应用"按钮，期望：
- Monaco 编辑器内容更新为 `SELECT * FROM users WHERE active = 1\nORDER BY created_at DESC`
- DiffPanel 消失

- [ ] **Step 7: 验证"取消"按钮（重新触发一次 curl，再取消）**

重新执行 Step 4 的 curl 命令，DiffPanel 再次出现后点击"取消"：
- DiffPanel 消失
- 编辑器内容不变

- [ ] **Step 8: 验证 original 不匹配时的静默处理**

```bash
curl -s -X POST http://127.0.0.1:19876/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "propose_sql_diff",
      "arguments": {
        "original": "SELECT * FROM nonexistent_table",
        "modified": "SELECT id FROM nonexistent_table",
        "reason": "不存在的语句"
      }
    }
  }'
```

期望：
- MCP 仍返回成功响应
- DiffPanel 不出现
- DevTools Console 显示 `[useToolBridge] propose_sql_diff: original not found in any tab.`

- [ ] **Step 9: 也需要更新废弃标注**

在 `docs/plans/2026-03-12-agent-phase2-tool-loop.md` 文件顶部追加废弃说明：

在文件第 1 行 `# Agent Phase 2 — Tool Loop 实现计划` 标题下方插入：

```markdown
> ⚠️ **部分废弃（2026-03-13）：**
> - Tasks 1-5（Rust 侧）已实现，见相关提交历史
> - Tasks 6-10（前端 TypeScript Agent Loop / toolCatalog.ts / agentLoop.ts）**不执行**
> - 原因：ACP/opencode 架构已接管 Agent Loop 编排，前端无需自建工具循环
> - `propose_sql_diff` 写回功能由独立计划实现：`docs/superpowers/plans/2026-03-13-propose-sql-diff-mcp.md`
```

- [ ] **Step 10: 最终 Commit**

```bash
git add docs/plans/2026-03-12-agent-phase2-tool-loop.md
git commit -m "docs(plans): mark agent-phase2 Tasks 6-10 as deprecated, replaced by ACP architecture"
```

---

## 验收标准

- [ ] `cd src-tauri && cargo check` — 无 error
- [ ] `npx tsc --noEmit` — 无 error
- [ ] MCP `tools/list` 返回包含 `propose_sql_diff` 的工具列表
- [ ] curl 调用 `propose_sql_diff` → MCP 返回成功 + DiffPanel 出现
- [ ] 点击"应用" → Monaco 编辑器内容更新，DiffPanel 消失
- [ ] 点击"取消" → 编辑器不变，DiffPanel 消失
- [ ] original 不存在时 → DiffPanel 不出现，console.warn 可见，无 JS 报错
