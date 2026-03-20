# SQL 编辑器 AI Ghost Text 补全 — 设计文档

**日期：** 2026-03-21
**状态：** 已批准
**关联草稿：** `docs/plans/2026-03-12-sql-editor-ai-ghost-text.md`

---

## 目标

在 Monaco SQL 编辑器中实现类似 Cursor / GitHub Copilot 的内联 AI Ghost Text 补全：停止输入 600ms 后自动触发，Tab 接受，Esc / 继续输入拒绝。补全语言跟随上下文（SQL 补 SQL，中文注释补中文，英文注释补英文）。

---

## 架构概览

```
用户停止输入 600ms
    ↓ 触发条件检查（前端）
    ↓
Monaco InlineCompletionsProvider（MainContent/index.tsx）
    ↓ invoke('ai_inline_complete', { connectionId, sqlBefore, sqlAfter,
    ↓                                schemaContext, historyContext, hint })
    ↓
Rust ai_inline_complete 命令（commands.rs）
    ├─ crate::db::get_best_llm_config()  → db/mod.rs
    ├─ dialect 从 connection_id 查询（db::get_connection_config）
    ├─ 构建 Prompt（include_str! 嵌入 sql_inline_complete.txt）
    ├─ llm/client.rs inline_complete()
    └─ tokio::time::timeout(5s) → 超时返回 Ok("")
    ↓
前端接收结果
    ├─ token.isCancellationRequested / result == "" → 不显示
    └─ 有内容 → Monaco 渲染灰色 Ghost Text
         ├─ Tab → 接受插入
         └─ Esc / 继续输入 → 拒绝
```

---

## 触发规则（前端检查，全部满足才发起请求）

| 条件 | 说明 |
|------|------|
| 当前 Tab `ghostTextEnabled = true` | Tab 级开关开启 |
| 光标前内容（去空白）长度 ≥ 2 | 避免空文档无意义触发 |
| `tab.queryContext.connectionId` 存在 | 当前 Tab 有激活数据库连接（注意：用 Tab 自身的 connectionId，而非全局 `connectionStore.activeConnectionId`，支持多 Tab 不同连接场景） |
| 无文本选中 | `model.getSelection()` 为空或折叠状态 |

**注意：注释行（`--` 开头）也触发补全**，用户可能需要 AI 辅助补全注释内容。

---

## Debounce 实现方式

Monaco `InlineCompletionsProvider` 在每次光标移动时被调用，**不内置 debounce**。需在组件外部（`useRef` 或模块级闭包）维护一个 timer 引用：

```typescript
// MainContent/index.tsx — useRef 维护，注册时通过闭包引用
const inlineDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

// provideInlineCompletions 内部：
if (inlineDebounceTimer.current) clearTimeout(inlineDebounceTimer.current);
return new Promise((resolve) => {
  inlineDebounceTimer.current = setTimeout(async () => {
    if (token.isCancellationRequested) { resolve({ items: [] }); return; }
    // ... 触发条件检查 + invoke
  }, 600);
});
```

已在途的 Rust 请求（< 5s）会自然完成并被 `token.isCancellationRequested` 丢弃，不做额外取消（可接受的少量 API 浪费）。

---

## 开关设计（三层）

| 层级 | 存储位置 | 操作方 |
|------|----------|--------|
| 全局默认 | `ui_state` 表，key = `ghost_text_default`（复用已有 `get_ui_state` / `set_ui_state` 命令，无需新增 Rust 命令） | Settings 页面 |
| 当前 Tab 状态 | `queryStore` Tab 元数据（`tabs_metadata`，已有 SQLite 持久化） | 工具栏按钮 |
| 反序列化兜底 | 从 SQLite 加载旧 Tab 时，`ghostTextEnabled === undefined` → 读取全局默认值填充 | `queryStore.ts` |

**行为规则：**
- 新建 Tab → 读全局默认值（`get_ui_state('ghost_text_default')`）初始化 `ghostTextEnabled`，默认 `true`
- 切换 Tab → 工具栏按钮状态跟随目标 Tab 的 `ghostTextEnabled` 刷新
- 工具栏点击 → 只改当前 Tab，其他 Tab 不受影响
- Settings 修改全局默认 → 只影响**之后新建**的 Tab，已有 Tab 不变

---

## Prompt 模板（`prompts/sql_inline_complete.txt`）

该文件在编译时通过 `include_str!("../../../prompts/sql_inline_complete.txt")` 嵌入二进制，**不支持运行时修改**。

```
You are a SQL completion engine. Output ONLY the completion text.
No explanations, no code block markers, no repetition of existing content before the cursor.

Database dialect: {{DIALECT}}

Schema:
{{SCHEMA}}

Recent SQL history (for style reference):
{{HISTORY}}

Editor content (<cursor> marks the cursor position):
{{SQL_BEFORE}}<cursor>{{SQL_AFTER}}

{{MODE_INSTRUCTION}}

Language rule: Detect the language/context automatically.
- If completing SQL syntax → output SQL
- If completing a Chinese comment → output Chinese
- If completing an English comment → output English
- Match the style and language of the surrounding content exactly.
```

**占位符填充规则（Rust 端）：**

| 占位符 | 来源 | 截断 |
|--------|------|------|
| `{{DIALECT}}` | `db::get_connection_config(connection_id).driver`，无连接时 `"sql"` | — |
| `{{SCHEMA}}` | 前端传入 `schema_context`，为空时填 `"(none)"` | — |
| `{{HISTORY}}` | 前端传入 `history_context`，为空时填 `"(none)"` | — |
| `{{SQL_BEFORE}}` | 前端传入，取光标前最后 2000 字符 | 末尾 2000 字符 |
| `{{SQL_AFTER}}` | 前端传入，取光标后最多 500 字符 | 前 500 字符 |
| `{{MODE_INSTRUCTION}}` | 由 `hint` 参数决定（见下） | — |

**MODE_INSTRUCTION 值（前端判断，传 `hint` 参数）：**
- `hint = "single_line"`（光标所在行光标前有非空内容）→ `"Complete the current line only. Do not add a newline."`
- `hint = "multi_line"`（光标在空行）→ `"Complete the full SQL statement from the cursor position."`

`hint` 由前端根据 Monaco `model.getLineContent(position.lineNumber)` 判断：
```typescript
const lineBeforeCursor = model.getLineContent(position.lineNumber)
  .slice(0, position.column - 1);
const hint = lineBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';
```

---

## 文件变更地图

| 文件 | 操作 | 内容 |
|------|------|------|
| `prompts/sql_inline_complete.txt` | **新建** | Prompt 模板（编译时嵌入） |
| `src-tauri/src/db/mod.rs` | **修改** | 新增 `pub fn get_best_llm_config()` |
| `src-tauri/src/llm/client.rs` | **修改** | 新增 `pub async fn inline_complete()` |
| `src-tauri/src/commands.rs` | **修改** | 新增 `ai_inline_complete` 命令 |
| `src-tauri/src/lib.rs` | **修改** | 注册 `ai_inline_complete` 到 `generate_handler!` |
| `src/types/index.ts` | **修改** | `Tab` 接口新增 `ghostTextEnabled: boolean` |
| `src/store/queryStore.ts` | **修改** | 新增 `toggleGhostText(tabId)` action；新建 Tab 读全局默认；反序列化兜底 |
| `src/store/appStore.ts` | **修改** | 新增 `ghostTextDefault: boolean` 全局状态，启动时从 `get_ui_state('ghost_text_default')` 加载 |
| `src/components/MainContent/index.tsx` | **修改** | ① 工具栏开关按钮（Optimize 之后） ② 注册 `InlineCompletionsProvider` |
| `src/components/Settings/SettingsPage.tsx` | **修改** | 新增 Ghost Text 全局默认开关 UI（写 `set_ui_state('ghost_text_default', ...)` + 更新 appStore） |

---

## Rust 实现细节

### `get_best_llm_config()`（`src-tauri/src/db/mod.rs`）

位置：`get_default_llm_config()` 函数之后。

优先级查询逻辑：
1. `is_default = 1 AND test_status = 'success'`（默认且已通过测试）
2. `test_status = 'success'`（任意已通过测试）
3. 返回 `None`（静默，命令返回空串）

**`test_status = 'untested'` 的配置不参与 Ghost Text**（用户未验证过的配置不应自动消耗 API）。

```rust
pub fn get_best_llm_config() -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    // 1. 默认且通过
    let raw = conn.query_row(
        &format!("{} WHERE is_default = 1 AND test_status = 'success' LIMIT 1", LLM_CONFIG_SELECT),
        [], |row| row_to_llm_config_raw(row),
    ).optional()?;
    if let Some(r) = raw { return Ok(Some(decrypt_llm_config(r)?)); }
    // 2. 任意通过
    let raw = conn.query_row(
        &format!("{} WHERE test_status = 'success' LIMIT 1", LLM_CONFIG_SELECT),
        [], |row| row_to_llm_config_raw(row),
    ).optional()?;
    match raw {
        Some(r) => Ok(Some(decrypt_llm_config(r)?)),
        None => Ok(None),
    }
}
```

### `inline_complete()`（`src-tauri/src/llm/client.rs`）

```rust
pub async fn inline_complete(
    &self,
    sql_before: &str,
    sql_after: &str,
    schema_context: &str,
    history_context: &str,
    mode_instruction: &str,
    dialect: &str,
) -> AppResult<String> {
    let prompt = include_str!("../../../prompts/sql_inline_complete.txt")
        .replace("{{DIALECT}}", dialect)
        .replace("{{SCHEMA}}", if schema_context.is_empty() { "(none)" } else { schema_context })
        .replace("{{HISTORY}}", if history_context.is_empty() { "(none)" } else { history_context })
        .replace("{{SQL_BEFORE}}", sql_before)
        .replace("{{SQL_AFTER}}", sql_after)
        .replace("{{MODE_INSTRUCTION}}", mode_instruction);
    let messages = vec![ChatMessage { role: "user".into(), content: prompt }];
    self.chat(messages).await
}
```

### `ai_inline_complete`（`src-tauri/src/commands.rs`）

```rust
#[tauri::command]
pub async fn ai_inline_complete(
    connection_id: Option<i64>,
    sql_before: String,
    sql_after: String,
    schema_context: String,
    history_context: String,
    hint: String,  // "single_line" | "multi_line"
) -> AppResult<String> {
    // 无可用配置 → 静默返回空
    let config = match crate::db::get_best_llm_config()? {
        Some(c) => c,
        None => return Ok(String::new()),
    };

    // dialect 从连接配置查询
    let dialect = connection_id
        .and_then(|id| crate::db::get_connection_config(id).ok())
        .map(|c| c.driver)
        .unwrap_or_else(|| "sql".to_string());

    let mode_instruction = if hint == "single_line" {
        "Complete the current line only. Do not add a newline."
    } else {
        "Complete the full SQL statement from the cursor position."
    };

    let api_type = parse_api_type(&config.api_type);
    let client = crate::llm::client::LlmClient::new(
        config.api_key, Some(config.base_url), Some(config.model), Some(api_type),
    );

    // 5s 超时，超时返回空串
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.inline_complete(
            // 取最后 2000 个字符（按字符截断，避免 UTF-8 多字节字符边界 panic）
            &sql_before.chars().rev().take(2000).collect::<String>()
                .chars().rev().collect::<String>(),
            // 取前 500 个字符（同上，不能用字节索引）
            &sql_after.chars().take(500).collect::<String>(),
            &schema_context,
            &history_context,
            mode_instruction,
            &dialect,
        ),
    ).await {
        Ok(Ok(text)) => Ok(text.trim().to_string()),
        _ => Ok(String::new()),
    }
}
```

---

## 前端实现细节

### `Tab` 类型扩展（`src/types/index.ts`）

```typescript
interface Tab {
  // ... 现有字段
  ghostTextEnabled: boolean;  // 新增，新建时从全局默认初始化
}
```

### `queryStore.ts` 变更

1. **新增 `toggleGhostText(tabId: string)` action**（属于 queryStore，操作 Tab 级状态）
2. **新建 Tab 时**：读 `appStore.getState().ghostTextDefault` 初始化 `ghostTextEnabled`
3. **反序列化兜底**：`loadTabsFromStorage` 中，对 `ghostTextEnabled === undefined` 的 Tab，填入全局默认值

### `appStore.ts` 变更

新增：
```typescript
ghostTextDefault: boolean;   // 全局默认值，启动时从 get_ui_state('ghost_text_default') 加载，默认 true
```

### Schema 上下文来源（前端）

`schemaRef.current`（`MainContent/index.tsx` 中已有的 `useRef<FullSchemaInfo | null>`）转为字符串：

```typescript
function buildSchemaContext(): string {
  const schema = schemaRef.current;
  if (!schema) return '';
  return schema.tables
    .map(t => `Table ${t.name}(${t.columns.map(c => `${c.name} ${c.data_type}`).join(', ')})`)
    .join('\n');
}
```

**已知限制（可接受）：** `schemaRef` 由全局 `activeConnectionId` 更新（`MainContent/index.tsx:312-319`）。在多 Tab 不同连接场景下，若 Tab 切换未同步更新全局 `activeConnectionId`，Ghost Text 可能使用错误 Tab 的 schema 上下文。这不会引发崩溃或错误——LLM 仍能生成合理补全，只是 schema 提示可能不准确。当前实现中接受此限制，未来可通过 per-tab schema 缓存优化。

### 历史 SQL 上下文来源（前端）

```typescript
const { queryHistory } = useQueryStore();  // 已有，按需解构
const historyContext = queryHistory
  .slice(0, 5)
  .map(h => h.sql)
  .join('\n---\n');
```

### 工具栏按钮（`MainContent/index.tsx`）

位置：现有 Optimize 按钮之后。
- ✨ sparkle 图标，主题色 = 开启，灰色 = 关闭
- 点击 → `queryStore.toggleGhostText(activeTab.id)`
- 显示状态 → 读当前 Tab 的 `ghostTextEnabled`

### InlineCompletionsProvider 注册

```typescript
// 与 completionProviderRegistered 并列，useRef 控制只注册一次
if (!inlineProviderRegistered.current) {
  inlineProviderRegistered.current = true;
  const inlineDebounceTimer = { current: null as ReturnType<typeof setTimeout> | null };

  monaco.languages.registerInlineCompletionsProvider('sql', {
    provideInlineCompletions: (model, position, _context, token) => {
      return new Promise((resolve) => {
        if (inlineDebounceTimer.current) clearTimeout(inlineDebounceTimer.current);
        inlineDebounceTimer.current = setTimeout(async () => {
          // 1. 检查当前 Tab ghostTextEnabled
          // 2. 检查触发条件（字符数、连接、无选中）
          // 3. 构建上下文（schemaContext、historyContext、hint）
          // 4. invoke('ai_inline_complete', { ... })
          // 5. token.isCancellationRequested → resolve({ items: [] })
          // 6. result 为空 → resolve({ items: [] })
          // 7. 有内容 → resolve({ items: [{ insertText, range }] })
        }, 600);
      });
    },
    freeInlineCompletions: () => {},
  });
}
```

---

## 错误处理策略

**原则：Ghost Text 永远静默降级，绝不弹错误提示。**

| 场景 | 处理 |
|------|------|
| 无可用 AI 配置（无通过测试的配置） | Rust 返回 `""`，不显示 Ghost Text |
| `test_status = 'untested'` 的配置 | 不参与选择，视为无配置 |
| LLM 请求超时（> 5s） | Rust timeout 返回 `""` |
| LLM 返回 API 错误 | Rust catch → 返回 `""` |
| 用户继续输入（取消） | Monaco `token.isCancellationRequested` 丢弃结果 |
| Schema 未加载 | `schemaContext` 为空串，LLM 仅依赖 SQL 上下文 |
| `queryHistory` 为空 | `historyContext` 传空串，Rust 填 `"(none)"` |
| Ghost Text 开关关闭 | 前端直接 `resolve({ items: [] })`，不发请求 |
| Tab 切换时请求在途 | Monaco 销毁 editor 触发 cancellation token |
| 旧 Tab 反序列化无 `ghostTextEnabled` 字段 | 读全局默认值填充，非 `false` |

---

## 验收标准

**功能：**
- [ ] 输入 SQL 停顿 600ms → 出现灰色 Ghost Text
- [ ] `Tab` 接受，`Esc` / 继续输入 → 拒绝
- [ ] 光标所在行有内容 → 单行补全；空行 → 多行补全
- [ ] 中文注释行 → 补全中文；英文注释行 → 补全英文；SQL → 补全 SQL
- [ ] 注释行（`--` 开头）也正常触发补全
- [ ] 工具栏按钮切换当前 Tab，其他 Tab 不受影响
- [ ] 新建 Tab 继承全局默认值
- [ ] Settings 修改全局默认，仅影响新 Tab
- [ ] 重启后各 Tab Ghost Text 开关状态恢复（SQLite 持久化）
- [ ] 多 Tab 不同连接场景：各 Tab 独立使用自身 `queryContext.connectionId`

**健壮性：**
- [ ] 无通过测试的 AI 配置 → 无 Ghost Text，无报错
- [ ] LLM 超时 → 编辑器正常可用，无卡顿
- [ ] 快速连续输入 → debounce 生效，不发多余请求
- [ ] 旧版本升级（Tab 无 `ghostTextEnabled` 字段）→ 自动填入全局默认值（同时作为 `ghostTextDefault` 异步加载竞态的安全网）
- [ ] `cargo check` 无 error
- [ ] `npx tsc --noEmit` 无 error
