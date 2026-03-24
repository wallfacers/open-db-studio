# 设计规格：指标目录集成到数据库树

**日期**：2026-03-25
**状态**：已批准
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
| `src/store/treeStore.ts` | 新增 `metricCounts` Map；插入逻辑；loadChildren 新分支；deleteMetricNode action |
| `src/components/Explorer/DBTree.tsx` | 渲染新节点类型；右键菜单；新增 Props 回调 |
| `src/components/Explorer/index.tsx` | 透传 `onOpenMetricTab` / `onOpenMetricListTab` 回调 |
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

---

### 2. treeStore 改动（`store/treeStore.ts`）

#### 新增状态

```typescript
interface TreeStore {
  metricCounts: Map<string, number>;  // key = metrics_folder 节点 ID
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
    label: 'dbTree.metrics',  // i18n key，渲染时调用 t()
    parentId,
    hasChildren: true,
    loaded: false,
    meta: { ...meta },
  };
}
```

#### 插入时机

**SQLite（无 database）**：
```typescript
// connection 节点，databases.length === 0
children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
children.push(makeMetricsFolderNode(nodeId, node.meta));
```

**MySQL 等（有 database，无 schema）**：
```typescript
if (!needsSchema) {
  children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
  children.push(makeMetricsFolderNode(dbId, { ...node.meta, database: db }));
}
```

**PostgreSQL/Oracle（有 schema）**：
```typescript
// database 节点，schemas 加载完毕后末尾追加
children.push(makeMetricsFolderNode(nodeId, node.meta));
```

#### loadChildren 新分支

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
  set(s => ({
    metricCounts: new Map(s.metricCounts).set(nodeId, metrics.length),
    nodes: (() => {
      const n = new Map(s.nodes);
      n.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
      return n;
    })(),
  }));
}
```

#### deleteMetricNode action

```typescript
deleteMetricNode: (nodeId: string) => {
  set(s => {
    const nodes = new Map(s.nodes);
    const metricCounts = new Map(s.metricCounts);
    const node = nodes.get(nodeId);
    nodes.delete(nodeId);
    // 递减父目录计数
    if (node?.parentId) {
      const count = metricCounts.get(node.parentId) ?? 0;
      metricCounts.set(node.parentId, Math.max(0, count - 1));
    }
    return { nodes, metricCounts };
  });
},
```

---

### 3. DBTree 渲染（`components/Explorer/DBTree.tsx`）

#### 新增 Props

```typescript
interface DBTreeProps {
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
}
```

#### 图标

```typescript
import { BarChart2 } from 'lucide-react';

// metrics_folder → BarChart2（折叠/展开同图标，用颜色区分状态）
// metric         → BarChart2
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

**metric 节点**：
- 「打开」→ `onOpenMetricTab?.(metricId, node.label, connectionId)`
- 分隔线
- 「删除」→ 确认弹窗 → `invoke('delete_metric', { id: metricId })` → `deleteMetricNode(node.id)` → `closeMetricTabById(metricId)`

---

### 4. ActivityBar 隐藏（`components/ActivityBar/index.tsx`）

```tsx
{/* 指标入口临时隐藏，MetricsExplorer 代码保留 */}
{false && <MetricsActivityButton />}
```

---

## 数据流图

```
用户展开 metrics_folder
  ↓
treeStore.toggleExpand(folderId)
  ↓
treeStore.loadChildren(folderId)
  ↓
invoke('list_metrics_by_node', { connectionId, database, schema: null })
  ↓
生成 metric[] 子节点 + 更新 metricCounts
  ↓
DBTree 渲染：显示 metric 节点列表 + metrics_folder 上的 [N] 徽章

用户右键 metric → 删除
  ↓
invoke('delete_metric', { id: metricId })
  ↓
treeStore.deleteMetricNode(nodeId)      // 移除节点 + 递减父目录计数
  ↓
queryStore.closeMetricTabById(metricId) // 关闭对应 Tab
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
| 该数据库下无指标 | `metrics_folder` 节点 `hasChildren: false`，展开后显示空，不显示 `[N]` |
| 加载失败 | 沿用现有 loadChildren 错误处理：折叠节点，设置 `error` 状态 |
| 指标被 MetricsExplorer 面板删除 | treeStore 不感知，下次用户手动刷新指标目录后同步 |
| 新建指标后计数更新 | 新建成功后调用 `refreshNode(folderId)` 重新加载子节点并更新计数 |
