# 设计文档：图关系消歧 MCP Skill 统一架构

**日期**：2026-03-20
**状态**：已批准（v2，经 spec-reviewer 修正）
**作者**：Claude Code + 用户协作

---

## 背景与问题

当前项目中，AI 的图关系读取能力存在严重分裂：

| AI 入口 | 是否读取图关系 | 实现方式 |
|---------|-------------|---------|
| `ai_generate_sql_v2` | 是 | `build_sql_context()` 预计算后注入 system prompt |
| `agent_chat` | 否 | 仅传入编辑器 SQL + 连接 ID |
| `agent_explain_sql` | 否 | 仅传入 SQL + 驱动类型 |
| `agent_optimize_sql` | 否 | 仅传入 SQL + 驱动类型 |

这导致 `agent_chat`（AI 助手对话框）在处理复杂关联查询时无法利用 GraphExplorer 中已构建的表关系、外键路径、业务指标等信息，无法有效消除字段/表名歧义。

---

## 现有架构（实际状态）

项目中存在**两个独立进程**，必须区分：

```
┌──────────────────────────────────────────────────────┐
│  Tauri 主进程                                        │
│                                                      │
│  serve_port (6686) ← opencode-cli (Node.js 进程)    │
│    /events SSE                                       │
│    ↑ Tauri 向此端口发 HTTP 请求，无路由控制权        │
│                                                      │
│  mcp_port (19876) ← Tauri 自身 Axum HTTP Server     │
│    /mcp  ← 已有 22 个工具（MCP JSON-RPC）           │
│    src-tauri/src/mcp/mod.rs                          │
└──────────────────────────────────────────────────────┘

opencode-cli 启动时读取 opencode.json：
  mcp.open-db-studio.url = http://127.0.0.1:{mcp_port}/mcp
  → agent_chat 中 LLM 已可使用全部 22 个 MCP 工具
```

**关键发现**：`agent_chat` 已经通过 opencode-cli → opencode.json → mcp_port 感知所有工具，新增图关系 skill 后**自动生效，无需修改 agent_chat 代码**。

---

## 目标

1. **统一**：`agent_chat` 和 `ai_generate_sql_v2` 都通过图关系 MCP skill 消歧
2. **按需加载**：LLM 自主判断是否需要调用图关系工具，简单查询零开销
3. **可扩展**：新增图能力只需在现有 MCP Server 中增加 skill 文件
4. **删除冗余**：移除 `pipeline/context_builder.rs` 的预计算逻辑，统一维护一份

---

## 方案

在现有 **Tauri Axum MCP Server**（`src-tauri/src/mcp/`）中新增图关系 skills。

- 不新建进程，不新建端口
- opencode-cli 通过 `opencode.json` 自动发现新工具
- `agent_chat` 无需修改，新工具上线后 LLM 立即可用

---

## 架构设计

### 整体架构图

```
opencode-cli (serve_port: 6686)          Tauri Axum MCP Server (mcp_port: 19876)
┌──────────────────────────┐             ┌─────────────────────────────────────┐
│  agent_chat session      │             │  /mcp  (JSON-RPC 2.0)               │
│                          │  tool call  │                                     │
│  LLM 推理                │ ──────────→ │  [现有 22 个工具]                   │
│  - 需要消歧时            │ ←────────── │  list_databases, list_tables,       │
│    调用 graph_* 工具     │  tool result│  get_table_schema, search_metrics…  │
└──────────────────────────┘             │                                     │
                                         │  [新增 5 个图关系 skills]           │
ai_generate_sql_v2 (同步 invoke)         │  graph_query_context   (粗粒度)     │
┌──────────────────────────┐             │  graph_search_tables               │
│  pipeline/mod.rs         │  直接调用   │  graph_find_join_paths             │
│  generate_sql_v2()       │ ──────────→ │  graph_get_ddl                     │
│  → 调用 Rust graph 函数  │  Rust fn    │  graph_search_metrics              │
└──────────────────────────┘             └────────────────┬────────────────────┘
                                                          │ 直接函数调用（无 HTTP）
                                         ┌────────────────▼────────────────────┐
                                         │  graph::query 模块（现有，保留）    │
                                         │  find_relevant_subgraph()           │
                                         │  find_join_paths()                  │
                                         │  search_metrics() (metrics crate)   │
                                         └─────────────────────────────────────┘
```

**注意**：`ai_generate_sql_v2` 是同步 Tauri invoke，不走 MCP HTTP，直接调用与 MCP skill 相同的 Rust 函数——保证逻辑一致、无 HTTP 开销。

### Skill 文件结构（新增到现有 `mcp/` 目录）

```
src-tauri/src/mcp/
├── mod.rs              # 已有：tool_definitions() + call_tool() 中新增 graph_* 分支
├── tools/
│   ├── mod.rs
│   ├── db_read.rs      # 已有
│   ├── metric_edit.rs  # 已有
│   └── graph/          # 新增目录
│       ├── mod.rs
│       ├── query_context.rs    # graph_query_context（粗粒度入口）
│       ├── search_tables.rs    # graph_search_tables
│       ├── find_join_paths.rs  # graph_find_join_paths
│       ├── get_ddl.rs          # graph_get_ddl
│       └── search_metrics.rs  # graph_search_metrics
```

每个文件单一职责。新增图能力只需加文件 + 在 `mod.rs` 注册两处（`tool_definitions` + `call_tool` 匹配分支）。

---

## MCP Tool 定义

所有新工具使用 `graph_` 前缀，避免与现有 22 个工具命名冲突。

### 粗粒度入口（LLM 首选）

```json
{
  "name": "graph_query_context",
  "description": "当问题涉及多表关联、字段歧义或不确定表名时优先调用。基于 GraphExplorer 知识图谱，返回相关表列表、推断的 JOIN 路径、精简 DDL 和业务指标。获得结果后再按需调用细粒度工具深挖。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "用户原始问题（用于实体提取）" },
      "connection_id": { "type": "integer", "description": "数据库连接 ID" }
    },
    "required": ["question", "connection_id"]
  }
}
```

输出结构：

```json
{
  "relevant_tables": ["orders", "users"],
  "join_paths": ["orders → users via orders.user_id = users.id"],
  "schema_ddl": "CREATE TABLE orders (...); CREATE TABLE users (...);",
  "metrics": ["monthly_revenue: SUM(orders.amount) WHERE ..."],
  "context_quality": "graph_hit"
}
```

`context_quality` 枚举（替代模糊的 `fallback: bool`）：

| 值 | 含义 |
|----|------|
| `"graph_hit"` | 图谱命中，结果高质量 |
| `"fts_fallback"` | 图谱无精确命中，改用 FTS5 全文搜索 |
| `"schema_only"` | FTS5 也无命中，降级到全库表名列表 |
| `"empty"` | 图谱未构建，返回空结果 |

### 细粒度工具（LLM 深挖时按需调用）

```json
{ "name": "graph_search_tables",
  "description": "在知识图谱中按关键词模糊搜索表名、别名、display_name，返回匹配的表列表。与 list_tables 的区别：本工具搜索用户定义的业务别名，list_tables 返回数据库实际表名。",
  "inputSchema": { "question": "string", "connection_id": "integer" } }

{ "name": "graph_find_join_paths",
  "description": "给定起点表和终点表，在知识图谱边中查找通过外键关系连接的最短 JOIN 路径，返回路径描述列表。",
  "inputSchema": { "from_table": "string", "to_table": "string", "connection_id": "integer" } }

{ "name": "graph_get_ddl",
  "description": "获取指定表的精简 DDL（仅包含字段名、类型、注释、外键），用于了解字段详情。与 get_table_schema 的区别：本工具输出 CREATE TABLE 文本，更适合直接插入 SQL 生成 prompt。",
  "inputSchema": { "table_name": "string", "connection_id": "integer" } }

{ "name": "graph_search_metrics",
  "description": "在知识图谱中搜索业务指标节点，返回指标名称和计算逻辑定义。与 search_metrics 的区别：本工具搜索图谱节点（node_type=metric），search_metrics 搜索 MetricsExplorer 中 approved 的指标记录。",
  "inputSchema": { "keyword": "string", "connection_id": "integer" } }
```

---

## 数据流

### agent_chat（LLM 自主决策）

```
用户问："查一下每个用户的总订单金额"
  │
  ├─ opencode-cli LLM 推理开始
  │   system: 可用工具包含 graph_query_context 等（通过 opencode.json 感知）
  │
  ├─ [歧义检测] LLM 认为涉及多表关联 → tool_call
  │     graph_query_context(question="每个用户的总订单金额", connection_id=1)
  │     ↓ mcp_port /mcp
  │     → graph::query::find_relevant_subgraph()
  │     → graph::traversal::find_join_paths()
  │     ← { relevant_tables: ["users","orders"], join_paths: [...], context_quality: "graph_hit" }
  │
  ├─ LLM 读取上下文，生成正确 SQL
  │     SELECT u.id, SUM(o.amount) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.id
  │
  └─ [简单查询] "SELECT 1" → LLM 直接生成，不调用任何工具（按需，零开销）
```

### ai_generate_sql_v2（直接 Rust 调用，不走 MCP HTTP）

```
invoke('ai_generate_sql_v2', { question, connectionId })
  ↓
pipeline::generate_sql_v2()
  ↓
graph::query::find_relevant_subgraph()   ← 与 MCP skill 调用相同函数
graph::traversal::find_join_paths()
metrics::search_metrics()
  ↓
build system prompt（内联注入上下文）
  ↓
llm::client.chat()
  ↓
TextToSqlResult { sql, graph_context, ... }
```

Phase 2 中 `build_sql_context()` 内联逻辑迁移到 `graph/tools/query_context.rs` 中的共享函数，`pipeline/mod.rs` 直接调用该函数（而非通过 HTTP）。

---

## 迁移策略

### Phase 1：新增图关系 skills 到现有 MCP Server

- 在 `mcp/tools/graph/` 下实现 5 个 skill 文件
- 在 `mcp/mod.rs` 的 `tool_definitions()` 追加 5 个工具定义
- 在 `mcp/mod.rs` 的 `call_tool()` 追加 5 个 `graph_*` 匹配分支
- 重启后 opencode-cli 自动感知新工具，`agent_chat` 立即生效
- `ai_generate_sql_v2` 原有逻辑不动（两套并行验证期）

### Phase 2：`ai_generate_sql_v2` 切换

- `graph/tools/query_context.rs` 将 `build_sql_context()` 的核心逻辑提取为 `pub async fn build_graph_context()`
- `pipeline/mod.rs` 改为调用 `mcp::tools::graph::query_context::build_graph_context()`
- `pipeline/context_builder.rs` 的代码**移入** `graph/tools/query_context.rs`（非删除，是迁移）
- 前端 `TextToSqlResult.graph_context` 字段保留，来源从 `context_builder` 改为共享函数
- 验收：相同查询场景下，`graph_context` 输出结果与旧版一致

### Phase 3：清理

- 确认 Phase 2 稳定后，删除 `pipeline/context_builder.rs`
- `TextToSqlResult.graph_context` 字段验证前端消费链路（检查 `queryStore` / `ResultPanel` 依赖）后再决定是否修改

---

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 图谱未构建（空库） | 返回 `context_quality: "empty"` + 空数组，LLM 自行决策（现有降级策略保留） |
| 内置 SQLite 查询超时 | 50ms 超时，超时返回 `context_quality: "schema_only"` |
| 外部数据源 DDL 获取超时 | 3000ms 超时（与现有连接超时一致），超时跳过 DDL 字段 |
| `connection_id` 无效 | 返回 JSON-RPC error `{"code": -32602, "message": "connection_not_found"}` |
| 细粒度工具无结果 | 返回空数组，LLM 判断是否需要向用户澄清 |
| `graph_search_metrics` 与 MetricsExplorer `search_metrics` 混淆 | description 中明确区分（见工具定义），两者共存不冲突 |

---

## 前端兼容

`ai_generate_sql_v2` 当前向前端返回 `graph_context`（展示命中了哪些表/路径）。切换后：

- Phase 2 期间：`TextToSqlResult.graph_context` 字段保留，来源函数变更但结构不变，前端无感知
- Phase 3 后（可选）：若需在 `agent_chat` 对话中展示图关系命中，在 `aiStore` 新增 `lastGraphContext?: GraphContext` 字段，从流式 tool_call 响应中解析 `graph_query_context` 的返回值填入

---

## 不在本次范围内

- MCP Server 对外部工具（Claude Desktop、Cursor）的直接暴露
- `agent_explain_sql` / `agent_optimize_sql` 接入图关系（可后续迭代）
- 图谱构建（`build_schema_graph`）本身的改动
- `agent_chat` 的 connection_id 传递机制改动（已通过 system prompt 注入，现有机制有效）
