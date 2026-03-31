<!-- STATUS: ✅ 已实现 -->
# SQL 编辑器 AI Ghost Text 补全实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Monaco SQL 编辑器中实现类似 Cursor/Copilot 的内联 AI Ghost Text 补全，停止输入 600ms 后自动触发，Tab 接受，Esc 拒绝。

**Architecture:** 前端注册 Monaco `InlineCompletionsProvider`，debounce 600ms 后调用 Rust 命令 `ai_inline_complete`；后端自动选取最优 LLM 配置（默认+通过优先，否则任意通过），结合 Schema + 历史 SQL 构建 Prompt 并返回补全文本；无可用配置时静默返回空。

**Tech Stack:** Monaco Editor `registerInlineCompletionsProvider`、Rust Tauri command、现有 `llm/client.rs` + `db/mod.rs`

---

## 关键文件速查

| 文件 | 作用 |
|------|------|
| `prompts/sql_inline_complete.txt` | 新建 Prompt 模板 |
| `src-tauri/src/llm/client.rs` | 新增 `inline_complete` 方法 |
| `src-tauri/src/db/mod.rs` | 新增 `get_best_llm_config()` 函数 |
| `src-tauri/src/commands.rs` | 新增 `ai_inline_complete` 命令 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/components/MainContent/index.tsx` | 注册 InlineCompletionsProvider |

---

### Task 1: 新建 Prompt 模板文件

**Files:**
- Create: `prompts/sql_inline_complete.txt`

**Step 1: 创建文件**

```
你是 SQL 补全引擎。只输出补全内容，不加任何解释、不加代码块标记、不重复光标前已有的内容。

数据库方言: {{DIALECT}}

Schema 信息:
{{SCHEMA}}

历史 SQL 参考（最近执行过的查询）:
{{HISTORY}}

当前编辑器内容（<cursor> 表示光标位置）:
{{SQL_BEFORE}}<cursor>{{SQL_AFTER}}

{{#if SINGLE_LINE}}
续写光标处，只补全当前行剩余部分，不换行：
{{else}}
从光标处续写，补全完整的 SQL 语句：
{{/if}}
```

> 注意：模板中的 `{{#if ...}}` 是说明用途的注释逻辑，实际在 Rust 代码里通过字符串 replace 选择不同结尾文字，不需要模板引擎。

**实际文件内容（无条件分支，改为用 `{{MODE_INSTRUCTION}}` 占位）：**

```
你是 SQL 补全引擎。只输出补全内容，不加任何解释、不加代码块标记、不重复光标前已有的内容。

数据库方言: {{DIALECT}}

Schema 信息:
{{SCHEMA}}

历史 SQL 参考（最近执行过的查询）:
{{HISTORY}}

当前编辑器内容（<cursor> 表示光标位置）:
{{SQL_BEFORE}}<cursor>{{SQL_AFTER}}

{{MODE_INSTRUCTION}}
```

**Step 2: 验证文件存在**

```bash
ls prompts/
```

期望输出中包含 `sql_inline_complete.txt`

**Step 3: Commit**

```bash
git add prompts/sql_inline_complete.txt
git commit -m "feat(prompts): add sql_inline_complete prompt template"
```

---

### Task 2: 在 db/mod.rs 中新增 get_best_llm_config

**Files:**
- Modify: `src-tauri/src/db/mod.rs`（在 `get_default_llm_config` 函数之后添加）

**背景：** `get_default_llm_config()` 只返回 `is_default=1` 的配置，不检查 `test_status`。我们需要按优先级选取：① 默认且通过 → ② 任意通过 → ③ None。

**Step 1: 在 `get_default_llm_config` 函数之后（约 573 行）添加新函数**

在 `pub fn get_default_llm_config()` 函数结束后（`}` 之后）插入：

```rust
/// 选取最优可用 LLM 配置：① is_default=1 且 test_status='success' → ② 任意 test_status='success' → ③ None
pub fn get_best_llm_config() -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    // 优先：默认且通过
    let raw = conn.query_row(
        &format!("{} WHERE is_default = 1 AND test_status = 'success' LIMIT 1", LLM_CONFIG_SELECT),
        [],
        |row| row_to_llm_config_raw(row),
    ).optional()?;
    if let Some(r) = raw {
        return Ok(Some(decrypt_llm_config(r)?));
    }
    // 次选：任意通过
    let raw = conn.query_row(
        &format!("{} WHERE test_status = 'success' LIMIT 1", LLM_CONFIG_SELECT),
        [],
        |row| row_to_llm_config_raw(row),
    ).optional()?;
    match raw {
        Some(r) => Ok(Some(decrypt_llm_config(r)?)),
        None => Ok(None),
    }
}
```

**Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：`warning: ...` 结尾，无 `error`

**Step 3: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add get_best_llm_config with fallback priority"
```

---

### Task 3: 在 llm/client.rs 中新增 inline_complete 方法

**Files:**
- Modify: `src-tauri/src/llm/client.rs`（在 `pub async fn chat` 之后添加）

**Step 1: 在 `chat_stream` 方法末尾（文件末 `}` 前）之前添加方法**

在 `client.rs` 的 `impl LlmClient {` 块内，`chat_stream` 方法后添加：

```rust
/// SQL 编辑器内联补全
pub async fn inline_complete(
    &self,
    sql_before: &str,
    sql_after: &str,
    schema_context: &str,
    history_context: &str,
    hint: &str,  // "single_line" | "multi_line"
    dialect: &str,
) -> AppResult<String> {
    let mode_instruction = if hint == "single_line" {
        "续写光标处，只补全当前行剩余部分，不换行："
    } else {
        "从光标处续写，补全完整的 SQL 语句："
    };

    let prompt = include_str!("../../../prompts/sql_inline_complete.txt")
        .replace("{{DIALECT}}", dialect)
        .replace("{{SCHEMA}}", schema_context)
        .replace("{{HISTORY}}", history_context)
        .replace("{{SQL_BEFORE}}", sql_before)
        .replace("{{SQL_AFTER}}", sql_after)
        .replace("{{MODE_INSTRUCTION}}", mode_instruction);

    let messages = vec![
        ChatMessage { role: "user".into(), content: prompt },
    ];
    self.chat(messages).await
}
```

**Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 `error`

**Step 3: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): add inline_complete method to LlmClient"
```

---

### Task 4: 在 commands.rs 中新增 ai_inline_complete 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `ai_diagnose_error` 或 `ai_optimize_sql` 之后添加）

**背景：** 已有 `build_llm_client()` 函数，它调用 `get_default_llm_config()`（不检查 test_status）。我们新增一个 `build_llm_client_best_effort()` 用于 inline complete，以及新命令本身。

**Step 1: 在 `build_llm_client()` 函数之后添加 `build_llm_client_best_effort()`**

在 `commands.rs` 中 `fn build_llm_client()` 函数结束 `}` 后插入：

```rust
fn build_llm_client_best_effort() -> AppResult<crate::llm::client::LlmClient> {
    let config = crate::db::get_best_llm_config()?
        .ok_or_else(|| crate::AppError::Other(
            "No connected AI model found. Please add and test one in Settings → AI Model.".into()
        ))?;
    let api_type = parse_api_type(&config.api_type);
    Ok(crate::llm::client::LlmClient::new(
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    ))
}
```

**Step 2: 在 `ai_diagnose_error` 命令之后添加 `ai_inline_complete` 命令**

找到 `commands.rs` 中 `ai_diagnose_error` 函数末尾后插入：

```rust
#[tauri::command]
pub async fn ai_inline_complete(
    connection_id: Option<i64>,
    sql_before: String,
    sql_after: String,
    schema_context: String,
    history_context: String,
    hint: String,
) -> AppResult<String> {
    // 静默：无可用配置时返回空字符串，不报错
    let client = match build_llm_client_best_effort() {
        Ok(c) => c,
        Err(_) => return Ok(String::new()),
    };

    let dialect = match connection_id {
        Some(id) if id > 0 => {
            crate::db::get_connection_config(id)
                .map(|c| c.driver)
                .unwrap_or_else(|_| "sql".to_string())
        }
        _ => "sql".to_string(),
    };

    // 超时 5 秒，超时返回空字符串
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.inline_complete(
            &sql_before,
            &sql_after,
            &schema_context,
            &history_context,
            &hint,
            &dialect,
        ),
    )
    .await;

    match result {
        Ok(Ok(text)) => Ok(text.trim().to_string()),
        _ => Ok(String::new()),
    }
}
```

**Step 3: 确认 `tokio` 已在依赖中**

```bash
grep -n "tokio" src-tauri/Cargo.toml
```

期望：有 `tokio` 行。如果没有，在 `[dependencies]` 中添加 `tokio = { version = "1", features = ["time"] }`（通常 Tauri 已依赖 tokio，只需确认 `time` feature）。

**Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -10
```

期望：无 `error`

**Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/Cargo.toml
git commit -m "feat(commands): add ai_inline_complete with best-effort LLM selection and 5s timeout"
```

---

### Task 5: 在 lib.rs 中注册新命令

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 `invoke_handler` 列表末尾（`commands::list_objects,` 之后）添加**

```rust
commands::ai_inline_complete,
```

**Step 2: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 `error`

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): register ai_inline_complete command"
```

---

### Task 6: 前端注册 InlineCompletionsProvider

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**背景知识：**
- Monaco 的 `registerInlineCompletionsProvider` 接受一个 `{ provideInlineCompletions, freeInlineCompletions }` 对象
- `provideInlineCompletions` 返回 `{ items: [{ insertText: string }] }`
- 需要 debounce（前端用 `setTimeout` 实现）；同时用 `token.isCancellationRequested` 检查是否被取消
- `schemaRef.current` 已有 Schema 信息；`queryHistory` 来自 `useQueryStore()`（组件已引用）

**Step 1: 在组件内添加 `queryHistory` 的引用**

找到 `index.tsx` 中这一行（约第 192-193 行）：

```typescript
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults } = useQueryStore();
```

修改为（添加 `queryHistory`）：

```typescript
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults,
          queryHistory } = useQueryStore();
```

**Step 2: 在 `useAiStore` 解构中添加 `configs`**

找到：

```typescript
  const { explainSql, isExplaining, optimizeSql, isOptimizing } = useAiStore();
```

修改为：

```typescript
  const { explainSql, isExplaining, optimizeSql, isOptimizing, configs } = useAiStore();
```

**Step 3: 新增 `inlineProviderRegistered` ref（与 `completionProviderRegistered` 并列）**

在 `completionProviderRegistered` 之后插入：

```typescript
  const inlineProviderRegistered = useRef(false);
```

**Step 4: 在 `handleEditorDidMount` 中，Schema 补全 provider 注册之后（约第 274 行 `});` 之后）添加 Inline provider**

```typescript
    // ---- AI Ghost Text Inline Completion ----
    if (!inlineProviderRegistered.current) {
      inlineProviderRegistered.current = true;

      // 构建 Schema 上下文字符串
      function buildSchemaContext(): string {
        const schema = schemaRef.current;
        if (!schema) return '';
        return schema.tables
          .map(t => `Table ${t.name}(${t.columns.map(c => `${c.name} ${c.data_type}`).join(', ')})`)
          .join('\n');
      }

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      monaco.languages.registerInlineCompletionsProvider('sql', {
        provideInlineCompletions: (model, position, _context, token) => {
          return new Promise((resolve) => {
            if (debounceTimer) clearTimeout(debounceTimer);

            debounceTimer = setTimeout(async () => {
              if (token.isCancellationRequested) {
                resolve({ items: [] });
                return;
              }

              // 选取可用 AI 配置（前端判断用于决定是否显示 loading，实际调用由 Rust 决定）
              const usableConfig =
                configs.find((c: { is_default: boolean; test_status: string }) => c.is_default && c.test_status === 'success') ??
                configs.find((c: { test_status: string }) => c.test_status === 'success') ??
                null;
              if (!usableConfig) {
                resolve({ items: [] });
                return;
              }

              // 光标前/后文本
              const fullText = model.getValue();
              const offset = model.getOffsetAt(position);
              const sqlBefore = fullText.slice(0, offset).slice(-2000);
              const sqlAfter = fullText.slice(offset).slice(0, 500);

              // 自适应粒度
              const lineContentBeforeCursor = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
              const hint = lineContentBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';

              // 历史 SQL（最近 5 条）
              const historyContext = queryHistory
                .slice(0, 5)
                .map((h: { sql: string }) => h.sql)
                .join('\n---\n');

              const schemaContext = buildSchemaContext();

              try {
                const result = await invoke<string>('ai_inline_complete', {
                  connectionId: activeConnectionId,
                  sqlBefore,
                  sqlAfter,
                  schemaContext,
                  historyContext,
                  hint,
                });

                if (token.isCancellationRequested || !result) {
                  resolve({ items: [] });
                  return;
                }

                resolve({
                  items: [{
                    insertText: result,
                    range: {
                      startLineNumber: position.lineNumber,
                      startColumn: position.column,
                      endLineNumber: position.lineNumber,
                      endColumn: position.column,
                    },
                  }],
                });
              } catch {
                resolve({ items: [] });
              }
            }, 600);
          });
        },
        freeInlineCompletions: () => {},
      });
    }
```

**Step 5: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

如有类型错误：
- `configs` 的元素类型是 `LlmConfig`（来自 `../../types`），可以将 `(c: { is_default: boolean; test_status: string })` 替换为直接引用 `LlmConfig` 类型
- `queryHistory` 的元素类型是 `QueryHistory`，确认 `.sql` 字段存在

**Step 6: 手动测试**

1. `npm run tauri:dev` 启动应用
2. 设置中确认有一个连通性通过的 AI 配置
3. 打开 SQL 编辑器，连接数据库
4. 输入 `SELECT * FR`，等待约 600ms
5. 期望：光标后出现灰色 ghost text（如 `OM users`）
6. 按 `Tab` 接受，按 `Esc` 拒绝

无 AI 配置时：
- 删除或将配置测试状态改为未测试
- 输入 SQL 停顿 → 不应有任何 ghost text 或报错

**Step 7: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(editor): add AI ghost text inline completion with debounce and schema/history context"
```

---

## 验收标准

- [ ] 有通过的 AI 配置时：输入 SQL 停顿 600ms 后出现 ghost text
- [ ] `Tab` 接受 ghost text，`Esc` 拒绝
- [ ] 行中间输入 → single_line 模式（单行补全）
- [ ] 空行输入 → multi_line 模式（完整 SQL）
- [ ] 无可用 AI 配置时 → 静默，无错误提示
- [ ] AI 响应超时（>5s）→ 无 ghost text，编辑器正常可用
- [ ] `npx tsc --noEmit` 无错误
- [ ] `cargo check` 无错误
