---
description: Table structure read and column comment write tools
triggers:
  - when active_tab.type is 'table_structure'
---

# table-edit Skill

Use fs_* tools to read table column metadata and update column comments.

## Available Tools

### Read column metadata
Get column metadata (name, type, nullable, comment) for a table.
Target format: `table_name@conn:N` or `table_name@conn:N@db:mydb` for multi-database.
```
fs_read("tab.table", "users@conn:1", "struct")
fs_read("tab.table", "users@conn:1@db:app", "struct")
```
Returns column list with name, data_type, nullable, comment, etc.

### Update column comment
Update a column's comment/description. Requires Auto mode ON.
Supported databases: MySQL, PostgreSQL.
```
fs_write("tab.table", "users@conn:1", {
  "column_name": "user_id",
  "comment": "用户唯一标识"
})
```
Or struct patch format:
```
fs_write("tab.table", "users@conn:1", {
  "mode": "struct",
  "path": "/user_id/comment",
  "value": "用户唯一标识"
})
```
Returns `{ "success": true, "message": "..." }` on success.
Undo via `fs_exec("panel.history", "active", "undo")`.

### Open table structure tab
```
fs_open("tab.table", { table: "users", database: "app", connection_id: 1 })
```

## Write Operation Guidelines

- Always call `fs_read` first to read current state before updating
- In Auto OFF mode, returns error "Auto 模式已关闭" — do not retry without user action
- NOT supported: changing column type or column name (high risk, not exposed in this version)
- All writes are recorded in change history and can be undone
