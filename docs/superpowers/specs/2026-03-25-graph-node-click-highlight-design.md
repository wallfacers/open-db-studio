<!-- STATUS: ✅ 已实现 -->
# GraphExplorer 节点点击高亮联动设计

**日期**: 2026-03-25
**状态**: implemented

## 需求

在知识图谱 GraphExplorer 中，点击节点时：
1. 高亮该节点 + 直接相连的节点和边（1 跳）
2. 非相关节点/边淡出（opacity 0.3）
3. 同时打开 NodeDetail 侧面板
4. 点击画布空白处恢复全部显示

## 方案选择

**方案 1: 纯 React 状态驱动（选定）**

在现有 `onNodeClick` 中计算邻居集合，通过 React 状态驱动节点/边的 style 变化。零依赖，与现有 ReactFlow 架构完全一致。

淘汰方案：
- fitView + 过滤：破坏全图认知，恢复体验差
- CSS class 切换：ReactFlow 内联 style 优先级高于外部 CSS，易冲突

## 交互设计

### 流程

1. 用户点击节点
2. 从当前 edges 中找出所有 `from_node` 或 `to_node` 包含该节点 ID 的边
3. 提取这些边的对端节点 ID，组成邻居集合
4. 设置状态：`focusedNodeId`、`focusedNeighborIds`（Set）、`focusedEdgeIds`（Set）
5. 节点渲染：不在 `{focusedNodeId} ∪ focusedNeighborIds` 中的节点 → opacity 0.3
6. 边渲染：
   - 在 `focusedEdgeIds` 中的边 → stroke 3、颜色 `#00c9a7`（cyan）、animated
   - 不在集合中的边 → opacity 0.3
7. 同时打开 NodeDetail 面板（复用现有逻辑）
8. 点击画布空白处 → 清除 `focusedNodeId`，全部恢复 opacity 1.0

### 视觉参数

| 元素 | 高亮状态 | 淡出状态 |
|------|---------|---------|
| 焦点节点 | 正常显示 | — |
| 邻居节点 | 正常显示 | — |
| 相关边 | stroke 3, `#00c9a7`, animated | — |
| 无关节点 | — | opacity 0.3 |
| 无关边 | — | opacity 0.3 |

过渡动画：`transition: opacity 0.3s ease`

## 改动范围

3 个文件，不新增文件，不改数据层。

### index.tsx

- 新增状态：`focusedNodeId: string | null`、`focusedNeighborIds: Set<string>`、`focusedEdgeIds: Set<string>`
- 修改 `onNodeClick`：计算 1 跳邻居集合，设置 focus 状态，同时打开 NodeDetail
- 修改 `onPaneClick`：清除 focus 状态
- 在 ReactFlow nodes 构建时：根据 focus 状态注入 `data.dimmed` 属性
- 在 ReactFlow edges 构建时：根据 focus 状态注入 `data.highlighted` / `data.dimmed` 属性

### GraphNodeComponents.tsx

- 所有节点组件（TableNode、MetricNode、AliasNode、LinkNode）：
  - 读取 `data.dimmed` 属性
  - 当 `dimmed=true` 时，外层容器添加 `opacity: 0.3` + `transition: opacity 0.3s ease`
  - 当 `dimmed=false` 时，`opacity: 1.0`

### RelationEdge（GraphNodeComponents.tsx 内）

- 读取 `data.highlighted` 和 `data.dimmed` 属性
- `highlighted=true`：stroke 变为 3、颜色 `#00c9a7`、添加 animated dash
- `dimmed=true`：opacity 0.3
- 默认状态：保持现有样式不变

## 与现有功能的兼容

- **现有 `highlightedNodeIds`/`highlightedEdgeIds`（路径高亮）**：focus 状态优先级高于路径高亮；两者不会同时生效（点击节点会覆盖路径高亮状态）
- **搜索面板点击结果**：搜索结果点击走 `fitView`，不触发 focus（保持现有行为）
- **编辑模式**：focus 状态在编辑模式下同样生效
- **子图模式**：focus 在子图模式下正常工作（只针对可见节点计算邻居）
