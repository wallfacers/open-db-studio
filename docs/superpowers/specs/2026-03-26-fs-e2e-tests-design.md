# FS Abstraction Layer — E2E Test Design

**Date:** 2026-03-26
**Scope:** Unified FS Abstraction Phase 1 端到端测试
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
| `@tauri-apps/api/core` (invoke) | Mock（mockResolvedValue） | `mcp_query_respond` 等 Rust 命令无法真实调用 |
| `useMcpBridge` | **真实**（renderHook） | E2E 的起点 |
| `fsRouter` / `registerFsAdapters` | **真实**（不 mock） | A 层核心验证对象 |
| `QueryTabAdapter` | **真实** | E2E 穿透目标 |
| `useQueryStore` / `useAppStore` | **真实**（setState 预置） | 验证 store 变化是 E2E 的核心目标 |

---

## 辅助函数

```typescript
// 注册 listen listener
function mountBridge(): void

// 触发 mcp://query-request 事件（query_type = 'fs_request'）
async function emitFsRequest(
  op: string,
  resource: string,
  target: string,
  payload: Record<string, unknown>,
  request_id?: string,
): Promise<void>

// 从 mockInvoke 调用记录中取最后一次 mcp_query_respond 的 data
function lastRespondData(): unknown
```

---

## A 层：Integration 测试

文件位置：`e2e.test.ts` 内 `describe('A: Integration — event → FsRouter → Adapter → store')`

### A-1: fs_read 返回 SQL 内容

```
前置: activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT 1'
动作: emitFsRequest('read', 'tab.query', 'active', { mode: 'text' }, 'a-1')
断言:
  - mockInvoke('mcp_query_respond') 收到 requestId='a-1'
  - data.content === 'SELECT 1'
  - data.lines === [{ no: 1, text: 'SELECT 1' }]
```

### A-2: fs_write 非 Auto 模式 → 触发 pendingDiff

```
前置: autoMode = false, activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT *'
动作: emitFsRequest('write', 'tab.query', 'active',
        { mode:'text', op:'replace_all', content:'SELECT 1', reason:'优化' }, 'a-2')
断言:
  - useQueryStore.getState().pendingDiff.modified === 'SELECT 1'
  - useQueryStore.getState().pendingDiff.reason === '优化'
  - mcp_query_respond data.status === 'pending_confirm'
```

### A-3: fs_write Auto 模式 → 直接写入 store

```
前置: autoMode = true, activeTabId = 'tab-q1', sqlContent['tab-q1'] = 'SELECT *'
动作: emitFsRequest('write', 'tab.query', 'active',
        { mode:'text', op:'replace_all', content:'SELECT 1' }, 'a-3')
断言:
  - useQueryStore.getState().sqlContent['tab-q1'] === 'SELECT 1'
  - mcp_query_respond data.status === 'applied'
```

---

## C 层：Scenario 测试

文件位置：`e2e.test.ts` 内 `describe('C: Scenario — 完整 AI 工作流')`

### Scenario 1：AI 非 Auto 修改 SQL → 用户确认 → SQL 最终更新

模拟完整的"AI 提案 + 用户确认"流程。

```
前置:
  autoMode = false
  activeTabId = 'tab-q1'
  sqlContent['tab-q1'] = 'SELECT * FROM users'

步骤 1 — AI 发起写操作:
  emitFsRequest('write', 'tab.query', 'active',
    { mode:'text', op:'replace_all', content:'SELECT id FROM users', reason:'只取 id' })
  断言: pendingDiff.modified === 'SELECT id FROM users'
        pendingDiff.original === 'SELECT * FROM users'
        sqlContent['tab-q1'] 仍为 'SELECT * FROM users'（未直接写入）

步骤 2 — 用户点击"确认":
  useQueryStore.getState().applyDiff()
  断言: sqlContent['tab-q1'] === 'SELECT id FROM users'
        pendingDiff === null
```

### Scenario 2：AI Auto 模式直接覆写 SQL

模拟 Auto 模式下无需确认的写入。

```
前置:
  autoMode = true
  activeTabId = 'tab-q1'
  sqlContent['tab-q1'] = 'SELECT * FROM users'

动作:
  emitFsRequest('write', 'tab.query', 'active',
    { mode:'text', op:'replace_all', content:'SELECT id FROM users WHERE active=1' })

断言:
  - sqlContent['tab-q1'] === 'SELECT id FROM users WHERE active=1'
  - pendingDiff === null（未产生 diff 提案）
  - mcp_query_respond data.status === 'applied'
```

### Scenario 3：AI 搜索 tab → 打开新 tab → 返回 tab_id

模拟 AI 先搜索确认目标，再打开新查询 tab。

```
前置:
  tabs = [{ id:'tab-q1', type:'query', title:'conn1/mydb', connectionId:1, db:'mydb' }]
  activeTabId = 'tab-q1'

步骤 1 — AI 搜索 tab:
  emitFsRequest('search', 'tab.query', '', { keyword:'mydb' })
  断言: mcp_query_respond data 是数组，包含 { target:'tab-q1', resource:'tab.query' }

步骤 2 — AI 打开新 tab:
  emitFsRequest('open', 'tab.query', '', { connection_id:1, label:'conn1', database:'mydb' })
  断言:
    - mcp_query_respond data.target 为字符串，且不等于 'tab-q1'
    - useQueryStore.getState().tabs.length === 2
    - 新 tab 的 type === 'query'
```

---

## 测试文件骨架

```typescript
// src/mcp/fs/e2e.test.ts

vi.mock('@tauri-apps/api/event', ...)   // 捕获 listen / mock emit
vi.mock('@tauri-apps/api/core', ...)    // mock invoke

// 共享辅助函数
function mountBridge() { ... }
async function emitFsRequest(...) { ... }
function lastRespondData() { ... }

beforeEach(() => {
  vi.clearAllMocks()
  // 重置 useQueryStore / useAppStore
})

describe('A: Integration — event → FsRouter → Adapter → store', () => {
  it('A-1: fs_read 返回 SQL 内容', ...)
  it('A-2: fs_write 非 Auto → pendingDiff', ...)
  it('A-3: fs_write Auto → 直接写入', ...)
})

describe('C: Scenario — 完整 AI 工作流', () => {
  it('场景1：非 Auto 改 SQL → 确认 → 更新', ...)
  it('场景2：Auto 模式直接覆写', ...)
  it('场景3：搜索 tab → 打开新 tab', ...)
})
```

---

## 成功标准

- `npx vitest run src/mcp/fs/e2e.test.ts` — 6 个用例全部 PASS
- 所有用例不 mock `fsRouter`、`QueryTabAdapter`、store（除 setState 预置外）
- `npx vitest run` 全量测试仍然全部 PASS（不破坏现有测试）
- `npx tsc --noEmit` 无新增类型错误
