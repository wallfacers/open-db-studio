# Unified FS Abstraction — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 FsRouter + FsAdapter TypeScript 基础设施，并实现 QueryTabAdapter，使 `tab.query` 全量 DSL 操作（read/write/search/open/exec）可用，替代现有 tab_control 工具。

**Architecture:** 新增 `src/mcp/fs/` 目录作为统一抽象层核心。Rust 层新增 5 个 `fs_*` 工具，通过现有 `query_frontend()` 发送 `mcp://query-request`（`query_type = "fs_request"`）转发到前端。`useMcpBridge.ts` 在现有 `mcp://query-request` handler 中增加 `fs_request` 分支，路由到 `FsRouter.handle()`。`FsRouter` 按 resource 类型分发到对应 Adapter。`QueryTabAdapter` 实现 `tab.query` 的完整 Adapter。Rust 层新旧工具并存，Phase 2 再删旧工具。

**Tech Stack:** React 18 + TypeScript + Zustand + Vitest + @testing-library/react + Tauri 2.x

**Spec:** `docs/superpowers/specs/2026-03-26-unified-fs-abstraction-design.md`

---

## 文件结构

```
新建:
  src/mcp/fs/types.ts                       — 全部 TypeScript 接口定义
  src/mcp/fs/FsRouter.ts                    — FsRouter 类（注册 + 路由 + glob）
  src/mcp/fs/adapters/QueryTabAdapter.ts    — tab.query 全量 Adapter
  src/mcp/fs/index.ts                       — 注册入口 + 导出 fsRouter 单例

修改:
  src/hooks/useMcpBridge.ts                 — 在 mcp://query-request 的 fs_request 分支中路由到 FsRouter
  src-tauri/src/mcp/mod.rs                  — tool_definitions() 新增 5 个 fs_* 工具 + call_tool 新增分支

测试:
  src/mcp/fs/FsRouter.test.ts               — FsRouter 单元测试
  src/mcp/fs/adapters/QueryTabAdapter.test.ts — QueryTabAdapter 单元测试
  src/hooks/useMcpBridge.test.ts            — 集成测试（新增 fs_request 场景）
```

---

## Chunk 1: 类型定义 + FsRouter

### Task 1: 创建 `src/mcp/fs/types.ts`

**Files:**
- Create: `src/mcp/fs/types.ts`

- [ ] **Step 1: 写入完整类型定义文件**

```typescript
// src/mcp/fs/types.ts

export type FsOp = 'read' | 'write' | 'search' | 'open' | 'exec'

export interface FsMcpRequest {
  op:       FsOp
  resource: string                        // 精确类型，如 "tab.query"
  target:   string                        // "active" | "list" | tab_id | 名称
  payload:  Record<string, unknown>
}

export interface FsReadResult {
  [key: string]: unknown
}

export interface FsWriteResult {
  status:      'applied' | 'pending_confirm' | 'error'
  confirm_id?: string
  preview?:    string
  message?:    string
}

export interface FsSearchFilter {
  keyword?:       string
  type?:          string
  connection_id?: number
  [key: string]:  unknown
}

export interface FsSearchResult {
  resource: string
  target:   string
  label:    string
  meta:     Record<string, unknown>
}

export type TextPatchOp = 'replace' | 'insert_after' | 'replace_all'

export interface FsWritePatch {
  mode:     'text' | 'struct'
  // text 模式
  op?:      TextPatchOp
  range?:   [number, number]   // [fromLine, toLine]，1-indexed
  line?:    number             // insert_after 用
  content?: string
  // struct 模式
  path?:    string             // JSON path，如 "/columns/1/comment"
  value?:   unknown
  // 通用
  reason?:  string
}

export interface FsAdapter {
  capabilities: {
    read:   boolean
    write:  boolean
    search: boolean
    open:   boolean
    exec:   string[]           // 支持的 action 名列表
  }

  read?(target: string, mode: 'text' | 'struct'): Promise<FsReadResult>
  write?(target: string, patch: FsWritePatch): Promise<FsWriteResult>
  search?(filter: FsSearchFilter): Promise<FsSearchResult[]>
  open?(params: Record<string, unknown>): Promise<{ target: string }>
  exec?(target: string, action: string, params?: Record<string, unknown>): Promise<unknown>
}
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 3: Commit**

```bash
git add src/mcp/fs/types.ts
git commit -m "feat(fs): add FsAdapter TypeScript type definitions"
```

---

### Task 2: 创建 `src/mcp/fs/FsRouter.ts` + 单元测试

**Files:**
- Create: `src/mcp/fs/FsRouter.ts`
- Create: `src/mcp/fs/FsRouter.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
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
```

- [ ] **Step 2: 运行测试，确认全部 FAIL**

```bash
npx vitest run src/mcp/fs/FsRouter.test.ts
```

期望：FAIL（FsRouter 不存在）

- [ ] **Step 3: 实现 FsRouter**

```typescript
// src/mcp/fs/FsRouter.ts
import type {
  FsAdapter, FsMcpRequest, FsSearchFilter, FsSearchResult,
  FsWritePatch,
} from './types'

export class FsRouter {
  private adapters = new Map<string, FsAdapter>()

  register(resource: string, adapter: FsAdapter): void {
    this.adapters.set(resource, adapter)
  }

  async handle(req: FsMcpRequest): Promise<string> {
    if (req.op === 'search') {
      return this._handleSearch(req)
    }

    const adapter = this.adapters.get(req.resource)
    if (!adapter) {
      throw new Error(`Unknown resource: ${req.resource}`)
    }

    switch (req.op) {
      case 'read': {
        if (!adapter.read) throw new Error(`${req.resource} does not support read`)
        const mode = req.payload.mode as 'text' | 'struct'
        return JSON.stringify(await adapter.read(req.target, mode))
      }
      case 'write': {
        if (!adapter.write) throw new Error(`${req.resource} does not support write`)
        return JSON.stringify(await adapter.write(req.target, req.payload as FsWritePatch))
      }
      case 'open': {
        if (!adapter.open) throw new Error(`${req.resource} does not support open`)
        return JSON.stringify(await adapter.open(req.payload))
      }
      case 'exec': {
        if (!adapter.exec) throw new Error(`${req.resource} does not support exec`)
        const action = req.payload.action as string
        if (!adapter.capabilities.exec.includes(action)) {
          throw new Error(`Unsupported action: ${action}`)
        }
        const params = req.payload.params as Record<string, unknown> | undefined
        return JSON.stringify(await adapter.exec(req.target, action, params))
      }
      default:
        throw new Error(`Unknown op: ${(req as FsMcpRequest).op}`)
    }
  }

  private async _handleSearch(req: FsMcpRequest): Promise<string> {
    const pattern = req.resource
    const isGlob  = pattern.endsWith('.*')
    const prefix  = isGlob ? pattern.slice(0, -2) : null

    const matched = [...this.adapters.entries()].filter(([key]) =>
      isGlob
        ? key.startsWith(prefix! + '.') || key === prefix
        : key === pattern
    )

    const results: FsSearchResult[] = []
    for (const [, adapter] of matched) {
      if (adapter.search) {
        results.push(...await adapter.search(req.payload as FsSearchFilter))
      }
    }
    return JSON.stringify(results)
  }
}
```

- [ ] **Step 4: 运行测试，确认全部 PASS**

```bash
npx vitest run src/mcp/fs/FsRouter.test.ts
```

期望：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/fs/FsRouter.ts src/mcp/fs/FsRouter.test.ts
git commit -m "feat(fs): add FsRouter with glob-aware search routing"
```

---

## Chunk 2: QueryTabAdapter

### Task 3: 实现 `QueryTabAdapter` + 单元测试

**Files:**
- Create: `src/mcp/fs/adapters/QueryTabAdapter.ts`
- Create: `src/mcp/fs/adapters/QueryTabAdapter.test.ts`

**背景：**
- `useQueryStore` 包含：`tabs`、`activeTabId`、`sqlContent`、`setActiveTabId`、`openQueryTab`、`proposeSqlDiff`、`setSql`
- `useAppStore` 包含：`autoMode`
- 写操作：Auto 模式 → `setSql` 直接写入；非 Auto 模式 → `proposeSqlDiff` 触发 DiffPanel 展示 diff
- `confirm_write` 为 stub（DiffPanel 自行处理确认，无需 exec 介入）

- [ ] **Step 1: 写失败测试**

```typescript
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
```

- [ ] **Step 2: 运行测试，确认全部 FAIL**

```bash
npx vitest run src/mcp/fs/adapters/QueryTabAdapter.test.ts
```

期望：FAIL（文件不存在）

- [ ] **Step 3: 实现 QueryTabAdapter**

```typescript
// src/mcp/fs/adapters/QueryTabAdapter.ts
import { emit } from '@tauri-apps/api/event'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore }   from '../../../store/appStore'
import type {
  FsAdapter, FsReadResult, FsWriteResult, FsWritePatch,
  FsSearchFilter, FsSearchResult,
} from '../types'

function resolveTabId(target: string): string {
  if (target === 'active') return useQueryStore.getState().activeTabId
  return target
}

function buildLines(content: string): Array<{ no: number; text: string }> {
  return content.split('\n').map((text, i) => ({ no: i + 1, text }))
}

function applyTextPatch(original: string, patch: FsWritePatch): string {
  const lines = original.split('\n')

  switch (patch.op) {
    case 'replace_all':
      return patch.content ?? ''

    case 'replace': {
      if (!patch.range) return patch.content ?? ''
      const [from, to] = patch.range  // 1-indexed
      const before   = lines.slice(0, from - 1)
      const after    = lines.slice(to)
      const newLines = (patch.content ?? '').split('\n')
      return [...before, ...newLines, ...after].join('\n')
    }

    case 'insert_after': {
      const lineNo   = patch.line ?? 0  // 1-indexed：在第 lineNo 行后插入
      const before   = lines.slice(0, lineNo)
      const after    = lines.slice(lineNo)
      const newLines = (patch.content ?? '').split('\n')
      return [...before, ...newLines, ...after].join('\n')
    }

    default:
      return patch.content ?? original
  }
}

export class QueryTabAdapter implements FsAdapter {
  capabilities = {
    read:   true,
    write:  true,
    search: true,
    open:   true,
    exec:   ['focus', 'run_sql', 'undo', 'confirm_write'],
  }

  async read(target: string, mode: 'text' | 'struct'): Promise<FsReadResult> {
    const tabId = resolveTabId(target)
    const { tabs, sqlContent } = useQueryStore.getState()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) throw new Error(`Tab not found: ${target}`)

    if (mode === 'struct') {
      return {
        type:          'query',
        tab_id:        tab.id,
        title:         tab.title,
        connection_id: tab.connectionId ?? null,
        db:            tab.db ?? null,
      }
    }

    // text 模式
    const content = sqlContent[tabId] ?? ''
    return {
      content,
      lines:          buildLines(content),
      cursor_line:    null,
      selected_range: null,
      statements:     content ? [content] : [],
    }
  }

  async write(target: string, patch: FsWritePatch): Promise<FsWriteResult> {
    const tabId = resolveTabId(target)
    const { tabs, sqlContent, proposeSqlDiff, setSql } = useQueryStore.getState()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) throw new Error(`Tab not found: ${target}`)

    const original = sqlContent[tabId] ?? ''
    const modified = applyTextPatch(original, patch)
    const { autoMode } = useAppStore.getState()

    if (autoMode) {
      setSql(tabId, modified)
      return { status: 'applied' }
    }

    // 非 Auto 模式：走 proposeSqlDiff → DiffPanel
    proposeSqlDiff({ tabId, original, modified, reason: patch.reason ?? '' })
    return { status: 'pending_confirm', confirm_id: `${tabId}-diff` }
  }

  async search(filter: FsSearchFilter): Promise<FsSearchResult[]> {
    const { tabs } = useQueryStore.getState()
    const kw = filter.keyword?.toLowerCase()

    return tabs
      .filter(t => t.type === 'query')
      .filter(t => !kw || t.title.toLowerCase().includes(kw))
      .map(t => ({
        resource: 'tab.query',
        target:   t.id,
        label:    `query · ${t.title}`,
        meta:     { connection_id: t.connectionId, db: t.db ?? null },
      }))
  }

  async open(params: Record<string, unknown>): Promise<{ target: string }> {
    const connId   = params.connection_id as number
    const label    = (params.label as string | undefined) ?? `Connection #${connId}`
    const database = params.database as string | undefined

    const { openQueryTab } = useQueryStore.getState()
    const beforeIds = new Set(useQueryStore.getState().tabs.map(t => t.id))

    openQueryTab(connId, label, database)

    // 等待 store 微任务更新
    await Promise.resolve()

    const { tabs: after } = useQueryStore.getState()
    const newTab = after.find(t => t.type === 'query' && !beforeIds.has(t.id))
    if (!newTab) throw new Error('openQueryTab did not produce a new tab')
    return { target: newTab.id }
  }

  async exec(target: string, action: string, _params?: Record<string, unknown>): Promise<unknown> {
    const tabId = resolveTabId(target)

    switch (action) {
      case 'focus':
        useQueryStore.getState().setActiveTabId(tabId)
        return { ok: true }

      case 'run_sql':
        await emit('run-sql-request', { tab_id: tabId })
        return { ok: true }

      case 'undo':
        await emit('undo-request', { tab_id: tabId })
        return { ok: true }

      case 'confirm_write':
        // DiffPanel 通过 store 的 proposeSqlDiff 流程自行处理确认，此处为 stub
        return { ok: true }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }
}
```

- [ ] **Step 4: 运行测试，确认全部 PASS**

```bash
npx vitest run src/mcp/fs/adapters/QueryTabAdapter.test.ts
```

期望：全部 PASS

- [ ] **Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 6: Commit**

```bash
git add src/mcp/fs/adapters/QueryTabAdapter.ts src/mcp/fs/adapters/QueryTabAdapter.test.ts
git commit -m "feat(fs): add QueryTabAdapter for tab.query read/write/search/open/exec"
```

---

## Chunk 3: 注册入口 + useMcpBridge 集成 + Rust 工具注册

### Task 4: 创建 `src/mcp/fs/index.ts`

**Files:**
- Create: `src/mcp/fs/index.ts`

- [ ] **Step 1: 写注册入口**

```typescript
// src/mcp/fs/index.ts
import { FsRouter } from './FsRouter'
import { QueryTabAdapter } from './adapters/QueryTabAdapter'

export const fsRouter = new FsRouter()

/**
 * 注册所有 FsAdapter。
 * 在 useMcpBridge 初始化时调用，设计为幂等（重复调用只是覆盖 Map 中的同 key）。
 * Phase 2 在此追加 TableTabAdapter、MetricTabAdapter。
 * Phase 3 在此追加 DbTreeAdapter、TaskCenterAdapter、LlmSettingsAdapter、ConnSettingsAdapter。
 */
export function registerFsAdapters(): void {
  fsRouter.register('tab.query', new QueryTabAdapter())
  // Phase 2: fsRouter.register('tab.table',  new TableTabAdapter())
  // Phase 2: fsRouter.register('tab.metric', new MetricTabAdapter())
  // Phase 3: fsRouter.register('panel.db-tree',   new DbTreeAdapter())
  // Phase 3: fsRouter.register('panel.tasks',      new TaskCenterAdapter())
  // Phase 3: fsRouter.register('settings.llm',     new LlmSettingsAdapter())
  // Phase 3: fsRouter.register('settings.conn',    new ConnSettingsAdapter())
}

export type {
  FsOp, FsAdapter, FsMcpRequest, FsReadResult, FsWriteResult,
  FsWritePatch, FsSearchFilter, FsSearchResult,
} from './types'
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 3: Commit**

```bash
git add src/mcp/fs/index.ts
git commit -m "feat(fs): add FsRouter registration entry point and singleton"
```

---

### Task 5: 集成到 `useMcpBridge.ts`

**Files:**
- Modify: `src/hooks/useMcpBridge.ts`
- Modify: `src/hooks/useMcpBridge.test.ts`

**策略：** 复用现有 `mcp://query-request` 事件通道。在 `query_type === 'fs_request'` 分支中路由到 `fsRouter`。无需新增独立事件，Rust 侧直接复用 `query_frontend()`。

- [ ] **Step 1: 写失败测试（在 `useMcpBridge.test.ts` 末尾追加）**

```typescript
// ─── 新增：fs_request 场景 ───────────────────────────────────────────────────

import { fsRouter, registerFsAdapters } from '../mcp/fs'

// 整块 mock：fsRouter.handle 可控，registerFsAdapters 为空操作
vi.mock('../mcp/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/fs')>()
  return {
    ...actual,
    fsRouter: {
      handle: vi.fn().mockResolvedValue(JSON.stringify({ content: 'SELECT 1', lines: [] })),
    },
    registerFsAdapters: vi.fn(),
  }
})

describe('mcp://query-request → fs_request', () => {
  it('将 fs_request 路由到 fsRouter.handle 并回调 mcp_query_respond', async () => {
    mountBridge()

    await emitQueryRequest({
      request_id: 'fs-1',
      query_type: 'fs_request',
      params: { op: 'read', resource: 'tab.query', target: 'active', payload: { mode: 'text' } },
    })

    expect(fsRouter.handle).toHaveBeenCalledWith({
      op: 'read', resource: 'tab.query', target: 'active', payload: { mode: 'text' },
    })
    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'fs-1',
      data: { content: 'SELECT 1', lines: [] },
    })
  })

  it('fsRouter 抛出错误时回调 error 字段', async () => {
    vi.mocked(fsRouter.handle).mockRejectedValueOnce(new Error('Unknown resource: tab.unknown'))
    mountBridge()

    await emitQueryRequest({
      request_id: 'fs-2',
      query_type: 'fs_request',
      params: { op: 'read', resource: 'tab.unknown', target: 'active', payload: { mode: 'text' } },
    })

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'fs-2',
      data: { error: 'Unknown resource: tab.unknown' },
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认新用例 FAIL**

```bash
npx vitest run src/hooks/useMcpBridge.test.ts
```

期望：新增的两个 `fs_request` 用例 FAIL

- [ ] **Step 3: 修改 `useMcpBridge.ts`**

在文件顶部 import 区追加：
```typescript
import { fsRouter, registerFsAdapters } from '../mcp/fs'
import type { FsOp } from '../mcp/fs'
```

在 `useMcpBridge` 函数体内、`useEffect` 调用**之前**追加（只执行一次注册）：
```typescript
// 注册所有 FsAdapter（幂等，可重复调用）
registerFsAdapters()
```

在 `mcp://query-request` handler 的 `search_db_metadata` 分支之后，`data` 赋值完成之前追加：
```typescript
} else if (query_type === 'fs_request') {
  const { op, resource, target, payload: fsPayload } = params as {
    op: FsOp; resource: string; target: string; payload: Record<string, unknown>
  }
  try {
    const resultStr = await fsRouter.handle({ op, resource, target, payload: fsPayload })
    data = JSON.parse(resultStr) as unknown
  } catch (fsErr) {
    data = { error: fsErr instanceof Error ? fsErr.message : String(fsErr) }
  }
}
```

同时更新 `QueryRequestPayload` 的 `query_type` 联合类型，加入 `'fs_request'`：
```typescript
interface QueryRequestPayload {
  request_id: string;
  query_type: 'search_tabs' | 'get_tab_content' | 'search_db_metadata' | 'fs_request';
  params: Record<string, unknown>;
}
```

- [ ] **Step 4: 运行全部 useMcpBridge 测试**

```bash
npx vitest run src/hooks/useMcpBridge.test.ts
```

期望：全部 PASS（含新增用例）

- [ ] **Step 5: Commit（仅提交前端变更）**

```bash
git add src/hooks/useMcpBridge.ts src/hooks/useMcpBridge.test.ts
git commit -m "feat(fs): route fs_request in useMcpBridge to FsRouter"
```

---

### Task 6: Rust 层新增 5 个 `fs_*` 工具

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

Phase 1 阶段，新旧工具并存。Rust 层将 `fs_*` 请求通过现有 `query_frontend()` 发出 `mcp://query-request`（`query_type = "fs_request"`），前端 `useMcpBridge` 的 `fs_request` 分支接收并路由到 `FsRouter`。

- [ ] **Step 1: 在 `tool_definitions()` 的 tools 数组末尾追加 5 个工具定义**

在 `graph_debug_links` 工具 json 对象的结尾 `)` 之后、整个 `json!({ "tools": [...] })` 闭合之前插入：

```rust
,
json!({
    "name": "fs_read",
    "description": "Read content from any tab, panel, or settings page. mode=text returns SQL with line numbers; mode=struct returns structured JSON.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "resource": { "type": "string", "description": "tab.query | tab.table | tab.metric | panel.db-tree | panel.tasks | settings.llm | settings.conn" },
            "target":   { "type": "string", "description": "active | list | tab_id | table_name | metric_id" },
            "mode":     { "type": "string", "enum": ["text", "struct"] }
        },
        "required": ["resource", "target", "mode"]
    }
}),
json!({
    "name": "fs_write",
    "description": "Write or patch a tab or settings page. SQL editor writes show diff unless Auto mode is on.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "resource": { "type": "string" },
            "target":   { "type": "string" },
            "patch": {
                "type": "object",
                "description": "Text: {mode:'text',op:'replace|insert_after|replace_all',range?:[from,to],line?:N,content:'...',reason?:'...'}. Struct: {mode:'struct',path:'/field',value:...}"
            }
        },
        "required": ["resource", "target", "patch"]
    }
}),
json!({
    "name": "fs_search",
    "description": "Search across tabs or panels. Use resource_pattern='tab.*' for all tabs.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "resource_pattern": { "type": "string", "description": "tab.* | tab.query | panel.db-tree" },
            "filter": { "type": "object", "description": "{keyword?, type?, connection_id?}" }
        },
        "required": ["resource_pattern"]
    }
}),
json!({
    "name": "fs_open",
    "description": "Open a new tab or navigate to a page. Returns { target: tab_id }.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "resource": { "type": "string" },
            "params":   { "type": "object", "description": "tab.query: {connection_id,label?,database?}. tab.table: {table,database,connection_id}." }
        },
        "required": ["resource"]
    }
}),
json!({
    "name": "fs_exec",
    "description": "Execute an action on a resource target.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "resource": { "type": "string" },
            "target":   { "type": "string", "description": "active | tab_id" },
            "action":   { "type": "string", "description": "focus | run_sql | undo | confirm_write | refresh | create" },
            "params":   { "type": "object" }
        },
        "required": ["resource", "target", "action"]
    }
})
```

- [ ] **Step 2: 在 `call_tool()` 的 match 末尾（`_ =>` 之前）追加 fs_* 分支**

```rust
"fs_read" | "fs_write" | "fs_search" | "fs_open" | "fs_exec" => {
    // 构造转发给前端 FsRouter 的请求体
    let op = name.strip_prefix("fs_").unwrap_or(name);
    let resource = args
        .get("resource").or_else(|| args.get("resource_pattern"))
        .and_then(|v| v.as_str()).unwrap_or("").to_string();
    let target = args.get("target")
        .and_then(|v| v.as_str()).unwrap_or("active").to_string();
    let payload = match op {
        "search" => args.get("filter").cloned().unwrap_or(json!({})),
        "write"  => args.get("patch").cloned().unwrap_or(json!({})),
        "open"   => args.get("params").cloned().unwrap_or(json!({})),
        "exec"   => json!({
            "action": args.get("action").and_then(|v| v.as_str()).unwrap_or(""),
            "params": args.get("params").cloned().unwrap_or(json!({}))
        }),
        _        => json!({
            "mode": args.get("mode").and_then(|v| v.as_str()).unwrap_or("struct")
        }),
    };
    // 复用 query_frontend：发 mcp://query-request，query_type = "fs_request"
    // 前端 useMcpBridge 的 fs_request 分支接收并路由到 FsRouter
    let result = crate::mcp::tools::tab_control::query_frontend(
        &handle,
        "fs_request",
        json!({ "op": op, "resource": resource, "target": target, "payload": payload }),
    ).await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
```

- [ ] **Step 3: Rust 编译检查**

```bash
cd src-tauri && cargo check
```

期望：无编译错误

- [ ] **Step 4: 运行全量前端测试**

```bash
npx vitest run
```

期望：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(fs): register fs_* MCP tools in Rust with query_frontend forwarding"
```

---

## 最终验收

- [ ] **运行全量测试**

```bash
npx vitest run && cd src-tauri && cargo check
```

期望：全部 PASS，零编译错误

- [ ] **手动验证（可选，需应用运行中）**

通过 MCP 客户端发送：
```json
{ "name": "fs_read", "arguments": { "resource": "tab.query", "target": "active", "mode": "text" } }
```
期望：返回当前 SQL 编辑器内容，含 `lines` 数组。

```json
{ "name": "fs_search", "arguments": { "resource_pattern": "tab.*" } }
```
期望：返回所有已开 Tab 的 `FsSearchResult` 数组。

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "feat(fs): Phase 1 complete — FsRouter + QueryTabAdapter + Rust fs_* tools

All tab.query operations (read/write/search/open/exec) available via new DSL.
Old tools remain for Phase 2 parallel cutover."
```

---

## Phase 2 预告

Phase 2 将实现：
- `TableTabAdapter`（`tab.table`）：`get_column_meta` → `fs_read struct`，`update_column_comment` → `fs_write struct` via invoke，auto_mode 检查移至 Adapter
- `MetricTabAdapter`（`tab.metric`）：list/get/create/update 指标，`search_metrics` → `fs_search`
- Rust 层删除旧工具（tab_control 相关），只保留 5 个 `fs_*` + db_read + graph_*

计划文档将保存在：`docs/superpowers/plans/2026-03-26-unified-fs-abstraction-phase2.md`
