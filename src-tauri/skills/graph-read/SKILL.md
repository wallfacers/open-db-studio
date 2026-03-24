---
description: Knowledge graph disambiguation tools for resolving table relationships, join paths, and field ambiguity when generating multi-table SQL
triggers:
  - when user question involves multi-table joins or relationships
  - when table name or field name is ambiguous
  - when generating SQL that requires understanding foreign key paths
  - when user asks about table connections or relationships
  - always
---

# graph-read Skill

Use these tools to query the knowledge graph built in GraphExplorer.
The graph stores table relationships (FK, inferred, user-defined), business aliases, and metric nodes — use it to **disambiguate** before generating SQL.

## Available Tools

### graph_query_context (start here)
One-shot coarse-grained context retrieval. Call this **first** when the question involves multi-table joins, ambiguous table/field names, or unknown relationships. Returns relevant tables, structured JOIN paths, and matched metrics in a single response.
```
graph_query_context(question: string, connection_id: integer)
```
Returns:
```json
{
  "relevant_tables": ["orders", "users"],
  "join_paths": [
    {
      "path": "orders → users",
      "via": "orders.user_id = users.id",
      "cardinality": "N:1",
      "on_delete": "CASCADE",
      "description": "每笔订单归属一个用户",
      "sql_hint": "JOIN users u ON o.user_id = u.id"
    }
  ],
  "schema_ddl": "...",
  "metrics": ["monthly_revenue = SUM(orders.amount): ..."],
  "context_quality": "graph_hit"
}
```
`context_quality` values:
- `graph_hit` — graph matched, high confidence
- `fts_fallback` — no exact graph match, fell back to full-text search
- `schema_only` — FTS also missed, only raw table list available
- `empty` — graph not built for this connection

### graph_search_tables
Fuzzy-search table names, aliases, and display names in the graph.
Differs from `list_tables`: this searches **user-defined business aliases**, not raw database table names.
```
graph_search_tables(question: string, connection_id: integer)
```

### graph_find_join_paths
Find the shortest JOIN path between two tables via Link Nodes (two-hop: table → link → table). Returns structured paths with cardinality, via field, and semantic description.
```
graph_find_join_paths(from_table: string, to_table: string, connection_id: integer, max_depth?: integer)
```
- `max_depth`: default 4, max 6 (logical hops, each hop = table→link→table)
- Returns `{ paths: [...], no_path: bool }`

### graph_get_ddl
Get a compact CREATE TABLE DDL (columns, types, comments only) for a table, sourced from the graph node metadata. Better suited for SQL generation prompts than `get_table_schema`.
```
graph_get_ddl(table_name: string, connection_id: integer)
```

### graph_search_metrics
Search metric nodes in the graph by keyword. Returns metric name, display name, table, description, and calculation formula.
Differs from `search_metrics` (metric-read skill): this searches **graph nodes** (`node_type=metric`), not the MetricsExplorer approved records.
```
graph_search_metrics(keyword: string, connection_id: integer)
```

## Usage Strategy

```
User question arrives
  │
  ├─ Involves multi-table / ambiguous names / unknown joins?
  │    YES → call graph_query_context(question, connection_id)
  │           │
  │           ├─ context_quality = "graph_hit"
  │           │    → Use join_paths + relevant_tables directly for SQL generation
  │           │    → Need column details? → graph_get_ddl(table_name, connection_id)
  │           │    → Need exact path between two specific tables? → graph_find_join_paths(from, to, connection_id)
  │           │
  │           ├─ context_quality = "fts_fallback"
  │           │    → Results are approximate; verify with graph_search_tables or get_table_schema
  │           │
  │           └─ context_quality = "empty" / "schema_only"
  │                → Graph not available; fall back to list_tables + get_table_schema (db-read skill)
  │
  └─ Simple single-table query?
       NO graph tools needed → use db-read skill directly

```

## Key Principles

1. **graph_query_context first** — it combines subgraph retrieval, join path inference, and metric matching in one call; avoid calling fine-grained tools redundantly
2. **Respect context_quality** — do not hallucinate join conditions when quality is `empty` or `schema_only`; ask the user or fall back to db-read
3. **sql_hint is authoritative** — when `join_paths[].sql_hint` is present, use it directly in generated SQL rather than guessing the JOIN condition
4. **Do not confuse graph tools with db-read tools** — graph tools query the knowledge graph (user-curated relationships + inferred links); db-read tools query the live database catalog
5. **Link Node awareness** — the graph uses a Palantir-style two-hop structure (table → link → table); Link Nodes carry `cardinality`, `via`, `description` — never treat a Link Node id as a real table name
