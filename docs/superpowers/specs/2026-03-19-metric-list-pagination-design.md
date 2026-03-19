# 设计文档：指标列表 Tab 服务端分页与统计

**日期**：2026-03-19
**状态**：已批准

---

## 背景

`MetricListPanel`（指标列表树 Tab 页面）当前一次加载所有指标，没有分页和统计栏。用户希望对齐 `TableDataView` 的体验：顶部分页工具栏 + 底部状态栏（行数 · 耗时）。

---

## 目标

1. 后端 `list_metrics_by_node` 支持分页参数，返回当前页数据及统计信息
2. 前端 `MetricListPanel` 增加分页控件和状态栏，交互与 `TableDataView` 一致

---

## 非目标

- 不引入总记录数（不做额外 COUNT 查询）
- 不改搜索逻辑（搜索仍在客户端过滤当前页数据）
- 不修改其他调用 `list_metrics_by_node` 的代码（当前只有 MetricListPanel 一处）

---

## 后端设计

### 新增返回类型

在 `src-tauri/src/commands.rs`（或相关模块）新增：

```rust
#[derive(serde::Serialize)]
pub struct MetricPageResult {
    pub items: Vec<Metric>,
    pub row_count: i64,   // items.len() as i64，当前页实际行数
    pub duration_ms: u64,
}
```

### 修改 `list_metrics_by_node` 命令签名

```rust
// 新增可选分页参数
page: Option<u32>,       // 默认 1
page_size: Option<u32>,  // 默认 100
```

返回类型从 `Vec<Metric>` 改为 `MetricPageResult`。

### SQL 变化

在现有 SELECT 语句末尾追加：

```sql
LIMIT ? OFFSET ?
```

`OFFSET = (page - 1) * page_size`。

`row_count` 直接取 `items.len() as i64`，无需额外 COUNT 查询。

---

## 前端设计

### 新增类型（`src/types/index.ts`）

```typescript
export interface MetricPageResult {
  items: Metric[];
  row_count: number;
  duration_ms: number;
}
```

### MetricListPanel 状态变化

新增：

```typescript
const [page, setPage] = useState(1);
const [pageSize] = useState(100);
const [rowCount, setRowCount] = useState(0);
const [durationMs, setDurationMs] = useState(0);
```

`metrics` 状态类型不变（`Metric[]`），从 `MetricPageResult.items` 赋值。

### load() 变化

```typescript
const data = await invoke<MetricPageResult>('list_metrics_by_node', {
  connectionId: scope.connectionId,
  database: scope.database ?? null,
  schema: scope.schema ?? null,
  status: filterTab === 'all' ? null : filterTab,
  page,
  pageSize,
});
setMetrics(data.items);
setRowCount(data.row_count);
setDurationMs(data.duration_ms);
```

`filterTab` / `scope` 变化时重置 `page = 1`（通过 `useEffect` 依赖控制）。

### 顶部工具栏新增分页控件

插入到现有过滤栏左侧（与 TableDataView toolbar 样式一致）：

```
|<   <   {page}   >   100行/页   刷新
```

- `|<` / `<` 禁用条件：`page <= 1`
- `>` 禁用条件：`rowCount < pageSize`
- 刷新按钮：重新执行 `load()`，与现有搜索刷新复用

### 底部状态栏

在批量操作栏上方新增（与 TableDataView Status Bar 样式一致）：

```
{rowCount} 行 · {durationMs}ms
```

高度 `h-7`，背景 `bg-[#080d12]`，文字 `text-[#7a9bb8] text-xs`。

---

## 受影响文件

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/commands.rs` 或相关数据库模块 | 修改：新增返回类型，修改命令签名和 SQL |
| `src/types/index.ts` | 修改：新增 `MetricPageResult` |
| `src/components/MetricsExplorer/MetricListPanel.tsx` | 修改：新增分页状态、工具栏控件、状态栏 |

---

## 交互细节

| 操作 | 行为 |
|------|------|
| 切换 filterTab | 重置 page=1，重新加载 |
| 切换 scope | 重置 page=1，重新加载 |
| 搜索框输入 | 客户端过滤当前页，不触发重置 |
| 点击 `>` 下一页 | page+1，重新加载 |
| 点击 `<` 上一页 | page-1，重新加载 |
| 点击 `|<` 首页 | page=1，重新加载 |
| 刷新按钮 | 保持当前 page，重新加载 |
