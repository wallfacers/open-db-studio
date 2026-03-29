# Ghost Text with Layered Metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement AI-powered inline SQL completion (Ghost Text) with three-zone layered metadata injection (Hot/Warm/Cold), knowledge graph integration, cross-schema support, prefix caching, and adaptive timeout handling.

**Architecture:** Frontend (Monaco InlineCompletionsProvider) extracts table names via regex, sends a single IPC call to Rust backend. Backend assembles layered metadata context, calls LLM with prompt template, postprocesses result. Frontend caches results for prefix matching and guards against stale responses.

**Tech Stack:** Tauri 2.x, React 18, TypeScript, Monaco Editor, Zustand, Rust (tokio, reqwest, rusqlite, sha2)

**Spec:** `docs/superpowers/specs/2026-03-29-ghost-text-layered-metadata-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `prompts/sql_inline_complete.txt` | LLM prompt template for inline completion |
| `src-tauri/src/llm/inline_complete.rs` | Layered context assembly, postprocessing, MetaCache, TimeoutTracker. **Deviation from spec:** spec places MetaCache in `datasource/mod.rs`, but we co-locate it here with its sole consumer for locality and encapsulation. |

### Modified Files
| File | Changes |
|------|---------|
| `src-tauri/src/llm/mod.rs` | Add `pub mod inline_complete;` |
| `src-tauri/src/llm/client.rs` | Add `ChatParams`, `chat_with_params()`, `chat_openai_with_params()`, `chat_anthropic_with_params()`, `inline_complete()` |
| `src-tauri/src/db/mod.rs` | Add `get_best_llm_config()` |
| `src-tauri/src/graph/mod.rs` | Add `refresh_schema_graph()` |
| `src-tauri/src/commands.rs` | Add `ai_inline_complete` + `refresh_schema_graph` commands + DDL auto-trigger in `execute_query` + invalidate hooks in connection delete/update |
| `src-tauri/src/lib.rs` | Register `ai_inline_complete` + `refresh_schema_graph` in `generate_handler!` |
| `src/types/index.ts` | Add `ghostTextEnabled?: boolean` to Tab |
| `src/store/appStore.ts` | Add `ghostTextDefault` + `setGhostTextDefault()` |
| `src/store/queryStore.ts` | Add `toggleGhostText()` + `isGhostTextEnabled()` |
| `src/store/connectionStore.ts` | Add graph refresh timer management |
| `src/components/MainContent/index.tsx` | InlineCompletionsProvider + regex + prefix cache + toolbar button |
| `src/components/Settings/SettingsPage.tsx` | AI Inline Completion toggle in General section |

---

## Task 1: Prompt Template

**Files:**
- Create: `prompts/sql_inline_complete.txt`

- [ ] **Step 1: Create prompt template file**

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

- [ ] **Step 2: Commit**

```bash
git add prompts/sql_inline_complete.txt
git commit -m "feat(ghost-text): add inline completion prompt template"
```

---

## Task 2: LLM Client — ChatParams & chat_with_params

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Context:** The current `LlmClient` has `chat()` which dispatches to `chat_openai()` / `chat_anthropic()`. We need a parameterized variant that supports `temperature`, `max_tokens`, and `stop` sequences. The existing `chat_openai()` builds a JSON body with `model` and `messages` — we add optional fields. The existing `chat_anthropic()` uses `x-api-key` header and has a hardcoded `DEFAULT_ANTHROPIC_MAX_TOKENS` — we override when params specify.

- [ ] **Step 1: Add ChatParams struct**

Add after the existing struct definitions (around line 138-144):

```rust
/// Parameter overrides for LLM calls (used by inline completion)
#[derive(Default)]
pub struct ChatParams {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// OpenAI: maps to "stop" field. Anthropic: maps to "stop_sequences" field.
    pub stop: Option<Vec<String>>,
}
```

- [ ] **Step 2: Add `chat_openai_with_params` method**

Add a new method on `LlmClient`. Follow the pattern of existing `chat_openai()` (around line 253) but inject `ChatParams` fields into the request body JSON:
- If `params.temperature` is Some, add `"temperature": value` to body
- If `params.max_tokens` is Some, add `"max_tokens": value` to body
- If `params.stop` is Some, add `"stop": value` to body

- [ ] **Step 3: Add `chat_anthropic_with_params` method**

Follow the pattern of existing `chat_anthropic()` but:
- If `params.temperature` is Some, add `"temperature": value` to body
- If `params.max_tokens` is Some, use it; otherwise fall back to `DEFAULT_ANTHROPIC_MAX_TOKENS`
- If `params.stop` is Some, add `"stop_sequences": value` to body

- [ ] **Step 4: Add `chat_with_params` router method**

```rust
pub async fn chat_with_params(
    &self,
    messages: Vec<ChatMessage>,
    params: ChatParams,
) -> AppResult<String> {
    match self.api_type {
        ApiType::Openai => self.chat_openai_with_params(messages, params).await,
        ApiType::Anthropic => self.chat_anthropic_with_params(messages, params).await,
    }
}
```

- [ ] **Step 5: Add `inline_complete` method**

This method wraps `chat_with_params` with Ghost Text-specific settings:

```rust
pub async fn inline_complete(&self, prompt: String, hint: &str) -> AppResult<String> {
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
    }];

    // Stop sequences differ by mode:
    // - single_line: stop at first newline
    // - multi_line: stop at double newline or semicolon+newline
    let stop = match hint {
        "single_line" => vec!["\n".to_string()],
        _ => vec!["\n\n".to_string(), ";\n".to_string()],
    };

    self.chat_with_params(messages, ChatParams {
        temperature: Some(0.1),
        max_tokens: Some(200),
        stop: Some(stop),
    }).await
}
```

- [ ] **Step 6: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: compilation succeeds with no errors

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(ghost-text): add ChatParams, chat_with_params, and inline_complete to LlmClient"
```

---

## Task 3: get_best_llm_config

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

**Context:** Existing `get_default_llm_config()` at ~line 711 queries `WHERE is_default = 1`. We add `get_best_llm_config()` with priority: (is_default=1 AND test_status='success') → (test_status='success' first match) → None.

- [ ] **Step 1: Add `get_best_llm_config` function**

Add after `get_default_llm_config()`:

```rust
pub fn get_best_llm_config() -> AppResult<Option<LlmConfig>> {
    let conn = get_connection()?;
    // Priority 1: default + tested successfully
    let result: Option<LlmConfig> = conn.query_row(
        "SELECT * FROM llm_configs WHERE is_default = 1 AND test_status = 'success' LIMIT 1",
        [],
        |row| { /* same mapping as get_default_llm_config */ },
    ).optional()?;
    if result.is_some() {
        return Ok(result);
    }
    // Priority 2: any config tested successfully
    let result: Option<LlmConfig> = conn.query_row(
        "SELECT * FROM llm_configs WHERE test_status = 'success' LIMIT 1",
        [],
        |row| { /* same mapping */ },
    ).optional()?;
    Ok(result)
}
```

Follow the exact row mapping pattern from `get_default_llm_config()`.

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(ghost-text): add get_best_llm_config with priority selection"
```

---

## Task 4: Inline Complete Module — MetaCache, TimeoutTracker, Context Assembly

**Files:**
- Create: `src-tauri/src/llm/inline_complete.rs`
- Modify: `src-tauri/src/llm/mod.rs` (add `pub mod inline_complete;`)

**Context:** This is the core backend logic. It contains:
1. `MetaCache` — 30s TTL cache for `get_tables()` and `get_columns()` results
2. `TimeoutTracker` — adaptive timeout pausing
3. `build_layered_context()` — assembles Hot/Warm/Cold zone metadata
4. `postprocess_completion()` — strips code blocks and duplicate prefixes
5. `inline_complete()` — orchestrates everything

Reference the spec's "Layered Metadata Assembly" and "Performance Safeguards" sections.

- [ ] **Step 1: Create module file and add mod declaration**

Create `src-tauri/src/llm/inline_complete.rs` with:
- `use` statements for `std::collections::{HashMap, HashSet}`, `std::time::{Duration, Instant}`, `tokio::sync::Mutex`, `lazy_static`, `sha2`
- Import `crate::datasource::{DataSource, TableMeta, ColumnMeta}`, `crate::graph::query::find_relevant_subgraph`

Add `pub mod inline_complete;` to `src-tauri/src/llm/mod.rs`.

- [ ] **Step 2: Implement MetaCache**

```rust
lazy_static! {
    static ref META_CACHE: Mutex<HashMap<i64, MetaCache>> = Mutex::new(HashMap::new());
}

struct MetaCache {
    tables: Option<(Vec<TableMeta>, Instant)>,
    columns: HashMap<(String, String), (Vec<ColumnMeta>, Instant)>,
    ttl: Duration,
}
```

Implement `new()`, `get_tables()`, `set_tables()`, `get_columns(schema, table)`, `set_columns(schema, table, cols)`.

Add public function `pub async fn invalidate_meta_cache(connection_id: i64)` that removes the entry from `META_CACHE`.

- [ ] **Step 3: Implement TimeoutTracker**

```rust
lazy_static! {
    static ref TIMEOUT_TRACKERS: Mutex<HashMap<i64, TimeoutTracker>> = Mutex::new(HashMap::new());
}

#[derive(Default)]
struct TimeoutTracker {
    consecutive_timeouts: u32,
    paused_until: Option<Instant>,
}
```

Implement `should_skip()`, `record_timeout()`, `record_success()`.

Add public function `pub async fn invalidate_timeout_tracker(connection_id: i64)`.

- [ ] **Step 4: Implement `postprocess_completion`**

```rust
pub fn postprocess_completion(raw: &str, sql_before: &str) -> String
```

Three steps: strip code block wrappers → remove duplicated prefix (overlap detection with last 50 chars of sql_before) → strip leading newlines. See spec section "Result Postprocessing" for exact logic.

- [ ] **Step 5: Implement format functions**

Each function outputs SQL comment format. Cross-schema rule: if `table.schema != current_schema`, use `schema.table` format; otherwise bare name.

`format_hot_zone`: Output `-- [ACTIVE TABLES]` header, then for each table:
```
-- users (schema: public)
--   id: BIGINT (PK)
--   name: VARCHAR(100) -- username comment
--   role_id: INT (FK → roles.id)
--   created_at: TIMESTAMP DEFAULT now()
--   Indexes: uk_email (email, UNIQUE)
```

`format_warm_zone`: Output `-- [RELATED TABLES]` header, then for each table:
```
-- roles (join path: users.role_id → roles.id)
--   id: BIGINT (PK)
--   name: VARCHAR(50)
--   level: INT
```

`format_cold_zone`: Output `-- [OTHER TABLES]` header, then comma-separated `schema.table` names. If >200 tables, truncate with `... and N more`.

- [ ] **Step 6: Implement `build_layered_context` — Hot zone**

```rust
pub async fn build_layered_context(
    ds: &dyn DataSource,
    mentioned: &[String],
    current_schema: &str,
    connection_id: i64,
) -> String
```

Hot zone steps:
1. Take first 10 from `mentioned`
2. For each table, check MetaCache first, then `ds.get_columns(table, Some(current_schema))`, also `ds.get_foreign_keys(table, Some(current_schema))` and `ds.get_indexes(table, Some(current_schema))`
3. Update MetaCache with fetched results
4. Collect into hot details vec

- [ ] **Step 7: Implement `build_layered_context` — Warm + Cold zones**

Warm zone:
1. Call `crate::graph::query::find_relevant_subgraph(connection_id, mentioned, 1)`
2. Filter out tables already in hot zone
3. Sort by max edge weight descending (for each node, find highest weight among its edges in `SubGraph.edges`)
4. Take 15, fetch columns for each

Cold zone:
1. Call `ds.get_tables()` (check MetaCache first)
2. Build `HashSet<(Option<&str>, &str)>` from hot+warm table `(schema, name)` tuples
3. Filter, take 200

Final assembly:
1. Concatenate `format_hot + format_warm + format_cold`
2. Token budget: if `result.len() / 4 > 4000`, truncate cold zone first (reduce to 50 tables), then warm zone (reduce to 5 tables)

- [ ] **Step 8: Add concurrency guard**

Add a per-connection concurrency limit — max 1 in-flight Ghost Text request per connection:

```rust
lazy_static! {
    static ref IN_FLIGHT: Mutex<HashSet<i64>> = Mutex::new(HashSet::new());
}

pub async fn acquire_slot(connection_id: i64) -> bool {
    let mut set = IN_FLIGHT.lock().await;
    set.insert(connection_id)  // returns false if already present
}

pub async fn release_slot(connection_id: i64) {
    let mut set = IN_FLIGHT.lock().await;
    set.remove(&connection_id);
}
```

The `ai_inline_complete` command should call `acquire_slot` at the start — if false, return `""` immediately. Always call `release_slot` before returning (use a guard pattern or manual cleanup).

- [ ] **Step 9: Add request deduplication**

Add a last-request cache to skip identical requests:

```rust
lazy_static! {
    static ref LAST_REQUEST: Mutex<HashMap<i64, (String, Vec<String>)>> = Mutex::new(HashMap::new());
}
```

Key: `connection_id`, Value: `(sql_before, mentioned_tables)`. Before processing, check if the new request matches the last — if so, return `""` (the frontend already has the cached result from the previous identical request). Update after each successful completion.

- [ ] **Step 10: Verify compilation**

Run: `cd src-tauri && cargo check`

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/llm/inline_complete.rs src-tauri/src/llm/mod.rs
git commit -m "feat(ghost-text): add inline_complete module with MetaCache, TimeoutTracker, layered context"
```

---

## Task 5: Knowledge Graph Incremental Refresh

**Files:**
- Modify: `src-tauri/src/graph/mod.rs`

**Context:** Existing `run_graph_build()` at ~line 125 does a full rebuild. We add a lightweight `refresh_schema_graph()` that only detects table/column differences. It does NOT re-parse comment links or sync metrics/aliases. Must be implemented before Task 6 because the command references it.

- [ ] **Step 1: Implement `refresh_schema_graph`**

Add to `src-tauri/src/graph/mod.rs`:

```rust
pub async fn refresh_schema_graph(connection_id: i64, database: Option<String>) -> AppResult<()>
```

Steps:
1. Get DataSource from pool_cache (use `database` param for context)
2. Fetch current tables: `ds.get_tables()`
3. Fetch graph nodes: `crate::graph::query::get_nodes(connection_id, Some("table"))` (note: use the internal `get_nodes` function, NOT the Tauri command wrapper `get_graph_nodes`)
4. Compute added/removed/unchanged sets by table name
5. For unchanged: compute SHA256 of sorted column names, compare with stored hash
6. Add nodes+edges for new tables, remove for deleted, update for modified
7. Return Ok(())

If any step fails, log and return Ok(()) — this is a background operation.

- [ ] **Step 2: Export the function**

Ensure `refresh_schema_graph` is `pub` and accessible from `crate::graph::refresh_schema_graph`.

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/graph/mod.rs
git commit -m "feat(ghost-text): add refresh_schema_graph incremental refresh"
```

---

## Task 6: Tauri Commands — ai_inline_complete + refresh_schema_graph + Invalidation Hooks

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Context:** Follow the pattern of existing `ai_generate_sql` command at ~line 157. Use `build_llm_client()` helper. The prompt template is loaded via `include_str!("../../../prompts/sql_inline_complete.txt")`.

- [ ] **Step 1: Add `ai_inline_complete` command**

Add to `commands.rs`:

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
) -> Result<String, String> {
    // 1. Check TimeoutTracker — if should_skip(), return Ok("")
    // 2. get_best_llm_config() → None = return Ok("")
    // 3. Get dialect from connection config (use driver string, e.g. "mysql", "postgres")
    // 4. Get DataSource from pool_cache
    // 5. build_layered_context(ds, mentioned_tables, current_schema, connection_id)
    // 6. Assemble prompt from template with placeholder replacement
    // 7. Create LlmClient, call inline_complete(prompt, &hint) with 5s timeout
    // 8. On success: record_success, postprocess_completion, return
    // 9. On timeout/error: record_timeout, return Ok("")
}
```

Use `include_str!("../../../prompts/sql_inline_complete.txt")` for the template. Replace `{{DIALECT}}`, `{{MODE_INSTRUCTION}}`, `{{SCHEMA_CONTEXT}}`, `{{SQL_BEFORE}}` (last 2000 chars), `{{SQL_AFTER}}` (first 500 chars).

`MODE_INSTRUCTION` mapping:
- `"single_line"` → `"Complete the current line only. Do not add newlines."`
- `"multi_line"` → `"Complete the full SQL statement from the cursor position. Use newlines for readability."`

- [ ] **Step 2: Add `refresh_schema_graph` Tauri command wrapper**

The frontend timer calls `invoke('refresh_schema_graph', ...)`, so it must be a registered command:

```rust
#[tauri::command]
pub async fn refresh_schema_graph(
    connection_id: i64,
    database: Option<String>,
) -> Result<(), String> {
    crate::graph::refresh_schema_graph(connection_id, database)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register both commands in lib.rs**

Add `commands::ai_inline_complete` and `commands::refresh_schema_graph` to the `generate_handler![]` macro list.

- [ ] **Step 4: Add DDL auto-trigger in execute_query**

In the `execute_query` command (around line 53-93), after successful SQL execution, add:

```rust
let sql_upper = sql.trim().to_uppercase();
if sql_upper.starts_with("CREATE")
    || sql_upper.starts_with("ALTER")
    || sql_upper.starts_with("DROP")
{
    let conn_id = connection_id;
    let db = database.clone();
    tokio::spawn(async move {
        let _ = crate::graph::refresh_schema_graph(conn_id, db).await;
    });
}
```

- [ ] **Step 5: Add MetaCache + TimeoutTracker invalidation hooks**

Find the existing connection delete/update command handlers in `commands.rs` (the functions that call `pool_cache::invalidate(connection_id)`). After each `pool_cache::invalidate` call, add:

```rust
crate::llm::inline_complete::invalidate_meta_cache(connection_id).await;
crate::llm::inline_complete::invalidate_timeout_tracker(connection_id).await;
```

This ensures cached metadata and timeout state are cleared when a connection is reconfigured.

- [ ] **Step 6: Verify compilation**

Run: `cd src-tauri && cargo check`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(ghost-text): add ai_inline_complete and refresh_schema_graph commands with invalidation hooks"
```

---

## Task 7: Frontend Types & Stores

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/store/appStore.ts`
- Modify: `src/store/queryStore.ts`
- Modify: `src/store/connectionStore.ts`

- [ ] **Step 1: Extend Tab interface**

In `src/types/index.ts`, add to the `Tab` interface (around line 143-156):

```typescript
ghostTextEnabled?: boolean;  // undefined = use global default
```

- [ ] **Step 2: Extend appStore**

In `src/store/appStore.ts`, add to state:

```typescript
ghostTextDefault: boolean;
setGhostTextDefault: (v: boolean) => void;
```

Implementation:
```typescript
ghostTextDefault: true,  // default on
setGhostTextDefault: async (v) => {
  set({ ghostTextDefault: v });
  await invoke('set_ui_state', { key: 'ghost_text_default', value: String(v) });
},
```

On store init, load from SQLite. Find the existing init function in `appStore.ts` (look for `initAutoMode` or similar pattern that loads persisted state). Add alongside it:

```typescript
initGhostTextDefault: async () => {
  try {
    const saved = await invoke<string | null>('get_ui_state', { key: 'ghost_text_default' });
    if (saved !== null) set({ ghostTextDefault: saved === 'true' });
  } catch { /* silent — use default true */ }
},
```

Call `initGhostTextDefault()` from wherever `initAutoMode()` is called (likely in `App.tsx` or a root-level `useEffect`).

- [ ] **Step 3: Extend queryStore**

Add two new methods:

```typescript
toggleGhostText: (tabId: string) => void;
isGhostTextEnabled: (tabId: string) => boolean;
```

`isGhostTextEnabled`: check tab's `ghostTextEnabled` → if undefined, fall back to `useAppStore.getState().ghostTextDefault`.

`toggleGhostText`: flip the current effective value and set on the tab.

- [ ] **Step 4: Add graph refresh timer to connectionStore**

Add to `connectionStore.ts`:

```typescript
// Module-level (outside store)
const graphTimers = new Map<number, NodeJS.Timeout>();

// In store actions:
startGraphRefreshTimer: (connectionId: number) => {
  if (graphTimers.has(connectionId)) return;
  const timer = setInterval(() => {
    invoke('refresh_schema_graph', { connectionId, database: null });
  }, 5 * 60 * 1000);
  graphTimers.set(connectionId, timer);
},

stopGraphRefreshTimer: (connectionId: number) => {
  const timer = graphTimers.get(connectionId);
  if (timer) { clearInterval(timer); graphTimers.delete(connectionId); }
},

stopAllGraphRefreshTimers: () => {
  graphTimers.forEach((timer) => clearInterval(timer));
  graphTimers.clear();
},
```

Call `startGraphRefreshTimer` when a connection is activated/used. Call `stopGraphRefreshTimer` when a connection is deleted. Call `stopAllGraphRefreshTimers` on app cleanup.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/store/appStore.ts src/store/queryStore.ts src/store/connectionStore.ts
git commit -m "feat(ghost-text): add ghost text state management to stores"
```

---

## Task 8: Monaco InlineCompletionsProvider

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**Context:** The existing `handleEditorDidMount` at ~line 338 registers a `CompletionItemProvider` for table/column autocomplete. We add an `InlineCompletionsProvider` for Ghost Text. Monaco's `registerInlineCompletionsProvider` returns a disposable — store it in a ref and dispose on unmount.

- [ ] **Step 1: Add helper functions outside the component**

Add before the component definition:

```typescript
const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON',
  'AS', 'SET', 'VALUES', 'INTO', 'NULL', 'IS', 'LIKE', 'BETWEEN',
  'EXISTS', 'HAVING', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET',
  'UNION', 'ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL',
  'ASC', 'DESC', 'WITH', 'RECURSIVE', 'IF', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW',
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE',
]);

function extractMentionedTables(sql: string): string[] {
  const tables = new Set<string>();

  // Pattern 1: keyword-based (FROM, JOIN, INTO, UPDATE, DELETE FROM, MERGE INTO)
  const keywordPattern = /(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+([`"']?[\w]+[`"']?(?:\.[`"']?[\w]+[`"']?)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = keywordPattern.exec(sql)) !== null) {
    const name = match[1].replace(/[`"']/g, '');
    if (!SQL_KEYWORDS.has(name.toUpperCase())) {
      tables.add(name);
    }
  }

  // Pattern 2: comma-separated tables after FROM (e.g., FROM users, orders)
  const commaListPattern = /FROM\s+([\w.`"']+(?:\s*,\s*[\w.`"']+)*)/gi;
  while ((match = commaListPattern.exec(sql)) !== null) {
    const list = match[1];
    for (const item of list.split(',')) {
      const name = item.trim().replace(/[`"']/g, '');
      if (name && !SQL_KEYWORDS.has(name.toUpperCase())) {
        tables.add(name);
      }
    }
  }

  return Array.from(tables);
}
```

- [ ] **Step 2: Add refs for Ghost Text state**

Inside the component, add:

```typescript
const ghostCacheRef = useRef<{ sqlBefore: string; result: string; timestamp: number } | null>(null);
const requestIdRef = useRef<number>(0);
const inlineProviderRef = useRef<monaco.IDisposable | null>(null);
```

- [ ] **Step 3: Add `tryPrefixCache` function**

```typescript
function tryPrefixCache(
  currentSqlBefore: string,
  cacheRef: React.MutableRefObject<{ sqlBefore: string; result: string; timestamp: number } | null>
): string | null {
  const cache = cacheRef.current;
  if (!cache || !cache.result) return null;
  if (Date.now() - cache.timestamp > 30_000) return null;  // 30s expiry

  if (!currentSqlBefore.startsWith(cache.sqlBefore)) return null;

  const typed = currentSqlBefore.slice(cache.sqlBefore.length);
  if (!cache.result.startsWith(typed)) return null;

  return cache.result.slice(typed.length);  // Remaining completion
}
```

- [ ] **Step 4: Register InlineCompletionsProvider in handleEditorDidMount**

After the existing `registerCompletionItemProvider` block (around line 430), add:

```typescript
inlineProviderRef.current = monacoInstance.languages.registerInlineCompletionsProvider('sql', {
  provideInlineCompletions: async (model, position, context, token) => {
    // 1. Get current tab info (connectionId, schema, database, ghostTextEnabled)
    const tab = useQueryStore.getState().tabs.get(activeTabId);
    if (!tab?.queryContext?.connectionId) return { items: [] };
    if (!useQueryStore.getState().isGhostTextEnabled(tab.id)) return { items: [] };

    // 2. Extract sqlBefore / sqlAfter
    const fullText = model.getValue();
    const offset = model.getOffsetAt(position);
    const sqlBefore = fullText.slice(0, offset);
    const sqlAfter = fullText.slice(offset);

    // 3. Trigger conditions
    if (sqlBefore.trim().length < 2) return { items: [] };
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) return { items: [] };

    // 4. Prefix cache check
    const cached = tryPrefixCache(sqlBefore, ghostCacheRef);
    if (cached) return { items: [{ insertText: cached, range: new monacoInstance.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };

    // 5. Request ID guard
    const thisRequestId = ++requestIdRef.current;
    if (token.isCancellationRequested) return { items: [] };

    // 6. Extract mentioned tables and determine hint
    const mentionedTables = extractMentionedTables(sqlBefore + sqlAfter);
    const lineBeforeCursor = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const hint = lineBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';

    // 7. Invoke backend
    try {
      const result = await invoke<string>('ai_inline_complete', {
        connectionId: tab.queryContext.connectionId,
        sqlBefore,
        sqlAfter,
        mentionedTables,
        currentSchema: tab.schema || 'public',
        hint,
        database: tab.db || null,
      });

      // 8. Stale response guard
      if (requestIdRef.current !== thisRequestId) return { items: [] };
      if (token.isCancellationRequested) return { items: [] };

      // 9. Update cache
      if (result) {
        ghostCacheRef.current = { sqlBefore, result, timestamp: Date.now() };
        return { items: [{ insertText: result, range: new monacoInstance.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      }
    } catch {
      // Silent degradation
    }

    return { items: [] };
  },
  freeInlineCompletions: () => {},
});
```

- [ ] **Step 5: Add cleanup in useEffect return**

In the component's cleanup effect, add:

```typescript
inlineProviderRef.current?.dispose();
```

- [ ] **Step 6: Add toolbar toggle button**

In the toolbar area of the editor, add a button:

```tsx
<button
  onClick={() => useQueryStore.getState().toggleGhostText(activeTabId)}
  title="AI Completion (Tab to accept)"
  className={isGhostTextEnabled ? 'active' : ''}
>
  <Sparkles size={16} />
</button>
```

Follow the existing toolbar button pattern in MainContent. Use the `Sparkles` icon from `lucide-react`.

- [ ] **Step 7: Verify TypeScript compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(ghost-text): add InlineCompletionsProvider with prefix cache and toolbar toggle"
```

---

## Task 9: Settings Page — Global Default Toggle

**Files:**
- Modify: `src/components/Settings/SettingsPage.tsx`

**Context:** Settings page has nav items: 'ai', 'appearance', 'shortcuts', 'about'. The 'appearance' section (~line 55-118) has toggles for language and page size. Add a new entry in the appropriate section (or under 'ai' section) for the global Ghost Text default.

- [ ] **Step 1: Add AI Inline Completion toggle**

In the AI settings section or General section, add:

```tsx
<div className="setting-item">
  <div className="setting-label">
    <span>AI Inline Completion</span>
    <span className="setting-description">
      Enable AI-powered ghost text suggestions in SQL editor. New tabs will use this setting by default.
    </span>
  </div>
  <Switch
    checked={ghostTextDefault}
    onChange={(checked) => setGhostTextDefault(checked)}
  />
</div>
```

Use `useAppStore` to get/set `ghostTextDefault`.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/Settings/SettingsPage.tsx
git commit -m "feat(ghost-text): add AI Inline Completion toggle in Settings"
```

---

## Task 10: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Verify Rust compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Verify dev server starts**

Run: `npm run dev`
Expected: Vite dev server starts on port 1420

- [ ] **Step 4: Manual smoke test checklist**

If Tauri dev environment is available (`npm run tauri:dev`):
1. Open Settings → verify AI Inline Completion toggle exists and works
2. Connect to a database → verify tree loads normally (no regression)
3. Open a query tab → verify toolbar shows Ghost Text toggle button (Sparkles icon)
4. Toggle Ghost Text on/off → verify button state changes
5. Type SQL in editor → if LLM is configured, verify Ghost Text appears after 600ms pause
6. Press Tab → verify suggestion is accepted
7. Press Esc → verify suggestion is dismissed
8. Type matching prefix → verify cached suggestion appears instantly
9. Execute a CREATE TABLE → verify no errors (DDL trigger fires in background)

- [ ] **Step 5: Commit any fixes from integration testing**

```bash
git add -A
git commit -m "fix(ghost-text): integration fixes from smoke testing"
```
