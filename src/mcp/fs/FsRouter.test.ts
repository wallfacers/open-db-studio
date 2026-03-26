// src/mcp/fs/FsRouter.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FsRouter } from './FsRouter'
import type { FsAdapter, FsMcpRequest } from './types'

function makeAdapter(overrides: Partial<FsAdapter> = {}): FsAdapter {
  return {
    capabilities: { read: true, write: true, search: true, open: true, exec: ['focus', 'run_sql'] },
    read:   vi.fn().mockResolvedValue({ content: 'SELECT 1' }),
    write:  vi.fn().mockResolvedValue({ status: 'applied' }),
    search: vi.fn().mockResolvedValue([{ resource: 'tab.query', target: 'tab-1', label: 'q1', meta: {} }]),
    open:   vi.fn().mockResolvedValue({ target: 'tab-new' }),
    exec:   vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

describe('FsRouter', () => {
  let router: FsRouter

  beforeEach(() => {
    router = new FsRouter()
  })

  it('register + read：精确 resource 路由到正确 Adapter', async () => {
    const adapter = makeAdapter()
    router.register('tab.query', adapter)

    const result = await router.handle({
      op: 'read', resource: 'tab.query', target: 'active', payload: { mode: 'text' },
    })

    expect(adapter.read).toHaveBeenCalledWith('active', 'text')
    expect(JSON.parse(result)).toEqual({ content: 'SELECT 1' })
  })

  it('未注册的 resource 抛出错误', async () => {
    await expect(
      router.handle({ op: 'read', resource: 'tab.unknown', target: 'active', payload: { mode: 'text' } })
    ).rejects.toThrow('Unknown resource: tab.unknown')
  })

  it('Adapter 不支持的 op 抛出错误', async () => {
    const adapter: FsAdapter = {
      capabilities: { read: true, write: false, search: false, open: false, exec: [] },
      read: vi.fn().mockResolvedValue({}),
    }
    router.register('tab.query', adapter)
    await expect(
      router.handle({ op: 'write', resource: 'tab.query', target: 'active', payload: {} })
    ).rejects.toThrow('does not support write')
  })

  it('write 路由正确传递 patch 参数', async () => {
    const adapter = makeAdapter()
    router.register('tab.query', adapter)
    const patch = { mode: 'text' as const, op: 'replace_all' as const, content: 'SELECT 2' }

    await router.handle({ op: 'write', resource: 'tab.query', target: 'active', payload: patch })

    expect(adapter.write).toHaveBeenCalledWith('active', patch)
  })

  it('open 路由正确传递 params', async () => {
    const adapter = makeAdapter()
    router.register('tab.query', adapter)

    const result = await router.handle({
      op: 'open', resource: 'tab.query', target: '', payload: { connection_id: 1 },
    })

    expect(adapter.open).toHaveBeenCalledWith({ connection_id: 1 })
    expect(JSON.parse(result)).toEqual({ target: 'tab-new' })
  })

  it('exec 检查 capabilities.exec 白名单，非法 action 抛出错误', async () => {
    const adapter = makeAdapter()
    router.register('tab.query', adapter)

    await expect(
      router.handle({ op: 'exec', resource: 'tab.query', target: 'active', payload: { action: 'delete_all' } })
    ).rejects.toThrow('Unsupported action: delete_all')
  })

  it('exec 合法 action 路由正确', async () => {
    const adapter = makeAdapter()
    router.register('tab.query', adapter)

    await router.handle({ op: 'exec', resource: 'tab.query', target: 'active', payload: { action: 'run_sql', params: {} } })

    expect(adapter.exec).toHaveBeenCalledWith('active', 'run_sql', {})
  })

  it('search "tab.*" 聚合所有 tab.* Adapter 的结果', async () => {
    const queryAdapter = makeAdapter({
      search: vi.fn().mockResolvedValue([
        { resource: 'tab.query', target: 'tab-1', label: 'query tab', meta: {} },
      ]),
    })
    const tableAdapter = makeAdapter({
      search: vi.fn().mockResolvedValue([
        { resource: 'tab.table', target: 'users', label: 'table users', meta: {} },
      ]),
    })
    router.register('tab.query', queryAdapter)
    router.register('tab.table', tableAdapter)

    const result = await router.handle({
      op: 'search', resource: 'tab.*', target: '', payload: {},
    })

    const items = JSON.parse(result) as Array<{ resource: string }>
    expect(items).toHaveLength(2)
    expect(items.some(i => i.resource === 'tab.query')).toBe(true)
    expect(items.some(i => i.resource === 'tab.table')).toBe(true)
  })

  it('search 精确 resource 只调用对应 Adapter', async () => {
    const queryAdapter = makeAdapter()
    const tableAdapter = makeAdapter()
    router.register('tab.query', queryAdapter)
    router.register('tab.table', tableAdapter)

    await router.handle({ op: 'search', resource: 'tab.query', target: '', payload: { keyword: 'orders' } })

    expect(queryAdapter.search).toHaveBeenCalledWith({ keyword: 'orders' })
    expect(tableAdapter.search).not.toHaveBeenCalled()
  })

  it('search 无匹配 Adapter 返回空数组', async () => {
    const result = await router.handle({ op: 'search', resource: 'settings.*', target: '', payload: {} })
    expect(JSON.parse(result)).toEqual([])
  })
})
