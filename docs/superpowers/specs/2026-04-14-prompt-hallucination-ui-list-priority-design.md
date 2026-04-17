# 提示词幻觉修复：`ui_list` 首选化 + `list_tasks` 降级

**日期**: 2026-04-14
**作者**: wallfacers (+ Claude)
**状态**: 设计定稿

## 背景

在一次真实会话中，用户请求"当前迁移任务的参数给我优化掉"，AI 错误调用了 `list_tasks`，返回的全部是 graph build 后台任务，完全绕过了用户真正想要的"当前打开的 migration_job 卡片"。正确路径是 `ui_list(filter={type:"migration_job"})`。

## 根因

### 语义冲突
项目中同时存在两个带 "task" 含义的工具：

| 工具 | 实际含义 | 现有描述 |
|------|---------|---------|
| `list_tasks` | 后台**运行时**任务（import/export/graph build） | `"List import/export tasks..."` |
| `ui_list` | 当前**打开的 UI 对象**（含 `migration_job` 卡片） | `"List all currently open UI objects"` |

用户口语 "当前 X 任务/卡片" 的"任务"一词字面匹配到 `list_tasks`，但语义"当前 + UI"应指向 `ui_list`。

### 三个加重因素
1. `Migration Job` 章节没讲"如何发现已打开的 job"，只讲了打开/读/写/运行。
2. `list_tasks` 的描述未反向排除 "UI 卡片"。
3. 术语 "task" / "job" 在 `migration_explorer`、`list_tasks`、UI 卡片间复用。

## 目标

- 让 AI 在用户提"当前/打开的/这个/正在编辑的"时，稳定调用 `ui_list`。
- 让 `list_tasks` 的触发门槛抬高到"用户明确提到后台/历史/运行中的任务"。
- 净体积增加 ≤ 350 字符（用户刚做完 55% 压缩，精简是硬约束；此次改动换来消歧收益）。
- 不改 API、不改参数、不改行为——仅改描述文本。

## 非目标

- 不重命名工具（`list_tasks` / `ui_list` 名称保留）。
- 不在 prompt 顶部新增"Intent → Tool"映射表（违背精简）。
- 不扩展 `Migration Job` 章节的叙述（避免重复）。

## 设计

### 核心策略

把"优先级"和"消歧"直接焊进**工具描述本身**（prompt 层 + MCP 层双写），不依赖外部映射表或章节叙述。无论 prompt 如何被压缩重排，工具列表本身始终可见。

### 改动清单

#### 改动 1 — `prompts/chat_assistant.txt` L22

```diff
-- **`ui_list(filter?)`** — discover open objects. Filter by `type` / `keyword` / `connectionId` / `database`
+- **`ui_list(filter?)`** — **首选发现入口**：用户提"当前 / 打开的 / 这个 / 正在编辑的" UI 元素时先调用。Filter: `type` / `keyword` / `connectionId` / `database`
```

#### 改动 2 — `prompts/chat_assistant.txt` L184

```diff
-- `list_tasks(status?, limit?=20, max=100)` — status ∈ `running` / `completed` / `failed` / `cancelled` / `pending` (omit for all)
+- `list_tasks(status?, limit?=20, max=100)` — **仅**后台 import/export/graph 运行时任务；**不含** UI 卡片（migration_job / query_editor / form 走 `ui_list`）。仅在用户明确提"后台/历史/运行中的任务"时调用。status ∈ `running`/`completed`/`failed`/`cancelled`/`pending`
```

#### 改动 3 — `src-tauri/src/mcp/mod.rs` 约 L145（`list_tasks` description）

```diff
-"List import/export tasks with their status, progress, and error information. Use this to see what tasks are running, completed, or failed."
+"List backend import/export/graph runtime tasks (status, progress, errors). Does NOT include UI cards — for open migration jobs, editors, or forms, use ui_list. Only call when user explicitly asks about background or historical tasks."
```

#### 改动 4 — `src-tauri/src/mcp/mod.rs` 约 L219（`ui_list` description）

```diff
-"List all currently open UI objects, optionally filtered by type."
+"PREFERRED discovery tool. Lists currently open UI objects (query editors, migration jobs, forms, canvases). Call this first whenever the user refers to 'current/open/this' UI element."
```

## 设计决策与权衡

### 为什么双层都改
- **MCP 层**：最后防线。即使内置 prompt 被裁剪，外部 MCP 客户端也能看到工具描述。
- **Prompt 层**：承担中文触发词（"当前/打开的"）映射，因为 MCP description 保持英文更通用。

### 为什么不改章节结构 / 加顶部映射表
- 顶部映射表会在下次 prompt 压缩时首当其冲被裁剪——优先级信号藏在工具描述里更稳健。
- 章节叙述容易被模型在上下文压力下遗忘；工具描述跟工具签名同屏呈现，最显眼。

### 为什么保留 `list_tasks` 的名字
- 向后兼容：外部 MCP 客户端可能已经硬编码了这个名字。
- 重命名收益有限：真正的歧义是"task 是后台还是 UI"，通过描述消歧即可。

## 预期净效应

- 体积：prompt +~140 字符、MCP description +~180 字符，合计 +~320 字符。
- 覆盖：所有"当前 X 卡片"场景（migration_job、query_editor、table_form、er_canvas、metric_form）。
- 零风险：文本改动，不触及 API / 参数 / 行为；不改数据结构 / 数据库 schema。

## 验证

1. 手动回归：以下 prompt 应稳定命中 `ui_list`：
   - "当前迁移任务的参数优化掉"
   - "把当前查询编辑器的 SQL 格式化"
   - "这个 ER 图加一个 user 表"
2. 手动反向：以下 prompt 应稳定命中 `list_tasks`：
   - "最近有哪些导出任务失败了"
   - "后台任务列表"
   - "历史任务"
3. 不做单元测试——纯文本描述改动，无可断言的运行时行为。

## 实施范围

改动文件：
- `prompts/chat_assistant.txt`（2 行）
- `src-tauri/src/mcp/mod.rs`（2 行）

后置校验：
- `cd src-tauri && cargo check`（description 只是字符串，不应引入编译错误，但 CLAUDE.md 要求统一校验）
- `npx tsc --noEmit`（前端未触及，应通过）
