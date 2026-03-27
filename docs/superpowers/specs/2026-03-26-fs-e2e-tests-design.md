# FS Abstraction Layer — E2E Test Design

**Date:** 2026-03-26
**Scope:** 统一 FS 抽象层 Phase 1 端到端测试
**Prerequisite:** `docs/superpowers/specs/2026-03-26-unified-fs-abstraction-design.md`（Phase 1 实现已完成）

---

## 目标

Phase 1 现有测试层次：

| 文件 | 类型 | mock 层 |
|------|------|---------|
| `FsRouter.test.ts` | 单元 | mock adapter |
| `QueryTabAdapter.test.ts` | 单元 | mock store |
| `useMcpBridge.test.ts` | 集成 | mock fsRouter |

**缺口：** 没有测试覆盖从事件触发到 store 变化的完整链路（中间层均为真实实现）。

本 spec 设计两层补充测试：

- **A 层 Integration：** 事件 → `useMcpBridge` → `FsRouter` → `QueryTabAdapter` → store，验证链路通畅
- **C 层 Scenario：** 模拟完整 AI 工作流，验证端到端行为语义

---

## 测试文件

单一文件：`src/mcp/fs/e2e.test.ts`

分两个 `describe` 块，共享辅助函数。

---

## Mock 策略

| 层 | Mock 策略 | 说明 |
|---|---|---|
| `@tauri-apps/api/event` (listen/emit) | Mock | 无真实 Tauri 运行时，捕获 listener 用于手动触发 |
| `@tauri-apps/api/core` (invoke) | `mockImplementation` 按命令分发 | 见下方"invoke mock 详细配置" |
| `useMcpBridge` | **真实**（renderHook） | E2E 的起点 |
| `fsRouter` / `registerFsAdapters` | **真实**（不 mock） | A 层核心验证对象 |
| `QueryTabAdapter` | **真实** | E2E 穿透目标 |
| `useQueryStore` / `useAppStore` | **真实**（setState 预置） | 验证 store 变化是 E2E 的核心目标 |

### invoke mock 详细配置

`queryStore.ts` 在**模块加载时**自动执行：
- `loadTabsFromStorage()` — 调用 `invoke('get_ui_state', ...)`, `invoke('list_tab_files')`, `invoke('read_tab_file', ...)` 等
- `useQueryStore.subscribe(...)` 回调 — 防抖调用 `invoke('set_ui_state', ...)`

真实 `setSql` 调用 `persistSqlContent`，触发 `invoke('write_tab_file', ...)`。

因此 `invoke` 必须按命令名分发 mock，**不能简单地 `mockResolvedValue(undefined)`**：

```typescript
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// 在 beforeEach 中配置：
mockInvoke.mockImplementation((cmd: string) => {
  if (cmd === 'list_tab_files') return Promise.resolve([])
  if (cmd === 'read_tab_file') return Promise.resolve(null)
  if (cmd === 'get_ui_state') return Promise.resolve(null)
  // write_tab_file, set_ui_state, mcp_query_respond 等均返回 undefined
  return Promise.resolve(undefined)
})
```

`loadTabsFromStorage` 异步完成后会用空状态覆盖 store。因此 **store 的 `setState` 预置必须在 `loadTabsFromStorage` resolve 之后执行**，即在每个 `it` 内调用 `mountBridge()` 前执行：

```typescript
beforeEach(async () => {
  vi.clearAllMocks()
  // 配置 invoke mock（见上方）
  mockInvoke.mockImplementation(...)

  // 等待 loadTabsFromStorage 完成（它会将 store 重置为空）
  // loadTabsFromStorage 内部有多级 await，需要 setTimeout(0) 排到宏任务之后确保全部 resolve
  await new Promise(r => setTimeout(r, 0))

  // 然后预置测试状态（覆盖 loadTabsFromStorage 的结果）
  useQueryStore.setState({
    tabs: [...],
    activeTabId: 'tab-q1',
    sqlContent: { 'tab-q1': 'SELECT * FROM users' },
  })
  useAppStore.setState({ autoMode: false })
})
```

> **注意：** store 的 `setSql`、`proposeSqlDiff` 等方法使用**真实实现**（不 mock），但其触发的持久化 `invoke` 调用（`write_tab_file`、`set_ui_state` 等）由上方 `mockImplementation` 静默吸收，不影响测试结果。

---

## 辅助函数

```typescript
type ListenCallback<T> = (event: { payload: T }) => void | Promise<void>
const capturedListeners: Record<string, ListenCallback<unknown>> = {}

// 挂载 useMcpBridge（每个 it 开头调用）
function mountBridge(): void {
  renderHook(() => useMcpBridge())
}

/**
 * 触发 mcp://query-request 事件，query_type = 'fs_request'。
 *
 * useMcpBridge 的 fs_request 分支期望的 params 结构：
 *   { op, resource, target, payload: Record<string, unknown> }
 *
 * 完整事件 payload 结构：
 *   {
 *     request_id: string,
 *     query_type: 'fs_request',
 *     params: { op, resource, target, payload }
 *   }
 */
async function emitFsRequest(
  op: string,
  resource: string,
  target: string,      // search 操作中该字段不被 FsRouter 使用，传空字符串即可
  payload: Record<string, unknown>,
  request_id = 'test-req',
): Promise<void> {
  const handler = capturedListeners['mcp://query-request']
  await handler?.({ payload: { request_id, query_type: 'fs_request', params: { op, resource, target, payload } } })
}

// 从 mockInvoke 调用记录中取最后一次 mcp_query_respond 的 data
function lastRespondData(): unknown {
  const call = [...mockInvoke.mock.calls]
    .reverse()
    .find(c => c[0] === 'mcp_query_respond')
  return (call?.[1] as { data: unknown } | undefined)?.data
}
```

> **mountBridge() 调用位置：** 必须在**每个 `it` 内最先调用**（store setState 之后），而非在 `beforeEach` 中调用。原因：`useMcpBridge` 内 `registerFsAdapters()` 在渲染时执行，每次 `it` 都需要重新注册 listener 到 `capturedListeners`。

---

## A 层：Integration 测试

```typescript
describe('A: Integration — event → FsRouter → Adapter → store', () => {
```

### A-1: fs_read 返回 SQL 内容

```
前置: activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT 1'

动作: emitFsRequest('read', 'tab.query', 'active', { mode: 'text' }, 'a-1')

断言:
  - mockInvoke 被调用 'mcp_query_respond' with { requestId: 'a-1', data: expect.objectContaining({}) }
  - lastRespondData().content === 'SELECT 1'
  - expect(lastRespondData().lines).toEqual([{ no: 1, text: 'SELECT 1' }])
    （注意用 toEqual 而非 ===，lines 是数组引用比较无意义）
```

### A-2: fs_write 非 Auto 模式 → 触发 pendingDiff

```
前置: autoMode = false, activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT *'

动作: emitFsRequest('write', 'tab.query', 'active',
        { mode:'text', op:'replace_all', content:'SELECT 1', reason:'优化' }, 'a-2')

断言:
  - useQueryStore.getState().pendingDiff.original === 'SELECT *'   ← 验证来源 tab 正确
  - useQueryStore.getState().pendingDiff.modified === 'SELECT 1'
  - useQueryStore.getState().pendingDiff.reason   === '优化'
  - lastRespondData().status === 'pending_confirm'

（pendingDiff 类型为 SqlDiffProposal：{ tabId, original, modified, reason, startOffset, endOffset }）
```

### A-3: fs_write Auto 模式 → 直接写入 store

```
前置: autoMode = true, activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT *'

动作: emitFsRequest('write', 'tab.query', 'active',
        { mode:'text', op:'replace_all', content:'SELECT 1' }, 'a-3')

断言:
  - useQueryStore.getState().sqlContent['tab-q1'] === 'SELECT 1'
  - useQueryStore.getState().pendingDiff === null   ← 未产生 diff
  - lastRespondData().status === 'applied'
```

---

## C 层：Scenario 测试

```typescript
describe('C: Scenario — 完整 AI 工作流', () => {
```

### Scenario 1：AI 非 Auto 修改 SQL → 用户确认 → SQL 最终更新

模拟完整"AI 提案 + 用户点击确认"流程。

```
前置:
  autoMode = false
  activeTabId = 'tab-q1'
  sqlContent['tab-q1'] = 'SELECT * FROM users'

步骤 1 — AI 发起写操作:
  await emitFsRequest('write', 'tab.query', 'active',
    { mode:'text', op:'replace_all', content:'SELECT id FROM users', reason:'只取 id' })

  中间状态断言:
    - pendingDiff.original  === 'SELECT * FROM users'
    - pendingDiff.modified  === 'SELECT id FROM users'
    - sqlContent['tab-q1'] === 'SELECT * FROM users'  ← 尚未写入

步骤 2 — 用户点击"确认"（调用 store.applyDiff）:
  useQueryStore.getState().applyDiff()
  （applyDiff 内部：newSql = original.slice(0, startOffset) + modified + original.slice(endOffset)
   replace_all 时 startOffset=0, endOffset=original.length，故 newSql = '' + modified + '' = modified）

  最终断言:
    - sqlContent['tab-q1'] === 'SELECT id FROM users'
    - pendingDiff === null
```

### Scenario 2：AI Auto 模式直接覆写 SQL

模拟 Auto 模式下无需确认的写入。

```
前置:
  autoMode = true
  activeTabId = 'tab-q1'
  sqlContent['tab-q1'] = 'SELECT * FROM users'

动作:
  await emitFsRequest('write', 'tab.query', 'active',
    { mode:'text', op:'replace_all', content:'SELECT id FROM users WHERE active=1' })

断言:
  - sqlContent['tab-q1'] === 'SELECT id FROM users WHERE active=1'
  - pendingDiff === null
  - lastRespondData().status === 'applied'
```

### Scenario 3：AI 搜索 tab → 打开新 tab → 返回 tab_id

两个步骤在**同一 `it`** 内串行执行。步骤 1（search）不修改 store，步骤 2（open）在相同 store 状态基础上执行。

```
前置:
  tabs = [{ id:'tab-q1', type:'query', title:'conn1/mydb', connectionId:1, db:'mydb' }]
  activeTabId = 'tab-q1'

步骤 1 — AI 搜索 tab（target 字段 FsRouter search 不使用，传空字符串）:
  await emitFsRequest('search', 'tab.query', '', { keyword:'mydb' }, 'fs-s1')

  断言:
    - lastRespondData() 是数组
    - expect(lastRespondData()).toContainEqual(expect.objectContaining({
        resource: 'tab.query', target: 'tab-q1'
      }))

步骤 2 — AI 打开新 tab:
  const tabsBefore = useQueryStore.getState().tabs.length  // === 1
  await emitFsRequest('open', 'tab.query', '', { connection_id:1, label:'conn1', database:'mydb' }, 'fs-s2')

  const newTabId = (lastRespondData() as { target: string }).target

  断言:
    - typeof newTabId === 'string'
    - newTabId !== 'tab-q1'
    - useQueryStore.getState().tabs.length === tabsBefore + 1
    - useQueryStore.getState().tabs.find(t => t.id === newTabId)?.type === 'query'
```

---

## 测试文件骨架

```typescript
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

function mountBridge() { renderHook(() => useMcpBridge()) }

async function emitFsRequest(
  op: string, resource: string, target: string,
  payload: Record<string, unknown>, request_id = 'test-req',
) {
  const handler = capturedListeners['mcp://query-request']
  await handler?.({ payload: { request_id, query_type: 'fs_request', params: { op, resource, target, payload } } })
}

function lastRespondData(): unknown {
  const call = [...mockInvoke.mock.calls].reverse().find(c => c[0] === 'mcp_query_respond')
  return (call?.[1] as { data: unknown } | undefined)?.data
}

// ─── beforeEach ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks()

  // 按命令分发 invoke mock（避免 store 副作用泄漏）
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_tab_files') return Promise.resolve([])
    if (cmd === 'read_tab_file') return Promise.resolve(null)
    if (cmd === 'get_ui_state') return Promise.resolve(null)
    return Promise.resolve(undefined)
  })

  // 等待 loadTabsFromStorage 完成（避免其覆盖下方的 setState）
  await Promise.resolve()

  // 预置 store 状态
  useQueryStore.setState({
    tabs: [{ id: 'tab-q1', type: 'query', title: 'conn1/mydb', connectionId: 1, db: 'mydb' }],
    activeTabId: 'tab-q1',
    sqlContent: { 'tab-q1': 'SELECT * FROM users' },
  })
  useAppStore.setState({ autoMode: false })
})

// ─── A 层：Integration ────────────────────────────────────────────────────────

describe('A: Integration — event → FsRouter → Adapter → store', () => {
  // mountBridge() 必须在每个 it 内最先调用
  it('A-1: fs_read 返回 SQL 内容', async () => {
    mountBridge()
    await emitFsRequest('read', 'tab.query', 'active', { mode: 'text' }, 'a-1')
    expect(lastRespondData()).toMatchObject({ content: 'SELECT * FROM users' })
  })
  it('A-2: fs_write 非 Auto → pendingDiff', async () => {
    mountBridge()
    // ... 见上方 A-2 详细断言
  })
  it('A-3: fs_write Auto → 直接写入', async () => {
    mountBridge()
    // ... 见上方 A-3 详细断言
  })
})

// ─── C 层：Scenario ──────────────────────────────────────────────────────────

describe('C: Scenario — 完整 AI 工作流', () => {
  it('场景1：非 Auto 改 SQL → 用户确认 → SQL 更新', async () => { ... })
  it('场景2：Auto 模式直接覆写', async () => { ... })
  it('场景3：搜索 tab → 打开新 tab', async () => { ... })
})
```

---

## 成功标准

- `npx vitest run src/mcp/fs/e2e.test.ts` — 6 个用例全部 PASS
- 所有用例不 mock `fsRouter`、`QueryTabAdapter`
- store 的 `setSql`、`proposeSqlDiff`、`applyDiff` 等方法使用**真实实现**；持久化 `invoke` 调用（`write_tab_file`、`set_ui_state` 等）由 `mockImplementation` 静默吸收
- `npx vitest run` 全量测试仍然全部 PASS（不破坏现有 205 个测试）
- `npx tsc --noEmit` 无新增类型错误
