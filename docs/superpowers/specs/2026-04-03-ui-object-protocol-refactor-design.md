# UI Object Protocol Refactor — Tool Interface Unification

**Date**: 2026-04-03  
**Status**: Approved  
**Scope**: Protocol layer + all 8 adapters + system prompt + Rust tool definitions

## Problem Statement

AI agents interacting with ER diagrams require 3-4 failed attempts before succeeding, due to:

1. **No protocol contract** — each adapter defines paramsSchema in different formats (or omits it entirely). 6/8 adapters lack production-quality action definitions.
2. **Inconsistent patch path syntax** — TableForm uses `[name=xxx]`, ERCanvas uses `/[id=n]/`, others use plain RFC 6902.
3. **Undocumented capability boundaries** — ER canvas patch cannot add/update relations, but this is nowhere the AI can see.
4. **Missing system prompt coverage** — `chat_assistant.txt` has zero documentation for ER canvas operations despite it being the most complex adapter.
5. **Unhelpful error messages** — most adapters return `String(e)` instead of guiding the AI toward the correct tool/path.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approach | Dual-track parallel (protocol + adapter fixes simultaneously) | Fast feedback via ERCanvas as testbed, no blocking on full protocol design |
| Patch path syntax | Support both `[id=n]` and `[name=xxx]` | Different scenarios need different addressing; `x-addressable-by` declares which keys |
| Error message format | Plain text with standardized template | AI understands natural language best; no interface breaking changes needed |
| System prompt strategy | Key workflows + teach AI self-discovery via `ui_read` | Scalable — new adapters need good paramsSchema, not prompt rewrites |
| Delivery | Phase 1 (protocol + ERCanvas + DbTree + History + prompt) then Phase 2 (remaining 4 adapters) | Incremental risk |

## Architecture

### Protocol Contract (`src/mcp/ui/types.ts`)

#### Strengthened `ActionDef`

```typescript
export interface ActionDef {
  name: string
  description: string
  paramsSchema: JsonSchema   // Required (was optional Record<string, any>)
}

interface JsonSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}
```

**Effect**: `{ keyword: 'string' }` shorthand won't compile. All adapters must provide full JSON Schema.

**No-params actions** (e.g. `auto_layout`, `run_sql`, `format`) use `{ type: 'object', properties: {} }` — the schema is required but can be empty. ERCanvasAdapter already follows this pattern.

#### Patch Capability Declaration

```typescript
export interface UIObject {
  type: string
  objectId: string
  title: string
  connectionId?: number
  database?: string

  patchCapabilities?: PatchCapability[]

  read(mode: 'state' | 'schema' | 'actions'): any
  patch(ops: JsonPatchOp[], reason?: string): PatchResult | Promise<PatchResult>
  exec(action: string, params?: any): ExecResult | Promise<ExecResult>
}

export interface PatchCapability {
  pathPattern: string            // e.g. "/tables/[id=<n>]/<field>"
  ops: ('replace' | 'add' | 'remove')[]
  description: string
  addressableBy?: string[]       // e.g. ['id', 'name']
}
```

**Effect**: `ui_read(mode='schema')` returns `patchCapabilities`, so AI knows what's patchable in one call.

**Integration with `read('schema')`**: Each adapter's `read('schema')` already returns adapter-specific schema data. Adapters that declare `patchCapabilities` should include them in the `read('schema')` response under a `patchCapabilities` key alongside existing fields. This is additive — no existing schema data is removed.

#### Error Message Utilities (`src/mcp/ui/errors.ts`)

```typescript
export function patchError(
  problem: string,
  expected?: string,
  hint?: string
): PatchResult {
  let message = problem
  if (expected) message += `. Expected: ${expected}`
  if (hint) message += `. Hint: ${hint}`
  return { status: 'error', message }
}

export function execError(
  problem: string,
  hint?: string
): ExecResult {
  let message = problem
  if (hint) message += `. Hint: ${hint}`
  return { success: false, error: message }
}
```

**Template**: `"<problem>. Expected: <correct usage>. Hint: <alternative approach>"`

### Unified Path Resolver (`src/mcp/ui/pathResolver.ts`)

Replaces three separate parsing implementations (jsonPatch.ts resolvePath, ERCanvasAdapter's parsePatchPath/parseCollectionAppendPath/parseEntityRemovePath).

```typescript
export interface PathSegment {
  field: string
  filters?: Record<string, string>  // { id: "5" } or { name: "users" }
  isAppend?: boolean                 // true for "-" (array append)
}

/**
 * Parse unified path syntax.
 *
 * Supported formats:
 *   /tables/[id=5]/name            — ERCanvas style
 *   /columns[name=email]/dataType  — TableForm style
 *   /tables/[id=5]/columns/-       — Array append
 *   /columns/[id=10]/[tableId=5]   — Remove with context
 *   /content                       — Simple field
 */
export function parsePath(path: string): PathSegment[]

export interface ResolveResult {
  target: any
  parent: any
  key: string | number
  context: Record<string, any>  // All filter values extracted from path
}

export function resolvePath(state: any, segments: PathSegment[]): ResolveResult | null

/**
 * Check if a concrete path matches a capability pattern.
 * Used by UIRouter's patch pre-check.
 *
 * Example: matchPathPattern('/tables/[id=5]/name', '/tables/[id=<n>]/<field>') → true
 */
export function matchPathPattern(path: string, pattern: string): boolean
```

**Migration**: `jsonPatch.ts` `resolvePath()` is preserved (TableForm confirmation panel depends on it). New `pathResolver.ts` is used inside adapters for their own path parsing. ERCanvasAdapter's three regex functions are deleted and replaced with `parsePath()` calls.

### UIRouter Validation Layer (`src/mcp/ui/UIRouter.ts`)

#### Patch Pre-check

Before calling `adapter.patch()`, UIRouter validates ops against `patchCapabilities`:

```typescript
private async handlePatch(instance: UIObject, payload: any): Promise<UIResponse> {
  const ops = payload?.ops ?? []
  const capabilities = instance.patchCapabilities

  // No capabilities declared → passthrough (backward compatible)
  if (!capabilities?.length) {
    return instance.patch(ops, payload?.reason)
  }

  for (const op of ops) {
    const match = capabilities.find(cap =>
      cap.ops.includes(op.op) && matchPathPattern(op.path, cap.pathPattern)
    )
    if (!match) {
      const supported = capabilities
        .map(c => `${c.ops.join('/')} ${c.pathPattern}`)
        .join(', ')
      return patchError(
        `Unsupported: ${op.op} ${op.path}`,
        `Supported paths: [${supported}]`,
        `Use ui_read(mode='actions') for operations not available via patch`
      )
    }
  }

  return instance.patch(ops, payload?.reason)
}
```

#### Exec Pre-check

Before calling `adapter.exec()`, UIRouter validates action existence and required params:

```typescript
private async handleExec(instance: UIObject, payload: any): Promise<UIResponse> {
  const { action, params } = payload ?? {}
  const actions: ActionDef[] = instance.read('actions')
  const def = actions.find(a => a.name === action)

  if (!def) {
    const available = actions.map(a => a.name).join(', ')
    return execError(
      `Unknown action '${action}'`,
      `Available actions: [${available}]`
    )
  }

  const missing = (def.paramsSchema.required ?? [])
    .filter(key => params?.[key] === undefined)

  if (missing.length) {
    return execError(
      `Missing required params: ${missing.join(', ')}`,
      `Schema: ${JSON.stringify(def.paramsSchema)}`
    )
  }

  return instance.exec(action, params)
}
```

**Key design**: adapters without `patchCapabilities` get passthrough behavior — zero breakage during incremental rollout.

## Adapter Modifications

### Phase 1

| Adapter | Changes |
|---------|---------|
| **ERCanvasAdapter** | Add `patchCapabilities` (6 entries), replace 3 regex parsers with `pathResolver.parsePath()`, support `[name=xxx]` addressing for tables, standardize all error messages via `patchError()`/`execError()` |
| **DbTreeAdapter** | Rewrite paramsSchema from shorthand `{ keyword: 'string' }` to full JSON Schema `{ type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] }` |
| **HistoryAdapter** | Same as DbTree — rewrite paramsSchema for `list` action |

### Phase 2

All 4 adapters follow a uniform 3-step pattern:

1. Add `patchCapabilities` declaration
2. Add full `paramsSchema` to all actions
3. Standardize error messages via `patchError()`/`execError()`

| Adapter | patchCapabilities | paramsSchema gaps |
|---------|-------------------|-------------------|
| **QueryEditorAdapter** | `/content`, `/connectionId`, `/database` (replace) | `set_context` missing schema |
| **TableFormAdapter** | `/tableName`, `/columns[name=<s>]/<field>`, `/columns/-`, `/indexes[name=<s>]/<field>`, `/indexes/-` | `preview_sql`, `save` missing schema |
| **MetricFormAdapter** | `/displayName`, `/name`, `/metricType`, `/tableName`, etc. (replace) | `save`, `validate` missing schema |
| **SeaTunnelJobAdapter** | `/jobName`, `/configJson` (replace) | `save`, `submit`, `stop` missing schema |

**WorkspaceAdapter**: Already production-quality. No changes needed.

## System Prompt Updates (`prompts/chat_assistant.txt`)

**Strategy**: English prose, Chinese allowed in examples. Target ~250 lines (from current 210).

### New Content

**Discovery-First Workflow** (~15 lines) — inserted after `## UI Object Protocol`:

```markdown
### Discovery-First Workflow

Before operating any UI object for the first time, discover its capabilities:

1. `ui_read(object="<type>", mode="actions")` — See all available actions with parameter schemas
2. `ui_read(object="<type>", mode="schema")` — See patchable paths and addressable keys
3. Then choose: `ui_patch` for simple field updates, `ui_exec` for structured actions

**When to use which:**
- `ui_patch`: Updating individual fields visible in the schema (rename, change type, toggle flag)
- `ui_exec`: Creating/deleting entities, batch operations, triggering side effects (save, run, import)
- When in doubt, use `ui_exec` — it covers everything `ui_patch` can do and more
```

**ER Diagram Workflow** (~30 lines):

```markdown
### ER Diagram Workflow

ER diagrams use `er_canvas` objects. Two convenience top-level tools are available:

- `init_er_table(table_name, columns, indexes?)` — Create one complete table in one call
- `er_batch(ops)` — Multi-step workflows with variable binding (`$0.tableId`, `$1.columnMap.user_id`)

**Create multiple tables with relations (创建多表并建立关系):**

er_batch(ops=[
  {action:"batch_create_table", params:{name:"users", columns:[
    {name:"id", data_type:"BIGINT", is_primary_key:true, is_auto_increment:true},
    {name:"email", data_type:"VARCHAR", length:255}
  ]}},
  {action:"batch_create_table", params:{name:"orders", columns:[
    {name:"id", data_type:"BIGINT", is_primary_key:true, is_auto_increment:true},
    {name:"user_id", data_type:"BIGINT"}
  ]}},
  {action:"add_relation", params:{
    source_table_id:"$0.tableId", source_column_id:"$0.columnMap.id",
    target_table_id:"$1.tableId", target_column_id:"$1.columnMap.user_id"
  }}
])

**Modify existing tables (修改现有表):** Use `ui_exec(object="er_canvas", action="add_column"/"update_column"/...)` or `ui_patch` for simple field updates.

**Patch addressing:** ER canvas supports both `[id=5]` and `[name=users]`:
- `ui_patch(object="er_canvas", ops=[{op:"replace", path:"/tables/[name=users]/comment", value:"User accounts"}])`

**Relations cannot be added/updated via patch** — use `ui_exec` with `add_relation`/`update_relation`.
```

### Compressed Content

`## Table Creation Workflow (Multi-Round)` (lines 88-125, ~37 lines) compressed to ~10 lines.
`## Editing an Existing Table` (lines 128-151, ~23 lines) compressed to ~5 lines.

### Final Structure

```
chat_assistant.txt (~250 lines)
├── Role + Guidelines (lines 1-18, unchanged)
├── ## UI Object Protocol
│   ├── ### Core Concepts (compressed)
│   ├── ### Available Tools (compressed examples)
│   ├── ### Discovery-First Workflow (NEW, ~15 lines)
│   └── ### When to use patch vs exec (NEW, ~5 lines)
├── ## ER Diagram Workflow (NEW, ~30 lines)
├── ## Table Form Workflow (compressed, ~10 lines)
├── ## SQL Editing Workflow (unchanged, ~5 lines)
├── ## Database Read Tools (unchanged)
├── ## Knowledge Graph (unchanged)
└── ## Clarification Principles (unchanged)
```

## Rust Tool Definition Updates (`src-tauri/src/mcp/mod.rs`)

### `init_er_table`

```
Before: "Create a complete table with columns and indexes in the active ER diagram in one call. ..."
After:  "Create ONE complete table with columns and indexes in the active ER diagram.
         For single-table creation this is the simplest choice.
         For multi-table + relations, use er_batch instead (supports variable binding across operations)."
```

### `er_batch`

Append available action list and common patterns to description:

```
"Available actions: batch_create_table, add_table, update_table, delete_table,
add_column, update_column, delete_column, add_relation, update_relation, delete_relation,
add_index, update_index, delete_index, replace_columns, replace_indexes.

Common patterns:
- Create tables + relations: batch_create_table x N -> add_relation
- Modify existing table: update_column / delete_column / add_column in sequence
- Rebuild columns: replace_columns (deletes all then creates new)"
```

### `ui_patch` / `ui_exec`

Append discovery tip to each description:

```
ui_patch: + "Tip: call ui_read(mode='schema') first to see supported patch paths and addressable keys."
ui_exec:  + "Tip: call ui_read(mode='actions') first to see all available actions with parameter schemas."
```

## Testing

### New Test Files

| File | Coverage |
|------|----------|
| `src/mcp/ui/__tests__/pathResolver.test.ts` | Dual-mode addressing, append paths, context paths, simple fields |
| `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts` | name addressing, patchCapabilities completeness, error messages |
| `src/mcp/ui/__tests__/errors.test.ts` | `patchError()` / `execError()` message formatting |

### Modified Test Files

| File | Changes |
|------|---------|
| `UIRouter.test.ts` | Add patch pre-check + exec pre-check cases |
| `jsonPatch.test.ts` | Verify old syntax still works (backward compatibility) |

### Key Test Cases

**pathResolver.test.ts**:
- `parsePath('/tables/[id=5]/name')` → ERCanvas style
- `parsePath('/columns[name=email]/dataType')` → TableForm style
- `parsePath('/tables/[id=5]/columns/-')` → array append
- `parsePath('/columns/[id=10]/[tableId=5]')` → remove with context
- `parsePath('/content')` → simple field

**UIRouter.test.ts — pre-checks**:
- Unknown action → error with available actions list
- Missing required params → error with schema
- Unsupported patch path → error with supported paths + hint
- No capabilities declared → passthrough (backward compatible)

**ERCanvasAdapter.test.ts**:
- `[name=users]` addressing succeeds
- `[name=nonexistent]` → descriptive error
- `patchCapabilities` has >= 6 entries, all with pathPattern + ops + description

### Out of Scope

- Rust `mod.rs` description text changes (manual review)
- `chat_assistant.txt` effectiveness (requires end-to-end validation)
- Phase 2 adapter tests (written during Phase 2 implementation)

## Phasing

### Phase 1 (this delivery)

1. Protocol contract: `types.ts` (ActionDef + PatchCapability + UIObject update)
2. Error utilities: `errors.ts` (patchError + execError)
3. Path resolver: `pathResolver.ts` (unified parser)
4. UIRouter validation layer (handlePatch + handleExec)
5. ERCanvasAdapter (patchCapabilities + name addressing + path resolver + error messages)
6. DbTreeAdapter + HistoryAdapter (paramsSchema normalization)
7. `chat_assistant.txt` (discovery workflow + ER workflow + compression)
8. `mod.rs` tool descriptions (init_er_table + er_batch + ui_patch/ui_exec tips)
9. Tests for all Phase 1 changes

### Phase 2 (follow-up)

1. QueryEditorAdapter (patchCapabilities + paramsSchema + errors)
2. TableFormAdapter (patchCapabilities + paramsSchema + errors)
3. MetricFormAdapter (patchCapabilities + paramsSchema + errors)
4. SeaTunnelJobAdapter (patchCapabilities + paramsSchema + errors)
5. Tests for Phase 2 adapters
