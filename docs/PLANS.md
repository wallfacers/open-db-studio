# PLANS.md — 开发计划与路线图

## 当前阶段：MVP（2026 Q1）

### 已完成
- [x] Tauri 2.x 脚手架初始化
- [x] Rust 后端骨架（db/、datasource/、llm/）
- [x] 内置 SQLite schema（5 张表）
- [x] MySQL + PostgreSQL DataSource 实现（骨架）
- [x] LLM 代理模块（OpenAI 兼容）
- [x] CLAUDE.md + docs/ 文档记录系统

### 进行中
- [ ] 连接管理 UI（新建/编辑/删除连接）
- [ ] execute_query 命令完整实现
- [ ] 密码加密存储（AES-256-GCM）

### 待开始
- [ ] SQL 编辑器与 Rust 后端联调
- [ ] AI 生成 SQL 功能完整实现
- [ ] 查询历史 UI
- [ ] Oracle、SQL Server 真实驱动实现

## 文档新鲜度触发表

| 触发事件 | 需更新的文档 |
|----------|------------|
| 新增 Tauri 命令 | ARCHITECTURE.md + CLAUDE.md 命令示例 |
| 新增数据源驱动 | docs/design-docs/datasource-arch.md + PLANS.md |
| 修改 SQLite schema | docs/design-docs/schema-design.md + schema/init.sql |
| 修改 Prompt 模板 | docs/design-docs/ai-pipeline.md |
| 重大架构决策 | 新建 docs/adr/XXX.md |
