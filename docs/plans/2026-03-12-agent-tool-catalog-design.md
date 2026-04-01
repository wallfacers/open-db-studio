<!-- STATUS: ✅ 已实现 -->
# Agent Tool Catalog 设计文档

**日期：** 2026-03-12
**状态：** 已批准，待实现
**关联计划：** `docs/superpowers/plans/2026-03-12-ai-agent-sql-chat.md`（Chunk 3 已废弃，见下）

---

## 背景与决策

### 废弃 page-agent

`2026-03-12-ai-agent-sql-chat.md` Chunk 3（Task 8-10）已废弃。原因：

- `page-agent` 自带独立 UI 面板，与 Assistant 聊天框完全脱节
- 前端直连 LLM 需要持有 API Key，违反 SECURITY.md
- page-agent 的 DOM 感知与我们的 SQL IDE 场景不匹配

保留内容：`useToolBridge.ts`、`DiffPanel.tsx`、`sqlParser.ts` — 下一阶段复用。

### 设计哲学：工具驱动，按需获取上下文

不将所有上下文一次性塞入 system prompt，而是提供一组工具，让 Agent 按需调用：

> **模型负责思考和决策，系统负责提供工具能力。**

上下文不是提前准备的，而是被 Agent 逐步发现的。类比 Claude Code 的工作方式：在回答问题前先调用 `ls`、`cat`、`grep` 收集信息，再执行操作。

---

## 架构

```
用户输入
  ↓
前端 Agent Loop（TypeScript）
  ├─ 发送消息 + 工具定义 → invoke('ai_chat_stream_with_tools')
  │                              ↓
  │                         Rust（持有 API Key）
  │                              ↓
  │                         调用 LLM（OpenAI function calling）
  │                              ↓
  │                     返回 content OR tool_call_request
  ├─ 收到 tool_call_request → 执行对应工具函数
  │   ├─ 编辑器工具：直接读 queryStore / Monaco（前端）
  │   └─ 数据库工具：invoke('xxx') → Rust → DB
  └─ 工具结果 → invoke('ai_chat_continue') → Rust → LLM → 继续
```

**安全边界：**
- API Key 永不离开 Rust
- 工具执行在前端（Monaco/queryStore 操作）
- Rust 作为 LLM 网关持有密钥

---

## 安全修复：凭证不暴露前端

### API Key

| 命令 | 行为 |
|------|------|
| `list_llm_configs` | 返回 `api_key: ""` （空串，永不暴露） |
| `get_llm_config_key(id)` | 返回真实 key（仅编辑时用户主动点"小眼睛"触发） |

### 数据库密码

| 命令 | 行为 |
|------|------|
| `list_connections` | 返回 `password: null`（现有行为，保持） |
| `get_connection_password(id)` | 返回解密后明文（仅编辑时用户主动触发） |

### 编辑时"未修改不覆盖"机制

编辑弹窗（LLM 配置 / 数据库连接）的密码/Key 字段：

- 打开时显示占位符 `••••••••`，前端标记 `isDirty = false`
- 用户修改字段 → `isDirty = true`
- 保存时：
  - `isDirty = true` → 发送新值，Rust 更新存储
  - `isDirty = false` → 该字段不传（Rust 侧 `Option<String> = None`，跳过更新）
- 无论报错重试多少次，只要未修改字段，原始加密值不受影响

Rust update 命令签名：
```rust
// UpdateLlmConfigInput / UpdateConnectionInput
api_key: Option<String>,   // None = 不动原值
password: Option<String>,  // None = 不动原值
```

---

## 工具目录（Tool Catalog）

### A. 编辑器工具（前端，queryStore + Monaco）

| 工具 | 参数 | 返回内容 |
|------|------|----------|
| `get_current_tab` | — | tabId, title, SQL 全文, 语句列表（含起始/结束行）, 光标行 |
| `get_tab_sql` | tabId | 指定 Tab 的 SQL 全文 |
| `list_tabs` | — | 所有打开的 Tab（id, title, type） |
| `get_selected_text` | — | 选中文本 + 起始/结束行号 |
| `parse_sql_statements` | — | 当前 Tab 解析出的语句列表（text, startLine, endLine） |

### B. 数据库结构工具（Rust invoke → DB）

| 工具 | 参数 | 返回内容 |
|------|------|----------|
| `get_current_connection` | — | connectionId, driver, host, database, schema |
| `list_databases` | connectionId | 数据库名列表 |
| `list_tables` | connectionId, database, schema? | 表名列表 |
| `get_table_schema` | connectionId, table | 列定义（名、类型、nullable、default、主键）、索引、外键 |
| `list_views` | connectionId, database | 视图列表 |
| `list_procedures` | connectionId, database | 存储过程/函数列表 |

### C. 数据工具（Rust invoke，有安全限制）

| 工具 | 参数 | 返回内容 | 限制 |
|------|------|----------|------|
| `get_table_sample` | connectionId, table, limit=5 | 最多 N 行样本数据 | limit ≤ 20 |
| `execute_sql` | connectionId, sql | 查询结果 | 仅 SELECT，行数 ≤ 100 |
| `get_last_error` | — | 最近一次 SQL 执行错误信息 | — |
| `get_query_history` | connectionId, limit=10 | 最近执行的 SQL 列表 | limit ≤ 50 |

### D. 写回工具（前端，对编辑器的操作）

| 工具 | 参数 | 说明 |
|------|------|------|
| `propose_sql_diff` | original, modified, reason | 展示 diff，等待用户确认后写入 Monaco（已有实现） |
| `switch_tab` | tabId | 切换到目标 Tab |

---

## 实现阶段划分

### Phase 1（本次计划）

1. 移除 `page-agent`（uninstall + 删 `usePageAgent.ts` + 清 Assistant）
2. 安全修复：`list_llm_configs` 不返回 api_key，新增 `get_llm_config_key`
3. 安全修复：新增 `get_connection_password`，update 命令支持 `Option` 跳过
4. 编辑弹窗 `isDirty` 机制（LLM 配置 + 连接配置）
5. 文档同步：标注废弃的 Chunk 3，更新 PLANS.md

### Phase 2（下一轮计划）

1. Rust 侧 `ai_chat_stream_with_tools`：支持 OpenAI function calling，返回 tool_call_request
2. Rust 侧 `ai_chat_continue`：接收工具结果，继续对话
3. 前端 Agent Loop：解析 tool_call，调用 Tool Catalog，回传结果
4. 实现完整 Tool Catalog（A/B/C/D 四类工具）
5. `sqlParser.ts` 扩展：`parseStatements` 增加 startLine/endLine 字段

---

## 不在本次范围

- `propose_sql_diff` 的 apply 流程已实现（DiffPanel + useToolBridge），本次不动
- ER 图相关工具（见 `2026-03-12-ai-agent-page-interaction-design.md`）
- 多 Tab 批量操作工具
