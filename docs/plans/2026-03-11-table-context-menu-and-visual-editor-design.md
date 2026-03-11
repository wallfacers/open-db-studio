# 表右键菜单扩展 & 可视化表结构编辑器 设计文档

**日期：** 2026-03-11
**状态：** 已批准

## 背景

当前表节点右键菜单缺少「查看 DDL」和「截断表」入口；「编辑表结构」使用原始 DDL textarea 编辑，用户体验差。本次设计新增两个菜单项并重构表结构编辑器为可视化表格模式。

## 需求范围

1. 右键菜单新增「查看 DDL」和「截断表」
2. 新增只读 DDL 查看对话框
3. 新增截断表确认对话框（自定义红色警告样式）
4. 将「编辑表结构」从 DDL textarea 重构为可视化列编辑表格，底部实时生成 ALTER SQL 预览

---

## 一、右键菜单变更（`ContextMenu.tsx`）

表节点菜单最终顺序：

| 菜单项 | 图标 | 样式 | 回调 |
|--------|------|------|------|
| 打开数据 | `Eye` | 普通 | `onOpenTableData` |
| 新建查询 | `FilePlus` | 普通 | `onNewQuery` |
| 查看 DDL | `Code2` | 普通 | `onViewDdl` |
| —— 分隔线 —— | | | |
| 编辑表结构 | `FileEdit` | 普通 | `onEditTable` |
| 管理索引 | `ListTree` | 普通 | `onManageIndexes` |
| —— 分隔线 —— | | | |
| 截断表 | `Eraser` | 红色危险 | `onTruncateTable` |
| 删除表 | `Trash2` | 红色危险 | `onDropTable` |

**涉及文件：**
- `src/components/Explorer/ContextMenu.tsx` — 新增 `onViewDdl`、`onTruncateTable` props 和菜单项
- `src/components/Explorer/DBTree.tsx` — 新增对应事件处理，管理 `showDdlViewer`、`showTruncateConfirm` 状态

---

## 二、查看 DDL 对话框（`DdlViewerDialog`）

**路径：** `src/components/DdlViewerDialog/index.tsx`

**Props：**
```typescript
interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
}
```

**交互设计：**
- 打开时调用 `get_table_ddl`（已有 Rust 命令），展示只读 DDL
- 右上角「复制」按钮（`Copy` 图标），点击后图标变为 `Check` 并短暂提示「已复制」
- ESC / X 关闭
- 宽度 640px，DDL 区域 monospace 字体只读 textarea

**无需新增 Rust 命令。**

---

## 三、截断表确认对话框（`TruncateConfirmDialog`）

**路径：** `src/components/TruncateConfirmDialog/index.tsx`

**Props：**
```typescript
interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}
```

**交互设计：**
- 红色警告图标（`AlertTriangle`）+ 标题「截断表」
- 警告文案：「此操作将删除表 `{tableName}` 中的所有数据，且无法恢复。」
- 两个按钮：「取消」（灰色）/ 「确认截断」（红色）
- 点确认后执行 SQL：
  - MySQL：`TRUNCATE TABLE \`{tableName}\``
  - PostgreSQL：`TRUNCATE TABLE "{schema}"."{tableName}"`
- 执行中按钮 loading 态，成功/失败均 showToast

**无需新增 Rust 命令，复用 `execute_query`。**

---

## 四、可视化表结构编辑器（重构 `TableManageDialog`）

**路径：** `src/components/TableManageDialog/index.tsx`（原地重构）

### 布局

```
┌─────────────────────────────────────────────────┐
│ 编辑表结构: users                           [X] │
├─────────────────────────────────────────────────┤
│ [列名] [类型] [长度] [可空] [默认值] [主键] [操作] │
│  id    INT         ☐      (auto) ★PK  [↑][↓][×] │
│  name  VARCHAR 255 ☑      -          [↑][↓][×]  │
│ [+ 添加列]                                       │
├─────────────────────────────────────────────────┤
│ ALTER SQL 预览（实时生成，只读 textarea）          │
├─────────────────────────────────────────────────┤
│              [取消]  [执行 ALTER]                │
└─────────────────────────────────────────────────┘
```

### 数据结构

```typescript
interface EditableColumn {
  id: string;           // 前端唯一标识（uuid）
  name: string;
  dataType: string;     // 'INT' | 'VARCHAR' | 'TEXT' | ...
  length?: number;
  isNullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  extra?: string;       // 'auto_increment' 等
  _originalName?: string; // 非空表示该列是从原有列修改来的
  _isNew?: boolean;     // 标记为新增列
  _isDeleted?: boolean; // 标记为待删除（软删除，渲染时灰显）
}
```

### 数据流

1. 打开时调用 `get_table_columns` 加载原始列，存入 `originalColumns`（不可变引用）
2. 用户操作维护 `editedColumns` 状态（含软删除标记）
3. `editedColumns` 每次变化触发 `generateAlterSql()` 生成预览 SQL
4. 点「执行 ALTER」→ 执行预览 SQL（`execute_query`）

### ALTER SQL 生成规则

| 变化类型 | MySQL | PostgreSQL |
|----------|-------|-----------|
| 新增列 | `ADD COLUMN \`col\` TYPE ...` | `ADD COLUMN "col" TYPE ...` |
| 修改列（类型/可空/默认值） | `MODIFY COLUMN \`col\` TYPE ...` | `ALTER COLUMN "col" TYPE ...` + 多条语句 |
| 删除列 | `DROP COLUMN \`col\`` | `DROP COLUMN "col"` |
| 调整顺序 | `MODIFY COLUMN \`col\` TYPE ... AFTER \`prev\`` | 不支持，展示警告提示 |
| 主键变化 | `DROP PRIMARY KEY; ADD PRIMARY KEY(\`col\`)` | `DROP CONSTRAINT pkey; ADD PRIMARY KEY("col")` |

### 新建模式

`tableName` 为空时，底部生成 `CREATE TABLE` SQL，按钮文案改为「创建表」。

### 驱动类型检测

通过 `connectionId` 查询 store 获取驱动类型（`mysql` / `postgres`），决定 SQL 方言。

---

## 五、i18n 新增键

```json
{
  "contextMenu": {
    "viewDdl": "查看 DDL",
    "truncateTable": "截断表"
  },
  "ddlViewer": {
    "title": "查看 DDL",
    "copied": "已复制"
  },
  "truncateConfirm": {
    "title": "截断表",
    "warning": "此操作将删除表 {{table}} 中的所有数据，且无法恢复。",
    "confirm": "确认截断",
    "success": "截断成功",
    "error": "截断失败"
  },
  "tableManage": {
    "addColumn": "添加列",
    "columnName": "列名",
    "dataType": "类型",
    "length": "长度",
    "nullable": "可空",
    "defaultValue": "默认值",
    "primaryKey": "主键",
    "alterPreview": "ALTER SQL 预览",
    "executeAlter": "执行 ALTER",
    "noChanges": "-- 无变更",
    "orderNotSupported": "-- PostgreSQL 不支持调整列顺序"
  }
}
```

---

## 六、不涉及 Rust 后端变更

所有功能复用现有命令：
- `get_table_ddl` — DDL 查看
- `get_table_columns`（通过现有 `get_table_detail` 或直接调用）— 加载列结构
- `execute_query` — 执行截断/ALTER/CREATE

---

## 七、文件改动清单

| 文件 | 类型 |
|------|------|
| `src/components/Explorer/ContextMenu.tsx` | 修改 |
| `src/components/Explorer/DBTree.tsx` | 修改 |
| `src/components/DdlViewerDialog/index.tsx` | 新增 |
| `src/components/TruncateConfirmDialog/index.tsx` | 新增 |
| `src/components/TableManageDialog/index.tsx` | 重构 |
| `src/locales/zh-CN.json` | 修改 |
| `src/locales/en-US.json` | 修改 |
