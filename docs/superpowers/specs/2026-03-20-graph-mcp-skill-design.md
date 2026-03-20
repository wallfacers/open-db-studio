# 设计文档：图关系消歧 MCP Skill 统一架构

**日期**：2026-03-20
**状态**：已批准
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

## 目标

1. **统一**：`agent_chat` 和 `ai_generate_sql_v2` 都通过同一图关系查询机制消歧
2. **按需加载**：LLM 自主判断是否需要调用图关系工具，简单查询零开销
3. **可扩展**：新增图能力只需添加一个 skill 文件
4. **删除冗余**：移除 `pipeline/context_builder.rs` 的预计算逻辑，统一维护一份

---

## 方案选择

选择**方案 A：扩展现有 `serve_port`，新增 `/mcp` 路由**。

- 复用现有网络栈，无额外进程
- agent runtime 已连接 `serve_port`，MCP 只是新增路由
- 两个 AI 入口统一路径最自然
- 未来可直接将 `/mcp` 端点暴露给外部工具

---

## 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Tauri serve_port                        │
│                                                             │
│   /events  (现有 SSE)          /mcp  (新增)                │
│   ┌───────────────┐            ┌────────────────────────┐  │
│   │ agent_chat    │            │   MCP Server           │  │
│   │ agent_explain │  ←─────→  │  ┌──────────────────┐  │  │
│   │ ai_gen_sql_v2 │  tool call │  │ query_graph      │  │  │
│   └───────────────┘            │  │ (粗粒度入口)     │  │  │
│                                │  ├──────────────────┤  │  │
│                                │  │ search_tables    │  │  │
│                                │  │ find_join_paths  │  │  │
│                                │  │ get_schema_ddl   │  │  │
│                                │  │ search_metrics   │  │  │
│                                │  └──────────────────┘  │  │
│                                └─────────┬──────────────┘  │
└──────────────────────────────────────────┼─────────────────┘
                                           │ 直接函数调用
                               ┌───────────▼──────────────┐
                               │  graph::query 模块        │
                               │  (现有 Rust 函数保留)     │
                               │  find_relevant_subgraph() │
                               │  find_join_paths()        │
                               │  search_metrics()         │
                               └──────────────────────────┘
```

### Skill 文件结构

```
src-tauri/src/mcp/
├── mod.rs              # MCP Server 路由注册，挂载到 serve_port
├── router.rs           # /mcp 路由：tools/list、tools/call
├── skills/
│   ├── mod.rs
│   ├── query_graph.rs       # query_graph_context（粗粒度，优先调用）
│   ├── search_tables.rs     # 按关键词模糊搜索表名和别名
│   ├── find_join_paths.rs   # 给定两张表，返回最短 JOIN 路径
│   ├── get_schema_ddl.rs    # 获取指定表的完整 DDL
│   └── search_metrics.rs    # 搜索业务指标定义
└── types.rs            # MCP 协议类型（ToolDef, ToolCall, ToolResult）
```

每个 `skills/*.rs` 是独立的单一职责文件，新增图能力只需加一个文件并在 `skills/mod.rs` 注册。

---

## MCP Tool 定义

### 粗粒度入口（LLM 首选）

```rust
Tool {
    name: "query_graph_context",
    description: "当问题涉及多表关联、字段歧义或不确定表名时调用。
                  返回相关表列表、推断的 JOIN 路径、精简 DDL 和业务指标。
                  优先调用此工具获取完整上下文，再按需调用细粒度工具深挖。",
    input_schema: {
        question: String,       // 用户原始问题（用于实体提取）
        connection_id: i64,     // 数据库连接 ID
    },
    output: {
        relevant_tables: Vec<String>,
        join_paths: Vec<String>,    // 如："orders → users via orders.user_id"
        schema_ddl: String,         // 仅相关表的精简 DDL
        metrics: Vec<String>,
        fallback: bool,             // true 表示图谱为空，已降级到全表名列表
    }
}
```

### 细粒度工具（LLM 深挖时按需调用）

```rust
Tool { name: "search_tables",
       description: "按关键词模糊搜索表名、别名、display_name，返回匹配的表名列表",
       input: { keyword: String, connection_id: i64 } }

Tool { name: "find_join_paths",
       description: "给定起点表和终点表，返回通过外键关系连接的最短 JOIN 路径",
       input: { from_table: String, to_table: String, connection_id: i64 } }

Tool { name: "get_schema_ddl",
       description: "获取指定表的完整 DDL（建表语句），用于了解字段详情",
       input: { table_name: String, connection_id: i64 } }

Tool { name: "search_metrics",
       description: "按关键词搜索业务指标定义，用于了解指标计算逻辑",
       input: { keyword: String, connection_id: i64 } }
```

---

## 数据流

### LLM 推理时序

```
agent_chat / ai_generate_sql_v2 请求
  │
  ├─ system prompt 中声明 5 个 MCP tools 可用
  │
  ├─ [简单查询] LLM 直接生成 SQL，不调用任何工具     ← 零开销
  │
  └─ [复杂/歧义查询]
        LLM → tool_call: query_graph_context(question, connection_id)
          ↓
        /mcp/tools/call → skills/query_graph.rs
          ↓
        graph::query::find_relevant_subgraph()
        graph::traversal::find_join_paths()
        metrics::search_metrics()
          ↓
        返回 graph_context JSON 给 LLM
          ↓
        LLM 读取上下文，消歧后生成正确 SQL
          │
          └─ [仍有疑问] 追加 tool_call: find_join_paths / get_schema_ddl
```

---

## 迁移策略

### Phase 1：MCP Server 上线

- 实现 `src-tauri/src/mcp/` 模块（router + types + 5 个 skills）
- `serve_port` 的 HTTP 层新增 `/mcp` 路由（`tools/list`、`tools/call`）
- `agent_chat` 的 system prompt 中注入 MCP tools 声明
- 原有代码不动，两套并行

### Phase 2：`ai_generate_sql_v2` 切换

- `pipeline/mod.rs` 移除 `build_sql_context()` 调用
- `generate_sql_v2` 改为通过 agent runtime 走 MCP tool_call
- 验证 `graph_context` 返回结构与前端 store 兼容（`TextToSqlResult` 字段调整）

### Phase 3：清理

- 删除 `pipeline/context_builder.rs`
- 删除 `TextToSqlResult.graph_context` 字段或改为从流式响应解析
- graph::query 模块内的函数保留（现在被 MCP skill handler 调用）

---

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 图谱未构建（空库） | `query_graph_context` 返回 `fallback: true` + 全表名列表，LLM 自行决策 |
| MCP 工具调用超时 | 500ms 超时后返回空结果，LLM 继续生成不阻塞 |
| `connection_id` 无效 | 返回 `error: "connection_not_found"`，LLM 不继续调用细粒度工具 |
| 细粒度工具无结果 | 返回空数组，LLM 判断是否需要向用户澄清 |
| MCP Server 未启动 | agent runtime 启动时检测，tools 声明降级为空列表 |

---

## 前端兼容

`ai_generate_sql_v2` 当前向前端返回 `graph_context`（展示命中了哪些表/路径）。切换后：

- 前端 `aiStore` 新增 `lastGraphContext` 字段
- `agent_chat` 流式响应中，当 LLM 完成 tool_call 后，将 `query_graph_context` 的返回值存入 store
- UI 展示逻辑不变（仍渲染 `relevant_tables`、`join_paths`）

---

## 不在本次范围内

- MCP Server 对外部工具（Claude Desktop、Cursor）的暴露
- `agent_explain_sql` / `agent_optimize_sql` 接入图关系（可后续迭代）
- 图谱构建（`build_schema_graph`）本身的改动
