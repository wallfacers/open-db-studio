# 设计文档：数据库树所有节点支持"新建查询"

**日期：** 2026-03-16
**状态：** 已批准

## 背景

当前数据库树中，`category`（表/视图等文件夹节点）和 `column`（列节点）缺少"新建查询"菜单项。此外，从 `table`/`view`/`column` 节点触发"新建查询"时，SQL 编辑器 Tab 的数据库/Schema 上下文已自动填充，但编辑器内容为空，用户需要手动输入表名。

## 目标

1. 所有有连接上下文的节点（connection / database / schema / category / table / view / column）均支持"新建查询"。
2. 从 `table` / `view` / `column` 节点触发时，自动预填充 SQL 模板，提升使用效率。

## 方案

**选择方案 A：扩展 `onNewQuery` 签名，新增可选 `initialSql` 参数。**

DBTree 负责根据节点类型生成 SQL 模板（含正确引号风格），App.tsx 创建 Tab 后调用 `setSql(tabId, initialSql)` 写入初始内容。

## 变更清单

### `src/components/Explorer/ContextMenu.tsx`
- `category` case：所有子类型（tables / views / functions 等）均加入"新建查询"菜单项。
- `column` case：加入"新建查询"菜单项（保留"复制列名"）。

### `src/components/Explorer/DBTree.tsx`
- `DBTreeProps.onNewQuery` 类型签名末尾加 `initialSql?: string`。
- `table` 节点 `onNewQuery` 调用：传入 `SELECT * FROM \`table\` LIMIT 100;` 模板。
- `view` 节点 `onNewQuery` 调用：传入 `SELECT * FROM \`view\` LIMIT 100;` 模板。
- `column` 节点 `onNewQuery` 调用：传入 `SELECT \`col\` FROM \`table\` LIMIT 100;` 模板（`table` 从父节点 `.label` 取得）。
- `category` 节点 `onNewQuery` 调用：无初始 SQL，只传连接/database/schema 上下文。
- 引号风格：`getDriver()` 判断，PostgreSQL/Oracle 用双引号，其余用反引号。

### `src/App.tsx`
- `handleNewQuery` 末尾加 `initialSql?: string` 参数。
- 创建 Tab 后若 `initialSql` 非空，调用 `useQueryStore.getState().setSql(tabId, initialSql)`。

## SQL 模板规则

| 节点类型 | 预填充 SQL | 填充 queryContext |
|---------|-----------|-----------------|
| connection | 空 | connectionId |
| database / schema | 空 | connectionId + database + schema |
| category | 空 | connectionId + database + schema |
| table | `SELECT * FROM \`t\` LIMIT 100;` | connectionId + database + schema |
| view | `SELECT * FROM \`v\` LIMIT 100;` | connectionId + database + schema |
| column | `SELECT \`col\` FROM \`table\` LIMIT 100;` | connectionId + database + schema |

## 不在本次范围内

- `group` 节点（无连接上下文，无法创建查询）
- SQL 编辑器 Header 增加表名选择器
