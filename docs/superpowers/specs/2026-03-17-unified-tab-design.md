<!-- STATUS: ✅ 已实现 -->
# 统一 Tab 内容区设计规范

**日期：** 2026-03-17
**状态：** 已批准
**范围：** 数据库模式与业务指标模式共享同一 Tab 内容窗体

---

## 1. 背景与问题

当前应用在"数据库"和"业务指标"两个活动之间切换时，内容区是完全独立的：

- **数据库模式**：`App.tsx` 维护本地 `tabs`/`activeTab` 状态，传给 `<MainContent>` 渲染 Tab 栏和内容
- **业务指标模式**：`<MetricsLayout>` 自包含，有独立的左侧 MetricsTree + 独立 Tab 状态（存 localStorage 键名 `metrics_tabs_state`）
- **queryStore**：已有 `tabs`/`activeTabId`/`openMetricTab`/`openMetricListTab` 字段，但未与 MainContent 打通

结果：两套 Tab 状态互不感知，无法共享 Tab 栏，用户体验割裂。

---

## 2. 目标

- 数据库和业务指标活动共用同一个右侧 Tab 内容区
- 切换活动时，Tab 栏保持不变（所有类型 Tab 全部显示）
- 左侧边栏根据活动切换（数据库树 vs 指标树）
- 样式以数据库 Tab 为基准（`MetricsLayout` 的 Tab 样式已与之一致）

---

## 3. 整体架构

```
App.tsx
├── ActivityBar（左竖栏）
├── 左侧边栏（根据 activeActivity 切换）
│   ├── database/其他 → <Explorer>（数据库连接树）
│   └── metrics       → <MetricsSidebar>（指标树）
├── 中央内容区（database + metrics 共用）
│   └── <MainContent>（扩展，支持所有 Tab 类型）
└── <Assistant>（右侧 AI 面板）
```

**单一状态源：`queryStore.tabs`**

所有 Tab（`query`/`table`/`er_diagram`/`table_structure`/`metric`/`metric_list`）统一存储在 `queryStore` 中。

---

## 4. 类型变更（`src/types/index.ts`）

### 4.1 TabType 扩展

当前 `types/index.ts` 中的 `TabType` 不含 `table_structure`（该类型目前仅存在于 `App.tsx` 的本地 `TabData` 联合类型中）。本次将其**从 `TabData` 迁移**至共享的 `TabType`：

```ts
export type TabType =
  | 'query'
  | 'table'
  | 'er_diagram'
  | 'table_structure'   // 从 App.tsx TabData 迁移，非新增类型
  | 'metric'
  | 'metric_list';
```

### 4.2 Tab 接口扩展

当前 `types/index.ts` 的 `Tab` 接口：
```ts
// 现状
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;
  metricScope?: MetricScope;
}
```

将 `App.tsx` 的 `TabData` 专有字段合并进来（`db`、`schema`、`queryContext`、`isNewTable`）。注意 `connectionId` 在 `Tab` 中已存在，在 `TabData` 中也有，合并后无变化：

```ts
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  // 原有字段（保留不变）
  connectionId?: number;
  metricId?: number;           // metric Tab 专用
  metricScope?: MetricScope;   // metric_list Tab 专用
  // 从 App.tsx TabData 迁移的字段
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;        // table_structure Tab 专用
}
```

`App.tsx` 中的 `TabData` 接口随之删除，所有引用改为 `Tab`。

---

## 5. queryStore 变更（`src/store/queryStore.ts`）

### 5.1 新增 Tab 管理方法

以下方法目前分散在 App.tsx 本地 handler 中，迁移至 queryStore。

**`closeTab` 签名变更说明：** App.tsx 当前签名为 `closeTab(e: React.MouseEvent, tabId: string)`，迁移后改为 `closeTab(tabId: string)`——事件的 `stopPropagation()` 交由 `MainContent` 内部的关闭按钮 `onClick` 处理，不再由 store 方法承接：

```ts
closeTab(tabId: string): void
closeAllTabs(): void
closeTabsLeft(tabId: string): void
closeTabsRight(tabId: string): void
closeOtherTabs(tabId: string): void
updateTabContext(tabId: string, ctx: Partial<QueryContext>): void
```

`MainContent` 内所有调用 `closeTab` 的按钮需改为：
```tsx
onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
```

### 5.2 新增语义化 open 方法

```ts
openQueryTab(connId: number, connName: string, database?: string, schema?: string, initialSql?: string): void
openTableDataTab(tableName: string, connectionId: number, database?: string, schema?: string): void
openTableStructureTab(connectionId: number, database?: string, schema?: string, tableName?: string): void
```

以上三个方法对应 App.tsx 中的 `handleNewQuery`、`handleOpenTableData`、`handleOpenTableStructure`，逻辑不变，仅迁移位置。`App.tsx` 改为通过 `useQueryStore()` 解构这些方法后传给 `Explorer` 的 `onNewQuery`、`onOpenTableData` 等 props。

### 5.3 Tab 状态持久化

从 `MetricsLayout` 迁移 localStorage 持久化逻辑至 queryStore，**键名统一改为 `unified_tabs_state`**。

- 初始化时优先读取 `unified_tabs_state`；若不存在则尝试读取旧键 `metrics_tabs_state` 做一次性迁移，迁移后写入新键并删除旧键
- `tabs`/`activeTabId` 变化时写回 `unified_tabs_state`（通过 Zustand `subscribe` 实现）

---

## 6. 组件变更

### 6.1 MainContent（`src/components/MainContent/index.tsx`）

**删除的 props（改为从 `useQueryStore` 读取/调用）：**

```ts
tabs, activeTab, setActiveTab,
closeTab, closeAllTabs, closeTabsLeft, closeTabsRight, closeOtherTabs,
updateTabContext
```

**新增 Tab 类型渲染：**

```tsx
{activeTab?.type === 'metric' && activeTab.metricId && (
  <MetricTab metricId={activeTab.metricId} />
)}
{activeTab?.type === 'metric_list' && activeTab.metricScope && (
  <MetricListPanel
    scope={activeTab.metricScope}
    onOpenMetric={(id, title) => useQueryStore.getState().openMetricTab(id, title)}
  />
)}
```

**Tab 栏图标扩展：**

| Tab 类型 | 图标（Lucide） |
|---|---|
| `query` | `FileCode` |
| `table` | `Table` |
| `er_diagram` | `GitMerge` |
| `table_structure` | `LayoutTemplate`（注：旧版 Lucide 中为 `Layout`，实现时以项目已安装版本为准） |
| `metric` | `BarChart2` |
| `metric_list` | `TableProperties` |

---

### 6.2 MetricsSidebar（新建 `src/components/MetricsExplorer/MetricsSidebar.tsx`）

从 `MetricsLayout` 拆出左侧树部分，独立为 `MetricsSidebar`：

- 包含：标题栏、刷新按钮、搜索框、`<MetricsTree>`、侧边栏 resize 拖拽手柄
- 点击指标时：`useQueryStore.getState().openMetricTab(id, title)`
- 点击指标列表时：`useQueryStore.getState().openMetricListTab(scope, title)`
- **不管理任何 Tab 状态**

**侧边栏宽度策略：** `MetricsSidebar` 使用 App.tsx 统一的 `sidebarWidth` 状态（与 Explorer 共享），而非独立维护。这意味着切换活动时侧边栏宽度保持连续，用户在指标模式调整宽度后切回数据库模式宽度同步变化，这是预期行为。

Props：
```ts
interface MetricsSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
}
```

---

### 6.3 MetricsLayout（删除）

`src/components/MetricsExplorer/MetricsLayout.tsx` 整体删除。其职责分别由：
- 左侧：`MetricsSidebar`（新建）
- 右侧 Tab：`MainContent`（扩展）

承接。

---

### 6.4 App.tsx 重构

**删除：**
- 本地 `tabs: TabData[]`、`activeTab: string` state（约 5 行）
- `handleNewQuery`、`handleOpenTableData`、`handleOpenTableStructure`、`closeTab`、`closeAllTabs`、`closeTabsLeft`、`closeTabsRight`、`closeOtherTabs`、`updateTabContext` 函数（约 100 行）
- `MetricsLayout` import
- `TabData` 接口定义

**修改左侧边栏逻辑：**

```tsx
{activeActivity === 'metrics' ? (
  <MetricsSidebar sidebarWidth={sidebarWidth} onResize={handleSidebarResize} />
) : (
  activeActivity !== 'settings' && activeActivity !== 'tasks' &&
  activeActivity !== 'graph' && activeActivity !== 'migration' && (
    <Explorer ... onNewQuery={openQueryTab} onOpenTableData={openTableDataTab} ... />
    // openQueryTab / openTableDataTab 从 useQueryStore() 解构获取
  )
)}
```

**修改中央内容区逻辑（metrics 不再单独处理）：**

```tsx
{activeActivity === 'settings' ? <SettingsPage />
 : activeActivity === 'tasks'    ? <TaskCenter />
 : activeActivity === 'graph'    ? <GraphExplorer connectionId={activeConnectionId} />
 : activeActivity === 'migration'? <MigrationWizard />
 : <MainContent ... />}
```

**`GraphExplorer` 和 `Assistant` 的 connectionId 来源：**

重构后 `tabs`/`activeTab` 不再是 App.tsx 本地状态。这两个组件需要的 `activeConnectionId` 改为从 `queryStore` 派生：

```tsx
// App.tsx 顶层
const { tabs, activeTabId } = useQueryStore();
const activeConnectionId = tabs.find(t => t.id === activeTabId)?.queryContext?.connectionId ?? null;

// 传给 GraphExplorer 和 Assistant
<GraphExplorer connectionId={activeConnectionId} />
<Assistant activeConnectionId={activeConnectionId} ... />
```

`queryContext` 字段已在 Section 4.2 中加入 `Tab` 接口，因此此处可以直接读取。

---

## 7. 数据流

```
用户点击指标树节点
  → MetricsSidebar 调用 queryStore.openMetricTab(id, title)
  → queryStore.tabs 新增 { type: 'metric', metricId, ... }
  → MainContent 读取 tabs，渲染新 Tab
  → 用户切换到"数据库"活动
  → 左侧边栏换成 Explorer，Tab 栏不变
  → MainContent 依然可见，metric Tab 仍在列表中
```

---

## 8. 文件变更汇总

| 文件 | 变化类型 | 说明 |
|---|---|---|
| `src/types/index.ts` | 修改 | 扩展 Tab 类型，迁移 table_structure 和 TabData 字段 |
| `src/store/queryStore.ts` | 修改 | 新增 Tab 管理方法 + localStorage 持久化（含旧键迁移） |
| `src/components/MainContent/index.tsx` | 修改 | 从 queryStore 读取 tabs，扩展 metric 渲染，更新 closeTab 调用点 |
| `src/components/MetricsExplorer/MetricsSidebar.tsx` | **新建** | 从 MetricsLayout 拆出左侧树 |
| `src/components/MetricsExplorer/MetricsLayout.tsx` | **删除** | 职责分拆至 MetricsSidebar + MainContent |
| `src/App.tsx` | 修改 | 删除本地 tab state，切换侧边栏逻辑，精简约 120 行 |

---

## 9. 不在本次范围内

- MetricTab / MetricListPanel 的内部功能改动
- Assistant 面板、Graph、Migration 等模块的功能改动（仅更新其 connectionId 数据来源）
- Tab 持久化的跨设备同步
