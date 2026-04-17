# ER 设计器

> **模块类型**：可视化工具
> **首次发布**：V1
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

ER 设计器提供可视化数据库设计能力，支持拖拽创建表结构、建立关系连线、DDL 预览和多方言导出。可与现有数据库双向同步，对比差异并生成同步脚本。

### 快速入门

**1. 创建 ER 项目**
- 切换到 ER 模式（ActivityBar 🏗️ 图标）
- 点击「新建项目」输入项目名称
- 选择绑定的数据库连接

**2. 导入现有表**
- 右键项目 → 「从数据库导入」
- 选择要导入的表
- 自动生成表节点和关系连线

**3. 设计表结构**
- 拖拽添加表节点
- 双击表编辑字段（名称、类型、约束）
- 拖拽建立外键关系

**4. 生成 DDL**
- 点击「DDL 预览」
- 选择目标方言（MySQL/PostgreSQL/Oracle/MSSQL/SQLite）
- 复制或执行 DDL

### 操作说明

**项目管理**
- 新建项目：输入名称、选择数据库连接
- 多项目 Tab：同时打开多个项目，独立编辑
- 删除项目：右键项目 → 删除（可选保留数据库表）

**表设计**
- 添加表：拖拽表节点到画布
- 编辑表：双击打开表设计面板
- 添加字段：表内点击「添加字段」
- 字段属性：名称、数据类型、长度、是否为空、默认值、注释
- 主键设置：勾选 PK 标记

**关系建立**
- 创建关系：从子表字段拖拽到父表主键
- 关系属性：外键名、更新/删除规则
- 删除关系：选中连线按 Delete 或右键删除

**DDL 操作**
- 预览 DDL：查看当前设计的 CREATE TABLE 语句
- 多方言支持：MySQL、PostgreSQL、Oracle、MSSQL、SQLite
- 执行 DDL：一键在绑定数据库执行
- 导出 DDL：复制到剪贴板或保存为文件

**数据库同步**
- Diff 对比：设计与数据库实际结构对比
- 同步方向：设计 → 数据库、数据库 → 设计
- 生成脚本：根据 Diff 生成 ALTER 语句

### 常见问题

**Q: 导入表后关系没有自动建立？**
A: 确保数据库已定义外键约束，部分遗留数据库可能无外键定义。

**Q: DDL 方言转换不准确？**
A: 复杂类型可能存在方言差异，建议预览后手动调整。

**Q: 画布上表太多难以管理？**
A: 使用搜索过滤、缩放画布、或分多个项目管理。

---

## 开发者指南

### 架构设计

ER 设计器采用 ReactFlow 架构：
- **数据层**：Zustand store 管理节点/边状态
- **视图层**：ReactFlow 渲染画布、节点、边
- **同步层**：单向数据流 store → ReactFlow
- **引擎层**：DDL 生成器、Diff 引擎

### 数据流

```
用户操作 → Zustand Store → ReactFlow 渲染 → 画布展示
                ↓
         持久化到 er_* 表 ←→ 数据库 Schema 同步
```

### 数据表结构

**er_projects**
- `id` - 项目 ID
- `name` - 项目名称
- `connection_id` - 绑定的数据库连接
- `created_at/updated_at`

**er_tables**
- `id` - 表 ID
- `project_id` - 所属项目
- `name` - 表名
- `comment` - 表注释
- `position_x/y` - 画布位置

**er_columns**
- `id` - 字段 ID
- `table_id` - 所属表
- `name` - 字段名
- `data_type` - 数据类型
- `length/scale` - 长度/精度
- `nullable` - 是否可空
- `default_value` - 默认值
- `is_primary_key` - 是否主键
- `comment` - 字段注释

**er_relations**
- `id` - 关系 ID
- `project_id` - 所属项目
- `source_table_id` - 源表
- `source_column_id` - 源字段
- `target_table_id` - 目标表
- `target_column_id` - 目标字段
- `on_delete/on_update` - 级联规则

**er_indexes**
- `id` - 索引 ID
- `table_id` - 所属表
- `name` - 索引名
- `columns` - 索引字段 JSON
- `is_unique` - 是否唯一

### API 接口

**项目管理**
- `er_list_projects() -> Result<Vec<ERProject>, Error>`
- `er_create_project(name: String, connection_id: Option<i64>) -> Result<ERProject, Error>`
- `er_delete_project(id: i64) -> Result<(), Error>`

**表操作**
- `er_create_table(project_id: i64, table: TableInput) -> Result<ERTable, Error>`
- `er_update_table(id: i64, table: TableInput) -> Result<ERTable, Error>`
- `er_delete_table(id: i64) -> Result<(), Error>`

**关系操作**
- `er_create_relation(project_id: i64, relation: RelationInput) -> Result<ERRelation, Error>`
- `er_delete_relation(id: i64) -> Result<(), Error>`

**DDL 与同步**
- `er_generate_ddl(project_id: i64, dialect: SqlDialect) -> Result<String, Error>`
- `er_diff_with_database(project_id: i64) -> Result<DiffResult, Error>`
- `er_import_from_database(project_id: i64, table_names: Vec<String>) -> Result<(), Error>`

### 扩展方式

**添加新方言支持**
1. 在 `src-tauri/src/er/dialect/` 创建方言模块
2. 实现类型映射、方言特性差异处理
3. 在 DDL 生成器中注册方言

**自定义节点样式**
修改 `src/components/ERDesigner/nodes/TableNode.tsx`：
- 调整节点外观
- 自定义字段展示样式
- 添加操作按钮

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-25-er-designer-design.md](./2026-03-25-er-designer-design.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ERDesigner/` | ER 设计器组件 |
| `src-tauri/src/er/` | Rust ER 模块 |
| `src-tauri/src/er/ddl.rs` | DDL 生成器 |
| `src-tauri/src/er/diff.rs` | Diff 引擎 |
| `schema/init.sql` | er_* 表结构定义 |
