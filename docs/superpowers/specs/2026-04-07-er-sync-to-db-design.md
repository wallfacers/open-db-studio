# ER → 数据库同步功能设计文档

**日期**：2026-04-07  
**状态**：已确认，待实现

---

## 背景

`DiffReportDialog` 提供了"ER→数据库"和"数据库→ER"两个方向的同步入口。  
"数据库→ER"已在上一个修复中实现（`er_sync_from_database`）。  
"ER→数据库"方向：前端 UI 完整（差异展示、勾选框、按钮），但 `ERCanvas.onSyncToDb` 仅有 `alert('功能未实现')`，Rust 侧 `er_generate_sync_ddl` 对新增表只生成注释占位符。

本次目标：移除 `alert()`，实现完整的 ER→数据库同步流程。

---

## 用户流程

```
DiffReportDialog 用户勾选变更 → 点击"ER→数据库"
  → ERCanvas.onSyncToDb(filteredDiff)
  → er_generate_sync_ddl(projectId, filteredDiff)   [Rust]
  → DDLPreviewDialog（preloadedDdl 模式，隐藏方言选项）
  → 用户审阅 DDL，点 Execute
  → er_execute_sync_ddl(projectId, statements)      [Rust]
```

---

## 改动文件

| 文件 | 改动概述 |
|------|---------|
| `src-tauri/src/er/commands.rs` | 实现 `er_generate_sync_ddl` 完整逻辑（主要工作） |
| `src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx` | 加 `preloadedDdl?: string` prop |
| `src/components/ERDesigner/dialogs/DiffReportDialog.tsx` | `onSyncToDb` 传参从 `SelectedChange[]` 改为 filtered DiffResult |
| `src/store/erDesignerStore.ts` | 加 `generateSyncDdl()` 调用 invoke |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 替换 alert，接入完整流程 |

---

## Rust：`er_generate_sync_ddl` 实现细节

**文件**：`src-tauri/src/er/commands.rs`（当前第 472-533 行）

### 输入格式（`changes: serde_json::Value`）

```json
{
  "added_tables": [
    { "table_name": "users", "columns": [...] }
  ],
  "modified_tables": [
    {
      "table_name": "orders",
      "added_columns": [{ "name": "status", "data_type": "varchar", "nullable": true }],
      "removed_columns": [{ "name": "old_col", ... }],
      "modified_columns": [{ "name": "amount", "er_type": "decimal", "db_type": "float", "er_nullable": false, "db_nullable": true, ... }],
      "added_indexes": [{ "name": "idx_status", "index_type": "INDEX", "columns": ["status"] }],
      "removed_indexes": [{ "name": "idx_old", ... }]
    }
  ]
}
```

### 实现步骤

1. **加载 ER 项目**：调用 `get_project_full(project_id)` 获取所有表/列/索引数据，建立 `table_name（小写）→ ErTableFull` 查找 map
2. **获取方言**：从项目的 `connection_id` 查找连接配置（SQLite 内置库），读取 `driver` 字段（"mysql"/"postgresql"/...）
3. **added_tables**：
   - 从 map 中找到对应的 `ErTableFull`
   - 调用现有 `ddl_generator::generate_ddl()` 为该单表生成完整 `CREATE TABLE`（包含 PK、索引、列约束）
4. **modified_tables → added_columns**：
   - 从 map 中取出 `ErColumn`（保留 length/scale/unsigned/charset 等完整属性）
   - 生成 `ALTER TABLE t ADD COLUMN col TYPE [NOT NULL] [DEFAULT ...]`（按方言格式化）
5. **modified_tables → removed_columns**：
   - 生成 `ALTER TABLE t DROP COLUMN col`
6. **modified_tables → modified_columns**（类型/nullable 变更）：
   - 从 ER 模型取出更新后的 `ErColumn`
   - MySQL：`ALTER TABLE t MODIFY COLUMN col new_type [NOT NULL]`
   - PostgreSQL：两句，`ALTER TABLE t ALTER COLUMN col TYPE new_type` + `ALTER COLUMN col [SET|DROP] NOT NULL`
   - 其他方言同 MySQL 语法
7. **modified_tables → added_indexes**：
   - 生成 `CREATE [UNIQUE] INDEX name ON t (col1, col2)`
8. **modified_tables → removed_indexes**：
   - MySQL：`DROP INDEX name ON t`
   - PostgreSQL：`DROP INDEX IF EXISTS name`

### 方言获取辅助函数

新增私有函数 `get_project_dialect(project: &ErProject) -> AppResult<String>`：
- 根据 `project.connection_id` 查询 SQLite 内置库中的 connection 记录
- 读取 `driver` 字段（存储值：`"mysql"` / `"postgresql"` / `"sqlite"` 等）
- 无连接时默认返回 `"mysql"`

---

## 前端改动细节

### 1. `erDesignerStore.ts`

新增：
```typescript
generateSyncDdl: async (projectId: number, changes: object): Promise<string[]> => {
  return await invoke<string[]>('er_generate_sync_ddl', { projectId, changes });
}
```

### 2. `DiffReportDialog.tsx`

- `onSyncToDb` prop 类型改为 `(diff: SyncDiffPayload) => void`
- 新增接口：
  ```typescript
  export interface SyncDiffPayload {
    added_tables: TableDiff[];
    modified_tables: Array<{
      table_name: string;
      added_columns: ColumnDiff[];
      removed_columns: ColumnDiff[];
      modified_columns: ColumnModDiff[];
      added_indexes: IndexDiff[];
      removed_indexes: IndexDiff[];
    }>;
  }
  ```
- `handleSyncToDb` 内部从 `diffResult` 和 `selectedChanges` 直接构建 `SyncDiffPayload`，替代原来传 `SelectedChange[]`

### 3. `DDLPreviewDialog.tsx`

新增 prop：
```typescript
preloadedDdl?: string;  // 若提供，跳过 er_generate_ddl，直接展示；隐藏方言/选项控件；标题改为"同步 DDL 预览"
```
- 有 `preloadedDdl` 时，`useEffect` 不触发 `generateDDL`，直接 `setDdl(preloadedDdl)`
- 执行逻辑不变（调用 `onExecute(ddl)`）

### 4. `ERCanvas/index.tsx`

新增 state：
```typescript
const [syncStatements, setSyncStatements] = useState<string[] | null>(null);
```

替换 alert：
```typescript
onSyncToDb={async (filteredDiff) => {
  try {
    const statements = await generateSyncDdl(projectId, filteredDiff);
    setSyncStatements(statements);
    setShowDDL(true);
  } catch (e) {
    console.error('Failed to generate sync DDL:', e);
  }
}}
```

DDLPreviewDialog 调用处修改：
```typescript
<DDLPreviewDialog
  visible={showDDL}
  projectId={projectId}
  hasConnection={hasConnection}
  preloadedDdl={syncStatements ? syncStatements.join('\n\n') : undefined}
  onClose={() => { setShowDDL(false); setSyncStatements(null); }}
  onExecute={async (ddl) => {
    if (syncStatements) {
      // 同步模式：使用 er_execute_sync_ddl
      await invoke('er_execute_sync_ddl', {
        projectId,
        ddlStatements: syncStatements,
      });
      setSyncStatements(null);
    } else {
      // 普通模式：execute_query
      if (!activeProject?.connection_id) return;
      await invoke('execute_query', {
        connectionId: activeProject.connection_id,
        sql: ddl,
        database: activeProject.database_name ?? null,
        schema: activeProject.schema_name ?? null,
      });
    }
  }}
/>
```

---

## 验证方案

1. 绑定 MySQL/PostgreSQL 连接，创建含多张表的 ER 图
2. 在数据库中只创建部分表（制造差异）
3. 点击工具栏"同步"图标 → DiffReportDialog 出现
4. 勾选部分变更（新增表、修改列、新增索引），点击"ER→数据库"
5. 验证 DDLPreviewDialog 弹出，显示方言正确的 DDL（无方言/选项控件）
6. 点击 Execute，验证 DDL 在数据库中执行成功
7. 再次点击 Diff，验证差异已消除

---

## 不在范围内

- FK 反向工程（`er_sync_from_database` 中 line 466 的 TODO）
- 执行结果的详细展示（per-statement 成功/失败列表）——`er_execute_sync_ddl` 已有返回值，后续可扩展
