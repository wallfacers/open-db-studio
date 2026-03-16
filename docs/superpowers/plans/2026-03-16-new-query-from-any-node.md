# New Query From Any DB Tree Node — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数据库树所有有连接上下文的节点（category / column 补全，table / view / column 预填 SQL 模板）均支持"新建查询"。

**Architecture:**
- `ContextMenu.tsx` 的 `onNewQuery: () => void` prop 签名**不变**；它内部只调用 `onNewQuery()`，不感知节点类型。
- 模板生成逻辑在 `DBTree.tsx` 中完成：`ContextMenu` 的 `onNewQuery` prop 接收一个 lambda，该 lambda 按 `contextMenu.node.nodeType` 分支生成 `initialSql`，再调用外层 `onNewQuery(connId, connName, db, schema, initialSql)`。
- `App.tsx` 的 `handleNewQuery` 末尾加 `initialSql?: string` 参数；创建 Tab 后调用 `useQueryStore.getState().setSql(tabId, initialSql)` 写入初始 SQL。
- `category` 节点没有 SQL 模板（`initialSql = undefined`），只预选 db/schema 上下文。
- `column` 节点通过 `nodes.get(n.parentId ?? '')?.label` 取父表名（`nodes` 来自 `useTreeStore`，在 DBTree 组件内可直接访问）。column 的直接父节点**一定是 `table` 或 `view` 节点**（见 `src/store/treeStore.ts` 第 186-196 行：列在展开 table/view 时创建，`parentId = nodeId`），不会是 `category` 节点。

**Tech Stack:** React 18, TypeScript, Zustand (useQueryStore), Tauri invoke

---

## Chunk 1: App.tsx — handleNewQuery 支持初始 SQL

### Task 1: 修改 App.tsx handleNewQuery 签名及实现

**Files:**
- Modify: `src/App.tsx`（约第 206-217 行，handleNewQuery 函数）

**背景：** SQL 内容由 `useQueryStore` 管理，`setSql(tabId, sql)` 写入指定 Tab 的编辑器内容。`useQueryStore.getState()` 可在 React 回调外部直接访问 store。

- [ ] **Step 1: 修改 handleNewQuery**

将现有函数替换为：

```typescript
const handleNewQuery = (connId: number, connName: string, database?: string, schema?: string, initialSql?: string) => {
  const tabId = `query_${connId}_${Date.now()}`;
  const queryCount = tabs.filter(t => t.type === 'query').length + 1;
  setTabs(prev => [...prev, {
    id: tabId,
    type: 'query',
    title: `查询${queryCount}`,
    db: connName,
    queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
  }]);
  if (initialSql) {
    useQueryStore.getState().setSql(tabId, initialSql);
  }
  setActiveTab(tabId);
};
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd D:/project/java/source/open-db-studio && npx tsc --noEmit 2>&1 | head -30
```

预期：此时 DBTree 的 `onNewQuery` prop 类型会报不兼容错误，Task 2 修复。

---

## Chunk 2: DBTree.tsx — 类型更新 + 模板生成 + 统一调用点

### Task 2: 更新 DBTree — onNewQuery prop 类型

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`（DBTreeProps 接口，约第 26 行）

- [ ] **Step 1: 修改 onNewQuery prop 类型**

```typescript
// 修改前
onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string) => void;

// 修改后
onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
```

### Task 3: 添加 SQL 模板生成辅助函数

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`（组件函数体内，紧接 `normalizeDriver` 函数之后）

**背景：**
- `getDriver(connectionId)` 已在组件内定义（约第 179 行），返回 `'mysql'`、`'postgresql'` 等字符串。
- `buildSelectSql` 通过闭包访问 `getDriver`，无需额外传参。

- [ ] **Step 1: 添加两个辅助函数**

```typescript
const quoteIdentifier = (name: string, driver: string): string => {
  const isPgOrOracle = driver === 'postgres' || driver === 'postgresql' || driver === 'oracle';
  return isPgOrOracle ? `"${name}"` : `\`${name}\``;
};

const buildSelectSql = (tableName: string, connectionId: number, columnName?: string): string => {
  const driver = getDriver(connectionId);
  const q = (name: string) => quoteIdentifier(name, driver);
  const cols = columnName ? q(columnName) : '*';
  return `SELECT ${cols} FROM ${q(tableName)} LIMIT 100;`;
};
```

### Task 4: 修改 ContextMenu 的 onNewQuery prop（统一调用点）

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`（ContextMenu 渲染处的 `onNewQuery` prop，约第 250-253 行）

**关键说明：**
- `ContextMenu` 内部的 `onNewQuery: () => void` **不变**，ContextMenu 只调用 `onNewQuery()`，不传参。
- 模板生成和参数拼装全在 DBTree 的这个 lambda 内完成。
- `column` 节点的父表名通过 `nodes.get(n.parentId ?? '')?.label` 获取（`nodes` 来自 `useTreeStore`，已在组件顶部解构）。
- `category` 节点不生成 SQL 模板（`initialSql = undefined`），打开空编辑器并预选 db/schema。

- [ ] **Step 1: 替换 onNewQuery prop 为包含分支逻辑的 lambda**

```typescript
onNewQuery={() => {
  const n = contextMenu.node;
  const connId = getConnectionId(n);
  let initialSql: string | undefined;
  if (n.nodeType === 'table' || n.nodeType === 'view') {
    initialSql = buildSelectSql(n.label, connId);
  } else if (n.nodeType === 'column') {
    const parentNode = nodes.get(n.parentId ?? '');
    const tableName = parentNode?.label ?? 'table_name';
    initialSql = buildSelectSql(tableName, connId, n.label);
  }
  // connection / database / schema / category：initialSql = undefined，仅预选上下文
  onNewQuery(connId, getConnName(n), n.meta.database, n.meta.schema, initialSql);
}}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd D:/project/java/source/open-db-studio && npx tsc --noEmit 2>&1 | head -30
```

预期：无错误（或仅 ContextMenu 菜单项缺失相关警告，Chunk 3 修复）

---

## Chunk 3: ContextMenu.tsx — 补全 category 和 column 菜单项

**关键说明：** `ContextMenu.tsx` 的 `onNewQuery: () => void` prop 签名**不修改**。只修改 `getMenuItems` 中的 `category` 和 `column` case。

### Task 5: ContextMenu — category 节点加入"新建查询"

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`（getMenuItems 的 category case，约第 103-112 行）

- [ ] **Step 1: 修改 category case**

```typescript
case 'category':
  if (node.meta.objectName === 'tables') {
    return [
      { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
      { label: t('contextMenu.createTable'), icon: FilePlus2, onClick: onCreateTable, dividerBefore: true },
      { label: t('contextMenu.aiCreateTable'), icon: Sparkles, onClick: onAiCreateTable },
      { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
      ...(onExportMultiTable ? [{ label: t('contextMenu.exportMultiTable'), icon: Download, onClick: onExportMultiTable, dividerBefore: true }] : []),
    ];
  }
  return [
    { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
    { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
  ];
```

### Task 6: ContextMenu — column 节点加入"新建查询"

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`（column case，约第 131-134 行）

- [ ] **Step 1: 修改 column case**

```typescript
case 'column':
  return [
    { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
    { label: t('contextMenu.copyColumnName'), icon: Copy, onClick: onCopyName, dividerBefore: true },
  ];
```

- [ ] **Step 2: TypeScript 最终检查**

```bash
cd D:/project/java/source/open-db-studio && npx tsc --noEmit
```

预期：**零错误**

- [ ] **Step 3: 提交**

```bash
cd D:/project/java/source/open-db-studio
git add src/App.tsx src/components/Explorer/DBTree.tsx src/components/Explorer/ContextMenu.tsx
git commit -m "feat: all db tree nodes support new query with sql template pre-fill"
```

---

## 验收检查清单

- [ ] 右键 `category`（表/视图/函数等文件夹节点）→ 出现"新建查询" → 打开 Tab，db/schema 下拉已预选，编辑器为空
- [ ] 右键 `table` → "新建查询" → 编辑器内容为 `SELECT * FROM \`table_name\` LIMIT 100;`
- [ ] 右键 `view` → "新建查询" → 编辑器内容为 `SELECT * FROM \`view_name\` LIMIT 100;`
- [ ] 右键 `column` → "新建查询" → 编辑器内容为 `SELECT \`col_name\` FROM \`table_name\` LIMIT 100;`（table_name 来自父节点）
- [ ] PostgreSQL 连接下，引号为双引号（`"table_name"` 而非反引号）
- [ ] 原有 connection / database / schema 节点"新建查询"行为不变
- [ ] TypeScript 编译零错误
