# UI Object Protocol Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all 8 UI adapter tool interfaces with enforced protocol contracts, consistent error messages, dual-mode patch path addressing, and system prompt updates so AI agents succeed on first attempt.

**Architecture:** Dual-track parallel — define protocol contract and fix ERCanvasAdapter simultaneously. UIRouter gains a validation layer that checks patch capabilities and exec action existence before forwarding to adapters. Adapters without capability declarations get passthrough (backward compatible).

**Tech Stack:** TypeScript, Vitest, Rust (tool descriptions only)

---

## File Map

### New Files (Phase 1)
| File | Responsibility |
|------|----------------|
| `src/mcp/ui/errors.ts` | `patchError()` and `execError()` helper functions |
| `src/mcp/ui/pathResolver.ts` | Unified path parser: `parsePath()`, `matchPathPattern()` |
| `src/mcp/ui/__tests__/errors.test.ts` | Tests for error helpers |
| `src/mcp/ui/__tests__/pathResolver.test.ts` | Tests for path resolver |
| `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts` | Tests for ERCanvas refactor |

### Modified Files (Phase 1)
| File | Changes |
|------|---------|
| `src/mcp/ui/types.ts` | Add `JsonSchema`, `PatchCapability`; strengthen `ActionDef`; add `patchCapabilities` to `UIObject` |
| `src/mcp/ui/UIRouter.ts` | Add `handlePatch()` and `handleExec()` validation layer |
| `src/mcp/ui/__tests__/UIRouter.test.ts` | Add pre-check test cases |
| `src/mcp/ui/adapters/ERCanvasAdapter.ts` | Add `patchCapabilities`, replace regex parsers, support `[name=xxx]`, use error helpers |
| `src/mcp/ui/adapters/DbTreeAdapter.ts` | Normalize paramsSchema to full JSON Schema |
| `src/mcp/ui/adapters/HistoryAdapter.ts` | Normalize paramsSchema to full JSON Schema |
| `prompts/chat_assistant.txt` | Add discovery workflow + ER workflow, compress existing content |
| `src-tauri/src/mcp/mod.rs` | Update tool descriptions for init_er_table, er_batch, ui_patch, ui_exec |

### Modified Files (Phase 2)
| File | Changes |
|------|---------|
| `src/mcp/ui/adapters/QueryEditorAdapter.ts` | Add `patchCapabilities`, complete paramsSchema, use error helpers |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | Add `patchCapabilities`, complete paramsSchema |
| `src/mcp/ui/adapters/MetricFormAdapter.ts` | Add `patchCapabilities`, complete paramsSchema, use error helpers |
| `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts` | Add `patchCapabilities`, complete paramsSchema, use error helpers |

---

## Phase 1

### Task 1: Protocol Contract — types.ts

**Files:**
- Modify: `src/mcp/ui/types.ts`

- [ ] **Step 1: Add JsonSchema and PatchCapability types, strengthen ActionDef**

```typescript
// Add after the ExecResult interface (after line 50):

// ── JSON Schema (subset for ActionDef) ────────────────────
export interface JsonSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

// ── Patch Capability Declaration ──────────────────────────
export interface PatchCapability {
  /** Path pattern, e.g. "/tables/[id=<n>]/<field>" */
  pathPattern: string
  /** Supported ops for this path */
  ops: ('replace' | 'add' | 'remove')[]
  /** Human-readable description */
  description: string
  /** Keys usable in [key=value] addressing, e.g. ['id', 'name'] */
  addressableBy?: string[]
}
```

- [ ] **Step 2: Update ActionDef to require paramsSchema**

Replace the existing `ActionDef` (lines 54-58):

```typescript
export interface ActionDef {
  name: string
  description: string
  paramsSchema: JsonSchema
}
```

- [ ] **Step 3: Add patchCapabilities and database to UIObject**

Replace the existing `UIObject` interface (lines 28-37):

```typescript
export interface UIObject {
  type: string
  objectId: string
  title: string
  connectionId?: number
  database?: string

  /** Declare supported patch paths. If present, UIRouter validates before forwarding. */
  patchCapabilities?: PatchCapability[]

  read(mode: 'state' | 'schema' | 'actions'): any
  patch(ops: JsonPatchOp[], reason?: string): PatchResult | Promise<PatchResult>
  exec(action: string, params?: any): ExecResult | Promise<ExecResult>
}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit 2>&1 | head -50`

Expected: Type errors in adapters that have `paramsSchema?: Record<string, any>` or shorthand `paramsSchema` — this is expected and will be fixed in subsequent tasks. Note the errors for reference but do NOT fix them yet.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/types.ts
git commit -m "refactor(mcp): strengthen protocol contract — require JsonSchema in ActionDef, add PatchCapability"
```

---

### Task 2: Error Message Utilities

**Files:**
- Create: `src/mcp/ui/errors.ts`
- Create: `src/mcp/ui/__tests__/errors.test.ts`

- [ ] **Step 1: Write failing tests for error helpers**

Create `src/mcp/ui/__tests__/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { patchError, execError } from '../errors'

describe('patchError', () => {
  it('returns error status with problem only', () => {
    const result = patchError('Something broke')
    expect(result).toEqual({ status: 'error', message: 'Something broke' })
  })

  it('appends expected when provided', () => {
    const result = patchError('Bad path', '/tables/[id=<n>]/<field>')
    expect(result.message).toBe('Bad path. Expected: /tables/[id=<n>]/<field>')
  })

  it('appends hint when provided', () => {
    const result = patchError('Cannot add relation via patch', 'use ui_exec', 'ui_read(mode="actions") shows all actions')
    expect(result.message).toBe(
      'Cannot add relation via patch. Expected: use ui_exec. Hint: ui_read(mode="actions") shows all actions'
    )
  })
})

describe('execError', () => {
  it('returns success false with problem only', () => {
    const result = execError('Unknown action')
    expect(result).toEqual({ success: false, error: 'Unknown action' })
  })

  it('appends hint when provided', () => {
    const result = execError('Missing params', 'Schema: {...}')
    expect(result.error).toBe('Missing params. Hint: Schema: {...}')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/ui/__tests__/errors.test.ts 2>&1`

Expected: FAIL — module `../errors` not found

- [ ] **Step 3: Implement error helpers**

Create `src/mcp/ui/errors.ts`:

```typescript
import type { PatchResult, ExecResult } from './types'

/**
 * Build a standardized PatchResult error.
 * Template: "<problem>. Expected: <correct usage>. Hint: <alternative>"
 */
export function patchError(
  problem: string,
  expected?: string,
  hint?: string,
): PatchResult {
  let message = problem
  if (expected) message += `. Expected: ${expected}`
  if (hint) message += `. Hint: ${hint}`
  return { status: 'error', message }
}

/**
 * Build a standardized ExecResult error.
 * Template: "<problem>. Hint: <alternative>"
 */
export function execError(
  problem: string,
  hint?: string,
): ExecResult {
  let message = problem
  if (hint) message += `. Hint: ${hint}`
  return { success: false, error: message }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp/ui/__tests__/errors.test.ts 2>&1`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/errors.ts src/mcp/ui/__tests__/errors.test.ts
git commit -m "feat(mcp): add patchError/execError standardized error helpers"
```

---

### Task 3: Unified Path Resolver

**Files:**
- Create: `src/mcp/ui/pathResolver.ts`
- Create: `src/mcp/ui/__tests__/pathResolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/mcp/ui/__tests__/pathResolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parsePath, matchPathPattern } from '../pathResolver'

describe('parsePath', () => {
  it('parses simple field path', () => {
    expect(parsePath('/content')).toEqual([
      { field: 'content' },
    ])
  })

  it('parses ERCanvas style: /tables/[id=5]/name', () => {
    expect(parsePath('/tables/[id=5]/name')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'name' },
    ])
  })

  it('parses ERCanvas style with name: /tables/[name=users]/comment', () => {
    expect(parsePath('/tables/[name=users]/comment')).toEqual([
      { field: 'tables', filters: { name: 'users' } },
      { field: 'comment' },
    ])
  })

  it('parses TableForm style: /columns[name=email]/dataType', () => {
    expect(parsePath('/columns[name=email]/dataType')).toEqual([
      { field: 'columns', filters: { name: 'email' } },
      { field: 'dataType' },
    ])
  })

  it('parses array append: /tables/[id=5]/columns/-', () => {
    expect(parsePath('/tables/[id=5]/columns/-')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'columns', isAppend: true },
    ])
  })

  it('parses remove with context: /columns/[id=10]/[tableId=5]', () => {
    expect(parsePath('/columns/[id=10]/[tableId=5]')).toEqual([
      { field: 'columns', filters: { id: '10' } },
      { field: '', filters: { tableId: '5' } },
    ])
  })

  it('parses nested field: /tables/[id=5]/position/x', () => {
    expect(parsePath('/tables/[id=5]/position/x')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'position' },
      { field: 'x' },
    ])
  })

  it('parses standalone filter: /relations/[id=7]', () => {
    expect(parsePath('/relations/[id=7]')).toEqual([
      { field: 'relations', filters: { id: '7' } },
    ])
  })
})

describe('matchPathPattern', () => {
  it('matches simple field', () => {
    expect(matchPathPattern('/content', '/content')).toBe(true)
  })

  it('matches ERCanvas table field', () => {
    expect(matchPathPattern('/tables/[id=5]/name', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })

  it('matches ERCanvas table field with name addressing', () => {
    expect(matchPathPattern('/tables/[name=users]/comment', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })

  it('matches array append', () => {
    expect(matchPathPattern('/tables/[id=5]/columns/-', '/tables/[<key>=<val>]/columns/-')).toBe(true)
  })

  it('matches remove with context', () => {
    expect(matchPathPattern('/columns/[id=10]/[tableId=5]', '/columns/[id=<n>]/[tableId=<n>]')).toBe(true)
  })

  it('matches relation remove', () => {
    expect(matchPathPattern('/relations/[id=7]', '/relations/[id=<n>]')).toBe(true)
  })

  it('rejects mismatched paths', () => {
    expect(matchPathPattern('/relations/[id=7]', '/tables/[id=<n>]/<field>')).toBe(false)
  })

  it('matches nested position field', () => {
    expect(matchPathPattern('/tables/[id=5]/position/x', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/ui/__tests__/pathResolver.test.ts 2>&1`

Expected: FAIL — module `../pathResolver` not found

- [ ] **Step 3: Implement pathResolver**

Create `src/mcp/ui/pathResolver.ts`:

```typescript
// ── Path Segment ──────────────────────────────────────────

export interface PathSegment {
  /** Field name, e.g. "tables", "columns", "name". Empty string for context-only segments. */
  field: string
  /** Address filters, e.g. { id: "5" } or { name: "users" } */
  filters?: Record<string, string>
  /** True for "-" (array append) */
  isAppend?: boolean
}

// ── Regex for [key=value] ─────────────────────────────────

// Matches: [key=value] — no spaces, value can contain letters/digits/underscore/hyphen
const FILTER_RE = /\[(\w+)=([^\]]+)\]/g

/**
 * Parse unified path syntax into segments.
 *
 * Supported formats:
 *   /tables/[id=5]/name            — ERCanvas style (filter as separate segment)
 *   /columns[name=email]/dataType  — TableForm style (filter attached to field)
 *   /tables/[id=5]/columns/-       — Array append
 *   /columns/[id=10]/[tableId=5]   — Remove with context
 *   /content                       — Simple field
 */
export function parsePath(path: string): PathSegment[] {
  const raw = path.replace(/^\//, '')
  if (!raw) return []

  const tokens = raw.split('/')
  const segments: PathSegment[] = []

  for (const token of tokens) {
    if (token === '-') {
      // Array append — mark previous segment
      if (segments.length > 0) {
        segments[segments.length - 1].isAppend = true
      }
      continue
    }

    // Check if token is purely a filter: [key=value]
    if (token.startsWith('[')) {
      const filters: Record<string, string> = {}
      let m: RegExpExecArray | null
      FILTER_RE.lastIndex = 0
      while ((m = FILTER_RE.exec(token)) !== null) {
        filters[m[1]] = m[2]
      }
      if (Object.keys(filters).length > 0) {
        // Standalone filter — attach to previous segment if possible, else create empty-field segment
        if (segments.length > 0 && !segments[segments.length - 1].filters) {
          segments[segments.length - 1].filters = filters
        } else {
          segments.push({ field: '', filters })
        }
      }
      continue
    }

    // Check if token has inline filters: field[key=value]
    FILTER_RE.lastIndex = 0
    const inlineMatch = token.match(/^([^[]+)/)
    const fieldName = inlineMatch ? inlineMatch[1] : token

    const filters: Record<string, string> = {}
    let m: RegExpExecArray | null
    FILTER_RE.lastIndex = 0
    while ((m = FILTER_RE.exec(token)) !== null) {
      filters[m[1]] = m[2]
    }

    const segment: PathSegment = { field: fieldName }
    if (Object.keys(filters).length > 0) {
      segment.filters = filters
    }
    segments.push(segment)
  }

  return segments
}

// ── Pattern matching ──────────────────────────────────────

/**
 * Check if a concrete path matches a capability pattern.
 *
 * Pattern placeholders:
 *   <n>     — matches any number
 *   <s>     — matches any string
 *   <val>   — matches any value
 *   <key>   — matches any key name
 *   <field> — matches one or more remaining path segments
 *
 * Example: matchPathPattern('/tables/[id=5]/name', '/tables/[<key>=<val>]/<field>') → true
 */
export function matchPathPattern(path: string, pattern: string): boolean {
  const pathParts = path.replace(/^\//, '').split('/')
  const patternParts = pattern.replace(/^\//, '').split('/')

  let pi = 0
  let pp = 0

  while (pi < pathParts.length && pp < patternParts.length) {
    const pathToken = pathParts[pi]
    const patternToken = patternParts[pp]

    // <field> matches all remaining segments
    if (patternToken === '<field>') return true

    // Both are filter tokens: [key=value] vs [<key>=<val>] or [id=<n>]
    if (patternToken.includes('[') && pathToken.includes('[')) {
      // Normalize: extract field parts and filter parts
      const pathField = pathToken.replace(/\[.*/, '')
      const patternField = patternToken.replace(/\[.*/, '')

      // Field names must match (or pattern field is empty for pure filter tokens)
      if (pathField !== patternField && patternField !== '' && pathField !== '') {
        return false
      }

      // Filters: pattern has placeholders, path has concrete values — always match
      pi++
      pp++
      continue
    }

    // Plain tokens must match exactly
    if (pathToken !== patternToken && patternToken !== '<field>') {
      return false
    }

    pi++
    pp++
  }

  // <field> at end of pattern consumes remaining
  if (pp < patternParts.length && patternParts[pp] === '<field>') return true

  return pi === pathParts.length && pp === patternParts.length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp/ui/__tests__/pathResolver.test.ts 2>&1`

Expected: All 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/pathResolver.ts src/mcp/ui/__tests__/pathResolver.test.ts
git commit -m "feat(mcp): add unified path resolver with dual-mode [id=n]/[name=xxx] addressing"
```

---

### Task 4: UIRouter Validation Layer

**Files:**
- Modify: `src/mcp/ui/UIRouter.ts`
- Modify: `src/mcp/ui/__tests__/UIRouter.test.ts`

- [ ] **Step 1: Write failing tests for pre-checks**

Append to `src/mcp/ui/__tests__/UIRouter.test.ts` (after the last `it()` block, inside the `describe` block):

```typescript
  // ── Exec pre-check tests ────────────────────────────────
  it('exec pre-check: rejects unknown action with available list', async () => {
    const obj = mockUIObject({
      read: vi.fn().mockReturnValue([
        { name: 'save', description: 'Save', paramsSchema: { type: 'object', properties: {} } },
        { name: 'run', description: 'Run', paramsSchema: { type: 'object', properties: {} } },
      ]),
    })
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_exec', object: 'test_form', target: 'test_1',
      payload: { action: 'nonexistent', params: {} },
    })
    expect(res.error).toContain("Unknown action 'nonexistent'")
    expect(res.error).toContain('save')
    expect(res.error).toContain('run')
    expect(obj.exec).not.toHaveBeenCalled()
  })

  it('exec pre-check: rejects missing required params', async () => {
    const obj = mockUIObject({
      read: vi.fn().mockReturnValue([
        {
          name: 'add_column',
          description: 'Add column',
          paramsSchema: { type: 'object', properties: { tableId: { type: 'number' }, column: { type: 'object' } }, required: ['tableId', 'column'] },
        },
      ]),
    })
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_exec', object: 'test_form', target: 'test_1',
      payload: { action: 'add_column', params: {} },
    })
    expect(res.error).toContain('Missing required params')
    expect(res.error).toContain('tableId')
    expect(res.error).toContain('column')
    expect(obj.exec).not.toHaveBeenCalled()
  })

  it('exec pre-check: passes through when action and params are valid', async () => {
    const obj = mockUIObject({
      read: vi.fn().mockReturnValue([
        {
          name: 'save',
          description: 'Save',
          paramsSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        },
      ]),
    })
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_exec', object: 'test_form', target: 'test_1',
      payload: { action: 'save', params: { id: 1 } },
    })
    expect(obj.exec).toHaveBeenCalledWith('save', { id: 1 })
    expect(res.data?.success).toBe(true)
  })

  // ── Patch pre-check tests ───────────────────────────────
  it('patch pre-check: rejects unsupported path when capabilities declared', async () => {
    const obj = mockUIObject({
      patchCapabilities: [
        { pathPattern: '/content', ops: ['replace'], description: 'Replace content' },
      ],
    } as any)
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_patch', object: 'test_form', target: 'test_1',
      payload: { ops: [{ op: 'add', path: '/relations/-', value: {} }] },
    })
    expect(res.error).toContain('Unsupported')
    expect(res.error).toContain('/relations/-')
    expect(obj.patch).not.toHaveBeenCalled()
  })

  it('patch pre-check: passes through when no capabilities declared', async () => {
    const obj = mockUIObject() // no patchCapabilities
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_patch', object: 'test_form', target: 'test_1',
      payload: { ops: [{ op: 'replace', path: '/anything', value: 'ok' }] },
    })
    expect(obj.patch).toHaveBeenCalled()
    expect(res.status).toBe('applied')
  })

  it('patch pre-check: allows matching path', async () => {
    const obj = mockUIObject({
      patchCapabilities: [
        { pathPattern: '/tables/[<key>=<val>]/<field>', ops: ['replace'], description: 'Update table' },
      ],
    } as any)
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_patch', object: 'test_form', target: 'test_1',
      payload: { ops: [{ op: 'replace', path: '/tables/[id=5]/name', value: 'new' }] },
    })
    expect(obj.patch).toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/mcp/ui/__tests__/UIRouter.test.ts 2>&1`

Expected: New tests FAIL (UIRouter doesn't have pre-check logic yet), old tests still PASS.

- [ ] **Step 3: Implement UIRouter validation layer**

Replace `src/mcp/ui/UIRouter.ts` content:

```typescript
import type { UIObject, UIRequest, UIResponse, UIObjectInfo, ActionDef } from './types'
import { patchError, execError } from './errors'
import { matchPathPattern } from './pathResolver'

export class UIRouter {
  private instances = new Map<string, UIObject>()
  private _getActiveTabId: (() => string | null) | null = null

  /** Inject a function that returns the currently active tab ID. Avoids circular deps with store. */
  setActiveTabIdProvider(fn: () => string | null) {
    this._getActiveTabId = fn
  }

  registerInstance(objectId: string, instance: UIObject) {
    this.instances.set(objectId, instance)
  }

  unregisterInstance(objectId: string) {
    this.instances.delete(objectId)
  }

  async handle(req: UIRequest): Promise<UIResponse> {
    if (req.tool === 'ui_list') {
      return this.handleList(req.payload?.filter)
    }

    const instance = this.resolveTarget(req.object, req.target)
    if (!instance) {
      return { error: `No ${req.object} found for target '${req.target}'` }
    }

    try {
      switch (req.tool) {
        case 'ui_read': {
          const data = instance.read(req.payload?.mode ?? 'state')
          return { data }
        }
        case 'ui_patch':
          return this.handlePatch(instance, req.payload)
        case 'ui_exec':
          return this.handleExec(instance, req.payload)
        default:
          return { error: `Unknown tool: ${req.tool}` }
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  // ── Patch pre-check ───────────────────────────────────────

  private async handlePatch(instance: UIObject, payload: any): Promise<UIResponse> {
    const ops = payload?.ops ?? []
    const capabilities = instance.patchCapabilities

    // No capabilities declared → passthrough (backward compatible)
    if (!capabilities?.length) {
      const result = await instance.patch(ops, payload?.reason)
      return {
        data: result,
        status: result.status === 'error' ? undefined : result.status,
        confirm_id: result.confirm_id,
        error: result.status === 'error' ? result.message : undefined,
      }
    }

    // Validate each op against declared capabilities
    for (const op of ops) {
      const match = capabilities.find(
        cap => cap.ops.includes(op.op) && matchPathPattern(op.path, cap.pathPattern),
      )
      if (!match) {
        const supported = capabilities
          .map(c => `${c.ops.join('/')} ${c.pathPattern}`)
          .join(', ')
        const result = patchError(
          `Unsupported: ${op.op} ${op.path}`,
          `Supported paths: [${supported}]`,
          `Use ui_read(mode='actions') for operations not available via patch`,
        )
        return { error: result.message }
      }
    }

    const result = await instance.patch(ops, payload?.reason)
    return {
      data: result,
      status: result.status === 'error' ? undefined : result.status,
      confirm_id: result.confirm_id,
      error: result.status === 'error' ? result.message : undefined,
    }
  }

  // ── Exec pre-check ────────────────────────────────────────

  private async handleExec(instance: UIObject, payload: any): Promise<UIResponse> {
    const action = payload?.action ?? ''
    const params = payload?.params

    // Get action definitions for validation
    const actions: ActionDef[] = instance.read('actions') ?? []

    // Check action exists
    const def = actions.find(a => a.name === action)
    if (!def) {
      const available = actions.map(a => a.name).join(', ')
      const result = execError(
        `Unknown action '${action}'`,
        `Available actions: [${available}]`,
      )
      return { data: result, error: result.error }
    }

    // Check required params
    const required = def.paramsSchema?.required ?? []
    const missing = required.filter(key => params?.[key] === undefined)
    if (missing.length) {
      const result = execError(
        `Missing required params: ${missing.join(', ')}`,
        `Schema: ${JSON.stringify(def.paramsSchema)}`,
      )
      return { data: result, error: result.error }
    }

    // Forward to adapter
    const result = await instance.exec(action, params)
    return { data: result, error: result.success ? undefined : result.error }
  }

  private resolveTarget(objectType: string, target: string): UIObject | null {
    if (target && target !== 'active') {
      return this.instances.get(target) ?? null
    }
    // "active" → use injected provider to find the currently active tab
    const activeTabId = this._getActiveTabId?.()
    if (activeTabId) {
      const instance = this.instances.get(activeTabId)
      if (instance && (!objectType || instance.type === objectType)) return instance
    }
    // fallback: find first instance of matching type
    for (const [, obj] of this.instances) {
      if (!objectType || obj.type === objectType) return obj
    }
    return null
  }

  private handleList(filter?: { type?: string; keyword?: string; connectionId?: number; database?: string }): UIResponse {
    const results: UIObjectInfo[] = []
    for (const [, obj] of this.instances) {
      if (filter?.type && obj.type !== filter.type) continue
      if (filter?.connectionId != null && obj.connectionId !== filter.connectionId) continue
      if (filter?.keyword) {
        const haystack = `${obj.title} ${obj.objectId}`.toLowerCase()
        if (!haystack.includes(filter.keyword.toLowerCase())) continue
      }
      results.push({
        objectId: obj.objectId,
        type: obj.type,
        title: obj.title,
        connectionId: obj.connectionId,
      })
    }
    return { data: results }
  }
}

export const uiRouter = new UIRouter()
```

- [ ] **Step 4: Run all UIRouter tests**

Run: `npx vitest run src/mcp/ui/__tests__/UIRouter.test.ts 2>&1`

Expected: All tests PASS (old + new)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/UIRouter.ts src/mcp/ui/__tests__/UIRouter.test.ts
git commit -m "feat(mcp): add UIRouter validation layer — patch pre-check + exec pre-check"
```

---

### Task 5: ERCanvasAdapter Refactor

**Files:**
- Modify: `src/mcp/ui/adapters/ERCanvasAdapter.ts`
- Create: `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts`

This is the largest task. It modifies ERCanvasAdapter to:
1. Add `patchCapabilities` property
2. Replace 3 regex parsers with `parsePath()`
3. Support `[name=xxx]` addressing for tables
4. Use `patchError()`/`execError()` for all error messages
5. Include `patchCapabilities` in `read('schema')` response

- [ ] **Step 1: Write failing tests for ERCanvasAdapter**

Create `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the stores and tauri before importing the adapter
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockStore = {
  projects: [{ id: 1, name: 'Test', connection_id: null }],
  tables: [
    { id: 10, name: 'users', position_x: 0, position_y: 0 },
    { id: 20, name: 'orders', position_x: 100, position_y: 100 },
  ],
  columns: {
    10: [{ id: 100, name: 'id', data_type: 'INT', nullable: false, is_primary_key: true, is_auto_increment: true, is_unique: false, unsigned: false, default_value: null, comment: null, length: null, scale: null, enum_values: null, sort_order: 0 }],
    20: [{ id: 200, name: 'id', data_type: 'INT', nullable: false, is_primary_key: true, is_auto_increment: true, is_unique: false, unsigned: false, default_value: null, comment: null, length: null, scale: null, enum_values: null, sort_order: 0 }],
  },
  relations: [],
  indexes: { 10: [], 20: [] },
  updateTable: vi.fn(),
  updateColumn: vi.fn(),
  addColumn: vi.fn().mockResolvedValue({ id: 999 }),
  addIndex: vi.fn().mockResolvedValue({ id: 888 }),
  deleteColumn: vi.fn(),
  deleteIndex: vi.fn(),
  deleteRelation: vi.fn(),
}

vi.mock('../../../store/erDesignerStore', () => ({
  useErDesignerStore: { getState: () => mockStore },
}))

import { ERCanvasAdapter } from '../adapters/ERCanvasAdapter'

describe('ERCanvasAdapter', () => {
  let adapter: ERCanvasAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new ERCanvasAdapter('project_1', 'Test Project', 1)
  })

  describe('patchCapabilities', () => {
    it('declares at least 6 capabilities', () => {
      expect(adapter.patchCapabilities).toBeDefined()
      expect(adapter.patchCapabilities!.length).toBeGreaterThanOrEqual(6)
    })

    it('every capability has pathPattern, ops, and description', () => {
      for (const cap of adapter.patchCapabilities!) {
        expect(cap.pathPattern).toBeTruthy()
        expect(cap.ops.length).toBeGreaterThan(0)
        expect(cap.description).toBeTruthy()
      }
    })
  })

  describe('read("schema") includes patchCapabilities', () => {
    it('includes patchCapabilities in schema response', () => {
      const schema = adapter.read('schema')
      expect(schema.patchCapabilities).toBeDefined()
      expect(schema.patchCapabilities.length).toBeGreaterThanOrEqual(6)
    })
  })

  describe('patch with name addressing', () => {
    it('replaces table field via [name=users]', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[name=users]/comment', value: 'User accounts' },
      ])
      expect(result.status).toBe('applied')
      expect(mockStore.updateTable).toHaveBeenCalledWith(10, { comment: 'User accounts' })
    })

    it('returns descriptive error for non-existent table name', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[name=nonexistent]/comment', value: 'x' },
      ])
      expect(result.status).toBe('error')
      expect(result.message).toContain('nonexistent')
      expect(result.message).toContain('Expected')
    })

    it('still supports [id=N] addressing', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[id=10]/comment', value: 'Updated' },
      ])
      expect(result.status).toBe('applied')
      expect(mockStore.updateTable).toHaveBeenCalledWith(10, { comment: 'Updated' })
    })
  })

  describe('patch error messages use standardized format', () => {
    it('unsupported op includes Expected hint', async () => {
      const result = await adapter.patch([
        { op: 'move', path: '/tables/[id=10]', from: '/tables/[id=20]' } as any,
      ])
      expect(result.status).toBe('error')
      expect(result.message).toContain('Expected')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/ui/__tests__/ERCanvasAdapter.test.ts 2>&1`

Expected: FAIL — adapter doesn't have `patchCapabilities`, `read('schema')` doesn't include them, name addressing not supported.

- [ ] **Step 3: Add patchCapabilities property and update read('schema')**

In `src/mcp/ui/adapters/ERCanvasAdapter.ts`, add the import and property to the class. At the top of the file, add import:

```typescript
import { parsePath } from '../pathResolver'
import { patchError, execError } from '../errors'
```

Add `patchCapabilities` as a getter on the `ERCanvasAdapter` class (after the `connectionId` getter, around line 635):

```typescript
  get patchCapabilities(): PatchCapability[] {
    return [
      {
        pathPattern: '/tables/[<key>=<val>]/<field>',
        ops: ['replace'],
        description: 'Update table properties (name, comment, color, position/x, position/y)',
        addressableBy: ['id', 'name'],
      },
      {
        pathPattern: '/tables/[<key>=<val>]/columns/-',
        ops: ['add'],
        description: 'Append a column to a table',
        addressableBy: ['id', 'name'],
      },
      {
        pathPattern: '/tables/[<key>=<val>]/indexes/-',
        ops: ['add'],
        description: 'Append an index to a table',
        addressableBy: ['id', 'name'],
      },
      {
        pathPattern: '/columns/[id=<n>]/[tableId=<n>]',
        ops: ['remove'],
        description: 'Delete a column (requires tableId)',
        addressableBy: ['id'],
      },
      {
        pathPattern: '/indexes/[id=<n>]/[tableId=<n>]',
        ops: ['remove'],
        description: 'Delete an index (requires tableId)',
        addressableBy: ['id'],
      },
      {
        pathPattern: '/relations/[id=<n>]',
        ops: ['remove'],
        description: 'Delete a relation. To add/update relations, use ui_exec with add_relation/update_relation',
        addressableBy: ['id'],
      },
    ]
  }
```

Add import for `PatchCapability` type at the top:

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
```

Update `read('schema')` to include `patchCapabilities`:

```typescript
      case 'schema':
        return { ...ER_CANVAS_STATE_SCHEMA, patchCapabilities: this.patchCapabilities }
```

- [ ] **Step 4: Rewrite patch() to use parsePath and support name addressing**

Replace the entire `patch()` method (lines 716-795) with:

```typescript
  async patch(ops: JsonPatchOp[], _reason?: string): Promise<PatchResult> {
    const store = useErDesignerStore.getState()

    for (const op of ops) {
      try {
        switch (op.op) {
          case 'replace': {
            const segments = parsePath(op.path)
            if (segments.length < 2 || !segments[0].filters) {
              return patchError(
                `Cannot parse replace path "${op.path}"`,
                `/tables/[id=<n>]/<field> or /tables/[name=<s>]/<field> or /columns/[id=<n>]/<field>`,
              )
            }
            const entity = segments[0].field
            const filters = segments[0].filters
            const field = segments.slice(1).map(s => s.field).join('/')

            if (entity === 'tables') {
              const table = store.tables.find(t =>
                Object.entries(filters).every(([k, v]) => String((t as any)[k]) === v),
              )
              if (!table) {
                return patchError(
                  `Table not found: ${JSON.stringify(filters)}`,
                  `/tables/[id=<n>]/<field> or /tables/[name=<s>]/<field>`,
                )
              }
              const resolvedField = resolveField('table', field)
              await store.updateTable(table.id, { [resolvedField]: op.value })
            } else if (entity === 'columns') {
              const colId = Number(filters.id)
              if (!colId) {
                return patchError(
                  `Column addressing requires [id=<n>]`,
                  `/columns/[id=<n>]/<field>`,
                )
              }
              const resolvedField = resolveField('column', field)
              await store.updateColumn(colId, { [resolvedField]: op.value })
            } else {
              return patchError(
                `Cannot parse replace path "${op.path}"`,
                `/tables/[id=<n>]/<field> or /columns/[id=<n>]/<field>`,
              )
            }
            break
          }

          case 'add': {
            const segments = parsePath(op.path)
            // Expect: /tables/[filter]/collection/- where collection has isAppend
            const tableSegment = segments[0]
            const collSegment = segments.find(s => s.isAppend)
            if (!tableSegment?.filters || !collSegment) {
              return patchError(
                `Cannot parse add path "${op.path}"`,
                `/tables/[id=<n>]/columns/- or /tables/[name=<s>]/indexes/-`,
              )
            }
            const table = store.tables.find(t =>
              Object.entries(tableSegment.filters!).every(([k, v]) => String((t as any)[k]) === v),
            )
            if (!table) {
              return patchError(
                `Table not found: ${JSON.stringify(tableSegment.filters)}`,
                `/tables/[id=<n>]/columns/- or /tables/[name=<s>]/columns/-`,
              )
            }
            if (collSegment.field === 'columns') {
              await store.addColumn(table.id, op.value)
            } else if (collSegment.field === 'indexes') {
              const indexDef = { ...op.value }
              normalizeIndexColumns(indexDef)
              await store.addIndex(table.id, indexDef)
            } else {
              return patchError(
                `Cannot parse add path "${op.path}"`,
                `/tables/[id=<n>]/columns/- or /tables/[id=<n>]/indexes/-`,
              )
            }
            break
          }

          case 'remove': {
            const segments = parsePath(op.path)
            const entitySegment = segments[0]
            if (!entitySegment?.filters) {
              return patchError(
                `Cannot parse remove path "${op.path}"`,
                `/columns/[id=<n>]/[tableId=<n>], /indexes/[id=<n>]/[tableId=<n>], or /relations/[id=<n>]`,
              )
            }
            const entityId = Number(entitySegment.filters.id)
            const entity = entitySegment.field

            // Extract tableId from context segment (e.g. /[tableId=5])
            const ctxSegment = segments.find(s => s.field === '' && s.filters?.tableId)
            const tableId = ctxSegment ? Number(ctxSegment.filters!.tableId) : undefined

            if (entity === 'columns') {
              if (!tableId) {
                return patchError(
                  `remove /columns requires tableId`,
                  `/columns/[id=<n>]/[tableId=<n>]`,
                )
              }
              await store.deleteColumn(entityId, tableId)
            } else if (entity === 'indexes') {
              if (!tableId) {
                return patchError(
                  `remove /indexes requires tableId`,
                  `/indexes/[id=<n>]/[tableId=<n>]`,
                )
              }
              await store.deleteIndex(entityId, tableId)
            } else if (entity === 'relations') {
              await store.deleteRelation(entityId)
            } else {
              return patchError(
                `Cannot parse remove path "${op.path}"`,
                `/columns/[id=<n>]/[tableId=<n>], /indexes/[id=<n>]/[tableId=<n>], or /relations/[id=<n>]`,
              )
            }
            break
          }

          default:
            return patchError(
              `Unsupported patch op "${op.op}"`,
              `er_canvas supports "replace", "add", and "remove"`,
              `Use ui_exec for complex operations like add_relation`,
            )
        }
      } catch (e) {
        return patchError(String(e))
      }
    }

    return { status: 'applied' }
  }
```

- [ ] **Step 5: Delete the three old regex parser functions**

Delete these functions from the file (they are no longer used):
- `parsePatchPath()` (lines 582-592)
- `parseCollectionAppendPath()` (lines 594-599)
- `parseEntityRemovePath()` (lines 601-615)
- `ParsedPath` interface (lines 489-493)
- `ParsedCollectionPath` interface (lines 495-499)
- `ParsedEntityRemovePath` interface (lines 501-506)

Keep `FIELD_ALIASES`, `normalizeIndexColumns`, `resolveField`, `resolveVarRefs`, and `VAR_REF_RE` — these are still used.

- [ ] **Step 6: Run ERCanvasAdapter tests**

Run: `npx vitest run src/mcp/ui/__tests__/ERCanvasAdapter.test.ts 2>&1`

Expected: All tests PASS

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `npx vitest run src/mcp/ui/__tests__/ 2>&1`

Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/mcp/ui/adapters/ERCanvasAdapter.ts src/mcp/ui/__tests__/ERCanvasAdapter.test.ts
git commit -m "refactor(er-canvas): add patchCapabilities, name addressing, unified path resolver, standardized errors"
```

---

### Task 6: DbTreeAdapter + HistoryAdapter paramsSchema Normalization

**Files:**
- Modify: `src/mcp/ui/adapters/DbTreeAdapter.ts`
- Modify: `src/mcp/ui/adapters/HistoryAdapter.ts`

- [ ] **Step 1: Update DbTreeAdapter paramsSchema**

In `src/mcp/ui/adapters/DbTreeAdapter.ts`, replace the `case 'actions'` return (lines 43-54) with:

```typescript
      case 'actions':
        return [
          {
            name: 'search',
            description: 'Search tree nodes by keyword and optional type/connection filter',
            paramsSchema: {
              type: 'object',
              properties: {
                keyword: { type: 'string', description: 'Search keyword' },
                type: { type: 'string', description: 'Node type filter: table, view, procedure' },
                connection_id: { type: 'number', description: 'Limit search to a specific connection' },
              },
              required: ['keyword'],
            },
          },
          {
            name: 'refresh',
            description: 'Refresh tree data (reload all connections)',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'expand',
            description: 'Expand a tree node by its ID (loads children if needed)',
            paramsSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'Tree node ID to expand' },
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'select',
            description: 'Select/highlight a tree node by its ID',
            paramsSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'Tree node ID to select' },
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'locate_table',
            description: 'Expand the tree path to a specific table and select it. Loads all ancestor nodes automatically.',
            paramsSchema: {
              type: 'object',
              properties: {
                connection_id: { type: 'number', description: 'Database connection ID' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
                schema: { type: 'string', description: 'Schema name (optional, for postgres/oracle)' },
              },
              required: ['connection_id', 'table'],
            },
          },
        ]
```

- [ ] **Step 2: Update HistoryAdapter paramsSchema**

In `src/mcp/ui/adapters/HistoryAdapter.ts`, replace the `case 'actions'` return (lines 33-37) with:

```typescript
      case 'actions':
        return [
          {
            name: 'list',
            description: 'List change history entries',
            paramsSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Maximum entries to return (default: 50)' },
              },
            },
          },
          {
            name: 'undo',
            description: 'Undo last change',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: No new type errors from these two files. (Other adapters may still have type errors from Task 1 — that's expected.)

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/adapters/DbTreeAdapter.ts src/mcp/ui/adapters/HistoryAdapter.ts
git commit -m "fix(mcp): normalize DbTree + History paramsSchema to full JSON Schema"
```

---

### Task 7: System Prompt Update

**Files:**
- Modify: `prompts/chat_assistant.txt`

- [ ] **Step 1: Add Discovery-First Workflow section**

After the `#### ui_list(filter?)` section (after line 84), insert:

```markdown

### Discovery-First Workflow

Before operating any UI object for the first time, discover its capabilities:

1. `ui_read(object="<type>", mode="actions")` — See all available actions with parameter schemas
2. `ui_read(object="<type>", mode="schema")` — See patchable paths, addressable keys, and field types
3. Then choose: `ui_patch` for simple field updates, `ui_exec` for structured actions

**When to use which:**
- `ui_patch`: Updating individual fields visible in the schema (rename, change type, toggle a flag)
- `ui_exec`: Creating/deleting entities, batch operations, triggering side effects (save, run, import)
- When in doubt, use `ui_exec` — it covers everything `ui_patch` can do and more
```

- [ ] **Step 2: Add ER Diagram Workflow section**

After the Discovery-First Workflow section, insert:

```markdown

---

## ER Diagram Workflow

ER diagrams use `er_canvas` objects. Two convenience top-level tools are available:

- `init_er_table(table_name, columns, indexes?)` — Create one complete table in one call
- `er_batch(ops)` — Multi-step workflows with variable binding (`$0.tableId`, `$1.columnMap.user_id`)

**Create multiple tables with relations (创建多表并建立关系):**
```
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
```

**Modify existing tables (修改现有表):** Use `ui_exec(object="er_canvas", action="add_column"/"update_column"/...)` or `ui_patch` for simple field updates.

**Patch addressing:** ER canvas supports both `[id=5]` and `[name=users]`:
- `ui_patch(object="er_canvas", ops=[{op:"replace", path:"/tables/[name=users]/comment", value:"User accounts"}])`

**Relations cannot be added/updated via patch** — use `ui_exec` with `add_relation`/`update_relation`.
```

- [ ] **Step 3: Compress Table Creation Workflow**

Replace lines 88-151 (Table Creation Workflow + Editing an Existing Table) with:

```markdown

---

## Table Form Workflow (CREATE / ALTER TABLE)

1. Open: `ui_exec(object="workspace", action="open", params={type:"table_form", connection_id:1, database:"app"})`
   - For existing table: add `table:"users"` to edit its structure
2. Edit: `ui_patch(object="table_form", ops=[...])` — use `[name=xxx]` to address columns by name
3. Preview: `ui_exec(object="table_form", action="preview_sql")` — generates CREATE or ALTER TABLE SQL

Use `ui_read(object="table_form", mode="schema")` to see all patchable fields and `x-addressable-by` hints.
```

- [ ] **Step 4: Verify file is ~250 lines and reads well**

Run: `wc -l prompts/chat_assistant.txt`

Expected: ~240-260 lines

- [ ] **Step 5: Commit**

```bash
git add prompts/chat_assistant.txt
git commit -m "docs: update system prompt — add discovery-first workflow, ER canvas guide, compress table form docs"
```

---

### Task 8: Rust Tool Description Updates

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Update init_er_table description**

In `src-tauri/src/mcp/mod.rs` line 276, replace the description:

```rust
"description": "Create ONE complete table with columns and indexes in the active ER diagram. For single-table creation this is the simplest choice. For multi-table + relations, use er_batch instead (supports variable binding across operations). This is for ER DESIGN projects (visual schema design), NOT for connected databases — use init_table_form for that.",
```

- [ ] **Step 2: Update er_batch description**

In `src-tauri/src/mcp/mod.rs` line 328, replace the description:

```rust
"description": "Execute a sequence of ER canvas actions in one call with variable binding. Each op is {action, params}. Results from earlier ops can be referenced via \"$N.path\" syntax (e.g. \"$0.tableId\", \"$1.columnMap.user_id\", \"$2.columnIds[0]\"). Stops on first failure. Available actions: batch_create_table, add_table, update_table, delete_table, add_column, update_column, delete_column, add_relation, update_relation, delete_relation, add_index, update_index, delete_index, replace_columns, replace_indexes. Common patterns: create tables + relations (batch_create_table x N then add_relation), modify existing table (update_column/delete_column/add_column), rebuild columns (replace_columns).",
```

- [ ] **Step 3: Update ui_patch description**

In `src-tauri/src/mcp/mod.rs` line 191, append to the description string (before the closing `"`):

```
 Tip: call ui_read(mode='schema') first to see supported patch paths and addressable keys for the target object.
```

- [ ] **Step 4: Update ui_exec description**

In `src-tauri/src/mcp/mod.rs` line 205, replace the description:

```rust
"description": "Execute an action on a UI object (e.g. run_sql, save, preview_sql, format). Tip: call ui_read(mode='actions') first to see all available actions with parameter schemas.",
```

- [ ] **Step 5: Run cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "docs(mcp): improve tool descriptions — add action lists, discovery tips, usage guidance"
```

---

### Task 9: Phase 1 Final Verification

- [ ] **Step 1: Run full frontend test suite**

Run: `npx vitest run src/mcp/ui/__tests__/ 2>&1`

Expected: All tests PASS

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit 2>&1 | head -50`

Expected: Only type errors from Phase 2 adapters (QueryEditor, TableForm, MetricForm, SeaTunnel — their `paramsSchema` don't match `JsonSchema` yet). Note these are expected and will be fixed in Phase 2.

- [ ] **Step 3: Run cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

Expected: No errors

- [ ] **Step 4: Commit Phase 1 complete marker**

No code changes — this is a verification step only.

---

## Phase 2

### Task 10: QueryEditorAdapter

**Files:**
- Modify: `src/mcp/ui/adapters/QueryEditorAdapter.ts`

- [ ] **Step 1: Add patchCapabilities**

Add import and getter to `QueryEditorAdapter`:

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
```

Add getter after the `connectionId` property:

```typescript
  get patchCapabilities(): PatchCapability[] {
    return [
      { pathPattern: '/content', ops: ['replace'], description: 'Replace SQL content' },
      { pathPattern: '/connectionId', ops: ['replace'], description: 'Switch connection' },
      { pathPattern: '/database', ops: ['replace'], description: 'Switch database' },
      { pathPattern: '/schema', ops: ['replace'], description: 'Switch schema' },
    ]
  }
```

Update `read('schema')` to include patchCapabilities:

```typescript
      case 'schema':
        return {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'SQL content' },
            connectionId: { type: 'number', description: 'Connection ID for query execution' },
            database: { type: 'string', description: 'Target database name' },
            schema: { type: 'string', description: 'Target schema name (PostgreSQL/Oracle)' },
          },
          patchCapabilities: this.patchCapabilities,
        }
```

- [ ] **Step 2: Add full paramsSchema to all actions**

Replace the `case 'actions'` return with:

```typescript
      case 'actions':
        return [
          { name: 'run_sql', description: 'Execute the SQL in this tab', paramsSchema: { type: 'object', properties: {} } },
          { name: 'format', description: 'Format/beautify the SQL', paramsSchema: { type: 'object', properties: {} } },
          { name: 'undo', description: 'Undo last change', paramsSchema: { type: 'object', properties: {} } },
          { name: 'focus', description: 'Switch to this tab', paramsSchema: { type: 'object', properties: {} } },
          {
            name: 'set_context',
            description: 'Set connection/database/schema context for this query tab',
            paramsSchema: {
              type: 'object',
              properties: {
                connectionId: { type: 'number', description: 'Database connection ID' },
                database: { type: 'string', description: 'Database name' },
                schema: { type: 'string', description: 'Schema name (PostgreSQL/Oracle)' },
              },
            },
          },
        ]
```

- [ ] **Step 3: Standardize error messages**

In the `set_context` case of `exec()`, replace the error return with:

```typescript
import { execError } from '../errors'

// In set_context case:
if (Object.keys(ctx).length === 0) {
  return execError('No context fields provided', 'Pass at least one of: connectionId, database, schema')
}
```

In the default case:

```typescript
default:
  return execError(`Unknown action: ${action}`, `Available actions: run_sql, format, undo, focus, set_context`)
```

- [ ] **Step 4: Run type check and tests**

Run: `npx tsc --noEmit 2>&1 | grep QueryEditorAdapter` and `npx vitest run src/mcp/ui/__tests__/ 2>&1`

Expected: No type errors from QueryEditorAdapter, all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/adapters/QueryEditorAdapter.ts
git commit -m "refactor(query-editor): add patchCapabilities, complete paramsSchema, standardize errors"
```

---

### Task 11: TableFormAdapter

**Files:**
- Modify: `src/mcp/ui/adapters/TableFormAdapter.ts`

- [ ] **Step 1: Add patchCapabilities and complete paramsSchema**

Add import:

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
```

Add getter to `TableFormUIObject`:

```typescript
  get patchCapabilities(): PatchCapability[] {
    return [
      { pathPattern: '/tableName', ops: ['replace'], description: 'Rename the table' },
      { pathPattern: '/engine', ops: ['replace'], description: 'Change storage engine' },
      { pathPattern: '/charset', ops: ['replace'], description: 'Change charset' },
      { pathPattern: '/comment', ops: ['replace'], description: 'Change table comment' },
      {
        pathPattern: '/columns[name=<s>]/<field>',
        ops: ['replace', 'remove'],
        description: 'Modify or remove a column by name',
        addressableBy: ['name'],
      },
      {
        pathPattern: '/columns/-',
        ops: ['add'],
        description: 'Append a new column',
      },
      {
        pathPattern: '/indexes[name=<s>]/<field>',
        ops: ['replace', 'remove'],
        description: 'Modify or remove an index by name',
        addressableBy: ['name'],
      },
      {
        pathPattern: '/indexes/-',
        ops: ['add'],
        description: 'Append a new index',
      },
    ]
  }
```

Update `read('schema')`:

```typescript
      case 'schema':
        return { ...TABLE_FORM_SCHEMA, patchCapabilities: this.patchCapabilities }
```

Replace `case 'actions'`:

```typescript
      case 'actions':
        return [
          {
            name: 'preview_sql',
            description: 'Preview CREATE/ALTER TABLE SQL based on current form state',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'save',
            description: 'Generate SQL and write to query tab for review',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
```

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit 2>&1 | grep TableFormAdapter` and `npx vitest run src/mcp/ui/__tests__/TableFormAdapter.test.ts 2>&1`

Expected: No type errors, existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/adapters/TableFormAdapter.ts
git commit -m "refactor(table-form): add patchCapabilities, complete paramsSchema"
```

---

### Task 12: MetricFormAdapter

**Files:**
- Modify: `src/mcp/ui/adapters/MetricFormAdapter.ts`

- [ ] **Step 1: Add patchCapabilities and complete paramsSchema**

Add imports:

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { execError } from '../errors'
```

Add getter to `MetricFormUIObject`:

```typescript
  get patchCapabilities(): PatchCapability[] {
    return [
      { pathPattern: '/displayName', ops: ['replace'], description: 'Change display name' },
      { pathPattern: '/name', ops: ['replace'], description: 'Change identifier' },
      { pathPattern: '/metricType', ops: ['replace'], description: 'Change metric type (atomic/composite)' },
      { pathPattern: '/tableName', ops: ['replace'], description: 'Change source table' },
      { pathPattern: '/columnName', ops: ['replace'], description: 'Change aggregation column' },
      { pathPattern: '/aggregation', ops: ['replace'], description: 'Change aggregation function' },
      { pathPattern: '/filterSql', ops: ['replace'], description: 'Change SQL filter clause' },
      { pathPattern: '/category', ops: ['replace'], description: 'Change category' },
      { pathPattern: '/description', ops: ['replace'], description: 'Change description' },
    ]
  }
```

Update `read('schema')`:

```typescript
      case 'schema':
        return { ...METRIC_FORM_SCHEMA, patchCapabilities: this.patchCapabilities }
```

Replace `case 'actions'`:

```typescript
      case 'actions':
        return [
          {
            name: 'save',
            description: 'Save metric definition to database',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'validate',
            description: 'Validate metric fields and return any errors',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
```

Update error messages in `exec()`:

```typescript
    if (!state) return execError('No form state', `Metric form ${this.objectId} not initialized`)

    // In default case:
    default:
      return execError(`Unknown action: ${action}`, 'Available actions: save, validate')
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit 2>&1 | grep MetricFormAdapter`

Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/adapters/MetricFormAdapter.ts
git commit -m "refactor(metric-form): add patchCapabilities, complete paramsSchema, standardize errors"
```

---

### Task 13: SeaTunnelJobAdapter

**Files:**
- Modify: `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts`

- [ ] **Step 1: Add patchCapabilities and complete paramsSchema**

Add imports:

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { execError } from '../errors'
```

Add getter to `SeaTunnelJobUIObject`:

```typescript
  get patchCapabilities(): PatchCapability[] {
    return [
      { pathPattern: '/jobName', ops: ['replace'], description: 'Change job name' },
      { pathPattern: '/configJson', ops: ['replace'], description: 'Replace entire job config JSON' },
      { pathPattern: '/connectionId', ops: ['replace'], description: 'Change connection' },
      { pathPattern: '/categoryId', ops: ['replace'], description: 'Change category' },
    ]
  }
```

Update `read('schema')`:

```typescript
      case 'schema':
        return { ...SEATUNNEL_JOB_SCHEMA, patchCapabilities: this.patchCapabilities }
```

Replace `case 'actions'`:

```typescript
      case 'actions':
        return [
          {
            name: 'save',
            description: 'Save job configuration to database',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'submit',
            description: 'Submit job for execution (must be saved first)',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'stop',
            description: 'Stop a running job',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
```

Update error messages in `exec()`:

```typescript
    if (!state) return execError('No form state', `SeaTunnel job form ${this.objectId} not initialized`)

    // In submit case:
    if (!state.jobId) return execError('Job not saved yet', 'Call save action first')

    // In stop case:
    if (!state.jobId) return execError('No job to stop', 'Job must be saved and submitted first')

    // In default case:
    default:
      return execError(`Unknown action: ${action}`, 'Available actions: save, submit, stop')
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit 2>&1 | grep SeaTunnelJobAdapter`

Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/adapters/SeaTunnelJobAdapter.ts
git commit -m "refactor(seatunnel): add patchCapabilities, complete paramsSchema, standardize errors"
```

---

### Task 14: Phase 2 Final Verification

- [ ] **Step 1: Run full TypeScript type check**

Run: `npx tsc --noEmit 2>&1`

Expected: ZERO type errors

- [ ] **Step 2: Run full frontend test suite**

Run: `npx vitest run src/mcp/ui/__tests__/ 2>&1`

Expected: All tests PASS

- [ ] **Step 3: Run cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

Expected: No errors

- [ ] **Step 4: Summary of all changes**

Verify all files touched match the plan's file map. No extra files, no missing files.
