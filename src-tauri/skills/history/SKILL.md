---
description: Change history and undo tools for the current session
triggers:
  - when user message contains undo/restore/rollback
---

# history Skill

Use these tools to view and undo changes made in the current session.

## Available Tools

### get_change_history
Get the change history for the current session (LIFO order).
```
get_change_history(limit?: integer)
```
Returns records with `id`, `tool_name`, `target_type`, `target_id`, `status`, `created_at`.

### undo_last_change
Undo the last successful change in the current session (LIFO).
Only processes records with `status='success'`. Requires Auto mode ON.
```
undo_last_change()
```

## Undo Scope

- Scoped to the current session_id — cannot undo changes from other sessions
- LIFO order — always undoes the most recent successful change
- NOT undoable: `status='failed'` records, column type/name changes

## Response Pattern

After undo succeeds, confirm to the user what was reverted and the previous value.
