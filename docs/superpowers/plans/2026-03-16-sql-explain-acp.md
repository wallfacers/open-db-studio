# SQL Explain ACP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 将 SQL 解释功能重构为 ACP Agent 流式模式，结果在结果区新增"SQL解释"Tab 中以 Markdown 格式实时展示。

**Architecture:**
- Rust 新增 `ai_explain_sql_acp`（Channel 流式）+ `cancel_explain_acp_session`，复用 `/mcp/optimize` 端点（相同 4 个只读工具）
- `queryStore` 新增 per-tab `explanationContent` + `explanationStreaming` 字段，流式内容 append 进去
- `MainContent` 结果区 Tab 栏新增"SQL解释"Tab，选中后渲染 Markdown（复用提取的共享组件）

**Tech Stack:** Rust (Tauri), TypeScript (React, Zustand), react-markdown, remark-gfm

---

## Chunk 1：Rust 后端

### Task 1：AppState + lib.rs 新增 explain_acp_session

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：state.rs 添加字段**

```rust
pub struct AppState {
    pub mcp_port: u16,
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
    pub optimize_acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    /// SQL 解释专用 ACP session（每次解释创建新 session，存储仅用于取消）
    pub explain_acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
}
```

- [ ] **Step 2：lib.rs AppState 初始化添加字段**

```rust
app.manage(crate::state::AppState {
    mcp_port,
    acp_session: tokio::sync::Mutex::new(None),
    current_editor_sql: tokio::sync::Mutex::new(None),
    optimize_acp_session: tokio::sync::Mutex::new(None),
    explain_acp_session: tokio::sync::Mutex::new(None),  // ← 新增
});
```

- [ ] **Step 3：cargo check**

---

### Task 2：AGENTS_EXPLAIN.md + ai_explain_sql_acp 命令

**Files:**
- Create: `src-tauri/assets/AGENTS_EXPLAIN.md`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：创建 AGENTS_EXPLAIN.md**

```markdown
你是数据库 SQL 分析专家。请对用户提供的 SQL 进行全面分析，生成一份 Markdown 格式的综合报告。

## 铁律

- 只输出 Markdown 报告，不输出 markdown 代码块之外的多余说明。
- 调用工具（list_tables、get_table_schema、get_table_sample）是内部分析过程，工具调用完成后直接输出报告。
- 不输出"我先查看…"等过渡语句。

## 分析流程

1. 调用 `list_tables` 获取当前库所有表
2. 对 SQL 中涉及的每张表，调用 `get_table_schema` 获取列定义、索引、外键
3. 对核心表调用 `get_table_sample` 感知数据规模（行数多少、数据分布）
4. 综合以上信息，生成报告

## 报告结构（必须包含以下所有章节）

### SQL 解析
用自然语言解释这条 SQL 的意图和执行逻辑。

### 涉及表与关联关系
列出涉及的表，说明表间关联方式（JOIN 条件、外键关系等）。如有 ER 关系，用文字描述。

### 潜在问题
指出 SQL 中存在的语法问题、逻辑隐患、数据类型不匹配等。若无问题，写"无明显问题"。

### 性能评估
评估当前查询是否最优：
- 是否存在全表扫描
- JOIN 顺序是否合理
- WHERE 条件是否能命中索引

### 优化建议
根据数据规模给出具体建议：

**数据规模小（< 10万行）时：**
- 可不建议创建索引，说明原因
- 给出查询改写建议（如有）

**数据规模大（≥ 10万行）时：**
- 给出索引建议，包含可直接执行的 DDL 语句（使用当前数据库类型的语法）
- 考虑其他优化方案：分区表、物化视图、查询改写、分页优化等

若当前 SQL 已是最优，明确说明。
```

- [ ] **Step 2：commands.rs 添加 ai_explain_sql_acp**

在 `cancel_optimize_acp_session` 后面添加以下两个函数：

```rust
/// SQL 解释：每次调用创建新 ACP session，流式输出 Markdown 报告，支持取消。
#[tauri::command]
pub async fn ai_explain_sql_acp(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = ai_explain_sql_acp_inner(sql, connection_id, database, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    let _ = channel.send(crate::llm::StreamEvent::Done);
    result
}

async fn ai_explain_sql_acp_inner(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;

    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into()),
    ).join("open-db-studio-explain");
    std::fs::create_dir_all(&cwd).ok();

    let agents_content = include_str!("../assets/AGENTS_EXPLAIN.md");
    if let Err(e) = std::fs::write(cwd.join("AGENTS.md"), agents_content) {
        log::warn!("[explain] Failed to write AGENTS.md: {}", e);
    }

    let conn_context = if let Some(conn_id) = connection_id {
        let driver = crate::db::get_connection_config(conn_id)
            .map(|c| c.driver)
            .unwrap_or_else(|_| "mysql".to_string());
        let db_line = match &database {
            Some(db) if !db.is_empty() => format!("当前数据库: {}\n", db),
            _ => String::new(),
        };
        format!("当前数据库连接 ID: {}\n数据库类型: {}\n{}\n", conn_id, driver, db_line)
    } else {
        String::new()
    };
    let prompt_text = format!("{}请分析以下 SQL：\n\n{}", conn_context, sql);

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<crate::llm::StreamEvent>();
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    {
        let mut guard = state.explain_acp_session.lock().await;
        if guard.is_some() {
            *guard = None;
            log::info!("[explain] Dropped previous explain session");
        }
    }

    // 复用 /mcp/optimize 端点（相同 4 个只读工具）
    let mcp_url = format!("http://127.0.0.1:{}/mcp/optimize", state.mcp_port);
    let new_session = crate::acp::session::spawn_acp_session_thread(
        config.api_key.clone(),
        config.base_url.clone(),
        config.model.clone(),
        config.api_type.clone(),
        config.preset.clone(),
        config.id,
        mcp_url,
        cwd.clone(),
        Some(event_tx.clone()),
    ).await?;

    let request_tx = new_session.request_tx.clone();
    {
        let mut guard = state.explain_acp_session.lock().await;
        *guard = Some(crate::state::PersistentAcpSession {
            config_id: new_session.config_id,
            config_fingerprint: String::new(),
            request_tx: new_session.request_tx,
        });
    }

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();
    request_tx
        .send(AcpRequest { prompt_text, event_tx, done_tx })
        .map_err(|_| AppError::Other("Explain ACP session closed unexpectedly".into()))?;

    let result = done_rx
        .await
        .map_err(|_| AppError::Other("Explain ACP session thread dropped before responding".into()))?;

    {
        let mut guard = state.explain_acp_session.lock().await;
        *guard = None;
    }

    result
}

#[tauri::command]
pub async fn cancel_explain_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut guard = state.explain_acp_session.lock().await;
    if guard.is_some() {
        *guard = None;
        log::info!("[explain] Session cancelled by user");
    }
    Ok(())
}
```

- [ ] **Step 3：lib.rs 注册新命令**

在 `commands::cancel_optimize_acp_session,` 后面添加：
```rust
commands::ai_explain_sql_acp,
commands::cancel_explain_acp_session,
```

- [ ] **Step 4：cargo check 无错误**

---

## Chunk 2：前端改造

### Task 3：提取共享 MarkdownContent 组件

**Files:**
- Create: `src/components/shared/MarkdownContent.tsx`
- Modify: `src/components/Assistant/index.tsx`

`MarkdownContent` 当前定义在 `Assistant/index.tsx` 内部（第 111-115 行附近），是个 local const。
需要提取为共享组件供 MainContent 复用。

- [ ] **Step 1：读取 Assistant/index.tsx 中 MarkdownContent 的完整实现**

读取文件，找到 `mdComponents`（大约第 20-110 行）和 `MarkdownContent` 组件（约 111-115 行），记录完整代码。

- [ ] **Step 2：创建 `src/components/shared/MarkdownContent.tsx`**

将 `mdComponents` 对象和 `MarkdownContent` 组件提取到新文件，添加 export：

```tsx
import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// mdComponents 从 Assistant/index.tsx 原样复制
const mdComponents = {
  // ... 原有实现
};

export const MarkdownContent: React.FC<{ content: string }> = memo(({ content }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
    {content}
  </ReactMarkdown>
));
```

- [ ] **Step 3：修改 Assistant/index.tsx，改为 import 共享组件**

删除 `Assistant/index.tsx` 中 `mdComponents` 和 `MarkdownContent` 的本地定义，改为：
```tsx
import { MarkdownContent } from '../shared/MarkdownContent';
```

---

### Task 4：queryStore 新增 explanation 字段

**Files:**
- Modify: `src/store/queryStore.ts`

- [ ] **Step 1：在 QueryState interface 中新增字段和方法**

在现有字段后新增：
```typescript
// SQL 解释（per-tab，流式内容）
explanationContent: Record<string, string>;
explanationStreaming: Record<string, boolean>;
setExplanationStreaming: (tabId: string, streaming: boolean) => void;
appendExplanationContent: (tabId: string, delta: string) => void;
clearExplanation: (tabId: string) => void;
```

- [ ] **Step 2：在 store 初始值中新增**

```typescript
explanationContent: {},
explanationStreaming: {},
```

- [ ] **Step 3：实现三个方法**

```typescript
setExplanationStreaming: (tabId, streaming) =>
  set((s) => ({ explanationStreaming: { ...s.explanationStreaming, [tabId]: streaming } })),

appendExplanationContent: (tabId, delta) =>
  set((s) => ({
    explanationContent: {
      ...s.explanationContent,
      [tabId]: (s.explanationContent[tabId] ?? '') + delta,
    },
  })),

clearExplanation: (tabId) =>
  set((s) => {
    const ec = { ...s.explanationContent };
    const es = { ...s.explanationStreaming };
    delete ec[tabId];
    delete es[tabId];
    return { explanationContent: ec, explanationStreaming: es };
  }),
```

---

### Task 5：aiStore 重构 explainSql 为流式 + 新增 cancel

**Files:**
- Modify: `src/store/aiStore.ts`

- [ ] **Step 1：修改 AiState interface**

将：
```typescript
explainSql: (sql: string, connectionId: number) => Promise<string>;
```
改为：
```typescript
explainSql: (
  sql: string,
  connectionId: number | null,
  database: string | null | undefined,
  tabId: string,
  onDelta: (delta: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
) => Promise<void>;
cancelExplainSql: () => Promise<void>;
```

- [ ] **Step 2：重写 explainSql 实现**

```typescript
explainSql: async (sql, connectionId, database, tabId, onDelta, onDone, onError) => {
  set({ isExplaining: true, error: null });
  try {
    const { Channel } = await import('@tauri-apps/api/core');
    const channel = new Channel<{
      type: 'ContentChunk' | 'ThinkingChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
      data?: { delta?: string; message?: string };
    }>();

    channel.onmessage = (event) => {
      if (event.type === 'ContentChunk' && event.data?.delta) {
        onDelta(event.data.delta);
      } else if (event.type === 'Done') {
        set({ isExplaining: false });
        onDone();
      } else if (event.type === 'Error') {
        set({ isExplaining: false, error: event.data?.message ?? 'Unknown error' });
        onError(event.data?.message ?? 'Unknown error');
      }
    };

    await invoke('ai_explain_sql_acp', {
      sql,
      connectionId,
      database: database ?? null,
      channel,
    });
  } catch (e) {
    set({ isExplaining: false, error: String(e) });
    onError(String(e));
  }
},
```

- [ ] **Step 3：添加 cancelExplainSql**

```typescript
cancelExplainSql: async () => {
  await invoke('cancel_explain_acp_session').catch(() => {});
  set({ isExplaining: false });
},
```

---

### Task 6：MainContent 结果区新增 SQL解释 Tab + 更新 handleExplain + 更新解释按钮

**Files:**
- Modify: `src/components/MainContent/index.tsx`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

这是最大的改动，分步完成。

- [ ] **Step 1：读取 MainContent/index.tsx，确认当前代码结构**

- [ ] **Step 2：在文件顶部添加 import**

```tsx
import { MarkdownContent } from '../shared/MarkdownContent';
```

- [ ] **Step 3：从 useQueryStore 引入 explanation 相关方法**

找到 `useQueryStore` 解构的地方，添加：
```typescript
const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
        removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults,
        explanationContent, explanationStreaming,
        appendExplanationContent, clearExplanation, setExplanationStreaming } = useQueryStore();
```

- [ ] **Step 4：从 useAiStore 引入 cancelExplainSql**

```typescript
const { explainSql, isExplaining, optimizeSql, isOptimizing, cancelOptimizeSql, cancelExplainSql } = useAiStore();
```

- [ ] **Step 5：添加 selectedResultPane state，替换 selectedResultIdx**

在 local state 声明处，将：
```typescript
const [selectedResultIdx, setSelectedResultIdx] = useState(0);
```
改为：
```typescript
const [selectedResultPane, setSelectedResultPane] = useState<number | 'explanation'>(0);
```

注意：凡是文件中用到 `selectedResultIdx` 的地方都要换成 `selectedResultPane`，并处理类型（`typeof selectedResultPane === 'number'` 时才用作数组索引）。

- [ ] **Step 6：移除旧 explanation state**

删除：
```typescript
const [explanation, setExplanation] = useState<string | null>(null);
```
（此 state 已由 queryStore 的 `explanationContent` 替代）

- [ ] **Step 7：重写 handleExplain**

```typescript
const handleExplain = async () => {
  const connId = activeTabObj?.queryContext?.connectionId ?? null;
  if (!currentSql.trim() || !connId) {
    showToast(t('mainContent.inputSqlAndSelectConnection'), 'warning');
    return;
  }
  const editor = editorRef.current;
  const selection = editor?.getSelection();
  const selectedSql =
    selection && !selection.isEmpty()
      ? editor!.getModel()?.getValueInRange(selection) ?? ''
      : '';
  const sqlToExplain = selectedSql.trim() ? selectedSql : currentSql;

  // 清空旧内容，切换到解释 Tab，开始流式
  clearExplanation(activeTab);
  setSelectedResultPane('explanation');
  setExplanationStreaming(activeTab, true);

  try {
    await explainSql(
      sqlToExplain,
      connId,
      activeTabObj?.queryContext?.database ?? null,
      activeTab,
      (delta) => appendExplanationContent(activeTab, delta),
      () => setExplanationStreaming(activeTab, false),
      (err) => {
        setExplanationStreaming(activeTab, false);
        showToast(err, 'error');
      },
    );
  } catch (e) {
    const ctx = buildErrorContext('ai_request', { rawError: String(e) });
    if (showError) showError(ctx.userMessage, ctx.markdownContext);
    else showToast(ctx.userMessage, 'error');
  }
};
```

- [ ] **Step 8：更新解释按钮（与优化按钮对称）**

找到当前的解释按钮（含 `isExplaining` 和 `Lightbulb` 的 Tooltip），替换为：

```tsx
{isExplaining ? (
  <Tooltip content={t('mainContent.stopExplaining')}>
    <button
      className="p-1.5 rounded transition-colors text-[#3794ff] hover:text-red-400 hover:bg-[#1e2d42] group"
      onClick={() => cancelExplainSql()}
    >
      <span className="block group-hover:hidden">
        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </span>
      <span className="hidden group-hover:block">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </button>
  </Tooltip>
) : (
  <Tooltip content={!currentSql.trim() ? '' : t('mainContent.explainSql')}>
    <button
      className={`p-1.5 rounded transition-colors ${!currentSql.trim() ? 'text-[#7a9bb8] cursor-not-allowed opacity-30' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
      onClick={handleExplain}
      disabled={!currentSql.trim() || !activeTabObj?.queryContext?.connectionId}
    >
      <Lightbulb size={16} />
    </button>
  </Tooltip>
)}
```

- [ ] **Step 9：重写结果区 Tab 栏，新增 SQL解释 Tab**

找到结果区 Tab 栏渲染（`{/* Result tabs */}` 那段），替换整个 Tab 栏：

```tsx
<div className="flex items-center bg-[#0d1117] border-b border-[#1e2d42] overflow-x-auto">
  {/* 结果集 Tabs */}
  {currentResults.length === 0 ? (
    <div
      className={`px-4 h-[38px] flex items-center text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${typeof selectedResultPane === 'number' ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
      onClick={() => setSelectedResultPane(0)}
    >
      {t('mainContent.resultSet')}
    </div>
  ) : (
    currentResults.map((result, idx) => (
      <div
        key={idx}
        className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultPane === idx ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
        onClick={() => setSelectedResultPane(idx)}
        onContextMenu={(e) => { e.preventDefault(); setResultContextMenu({ idx, x: e.clientX, y: e.clientY }); }}
      >
        <span>
          {result.kind === 'dml-report'
            ? `${t('mainContent.dmlReport')}（${result.rows.length}${t('mainContent.dmlReportCount')}）`
            : `${t('mainContent.resultSet')} ${idx + 1}`}
        </span>
        <Tooltip content={t('mainContent.closeResult')}>
          <span
            className="hover:bg-[#1e2d42] rounded p-0.5 leading-none"
            onClick={(e) => {
              e.stopPropagation();
              removeResult(activeTab, idx);
              if (typeof selectedResultPane === 'number' && selectedResultPane >= idx && selectedResultPane > 0)
                setSelectedResultPane((s) => typeof s === 'number' ? s - 1 : s);
            }}
          >✕</span>
        </Tooltip>
      </div>
    ))
  )}

  {/* SQL 解释 Tab（始终存在） */}
  <div
    className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultPane === 'explanation' ? 'bg-[#080d12] text-[#3794ff] border-t-[#3794ff]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
    onClick={() => setSelectedResultPane('explanation')}
  >
    {explanationStreaming[activeTab] ? (
      <svg className="animate-spin flex-shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    ) : (
      <Lightbulb size={11} className="flex-shrink-0" />
    )}
    <span>{t('mainContent.sqlExplanation')}</span>
  </div>
</div>
```

- [ ] **Step 10：在内容区（`<div className="flex-1 overflow-auto">`）末尾处理 explanation 面板**

结果区内容区目前只有一个 `<div className="flex-1 overflow-auto">` 渲染结果表格。
改为根据 `selectedResultPane` 决定渲染什么：

将 `<div className="flex-1 overflow-auto">` 的内容替换为：

```tsx
{selectedResultPane === 'explanation' ? (
  /* SQL 解释 Markdown 面板 */
  <div className="p-4 h-full overflow-auto">
    {explanationContent[activeTab] ? (
      <div className="prose prose-invert prose-sm max-w-none text-[#c8daea]">
        <MarkdownContent content={explanationContent[activeTab]} />
      </div>
    ) : explanationStreaming[activeTab] ? (
      <div className="text-[#7a9bb8] text-sm">{t('mainContent.analyzing')}</div>
    ) : (
      <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-sm gap-2">
        <Lightbulb size={32} className="opacity-20" />
        <span>{t('mainContent.clickToExplain')}</span>
      </div>
    )}
  </div>
) : (
  /* 原有结果表格内容，保持不变 */
  <>
    {isExecuting ? (
      <div className="p-4 text-gray-400 text-sm">{t('mainContent.executing')}</div>
    ) : error ? (
      /* ... 原有 error 渲染 ... */
    ) : currentResults.length === 0 ? (
      /* ... 原有空结果渲染 ... */
    ) : (
      /* ... 原有表格渲染 ... */
    )}
  </>
)}
```

**注意**：只包裹一层判断，不改动原有结果表格的任何内容。

- [ ] **Step 11：删除文件底部旧的"AI 解释面板"**

找到并删除：
```tsx
{/* AI 解释面板 */}
{explanation && (
  <div className="border-t ...">
    ...
  </div>
)}
```

- [ ] **Step 12：i18n 添加 key**

`zh.json` mainContent 内添加：
```json
"sqlExplanation": "SQL 解释",
"stopExplaining": "停止解释",
"clickToExplain": "点击 💡 开始解释 SQL",
"analyzing": "AI 正在分析..."
```

`en.json` mainContent 内添加：
```json
"sqlExplanation": "SQL Explain",
"stopExplaining": "Stop Explaining",
"clickToExplain": "Click 💡 to explain SQL",
"analyzing": "AI is analyzing..."
```

- [ ] **Step 13：TypeScript 类型检查（可用 npm run dev 验证，tsc --noEmit 也可）**

---

### Task 7：验证 + commit

- [ ] **Step 1：cargo check**

- [ ] **Step 2：npx tsc --noEmit（或启动 dev 确认无类型错误）**

- [ ] **Step 3：手动验证**

1. 打开 SQL 编辑器，输入查询语句
2. 点击 💡 按钮 → 自动切换到"SQL解释"Tab，开始流式展示 Markdown
3. 流式过程中按钮变蓝色 spinner，hover 变 X 可停止
4. 解释完成后报告完整展示
5. 切换到"结果集"Tab 仍正常显示查询结果
6. 新建/切换编辑器 Tab → 各 Tab 的解释内容独立

- [ ] **Step 4：commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/src/commands.rs \
        src-tauri/assets/AGENTS_EXPLAIN.md \
        src/components/shared/MarkdownContent.tsx \
        src/components/Assistant/index.tsx \
        src/store/queryStore.ts src/store/aiStore.ts \
        src/components/MainContent/index.tsx \
        src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(explain): ACP agent SQL analysis + streaming markdown tab"
```
