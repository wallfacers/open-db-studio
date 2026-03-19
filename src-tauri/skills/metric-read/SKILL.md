---
description: Resolve ambiguity in natural language queries using metric definitions, and generate accurate SQL

triggers:
  - when user asks about metrics or business indicators
  - when user references a metric name
  - when generating SQL from natural language
  - when user query contains ambiguous business terms
  - when active_tab.type is 'metric_list' or 'metric'
---

# metric-read Skill

Use metric definitions as the **single source of truth** to interpret user intent and generate SQL.
Primary goal: **eliminate ambiguity before SQL generation**.


## Core Principles

- Never guess metric logic
- Always resolve business ambiguity via metric definitions
- Prefer **approved metrics**
- If ambiguity remains → **ask for clarification before generating SQL**


## Disambiguation Strategy (Critical)

When user input is ambiguous (e.g. “revenue”, “orders”, “users”):

1. Identify all possible metric candidates
2. Resolve using priority:
    1. exact match on `name` or `display_name`
    2. approved metrics over draft/rejected
    3. metrics with explicit `filter_sql` / clear `description`
    4. context consistency (table, domain, prior query)
3. If multiple valid matches remain:
    - do NOT pick arbitrarily
    - ask user to clarify


## Available Tools

### list_metrics
List metrics (optionally filtered).
```

list_metrics(connection_id, status?, database?, schema?, limit?)

```

### search_metrics
Search **approved** metrics by keyword (AND logic).
```

search_metrics(connection_id, keyword)

```

### get_metric
Get full metric definition.
```

get_metric(metric_id)

````



## SQL Generation Rules (Strict)

### 1. Always map query → metric
- Do NOT directly translate natural language to SQL
- MUST go through metric resolution first

### 2. Atomic metric → SQL
```sql
SELECT {aggregation}({column_name}) AS {name}
FROM {table_name}
[WHERE {filter_sql}]
````

### 3. CUSTOM metric

* Use expression directly from definition
* Do NOT wrap with aggregation

### 4. Composite metric

* Resolve ALL sub-metrics via `get_metric`
* Build using CTEs
* Apply `composite_formula` strictly



## Ambiguity Handling

| Situation                     | Action                                        |
| -- |  |
| Term maps to 1 metric         | Use it                                        |
| Term maps to multiple metrics | Ask clarification                             |
| No matching metric            | Ask or fallback (explicitly state assumption) |
| Metric exists but is draft    | Warn user                                     |



## Output Format

When generating SQL:

1. **Metric Interpretation**

    * resolved metric name(s)
    * disambiguation reasoning (brief)

2. **SQL**

```sql
-- metric: {name} (id={id})
SELECT ...
```

## Metric Understanding

Key fields to use:

* `aggregation` → defines aggregation logic
* `filter_sql` → defines inclusion rules (critical for disambiguation)
* `description` → business meaning
* `data_caliber` → statistical constraints
* `composite_formula` → final computation logic



## Best Practices

* Treat `filter_sql` as part of metric identity (not optional)
* Do NOT override metric logic with user assumptions
* Prefer consistency over flexibility
* Ensure all SQL is traceable to metric definitions