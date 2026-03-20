# 知识图谱实体搜索与多跳路径查询设计文档

**日期**：2026-03-21
**状态**：已确认
**范围**：GraphExplorer 组件 + 后端新增 `find_subgraph` 命令

---

## 背景

知识图谱页面（GraphExplorer）现有搜索为纯前端本地过滤，未调用后端 FTS5 全文索引。多跳路径查询能力（`find_relevant_subgraph` + BFS + LRU 缓存）已在后端实现，但未暴露为前端可用的 Tauri 命令，也没有对应的 UI 交互。

本设计目标：
1. **实体搜索**：工具栏快速搜索 + 侧边栏详细结果列表，调用后端 FTS5
2. **节点到节点多跳路径查询**：选择起点/终点节点，输入最大跳数，查找并高亮路径，支持提取子图

---

## 架构总览

### 新增前端文件

```
src/components/GraphExplorer/
├── GraphSearchPanel.tsx    # 侧边栏容器，含 Tab 切换
├── SearchTab.tsx           # 搜索 Tab：关键词搜索 + 结果列表
├── PathTab.tsx             # 路径 Tab：起点/终点 + 路径列表
├── useGraphSearch.ts       # 搜索状态 Hook
└── usePathFinder.ts        # 路径查询 Hook
```

### 新增后端命令

```rust
// src-tauri/src/commands.rs
#[tauri::command]
pub async fn find_subgraph(
  app: tauri::AppHandle,
  connection_id: i64,
  from_node_id: String,
  to_node_id: String,
  max_hops: u8,
) -> AppResult<SubGraph>
```

内部调用 `graph::query::find_relevant_subgraph`，传入 `[from_node_id, to_node_id]`，复用现有 BFS + LRU 缓存。命令需在 `lib.rs` 的 `generate_handler![]` 中注册。

### GraphExplorer 状态扩展

```typescript
// 新增 state（src/components/GraphExplorer/index.tsx）
activePanel: 'detail' | 'search' | null   // 右侧面板切换
highlightedNodeIds: Set<string>            // 高亮节点集合
highlightedEdgeIds: Set<string>            // 高亮边集合
pathFrom: GraphNode | null                 // 路径起点
pathTo: GraphNode | null                   // 路径终点
subgraphMode: boolean                      // 子图隔离模式
subgraphNodeIds: Set<string>               // 子图节点集合
```

---

## 组件设计

### GraphSearchPanel

- 宽度 280px，位于 GraphExplorer 右侧
- 与现有 NodeDetail 面板互斥：通过 `activePanel` 切换
- 工具栏新增搜索图标按钮（`Search` from lucide-react），点击切换 `activePanel: 'search'`
- 包含两个 Tab：**搜索** / **路径**

---

### SearchTab

**交互流程**：

```
用户输入关键词（debounce 300ms）
  → invoke('search_graph', { connectionId, keyword })
  → 返回 GraphNode[]（最多 20 条，FTS5 排序）
  → 渲染结果列表（name + node_type 徽章 + display_name）
  → 点击条目：ReactFlow fitView 到该节点 + 节点高亮 2 秒后消退
  → 条目右侧两个按钮：[S] 设为起点  [T] 设为终点
    → 点击后自动切换到 Path Tab 并填入对应端点
```

**边界处理**：
- 关键词为空：不发起请求，清空结果列表
- 无匹配：显示空态 "未找到匹配节点"
- 目标节点被类型过滤隐藏：fitView 仍执行，条目提示 "当前已过滤，节点不可见"
- 加载中：输入框右侧 spinner + 结果列表 skeleton

---

### PathTab

**交互流程**：

```
起点槽位 + 终点槽位（显示节点名，可清除）
跳数输入框（数字，默认 3，最小 1）
[查找路径] 按钮
  → invoke('find_subgraph', { connectionId, fromNodeId, toNodeId, maxHops })
  → 返回 SubGraph { nodes, edges, join_paths }
  → 路径列表：每条路径显示 "A → B → C"
  → 点击路径条目：
      1. 更新 highlightedNodeIds / highlightedEdgeIds
      2. 非路径节点 opacity-30，路径节点 accent-glow，路径边加粗青色
      3. ReactFlow fitView 到路径范围
  → [提取子图] 按钮：
      进入 subgraphMode，隐藏非路径节点
      工具栏显示 "恢复全图" 按钮退出
```

**边界处理**：
- 起点 = 终点：禁用查询按钮，提示 "起点和终点不能相同"
- 跳数非法：自动修正为 1
- 无路径：提示 "在 N 跳范围内未找到路径，可尝试增大跳数"
- 路径数 > 20：只显示前 20 条，并提示
- 请求失败：Toast 错误 + 重试按钮

---

## 色彩规范（Abyss Theme）

### 侧边栏面板

| 元素 | 样式 |
|------|------|
| 面板背景 | `bg-[#0d1117]` |
| Tab 激活 | `border-b-2 border-[#00c9a7]` + `text-[#e8f4ff]` |
| Tab 未激活 | `text-[#7a9bb8]` hover `text-[#c8daea]` |
| 搜索输入框 | `bg-[#111922] border border-[#1e2d42]` focus `border-[#00a98f]` |
| 结果列表 hover | `bg-[#1a2639]` |
| 结果列表选中 | `bg-[#003d2f] border-l-2 border-[#00c9a7]` |

### 路径查询专属

| 元素 | 颜色 | 说明 |
|------|------|------|
| 起点标记 | `#4ade80`（成功绿） | "FROM 节点" |
| 终点标记 | `#5eb2f7`（信息蓝） | "TO 节点" |
| 路径边高亮 | `#00c9a7` 加粗描边 | 主题青 |
| 路径节点高亮 | `accent-glow` CSS 类 | 主题色发光 |
| 非路径节点 | `opacity-30` | 弱化 |
| 提取子图按钮 | `bg-[#003d2f] border-[#00a98f]` | 呼应激活背景 |

### 节点角色徽章（画布叠加）

- 起点：右上角绿色圆点 `bg-[#4ade80]` + 文字 "S"
- 终点：右上角蓝色圆点 `bg-[#5eb2f7]` + 文字 "T"

---

## 子图模式

进入条件：用户点击 PathTab 中的"提取子图"按钮

行为：
- `subgraphMode = true`，只渲染 `subgraphNodeIds` 中的节点及其边
- 工具栏出现 "恢复全图" 按钮（`RotateCcw` 图标）
- 退出条件：点击"恢复全图"、切换连接/数据库、关闭搜索面板

当子图模式下用户点击搜索结果跳转，若目标节点不在子图内，Toast 提示 "目标节点在子图外，已恢复全图" 并自动退出子图模式。

---

## 不在本次范围内

- 多路径同时高亮（本次只支持单条路径高亮）
- 路径动画（边沿路径流动效果）
- 保存/导出子图
- 多起点多终点查询

---

## 受影响文件清单

### 前端
- `src/components/GraphExplorer/index.tsx` — 状态扩展 + 面板切换逻辑
- `src/components/GraphExplorer/GraphNodeComponents.tsx` — 节点高亮/角色徽章渲染
- `src/components/GraphExplorer/GraphSearchPanel.tsx` — 新增
- `src/components/GraphExplorer/SearchTab.tsx` — 新增
- `src/components/GraphExplorer/PathTab.tsx` — 新增
- `src/components/GraphExplorer/useGraphSearch.ts` — 新增
- `src/components/GraphExplorer/usePathFinder.ts` — 新增

### 后端
- `src-tauri/src/commands.rs` — 新增 `find_subgraph` 命令
- `src-tauri/src/lib.rs` — 注册 `find_subgraph` 到 `generate_handler![]`
