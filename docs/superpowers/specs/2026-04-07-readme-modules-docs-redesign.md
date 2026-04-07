<!-- STATUS: ✅ 待实现 -->
# README 与模块文档体系重构设计

**日期**: 2026-04-07
**状态**: 待实现
**范围**: README.md 重写 + `docs/modules/` 新增 8 个模块说明文档

---

## 背景与目标

### 现状问题

1. **README.md 信息过载** — 核心亮点、AI Agent 能力、路线图等内容冗长，缺乏模块导航
2. **模块文档分散** — ER 设计器、知识图谱、业务指标层等核心模块的设计文档散落在 `docs/superpowers/specs/`，用户难以发现
3. **缺少用户导向文档** — 现有设计文档面向开发者，缺少面向用户的功能介绍和操作指南
4. **部分模块无文档** — SQL 编辑器、连接管理、ActivityBar 导航等模块缺少独立文档

### 重构目标

1. **README.md 简化重构** — 新增「模块导航」核心章节，指向 `docs/modules/` 子文档
2. **建立分层文档体系** — 每个模块文档分「用户指南」+「开发者指南」两层
3. **补充缺失模块文档** — 为 8 个核心模块创建完整的说明文档
4. **统一文档风格** — 所有子文档采用一致的模板结构

---

## 不在本次范围

- 跨数据源迁移模块（后续重新设计）
- SeaTunnel 集成模块（后续重新设计）

---

## 第一节：README.md 新结构

### 结构大纲

```markdown
# 🗄️ Open DB Studio

**本地优先的 AI 数据库 IDE** — 一句话定位

---

## ✨ 核心亮点
（精简现有内容，保留 6-8 条核心卖点）

---

## 🔌 数据库支持
（保留矩阵，链接到 database-compatibility.md 详情）

---

## 🚀 快速开始
### 环境要求
### 安装运行
### AI 配置

---

## 📚 模块导航 ← 新增核心章节
（表格形式，8 模块简介 + 链接）

---

## 🛠️ 技术栈
（保留现有表格）

---

## 🗺️ 路线图
（更新状态：MVP/V1/V2 ✅ 完成，V3 规划）

---

## 🙏 致谢
## 🤝 贡献
## 📄 License
```

### 模块导航章节内容

```markdown
## 📚 模块导航

| 模块 | 功能简介 | 文档 |
|------|---------|------|
| 🔌 连接管理 | 多数据源连接、分组管理、SSL/TLS、连接池缓存 | [详细文档](./docs/modules/connection-management.md) |
| 📝 SQL 编辑器 | Monaco 编辑器、多结果集 Tab、Schema 补全、格式化、Ghost Text | [详细文档](./docs/modules/sql-editor.md) |
| 🤖 AI 助手 | Text-to-SQL、AI 建表、错误诊断、多会话、流式思考模型、Slash 命令 | [详细文档](./docs/modules/ai-assistant.md) |
| 🏗️ ER 设计器 | 可视化建表、关系连线、DDL 预览、双向同步、多项目管理 | [详细文档](./docs/modules/er-designer.md) |
| 🧠 知识图谱 | Schema 实体图、JOIN 路径推断、Palantir Link Node 风格 | [详细文档](./docs/modules/knowledge-graph.md) |
| 📊 业务指标层 | 指标定义、AI 生成草稿、审核确认、指标检索增强 | [详细文档](./docs/modules/metrics.md) |
| 📦 数据导入导出 | CSV/JSON/Excel 导入、字段映射、多格式导出、Task 进度跟踪 | [详细文档](./docs/modules/import-export.md) |
| 🧭 ActivityBar 导航 | VSCode 风格侧边栏、DB/指标/图谱模式切换、设置入口 | [详细文档](./docs/modules/activity-bar.md) |
```

---

## 第二节：子文档模板结构

每个 `docs/modules/*.md` 文件采用以下统一模板：

```markdown
# 模块名称

> **模块类型**：核心功能 / AI 能力 / 可视化工具
> **首次发布**：MVP / V1 / V2
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述
（1-2 段话描述模块核心价值和使用场景）

### 快速入门
（2-3 步操作流程，配合截图占位符）

### 操作说明
（按功能点分小节，每节 1-2 段文字说明）

### 常见问题
（3-5 条 FAQ，问答形式）

---

## 开发者指南

### 架构设计
（模块边界、职责划分、与其他模块关系）

### 数据流
（关键流程描述，可用文字或简单 ASCII 图）

### API 接口
（相关 Tauri 命令列表 + 参数/返回值说明）

### 扩展方式
（如何添加新功能、hook 点、配置项）

### 相关文档
（链接到设计文档、ADR、代码目录）

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/Xxx/` | 前端组件目录 |
| `src-tauri/src/xxx/` | Rust 后端模块 |
| `docs/superpowers/specs/xxx-design.md` | 详细设计文档 |
```

---

## 第三节：各模块内容规划

### 1. connection-management.md

**用户指南重点**：
- 新建连接流程（驱动选择、主机/端口/用户名/密码、SSL 配置）
- 连接分组管理（新建分组、拖拽归类）
- 测试连接、编辑/删除
- SQLite 本地文件连接（无需网络）

**开发者指南重点**：
- `connections` 表结构（driver/host/port/database/username/password_encrypted 等字段）
- AES-256-GCM 密码加密/解密流程
- DataSource trait 及各 driver 实现（MySQL/PostgreSQL/Oracle/SQL Server/SQLite/ClickHouse/Doris/TiDB）
- 全局连接池缓存机制

**相关文件**：
- `src/components/ConnectionModal/`
- `src-tauri/src/datasource/`
- `src-tauri/src/crypto.rs`

---

### 2. sql-editor.md

**用户指南重点**：
- SQL 执行流程（F5 / Ctrl+Enter）
- 多结果集 Tab 展示
- Schema-aware 自动补全（表名 → 字段提示）
- 一键格式化（Ctrl+Shift+F）
- 查询历史（最近 500 条）
- Ghost Text AI 补全（停止输入 600ms 触发，Tab 接受）

**开发者指南重点**：
- Monaco Editor 集成（language 配置、自定义补全 provider）
- `execute_query` 命令流程（SELECT 返回数据、DML 返回 row_count）
- 多结果集解析逻辑（`split_statements` + 逐条执行）
- `ai_inline_complete` 命令 + InlineCompletionsProvider
- 查询历史持久化（`query_history` 表）

**相关文件**：
- `src/components/MainContent/`
- `src/components/QueryHistory/`
- `src-tauri/src/commands.rs`（execute_query、ai_inline_complete）

---

### 3. ai-assistant.md

**用户指南重点**：
- 自然语言转 SQL（提问 → AI 分析 Schema → 生成 SQL）
- AI 建表（描述表结构 → DDL → 确认执行）
- SQL 解释/优化/错误诊断
- 多会话管理（历史列表、AI 自动生成标题）
- 流式思考模型（DeepSeek-R1 / Claude Extended Thinking 折叠块）
- Slash 命令菜单（`/` 触发快捷命令）
- ECharts 内联图表（AI 回答中 ` ```chart ` 渲染）

**开发者指南重点**：
- Agent 架构（OpenCode 引擎 + MCP 工具调用）
- MCP 工具列表（`execute_sql`、`get_schema`、`propose_sql_diff` 等）
- 流式输出实现（`ai_chat_stream` 命令 + SSE）
- 多会话后台流式（sessionStore + 切换不中断）
- `agent_sessions` 表持久化
- `askAi.ts` 智能错误上下文注入

**相关文件**：
- `src/components/Assistant/`
- `src-tauri/src/agent/`
- `src-tauri/src/mcp/`
- `docs/superpowers/specs/2026-03-14-multi-session-design.md`

---

### 4. er-designer.md

**用户指南重点**：
- 创建 ER 项目（项目列表、右键新建）
- 导入表（从绑定的数据库导入 Schema）
- 拖拽表节点、新建表/列
- 连线建立关系（外键）
- DDL 预览（多方言：MySQL/PG/Oracle/MSSQL/SQLite）
- Diff 报告（与数据库对比，同步双向）
- 多项目管理（独立 Tab 打开）

**开发者指南重点**：
- ReactFlow 架构（单向数据流：store → ReactFlow nodes/edges）
- `er_*` 5 张表（er_projects、er_tables、er_columns、er_relations、er_indexes）
- `er_*` Tauri 命令列表（er_list_projects、er_create_table、er_generate_ddl、er_diff_with_database 等）
- DDL 多方言引擎（类型映射、方言差异处理）
- Diff 引擎数据结构（DiffResult/TableModDiff）

**相关文件**：
- `src/components/ERDesigner/`
- `src-tauri/src/er/`
- `docs/superpowers/specs/2026-03-25-er-designer-design.md`

---

### 5. knowledge-graph.md

**用户指南重点**：
- 图谱浏览（表节点、Link 节点、关系连线）
- 搜索节点（关键词匹配表名/别名/描述）
- 查看 JOIN 路径（选中两表 → 自动推断关联路径）
- 过滤器切换（table/metric/alias/link 类型）
- 节点详情面板（属性、别名、关联表）

**开发者指南重点**：
- Palantir Link Node 设计（FK 升级为独立节点，携带 cardinality/via/on_delete 等属性）
- `graph_nodes` / `graph_edges` 表结构
- `build_schema_graph` 命令流程（information_schema → 图构建）
- BFS 多跳路径推断（`find_join_paths_structured`）
- GraphCacheStore 内存缓存
- MCP graph 工具（`graph_get_node_list`、`find_join_paths` 等）

**相关文件**：
- `src/components/GraphExplorer/`
- `src-tauri/src/graph/`
- `docs/superpowers/specs/2026-03-20-knowledge-graph-palantir-redesign.md`

---

### 6. metrics.md

**用户指南重点**：
- 指标定义（名称、表/列、聚合函数、过滤条件、业务含义）
- AI 生成指标草稿（扫描 Schema + 数据样本 → LLM 生成）
- 审核确认（draft → approved/rejected 状态流转）
- 指标树导航（原子指标 / 复合指标分组）
- 指标检索增强（提问时自动注入相关指标定义）

**开发者指南重点**：
- `metrics` / `semantic_aliases` 表结构
- `metrics/` Rust 模块（crud.rs、ai_draft.rs）
- 指标状态流转（draft → approved/rejected）
- AI 生成流程（Schema scan → sample → LLM → draft）
- 指标树重构设计（MetricsTree + MetricTab）

**相关文件**：
- `src/components/MetricsExplorer/`
- `src-tauri/src/metrics/`
- `docs/superpowers/specs/2026-03-16-metrics-tree-redesign.md`

---

### 7. import-export.md

**用户指南重点**：
- 导入向导（4 步：选择文件 → 预览数据 → 字段映射 → 执行）
- 支持格式（CSV / JSON / Excel）
- 字段映射（自动匹配 + 手动调整）
- 导出格式（CSV / JSON / SQL Dump）
- 带 WHERE 条件的部分导出
- Task 进度跟踪（TaskCenter 查看进度）

**开发者指南重点**：
- ImportWizard 前端流程
- `preview_import_file` / `import_to_table` / `run_import` 命令
- 字段映射逻辑（FieldMapper 组件）
- 导出命令（`export_query_result`）
- `task_records` 表统一任务管理
- Tauri Event 进度广播

**相关文件**：
- `src/components/ImportExport/`
- `src/components/TaskCenter/`
- `src-tauri/src/import_export/`
- `docs/superpowers/specs/2026-03-13-import-export-task-center-design.md`

---

### 8. activity-bar.md

**用户指南重点**：
- VSCode 风格左侧图标导航
- 模式切换（DB 模式 / 指标模式 / 图谱模式）
- 底部入口（Tasks 任务中心 / Settings 设置）
- 浮动 AI 助手 Tab（右边缘，可拖拽）

**开发者指南重点**：
- ActivityBar 组件结构
- `activeActivity` 状态管理（connection/metrics/graph）
- Unified Tab 内容区（多模式共用右侧 Tab）
- `unified_tabs_state` 状态结构
- AssistantToggleTab 浮动按钮实现

**相关文件**：
- `src/components/ActivityBar/`
- `src/App.tsx`（activeActivity + unified_tabs_state）
- `src/store/appStore.ts`

---

## 第四节：文件变更清单

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

## 第五节：验收标准

1. README.md 包含「模块导航」章节，表格形式展示 8 个模块简介 + 链接
2. `docs/modules/` 目录下存在 8 个模块文档，每个文档包含「用户指南」和「开发者指南」两部分
3. 每个模块文档的「开发者指南」包含相关 Tauri 命令列表、数据表结构、代码目录索引
4. 文档风格统一（模板结构一致）
5. 已有设计文档的模块（ER 设计器、知识图谱、业务指标层）在子文档中正确引用原有设计文档链接