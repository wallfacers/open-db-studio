---
description: Metric definition read and write tools
triggers:
  - when active_tab.type is 'metric' or 'metric_list'
---

# metric-edit Skill

Use these tools to read and modify metric definitions.

## Available Tools

### get_metric
Get metric definition by ID.
```
get_metric(metric_id: integer)
```

### update_metric_definition
Update a metric's description or display_name. Requires Auto mode ON (or ACP confirmation in manual mode).
```
update_metric_definition(metric_id: integer, description?: string, display_name?: string)
```
On success, returns a message with undo instructions.

### create_metric
Create a new metric definition.
```
create_metric(connection_id: integer, name: string, display_name: string, table_name?: string, description?: string)
```

## Write Operation Guidelines

- All writes are recorded in `change_history` for undo support
- After a successful write, inform the user they can type "undo" to revert
- In Auto OFF mode, the tool will return an error — route through ACP `request_permission` instead
