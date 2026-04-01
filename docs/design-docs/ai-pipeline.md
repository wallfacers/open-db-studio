# AI SQL 生成流程

**最后更新**：2026-03-29

---

## 基础流程（MVP → V1）

```
用户输入自然语言
→ invoke('ai_generate_sql', { prompt, connectionId })
→ get_schema(connectionId)
→ 加载 prompts/sql_generate.txt
→ 替换 {{DIALECT}} 和 {{SCHEMA}}
→ llm::client.chat(messages)
→ SQL 字符串 → 前端填充到编辑器
```

## V2 增强流程（Text-to-SQL v2 Pipeline）

```
用户输入自然语言
→ AI 助手面板 (Assistant/index.tsx)
→ opencode Agent HTTP API (/session/:id/chat)
→ Agent 调用 MCP 工具链：
    ├─ graph_get_node_list / find_join_paths（GraphRAG 路径推断）
    ├─ metrics_search（业务指标检索）
    ├─ get_schema / get_full_schema（Schema 上下文）
    └─ 其他注册工具
→ LLM 融合 Prompt（指标 + GraphRAG + Schema 三路融合）
→ SQL 语法校验（pipeline/sql_validator）
→ 流式输出到前端（SSE → ThinkingBlock + Content）
```

### 核心模块（`src-tauri/src/pipeline/`）

| 模块 | 用途 |
|------|------|
| `entity_extract` | 从自然语言中提取实体（表名、列名、指标名） |
| `context_builder` | 融合 Schema + GraphRAG + 指标上下文 |
| `sql_validator` | 生成后自动校验 SQL 语法 |

---

## Prompt 模板

位于 `prompts/` 目录，通过 `include_str!()` 在编译时嵌入：
- `sql_generate.txt`：自然语言 → SQL
- `sql_explain.txt`：SQL 解释
- `sql_optimize.txt`：SQL 优化建议
- `sql_inline_complete.txt`：AI Ghost Text 补全（未实现）

## Schema 注入

`get_schema()` / `get_full_schema()` 返回完整 Schema 信息（表名 + 列名 + 类型 + 主外键关系 + 索引），注入到 Prompt 占位符。

## AI 相关命令一览

| 命令 | 用途 | 状态 |
|------|------|------|
| `ai_generate_sql` | 基础 SQL 生成 | ✅ |
| `ai_explain_sql` | SQL 解释 | ✅ |
| `ai_optimize_sql` | SQL 优化（流式 + 取消） | ✅ |
| `ai_diagnose_error` | 错误诊断 | ✅ |
| `ai_chat_stream` | AI 助手流式对话 | ✅ |
| `ai_explain_sql_acp` | SQL Explain ACP（流式） | ✅ |
| `ai_inline_complete` | Ghost Text 内联补全 | ✅ 已实现 |

## AI 流式输出

支持多种思考模型的流式输出：
- **OpenAI 兼容**：DeepSeek-R1（`<think/>` 标签）、Qwen-thinking
- **Anthropic**：Claude Extended Thinking（`thinking` 块）
- **前端渲染**：`ThinkingBlock.tsx` 折叠块展示思考过程
