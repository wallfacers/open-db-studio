import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryEditorAdapter } from '../adapters/QueryEditorAdapter'

const mockSetSql = vi.fn()
const mockSetActiveTabId = vi.fn()
let mockSqlContent: Record<string, string> = {}
let mockTabs: any[] = []

vi.mock('../../../store/queryStore', () => ({
  useQueryStore: {
    getState: () => ({
      tabs: mockTabs,
      sqlContent: mockSqlContent,
      activeTabId: 'tab_1',
      setSql: mockSetSql,
      setActiveTabId: mockSetActiveTabId,
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

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
}))

describe('QueryEditorAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTabs = [{ id: 'tab_1', type: 'query', title: 'Q1', connectionId: 1, db: 'testdb' }]
    mockSqlContent = { tab_1: 'SELECT 1' }
  })

  it('read state returns content and metadata', () => {
    const adapter = new QueryEditorAdapter('tab_1', 1, 'Q1')
    const state = adapter.read('state') as any
    expect(state.content).toBe('SELECT 1')
    expect(state.connectionId).toBe(1)
    expect(state.database).toBe('testdb')
  })

  it('read schema returns property definitions', () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const schema = adapter.read('schema') as any
    expect(schema.properties.content).toBeDefined()
  })

  it('read actions returns action list', () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const actions = adapter.read('actions') as any[]
    expect(actions.map((a: any) => a.name)).toContain('run_sql')
    expect(actions.map((a: any) => a.name)).toContain('format')
  })

  it('patchDirect replaces content', () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const result = adapter.patchDirect([
      { op: 'replace', path: '/content', value: 'SELECT 2' },
    ])
    expect(result.status).toBe('applied')
    expect(mockSetSql).toHaveBeenCalledWith('tab_1', 'SELECT 2')
  })

  it('patch in auto mode applies directly', () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const result = adapter.patch([
      { op: 'replace', path: '/content', value: 'SELECT 3' },
    ])
    expect(result.status).toBe('applied')
  })

  it('exec focus calls setActiveTabId', async () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const result = await adapter.exec('focus')
    expect(result.success).toBe(true)
    expect(mockSetActiveTabId).toHaveBeenCalledWith('tab_1')
  })

  it('exec unknown action returns error', async () => {
    const adapter = new QueryEditorAdapter('tab_1')
    const result = await adapter.exec('nonexistent')
    expect(result.success).toBe(false)
  })
})
