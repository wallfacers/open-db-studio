# 设计文档：指标列表 Tab 服务端分页与统计

**日期**：2026-03-19
**状态**：已批准

---

## 背景

`MetricListPanel`（指标列表树 Tab 页面）当前一次加载所有指标，没有分页和统计栏。用户希望对齐 `TableDataView` 的体验：顶部分页工具栏 + 底部状态栏（行数 · 耗时）。

---

## 目标

1. `crud.rs` 新增分页版内部函数，Tauri 命令层新增对应命令
2. 前端 `MetricListPanel` 增加分页控件和状态栏，交互与 `TableDataView` 一致

---

## 非目标

- 不引入总记录数（不做额外 COUNT 查询）
- 不修改现有 `list_metrics_by_node` 内部函数签名（保持 MCP 工具层调用不受影响）

---

## 后端设计

### 改造边界

`src-tauri/src/mcp/tools/metric_edit.rs` 直接调用 `crate::metrics::list_metrics_by_node`（crud.rs 中的内部函数，非 Tauri 命令）。

改造策略：在 `crud.rs` 中**新增** `pub fn list_metrics_by_node_paged`，与原函数并列，复用同文件中的私有 `SELECT_COLS` 常量和 `row_to_metric` 函数（同文件可见，无需改变可见性）。Tauri 命令层新增 `list_metrics_paged` 命令调用此新函数。原有 `list_metrics_by_node` 和调用它的 MCP 工具层代码均不修改。

### crud.rs：新增 `list_metrics_by_node_paged`

```rust
pub fn list_metrics_by_node_paged(
    connection_id: i64,
    database: Option<&str>,
    schema: Option<&str>,
    status: Option<&str>,
    page: u32,       // 从 1 开始
    page_size: u32,
) -> AppResult<(Vec<Metric>, usize)> {
    // 返回 (items, row_count)，row_count = items.len()
    // SQL 构建逻辑与 list_metrics_by_node 相同，末尾追加：
    //   LIMIT {page_size} OFFSET {(page-1)*page_size}
    // 使用 params_from_iter 绑定动态参数，避免 match 分支爆炸
    // timing 在 stmt.query_map 之前开始，collect() 之后结束
}
```

实现要点：
- SQL 构建：复用同文件 `SELECT_COLS`，条件拼接逻辑与原函数相同，ORDER BY 后追加 `LIMIT ? OFFSET ?`
- 参数绑定：使用 `rusqlite::params_from_iter(param_values)` 绑定动态参数列表（将 LIMIT/OFFSET 追加到 `param_values`），避免原函数的 match 分支爆炸问题
- `schema without database` 边界：与原函数行为一致，`schema` 仅在 `database` 也指定时生效（`database=None` 时 schema 条件不加入 SQL）
- 返回值：`items.len()` 即为 `row_count`，函数直接返回 `(items, items.len())` 的元组

### commands.rs：新增返回类型和 Tauri 命令

```rust
#[derive(serde::Serialize)]
pub struct MetricPageResult {
    pub items: Vec<Metric>,
    pub row_count: usize,   // items.len()，与 QueryResult.row_count 类型一致
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn list_metrics_paged(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    status: Option<String>,
    page: u32,
    page_size: u32,
    // state: tauri::State<'_, AppState>,  // 若需要 AppState 则加
) -> Result<MetricPageResult, String> {
    let start = std::time::Instant::now();
    let (items, row_count) = crate::metrics::list_metrics_by_node_paged(
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        status.as_deref(),
        page,
        page_size,
    ).map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;
    // duration_ms 计时：从调用内部函数前开始，collect() 返回后（内部函数返回后）结束
    Ok(MetricPageResult { items, row_count, duration_ms })
}
```

命令注册：在 `lib.rs` 的 `generate_handler![]` 中新增 `list_metrics_paged`。

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
const data = await invoke<MetricPageResult>('list_metrics_paged', {
  connectionId: scope.connectionId,   // Tauri camelCase → Rust snake_case 自动映射
  database: scope.database ?? null,
  schema: scope.schema ?? null,
  status: filterTab === 'all' ? null : filterTab,
  page,
  pageSize,
});
setMetrics(data.items);
setRowCount(data.row_count);
setDurationMs(data.duration_ms);

// 空页回退：若拿到空列表且当前不是第一页，自动回退
if (data.items.length === 0 && page > 1) {
  setPage(p => p - 1);
  return;
}
```

### filterTab / scope / search 变化时重置 page

| 操作 | 是否重置 page=1 |
|------|----------------|
| 切换 filterTab | 是（`useEffect` 依赖 filterTab） |
| 切换 scope | 是（`useEffect` 依赖 scope） |
| 搜索框输入 | **是**（`onChange` 时调用 `setPage(1)`，保证搜索始终从第一页过滤） |

搜索仍为客户端过滤（过滤当前页已加载数据），重置 page=1 可减少用户困惑（搜索永远从第一页开始看结果）。

### 顶部工具栏新增分页控件

插入到现有过滤栏左侧（与 `TableDataView` toolbar 样式一致）：

```
|<   <   {page}   >   100行/页   刷新
```

- `|<` / `<` 禁用条件：`page <= 1`
- `>` 禁用条件：`rowCount < pageSize`（当前页行数 < 每页大小，说明已到最后一页；空页情况由 load() 回退处理）
- 刷新按钮：重新执行 `load()`

### 底部状态栏

在批量操作栏上方新增（与 `TableDataView` Status Bar 样式一致）：

```
{displayCount} 行 · {durationMs}ms
```

- `displayCount`：`search` 非空时显示 `filtered.length`（客户端过滤后可见行数），`search` 为空时显示 `rowCount`（服务端返回行数）
- 高度 `h-7`，背景 `bg-[#080d12]`，文字 `text-[#7a9bb8] text-xs`

---

## 受影响文件

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/metrics/crud.rs` | 新增：`list_metrics_by_node_paged` 函数 |
| `src-tauri/src/commands.rs` | 新增：`MetricPageResult` 结构体，`list_metrics_paged` 命令 |
| `src-tauri/src/lib.rs` | 修改：注册 `list_metrics_paged` |
| `src/types/index.ts` | 修改：新增 `MetricPageResult` |
| `src/components/MetricsExplorer/MetricListPanel.tsx` | 修改：改用 `list_metrics_paged`，新增分页状态、工具栏、状态栏 |

---

## 交互细节

| 操作 | 行为 |
|------|------|
| 切换 filterTab | 重置 page=1，重新加载 |
| 切换 scope | 重置 page=1，重新加载 |
| 搜索框输入 | 重置 page=1，客户端过滤当前页，状态栏显示过滤后行数 |
| 点击 `>` 下一页 | page+1，重新加载；若返回空列表自动回退 |
| 点击 `<` 上一页 | page-1，重新加载 |
| 点击 `\|<` 首页 | page=1，重新加载 |
| 刷新按钮 | 保持当前 page，重新加载 |
