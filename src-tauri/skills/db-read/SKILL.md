---
description: Database read tools for listing databases, tables, schema, and sample data
triggers:
  - always
---

# db-read Skill

Use these tools to read database metadata and content.

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

### search_db_metadata
Search database metadata from the cached tree (tables, views by name prefix/fuzzy match).
Only searches already-loaded nodes in the tree cache. If the target database was never expanded, returns empty.
```
search_db_metadata(keyword: string)
```

## Usage Guidelines

1. Always load this skill first — it provides foundational DB access
2. Use `search_db_metadata` to quickly find a table without knowing which connection/database it belongs to
3. If `search_db_metadata` returns empty, ask the user to expand the database node in the tree first
