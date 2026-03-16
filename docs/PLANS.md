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

## 文档新鲜度触发表

| 触发事件 | 需更新的文档 |
|----------|------------|
| 新增 Tauri 命令 | ARCHITECTURE.md + CLAUDE.md 命令示例 |
| 新增数据源驱动 | docs/design-docs/datasource-arch.md + PLANS.md |
| 修改 SQLite schema | docs/design-docs/schema-design.md + schema/init.sql |
| 修改 Prompt 模板 | docs/design-docs/ai-pipeline.md |
| 新增 GraphRAG/指标模块 | docs/design-docs/ai-pipeline.md + ARCHITECTURE.md |
| 重大架构决策 | 新建 docs/adr/XXX.md |
