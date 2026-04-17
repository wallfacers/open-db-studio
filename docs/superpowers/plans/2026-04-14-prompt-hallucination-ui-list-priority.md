# 提示词幻觉修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ui_list` 焊为"首选发现入口"，把 `list_tasks` 降级为"仅后台运行时任务"，消除用户说"当前 X 卡片"时错调 `list_tasks` 的幻觉。

**Architecture:** 两层描述双写——prompt 层（中文触发词映射）+ MCP 工具 description 层（英文通用消歧）。纯文本改动，不触 API / 参数 / 行为。

**Tech Stack:** `prompts/chat_assistant.txt`（运行时加载）、`src-tauri/src/mcp/mod.rs`（Rust 工具注册）。

**Spec:** [`docs/superpowers/specs/2026-04-14-prompt-hallucination-ui-list-priority-design.md`](../specs/2026-04-14-prompt-hallucination-ui-list-priority-design.md)

---

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `prompts/chat_assistant.txt` | 修改 L22 + L184 | ui_list 升级 / list_tasks 降级 |
| `src-tauri/src/mcp/mod.rs` | 修改 ~L145 + ~L219 | MCP 工具 description 双写 |

## 测试策略说明

本计划不含单元测试步骤——所有改动均为**工具描述字符串**，无可断言的运行时行为变化。验证靠：

1. **静态校验**：`cargo check`（Rust 编译）、`npx tsc --noEmit`（TypeScript，虽然未触及前端但 CLAUDE.md 统一要求）。
2. **手动回归提示词**：spec 第 "验证" 节列出的 6 条 prompt（3 条正向、3 条反向）。
3. **grep 验证**：每步后用 Grep 确认新文本落地、旧文本消除。

---

## Task 1: Prompt 层 — `ui_list` 升级为首选入口

**Files:**
- Modify: `prompts/chat_assistant.txt:22`

- [ ] **Step 1: 读取文件，确认当前 L22 内容**

Run: 使用 `Read` 工具读取 `prompts/chat_assistant.txt` 的 L20-24。

Expected: L22 内容为：
```
- **`ui_list(filter?)`** — discover open objects. Filter by `type` / `keyword` / `connectionId` / `database`
```

- [ ] **Step 2: 应用 Edit**

使用 `Edit` 工具：

old_string:
```
- **`ui_list(filter?)`** — discover open objects. Filter by `type` / `keyword` / `connectionId` / `database`
```

new_string:
```
- **`ui_list(filter?)`** — **首选发现入口**：用户提"当前 / 打开的 / 这个 / 正在编辑的" UI 元素时先调用。Filter: `type` / `keyword` / `connectionId` / `database`
```

- [ ] **Step 3: Grep 验证**

Run: `Grep` with pattern `首选发现入口` path `prompts/chat_assistant.txt`
Expected: 命中 1 行（L22）。

Run: `Grep` with pattern `discover open objects` path `prompts/chat_assistant.txt`
Expected: 0 匹配（旧文本已清除）。

---

## Task 2: Prompt 层 — `list_tasks` 降级 + 反向排除

**Files:**
- Modify: `prompts/chat_assistant.txt:184`

- [ ] **Step 1: 读取文件，确认当前 L184 内容**

Run: 使用 `Read` 工具读取 `prompts/chat_assistant.txt` 的 L182-186。

Expected: L184 内容为：
```
- `list_tasks(status?, limit?=20, max=100)` — status ∈ `running` / `completed` / `failed` / `cancelled` / `pending` (omit for all)
```

- [ ] **Step 2: 应用 Edit**

使用 `Edit` 工具：

old_string:
```
- `list_tasks(status?, limit?=20, max=100)` — status ∈ `running` / `completed` / `failed` / `cancelled` / `pending` (omit for all)
```

new_string:
```
- `list_tasks(status?, limit?=20, max=100)` — **仅**后台 import/export/graph 运行时任务；**不含** UI 卡片（migration_job / query_editor / form 走 `ui_list`）。仅在用户明确提"后台/历史/运行中的任务"时调用。status ∈ `running`/`completed`/`failed`/`cancelled`/`pending`
```

- [ ] **Step 3: Grep 验证**

Run: `Grep` with pattern `不含\*\* UI 卡片` path `prompts/chat_assistant.txt`
Expected: 命中 1 行（L184）。

---

## Task 3: Prompt 层 commit

- [ ] **Step 1: 查看改动 diff**

Run: `git diff prompts/chat_assistant.txt`

Expected: 只显示 L22 和 L184 两处变化，无其他文件。

- [ ] **Step 2: Commit**

```bash
git add prompts/chat_assistant.txt
git commit -m "$(cat <<'EOF'
docs(prompts): promote ui_list to preferred discovery, demote list_tasks

When user says "current/open/this X card", model was hallucinating
list_tasks (background runtime tasks) instead of ui_list (open UI
objects). Fix: weld priority directly into tool descriptions.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit 成功，无 hook 失败。

---

## Task 4: MCP 层 — `list_tasks` description

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs:145`

- [ ] **Step 1: 读取文件，确认 L143-147 上下文**

Run: 使用 `Read` 工具读取 `src-tauri/src/mcp/mod.rs` 的 L140-150。

Expected: L145 包含：
```
"description": "List import/export tasks with their status, progress, and error information. Use this to see what tasks are running, completed, or failed.",
```

- [ ] **Step 2: 应用 Edit**

使用 `Edit` 工具：

old_string:
```
"description": "List import/export tasks with their status, progress, and error information. Use this to see what tasks are running, completed, or failed.",
```

new_string:
```
"description": "List backend import/export/graph runtime tasks (status, progress, errors). Does NOT include UI cards — for open migration jobs, editors, or forms, use ui_list. Only call when user explicitly asks about background or historical tasks.",
```

- [ ] **Step 3: Grep 验证**

Run: `Grep` with pattern `Does NOT include UI cards` path `src-tauri/src/mcp/mod.rs`
Expected: 命中 1 行。

Run: `Grep` with pattern `List import/export tasks with their status` path `src-tauri/src/mcp/mod.rs`
Expected: 0 匹配。

---

## Task 5: MCP 层 — `ui_list` description

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs:219`

- [ ] **Step 1: 读取文件，确认 L217-223 上下文**

Run: 使用 `Read` 工具读取 `src-tauri/src/mcp/mod.rs` 的 L215-225。

Expected: L219 包含：
```
"description": "List all currently open UI objects, optionally filtered by type.",
```

- [ ] **Step 2: 应用 Edit**

使用 `Edit` 工具：

old_string:
```
"description": "List all currently open UI objects, optionally filtered by type.",
```

new_string:
```
"description": "PREFERRED discovery tool. Lists currently open UI objects (query editors, migration jobs, forms, canvases). Call this first whenever the user refers to 'current/open/this' UI element.",
```

- [ ] **Step 3: Grep 验证**

Run: `Grep` with pattern `PREFERRED discovery tool` path `src-tauri/src/mcp/mod.rs`
Expected: 命中 1 行。

---

## Task 6: Rust 编译校验

- [ ] **Step 1: 运行 cargo check**

Run:
```bash
cd src-tauri && cargo check
```

Expected: 编译通过，无 error。warnings 可接受（不是此次改动引入）。

- [ ] **Step 2: 处理可能的失败**

如果失败：
- 最可能是字符串转义错误（如单引号、反斜杠）。使用 `Read` 工具重新检查 L145 或 L219，确保字符串语法正确。
- 不要 rollback—— fix forward。

---

## Task 7: TypeScript 校验（CLAUDE.md 统一要求）

- [ ] **Step 1: 运行 tsc --noEmit**

Run:
```bash
npx tsc --noEmit
```

Expected: 通过，0 error。此次未触前端，如果失败说明其他地方已有问题，不应由此次改动引入——请停止并报告。

---

## Task 8: MCP 层 commit

- [ ] **Step 1: 查看改动 diff**

Run: `git diff src-tauri/src/mcp/mod.rs`

Expected: 只显示 L145 和 L219 两处 description 变化。

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "$(cat <<'EOF'
feat(mcp): clarify list_tasks vs ui_list tool descriptions

Mirror the prompt-layer disambiguation at the MCP tool description
layer so external MCP clients (not just the internal chat assistant)
also get the corrected tool priority signals.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit 成功。

---

## Task 9: 手动回归验证

手动验证而非自动化——需要在 AI 会话中实际触发以下 prompt，观察工具调用选择。

- [ ] **Step 1: 正向测试（应命中 `ui_list`）**

在应用的 AI 对话里依次输入：
1. "当前迁移任务的参数优化掉"
2. "把当前查询编辑器的 SQL 格式化"
3. "这个 ER 图加一个 user 表"

Expected: 每条都应触发 `ui_list(filter={type:"..."})` 作为**第一个**工具调用，而非 `list_tasks`。

- [ ] **Step 2: 反向测试（应命中 `list_tasks`）**

1. "最近有哪些导出任务失败了"
2. "后台任务列表"
3. "查看历史任务"

Expected: 每条都应触发 `list_tasks(status?)`，而非 `ui_list`。

- [ ] **Step 3: 记录结果**

如果任一测试失败：
- 记录具体 prompt、实际工具调用、错误方向
- 不立即回滚——先分析是描述措辞问题还是 prompt 章节顺序问题
- 若必要，回 spec 修订描述措辞并重跑 Task 1/4/5

如果全部通过：改动验证完毕，收工。

---

## Self-Review 清单

- [x] Spec 覆盖：改动 1→Task 1；改动 2→Task 2；改动 3→Task 4；改动 4→Task 5；验证→Task 9。无遗漏。
- [x] 无 placeholder：所有 Edit 步骤都有完整 old_string / new_string。
- [x] 类型一致性：不适用（纯文本改动，无函数签名/类型）。
- [x] Commit 粒度：2 个独立 commit（prompt 层、MCP 层），允许独立 revert。
- [x] 校验覆盖：cargo check + tsc + grep + 手动回归。

---

## 执行说明

改动极小（4 行文本 + 2 commit），建议选 **Inline Execution** 模式——subagent 开销 >> 实际改动成本。
