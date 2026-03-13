# 导出与备份功能增强设计文档

**日期**：2026-03-13
**状态**：已批准
**涉及模块**：ExportWizard、BackupWizard（新）、ContextMenu、DBTree、Rust 后端

---

## 背景

现有 ExportWizard 仅支持从表节点触发单表/多表导出，数据库节点无导出入口，且导出文件名不可编辑，也不支持运维场景的原生数据库备份。本次增强覆盖三个方向：

1. ExportWizard Step3 加文件名输入，步骤数随 scope 自适应
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

头部步骤圆点数量和"步骤 X/N"的 N 值根据当前 scope 动态计算。当用户在 Step1 选择 `database` scope 时，"下一步"直接跳到最终选项页（内容同原 Step3，重编号为 Step2）。

#### 1.2 文件名输入（最终步骤新增）

最终步骤顶部新增文件名行：

```
文件名
[ users_20260313152301 ] [ .csv ]
                          ↑ 后缀跟随格式联动，只读
```

**自动生成规则：**

| scope | 默认文件名 | 说明 |
|---|---|---|
| `current_table` | `{tableName}_{yyyyMMddHHmmss}` | |
| `multi_table` | `{database}_{schema}_{yyyyMMddHHmmss}` | PG 含 schema，MySQL 无 schema 段 |
| `database` | `{database}_{yyyyMMddHHmmss}` | |

**格式 → 后缀映射：**

| 格式 | 后缀 |
|---|---|
| csv | `.csv` |
| json | `.json` |
| sql | `.sql` |
| multi_table（任意格式） | `.zip`（ZIP 内每个表为 `{tableName}.{format}`）|

#### 1.3 导出流程变更

- 点"开始导出" → 弹目录选择器 → 文件保存为 `{选中目录}/{文件名}{后缀}`
- 多表 ZIP：`{目录}/{文件名}.zip`，ZIP 内每个表一个文件，按格式命名

#### 1.4 新增 props

```typescript
interface ExportWizardProps {
  initialScope?: ExportScope;  // 新增：调用方指定初始 scope
  // 其余保持不变
  defaultTable?: string;
  connectionId: number;
  database?: string;
  schema?: string;
  onClose: () => void;
}
```

#### 1.5 Step3Options 新增字段

```typescript
interface Step3Options {
  // 现有字段保持不变
  format: ExportFormat;
  includeHeader: boolean;
  includeDdl: boolean;
  whereClause: string;
  encoding: 'UTF-8' | 'GBK';
  delimiter: string;
  // 新增
  fileName: string;  // 不含后缀，用户可编辑
}
```

---

### 2. BackupWizard（新建）

#### 2.1 入口

数据库节点右键 → "备份数据库" → 打开 BackupWizard

#### 2.2 Props

```typescript
interface BackupWizardProps {
  connectionId: number;
  database: string;
  driver: string;  // 'mysql' | 'postgresql'
  onClose: () => void;
}
```

#### 2.3 流程：2步

**Step 1：备份选项**

- 备份方式单选（目前仅"逻辑备份"可选，其他灰色预留）
- MySQL 附加选项：包含建表语句（默认勾选）、包含数据（默认勾选）、压缩输出
- PG 附加选项：包含 schema（默认勾选）、包含数据（默认勾选）、自定义格式（.dump）

**Step 2：文件名 + 摘要**

```
文件名
[ mydb_20260313152301 ] [ .sql ]
                         PG 自定义格式时变为 .dump

摘要
数据库：mydb
驱动：MySQL 8.0
备份方式：逻辑备份
```

点"开始备份" → 弹目录选择器 → 调用 Rust 命令

#### 2.4 错误处理

若系统未安装 `mysqldump` / `pg_dump`，显示错误提示：
> "未找到 {tool}，请确认已安装并添加到 PATH"

---

### 3. ContextMenu 变更

#### 3.1 新增 props

```typescript
onExportDatabase: () => void;    // database/schema 节点 → 导出数据
onBackupDatabase: () => void;    // database/schema 节点 → 备份数据库
onExportMultiTable: () => void;  // tables category 节点 → 导出多表
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

**table 节点**：不变（现有"导出数据"入口已足够，用户可在向导 Step1 切换 scope）

---

### 4. DBTree 变更

#### 4.1 新增 state

```typescript
const [backupWizard, setBackupWizard] = useState<{
  connectionId: number;
  database: string;
  driver: string;
} | null>(null);
```

#### 4.2 新增 handler 逻辑

```typescript
// database/schema 节点 → 导出数据（database scope，跳表选择）
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
    driver: getDriver(getConnectionId(n)),
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

#### 4.3 exportWizard state 扩展

```typescript
const [exportWizard, setExportWizard] = useState<{
  tableName?: string;       // 单表入口时传入
  connectionId: number;
  database?: string;
  schema?: string;
  initialScope?: ExportScope;  // 新增
} | null>(null);
```

---

### 5. Rust 后端变更

#### 5.1 export_tables 扩展（多表 ZIP）

现有 `export_tables` 命令需支持 ZIP 输出：
- 当 `output_format = 'zip'`（或根据选中表数量 > 1 自动判断）时，将所有表文件打包为 ZIP
- 输出路径为完整文件路径（`output_dir/filename.zip`）而非目录

#### 5.2 新增 backup_database 命令

```rust
#[tauri::command]
async fn backup_database(params: BackupParams) -> Result<(), String>

struct BackupParams {
    connection_id: i64,
    database: String,
    output_path: String,      // 完整文件路径
    include_schema: bool,
    include_data: bool,
    compress: bool,
    custom_format: bool,      // PG only: --format=c
}
```

**实现逻辑：**
- 查询 connection_id 对应的连接信息获取 host/port/user/password
- MySQL：`std::process::Command::new("mysqldump")` 拼接参数
- PG：`std::process::Command::new("pg_dump")` 拼接参数
- 若命令不存在（`which`/`where` 失败），返回 `Err("未找到 mysqldump/pg_dump")`

---

### 6. i18n 新增 key

**en.json / zh.json 各新增：**

```json
// contextMenu
"exportDatabase": "导出数据 / Export Data",
"backupDatabase": "备份数据库 / Backup Database",
"exportMultiTable": "导出多表 / Export Multiple Tables",

// exportWizard
"fileName": "文件名 / File Name",
"fileNamePlaceholder": "输入文件名 / Enter file name",
"summaryFile": "输出文件：{{name}}{{ext}} / Output: {{name}}{{ext}}",

// backupWizard（全新）
"title": "备份数据库 / Backup Database",
"step": "步骤 {{current}} / {{total}} / Step {{current}} of {{total}}",
"backupMethod": "备份方式 / Backup Method",
"logicalBackup": "逻辑备份（mysqldump / pg_dump） / Logical Backup",
"includeSchema": "包含建表语句 / Include Schema",
"includeData": "包含数据 / Include Data",
"compress": "压缩输出 / Compress Output",
"customFormat": "自定义格式（.dump） / Custom Format (.dump)",
"summaryDb": "数据库：{{db}} / Database: {{db}}",
"summaryDriver": "驱动：{{driver}} / Driver: {{driver}}",
"summaryMethod": "备份方式：{{method}} / Method: {{method}}",
"startBackup": "开始备份 / Start Backup",
"backing": "备份中... / Backing up...",
"toolNotFound": "未找到 {{tool}}，请确认已安装并添加到 PATH / {{tool}} not found, please install it and add to PATH",
"success": "备份成功：{{path}} / Backup succeeded: {{path}}"
```

---

## 文件变更清单

| 文件 | 操作 |
|---|---|
| `src/components/ImportExport/ExportWizard.tsx` | 修改：动态步骤、文件名输入、initialScope prop |
| `src/components/ImportExport/BackupWizard.tsx` | 新建 |
| `src/components/Explorer/ContextMenu.tsx` | 修改：新增 3 个 prop 和菜单项 |
| `src/components/Explorer/DBTree.tsx` | 修改：新增 state、handler、BackupWizard 渲染 |
| `src/i18n/locales/zh.json` | 修改：新增 key |
| `src/i18n/locales/en.json` | 修改：新增 key |
| `src-tauri/src/commands.rs` | 修改：新增 backup_database，扩展 export_tables ZIP 支持 |
| `src-tauri/src/lib.rs` | 修改：注册 backup_database |
