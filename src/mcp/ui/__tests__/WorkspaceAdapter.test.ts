import { describe, it, expect, vi } from 'vitest'
import { WorkspaceAdapter } from '../adapters/WorkspaceAdapter'

vi.mock('../../../store/queryStore', () => ({
  useQueryStore: {
    getState: () => ({
      tabs: [],
      activeTabId: null,
      openQueryTab: vi.fn(),
      openTableStructureTab: vi.fn(),
      openMetricTab: vi.fn(),
      openERDesignTab: vi.fn(),
      openSeaTunnelJobTab: vi.fn(),
      openMigrationJobTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTabId: vi.fn(),
    }),
  },
}))

describe('WorkspaceAdapter', () => {
  it('read state returns error (workspace has no state)', () => {
    const ws = new WorkspaceAdapter()
    const result = ws.read('state')
    expect(result).toEqual({ error: 'workspace does not support read' })
  })

  it('read actions lists open/close/focus', () => {
    const ws = new WorkspaceAdapter()
    const actions = ws.read('actions') as any[]
    expect(actions.map((a: any) => a.name)).toContain('open')
    expect(actions.map((a: any) => a.name)).toContain('close')
    expect(actions.map((a: any) => a.name)).toContain('focus')
  })

  it('patch returns error', () => {
    const ws = new WorkspaceAdapter()
    const result = ws.patch([])
    expect(result.status).toBe('error')
  })

  it('exec open with unknown type returns error', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('open', { type: 'unknown' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown tab type')
  })

  it('exec unknown action returns error', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('unknown_action')
    expect(result.success).toBe(false)
  })

  it('exec close calls closeTab', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('close', { target: 'tab_1' })
    expect(result.success).toBe(true)
  })

  it('exec focus calls setActiveTabId', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('focus', { target: 'tab_1' })
    expect(result.success).toBe(true)
  })

  it('exec open migration_job calls openMigrationJobTab', async () => {
    const ws = new WorkspaceAdapter()
    const result = await ws.exec('open', { type: 'migration_job', job_id: 42, title: 'My Job' })
    expect(result.success).toBe(true)
  })
})
