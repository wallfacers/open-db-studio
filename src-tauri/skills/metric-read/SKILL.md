---
description: Metric definition read tools — list, search, and get metrics
triggers:
  - when user asks about metrics or business indicators
  - when active_tab.type is 'metric_list'
  - when asked to find, browse, or summarize metrics
---

# metric-read Skill

Use these tools to discover and read metric definitions stored in the app.

## Available Tools

### list_metrics
List all metrics for a connection. Optionally filter by status or scope.
```
list_metrics(
  connection_id: integer,
  status?: "draft" | "approved" | "rejected",
  database?: string,
  schema?: string,
  limit?: integer   -- default 50, max 200
)
```

### search_metrics
Search **approved** metrics by keyword. Matches against name, display_name, and description.
Multiple space-separated words are ANDed.
```
search_metrics(connection_id: integer, keyword: string)
```

### get_metric
Get the full definition of a single metric by its ID.
```
get_metric(metric_id: integer)
```
> This tool is provided by the `metric-edit` skill. You do not need to load that skill just to read.

## Typical Workflow

1. **Browse all metrics** — use `list_metrics(connection_id)` to get an overview
2. **Find a specific metric** — use `search_metrics(connection_id, keyword)` to locate by name/description
3. **Inspect details** — use `get_metric(metric_id)` to read the full definition including `filter_sql`, `composite_components`, `data_caliber`, etc.

## Tips

- `list_metrics` without `status` returns all statuses. Use `status="approved"` to focus on production-ready metrics.
- `search_metrics` only searches **approved** metrics. To search drafts too, use `list_metrics` and filter client-side.
- `composite_components` is a JSON string. Parse it to get the list of sub-metric IDs for composite metrics.
- `scope_database` / `scope_schema` indicate which data scope the metric belongs to — use the `database` / `schema` params in `list_metrics` to narrow down.
