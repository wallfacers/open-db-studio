<!-- STATUS: ✅ 已实现 -->
# 大批量数据渲染优化 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 SQL 编辑器查询结果集在大数据量（5000-10000 行）时的页面冻结，并为 TableDataView 引入行级虚拟滚动，将 1000 行场景的 DOM 节点数降低 95%。

**Architecture:** SQL 编辑器结果集采用前端截断（500 行上限）+ 结果内分页（每页 200 行），不引入虚拟滚动；TableDataView 引入 `@tanstack/react-virtual` 行级虚拟滚动，通过 `tbody display:block` + `tr display:flex` 方案在原生 `<table>` 上实现虚拟化，同时保留可编辑单元格、克隆行、右键菜单等现有功能。

**Tech Stack:** React 18, TypeScript, `@tanstack/react-virtual`, Tailwind CSS, Vitest

---

## 文件地图

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 新增 | `src/hooks/useVirtualRows.ts` | 封装 `useVirtualizer`，暴露行虚拟化实例 |
| 新增 | `src/components/MainContent/VirtualTable.tsx` | 虚拟表格容器，接受 thead/renderRow/rowVirtualizer |
| 新增 | `src/components/MainContent/VirtualTable.test.tsx` | VirtualTable 单元测试 |
| 修改 | `src/components/MainContent/TableDataView.tsx` | 接入 VirtualTable，添加 scrollRef，处理克隆行虚拟化 |
| 修改 | `src/components/MainContent/index.tsx` | SQL 结果集加截断提示 + 前端分页 |
| 修改 | `src/components/MainContent/MainContent.test.tsx` | 补充结果集截断场景测试 |

---

## Chunk 1: 安装依赖 + 创建 useVirtualRows hook

### Task 1: 安装 @tanstack/react-virtual

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install @tanstack/react-virtual
```

预期输出包含：`added 1 package` 或类似字样，`@tanstack/react-virtual` 出现在 `package.json` dependencies 中。

- [ ] **Step 2: 验证安装**

```bash
node -e "require('./node_modules/@tanstack/react-virtual/build/lib/index.cjs')" && echo OK
```

预期：`OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @tanstack/react-virtual dependency"
```

---

### Task 2: 创建 useVirtualRows hook

**Files:**
- Create: `src/hooks/useVirtualRows.ts`

- [ ] **Step 1: 创建文件**

创建 `src/hooks/useVirtualRows.ts`，内容如下：

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

/**
 * 行级虚拟滚动 hook，封装 @tanstack/react-virtual 的 useVirtualizer。
 *
 * @param count       - 总行数（当前页数据行 + 克隆行）
 * @param scrollRef   - 外层滚动容器的 ref，需设置 overflow-auto 且有明确高度
 * @returns           - Virtualizer 实例，包含 getVirtualItems() 和 getTotalSize()
 */
export function useVirtualRows(
  count: number,
  scrollRef: RefObject<HTMLDivElement | null>
) {
  return useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28, // py-1.5(12px) + text-xs line-height(16px) = 28px
    overscan: 5,
  });
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useVirtualRows.ts
git commit -m "feat(virtual-table): add useVirtualRows hook"
```

---

### Task 3: 创建 VirtualTable 组件

**Files:**
- Create: `src/components/MainContent/VirtualTable.tsx`
- Create: `src/components/MainContent/VirtualTable.test.tsx`

- [ ] **Step 1: 先写测试**

创建 `src/components/MainContent/VirtualTable.test.tsx`：

```typescript
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// Mock @tanstack/react-virtual
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(),
}));

// 构造一个最小化的 mock Virtualizer
function makeMockVirtualizer(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({
    key: i,
    index: i,
    start: i * 28,
    size: 28,
    lane: 0,
    end: i * 28 + 28,
  }));
  return {
    getVirtualItems: () => items,
    getTotalSize: () => count * 28,
    measureElement: vi.fn(),
  } as any;
}

describe('VirtualTable', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('渲染 thead 内容', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(3);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id', 'name'],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null,
            React.createElement('th', null, 'ID'),
            React.createElement('th', null, 'Name'),
          ),
          renderRow: (ri) => React.createElement('td', { key: ri }, `row-${ri}`),
        })
      );
    });
    expect(container.textContent).toContain('ID');
    expect(container.textContent).toContain('Name');
  });

  it('只渲染虚拟行数量的 tr', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(3);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id'],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null),
          renderRow: (ri) => React.createElement('td', null, `row-${ri}`),
        })
      );
    });
    // 只应有 3 行（mock 返回 3 个虚拟行）
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
  });

  it('tbody 高度等于 getTotalSize()', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(5);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id'],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null),
          renderRow: (ri) => React.createElement('td', null, `r${ri}`),
        })
      );
    });
    const tbody = container.querySelector('tbody') as HTMLElement;
    expect(tbody.style.height).toBe('140px'); // 5 * 28 = 140
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test -- VirtualTable.test
```

预期：FAIL，原因是 `VirtualTable` 模块不存在。

- [ ] **Step 3: 实现 VirtualTable 组件**

创建 `src/components/MainContent/VirtualTable.tsx`：

```tsx
import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

interface VirtualTableProps {
  /** 列名列表，用于生成 colgroup（行号列宽 40px，数据列宽 150px） */
  columns: string[];
  /** 虚拟滚动实例，由调用方通过 useVirtualRows 创建 */
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  /**
   * 渲染单行所有 <td> 的回调。
   * rowIndex 是数据真实索引（包含克隆行偏移后的绝对下标）。
   * 返回值直接放入 <tr> 内，应为若干 <td> 元素。
   */
  renderRow: (rowIndex: number) => React.ReactNode;
  /** thead 行内容（<tr> 元素），由调用方传入以保留排序图标等逻辑 */
  thead: React.ReactNode;
}

/**
 * 虚拟表格容器。
 *
 * 布局方案：table-layout:fixed + colgroup 控制列宽，tbody 设为 display:block
 * 脱离表格布局流，虚拟行用 display:flex + position:absolute 精确定位。
 * thead 的 <th> 宽度必须与 <col> 宽度一致才能对齐列头与数据（调用方负责）。
 */
export const VirtualTable: React.FC<VirtualTableProps> = ({
  columns,
  rowVirtualizer,
  renderRow,
  thead,
}) => {
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <table
      style={{ tableLayout: 'fixed', width: '100%', borderCollapse: 'collapse' }}
      className="text-left whitespace-nowrap text-xs"
    >
      <colgroup>
        {/* 行号列 */}
        <col style={{ width: '40px' }} />
        {/* 数据列：每列 150px */}
        {columns.map((col) => (
          <col key={col} style={{ width: '150px' }} />
        ))}
      </colgroup>

      <thead className="sticky top-0 bg-[#0d1117] z-10">
        {thead}
      </thead>

      <tbody
        style={{
          display: 'block',
          position: 'relative',
          height: `${totalSize}px`,
        }}
      >
        {virtualRows.map((vRow) => (
          <tr
            key={vRow.key}
            style={{
              display: 'flex',
              position: 'absolute',
              top: 0,
              transform: `translateY(${vRow.start}px)`,
              width: '100%',
            }}
            className="border-b border-[#1e2d42]"
          >
            {renderRow(vRow.index)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npm test -- VirtualTable.test
```

预期：3 个测试全部 PASS。

- [ ] **Step 5: TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 6: Commit**

```bash
git add src/components/MainContent/VirtualTable.tsx src/components/MainContent/VirtualTable.test.tsx
git commit -m "feat(virtual-table): add VirtualTable component with tests"
```

---

## Chunk 2: 改造 TableDataView 接入虚拟滚动

### Task 4: 重构 TableDataView 使用 VirtualTable

**Files:**
- Modify: `src/components/MainContent/TableDataView.tsx:254-560`

> **重要背景**：
> - 滚动容器位于第 413 行：`<div className="flex-1 overflow-auto relative">`，只需加 `ref`。
> - `pending.clonedRows` 在原代码 tbody 末尾追加，重构后通过 `count = data.rows.length + pending.clonedRows.length` 合并到虚拟滚动。
> - `rowBgClass(ri)` 已接受数据真实索引，不需修改。
> - thead 的每个 `<th>` 需显式设置宽度（行号列 40px，其他 150px）以匹配 VirtualTable 的 colgroup，否则列头与数据列会错位。
> - 第 417 行的 `noData` 条件将从 `data.rows.length === 0` 改为 `data.rows.length === 0 && pending.clonedRows.length === 0`，原因：用户可能在空表上克隆新行，此时 `data.rows` 为空但 `clonedRows` 不为空，不应显示"无数据"提示。

- [ ] **Step 1: 在文件顶部追加两个 import**

在 `TableDataView.tsx` 的第 16 行（最后一个 import 行）之后添加：

```typescript
import { VirtualTable } from './VirtualTable';
import { useVirtualRows } from '../../hooks/useVirtualRows';
```

注意：`useRef` 已在第 1 行的 React import 中存在，无需再引入。

- [ ] **Step 2: 在组件函数内添加 scrollRef 和 rowVirtualizer**

在 `const { pending, ...} = usePendingChanges();` 这一行（第 72 行）之后添加：

```typescript
// 虚拟滚动：scrollRef 绑定到外层滚动容器，count 包含数据行 + 克隆行
const scrollRef = useRef<HTMLDivElement>(null);
const virtualRowCount = data ? data.rows.length + pending.clonedRows.length : 0;
const rowVirtualizer = useVirtualRows(virtualRowCount, scrollRef);
```

- [ ] **Step 3: 替换 Table 区域 JSX**

将第 412-505 行（`{/* Table */}` 注释至该块结束的 `</>`）替换为以下内容：

```tsx
{/* Table */}
<div ref={scrollRef} className="flex-1 overflow-auto relative">
  {isLoading && !data && (
    <div className="absolute inset-0 flex items-center justify-center text-[#7a9bb8] text-sm">{t('tableDataView.loading')}</div>
  )}
  {!isLoading && (!data || (data.rows.length === 0 && pending.clonedRows.length === 0)) && (
    <div className="absolute inset-0 flex items-center justify-center text-[#7a9bb8] text-sm">{t('tableDataView.noData')}</div>
  )}
  {data && (data.rows.length > 0 || pending.clonedRows.length > 0) && (
    <>
      {isLoading && <div className="absolute inset-0 bg-[#080d12]/40 z-10 pointer-events-none" />}
      <VirtualTable
        columns={data.columns}
        rowVirtualizer={rowVirtualizer}
        thead={
          <tr>
            {/* 行号列表头：宽度 40px，与 colgroup 对齐 */}
            <th style={{ width: '40px', minWidth: '40px' }} className="px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal">
              {t('tableDataView.serialNo')}
            </th>
            {data.columns.map(col => (
              <th key={col} style={{ width: '150px', minWidth: '150px' }} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal group/th">
                <div className="flex items-center justify-between gap-1 w-full">
                  <span className="truncate">{col}</span>
                  <Tooltip content={
                    sortCol === col && sortDir === 'ASC' ? t('tableDataView.sortDesc')
                    : sortCol === col && sortDir === 'DESC' ? t('tableDataView.sortAsc')
                    : t('tableDataView.sortAsc')
                  }>
                    <button
                      className={`flex-shrink-0 leading-none transition-colors ${
                        sortCol === col
                          ? 'text-[#00c9a7]'
                          : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
                      }`}
                      onClick={() => {
                        if (sortCol !== col) { setSortCol(col); setSortDir('ASC'); }
                        else if (sortDir === 'ASC') { setSortDir('DESC'); }
                        else { setSortCol(null); setSortDir(null); }
                      }}
                    >
                      {sortCol === col && sortDir === 'ASC' ? <ChevronUp size={11}/> :
                       sortCol === col && sortDir === 'DESC' ? <ChevronDown size={11}/> :
                       <ChevronsUpDown size={11}/>}
                    </button>
                  </Tooltip>
                </div>
              </th>
            ))}
          </tr>
        }
        renderRow={(ri) => {
          // 克隆行（绿色）
          if (ri >= data.rows.length) {
            const cloneIdx = ri - data.rows.length;
            const row = pending.clonedRows[cloneIdx];
            return (
              <>
                <td style={{ width: '40px', minWidth: '40px' }} className="px-2 py-1.5 border-r border-[#1e2d42] text-green-400 bg-[#0d1117] text-center text-xs select-none flex-shrink-0">
                  <button
                    onClick={() => removeClonedRow(cloneIdx)}
                    className="text-red-400 hover:text-red-300 leading-none"
                    title={t('tableDataView.deleteRowMenuItem')}
                  >×</button>
                </td>
                {row.map((cell, ji) => (
                  <td key={ji} style={{ width: '150px', minWidth: '150px' }} className="px-3 py-1.5 text-green-400 border-r border-[#1e2d42] truncate flex-shrink-0">
                    {cell === null ? <span className="text-[#7a9bb8]">NULL</span> : String(cell)}
                  </td>
                ))}
              </>
            );
          }
          // 普通数据行
          const row = data.rows[ri];
          return (
            <>
              {/* 行号列 */}
              <td
                style={{ width: '40px', minWidth: '40px' }}
                className={`px-2 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none flex-shrink-0 ${rowBgClass(ri)}`}
                onContextMenu={e => handleContextMenu(e, ri, -1, 'row')}
              >
                {(page - 1) * pageSize + ri + 1}
              </td>
              {/* 数据单元格 */}
              {row.map((cell, ci) => (
                <EditableCell
                  key={ci}
                  value={cell}
                  pendingValue={getPendingValue(ri, ci)}
                  isDeleted={isRowDeleted(ri)}
                  onCommit={newVal => editCell(ri, ci, newVal)}
                  onContextMenu={e => handleContextMenu(e, ri, ci, 'cell')}
                  onOpenEditor={() => openCellEditor(ri, ci)}
                  style={{ width: '150px', minWidth: '150px' }}
                />
              ))}
            </>
          );
        }}
      />
    </>
  )}
</div>
```

> **注意**：`EditableCell` 组件需要接受 `style` prop 以设置 flex 子项宽度。检查 `EditableCell.tsx` 是否已有 `style` prop，若无则在下一步添加。

- [ ] **Step 4: 更新 EditableCell 以支持 style prop**

`EditableCell.tsx` 有**两个** `<td>` 分支（编辑态和正常态），都需要添加 `style` prop：

在 `EditableCellProps` 接口（第 4-12 行）中添加：
```typescript
style?: React.CSSProperties;
```

在组件参数解构（第 14-22 行）中添加 `style`。

编辑态 `<td>`（第 62 行），将 `style={{ outline: ... }}` 改为合并传入的 style：
```tsx
<td
  className="border-r border-[#1e2d42] p-0 relative"
  style={{ outline: '1px solid #3a7bd5', outlineOffset: '-1px', ...style }}
>
```

正常态 `<td>`（第 80 行），添加 `style={style}`：
```tsx
<td
  className={`${baseCellClass} group`}
  style={style}
  onDoubleClick={startEdit}
  onContextMenu={onContextMenu}
>
```

- [ ] **Step 5: TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：无报错。如有 `style` prop 相关报错，检查 Step 4 是否完成。

- [ ] **Step 6: 手工验证**

启动开发服务器（`npm run dev`，在浏览器中打开），连接数据库，浏览含 100+ 行的表：
- 表头与数据列对齐
- 滚动时数据行正确更新
- 右键菜单仍然可用
- 编辑后的单元格（pending state）滚走再滚回后值仍保留
- 克隆行显示绿色并可删除

- [ ] **Step 7: Commit**

```bash
git add src/components/MainContent/TableDataView.tsx src/components/MainContent/EditableCell.tsx
git commit -m "feat(virtual-table): refactor TableDataView to use VirtualTable with row virtualization"
```

---

## Chunk 3: SQL 编辑器结果集截断与分页

### Task 5: 为 SQL 结果集添加前端截断和分页

**Files:**
- Modify: `src/components/MainContent/index.tsx:989-1087`
- Modify: `src/components/MainContent/MainContent.test.tsx`

> **重要背景**：
> - `currentResults` = `results[activeTab] ?? []`（来自 queryStore）
> - `currentSql` = `sqlContent[activeTab] ?? ''`（当前 SQL 编辑器内容，用于导出时标注）
> - 结果对象结构：`{ kind: 'select' | 'dml-report', columns: string[], rows: (string|null)[][], row_count: number, duration_ms: number }`
> - 导出策略：直接使用内存中的 `result.rows`（全量，未截断），构建 CSV 并触发浏览器下载，无需再调用 `invoke`。
> - 翻页 state 需在每次结果切换时重置（`selectedResultPane` 变化时重置 `resultPage` 为 0）。

- [ ] **Step 1: 先写测试**

在 `MainContent.test.tsx` 末尾添加新的 describe 块：

```typescript
describe('SQL 结果集截断与分页', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('结果行数 <= 200 时不显示截断提示和翻页', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q1', type: 'query', title: 'Q1' }],
      activeTabId: 'q1',
      results: { q1: [{ kind: 'select', columns: ['id'], rows, row_count: 50, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.textContent).not.toContain('显示前');
    expect(container.querySelector('[data-testid="result-pagination"]')).toBeNull();
  });

  it('结果行数 > 500 时显示截断提示', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q2', type: 'query', title: 'Q2' }],
      activeTabId: 'q2',
      results: { q2: [{ kind: 'select', columns: ['id'], rows, row_count: 600, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.textContent).toContain('600');
    expect(container.textContent).toContain('500');
  });

  it('结果行数 > 200 时显示翻页控件', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q3', type: 'query', title: 'Q3' }],
      activeTabId: 'q3',
      results: { q3: [{ kind: 'select', columns: ['id'], rows, row_count: 250, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.querySelector('[data-testid="result-pagination"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test -- MainContent.test
```

预期：新增的 3 个测试 FAIL（截断/分页逻辑尚未实现）。

- [ ] **Step 3: 在 index.tsx 中添加常量（模块级）和 state（组件内）**

**模块级常量**：在文件顶部 import 区结束后、组件函数开始前添加（约第 100 行附近，`function getSqlAtCursor` 之后）：

```typescript
// 结果集分页常量（模块级，非组件内）
const RESULT_PAGE_SIZE = 200;
const RESULT_MAX_ROWS = 500;
```

**组件内 state**：在组件函数内，`resultCellMenu` state（第 225 行）附近添加：

```typescript
const [resultPage, setResultPage] = useState(0);
```

**切换 tab 时重置分页**：在组件内添加 effect：

```typescript
useEffect(() => {
  setResultPage(0);
}, [selectedResultPane, activeTab]);
```

- [ ] **Step 4: 替换结果集渲染区域**

找到 `index.tsx` 中 `<div className="flex-1 overflow-auto">` 内的结果集渲染部分（约第 989-1080 行），将原有 `<table>...</table>` 渲染块替换为带截断和分页逻辑的版本：

在组件 return 的 JSX 中，找到如下结构（约第 1023-1076 行）：

```tsx
) : (
  <>
    <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
      ...（原有全量渲染）...
    </table>
  </>
)}
```

替换为：

```tsx
) : (() => {
  const activeResult = typeof selectedResultPane === 'number'
    ? currentResults[selectedResultPane]
    : undefined;

  if (!activeResult) return null;

  // 原始代码中 dml-report 和 select 使用相同的表格渲染逻辑（不区分 kind）。
  // 本次重构仅对 select 结果（可能有大量行）添加截断+分页；
  // dml-report 结果（通常 < 10 行，如"✓ 5 rows affected"）直接使用原始全量渲染。
  const allRows = activeResult.rows;

  // dml-report 或行数极少：使用原始全量渲染，无截断无分页
  if (activeResult.kind === 'dml-report' || allRows.length <= RESULT_PAGE_SIZE) {
    return (
      <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
        <thead className="sticky top-0 bg-[#0d1117] z-10">
          <tr>
            <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal text-center">{t('tableDataView.serialNo')}</th>
            {activeResult.columns.map((col) => (
              <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allRows.map((row, ri) => (
            <tr key={ri} className="hover:bg-[#1a2639] border-b border-[#1e2d42]">
              <td
                className="px-3 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-left text-xs select-none cursor-default"
                onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: -1 }); }}
              >{ri + 1}</td>
              {row.map((cell, ci) => {
                const colName = activeResult.columns[ci] ?? '';
                const cellStr = cell === null ? null : String(cell);
                return (
                  <td
                    key={ci}
                    className="px-3 py-1.5 border-r border-[#1e2d42] relative group text-left"
                    onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: ci }); }}
                  >
                    <div className="max-w-[300px] truncate" title={cellStr ?? undefined}>
                      {cell === null
                        ? <span className="text-[#7a9bb8]">NULL</span>
                        : typeof cell === 'string' && cell.startsWith('✓')
                          ? <span className="text-green-400">{cell}</span>
                          : <span className="text-[#c8daea]">{cellStr}</span>}
                    </div>
                    {cellStr !== null && (
                      <button
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[#243a55] rounded text-[#7a9bb8] hover:text-[#3a7bd5] transition-opacity"
                        onClick={() => setResultCellViewer({ value: cellStr, columnName: colName })}
                      >
                        <Maximize2 size={10} />
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // SELECT 结果（行数 > RESULT_PAGE_SIZE）：截断 + 分页
  const displayRows = allRows.slice(0, RESULT_MAX_ROWS); // 展示行上限 500
  const totalDisplayPages = Math.ceil(displayRows.length / RESULT_PAGE_SIZE);
  const pageRows = displayRows.slice(
    resultPage * RESULT_PAGE_SIZE,
    (resultPage + 1) * RESULT_PAGE_SIZE
  );
  const isTruncated = allRows.length > RESULT_MAX_ROWS;

  // CSV 导出辅助函数（使用全量 allRows）
  const exportCsv = () => {
    const header = activeResult.columns.join(',');
    const body = allRows.map(row =>
      row.map(cell => (cell === null ? '' : `"${String(cell).replace(/"/g, '""')}"`)).join(',')
    ).join('\n');
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query_result.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {/* 截断提示条 */}
      {isTruncated && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-900/30 border-b border-yellow-700/50 text-yellow-300 text-xs flex-shrink-0">
          <span>⚠ 查询返回 {allRows.length} 行，当前显示前 {RESULT_MAX_ROWS} 行。如需查看全量数据请使用 LIMIT 或导出。</span>
          <button
            onClick={exportCsv}
            className="ml-auto px-2 py-0.5 rounded border border-yellow-600 hover:bg-yellow-800/50 transition-colors flex-shrink-0"
          >
            导出全量
          </button>
        </div>
      )}

      {/* 数据表格 */}
      <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
        <thead className="sticky top-0 bg-[#0d1117] z-10">
          <tr>
            <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal text-center">{t('tableDataView.serialNo')}</th>
            {activeResult.columns.map((col) => (
              <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, pageRi) => {
            const ri = resultPage * RESULT_PAGE_SIZE + pageRi; // 真实全局行索引（用于行号显示）
            return (
              <tr key={ri} className="hover:bg-[#1a2639] border-b border-[#1e2d42]">
                <td
                  className="px-3 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-left text-xs select-none cursor-default"
                  onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: -1 }); }}
                >{ri + 1}</td>
                {row.map((cell, ci) => {
                  const colName = activeResult.columns[ci] ?? '';
                  const cellStr = cell === null ? null : String(cell);
                  return (
                    <td
                      key={ci}
                      className="px-3 py-1.5 border-r border-[#1e2d42] relative group text-left"
                      onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: ci }); }}
                    >
                      <div className="max-w-[300px] truncate" title={cellStr ?? undefined}>
                        {cell === null
                          ? <span className="text-[#7a9bb8]">NULL</span>
                          : typeof cell === 'string' && cell.startsWith('✓')
                            ? <span className="text-green-400">{cell}</span>
                            : <span className="text-[#c8daea]">{cellStr}</span>}
                      </div>
                      {cellStr !== null && (
                        <button
                          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[#243a55] rounded text-[#7a9bb8] hover:text-[#3a7bd5] transition-opacity"
                          onClick={() => setResultCellViewer({ value: cellStr, columnName: colName })}
                        >
                          <Maximize2 size={10} />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 翻页控件（行数 > RESULT_PAGE_SIZE 时显示） */}
      {displayRows.length > RESULT_PAGE_SIZE && (
        <div
          data-testid="result-pagination"
          className="flex-shrink-0 h-8 flex items-center justify-center gap-3 border-t border-[#1e2d42] bg-[#080d12] text-[#7a9bb8] text-xs"
        >
          <button
            disabled={resultPage <= 0}
            onClick={() => setResultPage(p => p - 1)}
            className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
          >
            <ChevronLeft size={14}/>
          </button>
          <span>第 {resultPage + 1} / {totalDisplayPages} 页</span>
          <button
            disabled={resultPage >= totalDisplayPages - 1}
            onClick={() => setResultPage(p => p + 1)}
            className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
          >
            <ChevronRight size={14}/>
          </button>
        </div>
      )}
    </>
  );
})()}
```

- [ ] **Step 5: 运行所有测试**

```bash
npm test
```

预期：全部通过，包括新增的 3 个截断/分页测试。

- [ ] **Step 6: TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 7: 手工验证**

在开发模式下：
1. 执行返回 50 行的查询 → 无截断提示，无翻页控件
2. 执行返回 250 行的查询 → 翻页控件显示，可切换到第 2 页
3. 执行返回 600 行的查询 → 黄色提示条显示"600 行...前 500 行"，"导出全量"按钮可触发 CSV 下载
4. DML（INSERT/UPDATE）报告不受影响

- [ ] **Step 8: Commit**

```bash
git add src/components/MainContent/index.tsx src/components/MainContent/MainContent.test.tsx
git commit -m "feat(result-paging): add truncation warning and pagination for SQL result sets"
```

---

## Chunk 4: 最终验收

### Task 6: 性能验收与收尾

**Files:**
- 无代码修改

- [ ] **Step 1: 运行全量测试套件**

```bash
npm test
```

预期：全部通过。

- [ ] **Step 2: TypeScript 全量检查**

```bash
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: Chrome DevTools 性能验收（手工）**

1. 在开发模式下打开 TableDataView，选择 pageSize=1000，浏览一张 1000 行的表
2. 打开 Chrome DevTools → Elements → 检查 `<tbody>` 内 `<tr>` 数量应 ≤ 60（overscan=5，约 50行可视 + 10行预渲染）
3. 打开 Performance 面板 → 开始录制 → 快速滚动 2 秒 → 停止录制
4. 检查 Frames 区域：无红色长帧，平均帧时 < 16ms

- [ ] **Step 4: Commit 性能验收结论（可选）**

若验收通过，可在提交说明中标注：

```bash
git commit --allow-empty -m "perf: virtual table verified - <60 DOM rows in 1000-row view, 60fps scroll"
```

---

## 已知风险与降级方案

| 风险 | 描述 | 降级方案 |
|------|------|----------|
| thead 列宽对齐偏差 | `display:block` tbody 后 thead 与 colgroup 不自动联动，需 `<th>` 显式宽度 | 每列 `<th>` 必须设置 `style={{ width: '150px', minWidth: '150px' }}` |
| EditableCell 缺少 style prop | 组件可能无 `style` 入参导致 td 宽度无法设置 | 检查并添加 `style?: React.CSSProperties` 传递到 `<td>` |
| 行高估算偏差导致滚动条跳动 | `estimateSize: 28` 与实际行高不符 | 实际行高用 DevTools 量取后调整常量 |
| IPC 大数据传输仍冻结 | 截断只解决渲染层，后端返回 >1 万行时 JSON 解析仍卡 | 本次范围外，后续迭代在 Rust 层加 LIMIT 保护 |
