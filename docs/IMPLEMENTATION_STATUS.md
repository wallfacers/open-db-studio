# Open-DB-Studio 功能实现状态总览

> 本文档记录 docs/plans/ 中设计文档的实现状态
> 最后更新: 2026-03-16

---

## MVP 阶段（当前 → Q2 2026）— 已完成 ✅

| 功能 | 实现文件 | 备注 |
|------|---------|------|
| Tauri 2.x 脚手架初始化 | `src-tauri/` 目录结构 | - |
| Rust 后端骨架 | `src-tauri/src/db/`, `datasource/`, `llm/` | - |
| 内置 SQLite schema（5 张表） | `schema/init.sql` | connections, query_history, saved_queries, llm_configs |
| MySQL + PostgreSQL DataSource | `src-tauri/src/datasource/mysql.rs`, `postgres.rs` | - |
| Oracle DataSource | `src-tauri/src/datasource/oracle.rs`（136行）| 条件编译 feature="oracle-driver"，需 Oracle Instant Client |
| SQL Server DataSource | `src-tauri/src/datasource/sqlserver.rs`（109行）| tiberius，含 TLS + winauth |
| LLM 代理模块 | `src-tauri/src/llm/client.rs` | OpenAI/Anthropic 兼容接口 |
| CLAUDE.md + docs/ 文档体系 | 根目录 + `docs/` | 已建立完整文档结构 |
| 连接管理 UI（新建/编辑/删除/测试） | `ConnectionModal/` | - |
| `execute_query` 命令完整实现 | `commands.rs:39-77` | SELECT + DDL/DML 支持 |
| 密码加密存储 | `src-tauri/src/crypto.rs` | AES-256-GCM |
| Schema 树面板 | `Explorer/DBTree.tsx` | 数据库 → 表 → 列 |
| 查询结果表格展示 | `MainContent/index.tsx` | 分页 + 列排序 |
| 查询历史 | `QueryHistory/index.tsx` | 最近查询列表 |
| 基础 AI 生成 SQL | `commands.rs`（`ai_generate_sql`）| 注入 Schema 上下文 |
| AI SQL 解释 | `commands.rs`（`ai_explain_sql`）| 选中 SQL → 中文解释 |
| LLM 配置多配置列表 | `Settings/LlmSettings.tsx` | CRUD + 默认标记 + 测试状态 |
| 表数据浏览 | `MainContent/TableDataView.tsx` | 分页查看 + 行内编辑 |
| 行操作（UPDATE/DELETE） | `commands.rs`（`update_row`, `delete_row`）| - |
| 数据导出 | `ExportDialog/index.tsx` | CSV/JSON/SQL |
| TableDataView 行操作增强 | `EditableCell.tsx`, `RowContextMenu.tsx`, `usePendingChanges.ts`, `CellEditorModal.tsx` | 内联编辑 + 批量提交 |
| 表右键菜单扩展 | `Explorer/ContextMenu.tsx`, `DdlViewerDialog/`, `TruncateConfirmDialog/` | 查看 DDL + 截断表 + 可视化编辑器 |

### 进行中/待完善 ⚠️

| 功能 | 状态 | 备注 |
|------|------|------|
| SQL 编辑器 Monaco 集成 | ⚠️ 部分实现 | 基础编辑可用，Schema 补全已有，高级错误标红待完善 |

---

## V1 阶段（Q3 2026）— 已完成 ✅

| 功能 | 实现文件 | 备注 |
|------|---------|------|
| 表管理 GUI（建表/改表/删表 + DDL 预览） | `TableManageDialog/index.tsx` | 可视化列编辑器 + ALTER SQL 预览 + 多方言 DDL |
| 表结构可视化编辑器（完整版） | `TableManageDialog/index.tsx` | 列编辑器 + 约束/索引/默认值管理 |
| 索引管理 | `IndexManager/index.tsx` | 创建/删除，唯一索引、复合索引 |
| 视图 / 存储过程 / 函数管理 | `ObjectPanel/index.tsx` | 基础面板 |
| ERD 可视化 | `ERDiagram.tsx` | 外键自动生成 ER 图 + FK 连线 |
| Schema-aware 自动补全 | `MainContent/index.tsx` | Monaco 集成表名/字段提示 |
| 语法高亮 + 错误标红 | Monaco Editor | 多方言支持 |
| 一键格式化 SQL | 内置 Monaco | sql-formatter 集成 |
| 多结果集 Tab | `MainContent/index.tsx` | 多语句各自展示结果 |
| 数据导出（CSV/JSON/SQL Dump） | `ExportDialog/index.tsx` | 含 WHERE 条件部分导出 |
| 数据导入（CSV/JSON/Excel） | `ImportExport/ImportWizard.tsx`, `FieldMapper.tsx` | 4 步向导 + 字段映射 + Task 进度跟踪；命令：`preview_import_file`, `import_to_table`, `run_import` |
| DML 结果报告增强 | `commands.rs`（`QueryResult.row_count`）| insert/update/delete 均返回 row_count，持久化到 query_history |
| AI 建表 | `AiCreateTableDialog/index.tsx` | 自然语言 → DDL → 确认执行 |
| AI SQL 优化 | `commands.rs`（`ai_optimize_sql`）| 执行计划分析 + 索引建议 |
| AI 错误诊断 | `commands.rs`（`ai_diagnose_error`）| 报错 → 原因解释 + 修复方案 |
| AI 多轮对话 | `Assistant/index.tsx` | AI 面板保留上下文 + 持久化历史 |
| AI 模型配置列表 | `Settings/LlmSettings.tsx` | 完整 CRUD + 默认标记 + 持久化测试状态 + AI 面板选择器 |
| 安全修复：api_key 不暴露前端 | `commands.rs`（`list_llm_configs` 遮蔽, `get_llm_config_key`）| 按需获取 |
| 安全修复：DB 密码按需获取 | `commands.rs`（`get_connection_password`）| 编辑弹窗 isDirty 机制防覆盖 |
| ACP + OpenCode 集成 | `src-tauri/src/acp/`, `mcp/` | 真正的工具调用支持，替换自建 Agent Loop |
| 智能错误上下文 | `src/store/appStore.ts`, `src/utils/errorContext.ts`, `src/utils/askAi.ts` | 操作前写入上下文快照；Toast/TaskCenter/查询区"问 AI"按钮 |
| AI 助手全局常驻 Tab | `src/components/AssistantToggleTab/`, `App.tsx` | 右边缘浮动 Tab；拖拽定位；多会话历史 + AI 生成标题 |
| DB 版本缓存 | `commands.rs`（`get_db_version`）, `connectionStore.ts` | 连接后缓存版本号，注入错误上下文 |

---

## docs/plans/ 设计文档清单

### 已完全实现 ✅

| 文档 | 实现日期 | 相关文件 |
|------|---------|---------|
| `2026-03-10-tauri-migration-and-docs-system-design.md` | 2026-03-10 | CLAUDE.md, ARCHITECTURE.md |
| `2026-03-10-tauri-migration-impl-plan.md` | 2026-03-10 | 完整项目骨架 |
| `2026-03-10-feature-roadmap-design.md` | 2026-03-10 | PLANS.md |
| `2026-03-10-mvp-implementation-plan.md` | 2026-03-10 | MVP 核心功能 |
| `2026-03-10-connection-edit-design.md` | 2026-03-10 | ConnectionModal/ |
| `2026-03-10-connection-edit-plan.md` | 2026-03-10 | ConnectionModal/ |
| `2026-03-11-anthropic-api-preset-design.md` | 2026-03-11 | llm/client.rs |
| `2026-03-11-anthropic-api-preset.md` | 2026-03-11 | LLM 配置支持 Anthropic |
| `2026-03-11-navicat-style-db-tree-design.md` | 2026-03-11 | Explorer/DBTree.tsx |
| `2026-03-11-navicat-tree-impl-plan.md` | 2026-03-11 | DBTree.tsx 实现 |
| `2026-03-11-llm-config-list-design.md` | 2026-03-11 | Settings/LlmSettings.tsx |
| `2026-03-11-llm-config-list-impl.md` | 2026-03-11 | LlmSettings.tsx 实现 |
| `2026-03-11-toast-level-colors-design.md` | 2026-03-11 | Toast/index.tsx |
| `2026-03-11-toast-level-colors-impl-plan.md` | 2026-03-11 | Toast 多级别颜色 |
| `2026-03-11-multi-result-smart-grouping-design.md` | 2026-03-11 | MainContent/ 结果分组 |
| `2026-03-11-multi-result-smart-grouping-impl-plan.md` | 2026-03-11 | 结果智能分组实现 |
| `2026-v1-implementation-plan.md` | 2026-03-11 | V1 阶段功能 |
| `2026-03-12-acp-opencode-integration-plan.md` | 2026-03-13 | acp/, mcp/, Agent 工具调用 |
| `docs/superpowers/plans/2026-03-13-smart-error-ai-context.md` | 2026-03-13 | appStore, errorContext, askAi, AssistantToggleTab, 多会话历史 |
| `2026-03-11-table-data-view-row-operations-design.md` | 2026-03-16 | EditableCell, RowContextMenu, usePendingChanges, CellEditorModal |
| `2026-03-11-table-data-view-row-operations-impl.md` | 2026-03-16 | 全部 Tasks 已完成 |
| `2026-03-11-table-context-menu-and-visual-editor-design.md` | 2026-03-16 | Explorer/ContextMenu, DdlViewerDialog, TruncateConfirmDialog |
| `2026-03-11-table-context-menu-and-visual-editor.md` | 2026-03-16 | 全部 7 个 Tasks 已完成 |

### 进行中 🔄

暂无

---

## V2 阶段（Q4 2026）— 已完成 ✅

| 功能 | 实现文件 | 备注 |
|------|---------|------|
| graph/ 模块骨架 | `src-tauri/src/graph/mod.rs` | builder/traversal/query 三子模块 |
| Schema 图构建（information_schema → 节点/边） | `graph/builder.rs` | 表/列/FK → graph_nodes/graph_edges |
| BFS 路径推断（JOIN 路径发现） | `graph/traversal.rs` | BFS 多跳遍历 |
| 图查询接口 | `graph/query.rs` | `search_graph`, `find_relevant_subgraph` |
| metrics/ CRUD | `metrics/crud.rs` | list/save/delete/approve，status 流转 draft→approved |
| AI 生成指标草稿 | `metrics/ai_draft.rs` | 扫描 Schema + 样本 → LLM 生成 |
| Text-to-SQL v2 管道 | `pipeline/` | entity_extract → context_builder → sql_validator |
| migration/ DDL 转换 | `migration/ddl_convert.rs` | 跨方言类型映射表（MySQL/PG/Oracle/MSSQL） |
| migration/ 预检 | `migration/precheck.rs` | type_compat/null_constraint/pk_conflict 三类检查 |
| migration/ 数据泵 | `migration/data_pump.rs` | 分批读写 + Tauri Event `migration:progress` 广播 |
| migration/ 任务管理 | `migration/task_mgr.rs` | 状态机 pending/running/paused/done/failed |
| GraphExplorer 前端 | `src/components/GraphExplorer/index.tsx` | 图谱主面板 |
| MetricsPanel 前端 | `src/components/MetricsPanel/index.tsx` | 指标列表 + draft/approved/rejected 分组 |
| MigrationWizard 前端 | `src/components/MigrationWizard/index.tsx` | 4 步向导：源/目标选择→表映射→预检→实时进度 |
| SQL Explain ACP | `commands.rs`（`ai_explain_sql_acp`）| Channel 流式 + 取消，结果渲染在独立 Tab |
| SQL Optimize ACP | `commands.rs`（`ai_optimize_sql`，重构）| 流式 + 取消，`/mcp/optimize` 独立只读端点 |
| MCP propose_sql_diff | `mcp/mod.rs`（`propose_sql_diff` 工具）| AI 提议 SQL 修改 → Tauri 事件 → DiffPanel 确认 |
| useToolBridge 前端 | `src/hooks/useToolBridge.ts` | 监听 `sql-diff-proposal` 事件，调用 proposeSqlDiff |
| 数据库树任意节点新建查询 | `Explorer/DBTree.tsx`, `App.tsx` | table/view/column 预填 SQL 模板，category 补全上下文 |
| AI 助手浮动按钮 + 会话历史 | `Assistant/index.tsx` | 浮动开关 + AI 生成会话标题 + 历史列表 |
| Smart Error AI Context | `Toast`, `TaskCenter`, 错误区域 | "问 AI" 按钮，i18n 支持 zh/en |
| ActivityBar V2 重构 | `ActivityBar/index.tsx` | 移除废弃入口，添加指标/图谱/迁移，底部改为 tasks/settings |
| 启动恢复已打开连接 | `connectionStore.ts`, `Explorer/index.tsx` | localStorage 持久化，静默恢复上次会话 |

### SQLite Schema 新增 6 张表
`graph_nodes`, `graph_edges`, `metrics`, `semantic_aliases`, `migration_tasks`, `migration_checks`（均已追加至 `schema/init.sql`）

### docs/superpowers/plans/ V2 计划文档
| 文档 | 状态 |
|------|------|
| `2026-03-16-v2-design.md` | ✅ 已实现 |
| `2026-03-16-v2-knowledge-graph-metrics-pipeline.md` | ✅ 已实现 |
| `2026-03-16-v2-migration.md` | ✅ 已实现 |
| `2026-03-16-sql-explain-acp.md` | ✅ 已实现（commit 170c0bb） |
| `2026-03-16-sql-optimize-acp.md` | ✅ 已实现（commit 170c0bb） |
| `2026-03-16-new-query-from-any-node.md` | ✅ 已实现（commit 736d0cc） |
| `2026-03-13-propose-sql-diff-mcp.md` | ✅ 已实现（mcp/mod.rs + useToolBridge.ts） |
| `2026-03-13-conversational-sql-editor.md` | ✅ 已实现（commit 05ecff6） |
| `2026-03-13-smart-error-ai-context.md` | ✅ 已实现（commit f7b4d45） |
| `2026-03-13-import-export-task-center.md` | ✅ 已实现（commit 62a3ae1） |
| `2026-03-13-export-backup-enhancement.md` | ✅ 已实现（commit 62a3ae1） |

---

---

## V2 后期增强（2026-03-17 ~ 2026-03-20）— 已完成 ✅

> 这些功能在 V2 阶段基础上陆续完成，对应 docs/superpowers/plans/ 和 docs/plans/ 中的后期计划文档。

| 功能 | 实现文件 | 对应计划文档 |
|------|---------|------------|
| AI 流式输出 + 思考模型（DeepSeek-R1/Claude Extended Thinking） | `src-tauri/src/agent/stream.rs`, `commands.rs:ai_chat_stream`, `Assistant/ThinkingBlock.tsx` | `docs/plans/2026-03-11-ai-streaming-thinking-impl-plan.md` |
| 多 session 后台流式输出（切换不中断） | `Assistant/index.tsx` + `sessionStore` | `docs/superpowers/plans/2026-03-14-multi-session.md` |
| 业务指标树重构（树形导航 + Tab 编辑器） | `MetricsExplorer/MetricsTree.tsx`, `MetricsSidebar.tsx`, `MetricTab.tsx`, `MetricListPanel.tsx` | `docs/superpowers/plans/2026-03-16-metrics-tree-redesign.md` |
| Unified Tab 内容区（DB 模式/指标模式共用右侧 Tab） | `App.tsx` (`activeActivity` + `unified_tabs_state`)、`queryStore.ts` | `docs/superpowers/plans/2026-03-17-unified-tab.md` |
| ACP Elicitation 结构化 UI（request_permission → 按钮面板） | `Assistant/ElicitationPanel.tsx` | `docs/superpowers/plans/2026-03-17-acp-elicitation.md` |
| AI 建表增强（TableManageDialog 集成 AI 流式建表） | `AiCreateTableDialog/index.tsx`（流式版） | `docs/superpowers/plans/2026-03-17-ai-table-generation.md` |
| Slash 命令菜单（/ 触发快捷命令） | `Assistant/SlashCommandMenu.tsx`, `slashCommands.ts` | `docs/superpowers/specs/2026-03-18-slash-commands-design.md` |
| ECharts chart 代码块（```chart 内联交互图表） | `shared/ChartBlock.tsx`, `shared/MarkdownContent.tsx` | `docs/superpowers/plans/2026-03-19-echarts-chart-block.md` |
| 图表放大弹窗 | `shared/MarkdownContent.tsx` (`CodeExpandModal`) | commit `28ad82e` |
| AI 助手删除/清空确认框 + 代码块放大弹框 | `common/ConfirmDialog.tsx`, `shared/MarkdownContent.tsx` (`CodeExpandModal`) | `docs/superpowers/plans/2026-03-20-ai-assistant-confirm-and-code-expand.md` |
| Auto 模式直接应用 SQL Diff（跳过 DiffPanel，显示 Banner） | `Assistant/AutoApplyBanner.tsx`, `hooks/useToolBridge.ts`, `store/appStore.ts` | `docs/superpowers/plans/2026-03-20-auto-mode-direct-apply.md` |
| Knowledge Graph Palantir Ontology 改造（Link Node + Object Type） | `GraphExplorer/index.tsx`, `graph/builder.rs`, `graph/traversal.rs`, FK→LinkNode | `docs/superpowers/plans/2026-03-20-knowledge-graph-palantir-redesign.md` |
| GraphCacheStore + JoinPath 内存图缓存（BFS 多跳缓存） | `src-tauri/src/graph/cache.rs` | `docs/superpowers/specs/2026-03-20-graph-virtual-relation-design.md` |
| 5 个 graph_* MCP 工具注册（Phase 1） | `src-tauri/src/mcp/mod.rs`（`graph_get_node_list` 等） | `docs/superpowers/specs/2026-03-20-graph-mcp-skill-design.md` |
| find_join_paths_structured + link 节点过滤（规则 1+2） | `src-tauri/src/graph/traversal.rs` | commit `36563e2` |
| 全局连接池缓存（消除树导航重复握手） | `src-tauri/src/datasource/pool.rs` 或 `mod.rs` | commit `bb1e492` |
| SeaTunnel 前端集成（连接配置 + Job 状态展示） | `SeaTunnelExplorer/index.tsx`, `SeaTunnelJobTab/index.tsx` | `docs/superpowers/specs/2026-03-20-seatunnel-design.md` |
| i18n 全量国际化（Assistant/GraphExplorer/MetricsExplorer/SeaTunnel） | `src/i18n/` | commits `7eccf9d`, `0baae87` |

### 废弃/超时计划 ⚠️

| 计划文档 | 状态 | 说明 |
|---------|------|------|
| `docs/plans/2026-03-12-agent-phase2-tool-loop.md` | ⚠️ 部分废弃 | Rust 侧（Tasks 1-5）已实现；前端 Agent Loop 不执行，已由 ACP 接管 |
| `docs/superpowers/plans/2026-03-12-ai-agent-sql-chat.md` | ⚠️ 已超时 | Page Agent 架构已移除，功能由 ACP + propose_sql_diff 实现 |

### docs/superpowers/plans/ 新增已完成文档清单

| 文档 | 状态 |
|------|------|
| `2026-03-14-multi-session.md` | ✅ 已实现 |
| `2026-03-16-metrics-tree-redesign.md` | ✅ 已实现 |
| `2026-03-17-unified-tab.md` | ✅ 已实现 |
| `2026-03-17-acp-elicitation.md` | ✅ 已实现 |
| `2026-03-17-ai-table-generation.md` | ✅ 已实现 |
| `2026-03-19-echarts-chart-block.md` | ✅ 已实现 |
| `2026-03-20-ai-assistant-confirm-and-code-expand.md` | ✅ 已实现 |
| `2026-03-20-auto-mode-direct-apply.md` | ✅ 已实现 |
| `2026-03-20-knowledge-graph-palantir-redesign.md` | ✅ 已实现（commit 6d694db） |

### docs/plans/ 新增已完成文档清单

| 文档 | 状态 |
|------|------|
| `2026-03-11-ai-streaming-thinking-design.md` | ✅ 已实现 |
| `2026-03-11-ai-streaming-thinking-impl-plan.md` | ✅ 已实现 |

---

## 未实现计划（待开始）❌

| 计划文档 | 目标 | 备注 |
|---------|------|------|
| `docs/plans/2026-03-12-sql-editor-ai-ghost-text-*` | Monaco 内联 AI Ghost Text 补全（Tab 接受/Esc 拒绝） | Rust 命令 `ai_inline_complete` 未实现 |

## 已完成（2026-03-20 后补录）✅

| 计划文档 | 目标 | 实现状态 |
|---------|------|---------|
| `docs/superpowers/plans/2026-03-18-llm-config-provider-first.md` | 从 opencode `/config/providers` 动态加载供应商和模型 | `opencode_provider_id`+`config_mode` 已入 DB；`agent_list_providers` 命令已注册；`LlmSettings.tsx` 已动态加载 |
| `docs/superpowers/plans/2026-03-17-ui-state-persistence.md` | UI 状态全量迁移到 SQLite | `get_ui_state` / `set_ui_state` 命令已实现，前端已迁移至 SQLite |

## 已废弃计划 ⚠️

| 计划文档 | 目标 | 废弃原因 |
|---------|------|---------|
| `docs/superpowers/plans/2026-03-12-acp-persistent-session.md` | 复用 opencode-cli 进程消除冷启动 | ACP 协议已整体替换为 Serve 模式；`serve_child` 长驻进程实现同等效果；`ai_chat_acp` 已降为废弃桩 |

---

## 下一步：V3 阶段（2027）

1. **Milvus 向量库集成**（本地 + 独立部署两种模式）
2. **完整 RAG 管道**（向量 + 指标 + GraphRAG 三路融合）
3. **插件系统**（数据源/AI 提供商/导出格式）
4. **团队协作**（SQL 片段共享、指标库导出/导入）
5. **SeaTunnel 外部引擎接入**（基础 UI 已就绪，REST API 提交待实现）

---

## 更新记录

| 日期 | 更新内容 |
|------|---------|
| 2026-03-11 | 创建本文档，整理 MVP 和 V1 实现状态 |
| 2026-03-11 | 添加 insert_row 命令实现状态 |
| 2026-03-14 | 补充智能错误上下文、AI 助手全局 Tab、DB 版本缓存实现状态；标记计划文件完成 |
| 2026-03-16 | 标记 TableDataView 行操作增强、表右键菜单扩展为已完成 |
| 2026-03-16 | 全面代码评估：补录 Oracle/SQL Server 驱动、数据导入、DML 报告、可视化编辑器；MVP + V1 阶段 100% 完成；文档整体重整 |
| 2026-03-16 | V2 阶段全部实现：图谱/指标/迁移/pipeline 模块 + 前端三大面板 + SQL ACP + propose_sql_diff；ActivityBar 重构；启动恢复连接 |
| 2026-03-20 | V2 后期增强全面追踪：AI 流式/思考模型、Palantir 图改造、MCP graph 工具、GraphCacheStore、Unified Tab、ACP Elicitation、Auto 模式、ECharts chart、SeaTunnel 前端、i18n 全量化；标记 4 个未实现计划 |
