# ER Multi-Tab activeProjectId Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除多 ER Tab 场景下 `activeProjectId` 对写入操作和画布同步的隐式依赖，使每个 Canvas 实例独立响应自身项目数据的变化。

**Architecture:** 三条改动：(1) `addTable`/`addRelation` 增加显式 `projectId` 参数，消除写入操作读取全局 `activeProjectId` 导致的项目错位；(2) Canvas 同步 useEffect 移除 `activeProjectId` 守卫，改为按 `projectId` 过滤 `tables`/`relations`，同时修复 `reloadCanvas` 的相同问题；(3) `useERKeyboard` 接受 `projectId` 参数，消除键盘快捷键的全局依赖。

**Tech Stack:** React 18 · TypeScript · Zustand · Vitest · tsc

---

## 文件变更总览

| 文件 | 动作 |
|------|------|
| `src/store/erDesignerStore.ts` | 修改：`addTable`/`addRelation` 接口与实现 |
| `src/store/erDesignerStore.test.ts` | 新建：store 方法单元测试 |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 修改：`reloadCanvas` 过滤 + sync useEffect 过滤 + `addRelation` 调用 + `useERKeyboard` 调用 |
| `src/components/ERDesigner/hooks/useERKeyboard.ts` | 修改：增加 `projectId` 参数，移除 `activeProjectId` 依赖 |
| `src/mcp/ui/adapters/ERCanvasAdapter.ts` | 修改：`exec('add_table')` + `_batchCreateTable` + `exec('add_relation')` |
| `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts` | 修改：追加 addTable/addRelation projectId 测试 |
| `src/components/ERDesigner/ERCanvas/ERToolbar.tsx` | 修改：`handleAddTable` 调用 |
| `src/components/ERDesigner/ERCanvas/ERTableContextMenu.tsx` | 修改：`handleDuplicate` 调用 |
| `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx` | 修改：`handleDuplicate` 调用 |
| `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx` | 修改：`handleAddTable` 调用 |

---

### Task 1：更新 store `addTable` + `addRelation` 接口与实现

**Files:**
- Modify: `src/store/erDesignerStore.ts`
- Create: `src/store/erDesignerStore.test.ts`

- [ ] **Step 1：写失败测试**

新建 `src/store/erDesignerStore.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

import { invoke } from '@tauri-apps/api/core'
import { useErDesignerStore } from './erDesignerStore'

describe('erDesignerStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useErDesignerStore.setState({
      tables: [],
      columns: {},
      indexes: {},
      undoStack: [],
      redoStack: [],
    })
  })

  describe('addTable', () => {
    it('传入显式 projectId 而非读取 activeProjectId', async () => {
      const mockTable = {
        id: 1, project_id: 99, name: 'foo',
        position_x: 10, position_y: 20,
        comment: null, color: null,
      }
      vi.mocked(invoke).mockResolvedValue(mockTable)

      await useErDesignerStore.getState().addTable(99, 'foo', { x: 10, y: 20 })

      expect(invoke).toHaveBeenCalledWith('er_create_table', {
        req: { project_id: 99, name: 'foo', position_x: 10, position_y: 20 },
      })
    })
  })

  describe('addRelation', () => {
    it('传入显式 projectId 而非读取 activeProjectId', async () => {
      const mockRelation = {
        id: 5, project_id: 42,
        source_table_id: 1, source_column_id: 10,
        target_table_id: 2, target_column_id: 20,
        relation_type: 'one_to_many', name: null,
        on_delete: 'NO ACTION', on_update: 'NO ACTION', source: 'designer',
      }
      vi.mocked(invoke).mockResolvedValue(mockRelation)

      await useErDesignerStore.getState().addRelation(42, {
        source_table_id: 1, source_column_id: 10,
        target_table_id: 2, target_column_id: 20,
        relation_type: 'one_to_many',
      })

      expect(invoke).toHaveBeenCalledWith('er_create_relation', {
        req: {
          project_id: 42,
          source_table_id: 1, source_column_id: 10,
          target_table_id: 2, target_column_id: 20,
          relation_type: 'one_to_many',
        },
      })
    })
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
cd /home/wallfacers/project/open-db-studio && npx vitest run src/store/erDesignerStore.test.ts
```

预期：类型错误或运行时错误，因为当前签名不接受 `projectId` 参数。

- [ ] **Step 3：更新 `ErDesignerState` 接口**

编辑 `src/store/erDesignerStore.ts`，修改接口中两行（第70行 addTable，第82行 addRelation）：

```typescript
// 第70行，改前：
addTable: (name: string, position: { x: number; y: number }) => Promise<ErTable>;
// 改后：
addTable: (projectId: number, name: string, position: { x: number; y: number }) => Promise<ErTable>;

// 第82行，改前：
addRelation: (rel: Partial<ErRelation>) => Promise<ErRelation>;
// 改后：
addRelation: (projectId: number, rel: Partial<ErRelation>) => Promise<ErRelation>;
```

- [ ] **Step 4：更新 `addTable` 实现**

编辑第337-338行，将：

```typescript
addTable: async (name, position) => {
  const { activeProjectId, pushOperation } = get();
```

改为：

```typescript
addTable: async (projectId, name, position) => {
  const { pushOperation } = get();
```

同时第342行，将：

```typescript
req: { project_id: activeProjectId, name, position_x: position.x, position_y: position.y },
```

改为：

```typescript
req: { project_id: projectId, name, position_x: position.x, position_y: position.y },
```

- [ ] **Step 5：更新 `addRelation` 实现**

编辑第557-560行，将：

```typescript
addRelation: async (rel) => {
  const { activeProjectId } = get();
  try {
    const created = await invoke<ErRelation>('er_create_relation', {
      req: { project_id: activeProjectId, ...rel },
```

改为：

```typescript
addRelation: async (projectId, rel) => {
  try {
    const created = await invoke<ErRelation>('er_create_relation', {
      req: { project_id: projectId, ...rel },
```

- [ ] **Step 6：运行测试，确认通过**

```bash
npx vitest run src/store/erDesignerStore.test.ts
```

预期：2 tests PASS

- [ ] **Step 7：Commit**

```bash
git add src/store/erDesignerStore.ts src/store/erDesignerStore.test.ts
git commit -m "feat(er-store): addTable/addRelation accept explicit projectId param"
```

---

### Task 2：修复 ERCanvas `reloadCanvas` + sync useEffect

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`

此任务为纯逻辑改写，通过 tsc + 行为验证确认正确性。

- [ ] **Step 1：修复 `reloadCanvas` 中的全量过滤问题**

`reloadCanvas` 当前使用 `state.tables`（全量）构建节点。多项目场景下会把其他项目的表渲染到本 Canvas。

编辑 `src/components/ERDesigner/ERCanvas/index.tsx` 中的 `reloadCanvas` 函数体（约第135-156行），将：

```typescript
const reloadCanvas = useCallback(() => {
  loadProject(projectId).then(() => {
    const state = useErDesignerStore.getState()
    const newNodes: Node<NodeData>[] = state.tables.map((table) => ({
      id: erTableNodeId(table.id),
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, state.columns[table.id] || []),
    }))
    const newEdges = state.relations.map((rel) => ({
      id: erEdgeNodeId(rel.id),
      source: erTableNodeId(rel.source_table_id),
      sourceHandle: `${rel.source_column_id}-source`,
      target: erTableNodeId(rel.target_table_id),
      targetHandle: `${rel.target_column_id}-target`,
      type: 'erEdge',
      data: { relation_type: rel.relation_type, source_type: rel.source },
    }))
    setNodes(newNodes)
    setEdges(newEdges)
  })
}, [projectId, buildNodeData, setNodes, setEdges, loadProject])
```

改为：

```typescript
const reloadCanvas = useCallback(() => {
  loadProject(projectId).then(() => {
    const state = useErDesignerStore.getState()
    const projectTables = state.tables.filter(t => t.project_id === projectId)
    const tableIdSet = new Set(projectTables.map(t => t.id))
    const newNodes: Node<NodeData>[] = projectTables.map((table) => ({
      id: erTableNodeId(table.id),
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, state.columns[table.id] || []),
    }))
    const newEdges = state.relations
      .filter(r => tableIdSet.has(r.source_table_id) || tableIdSet.has(r.target_table_id))
      .map((rel) => ({
        id: erEdgeNodeId(rel.id),
        source: erTableNodeId(rel.source_table_id),
        sourceHandle: `${rel.source_column_id}-source`,
        target: erTableNodeId(rel.target_table_id),
        targetHandle: `${rel.target_column_id}-target`,
        type: 'erEdge',
        data: { relation_type: rel.relation_type, source_type: rel.source },
      }))
    setNodes(newNodes)
    setEdges(newEdges)
  })
}, [projectId, buildNodeData, setNodes, setEdges, loadProject])
```

- [ ] **Step 2：修复 sync useEffect（移除守卫，改为 projectId 过滤）**

编辑约第162-230行的 sync useEffect，将：

```typescript
// Sync store changes to ReactFlow nodes/edges (for sidebar operations)
useEffect(() => {
  // Only sync when we have loaded data (activeProjectId matches)
  const state = useErDesignerStore.getState()
  if (state.activeProjectId !== projectId) return

  // Update nodes based on current tables (sync table name, columns, etc.)
  setNodes(nds => {
    const currentTableIds = new Set(tables.map(t => t.id))
    // Update existing nodes and remove deleted ones
    const updated = nds
      .filter(n => currentTableIds.has(parseErTableNodeId(n.id)!))
      .map(n => {
        const tableId = parseErTableNodeId(n.id)!
        const table = tables.find(t => t.id === tableId)
        if (!table) return n
        const cols = columns[tableId] || []
        // Update node data with latest table and columns
        return {
          ...n,
          position: { x: table.position_x, y: table.position_y },
          data: {
            ...n.data,
            table,
            columns: cols,
          },
        }
      })
    // Add new nodes for tables not yet on canvas
    const existingIds = new Set(updated.map(n => n.id))
    const newNodes = tables
      .filter(t => !existingIds.has(erTableNodeId(t.id)))
      .map(table => ({
        id: erTableNodeId(table.id),
        type: 'erTable',
        position: { x: table.position_x, y: table.position_y },
        data: buildNodeData(table, columns[table.id] || []),
      }))
    return [...updated, ...newNodes]
  })

  // Update edges based on current relations
  setEdges(eds => {
    const currentRelIds = new Set(relations.map(r => r.id))
    const currentTableIds = new Set(tables.map(t => t.id))
    // Remove edges for deleted relations or deleted tables
    const filtered = eds.filter(e => {
      const relId = parseErEdgeNodeId(e.id)
      return relId != null &&
        currentRelIds.has(relId) &&
        currentTableIds.has(parseErTableNodeId(e.source)!) &&
        currentTableIds.has(parseErTableNodeId(e.target)!)
    })
    // Add edges for new relations
    const existingIds = new Set(filtered.map(e => e.id))
    const newEdges = relations
      .filter(r => !existingIds.has(erEdgeNodeId(r.id)))
      .map(rel => ({
        id: erEdgeNodeId(rel.id),
        source: erTableNodeId(rel.source_table_id),
        sourceHandle: `${rel.source_column_id}-source`,
        target: erTableNodeId(rel.target_table_id),
        targetHandle: `${rel.target_column_id}-target`,
        type: 'erEdge',
        data: { relation_type: rel.relation_type, source_type: rel.source },
      }))
    return [...filtered, ...newEdges]
  })
}, [projectId, tables, relations, columns, buildNodeData, setNodes, setEdges])
```

改为：

```typescript
// Sync store changes to ReactFlow nodes/edges (for sidebar operations)
// Filter by projectId — each Canvas instance only reacts to its own project data
useEffect(() => {
  const projectTables = tables.filter(t => t.project_id === projectId)
  const tableIdSet = new Set(projectTables.map(t => t.id))
  const projectRelations = relations.filter(
    r => tableIdSet.has(r.source_table_id) || tableIdSet.has(r.target_table_id)
  )

  setNodes(nds => {
    const currentTableIds = new Set(projectTables.map(t => t.id))
    const updated = nds
      .filter(n => currentTableIds.has(parseErTableNodeId(n.id)!))
      .map(n => {
        const tableId = parseErTableNodeId(n.id)!
        const table = projectTables.find(t => t.id === tableId)
        if (!table) return n
        const cols = columns[tableId] || []
        return {
          ...n,
          position: { x: table.position_x, y: table.position_y },
          data: { ...n.data, table, columns: cols },
        }
      })
    const existingIds = new Set(updated.map(n => n.id))
    const newNodes = projectTables
      .filter(t => !existingIds.has(erTableNodeId(t.id)))
      .map(table => ({
        id: erTableNodeId(table.id),
        type: 'erTable',
        position: { x: table.position_x, y: table.position_y },
        data: buildNodeData(table, columns[table.id] || []),
      }))
    return [...updated, ...newNodes]
  })

  setEdges(eds => {
    const currentRelIds = new Set(projectRelations.map(r => r.id))
    const filtered = eds.filter(e => {
      const relId = parseErEdgeNodeId(e.id)
      return relId != null &&
        currentRelIds.has(relId) &&
        tableIdSet.has(parseErTableNodeId(e.source)!) &&
        tableIdSet.has(parseErTableNodeId(e.target)!)
    })
    const existingIds = new Set(filtered.map(e => e.id))
    const newEdges = projectRelations
      .filter(r => !existingIds.has(erEdgeNodeId(r.id)))
      .map(rel => ({
        id: erEdgeNodeId(rel.id),
        source: erTableNodeId(rel.source_table_id),
        sourceHandle: `${rel.source_column_id}-source`,
        target: erTableNodeId(rel.target_table_id),
        targetHandle: `${rel.target_column_id}-target`,
        type: 'erEdge',
        data: { relation_type: rel.relation_type, source_type: rel.source },
      }))
    return [...filtered, ...newEdges]
  })
}, [projectId, tables, relations, columns, buildNodeData, setNodes, setEdges])
```

- [ ] **Step 3：tsc 检查（记录当前错误数作为基线，此时 addTable/addRelation 调用点尚未更新）**

```bash
npx tsc --noEmit 2>&1 | grep -c "error TS" || echo "0 errors"
```

记录错误数量，这些错误来自尚未更新的调用点，后续任务会逐一清零。

- [ ] **Step 4：Commit**

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx
git commit -m "fix(er-canvas): filter tables/relations by projectId in sync effect and reloadCanvas"
```

---

### Task 3：更新 useERKeyboard 接受 projectId 参数

**Files:**
- Modify: `src/components/ERDesigner/hooks/useERKeyboard.ts`

- [ ] **Step 1：更新 `UseERKeyboardOptions` 接口**

编辑 `src/components/ERDesigner/hooks/useERKeyboard.ts`，将第6-14行：

```typescript
interface UseERKeyboardOptions {
  nodes: Node[];
  edges: Edge[];
  selectedNodes: Node[];
  selectedEdges: Edge[];
  onAutoLayout: () => void;
  onExportDDL: () => void;
  enabled?: boolean;
}
```

改为：

```typescript
interface UseERKeyboardOptions {
  projectId: number;
  nodes: Node[];
  edges: Edge[];
  selectedNodes: Node[];
  selectedEdges: Edge[];
  onAutoLayout: () => void;
  onExportDDL: () => void;
  enabled?: boolean;
}
```

- [ ] **Step 2：更新函数签名，移除 `activeProjectId` store 订阅**

将第28-45行：

```typescript
export function useERKeyboard({
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  onAutoLayout,
  onExportDDL,
  enabled = true,
}: UseERKeyboardOptions) {
  const {
    deleteTable,
    deleteRelation,
    undo,
    redo,
    addTable,
    tables,
    activeProjectId,
  } = useErDesignerStore();
```

改为：

```typescript
export function useERKeyboard({
  projectId,
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  onAutoLayout,
  onExportDDL,
  enabled = true,
}: UseERKeyboardOptions) {
  const {
    deleteTable,
    deleteRelation,
    undo,
    redo,
    addTable,
    tables,
  } = useErDesignerStore();
```

- [ ] **Step 3：更新 `handleDuplicate`，用参数 `projectId` 替换 `activeProjectId`**

将第67-82行：

```typescript
const handleDuplicate = useCallback(() => {
  if (selectedNodes.length === 0 || !activeProjectId) return;

  selectedNodes.forEach((node) => {
    const tableId = parseErTableNodeId(node.id);
    if (tableId === null) return;
    const originalTable = tables.find((t) => t.id === tableId);
    if (!originalTable) return;

    // 创建新表，位置偏移
    addTable(`${originalTable.name}_copy`, {
      x: originalTable.position_x + 50,
      y: originalTable.position_y + 50,
    });
  });
}, [selectedNodes, tables, activeProjectId, addTable]);
```

改为：

```typescript
const handleDuplicate = useCallback(() => {
  if (selectedNodes.length === 0) return;

  selectedNodes.forEach((node) => {
    const tableId = parseErTableNodeId(node.id);
    if (tableId === null) return;
    const originalTable = tables.find((t) => t.id === tableId);
    if (!originalTable) return;

    // 创建新表，位置偏移
    addTable(projectId, `${originalTable.name}_copy`, {
      x: originalTable.position_x + 50,
      y: originalTable.position_y + 50,
    });
  });
}, [selectedNodes, tables, projectId, addTable]);
```

- [ ] **Step 4：Commit**

```bash
git add src/components/ERDesigner/hooks/useERKeyboard.ts
git commit -m "feat(er-keyboard): accept explicit projectId, remove activeProjectId dependency"
```

---

### Task 4：更新 ERCanvasAdapter 调用点

**Files:**
- Modify: `src/mcp/ui/adapters/ERCanvasAdapter.ts`
- Modify: `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts`

- [ ] **Step 1：在 ERCanvasAdapter.test.ts 中追加失败测试**

在 `describe('ERCanvasAdapter', ...)` 内追加两个 describe 块：

```typescript
describe('exec add_table uses adapter projectId', () => {
  it('calls store.addTable with this._projectId as first arg', async () => {
    const addTableMock = vi.fn().mockResolvedValue({
      id: 1, project_id: 1, name: 'foo', position_x: 100, position_y: 100,
      comment: null, color: null,
    })
    mockStore.addTable = addTableMock

    const result = await adapter.exec('add_table', { name: 'foo', position: { x: 100, y: 100 } })

    expect(result.success).toBe(true)
    expect(addTableMock).toHaveBeenCalledWith(1, 'foo', { x: 100, y: 100 })
  })
})

describe('exec add_relation uses adapter projectId', () => {
  it('calls store.addRelation with this._projectId as first arg', async () => {
    const addRelationMock = vi.fn().mockResolvedValue({ id: 5, project_id: 1 })
    mockStore.addRelation = addRelationMock

    const result = await adapter.exec('add_relation', {
      source_table_id: 10, source_column_id: 100,
      target_table_id: 20, target_column_id: 200,
      relation_type: 'one_to_many',
    })

    expect(result.success).toBe(true)
    expect(addRelationMock).toHaveBeenCalledWith(1, {
      source_table_id: 10, source_column_id: 100,
      target_table_id: 20, target_column_id: 200,
      relation_type: 'one_to_many',
    })
  })
})
```

- [ ] **Step 2：运行测试，确认新增测试失败**

```bash
npx vitest run src/mcp/ui/__tests__/ERCanvasAdapter.test.ts
```

预期：2 new tests FAIL（addTable 未收到 `this._projectId` 作为第一参数）。

- [ ] **Step 3：更新 `exec('add_table')` 调用（约第870-876行）**

将：

```typescript
case 'add_table':
  return this.withReload(async () => {
    const position = params?.position ?? { x: 100, y: 100 }
    const table = await store.addTable(params.name, position)
    return { tableId: table.id }
  })
```

改为：

```typescript
case 'add_table':
  return this.withReload(async () => {
    const position = params?.position ?? { x: 100, y: 100 }
    const table = await store.addTable(this._projectId, params.name, position)
    return { tableId: table.id }
  })
```

- [ ] **Step 4：更新 `exec('add_relation')` 调用（约第897-901行）**

将：

```typescript
case 'add_relation':
  return this.withReload(async () => {
    const created = await store.addRelation(params)
    return { relationId: created.id }
  })
```

改为：

```typescript
case 'add_relation':
  return this.withReload(async () => {
    const created = await store.addRelation(this._projectId, params)
    return { relationId: created.id }
  })
```

- [ ] **Step 5：更新 `_batchCreateTable` 调用（约第1030行）**

将：

```typescript
const table = await store.addTable(params.name, position)
```

改为：

```typescript
const table = await store.addTable(this._projectId, params.name, position)
```

- [ ] **Step 6：运行测试，确认全部通过**

```bash
npx vitest run src/mcp/ui/__tests__/ERCanvasAdapter.test.ts
```

预期：所有测试 PASS（包含原有 + 2 新增）。

- [ ] **Step 7：Commit**

```bash
git add src/mcp/ui/adapters/ERCanvasAdapter.ts src/mcp/ui/__tests__/ERCanvasAdapter.test.ts
git commit -m "fix(er-adapter): pass this._projectId to addTable/addRelation calls"
```

---

### Task 5：更新 ERCanvas + ERToolbar + ERTableContextMenu 调用点

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`
- Modify: `src/components/ERDesigner/ERCanvas/ERToolbar.tsx`
- Modify: `src/components/ERDesigner/ERCanvas/ERTableContextMenu.tsx`

- [ ] **Step 1：ERCanvas — 更新 `onConnect` 中的 `addRelation`**

编辑 `src/components/ERDesigner/ERCanvas/index.tsx`，在 `onConnect` callback（约第346-364行）中，将：

```typescript
    addRelation({
      source_table_id: sourceTableId,
      source_column_id: sourceColumnId,
      target_table_id: targetTableId,
      target_column_id: targetColumnId,
      relation_type: 'one_to_many',
      source: 'designer'
    })
```

改为：

```typescript
    addRelation(projectId, {
      source_table_id: sourceTableId,
      source_column_id: sourceColumnId,
      target_table_id: targetTableId,
      target_column_id: targetColumnId,
      relation_type: 'one_to_many',
      source: 'designer'
    })
```

- [ ] **Step 2：ERCanvas — 更新 `useERKeyboard` 调用，传入 `projectId`**

找到 `useERKeyboard({` 的调用（约第393行），将：

```typescript
  useERKeyboard({
    nodes,
    edges,
    selectedNodes: [],
    selectedEdges: [],
    onAutoLayout: handleAutoLayout,
    onExportDDL: () => setShowDDL(true),
    enabled: isActiveTab,
  })
```

改为：

```typescript
  useERKeyboard({
    projectId,
    nodes,
    edges,
    selectedNodes: [],
    selectedEdges: [],
    onAutoLayout: handleAutoLayout,
    onExportDDL: () => setShowDDL(true),
    enabled: isActiveTab,
  })
```

- [ ] **Step 3：ERToolbar — 更新 `handleAddTable`，移除 `activeProjectId` 依赖**

编辑 `src/components/ERDesigner/ERCanvas/ERToolbar.tsx`。

将第52-60行的 store 解构：

```typescript
  const {
    addTable,
    syncFromDatabase,
    exportJson,
    previewImport,
    executeImport,
    projects,
    activeProjectId,
  } = useErDesignerStore();
```

改为（移除 `activeProjectId`）：

```typescript
  const {
    addTable,
    syncFromDatabase,
    exportJson,
    previewImport,
    executeImport,
    projects,
  } = useErDesignerStore();
```

将第82行：

```typescript
      const table = await addTable(name, pos);
```

改为：

```typescript
      const table = await addTable(projectId, name, pos);
```

- [ ] **Step 4：ERTableContextMenu — 用 `table.project_id` 替换 `activeProjectId`**

编辑 `src/components/ERDesigner/ERCanvas/ERTableContextMenu.tsx`。

将第26行的 store 解构：

```typescript
  const { tables, columns, deleteTable, addColumn, activeProjectId, loadProject, addTable, openDrawer } = useErDesignerStore();
```

改为（移除 `activeProjectId` 和 `loadProject`，均不再使用）：

```typescript
  const { tables, columns, deleteTable, addColumn, addTable, openDrawer } = useErDesignerStore();
```

将 `handleDuplicate`（约第68-97行）中：

```typescript
  const handleDuplicate = async () => {
    if (!table || !activeProjectId) return;
    const srcCols = columns[tableId] || [];
    const newTable = await addTable(`${table.name}_copy`, {
      x: table.position_x + 50,
      y: table.position_y + 50,
    });
```

改为：

```typescript
  const handleDuplicate = async () => {
    if (!table) return;
    const srcCols = columns[tableId] || [];
    const newTable = await addTable(table.project_id, `${table.name}_copy`, {
      x: table.position_x + 50,
      y: table.position_y + 50,
    });
```

- [ ] **Step 5：tsc 检查，此文件组应无错误**

```bash
npx tsc --noEmit 2>&1 | grep -E "ERCanvas|ERToolbar|ERTableContextMenu" | head -20
```

预期：无相关错误。

- [ ] **Step 6：Commit**

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx \
        src/components/ERDesigner/ERCanvas/ERToolbar.tsx \
        src/components/ERDesigner/ERCanvas/ERTableContextMenu.tsx
git commit -m "fix(er-canvas): update addRelation/addTable call sites with explicit projectId"
```

---

### Task 6：更新 sidebar 调用点 + 全量验证

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx`
- Modify: `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx`

- [ ] **Step 1：TableContextMenu — 用 `table.project_id`**

编辑 `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx`。

将 `handleDuplicate`（约第83-112行）中：

```typescript
  const handleDuplicate = async () => {
    if (!table) return;
    const srcCols = columns[tableId] || [];
    const newTable = await addTable(`${table.name}_copy`, {
      x: table.position_x + 50,
      y: table.position_y + 50,
    });
```

改为：

```typescript
  const handleDuplicate = async () => {
    if (!table) return;
    const srcCols = columns[tableId] || [];
    const newTable = await addTable(table.project_id, `${table.name}_copy`, {
      x: table.position_x + 50,
      y: table.position_y + 50,
    });
```

- [ ] **Step 2：ProjectContextMenu — 用 prop `projectId`**

编辑 `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx`。

将 `handleAddTable`（约第117-131行）中：

```typescript
    await addTable(name, { x: 100, y: 100 });
```

改为：

```typescript
    await addTable(projectId, name, { x: 100, y: 100 });
```

（`projectId` 已作为 props 传入该组件，无需其他修改。）

- [ ] **Step 3：全量 TypeScript 类型检查 — 期望零错误**

```bash
npx tsc --noEmit 2>&1
```

预期：**无任何输出**（零错误）。若有残余错误，按错误信息定位并修复，再次运行直至干净。

- [ ] **Step 4：运行全量测试套件**

```bash
npm run test
```

预期：所有测试通过，包括：
- `src/store/erDesignerStore.test.ts` — 2 新增 tests
- `src/mcp/ui/__tests__/ERCanvasAdapter.test.ts` — 原有 + 2 新增 tests
- 其他现有测试不受影响

- [ ] **Step 5：最终 Commit**

```bash
git add src/components/ERDesigner/ERSidebar/TableContextMenu.tsx \
        src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx
git commit -m "fix(er-sidebar): pass explicit projectId to addTable in sidebar context menus"
```

---

## 验收标准核对

| 验收条件 | 覆盖任务 |
|----------|----------|
| 打开项目 A 和 B 的 ER Tab，AI 修改项目 A → Canvas A 节点实时更新，Canvas B 不受影响 | Task 2（sync useEffect filter） |
| 通过项目 A 的 MCP Adapter 调用 `add_table` → 新表 `project_id = A` | Task 1 + Task 4 |
| 聚焦 Canvas A，按 `Ctrl+D` 复制表 → 新表出现在项目 A，不影响项目 B | Task 3 |
| TypeScript 编译零新增错误 | Task 6 Step 3 |
| 全量测试通过 | Task 6 Step 4 |
