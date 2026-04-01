<!-- STATUS: ✅ 已实现 -->
# 指标目录集成到数据库树 — 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将「业务指标」目录集成到数据库树中，用户可在浏览数据库对象的同时管理指标。

**Architecture:** 在 treeStore 中新增 `metricCounts` 状态和 `metrics_folder`/`metric` 节点类型，在 loadChildren 时根据数据库类型在正确位置插入指标目录，通过 DBTree 渲染和右键菜单支持指标操作。

**Tech Stack:** React, TypeScript, Zustand, Tauri invoke, Lucide icons, i18n

---

## 受影响文件

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | NodeType 新增 `metrics_folder` \| `metric` |
| `src/store/treeStore.ts` | 新增 `metricCounts` Map、`makeMetricsFolderNode`、`deleteMetricNode`、loadChildren 分支 |
| `src/components/Explorer/DBTree.tsx` | 新增 Props、渲染指标节点、右键菜单 |
| `src/components/Explorer/ContextMenu.tsx` | 新增指标相关菜单项 |
| `src/components/Explorer/TreeNode.tsx` | NODE_ICONS 新增图标映射 |
| `src/components/Explorer/index.tsx` | 新增 Props 透传 |
| `src/components/ActivityBar/index.tsx` | 隐藏指标图标入口 |
| `src/i18n/locales/zh.json` | 新增 i18n 键 |
| `src/i18n/locales/en.json` | 新增 i18n 键 |

---

## Chunk 1: Types 和 i18n 基础设施

### Task 1: 扩展 NodeType

**Files:**
- Modify: `src/types/index.ts:213-228`

- [ ] **Step 1: 扩展 NodeType 类型定义**

在 `NodeType` 类型末尾新增两个节点类型：

```typescript
export type NodeType =
  | 'group'
  | 'connection'
  | 'database'
  | 'schema'
  | 'category'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'event'
  | 'sequence'
  | 'materialized_view'
  | 'dictionary'
  | 'column'
  | 'metrics_folder'   // 新增：指标目录节点
  | 'metric';          // 新增：单个指标叶节点
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（无类型错误）

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(tree): add metrics_folder and metric to NodeType

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: 添加 i18n 键

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: 在 zh.json 的 dbTree 部分添加指标相关键**

在 `"dbTree"` 对象中添加：

```json
"dbTree": {
  "noConnections": "暂无连接",
  "noSearchResults": "未找到匹配项",
  "confirmDeleteConnection": "确定要删除此连接？",
  "connectionDeleted": "连接已删除",
  "operationSuccess": "操作成功",
  "nameCopied": "已复制",
  "groupCreateComingSoon": "新建分组功能开发中",
  "groupRenameComingSoon": "重命名分组功能开发中",
  "confirmDeleteGroup": "确定要删除此分组？连接将移至未分组。",
  "groupDeleted": "分组已删除",
  "connectionFailed": "连接失败，请检查连接配置",
  "doubleClickToOpen": "双击打开连接",
  "metrics": "指标",
  "openMetricList": "打开指标列表",
  "newMetric": "新建指标",
  "deleteMetric": "删除指标",
  "confirmDeleteMetric": "确认删除指标 \"{{name}}\"？"
}
```

- [ ] **Step 2: 在 zh.json 的 contextMenu 部分添加指标相关键**

在 `"contextMenu"` 对象中添加（添加到现有键之后）：

```json
"contextMenu": {
  ...existing keys...
  "openMetricList": "打开指标列表",
  "newMetric": "新建指标",
  "deleteMetric": "删除指标"
}
```

- [ ] **Step 3: 在 en.json 添加对应的英文键**

在 `dbTree` 部分添加：

```json
"metrics": "Metrics",
"openMetricList": "Open Metric List",
"newMetric": "New Metric",
"deleteMetric": "Delete Metric",
"confirmDeleteMetric": "Confirm delete metric \"{{name}}\"?"
```

在 `contextMenu` 部分添加：

```json
"openMetricList": "Open Metric List",
"newMetric": "New Metric",
"deleteMetric": "Delete Metric"
```

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(i18n): add metrics-related i18n keys for db tree

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 2: treeStore 核心逻辑

### Task 3: treeStore 新增状态和辅助函数

**Files:**
- Modify: `src/store/treeStore.ts`

- [ ] **Step 1: 新增 Metric 类型导入（文件顶部）**

在 `import type { TreeNode, NodeType, CategoryKey, ConnectionGroup } from '../types';` 之后添加：

```typescript
import type { Metric } from '../types';
```

- [ ] **Step 2: 新增 makeMetricsFolderNode 辅助函数**

在 `makeCategoryNodes` 函数之后添加：

```typescript
function makeMetricsFolderNode(parentId: string, meta: TreeNode['meta']): TreeNode {
  return {
    id: `${parentId}/metrics_folder`,
    nodeType: 'metrics_folder',
    label: 'dbTree.metrics',   // i18n key，DBTree 渲染时调用 t()
    parentId,
    hasChildren: true,         // 初始设为 true 以显示展开箭头；加载后修正为 metrics.length > 0
    loaded: false,
    meta: { ...meta },
  };
}
```

- [ ] **Step 3: 扩展 TreeStore interface 新增 metricCounts 和 deleteMetricNode**

在 `interface TreeStore` 中添加 `metricCounts` 状态和 `deleteMetricNode` action：

```typescript
interface TreeStore {
  nodes: Map<string, TreeNode>;
  searchIndex: Map<string, TreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  loadingIds: Set<string>;
  error: string | null;
  metricCounts: Map<string, number>;  // 新增：key = metrics_folder 节点 ID，value = 指标数量

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  search: (query: string) => TreeNode[];
  deleteMetricNode: (nodeId: string) => void;  // 新增
  _addNodes: (nodes: TreeNode[]) => void;
  _removeSubtree: (nodeId: string) => void;
}
```

- [ ] **Step 4: 在 create 初始状态中添加 metricCounts**

在 `export const useTreeStore = create<TreeStore>((set, get) => ({` 中添加初始值：

```typescript
export const useTreeStore = create<TreeStore>((set, get) => ({
  nodes: new Map(),
  searchIndex: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  loadingIds: new Set(),
  error: null,
  metricCounts: new Map(),  // 新增

  init: async () => {
    // ... 不变
  },
  // ...
}));
```

- [ ] **Step 5: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/treeStore.ts
git commit -m "feat(treeStore): add metricCounts state and makeMetricsFolderNode helper

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: loadChildren 插入 metrics_folder 节点

**Files:**
- Modify: `src/store/treeStore.ts`

- [ ] **Step 1: 在 connection 节点的 databases.length === 0 分支插入 metrics_folder**

找到 `if (databases.length === 0)` 分支，修改为：

```typescript
if (databases.length === 0) {
  // 无多数据库概念（如 SQLite）：category 直接挂在 connection 节点下
  children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
  children.push(makeMetricsFolderNode(nodeId, node.meta));  // 新增：追加在 categories 末尾
}
```

- [ ] **Step 2: 在 connection 节点的 !needsSchema 分支插入 metrics_folder**

找到 `if (!needsSchema)` 分支，修改为：

```typescript
if (!needsSchema) {
  children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
  children.push(makeMetricsFolderNode(dbId, { ...node.meta, database: db }));  // 新增：追加
}
```

- [ ] **Step 3: 在 database 节点（有 schema）分支插入 metrics_folder**

找到 `} else if (node.nodeType === 'database') {` 分支，修改为：

```typescript
} else if (node.nodeType === 'database') {
  const driver = node.meta.driver ?? 'postgres';
  if (['postgres', 'oracle'].includes(driver)) {
    const schemas = await invoke<string[]>('list_schemas', {
      connectionId: node.meta.connectionId,
      database: node.meta.database,
    });
    for (const schema of schemas) {
      const schemaId = `${nodeId}/schema_${schema}`;
      const schemaNode: TreeNode = {
        id: schemaId,
        nodeType: 'schema',
        label: schema,
        parentId: nodeId,
        hasChildren: true,
        loaded: false,
        meta: { ...node.meta, schema },
      };
      children.push(schemaNode);
    }
    // 新增：metrics_folder 追加在所有 schema 节点之后
    children.push(makeMetricsFolderNode(nodeId, node.meta));
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/store/treeStore.ts
git commit -m "feat(treeStore): insert metrics_folder node at correct positions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: loadChildren 新增 metrics_folder 分支

**Files:**
- Modify: `src/store/treeStore.ts`

- [ ] **Step 1: 在 loadChildren 的 try 块中添加 metrics_folder 分支**

在 `} else if (node.nodeType === 'table' || node.nodeType === 'view') {` 之前添加：

```typescript
} else if (node.nodeType === 'metrics_folder') {
  const { connectionId, database } = node.meta;
  const metrics = await invoke<Metric[]>('list_metrics_by_node', {
    connectionId,
    database: database ?? null,
    schema: null,
    status: null,
  });
  for (const m of metrics) {
    children.push({
      id: `${nodeId}/metric_${m.id}`,
      nodeType: 'metric',
      label: m.display_name,
      parentId: nodeId,
      hasChildren: false,
      loaded: true,
      meta: { ...node.meta, objectName: String(m.id) },
    });
  }
  // 在 _addNodes 之后单独更新 metricCounts 和 hasChildren
  // 此处先 push children，后续在 _addNodes 调用后处理
}
```

- [ ] **Step 2: 修改 loadChildren 中 _addNodes 调用后的逻辑**

找到 `get()._addNodes(children);` 之后，添加 metrics_folder 的特殊处理：

```typescript
get()._addNodes(children);

// metrics_folder 节点加载后更新 metricCounts 和 hasChildren
if (node.nodeType === 'metrics_folder') {
  const metrics = children.filter(c => c.nodeType === 'metric');
  set(s => ({
    metricCounts: new Map(s.metricCounts).set(nodeId, metrics.length),
    nodes: (() => {
      const n = new Map(s.nodes);
      const folder = n.get(nodeId);
      if (folder) n.set(nodeId, { ...folder, hasChildren: metrics.length > 0 });
      return n;
    })(),
  }));
}

set(s => {
  const newNodes = new Map(s.nodes);
  const updated = newNodes.get(nodeId);
  if (updated) newNodes.set(nodeId, { ...updated, loaded: true });
  return { nodes: newNodes };
});
```

- [ ] **Step 3: Commit**

```bash
git add src/store/treeStore.ts
git commit -m "feat(treeStore): add loadChildren branch for metrics_folder node

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: 新增 deleteMetricNode action

**Files:**
- Modify: `src/store/treeStore.ts`

- [ ] **Step 1: 实现 deleteMetricNode action**

在 `search` 方法之后、`_addNodes` 之前添加：

```typescript
deleteMetricNode: (nodeId: string) => {
  set(s => {
    const nodes = new Map(s.nodes);
    const searchIndex = new Map(s.searchIndex);
    const metricCounts = new Map(s.metricCounts);
    const node = nodes.get(nodeId);
    nodes.delete(nodeId);
    searchIndex.delete(nodeId);
    if (node?.parentId) {
      const count = metricCounts.get(node.parentId) ?? 0;
      metricCounts.set(node.parentId, Math.max(0, count - 1));
    }
    return { nodes, searchIndex, metricCounts };
  });
},

_addNodes: (newNodes: TreeNode[]) => {
  // ... 不变
},
```

- [ ] **Step 2: 修改 _removeSubtree 清理 metricCounts**

找到 `_removeSubtree` 方法，在删除子节点时同步清理 metricCounts：

```typescript
_removeSubtree: (nodeId: string) => {
  set(s => {
    const nodes = new Map(s.nodes);
    const searchIndex = new Map(s.searchIndex);
    const expandedIds = new Set(s.expandedIds);
    const metricCounts = new Map(s.metricCounts);  // 新增
    const toRemove: string[] = [];
    const queue = [nodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const [key, node] of nodes.entries()) {
        if (node.parentId === id) {
          toRemove.push(key);
          queue.push(key);
        }
      }
    }
    for (const id of toRemove) {
      nodes.delete(id);
      searchIndex.delete(id);
      expandedIds.delete(id);
      metricCounts.delete(id);  // 新增：清除被删子节点的计数
    }
    // 清除当前节点的计数（适用于 metrics_folder）
    metricCounts.delete(nodeId);  // 新增
    return { nodes, searchIndex, expandedIds, metricCounts };  // 修改：添加 metricCounts
  });
},
```

- [ ] **Step 3: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/store/treeStore.ts
git commit -m "feat(treeStore): add deleteMetricNode and clean metricCounts in _removeSubtree

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 3: 前端渲染

### Task 7: TreeNode 新增指标节点图标

**Files:**
- Modify: `src/components/Explorer/TreeNode.tsx`

- [ ] **Step 1: 导入 BarChart2 图标**

修改 lucide-react 导入：

```typescript
import {
  ChevronDown, ChevronRight, Loader2,
  Folder, FolderOpen, Database, Layers, TableProperties,
  LayoutDashboard, Code2, GitBranch, Zap, Columns3,
  Eye, Hash, BarChart2
} from 'lucide-react';
```

- [ ] **Step 2: 在 NODE_ICONS 中添加新节点类型图标**

修改 `NODE_ICONS` 对象：

```typescript
const NODE_ICONS: Record<NodeType, React.ElementType> = {
  group: Folder,
  connection: LayoutDashboard,
  database: Database,
  schema: Layers,
  category: Folder,
  table: TableProperties,
  view: Eye,
  function: Code2,
  procedure: GitBranch,
  trigger: Zap,
  event: Hash,
  sequence: Hash,
  materialized_view: Eye,
  dictionary: Hash,
  column: Columns3,
  metrics_folder: BarChart2,  // 新增
  metric: BarChart2,          // 新增
};
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Explorer/TreeNode.tsx
git commit -m "feat(TreeNode): add BarChart2 icon for metrics_folder and metric nodes

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: ContextMenu 新增指标菜单项

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`

- [ ] **Step 1: 新增 Props 回调**

修改 `ContextMenuProps` interface：

```typescript
interface ContextMenuProps {
  node: TreeNode;
  x: number;
  y: number;
  isConnected: boolean;
  onClose: () => void;
  onOpenConnection: () => void;
  onCloseConnection: () => void;
  onNewQuery: () => void;
  onRefresh: () => void;
  onEditConnection: () => void;
  onDeleteConnection: () => void;
  onCreateTable: () => void;
  onOpenTableData: () => void;
  onEditTable: () => void;
  onManageIndexes: () => void;
  onViewDdl: () => void;
  onTruncateTable: () => void;
  onDropTable: () => void;
  onExportTableData: () => void;
  onImportToTable: () => void;
  onCopyName: () => void;
  onMoveToGroup: () => void;
  onCreateGroup: () => void;
  onRenameGroup: () => void;
  onDeleteGroup: () => void;
  onCreateConnectionInGroup: () => void;
  onCreateDatabase: () => void;
  onExportDatabase?: () => void;
  onBackupDatabase?: () => void;
  onExportMultiTable?: () => void;
  // 新增指标相关回调
  onOpenMetricList?: () => void;
  onNewMetric?: () => void;
  onOpenMetric?: () => void;
  onDeleteMetric?: () => void;
}
```

- [ ] **Step 2: 更新组件参数解构**

修改组件参数：

```typescript
export const ContextMenu: React.FC<ContextMenuProps> = ({
  node, x, y, isConnected, onClose,
  onOpenConnection, onCloseConnection, onNewQuery, onRefresh,
  onEditConnection, onDeleteConnection, onCreateTable,
  onOpenTableData, onEditTable, onManageIndexes, onViewDdl, onTruncateTable, onDropTable,
  onExportTableData, onImportToTable, onCopyName,
  onMoveToGroup, onCreateGroup, onRenameGroup, onDeleteGroup, onCreateConnectionInGroup,
  onCreateDatabase,
  onExportDatabase,
  onBackupDatabase,
  onExportMultiTable,
  // 新增
  onOpenMetricList,
  onNewMetric,
  onOpenMetric,
  onDeleteMetric,
}) => {
```

- [ ] **Step 3: 导入新图标**

修改 lucide-react 导入：

```typescript
import {
  FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, FolderOpen, DatabaseZap, FolderInput,
  Code2, Eraser, Download, Upload, Database, Archive, PlugZap, Unplug, BarChart2, Plus
} from 'lucide-react';
```

- [ ] **Step 4: 在 getMenuItems 中添加指标菜单分支**

在 `switch (node.nodeType)` 中添加两个新 case（在 `default` 之前）：

```typescript
case 'metrics_folder':
  return [
    { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
    { label: t('contextMenu.openMetricList'), icon: BarChart2, onClick: onOpenMetricList || (() => {}), disabled: !onOpenMetricList, dividerBefore: true },
    { label: t('contextMenu.newMetric'), icon: Plus, onClick: onNewMetric || (() => {}), disabled: !onNewMetric },
    { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh, dividerBefore: true },
  ];
case 'metric':
  return [
    { label: t('contextMenu.openMetricList'), icon: Eye, onClick: onOpenMetric || (() => {}), disabled: !onOpenMetric },
    { label: t('contextMenu.deleteMetric'), icon: Trash2, onClick: onDeleteMetric || (() => {}), danger: true, dividerBefore: true },
  ];
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/ContextMenu.tsx
git commit -m "feat(ContextMenu): add menu items for metrics_folder and metric nodes

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: DBTree 新增指标节点渲染和交互

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`

- [ ] **Step 1: 新增 Props**

修改 `DBTreeProps` interface：

```typescript
interface DBTreeProps {
  searchQuery: string;
  showToast: (msg: string, level?: ToastLevel) => void;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  onOpenTableStructure: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
  activeConnectionIds: Set<number>;
  onOpenConnection: (connectionId: number) => void;
  onCloseConnection: (connectionId: number) => void;
  // 新增指标相关回调
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
}
```

- [ ] **Step 2: 更新组件参数解构**

```typescript
export const DBTree: React.FC<DBTreeProps> = ({
  searchQuery,
  showToast,
  onNewQuery,
  onOpenTableData,
  onOpenTableStructure,
  activeConnectionIds,
  onOpenConnection,
  onCloseConnection,
  // 新增
  onOpenMetricTab,
  onOpenMetricListTab,
}) => {
```

- [ ] **Step 3: 从 store 读取 metricCounts 和 deleteMetricNode**

修改 useTreeStore 调用：

```typescript
const { nodes, expandedIds, selectedId, loadingIds, metricCounts,
        toggleExpand, selectNode, refreshNode, search, deleteMetricNode } = useTreeStore();
```

- [ ] **Step 4: 修改 TreeNode 渲染，添加计数徽章**

找到 `{visibleNodes.map(node => (` 部分，修改为：

```tsx
{visibleNodes.map(node => {
  // metrics_folder 节点显示计数徽章
  const metricCountBadge = node.nodeType === 'metrics_folder' ? (() => {
    const count = metricCounts.get(node.id);
    return count !== undefined && count > 0
      ? <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">[{count}]</span>
      : null;
  })() : null;

  return (
    <TreeNode
      key={node.id}
      node={node}
      indent={getIndentLevel(node, nodes)}
      isExpanded={searchQuery.trim() ? !collapsedInSearch.has(node.id) : expandedIds.has(node.id)}
      isSelected={selectedId === node.id}
      isLoading={loadingIds.has(node.id)}
      onClick={() => handleNodeClick(node)}
      onContextMenu={(e) => handleContextMenu(e, node)}
      badge={metricCountBadge}
    />
  );
})}
```

- [ ] **Step 5: 修改 TreeNode 组件调用**

由于 TreeNode 当前不接受 badge prop，我们需要修改 TreeNode 组件。

先修改 DBTree 中的调用（使用 React.createElement 或直接在 TreeNode 外层包装）：

实际上更好的方式是直接修改 TreeNode 组件接受 badge prop。让我们先跳过这步，在 Task 10 中处理。

暂时在 DBTree 中使用包装方式渲染徽章：

```tsx
{visibleNodes.map(node => (
  <div key={node.id} className="flex items-center">
    <TreeNode
      node={node}
      indent={getIndentLevel(node, nodes)}
      isExpanded={searchQuery.trim() ? !collapsedInSearch.has(node.id) : expandedIds.has(node.id)}
      isSelected={selectedId === node.id}
      isLoading={loadingIds.has(node.id)}
      onClick={() => handleNodeClick(node)}
      onContextMenu={(e) => handleContextMenu(e, node)}
    />
    {node.nodeType === 'metrics_folder' && (() => {
      const count = metricCounts.get(node.id);
      return count !== undefined && count > 0
        ? <span className="text-[10px] text-[#7a9bb8] ml-[-4px]">[{count}]</span>
        : null;
    })()}
  </div>
))}
```

实际上这种包装方式会破坏缩进。更好的方案是修改 TreeNode 组件。

让我重新设计：在 TreeNode 内部根据 nodeType 渲染徽章，从 store 读取 metricCounts。

- [ ] **Step 4（修订）: 在 TreeNode 渲染逻辑中添加徽章**

修改 TreeNode 组件（在下一个 Task 中完成）。

先在 DBTree 中通过另一种方式实现：修改 TreeNode 组件接受额外 prop。

- [ ] **Step 6: 在 ContextMenu 中添加指标相关回调**

找到 ContextMenu 组件调用，添加新的 props：

```tsx
<ContextMenu
  node={contextMenu.node}
  x={contextMenu.x}
  y={contextMenu.y}
  isConnected={activeConnectionIds.has(getConnectionId(contextMenu.node))}
  onClose={() => setContextMenu(null)}
  // ... 现有 props 不变 ...
  onExportMultiTable={
    (contextMenu.node.nodeType === 'category' && contextMenu.node.meta.objectName === 'tables')
      ? () => {
          const n = contextMenu.node;
          setContextMenu(null);
          setExportWizard({
            connectionId: getConnectionId(n),
            database: n.meta.database,
            schema: n.meta.schema,
            initialScope: 'multi_table',
          });
        }
      : undefined
  }
  // 新增指标相关回调
  onOpenMetricList={() => {
    const n = contextMenu.node;
    setContextMenu(null);
    const scope = {
      connectionId: getConnectionId(n),
      database: n.meta.database,
      schema: n.meta.schema,
    };
    const connName = getConnName(n);
    const dbPart = n.meta.database ? ` / ${n.meta.database}` : '';
    const title = `${connName}${dbPart} - ${t('dbTree.metrics')}`;
    onOpenMetricListTab?.(scope, title);
  }}
  onNewMetric={() => {
    const n = contextMenu.node;
    setContextMenu(null);
    const scope = {
      connectionId: getConnectionId(n),
      database: n.meta.database,
      schema: n.meta.schema,
    };
    const connName = getConnName(n);
    const dbPart = n.meta.database ? ` / ${n.meta.database}` : '';
    const scopeTitle = `${connName}${dbPart}`;
    useQueryStore.getState().openNewMetricTab(scope, scopeTitle);
  }}
  onOpenMetric={() => {
    const n = contextMenu.node;
    setContextMenu(null);
    const metricId = Number(n.meta.objectName);
    const connectionId = n.meta.connectionId;
    onOpenMetricTab?.(metricId, n.label, connectionId);
  }}
  onDeleteMetric={async () => {
    const n = contextMenu.node;
    if (!await confirm({ message: t('dbTree.confirmDeleteMetric', { name: n.label }), variant: 'danger' })) return;
    const metricId = Number(n.meta.objectName);
    try {
      await invoke('delete_metric', { id: metricId });
      deleteMetricNode(n.id);
      useQueryStore.getState().closeMetricTabById(metricId);
      showToast(t('dbTree.operationSuccess'), 'success');
    } catch (e) {
      showToast(String(e), 'error');
    }
  }}
/>
```

- [ ] **Step 7: Commit**

```bash
git add src/components/Explorer/DBTree.tsx
git commit -m "feat(DBTree): add metric node callbacks and context menu handlers

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: TreeNode 支持徽章渲染

**Files:**
- Modify: `src/components/Explorer/TreeNode.tsx`

- [ ] **Step 1: 新增 badge prop**

修改 `TreeNodeProps` interface：

```typescript
interface TreeNodeProps {
  node: TreeNodeType;
  indent: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  badge?: React.ReactNode;  // 新增
}
```

- [ ] **Step 2: 更新组件参数解构**

```typescript
export const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  indent,
  isExpanded,
  isSelected,
  isLoading,
  onClick,
  onDoubleClick,
  onContextMenu,
  badge,  // 新增
}) => {
```

- [ ] **Step 3: 在 label 之后渲染徽章**

修改渲染部分：

```tsx
<span
  className={`text-[13px] truncate ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}
>
  {displayLabel}
</span>
{badge}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Explorer/TreeNode.tsx
git commit -m "feat(TreeNode): add badge prop for metrics_folder count display

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: DBTree 传递徽章给 TreeNode

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`

- [ ] **Step 1: 修改 TreeNode 渲染逻辑传递 badge**

```tsx
{visibleNodes.map(node => {
  // metrics_folder 节点显示计数徽章
  const metricCountBadge = node.nodeType === 'metrics_folder' ? (() => {
    const count = metricCounts.get(node.id);
    return count !== undefined && count > 0
      ? <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">[{count}]</span>
      : null;
  })() : null;

  return (
    <TreeNode
      key={node.id}
      node={node}
      indent={getIndentLevel(node, nodes)}
      isExpanded={searchQuery.trim() ? !collapsedInSearch.has(node.id) : expandedIds.has(node.id)}
      isSelected={selectedId === node.id}
      isLoading={loadingIds.has(node.id)}
      onClick={() => handleNodeClick(node)}
      onContextMenu={(e) => handleContextMenu(e, node)}
      badge={metricCountBadge}
    />
  );
})}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Explorer/DBTree.tsx
git commit -m "feat(DBTree): pass metric count badge to TreeNode for metrics_folder

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 4: Props 透传和入口隐藏

### Task 12: Explorer 透传指标回调 Props

**Files:**
- Modify: `src/components/Explorer/index.tsx`

- [ ] **Step 1: 新增 ExplorerProps 的指标回调**

修改 `ExplorerProps` interface：

```typescript
interface ExplorerProps {
  isSidebarOpen: boolean;
  sidebarWidth: number;
  handleSidebarResize: (e: React.MouseEvent) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  activeActivity: string;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  onOpenTableStructure: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
  // 新增指标相关回调
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
}
```

- [ ] **Step 2: 更新组件参数解构**

```typescript
export const Explorer: React.FC<ExplorerProps> = ({
  isSidebarOpen,
  sidebarWidth,
  handleSidebarResize,
  showToast,
  searchQuery,
  setSearchQuery,
  activeActivity,
  onNewQuery,
  onOpenTableData,
  onOpenTableStructure,
  // 新增
  onOpenMetricTab,
  onOpenMetricListTab,
}) => {
```

- [ ] **Step 3: 透传给 DBTree**

找到 `<DBTree` 调用，添加新的 props：

```tsx
<DBTree
  searchQuery={searchQuery}
  showToast={showToast}
  onNewQuery={onNewQuery}
  onOpenTableData={onOpenTableData}
  onOpenTableStructure={onOpenTableStructure}
  activeConnectionIds={activeConnectionIds}
  onOpenConnection={handleOpenConnection}
  onCloseConnection={handleCloseConnection}
  onOpenMetricTab={onOpenMetricTab}
  onOpenMetricListTab={onOpenMetricListTab}
/>
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Explorer/index.tsx
git commit -m "feat(Explorer): add and forward metric callback props to DBTree

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 13: App.tsx 连接指标回调

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 找到 Explorer 组件调用位置并添加 props**

在 `App.tsx` 中找到 `<Explorer` 调用，添加：

```tsx
<Explorer
  // ... 现有 props 不变 ...
  onOpenMetricTab={useQueryStore.getState().openMetricTab}
  onOpenMetricListTab={useQueryStore.getState().openMetricListTab}
/>
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat(App): connect metric callbacks from queryStore to Explorer

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 14: 隐藏 ActivityBar 指标入口

**Files:**
- Modify: `src/components/ActivityBar/index.tsx`

- [ ] **Step 1: 移除或隐藏独立的「业务指标」ActivityBar 入口**

找到「业务指标」(metrics) 入口代码，用条件渲染隐藏：

```tsx
{/* 指标入口临时隐藏，MetricsExplorer 代码保留，后续可恢复 */}
{false && (
  <Tooltip content={!isExpanded ? t('activity.metrics') : undefined}>
    <div
      className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'metrics' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
      onClick={() => {
        setActiveActivity('metrics');
        setIsSidebarOpen(true);
      }}
    >
      <Activity size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
      {isExpanded && <span className="text-[13px] truncate">{t('activity.metrics')}</span>}
    </div>
  </Tooltip>
)}
```

或者直接删除该入口代码块。

根据设计文档要求「原 MetricsExplorer 面板代码保留，ActivityBar 入口隐藏」，使用 `{false && ...}` 方式更安全。

- [ ] **Step 2: Commit**

```bash
git add src/components/ActivityBar/index.tsx
git commit -m "feat(ActivityBar): hide standalone metrics entry point

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 5: 验证和测试

### Task 15: 类型检查和编译验证

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（无类型错误）

- [ ] **Step 2: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 3: 修复任何发现的问题**

如果有类型错误，根据错误信息修复。

---

### Task 16: 手动功能验证

- [ ] **Step 1: 启动开发服务器**

Run: `npm run tauri:dev`

- [ ] **Step 2: 验证指标目录显示**

1. 展开一个数据库连接
2. 确认在正确位置（schema 之后或 category 之后）显示「指标」目录
3. 确认目录图标正确（BarChart2）

- [ ] **Step 3: 验证指标目录展开**

1. 点击「指标」目录展开
2. 确认显示该数据库下的指标列表
3. 确认计数徽章显示正确（如 [3]）

- [ ] **Step 4: 验证右键菜单**

1. 右键点击「指标」目录
2. 确认显示「打开指标列表」「新建指标」「刷新」菜单项
3. 右键点击单个指标
4. 确认显示「打开」「删除」菜单项

- [ ] **Step 5: 验证删除指标**

1. 右键点击指标 → 删除
2. 确认显示确认弹窗
3. 确认删除后指标节点消失，计数徽章更新

- [ ] **Step 6: 验证 ActivityBar 入口隐藏**

1. 确认 ActivityBar 中不再显示「业务指标」独立入口

---

### Task 17: 最终 Commit

- [ ] **Step 1: 确认所有更改已提交**

Run: `git status`
Expected: 无未提交更改

- [ ] **Step 2: 创建汇总 commit（如有遗漏文件）**

```bash
git add -A
git commit -m "feat(metrics): integrate metrics folder into database tree

- Add metrics_folder and metric node types
- Render metrics folder at correct positions based on database driver
- Support right-click context menu for metric operations
- Hide standalone ActivityBar metrics entry
- Display metric count badge on metrics_folder node

Closes: docs/superpowers/specs/2026-03-25-metrics-in-db-tree-design.md

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## 完成标志

- [ ] 所有 TypeScript 类型检查通过
- [ ] Rust 编译通过
- [ ] 指标目录在数据库树中正确显示
- [ ] 右键菜单功能正常
- [ ] 删除指标后计数更新正确
- [ ] ActivityBar 指标入口已隐藏
