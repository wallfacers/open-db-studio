# PLANS.md — 开发计划与路线图

> 详细设计见 [docs/plans/2026-03-10-feature-roadmap-design.md](./plans/2026-03-10-feature-roadmap-design.md)
>
> 📋 **实现状态总览**: [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) — 已实现/进行中/待实现功能清单

---

## MVP 阶段（当前 → Q2 2026）—— 能用

### 已完成
- [x] Tauri 2.x 脚手架初始化
- [x] Rust 后端骨架（db/、datasource/、llm/）
- [x] 内置 SQLite schema（5 张表）
- [x] MySQL + PostgreSQL DataSource 实现（骨架）
- [x] LLM 代理模块（OpenAI 兼容）
- [x] CLAUDE.md + docs/ 文档记录系统
- [x] 连接管理 UI（新建/编辑/删除/测试连接）
- [x] `execute_query` 命令完整实现（SELECT + DDL/DML）
- [x] 密码加密存储（AES-256-GCM）
- [x] SQL 编辑器与 Rust 后端联调（Monaco Editor + F5 执行）
- [x] Schema 树面板（数据库 → 表 → 列）
- [x] 查询结果表格展示（分页 + 列排序）
- [x] 查询历史（最近 500 条，可搜索重用）
- [x] 基础 AI 生成 SQL（注入 Schema 上下文）
- [x] AI SQL 解释（选中 SQL → 中文解释）
- [x] TableDataView 行操作增强（内联编辑、批量提交）
- [x] 表右键菜单扩展（查看 DDL、截断表、可视化编辑器）


### 进行中
- （无）

### 已完成（补录）
- [x] Oracle 驱动实现（oracle crate，可选 feature，需 Oracle Instant Client）
- [x] SQL Server 驱动实现（tiberius）
- [x] 数据导入（CSV/JSON/Excel 字段映射，ImportWizard 4 步向导）

### 待开始
- （无，MVP 阶段全部完成）

---

## V1 阶段（Q3 2026）—— 好用 — 已完成 ✅

### 完整 DB 管理
- [x] 表管理 GUI（建表/改表/删表 + DDL 预览）
- [x] 数据浏览器（分页查看 + 行内编辑 + 条件过滤）
- [x] 索引管理（创建/删除，唯一索引、复合索引）
- [x] 视图 / 存储过程 / 函数管理（基础面板）
- [x] ERD 可视化（外键自动生成 ER 图，接入真实 Schema + FK 连线）
- [x] 表右键菜单扩展（查看 DDL、截断表）

### SQL 编辑器增强
- [x] Schema-aware 自动补全（表名 → 字段提示，Monaco 集成）
- [x] 语法高亮 + 错误标红（多方言）
- [x] 一键格式化 SQL（sql-formatter 集成）
- [x] 多结果集 Tab（多语句各自展示结果）

### 数据导入导出
- [x] 导出：CSV / JSON / SQL Dump（含导出 UI）
- [x] 导入：CSV / JSON / Excel 字段映射写入（ImportWizard + import_to_table 命令）
- [x] 带 WHERE 条件的部分数据导出

### AI 能力增强
- [x] AI 建表（自然语言 → DDL → 确认执行，建表对话框）
- [x] AI SQL 优化（执行计划分析 + 索引建议，优化面板）
- [x] AI 错误诊断（报错 → 原因解释 + 修复方案，自动诊断）
- [x] 多轮对话式 SQL（AI 面板保留上下文，持久化历史）
- [x] AI 模型配置多配置列表（CRUD + 默认标记 + 持久化测试状态 + AI 面板选择器）
- [x] 安全修复：api_key 不暴露前端（list_llm_configs 遮蔽，get_llm_config_key 按需获取）
- [x] 安全修复：DB 密码按需获取（get_connection_password），编辑弹窗 isDirty 机制防覆盖
- [x] 移除 page-agent，改为工具驱动 Agent 架构（见 docs/plans/2026-03-12-agent-tool-catalog-design.md）
- [x] ACP + OpenCode 集成（用 opencode ACP 协议替换自建 Agent Loop，支持真正的工具调用）
- [x] 智能错误上下文（操作前写入上下文快照；Toast/TaskCenter/查询区"问 AI"一键填入助手）
- [x] AI 助手全局常驻 Tab（右边缘浮动 Tab，多会话历史，AI 自动生成会话标题）

---

## V2 阶段（Q4 2026）—— 专业版 — 已完成 ✅

### GraphRAG 知识图谱引擎
- [x] Schema 实体图构建（表/列/外键 → 图节点和边）
- [x] 关系路径推断（自动发现 JOIN 路径）
- [x] 图谱可视化（GraphExplorer 面板）

### 业务指标层
- [x] 指标定义（名称/字段/聚合函数/业务含义）
- [x] AI 生成指标草稿（扫描 Schema + 数据样本）
- [x] 用户审核确认（编辑/批准/拒绝 → 入库）
- [x] 指标检索增强（提问时注入相关指标定义）

### 高精度 Text-to-SQL 管道
- [x] 指标 + GraphRAG + Schema 融合 Prompt 构建
- [x] SQL 语法校验（生成后自动检查）

### 跨数据源迁移（Rust 原生实现）
- [x] DDL 跨方言转换（类型映射）
- [x] 分批数据迁移（进度展示 + 错误报告）
- [x] 迁移预检（兼容性检查）
- [x] 迁移任务管理（暂停/恢复/重试）

### 其他 V2 特性
- [x] SQL Explain/Optimize ACP（流式 + 取消，结果独立 Tab）
- [x] MCP propose_sql_diff 工具（AI 提议 SQL 修改 → DiffPanel 确认）
- [x] 数据库树任意节点"新建查询"（SQL 模板预填）
- [x] AI 助手浮动按钮 + 会话历史（AI 生成标题）
- [x] ActivityBar V2 重构（移除废弃入口，添加指标/图谱/迁移）
- [x] 启动时恢复上次已打开连接（localStorage 持久化）

---

## V2 后期增强（2026-03-17 ~ 2026-03-20）—— 已完成 ✅

### AI 能力深化
- [x] AI 流式输出 + 思考模型（DeepSeek-R1、Qwen-thinking、Claude Extended Thinking 折叠块）
- [x] 多 session 后台流式输出（切换 session 不中断流）
- [x] ACP Elicitation UI（`request_permission` → 结构化按钮面板）
- [x] Auto 模式直接应用 SQL Diff（跳过 DiffPanel，AutoApplyBanner 闪现）
- [x] AI 建表增强（TableManageDialog 集成 AI 流式填充字段）
- [x] AI 助手删除/清空全局确认框
- [x] Slash 命令菜单（`/` 触发快捷命令面板）

### 图谱引擎升级
- [x] Knowledge Graph Palantir Ontology 改造（FK 升级为独立 Link Node，Object Type 样式）
- [x] GraphCacheStore + JoinPath 内存缓存（BFS 多跳路径缓存）
- [x] 5 个 graph_* MCP 工具注册到 MCP Server（Phase 1）
- [x] find_join_paths_structured + link 节点过滤规则（规则 1+2）
- [x] 图谱虚拟关系层设计（`RelationEdge` 合成边）

### 指标 & 编辑器增强
- [x] 业务指标树重构（树形导航 + 原子/复合指标分类 + Tab 编辑器）
- [x] Unified Tab 内容区（DB 模式与指标模式共用右侧 Tab，切换不重置）
- [x] ECharts chart 代码块（AI 回答内联 ` ```chart ` 渲染交互图表 + 放大弹窗）
- [x] 代码块放大弹框（MarkdownContent 内 CodeExpandModal）

### 基础设施
- [x] 全局连接池缓存（消除树导航重复握手开销）
- [x] SeaTunnel 前端集成（连接配置 + Job 状态展示面板，基础 UI 就绪）
- [x] i18n 全量化（Assistant / GraphExplorer / MetricsExplorer / SeaTunnel）

### 未实现（有设计文档，待开始）
- [ ] SQL 编辑器 AI Ghost Text 补全（停止输入 600ms 触发，Tab 接受）
- [ ] LLM 配置供应商优先重设计（从 opencode `/config/providers` 动态加载）
- [ ] ACP 持久化 Session（复用 opencode-cli 进程，消除冷启动）
- [ ] UI 状态全量持久化至 SQLite（⚠️ 部分：Rust 侧已有 `get_ui_state`，前端标签页仍用 localStorage）

---

## V3 阶段（2027）—— 生态版

### Milvus 向量库集成
- [ ] Milvus Lite 嵌入模式（本地向量存储）
- [ ] Milvus 独立部署模式（团队共享）
- [ ] 历史 SQL / 指标 / Schema 向量化
- [ ] Few-shot 检索增强（相似 SQL 案例注入）

### 完整 RAG 管道（GraphRAG + 向量双路融合）
- [ ] 向量检索 + 指标检索 + GraphRAG 三路融合 Prompt

### 插件系统
- [ ] 数据源插件（ClickHouse、TiDB、达梦等）
- [ ] AI 提供商插件（Ollama、Azure OpenAI）
- [ ] 导出格式插件

### 团队协作
- [ ] SQL 片段共享库
- [ ] 指标库导出/导入（JSON）
- [ ] 连接配置脱敏导出

### SeaTunnel 外部引擎接入
- [ ] SeaTunnel 连接配置
- [ ] 迁移 job 生成 + REST API 提交
- [ ] 任务状态同步展示

---

---

## 智能运维方向（2026 Q4 ~ 2027）

> 定位：在 AI-Native Database Client 基础上，扩展数据运维与智能运维能力，服务 DBA 和数据工程师的日常运维场景。
>
> 三个方向相互独立，可逐个落地。

---

### 方向 A — 数据库健康监控

**目标**：让 DBA 在 IDE 内一屏看到数据库运行状态，无需切换外部监控工具。

#### 功能清单

**指标采集（Rust 层）**
- [ ] 各方言系统视图查询封装：
  - MySQL：`performance_schema.events_statements_summary_*`、`SHOW STATUS`、`SHOW PROCESSLIST`
  - PostgreSQL：`pg_stat_activity`、`pg_stat_database`、`pg_stat_bgwriter`
- [ ] 采集指标：连接数、活跃查询数、慢查询数、锁等待数、QPS/TPS、磁盘使用率、缓存命中率
- [ ] 定时采样写入内置 SQLite（采样间隔可配置，默认 30s）
- [ ] Tauri 命令：`get_db_metrics`（实时）、`get_db_metrics_history`（历史时序）

**监控面板 UI（前端）**
- [ ] ActivityBar 新增"运维"入口（DatabaseHealth 面板）
- [ ] 关键指标卡片（连接数 / 慢查询 / 锁等待 / QPS）
- [ ] 时序折线图（复用 ECharts chart 块，展示近 1h / 24h / 7d）
- [ ] 慢查询列表：按耗时排序，可点击查看 EXPLAIN 执行计划
- [ ] 当前活跃连接列表（进程 ID / 用户 / SQL / 耗时 / 状态）

**告警阈值配置**
- [ ] 每个指标可设上限阈值（持久化至 SQLite）
- [ ] 超出时 Toast 提示 + 桌面系统通知（Tauri notification API）

**验收标准**
- 面板加载 ≤ 1s，折线图实时刷新无卡顿
- 慢查询列表点击后可直接在 SQL 编辑器查看 EXPLAIN

---

### 方向 B — 智能告警 + 根因分析

**目标**：基于方向 A 的指标数据，AI 自动检测异常并给出中文诊断报告和修复建议。

**依赖**：方向 A 完成后可开始。

#### 功能清单

**异常检测（Rust 层）**
- [ ] 阈值告警：指标超出配置上限时触发
- [ ] 同比/环比突变检测：与上一小时 / 昨日同期对比，变化 > N% 时触发
- [ ] 告警事件写入 SQLite（时间 / 指标 / 当前值 / 触发规则 / 状态）

**AI 根因分析**
- [ ] 注册 MCP 工具 `diagnose_db_health`：
  - 输入：异常指标快照 + 近 5 分钟慢查询列表 + 最近错误日志
  - 输出：中文诊断报告（问题描述 / 可能原因 / 修复建议）
- [ ] 走现有 MCP/ACP 工具链，不新建 LLM 调用路径

**告警面板 UI**
- [ ] 告警历史列表（时间 / 指标 / 严重程度 / 状态：未处理 / 已忽略 / 已修复）
- [ ] 每条告警可展开查看 AI 诊断报告
- [ ] "一键问 AI"：从告警直接跳转 AI 助手，上下文自动填入

**验收标准**
- 告警触发到 AI 报告生成 ≤ 10s
- 用户无需手动描述问题，AI 报告覆盖"原因 + 建议"两部分

---

### 方向 C — SQL 审计日志

**目标**：记录所有 SQL 执行行为，支持合规审查和运维溯源，独立于监控指标。

#### 功能清单

**审计记录（Rust 层）**
- [ ] 所有 `execute_query` 调用均写审计表（新增 SQLite 表 `sql_audit_log`）：
  - 字段：`id`、`connection_id`、`sql_text`、`executed_at`、`duration_ms`、`affected_rows`、`row_count`、`success`、`error_msg`、`source`（manual / ai / agent）
- [ ] 高风险 SQL 自动标记：DELETE/UPDATE 无 WHERE、DROP、全表扫描（无索引的 SELECT）

**审计搜索 UI**
- [ ] ActivityBar"运维"面板下新增"审计日志" Tab
- [ ] 过滤条件：时间范围、连接、关键词、是否成功、是否高风险
- [ ] 高风险 SQL 行标红
- [ ] 点击行可在 SQL 编辑器中重放该 SQL

**统计摘要**
- [ ] 今日执行次数 / 错误率 / 平均耗时 / 最慢 SQL Top 10

**导出**
- [ ] CSV / JSON 导出（可选时间范围），复用现有导出逻辑

**验收标准**
- 审计记录写入不影响查询响应时间（异步写入）
- 高风险 SQL 标记误报率 < 5%（基于 AST 解析，不是关键词匹配）

---

## 文档新鲜度触发表

| 触发事件 | 需更新的文档 |
|----------|------------|
| 新增 Tauri 命令 | ARCHITECTURE.md + CLAUDE.md 命令示例 |
| 新增数据源驱动 | docs/design-docs/datasource-arch.md + PLANS.md |
| 修改 SQLite schema | docs/design-docs/schema-design.md + schema/init.sql |
| 修改 Prompt 模板 | docs/design-docs/ai-pipeline.md |
| 新增 GraphRAG/指标模块 | docs/design-docs/ai-pipeline.md + ARCHITECTURE.md |
| 重大架构决策 | 新建 docs/adr/XXX.md |
