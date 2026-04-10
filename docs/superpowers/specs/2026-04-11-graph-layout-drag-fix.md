# 知识图谱布局与拖拽持久化设计

**日期**：2026-04-11  
**状态**：已批准

---

## 背景

知识图谱（GraphExplorer）存在两个问题：

1. **拖拽回弹 Bug**：节点拖拽到新位置后，点击空白区域（onPaneClick）触发高亮状态清除，导致 `useEffect` 重跑，`buildLayout` 内 `hasSavedPosition` 检查 `data.position_x`（数据库原始值），首次拖拽时该值为 null，Dagre 重算后节点回弹。
2. **布局无分组**：所有节点混在一起用单次 Dagre 布局，无法体现数据库维度的聚合关系；后端构建图谱时也不分配初始坐标，导致新节点堆叠在 (0, 0)。

---

## 方案一：Bug 修复

**文件**：`src/components/GraphExplorer/index.tsx`

**位置**：第 514–519 行的 `mergedNodes` 合并逻辑。

**改动**：合并拖拽坐标时，同步将 `data.position_x/position_y` 更新为拖拽后的值，使 `hasSavedPosition` 返回 true，阻止 Dagre 覆盖。

```typescript
// 改前
if (dragged) return { ...n, position: dragged };

// 改后
if (dragged) return {
  ...n,
  position: dragged,
  data: { ...n.data, position_x: dragged.x, position_y: dragged.y },
};
```

**影响范围**：仅该一行，无副作用。

---

## 方案二：前端分组布局算法

**文件**：`src/components/GraphExplorer/index.tsx`，`buildLayout` 函数

### 分组规则

- **分组 key**：`${connection_id}|${database ?? ''}`
- 同一连接 + 同一数据库 = 一组
- 无 database 字段的节点（全局指标/别名）单独归为一组，排在最后

### 组内布局

每组内部跑一次 Dagre（`rankdir: 'LR'`, `ranksep: 200`, `nodesep: 80`），逻辑与现有完全一致。已有保存坐标的节点（`hasSavedPosition = true`）跳过 Dagre，直接保留原坐标。

### 组间排列

- 各组按组内节点数从多到少排序
- 从左到右横向拼接，组间间距 **600px**
- 当组数 > 4 时换行，每行最多 4 组，行间距 **500px**

```
┌──────────────┐  600px  ┌──────────────┐
│  db_A (20节点) │ ──────→ │  db_B (15节点) │
│  Dagre LR    │         │  Dagre LR    │
└──────────────┘         └──────────────┘
      ↓ 500px
┌──────────────┐
│  db_C (8节点) │
└──────────────┘
```

### 接口变更

`buildLayout` 函数签名不变，调用方无需修改。内部新增分组逻辑，替换原来的单次 Dagre 调用。

---

## 方案三：后端自动布局

### 新文件：`src-tauri/src/graph/layout.rs`

提供 `auto_layout_new_nodes(connection_id, database)` 函数。

### 触发时机

`graph/mod.rs` 的 `run_graph_build` 末尾调用，仅在构建完成后执行一次。

### 算法（纯数学，不引入新 crate）

1. 查出所有 `position_x IS NULL` 的节点，按 `connection_id + database` 分组
2. 查出已有坐标节点，计算每个分组当前的 bounding box（`min_x, max_x, min_y, max_y`）
3. 对新节点，在其所属分组 bounding box **右侧** 600px 处开始插入：
   - `cols = ceil(sqrt(n))`（n 为本组新增节点数）
   - 横向间距 280px，纵向间距 120px
4. 若分组完全没有已有节点（新数据库），从全局 bounding box 右侧分配新的起始 X，Y 从 0 开始
5. 批量 `UPDATE graph_nodes SET position_x=?, position_y=? WHERE id=?`

```
已有节点 bounding box     新增节点插入区（右侧 600px）
┌────────────────────┐        ┌──────────────┐
│ 已保存坐标节点       │ ──────→ │ new1  new2   │
│ (不动)              │        │ new3  new4   │
└────────────────────┘        └──────────────┘
```

### Tauri 命令

同时注册 `auto_layout_graph` 命令（供前端"重新布局"按钮可选调用）：

```rust
#[tauri::command]
pub async fn auto_layout_graph(connection_id: i64, database: Option<String>) -> AppResult<()>
```

注册到 `lib.rs` 的 `generate_handler![]`。

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/components/GraphExplorer/index.tsx` | 修改 | Bug 修复（1行）+ buildLayout 分组算法 |
| `src-tauri/src/graph/layout.rs` | 新增 | 后端自动布局实现 |
| `src-tauri/src/graph/mod.rs` | 修改 | run_graph_build 末尾调用 layout |
| `src-tauri/src/commands.rs` | 修改 | 注册 auto_layout_graph 命令 |
| `src-tauri/src/lib.rs` | 修改 | generate_handler![] 加入新命令 |

---

## 约束

- 已拖拽节点（`position_x IS NOT NULL`）永远不会被后端覆盖
- 前端 `draggedPositionsRef` 中的节点视同已有坐标，Dagre 不覆盖
- 后端算法不引入新的 Rust crate
- 前端 `buildLayout` 对外接口不变
