<!-- STATUS: ✅ 已实现 -->
# 导出与备份功能增强实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ExportWizard 增加文件名输入和动态步骤数；为数据库节点添加"导出数据"和"备份数据库"右键入口；为 tables 分类节点添加多表导出入口；多表/整库导出输出 ZIP 包。

**Architecture:** 前端改造 ExportWizard（动态步骤 + fileName）并新建 BackupWizard；Rust 后端扩展 `export_tables` 参数（增加 `file_name`/`export_all` + ZIP 打包逻辑）并新增 `backup_database` 命令（调用 mysqldump/pg_dump 子进程）；ContextMenu 和 DBTree 增加三个新入口。

**Tech Stack:** React 18 + TypeScript, Rust/Tauri 2, `zip` crate（新增）, i18next

**Spec:** `docs/superpowers/specs/2026-03-13-export-backup-enhancement-design.md`

---

## Chunk 1: i18n + Rust 后端基础

### Task 1: 新增 i18n key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: 在 zh.json 中新增 contextMenu key**

找到 `"contextMenu"` 对象，在 `"noGroup"` 之后、对象闭合之前加入：

```json
"exportDatabase": "导出数据",
"backupDatabase": "备份数据库",
"exportMultiTable": "导出多表"
```

> 注意：zh.json 中 `contextMenu.exportData` 和 `contextMenu.importData` 已存在（表节点用），这三个是新 key，名称不同，不冲突。

- [ ] **Step 2: 在 zh.json 中新增 exportWizard key**

找到 `"exportWizard"` 对象，在 `"selectOutputDir"` 之后加入：

```json
"fileName": "文件名",
"fileNamePlaceholder": "输入文件名",
"summaryFile": "输出文件：{{name}}{{ext}}"
```

- [ ] **Step 3: 在 zh.json 中新增 backupWizard 对象**

在 `"exportWizard"` 对象之后（`"importWizard"` 之前）加入：

```json
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
},
```

- [ ] **Step 4: 在 en.json 中同步新增（结构相同，值改为英文）**

`contextMenu` 中加：
```json
"exportDatabase": "Export Data",
"backupDatabase": "Backup Database",
"exportMultiTable": "Export Multiple Tables"
```

`exportWizard` 中加：
```json
"fileName": "File Name",
"fileNamePlaceholder": "Enter file name",
"summaryFile": "Output file: {{name}}{{ext}}"
```

新增 `backupWizard` 对象：
```json
"backupWizard": {
  "title": "Backup Database",
  "step": "Step {{current}} / {{total}}",
  "backupMethod": "Backup Method",
  "logicalBackup": "Logical Backup (mysqldump / pg_dump)",
  "includeSchema": "Include Schema",
  "includeData": "Include Data",
  "compress": "Compress Output",
  "customFormat": "Custom Format (.dump)",
  "summaryDb": "Database: {{db}}",
  "summaryDriver": "Driver: {{driver}}",
  "summaryMethod": "Method: {{method}}",
  "startBackup": "Start Backup",
  "backing": "Backing up...",
  "toolNotFound": "{{tool}} not found, please install it and add to PATH",
  "success": "Backup succeeded: {{path}}",
  "cancel": "Cancel",
  "prev": "Back",
  "next": "Next"
}
```

- [ ] **Step 5: 验证 JSON 语法**

```bash
node -e "require('./src/i18n/locales/zh.json'); console.log('zh ok')"
node -e "require('./src/i18n/locales/en.json'); console.log('en ok')"
```

Expected: `zh ok` / `en ok`（无 JSON 解析错误）

- [ ] **Step 6: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(i18n): add export/backup wizard keys"
```

---

### Task 2: Rust - 添加 zip crate 并扩展 MultiExportParams

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands.rs`（MultiExportParams + export_tables 逻辑）

- [ ] **Step 1: 在 Cargo.toml 中添加 zip crate**

在 `[dependencies]` 中 `uuid` 之后加入：

```toml
# ZIP 打包（多表导出）
zip = { version = "2", features = [] }
```

- [ ] **Step 2: 验证 Cargo 依赖可解析**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: 无错误，或仅有 warning

- [ ] **Step 3: 扩展 MultiExportParams 结构体**

找到 `src-tauri/src/commands.rs` 中的 `pub struct MultiExportParams`（约第 1172 行），在 `pub options: MultiExportOptions,` 之后加入两个字段：

```rust
#[serde(default)]
pub file_name: String,    // 输出文件名（不含后缀），Rust 侧拼接后缀
#[serde(default)]
pub export_all: bool,     // true 时忽略 tables，自动查全量表
```

- [ ] **Step 4: 修复 export_tables 早退检查**

找到 `export_tables` 函数（约第 1202 行）：

```rust
// 旧代码：
if params.tables.is_empty() {
    return Err(crate::AppError::Other("No tables specified for export".to_string()));
}
```

改为：

```rust
if !params.export_all && params.tables.is_empty() {
    return Err(crate::AppError::Other("No tables specified for export".to_string()));
}
```

- [ ] **Step 5: 在 export_tables 中实现 export_all 表名查询**

在早退检查之后、task title 构建之前，插入表名解析逻辑：

```rust
// 解析最终要导出的表名列表
let tables_to_export: Vec<String> = if params.export_all {
    // 查询数据库全量表名
    let config = crate::db::get_connection_config(params.connection_id)?;
    let db_name = params.database.as_deref().unwrap_or("");
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    ds.list_objects(db_name, params.schema.as_deref(), "tables").await
        .map_err(|e| crate::AppError::Other(format!("Failed to list tables: {}", e)))?
} else {
    params.tables.clone()
};
```

> `list_objects` 是 datasource trait 方法，MySQL 和 PG 均已实现。

- [ ] **Step 6: 更新 task title 和 description 中所有 params.tables 引用**

共有以下位置需要将 `params.tables` 改为 `tables_to_export`：

**位置 1：title 构建**
```rust
// 原：
let title = if params.tables.len() == 1 {
    format!("导出 {} 表", params.tables[0])
} else {
    format!("导出 {} 个表", params.tables.len())
};
// 改为：
let title = if tables_to_export.len() == 1 {
    format!("导出 {} 表", tables_to_export[0])
} else {
    format!("导出 {} 个表", tables_to_export.len())
};
```

**位置 2：description 中的表列表**（约第 1258-1268 行，`table_list` 变量构建处）
```rust
// 原：
let table_list = params.tables.iter()
    .map(|t| format!("- `{}`", t))
    .collect::<Vec<_>>()
    .join("\n");
// 中间的 format! 宏中 params.tables.len() 也要改：
format!("...（{} 个）\n{}", params.tables.len(), table_list)
// 改为：
let table_list = tables_to_export.iter()
    .map(|t| format!("- `{}`", t))
    .collect::<Vec<_>>()
    .join("\n");
format!("...（{} 个）\n{}", tables_to_export.len(), table_list)
```

**位置 3：current_target 字段**（`create_task` 调用中）
```rust
// 原：
current_target: Some(params.tables.first().cloned().unwrap_or_default()),
// 改为：
current_target: Some(tables_to_export.first().cloned().unwrap_or_default()),
```

- [ ] **Step 7: 给 MultiExportParams 加 Clone derive（Step 8 的 tokio::spawn 代码需要 Clone）**

找到 `MultiExportParams` struct 的 derive 宏，加入 `Clone`：

```rust
// 原：
#[derive(Debug, Serialize, Deserialize)]
pub struct MultiExportParams {

// 改为：
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiExportParams {
```

- [ ] **Step 8: 实现 ZIP 分支（多表/整库）vs 单文件分支（单表）**

找到 tokio::spawn 闭包内的循环（约第 1292-1368 行），将 `params.tables` 改为克隆的 `tables_to_export`，并在循环外添加 ZIP 分支逻辑：

```rust
let is_zip = tables_to_export.len() > 1 || params.export_all;
let file_name = if params.file_name.is_empty() {
    tables_to_export.first().cloned().unwrap_or_else(|| "export".to_string())
} else {
    params.file_name.clone()
};

let total = tables_to_export.len() as u64;

// 克隆供 async move 使用
let tables_for_task = tables_to_export.clone();
let params_clone = params.clone();  // 需要给 MultiExportParams 加 #[derive(Clone)]

tokio::spawn(async move {
    use std::path::Path;
    use std::fs::File;
    use std::io::Write;

    if is_zip {
        // ---- ZIP 分支 ----
        let zip_path = Path::new(&params_clone.output_dir)
            .join(format!("{}.zip", file_name));

        let zip_file = match File::create(&zip_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                return;
            }
        };
        let mut zip = zip::ZipWriter::new(zip_file);
        let zip_options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let mut processed = 0u64;
        for (i, table_name) in tables_for_task.iter().enumerate() {
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone.clone(),
                status: "running".to_string(),
                progress: ((i as f64 / total as f64) * 100.0) as u8,
                processed_rows: processed,
                total_rows: Some(total),
                current_target: table_name.clone(),
                error: None,
                output_path: Some(zip_path.to_string_lossy().to_string()),
            });

            // 导出单表到临时文件
            let tmp_path = Path::new(&params_clone.output_dir)
                .join(format!("_tmp_{}.{}", table_name, &params_clone.format));
            let single_params = ExportParams {
                connection_id: params_clone.connection_id,
                database: params_clone.database.clone(),
                table: table_name.clone(),
                schema: params_clone.schema.clone(),
                format: params_clone.format.clone(),
                where_clause: None,
                output_path: tmp_path.to_string_lossy().to_string(),
                include_header: params_clone.options.include_header,
                include_ddl: params_clone.options.include_ddl,
            };

            if let Err(e) = export_table_data(single_params).await {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone.clone(),
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: processed,
                    total_rows: Some(total),
                    current_target: table_name.clone(),
                    error: Some(e.to_string()),
                    output_path: None,
                });
                // 清理临时文件
                let _ = std::fs::remove_file(&tmp_path);
                return;
            }

            // 将临时文件内容写入 ZIP
            let entry_name = format!("{}.{}", table_name, &params_clone.format);
            if zip.start_file(&entry_name, zip_options).is_ok() {
                if let Ok(content) = std::fs::read(&tmp_path) {
                    let _ = zip.write_all(&content);
                }
            }
            let _ = std::fs::remove_file(&tmp_path);
            processed += 1;
        }

        let _ = zip.finish();

        let out_path_str = zip_path.to_string_lossy().to_string();
        let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
            status: Some("completed".to_string()),
            progress: Some(100),
            processed_rows: Some(processed as i64),
            total_rows: Some(total as i64),
            output_path: Some(out_path_str.clone()),
            completed_at: Some(chrono::Utc::now().to_rfc3339()),
            ..Default::default()
        });
        let _ = app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id_clone,
            status: "completed".to_string(),
            progress: 100,
            processed_rows: processed,
            total_rows: Some(total),
            current_target: String::new(),
            error: None,
            output_path: Some(out_path_str),
        });

    } else {
        // ---- 单文件分支（保持原逻辑，但使用 file_name） ----
        let table_name = tables_for_task.first().cloned().unwrap_or_default();
        let output_file = Path::new(&params_clone.output_dir)
            .join(format!("{}.{}", file_name, &params_clone.format));

        let single_params = ExportParams {
            connection_id: params_clone.connection_id,
            database: params_clone.database.clone(),
            table: table_name.clone(),
            schema: params_clone.schema.clone(),
            format: params_clone.format.clone(),
            where_clause: params_clone.options.where_clause.clone(),
            output_path: output_file.to_string_lossy().to_string(),
            include_header: params_clone.options.include_header,
            include_ddl: params_clone.options.include_ddl,
        };

        if let Err(e) = export_table_data(single_params).await {
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("failed".to_string()),
                error: Some(e.to_string()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone,
                status: "failed".to_string(),
                progress: 0,
                processed_rows: 0,
                total_rows: Some(1),
                current_target: table_name,
                error: Some(e.to_string()),
                output_path: None,
            });
            return;
        }

        let out_path_str = output_file.to_string_lossy().to_string();
        let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
            status: Some("completed".to_string()),
            progress: Some(100),
            processed_rows: Some(1),
            total_rows: Some(1),
            output_path: Some(out_path_str.clone()),
            completed_at: Some(chrono::Utc::now().to_rfc3339()),
            ..Default::default()
        });
        let _ = app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id_clone,
            status: "completed".to_string(),
            progress: 100,
            processed_rows: 1,
            total_rows: Some(1),
            current_target: String::new(),
            error: None,
            output_path: Some(out_path_str),
        });
    }
});
```

> `MultiExportParams` 需要加 `#[derive(Clone)]`（原来只有 `Debug, Serialize, Deserialize`）。

- [ ] **Step 9: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 无 error

- [ ] **Step 10: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands.rs
git commit -m "feat(rust): extend export_tables with file_name, export_all, and ZIP support"
```

---

### Task 3: Rust - backup_database 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（新增 BackupParams + backup_database）
- Modify: `src-tauri/src/lib.rs`（注册命令）

- [ ] **Step 1: 在 commands.rs 末尾新增 BackupParams 结构体和 backup_database 命令**

> **注意**：`backup_database` 返回类型使用 `Result<(), String>` 而非 `AppResult<()>`，因为其错误需直接以字符串形式展示给前端（工具未找到等），Tauri 对 `Result<T, String>` 和 `Result<T, AppError>` 均支持序列化，两者最终都以 JSON 错误字符串传递，此处刻意选择更简单的形式。

在文件末尾（`}` 最后一个函数之后）追加：

```rust
// ============ 数据库备份 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupParams {
    pub connection_id: i64,
    pub database: String,
    pub output_path: String,      // 完整文件路径（含文件名和后缀）
    pub include_schema: bool,
    pub include_data: bool,
    pub compress: bool,           // MySQL: -C
    pub custom_format: bool,      // PG only: --format=c → 输出 .dump
}

#[tauri::command]
pub async fn backup_database(params: BackupParams) -> Result<(), String> {
    use std::process::Command;

    let config = crate::db::get_connection_config(params.connection_id)
        .map_err(|e| e.to_string())?;

    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(if config.driver == "mysql" { 3306 } else { 5432 });
    let user = &config.username;
    let password = crate::db::get_connection_password(params.connection_id)
        .map_err(|e| e.to_string())?;

    let driver = config.driver.to_lowercase();

    let mut cmd = if driver == "mysql" {
        let mut c = Command::new("mysqldump");
        c.arg(format!("-h{}", host))
         .arg(format!("-P{}", port))
         .arg(format!("-u{}", user))
         .arg(format!("-p{}", password));
        if params.compress { c.arg("-C"); }
        if !params.include_data { c.arg("--no-data"); }
        if !params.include_schema { c.arg("--no-create-info"); }
        c.arg("--databases").arg(&params.database);
        c
    } else {
        // PostgreSQL
        let mut c = Command::new("pg_dump");
        c.arg("-h").arg(host)
         .arg("-p").arg(port.to_string())
         .arg("-U").arg(user)
         .arg("-d").arg(&params.database);
        if !params.include_schema { c.arg("--data-only"); }
        if !params.include_data { c.arg("--schema-only"); }
        if params.custom_format { c.arg("--format=c"); }
        c.env("PGPASSWORD", &password);
        c
    };

    // 将 stdout 重定向到输出文件
    let output_file = std::fs::File::create(&params.output_path)
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    cmd.stdout(output_file);

    let status = cmd.status().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            let tool = if driver == "mysql" { "mysqldump" } else { "pg_dump" };
            format!("未找到 {}，请确认已安装并添加到 PATH", tool)
        } else {
            e.to_string()
        }
    })?;

    if !status.success() {
        return Err(format!("备份命令退出码非零：{:?}", status.code()));
    }

    Ok(())
}
```

- [ ] **Step 2: 在 lib.rs 中注册 backup_database**

找到 `commands::export_tables,`（约第 117 行），在其后加入：

```rust
commands::backup_database,
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 无 error

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add backup_database command with mysqldump/pg_dump support"
```

---

## Chunk 2: 前端组件

### Task 4: 改造 ExportWizard

**Files:**
- Modify: `src/components/ImportExport/ExportWizard.tsx`

- [ ] **Step 1: 在 ExportWizardProps 中新增 initialScope**

找到 `interface ExportWizardProps`，加入：

```typescript
initialScope?: ExportScope;
```

- [ ] **Step 2: 在 Step3Options 中新增 fileName**

找到 `interface Step3Options`，加入：

```typescript
fileName: string;
```

- [ ] **Step 3: 更新 useState 初始值**

找到 `const [options, setOptions] = useState<Step3Options>({`，加入：

```typescript
fileName: '',
```

在 `ExportWizard` 函数参数中接收 `initialScope`：

```typescript
export const ExportWizard: React.FC<ExportWizardProps> = ({
  defaultTable,
  connectionId,
  database = '',
  schema = '',
  initialScope,   // 新增
  onClose,
}) => {
```

将 `step1` 初始化中的 scope 改为：

```typescript
scope: initialScope ?? (defaultTable ? 'current_table' : 'multi_table'),
```

- [ ] **Step 4: 添加 userEditedFileName state 和 formatTimestamp 辅助函数**

在 `const [isLoading, setIsLoading]` 之后加入：

```typescript
const [userEditedFileName, setUserEditedFileName] = useState(false);

const formatTimestamp = (): string => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
};
```

- [ ] **Step 5: 添加文件名自动生成 useEffect**

在现有 useEffect 之后加入：

```typescript
useEffect(() => {
  if (userEditedFileName) return;
  const ts = formatTimestamp();
  let name = '';
  if (step1.scope === 'current_table') {
    name = `${defaultTable ?? 'export'}_${ts}`;
  } else if (step1.scope === 'multi_table') {
    name = step1.schema
      ? `${step1.database}_${step1.schema}_${ts}`
      : `${step1.database}_${ts}`;
  } else {
    name = `${step1.database || 'database'}_${ts}`;
  }
  setOptions(o => ({ ...o, fileName: name }));
}, [step1.scope, step1.database, step1.schema, defaultTable, userEditedFileName]);
```

- [ ] **Step 6: 添加 handleScopeChange（重置 userEditedFileName）**

```typescript
const handleScopeChange = (scope: ExportScope) => {
  setStep1(s => ({ ...s, scope }));
  setUserEditedFileName(false);
};
```

将 Step1 中 radio `onChange` 改为调用 `handleScopeChange`：

```typescript
// 原：onChange={() => setStep1((s) => ({ ...s, scope }))}
// 改为：
onChange={() => handleScopeChange(scope)}
```

- [ ] **Step 7: 添加动态步骤数逻辑**

在 `const inputClass` 之前加入：

```typescript
const totalSteps = step1.scope === 'database' ? 2 : 3;

const goNext = () => {
  if (step1.scope === 'database' && step === 1) {
    setStep(3);
  } else {
    setStep(s => s + 1);
  }
};

const goPrev = () => {
  if (step1.scope === 'database' && step === 3) {
    setStep(1);
  } else {
    setStep(s => s - 1);
  }
};

const displayStep = step1.scope === 'database' && step === 3 ? 2 : step;
```

- [ ] **Step 8: 更新头部步骤圆点和文字**

找到头部圆点渲染部分：

```typescript
// 原：
{[1, 2, 3].map((n) => (
  <div key={n} className={`w-2 h-2 rounded-full ${n === step ? ... : n < step ? ... : ...}`} />
))}
<span className="text-xs text-gray-400">{t('exportWizard.step', { current: step, total: 3 })}</span>

// 改为：
{Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
  <div
    key={n}
    className={`w-2 h-2 rounded-full ${
      n === displayStep ? 'bg-[#009e84]' : n < displayStep ? 'bg-[#00c9a7]' : 'bg-[#253347]'
    }`}
  />
))}
<span className="text-xs text-gray-400">
  {t('exportWizard.step', { current: displayStep, total: totalSteps })}
</span>
```

- [ ] **Step 9: 在 Step3 最终步骤加文件名输入**

找到 Step3 的 `{step === 3 && (` 块，在 `<div className="space-y-3">` 之后、格式选项 `grid` 之前，加入文件名行：

```tsx
{/* 文件名输入 */}
<div>
  <label className={labelClass}>{t('exportWizard.fileName')}</label>
  <div className="flex gap-2 items-center">
    <input
      value={options.fileName}
      onChange={e => {
        setOptions(o => ({ ...o, fileName: e.target.value }));
        setUserEditedFileName(true);
      }}
      placeholder={t('exportWizard.fileNamePlaceholder')}
      className={`${inputClass} flex-1`}
    />
    <span className="text-sm text-gray-400 flex-shrink-0">
      {(step1.scope === 'current_table')
        ? `.${options.format}`
        : '.zip'}
    </span>
  </div>
</div>
```

- [ ] **Step 10: 更新 handleStart 传入 file_name 和 export_all**

找到 `handleStart` 函数中 `invoke('export_tables', { params: { ... } })` 调用，更新参数：

```typescript
// tablesToExport 计算改为：
const tablesToExport =
  step1.scope === 'database'
    ? []
    : step1.scope === 'current_table' && defaultTable
    ? [defaultTable]
    : selectedTables;

// invoke 调用加入新字段：
await invoke('export_tables', {
  params: {
    connection_id: step1.connectionId,
    database: step1.database || null,
    schema: step1.schema || null,
    tables: tablesToExport,
    format: options.format,
    output_dir: outputDir,
    file_name: options.fileName,
    export_all: step1.scope === 'database',
    options: {
      include_header: options.includeHeader,
      include_ddl: options.includeDdl,
      where_clause: options.whereClause || null,
      encoding: options.encoding,
      delimiter: options.delimiter,
    },
  },
});
```

- [ ] **Step 11: 更新 Footer 按钮使用 goNext/goPrev**

找到 Footer 中的按钮：

```typescript
// 上一步按钮：onClick={() => setStep((s) => s - 1)} 改为：
onClick={goPrev}

// 下一步按钮：onClick={() => setStep((s) => s + 1)} 改为：
onClick={goNext}

// step < 3 判断保持不变（database scope 从1直接跳3，step < 3 仍然正确触发下一步）
```

- [ ] **Step 12: 在 Step3 摘要区加输出文件信息**

找到摘要 `<div className="p-3 bg-[#1a2639]...">`，在格式信息后加：

```tsx
<div>
  {t('exportWizard.summaryFile', {
    name: options.fileName,
    ext: step1.scope === 'current_table' ? `.${options.format}` : '.zip',
  })}
</div>
```

- [ ] **Step 13: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无错误（或仅有不相关的现有警告）

- [ ] **Step 14: Commit**

```bash
git add src/components/ImportExport/ExportWizard.tsx
git commit -m "feat(export): dynamic steps, fileName input, export_all support"
```

---

### Task 5: 新建 BackupWizard

**Files:**
- Create: `src/components/ImportExport/BackupWizard.tsx`

- [ ] **Step 1: 创建 BackupWizard 组件**

创建文件 `src/components/ImportExport/BackupWizard.tsx`：

```tsx
import React, { useState } from 'react';
import { X, ChevronLeft, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useEscClose } from '../../hooks/useEscClose';

interface BackupWizardProps {
  connectionId: number;
  database: string;
  driver: 'mysql' | 'postgresql';
  onClose: () => void;
}

const formatTimestamp = (): string => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
};

export const BackupWizard: React.FC<BackupWizardProps> = ({
  connectionId,
  database,
  driver,
  onClose,
}) => {
  const { t } = useTranslation();
  useEscClose(onClose);

  const [step, setStep] = useState(1);
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [compress, setCompress] = useState(false);
  const [customFormat, setCustomFormat] = useState(false);  // PG only

  const getExt = () => (driver === 'postgresql' && customFormat) ? '.dump' : '.sql';

  // BackupWizard 无需自动重新生成文件名（无触发场景），直接用初始值即可
  const [fileName, setFileName] = useState(() => `${database}_${formatTimestamp()}`);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const handleStart = async () => {
    setError(null);
    const outputDir = await openDialog({ directory: true, title: '选择备份目录' });
    if (!outputDir || Array.isArray(outputDir)) return;

    const outputPath = `${outputDir}/${fileName}${getExt()}`;
    setIsLoading(true);
    try {
      await invoke('backup_database', {
        params: {
          connection_id: connectionId,
          database,
          output_path: outputPath,
          include_schema: includeSchema,
          include_data: includeData,
          compress,
          custom_format: customFormat,
        },
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[480px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#253347]">
          <h3 className="text-white font-semibold">{t('backupWizard.title')}</h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {[1, 2].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-[#009e84]' : n < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-400">{t('backupWizard.step', { current: step, total: 2 })}</span>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 min-h-[260px]">
          {step === 1 && (
            <div className="space-y-4">
              {/* 备份方式 */}
              <div>
                <label className={labelClass}>{t('backupWizard.backupMethod')}</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked readOnly className="accent-[#009e84]" />
                  <span className="text-sm text-white">{t('backupWizard.logicalBackup')}</span>
                </label>
              </div>

              {/* 选项 */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSchema}
                    onChange={e => setIncludeSchema(e.target.checked)}
                    className="accent-[#009e84]"
                  />
                  <span className="text-sm text-white">{t('backupWizard.includeSchema')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeData}
                    onChange={e => setIncludeData(e.target.checked)}
                    className="accent-[#009e84]"
                  />
                  <span className="text-sm text-white">{t('backupWizard.includeData')}</span>
                </label>
                {driver === 'mysql' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={compress}
                      onChange={e => setCompress(e.target.checked)}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('backupWizard.compress')}</span>
                  </label>
                )}
                {driver === 'postgresql' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={customFormat}
                      onChange={e => setCustomFormat(e.target.checked)}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('backupWizard.customFormat')}</span>
                  </label>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {/* 文件名输入 */}
              <div>
                <label className={labelClass}>{t('backupWizard.title') + ' - ' + t('exportWizard.fileName')}</label>
                <div className="flex gap-2 items-center">
                  <input
                    value={fileName}
                    onChange={e => setFileName(e.target.value)}
                    className={`${inputClass} flex-1`}
                  />
                  <span className="text-sm text-gray-400 flex-shrink-0">{getExt()}</span>
                </div>
              </div>

              {/* 摘要 */}
              <div className="p-3 bg-[#1a2639] rounded border border-[#253347] text-sm text-gray-400 space-y-1">
                <div>{t('backupWizard.summaryDb', { db: database })}</div>
                <div>{t('backupWizard.summaryDriver', { driver: driver === 'mysql' ? 'MySQL' : 'PostgreSQL' })}</div>
                <div>{t('backupWizard.summaryMethod', { method: t('backupWizard.logicalBackup') })}</div>
              </div>

              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 px-3 py-1.5 rounded border border-red-400/30">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#253347]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-[#1a2639] hover:bg-[#253347] text-white rounded transition-colors"
          >
            {t('backupWizard.cancel')}
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-[#1a2639] hover:bg-[#253347] border border-[#253347] rounded transition-colors"
              >
                <ChevronLeft size={14} /> {t('backupWizard.prev')}
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep(2)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors"
              >
                {t('backupWizard.next')}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors disabled:opacity-50"
              >
                <Database size={14} />
                {isLoading ? t('backupWizard.backing') : t('backupWizard.startBackup')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportExport/BackupWizard.tsx
git commit -m "feat(backup): add BackupWizard component for mysqldump/pg_dump"
```

---

### Task 6: 改造 ContextMenu + 改造 DBTree

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`
- Modify: `src/components/Explorer/DBTree.tsx`

- [ ] **Step 1: 在 ContextMenu 接口中新增 3 个可选 prop**

找到 `interface ContextMenuProps`，在末尾（`onCreateDatabase` 之后）加入：

```typescript
onExportDatabase?: () => void;
onBackupDatabase?: () => void;
onExportMultiTable?: () => void;
```

- [ ] **Step 2: 在 ContextMenu 组件参数解构中加入 3 个新 prop**

找到 `export const ContextMenu: React.FC<ContextMenuProps> = ({` 的解构参数列表，在 `onCreateDatabase,` 之后加入：

```typescript
onExportDatabase,
onBackupDatabase,
onExportMultiTable,
```

- [ ] **Step 3: 在 database/schema 菜单项中加入新入口**

找到 `case 'database': case 'schema':` 返回的数组，改为：

```typescript
case 'database':
case 'schema':
  return [
    { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
    { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
    ...(onExportDatabase ? [{ label: t('contextMenu.exportDatabase'), icon: Download, onClick: onExportDatabase, dividerBefore: true }] : []),
    ...(onBackupDatabase ? [{ label: t('contextMenu.backupDatabase'), icon: Archive, onClick: onBackupDatabase }] : []),
  ];
```

在文件顶部 import 中加入 `Archive`：

```typescript
import {
  // ...现有图标...
  Archive,
} from 'lucide-react';
```

- [ ] **Step 4: 在 tables category 菜单项中加入多表导出**

找到 `case 'category':` 的 `if (node.meta.objectName === 'tables')` 分支，改为：

```typescript
if (node.meta.objectName === 'tables') {
  return [
    { label: t('contextMenu.createTable'), icon: FilePlus2, onClick: onCreateTable },
    { label: t('contextMenu.aiCreateTable'), icon: Sparkles, onClick: onAiCreateTable },
    { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
    ...(onExportMultiTable ? [{ label: t('contextMenu.exportMultiTable'), icon: Download, onClick: onExportMultiTable, dividerBefore: true }] : []),
  ];
}
```

- [ ] **Step 5: 在 DBTree 中 import BackupWizard**

在 `ExportWizard` import 行下方加入：

```typescript
import { BackupWizard } from '../ImportExport/BackupWizard';
```

- [ ] **Step 6: 在 DBTree 中添加 normalizeDriver 函数**

在 `getDriver` 函数之后加入：

```typescript
const normalizeDriver = (raw: string): 'mysql' | 'postgresql' => {
  const lower = raw.toLowerCase();
  if (lower === 'mysql') return 'mysql';
  if (lower.startsWith('pg') || lower.startsWith('postgres')) return 'postgresql';
  return 'mysql';
};
```

- [ ] **Step 7: 在 DBTree 中添加 backupWizard state，并放宽 exportWizard state 类型**

找到 `const [exportWizard, setExportWizard]`，改为：

```typescript
const [exportWizard, setExportWizard] = useState<{
  tableName?: string;       // 单表入口传入；database/multi_table 入口不传
  connectionId: number;
  database?: string;
  schema?: string;
  initialScope?: import('../ImportExport/ExportWizard').ExportScope;
} | null>(null);
```

在其后加入：

```typescript
const [backupWizard, setBackupWizard] = useState<{
  connectionId: number;
  database: string;
  driver: 'mysql' | 'postgresql';
} | null>(null);
```

- [ ] **Step 8: 在 DBTree 中更新 ContextMenu 调用，新增 3 个 prop**

找到 `<ContextMenu` 调用（约第 228 行），在 `onCreateDatabase={...}` 之后加入：

```typescript
onExportDatabase={
  (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
    ? () => {
        const n = contextMenu.node;
        setContextMenu(null);
        setExportWizard({
          connectionId: getConnectionId(n),
          database: n.meta.database ?? n.label,
          schema: n.meta.schema,
          initialScope: 'database',
        });
      }
    : undefined
}
onBackupDatabase={
  (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
    ? () => {
        const n = contextMenu.node;
        setContextMenu(null);
        setBackupWizard({
          connectionId: getConnectionId(n),
          database: n.meta.database ?? n.label,
          driver: normalizeDriver(getDriver(getConnectionId(n))),
        });
      }
    : undefined
}
onExportMultiTable={
  (contextMenu.node.nodeType === 'category' && contextMenu.node.meta.objectName === 'tables')
    ? () => {
        const n = contextMenu.node;
        setContextMenu(null);
        setExportWizard({
          connectionId: getConnectionId(n),
          database: n.meta.database,
          schema: n.meta.schema,
          initialScope: 'multi_table',
        });
      }
    : undefined
}
```

- [ ] **Step 9: 在 DBTree JSX 末尾加入 BackupWizard 渲染**

找到 `{exportWizard && (<ExportWizard ... />)}` 之后加入：

```tsx
{backupWizard && (
  <BackupWizard
    connectionId={backupWizard.connectionId}
    database={backupWizard.database}
    driver={backupWizard.driver}
    onClose={() => setBackupWizard(null)}
  />
)}
```

- [ ] **Step 10: 更新 ExportWizard 渲染，传入 initialScope**

找到 `{exportWizard && (<ExportWizard`，加入 `initialScope` prop：

```tsx
{exportWizard && (
  <ExportWizard
    defaultTable={exportWizard.tableName}
    connectionId={exportWizard.connectionId}
    database={exportWizard.database}
    schema={exportWizard.schema}
    initialScope={exportWizard.initialScope}
    onClose={() => setExportWizard(null)}
  />
)}
```

- [ ] **Step 11: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无错误

- [ ] **Step 12: 前端开发服务器启动验证**

```bash
npm run dev
```

手动验证：
1. 右键点击数据库节点 → 菜单出现"导出数据"和"备份数据库"
2. 点击"导出数据" → ExportWizard 以 database scope（2步）打开
3. 点击"备份数据库" → BackupWizard 打开
4. 右键 Tables 分类节点 → 出现"导出多表"
5. 右键表节点 → ExportWizard 以单表模式（3步）打开，Step3 有文件名输入框

- [ ] **Step 13: Commit**

```bash
git add src/components/Explorer/ContextMenu.tsx src/components/Explorer/DBTree.tsx
git commit -m "feat(ui): wire export/backup entries in ContextMenu and DBTree"
```

---

## 收尾

- [ ] **完整 TypeScript 检查**

```bash
npx tsc --noEmit
```

- [ ] **完整 Rust 编译**

```bash
cd src-tauri && cargo check
```

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "feat: complete export/backup enhancement - filename input, dynamic steps, database export, backup wizard"
```
