# SQL 执行错误 Tab 化 + AI 流式诊断

**日期**: 2026-04-01
**状态**: 已确认

## 背景

当前 SQL 执行出错时，错误信息显示在结果区域底部（全局 `error` 状态），不是独立 tab。当多条 SQL（用 `;` 分隔）混合成功与失败时，用户无法分别查看每条 SQL 的执行结果。此外，AI 诊断是自动触发且一次性返回，无法控制。

## 目标

1. 错误结果以 tab 形式展示（"错误日志 N"），与成功的结果集 tab 混排
2. Tab 编号按 SQL 执行顺序统一编号（结果集 1、错误日志 2、错误日志 3）
3. 错误 tab 支持与结果集 tab 相同的右键菜单（关闭、关闭左侧、关闭右侧等）
4. 错误 tab 内含 AI 诊断按钮（手动触发），点击后流式输出 Markdown 诊断结果
5. 移除原有错误自动触发 AI 诊断的行为

## 设计

### 1. 数据模型 — QueryResult 扩展

```typescript
// src/types/index.ts
export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  kind?: 'select' | 'dml-report' | 'error';  // 新增 'error'
  sql?: string;
  error_message?: string;  // 新增：存储错误信息
}
```

### 2. 执行流程改造 — queryStore.executeQuery

当前逻辑：逐条执行 SQL，分类为 selectResults / dmlResults，任一失败则 catch 抛错到全局 `error`。

改为：
- 逐条执行 SQL，每条结果（成功或失败）按执行顺序 push 到统一的 `orderedResults: QueryResult[]`
- 成功的 SQL 照旧生成 `kind: 'select'` 或后续聚合为 `kind: 'dml-report'`
- 失败的 SQL 生成 `kind: 'error'` 结果项，包含 `error_message` 和 `sql`
- 不再设置全局 `error` / `diagnosis` 状态
- 移除自动调用 `ai_diagnose_error` 的逻辑

关键变更点（`queryStore.ts` executeQuery 方法）：

```typescript
const orderedResults: QueryResult[] = [];
for (const stmt of statements) {
  try {
    const result = await invoke<QueryResult>('execute_query', { ... });
    // 标记 kind，push 到 orderedResults
  } catch (e) {
    orderedResults.push({
      columns: [], rows: [], row_count: 0, duration_ms: 0,
      kind: 'error', sql: stmt, error_message: String(e),
    });
  }
}
// DML 聚合逻辑保持不变，但需要处理混排顺序
// 最终 set results[tabId] = finalList
```

DML 聚合策略：连续的成功 DML 语句仍聚合为一个 dml-report，但 error 类型的结果保持在原位置不参与聚合。

### 3. Tab 标题 — 统一编号

Tab 标题由 `idx + 1`（在 orderedResults 中的位置）决定：
- `kind === 'error'` → `错误日志 ${idx + 1}`
- `kind === 'dml-report'` → `DML 报告（N 条）`
- 其他 → `结果集 ${idx + 1}`

### 4. 错误 Tab UI

在 `MainContent/index.tsx` 结果内容渲染区域，当 `activeResult.kind === 'error'` 时渲染错误面板：

```
┌─────────────────────────────────────────┐
│  ⚠ SQL 执行错误                          │
│                                         │
│  SQL: SELECT * FROM `even11231ts` ...   │
│                                         │
│  错误信息:                               │
│  Table 'test_analytics.even11231ts'     │
│  doesn't exist                          │
│                                         │
│  [AI图标] AI 诊断                        │
│                                         │
│  ── 诊断结果（流式 Markdown）──           │
│  ...                                    │
└─────────────────────────────────────────┘
```

- 错误 SQL 用 monospace 灰色展示
- 错误信息用红色展示
- AI 诊断按钮复用项目现有的 AI 图标样式
- 诊断结果区域使用 `MarkdownContent` 组件渲染

### 5. 错误 Tab 右键菜单

错误 tab 的右键菜单完全复用结果集 tab 的逻辑，无需额外处理——因为 error 类型结果就是 `currentResults` 数组中的普通元素，现有的 close/closeLeft/closeRight/closeOther/closeAll 操作天然适用。

### 6. AI 流式诊断 — Rust 端

新增 Rust 命令 `agent_diagnose_error`，参考 `agent_explain_sql` 的实现模式：
- 接收 `sql`, `error_msg`, `connection_id`, `database`, `channel: Channel<StreamEvent>`
- 创建临时 session，通过 opencode serve SSE 流式输出
- 支持 abort（通过 `AppState` 管理 session ID）
- Prompt 包含：错误 SQL、错误信息、连接上下文、数据库类型

### 7. AI 流式诊断 — 前端 Store

在 `aiStore` 中新增：

```typescript
// 状态
diagnosisContent: Record<string, string>;     // tabId -> 诊断内容
diagnosisStreaming: Record<string, boolean>;   // tabId -> 是否正在流式输出

// 方法
diagnoseSqlError(sql, errorMsg, connectionId, database, tabId, resultIdx): Promise<void>
cancelDiagnosis(tabId): Promise<void>
clearDiagnosis(tabId): void
```

- `diagnoseSqlError` 使用 Channel 流式接收，参考 `explainSql` 实现
- `resultIdx` 用于区分同一 tab 内多个错误的诊断（key 为 `${tabId}_${resultIdx}`）
- 流式内容通过 RAF 缓冲更新

### 8. 清理

- 移除 `queryStore` 中的全局 `error` 和 `diagnosis` 状态（如果仅用于 SQL 执行错误展示）
- 移除 `executeQuery` 中自动调用 `ai_diagnose_error` 的代码
- `MainContent` 中移除旧的错误展示区域（`error ? <div>...` 部分）

> 注意：需确认 `error` 状态是否还有其他用途（如 AI 解释失败等），如果有则保留但不再用于 SQL 执行错误。

### 9. i18n

新增翻译 key：
- `mainContent.errorLog` → "错误日志" / "Error Log"
- `mainContent.aiDiagnoseBtn` → "AI 诊断" / "AI Diagnosis"
- `mainContent.sqlExecutionError` → "SQL 执行错误" / "SQL Execution Error"
- `mainContent.errorMessage` → "错误信息" / "Error Message"
- `mainContent.diagnosing` → "诊断中..." / "Diagnosing..."

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `src/types/index.ts` | 扩展 QueryResult |
| `src/store/queryStore.ts` | 重构 executeQuery，移除全局 error/diagnosis |
| `src/store/aiStore.ts` | 新增 diagnoseSqlError / cancelDiagnosis |
| `src/components/MainContent/index.tsx` | 错误 tab 渲染、AI 诊断 UI |
| `src-tauri/src/commands.rs` | 新增 agent_diagnose_error 命令 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/locales/*.json` | 新增 i18n key |
