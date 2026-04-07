---
description: Database read tools for listing connections, databases, tables, schema, sample data, executing queries, and monitoring tasks
triggers:
  - always
---

# db-read Skill

Use these tools to read database metadata and content.

## Context First

Before querying the database, read the current editor context to understand what the user is working on:
```
ui_read("query_editor", "active", "state")   # get current SQL content and context
```

## Available Tools

### list_connections
List all configured database connections. **Call this first when connection_id is unknown.**
```
list_connections()
```
Returns: `[{ id, name, driver, host, database_name }]`

### list_databases
List all databases for a connection.
```
list_databases(connection_id: integer)
```

### list_tables
List all tables in a database.
```
list_tables(connection_id: integer, database: string)
```

### list_views
List all views in a database.
```
list_views(connection_id: integer, database: string)
```

### list_procedures
List all stored procedures and functions in a database.
```
list_procedures(connection_id: integer, database: string)
```

### get_table_schema
Get column definitions, indexes, and foreign keys for a table.
```
get_table_schema(connection_id: integer, table: string, database?: string)
```

### get_table_sample
Get sample rows from a table (max 20 rows).
```
get_table_sample(connection_id: integer, table: string, database?: string, limit?: integer)
```

### execute_sql
Execute a read-only SQL query. Supports SELECT / WITH / SHOW only. Returns at most 100 rows.
```
execute_sql(connection_id: integer, sql: string, database?: string)
```

### Search database tree
Search already-loaded tree nodes (tables, views) by keyword.
```
ui_exec("db_tree", "active", "search", {keyword: "users", type: "table"})
```
Only searches nodes that have already been loaded. If the target database was never expanded, returns empty — ask the user to expand it first, or use `list_tables` instead.

## Task Management Tools

Use these to monitor import/export tasks.

### list_tasks
List import/export tasks with status, progress, and error info.
```
list_tasks(status?: "running"|"completed"|"failed"|"cancelled"|"pending", limit?: integer)
```
- `status`: omit to list all tasks
- `limit`: default 20, max 100

### get_task_detail
Get full details of a specific task — error message, per-row failures, output path, timing.
Use this to diagnose why a task failed.
```
get_task_detail(task_id: string)
```
`task_id` comes from `list_tasks` results.

## Usage Guidelines

1. Call `list_connections()` first when you don't know the connection_id
2. Call `ui_read("query_editor", "active", "state")` to get editor context (connection, database already selected)
3. Use `ui_exec("db_tree", "active", "search", {keyword: ...})` to quickly find a table without knowing which connection/database it belongs to
4. If db_tree search returns empty, use `list_tables` or ask the user to expand the database node
5. Call independent tools in parallel to improve efficiency (e.g., `get_table_schema` and `get_table_sample` simultaneously)
