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
