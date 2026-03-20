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

### Link Node 存储

每条 FK 关系在 `build_schema_graph` 时产生：
- **1 个 Link Node**（存入 `graph_nodes`）
- **2 条 Edge**（存入 `graph_edges`）：`source_table → link_node`，`link_node → target_table`

Link Node 字段映射：

| graph_nodes 列 | Link Node 值 |
|----------------|-------------|
| `id` | `"link_{from_table}_{to_table}_{via_field}"` |
| `node_type` | `"link"` |
| `name` | `"{edge_type}"` (如 `"fk"`) |
| `display_name` | `"{source} → {target}"` |
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
  "target_table": "users"
}
```

### Cardinality 推断规则

| 条件 | Cardinality |
|------|-------------|
| via 字段有唯一约束（UNIQUE INDEX） | `1:1` |
| via 字段无唯一约束 | `N:1` |
| 多字段复合 FK | `N:M`（保守估计） |

---

## Rust 后端变更

**文件**: `src-tauri/src/datasource/`（各 driver 的 `build_schema_graph` 实现）

变更逻辑（伪代码）：

```rust
for fk in foreign_keys {
    let link_id = format!("link_{}_{}_{}", fk.from_table, fk.to_table, fk.column);
    let cardinality = infer_cardinality(&fk, &unique_indexes);

    let metadata = LinkMetadata {
        edge_type: "fk",
        cardinality,
        via: fk.column.clone(),
        on_delete: fk.on_delete.clone(),
        description: String::new(),
        weight: 0.95,
        is_inferred: true,
        source_table: fk.from_table.clone(),
        target_table: fk.to_table.clone(),
    };

    // 插入 Link Node
    insert_graph_node(&link_id, "link", &fk.edge_type, &metadata_json);

    // 插入两条边
    insert_graph_edge(&fk.from_table, &link_id, "to_link");
    insert_graph_edge(&link_id, &fk.to_table, "from_link");
}
```

**`get_graph_nodes`** 和 **`get_graph_edges`** 命令无需改动，透明返回 Link Node 数据。

---

## 前端组件设计

### 新增 `LinkNodeComponent`

**文件**: `src/components/GraphExplorer/GraphNodeComponents.tsx`（新增导出）

外观规格：
- 宽度：`260px`，高度：自适应（约 `60-80px`）
- 边框：`#00c9a7`（项目现有 accent 色）
- 背景：`#111922`（与 Object Node 一致）
- `is_inferred = true` 时：边框改为虚线 `border-dashed`
- Handle 位置：左（target）+ 右（source），与现有节点一致

卡片内容布局：
```
┌─────────────────────────────────────────┐
│  ⇌  fk                        N:1      │  ← edge_type + cardinality（右对齐）
│  via: user_id  ·  on_delete: CASCADE    │  ← 关键属性行
│  orders → users                         │  ← 方向说明（display_name）
└─────────────────────────────────────────┘
```

description 非空时在第三行显示（`italic #7a9bb8`）。

### 改造 `ObjectNodeComponent`（原 BaseNode）

升级为 Palantir Object Type 风格，保持现有主题色体系（table=#3794ff，metric=#f59e0b，alias=#a855f7）：

```
┌──────────────────────────────────────────┐
│  [icon]  orders              7✦  3⇌      │  ← 图标+name + props/links 计数徽章
│          Object Type · TABLE              │  ← 副标题
├──────────────────────────────────────────┤
│  id           Primary Key                 │  ← Key Properties（最多3条）
│  user_id      FK                          │
│  status       ENUM                        │
├──────────────────────────────────────────┤
│  #用户订单  #业务核心表                    │  ← aliases 标签
└──────────────────────────────────────────┘
```

图标映射：`table → Database`（lucide）、`metric → BarChart2`、`alias → Hash`

props 计数来自 `metadata` JSON 的数组长度；links 计数来自传入 `data` 的 `linkCount`（在 `toFlowNodes` 时统计并注入）。

节点宽度从 `200px` 扩展为 `240px`，高度自适应。

### `nodeTypes` 注册

**文件**: `src/components/GraphExplorer/nodeTypes.ts`

```typescript
import { LinkNodeComponent } from './GraphNodeComponents';

export const nodeTypes = {
  table:  ObjectNodeComponent,
  metric: ObjectNodeComponent,
  alias:  ObjectNodeComponent,
  link:   LinkNodeComponent,    // 新增
};
```

### `toFlowNodes` 扩展

在 `index.tsx` 的 `toFlowNodes` 函数中，额外计算每个 Object Node 的 `linkCount`：

```typescript
function toFlowNodes(rawNodes: GraphNode[], onAddAlias, linkCountMap: Record<string, number>): Node[] {
  return rawNodes.map(n => ({
    ...existing,
    data: {
      ...n,
      onAddAlias,
      linkCount: linkCountMap[n.id] ?? 0,
    }
  }));
}
```

`linkCountMap` 在 `filteredRaw` 计算时统计：Link Node 的 `source_table` / `target_table`（从 metadata 解析）命中的 Object Node id。

### 布局参数调整

```typescript
g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });
// Link Node 尺寸
const LINK_NODE_W = 260;
const LINK_NODE_H = 70;
// Object Node 尺寸不变
const NODE_W = 240;
const NODE_H = 100;
```

`buildLayout` 中按节点类型分别设置 dagre 节点尺寸。

---

## 交互设计

### 工具栏过滤器

新增 `link` 类型开关（青绿色 `#00c9a7` 主题）：

```
[table] [metric] [alias] [link]
```

关闭 `link` 时：Link Node 从 `filteredRaw` 中过滤，对应 2 条边也过滤，Object 节点之间退化为原始直连 Edge（从 `rawEdges` 中还原直连关系），保持向后兼容。

### NodeDetail 面板 — Link 节点

点击 Link Node 时，`NodeDetail` 面板展示以下区块：

| 区块 | 内容 |
|------|------|
| Header | `⇌` 图标 + edge_type（大写） |
| 方向 | `source_table → target_table`，可点击跳转高亮 |
| 属性 | cardinality / via / on_delete / weight（只读） |
| 描述 | description（可内联编辑，保存回 SQLite metadata） |
| 推断标记 | `AI 推断` / `手动创建` badge |

description 编辑复用现有 `AliasEditor` 的保存机制（`invoke('update_graph_node_metadata', ...)`）。

### Object Node 交互新增

点击 Object Node 卡片上的 `3⇌` 链接数徽章 → 画布高亮所有与该 Object Node 相连的 Link Node（其他节点降低透明度）。

### 搜索扩展

搜索关键词同时匹配 Link Node 的 `name`（edge_type）、`display_name`（source→target）、metadata 中的 `via` 和 `description`。

---

## 集群折叠兼容

`clusterByConnection` 函数中，Link Node 与 Object Node 一同计入 `CLUSTER_THRESHOLD`（200）。折叠时 Link Node 优先保留（保证关系可见），Object Node 按数量折叠。

---

## 范围边界（不在本次）

- Link Node 的人工新建 UI（本次只自动生成）
- `description` 之外的 Link 属性手动编辑
- Link 节点的搜索独立面板
- 非 FK 类型关系的 Link Node（alias_of 等，本次只改造 fk 类型）

---

## 文件变更清单

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/datasource/*/mod.rs`（各 driver） | 修改 `build_schema_graph` 逻辑 |
| `src/components/GraphExplorer/GraphNodeComponents.tsx` | 新增 `LinkNodeComponent`，改造 `BaseNode` |
| `src/components/GraphExplorer/nodeTypes.ts` | 注册 `link` 节点类型 |
| `src/components/GraphExplorer/index.tsx` | 过滤器/布局/linkCount 注入/高亮逻辑 |
| `src/components/GraphExplorer/NodeDetail.tsx` | Link Node 专属展示区块 |
| `src/components/GraphExplorer/useGraphData.ts` | 无需改动 |
| `src/i18n/locales/en.json` / `zh.json` | 新增 `link` 相关 i18n key |
