# README 与模块文档体系重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 README.md 新增模块导航章节，创建 8 个模块文档建立分层文档体系

**Architecture:** 简化 README 核心内容 + 新增模块导航表格，每个模块文档包含「用户指南」+「开发者指南」双层结构

**Tech Stack:** Markdown

---

## 文件结构

| 文件路径 | 变更类型 | 说明 |
|---------|---------|------|
| `README.md` | 重写 | 新增模块导航章节，精简其他章节 |
| `docs/modules/connection-management.md` | 新增 | 连接管理模块分层文档 |
| `docs/modules/sql-editor.md` | 新增 | SQL 编辑器模块分层文档 |
| `docs/modules/ai-assistant.md` | 新增 | AI 助手模块分层文档 |
| `docs/modules/er-designer.md` | 新增 | ER 设计器模块分层文档 |
| `docs/modules/knowledge-graph.md` | 新增 | 知识图谱模块分层文档 |
| `docs/modules/metrics.md` | 新增 | 业务指标层模块分层文档 |
| `docs/modules/import-export.md` | 新增 | 数据导入导出模块分层文档 |
| `docs/modules/activity-bar.md` | 新增 | ActivityBar 导航模块分层文档 |

---

## Task 1: 重写 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 重写 README.md 主体结构**

将 README.md 重写为以下结构：

```markdown
<div align="center">

# 🗄️ Open DB Studio

**本地优先的 AI 数据库 IDE**

_连接数据源 · 自然语言转 SQL · 执行查询 · 可视化结果 · 全程本地运行_

[![License](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue)]()
[![Rust](https://img.shields.io/badge/Rust-stable-orange)]()
[![React](https://img.shields.io/badge/React-18-61dafb)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)]()

![Open DB Studio 效果图](效果图.png)

</div>

---

## ✨ 核心亮点

- 🤖 **AI Agent 驱动** — 自然语言转 SQL、AI 建表、SQL 优化、错误自动诊断
- 🔌 **多数据源支持** — MySQL、PostgreSQL、Oracle、SQL Server、SQLite 等 8 种数据库
- 🔒 **本地优先 & 安全** — 所有数据留在本地，密码 AES-256-GCM 加密，API Key 永不暴露前端
- 📊 **内联图表渲染** — AI 回答中直接生成 ECharts 交互图表，数据即时可视化
- 🧠 **GraphRAG 知识图谱** — Schema 实体图 + JOIN 路径自动推断，让 AI 真正理解数据库结构
- 🌊 **流式思考模型** — 支持 DeepSeek-R1 等推理模型，流式输出思考过程
- 📝 **专业 SQL 编辑器** — Monaco 编辑器、Schema-aware 自动补全、一键格式化、多结果集 Tab
- 🚀 **开箱即用** — 基于 Tauri 2.x，跨平台桌面应用，无需额外服务

---

## 🔌 数据库支持

| 数据库 | 版本 | 状态 |
|--------|------|------|
| MySQL | 5.7 / 8.x | ✅ 完整支持 |
| PostgreSQL | 12+ | ✅ 完整支持 |
| Oracle | 11g+ | ✅ 支持 |
| SQL Server | 2017+ | ✅ 支持 |
| SQLite | 3.x | ✅ 支持 |
| Apache Doris | 1.2+ | ✅ 支持 |
| ClickHouse | 22+ | ✅ 支持 |
| TiDB | 6.0+ | ✅ 支持 |

> 完整兼容性矩阵见 [docs/database-compatibility.md](./docs/database-compatibility.md)

---

## 🚀 快速开始

### 环境要求
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) stable

### 安装运行

```bash
# 克隆仓库
git clone https://github.com/your-org/open-db-studio.git
cd open-db-studio

# 安装依赖
npm install

# 开发模式
npm run tauri:dev

# 生产构建
npm run tauri:build
```

### AI 配置
启动后进入 **设置 → AI 模型配置**，添加 OpenAI 兼容接口（OpenAI、DeepSeek、Qwen 等）。

---

## 📚 模块导航

| 模块 | 功能简介 | 文档 |
|------|---------|------|
| 🔌 [连接管理](./docs/modules/connection-management.md) | 多数据源连接、分组管理、SSL/TLS、连接池缓存 | [详细文档](./docs/modules/connection-management.md) |
| 📝 [SQL 编辑器](./docs/modules/sql-editor.md) | Monaco 编辑器、多结果集 Tab、Schema 补全、格式化、Ghost Text | [详细文档](./docs/modules/sql-editor.md) |
| 🤖 [AI 助手](./docs/modules/ai-assistant.md) | Text-to-SQL、AI 建表、错误诊断、多会话、流式思考模型、Slash 命令 | [详细文档](./docs/modules/ai-assistant.md) |
| 🏗️ [ER 设计器](./docs/modules/er-designer.md) | 可视化建表、关系连线、DDL 预览、双向同步、多项目管理 | [详细文档](./docs/modules/er-designer.md) |
| 🧠 [知识图谱](./docs/modules/knowledge-graph.md) | Schema 实体图、JOIN 路径推断、Palantir Link Node 风格 | [详细文档](./docs/modules/knowledge-graph.md) |
| 📊 [业务指标层](./docs/modules/metrics.md) | 指标定义、AI 生成草稿、审核确认、指标检索增强 | [详细文档](./docs/modules/metrics.md) |
| 📦 [数据导入导出](./docs/modules/import-export.md) | CSV/JSON/Excel 导入、字段映射、多格式导出、Task 进度跟踪 | [详细文档](./docs/modules/import-export.md) |
| 🧭 [ActivityBar 导航](./docs/modules/activity-bar.md) | VSCode 风格侧边栏、DB/指标/图谱模式切换、设置入口 | [详细文档](./docs/modules/activity-bar.md) |

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript + Vite |
| 状态管理 | Zustand |
| SQL 编辑器 | Monaco Editor |
| 图表 | ECharts |
| Rust 后端 | Tokio + rusqlite |
| AI 接入 | OpenAI 兼容接口（统一代理）|
| Agent 引擎 | OpenCode |

---

## 🗺️ 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| MVP | 连接管理、SQL 执行、基础 AI | ✅ 完成 |
| V1 | 完整 DB 管理、AI 建表/优化/诊断、数据导入导出 | ✅ 完成 |
| V2 | GraphRAG、业务指标层、跨数据源迁移、流式思考模型 | ✅ 完成 |
| V3 | 向量库、插件系统、团队协作 | 🔜 规划中 |

---

## 🙏 致谢

本项目集成了 [OpenCode](https://github.com/sst/opencode) 作为 AI Agent 底座引擎。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

[MIT License](./LICENSE)
```

- [ ] **Step 2: 提交更改**

```bash
git add README.md
git commit -m "docs: rewrite README.md with module navigation section"
```

---

## Task 2: 创建连接管理模块文档

**Files:**
- Create: `docs/modules/connection-management.md`

- [ ] **Step 1: 创建连接管理模块文档**

```markdown
# 连接管理

> **模块类型**：核心功能
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

连接管理是 Open DB Studio 的核心入口模块，提供统一的多数据源连接管理能力。支持 MySQL、PostgreSQL、Oracle、SQL Server、SQLite、ClickHouse、Doris、TiDB 等 8 种数据库，提供连接分组、SSL/TLS 加密、连接池缓存等功能。

### 快速入门

**1. 新建连接**
- 点击左侧 ActivityBar 的 🔌 图标
- 选择数据库驱动类型
- 填写主机、端口、用户名、密码
- 点击「测试连接」验证
- 保存连接

**2. 连接分组**
- 右键点击连接列表空白处 → 「新建分组」
- 拖拽连接到分组中进行归类
- 支持生产环境/测试环境/开发环境等分组策略

**3. SQLite 本地连接**
- 选择 SQLite 驱动类型
- 点击文件选择器选择 `.db` 或 `.sqlite` 文件
- 无需网络配置，直接连接本地文件

### 操作说明

**新建连接流程**
1. 选择驱动类型（MySQL/PostgreSQL/Oracle/SQL Server/SQLite/ClickHouse/Doris/TiDB）
2. 配置连接参数：
   - 主机地址（SQLite 为文件路径）
   - 端口号（各数据库默认端口自动填充）
   - 数据库名
   - 用户名/密码
3. SSL/TLS 配置（可选）：
   - 启用 SSL 连接
   - 配置 CA 证书、客户端证书
4. 点击「测试连接」验证连通性
5. 保存连接配置

**连接分组管理**
- 新建分组：右键菜单 → 「新建分组」
- 编辑分组：右键分组 → 「重命名」/「删除」
- 移动连接：拖拽连接到目标分组

**连接操作**
- 双击连接：建立连接并展开数据库对象树
- 右键连接：编辑、删除、复制连接配置
- 连接状态：实时显示连接/断开状态

### 常见问题

**Q: 连接测试失败如何处理？**
A: 检查主机地址、端口号、防火墙设置，确保数据库服务正常运行。对于云数据库，检查安全组规则是否允许当前 IP 访问。

**Q: 密码如何存储？**
A: 使用 AES-256-GCM 加密存储，密钥派生自设备唯一标识，确保密码安全。

**Q: SQLite 文件权限问题？**
A: 确保应用有读写权限，检查文件是否被其他程序占用。

---

## 开发者指南

### 架构设计

连接管理模块采用分层架构：
- **前端层**：连接列表 UI、连接配置表单、分组管理
- **命令层**：Tauri invoke 命令封装
- **数据源层**：DataSource trait 统一抽象
- **驱动层**：各数据库具体实现

### 数据流

```
用户操作 → React 组件 → Tauri invoke → commands.rs
  → datasource/mod.rs → DataSource trait → 具体驱动实现
```

### API 接口

**连接 CRUD**
- `create_connection(config: ConnectionConfig) -> Result<Connection, Error>`
- `update_connection(id: i64, config: ConnectionConfig) -> Result<Connection, Error>`
- `delete_connection(id: i64) -> Result<(), Error>`
- `list_connections() -> Result<Vec<Connection>, Error>`
- `get_connection(id: i64) -> Result<Connection, Error>`

**连接操作**
- `test_connection(config: ConnectionConfig) -> Result<TestResult, Error>`
- `connect(id: i64) -> Result<ConnectionState, Error>`
- `disconnect(id: i64) -> Result<(), Error>`

**分组管理**
- `create_group(name: String, parent_id: Option<i64>) -> Result<Group, Error>`
- `update_group(id: i64, name: String) -> Result<Group, Error>`
- `delete_group(id: i64) -> Result<(), Error>`
- `list_groups() -> Result<Vec<Group>, Error>`
- `move_to_group(connection_id: i64, group_id: i64) -> Result<(), Error>`

### 扩展方式

**添加新数据库驱动**
1. 在 `src-tauri/src/datasource/` 创建新驱动模块
2. 实现 `DataSource` trait
3. 在 `src-tauri/src/datasource/mod.rs` 注册驱动
4. 前端添加驱动配置表单

**连接池配置**
修改 `src-tauri/src/datasource/pool.rs` 调整：
- 最大连接数
- 连接超时时间
- 空闲连接回收策略

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-12-datasource-unified-pool-design.md](./2026-03-12-datasource-unified-pool-design.md)
- 数据源架构：[docs/design-docs/datasource-arch.md](../../design-docs/datasource-arch.md)
- 安全策略：[docs/SECURITY.md](../../SECURITY.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ConnectionModal/` | 连接配置弹窗组件 |
| `src/components/ConnectionList/` | 连接列表组件 |
| `src/components/ActivityBar/` | ActivityBar 连接入口 |
| `src-tauri/src/datasource/` | Rust 数据源模块 |
| `src-tauri/src/datasource/mod.rs` | DataSource trait 定义 |
| `src-tauri/src/datasource/mysql.rs` | MySQL 驱动实现 |
| `src-tauri/src/datasource/postgres.rs` | PostgreSQL 驱动实现 |
| `src-tauri/src/crypto.rs` | AES-256-GCM 加密实现 |
| `schema/init.sql` | connections 表结构定义 |
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/connection-management.md
git commit -m "docs: add connection-management module documentation"
```

---

## Task 3: 创建 SQL 编辑器模块文档

**Files:**
- Create: `docs/modules/sql-editor.md`

- [ ] **Step 1: 创建 SQL 编辑器模块文档**

```markdown
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
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/sql-editor.md
git commit -m "docs: add sql-editor module documentation"
```

---

## Task 4: 创建 AI 助手模块文档

**Files:**
- Create: `docs/modules/ai-assistant.md`

- [ ] **Step 1: 创建 AI 助手模块文档**

```markdown
# AI 助手

> **模块类型**：AI 能力
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

AI 助手是 Open DB Studio 的智能核心，基于 OpenCode Agent 引擎实现工具驱动的 AI 交互。支持自然语言转 SQL、AI 建表、SQL 解释/优化/错误诊断，提供多会话管理、流式思考模型、Slash 命令等高级功能。

### 快速入门

**1. Text-to-SQL**
- 点击右侧浮动 AI 助手 Tab
- 输入自然语言描述，如「查询最近 30 天的销售数据」
- AI 分析 Schema 后生成 SQL
- 点击「应用到编辑器」使用生成的 SQL

**2. AI 建表**
- 描述表结构，如「创建用户表，包含用户名、邮箱、创建时间」
- AI 生成 CREATE TABLE DDL
- 预览确认后一键执行

**3. 多会话管理**
- 点击会话列表查看历史
- 点击「新建会话」开始新对话
- 切换会话不中断后台流式输出

### 操作说明

**自然语言转 SQL**
1. 在 AI 助手输入框描述需求
2. AI 自动注入当前数据库 Schema 上下文
3. 分析需求并生成精准 SQL
4. 可选操作：应用到编辑器、重新生成、复制

**AI 建表**
1. 描述表结构和字段需求
2. AI 生成带注释的 CREATE TABLE 语句
3. 预览 DDL 确认字段类型
4. 执行建表或修改后重新生成

**SQL 解释/优化/诊断**
- **解释**：选中 SQL → 问 AI「解释这段 SQL」→ 获取执行逻辑说明
- **优化**：选中 SQL → 问 AI「优化这段 SQL」→ 获取索引建议和重写方案
- **诊断**：SQL 报错 → 点击「问 AI」→ 自动注入错误上下文获取修复建议

**多会话管理**
- 历史会话列表按时间倒序展示
- AI 自动生成会话标题（基于首条消息）
- 切换会话保持上下文隔离
- 后台会话继续流式输出

**流式思考模型**
- 支持 DeepSeek-R1、Claude Extended Thinking 等推理模型
- 思考过程以可折叠块展示
- 实时流式输出，无需等待完整响应

**Slash 命令**
- 输入 `/` 触发命令菜单
- 支持快捷命令：
  - `/sql` - 直接生成 SQL
  - `/explain` - 解释 SQL
  - `/optimize` - 优化 SQL
  - `/create` - 建表辅助

**ECharts 内联图表**
- AI 回答中输出 `\`\`\`chart` 代码块
- 自动渲染为交互式 ECharts 图表
- 支持柱状图、折线图、饼图等常见图表

### 常见问题

**Q: AI 生成的 SQL 不准确？**
A: 提供更详细的字段描述，或让 AI 先「查看表结构」获取更完整的 Schema 信息。

**Q: 流式输出卡顿？**
A: 检查网络连接，大模型响应时间较长时属于正常现象。

**Q: 会话标题未生成？**
A: 首条消息发送后 AI 自动生成标题，可在设置中关闭自动标题。

---

## 开发者指南

### 架构设计

AI 助手采用 Agent 架构：
- **OpenCode 引擎**：工具调用、多轮对话管理
- **MCP 工具层**：数据库操作工具封装
- **会话管理**：多会话状态隔离、持久化
- **流式输出**：SSE 流式响应处理

### 数据流

```
用户提问 → Agent 引擎 → Schema 上下文注入 → MCP 工具选择 → 执行工具 → 生成响应
                                  ↓
                           流式输出 ← 会话持久化
```

### API 接口

**AI 对话**
- `ai_chat_stream(session_id: String, messages: Vec<Message>) -> Result<StreamResponse, Error>`
  - 参数：会话 ID、消息列表
  - 返回：SSE 流式响应

**会话管理**
- `create_session(connection_id: Option<i64>) -> Result<Session, Error>`
- `list_sessions() -> Result<Vec<Session>, Error>`
- `delete_session(id: String) -> Result<(), Error>`
- `update_session_title(id: String, title: String) -> Result<Session, Error>`

**AI 配置**
- `save_ai_config(config: AiConfig) -> Result<(), Error>`
- `get_ai_config() -> Result<AiConfig, Error>`
- `test_ai_connection(config: AiConfig) -> Result<TestResult, Error>`

### MCP 工具列表

- `execute_sql(connection_id: i64, sql: String)` - 执行 SQL 获取结果
- `get_schema(connection_id: i64, table_name: Option<String>)` - 获取表结构信息
- `propose_sql_diff(connection_id: i64, description: String)` - 生成 SQL 变更建议
- `explain_sql(connection_id: i64, sql: String)` - 解释 SQL 执行逻辑
- `optimize_sql(connection_id: i64, sql: String)` - 优化 SQL 性能

### 扩展方式

**添加新 MCP 工具**
1. 在 `src-tauri/src/mcp/tools/` 创建新工具实现
2. 实现 Tool trait 的 `name()`、`description()`、`execute()`
3. 在 `src-tauri/src/mcp/mod.rs` 注册工具

**自定义 AI 提示词**
修改 `prompts/` 目录下的模板文件：
- `sql_generation.txt` - SQL 生成提示词
- `table_creation.txt` - 建表提示词
- `sql_explain.txt` - SQL 解释提示词

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-14-multi-session-design.md](./2026-03-14-multi-session-design.md)
- AI 流程：[docs/design-docs/ai-pipeline.md](../../design-docs/ai-pipeline.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/Assistant/` | AI 助手组件 |
| `src/components/AssistantToggleTab/` | 浮动 AI Tab 按钮 |
| `src-tauri/src/agent/` | OpenCode Agent 引擎封装 |
| `src-tauri/src/mcp/` | MCP 工具实现 |
| `src-tauri/src/llm/` | LLM 客户端统一代理 |
| `prompts/` | AI 提示词模板 |
| `schema/init.sql` | agent_sessions 表结构定义 |
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/ai-assistant.md
git commit -m "docs: add ai-assistant module documentation"
```

---

## Task 5: 创建 ER 设计器模块文档

**Files:**
- Create: `docs/modules/er-designer.md`

- [ ] **Step 1: 创建 ER 设计器模块文档**

```markdown
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
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/er-designer.md
git commit -m "docs: add er-designer module documentation"
```

---

## Task 6: 创建知识图谱模块文档

**Files:**
- Create: `docs/modules/knowledge-graph.md`

- [ ] **Step 1: 创建知识图谱模块文档**

```markdown
# 知识图谱

> **模块类型**：AI 能力 / 可视化工具
> **首次发布**：V2
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

知识图谱（GraphRAG）自动将数据库 Schema 构建为实体关系图，采用 Palantir Link Node 设计理念，将外键提升为独立节点展示关联详情。支持 JOIN 路径自动推断、多跳关系探索，为 AI 提供结构化上下文。

### 快速入门

**1. 浏览图谱**
- 切换到图谱模式（ActivityBar 🧠 图标）
- 自动加载当前数据库的 Schema 图谱
- 缩放、拖拽浏览节点关系

**2. 搜索节点**
- 使用顶部搜索框输入关键词
- 匹配表名、别名、描述
- 点击结果定位到节点

**3. 查看 JOIN 路径**
- 选中两个表节点
- 点击「查找路径」
- 查看自动推断的多跳 JOIN 路径

**4. 过滤节点类型**
- 使用过滤器切换：
  - table - 表节点
  - metric - 指标节点
  - alias - 别名节点
  - link - 关联节点

### 操作说明

**图谱浏览**
- 画布操作：拖拽移动、滚轮缩放
- 节点交互：点击查看详情、双击展开关联
- 边交互：悬停查看关系属性

**搜索功能**
- 关键词匹配：表名、别名、描述模糊匹配
- 实时搜索：输入时即时过滤
- 结果导航：点击跳转到节点位置

**JOIN 路径推断**
- 选择起点表：点击选中
- 选择终点表：按住 Ctrl 点击另一表
- 路径展示：高亮显示 JOIN 路径
- 路径详情：显示每跳关联字段

**节点详情面板**
- 表节点：字段列表、索引信息、描述
- Link 节点：关联类型、基数、级联规则
- 别名节点：别名映射、业务含义

**过滤器**
- table：实体表节点
- metric：业务指标节点
- alias：语义别名节点
- link：表间关联节点（外键关系）

### 常见问题

**Q: 图谱加载慢？**
A: 大型数据库 Schema 首次构建可能需要几秒，结果会缓存到内存。

**Q: JOIN 路径找不到？**
A: 确保数据库已定义外键约束，或手动添加关联关系。

**Q: 节点位置错乱？**
A: 使用「重新布局」功能自动优化节点位置。

---

## 开发者指南

### 架构设计

知识图谱采用 Palantir Link Node 设计：
- **图数据层**：graph_nodes / graph_edges 表
- **内存缓存**：GraphCacheStore 缓存节点边
- **路径引擎**：BFS 多跳路径推断
- **MCP 集成**：图谱工具供 AI 调用

### 数据流

```
数据库 Schema → build_schema_graph → graph_nodes/edges 表
                                    ↓
                              GraphCacheStore 内存缓存
                                    ↓
                              图谱可视化 / JOIN 路径推断
```

### 数据表结构

**graph_nodes**
- `id` - 节点 ID
- `connection_id` - 所属连接
- `node_type` - 节点类型（table/column/metric/alias/link）
- `name` - 节点名称
- `properties` - 节点属性 JSON

**graph_edges**
- `id` - 边 ID
- `connection_id` - 所属连接
- `source_id` - 源节点
- `target_id` - 目标节点
- `edge_type` - 边类型（belongs_to/references/alias_of/link_via）
- `properties` - 边属性 JSON

### API 接口

**图谱构建**
- `build_schema_graph(connection_id: i64) -> Result<BuildResult, Error>`
  - 从 information_schema 构建图谱
  - 返回节点数、边数统计

**图谱查询**
- `graph_get_node_list(connection_id: i64, filter: NodeFilter) -> Result<Vec<Node>, Error>`
- `graph_get_node_detail(connection_id: i64, node_id: String) -> Result<NodeDetail, Error>`
- `graph_search_nodes(connection_id: i64, keyword: String) -> Result<Vec<Node>, Error>`

**路径推断**
- `find_join_paths_structured(connection_id: i64, table_a: String, table_b: String) -> Result<Vec<JoinPath>, Error>`
  - BFS 多跳路径搜索
  - 返回完整 JOIN 链条

### MCP 工具

- `graph_get_node_list(connection_id: i64, node_type: Option<String>)` - 获取节点列表
- `graph_get_node_detail(connection_id: i64, node_id: String)` - 获取节点详情
- `graph_search_nodes(connection_id: i64, keyword: String)` - 搜索节点
- `find_join_paths(connection_id: i64, table_a: String, table_b: String)` - 查找 JOIN 路径

### 扩展方式

**自定义节点类型**
1. 扩展 `GraphNodeType` enum
2. 在图谱构建逻辑中添加新类型处理
3. 前端添加节点渲染组件

**路径算法优化**
修改 `src-tauri/src/graph/path.rs`：
- 实现更高效的图遍历算法
- 添加路径评分机制
- 支持带权最短路径

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-20-knowledge-graph-palantir-redesign.md](./2026-03-20-knowledge-graph-palantir-redesign.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/GraphExplorer/` | 图谱浏览器组件 |
| `src-tauri/src/graph/` | Rust 图谱模块 |
| `src-tauri/src/graph/build.rs` | Schema 图谱构建 |
| `src-tauri/src/graph/path.rs` | JOIN 路径推断 |
| `src-tauri/src/graph/cache.rs` | GraphCacheStore |
| `schema/init.sql` | graph_nodes/edges 表结构 |
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/knowledge-graph.md
git commit -m "docs: add knowledge-graph module documentation"
```

---

## Task 7: 创建业务指标层模块文档

**Files:**
- Create: `docs/modules/metrics.md`

- [ ] **Step 1: 创建业务指标层模块文档**

```markdown
# 业务指标层

> **模块类型**：AI 能力
> **首次发布**：V2
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

业务指标层提供语义化指标管理能力，支持定义原子指标和复合指标。AI 可扫描 Schema 自动生成指标草稿，人工审核后入库。提问时自动注入相关指标定义，提升 AI 生成 SQL 的准确性。

### 快速入门

**1. AI 生成指标**
- 切换到指标模式（ActivityBar 📊 图标）
- 点击「AI 生成指标」
- 选择目标表，AI 扫描 Schema 和数据样本
- 生成指标草稿列表

**2. 审核指标**
- 查看草稿指标详情
- 确认无误点击「批准」
- 需要修改点击「拒绝」并说明原因

**3. 使用指标提问**
- 在 AI 助手中提问「查询本月销售额」
- 自动识别并注入相关指标定义
- AI 基于指标定义生成准确 SQL

### 操作说明

**指标定义**
- 原子指标：基于单一表/字段的聚合计算
  - 名称：销售额、用户数等
  - 表/字段：数据来源
  - 聚合：SUM/COUNT/AVG/MAX/MIN
  - 过滤：WHERE 条件
  - 业务含义：指标解释

- 复合指标：基于原子指标的计算
  - 公式：原子指标间的运算
  - 如：客单价 = 销售额 / 订单数

**AI 生成流程**
1. 选择目标数据库和表
2. AI 扫描表结构和数据样本
3. 分析数值型、时间型字段
4. 生成候选指标草稿
5. 人工审核确认入库

**指标树导航**
- 原子指标分组：按业务域分类
- 复合指标分组：展示指标间关系
- 搜索过滤：按名称、表名搜索

**检索增强**
- 提问时自动匹配相关指标
- 注入指标定义到 AI 上下文
- 基于指标生成准确聚合 SQL

### 常见问题

**Q: AI 生成的指标不准确？**
A: 审核时修改业务含义和过滤条件，或拒绝后重新生成。

**Q: 指标如何应用到 SQL？**
A: 提问时使用指标名称（如「查询销售额」），AI 自动引用指标定义。

**Q: 复合指标如何创建？**
A: 先定义原子指标，然后在复合指标中引用并设置计算公式。

---

## 开发者指南

### 架构设计

业务指标层架构：
- **指标定义**：metrics / semantic_aliases 表
- **AI 生成**：Schema 扫描 + 数据采样 + LLM 生成
- **状态流转**：draft → approved/rejected
- **检索增强**：提问时语义匹配注入

### 数据流

```
Schema 扫描 → 数据采样 → LLM 生成 → draft 状态 → 人工审核 → approved
                                              ↓
                                       提问时检索注入
```

### 数据表结构

**metrics**
- `id` - 指标 ID
- `connection_id` - 所属连接
- `name` - 指标名称（唯一）
- `metric_type` - 类型（atomic/composite）
- `table_name` - 来源表
- `column_name` - 来源字段
- `aggregation` - 聚合函数（SUM/COUNT/AVG/MAX/MIN）
- `filter_condition` - 过滤条件 SQL
- `formula` - 复合指标公式
- `description` - 业务含义描述
- `status` - 状态（draft/approved/rejected）
- `created_by` - 创建方式（ai/manual）

**semantic_aliases**
- `id` - 别名 ID
- `connection_id` - 所属连接
- `target_type` - 目标类型（table/column/metric）
- `target_id` - 目标 ID
- `alias` - 别名
- `description` - 描述

### API 接口

**指标 CRUD**
- `metrics_list(connection_id: i64) -> Result<Vec<Metric>, Error>`
- `metrics_create(metric: MetricInput) -> Result<Metric, Error>`
- `metrics_update(id: i64, metric: MetricInput) -> Result<Metric, Error>`
- `metrics_delete(id: i64) -> Result<(), Error>`

**AI 生成**
- `metrics_ai_generate(connection_id: i64, table_names: Vec<String>) -> Result<Vec<MetricDraft>, Error>`
- 扫描指定表生成指标草稿

**审核流程**
- `metrics_approve(id: i64) -> Result<Metric, Error>`
- `metrics_reject(id: i64, reason: String) -> Result<Metric, Error>`

**语义别名**
- `alias_create(alias: AliasInput) -> Result<Alias, Error>`
- `alias_list(target_type: String, target_id: i64) -> Result<Vec<Alias>, Error>`

### 扩展方式

**自定义指标类型**
1. 扩展 `MetricType` enum
2. 在 AI 生成逻辑中添加新类型识别
3. 前端添加类型选择器

**指标检索算法**
修改 `src-tauri/src/metrics/retrieve.rs`：
- 实现语义相似度匹配
- 添加上下文权重计算
- 优化检索结果排序

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-16-metrics-tree-redesign.md](./2026-03-16-metrics-tree-redesign.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/MetricsExplorer/` | 指标浏览器组件 |
| `src-tauri/src/metrics/` | Rust 指标模块 |
| `src-tauri/src/metrics/crud.rs` | 指标 CRUD 操作 |
| `src-tauri/src/metrics/ai_draft.rs` | AI 生成草稿逻辑 |
| `src-tauri/src/metrics/retrieve.rs` | 检索增强逻辑 |
| `schema/init.sql` | metrics/semantic_aliases 表结构 |
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/metrics.md
git commit -m "docs: add metrics module documentation"
```

---

## Task 8: 创建数据导入导出模块文档

**Files:**
- Create: `docs/modules/import-export.md`

- [ ] **Step 1: 创建数据导入导出模块文档**

```markdown
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
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/import-export.md
git commit -m "docs: add import-export module documentation"
```

---

## Task 9: 创建 ActivityBar 导航模块文档

**Files:**
- Create: `docs/modules/activity-bar.md`

- [ ] **Step 1: 创建 ActivityBar 导航模块文档**

```markdown
# ActivityBar 导航

> **模块类型**：核心功能
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

ActivityBar 是 Open DB Studio 的左侧导航栏，采用 VSCode 风格设计。提供数据库模式、指标模式、图谱模式三种工作模式切换，以及任务中心、设置等快捷入口。

### 快速入门

**1. 切换工作模式**
- 点击 ActivityBar 图标切换：
  - 🔌 DB 模式：连接管理、SQL 编辑器
  - 📊 指标模式：业务指标浏览
  - 🧠 图谱模式：知识图谱探索

**2. 打开 AI 助手**
- 点击右侧边缘浮动 Tab
- 或按快捷键 `Ctrl+Shift+A`

**3. 进入设置**
- 点击 ActivityBar 底部 ⚙️ 图标
- 配置 AI 模型、主题、快捷键等

### 操作说明

**模式切换**
- DB 模式（🔌）：
  - 连接列表：查看、管理数据库连接
  - SQL 编辑器：编写、执行 SQL
  - 对象浏览器：展开查看表、视图、索引等

- 指标模式（📊）：
  - 指标树：浏览原子指标和复合指标
  - AI 生成：扫描 Schema 生成指标
  - 审核列表：待审核的指标草稿

- 图谱模式（🧠）：
  - 图谱画布：可视化 Schema 关系
  - 搜索面板：查找表、别名、指标
  - 路径面板：JOIN 路径探索

**底部入口**
- Tasks（任务中心）：查看导入导出任务进度
- Settings（设置）：应用配置

**浮动 AI 助手 Tab**
- 位置：右边缘浮动按钮
- 展开：点击打开 AI 助手面板
- 拖拽：可调整面板位置
- 快捷键：`Ctrl+Shift+A`

**Unified Tab 内容区**
- 三种模式共用右侧内容区
- 多项目以 Tab 形式展示
- 支持拖拽排序、关闭 Tab

### 常见问题

**Q: 模式切换后数据不保留？**
A: 模式切换时当前工作区状态会保存，切换回来可恢复。

**Q: 如何固定 AI 助手面板？**
A: 拖拽面板到侧边可固定，再次拖拽可恢复浮动。

**Q: Tab 太多如何管理？**
A: 右键 Tab 可关闭、关闭其他、关闭右侧等批量操作。

---

## 开发者指南

### 架构设计

ActivityBar 架构：
- **状态管理**：activeActivity 控制当前模式
- **Unified Tab**：多模式共用 Tab 内容区
- **Zustand Store**：跨组件状态同步
- **浮动面板**：AssistantToggleTab 独立实现

### 数据流

```
点击 ActivityBar → setActiveActivity → 切换侧边栏内容 → Unified Tab 展示对应内容
```

### 状态结构

**activeActivity**
```typescript
type Activity = 'connection' | 'metrics' | 'graph';
const activeActivity: Activity = 'connection'; // 当前激活模式
```

**unified_tabs_state**
```typescript
interface UnifiedTabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

interface Tab {
  id: string;
  type: 'connection' | 'metrics' | 'graph' | 'sql' | 'er';
  title: string;
  data: any;
}
```

### 组件结构

**ActivityBar**
```
ActivityBar/
├── ActivityBar.tsx          # 主容器
├── ActivityButton.tsx       # 模式切换按钮
├── ConnectionPanel.tsx      # DB 模式侧边栏
├── MetricsPanel.tsx         # 指标模式侧边栏
├── GraphPanel.tsx           # 图谱模式侧边栏
└── BottomActions.tsx        # 底部入口（Tasks/Settings）
```

**AssistantToggleTab**
```
AssistantToggleTab/
├── AssistantToggleTab.tsx   # 浮动按钮
├── AssistantPanel.tsx       # AI 助手面板
└── useAssistantPosition.ts  # 位置拖拽逻辑
```

### API 接口

ActivityBar 本身不提供 Tauri 命令，依赖各模块 API。

### 扩展方式

**添加新模式**
1. 扩展 `Activity` 类型
2. 创建新 Panel 组件
3. 在 ActivityBar 注册新按钮
4. 更新 Unified Tab 处理逻辑

**自定义 ActivityBar 样式**
修改 `src/components/ActivityBar/ActivityBar.tsx`：
- 调整图标大小、间距
- 自定义激活态样式
- 添加徽章（未读消息数等）

### 相关文档

- 设计文档：无独立设计文档
- 前端规范：[docs/FRONTEND.md](../../FRONTEND.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ActivityBar/` | ActivityBar 组件 |
| `src/components/AssistantToggleTab/` | 浮动 AI Tab |
| `src/App.tsx` | activeActivity + unified_tabs_state |
| `src/store/appStore.ts` | Zustand 状态管理 |
```

- [ ] **Step 2: 提交更改**

```bash
git add docs/modules/activity-bar.md
git commit -m "docs: add activity-bar module documentation"
```

---

## Task 10: 更新计划文档状态

**Files:**
- Modify: `docs/superpowers/specs/2026-04-07-readme-modules-docs-redesign.md`

- [ ] **Step 1: 更新计划文档状态**

将计划文档头部的 `<!-- STATUS: ✅ 待实现 -->` 改为 `<!-- STATUS: ✅ 已完成 -->`

```markdown
<!-- STATUS: ✅ 已完成 -->
```

- [ ] **Step 2: 最终提交**

```bash
git add docs/superpowers/specs/2026-04-07-readme-modules-docs-redesign.md
git commit -m "docs: mark readme-modules-docs-redesign as completed"
```

---

## 验收标准

- [ ] README.md 包含「模块导航」章节，表格形式展示 8 个模块简介 + 链接
- [ ] `docs/modules/` 目录下存在 8 个模块文档，每个文档包含「用户指南」和「开发者指南」两部分
- [ ] 每个模块文档的「开发者指南」包含相关 Tauri 命令列表、数据表结构、代码目录索引
- [ ] 文档风格统一（模板结构一致）
- [ ] 已有设计文档的模块（ER 设计器、知识图谱、业务指标层）在子文档中正确引用原有设计文档链接
