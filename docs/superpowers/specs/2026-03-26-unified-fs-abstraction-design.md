# 统一 FS 抽象层设计（AI 操作页面统一接口）

**日期**: 2026-03-26
**状态**: 已批准
**范围**: 替换现有 25 个分散 MCP 工具，统一为 5 个 DSL 原子工具；同步迁移 prompts/ 和 skills/

---

## 背景与目标

当前 MCP 工具体系按功能域分散实现（tab_control、table_edit、metric_edit、history 等），共约 25 个工具。AI 需要记忆每个工具的专属参数格式，且工具与具体组件实现强耦合。

本设计将所有 AI 页面操作能力统一抽象为"文件系统"模型：

- **Tab / 面板 / 设置页 = 文件**，全应用可寻址
- **5 个原子 verb**（read / write / search / open / exec）替代所有现有工具
- **注册制 Adapter**，各组件独立实现，FsRouter 统一路由
- AI 不感知组件内部实现，写操作的 confirm 流程由 Adapter 内部决定

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server（Rust）                        │
│                                                                 │
│  fs_read / fs_write / fs_search / fs_open / fs_exec            │
│       ↓ Tauri emit "mcp://fs-request"                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  FsRouter（前端，TypeScript）                    │
│                                                                 │
│  解析 resource_type + target → 路由到对应 Adapter               │
│  统一处理超时、错误格式                                          │
└──────────────┬──────────────┬──────────────┬────────────────────┘
               ↓              ↓              ↓
   ┌───────────────┐  ┌──────────────┐  ┌───────────────────┐
   │ TabAdapter    │  │ PanelAdapter │  │ SettingsAdapter   │
   │               │  │              │  │                   │
   │ tab.query     │  │ panel.db-tree│  │ settings.llm      │
   │ tab.table     │  │ panel.tasks  │  │ settings.conn     │
   │ tab.metric    │  │              │  │                   │
   └──────┬────────┘  └──────┬───────┘  └────────┬──────────┘
          ↓                  ↓                   ↓
   ┌────────────────────────────────────────────────────────┐
   │           现有系统层（改动最小）                          │
   │  Monaco Editor │ Zustand Store │ React Router │ SQLite  │
   └────────────────────────────────────────────────────────┘
```

**关键决策：**

- Rust 层只保留 5 个 MCP 工具，参数统一为 `resource + target + payload`
- 现有底层原语 `query_frontend`（读）和 `send_ui_action`（写）保持不变，FsRouter 继续复用
- FsRouter 是唯一路由入口，新增组件只需实现 FsAdapter 接口并调用 `FsRouter.register()`
- 写操作的 propose→confirm 流程由各 Adapter 内部决定，AI 调用 `fs_write` 签名不变

---

## 寻址模型

采用 **Resource Registry（类型 + 结构体）** 方案。URI 糖衣（`tab://query/active`）**仅用于文档说明**，Rust 层和前端路由只接受结构化参数，不实现 URI 解析。

### Resource 类型命名规范

```
tab.query        — SQL 编辑器 Tab
tab.table        — 表结构 Tab
tab.metric       — 指标定义 Tab
panel.db-tree    — 数据库树面板
panel.tasks      — 任务中心面板
settings.llm     — LLM 配置页
settings.conn    — 连接列表页
```

### Target 寻址

| target 值 | 含义 |
|-----------|------|
| `"active"` | 当前激活/聚焦的目标 |
| `"list"` | 返回所有同类目标的列表（数组） |
| `"history"` | 历史记录视图（如变更历史） |
| tab_id（字符串） | 精确指向某个 Tab（`tab-001` 等） |
| 名称（如 `"users"`） | 按名称寻址（表名、指标名等） |
| `"name@conn:N"`（如 `"users@conn:1"`） | 多连接场景下精确寻址（表名 + 连接 ID） |

---

## 5 个原子工具接口

### fs_read — 读取内容

```
fs_read(resource, target, mode: "text"|"struct")
```

**text 模式返回（带行号，供行范围操作）：**
```json
{
  "content": "SELECT *\nFROM users\nWHERE id = 1",
  "lines": [
    { "no": 1, "text": "SELECT *" },
    { "no": 2, "text": "FROM users" },
    { "no": 3, "text": "WHERE id = 1" }
  ],
  "cursor_line": 2,
  "selected_range": null,
  "statements": ["SELECT * FROM users WHERE id = 1"]
}
```

**struct 模式 — 单对象返回示例（tab.table）：**
```json
{
  "type": "table",
  "name": "users",
  "columns": [
    { "name": "id", "type": "BIGINT", "nullable": false, "comment": "主键" },
    { "name": "email", "type": "VARCHAR(255)", "nullable": true, "comment": "" }
  ]
}
```

**struct 模式 — list 返回示例（`target="list"`，如 tab.metric list）：**
```json
{
  "type": "list",
  "items": [
    { "id": 1, "name": "日活用户数", "status": "approved", "connection_id": 2 },
    { "id": 2, "name": "新增订单数", "status": "draft",    "connection_id": 2 }
  ],
  "total": 2
}
```

常用示例：
```
fs_read("tab.query",    "active",   "text")    # 读当前 SQL 文本
fs_read("tab.table",    "users",    "struct")  # 读 users 表结构（单对象）
fs_read("tab.metric",   "list",     "struct")  # 读指标列表（数组）
fs_read("panel.tasks",  "list",     "struct")  # 读任务列表
fs_read("settings.llm", "active",   "struct")  # 读 LLM 配置
```

---

### fs_write — 写入/修改

```
fs_write(resource, target, patch)
```

**text 模式 patch（按行范围操作，使用 `op` 枚举消除歧义）：**
```json
// 替换指定行范围（op: "replace"）
{
  "mode": "text",
  "op": "replace",
  "range": [3, 3],
  "content": "WHERE id = 1 AND status = 'active'",
  "reason": "添加状态过滤"
}

// 在指定行后插入（op: "insert_after"）
{
  "mode": "text",
  "op": "insert_after",
  "line": 5,
  "content": "ORDER BY created_at DESC",
  "reason": "添加排序"
}

// 全量替换（op: "replace_all"）
{ "mode": "text", "op": "replace_all", "content": "SELECT 1" }
```

**struct 模式 patch（按 JSON path 修改）：**
```json
// 修改列注释
{ "mode": "struct", "path": "/columns/1/comment", "value": "用户邮箱，唯一约束" }

// 修改配置字段
{ "mode": "struct", "path": "/model", "value": "gpt-4o" }
```

**写操作响应：**
```json
// 需要用户确认（SQL diff、ALTER TABLE 等）
{ "status": "pending_confirm", "confirm_id": "abc123", "preview": "..." }

// 直接生效（配置修改等）
{ "status": "applied" }
```

---

### fs_search — 搜索定位

```
fs_search(resource_pattern, filter?)
```

**FsSearchResult 类型定义：**
```typescript
interface FsSearchResult {
  resource: string       // "tab.query"
  target:   string       // tab_id 或名称
  label:    string       // 可读标题，如 "query-1 · SELECT * FROM orders"
  meta:     Record<string, unknown>  // 各 Adapter 自定义附加字段
}
```

**返回示例（`fs_search("tab.*")`）：**
```json
[
  { "resource": "tab.query",  "target": "tab-001", "label": "query-1 · SELECT * FROM orders", "meta": { "connection_id": 1 } },
  { "resource": "tab.table",  "target": "users",   "label": "table · users",                  "meta": { "database": "app" } },
  { "resource": "tab.metric", "target": "42",      "label": "metric · 日活用户数",              "meta": { "status": "approved" } }
]
```

常用示例：
```
fs_search("tab.*")                                          # 列出所有已开 Tab
fs_search("tab.query",    { keyword: "orders" })           # 搜含 orders 的 query tab
fs_search("panel.db-tree",{ keyword: "users", type: "table" })
fs_search("tab.*",        { type: "metric" })              # 找所有指标 Tab
```

---

### fs_open — 打开/导航

```
fs_open(resource, params?)
```

返回 `{ target: string }` — 打开后的 tab_id 或目标标识，可供后续操作使用。

```
fs_open("tab.query",   { connection_id: 1 })
fs_open("tab.table",   { table: "users", database: "app", connection_id: 1 })
fs_open("tab.metric",  { metric_id: 42 })
fs_open("settings.llm")
fs_open("panel.tasks")
```

---

### fs_exec — 执行动作

```
fs_exec(resource, target, action, params?)
```

| 调用示例 | 说明 |
|---------|------|
| `fs_exec("tab.query", "active", "run_sql")` | 执行当前 SQL |
| `fs_exec("tab.query", "active", "confirm_write", { confirm_id: "abc123" })` | 确认待写操作 |
| `fs_exec("tab.query", "active", "undo")` | 撤销最后变更 |
| `fs_exec("panel.db-tree", "conn:1", "refresh")` | 刷新数据库树 |
| `fs_exec("tab.metric", "new", "create", { connection_id: 1, name: "daily_active_users", display_name: "日活用户数", aggregation: "COUNT", table_name: "users", column_name: "id", filter_sql?: "...", description?: "...", time_granularity?: "day" })` | 创建指标（必填：connection_id、name、display_name、aggregation、table_name、column_name；可选：filter_sql、description、time_granularity） |

---

## FsAdapter 接口与注册

### TypeScript 接口定义

```typescript
interface FsAdapter {
  capabilities: {
    read:   boolean
    write:  boolean
    search: boolean
    open:   boolean
    exec:   string[]   // 支持的 action 名，如 ["run_sql", "undo", "focus"]
  }

  read?(target: string, mode: "text" | "struct"): Promise<FsReadResult>
  write?(target: string, patch: FsWritePatch): Promise<FsWriteResult>
  search?(filter: FsSearchFilter): Promise<FsSearchResult[]>
  open?(params: Record<string, unknown>): Promise<{ target: string }>
  exec?(target: string, action: string, params?: Record<string, unknown>): Promise<unknown>
}
```

### 核心类型定义

```typescript
interface FsMcpRequest {
  op:       "read" | "write" | "search" | "open" | "exec"
  resource: string            // 精确类型，如 "tab.query"
  target:   string            // "active" | "list" | tab_id | 名称 | "name@conn:N"
  payload:  Record<string, unknown>  // 各 op 的具体参数
}

interface FsReadResult   { [key: string]: unknown }
interface FsWriteResult  { status: "applied" | "pending_confirm" | "error"; confirm_id?: string; preview?: string; message?: string }
interface FsSearchFilter { keyword?: string; type?: string; connection_id?: number; [key: string]: unknown }
interface FsSearchResult { resource: string; target: string; label: string; meta: Record<string, unknown> }
interface FsWritePatch   { mode: "text" | "struct"; op?: "replace" | "insert_after" | "replace_all"; range?: [number, number]; line?: number; content?: string; path?: string; value?: unknown; reason?: string }
```

### FsRouter Skeleton

```typescript
class FsRouter {
  private adapters = new Map<string, FsAdapter>()

  register(resource: string, adapter: FsAdapter) {
    this.adapters.set(resource, adapter)
  }

  async handle(req: FsMcpRequest): Promise<string> {
    switch (req.op) {
      case "read":
      case "write":
      case "open":
      case "exec": {
        // 精确匹配单个 Adapter
        const adapter = this.adapters.get(req.resource)
        if (!adapter) throw new Error(`Unknown resource: ${req.resource}`)
        if (req.op === "read") {
          if (!adapter.read) throw new Error(`${req.resource} does not support read`)
          return JSON.stringify(await adapter.read(req.target, req.payload.mode as "text"|"struct"))
        }
        if (req.op === "write") {
          if (!adapter.write) throw new Error(`${req.resource} does not support write`)
          return JSON.stringify(await adapter.write(req.target, req.payload as FsWritePatch))
        }
        if (req.op === "open") {
          if (!adapter.open) throw new Error(`${req.resource} does not support open`)
          return JSON.stringify(await adapter.open(req.payload))
        }
        // exec
        if (!adapter.exec) throw new Error(`${req.resource} does not support exec`)
        if (!adapter.capabilities.exec.includes(req.payload.action as string))
          throw new Error(`Unsupported action: ${req.payload.action}`)
        return JSON.stringify(await adapter.exec(req.target, req.payload.action as string, req.payload.params as Record<string, unknown>))
      }
      case "search": {
        // glob 展开：在 FsRouter 层遍历所有 Adapter，按 resource_pattern 过滤
        // "tab.*" → 匹配所有 tab.* 前缀的 Adapter；"tab.query" → 精确匹配
        const pattern = req.resource  // resource_pattern 字段复用 resource
        const matchedAdapters = [...this.adapters.entries()].filter(([key]) =>
          pattern.endsWith(".*") ? key.startsWith(pattern.slice(0, -2)) : key === pattern
        )
        const results: FsSearchResult[] = []
        for (const [, adapter] of matchedAdapters) {
          if (adapter.search) results.push(...await adapter.search(req.payload as FsSearchFilter))
        }
        return JSON.stringify(results)
      }
      default:
        throw new Error(`Unknown op: ${(req as FsMcpRequest).op}`)
    }
  }
}

export const fsRouter = new FsRouter()
```

FsRouter 挂载到 `useMcpBridge` 的 `"mcp://fs-request"` 事件监听器，替换现有 switch-case 工具分发逻辑。

### 注册（AppShell.tsx 启动时）

```typescript
fsRouter.register("tab.query",          new QueryTabAdapter())
fsRouter.register("tab.table",          new TableTabAdapter())
fsRouter.register("tab.metric",         new MetricTabAdapter())
fsRouter.register("panel.db-tree",      new DbTreeAdapter())
fsRouter.register("panel.tasks",        new TaskCenterAdapter())
fsRouter.register("settings.llm",       new LlmSettingsAdapter())
fsRouter.register("settings.conn",      new ConnectionSettingsAdapter())
```

### Adapter 实现示例

**QueryTabAdapter.write() — SQL 写操作走 propose→confirm：**
```typescript
async write(target, patch): Promise<FsWriteResult> {
  const current = await queryFrontend("get_tab_content", { tab_id: resolveTarget(target) })
  const modified = applyTextPatch(current.content, patch)
  const confirmId = await DiffPanel.propose({ original: current.content, modified, reason: patch.reason })
  return { status: "pending_confirm", confirm_id: confirmId }
}
```

**TableTabAdapter.write() — 列注释修改，执行路径明确：**
```typescript
async write(target, patch): Promise<FsWriteResult> {
  // patch: { mode:"struct", path:"/columns/N/comment", value:"..." }
  const { table_name, column_name } = resolveStructPath(target, patch.path)

  // auto_mode 检查（迁移后移至前端 Adapter，与现有 auto_mode Zustand store 对接）
  const autoMode = useAppStore.getState().autoMode
  if (!autoMode) {
    return { status: "error", message: "需要开启 Auto 模式才能修改列注释" }
  }

  // target 应为 tab_id 或 "table_name@conn:N" 格式，以便在多连接场景下唯一确定连接
  // DDL 执行仍在 Rust 层，通过 invoke 调用
  await invoke("update_column_comment", {
    connectionId: resolveConnectionId(target),  // 从 target 中解析 connection_id
    tableName: table_name,
    columnName: column_name,
    comment: patch.value,
  })
  return { status: "applied" }
}
```

**LlmSettingsAdapter.write() — 配置写操作直接生效：**
```typescript
async write(target, patch): Promise<FsWriteResult> {
  const current = await invoke("get_llm_configs")
  const updated = applyStructPatch(current, patch)
  await invoke("update_llm_config", updated)
  return { status: "applied" }
}
```

### auto_mode 门控迁移策略

现有代码中，`update_metric_definition`、`update_column_comment`、`undo_last_change` 在 Rust 层检查 `auto_mode` 标志。迁移后：

- `auto_mode` 检查**移至前端 Adapter 层**，与 Zustand `appStore.autoMode` 直接对接
- Rust 层对应命令**移除 auto_mode 检查**，仅执行业务逻辑（信任前端已校验）
- 行为不变：Auto 模式关闭时，Adapter 返回 `{ status: "error", message: "需要开启 Auto 模式" }`

---

## Rust MCP 层新工具 inputSchema

Phase 2 替换后，`tool_definitions()` 只注册以下 5 个工具：

```json
[
  {
    "name": "fs_read",
    "description": "Read content from any tab, panel, or settings page",
    "inputSchema": {
      "type": "object",
      "properties": {
        "resource": { "type": "string", "description": "e.g. tab.query, tab.table, settings.llm" },
        "target":   { "type": "string", "description": "active | list | tab_id | name" },
        "mode":     { "type": "string", "enum": ["text", "struct"] }
      },
      "required": ["resource", "target", "mode"]
    }
  },
  {
    "name": "fs_write",
    "description": "Write or patch content in a tab, panel, or settings page",
    "inputSchema": {
      "type": "object",
      "properties": {
        "resource": { "type": "string" },
        "target":   { "type": "string" },
        "patch":    { "type": "object", "description": "text patch (op/range/content) or struct patch (path/value)" }
      },
      "required": ["resource", "target", "patch"]
    }
  },
  {
    "name": "fs_search",
    "description": "Search across tabs, panels, or db-tree by resource pattern and filter",
    "inputSchema": {
      "type": "object",
      "properties": {
        "resource_pattern": { "type": "string", "description": "e.g. tab.*, tab.query" },
        "filter": { "type": "object", "description": "optional: keyword, type, connection_id, etc." }
      },
      "required": ["resource_pattern"]
    }
  },
  {
    "name": "fs_open",
    "description": "Open a new tab or navigate to a page",
    "inputSchema": {
      "type": "object",
      "properties": {
        "resource": { "type": "string" },
        "params":   { "type": "object" }
      },
      "required": ["resource"]
    }
  },
  {
    "name": "fs_exec",
    "description": "Execute an action on a resource target",
    "inputSchema": {
      "type": "object",
      "properties": {
        "resource": { "type": "string" },
        "target":   { "type": "string" },
        "action":   { "type": "string", "description": "run_sql | confirm_write | undo | focus | refresh | create" },
        "params":   { "type": "object" }
      },
      "required": ["resource", "target", "action"]
    }
  }
]
```

---

## 旧工具迁移映射（完整）

| 旧工具 | 新实现 |
|--------|--------|
| `get_editor_sql` | `fs_read("tab.query","active","text")` |
| `propose_sql_diff` | `fs_write("tab.query","active",patch)` → QueryTabAdapter 内部触发 DiffPanel |
| `search_tabs` | `fs_search("tab.*", filter)` |
| `get_tab_content` | `fs_read(resource, target, mode)` |
| `focus_tab` | `fs_exec("tab.query", tab_id, "focus")` |
| `open_tab` | `fs_open(resource, params)` |
| `search_db_metadata` | `fs_search("panel.db-tree", { keyword, type })` → DbTreeAdapter |
| `get_column_meta` | `fs_read("tab.table", target, "struct")` |
| `update_column_comment` | `fs_write("tab.table", target, patch)` → TableTabAdapter.write() via invoke |
| `list_metrics` | `fs_read("tab.metric","list","struct")` |
| `search_metrics` | `fs_search("tab.metric", { keyword })` → MetricTabAdapter |
| `get_metric` | `fs_read("tab.metric", metric_id, "struct")` |
| `create_metric` | `fs_exec("tab.metric","new","create",{ connection_id, name, display_name, aggregation, table_name, column_name, filter_sql?, description?, time_granularity? })` |
| `update_metric_definition` | `fs_write("tab.metric", metric_id, patch)` → auto_mode 检查移至 Adapter |
| `list_tasks` | `fs_read("panel.tasks","list","struct")` |
| `get_task_detail` | `fs_read("panel.tasks", task_id, "struct")` |
| `get_change_history` | `fs_read("panel.tasks","history","struct")` |
| `undo_last_change` | `fs_exec("panel.tasks","active","undo")` → auto_mode 检查移至 Adapter |

**不纳入统一范围（保持原名）：**
- `db_read` 工具组（`list_databases` / `list_tables` / `get_table_schema` / `get_table_sample` / `execute_sql`）— 直接查询数据库，非 UI 操作
- `graph_*` 工具组 — 业务语义知识图谱，非 UI 操作
- `propose_seatunnel_job` — 独立业务域，其 confirm 流程与新 fs_write 设计相似，**列为已知技术债，Phase 3+ 视情况纳入**

---

## Prompts 迁移方案

### 文件变更

| 变更 | 说明 |
|------|------|
| `sql_explain.txt` + `sql_diagnose.txt` → `sql_analyze.txt` | 合并，参数 `mode: "explain"\|"diagnose"` |
| `sql_create_table.txt` 并入 `generate_table_schema.txt` | 参数 `output: "json"\|"sql"` |
| `sql_generate.txt` | 降级为兜底，AI 优先通过 `fs_read` 自行读取上下文，不再由前端注入 `{{SCHEMA}}` |
| `chat_assistant.txt` | **重写工具区块**，全部替换为新 DSL 工具名 |

### chat_assistant.txt 工具区块新结构

```
## Available Tools

### 读取类
- fs_read(resource, target, mode): 读取任意 Tab/面板/设置内容
  示例：fs_read("tab.query","active","text") 读当前 SQL

### 写入类
- fs_write(resource, target, patch): 修改 Tab 内容或配置（写操作内部自动处理 confirm 流程）

### 搜索定位类
- fs_search(resource_pattern, filter?): 搜索 Tab、面板或数据库树节点

### 导航类
- fs_open(resource, params?): 打开 Tab 或导航到页面，返回 { target }

### 执行类
- fs_exec(resource, target, action, params?): 执行操作
  示例：fs_exec("tab.query","active","run_sql")

### 数据库读取类（保持原名，非 UI 操作）
- list_databases / list_tables / get_table_schema / get_table_sample / execute_sql

### 知识图谱类（保持原名）
- graph_query_context / graph_search_tables / graph_find_join_paths / graph_get_ddl / graph_search_metrics
```

---

## Skills 迁移方案

skills 文件位于 `src-tauri/skills/`（对应路径 `src-tauri/skills/<name>/SKILL.md`）。

| 文件 | 变更程度 | 说明 |
|------|---------|------|
| `tab-control/SKILL.md` | 完全重写 | 全部替换为 fs_* DSL 工具描述，trigger 改为 always |
| `table-edit/SKILL.md` | 部分重写 | `get_column_meta` → `fs_read`，`update_column_comment` → `fs_write`，业务规则保留 |
| `db-read/SKILL.md` | 微调 | 补充"先 `fs_read("tab.query","active","text")` 读取当前编辑器上下文"引导 |
| `metric-read/SKILL.md` | 微调 | `list_metrics` → `fs_read` list，`search_metrics` → `fs_search`，`get_metric` → `fs_read`；指标解歧逻辑保留 |

`tab-control/SKILL.md` 新版描述：
```yaml
description: Unified file-system style tools for reading, writing, searching,
             opening, and executing actions on any tab, panel, or settings page
triggers:
  - always
```

---

## 实施分阶段

| 阶段 | 内容 | 产出 | 备注 |
|------|------|------|------|
| Phase 1 | FsRouter + FsAdapter 接口定义（TypeScript）；QueryTabAdapter 实现（覆盖 tab_control 所有工具）；Rust 层新增 5 工具但与旧工具并存 | `tab.query` 完全可用 | 验证架构正确性 |
| Phase 2 | TableTabAdapter（含 auto_mode 迁移）+ MetricTabAdapter；Rust 层移除旧工具，只保留 5 个 | 全量工具替换完成 | DDL 执行路径通过 invoke 调 Rust |
| Phase 3 | DbTreeAdapter + TaskCenterAdapter + SettingsAdapter（llm、conn）；`propose_seatunnel_job` 评估纳入 | 全应用可寻址 | |
| Phase 4 | prompts/ 文件合并+重写；skills/ SKILL.md 更新 | AI 提示词对齐新接口 | 工作量中等，prompts 与代码历史漂移需逐一核对 |

---

## 不在本设计范围内

- 数据库读取工具（`db_read` 工具组）的改动
- 知识图谱工具（`graph_*`）的改动
- Monaco Editor 内部实现细节
- `propose_seatunnel_job` 纳入统一（Phase 3+ 技术债评估）
