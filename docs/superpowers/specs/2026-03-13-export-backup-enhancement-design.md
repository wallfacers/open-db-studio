# 导出与备份功能增强设计文档

**日期**：2026-03-13
**状态**：已批准
**涉及模块**：ExportWizard、BackupWizard（新）、ContextMenu、DBTree、Rust 后端

---

## 背景

现有 ExportWizard 仅支持从表节点触发单表/多表导出，数据库节点无导出入口，且导出文件名不可编辑，也不支持运维场景的原生数据库备份。本次增强覆盖三个方向：

1. ExportWizard 最终步骤加文件名输入，步骤数随 scope 自适应
2. 数据库节点新增"导出数据"和"备份数据库"两个入口
3. Tables 分类节点新增多表导出入口，表节点保持现有入口不变

---

## 方案：ExportWizard 改造 + 新建 BackupWizard

### 1. ExportWizard 改造

#### 1.1 步骤数自适应

| scope | 步骤数 | 步骤内容 |
|---|---|---|
| `current_table` | 3 | Step1 范围选择 → Step2 确认单表 → Step3 格式+文件名 |
| `multi_table` | 3 | Step1 范围选择 → Step2 多表勾选 → Step3 格式+文件名(ZIP) |
| `database` | 2 | Step1 范围选择 → Step2 格式+文件名（跳过表选择）|

头部步骤圆点数量和"步骤 X/N"的 N 值根据当前 scope 动态计算：
- `database` scope：totalSteps = 2，步骤编号 Step1 → Step2
- 其他 scope：totalSteps = 3，步骤编号 Step1 → Step2 → Step3

**步骤跳转逻辑：**

```typescript
const totalSteps = step1.scope === 'database' ? 2 : 3;

// 下一步
const nextStep = () => {
  if (step1.scope === 'database' && step === 1) {
    setStep(3); // 跳过 Step2，内部仍用 step=3 表示最终页
  } else {
    setStep(s => s + 1);
  }
};

// 上一步
const prevStep = () => {
  if (step1.scope === 'database' && step === 3) {
    setStep(1);
  } else {
    setStep(s => s - 1);
  }
};

// 头部显示：将实际 step 映射为显示编号
const displayStep = step1.scope === 'database' && step === 3 ? 2 : step;
```

**步骤圆点渲染（替换现有固定 `[1,2,3]`）：**

```typescript
// 现有代码：{[1, 2, 3].map(n => ...)}
// 改为：
{Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
  <div
    key={n}
    className={`w-2 h-2 rounded-full ${
      n === displayStep ? 'bg-[#009e84]' : n < displayStep ? 'bg-[#00c9a7]' : 'bg-[#253347]'
    }`}
  />
))}
// 步骤文字同步改为：
<span className="text-xs text-gray-400">
  {t('exportWizard.step', { current: displayStep, total: totalSteps })}
</span>
```

**database scope 的表数据准备：**

当 `database` scope 跳过 Step2 后，`export_tables` 命令需要知道导出哪些表。解决方案：**传空 tables 数组，Rust 层在 database scope 下自行 `SHOW TABLES` / `SELECT tablename` 获取全量表名**。前端在调用时增加 `export_all: true` 标志，Rust 侧据此决定是否自动查询全表列表。

```typescript
// handleStart 中 database scope 分支
const tablesToExport =
  step1.scope === 'database'
    ? [] // Rust 侧自行获取
    : step1.scope === 'current_table' && defaultTable
    ? [defaultTable]
    : selectedTables;
```

#### 1.2 文件名输入（最终步骤新增）

最终步骤顶部新增文件名行：

```
文件名
[ users_20260313152301 ] [ .csv ]
                          ↑ 后缀跟随格式联动，只读
```

**自动生成规则：**

| scope | 默认文件名（不含后缀）| 说明 |
|---|---|---|
| `current_table` | `{tableName}_{yyyyMMddHHmmss}` | |
| `multi_table` | `{database}_{schema}_{yyyyMMddHHmmss}` | PG 含 schema；MySQL 无 schema，格式为 `{database}_{yyyyMMddHHmmss}` |
| `database` | `{database}_{yyyyMMddHHmmss}` | |

**schema 缺失处理（multi_table）：**
- 有 schema：`{database}_{schema}_{timestamp}`
- 无 schema（MySQL 或 schema 为空）：`{database}_{timestamp}`（去掉 schema 段及其下划线）

**fileName 生成时机：**

- 在 `useEffect` 中监听 `step1.scope`、`step1.database`、`step1.schema`、`defaultTable` 变化，重新生成 fileName 并更新 `options.fileName`
- 用户手动修改后不再自动覆盖（通过 `userEditedFileName` 布尔 flag 区分）；若用户切换 scope，则重置 flag 并重新生成

```typescript
const [userEditedFileName, setUserEditedFileName] = useState(false);

// 自动生成文件名
useEffect(() => {
  if (userEditedFileName) return;
  const ts = formatTimestamp(); // yyyyMMddHHmmss
  let name = '';
  if (step1.scope === 'current_table') {
    name = `${defaultTable ?? 'export'}_${ts}`;
  } else if (step1.scope === 'multi_table') {
    name = step1.schema
      ? `${step1.database}_${step1.schema}_${ts}`
      : `${step1.database}_${ts}`;
  } else {
    name = `${step1.database}_${ts}`;
  }
  setOptions(o => ({ ...o, fileName: name }));
}, [step1.scope, step1.database, step1.schema, defaultTable, userEditedFileName]);

// scope 切换时重置用户编辑状态
const handleScopeChange = (scope: ExportScope) => {
  setStep1(s => ({ ...s, scope }));
  setUserEditedFileName(false);
};
```

**格式 → 后缀映射：**

| 场景 | 后缀 |
|---|---|
| current_table，格式 csv | `.csv` |
| current_table，格式 json | `.json` |
| current_table，格式 sql | `.sql` |
| multi_table 或 database（任意格式） | `.zip`（ZIP 内每个表为 `{tableName}.{format}`）|

#### 1.3 导出流程变更

- 点"开始导出" → 弹目录选择器 → 文件保存为 `{选中目录}/{options.fileName}{ext}`
- 单表：直接写单个文件
- 多表/整库：写 ZIP 包，ZIP 内每个表为 `{tableName}.{format}`

#### 1.4 新增 props

```typescript
interface ExportWizardProps {
  initialScope?: ExportScope;  // 新增：调用方指定初始 scope（不影响用户在 Step1 切换）
  defaultTable?: string;       // 保持不变
  connectionId: number;
  database?: string;
  schema?: string;
  onClose: () => void;
}
```

`initialScope` 不锁定 scope，仅作为 `step1.scope` 的初始值。`current_table` 选项的禁用条件仍为 `!defaultTable`（与现有逻辑一致），与 `initialScope` 无关。

#### 1.5 Step3Options 新增字段

```typescript
interface Step3Options {
  format: ExportFormat;
  includeHeader: boolean;
  includeDdl: boolean;
  whereClause: string;
  encoding: 'UTF-8' | 'GBK';
  delimiter: string;
  fileName: string;  // 新增：不含后缀，用户可编辑
}
```

#### 1.6 Rust export_tables 参数扩展

现有 `MultiExportParams` 新增字段，`output_dir` 语义不变（仍为目录路径），新增 `file_name`（不含后缀）和 `export_all`：

```rust
struct MultiExportParams {
    // 现有字段
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    tables: Vec<String>,
    format: String,
    output_dir: String,
    options: ExportOptions,
    // 新增
    file_name: String,    // 输出文件名（不含后缀），Rust 侧拼接后缀
    export_all: bool,     // true 时忽略 tables，自动查全量表
}
```

**Rust 侧行为：**

现有 `export_tables` 命令开头有以下早退检查：
```rust
if params.tables.is_empty() {
    return Err(AppError::Other("No tables specified for export".to_string()));
}
```
**必须将其修改为：**
```rust
if !params.export_all && params.tables.is_empty() {
    return Err(AppError::Other("No tables specified for export".to_string()));
}
```

后续逻辑：
- `export_all = true`：在早退检查之后，执行 `SHOW TABLES`（MySQL）或 `SELECT tablename FROM information_schema.tables WHERE table_schema = $1`（PG）获取全量表名，赋值给局部变量 `tables_to_export`
- `export_all = false`：`tables_to_export = params.tables`
- `tables_to_export.len() > 1` 或 `export_all = true`：输出路径为 `output_dir/{file_name}.zip`，ZIP 内每个表一个文件
- `tables_to_export.len() == 1`：输出路径为 `output_dir/{file_name}.{format}`，单文件

---

### 2. BackupWizard（新建）

#### 2.1 入口

数据库节点右键 → "备份数据库" → 打开 BackupWizard

#### 2.2 Props

```typescript
interface BackupWizardProps {
  connectionId: number;
  database: string;
  driver: 'mysql' | 'postgresql';  // DBTree 传入前需规范化（见 4.4 节）
  onClose: () => void;
}
```

#### 2.3 流程：2步

**Step 1：备份选项**

- 备份方式单选（目前仅"逻辑备份"可选，其他灰色预留）
- MySQL 附加选项：包含建表语句（默认勾选）、包含数据（默认勾选）、压缩输出（默认不勾选）
- PG 附加选项：包含 schema（默认勾选）、包含数据（默认勾选）、自定义格式（.dump，默认不勾选）

**Step 2：文件名 + 摘要**

```
文件名
[ mydb_20260313152301 ] [ .sql ]
                         PG 勾选"自定义格式"时变为 .dump

摘要
数据库：mydb
驱动：MySQL
备份方式：逻辑备份
```

点"开始备份" → 弹目录选择器 → 调用 Rust 命令 `backup_database`

**BackupWizard 文件名生成时机：**

BackupWizard 采用与 ExportWizard 相同的 `userEditedFileName` 模式：
- 组件初始化时生成默认文件名：`{database}_{yyyyMMddHHmmss}`
- 用户手动修改后设置 `userEditedFileName = true`，不再自动覆盖
- PG 勾选"自定义格式"时，仅更新后缀显示（`.dump`），不重新生成文件名主体

```typescript
const [fileName, setFileName] = useState(() => `${database}_${formatTimestamp()}`);
const [userEditedFileName, setUserEditedFileName] = useState(false);
```

#### 2.4 错误处理

若系统未安装 `mysqldump` / `pg_dump`，在 Step 2 底部显示错误提示：
> "未找到 {tool}，请确认已安装并添加到 PATH"

---

### 3. ContextMenu 变更

#### 3.1 新增 props（均为可选，undefined 时对应菜单项不渲染）

```typescript
onExportDatabase?: () => void;   // database/schema 节点 → 导出数据
onBackupDatabase?: () => void;   // database/schema 节点 → 备份数据库
onExportMultiTable?: () => void; // tables category 节点 → 导出多表
```

菜单项生成时检查 prop 是否存在：
```typescript
...(onExportDatabase ? [{ label: t('contextMenu.exportDatabase'), icon: Download, onClick: onExportDatabase, dividerBefore: true }] : []),
```

#### 3.2 菜单项变更

**database / schema 节点**（现有：新建查询、刷新）新增：
```
新建查询
刷新
─────────────
导出数据
备份数据库
```

**category 节点（objectName === 'tables'）** 新增：
```
新建表
AI 建表
刷新
─────────────
导出多表
```

**table 节点**：不变

---

### 4. DBTree 变更

#### 4.1 新增 state

```typescript
const [backupWizard, setBackupWizard] = useState<{
  connectionId: number;
  database: string;
  driver: 'mysql' | 'postgresql';
} | null>(null);
```

#### 4.2 exportWizard state 扩展

现有 `tableName` 字段类型从 `string`（必选）改为 `string | undefined`（可选）：

```typescript
const [exportWizard, setExportWizard] = useState<{
  tableName?: string;          // 单表入口时传入；database/multi_table 入口不传
  connectionId: number;
  database?: string;
  schema?: string;
  initialScope?: ExportScope;  // 新增
} | null>(null);
```

**现有 `onExportTableData` handler 不变**（`tableName: n.label` 仍然传入），渲染处 `defaultTable={exportWizard.tableName}` 也不变（`ExportWizardProps.defaultTable` 本已为 `string | undefined`，TypeScript 兼容）。唯一改动是 state 类型声明去掉 `tableName` 的必选约束，使 database/multi_table 入口 handler 可以不传 `tableName`。

#### 4.3 新增 handler 逻辑

```typescript
// database/schema 节点 → 导出数据
onExportDatabase={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setExportWizard({
    connectionId: getConnectionId(n),
    database: n.meta.database ?? n.label,
    schema: n.meta.schema,
    initialScope: 'database',
  });
}}

// database/schema 节点 → 备份数据库
onBackupDatabase={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setBackupWizard({
    connectionId: getConnectionId(n),
    database: n.meta.database ?? n.label,
    driver: normalizeDriver(getDriver(getConnectionId(n))),
  });
}}

// tables category 节点 → 导出多表
onExportMultiTable={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setExportWizard({
    connectionId: getConnectionId(n),
    database: n.meta.database,
    schema: n.meta.schema,
    initialScope: 'multi_table',
  });
}}
```

#### 4.4 driver 规范化函数

`getDriver()` 返回的值来自 connections store，可能为 `'postgres'`、`'postgresql'` 等变体，需规范化：

```typescript
function normalizeDriver(raw: string): 'mysql' | 'postgresql' {
  const lower = raw.toLowerCase();
  if (lower === 'mysql') return 'mysql';
  if (lower.startsWith('pg') || lower.startsWith('postgres')) return 'postgresql';
  return 'mysql'; // 默认 fallback
}
```

#### 4.5 DBTree 中 ContextMenu 调用处新增传参

在 `DBTree.tsx` 的 `<ContextMenu ... />` 调用处增加以下 3 个 prop（仅在节点类型匹配时传入非 undefined 值，利用可选 prop 机制自动控制菜单项显隐）：

```typescript
<ContextMenu
  {/* 现有 props 不变 */}
  onExportDatabase={
    (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
      ? () => { /* onExportDatabase handler */ }
      : undefined
  }
  onBackupDatabase={
    (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
      ? () => { /* onBackupDatabase handler */ }
      : undefined
  }
  onExportMultiTable={
    (contextMenu.node.nodeType === 'category' && contextMenu.node.meta.objectName === 'tables')
      ? () => { /* onExportMultiTable handler */ }
      : undefined
  }
/>
```

#### 4.6 BackupWizard 渲染

```typescript
{backupWizard && (
  <BackupWizard
    connectionId={backupWizard.connectionId}
    database={backupWizard.database}
    driver={backupWizard.driver}
    onClose={() => setBackupWizard(null)}
  />
)}
```
```

---

### 5. Rust 后端变更

#### 5.1 export_tables 命令参数扩展

见 1.6 节，新增 `file_name: String` 和 `export_all: bool` 字段，`output_dir` 语义不变。

#### 5.2 新增 backup_database 命令

```rust
#[tauri::command]
async fn backup_database(params: BackupParams) -> Result<(), String>

struct BackupParams {
    connection_id: i64,
    database: String,
    output_path: String,      // 完整文件路径（output_dir + file_name + ext）
    include_schema: bool,
    include_data: bool,
    compress: bool,
    custom_format: bool,      // PG only: --format=c → 输出 .dump
}
```

**实现逻辑：**
1. 查询 `connection_id` 对应连接信息（host/port/username/password/driver）
2. 根据 driver 分支：
   - MySQL：`Command::new("mysqldump")` 拼接 `-h -P -u -p --databases {db}` 等参数，stdout 重定向到 `output_path`
   - PG：`Command::new("pg_dump")` 拼接 `-h -p -U -d {db}` 等参数，`custom_format` 时加 `--format=c`
3. 命令不存在时（`io::Error::kind() == NotFound`），返回 `Err("未找到 mysqldump/pg_dump，请确认已安装并添加到 PATH".to_string())`
4. 成功注册到 `lib.rs` 的 `generate_handler![]`

---

### 6. i18n 新增 key（JSON 嵌套结构）

**zh.json：**

```json
{
  "contextMenu": {
    "exportDatabase": "导出数据",
    "backupDatabase": "备份数据库",
    "exportMultiTable": "导出多表"
  },
  "exportWizard": {
    "fileName": "文件名",
    "fileNamePlaceholder": "输入文件名",
    "summaryFile": "输出文件：{{name}}{{ext}}"
    // 注：此 key 位于 exportWizard 命名空间，与 importWizard.summaryFile 无冲突
  },
  "backupWizard": {
    "title": "备份数据库",
    "step": "步骤 {{current}} / {{total}}",
    "backupMethod": "备份方式",
    "logicalBackup": "逻辑备份（mysqldump / pg_dump）",
    "includeSchema": "包含建表语句",
    "includeData": "包含数据",
    "compress": "压缩输出",
    "customFormat": "自定义格式（.dump）",
    "summaryDb": "数据库：{{db}}",
    "summaryDriver": "驱动：{{driver}}",
    "summaryMethod": "备份方式：{{method}}",
    "startBackup": "开始备份",
    "backing": "备份中...",
    "toolNotFound": "未找到 {{tool}}，请确认已安装并添加到 PATH",
    "success": "备份成功：{{path}}",
    "cancel": "取消",
    "prev": "上一步",
    "next": "下一步"
  }
}
```

**en.json 对应翻译（结构相同，值改为英文，略）**

---

## 文件变更清单

| 文件 | 操作 |
|---|---|
| `src/components/ImportExport/ExportWizard.tsx` | 修改：动态步骤、文件名输入、initialScope prop、export_all 支持 |
| `src/components/ImportExport/BackupWizard.tsx` | 新建 |
| `src/components/Explorer/ContextMenu.tsx` | 修改：新增 3 个可选 prop 和菜单项 |
| `src/components/Explorer/DBTree.tsx` | 修改：新增 state、handler、normalizeDriver、BackupWizard 渲染 |
| `src/i18n/locales/zh.json` | 修改：新增 contextMenu/exportWizard/backupWizard key |
| `src/i18n/locales/en.json` | 修改：新增对应英文 key |
| `src-tauri/src/commands.rs` | 修改：扩展 export_tables（file_name/export_all），新增 backup_database |
| `src-tauri/src/lib.rs` | 修改：注册 backup_database |
