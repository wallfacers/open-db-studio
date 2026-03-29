<!-- STATUS: ❌ 未实现 -->
# ER 图设计器 — 设计规格文档（修订版 v2）

> 日期: 2026-03-27
> 状态: Revision — 修复现有实现，双向同步优先
> 原始日期: 2026-03-25

---

## 背景与问题诊断

原始规格（2026-03-25）定义的前端实现存在以下根本性问题：

1. **`ERCanvas` 从未接入** — `MainContent` 渲染 placeholder，画布组件不可见
2. **双状态同步 anti-pattern** — `ERCanvas/index.tsx` 用 `useMemo` 把 Zustand store 变化同步到 ReactFlow 本地状态，造成无限渲染循环
3. **`onConnect` 不持久化** — 连线只更新 ReactFlow 本地边，不调用 `store.addRelation`
4. **`ERToolbar` 孤立** — 工具栏组件存在但未接入 `ERCanvas`（ERCanvas 从未渲染）
5. **新建表不更新画布** — `ERToolbar.handleAddTable` 调用 `store.addTable` 但没有回调路径把新节点加入 ReactFlow
6. **删除表不更新画布** — `ERTableNode.handleDeleteTable` 调用 `store.deleteTable` 但节点不从 ReactFlow 中移除
7. **后端状态未验证** — er_* Tauri 命令、SQLite 迁移从未在运行时验证

---

## 核心目标

**双向同步优先**：ER 图作为真实数据库 Schema 的镜像 + 编辑层。

- 连接数据库 → 导入 Schema → 可视化编辑
- ER 图变更 → 生成 DDL Diff → 推送到数据库
- 数据库变更 → 同步回 ER 图

**全功能保留**：原规格所有功能（多项目管理、注释标记集成、撤销/重做、DDL 生成、Diff 报告）保留，修复实现而非砍功能。

---

## 1. 核心架构原则：单向数据流

### 问题根源

原 `ERCanvas` 企图维护两份状态同步：
- ReactFlow 本地状态（nodes/edges）
- Zustand store（tables/columns/relations）

用 `useMemo` 做副作用同步，导致循环渲染。`useERCanvas.ts` 同样存在此问题（`initialNodes` 是 useMemo，依赖 `tables`，导致 useEffect 每次重触发）——该文件标记为**删除**，不在新实现中使用。

### 新架构

```
项目加载（useEffect，projectId 变化时触发一次）
    store.loadProject(projectId)          ← 设置 activeProjectId + 填充 store
        → 读取 store.getState()
        → setNodes(tables → ReactFlow nodes，含完整 data callbacks)
        → setEdges(relations → ReactFlow edges)

用户操作（拖拽/编辑/连线）
    → ReactFlow 本地状态立即响应（流畅）
    → 操作完成后回调持久化（store → Rust invoke）
    → store 局部更新自身 state（不调用 setNodes/setEdges）

画布 reload（同步数据库到 ER 后）
    → 调用 reloadCanvas()（见 Section 3）
    → 重新 loadProject + setNodes + setEdges
```

**关键约束**：
- 画布状态由 ReactFlow 本地管理，**不**反向从 store 驱动
- store 只做持久化，不调用 setNodes/setEdges
- 项目切换（projectId 变化）才重新 setNodes/setEdges
- `addTable` / `deleteTable` 等改变节点数量的操作，**必须**通过 ERCanvas 提供的回调来同步 ReactFlow，不能只更新 store

参考实现模式：`src/components/ERDiagram.tsx`（useEffect 加载一次，ReactFlow 管理本地状态）。

---

## 2. 组件结构

```
src/components/ERDesigner/
├── index.tsx                     ← 只导出 ERSidebar（保持不变）
├── ERSidebar/
│   ├── index.tsx                 ← 确认 loadProjects 在挂载时调用；双击节点调用 openERDesignTab
│   ├── ProjectContextMenu.tsx    ← 新增"打开"菜单项，调用 openERDesignTab（目前无此项）
│   └── TableContextMenu.tsx
├── ERCanvas/
│   ├── index.tsx                 ← 重写：单向数据流架构
│   ├── ERTableNode.tsx           ← 修复：data 新增 onDeleteTable 回调；补全列删除按钮
│   ├── EREdge.tsx                ← 保留现有实现，不改动
│   └── ERToolbar.tsx             ← 修改：新增 onTableAdded 回调 prop；新增"绑定连接"按钮
├── dialogs/
│   ├── DDLPreviewDialog.tsx      ← 保留，props: visible/projectId/hasConnection/onClose/onExecute
│   ├── DiffReportDialog.tsx      ← 保留，props: visible/projectId/connectionInfo/onClose/onSyncToDb/onSyncFromDb
│   ├── BindConnectionDialog.tsx  ← 保留，接入触发点
│   └── ImportTableDialog.tsx     ← 保留，接入触发点
└── hooks/
    ├── useERCanvas.ts            ← **删除**（含循环渲染 anti-pattern）
    └── useERKeyboard.ts          ← 保留，集成快捷键
```

### MainContent 修改

```typescript
// 去掉 placeholder，改为：
activeTabObj.type === 'er_design'
  ? <ERCanvas projectId={activeTabObj.erProjectId!} />
  : ...
```

---

## 3. ERCanvas/index.tsx 重写规格

### 状态结构

```typescript
export default function ERCanvas({ projectId }: { projectId: number }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  // 对话框显示状态
  const [showDDL, setShowDDL] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showBind, setShowBind] = useState(false)

  const store = useErDesignerStore()

  // 当前项目（用于检查 connection_id）
  const activeProject = store.projects.find(p => p.id === projectId) ?? null
  const hasConnection = !!activeProject?.connection_id
  ...
}
```

### buildNodeData 辅助函数

由于 `ERTableNode` 读取 `data` 中的回调，必须在构建 node 时一并传入。抽取为内部辅助：

```typescript
// 注意：buildNodeData 的 deps 只包含 store/setNodes/setEdges，
// 不包含 table 和 cols —— 它们是函数参数，每次调用时从参数作用域捕获，
// 不是来自外部 state，因此不需要加入依赖。
// 切勿把 table 或 cols 加入 useCallback deps，否则会破坏 memoization。
const buildNodeData = useCallback((table: ErTable, cols: ErColumn[]) => ({
  table,
  columns: cols,
  onUpdateTable: (updates: Partial<ErTable>) => store.updateTable(table.id, updates),
  onAddColumn: () => store.addColumn(table.id, {
    name: `column_${(cols.length || 0) + 1}`,
    data_type: 'VARCHAR',
    nullable: true,
    default_value: null,
    is_primary_key: false,
    is_auto_increment: false,
    comment: null,
    sort_order: cols.length || 0,
  }),
  onUpdateColumn: (colId: number, updates: Partial<ErColumn>) =>
    store.updateColumn(colId, updates),
  onDeleteColumn: (colId: number) => {
    store.deleteColumn(colId, table.id)
    // setNodes functional updater form — safe with memoized callback
    setNodes(nds => nds.map(n =>
      n.id === `table-${table.id}`
        ? { ...n, data: { ...n.data, columns: (n.data.columns as ErColumn[]).filter(c => c.id !== colId) } }
        : n
    ))
  },
  onDeleteTable: () => {
    store.deleteTable(table.id)
    setNodes(nds => nds.filter(n => n.id !== `table-${table.id}`))
    setEdges(eds => eds.filter(e =>
      e.source !== `table-${table.id}` && e.target !== `table-${table.id}`
    ))
  },
}), [store, setNodes, setEdges])
```

### 项目加载

```typescript
const reloadCanvas = useCallback(() => {
  store.loadProject(projectId).then(() => {
    const state = useErDesignerStore.getState()
    const newNodes = state.tables.map((table) => ({
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, state.columns[table.id] || []),
    }))
    const newEdges = state.relations.map((rel) => ({
      id: `edge-${rel.id}`,
      source: `table-${rel.source_table_id}`,
      sourceHandle: `${rel.source_column_id}-source`,
      target: `table-${rel.target_table_id}`,
      targetHandle: `${rel.target_column_id}-target`,
      type: 'erEdge',
      data: { relation_type: rel.relation_type, source_type: rel.source },
    }))
    setNodes(newNodes)
    setEdges(newEdges)
  })
}, [projectId, buildNodeData, setNodes, setEdges, store])

// 项目切换时加载（reloadCanvas 稳定，加入依赖是正确的）
useEffect(() => {
  reloadCanvas()
}, [reloadCanvas])
```

### 关键事件处理

```typescript
// 拖拽结束 → 持久化位置（不触发 setNodes）
const onNodeDragStop = useCallback((_: unknown, node: Node) => {
  const tableId = parseInt(node.id.replace('table-', ''))
  store.updateTable(tableId, { position_x: node.position.x, position_y: node.position.y })
}, [store])

// 连线 → 立即更新画布 + 后台持久化
// 注意：relation_type 使用 'one_to_many'（后端 canonical value），不用 '1:N'
const onConnect = useCallback((connection: Connection) => {
  setEdges((eds) => addEdge({
    ...connection,
    type: 'erEdge',
    data: { relation_type: 'one_to_many', source_type: 'designer' }
  }, eds))
  const sourceColumnId = parseInt(connection.sourceHandle!.replace('-source', ''))
  const targetColumnId = parseInt(connection.targetHandle!.replace('-target', ''))
  const sourceTableId = parseInt(connection.source!.replace('table-', ''))
  const targetTableId = parseInt(connection.target!.replace('table-', ''))
  store.addRelation({
    source_table_id: sourceTableId,
    source_column_id: sourceColumnId,
    target_table_id: targetTableId,
    target_column_id: targetColumnId,
    relation_type: 'one_to_many',
    source: 'designer'
  })
}, [setEdges, store])
```

### ERToolbar 接入

ERToolbar 已有 `onOpenDDL`、`onOpenDiff`、`onOpenImport`、`setNodes`、`nodes`、`tables` 六个 props。

**新增 `onTableAdded` prop**（需修改 ERToolbar）：

```typescript
// ERToolbar.tsx — 新增到 ERToolbarProps
onTableAdded?: (table: ErTable) => void;

// handleAddTable 修改：
const handleAddTable = async () => {
  const pos = { x: Math.random() * 300 + 100, y: Math.random() * 300 + 100 }
  const table = await addTable('new_table', pos)
  onTableAdded?.(table)
}
```

```typescript
// ERCanvas 内，传给 ERToolbar：
const handleTableAdded = useCallback((table: ErTable) => {
  setNodes(nds => [...nds, {
    id: `table-${table.id}`,
    type: 'erTable',
    position: { x: table.position_x, y: table.position_y },
    data: buildNodeData(table, []),
  }])
}, [setNodes, buildNodeData])
```

**新增"绑定连接"按钮**（ERToolbar 目前无此按钮，需新增）：

```typescript
// ERToolbarProps 新增：
onOpenBind?: () => void;

// 按钮渲染（插入到 DDL/Diff/Sync 分组前）：
<button onClick={onOpenBind} ...>
  <Link2 size={14} />
  <span>{t('erDesigner.bindConnection')}</span>
</button>
```

ERCanvas 中传入：`onOpenBind={() => setShowBind(true)}`

**Diff 按钮连接检查**（ERToolbar 内 handleDiff）：

```typescript
const handleDiff = async () => {
  // ERToolbar 不知道 connection_id，检查逻辑移到 ERCanvas 层
  // ERCanvas 传入 onOpenDiff 时已做检查：
  //   hasConnection ? setShowDiff(true) : toast.warning(t('erDesigner.noConnectionBound'))
}
```

即：ERCanvas 传入的 `onOpenDiff` 内部做连接检查，ERToolbar 直接调用。

**自动布局**：ERToolbar 已自带 dagre 实现，通过 `setNodes` + `nodes` props 驱动，无需修改。

**导出 JSON**：保持现有行为（复制到剪贴板），不改为文件下载。

### 对话框挂载（使用正确的 props 接口）

```typescript
// ERCanvas 内补充：连接信息衍生
// database_name: string | null 字段已确认存在于 ErProject 类型（src/types/index.ts line 8）
const connectionInfo = activeProject?.connection_id
  ? { name: `Connection ${activeProject.connection_id}`, database: activeProject.database_name ?? '' }
  : null

return (
  <div className="w-full h-full flex flex-col">
    <ERToolbar
      projectId={projectId}
      onOpenDDL={() => setShowDDL(true)}
      onOpenDiff={() => hasConnection ? setShowDiff(true) : {/* toast */}}
      onOpenImport={() => setShowImport(true)}
      onOpenBind={() => setShowBind(true)}
      onTableAdded={handleTableAdded}
      setNodes={setNodes}
      nodes={nodes}
      tables={store.tables}
    />
    <div className="flex-1 min-h-0">
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onNodeDragStop={onNodeDragStop}
        onInit={(i) => { rfInstance.current = i }}
        nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background color="#253347" gap={20} />
        <Controls />
        <MiniMap nodeColor="#111922" nodeStrokeColor="#253347" />
      </ReactFlow>
    </div>

    {/* DDLPreviewDialog — 实际 props 接口 */}
    <DDLPreviewDialog
      visible={showDDL}
      projectId={projectId}
      hasConnection={hasConnection}
      onClose={() => setShowDDL(false)}
      onExecute={(ddl) => { /* invoke execute_query */ }}
    />

    {/* DiffReportDialog — 实际 props 接口 */}
    <DiffReportDialog
      visible={showDiff}
      projectId={projectId}
      connectionInfo={connectionInfo}
      onClose={() => setShowDiff(false)}
      {/* TODO Phase 3: 实现同步到数据库（store.generateSyncDDL → store.executeSyncDDL） */}
      onSyncToDb={(_changes) => { /* Phase 3 stub */ }}
      onSyncFromDb={(changes) => { store.syncFromDatabase(projectId).then(reloadCanvas) }}
    />

    {showImport && (
      <ImportTableDialog
        projectId={projectId}
        onClose={() => setShowImport(false)}
        onImported={() => { setShowImport(false); reloadCanvas() }}
      />
    )}

    {showBind && (
      <BindConnectionDialog
        projectId={projectId}
        onClose={() => setShowBind(false)}
      />
    )}
  </div>
)
```

---

## 4. ERTableNode 修复点

### 4.1 新增 `onDeleteTable` 回调

`ERTableNodeData` 新增字段：

```typescript
interface ERTableNodeData {
  ...
  onDeleteTable: () => void;  // 新增
}
```

`handleDeleteTable` 改为调用 `data.onDeleteTable()`（不再直接调用 store）：

```typescript
const handleDeleteTable = () => {
  data.onDeleteTable()  // ERCanvas 提供的回调，同步 store + ReactFlow
}
```

### 4.2 列删除按钮

`ColumnRow` 中缺少删除列按钮。在每行操作区右侧补全：

```tsx
<X
  size={10}
  className="opacity-0 group-hover:opacity-100 cursor-pointer text-gray-500 hover:text-red-400 shrink-0 ml-1"
  onClick={(e) => { e.stopPropagation(); onDeleteColumn(col.id) }}
/>
```

---

## 5. ERSidebar 修复点

### 5.1 右键菜单新增"打开"项

`ProjectContextMenu.tsx` 目前无"打开"菜单项（只有新建表、重命名、绑定连接、解除绑定、导出、删除）。

新增：

```tsx
<div onClick={() => { openERDesignTab(project.id, project.name); onClose() }}>
  {t('erDesigner.openProject')}
</div>
```

### 5.2 ERSidebar loadProjects 时机

验证项（非代码改动）：确认 `ERSidebar/index.tsx` 在 `useEffect(() => { loadProjects() }, [])` 中调用。若没有，则添加此 effect。

---

## 6. 后端验证策略

按优先级逐步验证，遇到问题就地修最小改动：

| 优先级 | 命令 | 验证时机 |
|--------|------|----------|
| P0 | `er_list_projects`、`er_create_project`、`er_get_project` | ERSidebar 加载 + 打开项目 |
| P0 | `er_create_table`、`er_update_table`、`er_delete_table` | 画布新建表、拖拽持久化、删除表 |
| P0 | `er_create_column`、`er_update_column`、`er_delete_column` | 节点内编辑列 |
| P1 | `er_create_relation`、`er_delete_relation` | 连线持久化 |
| P1 | `er_generate_ddl` | DDLPreviewDialog |
| P2 | `er_diff_with_database`、`er_sync_from_database` | DiffReportDialog |

**SQLite 迁移**：检查 `src-tauri/src/db/migrations.rs`，确认 `er_projects`、`er_tables`、`er_columns`、`er_relations`、`er_indexes` 五张表已包含在迁移脚本中。

**修复范围**：只修编译错误和运行时 panic，不重构后端逻辑。

**relation_type 规范**：后端 canonical value 为 `'one_to_many'`（非 `'1:N'`）。前端所有 hardcoded 关系类型统一改为 `'one_to_many'`。

---

## 7. 保留不变的功能

以下功能原规格设计合理，实现中不做改动：

- **数据模型**（SQLite 表结构、JSON 导出格式）— 见原规格 Section 3
- **DDL 多方言引擎**（MySQL/PostgreSQL/Oracle/SQL Server/SQLite）— 见原规格 Section 4.3
- **Diff 引擎数据结构**（DiffResult/TableModDiff）— 见原规格 Section 4.4
- **Zustand store 接口**（erDesignerStore.ts）— 保持现有实现，不修改
- **关系来源三层模型**（schema/comment/designer，视觉样式区分）— 见原规格 Section 6.5
- **快捷键**（useERKeyboard.ts）— 集成进 ERCanvas
- **撤销/重做**（undo/redo stub）— 保持现有 stub，不升级也不删除
- **注释标记集成**（@ref 写回、知识图谱联动）— 保留后端逻辑，DiffReport 同步时调用

---

## 8. 实现优先级

```
Phase 1（核心可用）:
  1. MainContent 接入 ERCanvas（去掉 placeholder）
  2. ERCanvas 重写（单向数据流 + buildNodeData + reloadCanvas）
  3. ERTableNode 修复（onDeleteTable + 列删除按钮）
  4. ERToolbar 修改（新增 onTableAdded + 绑定连接按钮）
  5. ERSidebar 修复（右键"打开"菜单项）
  6. 删除 useERCanvas.ts
  7. P0 后端命令验证 + 修复

Phase 2（功能完整）:
  8. P1 命令验证：relation、DDL 生成
  9. DDLPreviewDialog 接入（correct props）
  10. BindConnectionDialog 接入

Phase 3（同步闭环）:
  11. P2 命令验证：diff、sync
  12. DiffReportDialog 接入（connectionInfo + onSyncToDb/FromDb）
  13. ImportTableDialog 接入（onImported → reloadCanvas）
```
