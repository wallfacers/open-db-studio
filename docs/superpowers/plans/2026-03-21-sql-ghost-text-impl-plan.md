<!-- STATUS: ❌ 未实现 -->
# SQL 编辑器 AI Ghost Text 补全 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Monaco SQL 编辑器中实现 AI Ghost Text 内联补全，停止输入 600ms 触发，Tab 接受，Esc 拒绝，支持 Tab 级开关持久化。

**Architecture:** 前端 Monaco `InlineCompletionsProvider` debounce 600ms 后调用 Rust `ai_inline_complete` 命令；Rust 层自动选取最优 LLM（默认+通过 > 任意通过 > 静默返回空），5s 超时保护；开关三层设计：全局默认（SQLite `ui_state`）→ Tab 级状态（`tabs_metadata`）→ 工具栏按钮实时切换。

**Tech Stack:** Rust / Tauri 2.x / tokio / rusqlite，React 18 / TypeScript / Monaco Editor / Zustand

**Spec:** `docs/superpowers/specs/2026-03-21-sql-ghost-text-design.md`

---

## Chunk 1: Rust 后端

### Task 1: 新建 Prompt 模板文件

**Files:**
- Create: `prompts/sql_inline_complete.txt`

- [ ] **Step 1: 创建 Prompt 模板文件**

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

- [ ] **Step 2: 验证文件存在**

```bash
ls prompts/
```

预期：输出中含 `sql_inline_complete.txt`

- [ ] **Step 3: Commit**

```bash
git add prompts/sql_inline_complete.txt
git commit -m "feat(prompts): add sql_inline_complete prompt template"
```

---

### Task 2: db/mod.rs — 新增 `get_best_llm_config()`

**Files:**
- Modify: `src-tauri/src/db/mod.rs`（在 `get_default_llm_config()` 函数结束的 `}` 之后插入，约第 650 行）

**背景：** 已有 `get_default_llm_config()`（仅取 `is_default=1`，不检查 `test_status`）。新函数按优先级选取：默认+通过 → 任意通过 → None。`test_status='untested'` 的配置不参与（用户未验证的配置不应消耗 API）。

内部辅助函数（`row_to_llm_config_raw`、`decrypt_llm_config`、`LLM_CONFIG_SELECT`）均已在该模块内定义，直接引用即可。

- [ ] **Step 1: 在 `get_default_llm_config()` 函数结束 `}` 之后插入新函数**

```rust
/// 选取最优可用 LLM 配置：
/// ① is_default=1 AND test_status='success'
/// ② 任意 test_status='success'
/// ③ None（test_status='untested' 不参与）
pub fn get_best_llm_config() -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    // 1. 默认且通过
    let raw = conn.query_row(
        &format!("{} WHERE is_default = 1 AND test_status = 'success' LIMIT 1", LLM_CONFIG_SELECT),
        [],
        |row| row_to_llm_config_raw(row),
    ).optional()?;
    if let Some(r) = raw {
        return Ok(Some(decrypt_llm_config(r)?));
    }
    // 2. 任意通过
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

- [ ] **Step 2: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：无输出（无 error）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add get_best_llm_config with success-only fallback priority"
```

---

### Task 3: llm/client.rs — 新增 `inline_complete()` 方法

**Files:**
- Modify: `src-tauri/src/llm/client.rs`（在 `impl LlmClient { }` 块内，`generate_sql` 方法之前插入）

**背景：** `impl LlmClient` 块从第 141 行开始，`chat()` 在第 241 行，`generate_sql()` 在第 249 行。新方法插入在 `generate_sql()` 之前。`include_str!` 路径相对于 `client.rs` 文件位置（`src-tauri/src/llm/client.rs`），`prompts/` 在根目录，路径为 `"../../../prompts/sql_inline_complete.txt"`，与现有其他 prompt 加载方式完全一致。

- [ ] **Step 1: 在 `generate_sql()` 方法之前（第 249 行之前）插入 `inline_complete()`**

找到 `client.rs` 中：
```rust
    pub async fn generate_sql(
```

在其之前插入：

```rust
    /// SQL 编辑器内联 Ghost Text 补全
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
            .replace(
                "{{SCHEMA}}",
                if schema_context.is_empty() { "(none)" } else { schema_context },
            )
            .replace(
                "{{HISTORY}}",
                if history_context.is_empty() { "(none)" } else { history_context },
            )
            .replace("{{SQL_BEFORE}}", sql_before)
            .replace("{{SQL_AFTER}}", sql_after)
            .replace("{{MODE_INSTRUCTION}}", mode_instruction);
        let messages = vec![ChatMessage { role: "user".into(), content: prompt }];
        self.chat(messages).await
    }

```

- [ ] **Step 2: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：无输出

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): add inline_complete method to LlmClient"
```

---

### Task 4: commands.rs + lib.rs — 新增 `ai_inline_complete` 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `ai_diagnose_error` 命令之后插入）
- Modify: `src-tauri/src/lib.rs`（在 `generate_handler![]` 列表中追加）

**背景：**
- `parse_api_type()` 已在 `commands.rs` 中定义，直接调用即可
- `crate::db::get_connection_config(id)` 返回 `AppResult<ConnectionConfig>`，其中 `.driver` 字段为方言字符串（`"mysql"` / `"postgres"` 等）
- `crate::db::get_best_llm_config()` 为 Task 2 新增函数
- UTF-8 安全截断：`sql_before` 取末尾 2000 字符（`.chars().rev().take(2000)...`），`sql_after` 取前 500 字符（`.chars().take(500)...`）

- [ ] **Step 1: 在 `commands.rs` 中找到 `ai_diagnose_error` 命令末尾 `}` 之后，插入新命令**

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
    // 无可用配置 → 静默返回空（不报错）
    let config = match crate::db::get_best_llm_config()? {
        Some(c) => c,
        None => return Ok(String::new()),
    };

    // dialect 从连接配置查询，无连接时降级为 "sql"
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
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    );

    // UTF-8 安全截断
    let sql_before_trunc = sql_before
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let sql_after_trunc = sql_after.chars().take(500).collect::<String>();

    // 5s 超时，超时返回空串
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.inline_complete(
            &sql_before_trunc,
            &sql_after_trunc,
            &schema_context,
            &history_context,
            mode_instruction,
            &dialect,
        ),
    )
    .await
    {
        Ok(Ok(text)) => Ok(text.trim().to_string()),
        _ => Ok(String::new()),
    }
}
```

- [ ] **Step 2: 在 `lib.rs` 的 `generate_handler![]` 列表中追加注册**

找到 `generate_handler![` 列表末尾 `]` 之前，追加：

```rust
        commands::ai_inline_complete,
```

- [ ] **Step 3: 完整编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

预期：无输出

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add ai_inline_complete command with 5s timeout and UTF-8 safe truncation"
```

---

## Chunk 2: 前端 Store 层

### Task 5: types/index.ts + queryStore.ts — Tab 类型扩展与 Ghost Text 状态

**Files:**
- Modify: `src/types/index.ts`（`Tab` 接口，第 122 行）
- Modify: `src/store/queryStore.ts`（`openQueryTab`、`loadTabsFromStorage`、新增 `toggleGhostText`）

**背景：**
- `Tab` 接口在 `src/types/index.ts:122`，不在 `queryStore.ts`
- `openQueryTab` 在 `queryStore.ts:224`，新建 Tab 时需加 `ghostTextEnabled`
- `loadTabsFromStorage` 在 `queryStore.ts:103`，反序列化时需兜底处理
- `appStore.useAppStore.getState().ghostTextDefault` 为 Task 6 新增，此处先用 `true` 兜底（Task 6 完成后即生效）

- [ ] **Step 1: 在 `src/types/index.ts` 的 `Tab` 接口末尾新增字段**

找到：
```typescript
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;
  metricScope?: MetricScope;
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;
  stJobId?: number;
  stConnectionId?: number;
}
```

改为（末尾追加一行）：
```typescript
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;
  metricScope?: MetricScope;
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;
  stJobId?: number;
  stConnectionId?: number;
  ghostTextEnabled?: boolean;  // 新增：Ghost Text 开关，undefined 时由 queryStore 兜底为全局默认值
}
```

- [ ] **Step 2: 在 `queryStore.ts` 的 `openQueryTab` 中，新建 Tab 时加入 `ghostTextEnabled`**

找到（约第 229 行）：
```typescript
      const tab: Tab = {
        id,
        type: 'query',
        title: `查询${queryCount}`,
        db: connName,
        queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
      };
```

改为：
```typescript
      const tab: Tab = {
        id,
        type: 'query',
        title: `查询${queryCount}`,
        db: connName,
        queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
        ghostTextEnabled: useAppStore.getState().ghostTextDefault ?? true,
      };
```

- [ ] **Step 3: 在 `queryStore.ts` 顶部导入 `useAppStore`（若未导入）**

在文件顶部的 import 区域，确认或新增：
```typescript
import { useAppStore } from './appStore';
```

- [ ] **Step 4: 在 `loadTabsFromStorage` 函数中，在 `return { tabs, activeTabId, sqlContent }` 语句紧前方插入兜底逻辑**

**重要：** 兜底必须放在 `return` 前，而非 `if (Array.isArray(parsed))` 之后——因为函数中还有一段 localStorage 迁移分支（约第 137-157 行）也会重新赋值 `tabs`，若插在 parsed 之后则迁移路径不会被覆盖。

找到 `loadTabsFromStorage` 函数末尾的 `return` 语句（在 `try` 块内）：
```typescript
    return { tabs, activeTabId: rawActiveId ?? '', sqlContent };
```

在其**正上方**插入：
```typescript
    // 反序列化兜底：旧 Tab（或 localStorage 迁移路径的 Tab）无 ghostTextEnabled 字段时，填入全局默认值
    // 注意：此处必须在 return 之前，以覆盖所有赋值路径（SQLite 路径 + localStorage 迁移路径）
    const ghostDefault = useAppStore.getState().ghostTextDefault ?? true;
    tabs = tabs.map(t => ({
      ...t,
      ghostTextEnabled: t.ghostTextEnabled ?? ghostDefault,
    }));
```

- [ ] **Step 5: 在 `queryStore.ts` 的 store 定义（`useQueryStore = create<QueryState>(...)`）中新增 `toggleGhostText` action**

在 `QueryState` interface 中新增类型声明（找到 interface 定义处，约第 40-75 行）：
```typescript
  toggleGhostText: (tabId: string) => void;
```

在 `create<QueryState>((set, get) => ({` 的实现中，在适当位置（如 `setActiveTabId` 之后）新增：
```typescript
  toggleGhostText: (tabId) => {
    set(s => ({
      tabs: s.tabs.map(t =>
        t.id === tabId ? { ...t, ghostTextEnabled: !(t.ghostTextEnabled ?? true) } : t
      ),
    }));
  },
```

- [ ] **Step 6: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：无 error

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/store/queryStore.ts
git commit -m "feat(store): add ghostTextEnabled to Tab type and toggleGhostText action in queryStore"
```

---

### Task 6: appStore.ts — 全局默认值状态

**Files:**
- Modify: `src/store/appStore.ts`

**背景：** 现有 `appStore` 结构参考 `autoMode` + `initAutoMode` 模式。`ghostTextDefault` 从 `ui_state` 表读取（复用现有 `get_ui_state` / `set_ui_state` 命令），key = `ghost_text_default`，默认值 `true`。

- [ ] **Step 1: 在 `AppState` interface 中新增字段和方法**

找到：
```typescript
interface AppState {
  lastOperationContext: OperationContext | null;
  setLastOperationContext: (ctx: OperationContext | null) => void;
  isAssistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  autoMode: boolean;
  setAutoMode: (enabled: boolean) => void;
  initAutoMode: () => Promise<void>;
}
```

改为（末尾追加三行）：
```typescript
interface AppState {
  lastOperationContext: OperationContext | null;
  setLastOperationContext: (ctx: OperationContext | null) => void;
  isAssistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  autoMode: boolean;
  setAutoMode: (enabled: boolean) => void;
  initAutoMode: () => Promise<void>;
  ghostTextDefault: boolean;
  setGhostTextDefault: (enabled: boolean) => Promise<void>;
  initGhostTextDefault: () => Promise<void>;
}
```

- [ ] **Step 2: 在 `useAppStore = create<AppState>((set) => ({` 实现中新增对应状态和方法**

在 `initAutoMode: async () => { ... },` 之后追加：

```typescript
  ghostTextDefault: true,
  setGhostTextDefault: async (enabled: boolean) => {
    set({ ghostTextDefault: enabled });
    try {
      await invoke('set_ui_state', { key: 'ghost_text_default', value: JSON.stringify(enabled) });
    } catch (e) {
      console.error('Failed to set ghost_text_default:', e);
    }
  },
  initGhostTextDefault: async () => {
    try {
      const raw = await invoke<string | null>('get_ui_state', { key: 'ghost_text_default' });
      if (raw !== null) {
        set({ ghostTextDefault: JSON.parse(raw) === true });
      }
      // raw 为 null 时保持默认值 true（首次启动）
    } catch (e) {
      console.error('Failed to get ghost_text_default:', e);
    }
  },
```

- [ ] **Step 3: 在应用启动时调用 `initGhostTextDefault`**

`initAutoMode` 实际在 `src/components/Assistant/index.tsx:108-110` 的 `useEffect` 中调用（非 App.tsx）：
```typescript
useEffect(() => {
  initAutoMode();
}, []);
```

在该 `useEffect` 中追加（注意从 `useAppStore` 解构 `initGhostTextDefault`，或直接用 `getState()` 调用）：
```typescript
useEffect(() => {
  initAutoMode();
  useAppStore.getState().initGhostTextDefault();
}, []);
```

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：无 error

- [ ] **Step 5: Commit**

```bash
git add src/store/appStore.ts src/components/Assistant/index.tsx
git commit -m "feat(store): add ghostTextDefault global state with SQLite persistence in appStore"
```

---

## Chunk 3: 前端 UI 层

### Task 7: SettingsPage.tsx — 全局默认开关

**Files:**
- Modify: `src/components/Settings/SettingsPage.tsx`（`AppearanceSection` 函数，约第 52 行）

**背景：** `AppearanceSection` 当前只有语言切换。在其末尾新增 Ghost Text 开关，风格与语言按钮一致（两个按钮 开/关）。使用 `useAppStore` 读写 `ghostTextDefault`。

- [ ] **Step 1: 在 `AppearanceSection` 中导入 `useAppStore`**

在 `SettingsPage.tsx` 顶部的 import 区域，添加：
```typescript
import { useAppStore } from '../../store/appStore';
```

- [ ] **Step 2: 在 `AppearanceSection` 函数体内新增 Ghost Text 状态读取**

在 `const [currentLang, ...` 之后追加：
```typescript
  const { ghostTextDefault, setGhostTextDefault } = useAppStore();
```

- [ ] **Step 3: 在语言切换 `</div>` 之后、`</div>` 关闭 `space-y-3` 之前，追加 Ghost Text 开关 UI**

找到（约第 85 行）：
```tsx
        </div>
      </div>
    </div>
  );
}
```

在第一个 `</div>` 之前插入：
```tsx
        <div>
          <p className="text-xs font-medium text-[#c8daea] mb-1">AI Ghost Text 补全</p>
          <p className="text-xs text-[#7a9bb8] mb-3">在 SQL 编辑器中自动提示 AI 补全内容（新建查询 Tab 的默认开关状态）</p>
          <div className="flex gap-2">
            {[
              { value: true, label: '开启' },
              { value: false, label: '关闭' },
            ].map(({ value, label }) => (
              <button
                key={String(value)}
                onClick={() => setGhostTextDefault(value)}
                className={`px-4 py-1.5 text-xs rounded transition-colors ${
                  ghostTextDefault === value
                    ? 'bg-[#003d2f] text-white border border-[#00c9a7]'
                    : 'text-[#7a9bb8] border border-[#2a3f5a] hover:text-[#c8daea] hover:border-[#2a3f5a]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
```

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：无 error

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/SettingsPage.tsx
git commit -m "feat(settings): add Ghost Text global default toggle in AppearanceSection"
```

---

### Task 8: MainContent/index.tsx — 工具栏开关按钮

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**背景：**
- 工具栏 Format 按钮在第 809-813 行（最后一个工具栏按钮，紧跟 `<FileEdit>` 图标）
- Format 按钮后跟着 `</div>` 关闭工具栏左侧区域
- Ghost Text 按钮插在 Format 之后、`</div>` 之前
- 使用 `Sparkles` 图标（lucide-react）
- 当前 Tab 的 `ghostTextEnabled` 从 `activeTabObj` 读取
- 点击调用 `queryStore.toggleGhostText(activeTab)`

- [ ] **Step 1: 在 import 区域确认或新增 `Sparkles` 图标**

找到 `lucide-react` import 行（如 `import { FileEdit, ... } from 'lucide-react'`），追加 `Sparkles`：
```typescript
import { ..., Sparkles } from 'lucide-react';
```

- [ ] **Step 2: 确认 `queryStore` 解构中包含 `toggleGhostText`**

找到（约第 192-195 行）：
```typescript
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults,
          queryHistory } = useQueryStore();
```

追加 `toggleGhostText`：
```typescript
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults,
          queryHistory, toggleGhostText } = useQueryStore();
```

- [ ] **Step 3: 在 Format 按钮之后插入 Ghost Text 开关按钮**

找到（约第 809-814 行）：
```tsx
                <Tooltip content={t('mainContent.formatSql')}>
                  <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" onClick={handleFormat}>
                    <FileEdit size={16} />
                  </button>
                </Tooltip>
              </div>
```

在 Format `</Tooltip>` 之后、`</div>` 之前插入：
```tsx
                <Tooltip content={(activeTabObj?.ghostTextEnabled ?? true) ? 'AI Ghost Text 补全（已开启）' : 'AI Ghost Text 补全（已关闭）'}>
                  <button
                    className={`p-1.5 rounded transition-colors ${
                      (activeTabObj?.ghostTextEnabled ?? true)
                        ? 'text-[#00c9a7] hover:text-[#00e4c0] hover:bg-[#1e2d42]'
                        : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'
                    }`}
                    onClick={() => toggleGhostText(activeTab)}
                  >
                    <Sparkles size={16} />
                  </button>
                </Tooltip>
```

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：无 error

- [ ] **Step 5: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(editor): add Ghost Text toggle button in toolbar after Format button"
```

---

### Task 9: MainContent/index.tsx — 注册 InlineCompletionsProvider

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**背景：**
- `schemaRef`（第 239 行）、`activeConnectionId`（第 215 行，全局连接 ID）、`activeTabObj` 均已在组件内可用
- `queryHistory` 已在 Task 8 解构
- `completionProviderRegistered` ref 在第 322 行，`inlineProviderRegistered` 与其并列新增
- 触发条件：`ghostTextEnabled`、光标前 ≥ 2 字符（去空白）、`tab.queryContext.connectionId` 存在、无选中
- debounce：组件级闭包 `inlineDebounceTimer` 对象（`{ current: null }`），不用 `useRef`（在 `handleEditorDidMount` 闭包内维护）
- Provider 注册位于 `handleEditorDidMount` 内，`completionProviderRegistered` 注册块之后

- [ ] **Step 1: 在 `completionProviderRegistered` ref 声明之后新增两个 ref**

找到（约第 322 行）：
```typescript
  const completionProviderRegistered = useRef(false);
```

在之后插入（两个 ref 相邻声明）：
```typescript
  const inlineProviderRegistered = useRef(false);
  const inlineDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

注意：`inlineDebounceTimer` 使用 `useRef` 而非闭包局部对象，确保跨渲染周期持有同一个 timer 引用，组件重挂载时也能正确 clearTimeout。

- [ ] **Step 2: 在 `handleEditorDidMount` 内，Schema 补全 Provider 注册块结束后（`completionProviderRegistered.current = true;` 块的最后一个 `});` 之后），追加 InlineCompletionsProvider 注册**

```typescript
    // ─── AI Ghost Text Inline Completion Provider ───────────────────────────
    if (!inlineProviderRegistered.current) {
      inlineProviderRegistered.current = true;

      // Schema 上下文构建
      // 注意：inlineDebounceTimer 已在组件顶层用 useRef 声明，此处通过闭包引用，无需重新创建
      function buildSchemaContext(): string {
        const schema = schemaRef.current;
        if (!schema) return '';
        return schema.tables
          .map(t =>
            `Table ${t.name}(${t.columns.map(c => `${c.name} ${c.data_type}`).join(', ')})`
          )
          .join('\n');
      }

      monaco.languages.registerInlineCompletionsProvider('sql', {
        provideInlineCompletions: (model, position, _context, token) => {
          return new Promise((resolve) => {
            if (inlineDebounceTimer.current) clearTimeout(inlineDebounceTimer.current);

            inlineDebounceTimer.current = setTimeout(async () => {
              try {
                // ── 1. 取当前 Tab（每次从 store 实时读取，避免闭包陈旧）
                const storeState = useQueryStore.getState();
                const currentActiveTabId = storeState.activeTabId;
                const currentTab = storeState.tabs.find(t => t.id === currentActiveTabId);

                // ── 2. 检查开关
                if (!(currentTab?.ghostTextEnabled ?? true)) {
                  resolve({ items: [] });
                  return;
                }

                // ── 3. 检查连接
                const tabConnectionId = currentTab?.queryContext?.connectionId;
                if (!tabConnectionId) {
                  resolve({ items: [] });
                  return;
                }

                // ── 4. 检查无选中
                const selection = model.getSelection();
                if (selection && !selection.isEmpty()) {
                  resolve({ items: [] });
                  return;
                }

                // ── 5. 检查光标前字符数（≥ 2 非空白）
                const offset = model.getOffsetAt(position);
                const fullText = model.getValue();
                const textBefore = fullText.slice(0, offset);
                if (textBefore.replace(/\s/g, '').length < 2) {
                  resolve({ items: [] });
                  return;
                }

                // ── 6. cancellation 检查（前置）
                if (token.isCancellationRequested) {
                  resolve({ items: [] });
                  return;
                }

                // ── 7. 构建上下文
                const sqlBefore = textBefore.slice(-4000); // 传前 4000 字节，Rust 再截 2000 字符
                const sqlAfter = fullText.slice(offset, offset + 1000);

                const lineBeforeCursor = model
                  .getLineContent(position.lineNumber)
                  .slice(0, position.column - 1);
                const hint = lineBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';

                const schemaContext = buildSchemaContext();
                const historyContext = storeState.queryHistory
                  .slice(0, 5)
                  .map(h => h.sql)
                  .join('\n---\n');

                // ── 8. 调用 Rust
                const result = await invoke<string>('ai_inline_complete', {
                  connectionId: tabConnectionId,
                  sqlBefore,
                  sqlAfter,
                  schemaContext,
                  historyContext,
                  hint,
                });

                // ── 9. cancellation 检查（后置）
                if (token.isCancellationRequested || !result) {
                  resolve({ items: [] });
                  return;
                }

                // ── 10. 返回补全项
                resolve({
                  items: [
                    {
                      insertText: result,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  ],
                });
              } catch {
                // 静默降级
                resolve({ items: [] });
              }
            }, 600);
          });
        },
        freeInlineCompletions: () => {},
      });
    }
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

常见类型问题处理：
- 若 `registerInlineCompletionsProvider` 类型不认识 → 确认 `@monaco-editor/react` 版本支持该 API（Monaco >= 0.31）
- 若 `items[].range` 类型报错 → 检查 `monaco.IRange` 的四个字段是否齐全（startLineNumber/startColumn/endLineNumber/endColumn），不要将 range 改为 `undefined`（`range` 在 Monaco 类型中是必填字段）

- [ ] **Step 4: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(editor): register AI InlineCompletionsProvider with debounce, trigger conditions, and schema/history context"
```

---

### Task 10: 集成验证

- [ ] **Step 1: 完整 Rust 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```

预期：`Finished` 无 error（warning 可接受）

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1
```

预期：无 error

- [ ] **Step 3: 启动应用**

```bash
npm run tauri:dev
```

- [ ] **Step 4: 验证 Ghost Text 基础功能**

1. Settings → Appearance，确认 "AI Ghost Text 补全" 开关显示，默认"开启"
2. 打开 SQL 编辑器，连接数据库
3. 输入 `SELECT * FR`，等待约 600ms
4. 预期：光标后出现灰色补全提示（如 `OM users`）
5. 按 `Tab` 接受，按 `Esc` 拒绝

- [ ] **Step 5: 验证注释行补全**

1. 输入 `-- 查询用`，等待 600ms
2. 预期：出现中文补全提示

- [ ] **Step 6: 验证工具栏开关**

1. 点击工具栏 ✨ 图标，变为灰色（关闭）
2. 输入 SQL 停顿 → 不应出现 Ghost Text
3. 再次点击，恢复主题色（开启）
4. 打开新 Tab，工具栏状态独立（不受刚才那个 Tab 影响）

- [ ] **Step 7: 验证 Tab 状态持久化**

1. 将某个 Tab 的 Ghost Text 关闭
2. 关闭并重启应用
3. 恢复该 Tab 后，Ghost Text 仍为关闭状态

- [ ] **Step 8: 验证无 AI 配置时静默**

1. 在 Settings → AI Model 中，将所有配置的测试状态改为未测试（或删除所有配置）
2. 输入 SQL 停顿 → 不出现 Ghost Text，不出现任何报错

- [ ] **Step 9: 最终 Commit**

```bash
git add .
git commit -m "test(ghost-text): verify Ghost Text integration end-to-end"
```
