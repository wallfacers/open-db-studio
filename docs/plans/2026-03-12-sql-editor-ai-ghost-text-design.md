# SQL 编辑器 AI Ghost Text 补全设计

**日期**：2026-03-12
**状态**：已批准
**功能**：SQL 编辑器内联 AI 推荐（Copilot/Cursor 风格 Ghost Text）

---

## 目标

在 SQL 编辑器中实现类似 GitHub Copilot / Cursor 的内联 AI 推荐：
- 用户停止输入 600ms 后自动触发
- 在光标后以灰色幽灵文字显示 AI 建议
- `Tab` 接受，`Esc` 拒绝
- 仅当存在可用 AI 配置时激活，否则静默降级

---

## 架构

```
前端 Monaco Editor
  └─ InlineCompletionsProvider
       ├─ debounce 600ms
       ├─ 读取光标前 SQL + 自适应粒度判断
       ├─ invoke('ai_inline_complete', { ... })
       └─ 渲染 Ghost Text（Tab 接受 / Esc 拒绝）

Rust 后端
  └─ ai_inline_complete(sql_before, sql_after, schema_context, history_context, hint)
       └─ llm/client.rs → 构建 Prompt → 调用 AI → 返回补全文本（5s 超时）
```

---

## 前端设计

### 注册位置

在 `MainContent/index.tsx` 的 `handleEditorDidMount` 中，紧跟现有 Schema 补全 provider 之后注册：

```ts
monaco.languages.registerInlineCompletionsProvider('sql', { ... })
```

### 触发粒度（自适应）

| 光标位置 | hint 值 | 补全目标 |
|---------|---------|---------|
| 当前行已有内容，光标不在行首 | `"single_line"` | 补全当前行剩余 |
| 光标在空行 / 行首 | `"multi_line"` | 补全完整 SQL 语句 |

### 上下文构建

| 参数 | 来源 | 限制 |
|------|------|------|
| `sql_before` | 光标前全部文本 | 最多 2000 chars |
| `sql_after` | 光标后全部文本 | 最多 500 chars |
| `schema_context` | `schemaRef.current`（已有） | 表名 + 字段摘要 |
| `history_context` | `queryHistoryStore` 最近 5 条 | 拼接 SQL 字符串 |
| `hint` | 光标位置判断 | `"single_line"` / `"multi_line"` |

### AI 配置选取逻辑

```ts
const usableConfig =
  configs.find(c => c.is_default && c.test_status === 'success')
  ?? configs.find(c => c.test_status === 'success')
  ?? null;

if (!usableConfig) return { items: [] }; // 静默降级
```

优先级：
1. 默认配置 (`is_default=true`) 且连通性通过 (`test_status='success'`)
2. 列表中任意连通性通过的第一个配置
3. 都没有 → 不触发 AI 请求

### 防抖机制

每次 `provideInlineCompletions` 调用时：
- 取消上一次未完成的 debounce timer（600ms）
- 超时未完成的 Rust 调用视为失败，返回空 items（不抛出错误）

---

## 后端设计

### 新增 Rust 命令

```rust
#[tauri::command]
async fn ai_inline_complete(
    sql_before: String,
    sql_after: String,
    schema_context: String,
    history_context: String,
    hint: String,           // "single_line" | "multi_line"
    state: tauri::State<'_, AppState>,
) -> Result<String, String>
```

需在 `lib.rs` 的 `generate_handler![]` 中注册。

### Prompt 模板

**单行模式（`hint = "single_line"`）**：
```
你是 SQL 补全引擎。只输出补全内容，不加任何解释、不加代码块、不重复光标前的内容。
Schema 信息:
{schema_context}

历史 SQL 参考:
{history_context}

当前编辑器内容（<cursor> 表示光标位置）:
{sql_before}<cursor>{sql_after}

续写光标处，只补全当前行剩余部分：
```

**多行模式（`hint = "multi_line"`）**：
```
你是 SQL 补全引擎。只输出补全内容，不加任何解释、不加代码块、不重复光标前的内容。
Schema 信息:
{schema_context}

历史 SQL 参考:
{history_context}

当前编辑器内容（<cursor> 表示光标位置）:
{sql_before}<cursor>{sql_after}

从光标处续写，补全完整的 SQL 语句：
```

### 超时与降级

- 请求超时：5 秒
- 超时或 AI 报错 → 返回 `Ok("")`（空字符串），前端渲染无 ghost text

---

## 复用的已有基础设施

| 需求 | 复用内容 |
|------|---------|
| AI 调用 | `llm/client.rs` 统一代理 |
| Schema 信息 | `schemaRef.current`（已有） |
| 查询历史 | `queryHistoryStore`（已有） |
| AI 配置列表 | `useAiStore().configs`（已有） |

---

## 不在本次范围内

- 流式（streaming）ghost text（首期用非流式）
- 多候选项选择（首期只取第一个建议）
- 快捷键手动触发模式
- Ghost Text 接受率统计
