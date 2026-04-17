# SQL 编辑器

> **模块类型**：核心功能
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

SQL 编辑器是 Open DB Studio 的核心工作区，基于 Monaco Editor 构建，提供专业的 SQL 编辑体验。支持 Schema-aware 自动补全、多结果集 Tab 展示、查询历史、一键格式化等功能，同时集成 AI Ghost Text 内联补全。

### 快速入门

**1. 执行 SQL**
- 在编辑器中输入 SQL 语句
- 按 `F5` 或 `Ctrl+Enter` 执行
- 查看底部结果集 Tab

**2. 使用自动补全**
- 输入表名前几个字母，自动提示表名
- 输入 `.` 后自动提示该表字段
- 按 `Tab` 或 `Enter` 接受补全

**3. 格式化 SQL**
- 选中 SQL 语句
- 按 `Ctrl+Shift+F` 一键格式化

**4. AI Ghost Text 补全**
- 停止输入 600ms 后自动触发
- 灰色提示文字显示建议
- 按 `Tab` 接受，`Esc` 忽略

### 操作说明

**SQL 执行**
- 单条执行：光标位于语句内，按 `F5` 或 `Ctrl+Enter`
- 多条执行：选中多条语句批量执行
- 终止执行：执行中点击「停止」按钮
- 执行结果：SELECT 返回数据表格，DML 返回影响行数

**多结果集 Tab**
- 每个结果集独立 Tab 展示
- 支持切换查看不同结果
- 数据表格支持排序、复制

**Schema-aware 自动补全**
- 表名补全：输入表名前几个字母触发
- 字段补全：表名后输入 `.` 触发字段提示
- 关键字补全：SQL 关键字智能提示
- 函数补全：数据库内置函数提示

**查询历史**
- 自动保存最近 500 条执行记录
- 点击历史记录快速填充到编辑器
- 支持搜索、清空历史

**格式化**
- 支持 SQL 语句美化格式化
- 调整关键字大小写、缩进
- 支持多种 SQL 方言

### 常见问题

**Q: 自动补全不生效？**
A: 确保已建立数据库连接，编辑器已获取当前数据库 Schema 信息。

**Q: 执行大结果集卡顿？**
A: 结果集默认分页加载，超过 1000 行自动分页，可调整分页大小。

**Q: Ghost Text 不触发？**
A: 检查 AI 配置是否正确，确保已启用内联补全功能。

---

## 开发者指南

### 架构设计

SQL 编辑器模块架构：
- **Monaco Editor**: 核心编辑器，提供语法高亮、智能提示
- **补全 Provider**: 自定义 Schema-aware 补全逻辑
- **执行引擎**: 多语句分割、批量执行
- **结果集组件**: 表格展示、分页、导出

### 数据流

```
用户输入 → Monaco Editor → 补全 Provider → 获取 Schema → 返回补全项
SQL 执行 → split_statements → 逐条执行 → 结果集 Tab 展示
```

### API 接口

**SQL 执行**
- `execute_query(connection_id: i64, sql: String) -> Result<QueryResult, Error>`
  - 参数：连接 ID、SQL 语句
  - 返回：列定义数组 + 数据行数组
- `split_statements(sql: String) -> Vec<String>`
  - 输入：多语句 SQL
  - 返回：分割后的单条语句数组

**AI 内联补全**
- `ai_inline_complete(connection_id: i64, sql: String, cursor_line: u32, cursor_column: u32) -> Result<InlineCompletion, Error>`
  - 参数：连接 ID、当前 SQL、光标位置
  - 返回：补全建议文本

**查询历史**
- `save_query_history(connection_id: i64, sql: String, execution_time_ms: u64) -> Result<(), Error>`
- `list_query_history(connection_id: i64, limit: u32) -> Result<Vec<QueryHistoryItem>, Error>`
- `clear_query_history(connection_id: i64) -> Result<(), Error>`

### 扩展方式

**添加新方言支持**
1. 在 Monaco 配置中添加新 SQL 方言
2. 实现方言特定的关键字、函数列表
3. 配置格式化规则

**自定义补全逻辑**
修改 `src/components/MainContent/MonacoEditor.tsx`：
- 注册自定义 CompletionProvider
- 实现 Schema 信息获取
- 构建补全项列表

### 相关文档

- 设计文档：无独立设计文档
- 前端规范：[docs/FRONTEND.md](../../FRONTEND.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/MainContent/` | 主内容区组件（含编辑器）|
| `src/components/QueryHistory/` | 查询历史组件 |
| `src-tauri/src/commands.rs` | execute_query、ai_inline_complete 命令 |
| `src-tauri/src/db/` | 查询历史表操作 |
| `schema/init.sql` | query_history 表结构定义 |
