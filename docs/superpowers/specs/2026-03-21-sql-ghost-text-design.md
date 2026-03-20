# SQL 编辑器 AI Ghost Text 补全 — 设计文档

**日期：** 2026-03-21
**状态：** 已批准
**关联计划文档：** `docs/plans/2026-03-12-sql-editor-ai-ghost-text.md`（原始草稿，本文档为最终设计）

---

## 目标

在 Monaco SQL 编辑器中实现类似 Cursor / GitHub Copilot 的内联 AI Ghost Text 补全：停止输入 600ms 后自动触发，Tab 接受，Esc / 继续输入拒绝。补全语言跟随上下文（SQL 补 SQL，中文注释补中文，英文注释补英文）。

---

## 架构概览

```
用户停止输入 600ms
    ↓ 触发条件检查
    ↓
Monaco InlineCompletionsProvider（前端）
    ↓ invoke('ai_inline_complete', { ... })
    ↓
Rust ai_inline_complete 命令
    ├─ get_best_llm_config()
    ├─ 构建 Prompt（sql_inline_complete.txt）
    ├─ llm/client.rs inline_complete()
    └─ 5s timeout → ""
    ↓
前端接收结果
    ├─ token cancelled / result "" → 不显示
    └─ 有内容 → Monaco 渲染 Ghost Text
         ├─ Tab → 接受插入
         └─ Esc / 继续输入 → 拒绝
```

---

## 触发规则

前端在发起请求前检查全部条件，任一不满足则跳过：

| 条件 | 说明 |
|------|------|
| 当前 Tab `ghostTextEnabled = true` | 开关开启 |
| 光标前内容（去空白）长度 ≥ 2 | 避免无意义触发 |
| `activeConnectionId` 存在 | 有激活数据库连接 |
| 无文本选中 | 有选中区域时不触发 |

注意：**注释行也触发补全**（用户可能懒得写注释，需要补全辅助）。

---

## 开关设计（三层）

| 层级 | 存储 | 说明 |
|------|------|------|
| 全局默认 | `app_settings.ghost_text_enabled`（SQLite） | Settings 页面配置，新 Tab 继承此值 |
| 当前 Tab 状态 | `queryStore` Tab 元数据（已有 SQLite 持久化） | 每个 Tab 独立，重启后恢复 |
| 工具栏按钮 | 读写当前 Tab 的 `ghostTextEnabled` 字段 | 只影响当前 Tab |

**行为规则：**
- 新建 Tab → 读全局默认值初始化 `ghostTextEnabled`
- 切换 Tab → 工具栏按钮状态跟随目标 Tab 的值刷新
- 工具栏点击 → 只改当前 Tab，其他 Tab 不受影响
- Settings 修改全局默认 → 只影响之后新建的 Tab，已有 Tab 不变

---

## Prompt 模板（`prompts/sql_inline_complete.txt`）

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

**MODE_INSTRUCTION 填充规则（Rust 端）：**
- 光标所在行有非空内容 → `"Complete the current line only. Do not add a newline."`
- 光标在空行 → `"Complete the full SQL statement from the cursor position."`

**上下文截断规则（Rust 端）：**
- `SQL_BEFORE`：最多取光标前 2000 字符（取末尾部分）
- `SQL_AFTER`：最多取光标后 500 字符
- `SCHEMA`：为空时填 `"(none)"`
- `HISTORY`：最近 5 条，为空时填 `"(none)"`

---

## 文件变更地图

| 文件 | 操作 | 内容 |
|------|------|------|
| `prompts/sql_inline_complete.txt` | 新建 | Prompt 模板 |
| `src-tauri/src/db/mod.rs` | 修改 | 新增 `get_best_llm_config()` |
| `src-tauri/src/llm/client.rs` | 修改 | 新增 `inline_complete()` 方法 |
| `src-tauri/src/commands.rs` | 修改 | 新增 `ai_inline_complete` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册 `ai_inline_complete` |
| `src/store/queryStore.ts` | 修改 | Tab 类型新增 `ghostTextEnabled` 字段 |
| `src/store/appStore.ts` | 修改 | 新增 `ghostTextEnabled` 全局状态 + `toggleGhostText()` |
| `src/components/MainContent/index.tsx` | 修改 | ① 工具栏开关按钮 ② 注册 `InlineCompletionsProvider` |
| `src/components/Settings/AppSettings.tsx` | 修改 | 新增全局默认开关 UI |

---

## Rust 实现细节

### `get_best_llm_config()`（`db/mod.rs`）

优先级：
1. `is_default = 1 AND test_status = 'success'`
2. `test_status = 'success'`（任意通过）
3. 返回 `None`

### `inline_complete()`（`llm/client.rs`）

```rust
pub async fn inline_complete(
    &self,
    sql_before: &str,
    sql_after: &str,
    schema_context: &str,
    history_context: &str,
    mode_instruction: &str,
    dialect: &str,
) -> AppResult<String>
```

读取 `prompts/sql_inline_complete.txt`（`include_str!`），替换占位符，调用 `self.chat(messages)` 返回结果。

### `ai_inline_complete`（`commands.rs`）

```rust
#[tauri::command]
pub async fn ai_inline_complete(
    connection_id: Option<i64>,
    sql_before: String,
    sql_after: String,
    schema_context: String,
    history_context: String,
    hint: String,  // "single_line" | "multi_line"
) -> AppResult<String>
```

- 无可用配置 → `Ok(String::new())`（静默）
- `tokio::time::timeout(5s, ...)` → 超时返回 `Ok(String::new())`
- 结果 `.trim().to_string()` 后返回

---

## 前端实现细节

### Tab 类型扩展（`queryStore.ts`）

```typescript
interface Tab {
  // ... 现有字段
  ghostTextEnabled: boolean;  // 新增
}
```

新建 Tab 时从全局 `appStore.ghostTextEnabled` 读取初始值。

### 工具栏按钮（`MainContent/index.tsx`）

位置：现有 Optimize 按钮之后，使用 ✨ sparkle 图标：
- 亮色（主题色）= 开启
- 暗色（灰色）= 关闭
- 点击 → `queryStore.toggleGhostText(activeTabId)`

### InlineCompletionsProvider 注册

```typescript
// 触发条件全部满足后，600ms debounce 发起请求
monaco.languages.registerInlineCompletionsProvider('sql', {
  provideInlineCompletions: async (model, position, _context, token) => {
    // 1. 检查开关
    // 2. 检查触发条件（字符数、连接、选中）
    // 3. 600ms debounce
    // 4. invoke('ai_inline_complete', { ... })
    // 5. token.isCancellationRequested → 丢弃
    // 6. 返回 { items: [{ insertText, range }] }
  },
  freeInlineCompletions: () => {},
});
```

---

## 错误处理策略

**原则：Ghost Text 永远静默降级，绝不弹错误提示。**

| 场景 | 处理 |
|------|------|
| 无可用 AI 配置 | Rust 返回 `""`，不显示 |
| LLM 请求超时（>5s） | Rust timeout 返回 `""` |
| LLM 返回 API 错误 | Rust catch → 返回 `""` |
| 用户继续输入（取消） | Monaco `token.isCancellationRequested` 丢弃 |
| Schema 未加载 | 传空串，LLM 仅依赖 SQL 上下文补全 |
| `queryHistory` 为空 | 传 `"(none)"` |
| Ghost Text 开关关闭 | 前端直接跳过，不发起请求 |
| Tab 切换时请求在途 | Monaco 销毁 editor 触发 cancellation |

---

## 验收标准

**功能：**
- [ ] 输入 SQL 停顿 600ms → 出现灰色 Ghost Text
- [ ] `Tab` 接受，`Esc` / 继续输入 → 拒绝
- [ ] 行中有内容 → 单行补全；空行 → 多行补全
- [ ] 中文注释 → 补全中文；英文注释 → 补全英文；SQL → 补全 SQL
- [ ] 注释行（`--` 开头）也正常触发补全
- [ ] 工具栏按钮切换当前 Tab 状态，其他 Tab 不受影响
- [ ] 新建 Tab 继承全局默认值
- [ ] Settings 修改全局默认，仅影响新 Tab
- [ ] 重启后各 Tab Ghost Text 开关状态恢复

**健壮性：**
- [ ] 无 AI 配置 → 无 Ghost Text，无报错
- [ ] LLM 超时 → 编辑器正常可用，无卡顿
- [ ] 快速连续输入 → 不发起多余请求（debounce 生效）
- [ ] `cargo check` 无 error
- [ ] `npx tsc --noEmit` 无 error
