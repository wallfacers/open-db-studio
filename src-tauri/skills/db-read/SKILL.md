---
description: Database read tools for listing databases, tables, schema, and sample data
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

### Search database tree
Search loaded tree nodes (tables, views) by keyword.
```
ui_exec("db_tree", "active", "search", {keyword: "users", type: "table"})
```
Only searches already-loaded tree nodes. If the target database was never expanded, returns empty; ask the user to expand it first.

## Usage Guidelines

1. Call `ui_read("query_editor", "active", "state")` first to get editor context
2. Use `ui_exec("db_tree", "active", "search", {keyword: ...})` to quickly find a table without knowing which connection/database it belongs to
3. If db_tree search returns empty, ask the user to expand the database node in the tree
