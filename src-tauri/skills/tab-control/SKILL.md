---
description: Unified file-system style tools for reading, writing, searching,
             opening, and executing actions on any tab, panel, or settings page
triggers:
  - always
---

# tab-control Skill

Use the unified fs_* DSL tools to operate on any tab, panel, or settings page.

## Resource Types

```
tab.query        — SQL 编辑器 Tab
tab.table        — 表结构 Tab
tab.metric       — 指标定义 Tab
panel.db-tree    — 数据库树面板
panel.tasks      — 任务中心面板
settings.llm     — LLM 配置页
settings.conn    — 连接列表页
```

## Target Addressing

| target | meaning |
|--------|---------|
| `"active"` | currently focused target |
| `"list"` | all targets of this resource type |
| `"history"` | change history view |
| tab_id | exact tab (e.g. `"tab-001"`) |
| name | by name (e.g. `"users"` for a table) |
| `"name@conn:N"` | name + connection ID for multi-connection (e.g. `"users@conn:1"`) |

## fs_read — Read Content

```
fs_read(resource, target, mode: "text"|"struct")
```

text mode returns: `{ content, lines[{no, text}], cursor_line, selected_range, statements }`

struct mode returns the resource object (table schema, metric definition, list, etc.)

```
fs_read("tab.query",    "active",   "text")    # current SQL text + statements
fs_read("tab.query",    tab_id,     "text")    # specific tab SQL
fs_read("tab.table",    "users",    "struct")  # table schema
fs_read("tab.metric",   "list",     "struct")  # metric list
fs_read("panel.tasks",  "list",     "struct")  # task list
fs_read("panel.tasks",  "history",  "struct")  # change history
fs_read("settings.llm", "active",   "struct")  # LLM config
```

## fs_write — Write / Patch

```
fs_write(resource, target, patch)
```

Text patch (line-range operations):
```json
{ "mode": "text", "op": "replace",      "range": [3,3], "content": "...", "reason": "..." }
{ "mode": "text", "op": "insert_after", "line": 5,      "content": "...", "reason": "..." }
{ "mode": "text", "op": "replace_all",  "content": "SELECT 1" }
```

Struct patch (JSON path):
```json
{ "mode": "struct", "path": "/columns/1/comment", "value": "用户邮箱" }
{ "mode": "struct", "path": "/model", "value": "gpt-4o" }
```

Write response:
- `{ "status": "pending_confirm", "confirm_id": "...", "preview": "..." }` — awaiting user confirmation
- `{ "status": "applied" }` — applied immediately

## fs_search — Search / Locate

```
fs_search(resource_pattern, filter?)
```

```
fs_search("tab.*")                                         # all open tabs
fs_search("tab.query",     { keyword: "orders" })         # query tabs containing keyword
fs_search("panel.db-tree", { keyword: "users", type: "table" })
fs_search("tab.*",         { type: "metric" })            # all metric tabs
```

Returns: `[{ resource, target, label, meta }]`

## fs_open — Open / Navigate

```
fs_open(resource, params?)
```

Returns `{ target: tab_id }` — use returned target for subsequent operations.

```
fs_open("tab.query",  { connection_id: 1 })
fs_open("tab.table",  { table: "users", database: "app", connection_id: 1 })
fs_open("tab.metric", { metric_id: 42 })
fs_open("settings.llm")
fs_open("panel.tasks")
```

## fs_exec — Execute Action

```
fs_exec(resource, target, action, params?)
```

| call | description |
|------|-------------|
| `fs_exec("tab.query", "active", "run_sql")` | execute current SQL |
| `fs_exec("tab.query", "active", "confirm_write", { confirm_id: "..." })` | confirm pending write |
| `fs_exec("tab.query", "active", "undo")` | undo last change |
| `fs_exec("tab.query", tab_id, "focus")` | switch to tab |
| `fs_exec("panel.db-tree", "conn:1", "refresh")` | refresh db tree |
| `fs_exec("tab.metric", "new", "create", { connection_id, name, display_name, aggregation, table_name, column_name, filter_sql?, description?, time_granularity? })` | create metric |

## Tab Discovery Strategy

1. Check `active_tab` context first
2. If target not in open tabs → `fs_search("tab.*")`
3. If still not found → `fs_search("panel.db-tree", { keyword: ..., type: "table" })`
4. If found in db-tree → `fs_open(resource, params)` then use returned `target`
5. Read content with `fs_read(resource, target, mode)`
