<!-- STATUS: ✅ 已实现 -->
# 大批量数据渲染优化设计文档

**日期**：2026-03-23
**状态**：✅ 已实现
**实现日期**：2026-03-26
**作者**：Claude Code（与用户协作）

---

## 背景

open-db-studio 当前有两处表格渲染场景：

1. **TableDataView**（浏览表数据）：服务端分页 + 原生 `<table>` 全量 DOM 渲染，pageSize 最大 1000 行，无虚拟滚动。
2. **SQL 编辑器查询结果集**：原生 `<table>` 全量 DOM 渲染，**无任何分页**，查询返回 5000-10000 行时直接冻结页面。

## 目标

- SQL 编辑器结果集：支持安全展示任意行数查询结果，避免页面冻结。
- TableDataView：1000 行 × 宽表场景下滚动流畅（≥ 60fps），DOM 节点数 ≤ 当前 5%。

## 方案选择

采用**分层策略（方案 C）**：两个场景独立处理，按实际需求匹配技术。

- SQL 结果集：前端截断 + 结果内分页（无需虚拟滚动）
- TableDataView：`@tanstack/react-virtual` 行级虚拟滚动

## 架构

```
src/
├── hooks/
│   └── useVirtualRows.ts          # 行虚拟滚动核心 hook（新增）
├── components/
│   └── MainContent/
│       ├── TableDataView.tsx      # 改：接入虚拟滚动
│       ├── VirtualTable.tsx       # 新增：通用虚拟表格容器
│       └── index.tsx              # 改：SQL结果集加前端截断+分页
```

数据流不变：Rust 层继续做服务端分页，前端只改渲染层。

---

## 详细设计

### 1. SQL 编辑器结果集（`MainContent/index.tsx`）

**策略**：前端截断 + 结果内分页

**关键常量**：
```typescript
const RESULT_PAGE_SIZE = 200;   // 每页显示行数
const RESULT_MAX_ROWS  = 500;   // 超出截断并提示
```

**IPC 传输说明**：后端 `execute_query` 仍返回全量数据（前端无法在反序列化前截断）。本方案只解决渲染层的卡顿，IPC 传输超大结果集（>1万行）的冻结问题留待后续在 Rust 层增加 `LIMIT` 自动注入来解决，超出范围不在本次迭代内。

**行为**：
- 结果到达后取 `rows.slice(0, RESULT_MAX_ROWS)` 作为展示数据，超出时顶部显示黄色提示条：
  `"查询返回 N 行，当前显示前 500 行。如需查看全量数据请使用 LIMIT 或导出"`
- 结果集底部添加翻页控件（上一页/下一页 + 页码显示），每页 200 行
- DML 报告（`result.kind === 'dml-report'`）完全跳过截断和分页逻辑，保持原有渲染
- 截断提示带"导出全量"按钮，点击调用 `invoke('execute_query', { sql: currentSql })` 后下载为 CSV，**不复用现有 ExportDialog**（因其依赖 tableName，与 SQL 结果场景不符）

**UI 布局**：
```
┌─────────────────────────────────────────────────────┐
│ ⚠ 查询返回 8421 行，当前显示前 500 行。[导出全量]   │  ← 黄色提示条（仅超限时显示）
├─────────────────────────────────────────────────────┤
│ 表头（sticky）                                       │
│ 数据行 1-200                                         │
│ ...                                                  │
├─────────────────────────────────────────────────────┤
│ [< 上一页]  第 1 / 3 页  [下一页 >]                 │  ← 翻页控件（底部，行数>200时显示）
└─────────────────────────────────────────────────────┘
```

**分支判断位置**：在 `index.tsx` 的结果集渲染入口处：
```typescript
// 仅对 select 类型结果做截断和分页
if (result.kind === 'select') {
  const displayRows = result.rows.slice(0, RESULT_MAX_ROWS);
  // 分页渲染 displayRows
} else {
  // dml-report：原有逻辑不变
}
```

---

### 2. TableDataView 虚拟滚动

**依赖**：`@tanstack/react-virtual`

#### 2.1 布局方案：`table-layout: fixed` + 固定列宽

原生 `<table>` + `position: absolute` 的 `<tr>` 会破坏列宽对齐（`tr` 脱离表格布局流后 `width: 100%` 失效）。解决方案：

- 给 `<table>` 设置 `table-layout: fixed`
- 在 `<colgroup>` 中为每列设置固定宽度（默认 150px，用户可拖拽调整留作后续迭代）
- `<tbody>` 使用 `display: block; position: relative; height: totalSize` 脱离表格布局流
- 虚拟行的 `<tr>` 使用 `display: flex; position: absolute`，每个 `<td>` 宽度与 `<col>` 宽度对应

```tsx
<table style={{ tableLayout: 'fixed', width: '100%' }}>
  <colgroup>
    <col style={{ width: '40px' }} />  {/* 行号列 */}
    {columns.map(col => (
      <col key={col} style={{ width: '150px' }} />
    ))}
  </colgroup>
  <thead className="sticky top-0 ...">
    {/* 表头不变 */}
  </thead>
  <tbody style={{ display: 'block', position: 'relative', height: `${totalSize}px` }}>
    {virtualRows.map(vRow => (
      <tr
        key={vRow.key}
        style={{ display: 'flex', position: 'absolute', top: 0, transform: `translateY(${vRow.start}px)`, width: '100%' }}
      >
        {renderRow(vRow.index)}
      </tr>
    ))}
  </tbody>
</table>
```

#### 2.2 `useVirtualRows.ts`

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

export function useVirtualRows(
  count: number,
  scrollRef: RefObject<HTMLDivElement>
) {
  return useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,   // 行高：py-1.5(12px) + text-xs line-height(16px) = 28px
    overscan: 5,
  });
}
```

#### 2.3 `VirtualTable.tsx` 完整 Props 类型

```typescript
import type { Virtualizer } from '@tanstack/react-virtual';

interface VirtualTableProps {
  /** 列定义（用于生成 colgroup） */
  columns: string[];
  /** 虚拟滚动实例，由调用方通过 useVirtualRows 创建 */
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  /** 渲染单行所有 td 的回调，rowIndex 为数据真实索引 */
  renderRow: (rowIndex: number) => React.ReactNode;
  /** thead 内容，由调用方传入以保持排序图标等逻辑 */
  thead: React.ReactNode;
}
```

调用方（`TableDataView`）持有 `scrollRef` 并绑定到外层滚动容器：

```tsx
// TableDataView.tsx
const scrollRef = useRef<HTMLDivElement>(null);
const rowVirtualizer = useVirtualRows(totalRowCount, scrollRef);

return (
  <div ref={scrollRef} className="flex-1 overflow-auto relative">
    <VirtualTable
      columns={data.columns}
      rowVirtualizer={rowVirtualizer}
      thead={<tr>...</tr>}
      renderRow={(ri) => (
        <>
          <td ...>{(page-1)*pageSize + ri + 1}</td>
          {data.rows[ri].map((cell, ci) => <EditableCell key={ci} ... />)}
        </>
      )}
    />
  </div>
);
```

现有滚动容器 `<div className="flex-1 overflow-auto relative">` 已满足 `useVirtualizer` 对滚动容器的要求（`overflow: auto` + 明确高度由 flex 布局提供），只需加 `ref`。

#### 2.4 克隆行处理

`count` 参数传 `data.rows.length + pending.clonedRows.length`，`renderRow` 内部按索引区分：

```typescript
const renderRow = (ri: number) => {
  if (ri < data.rows.length) {
    // 正常数据行
    return <NormalRow rowIdx={ri} ... />;
  } else {
    // 克隆行
    const cloneIdx = ri - data.rows.length;
    return <ClonedRow cloneIdx={cloneIdx} ... />;
  }
};
```

#### 2.5 与现有功能的集成

| 功能 | 处理方式 |
|------|----------|
| EditableCell 编辑态 | pending state 存于 `usePendingChanges`（内存），不依赖 DOM，滚走不丢失 |
| 行背景色（删除/编辑高亮） | `rowBgClass(ri)` 照常，rowIdx 用真实数据索引 |
| 右键菜单坐标 | 来自 `e.clientX/Y`，不受虚拟滚动影响 |
| sticky thead | 保持 `sticky top-0`，虚拟滚动只影响 tbody |
| 克隆行 | count 包含克隆行数，renderRow 按索引分支处理 |
| pageSize 选项 | 保留 100/200/500/1000，虚拟滚动下均流畅 |

---

### 3. 性能目标与验收方式

| 场景 | 当前 DOM 节点数 | 优化后 DOM 节点数 | 目标帧率 |
|------|----------------|-------------------|----------|
| TableDataView 1000行×20列 | ~20,000 | ≤ 1,100（55行×20列） | ≥ 60fps |
| SQL 结果集 5000行 | 5,000+ 行节点 | ≤ 200 行节点（分页） | N/A |

**验收方式**：
- Chrome DevTools → Performance 面板 → 录制滚动 2 秒 → 检查 Frame 不低于 60fps
- Elements 面板检查 `<tbody>` 内 `<tr>` 数量 ≤ overscan×2 + 可视行数（约 50 行）

---

## 不在范围内

- 列级虚拟滚动（宽表横向虚拟化）
- Rust 层查询结果流式返回 / 自动注入 LIMIT
- 列宽拖拽调整（`colgroup` 宽度固定为 150px）
- `pageOptions` 下拉上限调整（保持 500 不变）

---

## 实现步骤

1. `npm install @tanstack/react-virtual`
2. 新建 `src/hooks/useVirtualRows.ts`
3. 新建 `src/components/MainContent/VirtualTable.tsx`
4. 改造 `TableDataView.tsx`：加 `scrollRef`，接入 `VirtualTable`，调整 `count` 含克隆行
5. 改造 `MainContent/index.tsx`：SELECT 结果加截断+翻页，DML 报告保持不变
6. 手工测试：1000 行表浏览滚动、10000 行 SQL 查询结果翻页、克隆行可见性
7. Chrome DevTools Performance 验收
