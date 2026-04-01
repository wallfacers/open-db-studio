---
description: Table structure read, column editing, and table creation via UI Object Protocol
triggers:
  - when active_tab.type is 'table_structure'
---

# table-edit Skill

Use `ui_*` tools to read table column metadata, edit table structure, and create new tables.

## Available Tools

### Read column metadata
Get current table form state (columns, tableName, engine, charset).
```
ui_read("table_form", "active", "state")
ui_read("table_form", "<tabId>", "state")
```

### Read patchable schema
Get JSON Schema describing what fields can be patched.
```
ui_read("table_form", "active", "schema")
```

### Patch table structure
Use JSON Patch (RFC 6902) to modify the table form. Supports `[name=xxx]` addressing for columns.
```json
ui_patch("table_form", "active", [
  {"op": "replace", "path": "/tableName", "value": "orders"},
  {"op": "add", "path": "/columns/-", "value": {"name": "total", "dataType": "DECIMAL", "length": "10,2"}},
  {"op": "replace", "path": "/columns[name=user_id]/comment", "value": "user unique ID"},
  {"op": "remove", "path": "/columns[name=temp_col]"}
], "update table structure")
```

### Preview SQL
Generate CREATE TABLE or ALTER TABLE SQL without executing.
```
ui_exec("table_form", "active", "preview_sql")
```

### Save (generate SQL to query tab)
```
ui_exec("table_form", "active", "save")
```

### Open table structure tab
```
ui_exec("workspace", "", "open", {type: "table_form", connection_id: 1, database: "app", table: "users"})
ui_exec("workspace", "", "open", {type: "table_form", connection_id: 1, database: "app"})  # new table
```

## Multi-round Editing Workflow

1. Open table form: `ui_exec("workspace", "", "open", {type: "table_form", ...})`
2. Read current state: `ui_read("table_form", "active", "state")`
3. Patch fields iteratively: `ui_patch("table_form", "active", [...])`
4. Preview SQL: `ui_exec("table_form", "active", "preview_sql")`
5. Repeat 2-4 as needed based on user feedback

## Guidelines

- Always call `ui_read` first to read current state before patching
- Use `[name=xxx]` addressing for column operations (more stable than numeric indices)
- Use `test` op to guard against stale state: `{"op": "test", "path": "/tableName", "value": "expected"}`
- In Auto OFF mode, patches return `pending_confirm` — do not retry without user action
- All changes are recorded in history and can be undone
