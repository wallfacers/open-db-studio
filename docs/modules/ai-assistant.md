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
- AI 回答中输出 ` ```chart` 代码块
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
