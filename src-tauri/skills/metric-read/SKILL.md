---
description: Read metric definitions — list, search, inspect, and translate metrics into executable SQL
triggers:
  - when user asks about metrics or business indicators
  - when active_tab.type is 'metric_list' or 'metric'
  - when user wants to query data using a named metric
  - when user asks to find, browse, explain, or summarize metrics
  - when user references a metric by name in a question
  - when generating SQL that should respect metric definitions
---

# metric-read Skill

Use these tools to discover, read, and interpret metric definitions, and to translate them into executable SQL when needed.

---

## Available Tools

### list_metrics
List all metrics for a connection. Optionally filter by status or data scope.
```
list_metrics(
  connection_id: integer,
  status?: "draft" | "approved" | "rejected",  -- omit to return all statuses
  database?: string,   -- filter by scope_database
  schema?: string,     -- filter by scope_schema
  limit?: integer      -- default 50, max 200
)
```

### search_metrics
Search **approved** metrics by keyword. Matches against `name`, `display_name`, and `description`.
Multiple space-separated words are ANDed.
```
search_metrics(connection_id: integer, keyword: string)
```
> Only searches approved metrics. To search drafts, use `list_metrics` and filter client-side.

### get_metric
Get the full definition of a single metric by ID.
```
get_metric(metric_id: integer)
```
> Provided by the `metric-edit` skill. Can be called directly without loading that skill.

---

## Field Reference

| Field | Description |
|-------|-------------|
| `name` | Programmatic identifier (English, snake_case) |
| `display_name` | Human-readable label |
| `table_name` | Source table the metric is computed from |
| `column_name` | Column to aggregate (required for atomic metrics) |
| `aggregation` | Aggregation function: `SUM` / `COUNT` / `AVG` / `MAX` / `MIN` / `CUSTOM` |
| `filter_sql` | WHERE clause fragment (no `WHERE` keyword), e.g. `status = 'paid'` |
| `description` | Business definition of the metric |
| `status` | `draft` / `approved` / `rejected` |
| `metric_type` | `atomic` (single aggregation) or `composite` (derived from other metrics) |
| `composite_components` | JSON array of sub-metric references; only present on composite metrics |
| `composite_formula` | Computation formula referencing sub-metric `name` fields, e.g. `revenue / order_count` |
| `category` | Business domain tag |
| `data_caliber` | Statistical caliber notes (dedup logic, inclusion rules, etc.) |
| `scope_database` / `scope_schema` | Data scope this metric belongs to; null means applies to all scopes |

### composite_components format
```json
[
  { "metric_id": 12, "metric_name": "revenue",      "display_name": "Revenue" },
  { "metric_id": 15, "metric_name": "order_count",  "display_name": "Order Count" }
]
```
The calculation formula is stored in `composite_formula`, referencing `metric_name`, e.g. `revenue / order_count`.

---

## Translating a Metric to SQL

### Atomic metric → SQL
```sql
-- Template
SELECT {aggregation}({column_name}) AS {name}
FROM {table_name}
[WHERE {filter_sql}]

-- Example: { table_name:"orders", column_name:"amount", aggregation:"SUM", filter_sql:"status='paid'" }
SELECT SUM(amount) AS paid_revenue
FROM orders
WHERE status = 'paid'
```

### CUSTOM aggregation
When `aggregation = 'CUSTOM'`, the full SQL expression is stored in `filter_sql` or `description`.
Use that expression directly — do not wrap it in `AGG(column)`.

### Composite metric → SQL
1. Call `get_metric` for each entry in `composite_components` to retrieve sub-metric definitions.
2. Translate each sub-metric into a CTE or subquery.
3. Combine results using `composite_formula`.

```sql
-- Example: composite_formula = "revenue / order_count"
WITH
  revenue     AS (SELECT SUM(amount) AS v FROM orders WHERE status = 'paid'),
  order_count AS (SELECT COUNT(*) AS v FROM orders WHERE status = 'paid')
SELECT revenue.v / order_count.v AS conversion_rate
FROM revenue, order_count
```

---

## Typical Workflows

### Browse all metrics
1. `list_metrics(connection_id)` — get an overview of all metrics.
2. Group by `category` or `status` when presenting to the user.
3. Use `get_metric(id)` for details on specific entries.

### User references a metric by name, wants to query data
1. `search_metrics(connection_id, keyword)` — locate the metric.
2. `get_metric(metric_id)` — retrieve the full definition.
3. Build SQL from the fields (see translation rules above).
4. For composite metrics, recursively fetch sub-metrics before assembling the final query.

### Generate SQL that respects metric definitions
1. `search_metrics` first to confirm whether the business term maps to a defined metric.
2. Use `filter_sql` and `aggregation` from the metric to ensure caliber consistency.
3. Annotate the generated SQL with the metric source, e.g. `-- metric: paid_revenue (id=12)`.

### Explain a metric's business meaning
1. `get_metric(metric_id)` — fetch the full definition.
2. Highlight `description` (business intent), `data_caliber` (statistical rules), and `filter_sql` (inclusion criteria) in your response.

---

## Notes

- Prefer `approved` metrics for SQL generation. Use `draft` metrics for reference only.
- `scope_database` / `scope_schema` being null means the metric applies to all scopes.
- For Chinese metric names, match against `display_name` first; for English identifiers, match `name`.
- Always annotate generated SQL with the originating metric ID and name for traceability.
