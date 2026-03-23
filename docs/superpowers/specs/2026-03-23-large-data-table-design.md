# 大批量数据渲染优化设计文档

**日期**：2026-03-23
**状态**：已批准
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
│       ├── TableDataView.tsx      # 改：接入 useVirtualRows
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

**行为**：
- 后端返回结果后，前端最多展示 500 行（超出截断）
- 超出时顶部显示黄色提示条：`"查询返回 N 行，当前显示前 500 行。如需查看全量数据请使用 LIMIT 或导出"`
- 截断提示带"导出全量"按钮，复用现有 ExportDialog
- 结果集内部加轻量翻页（上一页/下一页，每页 200 行）
- DML 报告（INSERT/UPDATE 行数统计）不受影响，只有 SELECT 结果集走此逻辑
- 翻页控件与 TableDataView 工具栏风格一致（ChevronLeft / ChevronRight）

### 2. TableDataView 虚拟滚动（`useVirtualRows.ts` + `VirtualTable.tsx`）

**依赖**：`@tanstack/react-virtual`

**`useVirtualRows.ts`**：
```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

export function useVirtualRows(
  count: number,
  scrollRef: React.RefObject<HTMLDivElement>
) {
  return useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,   // 行高估算 32px
    overscan: 5,              // 可视区上下各预渲染 5 行
  });
}
```

**`VirtualTable.tsx`**：通用虚拟表格容器，接受 `rowVirtualizer` 和 `renderRow` 回调：
```typescript
// tbody 改为绝对定位，只渲染虚拟行
<tbody style={{ height: `${totalSize}px`, position: 'relative' }}>
  {virtualRows.map(vRow => (
    <tr
      key={vRow.key}
      style={{ position: 'absolute', transform: `translateY(${vRow.start}px)`, width: '100%' }}
    >
      {renderRow(vRow.index)}
    </tr>
  ))}
</tbody>
```

**与现有功能的集成**：

| 功能 | 处理方式 |
|------|----------|
| EditableCell 编辑态 | pending state 存于 `usePendingChanges` hook（内存），不依赖 DOM，滚走不丢失 |
| 行背景色（删除/编辑高亮） | `rowBgClass(ri)` 照常用，rowIdx 用真实索引 |
| 右键菜单坐标 | 来自 `e.clientX/Y`，不受虚拟滚动影响 |
| sticky thead | 保持 `sticky top-0`，虚拟滚动只影响 tbody |
| pageSize 选项 | 保留 100/200/500/1000，1000 行在虚拟滚动下完全流畅 |

### 3. 性能目标

| 场景 | 当前 DOM 节点数 | 优化后 DOM 节点数 | 目标帧率 |
|------|----------------|-------------------|----------|
| TableDataView 1000行×20列 | ~20,000 | ≤ 1,000（50行×20列） | ≥ 60fps |
| SQL 结果集 5000行 | 5,000+ 行节点 | ≤ 200 行节点（分页） | N/A |

---

## 不在范围内

- 列级虚拟滚动（宽表横向虚拟化）：留作后续迭代
- Rust 层查询结果流式返回：留作后续迭代
- TableDataView 的 pageSize 上限调整：保持现状（虚拟滚动后 1000 行已够用）

---

## 实现步骤（高层）

1. `npm install @tanstack/react-virtual`
2. 新建 `src/hooks/useVirtualRows.ts`
3. 新建 `src/components/MainContent/VirtualTable.tsx`
4. 改造 `TableDataView.tsx` 接入虚拟滚动
5. 改造 `MainContent/index.tsx` SQL 结果集加截断+分页
6. 手工测试：1000 行表浏览、10000 行 SQL 查询结果
