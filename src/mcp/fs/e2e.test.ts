// src/mcp/fs/e2e.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMcpBridge } from '../../hooks/useMcpBridge'
import { useQueryStore } from '../../store/queryStore'
import { useAppStore } from '../../store/appStore'
import { invoke } from '@tauri-apps/api/core'

// ─── Mock Tauri APIs ─────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

type ListenCallback<T> = (event: { payload: T }) => void | Promise<void>
const capturedListeners: Record<string, ListenCallback<unknown>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, cb: ListenCallback<unknown>) => {
    capturedListeners[eventName] = cb
    return Promise.resolve(() => { delete capturedListeners[eventName] })
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}))

const mockInvoke = vi.mocked(invoke)

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

function mountBridge(): void {
  renderHook(() => useMcpBridge())
}

async function emitFsRequest(
  op: string,
  resource: string,
  target: string,
  payload: Record<string, unknown>,
  request_id = 'test-req',
): Promise<void> {
  const handler = capturedListeners['mcp://query-request']
  await handler?.({
    payload: { request_id, query_type: 'fs_request', params: { op, resource, target, payload } },
  })
}

function lastRespondData(): unknown {
  const call = [...mockInvoke.mock.calls]
    .reverse()
    .find(c => c[0] === 'mcp_query_respond')
  return (call?.[1] as { data: unknown } | undefined)?.data
}

// ─── beforeEach ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks()

  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_tab_files') return Promise.resolve([])
    if (cmd === 'read_tab_file') return Promise.resolve(null)
    if (cmd === 'get_ui_state') return Promise.resolve(null)
    return Promise.resolve(undefined)
  })

  await new Promise(r => setTimeout(r, 0))

  useQueryStore.setState({
    tabs: [{ id: 'tab-q1', type: 'query', title: 'conn1/mydb', connectionId: 1, db: 'mydb' }],
    activeTabId: 'tab-q1',
    sqlContent: { 'tab-q1': 'SELECT * FROM users' },
    pendingDiff: null,
  })
  useAppStore.setState({ autoMode: false })
})

// ─── A 层：Integration ────────────────────────────────────────────────────────

describe('A: Integration — event → FsRouter → Adapter → store', () => {
  it('A-1: fs_read 返回 SQL 内容', async () => {
    mountBridge()
    await emitFsRequest('read', 'tab.query', 'active', { mode: 'text' }, 'a-1')

    const data = lastRespondData() as { content: string; lines: Array<{ no: number; text: string }> }
    expect(data.content).toBe('SELECT * FROM users')
    expect(data.lines).toEqual([{ no: 1, text: 'SELECT * FROM users' }])
    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond')
    expect(call?.[1]).toMatchObject({ requestId: 'a-1' })
  })

  it('A-2: fs_write 非 Auto → pendingDiff', async () => {
    mountBridge()
    await emitFsRequest(
      'write', 'tab.query', 'active',
      { mode: 'text', op: 'replace_all', content: 'SELECT 1', reason: '优化' },
      'a-2',
    )

    const state = useQueryStore.getState()
    expect(state.pendingDiff).not.toBeNull()
    expect(state.pendingDiff!.original).toBe('SELECT * FROM users')
    expect(state.pendingDiff!.modified).toBe('SELECT 1')
    expect(state.pendingDiff!.reason).toBe('优化')

    const data = lastRespondData() as { status: string }
    expect(data.status).toBe('pending_confirm')
  })

  it('A-3: fs_write Auto → 直接写入', async () => {
    useAppStore.setState({ autoMode: true })
    mountBridge()
    await emitFsRequest(
      'write', 'tab.query', 'active',
      { mode: 'text', op: 'replace_all', content: 'SELECT 1' },
      'a-3',
    )

    const state = useQueryStore.getState()
    expect(state.sqlContent['tab-q1']).toBe('SELECT 1')
    expect(state.pendingDiff).toBeNull()

    const data = lastRespondData() as { status: string }
    expect(data.status).toBe('applied')
  })
})

// ─── C 层：Scenario ──────────────────────────────────────────────────────────

describe('C: Scenario — 完整 AI 工作流', () => {
  it('场景1：非 Auto 改 SQL → 用户确认 → SQL 更新', async () => {
    mountBridge()

    await emitFsRequest(
      'write', 'tab.query', 'active',
      { mode: 'text', op: 'replace_all', content: 'SELECT id FROM users', reason: '只取 id' },
    )

    const mid = useQueryStore.getState()
    expect(mid.pendingDiff!.original).toBe('SELECT * FROM users')
    expect(mid.pendingDiff!.modified).toBe('SELECT id FROM users')
    expect(mid.sqlContent['tab-q1']).toBe('SELECT * FROM users')

    useQueryStore.getState().applyDiff()

    const final = useQueryStore.getState()
    expect(final.sqlContent['tab-q1']).toBe('SELECT id FROM users')
    expect(final.pendingDiff).toBeNull()
  })

  it('场景2：Auto 模式直接覆写', async () => {
    useAppStore.setState({ autoMode: true })
    mountBridge()

    await emitFsRequest(
      'write', 'tab.query', 'active',
      { mode: 'text', op: 'replace_all', content: 'SELECT id FROM users WHERE active=1' },
    )

    const state = useQueryStore.getState()
    expect(state.sqlContent['tab-q1']).toBe('SELECT id FROM users WHERE active=1')
    expect(state.pendingDiff).toBeNull()

    const data = lastRespondData() as { status: string }
    expect(data.status).toBe('applied')
  })

  it('场景3：搜索 tab → 打开新 tab', async () => {
    mountBridge()

    await emitFsRequest('search', 'tab.query', '', { keyword: 'mydb' }, 'fs-s1')

    const searchResult = lastRespondData() as Array<{ resource: string; target: string }>
    expect(Array.isArray(searchResult)).toBe(true)
    expect(searchResult).toContainEqual(
      expect.objectContaining({ resource: 'tab.query', target: 'tab-q1' })
    )

    const tabsBefore = useQueryStore.getState().tabs.length
    await emitFsRequest(
      'open', 'tab.query', '',
      { connection_id: 1, label: 'conn1', database: 'mydb' },
      'fs-s2',
    )

    const openResult = lastRespondData() as { target: string }
    const newTabId = openResult.target

    expect(typeof newTabId).toBe('string')
    expect(newTabId).not.toBe('tab-q1')
    expect(useQueryStore.getState().tabs.length).toBe(tabsBefore + 1)
    expect(
      useQueryStore.getState().tabs.find(t => t.id === newTabId)?.type
    ).toBe('query')
  })
})
