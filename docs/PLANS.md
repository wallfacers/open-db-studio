# PLANS.md — 开发计划与路线图

> 详细设计见 [docs/plans/2026-03-10-feature-roadmap-design.md](./plans/2026-03-10-feature-roadmap-design.md)

---

## MVP 阶段（当前 → Q2 2026）—— 能用

### 已完成
- [x] Tauri 2.x 脚手架初始化
- [x] Rust 后端骨架（db/、datasource/、llm/）
- [x] 内置 SQLite schema（5 张表）
- [x] MySQL + PostgreSQL DataSource 实现（骨架）
- [x] LLM 代理模块（OpenAI 兼容）
- [x] CLAUDE.md + docs/ 文档记录系统

### 进行中
- [ ] 连接管理 UI（新建/编辑/删除/测试连接）
- [ ] `execute_query` 命令完整实现（SELECT + DDL/DML）
- [ ] 密码加密存储（AES-256-GCM）

### 待开始
- [ ] SQL 编辑器与 Rust 后端联调（Monaco Editor + F5 执行）
- [ ] Schema 树面板（数据库 → 表 → 列）
- [ ] 查询结果表格展示（分页 + 列排序）
- [ ] 查询历史（最近 500 条，可搜索重用）
- [ ] 基础 AI 生成 SQL（注入 Schema 上下文）
- [ ] AI SQL 解释（选中 SQL → 中文解释）
- [ ] Oracle 驱动实现（oracle crate）
- [ ] SQL Server 驱动实现（tiberius）

---

## V1 阶段（Q3 2026）—— 好用

### 完整 DB 管理
- [ ] 表管理 GUI（建表/改表/删表 + DDL 预览）
- [ ] 数据浏览器（分页查看 + 行内编辑 + 条件过滤）
- [ ] 索引管理（创建/删除，唯一索引、复合索引）
- [ ] 视图 / 存储过程 / 函数管理
- [ ] ERD 可视化（外键自动生成 ER 图）

### SQL 编辑器增强
- [ ] Schema-aware 自动补全（表名 → 字段提示）
- [ ] 语法高亮 + 错误标红（多方言）
- [ ] 一键格式化 SQL
- [ ] 多结果集 Tab（多语句各自展示结果）

### 数据导入导出
- [ ] 导出：CSV / JSON / Excel / SQL Dump
- [ ] 导入：CSV / JSON / Excel 字段映射写入
- [ ] 带 WHERE 条件的部分数据导出

### AI 能力增强
- [ ] AI 建表（自然语言 → DDL → 确认执行）
- [ ] AI SQL 优化（执行计划分析 + 索引建议）
- [ ] AI 错误诊断（报错 → 原因解释 + 修复方案）
- [ ] 多轮对话式 SQL（AI 面板保留上下文）

---

## V2 阶段（Q4 2026）—— 专业版

### GraphRAG 知识图谱引擎
- [ ] Schema 实体图构建（表/列/外键 → 图节点和边）
- [ ] 关系路径推断（自动发现 JOIN 路径）
- [ ] 图谱可视化（ERD + 业务语义标注）

### 业务指标层
- [ ] 指标定义（名称/字段/聚合函数/业务含义）
- [ ] AI 生成指标草稿（扫描 Schema + 数据样本）
- [ ] 用户审核确认（编辑/批准/拒绝 → 入库）
- [ ] 指标检索增强（提问时注入相关指标定义）

### 高精度 Text-to-SQL 管道
- [ ] 指标 + GraphRAG + Schema 融合 Prompt 构建
- [ ] SQL 语法校验（生成后自动检查）

### 跨数据源迁移（Rust 原生实现）
- [ ] DDL 跨方言转换（类型映射）
- [ ] 分批数据迁移（进度展示 + 错误报告）
- [ ] 迁移预检（兼容性检查）
- [ ] 迁移任务管理（暂停/恢复/重试）

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
