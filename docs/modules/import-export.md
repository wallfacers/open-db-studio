# 数据导入导出

> **模块类型**：核心功能
> **首次发布**：V1
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

数据导入导出模块提供向导式数据迁移能力，支持 CSV、JSON、Excel 格式导入，支持 CSV、JSON、SQL Dump 格式导出。提供字段自动映射、预览确认、Task 进度跟踪等功能。

### 快速入门

**1. 导入数据**
- 右键目标表 → 「导入数据」
- 选择 CSV/JSON/Excel 文件
- 预览数据并确认字段映射
- 执行导入，在 TaskCenter 查看进度

**2. 导出数据**
- 右键目标表 → 「导出数据」
- 选择导出格式（CSV/JSON/SQL Dump）
- 可选：添加 WHERE 条件筛选
- 下载导出文件

**3. 查看任务进度**
- 点击 ActivityBar 底部「Tasks」入口
- 查看导入导出任务状态
- 下载已完成任务的导出文件

### 操作说明

**导入向导**

*Step 1: 选择文件*
- 支持格式：CSV、JSON、Excel (.xlsx/.xls)
- 文件大小限制：100MB（可配置）
- 编码自动检测（UTF-8/GBK 等）

*Step 2: 预览数据*
- 显示前 100 行数据预览
- 自动检测列类型（字符串、数字、日期）
- 显示数据质量提示（空值、格式异常）

*Step 3: 字段映射*
- 自动匹配：按列名相似度自动映射
- 手动调整：拖拽调整映射关系
- 忽略列：不导入的列标记为忽略
- 类型转换：配置目标字段数据类型

*Step 4: 执行导入*
- 选择导入模式：追加 / 替换
- 显示预估时间和行数
- 提交后台执行
- TaskCenter 实时查看进度

**导出功能**
- 全表导出：导出整张表数据
- 条件导出：添加 WHERE 子句筛选
- 格式选择：
  - CSV：带表头，逗号分隔
  - JSON：对象数组格式
  - SQL Dump：INSERT 语句

**TaskCenter 任务中心**
- 任务列表：显示所有导入导出任务
- 状态展示：排队中 / 进行中 / 已完成 / 失败
- 进度条：实时显示处理进度
- 操作：下载结果、查看日志、重试失败任务

### 常见问题

**Q: 导入编码乱码？**
A: 导入向导会自动检测编码，如检测失败可手动选择 UTF-8 或 GBK。

**Q: 日期格式解析失败？**
A: 在字段映射步骤指定日期格式，如 `yyyy-MM-dd HH:mm:ss`。

**Q: 大文件导入超时？**
A: 大文件采用后台分批导入，可在 TaskCenter 查看进度，无需等待。

---

## 开发者指南

### 架构设计

导入导出模块架构：
- **前端向导**：ImportWizard 组件，4 步流程
- **预览引擎**：文件解析、类型检测、数据采样
- **字段映射**：FieldMapper 组件，自动匹配 + 手动调整
- **任务系统**：task_records 表 + Tauri Event 进度广播

### 数据流

```
文件选择 → 预览解析 → 字段映射 → 提交任务 → 后台导入 → Event 进度 → UI 更新
```

### API 接口

**导入功能**
- `preview_import_file(file_path: String, format: ImportFormat) -> Result<PreviewResult, Error>`
  - 返回：列定义数组 + 前 100 行数据
- `import_to_table(connection_id: i64, table_name: String, file_path: String, mapping: FieldMapping) -> Result<Task, Error>`
  - 提交导入任务，返回任务 ID
- `run_import(task_id: String) -> Result<(), Error>`
  - 后台执行导入（内部调用）

**导出功能**
- `export_query_result(connection_id: i64, sql: String, format: ExportFormat) -> Result<Task, Error>`
  - 导出 SQL 查询结果
- `export_table(connection_id: i64, table_name: String, format: ExportFormat, where_clause: Option<String>) -> Result<Task, Error>`
  - 导出整张表或带条件筛选

**任务管理**
- `list_tasks() -> Result<Vec<TaskRecord>, Error>`
- `get_task_status(task_id: String) -> Result<TaskStatus, Error>`
- `download_export_result(task_id: String) -> Result<FilePath, Error>`
- `cancel_task(task_id: String) -> Result<(), Error>`

### Tauri Event

进度广播事件：
```rust
// 进度更新
app.emit("task:progress", TaskProgress {
    task_id: String,
    processed_rows: u64,
    total_rows: u64,
    percentage: u8,
});

// 任务完成
app.emit("task:completed", TaskCompleted {
    task_id: String,
    download_url: Option<String>,
});

// 任务失败
app.emit("task:failed", TaskFailed {
    task_id: String,
    error_message: String,
});
```

### 扩展方式

**添加新导入格式**
1. 在 `src-tauri/src/import_export/parsers/` 创建新解析器
2. 实现 `FileParser` trait
3. 在导入向导中注册新格式

**添加新导出格式**
1. 在 `src-tauri/src/import_export/exporters/` 创建新导出器
2. 实现 `Exporter` trait
3. 在导出对话框中注册新格式

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-13-import-export-task-center-design.md](./2026-03-13-import-export-task-center-design.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ImportExport/` | 导入导出组件 |
| `src/components/ImportWizard/` | 导入向导组件 |
| `src/components/TaskCenter/` | 任务中心组件 |
| `src-tauri/src/import_export/` | Rust 导入导出模块 |
| `src-tauri/src/import_export/parsers/` | 文件解析器 |
| `src-tauri/src/import_export/exporters/` | 导出器 |
| `src-tauri/src/task/` | 任务管理模块 |
| `schema/init.sql` | task_records 表结构 |
