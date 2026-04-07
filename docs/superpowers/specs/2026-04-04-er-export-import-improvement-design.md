# ER 设计器导出/导入改进设计

## 概述

改进 ER 设计器的导出/导入功能，解决 6 个问题：导出缺少颜色、图标不一致、右键导出未保存文件、导入只能新建项目、同名表冲突处理、项目名唯一性。

## 问题清单

| # | 问题 | 现状 |
|---|------|------|
| 1 | 导出不包含表颜色 | `ExportTable` 缺少 `color` 字段 |
| 2 | 图标不一致 | 工具栏导出用 `Upload`，右键菜单导出用 `Download` |
| 3 | 右键菜单导出未保存文件 | 只复制到剪贴板，无明显反馈 |
| 4 | 导入只能新建项目 | 无法导入到当前已有项目 |
| 5 | 非空白项目导入无同名表处理 | 无冲突检测 |
| 6 | 项目名可重复 | 无唯一性校验 |

## 设计方案

采用**后端集中处理方案**：冲突检测和处理逻辑集中在后端，前端负责展示和收集用户决策。

---

### 一、导出改进

#### 1.1 导出格式加入颜色

`ExportTable`（`src-tauri/src/er/export.rs`）新增字段：

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub color: Option<String>,
```

- 导出时从 `er_tables.color` 读取并写入 JSON
- 导入时还原到 `er_tables.color`
- JSON 版本号保持 `1.0`（向后兼容：旧文件无 `color` 字段时导入为 `None`）

#### 1.2 图标统一

所有位置统一语义：

- `Download`（↓）= 导出（下载文件）
- `Upload`（↑）= 导入（上传文件）

修改点：

- `ERToolbar.tsx`：导出按钮从 `Upload` 改为 `Download`，导入按钮从 `Download` 改为 `Upload`
- `ProjectContextMenu.tsx`：导出按钮保持 `Download`（已符合）

#### 1.3 右键菜单导出改为保存文件

`ProjectContextMenu.tsx` 的 `handleExport`：从"复制到剪贴板"改为弹出系统文件保存对话框，行为与工具栏导出一致。

---

### 二、导入改进

#### 2.1 新增后端命令

**`er_preview_import`** — 预览导入

```rust
#[tauri::command]
async fn er_preview_import(
    state: State<'_, AppState>,
    json: String,
    project_id: Option<i64>,
) -> Result<ImportPreview, AppError>
```

返回：

```rust
pub struct ImportPreview {
    pub project_name: String,         // 最终项目名（可能已加后缀）
    pub table_count: usize,           // 导入文件中的表总数
    pub new_tables: Vec<String>,      // 无冲突的新表名
    pub conflict_tables: Vec<String>, // 与已有项目同名的表
}
```

- `project_id = None`：新建项目模式，无冲突检测，仅返回项目名（含唯一性后缀处理）
- `project_id = Some(id)`：导入到已有项目，比对表名返回冲突列表

**`er_execute_import`** — 执行导入

```rust
#[tauri::command]
async fn er_execute_import(
    state: State<'_, AppState>,
    json: String,
    project_id: Option<i64>,
    conflicts: Vec<ConflictResolution>,
) -> Result<ErProject, AppError>
```

```rust
pub struct ConflictResolution {
    pub table_name: String,
    pub action: ConflictAction,  // Skip, Overwrite, Rename
}

pub enum ConflictAction {
    Skip,
    Overwrite,
    Rename,
}
```

- `project_id = None`：创建新项目并导入所有表
- `project_id = Some(id)`：在已有项目中执行导入
  - `Skip`：跳过该表
  - `Overwrite`：删除已有同名表（含列、索引、关系），用导入数据重新创建
  - `Rename`：表名自动加后缀 `_1`、`_2`...

#### 2.2 前端交互流程

```
用户点导入按钮
  → 弹出文件选择器，选择 .json 文件
  → 弹窗让用户选择：
      ├─ "导入到当前项目"（仅当前有打开的项目时显示）
      └─ "新建项目"
  → 调用 er_preview_import
  → 如果有冲突表：
      → 弹出冲突处理对话框
      → 每个冲突表显示三个选项：跳过 / 覆盖 / 重命名
  → 如果无冲突：直接执行
  → 调用 er_execute_import 完成导入
  → 刷新项目列表
```

#### 2.3 覆盖语义

删除已有同名表及其所有列、索引、关联关系，然后用导入数据重新创建该表。

---

### 三、项目名唯一性

#### 3.1 后端校验

新增辅助方法（在 repository 层）：

```rust
fn check_project_name_exists(name: &str, exclude_id: Option<i64>) -> Result<bool, AppError>
```

所有场景复用：

- **创建项目**：创建前校验，重复则返回错误
- **重命名项目**：校验时排除自身 ID，重复则返回错误
- **导入新建项目**：重复则自动叠加后缀

#### 3.2 后缀叠加逻辑

```
项目名 → 查重 → 不重复 → 直接使用
                → 重复 → 项目名_副本 → 查重 → 不重复 → 使用
                                              → 重复 → 项目名_副本2 → 查重 → ...
```

后端统一处理，前端不关心后缀生成。

#### 3.3 前端配合

- 创建/重命名时，后端返回名称重复错误，前端 toast 提示"项目名称已存在"
- 导入时，`er_preview_import` 返回最终项目名（含后缀），前端展示

---

## 涉及文件

### 后端（src-tauri/src/er/）

| 文件 | 修改内容 |
|------|----------|
| `export.rs` | `ExportTable` 加 `color` 字段 |
| `commands.rs` | 新增 `er_preview_import`、`er_execute_import`；修改 `er_create_project`、`er_rename_project` 加唯一性校验 |
| `repository.rs` | 新增 `check_project_name_exists`；修改导入相关数据库操作 |

### 前端（src/）

| 文件 | 修改内容 |
|------|----------|
| `components/ERDesigner/ERCanvas/ERToolbar.tsx` | 图标互换（导出→Download，导入→Upload） |
| `components/ERDesigner/ERSidebar/ProjectContextMenu.tsx` | 导出改为文件保存对话框 |
| `store/erDesignerStore.ts` | 重写 `importJson`，新增预览+执行两步流程 |
| `types/index.ts` | 新增 `ImportPreview`、`ConflictResolution` 类型 |
| 新文件：冲突处理对话框组件 | 展示冲突表列表及操作选项 |

### 注册

- `src-tauri/src/lib.rs`：`generate_handler![]` 中注册新命令
