# ER 导出/导入改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 ER 设计器导出/导入的 6 个问题：导出缺少颜色、图标不一致、右键导出改为保存文件、支持导入到当前项目、同名表冲突处理、项目名唯一性校验。

**Architecture:** 后端集中处理方案 — 新增 `er_preview_import` 和 `er_execute_import` 两个命令实现两步式导入流程。冲突检测在后端完成，前端展示冲突对话框收集用户决策。项目名唯一性在 repository 层统一校验。

**Tech Stack:** Rust (rusqlite, serde, tauri commands) + React (TypeScript, Zustand, lucide-react, @tauri-apps/plugin-dialog)

---

### Task 1: 导出格式加入 color 字段

**Files:**
- Modify: `src-tauri/src/er/export.rs:24-31` (ExportTable struct)
- Modify: `src-tauri/src/er/export.rs:121-148` (export_project table mapping)

- [ ] **Step 1: 修改 ExportTable 结构体，加入 color 字段**

```rust
// src-tauri/src/er/export.rs — ExportTable struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTable {
    pub name: String,
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub position: ExportPosition,
    pub columns: Vec<ExportColumn>,
    pub indexes: Vec<ExportIndex>,
}
```

- [ ] **Step 2: 修改 export_project 中的 ExportTable 构建，填充 color**

在 `export.rs:121` 的 `ExportTable` 构建中加入 `color: t.color.clone(),`：

```rust
ExportTable {
    name: t.name.clone(),
    comment: t.comment.clone(),
    color: t.color.clone(),
    position: ExportPosition {
        x: t.position_x,
        y: t.position_y,
    },
    // ... columns and indexes unchanged
}
```

- [ ] **Step 3: 修改 er_import_json 中的 create_table 调用，使用导入的 color**

在 `commands.rs:606-613` 中，将 `color: None` 改为 `color: export_table.color.clone()`：

```rust
let table = crate::er::repository::create_table(&CreateTableRequest {
    project_id: project.id,
    name: export_table.name.clone(),
    comment: export_table.comment.clone(),
    position_x: Some(export_table.position.x),
    position_y: Some(export_table.position.y),
    color: export_table.color.clone(),
})?;
```

- [ ] **Step 4: 更新现有测试，验证 color 被导出和导入**

在 `export.rs` 的 `test_export_and_reimport` 测试中，给 table 设置 `color: Some("#ff0000".to_string())`，并在导入后断言 color 存在：

```rust
// 在 test_export_and_reimport 的 ErTable 中：
color: Some("#ff0000".to_string()),

// 在断言部分添加：
assert_eq!(imported.project.tables[0].color, Some("#ff0000".to_string()));
```

- [ ] **Step 5: 运行测试验证**

Run: `cd src-tauri && cargo test --lib er::export::tests`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/er/export.rs src-tauri/src/er/commands.rs
git commit -m "feat(er): include table color in export/import JSON format"
```

---

### Task 2: 统一导出/导入图标

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/ERToolbar.tsx:246-262`

- [ ] **Step 1: 互换工具栏导出/导入按钮图标**

在 `ERToolbar.tsx` 中，导出按钮（`handleExportJson`）的图标从 `Upload` 改为 `Download`，导入按钮（`handleImportJson`）的图标从 `Download` 改为 `Upload`：

```tsx
{/* 导入/导出组 */}
<button
  onClick={handleExportJson}
  className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
  title={t('erDesigner.exportJson')}
>
  <Download size={14} />
  <span>{t('erDesigner.exportJson')}</span>
</button>

<button
  onClick={handleImportJson}
  className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
  title={t('erDesigner.importJson')}
>
  <Upload size={14} />
  <span>{t('erDesigner.importJson')}</span>
</button>
```

- [ ] **Step 2: 验证 ProjectContextMenu 导出图标已是 Download（无需修改）**

检查 `ProjectContextMenu.tsx:166`：`{ icon: Download, label: ... }` — 已经是 `Download`，无需修改。

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/ERToolbar.tsx
git commit -m "fix(er): unify export/import icons (Download=export, Upload=import)"
```

---

### Task 3: 右键菜单导出改为文件保存

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx:1-5` (imports)
- Modify: `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx:123-131` (handleExport)

- [ ] **Step 1: 添加 dialog 和 invoke 的导入**

在 `ProjectContextMenu.tsx` 顶部添加：

```tsx
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
```

- [ ] **Step 2: 重写 handleExport 为文件保存**

```tsx
const handleExport = async () => {
  try {
    const json = await exportJson(projectId);
    const defaultFileName = project?.name ? `${project.name}.json` : 'er-project.json';
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    await invoke('write_text_file', { path, content: json });
  } catch (e) {
    console.error('Export failed:', e);
  }
  onClose();
};
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx
git commit -m "fix(er): change sidebar export to save file dialog instead of clipboard"
```

---

### Task 4: 后端项目名唯一性校验

**Files:**
- Modify: `src-tauri/src/er/repository.rs:107-124` (create_project)
- Modify: `src-tauri/src/er/repository.rs:126-175` (update_project)
- Modify: `src-tauri/src/er/models.rs` (add new types)

- [ ] **Step 1: 在 repository.rs 中添加项目名查重方法**

在 `create_project` 函数之前添加：

```rust
/// Check if a project name already exists, optionally excluding a specific project ID.
pub fn project_name_exists(name: &str, exclude_id: Option<i64>) -> AppResult<bool> {
    let conn = crate::db::get().lock().unwrap();
    let count: i64 = match exclude_id {
        Some(eid) => conn.query_row(
            "SELECT COUNT(*) FROM er_projects WHERE name = ?1 AND id != ?2",
            rusqlite::params![name, eid],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM er_projects WHERE name = ?1",
            rusqlite::params![name],
            |r| r.get(0),
        )?,
    };
    Ok(count > 0)
}

/// Generate a unique project name by appending _副本, _副本2, _副本3, etc.
pub fn generate_unique_project_name(base_name: &str) -> AppResult<String> {
    if !project_name_exists(base_name, None)? {
        return Ok(base_name.to_string());
    }
    let candidate = format!("{}_副本", base_name);
    if !project_name_exists(&candidate, None)? {
        return Ok(candidate);
    }
    let mut i = 2;
    loop {
        let candidate = format!("{}_副本{}", base_name, i);
        if !project_name_exists(&candidate, None)? {
            return Ok(candidate);
        }
        i += 1;
        if i > 100 {
            return Err(crate::AppError::Other(
                "Too many duplicate project names".to_string(),
            ));
        }
    }
}
```

- [ ] **Step 2: 在 create_project 中添加唯一性校验**

在 `repository.rs` 的 `create_project` 函数中，在 `conn.execute(...)` 之前添加校验：

```rust
pub fn create_project(req: &CreateProjectRequest) -> AppResult<ErProject> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // Check name uniqueness
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM er_projects WHERE name = ?1",
        rusqlite::params![req.name],
        |r| r.get(0),
    )?;
    if count > 0 {
        return Err(crate::AppError::Other(format!(
            "项目名称 '{}' 已存在",
            req.name
        )));
    }

    conn.execute(
        "INSERT INTO er_projects (name, description, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![req.name, req.description, &now, &now],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_projects WHERE id = ?1", PROJECT_COLS),
        [id],
        row_to_project,
    )?;
    Ok(result)
}
```

- [ ] **Step 3: 在 update_project 中添加名称唯一性校验**

在 `repository.rs` 的 `update_project` 函数中，如果 `req.name` 有值，在执行 UPDATE 之前添加校验：

```rust
pub fn update_project(id: i64, req: &UpdateProjectRequest) -> AppResult<ErProject> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // If renaming, check name uniqueness (exclude self)
    if let Some(ref new_name) = req.name {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM er_projects WHERE name = ?1 AND id != ?2",
            rusqlite::params![new_name, id],
            |r| r.get(0),
        )?;
        if count > 0 {
            return Err(crate::AppError::Other(format!(
                "项目名称 '{}' 已存在",
                new_name
            )));
        }
    }

    // ... rest of existing code unchanged
```

- [ ] **Step 4: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/er/repository.rs
git commit -m "feat(er): enforce project name uniqueness on create and rename"
```

---

### Task 5: 后端 preview 和 execute import 命令

**Files:**
- Modify: `src-tauri/src/er/models.rs` (add ImportPreview, ConflictResolution types)
- Modify: `src-tauri/src/er/commands.rs` (add er_preview_import, er_execute_import)
- Modify: `src-tauri/src/lib.rs:385-386` (register new commands)

- [ ] **Step 1: 在 models.rs 中添加导入相关类型**

在 `models.rs` 末尾添加：

```rust
// ─── Import types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub project_name: String,
    pub table_count: usize,
    pub new_tables: Vec<String>,
    pub conflict_tables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConflictResolution {
    pub table_name: String,
    pub action: ConflictAction,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictAction {
    Skip,
    Overwrite,
    Rename,
}
```

- [ ] **Step 2: 添加 er_preview_import 命令**

在 `commands.rs` 的 `er_import_json` 函数之后添加：

```rust
#[tauri::command]
pub async fn er_preview_import(
    json: String,
    project_id: Option<i64>,
) -> AppResult<ImportPreview> {
    let data = super::export::parse_import(&json)?;

    match project_id {
        None => {
            // New project mode: generate unique name
            let unique_name =
                crate::er::repository::generate_unique_project_name(&data.project.name)?;
            let table_names: Vec<String> =
                data.project.tables.iter().map(|t| t.name.clone()).collect();
            Ok(ImportPreview {
                project_name: unique_name,
                table_count: table_names.len(),
                new_tables: table_names,
                conflict_tables: vec![],
            })
        }
        Some(pid) => {
            // Import into existing project: detect conflicts
            let full = crate::er::repository::get_project_full(pid)?;
            let existing_names: std::collections::HashSet<String> = full
                .tables
                .iter()
                .map(|tf| tf.table.name.clone())
                .collect();

            let mut new_tables = vec![];
            let mut conflict_tables = vec![];
            for et in &data.project.tables {
                if existing_names.contains(&et.name) {
                    conflict_tables.push(et.name.clone());
                } else {
                    new_tables.push(et.name.clone());
                }
            }

            Ok(ImportPreview {
                project_name: full.project.name.clone(),
                table_count: data.project.tables.len(),
                new_tables,
                conflict_tables,
            })
        }
    }
}
```

- [ ] **Step 3: 添加 er_execute_import 命令**

在 `er_preview_import` 之后添加：

```rust
#[tauri::command]
pub async fn er_execute_import(
    json: String,
    project_id: Option<i64>,
    conflicts: Vec<ConflictResolution>,
) -> AppResult<ErProject> {
    let data = super::export::parse_import(&json)?;

    // Build conflict action map: table_name → action
    let conflict_map: std::collections::HashMap<String, &ConflictAction> = conflicts
        .iter()
        .map(|c| (c.table_name.clone(), &c.action))
        .collect();

    // Determine target project
    let project = match project_id {
        None => {
            let unique_name =
                crate::er::repository::generate_unique_project_name(&data.project.name)?;
            crate::er::repository::create_project(&CreateProjectRequest {
                name: unique_name,
                description: data.project.description.clone(),
            })?
        }
        Some(pid) => {
            let full = crate::er::repository::get_project_full(pid)?;
            full.project
        }
    };

    // If importing into existing project, build existing table name → id map
    let existing_tables: std::collections::HashMap<String, i64> = if project_id.is_some() {
        let full = crate::er::repository::get_project_full(project.id)?;
        full.tables
            .iter()
            .map(|tf| (tf.table.name.clone(), tf.table.id))
            .collect()
    } else {
        std::collections::HashMap::new()
    };

    // Track table name → new id, and (table_name, col_name) → col_id for relations
    let mut table_name_to_id: HashMap<String, i64> = HashMap::new();
    let mut column_key_to_id: HashMap<(String, String), i64> = HashMap::new();

    // Pre-populate with existing tables (for relations that reference non-imported tables)
    if project_id.is_some() {
        let full = crate::er::repository::get_project_full(project.id)?;
        for tf in &full.tables {
            table_name_to_id.insert(tf.table.name.clone(), tf.table.id);
            for col in &tf.columns {
                column_key_to_id.insert(
                    (tf.table.name.clone(), col.name.clone()),
                    col.id,
                );
            }
        }
    }

    for export_table in &data.project.tables {
        let is_conflict = existing_tables.contains_key(&export_table.name);

        if is_conflict {
            let action = conflict_map
                .get(&export_table.name)
                .copied()
                .unwrap_or(&ConflictAction::Skip);

            match action {
                ConflictAction::Skip => {
                    // Keep existing table, no changes
                    continue;
                }
                ConflictAction::Overwrite => {
                    // Delete existing table, then create new one
                    let old_id = existing_tables[&export_table.name];
                    crate::er::repository::delete_table(old_id)?;
                    // Remove from tracking maps
                    table_name_to_id.remove(&export_table.name);
                    // Fall through to create
                }
                ConflictAction::Rename => {
                    // Generate a renamed table name with _1, _2, etc.
                    let mut all_names: std::collections::HashSet<String> = existing_tables
                        .keys()
                        .cloned()
                        .collect();
                    // Also include names of tables we've already imported in this batch
                    for name in table_name_to_id.keys() {
                        all_names.insert(name.clone());
                    }
                    let base = &export_table.name;
                    let mut suffix = 1;
                    let renamed = loop {
                        let candidate = format!("{}_{}", base, suffix);
                        if !all_names.contains(&candidate) {
                            break candidate;
                        }
                        suffix += 1;
                    };

                    let table = create_import_table(
                        project.id,
                        &renamed,
                        export_table,
                    )?;
                    table_name_to_id.insert(renamed.clone(), table.id);
                    create_import_columns(
                        table.id,
                        &renamed,
                        export_table,
                        &mut column_key_to_id,
                    )?;
                    create_import_indexes(table.id, export_table)?;
                    continue;
                }
            }
        }

        // Create table (new or after overwrite-delete)
        let table = create_import_table(
            project.id,
            &export_table.name,
            export_table,
        )?;
        table_name_to_id.insert(export_table.name.clone(), table.id);
        create_import_columns(
            table.id,
            &export_table.name,
            export_table,
            &mut column_key_to_id,
        )?;
        create_import_indexes(table.id, export_table)?;
    }

    // Create relations
    for export_rel in &data.project.relations {
        let src_table_id = match table_name_to_id.get(&export_rel.source.table) {
            Some(id) => *id,
            None => continue, // Source table was skipped
        };
        let src_col_id = match column_key_to_id.get(&(
            export_rel.source.table.clone(),
            export_rel.source.column.clone(),
        )) {
            Some(id) => *id,
            None => continue,
        };
        let tgt_table_id = match table_name_to_id.get(&export_rel.target.table) {
            Some(id) => *id,
            None => continue,
        };
        let tgt_col_id = match column_key_to_id.get(&(
            export_rel.target.table.clone(),
            export_rel.target.column.clone(),
        )) {
            Some(id) => *id,
            None => continue,
        };

        crate::er::repository::create_relation(&CreateRelationRequest {
            project_id: project.id,
            name: export_rel.name.clone(),
            source_table_id: src_table_id,
            source_column_id: src_col_id,
            target_table_id: tgt_table_id,
            target_column_id: tgt_col_id,
            relation_type: Some(export_rel.relation_type.clone()),
            on_delete: Some(export_rel.on_delete.clone()),
            on_update: None,
            source: export_rel.source_type.clone(),
            comment_marker: export_rel.comment_marker.clone(),
        })?;
    }

    Ok(project)
}

// ─── Import helpers ─────────────────────────────────────────────────────────

fn create_import_table(
    project_id: i64,
    name: &str,
    export_table: &super::export::ExportTable,
) -> AppResult<ErTable> {
    crate::er::repository::create_table(&CreateTableRequest {
        project_id,
        name: name.to_string(),
        comment: export_table.comment.clone(),
        position_x: Some(export_table.position.x),
        position_y: Some(export_table.position.y),
        color: export_table.color.clone(),
    })
}

fn create_import_columns(
    table_id: i64,
    table_name: &str,
    export_table: &super::export::ExportTable,
    column_key_to_id: &mut HashMap<(String, String), i64>,
) -> AppResult<()> {
    for (i, export_col) in export_table.columns.iter().enumerate() {
        let col = crate::er::repository::create_column(&CreateColumnRequest {
            table_id,
            name: export_col.name.clone(),
            data_type: export_col.data_type.clone(),
            nullable: Some(export_col.nullable),
            default_value: export_col.default_value.clone(),
            is_primary_key: Some(export_col.is_primary_key),
            is_auto_increment: Some(export_col.is_auto_increment),
            comment: export_col.comment.clone(),
            length: None,
            scale: None,
            is_unique: None,
            unsigned: None,
            charset: None,
            collation: None,
            on_update: None,
            enum_values: None,
            sort_order: Some(i as i64),
        })?;
        column_key_to_id.insert(
            (table_name.to_string(), export_col.name.clone()),
            col.id,
        );
    }
    Ok(())
}

fn create_import_indexes(
    table_id: i64,
    export_table: &super::export::ExportTable,
) -> AppResult<()> {
    for export_idx in &export_table.indexes {
        let columns_json =
            serde_json::to_string(&export_idx.columns).unwrap_or_else(|_| "[]".to_string());
        crate::er::repository::create_index(&CreateIndexRequest {
            table_id,
            name: export_idx.name.clone(),
            index_type: Some(export_idx.index_type.clone()),
            columns: columns_json,
        })?;
    }
    Ok(())
}
```

- [ ] **Step 4: 在 lib.rs 中注册新命令**

在 `lib.rs` 的 `generate_handler![]` 中，在 `er::commands::er_import_json,` 之后添加：

```rust
er::commands::er_preview_import,
er::commands::er_execute_import,
```

- [ ] **Step 5: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/er/models.rs src-tauri/src/er/commands.rs src-tauri/src/lib.rs
git commit -m "feat(er): add er_preview_import and er_execute_import backend commands"
```

---

### Task 6: 前端类型定义和 store 改造

**Files:**
- Modify: `src/types/index.ts` (add ImportPreview, ConflictResolution types)
- Modify: `src/store/erDesignerStore.ts` (add previewImport, executeImport methods; update importJson)

- [ ] **Step 1: 在 types/index.ts 中添加导入相关类型**

在文件末尾（或 ER 相关类型区域）添加：

```typescript
// ─── ER Import types ───────────────────────────────────────────────────────

export interface ImportPreview {
  project_name: string;
  table_count: number;
  new_tables: string[];
  conflict_tables: string[];
}

export type ConflictAction = 'skip' | 'overwrite' | 'rename';

export interface ConflictResolution {
  table_name: string;
  action: ConflictAction;
}
```

- [ ] **Step 2: 在 erDesignerStore.ts 中添加 previewImport 和 executeImport 方法**

在 store interface `ErDesignerState` 中，替换现有的 importJson 签名：

```typescript
// Import/Export
exportJson: (projectId: number) => Promise<string>;
importJson: (json: string) => Promise<ErProject>;
previewImport: (json: string, projectId?: number) => Promise<ImportPreview>;
executeImport: (json: string, projectId?: number, conflicts?: ConflictResolution[]) => Promise<ErProject>;
```

在 store 实现中，添加新方法（在 `importJson` 之后）：

```typescript
previewImport: async (json, projectId) => {
  try {
    const preview = await invoke<ImportPreview>('er_preview_import', {
      json,
      projectId: projectId ?? null,
    });
    return preview;
  } catch (e) {
    console.error('Failed to preview import:', e);
    throw e;
  }
},

executeImport: async (json, projectId, conflicts) => {
  try {
    const project = await invoke<ErProject>('er_execute_import', {
      json,
      projectId: projectId ?? null,
      conflicts: conflicts ?? [],
    });
    await get().loadProjects();
    return project;
  } catch (e) {
    console.error('Failed to execute import:', e);
    throw e;
  }
},
```

更新 types import 行，添加 `ImportPreview` 和 `ConflictResolution`：

```typescript
import type {
  ErProject,
  ErProjectFull,
  ErTable,
  ErColumn,
  ErRelation,
  ErIndex,
  DiffResult,
  ImportPreview,
  ConflictResolution,
} from '../types';
```

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts src/store/erDesignerStore.ts
git commit -m "feat(er): add previewImport and executeImport to store and types"
```

---

### Task 7: 前端导入冲突对话框组件

**Files:**
- Create: `src/components/ERDesigner/ImportConflictDialog.tsx`

- [ ] **Step 1: 创建 ImportConflictDialog 组件**

```tsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConflictAction, ConflictResolution } from '../../types';

interface ImportConflictDialogProps {
  open: boolean;
  conflictTables: string[];
  onConfirm: (resolutions: ConflictResolution[]) => void;
  onCancel: () => void;
}

const ACTION_OPTIONS: { value: ConflictAction; labelKey: string }[] = [
  { value: 'skip', labelKey: 'erDesigner.importConflictSkip' },
  { value: 'overwrite', labelKey: 'erDesigner.importConflictOverwrite' },
  { value: 'rename', labelKey: 'erDesigner.importConflictRename' },
];

export const ImportConflictDialog: React.FC<ImportConflictDialogProps> = ({
  open,
  conflictTables,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [actions, setActions] = useState<Record<string, ConflictAction>>(() => {
    const init: Record<string, ConflictAction> = {};
    for (const name of conflictTables) {
      init[name] = 'rename';
    }
    return init;
  });

  // Bulk action: apply same action to all
  const [bulkAction, setBulkAction] = useState<ConflictAction | ''>('');

  if (!open) return null;

  const handleBulkChange = (action: ConflictAction) => {
    setBulkAction(action);
    const next: Record<string, ConflictAction> = {};
    for (const name of conflictTables) {
      next[name] = action;
    }
    setActions(next);
  };

  const handleConfirm = () => {
    const resolutions: ConflictResolution[] = conflictTables.map((name) => ({
      table_name: name,
      action: actions[name] || 'rename',
    }));
    onConfirm(resolutions);
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40">
      <div className="bg-background-base border border-border-default rounded-lg shadow-xl w-[520px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-sm font-medium text-foreground-default">
            {t('erDesigner.importConflictTitle') || '导入冲突处理'}
          </h3>
          <p className="text-xs text-foreground-muted mt-1">
            {t('erDesigner.importConflictDesc') ||
              '以下表名与当前项目已有表重复，请选择处理方式：'}
          </p>
        </div>

        {/* Bulk action */}
        <div className="px-4 py-2 border-b border-border-default flex items-center gap-2">
          <span className="text-xs text-foreground-muted">
            {t('erDesigner.importConflictBulk') || '全部设为：'}
          </span>
          {ACTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleBulkChange(opt.value)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                bulkAction === opt.value
                  ? 'bg-accent text-white border-accent'
                  : 'border-border-default text-foreground-default hover:bg-background-hover'
              }`}
            >
              {t(opt.labelKey) || opt.value}
            </button>
          ))}
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {conflictTables.map((tableName) => (
            <div
              key={tableName}
              className="flex items-center justify-between py-1.5 border-b border-border-default last:border-0"
            >
              <span className="text-xs text-foreground-default font-mono truncate max-w-[200px]">
                {tableName}
              </span>
              <div className="flex items-center gap-1">
                {ACTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setActions((prev) => ({ ...prev, [tableName]: opt.value }));
                      setBulkAction('');
                    }}
                    className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                      actions[tableName] === opt.value
                        ? 'bg-accent text-white border-accent'
                        : 'border-border-default text-foreground-muted hover:bg-background-hover'
                    }`}
                  >
                    {t(opt.labelKey) || opt.value}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border-default flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-foreground-muted hover:bg-background-hover rounded border border-border-default transition-colors"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 text-xs text-white bg-accent hover:bg-accent/90 rounded transition-colors"
          >
            {t('erDesigner.importConfirm') || '确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportConflictDialog;
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ERDesigner/ImportConflictDialog.tsx
git commit -m "feat(er): add ImportConflictDialog component for handling table name conflicts"
```

---

### Task 8: 前端导入流程改造（工具栏 + 右键菜单）

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/ERToolbar.tsx` (rewrite handleImportJson)
- Modify: `src/store/erDesignerStore.ts` (no changes needed if Task 6 done)

- [ ] **Step 1: 改造 ERToolbar 的 handleImportJson 为两步式导入**

在 `ERToolbar.tsx` 中，添加导入状态和冲突对话框。先添加 import：

```tsx
import { useState } from 'react';
// ... existing imports ...
import ImportConflictDialog from '../ImportConflictDialog';
import type { ConflictResolution, ImportPreview } from '../../../types';
```

在组件内部添加状态和处理逻辑。替换现有的 `handleImportJson`：

```tsx
const {
  addTable,
  syncFromDatabase,
  exportJson,
  importJson,
  previewImport,
  executeImport,
  projects,
  activeProjectId,
} = useErDesignerStore();

// Import JSON state
const [importState, setImportState] = useState<{
  json: string;
  preview: ImportPreview;
  targetProjectId?: number;
} | null>(null);

// 导入 JSON — 两步式
const handleImportJson = async () => {
  try {
    const openPath = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!openPath || typeof openPath !== 'string') return;

    const json = await invoke<string>('read_text_file', { path: openPath });

    // Ask user: import into current project or create new?
    const hasCurrentProject = !!projectId;
    let targetProjectId: number | undefined;

    if (hasCurrentProject) {
      // Use confirm dialog to ask
      const importToCurrent = await new Promise<boolean>((resolve) => {
        const confirmed = window.confirm(
          t('erDesigner.importTargetPrompt') ||
            '选择导入方式：\n\n点击"确定"导入到当前项目\n点击"取消"新建项目'
        );
        resolve(confirmed);
      });
      targetProjectId = importToCurrent ? projectId : undefined;
    }

    const preview = await previewImport(json, targetProjectId);

    if (preview.conflict_tables.length > 0) {
      // Show conflict dialog
      setImportState({ json, preview, targetProjectId });
    } else {
      // No conflicts, execute directly
      await executeImport(json, targetProjectId, []);
    }
  } catch (e) {
    console.error('Import JSON failed:', e);
  }
};

const handleImportConfirm = async (resolutions: ConflictResolution[]) => {
  if (!importState) return;
  try {
    await executeImport(importState.json, importState.targetProjectId, resolutions);
  } catch (e) {
    console.error('Import execute failed:', e);
  } finally {
    setImportState(null);
  }
};

const handleImportCancel = () => {
  setImportState(null);
};
```

在 JSX return 的最后（`</div>` 之前）添加冲突对话框：

```tsx
{importState && (
  <ImportConflictDialog
    open={true}
    conflictTables={importState.preview.conflict_tables}
    onConfirm={handleImportConfirm}
    onCancel={handleImportCancel}
  />
)}
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/ERToolbar.tsx
git commit -m "feat(er): implement two-step import flow with conflict handling in toolbar"
```

---

### Task 9: 添加 i18n 翻译键

**Files:**
- Modify: `src/i18n/locales/zh.json` (add import conflict translation keys)
- Modify: `src/i18n/locales/en.json` (add import conflict translation keys)

- [ ] **Step 1: 在 zh.json 的 erDesigner 区域添加翻译**

在 `exportJson` 和 `importJson` 附近添加：

```json
"importTargetPrompt": "选择导入方式：\n\n点击\"确定\"导入到当前项目\n点击\"取消\"新建项目",
"importConflictTitle": "导入冲突处理",
"importConflictDesc": "以下表名与当前项目已有表重复，请选择处理方式：",
"importConflictBulk": "全部设为：",
"importConflictSkip": "跳过",
"importConflictOverwrite": "覆盖",
"importConflictRename": "重命名",
"importConfirm": "确认导入",
"projectNameExists": "项目名称已存在"
```

- [ ] **Step 2: 在 en.json 的 erDesigner 区域添加翻译**

```json
"importTargetPrompt": "Choose import mode:\n\nClick OK to import into current project\nClick Cancel to create new project",
"importConflictTitle": "Import Conflict Resolution",
"importConflictDesc": "The following tables conflict with existing tables. Choose how to handle each:",
"importConflictBulk": "Set all to:",
"importConflictSkip": "Skip",
"importConflictOverwrite": "Overwrite",
"importConflictRename": "Rename",
"importConfirm": "Confirm Import",
"projectNameExists": "Project name already exists"
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(er): add i18n translations for import conflict dialog"
```

---

### Task 10: 前端项目创建/重命名错误处理

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx:70-76` (handleRenameConfirm)
- Modify: `src/store/erDesignerStore.ts:192-203` (createProject error handling)

- [ ] **Step 1: 在 ProjectContextMenu 重命名时捕获错误并 toast**

修改 `handleRenameConfirm`：

```tsx
const handleRenameConfirm = async () => {
  const trimmed = renameName.trim();
  if (trimmed && trimmed !== project?.name) {
    try {
      await updateProject(projectId, { name: trimmed });
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e?.message || '';
      if (msg.includes('已存在') || msg.includes('already exists')) {
        alert(t('erDesigner.projectNameExists') || '项目名称已存在');
        return; // Don't close menu, let user retry
      }
    }
  }
  onClose();
};
```

- [ ] **Step 2: 在 store 的 updateProject 中让错误向上传播**

当前 `updateProject` 只 console.error 不 throw。修改为 throw 以便 UI 层捕获：

```typescript
updateProject: async (id, updates) => {
  const project = await invoke('er_update_project', { id, req: updates });
  set((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
  }));
},
```

注意：移除 try/catch，让错误传播到调用方。`createProject` 已经是 throw 的，无需修改。

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx src/store/erDesignerStore.ts
git commit -m "fix(er): show error when renaming project to duplicate name"
```

---

### Task 11: 最终验证

- [ ] **Step 1: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 2: 运行 Rust 测试**

Run: `cd src-tauri && cargo test --lib er::`
Expected: All tests pass

- [ ] **Step 3: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit（如有修复）**

Only if previous steps required fixes.
