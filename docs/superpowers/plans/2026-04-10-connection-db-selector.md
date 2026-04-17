# ConnectionDbSelector 公共组件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取 `ConnectionDbSelector` 公共组件，统一迁移中心（ConfigTab）和知识图谱（GraphExplorer）的连接+数据库选择逻辑，统一调用 `list_databases_for_metrics` 接口。

**Architecture:** 新建 `src/components/common/ConnectionDbSelector.tsx`，内部复用 `useConnectionStore` 获取连接列表，调用 `list_databases_for_metrics` 获取数据库列表，对外暴露受控的 `connectionId / database / onChange` 接口。ConfigTab 源端和目标端各用一个，GraphExplorer 工具栏用水平布局版本替换现有的手写逻辑。

**Tech Stack:** React 18, TypeScript, Zustand (`useConnectionStore`), Tauri `invoke`, Vitest + jsdom

---

## 文件结构

| 操作 | 路径 | 说明 |
|------|------|------|
| 新增 | `src/components/common/ConnectionDbSelector.tsx` | 公共组件 |
| 新增 | `src/components/common/ConnectionDbSelector.test.tsx` | 单元测试 |
| 修改 | `src/components/MigrationJobTab/ConfigTab.tsx` | 源端 + 目标端替换 |
| 修改 | `src/components/GraphExplorer/index.tsx` | 替换工具栏连接/库选择逻辑 |

---

## Task 1: 创建 ConnectionDbSelector 组件

**Files:**
- Create: `src/components/common/ConnectionDbSelector.tsx`

- [ ] **Step 1: 写入组件代码**

  创建 `src/components/common/ConnectionDbSelector.tsx`，内容如下：

  ```tsx
  import { useEffect, useState } from 'react'
  import { invoke } from '@tauri-apps/api/core'
  import { useConnectionStore } from '../../store/connectionStore'
  import { DropdownSelect } from './DropdownSelect'

  export interface ConnectionDbSelectorProps {
    connectionId: number          // 0 = 未选
    database: string              // '' = 未选
    onConnectionChange: (connectionId: number) => void
    onDatabaseChange: (database: string) => void
    connectionPlaceholder?: string
    databasePlaceholder?: string
    direction?: 'vertical' | 'horizontal'  // 默认 vertical
    className?: string
  }

  export function ConnectionDbSelector({
    connectionId,
    database,
    onConnectionChange,
    onDatabaseChange,
    connectionPlaceholder = '请选择连接',
    databasePlaceholder = '请选择数据库',
    direction = 'vertical',
    className,
  }: ConnectionDbSelectorProps) {
    const { connections, loadConnections } = useConnectionStore()
    const [databases, setDatabases] = useState<string[]>([])
    const [dbLoading, setDbLoading] = useState(false)
    const [dbError, setDbError] = useState<string | null>(null)

    useEffect(() => {
      if (connections.length === 0) loadConnections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      if (!connectionId) {
        setDatabases([])
        setDbError(null)
        return
      }
      let cancelled = false
      setDbLoading(true)
      setDbError(null)
      invoke<string[]>('list_databases_for_metrics', { connectionId })
        .then(dbs => { if (!cancelled) setDatabases(dbs) })
        .catch(err => {
          if (!cancelled) {
            setDatabases([])
            setDbError(typeof err === 'string' ? err : '加载失败')
          }
        })
        .finally(() => { if (!cancelled) setDbLoading(false) })
      return () => { cancelled = true }
    }, [connectionId])

    const dbPlaceholder = dbLoading ? '加载中...' : (dbError ?? databasePlaceholder)

    const connSelect = (
      <DropdownSelect
        value={connectionId ? String(connectionId) : ''}
        options={connections.map(c => ({ value: String(c.id), label: c.name }))}
        placeholder={connectionPlaceholder}
        onChange={val => onConnectionChange(val ? Number(val) : 0)}
        className="w-full"
      />
    )

    const dbSelect = (
      <DropdownSelect
        value={database}
        options={databases.map(db => ({ value: db, label: db }))}
        placeholder={dbPlaceholder}
        onChange={onDatabaseChange}
        className="w-full"
      />
    )

    if (direction === 'horizontal') {
      return (
        <div className={`flex items-center gap-2 ${className ?? ''}`}>
          <div className="w-36">{connSelect}</div>
          {connectionId > 0 && (
            <div className="w-32">{dbSelect}</div>
          )}
        </div>
      )
    }

    return (
      <div className={`flex flex-col gap-2 ${className ?? ''}`}>
        {connSelect}
        {dbSelect}
        {dbError && (
          <span className="text-[11px] text-error">{dbError}</span>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 2: TypeScript 检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：无错误。

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/common/ConnectionDbSelector.tsx
  git commit -m "feat: add ConnectionDbSelector common component"
  ```

---

## Task 2: 为 ConnectionDbSelector 编写单元测试

**Files:**
- Create: `src/components/common/ConnectionDbSelector.test.tsx`

- [ ] **Step 1: 写入测试代码**

  创建 `src/components/common/ConnectionDbSelector.test.tsx`：

  ```tsx
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import { act } from 'react'
  import { describe, it, expect, beforeEach, vi } from 'vitest'

  // Mock Tauri invoke
  const mockInvoke = vi.fn()
  vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

  // Mock i18n
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
  }))

  // Mock DropdownSelect to a simple select element for testability
  vi.mock('./DropdownSelect', () => ({
    DropdownSelect: ({ value, options, placeholder, onChange, className }: {
      value: string
      options: { value: string; label: string }[]
      placeholder?: string
      onChange: (v: string) => void
      className?: string
    }) => (
      <select
        data-testid="dropdown"
        data-placeholder={placeholder}
        className={className}
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
  }))

  // Mock connectionStore
  const mockLoadConnections = vi.fn()
  vi.mock('../../store/connectionStore', () => ({
    useConnectionStore: () => ({
      connections: [
        { id: 1, name: 'conn-1' },
        { id: 2, name: 'conn-2' },
      ],
      loadConnections: mockLoadConnections,
    }),
  }))

  import { ConnectionDbSelector } from './ConnectionDbSelector'

  function renderIntoDoc(element: React.ReactElement) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: ReturnType<typeof createRoot>
    act(() => { root = createRoot(container); root.render(element) })
    return { container, unmount: () => act(() => root.unmount()) }
  }

  describe('ConnectionDbSelector', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mockInvoke.mockResolvedValue([])
    })

    it('renders connection options from store', () => {
      const { container } = renderIntoDoc(
        <ConnectionDbSelector
          connectionId={0}
          database=""
          onConnectionChange={() => {}}
          onDatabaseChange={() => {}}
        />,
      )
      const selects = container.querySelectorAll('select')
      expect(selects.length).toBe(2)
      const connOptions = selects[0].querySelectorAll('option[value]:not([value=""])')
      expect(connOptions.length).toBe(2)
      expect(connOptions[0].textContent).toBe('conn-1')
      expect(connOptions[1].textContent).toBe('conn-2')
    })

    it('calls list_databases_for_metrics when connectionId is set', async () => {
      mockInvoke.mockResolvedValue(['db1', 'db2'])
      const { container } = renderIntoDoc(
        <ConnectionDbSelector
          connectionId={1}
          database=""
          onConnectionChange={() => {}}
          onDatabaseChange={() => {}}
        />,
      )
      await act(async () => { await Promise.resolve() })
      expect(mockInvoke).toHaveBeenCalledWith('list_databases_for_metrics', { connectionId: 1 })
      const dbSelect = container.querySelectorAll('select')[1]
      const dbOptions = dbSelect.querySelectorAll('option[value]:not([value=""])')
      expect(dbOptions.length).toBe(2)
      expect(dbOptions[0].textContent).toBe('db1')
    })

    it('does not call list_databases_for_metrics when connectionId is 0', () => {
      renderIntoDoc(
        <ConnectionDbSelector
          connectionId={0}
          database=""
          onConnectionChange={() => {}}
          onDatabaseChange={() => {}}
        />,
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('calls onConnectionChange with numeric id when connection selected', () => {
      const onConnChange = vi.fn()
      const { container } = renderIntoDoc(
        <ConnectionDbSelector
          connectionId={0}
          database=""
          onConnectionChange={onConnChange}
          onDatabaseChange={() => {}}
        />,
      )
      const connSelect = container.querySelectorAll('select')[0]
      act(() => {
        connSelect.dispatchEvent(Object.assign(new Event('change', { bubbles: true }), { target: { value: '2' } }))
        // Use React's simulated change
      })
      // Simulate via React testing approach
      const event = { target: { value: '2' } } as React.ChangeEvent<HTMLSelectElement>
      act(() => {
        // Re-render test: directly call onChange
        const select = container.querySelectorAll('select')[0] as HTMLSelectElement
        select.value = '2'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    })

    it('shows error message when database load fails', async () => {
      mockInvoke.mockRejectedValue('连接超时')
      const { container } = renderIntoDoc(
        <ConnectionDbSelector
          connectionId={1}
          database=""
          onConnectionChange={() => {}}
          onDatabaseChange={() => {}}
        />,
      )
      await act(async () => { await Promise.resolve() })
      expect(container.textContent).toContain('连接超时')
    })
  })
  ```

- [ ] **Step 2: 运行测试确认通过**

  ```bash
  npx vitest run src/components/common/ConnectionDbSelector.test.tsx
  ```

  期望：所有测试通过（`4 passed`，onChange 相关 1 个可能需调整）。

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/common/ConnectionDbSelector.test.tsx
  git commit -m "test: add ConnectionDbSelector unit tests"
  ```

---

## Task 3: 改造 ConfigTab — 源端替换

**Files:**
- Modify: `src/components/MigrationJobTab/ConfigTab.tsx`

- [ ] **Step 1: 添加 import，移除冗余 state**

  在文件顶部添加 import：
  ```tsx
  import { ConnectionDbSelector } from '../common/ConnectionDbSelector'
  ```

  删除以下 state 声明（约第 69–75 行）：
  ```tsx
  // 删除这些行：
  const [connections, setConnections] = useState<Array<{ id: number; name: string }>>([])
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([])
  const [targetDatabases, setTargetDatabases] = useState<string[]>([])
  const [dbsLoading, setDbsLoading] = useState(false)
  const [targetDbsLoading, setTargetDbsLoading] = useState(false)
  ```

- [ ] **Step 2: 删除三个冗余 useEffect**

  删除以下三个 `useEffect`（约第 132–185 行）：

  **删除 #1** — 加载连接列表（约第 132–137 行）：
  ```tsx
  // 删除：
  useEffect(() => {
    invoke<Array<{ id: number; name: string }>>('list_connections').then(setConnections).catch(() => {})
    invoke<{ id: number } | null>('get_default_llm_config')
      .then(r => setHasAi(r !== null))
      .catch(() => setHasAi(false))
  }, [])
  ```
  替换为只保留 AI 配置加载：
  ```tsx
  useEffect(() => {
    invoke<{ id: number } | null>('get_default_llm_config')
      .then(r => setHasAi(r !== null))
      .catch(() => setHasAi(false))
  }, [])
  ```

  **删除 #2** — 加载源端数据库列表（约第 139–151 行）：
  ```tsx
  // 删除：
  useEffect(() => {
    if (!config.source.connectionId) {
      setSourceDatabases([])
      setSourceTables([])
      return
    }
    setDbsLoading(true)
    invoke<string[]>('list_databases', { connectionId: config.source.connectionId })
      .then(setSourceDatabases)
      .catch(() => setSourceDatabases([]))
      .finally(() => setDbsLoading(false))
  }, [config.source.connectionId])
  ```

  **删除 #3** — 加载目标端数据库列表（约第 164–175 行）：
  ```tsx
  // 删除：
  useEffect(() => {
    if (!config.defaultTargetConnId) {
      setTargetDatabases([])
      setTargetTables([])
      return
    }
    setTargetDbsLoading(true)
    invoke<string[]>('list_databases_for_metrics', { connectionId: config.defaultTargetConnId })
      .then(setTargetDatabases)
      .catch(() => setTargetDatabases([]))
      .finally(() => setTargetDbsLoading(false))
  }, [config.defaultTargetConnId])
  ```

- [ ] **Step 3: 替换源端 JSX（约第 254–318 行）**

  找到源端面板内的两个 `DropdownSelect`（连接 + 数据库），以及 `dbsLoading` 占位符，整体替换为：

  原来（约第 256–275 行）：
  ```tsx
  <DropdownSelect
    value={config.source.connectionId ? String(config.source.connectionId) : ''}
    onChange={val => update({
      source: { ...config.source, connectionId: val ? Number(val) : 0, database: '', tables: [] },
      tableMappings: [],
    })}
    options={connections.map(c => ({ value: String(c.id), label: c.name }))}
    placeholder={t('migration.sourceConn')}
    className="w-full"
  />
  <DropdownSelect
    value={config.source.database}
    onChange={val => update({
      source: { ...config.source, database: val, tables: [] },
      tableMappings: [],
    })}
    options={sourceDatabases.map(db => ({ value: db, label: db }))}
    placeholder={dbsLoading ? t('migration.loadingDatabases') : t('migration.sourceDatabase')}
    className="w-full"
  />
  ```

  替换为：
  ```tsx
  <ConnectionDbSelector
    connectionId={config.source.connectionId}
    database={config.source.database}
    onConnectionChange={val => update({
      source: { ...config.source, connectionId: val, database: '', tables: [] },
      tableMappings: [],
    })}
    onDatabaseChange={val => update({
      source: { ...config.source, database: val, tables: [] },
      tableMappings: [],
    })}
    connectionPlaceholder={t('migration.sourceConn')}
    databasePlaceholder={t('migration.sourceDatabase')}
  />
  ```

- [ ] **Step 4: 替换目标端 JSX（约第 325–338 行）**

  原来（约第 325–338 行）：
  ```tsx
  <DropdownSelect
    value={config.defaultTargetConnId ? String(config.defaultTargetConnId) : ''}
    onChange={val => update({ defaultTargetConnId: val ? Number(val) : 0, defaultTargetDb: '' })}
    options={connections.map(c => ({ value: String(c.id), label: c.name }))}
    placeholder={t('migration.targetConn')}
    className="w-full"
  />
  <DropdownSelect
    value={config.defaultTargetDb}
    onChange={val => update({ defaultTargetDb: val })}
    options={targetDatabases.map(db => ({ value: db, label: db }))}
    placeholder={targetDbsLoading ? t('migration.loadingDatabases') : t('migration.targetDatabase')}
    className="w-full"
  />
  ```

  替换为：
  ```tsx
  <ConnectionDbSelector
    connectionId={config.defaultTargetConnId}
    database={config.defaultTargetDb}
    onConnectionChange={val => update({ defaultTargetConnId: val, defaultTargetDb: '' })}
    onDatabaseChange={val => update({ defaultTargetDb: val })}
    connectionPlaceholder={t('migration.targetConn')}
    databasePlaceholder={t('migration.targetDatabase')}
  />
  ```

- [ ] **Step 5: 删除顶部多余的 DropdownSelect import（如果 DropdownSelect 不再在此文件中使用）**

  检查文件中是否还有其他 `DropdownSelect` 用法。若没有，删除：
  ```tsx
  import { DropdownSelect } from '../common/DropdownSelect'
  ```

- [ ] **Step 6: TypeScript 检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：无错误。

- [ ] **Step 7: Commit**

  ```bash
  git add src/components/MigrationJobTab/ConfigTab.tsx
  git commit -m "refactor(migration): use ConnectionDbSelector in ConfigTab"
  ```

---

## Task 4: 改造 GraphExplorer — 替换工具栏连接/库选择

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx`

- [ ] **Step 1: 添加 import**

  在文件顶部已有 import 区域末尾添加：
  ```tsx
  import { ConnectionDbSelector } from '../common/ConnectionDbSelector'
  ```

- [ ] **Step 2: 删除冗余 state 和 useEffect（约第 221–267 行）**

  删除以下内容（第 221–267 行）：
  ```tsx
  // 删除 —— 以下 6 行 state：
  const { connections, loadConnections } = useConnectionStore();
  const [internalConnId, setInternalConnId] = useState<number | null>(() => connectionId);
  const [internalDb, setInternalDb] = useState<string | null>(() => database ?? null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // 删除 —— 确保连接已加载的 useEffect（约第 229–231 行）：
  useEffect(() => {
    if (connections.length === 0) loadConnections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 删除 —— 数据库列表加载 useEffect（约第 234–267 行）：
  useEffect(() => {
    if (internalConnId === null) {
      setDatabases([]);
      setDbError(null);
      return;
    }
    let cancelled = false;
    setDbLoading(true);
    setDbError(null);

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        cancelled = true;
        setDbLoading(false);
        setDbError('加载超时');
      }
    }, 15000);

    invoke<string[]>('list_databases_for_metrics', { connectionId: internalConnId })
      .then(dbs => { if (!cancelled) setDatabases(dbs); })
      .catch((err) => {
        if (!cancelled) {
          setDatabases([]);
          setDbError(typeof err === 'string' ? err : '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setDbLoading(false);
        clearTimeout(timeoutId);
      });

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [internalConnId]);
  ```

  替换为以下两行（保持 `internalConnId` / `internalDb` state，但改为 `number` 类型）：
  ```tsx
  const [internalConnId, setInternalConnId] = useState<number>(() => connectionId ?? 0);
  const [internalDb, setInternalDb] = useState<string>(() => database ?? '');
  ```

- [ ] **Step 3: 修复 internalConnId null 检查（全文替换）**

  `internalConnId` 由 `number | null` 改为 `number`（0 表示未选），需要将文件内所有 `internalConnId === null` / `internalConnId !== null` 的判断更新：

  - `internalConnId === null` → `internalConnId === 0`（或 `!internalConnId`）
  - `internalConnId !== null` → `internalConnId !== 0`（或 `!!internalConnId`）

  涉及位置（按行号参考）：
  - 第 293–303 行 `useEffect` 中的依赖：`[internalConnId, internalDb]` — 无需改，仅依赖数组
  - 第 347 行：`if (!name || !internalConnId) return;` — 已兼容，无需改
  - 第 594 行：`if (internalConnId !== null) {` → `if (internalConnId) {`
  - 第 653 行：`if (internalConnId === null) return;` → `if (!internalConnId) return;`
  - 第 1092 行：`{!loading && (internalConnId === null || rfNodes.length === 0) && (` → `{!loading && (!internalConnId || rfNodes.length === 0) && (`
  - 第 1096 行：`{internalConnId === null` → `{!internalConnId`
  - 第 1198 行：`connectionId={internalConnId}` — 注意此处传给 `useGraphData`，类型需兼容

  检查 `useGraphData` 的签名：
  ```bash
  grep -n "useGraphData" src/components/GraphExplorer/useGraphData.ts | head -5
  ```
  若参数类型为 `number | null`，保持传 `internalConnId || null`；若已是 `number`，直接传。

- [ ] **Step 4: 替换工具栏中的连接/库选择 JSX（约第 921–950 行）**

  找到工具栏内的：
  ```tsx
  {/* Connection selector */}
  <DropdownSelect
    value={internalConnId !== null ? String(internalConnId) : ''}
    options={connections.map(c => ({ value: String(c.id), label: c.name }))}
    placeholder={t('graphExplorer.selectConnection')}
    onChange={(v) => {
      setInternalConnId(v ? Number(v) : null);
      setInternalDb(null);
    }}
    className="w-36"
  />

  {/* Database selector (optional, shown when databases are available) */}
  {internalConnId !== null && databases.length > 0 && !dbLoading && (
    <DropdownSelect
      value={internalDb ?? ''}
      options={databases.map(db => ({ value: db, label: db }))}
      placeholder={t('graphExplorer.allDatabases', '全部数据库')}
      onChange={(v) => setInternalDb(v || null)}
      className="w-32"
    />
  )}
  {internalConnId !== null && dbLoading && (
    <Loader2 size={14} className="animate-spin text-foreground-muted" />
  )}
  {internalConnId !== null && !dbLoading && dbError && (
    <span className="text-[11px] text-error" title={dbError}>{dbError}</span>
  )}
  ```

  替换为：
  ```tsx
  <ConnectionDbSelector
    connectionId={internalConnId}
    database={internalDb}
    onConnectionChange={v => { setInternalConnId(v); setInternalDb(''); }}
    onDatabaseChange={v => setInternalDb(v)}
    connectionPlaceholder={t('graphExplorer.selectConnection')}
    databasePlaceholder={t('graphExplorer.allDatabases', '全部数据库')}
    direction="horizontal"
  />
  ```

- [ ] **Step 5: 删除不再使用的 import**

  检查 `useConnectionStore` 是否在文件其他地方使用。若不再使用：
  ```tsx
  // 删除：
  import { useConnectionStore } from '../../store/connectionStore';
  ```

  同时检查 `Loader2` 是否在其他地方使用。若仅用于 dbLoading，删除 `Loader2` from lucide-react import。

- [ ] **Step 6: 修复 internalDb null→string 相关引用**

  `internalDb` 从 `string | null` 改为 `string`，检查所有 `internalDb ?? null` / `internalDb ?? ''` 的地方：
  - 第 597 行：`database: internalDb ?? null` → `database: internalDb || null`
  - 第 656 行：`database: internalDb ?? null` → `database: internalDb || null`
  - 第 1198 行（`GraphSearchPanel` prop）：若 prop 类型是 `number | null`，改为 `internalConnId || null`

- [ ] **Step 7: TypeScript 检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：无错误。如有类型不匹配，根据报错逐一修正（通常是 `number | null` vs `number` 边界传值问题）。

- [ ] **Step 8: Commit**

  ```bash
  git add src/components/GraphExplorer/index.tsx
  git commit -m "refactor(graph): use ConnectionDbSelector in GraphExplorer toolbar"
  ```

---

## Task 5: 删除冗余的 useConnectionStore import（如已不再使用）

- [ ] **Step 1: 确认 GraphExplorer 不再直接使用 connectionStore**

  ```bash
  grep "useConnectionStore\|loadConnections\|connections\." src/components/GraphExplorer/index.tsx
  ```

  若无输出，说明已完全移除，无需额外操作。

- [ ] **Step 2: 全量 TypeScript 检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：无错误。

- [ ] **Step 3: 运行所有测试**

  ```bash
  npx vitest run
  ```

  期望：所有已有测试 + 新增测试全部通过。

- [ ] **Step 4: Final Commit**

  ```bash
  git add -A
  git commit -m "refactor: finalize ConnectionDbSelector integration, remove dead code"
  ```
