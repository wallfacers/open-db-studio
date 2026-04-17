# Migration Job Adapter 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 聊天助手能通过 UI Object Protocol 对话式地创建和编辑 MigrateQL 迁移任务脚本。

**Architecture:** 新建 `MigrationJobAdapter`（参照 `QueryEditorAdapter` 模式），将迁移任务的读写/执行操作暴露给 MCP；扩展 `WorkspaceAdapter` 支持 `migration_job` tab 类型；更新 `chat_assistant.txt` 添加 MigrateQL 语法知识和对话式工作流。

**Tech Stack:** React + TypeScript + Zustand + Vitest

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/mcp/ui/adapters/MigrationJobAdapter.ts` | 新建 | 迁移任务 UI 适配器（read/patch/exec） |
| `src/mcp/ui/__tests__/MigrationJobAdapter.test.ts` | 新建 | 适配器单元测试 |
| `src/mcp/ui/adapters/WorkspaceAdapter.ts` | 修改 | 添加 `migration_job` 到 open action |
| `src/mcp/ui/__tests__/WorkspaceAdapter.test.ts` | 修改 | 添加 `migration_job` open 测试 |
| `src/components/MigrationJobTab/index.tsx` | 修改 | 注册 `MigrationJobAdapter` 到 UIRouter |
| `prompts/chat_assistant.txt` | 修改 | 添加 Migration Job Workflow + MigrateQL 语法 |

---

### Task 1: MigrationJobAdapter — 测试

**Files:**
- Create: `src/mcp/ui/__tests__/MigrationJobAdapter.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/mcp/ui/__tests__/MigrationJobAdapter.test.ts`
Expected: FAIL — `Cannot find module '../adapters/MigrationJobAdapter'`

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/__tests__/MigrationJobAdapter.test.ts
git commit -m "test(mcp): add MigrationJobAdapter unit tests"
```

---

### Task 2: MigrationJobAdapter — 实现

**Files:**
- Create: `src/mcp/ui/adapters/MigrationJobAdapter.ts`

- [ ] **Step 1: 实现适配器**

```typescript
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { applyPatch } from '../jsonPatch'
import { execError } from '../errors'
import { useMigrationStore } from '../../../store/migrationStore'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useHighlightStore } from '../../../store/highlightStore'
import { invoke } from '@tauri-apps/api/core'

const MIGRATION_JOB_PATCH_CAPABILITIES: PatchCapability[] = [
  { pathPattern: '/scriptText', ops: ['replace'], description: 'Replace MigrateQL script content' },
]

export class MigrationJobAdapter implements UIObject {
  type = 'migration_job'
  objectId: string
  title: string
  private jobId: number

  /** Injected by MigrationJobTab — reads current editor content */
  getScriptText: () => string = () => ''
  /** Injected by MigrationJobTab — writes to editor state */
  setScriptText: (value: string) => void = () => {}
  /** Injected by MigrationJobTab — triggers save to backend */
  triggerSave: () => Promise<void> = async () => {}

  constructor(tabId: string, jobId: number, title: string) {
    this.objectId = tabId
    this.jobId = jobId
    this.title = title
  }

  get patchCapabilities(): PatchCapability[] {
    return MIGRATION_JOB_PATCH_CAPABILITIES
  }

  read(mode: 'state' | 'schema' | 'actions' | 'full') {
    switch (mode) {
      case 'state': {
        const store = useMigrationStore.getState()
        const node = store.nodes.get(`job_${this.jobId}`)
        const status = node?.nodeType === 'job' ? node.status : null
        return {
          scriptText: this.getScriptText(),
          jobId: this.jobId,
          name: this.title,
          status,
        }
      }
      case 'schema':
        return {
          type: 'object',
          properties: {
            scriptText: { type: 'string', description: 'MigrateQL script content' },
            jobId: { type: 'number', description: 'Migration job ID (read-only)' },
            name: { type: 'string', description: 'Job name (read-only)' },
            status: { type: 'string', description: 'Last run status (read-only)', enum: ['RUNNING', 'FINISHED', 'FAILED', 'STOPPED', 'PARTIAL_FAILED'] },
          },
          patchCapabilities: MIGRATION_JOB_PATCH_CAPABILITIES,
        }
      case 'actions':
        return [
          { name: 'run', description: 'Save and execute the migration job', paramsSchema: { type: 'object', properties: {} } },
          { name: 'stop', description: 'Stop a running migration job', paramsSchema: { type: 'object', properties: {} } },
          { name: 'format', description: 'Format MigrateQL script via LSP', paramsSchema: { type: 'object', properties: {} } },
          { name: 'save', description: 'Save script to database', paramsSchema: { type: 'object', properties: {} } },
          { name: 'focus', description: 'Switch to this tab', paramsSchema: { type: 'object', properties: {} } },
        ]
      case 'full':
        return {
          state: this.read('state'),
          schema: this.read('schema'),
          actions: this.read('actions'),
        }
    }
  }

  patch(ops: JsonPatchOp[], reason?: string): PatchResult {
    const autoMode = useAppStore.getState().autoMode
    if (autoMode) {
      return this.patchDirect(ops)
    }

    const confirmId = `patch_${this.objectId}_${Date.now()}`
    usePatchConfirmStore.getState().propose({
      confirmId,
      objectId: this.objectId,
      objectType: this.type,
      ops,
      reason,
      currentState: this.read('state'),
      createdAt: Date.now(),
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const currentState = { scriptText: this.getScriptText() }
    try {
      const patched = applyPatch(currentState, ops)
      if (patched.scriptText !== currentState.scriptText) {
        this.setScriptText(patched.scriptText)
        useHighlightStore.getState().addHighlights(this.objectId, ['scriptText'])
      }
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    switch (action) {
      case 'run': {
        await this.triggerSave()
        await useMigrationStore.getState().runJob(this.jobId)
        return { success: true }
      }

      case 'stop':
        await invoke('stop_migration_job', { jobId: this.jobId })
        return { success: true }

      case 'format': {
        const result = await invoke<string | null>('lsp_request', {
          method: 'textDocument/formatting',
          params: { text: this.getScriptText() },
        })
        if (result) {
          this.setScriptText(result)
          await invoke('update_migration_job_script', { id: this.jobId, scriptText: result })
        }
        return { success: true }
      }

      case 'save':
        await this.triggerSave()
        return { success: true }

      case 'focus':
        useQueryStore.getState().setActiveTabId(this.objectId)
        return { success: true }

      default:
        return execError(`Unknown action: ${action}`, 'Available actions: run, stop, format, save, focus')
    }
  }
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run src/mcp/ui/__tests__/MigrationJobAdapter.test.ts`
Expected: ALL PASS

- [ ] **Step 3: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/adapters/MigrationJobAdapter.ts
git commit -m "feat(mcp): add MigrationJobAdapter for migration job UI protocol"
```

---

### Task 3: WorkspaceAdapter — 添加 migration_job 支持

**Files:**
- Modify: `src/mcp/ui/adapters/WorkspaceAdapter.ts:17` (enum), `src/mcp/ui/adapters/WorkspaceAdapter.ts:47-74` (switch-case)
- Modify: `src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`

- [ ] **Step 1: 编写测试**

在 `src/mcp/ui/__tests__/WorkspaceAdapter.test.ts` 的 mock 中添加 `openMigrationJobTab`，并新增测试用例：

```typescript
// 添加到 mock 的 getState 返回值中:
openMigrationJobTab: vi.fn(),

// 添加测试用例:
it('exec open migration_job calls openMigrationJobTab', async () => {
  const ws = new WorkspaceAdapter()
  const result = await ws.exec('open', { type: 'migration_job', job_id: 42, title: 'My Job' })
  expect(result.success).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认新用例失败**

Run: `npx vitest run src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`
Expected: 新测试 FAIL（`Unknown tab type: migration_job`）

- [ ] **Step 3: 修改 WorkspaceAdapter**

在 `src/mcp/ui/adapters/WorkspaceAdapter.ts` 中：

1. 将 `type` enum 行的值加上 `'migration_job'`：
```typescript
type: { type: 'string', enum: ['query_editor', 'table_form', 'metric_form', 'metric_list', 'new_metric', 'er_canvas', 'seatunnel_job', 'migration_job'] },
```

2. 在 `exec` 方法的 switch-case 中，在 `case 'er_canvas':` 之后添加：
```typescript
case 'migration_job': {
  if (!job_id) return { success: false, error: 'job_id is required for migration_job' }
  const jobTitle = params?.title ?? `Migration #${job_id}`
  store.openMigrationJobTab(job_id, jobTitle)
  break
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `npx vitest run src/mcp/ui/__tests__/WorkspaceAdapter.test.ts`
Expected: ALL PASS

- [ ] **Step 5: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/mcp/ui/adapters/WorkspaceAdapter.ts src/mcp/ui/__tests__/WorkspaceAdapter.test.ts
git commit -m "feat(mcp): add migration_job support to WorkspaceAdapter"
```

---

### Task 4: MigrationJobTab — 注册适配器

**Files:**
- Modify: `src/components/MigrationJobTab/index.tsx`

- [ ] **Step 1: 在 MigrationJobTab 中注册 MigrationJobAdapter**

在 `src/components/MigrationJobTab/index.tsx` 中：

1. 添加导入：
```typescript
import { useMemo } from 'react'
import { useUIObjectRegistry } from '../../mcp/ui'
import { MigrationJobAdapter } from '../../mcp/ui/adapters/MigrationJobAdapter'
```

注意：`useMemo` 需要加到已有的 `import { useState, useEffect, useCallback, useRef } from 'react'` 行中。

2. 在 `MigrationJobTab` 组件内，`useEffect` 块之前，添加适配器注册逻辑。需要从外层获取 `tabId`。当前组件接收 `jobId` 作为 prop，但不接收 `tabId`。需要在组件内部通过 queryStore 查找对应的 tabId：

```typescript
// 查找此 job 对应的 tabId
const tabId = useQueryStore(s => s.tabs.find(t => t.type === 'migration_job' && t.migrationJobId === jobId)?.id) ?? ''
const jobLabel = jobNode?.nodeType === 'job' ? jobNode.label : `Migration #${jobId}`

const adapter = useMemo(() => {
  if (!tabId) return null
  return new MigrationJobAdapter(tabId, jobId, jobLabel)
}, [tabId, jobId, jobLabel])

// 注入 script 读写回调
useEffect(() => {
  if (!adapter) return
  adapter.getScriptText = () => scriptTextRef.current
  adapter.setScriptText = (value: string) => setScriptText(value)
  adapter.triggerSave = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    await invoke('update_migration_job_script', { id: jobId, scriptText: scriptTextRef.current })
  }
}, [adapter, jobId])

useUIObjectRegistry(adapter)
```

需要添加 `useQueryStore` 的导入：
```typescript
import { useQueryStore } from '../../store/queryStore'
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/components/MigrationJobTab/index.tsx
git commit -m "feat(mcp): register MigrationJobAdapter in MigrationJobTab"
```

---

### Task 5: 更新 chat_assistant.txt — 添加 Migration Job Workflow

**Files:**
- Modify: `prompts/chat_assistant.txt`

- [ ] **Step 1: 在 `chat_assistant.txt` 中添加以下内容**

在 `## SeaTunnel Job Workflow` 章节之后（约第 238 行后），插入新的 Migration Job Workflow 章节：

```text
---

## Migration Job Workflow (MigrateQL)

Migration jobs use MigrateQL — a declarative DSL for data migration between databases.

1. Create a job: `ui_exec(object="workspace", action="open", params={type:"migration_job", job_id:<id>, title:"<name>"})`
   - To create a new job first, use `create_migration_job(name, category_id?)` (returns job with `id`)
2. Read current script: `ui_read(object="migration_job", mode="state")` → `{ scriptText, jobId, name, status }`
3. Write script: `ui_patch(object="migration_job", ops=[{op:"replace", path:"/scriptText", value:"<MigrateQL script>"}])`
4. Format: `ui_exec(object="migration_job", action="format")`
5. Run: `ui_exec(object="migration_job", action="run")` — saves and executes
6. Stop: `ui_exec(object="migration_job", action="stop")`

### MigrateQL Syntax Reference

```
-- Connection aliases (optional, for cross-database migration)
USE src = CONNECTION('source_mysql');
USE dst = CONNECTION('target_pg');

-- Global settings
SET parallelism=4, read_batch=5000, write_batch=2000, error_limit=100;

-- Migration statement
MIGRATE FROM src.mydb.users INTO dst.appdb.user_accounts
  MAPPING (
    id         -> id,
    user_name  -> username :: VARCHAR(100),
    created_at -> create_time
  )
  WHERE status = 'active'
  ON CONFLICT UPSERT BY (id)
  INCREMENTAL ON updated_at
  CREATE IF NOT EXISTS;

-- Auto-mapping (same column names)
MIGRATE FROM src.mydb.orders INTO dst.appdb.orders
  MAPPING (*)
  ON CONFLICT REPLACE;
```

**Key syntax elements:**
- `MIGRATE FROM <conn.db.table> INTO <conn.db.table>` — source and target
- `MAPPING (src_col -> dst_col :: TYPE, ...)` — column mapping with optional type cast
- `MAPPING (*)` — auto-map all same-name columns
- `WHERE <condition>` — filter source rows
- `ON CONFLICT UPSERT|REPLACE|SKIP|INSERT|OVERWRITE BY (col, ...)` — conflict resolution
- `INCREMENTAL ON <column>` — incremental sync by column
- `CREATE IF NOT EXISTS` — auto-create target table
- `USE <alias> = CONNECTION('<name>')` — bind connection alias
- `SET key=value, ...` — global pipeline settings (parallelism, batch sizes, error_limit)

### Conversational Creation Workflow

When a user asks to create a migration task conversationally:

1. **Gather requirements** — ask about source/target databases, tables, column mappings, conflict strategy
2. **Discover connections** — call `list_connections()` to find available connections
3. **Discover schemas** — call `get_table_schema(connection_id, table)` for source and target tables
4. **Generate MigrateQL** — compose the script based on gathered information
5. **Write to editor** — use `ui_patch(object="migration_job", ops=[{op:"replace", path:"/scriptText", value:"..."}])` to populate the editor
6. **Let user review** — explain the generated script and ask if modifications are needed
```

同时更新 WorkspaceAdapter 文档部分。找到 `ui_exec(object="workspace", action="open", ...)` 的示例列表（约第 62-67 行），在 `seatunnel_job` 行后添加：

```text
- `ui_exec(object="workspace", action="open", params={type:"migration_job", job_id:1, title:"My Migration"})` — Open migration job editor
```

- [ ] **Step 2: Commit**

```bash
git add prompts/chat_assistant.txt
git commit -m "docs(prompt): add Migration Job Workflow and MigrateQL syntax to chat_assistant"
```

---

### Task 6: 全量验证

- [ ] **Step 1: 运行所有适配器测试**

Run: `npx vitest run src/mcp/ui/__tests__/`
Expected: ALL PASS

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过（本次不修改 Rust 代码，确认无回归）
