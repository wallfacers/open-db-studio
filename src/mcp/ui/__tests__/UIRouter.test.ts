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

  // ── "active" target resolution ──────────────────────────
  // Regression: when objectId ≠ tabId (e.g. MigrationJobAdapter), resolving
  // target="active" used to fall through to "return first instance of type",
  // which silently leaked state across unrelated tabs.

  it('active target: resolves by objectId when objectId === tabId', async () => {
    const tabA = mockUIObject({ objectId: 'tab-A', type: 'query_editor', title: 'A' })
    const tabB = mockUIObject({ objectId: 'tab-B', type: 'query_editor', title: 'B' })
    router.registerInstance('tab-A', tabA)
    router.registerInstance('tab-B', tabB)
    router.setActiveTabIdProvider(() => 'tab-B')

    const res = await router.handle({
      tool: 'ui_read', object: 'query_editor', target: 'active',
      payload: { mode: 'state' },
    })
    expect(tabB.read).toHaveBeenCalled()
    expect(tabA.read).not.toHaveBeenCalled()
    expect(res.data).toBeDefined()
  })

  it('active target: resolves by tabId field when objectId ≠ tabId', async () => {
    // Simulates MigrationJobAdapter: objectId is stable (migration_job_<jobId>)
    // while tabId is the timestamp-based tab identifier.
    const job8 = mockUIObject({ objectId: 'migration_job_8',  type: 'migration_job', title: 'Job 8',  tabId: 'tab-111' })
    const job11 = mockUIObject({ objectId: 'migration_job_11', type: 'migration_job', title: 'Job 11', tabId: 'tab-222' })
    router.registerInstance('migration_job_8', job8)
    router.registerInstance('migration_job_11', job11)
    router.setActiveTabIdProvider(() => 'tab-222')

    const res = await router.handle({
      tool: 'ui_read', object: 'migration_job', target: 'active',
      payload: { mode: 'state' },
    })
    expect(job11.read).toHaveBeenCalled()
    expect(job8.read).not.toHaveBeenCalled()
    expect(res.data).toBeDefined()
  })

  it('active target: does not leak to a sibling instance when active tab differs', async () => {
    // Flipped order from the previous test: active is now job_8. This guards
    // against the old "return first-in-map" fallback that would always return
    // whichever was registered first, regardless of which tab is active.
    const job8 = mockUIObject({ objectId: 'migration_job_8',  type: 'migration_job', title: 'Job 8',  tabId: 'tab-111' })
    const job11 = mockUIObject({ objectId: 'migration_job_11', type: 'migration_job', title: 'Job 11', tabId: 'tab-222' })
    router.registerInstance('migration_job_11', job11) // registered first
    router.registerInstance('migration_job_8', job8)
    router.setActiveTabIdProvider(() => 'tab-111')

    await router.handle({
      tool: 'ui_read', object: 'migration_job', target: 'active',
      payload: { mode: 'state' },
    })
    expect(job8.read).toHaveBeenCalled()
    expect(job11.read).not.toHaveBeenCalled()
  })
})
