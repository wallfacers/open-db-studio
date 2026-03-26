// src/mcp/fs/adapters/QueryTabAdapter.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryTabAdapter } from './QueryTabAdapter'

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core',  () => ({ invoke: vi.fn() }))

import { emit } from '@tauri-apps/api/event'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore }   from '../../../store/appStore'

// ─── Store 类型（用于 setState）───────────────────────────────────────────
type QueryState = ReturnType<typeof useQueryStore.getState>

const mockProposeSqlDiff = vi.fn()
const mockSetSql         = vi.fn()
const mockSetActiveTabId = vi.fn()
const mockOpenQueryTab   = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()

  useQueryStore.setState({
    tabs: [
      { id: 'tab-q1', type: 'query', title: 'conn1/mydb',    connectionId: 1, db: 'mydb' },
      { id: 'tab-q2', type: 'query', title: 'conn1/otherdb', connectionId: 1, db: 'otherdb' },
    ],
    activeTabId:    'tab-q1',
    sqlContent:     { 'tab-q1': 'SELECT *\nFROM users\nWHERE id = 1', 'tab-q2': 'SELECT 2' },
    proposeSqlDiff: mockProposeSqlDiff,
    setSql:         mockSetSql,
    setActiveTabId: mockSetActiveTabId,
    openQueryTab:   mockOpenQueryTab,
  } as Partial<QueryState>)

  useAppStore.setState({ autoMode: false } as Partial<ReturnType<typeof useAppStore.getState>>)
})

// ── capabilities ─────────────────────────────────────────────────────────────

describe('QueryTabAdapter.capabilities', () => {
  it('声明支持全部 op', () => {
    const adapter = new QueryTabAdapter()
    expect(adapter.capabilities.read).toBe(true)
    expect(adapter.capabilities.write).toBe(true)
    expect(adapter.capabilities.search).toBe(true)
    expect(adapter.capabilities.open).toBe(true)
    expect(adapter.capabilities.exec).toContain('run_sql')
    expect(adapter.capabilities.exec).toContain('focus')
    expect(adapter.capabilities.exec).toContain('undo')
    expect(adapter.capabilities.exec).toContain('confirm_write')
  })
})

// ── read ─────────────────────────────────────────────────────────────────────

describe('QueryTabAdapter.read', () => {
  it('read("active","text") 返回行列表和完整 content', async () => {
    const adapter = new QueryTabAdapter()
    const result  = await adapter.read('active', 'text')

    expect(result).toMatchObject({
      content: 'SELECT *\nFROM users\nWHERE id = 1',
      lines: [
        { no: 1, text: 'SELECT *' },
        { no: 2, text: 'FROM users' },
        { no: 3, text: 'WHERE id = 1' },
      ],
    })
  })

  it('read(tab_id,"text") 读取指定 tab 的 SQL', async () => {
    const adapter = new QueryTabAdapter()
    const result  = await adapter.read('tab-q2', 'text')
    expect((result as { content: string }).content).toBe('SELECT 2')
  })

  it('read("active","struct") 返回 tab 元数据', async () => {
    const adapter = new QueryTabAdapter()
    const result  = await adapter.read('active', 'struct')

    expect(result).toMatchObject({
      type: 'query', tab_id: 'tab-q1', connection_id: 1, db: 'mydb',
    })
  })

  it('不存在的 tab_id 抛出错误', async () => {
    const adapter = new QueryTabAdapter()
    await expect(adapter.read('nonexistent', 'text')).rejects.toThrow()
  })
})

// ── write ────────────────────────────────────────────────────────────────────

describe('QueryTabAdapter.write', () => {
  it('非 Auto 模式：replace_all 调用 proposeSqlDiff 返回 pending_confirm', async () => {
    const adapter = new QueryTabAdapter()

    const result = await adapter.write('active', {
      mode: 'text', op: 'replace_all', content: 'SELECT 1', reason: '简化查询',
    })

    expect(result.status).toBe('pending_confirm')
    expect(mockProposeSqlDiff).toHaveBeenCalledWith(
      expect.objectContaining({ modified: 'SELECT 1', reason: '简化查询' })
    )
  })

  it('Auto 模式：replace_all 直接调用 setSql 返回 applied', async () => {
    useAppStore.setState({ autoMode: true } as Partial<ReturnType<typeof useAppStore.getState>>)
    const adapter = new QueryTabAdapter()

    const result = await adapter.write('active', {
      mode: 'text', op: 'replace_all', content: 'SELECT 2',
    })

    expect(result.status).toBe('applied')
    expect(mockSetSql).toHaveBeenCalledWith('tab-q1', 'SELECT 2')
  })

  it('replace 按行范围替换第 3 行（1-indexed）', async () => {
    useAppStore.setState({ autoMode: true } as Partial<ReturnType<typeof useAppStore.getState>>)
    const adapter = new QueryTabAdapter()

    await adapter.write('active', {
      mode: 'text', op: 'replace', range: [3, 3], content: 'WHERE id = 99',
    })

    const newSql = mockSetSql.mock.calls[0][1] as string
    expect(newSql).toBe('SELECT *\nFROM users\nWHERE id = 99')
  })

  it('insert_after 在第 2 行后插入', async () => {
    useAppStore.setState({ autoMode: true } as Partial<ReturnType<typeof useAppStore.getState>>)
    const adapter = new QueryTabAdapter()

    await adapter.write('active', {
      mode: 'text', op: 'insert_after', line: 2, content: 'ORDER BY id DESC',
    })

    const newSql = mockSetSql.mock.calls[0][1] as string
    expect(newSql).toBe('SELECT *\nFROM users\nORDER BY id DESC\nWHERE id = 1')
  })
})

// ── search ───────────────────────────────────────────────────────────────────

describe('QueryTabAdapter.search', () => {
  it('无过滤返回所有 query tab', async () => {
    const adapter = new QueryTabAdapter()
    const results = await adapter.search({})
    expect(results).toHaveLength(2)
    expect(results.every(r => r.resource === 'tab.query')).toBe(true)
  })

  it('按 keyword 过滤（匹配 label 中的 title）', async () => {
    const adapter = new QueryTabAdapter()
    const results = await adapter.search({ keyword: 'otherdb' })
    expect(results).toHaveLength(1)
    expect(results[0].target).toBe('tab-q2')
  })

  it('FsSearchResult 格式正确', async () => {
    const adapter = new QueryTabAdapter()
    const results = await adapter.search({})
    expect(results[0]).toMatchObject({
      resource: 'tab.query',
      target:   expect.any(String),
      label:    expect.any(String),
      meta:     expect.objectContaining({ connection_id: 1 }),
    })
  })
})

// ── open ─────────────────────────────────────────────────────────────────────

describe('QueryTabAdapter.open', () => {
  it('调用 openQueryTab 并返回新 tab_id', async () => {
    mockOpenQueryTab.mockImplementation(() => {
      const { tabs } = useQueryStore.getState()
      useQueryStore.setState({
        tabs: [...tabs, { id: 'tab-new', type: 'query', title: 'conn2', connectionId: 2, db: 'app' }],
      } as Partial<QueryState>)
    })
    const adapter = new QueryTabAdapter()

    const result = await adapter.open({ connection_id: 2, label: 'conn2', database: 'app' })

    expect(mockOpenQueryTab).toHaveBeenCalledWith(2, 'conn2', 'app')
    expect(result.target).toBe('tab-new')
  })

  it('connection_id 未提供 label 时使用默认 label', async () => {
    mockOpenQueryTab.mockImplementation(() => {
      const { tabs } = useQueryStore.getState()
      useQueryStore.setState({
        tabs: [...tabs, { id: 'tab-new2', type: 'query', title: 'Connection #3', connectionId: 3 }],
      } as Partial<QueryState>)
    })
    const adapter = new QueryTabAdapter()

    await adapter.open({ connection_id: 3 })

    expect(mockOpenQueryTab).toHaveBeenCalledWith(3, 'Connection #3', undefined)
  })
})

// ── exec ─────────────────────────────────────────────────────────────────────

describe('QueryTabAdapter.exec', () => {
  it('exec focus 调用 setActiveTabId', async () => {
    const adapter = new QueryTabAdapter()
    await adapter.exec('tab-q2', 'focus')
    expect(mockSetActiveTabId).toHaveBeenCalledWith('tab-q2')
  })

  it('exec run_sql 发送 run-sql-request 事件', async () => {
    const adapter = new QueryTabAdapter()
    await adapter.exec('active', 'run_sql')
    expect(emit).toHaveBeenCalledWith('run-sql-request', { tab_id: 'tab-q1' })
  })

  it('exec undo 发送 undo-request 事件', async () => {
    const adapter = new QueryTabAdapter()
    await adapter.exec('active', 'undo')
    expect(emit).toHaveBeenCalledWith('undo-request', { tab_id: 'tab-q1' })
  })

  it('exec confirm_write 返回 ok（stub，DiffPanel 自行处理确认）', async () => {
    const adapter = new QueryTabAdapter()
    const result  = await adapter.exec('active', 'confirm_write', { confirm_id: 'abc123' })
    expect((result as { ok: boolean }).ok).toBe(true)
  })
})
