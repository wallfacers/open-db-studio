---
description: Unified UI Object Protocol tools for reading, patching, executing actions,
             and listing any tab, panel, or workspace object
triggers:
  - always
---

# tab-control Skill

Use the unified `ui_*` tools to operate on any UI object (tab, panel, workspace).

## Object Types

```
query_editor     — SQL editor tab
table_form       — table structure tab (create / alter)
metric_form      — metric definition tab
seatunnel_job    — SeaTunnel job tab
er_canvas        — ER diagram tab
db_tree          — database tree panel
history          — change history panel
workspace        — virtual global object (open/close/focus tabs)
```

## Target Addressing

| target | meaning |
|--------|---------|
| `"active"` | currently focused instance of the object type |
| objectId | exact tab/panel (e.g. `"tab-001"`) |

## ui_read — Read State / Schema / Actions

```
ui_read(object, target, mode: "state"|"schema"|"actions")
```

- `state` — current data (SQL text, form fields, etc.)
- `schema` — JSON Schema describing patchable fields
- `actions` — list of executable actions with param schemas

```
ui_read("query_editor", "active", "state")      # current SQL text
ui_read("table_form",   "tab-001", "schema")    # patchable field schema
ui_read("table_form",   "active",  "actions")   # available actions
ui_read("workspace",    "",        "actions")    # open/close/focus
```

## ui_patch — JSON Patch (RFC 6902)

```
ui_patch(object, target, ops, reason?)
```

Applies RFC 6902 JSON Patch operations atomically. Supports `[key=value]` array addressing.

```json
ui_patch("table_form", "active", [
  {"op": "replace", "path": "/tableName", "value": "orders"},
  {"op": "add", "path": "/columns/-", "value": {"name": "total", "dataType": "DECIMAL"}},
  {"op": "replace", "path": "/columns[name=amount]/dataType", "value": "BIGINT"},
  {"op": "test", "path": "/engine", "value": "InnoDB"}
], "rename table and add total column")
```

Supported ops: `add`, `remove`, `replace`, `move`, `copy`, `test`

Response:
- `{ "status": "applied" }` — applied immediately (Auto Mode ON)
- `{ "status": "pending_confirm", "confirm_id": "...", "preview": [...] }` — awaiting user confirmation (Auto Mode OFF)
- `{ "status": "error", "message": "..." }` — atomic rollback on any failure

## ui_exec — Execute Action

```
ui_exec(object, target, action, params?)
```

| call | description |
|------|-------------|
| `ui_exec("workspace", "", "open", {type: "query_editor", connection_id: 1})` | open new query tab |
| `ui_exec("workspace", "", "open", {type: "table_form", connection_id: 1, database: "app"})` | open new table form |
| `ui_exec("workspace", "", "open", {type: "table_form", connection_id: 1, database: "app", table: "users"})` | open existing table structure |
| `ui_exec("workspace", "", "close", {target: "tab-001"})` | close tab |
| `ui_exec("workspace", "", "focus", {target: "tab-001"})` | switch to tab |
| `ui_exec("query_editor", "active", "run_sql")` | execute current SQL |
| `ui_exec("query_editor", "active", "format")` | format SQL |
| `ui_exec("query_editor", "active", "undo")` | undo last text edit in editor |
| `ui_exec("query_editor", "active", "focus")` | focus (activate) the editor tab |
| `ui_exec("query_editor", "active", "set_context", {connectionId: 1, database: "app"})` | set editor's connection/database context |
| `ui_exec("table_form", "active", "preview_sql")` | preview CREATE/ALTER SQL |
| `ui_exec("table_form", "active", "save")` | generate SQL to query tab |
| `ui_exec("db_tree", "active", "refresh")` | refresh db tree |
| `ui_exec("db_tree", "active", "search", {keyword: "users", type: "table"})` | search already-loaded tree nodes |
| `ui_exec("db_tree", "active", "expand", {nodeId: "conn_1/db_app/cat_tables"})` | expand a specific tree node (loads children) |
| `ui_exec("db_tree", "active", "select", {nodeId: "conn_1/db_app/cat_tables/table_users"})` | highlight a specific tree node |
| `ui_exec("db_tree", "active", "locate_table", {connection_id: 1, database: "app", table: "users"})` | expand full path to a table and select it |
| `ui_exec("history", "", "list")` | list change history entries |
| `ui_exec("history", "", "undo")` | undo last structural change (table form, etc.) |

## ui_list — List Open Objects

```
ui_list(filter?)
```

```
ui_list()                                        # all open UI objects
ui_list({type: "query_editor"})                  # all query editor tabs
ui_list({type: "table_form", connectionId: 1})   # table forms for connection 1
ui_list({keyword: "orders"})                     # search by title/id
```

Returns: `[{ objectId, type, title, connectionId }]`

## Tab Discovery Strategy

1. Check `ui_read(object, "active", "state")` for current context
2. If target not found → `ui_list({keyword: ..., type: ...})`
3. If not open → `ui_exec("workspace", "", "open", {type: ..., ...})`
4. Read with `ui_read(object, target, "state")`
