# Ghost Text with Layered Metadata — Design Spec

**Status:** Approved
**Date:** 2026-03-29
**Supersedes:** `2026-03-21-sql-ghost-text-design.md` (original ghost text spec)

## Overview

AI-powered inline SQL completion (Ghost Text) in Monaco editor. User stops typing for 600ms, LLM generates completion suggestion displayed as gray inline text. Tab to accept, Esc or continue typing to reject.

Key differentiator from original spec: **layered metadata injection** (Hot/Warm/Cold zones) with knowledge graph integration, cross-schema support, prefix caching, and adaptive timeout handling.

## Architecture — End-to-End Data Flow

```
User stops typing (600ms debounce)
       │
       ▼
┌─ Monaco InlineCompletionsProvider ──────────────────────┐
│  1. Prefix cache check                                   │
│     └─ Hit → return remaining text (zero latency)        │
│  2. Trigger condition checks                             │
│     └─ ghostTextEnabled? connected? content≥2? no sel?   │
│  3. Regex extract mentionedTables[]                      │
│     └─ FROM/JOIN/INTO/UPDATE/DELETE FROM → identifiers   │
│  4. Cancel previous in-flight request                    │
│  5. invoke('ai_inline_complete', {                       │
│       connectionId, sqlBefore, sqlAfter,                 │
│       mentionedTables, currentSchema, hint, database     │
│     })                                                   │
└──────────────────────────────────────────────────────────┘
       │
       ▼
┌─ Rust ai_inline_complete ───────────────────────────────┐
│  1. get_best_llm_config() → None = return ""             │
│  2. TimeoutTracker: should_skip() → return ""            │
│  3. Get dialect from connection config                   │
│  4. Layered metadata assembly:                           │
│     ├─ Hot: mentionedTables full detail (≤10 tables)     │
│     ├─ Warm: knowledge graph 1-hop (≤15 tables)          │
│     └─ Cold: remaining table names (≤200 tables)         │
│  5. Prompt assembly (include_str! template)              │
│  6. tokio::select! {                                     │
│       LLM call => postprocess → return text              │
│       5s timeout => record_timeout → return ""           │
│     }                                                    │
└──────────────────────────────────────────────────────────┘
       │
       ▼
┌─ Monaco Rendering ─────────────────────────────────────┐
│  • token.isCancellationRequested → discard               │
│  • Has content → gray Ghost Text inline display          │
│  • Tab → accept & insert                                 │
│  • Esc / continue typing → reject                        │
│  • Update prefix cache: { sqlBefore, result, timestamp } │
└──────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Silent degradation** — any failure (no LLM config, graph not ready, timeout, API error) returns empty string. Ghost Text never shows error messages.
2. **Single IPC** — one `invoke` call from frontend to backend per request.
3. **Prefix cache on frontend** — pure string comparison, no backend involved.
4. **Dual cancellation** — frontend `CancellationToken` + `AbortController`, Rust `tokio::select!`.

## Layered Metadata Assembly

### Three-Zone Structure

#### Hot Zone — Tables directly referenced in SQL

**Source:** `mentionedTables[]` from frontend regex extraction.

**Content:** Full detail per table.

```sql
-- [ACTIVE TABLES]
-- users (schema: public)
--   id: BIGINT (PK)
--   name: VARCHAR(100) -- username
--   role_id: INT (FK → roles.id)
--   created_at: TIMESTAMP DEFAULT now()
--   Indexes: uk_email (email, UNIQUE)
```

**Includes:** column name, type, PK flag, FK relation (→ target.column), default value, column comment, indexes.

**Limit:** Max 10 tables, ordered by SQL appearance.

#### Warm Zone — Knowledge graph 1-hop related tables

**Source:** `find_relevant_subgraph(mentionedTables, max_hops=1)`, excluding tables already in Hot zone.

**Content:** Condensed summary.

```sql
-- [RELATED TABLES]
-- roles (join path: users.role_id → roles.id)
--   id: BIGINT (PK)
--   name: VARCHAR(50)
--   level: INT
```

**Includes:** table name, join path description, all column names + types (no comments/indexes).

**Limit:** Max 15 tables, ordered by graph edge weight descending.

#### Cold Zone — Remaining visible tables

**Source:** `get_tables()` minus Hot and Warm zone tables.

**Content:** Table names only.

```sql
-- [OTHER TABLES]
-- public.logs, public.sessions, public.permissions, public.categories,
-- analytics.page_views, analytics.user_events, audit.change_log
```

**Format:** `schema.table` comma-separated.

**Limit:** Max 200 table names. Exceeding → alphabetical truncation with `... and N more`.

### Cross-Schema Handling

| Scenario | Behavior |
|----------|----------|
| Current schema tables | Hot/Warm zone: no schema prefix (e.g., `users`) |
| Other schema tables | Always schema-qualified (e.g., `analytics.page_views`) |
| Cold zone all tables | Uniform `schema.table` format |
| LLM completion result | Cross-schema references auto-qualified |

### Token Budget

| Zone | Typical Scale | Estimated Tokens |
|------|--------------|-----------------|
| Hot | 3 tables × 15 columns | ~600 |
| Warm | 5 tables × 10 columns | ~500 |
| Cold | 50 table names | ~200 |
| Prompt template + SQL context | — | ~500 |
| **Total** | | **~1800** |

Worst case (10 hot + 15 warm + 200 cold): ~3500 tokens. Hard limit: if `build_layered_context` output exceeds 4000 tokens, trim Cold first, then Warm.

### Rust Assembly Pseudocode

```rust
async fn build_layered_context(
    ds: &dyn DataSource,
    mentioned: &[String],
    current_schema: &str,
    connection_id: i64,
) -> String {
    // 1. Hot zone
    let hot_tables = mentioned.iter().take(10);
    let hot_details = futures::join_all(
        hot_tables.map(|t| ds.get_columns(t, current_schema))
    ).await;

    // 2. Warm zone
    let warm_tables = match find_relevant_subgraph(connection_id, mentioned, 1).await {
        Ok(sg) if !sg.nodes.is_empty() => sg.nodes
            .into_iter()
            .filter(|n| !mentioned.contains(&n.name))
            .take(15)
            .collect(),
        _ => vec![],  // Graph not ready → empty warm zone
    };

    // 3. Cold zone
    let all_tables = ds.get_tables().await.unwrap_or_default();
    let hot_warm_set: HashSet<_> = /* hot + warm table names */;
    let cold_tables: Vec<_> = all_tables
        .iter()
        .filter(|t| !hot_warm_set.contains(&t.name))
        .take(200)
        .collect();

    // 4. Format
    format_hot(hot_details) + format_warm(warm_tables) + format_cold(cold_tables)
}
```

## Frontend: Regex Extraction & Prefix Cache

### Table Name Regex Extraction

```typescript
function extractMentionedTables(sql: string): string[] {
  const pattern = /(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([`"']?[\w]+[`"']?(?:\.[`"']?[\w]+[`"']?)?)/gi;

  const tables = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1].replace(/[`"']/g, '');
    if (!SQL_KEYWORDS.has(name.toUpperCase())) {
      tables.add(name);
    }
  }
  return Array.from(tables);
}
```

**Coverage:**

| SQL Fragment | Extracted |
|--------------|----------|
| `SELECT * FROM users` | `['users']` |
| `FROM public.users` | `['public.users']` |
| `JOIN orders ON ...` | `['orders']` |
| `LEFT JOIN analytics.events` | `['analytics.events']` |
| `INSERT INTO logs` | `['logs']` |
| `UPDATE products SET ...` | `['products']` |
| `DELETE FROM sessions` | `['sessions']` |

**Edge cases:**
- Subquery tables: naturally captured (`FROM (SELECT * FROM inner_table)` → `['inner_table']`)
- CTE names: extracted at `FROM cte`, backend silently skips when no metadata found
- Incomplete/invalid SQL: regex is syntax-agnostic, extracts what it can, empty list on failure (degrades to Cold-only)

### Prefix Cache

```typescript
interface GhostTextCache {
  sqlBefore: string;
  result: string;
  timestamp: number;
}

const ghostCacheRef = useRef<GhostTextCache | null>(null);

function tryPrefixCache(currentSqlBefore: string): string | null {
  const cache = ghostCacheRef.current;
  if (!cache || !cache.result) return null;
  if (Date.now() - cache.timestamp > 30_000) return null;  // 30s expiry

  if (!currentSqlBefore.startsWith(cache.sqlBefore)) return null;

  const typed = currentSqlBefore.slice(cache.sqlBefore.length);
  if (!cache.result.startsWith(typed)) return null;

  return cache.result.slice(typed.length);  // Remaining completion
}
```

**Example flow:**

1. Input: `"SELECT * FR"` → LLM returns `"OM users WHERE id = 1"` → cache stored
2. User types `"O"` → prefix hit → return `"M users WHERE id = 1"` (zero latency)
3. User types `"M "` → prefix hit → return `"users WHERE id = 1"`
4. User types `"p"` (diverges) → cache miss → new LLM request after 600ms debounce

### Concurrent Cancellation

```typescript
const abortRef = useRef<AbortController | null>(null);

async function provideInlineCompletions(model, position, context, token) {
  // 1. Cancel previous request
  abortRef.current?.abort();
  abortRef.current = new AbortController();

  // 2. Prefix cache check
  const cached = tryPrefixCache(sqlBefore);
  if (cached) return { items: [{ insertText: cached }] };

  // 3. Monaco cancellation listener
  token.onCancellationRequested(() => abortRef.current?.abort());

  // 4. Backend call
  const result = await invoke('ai_inline_complete', { ... });

  // 5. Update cache
  ghostCacheRef.current = { sqlBefore, result, timestamp: Date.now() };

  return result ? { items: [{ insertText: result }] } : { items: [] };
}
```

## Prompt Template

File: `prompts/sql_inline_complete.txt`

```
You are a SQL completion engine. Output ONLY the raw completion text.

Rules:
- Do NOT repeat any text before the cursor
- Do NOT wrap output in code blocks, backticks, or markdown
- Do NOT add explanations, comments, or annotations
- If no meaningful completion can be inferred, output nothing
- Strictly follow the SQL dialect: {{DIALECT}}

{{MODE_INSTRUCTION}}

=== Database Schema ===

{{SCHEMA_CONTEXT}}

=== Editor Content ===
{{SQL_BEFORE}}<cursor>{{SQL_AFTER}}
```

### Placeholder Rules

| Placeholder | Source | Truncation |
|-------------|--------|-----------|
| `{{DIALECT}}` | Connection config driver field | — |
| `{{MODE_INSTRUCTION}}` | Frontend `hint` parameter | See table below |
| `{{SCHEMA_CONTEXT}}` | `build_layered_context()` output | 4000 token hard limit |
| `{{SQL_BEFORE}}` | Frontend, text before cursor | Last 2000 chars |
| `{{SQL_AFTER}}` | Frontend, text after cursor | First 500 chars |

### MODE_INSTRUCTION Values

```typescript
const lineBeforeCursor = model.getLineContent(position.lineNumber)
  .slice(0, position.column - 1);
const hint = lineBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';
```

| hint | MODE_INSTRUCTION |
|------|-----------------|
| `single_line` | `Complete the current line only. Do not add newlines.` |
| `multi_line` | `Complete the full SQL statement from the cursor position. Use newlines for readability.` |

## LLM Integration

### Rust Command Signature

```rust
#[tauri::command]
pub async fn ai_inline_complete(
    connection_id: i64,
    sql_before: String,
    sql_after: String,
    mentioned_tables: Vec<String>,
    current_schema: String,
    hint: String,
    database: Option<String>,
) -> Result<String, String>
```

### LlmClient Extension

```rust
pub async fn inline_complete(&self, prompt: String) -> AppResult<String> {
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
    }];

    self.chat_with_params(messages, ChatParams {
        temperature: Some(0.1),   // High determinism
        max_tokens: Some(200),    // Limit output length
        stop: Some(vec!["\n\n".to_string(), ";".to_string()]),
    }).await
}
```

### LLM Config Selection

New function `get_best_llm_config()` in `db/mod.rs`:

**Priority:** `(is_default=1 AND test_status='success')` → `(test_status='success' first match)` → `None`

Never uses `test_status='untested'` configs.

### Result Postprocessing

```rust
fn postprocess_completion(raw: &str, sql_before: &str) -> String {
    let mut result = raw.trim().to_string();

    // 1. Strip markdown code block wrappers
    if result.starts_with("```") {
        result = result
            .trim_start_matches("```sql")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string();
    }

    // 2. Remove duplicated prefix (LLM may repeat tail of sql_before)
    let before_tail = &sql_before[sql_before.len().saturating_sub(50)..];
    for overlap_len in (1..=before_tail.len()).rev() {
        let tail = &before_tail[before_tail.len() - overlap_len..];
        if result.starts_with(tail) {
            result = result[overlap_len..].to_string();
            break;
        }
    }

    // 3. Strip leading blank lines
    result = result.trim_start_matches('\n').to_string();

    result
}
```

## Knowledge Graph: Incremental Refresh

### Refresh Triggers

| Event | Behavior |
|-------|----------|
| First database connection | Full graph build (background, non-blocking) |
| While connected | Incremental check every 5 minutes |
| DDL execution (CREATE/ALTER/DROP) | Immediate incremental refresh |
| Switch database/schema | Check if target graph exists, build if not |

### Incremental Detection

```rust
async fn refresh_schema_graph(connection_id: i64, database: Option<String>) {
    let current_tables = ds.get_tables().await;
    let graph_nodes = get_graph_nodes(connection_id, "table");

    let added = current_tables.difference(&graph_nodes);
    let removed = graph_nodes.difference(&current_tables);
    let unchanged = current_tables.intersection(&graph_nodes);

    // Column change detection via name-list hash
    let modified = check_column_changes(&unchanged).await;

    for table in added { add_node_with_edges(table).await; }
    for table in removed { remove_node_and_edges(table).await; }
    for table in modified { update_node_edges(table).await; }
}
```

**Optimization:** Column change detection uses `SHA256(sorted column names)` hash comparison. Full column fetch only when hash mismatch. Typical 100-table incremental check: <200ms.

### DDL Auto-Trigger

In `execute_query` command, after successful execution:

```rust
let sql_upper = sql.trim().to_uppercase();
if sql_upper.starts_with("CREATE")
    || sql_upper.starts_with("ALTER")
    || sql_upper.starts_with("DROP")
{
    tokio::spawn(async move {
        let _ = refresh_schema_graph(connection_id, database).await;
    });
}
```

### Frontend Timer Management

```typescript
const graphTimers = useRef<Map<number, NodeJS.Timeout>>(new Map());

function startGraphRefreshTimer(connectionId: number) {
  if (graphTimers.current.has(connectionId)) return;
  const timer = setInterval(() => {
    invoke('refresh_schema_graph', { connectionId });
  }, 5 * 60 * 1000);
  graphTimers.current.set(connectionId, timer);
}

function stopGraphRefreshTimer(connectionId: number) {
  const timer = graphTimers.current.get(connectionId);
  if (timer) { clearInterval(timer); graphTimers.current.delete(connectionId); }
}
```

**Lifecycle:** Connection established → start timer + initial full build. Connection closed → stop timer. App exit → clear all.

## Three-Layer Switch

| Layer | Storage | Operator | Scope |
|-------|---------|----------|-------|
| Global Default | SQLite `ui_state` (`key = 'ghost_text_default'`) | Settings page | New tab default |
| Per-Tab State | `queryStore` Tab metadata (`ghostTextEnabled`) | Toolbar button | Current tab only |
| Fallback | `queryStore` deserialization | Automatic | `undefined` → use global |

### Tab Interface Extension

```typescript
interface Tab {
  // ... existing fields
  ghostTextEnabled?: boolean;  // undefined = use global default
}
```

### Store Extensions

```typescript
// queryStore.ts
toggleGhostText: (tabId) => set(state => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.ghostTextEnabled = !state.isGhostTextEnabled(tabId);
}),

isGhostTextEnabled: (tabId) => {
  const tab = get().tabs.get(tabId);
  if (tab?.ghostTextEnabled !== undefined) return tab.ghostTextEnabled;
  return useAppStore.getState().ghostTextDefault;
},

// appStore.ts
ghostTextDefault: true,
setGhostTextDefault: async (v) => {
  set({ ghostTextDefault: v });
  await invoke('set_ui_state', { key: 'ghost_text_default', value: String(v) });
},
```

### UI Elements

**Toolbar button:** Sparkles icon (lucide-react), highlighted when active, gray when off. Tooltip: `AI Completion (Tab to accept)`.

**Settings page:** General section, toggle switch labeled "AI Inline Completion" with description: "Enable AI-powered ghost text suggestions in SQL editor. New tabs will use this setting by default."

## Error Handling

| Scenario | Handling | User Perception |
|----------|---------|-----------------|
| No LLM config | `get_best_llm_config()` → None → `""` | No Ghost Text |
| LLM untested (`test_status = 'untested'`) | Skipped | No Ghost Text |
| LLM API error (401/429/500) | catch → `""` | No Ghost Text |
| LLM timeout (>5s) | `tokio::time::timeout` → `""` | No Ghost Text |
| User continues typing | CancellationToken + abort | Old suggestion disappears |
| Database disconnected | pool_cache fails → `""` | No Ghost Text |
| Knowledge graph not ready | Warm zone empty, Hot+Cold work | Slightly lower quality |
| `get_tables()` fails | Cold zone empty, Hot works | Only mentioned tables |
| Regex extracts nothing | `mentionedTables = []` → Hot+Warm empty, Cold full | LLM uses SQL context + table names |
| LLM returns code block | Postprocess: strip wrappers | Clean completion |
| LLM repeats cursor prefix | Postprocess: remove overlap | Clean completion |

## Performance

### Latency Budget (Target: first char <1.5s)

| Phase | Budget | Notes |
|-------|--------|-------|
| Debounce | 600ms | Fixed wait |
| Frontend regex + invoke | <10ms | Pure computation + IPC |
| Rust metadata assembly | <50ms | Memory/local DB queries |
| Prompt assembly | <5ms | String replacement |
| LLM first token | 300-800ms | Model & prompt size dependent |
| **Total** | **~1-1.5s** | User-perceived |

### Safeguards

1. **Token budget hard limit** — `build_layered_context` output >4000 tokens → trim Cold first, then Warm.

2. **Request deduplication** — identical `(sqlBefore, mentionedTables)` not re-sent.

3. **Metadata cache** — Rust-side 30s TTL cache for `get_tables()` and `get_columns()` results. Avoids repeated database queries during high-frequency Ghost Text triggers.

4. **Concurrency limit** — Max 1 in-flight Ghost Text request per connection. New request cancels old.

5. **Adaptive timeout** — 3 consecutive timeouts → pause Ghost Text for 60s on that connection.

```rust
struct TimeoutTracker {
    consecutive_timeouts: u32,
    paused_until: Option<Instant>,
}

impl TimeoutTracker {
    fn should_skip(&self) -> bool {
        self.paused_until.map_or(false, |t| Instant::now() < t)
    }
    fn record_timeout(&mut self) {
        self.consecutive_timeouts += 1;
        if self.consecutive_timeouts >= 3 {
            self.paused_until = Some(Instant::now() + Duration::from_secs(60));
        }
    }
    fn record_success(&mut self) {
        self.consecutive_timeouts = 0;
        self.paused_until = None;
    }
}
```

## File Change Manifest

### New Files

| File | Purpose |
|------|---------|
| `prompts/sql_inline_complete.txt` | Ghost Text prompt template |

### Modified Files

| File | Changes |
|------|---------|
| **Rust Backend** | |
| `src-tauri/src/commands.rs` | Add `ai_inline_complete` command + DDL post-exec `refresh_schema_graph` trigger |
| `src-tauri/src/lib.rs` | Register `ai_inline_complete` in `generate_handler!` |
| `src-tauri/src/llm/client.rs` | Add `inline_complete()` method + `ChatParams` (temperature/max_tokens/stop) |
| `src-tauri/src/db/mod.rs` | Add `get_best_llm_config()` function |
| `src-tauri/src/datasource/mod.rs` | Add `MetaCache` struct (30s TTL metadata cache) |
| `src-tauri/src/graph/mod.rs` | Add `refresh_schema_graph()` incremental refresh |
| **Frontend** | |
| `src/components/MainContent/index.tsx` | InlineCompletionsProvider + regex extraction + prefix cache + cancellation + toolbar button |
| `src/types/index.ts` | Tab interface: add `ghostTextEnabled?: boolean` |
| `src/store/queryStore.ts` | Add `toggleGhostText()` + `isGhostTextEnabled()` |
| `src/store/appStore.ts` | Add `ghostTextDefault` + `setGhostTextDefault()` |
| `src/store/connectionStore.ts` | Add `startGraphRefreshTimer()` / `stopGraphRefreshTimer()` |
| `src/components/Settings/SettingsPage.tsx` | General section: AI Inline Completion toggle |

### Unchanged Files

| File | Reason |
|------|--------|
| `src-tauri/src/datasource/postgres.rs` etc. | Existing `get_tables()`/`get_columns()`/`get_foreign_keys()` sufficient |
| `src-tauri/src/graph/` query logic | `find_relevant_subgraph()` already exists and reusable |
| Other `prompts/` templates | Not affected |

### Relationship to Original Spec

This spec supersedes `2026-03-21-sql-ghost-text-design.md`. Key differences:

| Aspect | Original | This Design |
|--------|----------|-------------|
| Metadata injection | Frontend passes flat `schemaContext` string | Backend one-stop layered assembly (Hot/Warm/Cold) |
| Knowledge graph | Not involved | Warm zone uses `find_relevant_subgraph` |
| Cross-schema | Not addressed | Cold zone includes all schemas, `schema.table` format |
| Graph refresh | Manual trigger | Timed incremental + DDL auto-trigger |
| Prefix cache | Not addressed | Frontend prefix matching, zero-latency on hit |
| Cancellation | Monaco CancellationToken only | CancellationToken + AbortController dual insurance |
| Metadata cache | None | Rust-side 30s TTL cache |
| Timeout adaptation | Fixed 5s | 3 consecutive timeouts → 60s pause |
| Result postprocessing | None | Strip code blocks + remove duplicated prefix |
