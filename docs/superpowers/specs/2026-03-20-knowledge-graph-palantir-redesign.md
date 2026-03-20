# Knowledge Graph — Palantir Ontology 风格改造设计文档

**日期**: 2026-03-20
**状态**: 已批准
**范围**: `src/components/GraphExplorer/` + Rust `build_schema_graph` 命令

---

## 背景与目标

当前 GraphExplorer 的节点卡片信息极简（仅 name + type badge），边只携带 `edge_type` 和 `weight` 两个字段，Edge 是二等公民。

本次改造参考两个设计参照系：
- **Neo4j Browser**：节点直接展示属性列表，画布即是信息
- **Palantir 本体论方法论**：Link 是一等公民，与 Object 同等地位，携带丰富属性，可独立选中、编辑、查询

**改造目标**：
1. Object 节点卡片升级为 Palantir Object Type 风格（图标 + Key Properties + Links 计数）
2. Link（Edge）升级为独立 ReactFlow 节点，居中渲染于两端 Object 节点之间
3. Link 节点携带完整属性：`cardinality / via / on_delete / description / weight / is_inferred`

---

## 数据模型设计

### 不变部分

`graph_nodes` 和 `graph_edges` 表结构**不增加新列**。Link Node 复用现有 `graph_nodes` 表，通过 `node_type = 'link'` 区分。

### Node ID 命名约定

**Object Node id**：`"{connection_id}_{table_name}"`，例如 `"1_orders"`。这是现有 `build_schema_graph` 的命名规则，本次不变。

**Link Node id**：`"link_{connection_id}_{from_table}_{to_table}_{via_field}"`，例如 `"link_1_orders_users_user_id"`。

`linkCountMap` 使用 Object Node 的完整 id（含 `connection_id` 前缀）与 Link Node metadata 中的 `source_node_id` / `target_node_id` 匹配（见下方 metadata 结构）。

### Link Node 存储

每条 FK 关系在 `build_schema_graph` 时产生：
- **1 个 Link Node**（存入 `graph_nodes`）
- **2 条 Edge**（存入 `graph_edges`）：`source_node_id → link_node_id`，`link_node_id → target_node_id`

原来的单跳直连边（`source → target`）**不再写入**，所有关联关系统一走两段式结构。

Link Node 字段映射：

| graph_nodes 列 | Link Node 值 |
|----------------|-------------|
| `id` | `"link_{conn}_{from_table}_{to_table}_{via_field}"` |
| `node_type` | `"link"` |
| `name` | `"{edge_type}"` (如 `"fk"`) |
| `display_name` | `"{from_table} → {to_table}"` |
| `metadata` | Link 属性 JSON（见下） |
| `connection_id` | 同所属连接 |
| `source` | `"schema_introspection"` |

Link Node `metadata` JSON 结构：

```json
{
  "edge_type": "fk",
  "cardinality": "N:1",
  "via": "user_id",
  "on_delete": "CASCADE",
  "description": "",
  "weight": 0.95,
  "is_inferred": true,
  "source_table": "orders",
  "target_table": "users",
  "source_node_id": "1_orders",
  "target_node_id": "1_users"
}
```

`source_node_id` / `target_node_id` 与 Object Node 的 id 完全一致，供前端 `linkCountMap` 匹配使用。

### Cardinality 推断规则

| 条件 | Cardinality |
|------|-------------|
| via 字段有唯一约束（UNIQUE INDEX） | `1:1` |
| via 字段无唯一约束 | `N:1` |
| 多字段复合 FK | `N:M`（保守估计） |

---

## Rust 后端变更

### 1. `build_schema_graph`（各 driver）

**文件**: `src-tauri/src/datasource/`（各 driver 的 `build_schema_graph` 实现）

变更逻辑（伪代码）：

```rust
for fk in foreign_keys {
    let source_node_id = format!("{}_{}", connection_id, fk.from_table);
    let target_node_id = format!("{}_{}", connection_id, fk.to_table);
    let link_id = format!("link_{}_{}_{}", connection_id, fk.from_table, fk.to_table, fk.column);
    let cardinality = infer_cardinality(&fk, &unique_indexes);

    let metadata = json!({
        "edge_type": "fk",
        "cardinality": cardinality,
        "via": fk.column,
        "on_delete": fk.on_delete,
        "description": "",
        "weight": 0.95,
        "is_inferred": true,
        "source_table": fk.from_table,
        "target_table": fk.to_table,
        "source_node_id": source_node_id,
        "target_node_id": target_node_id,
    });

    // 插入 Link Node（替代旧的直连边）
    insert_graph_node(&link_id, "link", &fk.edge_type, &metadata.to_string());

    // 插入两条边（不再插入直连边）
    insert_graph_edge(&source_node_id, &link_id, "to_link", 1.0);
    insert_graph_edge(&link_id, &target_node_id, "from_link", 1.0);
}
```

**`get_graph_nodes`** 和 **`get_graph_edges`** 命令无需改动，透明返回 Link Node 数据。

### 2. 新增 `update_graph_node_metadata` 命令

**文件**: `src-tauri/src/commands.rs`

用于前端 NodeDetail 面板编辑 Link Node 的 `description` 字段后保存回 SQLite。

```rust
#[tauri::command]
pub async fn update_graph_node_metadata(
    state: tauri::State<'_, AppState>,
    node_id: String,
    metadata: String,  // 完整 JSON 字符串
) -> Result<(), String> {
    let db = state.db.lock().await;
    db.execute(
        "UPDATE graph_nodes SET metadata = ?1 WHERE id = ?2",
        rusqlite::params![metadata, node_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

需在 `lib.rs` 的 `generate_handler![]` 中注册：`update_graph_node_metadata`。

---

## 前端组件设计

### 节点组件改造策略

现有 `GraphNodeComponents.tsx` 导出三个独立组件：`TableNodeComponent`、`MetricNodeComponent`、`AliasNodeComponent`，均基于共用的 `BaseNode`。

**改造方式**：将 `BaseNode` 升级为 Palantir Object Type 风格（不删除现有三个具名导出），三个现有组件各自透传新 `BaseNode` 的 props。新增 `LinkNodeComponent` 作为独立导出。`nodeTypes.ts` 保持现有的三路注册，新增 `link` 项：

```typescript
// nodeTypes.ts（最终状态）
export const nodeTypes = {
  table:  TableNodeComponent,   // 保留，内部使用升级后的 BaseNode
  metric: MetricNodeComponent,  // 保留
  alias:  AliasNodeComponent,   // 保留
  link:   LinkNodeComponent,    // 新增
};
```

### 改造 `BaseNode`（Object Node 统一基础）

升级为 Palantir Object Type 风格，保持现有主题色体系（table=`#3794ff`，metric=`#f59e0b`，alias=`#a855f7`）：

```
┌──────────────────────────────────────────┐
│  [icon]  orders              7✦  3⇌      │  ← 图标+name + props/links 计数徽章
│          Object Type · TABLE              │  ← 副标题
├──────────────────────────────────────────┤
│  id           Primary Key                 │  ← Key Properties（最多3条）
│  user_id      FK                          │
│  status       ENUM                        │
├──────────────────────────────────────────┤
│  #用户订单  #业务核心表                    │  ← aliases 标签（有则显示）
└──────────────────────────────────────────┘
```

图标映射（lucide-react）：`table → Database`、`metric → BarChart2`、`alias → Hash`

props 计数：`metadata` JSON 数组长度。links 计数：`data.linkCount`（`toFlowNodes` 时注入，见下文）。

节点宽度从 `200px` 扩展为 `240px`，高度自适应。

### 新增 `LinkNodeComponent`

**文件**: `src/components/GraphExplorer/GraphNodeComponents.tsx`（新增导出）

外观规格：
- 宽度：`260px`，高度：自适应（约 `60-80px`）
- 边框：`1.5px solid #00c9a7`（项目现有 accent 色）
- 背景：`#111922`（与 Object Node 一致）
- `is_inferred = true` 时：边框改为 `border-dashed border-[#00c9a7]`
- Handle：左（target）+ 右（source）

卡片内容布局：
```
┌─────────────────────────────────────────┐
│  ⇌  fk                        N:1      │  ← edge_type + cardinality（右对齐）
│  via: user_id  ·  on_delete: CASCADE    │  ← 关键属性行
│  orders → users                         │  ← 方向说明（display_name）
└─────────────────────────────────────────┘
```

description 非空时在第四行显示（`italic text-[#7a9bb8]`）。

### `toFlowNodes` 扩展

在 `index.tsx` 的 `toFlowNodes` 函数中，注入 `linkCount`：

```typescript
// 在 filteredRaw 计算完成后，统计每个 Object Node 关联的 Link Node 数量
const linkCountMap: Record<string, number> = {};
filteredRaw
  .filter(n => n.node_type === 'link')
  .forEach(n => {
    try {
      const meta = JSON.parse(n.metadata || '{}');
      if (meta.source_node_id) linkCountMap[meta.source_node_id] = (linkCountMap[meta.source_node_id] ?? 0) + 1;
      if (meta.target_node_id) linkCountMap[meta.target_node_id] = (linkCountMap[meta.target_node_id] ?? 0) + 1;
    } catch { /* ignore */ }
  });

function toFlowNodes(rawNodes: GraphNode[], onAddAlias: (id: string) => void, linkCountMap: Record<string, number>): Node[] {
  return rawNodes.map(n => ({
    id: n.id,
    type: NODE_TYPE_MAP[n.node_type] ?? 'table',
    position: { x: 0, y: 0 },
    data: { ...n, onAddAlias, linkCount: linkCountMap[n.id] ?? 0 },
  }));
}
```

### 布局参数调整

```typescript
const NODE_W = 240;
const NODE_H = 100;
const LINK_NODE_W = 260;
const LINK_NODE_H = 70;

// buildLayout 中按节点类型设置 dagre 尺寸
nodes.forEach(n => {
  const isLink = n.type === 'link';
  g.setNode(n.id, {
    width:  isLink ? LINK_NODE_W : NODE_W,
    height: isLink ? LINK_NODE_H : NODE_H,
  });
});

g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });
```

---

## 交互设计

### 工具栏过滤器

新增 `link` 类型开关（青绿色 `#00c9a7` 主题），初始默认开启：

```
[table] [metric] [alias] [link]
```

`typeFilter` 初始值从 `['table', 'metric', 'alias']` 改为 `['table', 'metric', 'alias', 'link']`。

**关闭 `link` 时的行为**（方案 B — 前端合成直连边）：

Link Node 从 `filteredRaw` 中过滤后，前端从这些 Link Node 的 metadata 中动态合成直连 Edge：

```typescript
const syntheticEdges: Edge[] = filteredRaw
  .filter(n => n.node_type === 'link' && !typeFilter.includes('link'))
  .map(n => {
    const meta = JSON.parse(n.metadata || '{}');
    return {
      id: `synthetic_${n.id}`,
      source: meta.source_node_id,
      target: meta.target_node_id,
      label: meta.edge_type,
      type: 'smoothstep',
      data: { edge_type: meta.edge_type, weight: meta.weight },
    };
  })
  .filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
```

合成边与正常 Edge 合并后传入 ReactFlow，使关闭 `link` 时 Object 节点之间仍有可见连线。

### NodeDetail 面板 — Link 节点

点击 Link Node 时，`NodeDetail` 面板展示以下区块：

| 区块 | 内容 |
|------|------|
| Header | `⇌` 图标 + edge_type（大写） |
| 方向 | `source_table → target_table` |
| 属性 | cardinality / via / on_delete / weight（只读） |
| 描述 | description（可内联编辑） |
| 推断标记 | `AI 推断` / `手动创建` badge |

description 编辑保存调用新增的 `update_graph_node_metadata` 命令，传入节点 id 和更新后的完整 metadata JSON。

### Object Node 交互新增

点击 Object Node 卡片上的 `3⇌` 链接数徽章 → 画布高亮所有与该 Object Node 相连的 Link Node（其他节点透明度降低至 0.3）。

### MiniMap 颜色

```typescript
// index.tsx MiniMap nodeColor
if (t === 'table')  return '#3794ff';
if (t === 'metric') return '#f59e0b';
if (t === 'alias')  return '#a855f7';
if (t === 'link')   return '#00c9a7';  // 新增
return '#1e2d42';
```

### 搜索扩展

搜索关键词同时匹配 Link Node 的 `name`（edge_type）、`display_name`（source→target）、metadata 中的 `via` 和 `description`。

---

## 集群折叠兼容

`clusterByConnection` 函数中，Link Node 与 Object Node 一同计入 `CLUSTER_THRESHOLD`（200）。

**Link Node 优先保留逻辑**：折叠时先保留所有 Link Node，剩余名额（50 - linkNodeCount）分配给 Object Node：

```typescript
function clusterByConnection(rawNodes: GraphNode[]): GraphNode[] {
  if (rawNodes.length <= CLUSTER_THRESHOLD) return rawNodes;

  const result: GraphNode[] = [];
  const byConn: Record<number, { links: GraphNode[]; objects: GraphNode[] }> = {};

  rawNodes.forEach(n => {
    const cid = n.connection_id ?? 0;
    if (!byConn[cid]) byConn[cid] = { links: [], objects: [] };
    if (n.node_type === 'link') byConn[cid].links.push(n);
    else byConn[cid].objects.push(n);
  });

  Object.entries(byConn).forEach(([cid, { links, objects }]) => {
    const linkQuota = Math.min(links.length, 50);
    const objectQuota = Math.max(0, 50 - linkQuota);
    links.slice(0, linkQuota).forEach(n => result.push(n));
    objects.slice(0, objectQuota).forEach(n => result.push(n));
    const collapsed = objects.length - objectQuota;
    if (collapsed > 0) {
      result.push({
        id: `cluster_${cid}`,
        node_type: 'alias',
        name: `[连接 ${cid}：${collapsed} 个节点已折叠]`,
        display_name: '',
        aliases: '',
        metadata: '',
        connection_id: Number(cid),
        is_deleted: 0,
        source: 'cluster',
      });
    }
  });
  return result;
}
```

---

## 范围边界（不在本次）

- Link Node 的人工新建 UI（本次只自动生成）
- `description` 之外的 Link 属性手动编辑
- Link 节点的搜索独立面板
- 非 FK 类型关系的 Link Node（alias_of 等，本次只改造 fk 类型）

---

## i18n Key 清单

需在 `src/i18n/locales/en.json` 和 `zh.json` 的 `graphExplorer` 节中新增：

| Key | en | zh |
|-----|----|----|
| `graphExplorer.typeLink` | `"Link"` | `"关联"` |
| `graphExplorer.nodeDetail.linkCardinality` | `"Cardinality"` | `"基数关系"` |
| `graphExplorer.nodeDetail.linkVia` | `"Via"` | `"关联字段"` |
| `graphExplorer.nodeDetail.linkOnDelete` | `"On Delete"` | `"删除行为"` |
| `graphExplorer.nodeDetail.linkDescription` | `"Description"` | `"语义描述"` |
| `graphExplorer.nodeDetail.linkDirection` | `"Direction"` | `"关联方向"` |
| `graphExplorer.nodeDetail.inferredBadge` | `"AI Inferred"` | `"AI 推断"` |
| `graphExplorer.nodeDetail.manualBadge` | `"Manual"` | `"手动创建"` |
| `graphExplorer.nodeDetail.linkProps` | `"Link Properties"` | `"关联属性"` |

---

## 文件变更清单

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/datasource/*/mod.rs`（各 driver） | 修改 `build_schema_graph`：Link Node + 两段式边 |
| `src-tauri/src/commands.rs` | 新增 `update_graph_node_metadata` 命令 |
| `src-tauri/src/lib.rs` | 注册 `update_graph_node_metadata` |
| `src/components/GraphExplorer/GraphNodeComponents.tsx` | 升级 `BaseNode`，新增 `LinkNodeComponent` |
| `src/components/GraphExplorer/nodeTypes.ts` | 注册 `link` 节点类型 |
| `src/components/GraphExplorer/index.tsx` | 过滤器/布局/linkCount/高亮/合成边逻辑 |
| `src/components/GraphExplorer/NodeDetail.tsx` | Link Node 专属展示区块 |
| `src/components/GraphExplorer/useGraphData.ts` | 无需改动 |
| `src/i18n/locales/en.json` / `zh.json` | 新增 9 个 i18n key（见上方清单） |
