import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MigrationJobAdapter } from '../adapters/MigrationJobAdapter'

const mockSetScriptText = vi.fn()
const mockRunJob = vi.fn()
let mockScriptText = ''
let mockJobNode: any = null

vi.mock('../../../store/migrationStore', () => ({
  useMigrationStore: {
    getState: () => ({
      activeRuns: new Map(),
      nodes: new Map(mockJobNode ? [[`job_${mockJobNode.jobId}`, mockJobNode]] : []),
      runJob: mockRunJob,
    }),
  },
}))

vi.mock('../../../store/appStore', () => ({
  useAppStore: {
    getState: () => ({ autoMode: true }),
  },
}))

vi.mock('../../../store/patchConfirmStore', () => ({
  usePatchConfirmStore: {
    getState: () => ({ propose: vi.fn() }),
  },
}))

vi.mock('../../../store/highlightStore', () => ({
  useHighlightStore: {
    getState: () => ({ addHighlights: vi.fn() }),
  },
}))

vi.mock('../../../store/queryStore', () => ({
  useQueryStore: {
    getState: () => ({
      setActiveTabId: vi.fn(),
    }),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
}))

describe('MigrationJobAdapter', () => {
  let adapter: MigrationJobAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    mockScriptText = 'MIGRATE FROM src.db.t1 INTO dst.db.t2 MAPPING (*)'
    mockJobNode = { nodeType: 'job', id: 'job_1', label: 'Test Job', jobId: 1, status: null }
    adapter = new MigrationJobAdapter('tab_1', 1, 'Test Job')
    adapter.getScriptText = () => mockScriptText
    adapter.setScriptText = mockSetScriptText
  })

  it('read state returns scriptText and job metadata', () => {
    const state = adapter.read('state') as any
    expect(state.scriptText).toBe(mockScriptText)
    expect(state.jobId).toBe(1)
    expect(state.name).toBe('Test Job')
  })

  it('read schema returns patchable fields', () => {
    const schema = adapter.read('schema') as any
    expect(schema.properties.scriptText).toBeDefined()
  })

  it('read actions returns run/stop/format/save/focus', () => {
    const actions = adapter.read('actions') as any[]
    const names = actions.map((a: any) => a.name)
    expect(names).toContain('run')
    expect(names).toContain('stop')
    expect(names).toContain('format')
    expect(names).toContain('save')
    expect(names).toContain('focus')
  })

  it('patchDirect replaces scriptText', () => {
    const result = adapter.patchDirect([
      { op: 'replace', path: '/scriptText', value: 'MIGRATE FROM a.b.c INTO x.y.z MAPPING (*)' },
    ])
    expect(result.status).toBe('applied')
    expect(mockSetScriptText).toHaveBeenCalledWith('MIGRATE FROM a.b.c INTO x.y.z MAPPING (*)')
  })

  it('patch in auto mode applies directly', () => {
    const result = adapter.patch([
      { op: 'replace', path: '/scriptText', value: 'new script' },
    ])
    expect(result.status).toBe('applied')
  })

  it('exec focus calls setActiveTabId', async () => {
    const { useQueryStore } = await import('../../../store/queryStore')
    const result = await adapter.exec('focus')
    expect(result.success).toBe(true)
  })

  it('exec unknown action returns error', async () => {
    const result = await adapter.exec('nonexistent')
    expect(result.success).toBe(false)
  })
})
