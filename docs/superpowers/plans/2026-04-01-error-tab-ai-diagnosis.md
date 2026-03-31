# SQL 执行错误 Tab 化 + AI 流式诊断 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQL 执行失败时以独立 tab（"错误日志 N"）展示错误信息，支持手动触发 AI 流式诊断并渲染 Markdown。

**Architecture:** 扩展 `QueryResult.kind` 新增 `'error'` 类型，改造 `executeQuery` 为逐条 try-catch 混排模式，新增 Rust 流式诊断命令 `agent_diagnose_error`，前端 `aiStore` 新增诊断流式状态管理，`MainContent` 渲染错误面板 + AI 诊断区域。

**Tech Stack:** React 18, TypeScript, Zustand, Tauri 2.x Channel API, Rust, opencode serve SSE

---

### Task 1: 扩展 QueryResult 类型

**Files:**
- Modify: `src/types/index.ts:49-58`

- [ ] **Step 1: 在 QueryResult 接口中添加 error kind 和 error_message 字段**

```typescript
export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  /** 前端附加：select=查询结果, dml-report=DML聚合报告, error=执行错误 */
  kind?: 'select' | 'dml-report' | 'error';
  /** 前端附加：产生该结果的原始 SQL */
  sql?: string;
  /** 前端附加：错误信息（仅 kind='error' 时存在） */
  error_message?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: extend QueryResult type with error kind"
```

---

### Task 2: 添加 i18n 翻译 key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: 在 zh.json 的 mainContent 区块中添加新 key**

在现有 `"aiDiagnosis"` 附近添加：

```json
"errorLog": "错误日志",
"aiDiagnoseBtn": "AI 诊断",
"sqlExecutionError": "SQL 执行错误",
"errorMessage": "错误信息",
"diagnosing": "诊断中..."
```

- [ ] **Step 2: 在 en.json 的 mainContent 区块中添加新 key**

```json
"errorLog": "Error Log",
"aiDiagnoseBtn": "AI Diagnosis",
"sqlExecutionError": "SQL Execution Error",
"errorMessage": "Error",
"diagnosing": "Diagnosing..."
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat: add i18n keys for error tab and AI diagnosis"
```

---

### Task 3: 重构 queryStore.executeQuery — 逐条 try-catch 混排

**Files:**
- Modify: `src/store/queryStore.ts:405-476`

这是核心变更。将 executeQuery 从"整体 try-catch"改为"逐条 try-catch"，错误结果作为 `kind: 'error'` 混入结果列表。

- [ ] **Step 1: 重写 executeQuery 方法**

将 `queryStore.ts` 第 405-476 行的 `executeQuery` 方法替换为：

```typescript
  executeQuery: async (connectionId, tabId, sqlOverride, database, schema) => {
    const sql = sqlOverride ?? get().sqlContent[tabId] ?? '';
    if (!sql.trim()) return;

    const statements = parseStatements(sql).map(s => s.text);

    // 写入操作上下文快照（供错误诊断使用）
    useAppStore.getState().setLastOperationContext({
      type: 'sql_execute',
      connectionId,
      database: database ?? undefined,
      schema: schema ?? undefined,
      sql,
    });

    set(s => ({ isExecuting: { ...s.isExecuting, [tabId]: true }, error: null, diagnosis: null }));

    // 逐条执行，按顺序收集成功/失败结果
    const orderedResults: QueryResult[] = [];
    const dmlBatch: { idx: number; stmt: string; result: QueryResult }[] = [];

    const flushDmlBatch = () => {
      if (dmlBatch.length === 0) return;
      if (dmlBatch.length === 1) {
        // 单条 DML 不聚合，保持原位
        orderedResults[dmlBatch[0].idx] = dmlBatch[0].result;
      } else {
        const totalDuration = dmlBatch.reduce((sum, r) => sum + r.result.duration_ms, 0);
        const dmlReport: QueryResult = {
          columns: ['#', '操作', 'SQL摘要', '影响行数', '耗时(ms)', '状态'],
          rows: dmlBatch.map((item, i) => [
            String(i + 1),
            getSqlType(item.stmt),
            truncateSql(item.stmt),
            String(item.result.row_count),
            String(item.result.duration_ms),
            '✓ 成功',
          ]),
          row_count: dmlBatch.reduce((sum, r) => sum + r.result.row_count, 0),
          duration_ms: totalDuration,
          kind: 'dml-report',
          sql: `-- DML batch (${dmlBatch.length} statements)`,
        };
        // 放在 batch 首位 index，后续位置标记为 null 待清理
        orderedResults[dmlBatch[0].idx] = dmlReport;
        for (let i = 1; i < dmlBatch.length; i++) {
          orderedResults[dmlBatch[i].idx] = null as unknown as QueryResult;
        }
      }
      dmlBatch.length = 0;
    };

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        const result = await invoke<QueryResult>('execute_query', {
          connectionId,
          sql: stmt,
          database: database ?? null,
          schema: schema ?? null,
        });
        const isSelect = isSelectLike(stmt) || result.columns.length > 0;
        const enriched: QueryResult = {
          ...result,
          sql: stmt,
          kind: isSelect ? 'select' : undefined,
        };
        if (isSelect) {
          flushDmlBatch();
          orderedResults[i] = enriched;
        } else {
          dmlBatch.push({ idx: i, stmt, result: enriched });
        }
      } catch (e) {
        flushDmlBatch();
        orderedResults[i] = {
          columns: [],
          rows: [],
          row_count: 0,
          duration_ms: 0,
          kind: 'error',
          sql: stmt,
          error_message: String(e),
        };
      }
    }
    flushDmlBatch();

    // 过滤掉 null 占位（被聚合的 DML）
    const finalList = orderedResults.filter(Boolean);

    set(s => ({
      results: { ...s.results, [tabId]: finalList },
      isExecuting: { ...s.isExecuting, [tabId]: false },
    }));
  },
```

关键变更说明：
- 每条 SQL 独立 try-catch，失败生成 `kind: 'error'` 结果
- 连续成功 DML 仍然聚合为 `dml-report`，但遇到 error 或 select 时先 flush
- 不再设置全局 `error` 状态（SQL 执行错误场景）
- 移除自动调用 `ai_diagnose_error` 的代码（原 472-474 行）

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无 error 相关类型错误（`error` 和 `diagnosis` 仍在 state 中保留，其他地方可能引用）

- [ ] **Step 3: Commit**

```bash
git add src/store/queryStore.ts
git commit -m "feat: refactor executeQuery to per-statement try-catch with error results"
```

---

### Task 4: Rust 端新增 agent_diagnose_error 流式命令

**Files:**
- Modify: `src-tauri/src/commands.rs` — 新增 `agent_diagnose_error` 函数
- Modify: `src-tauri/src/state.rs` — 新增 `current_diagnose_session_id` 字段
- Modify: `src-tauri/src/lib.rs` — 注册新命令 + 初始化新字段

- [ ] **Step 1: 在 state.rs 中添加 current_diagnose_session_id 字段**

在 `AppState` struct 中 `current_explain_session_id` 下方添加：

```rust
    /// 当前 SQL 错误诊断专用的 opencode session ID
    pub current_diagnose_session_id: tokio::sync::Mutex<Option<String>>,
```

- [ ] **Step 2: 在 lib.rs 中初始化新字段**

在 `app.manage(crate::state::AppState { ... })` 中（`current_explain_session_id` 行下方）添加：

```rust
                current_diagnose_session_id: tokio::sync::Mutex::new(None),
```

- [ ] **Step 3: 在 commands.rs 中添加 agent_diagnose_error 和 cancel_diagnose_error 命令**

在 `cancel_explain_sql` 函数之后添加：

```rust
#[tauri::command]
pub async fn agent_diagnose_error(
    sql: String,
    error_msg: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_diagnose_error_inner(sql, error_msg, connection_id, database, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    result
}

async fn agent_diagnose_error_inner(
    sql: String,
    error_msg: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let port = state.serve_port;

    // 1. 并发处理：若上次诊断仍在进行，先 abort 旧 session
    {
        let mut guard = state.current_diagnose_session_id.lock().await;
        if let Some(old_id) = guard.take() {
            log::info!("[agent_diagnose_error] Aborting previous diagnose session: {}", old_id);
            cleanup_temp_sql_session(port, &old_id).await;
        }
    }

    // 2. 获取当前 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    // 3. 构建 prompt_text
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
    let prompt_text = format!(
        "{}请诊断以下 SQL 执行错误：\n\nSQL:\n```sql\n{}\n```\n\n错误信息:\n```\n{}\n```\n\n请分析错误原因并给出修复建议。",
        conn_context, sql, error_msg
    );

    // 4. 创建临时 session
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let title = format!("sql-diagnose-{}", ts);
    let session_id = crate::agent::client::create_session(port, Some(&title)).await?;
    crate::db::insert_agent_session(&session_id, Some(&title), None, true)?;

    // 5. 存入 AppState
    {
        let mut guard = state.current_diagnose_session_id.lock().await;
        *guard = Some(session_id.clone());
    }

    // 6. 通过 /event SSE 流式输出
    let (model_str, provider_str) = apply_llm_config_to_opencode(&config, state).await;
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    let stream_result = crate::agent::stream::stream_global_events(
        port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        Some("sql-diagnose"),
        channel,
    )
    .await;

    // 7. 清理 session
    cleanup_temp_sql_session(port, &session_id).await;
    {
        let mut guard = state.current_diagnose_session_id.lock().await;
        if guard.as_deref() == Some(&session_id) {
            *guard = None;
        }
    }

    stream_result
}

#[tauri::command]
pub async fn cancel_diagnose_error(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let session_id = {
        let mut guard = state.current_diagnose_session_id.lock().await;
        guard.take()
    };
    if let Some(id) = session_id {
        log::info!("[cancel_diagnose_error] Cancelling diagnose session: {}", id);
        cleanup_temp_sql_session(state.serve_port, &id).await;
    }
    Ok(())
}
```

- [ ] **Step 4: 在 lib.rs 的 generate_handler![] 中注册新命令**

在 `commands::cancel_explain_sql,` 行（第 307 行）之后添加：

```rust
            commands::agent_diagnose_error,
            commands::cancel_diagnose_error,
```

- [ ] **Step 5: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: add agent_diagnose_error streaming command in Rust"
```

---

### Task 5: 前端 aiStore 新增诊断流式状态管理

**Files:**
- Modify: `src/store/aiStore.ts` — 新增 `diagnoseSqlError`, `cancelDiagnosis`, `clearDiagnosis` 及相关状态

- [ ] **Step 1: 在 aiStore 状态类型中添加诊断相关字段**

在 aiStore 的 state 类型定义中（`isExplaining` 附近）添加：

```typescript
  // SQL 错误诊断（per result, 流式内容）
  diagnosisContent: Record<string, string>;     // key -> 诊断内容
  diagnosisStreaming: Record<string, boolean>;   // key -> 是否正在流式输出

  diagnoseSqlError: (sql: string, errorMsg: string, connectionId: number | null, database: string | null, diagKey: string) => Promise<void>;
  cancelDiagnosis: (diagKey: string) => Promise<void>;
  clearDiagnosis: (diagKey: string) => void;
```

- [ ] **Step 2: 在 create() 初始值中添加默认值**

```typescript
  diagnosisContent: {},
  diagnosisStreaming: {},
```

- [ ] **Step 3: 实现 diagnoseSqlError 方法**

参考 `explainSql` 的模式，在 store 方法中添加：

```typescript
  diagnoseSqlError: async (sql, errorMsg, connectionId, database, diagKey) => {
    set(s => ({
      diagnosisContent: { ...s.diagnosisContent, [diagKey]: '' },
      diagnosisStreaming: { ...s.diagnosisStreaming, [diagKey]: true },
    }));
    try {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{
        type: 'ContentChunk' | 'ThinkingChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
        data?: { delta?: string; message?: string };
      }>();

      // RAF 缓冲
      let buffer = '';
      let rafPending = false;

      channel.onmessage = (event) => {
        if (!get().diagnosisStreaming[diagKey]) return;
        if (event.type === 'ContentChunk' && event.data?.delta) {
          buffer += event.data.delta;
          if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
              rafPending = false;
              if (buffer) {
                set(s => ({
                  diagnosisContent: {
                    ...s.diagnosisContent,
                    [diagKey]: (s.diagnosisContent[diagKey] ?? '') + buffer,
                  },
                }));
                buffer = '';
              }
            });
          }
        } else if (event.type === 'Done') {
          // flush remaining buffer
          if (buffer) {
            set(s => ({
              diagnosisContent: {
                ...s.diagnosisContent,
                [diagKey]: (s.diagnosisContent[diagKey] ?? '') + buffer,
              },
            }));
            buffer = '';
          }
          set(s => ({ diagnosisStreaming: { ...s.diagnosisStreaming, [diagKey]: false } }));
        } else if (event.type === 'Error') {
          const errMsg = event.data?.message ?? 'Unknown error';
          set(s => ({
            diagnosisContent: {
              ...s.diagnosisContent,
              [diagKey]: (s.diagnosisContent[diagKey] ?? '') + `\n\n**Error:** ${errMsg}`,
            },
            diagnosisStreaming: { ...s.diagnosisStreaming, [diagKey]: false },
          }));
        }
      };

      await invoke('agent_diagnose_error', {
        sql,
        errorMsg,
        connectionId,
        database,
        channel,
      });
    } catch (e) {
      const isCancelledError = String(e).includes('thread dropped') || String(e).includes('cancelled');
      if (!isCancelledError) {
        set(s => ({
          diagnosisContent: {
            ...s.diagnosisContent,
            [diagKey]: `**Error:** ${String(e)}`,
          },
        }));
      }
      set(s => ({ diagnosisStreaming: { ...s.diagnosisStreaming, [diagKey]: false } }));
    }
  },

  cancelDiagnosis: async (diagKey) => {
    await invoke('cancel_diagnose_error').catch(() => {});
    set(s => ({ diagnosisStreaming: { ...s.diagnosisStreaming, [diagKey]: false } }));
  },

  clearDiagnosis: (diagKey) => {
    set(s => {
      const { [diagKey]: _c, ...restContent } = s.diagnosisContent;
      const { [diagKey]: _s, ...restStreaming } = s.diagnosisStreaming;
      return { diagnosisContent: restContent, diagnosisStreaming: restStreaming };
    });
  },
```

- [ ] **Step 4: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/store/aiStore.ts
git commit -m "feat: add streaming AI diagnosis state management in aiStore"
```

---

### Task 6: MainContent — 错误 Tab 标题渲染 + 右键菜单

**Files:**
- Modify: `src/components/MainContent/index.tsx:1272-1297` (result tab 标题区域)

- [ ] **Step 1: 修改 result tab 标题渲染逻辑**

找到 `MainContent/index.tsx` 第 1280-1284 行，当前代码：

```tsx
                    <span>
                      {result.kind === 'dml-report'
                        ? `${t('mainContent.dmlReport')}（${result.rows.length}${t('mainContent.dmlReportCount')}）`
                        : `${t('mainContent.resultSet')} ${idx + 1}`}
                    </span>
```

替换为：

```tsx
                    <span>
                      {result.kind === 'dml-report'
                        ? `${t('mainContent.dmlReport')}（${result.rows.length}${t('mainContent.dmlReportCount')}）`
                        : result.kind === 'error'
                          ? `${t('mainContent.errorLog')} ${idx + 1}`
                          : `${t('mainContent.resultSet')} ${idx + 1}`}
                    </span>
```

- [ ] **Step 2: 给错误 tab 标题加上红色样式区分**

修改同区域的 tab className，在 `selectedResultPane === idx` 判断中，当 `result.kind === 'error'` 时使用红色边框：

找到第 1276 行 className 中的 `border-t-[#00c9a7]`，整行替换为：

```tsx
                    className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultPane === idx ? `bg-[#080d12] ${result.kind === 'error' ? 'text-red-400 border-t-red-400' : 'text-[#00c9a7] border-t-[#00c9a7]'}` : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
```

右键菜单无需额外修改 — 错误 tab 是 `currentResults` 数组中的普通元素，已有的 close/closeLeft/closeRight/closeOther/closeAll 逻辑天然适用。

- [ ] **Step 3: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat: render error tabs with title and red styling in result pane"
```

---

### Task 7: MainContent — 错误面板内容渲染 + AI 诊断 UI

**Files:**
- Modify: `src/components/MainContent/index.tsx` — 结果内容渲染区域

- [ ] **Step 1: 从 aiStore 中提取诊断状态**

在 MainContent 组件顶部（第 277 行 `useAiStore` 处），添加 `diagnoseSqlError`, `diagnosisContent`, `diagnosisStreaming`, `cancelDiagnosis`：

```tsx
  const { explainSql, isExplaining: isExplainingMap, cancelExplainSql,
          diagnoseSqlError, diagnosisContent: diagnosisContentMap, diagnosisStreaming: diagnosisStreamingMap, cancelDiagnosis } = useAiStore();
```

- [ ] **Step 2: 在结果内容渲染区域添加 error kind 分支**

找到 `MainContent/index.tsx` 第 1346 行（`selectedResultPane === 'explanation'` 三元表达式的 else 分支开始处）。

在 `{isExecuting ? (` 之前（第 1348 行），添加错误面板渲染分支。将整个 else 分支 `<>` 中的内容改为：

```tsx
                  <>
                    {isExecuting ? (
                      <div className="p-4 text-gray-400 text-sm">{t('mainContent.executing')}</div>
                    ) : currentResults.length === 0 ? (
                      <div className="p-4 text-[#7a9bb8] text-sm">{t('mainContent.resultsWillShowHere')}</div>
                    ) : (() => {
                      const activeResult = typeof selectedResultPane === 'number'
                        ? currentResults[selectedResultPane]
                        : undefined;

                      if (!activeResult) return null;

                      // ── 错误面板 ──
                      if (activeResult.kind === 'error') {
                        const diagKey = `${activeTab}_${selectedResultPane}`;
                        const diagContent = diagnosisContentMap[diagKey] ?? '';
                        const diagStreaming = diagnosisStreamingMap[diagKey] ?? false;
                        const connId = activeTabObj?.queryContext?.connectionId ?? null;
                        const db = activeTabObj?.queryContext?.database ?? null;

                        return (
                          <div className="p-4 h-full overflow-auto">
                            <div className="mb-3">
                              <div className="flex items-center gap-2 text-red-400 text-sm font-medium mb-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                                  <path d="M12 9v4" /><path d="M12 17h.01" />
                                </svg>
                                {t('mainContent.sqlExecutionError')}
                              </div>
                              {activeResult.sql && (
                                <pre className="bg-[#0d1117] border border-[#1e2d42] rounded p-2 text-xs text-[#7a9bb8] font-mono mb-2 whitespace-pre-wrap break-all">{activeResult.sql}</pre>
                              )}
                              <div className="text-xs">
                                <span className="text-[#7a9bb8]">{t('mainContent.errorMessage')}：</span>
                                <span className="text-red-400 font-mono">{activeResult.error_message}</span>
                              </div>
                            </div>

                            <div className="border-t border-[#1e2d42] pt-3">
                              {!diagContent && !diagStreaming ? (
                                <button
                                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[#1a2639] text-[#00c9a7] hover:bg-[#1e2d42] transition-colors"
                                  onClick={() => diagnoseSqlError(activeResult.sql ?? '', activeResult.error_message ?? '', connId, db, diagKey)}
                                >
                                  <Sparkles size={13} />
                                  {t('mainContent.aiDiagnoseBtn')}
                                </button>
                              ) : (
                                <div>
                                  <div className="flex items-center gap-1.5 text-xs text-[#00c9a7] mb-2">
                                    <Sparkles size={13} />
                                    <span>{t('mainContent.aiDiagnoseBtn')}</span>
                                    {diagStreaming && (
                                      <svg className="animate-spin ml-1" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                      </svg>
                                    )}
                                  </div>
                                  <div className="prose prose-invert prose-sm max-w-none text-[#c8daea]">
                                    <MarkdownContent content={diagContent} />
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }

                      // ── 以下是原有的 select / dml-report 渲染 ──
```

然后将原有的空结果判断和表格渲染逻辑保持不变，但移除原来的 `error ?` 分支（第 1350-1358 行的旧错误展示代码整体删除）。

**具体要删除的旧代码**（原 1350-1358 行）：
```tsx
                    ) : error ? (
                      <div className="p-3 text-red-400 text-xs font-mono">
                        {error}
                        {diagnosis && (
                          <div className="mt-2 p-2 bg-[#1a2639] rounded text-[#c8daea] whitespace-pre-wrap font-sans">
                            <span className="text-[#3794ff]">{t('mainContent.aiDiagnosis')}</span>{diagnosis}
                          </div>
                        )}
                      </div>
```

- [ ] **Step 3: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat: render error panel with AI diagnosis button in result pane"
```

---

### Task 8: 清理旧的错误展示逻辑

**Files:**
- Modify: `src/components/MainContent/index.tsx` — 移除 error toast useEffect
- Modify: `src/components/MainContent/index.tsx` — 移除状态栏 error 判断
- Modify: `src/store/queryStore.ts` — 清理（保留 `error`/`diagnosis` 字段给其他功能使用）

- [ ] **Step 1: 修改 MainContent 中的 error toast useEffect**

找到第 676-686 行：

```tsx
  // Toast on execution error so user gets immediate feedback
  useEffect(() => {
    if (error) {
      const ctx = buildErrorContext('sql_execute', { rawError: error });
      if (showError) {
        showError(ctx.userMessage, ctx.markdownContext);
      } else {
        showToast(ctx.userMessage, 'error');
      }
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps
```

删除这个 useEffect 块。SQL 执行错误现在通过错误 tab 展示，不再需要 toast 提示。

- [ ] **Step 2: 移除状态栏中 error 相关的判断**

找到第 1572 行：
```tsx
              {!isExecuting && !error && typeof selectedResultPane === 'number' && ...
```

将 `!error &&` 移除，改为：
```tsx
              {!isExecuting && typeof selectedResultPane === 'number' && ...
```

- [ ] **Step 3: 从 useQueryStore 解构中移除 error 和 diagnosis**

在第 271 行，从 useQueryStore 解构中移除 `error, diagnosis,`：

```tsx
          sqlContent, setSql, executeQuery, isExecuting: isExecutingMap, results,
```

（直接去掉 `error, diagnosis,`）

- [ ] **Step 4: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（若 `error`/`diagnosis` 在其他组件中仍被引用则保留 store 中的定义）

- [ ] **Step 5: Commit**

```bash
git add src/components/MainContent/index.tsx src/store/queryStore.ts
git commit -m "fix: remove old global error display, errors now shown in result tabs"
```

---

### Task 9: 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 运行 Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: 启动开发环境验证**

Run: `npm run tauri:dev`

验证项目：
1. 连接到数据库，打开 SQL 编辑器
2. 执行单条错误 SQL（如 `SELECT * FROM nonexistent_table`）→ 应显示"错误日志 1" tab
3. 执行多条混合 SQL（如 `SELECT 1; SELECT * FROM bad; SELECT 2;`）→ 应显示"结果集 1"、"错误日志 2"、"结果集 3"
4. 右键点击错误 tab → 应显示关闭/关闭左侧/关闭右侧等菜单
5. 点击错误 tab 中的"AI 诊断"按钮 → 应流式输出 Markdown 诊断内容
6. 错误 tab 标题应显示红色边框

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address issues found during e2e verification"
```
