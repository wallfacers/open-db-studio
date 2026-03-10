# AI SQL 生成流程

## 流程

```
用户输入自然语言
→ invoke('ai_generate_sql', { prompt, connectionId })
→ get_schema(connectionId)
→ 加载 prompts/sql_generate.txt
→ 替换 {{DIALECT}} 和 {{SCHEMA}}
→ llm::client.chat(messages)
→ SQL 字符串 → 前端填充到编辑器
```

## Prompt 模板

位于 `prompts/` 目录，通过 `include_str!()` 在编译时嵌入：
- `sql_generate.txt`：自然语言 → SQL
- `sql_explain.txt`：SQL 解释
- `sql_optimize.txt`：SQL 优化建议

## Schema 注入

`get_schema()` 返回表名列表（MVP），注入到 `{{SCHEMA}}` 占位符。
后续增强：包含列名、类型、主外键关系。
