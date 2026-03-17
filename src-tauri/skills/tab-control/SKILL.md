---
description: Tab navigation tools for searching, opening, and focusing tabs
triggers:
  - when active_tab target is not found
---

# tab-control Skill

Use these tools to navigate and manage editor tabs.

## Available Tools

### search_tabs
Search currently opened tabs by type or table name.
```
search_tabs(table_name?: string, type?: 'query'|'table'|'table_structure'|'metric'|'metric_list')
```

### get_tab_content
Get the content of a specific tab (SQL, table data, metric definition, etc.).
```
get_tab_content(tab_id: string)
```

### focus_tab
Switch focus to a specific tab.
```
focus_tab(tab_id: string)
```

### open_tab
Open a new tab for a table structure or metric. Waits for tab to be fully opened before returning.
```
open_tab(connection_id: integer, type: 'table_structure'|'metric'|'query', table_name?: string, database?: string, metric_id?: integer)
```
Returns `{ tab_id: string }` — use this tab_id for subsequent `get_tab_content` calls.

## Tab Discovery Strategy

1. Check `active_tab` context first
2. If target not in open tabs, call `search_tabs`
3. If still not found, call `search_db_metadata` (from db-read skill)
4. If found, call `open_tab` and wait for `tab_id` before proceeding
5. Then call `get_tab_content` with the returned `tab_id`
