# UI Object Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragmented `fs_*` MCP protocol with a unified `ui_*` protocol that allows AI to read, patch, and exec any UI element through JSON Patch (RFC 6902), enabling multi-round conversational editing of forms, canvases, and panels.

**Architecture:** All `ui_*` MCP tool calls are forwarded from Rust to the frontend `UIRouter`, which dispatches to registered `UIObject` adapters. Each adapter wraps a Zustand store slice, making state readable and patchable by AI. Auto Mode controls whether patches apply immediately or require user confirmation via `PatchConfirmPanel`.

**Tech Stack:** TypeScript, React 18, Zustand, Tauri 2.x (Rust), JSON Patch RFC 6902

**Spec:** `docs/superpowers/specs/2026-03-28-ui-object-protocol-design.md`

---

## File Structure

### New Files

```
src/mcp/ui/
  types.ts                          — UIObject interface, JsonPatchOp, PatchResult, ExecResult, UIRequest/UIResponse
  jsonPatch.ts                      — RFC 6902 apply + [name=xxx] extension, atomic semantics
  UIRouter.ts                       — Core router: adapter registry, instance registry, target resolution, handle()
  useUIObjectRegistry.ts            — React hook: register/unregister UIObject on mount/unmount
  index.ts                          — registerAllAdapters() entry point
  adapters/
    WorkspaceAdapter.ts             — Global: open/close/focus tabs
    QueryEditorAdapter.ts           — SQL editor: read/patch content, exec run_sql/format/undo
    TableFormAdapter.ts             — New/edit table form: read/patch columns/tableName, exec save/preview_sql
    MetricFormAdapter.ts            — Metric definition form
    SeaTunnelJobAdapter.ts          — SeaTunnel job config
    DbTreeAdapter.ts                — Database tree panel (search only)
    HistoryAdapter.ts               — Change history panel
    ERCanvasAdapter.ts              — ER diagram (stub)
  __tests__/
    jsonPatch.test.ts               — RFC 6902 ops + [name=xxx] extension + atomic rollback
    UIRouter.test.ts                — Routing, target resolution, ui_list
    WorkspaceAdapter.test.ts        — open/close/focus
    QueryEditorAdapter.test.ts      — read/patch/exec
    TableFormAdapter.test.ts        — read/patch/exec with schema

src/store/
  patchConfirmStore.ts              — Pending patch queue for non-Auto mode

src/components/Assistant/
  PatchConfirmPanel.tsx             — Unified confirm panel (replaces DiffPanel)
```

### Modified Files

```
src-tauri/src/mcp/mod.rs            — Replace fs_* tool defs + routing with ui_*
src-tauri/src/mcp/tools/mod.rs      — Remove fs_* module declarations
src-tauri/src/mcp/tools/table_edit.rs — Expose functions as #[tauri::command]
src-tauri/src/mcp/tools/tab_control.rs — Add "ui_request" event support
src-tauri/src/lib.rs                — Register new tauri commands in generate_handler![]

src/hooks/useMcpBridge.ts           — Replace fs_request listener with ui_request → UIRouter
src/store/queryStore.ts             — Remove initialColumns/initialTableName params; keep proposeSqlDiff for QueryEditorAdapter
src/types/index.ts                  — Remove initialColumns/initialTableName from Tab interface
src/components/MainContent/TableStructureView.tsx — Lift state to Zustand, register UIObject
src/components/Assistant/index.tsx  — Replace DiffPanel with PatchConfirmPanel

prompts/chat_assistant.txt          — Full rewrite around ui_* protocol
```

### Deleted Files

```
src/mcp/fs/types.ts
src/mcp/fs/FsRouter.ts
src/mcp/fs/FsRouter.test.ts
src/mcp/fs/index.ts
src/mcp/fs/adapters/QueryTabAdapter.ts
src/mcp/fs/adapters/DbTreeAdapter.ts
src/mcp/fs/e2e.test.ts
src/components/Assistant/DiffPanel.tsx

src-tauri/src/mcp/tools/fs_table.rs
src-tauri/src/mcp/tools/fs_metric.rs
src-tauri/src/mcp/tools/fs_seatunnel.rs
src-tauri/src/mcp/tools/fs_history.rs
```

---

## Task 1: UI Protocol Types

**Files:**
- Create: `src/mcp/ui/types.ts`

> **Must be done first** — jsonPatch.ts and all adapters import from this file.

- [ ] **Step 1: Create types file**

```typescript
// src/mcp/ui/types.ts

// ── JSON Patch (RFC 6902) ──────────────────────────────────

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy'
  path: string        // JSON Pointer (RFC 6901) or [key=value] extension
  value?: any          // required for add/replace
  from?: string        // required for move/copy
}

// ── MCP Request / Response ─────────────────────────────────

export interface UIRequest {
  tool: 'ui_read' | 'ui_patch' | 'ui_exec' | 'ui_list'
  object: string       // object type: query_editor, table_form, etc.
  target: string       // objectId or "active"
  payload: any         // tool-specific payload
}

export interface UIResponse {
  data?: any
  error?: string
  status?: 'applied' | 'pending_confirm'
  confirm_id?: string
}

// ── UIObject Interface ─────────────────────────────────────

export interface UIObject {
  type: string
  objectId: string
  title: string
  connectionId?: number

  read(mode: 'state' | 'schema' | 'actions'): any
  patch(ops: JsonPatchOp[], reason?: string): PatchResult | Promise<PatchResult>
  exec(action: string, params?: any): ExecResult | Promise<ExecResult>
}

export interface PatchResult {
  status: 'applied' | 'pending_confirm' | 'error'
  confirm_id?: string
  preview?: JsonPatchOp[]
  message?: string
}

export interface ExecResult {
  success: boolean
  data?: any
  error?: string
}

// ── Action Self-Description ────────────────────────────────

export interface ActionDef {
  name: string
  description: string
  paramsSchema?: Record<string, any>
}

// ── UIObject Info (for ui_list) ────────────────────────────

export interface UIObjectInfo {
  objectId: string
  type: string
  title: string
  connectionId?: number
  database?: string
}

// ── Patch Confirm Store ────────────────────────────────────

export interface PendingPatch {
  confirmId: string
  objectId: string
  objectType: string
  ops: JsonPatchOp[]
  reason?: string
  currentState: any
  onConfirm: () => void
  onReject?: () => void
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/ui/types.ts
git commit -m "feat(ui-protocol): add UIObject types and interfaces"
```

---

## Task 2: JSON Patch Engine

**Files:**
- Create: `src/mcp/ui/jsonPatch.ts`
- Create: `src/mcp/ui/__tests__/jsonPatch.test.ts`

This is the foundation — all adapters depend on it.

- [ ] **Step 1: Write failing tests for core RFC 6902 ops**

```typescript
// src/mcp/ui/__tests__/jsonPatch.test.ts
import { describe, it, expect } from 'vitest'
import { applyPatch } from '../jsonPatch'

describe('applyPatch - RFC 6902', () => {
  const base = {
    tableName: 'users',
    columns: [
      { name: 'id', dataType: 'INT' },
      { name: 'email', dataType: 'VARCHAR' },
    ],
  }

  it('replace scalar', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/tableName', value: 'orders' },
    ])
    expect(result.tableName).toBe('orders')
  })

  it('add to array end', () => {
    const result = applyPatch(base, [
      { op: 'add', path: '/columns/-', value: { name: 'age', dataType: 'INT' } },
    ])
    expect(result.columns).toHaveLength(3)
    expect(result.columns[2].name).toBe('age')
  })

  it('add at array index', () => {
    const result = applyPatch(base, [
      { op: 'add', path: '/columns/1', value: { name: 'name', dataType: 'VARCHAR' } },
    ])
    expect(result.columns).toHaveLength(3)
    expect(result.columns[1].name).toBe('name')
    expect(result.columns[2].name).toBe('email')
  })

  it('remove from array', () => {
    const result = applyPatch(base, [
      { op: 'remove', path: '/columns/0' },
    ])
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0].name).toBe('email')
  })

  it('replace nested field', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/columns/0/dataType', value: 'BIGINT' },
    ])
    expect(result.columns[0].dataType).toBe('BIGINT')
  })

  it('move array element', () => {
    const result = applyPatch(base, [
      { op: 'move', from: '/columns/0', path: '/columns/1' },
    ])
    expect(result.columns[0].name).toBe('email')
    expect(result.columns[1].name).toBe('id')
  })

  it('copy field', () => {
    const result = applyPatch(base, [
      { op: 'copy', from: '/tableName', path: '/comment' },
    ])
    expect((result as any).comment).toBe('users')
  })

  it('atomic: rolls back all on error', () => {
    expect(() =>
      applyPatch(base, [
        { op: 'replace', path: '/tableName', value: 'orders' },
        { op: 'replace', path: '/nonexistent/deep/path', value: 'fail' },
      ])
    ).toThrow()
    // original not mutated
    expect(base.tableName).toBe('users')
  })

  it('does not mutate original', () => {
    const original = structuredClone(base)
    applyPatch(base, [
      { op: 'replace', path: '/tableName', value: 'changed' },
    ])
    expect(base).toEqual(original)
  })
})
```

- [ ] **Step 2: Write failing tests for [name=xxx] extension**

```typescript
// append to jsonPatch.test.ts
describe('applyPatch - [key=value] addressing', () => {
  const base = {
    columns: [
      { name: 'id', dataType: 'INT' },
      { name: 'email', dataType: 'VARCHAR' },
      { name: 'amount', dataType: 'DECIMAL' },
    ],
  }

  it('replace by name', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/columns[name=amount]/dataType', value: 'BIGINT' },
    ])
    expect(result.columns[2].dataType).toBe('BIGINT')
  })

  it('remove by name', () => {
    const result = applyPatch(base, [
      { op: 'remove', path: '/columns[name=email]' },
    ])
    expect(result.columns).toHaveLength(2)
    expect(result.columns.every((c: any) => c.name !== 'email')).toBe(true)
  })

  it('throws on name not found', () => {
    expect(() =>
      applyPatch(base, [
        { op: 'replace', path: '/columns[name=nonexistent]/dataType', value: 'X' },
      ])
    ).toThrow()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/mcp/ui/__tests__/jsonPatch.test.ts`
Expected: FAIL — `applyPatch` not found

- [ ] **Step 4: Implement jsonPatch.ts**

```typescript
// src/mcp/ui/jsonPatch.ts
import type { JsonPatchOp } from './types'

/**
 * Apply RFC 6902 JSON Patch operations with atomic semantics.
 * Extension: paths may use [key=value] syntax for array element addressing.
 * Throws on any error; original is never mutated.
 */
export function applyPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  // Deep clone for immutability + atomic rollback
  let result = structuredClone(doc)

  for (const op of ops) {
    switch (op.op) {
      case 'add':
        result = applyAdd(result, resolvePath(result, op.path), op.value)
        break
      case 'remove':
        result = applyRemove(result, resolvePath(result, op.path))
        break
      case 'replace':
        result = applyReplace(result, resolvePath(result, op.path), op.value)
        break
      case 'move': {
        const fromPath = resolvePath(result, op.from!)
        const value = getByPath(result, fromPath)
        result = applyRemove(result, fromPath)
        result = applyAdd(result, resolvePath(result, op.path), value)
        break
      }
      case 'copy': {
        const value = getByPath(result, resolvePath(result, op.from!))
        result = applyAdd(result, resolvePath(result, op.path), structuredClone(value))
        break
      }
      default:
        throw new Error(`Unknown patch op: ${(op as any).op}`)
    }
  }

  return result
}

// ── Path Resolution ────────────────────────────────────────

/**
 * Resolve a JSON Pointer with optional [key=value] segments.
 * "/columns[name=id]/dataType" → "/columns/0/dataType" (resolved index)
 */
function resolvePath(doc: any, path: string): string {
  // Split path into tokens, preserving [key=value] segments
  const raw = path.replace(/^\/?/, '').split('/')
  const resolved: string[] = []

  let current = doc
  for (const token of raw) {
    const match = token.match(/^([^[]+)\[(\w+)=([^\]]+)\]$/)
    if (match) {
      const [, arrayField, key, value] = match
      resolved.push(arrayField)
      const arr = current[arrayField]
      if (!Array.isArray(arr)) throw new Error(`Path segment '${arrayField}' is not an array`)
      const idx = arr.findIndex((item: any) => String(item[key]) === value)
      if (idx === -1) throw new Error(`No element with ${key}=${value} in ${arrayField}`)
      resolved.push(String(idx))
      current = arr[idx]
    } else {
      resolved.push(token)
      if (current != null && typeof current === 'object') {
        current = Array.isArray(current) ? current[Number(token)] : current[token]
      }
    }
  }

  return '/' + resolved.join('/')
}

// ── Pointer Utilities ──────────────────────────────────────

function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return []
  return path.replace(/^\//, '').split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function getByPath(doc: any, path: string): any {
  const tokens = parsePointer(path)
  let current = doc
  for (const t of tokens) {
    if (current == null) throw new Error(`Path not found: ${path}`)
    current = Array.isArray(current) ? current[Number(t)] : current[t]
  }
  return current
}

function getParentAndKey(doc: any, path: string): [any, string] {
  const tokens = parsePointer(path)
  if (tokens.length === 0) throw new Error('Cannot operate on root')
  const key = tokens.pop()!
  let current = doc
  for (const t of tokens) {
    if (current == null) throw new Error(`Path not found: ${path}`)
    current = Array.isArray(current) ? current[Number(t)] : current[t]
  }
  if (current == null) throw new Error(`Parent not found for: ${path}`)
  return [current, key]
}

// ── Operations ─────────────────────────────────────────────

function applyAdd<T>(doc: T, path: string, value: any): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(structuredClone(value))
    } else {
      const idx = Number(key)
      if (idx < 0 || idx > parent.length) throw new Error(`Array index out of bounds: ${idx}`)
      parent.splice(idx, 0, structuredClone(value))
    }
  } else {
    parent[key] = structuredClone(value)
  }
  return doc
}

function applyRemove<T>(doc: T, path: string): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    const idx = Number(key)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds: ${idx}`)
    parent.splice(idx, 1)
  } else {
    if (!(key in parent)) throw new Error(`Property not found: ${key}`)
    delete parent[key]
  }
  return doc
}

function applyReplace<T>(doc: T, path: string, value: any): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    const idx = Number(key)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds: ${idx}`)
    parent[idx] = structuredClone(value)
  } else {
    if (!(key in parent)) throw new Error(`Property not found: ${key}`)
    parent[key] = structuredClone(value)
  }
  return doc
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/mcp/ui/__tests__/jsonPatch.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/ui/jsonPatch.ts src/mcp/ui/__tests__/jsonPatch.test.ts
git commit -m "feat(ui-protocol): add JSON Patch engine with RFC 6902 + [name=xxx] extension"
```

---

## Task 3: UIRouter

**Files:**
- Create: `src/mcp/ui/UIRouter.ts`
- Create: `src/mcp/ui/__tests__/UIRouter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/mcp/ui/__tests__/UIRouter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UIRouter } from '../UIRouter'
import type { UIObject } from '../types'

function mockUIObject(overrides: Partial<UIObject> = {}): UIObject {
  return {
    type: 'test_form',
    objectId: 'test_1',
    title: 'Test',
    read: vi.fn().mockReturnValue({ field: 'value' }),
    patch: vi.fn().mockReturnValue({ status: 'applied' }),
    exec: vi.fn().mockReturnValue({ success: true }),
    ...overrides,
  }
}

describe('UIRouter', () => {
  let router: UIRouter

  beforeEach(() => {
    router = new UIRouter()
  })

  it('ui_read dispatches to instance.read()', async () => {
    const obj = mockUIObject()
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_read', object: 'test_form', target: 'test_1',
      payload: { mode: 'state' },
    })
    expect(obj.read).toHaveBeenCalledWith('state')
    expect(res.data).toEqual({ field: 'value' })
  })

  it('ui_patch dispatches to instance.patch()', async () => {
    const obj = mockUIObject()
    router.registerInstance('test_1', obj)
    const ops = [{ op: 'replace' as const, path: '/field', value: 'new' }]
    const res = await router.handle({
      tool: 'ui_patch', object: 'test_form', target: 'test_1',
      payload: { ops, reason: 'test' },
    })
    expect(obj.patch).toHaveBeenCalledWith(ops, 'test')
    expect(res.status).toBe('applied')
  })

  it('ui_exec dispatches to instance.exec()', async () => {
    const obj = mockUIObject()
    router.registerInstance('test_1', obj)
    const res = await router.handle({
      tool: 'ui_exec', object: 'test_form', target: 'test_1',
      payload: { action: 'save', params: {} },
    })
    expect(obj.exec).toHaveBeenCalledWith('save', {})
    expect(res.data?.success).toBe(true)
  })

  it('ui_list returns all registered instances', async () => {
    router.registerInstance('a', mockUIObject({ objectId: 'a', type: 'query_editor', title: 'Q1' }))
    router.registerInstance('b', mockUIObject({ objectId: 'b', type: 'table_form', title: 'T1' }))
    const res = await router.handle({
      tool: 'ui_list', object: '', target: '',
      payload: {},
    })
    expect(res.data).toHaveLength(2)
  })

  it('ui_list filters by type', async () => {
    router.registerInstance('a', mockUIObject({ objectId: 'a', type: 'query_editor', title: 'Q1' }))
    router.registerInstance('b', mockUIObject({ objectId: 'b', type: 'table_form', title: 'T1' }))
    const res = await router.handle({
      tool: 'ui_list', object: '', target: '',
      payload: { filter: { type: 'table_form' } },
    })
    expect(res.data).toHaveLength(1)
    expect(res.data[0].type).toBe('table_form')
  })

  it('returns error for unknown target', async () => {
    const res = await router.handle({
      tool: 'ui_read', object: 'test_form', target: 'nonexistent',
      payload: { mode: 'state' },
    })
    expect(res.error).toBeTruthy()
  })

  it('unregisterInstance removes object', async () => {
    const obj = mockUIObject()
    router.registerInstance('test_1', obj)
    router.unregisterInstance('test_1')
    const res = await router.handle({
      tool: 'ui_read', object: 'test_form', target: 'test_1',
      payload: { mode: 'state' },
    })
    expect(res.error).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/ui/__tests__/UIRouter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement UIRouter**

```typescript
// src/mcp/ui/UIRouter.ts
import type { UIObject, UIRequest, UIResponse, UIObjectInfo } from './types'

export class UIRouter {
  private instances = new Map<string, UIObject>()

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
        case 'ui_patch': {
          const result = await instance.patch(
            req.payload?.ops ?? [],
            req.payload?.reason
          )
          return {
            data: result,
            status: result.status === 'error' ? undefined : result.status,
            confirm_id: result.confirm_id,
            error: result.status === 'error' ? result.message : undefined,
          }
        }
        case 'ui_exec': {
          const result = await instance.exec(
            req.payload?.action ?? '',
            req.payload?.params
          )
          return { data: result, error: result.success ? undefined : result.error }
        }
        default:
          return { error: `Unknown tool: ${req.tool}` }
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  /** Resolve "active" to the currently active instance of the given type, or lookup by objectId */
  private resolveTarget(objectType: string, target: string): UIObject | null {
    if (target && target !== 'active') {
      return this.instances.get(target) ?? null
    }
    // "active" → find active tab of matching type from queryStore
    // Import lazily to avoid circular deps
    const { useQueryStore } = require('../../store/queryStore')
    const activeTabId = useQueryStore.getState().activeTabId
    if (!activeTabId) return null

    const instance = this.instances.get(activeTabId)
    if (instance && (!objectType || instance.type === objectType)) return instance
    return null
  }

  private handleList(filter?: { type?: string; keyword?: string }): UIResponse {
    const results: UIObjectInfo[] = []
    for (const [, obj] of this.instances) {
      if (filter?.type && obj.type !== filter.type) continue
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp/ui/__tests__/UIRouter.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/UIRouter.ts src/mcp/ui/__tests__/UIRouter.test.ts
git commit -m "feat(ui-protocol): add UIRouter with instance registry and target resolution"
```

---

## Task 4: useUIObjectRegistry Hook + PatchConfirmStore

**Files:**
- Create: `src/mcp/ui/useUIObjectRegistry.ts`
- Create: `src/store/patchConfirmStore.ts`

- [ ] **Step 1: Create useUIObjectRegistry hook**

```typescript
// src/mcp/ui/useUIObjectRegistry.ts
import { useEffect } from 'react'
import { uiRouter } from './UIRouter'
import type { UIObject } from './types'

/**
 * Register a UIObject instance with UIRouter on mount, unregister on unmount.
 * Pass null to skip registration (e.g., when object isn't ready yet).
 *
 * IMPORTANT: The object MUST be created with useMemo() in the component,
 * keyed on stable identifiers (tabId). If the object reference changes
 * (e.g., new adapter instance), re-registration happens automatically.
 */
export function useUIObjectRegistry(object: UIObject | null) {
  useEffect(() => {
    if (!object) return
    uiRouter.registerInstance(object.objectId, object)
    return () => uiRouter.unregisterInstance(object.objectId)
  }, [object])  // depend on object ref, not just objectId
}
```

- [ ] **Step 2: Create patchConfirmStore**

```typescript
// src/store/patchConfirmStore.ts
import { create } from 'zustand'
import type { PendingPatch } from '../mcp/ui/types'

interface PatchConfirmState {
  pending: PendingPatch | null
  propose: (patch: PendingPatch) => void
  confirm: () => void
  reject: () => void
}

export const usePatchConfirmStore = create<PatchConfirmState>((set, get) => ({
  pending: null,

  propose: (patch) => set({ pending: patch }),

  confirm: () => {
    const { pending } = get()
    if (!pending) return
    pending.onConfirm()
    set({ pending: null })
  },

  reject: () => {
    const { pending } = get()
    if (!pending) return
    pending.onReject?.()
    set({ pending: null })
  },
}))
```

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/useUIObjectRegistry.ts src/store/patchConfirmStore.ts
git commit -m "feat(ui-protocol): add useUIObjectRegistry hook and patchConfirmStore"
```

---

## Task 5: PatchConfirmPanel

**Files:**
- Create: `src/components/Assistant/PatchConfirmPanel.tsx`

- [ ] **Step 1: Create PatchConfirmPanel component**

Reference `src/components/Assistant/DiffPanel.tsx` for styling patterns. This panel shows structured patch operations for user confirmation.

```typescript
// src/components/Assistant/PatchConfirmPanel.tsx
import React from 'react'
import { usePatchConfirmStore } from '../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'
import type { JsonPatchOp } from '../../mcp/ui/types'

/** Render a single JSON Patch op as human-readable text */
function OpLine({ op }: { op: JsonPatchOp }) {
  const opLabel = { add: '+', remove: '-', replace: '~', move: '>', copy: '=' }[op.op] ?? '?'
  const opColor = { add: '#4ade80', remove: '#f87171', replace: '#60a5fa', move: '#c084fc', copy: '#94a3b8' }[op.op] ?? '#ccc'

  return (
    <div style={{ fontFamily: 'monospace', fontSize: 13, padding: '4px 8px', display: 'flex', gap: 8 }}>
      <span style={{ color: opColor, fontWeight: 700, width: 16 }}>{opLabel}</span>
      <span style={{ color: '#94a3b8' }}>{op.path}</span>
      {op.value !== undefined && (
        <span style={{ color: '#e2e8f0' }}>
          {typeof op.value === 'object' ? JSON.stringify(op.value) : String(op.value)}
        </span>
      )}
    </div>
  )
}

export function PatchConfirmPanel() {
  const { pending, confirm, reject } = usePatchConfirmStore()
  if (!pending) return null

  // IMPORTANT: No Rust-side call needed. Confirmation is purely frontend:
  // confirm() calls pending.onConfirm() which applies the patch to Zustand.
  // The Rust MCP layer already returned { status: "pending_confirm" } to the
  // MCP client — there is no second round-trip for the confirmation itself.
  const handleConfirm = () => {
    confirm()
  }

  const handleReject = () => {
    reject()
  }

  return (
    <div style={{
      background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
      padding: 12, margin: '8px 0',
    }}>
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>
        AI suggests changes to <strong style={{ color: '#e2e8f0' }}>{pending.objectType}</strong>
        {pending.reason && <span> — {pending.reason}</span>}
      </div>

      <div style={{ background: '#0f172a', borderRadius: 6, padding: 8, marginBottom: 8 }}>
        {pending.ops.map((op, i) => <OpLine key={i} op={op} />)}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={handleReject}
          style={{ padding: '4px 12px', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Reject
        </button>
        <button onClick={handleConfirm}
          style={{ padding: '4px 12px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Apply
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Assistant/PatchConfirmPanel.tsx
git commit -m "feat(ui-protocol): add PatchConfirmPanel for structured patch confirmation"
```

---

## Task 6: UI Protocol Index + Adapter Registration

**Files:**
- Create: `src/mcp/ui/index.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// src/mcp/ui/index.ts
export { uiRouter } from './UIRouter'
export { useUIObjectRegistry } from './useUIObjectRegistry'
export { applyPatch } from './jsonPatch'
export type { UIObject, UIRequest, UIResponse, JsonPatchOp, PatchResult, ExecResult, ActionDef } from './types'

// Adapter registration happens implicitly when components mount
// and call useUIObjectRegistry(). No static registration needed.
//
// WorkspaceAdapter is the exception — it's a singleton registered at app startup.
// It will be imported and registered in useMcpBridge.ts.
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/ui/index.ts
git commit -m "feat(ui-protocol): add ui protocol barrel export"
```

---

## Task 7: Rust MCP Layer — Tool Definitions + Routing

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/mcp/tools/mod.rs`
- Modify: `src-tauri/src/mcp/tools/tab_control.rs`

- [ ] **Step 1: Update tools/mod.rs — remove fs_* modules**

In `src-tauri/src/mcp/tools/mod.rs`, remove lines declaring `fs_metric`, `fs_table`, `fs_history`, `fs_seatunnel`. Keep `tab_control`, `metric_edit`, `table_edit`, `history`, `graph`.

- [ ] **Step 2: Delete the fs_* Rust files**

Delete these files:
- `src-tauri/src/mcp/tools/fs_table.rs`
- `src-tauri/src/mcp/tools/fs_metric.rs`
- `src-tauri/src/mcp/tools/fs_seatunnel.rs`
- `src-tauri/src/mcp/tools/fs_history.rs`

- [ ] **Step 3: Update tab_control.rs — make event channel name a parameter**

**CRITICAL**: `query_frontend()` in `tab_control.rs` hardcodes the event name to `"mcp://query-request"` (line 13). The `query_type` parameter is embedded as a JSON field, NOT used as the event channel. We must change the function signature to accept the event channel name.

Modify `query_frontend()` to accept an `event_channel` parameter:

```rust
pub(crate) async fn query_frontend(
    handle: &Arc<tauri::AppHandle>,
    event_channel: &str,   // ← was hardcoded "mcp://query-request"
    query_type: &str,
    params: Value,
) -> crate::AppResult<Value> {
    let app_state = handle.state::<crate::AppState>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut pending = app_state.pending_queries.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    handle.emit(event_channel, json!({   // ← use parameter
        "request_id": request_id,
        "query_type": query_type,
        "params": params
    })).map_err(|e| crate::AppError::Other(e.to_string()))?;
    // ... timeout logic unchanged
}
```

Then update the one existing call site (`search_tabs`) to pass the old channel name:
```rust
pub async fn search_tabs(handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let result = query_frontend(&handle, "mcp://query-request", "search_tabs", args).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
```

Also check `mod.rs` for any other calls to `query_frontend()` (the `fs_*` fallback branch) and update them to pass `"mcp://query-request"` as the first arg. These calls will be deleted in Step 5 anyway, but the code must compile between steps.

- [ ] **Step 4: Update mod.rs — replace tool_definitions()**

In `src-tauri/src/mcp/mod.rs`, replace the `tool_definitions()` function. Remove all `fs_read`, `fs_write`, `fs_search`, `fs_open`, `fs_exec`, `search_tabs` tool entries. Add `ui_read`, `ui_patch`, `ui_exec`, `ui_list` tool entries (exact JSON schemas from spec module 2 in the design doc).

- [ ] **Step 5: Update mod.rs — replace call_tool() routing**

In `call_tool()`, remove the `"fs_read" | "fs_write" | "fs_search" | "fs_open" | "fs_exec"` match arm and the `"search_tabs"` arm. Replace with:

```rust
"ui_read" | "ui_patch" | "ui_exec" | "ui_list" => {
    let payload = json!({
        "tool":    name,
        "object":  args.get("object").and_then(|v| v.as_str()).unwrap_or(""),
        "target":  args.get("target").and_then(|v| v.as_str()).unwrap_or("active"),
        "payload": match name {
            "ui_read"  => json!({ "mode": args.get("mode").and_then(|v| v.as_str()).unwrap_or("state") }),
            "ui_patch" => json!({ "ops": args.get("ops").cloned().unwrap_or(json!([])), "reason": args.get("reason") }),
            "ui_exec"  => json!({ "action": args.get("action").and_then(|v| v.as_str()).unwrap_or(""), "params": args.get("params").cloned().unwrap_or(json!({})) }),
            "ui_list"  => json!({ "filter": args.get("filter").cloned().unwrap_or(json!({})) }),
            _ => json!({})
        }
    });
    // NOTE: event_channel="mcp://ui-request", query_type="ui_request"
    let result = crate::mcp::tools::tab_control::query_frontend(
        &handle,
        "mcp://ui-request",  // ← event channel (Step 3 made this a parameter)
        "ui_request",         // ← query_type field in JSON payload
        payload,
    ).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
```

- [ ] **Step 6: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors (warnings OK)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp/mod.rs src-tauri/src/mcp/tools/mod.rs src-tauri/src/mcp/tools/tab_control.rs
git commit -m "feat(ui-protocol): replace fs_* MCP tools with ui_* in Rust layer"
```

---

## Task 8: Expose table_edit.rs as Tauri Commands

**Files:**
- Modify: `src-tauri/src/mcp/tools/table_edit.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add #[tauri::command] wrappers in table_edit.rs**

Add command wrappers at the end of `table_edit.rs` that call the existing internal functions. The internal functions take `&Value` args; the commands accept `params: Value`:

```rust
#[tauri::command]
pub fn cmd_generate_create_table_sql(params: serde_json::Value) -> Result<String, String> {
    generate_create_table_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_generate_add_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_add_column_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_generate_drop_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_drop_column_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_generate_modify_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_modify_column_sql(&params).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_generate_update_comment_sql(params: serde_json::Value) -> Result<String, String> {
    generate_update_comment_sql(&params).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the `generate_handler![]` macro:

```rust
crate::mcp::tools::table_edit::cmd_generate_create_table_sql,
crate::mcp::tools::table_edit::cmd_generate_add_column_sql,
crate::mcp::tools::table_edit::cmd_generate_drop_column_sql,
crate::mcp::tools::table_edit::cmd_generate_modify_column_sql,
crate::mcp::tools::table_edit::cmd_generate_update_comment_sql,
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles OK

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/tools/table_edit.rs src-tauri/src/lib.rs
git commit -m "feat(ui-protocol): expose table_edit SQL generators as Tauri commands"
```

---

## Task 9: useMcpBridge — Switch to ui_request

**Files:**
- Modify: `src/hooks/useMcpBridge.ts`

- [ ] **Step 1: Read current useMcpBridge.ts to understand full structure**

Read `src/hooks/useMcpBridge.ts` completely before making changes.

- [ ] **Step 2: Replace fs_request listener with ui_request**

1. Remove the `listen('mcp://query-request', ...)` handler that dispatches to `fsRouter.handle()`
2. Remove the `listen('mcp://ui-action', ...)` handler for `open_tab` / `propose_seatunnel_job` actions
3. Remove `import { fsRouter } from '../mcp/fs'`
4. Add `import { uiRouter } from '../mcp/ui'`
5. Add new listener:

```typescript
// IMPORTANT: mcp_query_respond accepts only { requestId: string, data: Value }
// It does NOT have success/error params. Wrap result/error into the data field.
listen<any>('mcp://ui-request', async (event) => {
  const { request_id, params } = event.payload
  const { tool, object, target, payload } = params  // nested under params by query_frontend()
  try {
    const result = await uiRouter.handle({ tool, object, target, payload })
    await invoke('mcp_query_respond', {
      requestId: request_id,
      data: result,  // UIResponse with data/error/status fields
    })
  } catch (e) {
    await invoke('mcp_query_respond', {
      requestId: request_id,
      data: { error: String(e) },
    })
  }
})
```

- [ ] **Step 3: Register WorkspaceAdapter at bridge init**

WorkspaceAdapter is the one adapter that doesn't correspond to a mounted component — it handles global open/close/focus. Register it as a singleton when the bridge initializes.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors (warnings OK). Some imports may break if fs/ is already deleted — that's expected and will be cleaned up in Task 14.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMcpBridge.ts
git commit -m "feat(ui-protocol): switch useMcpBridge from fs_request to ui_request"
```

---

## Task 10: WorkspaceAdapter

**Files:**
- Create: `src/mcp/ui/adapters/WorkspaceAdapter.ts`
- Create: `src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/mcp/ui/__tests__/WorkspaceAdapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkspaceAdapter } from '../adapters/WorkspaceAdapter'

// Mock queryStore
vi.mock('../../../store/queryStore', () => ({
  useQueryStore: { getState: () => ({ tabs: [], activeTabId: null }) },
}))

describe('WorkspaceAdapter', () => {
  it('read returns error (workspace has no state)', () => {
    const ws = new WorkspaceAdapter()
    const result = ws.read('state')
    expect(result).toEqual({ error: 'workspace does not support read' })
  })

  it('exec open returns objectId', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('open', {
      type: 'query_editor', connection_id: 1, database: 'test',
    })
    expect(result.success).toBeDefined()
  })

  it('actions lists open/close/focus', () => {
    const ws = new WorkspaceAdapter()
    const actions = ws.read('actions')
    expect(actions.map((a: any) => a.name)).toContain('open')
    expect(actions.map((a: any) => a.name)).toContain('close')
    expect(actions.map((a: any) => a.name)).toContain('focus')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`

- [ ] **Step 3: Implement WorkspaceAdapter**

The adapter wraps the existing `openQueryTab`, `openTableStructureTab`, `setActiveTabId`, `closeTab` store actions. Reference `src/hooks/useMcpBridge.ts` lines 122-179 for the current open_tab logic to replicate.

```typescript
// src/mcp/ui/adapters/WorkspaceAdapter.ts
import type { UIObject, PatchResult, ExecResult, JsonPatchOp } from '../types'
import { useQueryStore } from '../../../store/queryStore'

export class WorkspaceAdapter implements UIObject {
  type = 'workspace'
  objectId = 'workspace'
  title = 'Workspace'

  read(mode: 'state' | 'schema' | 'actions') {
    if (mode === 'actions') {
      return [
        { name: 'open', description: 'Open a new tab', paramsSchema: { type: 'string', connection_id: 'number', database: 'string', table: 'string', metric_id: 'number', project_id: 'number', job_id: 'number' } },
        { name: 'close', description: 'Close a tab', paramsSchema: { target: 'string' } },
        { name: 'focus', description: 'Focus/switch to a tab', paramsSchema: { target: 'string' } },
      ]
    }
    return { error: 'workspace does not support read' }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return { status: 'error', message: 'workspace does not support patch' }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const store = useQueryStore.getState()

    switch (action) {
      case 'open': {
        const { type, connection_id, database, table, metric_id, project_id, job_id } = params ?? {}
        const beforeIds = new Set(store.tabs.map(t => t.id))

        switch (type) {
          case 'query_editor':
            store.openQueryTab(connection_id, `Query`, database)
            break
          case 'table_form':
            store.openTableStructureTab(connection_id, database, undefined, table || undefined)
            break
          case 'metric_form':
            if (metric_id) store.openMetricTab(metric_id, `Metric #${metric_id}`)
            break
          case 'er_canvas':
            if (project_id) store.openERDesignTab(project_id, `ER #${project_id}`)
            break
          case 'seatunnel_job':
            if (job_id != null) store.openSeaTunnelJobTab(job_id, `Job #${job_id}`)
            break
          default:
            return { success: false, error: `Unknown tab type: ${type}` }
        }

        // Find the newly opened tab
        const newTab = useQueryStore.getState().tabs.find(t => !beforeIds.has(t.id))
        return { success: true, data: { objectId: newTab?.id ?? null } }
      }

      case 'close': {
        const tabId = params?.target
        if (tabId) store.closeTab(tabId)
        return { success: true }
      }

      case 'focus': {
        const tabId = params?.target
        if (tabId) store.setActiveTabId(tabId)
        return { success: true }
      }

      default:
        return { success: false, error: `Unknown workspace action: ${action}` }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/adapters/WorkspaceAdapter.ts src/mcp/ui/__tests__/WorkspaceAdapter.test.ts
git commit -m "feat(ui-protocol): add WorkspaceAdapter for open/close/focus tab actions"
```

---

## Task 11: QueryEditorAdapter

**Files:**
- Create: `src/mcp/ui/adapters/QueryEditorAdapter.ts`
- Create: `src/mcp/ui/__tests__/QueryEditorAdapter.test.ts`

- [ ] **Step 1: Write failing tests**

Test read(state), read(schema), read(actions), patch (auto mode + non-auto), exec (run_sql, focus, undo, confirm_patch).

- [ ] **Step 2: Run tests to verify failure**

- [ ] **Step 3: Implement QueryEditorAdapter**

Port logic from `src/mcp/fs/adapters/QueryTabAdapter.ts` (181 lines). Key changes:
- `write()` becomes `patch()` — accept JSON Patch ops on `/content` field
- Use `useAppStore.getState().autoMode` for confirm logic
- Use `usePatchConfirmStore` instead of `proposeSqlDiff` for non-Auto mode
- Keep `exec` actions: `run_sql`, `format`, `undo`, `focus`, `confirm_patch`
- `read('schema')` returns a simple schema: `{ content: "string", connectionId: "number", database: "string" }`

Component integration: `QueryEditor` component should call `useUIObjectRegistry` with a QueryEditorUIObject that wraps its store state. This object reads from `useQueryStore.sqlContent[tabId]` and writes via `setSql()`.

- [ ] **Step 4: Run tests to verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/adapters/QueryEditorAdapter.ts src/mcp/ui/__tests__/QueryEditorAdapter.test.ts
git commit -m "feat(ui-protocol): add QueryEditorAdapter (replaces QueryTabAdapter)"
```

---

## Task 12: TableFormAdapter + State Lift

This is the most important adapter — enables multi-round table creation.

**Files:**
- Create: `src/mcp/ui/adapters/TableFormAdapter.ts`
- Create: `src/store/tableFormStore.ts`
- Create: `src/mcp/ui/__tests__/TableFormAdapter.test.ts`
- Modify: `src/components/MainContent/TableStructureView.tsx`

- [ ] **Step 1: Create tableFormStore (Zustand slice)**

Lift `TableStructureView`'s local state to a Zustand store. Each open table_form tab gets its own slice keyed by tabId.

```typescript
// src/store/tableFormStore.ts
import { create } from 'zustand'

export interface TableFormColumn {
  id: string                     // unique ID for React key + internal tracking
  name: string
  dataType: string
  length?: string | null
  isNullable?: boolean
  defaultValue?: string | null
  isPrimaryKey?: boolean
  extra?: string
  comment?: string
  // Internal tracking (not exposed to AI via schema, but needed by UI)
  _isNew?: boolean               // column was added in this session
  _isDeleted?: boolean           // column marked for deletion
  _originalName?: string         // original name before rename (for ALTER RENAME)
}

export interface TableFormState {
  tableName: string
  engine: string
  charset: string
  comment: string
  columns: TableFormColumn[]
  originalColumns: TableFormColumn[]  // snapshot at load time, for diff/discard
  indexes: any[]
  isNewTable: boolean                 // true = CREATE TABLE, false = ALTER TABLE
}

interface TableFormStoreState {
  forms: Record<string, TableFormState>   // keyed by tabId
  initForm: (tabId: string, initial: TableFormState) => void
  patchForm: (tabId: string, updater: (s: TableFormState) => TableFormState) => void
  setForm: (tabId: string, state: TableFormState) => void
  removeForm: (tabId: string) => void
  getForm: (tabId: string) => TableFormState | undefined
}

const DEFAULT_STATE: TableFormState = {
  tableName: '',
  engine: 'InnoDB',
  charset: 'utf8mb4',
  comment: '',
  columns: [{ name: 'id', dataType: 'INT', isPrimaryKey: true, extra: 'auto_increment' }],
  indexes: [],
}

export const useTableFormStore = create<TableFormStoreState>((set, get) => ({
  forms: {},

  initForm: (tabId, initial) => set(s => ({
    forms: { ...s.forms, [tabId]: initial },
  })),

  patchForm: (tabId, updater) => set(s => {
    const current = s.forms[tabId]
    if (!current) return s
    return { forms: { ...s.forms, [tabId]: updater(current) } }
  }),

  setForm: (tabId, state) => set(s => ({
    forms: { ...s.forms, [tabId]: state },
  })),

  removeForm: (tabId) => set(s => {
    const { [tabId]: _, ...rest } = s.forms
    return { forms: rest }
  }),

  getForm: (tabId) => get().forms[tabId],
}))
```

- [ ] **Step 2: Write failing tests for TableFormAdapter**

```typescript
// src/mcp/ui/__tests__/TableFormAdapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { TableFormUIObject } from '../adapters/TableFormAdapter'
import { useTableFormStore } from '../../../store/tableFormStore'

describe('TableFormUIObject', () => {
  const tabId = 'test_tab_1'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'users',
      engine: 'InnoDB', charset: 'utf8mb4', comment: '',
      columns: [
        { name: 'id', dataType: 'INT', isPrimaryKey: true, extra: 'auto_increment' },
        { name: 'email', dataType: 'VARCHAR', length: '255' },
      ],
      indexes: [],
    })
  })

  it('read state returns current form state', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const state = obj.read('state')
    expect(state.tableName).toBe('users')
    expect(state.columns).toHaveLength(2)
  })

  it('read schema returns JSON Schema', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const schema = obj.read('schema')
    expect(schema.properties.tableName).toBeDefined()
    expect(schema.properties.columns).toBeDefined()
    expect(schema.properties.columns.items['x-addressable-by']).toBe('name')
  })

  it('read actions returns action list', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const actions = obj.read('actions')
    expect(actions.map((a: any) => a.name)).toContain('preview_sql')
    expect(actions.map((a: any) => a.name)).toContain('save')
  })

  it('patch replaces tableName (auto mode)', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    // Force auto mode for test
    const result = obj.patchDirect([
      { op: 'replace', path: '/tableName', value: 'orders' },
    ])
    expect(result.status).toBe('applied')
    expect(useTableFormStore.getState().getForm(tabId)?.tableName).toBe('orders')
  })

  it('patch adds column by [name=xxx]', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'replace', path: '/columns[name=email]/dataType', value: 'TEXT' },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.columns.find(c => c.name === 'email')?.dataType).toBe('TEXT')
  })

  it('patch adds column to end', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'age', dataType: 'INT' } },
    ])
    expect(result.status).toBe('applied')
    expect(useTableFormStore.getState().getForm(tabId)?.columns).toHaveLength(3)
  })
})
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run src/mcp/ui/__tests__/TableFormAdapter.test.ts`

- [ ] **Step 4: Implement TableFormAdapter**

```typescript
// src/mcp/ui/adapters/TableFormAdapter.ts
import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useTableFormStore } from '../../../store/tableFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'

const TABLE_FORM_SCHEMA = {
  type: 'object',
  properties: {
    tableName: { type: 'string', description: 'Table name' },
    engine: { type: 'string', enum: ['InnoDB', 'MyISAM', 'MEMORY'], default: 'InnoDB' },
    charset: { type: 'string', default: 'utf8mb4' },
    comment: { type: 'string' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dataType: { type: 'string' },
          length: { type: ['string', 'null'] },
          isNullable: { type: 'boolean', default: true },
          defaultValue: { type: ['string', 'null'] },
          isPrimaryKey: { type: 'boolean', default: false },
          extra: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['name', 'dataType'],
        'x-addressable-by': 'name',
      },
    },
    indexes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          unique: { type: 'boolean', default: false },
        },
        'x-addressable-by': 'name',
      },
    },
  },
}

export class TableFormUIObject implements UIObject {
  type = 'table_form'
  objectId: string
  title: string
  connectionId: number
  private database: string

  constructor(tabId: string, connectionId: number, database: string) {
    this.objectId = tabId
    this.connectionId = connectionId
    this.database = database
    this.title = useTableFormStore.getState().getForm(tabId)?.tableName || 'New Table'
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useTableFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return TABLE_FORM_SCHEMA
      case 'actions':
        return [
          { name: 'preview_sql', description: 'Preview CREATE/ALTER TABLE SQL' },
          { name: 'save', description: 'Generate SQL and write to query tab for review' },
        ]
    }
  }

  patch(ops: JsonPatchOp[], reason?: string): PatchResult {
    const autoMode = useAppStore.getState().autoMode
    if (autoMode) {
      return this.patchDirect(ops)
    } else {
      const confirmId = `patch_${this.objectId}_${Date.now()}`
      usePatchConfirmStore.getState().propose({
        confirmId,
        objectId: this.objectId,
        objectType: this.type,
        ops,
        reason,
        currentState: this.read('state'),
        onConfirm: () => this.patchDirect(ops),
      })
      return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
    }
  }

  /** Apply patch directly (bypassing confirm). Used by auto mode and confirm callback. */
  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useTableFormStore.getState().getForm(this.objectId)
    if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
    try {
      const patched = applyPatch(current, ops)
      useTableFormStore.getState().setForm(this.objectId, patched)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const state = useTableFormStore.getState().getForm(this.objectId)
    if (!state) return { success: false, error: 'No form state' }

    switch (action) {
      case 'preview_sql': {
        try {
          const sql = await invoke<string>('cmd_generate_create_table_sql', {
            params: {
              connection_id: this.connectionId,
              table_name: state.tableName,
              database: this.database,
              columns: state.columns.map(c => ({
                name: c.name, data_type: c.dataType, length: c.length,
                is_nullable: c.isNullable ?? true, default_value: c.defaultValue,
                is_primary_key: c.isPrimaryKey ?? false, extra: c.extra ?? '', comment: c.comment ?? '',
              })),
            },
          })
          return { success: true, data: { sql } }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'save': {
        // Same as preview_sql but also opens a query tab with the SQL
        const previewResult = await this.exec('preview_sql')
        if (!previewResult.success) return previewResult
        // The WorkspaceAdapter or direct store call opens query tab + writes SQL
        // For now just return the SQL; the caller can open a tab
        return { success: true, data: { sql: previewResult.data.sql, message: 'SQL generated. Open query tab to execute.' } }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/mcp/ui/__tests__/TableFormAdapter.test.ts`

- [ ] **Step 6: Modify TableStructureView to use tableFormStore + register UIObject**

In `src/components/MainContent/TableStructureView.tsx`:
1. Import `useTableFormStore` and `useUIObjectRegistry`
2. On mount (useEffect), init form state in store from existing `tableName`/column loading logic
3. Replace local `columns`/`newTableName` state reads with `useTableFormStore(s => s.forms[tabId])`
4. Create `TableFormUIObject` and pass to `useUIObjectRegistry`
5. On unmount, call `removeForm(tabId)`

This is the most delicate change — keep all existing UI interaction logic working (user typing in inputs, clicking buttons), just change where state lives.

- [ ] **Step 7: Verify TypeScript compiles + manual smoke test**

Run: `npx tsc --noEmit`
Then: `npm run tauri:dev` and test creating a new table via UI works as before.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/ui/adapters/TableFormAdapter.ts src/mcp/ui/__tests__/TableFormAdapter.test.ts \
  src/store/tableFormStore.ts src/components/MainContent/TableStructureView.tsx
git commit -m "feat(ui-protocol): add TableFormAdapter with Zustand state + multi-round patch support"
```

---

## Task 13: Remaining Adapters (MetricForm, SeaTunnel, DbTree, History, ERCanvas)

These follow the same pattern. Each adapter:
1. Implements `UIObject` interface
2. Reads from a Zustand store (or wraps existing store)
3. Patches via `applyPatch()` + auto mode check
4. Exposes type-specific exec actions

**Files:**
- Create: `src/mcp/ui/adapters/MetricFormAdapter.ts`
- Create: `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts`
- Create: `src/mcp/ui/adapters/DbTreeAdapter.ts`
- Create: `src/mcp/ui/adapters/HistoryAdapter.ts`
- Create: `src/mcp/ui/adapters/ERCanvasAdapter.ts`

- [ ] **Step 1: MetricFormAdapter**

Port logic from `src-tauri/src/mcp/tools/fs_metric.rs`. The adapter wraps metric form state (name, displayName, aggregation, tableName, columnName, filterSql, description). Exec actions: `save`, `validate`. Read schema returns metric field definitions.

- [ ] **Step 2: SeaTunnelJobAdapter**

Port logic from `src-tauri/src/mcp/tools/fs_seatunnel.rs`. Wraps `useSeaTunnelStore`. State: jobName, configJson, mode. Exec actions: `save`, `run`, `validate`.

- [ ] **Step 3: DbTreeAdapter**

Port from `src/mcp/fs/adapters/DbTreeAdapter.ts`. Search-only adapter (read not applicable for tree). `read('state')` returns tree nodes. `patch` returns error. `exec('refresh')` triggers tree reload.

- [ ] **Step 4: HistoryAdapter**

Port from `src-tauri/src/mcp/tools/fs_history.rs`. Read-only + exec('undo'). State: change history entries.

- [ ] **Step 5: ERCanvasAdapter (stub)**

Minimal implementation that returns `{ error: 'not_implemented' }` for patch/exec. Read returns empty state `{ nodes: [], edges: [] }`. Schema returns ER canvas schema placeholder.

- [ ] **Step 6: Register UIObjects in each component**

Add `useUIObjectRegistry` calls in:
- `src/components/MetricsExplorer/MetricTab.tsx`
- `src/components/SeaTunnelJobTab/index.tsx`
- App-level for DbTree and History (these are panels, not tabs)

- [ ] **Step 7: Commit each adapter separately**

```bash
git commit -m "feat(ui-protocol): add MetricFormAdapter"
git commit -m "feat(ui-protocol): add SeaTunnelJobAdapter"
git commit -m "feat(ui-protocol): add DbTreeAdapter"
git commit -m "feat(ui-protocol): add HistoryAdapter"
git commit -m "feat(ui-protocol): add ERCanvasAdapter (stub)"
```

---

## Task 14: Cleanup — Delete Old Protocol

**Files:**
- Delete: `src/mcp/fs/` entire directory
- Delete: `src/components/Assistant/DiffPanel.tsx`
- Modify: `src/components/Assistant/index.tsx` — replace DiffPanel import with PatchConfirmPanel
- Modify: `src/types/index.ts` — remove `initialColumns`, `initialTableName` from Tab interface
- Modify: `src/store/queryStore.ts` — remove `initialColumns`/`initialTableName` from `openTableStructureTab` params

- [ ] **Step 1: Delete fs/ directory**

```bash
rm -rf src/mcp/fs/
```

- [ ] **Step 2: Delete DiffPanel**

```bash
rm src/components/Assistant/DiffPanel.tsx
```

- [ ] **Step 3: Update Assistant/index.tsx**

Replace `import { DiffPanel } from './DiffPanel'` with `import { PatchConfirmPanel } from './PatchConfirmPanel'`. Replace `<DiffPanel ... />` usage with `<PatchConfirmPanel />`. Remove `pendingDiff`/`applyDiff`/`cancelDiff` store bindings.

- [ ] **Step 4: Clean Tab interface**

In `src/types/index.ts`, remove:
```typescript
  isNewTable?: boolean;
  initialTableName?: string;
  initialColumns?: Array<{...}>;
```

- [ ] **Step 5: Clean queryStore**

In `src/store/queryStore.ts`:
1. Remove `initialColumns` and `initialTableName` params from `openTableStructureTab`
2. **Remove all of**: `SqlDiffProposal` type, `pendingDiff`, `proposeSqlDiff`, `applyDiff`, `cancelDiff`, `autoApplyBanner`. These are fully replaced by `patchConfirmStore`. QueryEditorAdapter uses `patchConfirmStore` for its confirm flow, not the old `proposeSqlDiff`.

- [ ] **Step 6: Fix all remaining import errors**

Run: `npx tsc --noEmit`
Fix any broken imports or references to deleted code.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(ui-protocol): delete fs_* protocol, DiffPanel, and initialColumns from Tab"
```

---

## Task 15: Prompt Rewrite

**Files:**
- Modify: `prompts/chat_assistant.txt`

- [ ] **Step 1: Replace entire file content**

Use the full prompt text from the design spec (Module 4). The complete text is in the brainstorming conversation and in `docs/superpowers/specs/2026-03-28-ui-object-protocol-design.md` (referenced as "prompts/chat_assistant.txt 全文重写").

- [ ] **Step 2: Verify no references to fs_* remain**

```bash
grep -r "fs_read\|fs_write\|fs_search\|fs_open\|fs_exec" prompts/
```

Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add prompts/chat_assistant.txt
git commit -m "feat(ui-protocol): rewrite chat_assistant prompt for ui_* protocol"
```

---

## Task 16: Skills Check + Integration Test

**Files:**
- Check: `src-tauri/skills/` for any fs_* references

- [ ] **Step 1: Search skills for fs_* references**

```bash
grep -r "fs_read\|fs_write\|fs_search\|fs_open\|fs_exec" src-tauri/skills/ --include="*.yaml" --include="*.json" --include="*.ts" --include="*.md"
```

Update any found references to use `ui_*` equivalents.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Run Rust checks**

```bash
cd src-tauri && cargo check && cargo test
```

- [ ] **Step 4: Run TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Manual full-chain smoke test**

Start the app with `npm run tauri:dev`. Test these scenarios:

1. **Multi-round table creation**: Open AI chat → "帮我创建一个订单表" → AI calls `ui_exec(workspace, open table_form)` + `ui_patch(table_form, add columns)` → verify columns appear in form → "把 amount 改成 total_amount" → AI calls `ui_patch(replace)` → verify form updates → "预览 SQL" → AI calls `ui_exec(preview_sql)` → verify SQL returned
2. **SQL editing**: AI patches query editor → verify diff/auto-apply works
3. **ui_list**: AI calls `ui_list` → verify all open tabs returned
4. **Auto/Non-Auto toggle**: Switch auto mode → verify patches show confirm panel vs direct apply

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(ui-protocol): complete UI Object Protocol migration — all fs_* replaced with ui_*"
```
