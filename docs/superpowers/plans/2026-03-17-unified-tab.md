# Unified Tab Content Area Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数据库模式与业务指标模式共用同一个右侧 Tab 内容区，切换活动时 Tab 栏不重置，左侧边栏根据活动切换。

**Architecture:** 将所有 Tab 状态从 App.tsx 本地 state 和 MetricsLayout 本地 state 统一迁移至 `queryStore`；`MainContent` 从 props 改为直接读取 `queryStore`；`MetricsLayout` 拆分为独立的 `MetricsSidebar` + 复用 `MainContent` 渲染指标 Tab。

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Lucide React, Tauri 2.x

**Spec:** `docs/superpowers/specs/2026-03-17-unified-tab-design.md`

---

## 范围说明：不在本次计划内

以下内容超出本次 Tab 统一的边界，**不做修改**：

- `App.tsx` 中的 `sqlContent`、`isExecuting`、`handleExecute`、`handleClear`、`tableData`、`executionTime` 等本地 state 及其对应的 `MainContent` props ——这些属于 SQL 执行状态层，spec 未要求迁移。
- `MetricTab`、`MetricListPanel` 内部逻辑。
- `Assistant`、`GraphExplorer`、`MigrationWizard` 等模块的功能逻辑（仅在 App.tsx 重构中更新 `connectionId` 数据来源）。

---

## File Map

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/types/index.ts` | 修改 | 扩展 TabType + Tab 接口 |
| `src/store/queryStore.ts` | 修改 | 新增 Tab 管理方法 + localStorage 持久化 |
| `src/store/queryStore.test.ts` | 新建 | queryStore Tab 方法单元测试 |
| `src/components/MainContent/index.tsx` | 修改 | 从 queryStore 读取 tabs，扩展 metric 渲染 |
| `src/components/MetricsExplorer/MetricsSidebar.tsx` | 新建 | 从 MetricsLayout 拆出左侧树 |
| `src/components/MetricsExplorer/MetricsLayout.tsx` | 删除 | 职责已分拆 |
| `src/App.tsx` | 修改 | 删除本地 tab state，切换侧边栏逻辑 |

---

## Chunk 1: Types + queryStore

### Task 1: 扩展 Tab 类型

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 打开文件，定位 TabType 和 Tab 接口**

当前内容（约第 91-106 行）：
```ts
export type TabType = 'query' | 'table' | 'er_diagram' | 'metric' | 'metric_list';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;
  metricScope?: MetricScope;
}
```

- [ ] **Step 2: 将 `TabType` 加入 `table_structure`，将 `Tab` 合并 `TabData` 字段**

替换为：
```ts
export type TabType =
  | 'query'
  | 'table'
  | 'er_diagram'
  | 'table_structure'   // 从 App.tsx TabData 迁移
  | 'metric'
  | 'metric_list';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;           // metric Tab 专用
  metricScope?: MetricScope;   // metric_list Tab 专用
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;        // table_structure Tab 专用
}
```

- [ ] **Step 3: 确认 `QueryContext` 已导出（无需操作）**

`QueryContext` 已在 `src/types/index.ts` 约第 226 行导出，无需添加。仅需确认 `Tab` 中新加的 `queryContext?: QueryContext` 字段能正确引用到它（同文件内，无需额外 import）。

- [ ] **Step 4: 运行 TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：报错集中在 `App.tsx`（引用了旧 `TabData`）和 `MainContent`（props 类型不匹配），这是预期的，后续任务会修复。

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): extend Tab interface with table_structure and TabData fields"
```

---

### Task 2: queryStore — Tab 生命周期管理方法

**Files:**
- Modify: `src/store/queryStore.ts`
- Create: `src/store/queryStore.test.ts`

当前 `queryStore` 已有 `tabs: Tab[]`、`activeTabId: string`、`openMetricTab`、`openMetricListTab`，只需补充缺失的方法。

- [ ] **Step 1: 写失败测试**

新建 `src/store/queryStore.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useQueryStore } from './queryStore';

// 重置 store 状态
beforeEach(() => {
  useQueryStore.setState({
    tabs: [
      { id: 'q1', type: 'query', title: 'Q1' },
      { id: 'q2', type: 'query', title: 'Q2' },
      { id: 'q3', type: 'query', title: 'Q3' },
    ],
    activeTabId: 'q2',
  });
});

describe('closeTab', () => {
  it('关闭非活动 tab，活动 tab 不变', () => {
    useQueryStore.getState().closeTab('q1');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q2', 'q3']);
    expect(activeTabId).toBe('q2');
  });

  it('关闭活动 tab，激活同位置（取右邻居）', () => {
    useQueryStore.getState().closeTab('q2');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q1', 'q3']);
    // q2 在 index 1，next=[q1,q3]，Math.min(1, 1) => next[1] = q3
    expect(activeTabId).toBe('q3');
  });

  it('关闭最后一个活动 tab，激活新的末尾', () => {
    useQueryStore.getState().closeTab('q3');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q1', 'q2']);
    // q3 在 index 2，next=[q1,q2]，Math.min(2, 1) => next[1] = q2
    expect(activeTabId).toBe('q2');
  });
});

describe('closeAllTabs', () => {
  it('清空所有 tab', () => {
    useQueryStore.getState().closeAllTabs();
    expect(useQueryStore.getState().tabs).toHaveLength(0);
    expect(useQueryStore.getState().activeTabId).toBe('');
  });
});

describe('closeTabsLeft', () => {
  it('关闭 q3 左侧，保留 q3', () => {
    useQueryStore.getState().closeTabsLeft('q3');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q3']);
  });
});

describe('closeTabsRight', () => {
  it('关闭 q1 右侧，保留 q1', () => {
    useQueryStore.getState().closeTabsRight('q1');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q1']);
  });
});

describe('closeOtherTabs', () => {
  it('仅保留指定 tab', () => {
    useQueryStore.getState().closeOtherTabs('q2');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q2']);
    expect(useQueryStore.getState().activeTabId).toBe('q2');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm run test -- queryStore.test.ts
```

预期：FAIL — `closeTab is not a function`

- [ ] **Step 3: 在 queryStore 中实现这些方法**

在 `queryStore.ts` 的 `QueryState` interface 中添加方法签名：
```ts
closeTab: (tabId: string) => void;
closeAllTabs: () => void;
closeTabsLeft: (tabId: string) => void;
closeTabsRight: (tabId: string) => void;
closeOtherTabs: (tabId: string) => void;
updateTabContext: (tabId: string, ctx: Partial<QueryContext>) => void;
```

在 `create<QueryState>()` 实现体中添加：
```ts
closeTab: (tabId) =>
  set(s => {
    const next = s.tabs.filter(t => t.id !== tabId);
    if (s.activeTabId !== tabId) return { tabs: next };
    const idx = s.tabs.findIndex(t => t.id === tabId);
    const newActive = next[Math.min(idx, next.length - 1)]?.id ?? '';
    return { tabs: next, activeTabId: newActive };
  }),

closeAllTabs: () => set({ tabs: [], activeTabId: '' }),

closeTabsLeft: (tabId) =>
  set(s => {
    const idx = s.tabs.findIndex(t => t.id === tabId);
    if (idx <= 0) return s;
    const next = s.tabs.slice(idx);
    const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
    return { tabs: next, activeTabId: newActive };
  }),

closeTabsRight: (tabId) =>
  set(s => {
    const idx = s.tabs.findIndex(t => t.id === tabId);
    if (idx === s.tabs.length - 1) return s;
    const next = s.tabs.slice(0, idx + 1);
    const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
    return { tabs: next, activeTabId: newActive };
  }),

closeOtherTabs: (tabId) =>
  set(s => ({
    tabs: s.tabs.filter(t => t.id === tabId),
    activeTabId: tabId,
  })),

updateTabContext: (tabId, ctx) =>
  set(s => ({
    tabs: s.tabs.map(t =>
      t.id !== tabId ? t : {
        ...t,
        queryContext: { ...(t.queryContext ?? { connectionId: null, database: null, schema: null }), ...ctx },
      }
    ),
  })),
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npm run test -- queryStore.test.ts
```

预期：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/queryStore.ts src/store/queryStore.test.ts
git commit -m "feat(store): add closeTab/closeAllTabs/closeTabsLeft/Right/Other/updateTabContext to queryStore"
```

---

### Task 3: queryStore — 语义化 open 方法

**Files:**
- Modify: `src/store/queryStore.ts`
- Modify: `src/store/queryStore.test.ts`

这三个方法对应 App.tsx 中的 `handleNewQuery`/`handleOpenTableData`/`handleOpenTableStructure`，逻辑原样迁移。

- [ ] **Step 1: 添加失败测试**

在 `queryStore.test.ts` 追加：
```ts
describe('openQueryTab', () => {
  it('新建查询 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openQueryTab(1, 'myconn', 'mydb');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe('query');
    expect(tabs[0].queryContext?.connectionId).toBe(1);
    expect(tabs[0].queryContext?.database).toBe('mydb');
    expect(activeTabId).toBe(tabs[0].id);
  });
});

describe('openTableDataTab', () => {
  it('相同 table 不重复开 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableDataTab('users', 1, 'mydb');
    useQueryStore.getState().openTableDataTab('users', 1, 'mydb');
    expect(useQueryStore.getState().tabs).toHaveLength(1);
  });
});

describe('openTableStructureTab', () => {
  it('新建表时 title 为 新建表', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableStructureTab(1, 'mydb');
    const { tabs } = useQueryStore.getState();
    expect(tabs[0].title).toBe('新建表');
    expect(tabs[0].isNewTable).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm run test -- queryStore.test.ts
```

预期：FAIL — `openQueryTab is not a function`

- [ ] **Step 3: 在 QueryState interface 中添加方法签名**

```ts
openQueryTab: (connId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
openTableDataTab: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
openTableStructureTab: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
```

- [ ] **Step 4: 在 create 实现体中添加对应实现**

```ts
openQueryTab: (connId, connName, database, schema, initialSql) => {
  const id = `query_${connId}_${Date.now()}`;
  const queryCount = get().tabs.filter(t => t.type === 'query').length + 1;
  const tab: Tab = {
    id,
    type: 'query',
    title: `查询${queryCount}`,
    db: connName,
    queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
  };
  // 先将 tab 加入 tabs，再写 SQL 内容（setSql 仅操作 sqlContent map，顺序安全）
  set(s => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  if (initialSql) get().setSql(id, initialSql);
},

openTableDataTab: (tableName, connectionId, database, schema) => {
  const dbName = database ?? `conn_${connectionId}`;
  const id = `table_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
  set(s => {
    if (s.tabs.find(t => t.id === id)) return { activeTabId: id };
    const tab: Tab = { id, type: 'table', title: tableName, db: dbName, connectionId, schema };
    return { tabs: [...s.tabs, tab], activeTabId: id };
  });
},

openTableStructureTab: (connectionId, database, schema, tableName) => {
  const dbName = database ?? `conn_${connectionId}`;
  const isNew = !tableName;
  const id = isNew
    ? `table_structure_new_${connectionId}_${dbName}_${schema ?? ''}_${Date.now()}`
    : `table_structure_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
  set(s => {
    if (s.tabs.find(t => t.id === id)) return { activeTabId: id };
    const tab: Tab = {
      id, type: 'table_structure',
      title: tableName ?? '新建表',
      db: dbName, connectionId, schema,
      isNewTable: isNew,
    };
    return { tabs: [...s.tabs, tab], activeTabId: id };
  });
},
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npm run test -- queryStore.test.ts
```

预期：全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/queryStore.ts src/store/queryStore.test.ts
git commit -m "feat(store): add openQueryTab/openTableDataTab/openTableStructureTab to queryStore"
```

---

### Task 4: queryStore — localStorage 持久化与迁移

**Files:**
- Modify: `src/store/queryStore.ts`

- [ ] **Step 1: 在 queryStore.ts 文件顶部（create 调用之前）添加持久化辅助函数**

```ts
const TABS_STORAGE_KEY = 'unified_tabs_state';
const OLD_TABS_STORAGE_KEY = 'metrics_tabs_state';

function loadTabsFromStorage(): { tabs: Tab[]; activeTabId: string } {
  try {
    // 优先读新键
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    // 一次性迁移旧键（MetricsLayout 遗留）
    const oldRaw = localStorage.getItem(OLD_TABS_STORAGE_KEY);
    if (oldRaw) {
      const parsed = JSON.parse(oldRaw);
      localStorage.setItem(TABS_STORAGE_KEY, oldRaw);
      localStorage.removeItem(OLD_TABS_STORAGE_KEY);
      return parsed;
    }
  } catch {}
  return { tabs: [DEFAULT_TAB], activeTabId: DEFAULT_TAB.id };
}
```

注意：`loadTabsFromStorage` 需要在 `DEFAULT_TAB` 定义之后调用。请将 `DEFAULT_TAB` 定义移至文件顶部（在 `create` 之前）。

- [ ] **Step 2: 修改 create 初始化，使用持久化数据**

在 `DEFAULT_TAB` 定义之后、`create<QueryState>(...)` 调用之前，调用 `loadTabsFromStorage()` 并用模块级变量承接结果：

```ts
const DEFAULT_TAB: Tab = { id: 'query-1', type: 'query', title: 'Query 1' };
const { tabs: initialTabs, activeTabId: initialActiveTabId } = loadTabsFromStorage();
```

然后将 `create<QueryState>(...)` 实现体中的初始化字段改为：
```ts
// 改为使用持久化数据
tabs: initialTabs,
activeTabId: initialActiveTabId,
sqlContent: {},  // SQL 内容不持久化（避免存储大字符串）
```

不要使用 IIFE spread 语法（`...(() => {...})()`），TypeScript 在对象字面量中对 spread 有限制。

- [ ] **Step 3: 在 create 调用之后，添加 subscribe 写回 localStorage**

在 `export const useQueryStore = create<QueryState>(...)` 之后追加（使用简单的全状态 subscribe，无需额外 middleware）：

```ts
useQueryStore.subscribe((state) => {
  try {
    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId }),
    );
  } catch {}
});
```

注意：selector 版 `subscribe(selector, listener)` 需要 `subscribeWithSelector` middleware（非本项目当前配置），**不要使用**。简单版每次任意状态变化都写一次 localStorage，对于 Tab 操作频率可以接受。

- [ ] **Step 4: 运行所有测试**

```bash
npm run test
```

预期：全部 PASS（localStorage 在 vitest 中有 jsdom 模拟，不影响现有测试）

- [ ] **Step 5: Commit**

```bash
git add src/store/queryStore.ts
git commit -m "feat(store): add localStorage persistence with migration from metrics_tabs_state"
```

---

## Chunk 2: MainContent 重构

### Task 5: MainContent — 从 queryStore 读取 Tab 状态

> **前置条件：** Task 2（queryStore 新增 closeTab/closeAllTabs 等方法）必须已提交，否则 Step 4 的解构会报类型错误。

**Files:**
- Modify: `src/components/MainContent/index.tsx`

本任务移除 Tab 管理相关的 props，改为从 `useQueryStore` 读取。

**范围说明：** 本任务只删除 Tab 管理 props（`tabs`、`activeTab`、`closeTab` 等）。其余 props（`sqlContent`、`handleExecute`、`tableData` 等）暂时保留，它们属于 App.tsx 的执行状态层，不在本次 Tab 统一范围内。

- [ ] **Step 1: 修改 `MainContentProps` 接口，删除 Tab 管理 props**

将第 71-101 行的 interface 从：
```ts
interface MainContentProps {
  tabs: TabData[];
  activeTab: string;
  setActiveTab: (tabId: string) => void;
  closeTab: (e: React.MouseEvent, tabId: string) => void;
  closeAllTabs: () => void;
  closeTabsLeft: (tabId: string) => void;
  closeTabsRight: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  // ...其余 props 保留
}
```

改为（删除以上 8 行，保留其余）：
```ts
interface MainContentProps {
  sqlContent: string;
  setSqlContent: (content: string) => void;
  handleExecute: () => void;
  isExecuting: boolean;
  handleFormat: () => void;
  handleClear: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  isDbMenuOpen: boolean;
  setIsDbMenuOpen: (isOpen: boolean) => void;
  isTableMenuOpen: boolean;
  setIsTableMenuOpen: (isOpen: boolean) => void;
  resultsHeight: number;
  handleResultsResize: (e: React.MouseEvent) => void;
  isPageSizeMenuOpen: boolean;
  setIsPageSizeMenuOpen: (isOpen: boolean) => void;
  isExportMenuOpen: boolean;
  setIsExportMenuOpen: (isOpen: boolean) => void;
  tableData: any[];
  executionTime: number;
  showError?: (msg: string, ctx?: string | null) => void;
}
```

- [ ] **Step 2: 修改 import，删除 `TabData` 从 App，改为从 types**

将：
```ts
import { TabData } from '../../App';
```
改为：
```ts
import type { Tab } from '../../types';
```

- [ ] **Step 3: 修改组件函数签名，删除已移除的解构参数**

将第 208-216 行：
```ts
export const MainContent: React.FC<MainContentProps> = ({
  tabs, activeTab, setActiveTab, closeTab, closeAllTabs, closeTabsLeft, closeTabsRight, closeOtherTabs,
  handleFormat, showToast,
  isDbMenuOpen, setIsDbMenuOpen, isTableMenuOpen, setIsTableMenuOpen,
  resultsHeight, handleResultsResize,
  isPageSizeMenuOpen, setIsPageSizeMenuOpen, isExportMenuOpen, setIsExportMenuOpen,
  updateTabContext,
  showError,
}) => {
```

改为：
```ts
export const MainContent: React.FC<MainContentProps> = ({
  handleFormat, showToast,
  isDbMenuOpen, setIsDbMenuOpen, isTableMenuOpen, setIsTableMenuOpen,
  resultsHeight, handleResultsResize,
  isPageSizeMenuOpen, setIsPageSizeMenuOpen, isExportMenuOpen, setIsExportMenuOpen,
  showError,
}) => {
```

- [ ] **Step 4: 在组件内从 queryStore 读取 Tab 状态**

在 `const { sqlContent, setSql, ...} = useQueryStore();` 那一行（约第 219-222 行）扩展解构，补充：
```ts
const {
  tabs, activeTabId,
  setActiveTabId,
  closeTab, closeAllTabs, closeTabsLeft, closeTabsRight, closeOtherTabs,
  updateTabContext,
  openMetricTab,      // Task 7 中 MetricListPanel.onOpenMetric 会用到
  sqlContent, setSql, executeQuery,
  // ...其余原有字段不变
} = useQueryStore();
const activeTab = activeTabId;
```

同时将 `const activeTabObj = tabs.find(t => t.id === activeTab)` 中的 `TabData` 类型改为 `Tab`（如有显式类型标注）。

- [ ] **Step 5: 运行 TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：错误减少，主要剩余：App.tsx 仍向 MainContent 传了已删除的 props。

- [ ] **Step 6: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(main-content): read tab state from queryStore instead of props"
```

---

### Task 6: MainContent — 更新 closeTab 调用点

**Files:**
- Modify: `src/components/MainContent/index.tsx`

`closeTab` 签名从 `(e, tabId)` 变为 `(tabId)`，`e.stopPropagation()` 移至调用方。

- [ ] **Step 1: 找到所有 closeTab 调用点**

```bash
grep -n "closeTab" src/components/MainContent/index.tsx
```

预计在：608 行（Tab 关闭按钮）、1000 行（右键菜单）。

- [ ] **Step 2: 更新关闭按钮（约第 605-610 行）**

将：
```tsx
<button onClick={(e) => closeTab(e, tab.id)}>
```
改为：
```tsx
<button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>
```

- [ ] **Step 3: 更新右键菜单中的 closeTab 调用（约第 998-1002 行）**

将：
```tsx
closeTab(e, contextMenu.tabId);
```
改为（`e` 在菜单按钮的 `onClick` 中，需补充 stopPropagation）：
```tsx
closeTab(contextMenu.tabId);
```

若该处调用没有 `e` 参数，直接改即可；若有 onClick wrapper，按如下格式：
```tsx
onClick={(e) => { e.stopPropagation(); closeTab(contextMenu.tabId); setContextMenu(null); }}
```

- [ ] **Step 4: 检查其他右键菜单关闭操作是否也需要 stopPropagation**

搜索所有 `setContextMenu(null)` 的 onClick handler，统一加上 `e.stopPropagation()`。

- [ ] **Step 5: 运行 TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：closeTab 相关错误消失。

- [ ] **Step 6: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "fix(main-content): update closeTab call sites — move stopPropagation to call site"
```

---

### Task 7: MainContent — 渲染 metric 和 metric_list Tab

**Files:**
- Modify: `src/components/MainContent/index.tsx`

- [ ] **Step 1: 添加 MetricTab 和 MetricListPanel import**

```ts
import { MetricTab } from '../MetricsExplorer/MetricTab';
import { MetricListPanel } from '../MetricsExplorer/MetricListPanel';
```

- [ ] **Step 2: 找到内容区分支渲染逻辑（约第 617-640 行）**

当前结构：
```tsx
{activeTabObj ? (
  activeTabObj.type === 'er_diagram' ? (<ERDiagram />) :
  activeTabObj.type === 'table' ? (<TableDataView .../>) :
  activeTabObj.type === 'table_structure' ? (<TableStructureView .../>) :
  (/* SQL 编辑器 */)
) : null}
```

- [ ] **Step 3: 在 er_diagram 分支之前插入 metric/metric_list 分支**

```tsx
{activeTabObj ? (
  activeTabObj.type === 'metric' && activeTabObj.metricId ? (
    <MetricTab metricId={activeTabObj.metricId} />
  ) : activeTabObj.type === 'metric_list' && activeTabObj.metricScope ? (
    <MetricListPanel
      scope={activeTabObj.metricScope}
      onOpenMetric={(id, title) => openMetricTab(id, title)}
    />
  ) : activeTabObj.type === 'er_diagram' ? (
    <ERDiagram />
  ) : /* ... 其余不变 */
) : null}
```

- [ ] **Step 4: 扩展 Tab 栏图标，加入 metric 和 metric_list**

找到约第 595-602 行的图标判断：
```tsx
{tab.type === 'query' ? <FileCode2 .../>
 : tab.type === 'er_diagram' ? <DatabaseZap .../>
 : tab.type === 'table_structure' ? <Settings .../>
 : <TableProperties .../>}
```

改为（补充 metric 分支，并引入 BarChart2）：
```tsx
import { BarChart2 } from 'lucide-react';
// ...
{tab.type === 'query' ? <FileCode2 .../>
 : tab.type === 'er_diagram' ? <DatabaseZap .../>
 : tab.type === 'table_structure' ? <Settings .../>
 : tab.type === 'metric' ? <BarChart2 size={14} className={...} />
 : <TableProperties .../>}
```

`metric_list` 复用已有的 `TableProperties` 图标（当前 fallback 已是此图标），无需额外分支。

- [ ] **Step 5: 运行 TypeScript 检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(main-content): render metric and metric_list tab types"
```

---

## Chunk 3: MetricsSidebar + App.tsx 重构

### Task 8: 新建 MetricsSidebar 组件

**Files:**
- Create: `src/components/MetricsExplorer/MetricsSidebar.tsx`

从 `MetricsLayout.tsx` 提取左侧树部分。

- [ ] **Step 1: 新建文件 `src/components/MetricsExplorer/MetricsSidebar.tsx`**

```tsx
import React, { useState } from 'react';
import { BarChart2, RefreshCw, Search, X } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { MetricsTree } from './MetricsTree';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useQueryStore } from '../../store';

interface MetricsSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
}

export function MetricsSidebar({ sidebarWidth, onResize }: MetricsSidebarProps) {
  const { init } = useMetricsTreeStore();
  const [searchQuery, setSearchQuery] = useState('');

  const handleOpenMetricTab = (metricId: number, title: string) => {
    useQueryStore.getState().openMetricTab(metricId, title);
  };

  const handleOpenMetricListTab = (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => {
    useQueryStore.getState().openMetricListTab(scope, title);
  };

  return (
    <div
      className="flex flex-col bg-[#0d1117] border-r border-[#1e2d42] flex-shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
      {/* Resize 拖拽条 */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-20 transition-colors"
        onMouseDown={onResize}
      />
      {/* 标题栏 */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart2 size={14} className="text-[#00c9a7]" />
          <span className="font-medium text-[#c8daea]">业务指标</span>
        </div>
        <div className="flex items-center space-x-2 text-[#7a9bb8]">
          <Tooltip content="刷新">
            <RefreshCw
              size={16}
              className="cursor-pointer hover:text-[#c8daea]"
              onClick={() => init()}
            />
          </Tooltip>
        </div>
      </div>
      {/* 搜索框 */}
      <div className="p-2 border-b border-[#1e2d42]">
        <div className="flex items-center bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 focus-within:border-[#00a98f] transition-colors">
          <Search size={14} className="text-[#7a9bb8] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder="搜索指标..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-[#c8daea] w-full text-xs placeholder-[#7a9bb8]"
          />
          {searchQuery && (
            <button
              className="text-[#7a9bb8] ml-1 hover:text-[#c8daea] flex-shrink-0"
              onClick={() => setSearchQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {/* 指标树 */}
      <MetricsTree
        searchQuery={searchQuery}
        onOpenMetricTab={handleOpenMetricTab}
        onOpenMetricListTab={handleOpenMetricListTab}
      />
    </div>
  );
}
```

- [ ] **Step 2: 运行 TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：MetricsSidebar 本身无类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/MetricsExplorer/MetricsSidebar.tsx
git commit -m "feat: add MetricsSidebar component extracted from MetricsLayout"
```

---

### Task 9: 重构 App.tsx

**Files:**
- Modify: `src/App.tsx`

本任务是本次改动影响最大的文件，操作分小步进行。

- [ ] **Step 1: 删除 `TabData` 接口定义和 `MetricsLayout` import**

找到第 24-33 行的 `TabData` 接口，整段删除。

找到 `import { MetricsLayout }` 那行，删除。

添加新 import：
```ts
import { MetricsSidebar } from './components/MetricsExplorer/MetricsSidebar';
```

- [ ] **Step 2: 删除本地 Tab 状态和 activeTab 状态**

找到并删除：
```ts
const [activeTab, setActiveTab] = useState('er_diagram');
const [tabs, setTabs] = useState<TabData[]>([...]);
```

在其位置，改为从 queryStore 读取：
```ts
const { tabs, activeTabId: activeTab, openQueryTab, openTableDataTab, openTableStructureTab,
  closeTab, closeAllTabs, closeTabsLeft, closeTabsRight, closeOtherTabs,
  updateTabContext } = useQueryStore();
```

- [ ] **Step 3: 删除本地 Tab handler 函数**

删除以下函数（约 100 行）：
- `closeTab`（本地版本，约第 133-143 行）
- `closeAllTabs`
- `closeTabsLeft`
- `closeTabsRight`
- `closeOtherTabs`
- `handleOpenTableData`
- `handleOpenTableStructure`
- `handleNewQuery`
- `updateTabContext`

- [ ] **Step 4: 更新 activeConnectionId 派生逻辑**

当前 App.tsx 在调用 `GraphExplorer` 和 `Assistant` 时用：
```tsx
tabs.find(t => t.id === activeTab)?.queryContext?.connectionId ?? null
```
此处 `tabs` 和 `activeTab` 现在来自 queryStore，`queryContext` 已在 Task 1 中加入 `Tab` 类型，这行代码**无需修改**，只需确保没有多余的类型报错。

- [ ] **Step 5: 修改左侧边栏渲染逻辑**

找到当前条件渲染 Explorer 的代码块（约第 358-371 行）：
```tsx
{activeActivity !== 'settings' && activeActivity !== 'tasks' && ... && (
  <Explorer ... onNewQuery={handleNewQuery} onOpenTableData={handleOpenTableData} ... />
)}
```

替换为：
```tsx
{activeActivity === 'metrics' ? (
  <MetricsSidebar sidebarWidth={sidebarWidth} onResize={handleSidebarResize} />
) : (
  activeActivity !== 'settings' && activeActivity !== 'tasks' &&
  activeActivity !== 'graph' && activeActivity !== 'migration' && (
    <Explorer
      isSidebarOpen={isSidebarOpen}
      sidebarWidth={sidebarWidth}
      handleSidebarResize={handleSidebarResize}
      showToast={showToast}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      activeActivity={activeActivity}
      onNewQuery={openQueryTab}
      onOpenTableData={openTableDataTab}
      onOpenTableStructure={openTableStructureTab}
    />
  )
)}
```

- [ ] **Step 6: 修改中央内容区渲染逻辑**

找到 MetricsLayout 的 `div hidden/flex` 块（约第 372-375 行）和其余条件渲染（第 377-418 行）：

删除：
```tsx
{/* MetricsLayout 始终挂载，保留 Tab 和树展开状态 */}
<div className={activeActivity === 'metrics' ? 'flex flex-1 overflow-hidden' : 'hidden'}>
  <MetricsLayout />
</div>
```

修改条件渲染，将 `activeActivity === 'metrics' ? null` 分支去掉（metrics 现在走 MainContent）：
```tsx
{activeActivity === 'settings' ? (
  <SettingsPage />
) : activeActivity === 'tasks' ? (
  <TaskCenter />
) : activeActivity === 'graph' ? (
  <GraphExplorer connectionId={tabs.find(t => t.id === activeTab)?.queryContext?.connectionId ?? null} />
) : activeActivity === 'migration' ? (
  <MigrationWizard />
) : (
  <MainContent
    handleFormat={handleFormat}
    showToast={showToast}
    // ... 其余原有 props（不含已删除的 Tab 管理 props）
  />
)}
```

注意：`MainContent` 的 `tabs`/`activeTab`/`closeTab` 等 props 已在 Task 5 中删除，**不再传入**。

- [ ] **Step 7: 清理 useEffect 中 setActiveTabId 的旧同步逻辑**

找到约第 107 行：
```ts
useEffect(() => { setActiveTabId(activeTab); }, [activeTab]);
```

这行原本是为了让 queryStore.activeTabId 与 App.tsx 本地 activeTab 保持同步。现在 App.tsx 直接使用 queryStore.activeTabId，**可以删除此 useEffect**。

- [ ] **Step 8: 运行 TypeScript 检查**

```bash
npx tsc --noEmit
```

预期：零报错（或仅剩因 Explorer 的 `onNewQuery`/`onOpenTableData` prop 类型变更引发的错误，在下一步处理）。

- [ ] **Step 9: 主动确认 Explorer 的 prop 类型与 queryStore 方法签名一致**

打开 `src/components/Explorer/index.tsx`，找到 `ExplorerProps` interface，查看 `onNewQuery`/`onOpenTableData`/`onOpenTableStructure` 的参数类型。

预期与 queryStore 中新加方法的签名**完全一致**：
```ts
onNewQuery?: (connId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
onOpenTableData?: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
onOpenTableStructure?: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
```

若有不一致（例如参数顺序或名称不同），更新 Explorer 的 prop 类型定义使其与 queryStore 方法签名一致（无需修改 Explorer 内部逻辑，只改 interface 的类型标注）。

- [ ] **Step 10: 运行 TypeScript 检查，确认零报错**

```bash
npx tsc --noEmit
```

- [ ] **Step 11: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): unify tab state — remove local tab state, use queryStore, add MetricsSidebar"
```

---

### Task 10: 删除 MetricsLayout

**Files:**
- Delete: `src/components/MetricsExplorer/MetricsLayout.tsx`

- [ ] **Step 1: 确认没有任何地方还在 import MetricsLayout**

（Windows 环境下使用 git grep）：
```bash
git grep "MetricsLayout" -- src/
```

预期：零结果（App.tsx 的 import 已在 Task 9 删除）。

- [ ] **Step 2: 删除文件**

```bash
git rm src/components/MetricsExplorer/MetricsLayout.tsx
```

- [ ] **Step 3: 运行 TypeScript 检查和测试**

```bash
npx tsc --noEmit && npm run test
```

预期：零报错，全部测试通过。

- [ ] **Step 4: 启动开发服务器，手动验证**

```bash
npm run dev
```

验证清单：
- [ ] 在"数据库"活动下：可以正常打开 SQL 查询 Tab、表数据 Tab、表结构 Tab
- [ ] 切换到"业务指标"活动：左侧变成指标树，右侧 Tab 栏不变
- [ ] 在指标树中点击指标列表，右侧出现新 Tab（与数据库 Tab 在同一栏）
- [ ] 切回"数据库"活动：之前打开的指标 Tab 仍然存在
- [ ] 关闭 Tab、右键菜单（关闭左侧/右侧/其他/全部）正常工作
- [ ] 刷新页面后 Tab 状态从 localStorage 恢复

- [ ] **Step 5: Final commit**

```bash
git add -u
git commit -m "feat: remove MetricsLayout — unified tab area complete"
```
