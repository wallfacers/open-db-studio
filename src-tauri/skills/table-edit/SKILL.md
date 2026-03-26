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
```
fs_read("tab.table", "table_name@conn:N", "struct")
fs_read("tab.table", "table_name",        "struct")   # single-connection shorthand
```
Returns `{ type:"table", name, columns:[{ name, type, nullable, comment }] }`.

### Update column comment
Update a column's comment/description. Requires Auto mode ON.
Supported databases: MySQL, PostgreSQL.
```
fs_write("tab.table", "table_name@conn:N", {
  "mode": "struct",
  "path": "/columns/N/comment",
  "value": "new comment text"
})
```
Returns `{ status: "applied" }` on success. Undo via `fs_exec("tab.query","active","undo")`.

## Write Operation Guidelines

- Always call `fs_read` first to read current state before updating
- In Auto OFF mode, the Adapter returns `{ status:"error", message:"需要开启 Auto 模式" }` — do not retry without user action
- NOT supported: changing column type or column name (high risk, not exposed in this version)
