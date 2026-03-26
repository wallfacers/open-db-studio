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
│  统一处理超时、错误格式、confirm 流程                             │
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

采用 **Resource Registry（类型 + 上下文结构体）** 方案，同时支持 URI 糖衣写法。

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
| `"list"` | 返回所有同类目标的列表 |
| tab_id（字符串） | 精确指向某个 Tab |
| 名称（如 `"users"`） | 按名称寻址（表名、指标名等） |

URI 糖衣（可选，等价于结构体）：
```
tab://query/active  ≡  resource="tab.query", target="active"
settings://llm      ≡  resource="settings.llm", target="active"
```

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

**struct 模式返回（结构化，由各 Adapter 定义 schema）：**
```json
{
  "type": "table",
  "name": "users",
  "columns": [
    { "name": "id", "type": "BIGINT", "comment": "主键" },
    { "name": "email", "type": "VARCHAR(255)", "comment": "" }
  ]
}
```

常用示例：
```
fs_read("tab.query", "active", "text")      # 读当前 SQL 文本
fs_read("tab.table", "users", "struct")     # 读 users 表结构
fs_read("panel.db-tree", "active", "struct")# 读数据库树状态
fs_read("settings.llm", "active", "struct") # 读 LLM 配置
```

---

### fs_write — 写入/修改

```
fs_write(resource, target, patch)
```

**text 模式 patch（按行范围操作）：**
```json
// 替换指定行范围
{ "mode": "text", "range": [3, 3], "content": "WHERE id = 1 AND status = 'active'", "reason": "添加状态过滤" }

// 行后插入（range 相同 + insert_after）
{ "mode": "text", "range": [5, 5], "content": "\nORDER BY created_at DESC", "insert_after": true }

// 全量替换（不传 range）
{ "mode": "text", "content": "SELECT 1" }
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

```
fs_search("tab.*")                                    # 列出所有已开 Tab
fs_search("tab.query", { keyword: "orders" })         # 搜含 orders 的 query tab
fs_search("panel.db-tree", { keyword: "users", type: "table" })
fs_search("tab.*", { type: "metric" })                # 找所有指标 Tab
```

---

### fs_open — 打开/导航

```
fs_open(resource, params?)
```

```
fs_open("tab.query", { connection_id: 1 })
fs_open("tab.table", { table: "users", database: "app" })
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
    exec:   string[]   // 支持的 action 名，如 ["run_sql", "undo"]
  }

  read?(target: string, mode: "text" | "struct"): Promise<FsReadResult>
  write?(target: string, patch: FsWritePatch): Promise<FsWriteResult>
  search?(filter: FsSearchFilter): Promise<FsSearchResult[]>
  open?(params: Record<string, unknown>): Promise<{ target: string }>
  exec?(target: string, action: string, params?: Record<string, unknown>): Promise<unknown>
}
```

### 注册（AppShell.tsx 启动时）

```typescript
FsRouter.register("tab.query",         new QueryTabAdapter())
FsRouter.register("tab.table",         new TableTabAdapter())
FsRouter.register("tab.metric",        new MetricTabAdapter())
FsRouter.register("panel.db-tree",     new DbTreeAdapter())
FsRouter.register("panel.tasks",       new TaskCenterAdapter())
FsRouter.register("settings.llm",      new LlmSettingsAdapter())
FsRouter.register("settings.conn",     new ConnectionSettingsAdapter())
```

### 写操作 Confirm 由 Adapter 内部决定（示例）

```typescript
// QueryTabAdapter — SQL 写操作走 propose→confirm
async write(target, patch): Promise<FsWriteResult> {
  const current = await getEditorContent(target)
  const modified = applyPatch(current, patch)
  const confirmId = await DiffPanel.propose({ original: current, modified, reason: patch.reason })
  return { status: "pending_confirm", confirm_id: confirmId }
}

// LlmSettingsAdapter — 配置写操作直接生效
async write(target, patch): Promise<FsWriteResult> {
  await invoke("update_llm_config", applyStructPatch(current, patch))
  return { status: "applied" }
}
```

---

## 旧工具迁移映射

| 旧工具 | 新实现 |
|--------|--------|
| `get_editor_sql` | `fs_read("tab.query","active","text")` |
| `propose_sql_diff` | `fs_write("tab.query","active",patch)` → 内部触发 DiffPanel |
| `search_tabs` | `fs_search("tab.*", filter)` |
| `get_tab_content` | `fs_read(resource, target, mode)` |
| `focus_tab` | `fs_exec("tab.query", tab_id, "focus")` |
| `open_tab` | `fs_open(resource, params)` |
| `get_column_meta` | `fs_read("tab.table", target, "struct")` |
| `update_column_comment` | `fs_write("tab.table", target, patch)` → 内部走 ALTER TABLE |
| `list_metrics` | `fs_read("tab.metric", "list", "struct")` |
| `get_metric` | `fs_read("tab.metric", metric_id, "struct")` |
| `create_metric` | `fs_exec("tab.metric", "new", "create", def)` |
| `update_metric_definition` | `fs_write("tab.metric", metric_id, patch)` |
| `list_tasks` | `fs_read("panel.tasks", "list", "struct")` |
| `undo_last_change` | `fs_exec("tab.*", "active", "undo")` |
| `get_change_history` | `fs_read("panel.tasks", "history", "struct")` |

**不纳入统一范围（保持原名）：**
- `db_read` 工具组（`list_databases` / `list_tables` / `get_table_schema` / `get_table_sample` / `execute_sql`）— 数据库读取，非 UI 操作
- `graph_*` 工具组 — 业务语义知识图谱工具，非 UI 操作
- `seatunnel` 工具组 — 独立业务域

---

## Prompts 迁移方案

### 文件变更

| 变更 | 说明 |
|------|------|
| `sql_explain.txt` + `sql_diagnose.txt` → `sql_analyze.txt` | 合并，参数 `mode: "explain"\|"diagnose"` |
| `sql_create_table.txt` 并入 `generate_table_schema.txt` | 参数 `output: "json"\|"sql"` |
| `sql_generate.txt` | 降级为兜底，AI 优先通过 `fs_read` 自行读取上下文 |
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
- fs_search(resource_pattern, filter?): 搜索 Tab 或页面区域

### 导航类
- fs_open(resource, params?): 打开 Tab 或导航到页面

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

| 文件 | 变更程度 | 说明 |
|------|---------|------|
| `tab-control/SKILL.md` | 完全重写 | 全部替换为 fs_* DSL 工具描述 |
| `table-edit/SKILL.md` | 部分重写 | 读写操作改为 `fs_read`/`fs_write`，业务规则保留 |
| `db-read/SKILL.md` | 微调 | 补充"先 `fs_read` 读当前 tab 获取上下文"引导 |
| `metric-read/SKILL.md` | 微调 | 工具调用部分对齐新 DSL，指标解歧逻辑保留 |

`tab-control/SKILL.md` 新版 triggers 和描述：
```yaml
description: Unified file-system style tools for reading, writing, navigating
             any tab, panel, or settings page in the application
triggers:
  - always
```

---

## 实施分阶段

| 阶段 | 内容 | 产出 |
|------|------|------|
| Phase 1 | FsRouter + FsAdapter 接口定义；QueryTabAdapter 实现（覆盖 tab_control 现有工具） | tab.query 可用 |
| Phase 2 | TableTabAdapter + MetricTabAdapter；Rust MCP 层替换为 5 个工具 | 全量工具替换完成 |
| Phase 3 | PanelAdapter（db-tree、tasks）+ SettingsAdapter（llm、conn） | 全应用可寻址 |
| Phase 4 | prompts/ + skills/ 文件迁移 | AI 提示词对齐新接口 |

---

## 不在本设计范围内

- 数据库读取工具（`db_read` 工具组）的改动
- 知识图谱工具（`graph_*`）的改动
- SeaTunnel 工具的改动
- Monaco Editor 内部实现细节
