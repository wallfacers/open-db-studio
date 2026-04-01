<!-- STATUS: ✅ 已实现 -->
# 设计规格：指标目录集成到数据库树

**日期**：2026-03-25
**状态**：已批准（v2 修订）
**作者**：Claude Code (brainstorming)

---

## 背景

当前「业务指标」功能通过独立的 ActivityBar 入口（MetricsExplorer 面板）访问，与数据库树完全分离。用户希望将指标目录直接集成到数据库连接树中，方便在浏览数据库对象的同时管理指标，并因为指标查询可以跨 schema，因此指标目录需要与 schema 节点同级。

原 MetricsExplorer 面板代码保留，ActivityBar 入口隐藏。

---

## 目标

1. 在数据库树的每个数据库（或连接）节点下，新增「指标」目录节点
2. 指标目录与表/视图等 category 节点平级（对于有 schema 的数据库则与 schema 同级）
3. 展开指标目录后显示该 database 下的所有指标子节点
4. 目录节点上显示指标数量徽章 `[N]`
5. 右键菜单支持：打开指标列表、新建指标、刷新（目录）；打开、删除（指标节点）
6. 隐藏 ActivityBar 中的「业务指标」图标入口

---

## 不在范围内

- 修改 `metricsTreeStore` 或 `MetricsExplorer` 组件
- 在 schema 层内添加指标目录（指标始终挂在 database 级）
- 新增 Rust 后端命令（复用现有 `list_metrics_by_node`、`delete_metric`）
- 搜索功能对 `metric` 节点的索引扩展（可后续迭代）

---

## 插入位置规则

| 数据库驱动 | 指标目录位置 |
|-----------|------------|
| PostgreSQL、Oracle（有 schema） | `database` 节点下，与 schema 节点同级，排在所有 schema 之后 |
| MySQL、SQL Server、Doris、ClickHouse、TiDB（有 database，无 schema） | `database` 节点下，与 category 节点同级，排在所有 category 之后 |
| SQLite（无 database） | `connection` 节点下，与 category 节点同级，排在所有 category 之后 |

判断逻辑沿用 treeStore 现有的 `needsSchema` 标志：
```typescript
const needsSchema = ['postgres', 'oracle'].includes(driver);
```

后续新增数据库驱动只需维护此条件，无需逐类型枚举。

---

## 架构变更

### 受影响文件

| 文件 | 改动性质 |
|------|---------|
| `src/types/index.ts` | NodeType 新增 `metrics_folder` \| `metric` |
| `src/store/treeStore.ts` | 新增 `metricCounts` Map；插入逻辑；loadChildren 新分支；deleteMetricNode action；refreshNode/\_removeSubtree 清除 metricCounts |
| `src/components/Explorer/DBTree.tsx` | 渲染新节点类型；右键菜单；新增 Props 回调 |
| `src/components/Explorer/index.tsx` | 新增 Props 定义并透传 `onOpenMetricTab` / `onOpenMetricListTab` 回调 |
| `src/components/ActivityBar/index.tsx` | 隐藏指标图标（保留代码） |

---

## 详细设计

### 1. NodeType 扩展（`types/index.ts`）

```typescript
export type NodeType =
  | 'group' | 'connection' | 'database' | 'schema'
  | 'category' | 'table' | 'view' | 'function'
  | 'procedure' | 'trigger' | 'event' | 'sequence'
  | 'materialized_view' | 'dictionary' | 'column'
  | 'metrics_folder'   // 新增：指标目录节点
  | 'metric';          // 新增：单个指标叶节点
```

`NodeMeta` 接口不变；`metric` 节点复用 `objectName` 字段存储 metricId（string 类型）。
从 `metric` 节点取 metricId 时须显式转换：`const metricId = Number(node.meta.objectName)`。

---

### 2. treeStore 改动（`store/treeStore.ts`）

#### 新增状态

```typescript
interface TreeStore {
  metricCounts: Map<string, number>;    // key = metrics_folder 节点 ID，value = 指标数量
  deleteMetricNode: (nodeId: string) => void;
}
// 初始值
metricCounts: new Map(),
```

#### 辅助函数

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

> **注意**：`hasChildren: true` 是初始占位值，展开前用户会看到展开箭头。
> 加载完成后 `loadChildren` 会将其修正为 `metrics.length > 0`（与现有 category 节点行为一致）。

#### Tauri invoke 参数约定

treeStore 中所有 `invoke` 调用均使用 camelCase 键名（如 `connectionId`、`database`），
Tauri 2.x 配置了全局 `camelCase → snake_case` 转换，Rust 命令接收 snake_case 参数。
本设计沿用此约定，无需额外处理。

---

#### 插入时机

**SQLite（无 database）** — `connection` 节点，`databases.length === 0`：
```typescript
children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
children.push(makeMetricsFolderNode(nodeId, node.meta));  // 追加在 categories 末尾
```

**MySQL 等（有 database，无 schema）** — `connection` 节点的 db 循环内，`!needsSchema` 分支：
```typescript
if (!needsSchema) {
  children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
  children.push(makeMetricsFolderNode(dbId, { ...node.meta, database: db }));  // 追加
}
```

**PostgreSQL/Oracle（有 schema）** — `database` 节点 loadChildren 分支，schema 循环结束后追加：
```typescript
// 原有 database 节点分支（loadChildren 中）：
} else if (node.nodeType === 'database') {
  const driver = node.meta.driver ?? 'postgres';
  if (['postgres', 'oracle'].includes(driver)) {
    const schemas = await invoke<string[]>('list_schemas', {
      connectionId: node.meta.connectionId,
      database: node.meta.database,
    });
    for (const schema of schemas) {
      const schemaId = `${nodeId}/schema_${schema}`;
      children.push({
        id: schemaId,
        nodeType: 'schema',
        label: schema,
        parentId: nodeId,
        hasChildren: true,
        loaded: false,
        meta: { ...node.meta, schema },
      });
    }
    // 新增：metrics_folder 追加在所有 schema 节点之后
    children.push(makeMetricsFolderNode(nodeId, node.meta));
  }
}
```

---

#### loadChildren 新分支（metrics_folder）

遵循现有模式：子节点 push 到 `children`，由外层统一调用 `_addNodes(children)` 注册，
再由外层统一 `set` 将父节点标记为 `loaded: true`。
`metricCounts` 通过额外的 `set` 在 `_addNodes` 调用之后单独更新。

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
  // metrics_folder 的 hasChildren 在外层 set loaded:true 时一并修正
  // metricCounts 在外层 _addNodes 调用后单独 set：
  // （在 try 块末尾 _addNodes(children) 之后追加）
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
```

> 外层的 `_addNodes(children)` 会将所有 `metric` 子节点同时写入 `nodes` 和 `searchIndex`，
> 然后额外的 `set` 再更新 `metricCounts` 和 `hasChildren`，不存在双写冲突。

---

#### deleteMetricNode action

须同时清理 `nodes`、`searchIndex`、`metricCounts`：

```typescript
deleteMetricNode: (nodeId: string) => {
  set(s => {
    const nodes = new Map(s.nodes);
    const searchIndex = new Map(s.searchIndex);
    const metricCounts = new Map(s.metricCounts);
    const node = nodes.get(nodeId);
    nodes.delete(nodeId);
    searchIndex.delete(nodeId);          // 同步清理搜索索引
    if (node?.parentId) {
      const count = metricCounts.get(node.parentId) ?? 0;
      metricCounts.set(node.parentId, Math.max(0, count - 1));
    }
    return { nodes, searchIndex, metricCounts };
  });
},
```

---

#### refreshNode / _removeSubtree 清理 metricCounts

`refreshNode` 调用 `_removeSubtree` 后，需清除被刷新节点对应的 `metricCounts` 条目，
否则刷新后徽章会残留旧数值直到下次 `loadChildren` 覆盖。

在 `refreshNode` 的现有逻辑中，清除子树后追加：
```typescript
// refreshNode 中，removeChildren(nodeId) 之后：
set(s => {
  const metricCounts = new Map(s.metricCounts);
  metricCounts.delete(nodeId);   // 清除当前节点的计数（适用于 metrics_folder）
  return { metricCounts };
});
```

`_removeSubtree` 本身递归删除子节点时，也需同步删除这些子节点的 `metricCounts` 条目：
```typescript
// _removeSubtree 递归删除时追加
metricCounts.delete(id);   // 清除被删子节点的计数
```

---

### 3. DBTree 渲染（`components/Explorer/DBTree.tsx`）

#### 新增 Props

```typescript
interface DBTreeProps {
  // 新增
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
}
```

#### 从 store 读取 metricCounts

```typescript
const { nodes, expandedIds, selectedId, loadingIds, metricCounts,
        toggleExpand, selectNode, refreshNode, search,
        deleteMetricNode } = useTreeStore();
```

#### 图标

```typescript
import { BarChart2 } from 'lucide-react';

// metrics_folder → BarChart2（折叠/展开同图标，用颜色区分展开状态）
// metric         → BarChart2（metricType 未存入 meta，统一使用 BarChart2）
```

#### 计数徽章

```tsx
{node.nodeType === 'metrics_folder' && (() => {
  const count = metricCounts.get(node.id);
  return count !== undefined && count > 0
    ? <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">[{count}]</span>
    : null;
})()}
```

#### 右键菜单

**metrics_folder 节点**：
- 「打开指标列表」→ `onOpenMetricListTab?.({ connectionId, database }, scopeTitle)`
- 「新建指标」→ `useQueryStore.getState().openNewMetricTab({ connectionId, database }, scopeTitle)`
- 分隔线
- 「刷新」→ `refreshNode(node.id)`

**metric 节点**（取 metricId 须显式转换）：
```typescript
const metricId = Number(node.meta.objectName);  // objectName 存的是 String(m.id)
const connectionId = node.meta.connectionId!;
```
- 「打开」→ `onOpenMetricTab?.(metricId, node.label, connectionId)`
- 分隔线
- 「删除」：
  1. 确认弹窗（复用 `useConfirm`）
  2. `await invoke('delete_metric', { id: metricId })`
  3. `deleteMetricNode(node.id)`
  4. `useQueryStore.getState().closeMetricTabById(metricId)`

---

### 4. Explorer/index.tsx — Props 扩展与透传

```typescript
// ExplorerProps 新增两个可选回调：
interface ExplorerProps {
  // 现有 props 不变...
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
}

// DBTree 调用处增加透传：
<DBTree
  // 现有 props 不变...
  onOpenMetricTab={onOpenMetricTab}
  onOpenMetricListTab={onOpenMetricListTab}
/>
```

调用方（`App.tsx`）将这两个回调从 `queryStore` 连接处传入，复用现有的 `openMetricTab` / `openNewMetricTab`。

---

### 5. ActivityBar 隐藏（`components/ActivityBar/index.tsx`）

```tsx
{/* 指标入口临时隐藏，MetricsExplorer 代码保留，后续可恢复 */}
{false && <MetricsActivityButton />}
```

---

## 数据流图

```
用户展开 metrics_folder
  ↓
treeStore.toggleExpand(folderId)
  → loadChildren(folderId)
    → invoke('list_metrics_by_node', { connectionId, database, schema: null })
    → 生成 metric[] 子节点，push 进 children
    → _addNodes(children) — 写入 nodes + searchIndex
    → set metricCounts[folderId] = metrics.length
    → set nodes[folderId].hasChildren = metrics.length > 0
  ↓
DBTree 渲染：metric 节点列表 + metrics_folder 上的 [N] 徽章

用户右键 metric → 删除
  ↓
const metricId = Number(node.meta.objectName)
  ↓
invoke('delete_metric', { id: metricId })
  ↓
treeStore.deleteMetricNode(nodeId)
  → 清理 nodes、searchIndex、metricCounts（父目录计数 -1）
  ↓
queryStore.closeMetricTabById(metricId)

用户右键 metrics_folder → 刷新
  ↓
treeStore.refreshNode(folderId)
  → _removeSubtree：删除所有 metric 子节点（nodes + searchIndex + metricCounts 子项）
  → 清除 metricCounts[folderId]
  → 重置 loaded: false
  → loadChildren(folderId) 重新加载
```

---

## i18n 键

| 键 | 默认值（中文） |
|----|--------------|
| `dbTree.metrics` | 指标 |
| `dbTree.openMetricList` | 打开指标列表 |
| `dbTree.newMetric` | 新建指标 |
| `dbTree.deleteMetric` | 删除指标 |
| `dbTree.confirmDeleteMetric` | 确认删除指标 "{{name}}"？ |

---

## 边界情况

| 场景 | 处理方式 |
|------|---------|
| 该数据库下无指标 | 加载后 `hasChildren: false`，不显示 `[N]`；加载前展开箭头可见（与现有 category 节点行为一致） |
| 加载失败 | 沿用现有 loadChildren 错误处理：折叠节点，设置 `error` 状态 |
| 指标被 MetricsExplorer 面板删除 | treeStore 不感知，用户手动刷新指标目录后同步（跨面板实时同步不在本期范围） |
| 新建指标后计数更新 | 新建成功后调用 `refreshNode(folderId)` 重新加载子节点并更新计数 |
| refreshNode 后 metricCounts | refreshNode 显式删除 `metricCounts[folderId]`，徽章消失；重新加载后恢复正确数值 |
| searchIndex 与 metric 节点 | `_addNodes` 写入，`deleteMetricNode` 同步删除，保持一致 |
