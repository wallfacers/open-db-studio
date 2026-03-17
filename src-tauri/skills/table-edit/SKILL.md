---
description: Table structure read and column comment write tools
triggers:
  - when active_tab.type is 'table_structure'
---

# table-edit Skill

Use these tools to read table column metadata and update column comments.

## Available Tools

### get_column_meta
Get column metadata (name, type, nullable, comment) for a table.
```
get_column_meta(connection_id: integer, table_name: string, database?: string)
```

### update_column_comment
Update a column's comment/description via ALTER TABLE. Requires Auto mode ON.
Supported databases: MySQL, PostgreSQL.
```
update_column_comment(connection_id: integer, table_name: string, column_name: string, comment: string, database?: string)
```
On success, returns a message with undo instructions.

## Write Operation Guidelines

- Always call `get_column_meta` first to read the current state before updating
- All writes are recorded in `change_history` for undo support
- In Auto OFF mode, the tool returns an error — use ACP `request_permission` first
- NOT supported: changing column type or column name (high risk, not exposed in this version)
