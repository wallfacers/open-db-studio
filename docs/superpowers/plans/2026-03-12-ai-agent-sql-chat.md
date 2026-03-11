# AI Agent SQL 聊天修改 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 Page Agent + Tool Bridge 实现聊天修改 SQL 编辑器内容，AI 展示 diff 预览，用户确认后写入 Monaco Editor。

**Architecture:** 在现有 Assistant 面板中集成 Page Agent（`page-agent` NPM 包），Page Agent 感知页面 DOM 状态并调用注册的 Tool Bridge API；Tool Bridge 是纯前端 TypeScript Hook，连接 Zustand store 与 Monaco Editor；所有 SQL 修改必须经过 propose→confirm→apply 三步流程。offset 坐标由 Tool Bridge 内部解析，不暴露给 Page Agent。

**Tech Stack:** React 18 + TypeScript、Zustand、Monaco Editor（已有）、`page-agent@1.5.6`（`new PageAgent(...)` + `tool()` + zod）、`diff`（行级 diff 计算）、Vitest（新增测试框架）

**Spec:** `docs/superpowers/specs/2026-03-12-ai-agent-page-interaction-design.md`

---

## Chunk 1: 基础类型 + SQL 解析 + Store 状态

### 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `src/types/index.ts` | 新增 SqlStatementInfo、SqlDiffProposal 类型 |
| Create | `src/utils/sqlParser.ts` | SQL 语句解析（分号分割，带偏移量） |
| Create | `src/utils/sqlParser.test.ts` | 单元测试 |
| Modify | `src/store/queryStore.ts` | pendingDiff 状态、editorInfo 光标状态 |
| Modify | `src/components/MainContent/index.tsx` | Monaco 光标/选区变化 → 写入 queryStore |

---

### Task 1: 新增类型定义

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 在 `src/types/index.ts` 末尾追加以下类型**

```typescript
/** SQL 语句解析结果（含偏移量，用于消歧） */
export interface SqlStatementInfo {
  text: string;
  startOffset: number;  // 在完整编辑器内容中的起始字符偏移
  endOffset: number;    // 结束字符偏移（不含末尾分号）
}

/** AI 提出的 SQL 修改提案（等待用户确认） */
export interface SqlDiffProposal {
  original: string;     // 原始 SQL（单条语句）
  modified: string;     // 修改后的 SQL
  reason: string;       // 修改原因（AI 说明）
  tabId: string;        // 目标 Tab
  startOffset: number;  // 原始语句在编辑器中的起始位置
  endOffset: number;    // 原始语句在编辑器中的结束位置
}

/** Monaco 编辑器光标/选区信息（由 MainContent 实时写入） */
export interface EditorInfo {
  cursorOffset: number;       // 光标在全文中的字符偏移
  selectedText: string | null; // 当前选中的文本，无选区为 null
}
```

- [ ] **Step 2: 验证 TypeScript 无报错**

```bash
npx tsc --noEmit
```

期望：无错误

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add SqlStatementInfo, SqlDiffProposal, EditorInfo types"
```

---

### Task 2: SQL 语句解析工具（纯逻辑，可测试）

**Files:**
- Create: `src/utils/sqlParser.ts`
- Create: `src/utils/sqlParser.test.ts`

> 现有 `queryStore.ts:99` 有简单的 `sql.split(';')` 实现，这里做带偏移量的精确版本。已知限制：不处理行注释（`--`）和块注释（`/* */`）内的分号，与现有实现一致。SQL 标准的双引号转义（`''`）同样不处理，文档注明即可。

- [ ] **Step 1: 配置 Vitest（如果 `vite.config.ts` 中尚无 `test` 字段）**

检查：

```bash
cat vite.config.ts
```

如果没有 `test` 字段，在 `vite.config.ts` 的 `export default defineConfig({...})` 内部添加：

```typescript
  test: {
    environment: 'node',
  },
```

安装 vitest：

```bash
npm install -D vitest
```

在 `package.json` 的 `scripts` 中添加（在 `"dev"` 行附近）：

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: 先写失败的测试**

创建 `src/utils/sqlParser.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { parseStatements, findStatementAtOffset } from './sqlParser';

describe('parseStatements', () => {
  it('单条语句（无分号）', () => {
    const result = parseStatements('SELECT 1');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(8);
  });

  it('两条语句（分号分隔）', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[1].text).toBe('SELECT 2');
    expect(result[1].startOffset).toBe(10);
  });

  it('忽略空语句（双分号）', () => {
    const result = parseStatements('SELECT 1;;SELECT 2');
    expect(result).toHaveLength(2);
  });

  it('单引号字符串内的分号不分割', () => {
    const sql = "SELECT ';' FROM t";
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("SELECT ';' FROM t");
  });

  it('双引号字符串内的分号不分割', () => {
    const sql = 'SELECT ";" FROM t';
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
  });
});

describe('findStatementAtOffset', () => {
  it('光标在第一条语句中', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 3)?.text).toBe('SELECT 1');
  });

  it('光标在第二条语句中', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 15)?.text).toBe('SELECT 2');
  });

  it('光标在分号上返回前一条语句', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 8)?.text).toBe('SELECT 1');
  });

  it('只有一条语句时始终返回该语句', () => {
    const stmts = parseStatements('SELECT 1');
    expect(findStatementAtOffset(stmts, 99)?.text).toBe('SELECT 1');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm test
```

期望：FAIL，提示 `Cannot find module './sqlParser'`

- [ ] **Step 4: 实现 `src/utils/sqlParser.ts`**

```typescript
import type { SqlStatementInfo } from '../types';

/**
 * 解析 SQL 字符串为多条语句，带起止偏移量。
 * 处理单引号和双引号内的分号（不作为分隔符）。
 *
 * 已知限制：
 * - 行注释（--）和块注释（/* *\/）内的分号仍会分割（与现有 queryStore 一致）
 * - SQL 标准双引号转义（''）不处理，反斜杠转义（\'）同样简单处理
 */
export function parseStatements(sql: string): SqlStatementInfo[] {
  const results: SqlStatementInfo[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prev = sql[i - 1] ?? '';

    if (ch === "'" && !inDoubleQuote && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && prev !== '\\') {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
      pushStatement(sql, start, i, results);
      start = i + 1;
    }
  }

  // 末尾无分号的最后一条语句
  pushStatement(sql, start, sql.length, results);

  return results;
}

function pushStatement(
  sql: string,
  rawStart: number,
  rawEnd: number,
  results: SqlStatementInfo[]
): void {
  const slice = sql.slice(rawStart, rawEnd);
  const trimmedStart = rawStart + (slice.length - slice.trimStart().length);
  const text = slice.trim();
  if (text.length > 0) {
    results.push({ text, startOffset: trimmedStart, endOffset: trimmedStart + text.length });
  }
}

/**
 * 找到光标位置所在的语句。
 * 光标在分号上时，返回分号前的语句。
 * 如果 offset 超出所有语句范围，返回最后一条。
 */
export function findStatementAtOffset(
  statements: SqlStatementInfo[],
  offset: number
): SqlStatementInfo | null {
  if (statements.length === 0) return null;
  // 从后往前，返回 startOffset <= offset 的最后一条
  for (let i = statements.length - 1; i >= 0; i--) {
    if (statements[i].startOffset <= offset) return statements[i];
  }
  return statements[0];
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test
```

期望：所有测试 PASS

- [ ] **Step 6: Commit**

```bash
git add src/utils/sqlParser.ts src/utils/sqlParser.test.ts vite.config.ts package.json
git commit -m "feat(utils): add SQL statement parser with offset support"
```

---

### Task 3: queryStore 新增 pendingDiff + editorInfo 状态

**Files:**
- Modify: `src/store/queryStore.ts`

- [ ] **Step 1: 更新 import 行**

将文件顶部第 3 行（`import type { QueryResult...`）改为：

```typescript
import type { QueryResult, QueryHistory, Tab, SqlDiffProposal, EditorInfo } from '../types';
```

- [ ] **Step 2: 在 `QueryState` interface 中添加字段**

在 `clearResults` 方法声明后追加：

```typescript
  // SQL diff 提案（等待用户确认）
  pendingDiff: SqlDiffProposal | null;
  proposeSqlDiff: (proposal: SqlDiffProposal) => void;
  applyDiff: () => void;
  cancelDiff: () => void;

  // Monaco 编辑器光标/选区（由 MainContent 实时写入）
  editorInfo: Record<string, EditorInfo>;
  setEditorInfo: (tabId: string, info: EditorInfo) => void;
```

- [ ] **Step 3: 在 create 初始值中添加**

在 `diagnosis: null,` 后追加：

```typescript
  pendingDiff: null,
  editorInfo: {},
```

- [ ] **Step 4: 在 store 实现末尾（`clearResults` 后）添加 action**

```typescript
  proposeSqlDiff: (proposal) => set({ pendingDiff: proposal }),

  applyDiff: () => {
    const { pendingDiff } = get();
    if (!pendingDiff) return;
    const full = get().sqlContent[pendingDiff.tabId] ?? '';
    const newSql =
      full.slice(0, pendingDiff.startOffset) +
      pendingDiff.modified +
      full.slice(pendingDiff.endOffset);
    get().setSql(pendingDiff.tabId, newSql);
    set({ pendingDiff: null });
  },

  cancelDiff: () => set({ pendingDiff: null }),

  setEditorInfo: (tabId, info) =>
    set((s) => ({ editorInfo: { ...s.editorInfo, [tabId]: info } })),
```

- [ ] **Step 5: 验证类型检查无误**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/store/queryStore.ts
git commit -m "feat(store): add pendingDiff and editorInfo state to queryStore"
```

---

### Task 4: MainContent 向 queryStore 写入 Monaco 光标/选区信息

**Files:**
- Modify: `src/components/MainContent/index.tsx`

> Monaco Editor 提供 `onDidChangeCursorPosition` 和 `onDidChangeCursorSelection` 事件，在这里监听并写入 queryStore，供 useToolBridge 实现消歧。

- [ ] **Step 1: 找到 MainContent 中 Monaco `onMount` 回调位置**

查看 `src/components/MainContent/index.tsx` 中的 `onMount` prop（传给 `<MonacoEditor>`）。其类型为 `OnMount`，参数为 `(editor, monaco)`。

- [ ] **Step 2: 在 onMount 回调内追加监听器**

在 `onMount` 回调中（现有逻辑后面）添加：

```typescript
// 同步光标/选区信息到 queryStore，供 Tool Bridge 消歧
const syncEditorInfo = () => {
  const model = editor.getModel();
  if (!model) return;
  const selection = editor.getSelection();
  const cursorPos = editor.getPosition();
  const cursorOffset = cursorPos
    ? model.getOffsetAt(cursorPos)
    : 0;
  const selectedText =
    selection && !selection.isEmpty()
      ? model.getValueInRange(selection)
      : null;
  useQueryStore.getState().setEditorInfo(activeTabId, { cursorOffset, selectedText });
};
editor.onDidChangeCursorPosition(syncEditorInfo);
editor.onDidChangeCursorSelection(syncEditorInfo);
syncEditorInfo(); // 初始化一次
```

> `activeTabId` 在 `onMount` 所在作用域中通过 `useQueryStore` 获取。如果 `onMount` 是独立函数，改为 `useQueryStore.getState().activeTabId`。

- [ ] **Step 3: 验证类型检查无误**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: 在 dev 模式验证**

```bash
npm run dev
```

在 `src/store/queryStore.ts` 的 `create<QueryState>` 最后临时添加一行（验证完即删）：

```typescript
// TEMP: 调试用，验证完删除
if (typeof window !== 'undefined') (window as any).__qs = useQueryStore;
```

打开应用，在 SQL 编辑器中点击不同位置，DevTools Console 执行：

```javascript
// 查看当前 Tab 的 editorInfo
__qs.getState().editorInfo
```

期望：每次点击编辑器，`cursorOffset` 值变化。选中文本后，`selectedText` 非空。

验证完后删除临时调试行并提交。

- [ ] **Step 5: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(editor): sync Monaco cursor/selection to queryStore editorInfo"
```

---

## Chunk 2: Tool Bridge + DiffPanel + Assistant 集成

### 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| Create | `src/hooks/useToolBridge.ts` | Tool Bridge（暴露给 Page Agent 的操作 API） |
| Create | `src/components/Assistant/DiffPanel.tsx` | SQL diff 展示 + 确认/取消 |
| Modify | `src/components/Assistant/index.tsx` | 集成 DiffPanel |

---

### Task 5: 创建 useToolBridge Hook

**Files:**
- Create: `src/hooks/useToolBridge.ts`

> Page Agent 会调用这里返回的函数作为 Tool。注意：`proposeSqlDiff` 接收 `original` 文本，**内部**解析偏移量，不暴露给 Page Agent。

- [ ] **Step 1: 创建 `src/hooks/useToolBridge.ts`**

```typescript
import { useCallback } from 'react';
import { useQueryStore } from '../store/queryStore';
import { parseStatements, findStatementAtOffset } from '../utils/sqlParser';
import type { SqlDiffProposal } from '../types';

/**
 * Tool Bridge — 暴露给 Page Agent 的结构化操作 API。
 *
 * 设计原则：
 * - Page Agent 不处理偏移量（内部实现细节）
 * - 所有 SQL 修改通过 propose→confirm→apply 流程
 * - getCurrentSql 返回完整上下文供 Page Agent 消歧
 */
export function useToolBridge() {
  const {
    sqlContent, activeTabId, tabs,
    editorInfo, setActiveTab,
    proposeSqlDiff, applyDiff, cancelDiff,
  } = useQueryStore();

  /**
   * 获取当前活动 Tab 的 SQL 上下文。
   * Page Agent 调用此工具感知编辑器状态，决定要修改哪条语句。
   */
  const getCurrentSql = useCallback(() => {
    const full = sqlContent[activeTabId] ?? '';
    const statements = parseStatements(full);
    const info = editorInfo[activeTabId];
    const cursorOffset = info?.cursorOffset ?? 0;
    const selectedText = info?.selectedText ?? null;
    const activeStatement = selectedText
      ? selectedText
      : findStatementAtOffset(statements, cursorOffset)?.text ?? null;

    return {
      full_content: full,
      selected_text: selectedText,
      cursor_position: cursorOffset,
      statements: statements.map(s => s.text),
      active_statement: activeStatement,
    };
  }, [sqlContent, activeTabId, editorInfo]);

  /**
   * 提出 SQL 修改方案（展示 diff，等待用户确认）。
   *
   * @param original - 要修改的原始语句文本（Page Agent 从 getCurrentSql 获得）
   * @param modified - 修改后的语句文本
   * @param reason   - 修改原因说明
   *
   * 内部解析：在当前编辑器内容中找到 original 文本，确定偏移区间。
   * 如果找不到匹配，返回 error。
   */
  const proposeSqlDiffTool = useCallback((
    original: string,
    modified: string,
    reason: string,
  ): { status: 'pending' | 'error'; message: string } => {
    const full = sqlContent[activeTabId] ?? '';
    const statements = parseStatements(full);

    // 优先：精确匹配 original 文本
    const matchedStmt = statements.find(s => s.text === original.trim());
    if (!matchedStmt) {
      return {
        status: 'error',
        message: `在当前编辑器中找不到文本：${original.slice(0, 50)}...`,
      };
    }

    const proposal: SqlDiffProposal = {
      original: matchedStmt.text,
      modified: modified.trim(),
      reason,
      tabId: activeTabId,
      startOffset: matchedStmt.startOffset,
      endOffset: matchedStmt.endOffset,
    };
    proposeSqlDiff(proposal);
    return { status: 'pending', message: '已展示 diff，等待用户确认' };
  }, [sqlContent, activeTabId, proposeSqlDiff]);

  /**
   * 切换活动 Tab。
   */
  const switchTab = useCallback((tabId: string): { status: string; message?: string } => {
    const exists = useQueryStore.getState().tabs.find(t => t.id === tabId);
    if (!exists) return { status: 'error', message: `Tab ${tabId} 不存在` };
    setActiveTab(tabId);
    return { status: 'ok' };
  }, [setActiveTab]);

  /**
   * 列出所有打开的 Tab。
   */
  const listTabs = useCallback(() => {
    return useQueryStore.getState().tabs.map(t => ({
      id: t.id, title: t.title, type: t.type,
    }));
  }, []);

  return {
    getCurrentSql,
    proposeSqlDiff: proposeSqlDiffTool,
    applySql: applyDiff,
    cancelSql: cancelDiff,
    switchTab,
    listTabs,
  };
}
```

- [ ] **Step 2: 验证类型无误**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useToolBridge.ts
git commit -m "feat(hooks): add useToolBridge with full getCurrentSql context and internal offset resolution"
```

---

### Task 6: 安装 diff 包并创建 DiffPanel 组件

**Files:**
- Create: `src/components/Assistant/DiffPanel.tsx`

- [ ] **Step 1: 安装 `diff` 包（正确的行级 diff 实现）**

```bash
npm install diff
npm install -D @types/diff
```

- [ ] **Step 2: 创建 `src/components/Assistant/DiffPanel.tsx`**

```typescript
import React, { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { diffLines } from 'diff';
import type { SqlDiffProposal } from '../../types';

interface DiffPanelProps {
  proposal: SqlDiffProposal;
  onApply: () => void;
  onCancel: () => void;
}

export const DiffPanel: React.FC<DiffPanelProps> = ({ proposal, onApply, onCancel }) => {
  // diffLines 使用 LCS 算法，正确处理重复行和多行变更
  const parts = useMemo(
    () => diffLines(proposal.original, proposal.modified),
    [proposal.original, proposal.modified]
  );

  return (
    <div className="border-t border-[#1e2d42] bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e2d42]">
        <span className="text-xs font-medium text-[#c8daea]">修改建议</span>
        <button
          onClick={onCancel}
          className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          title="取消"
        >
          <X size={14} />
        </button>
      </div>

      {/* 原因说明 */}
      {proposal.reason && (
        <div className="px-3 py-1.5 text-xs text-[#7a9bb8] bg-[#0d1117] border-b border-[#1e2d42]">
          {proposal.reason}
        </div>
      )}

      {/* Diff 内容 */}
      <div className="overflow-x-auto font-mono text-xs max-h-48 overflow-y-auto">
        {parts.map((part, partIdx) => {
          const lines = part.value.split('\n').filter((l, i, arr) =>
            // 去掉末尾空行（diffLines 尾部通常带一个空串）
            !(i === arr.length - 1 && l === '')
          );
          return lines.map((line, lineIdx) => (
            <div
              key={`${partIdx}-${lineIdx}`}
              className={
                part.added
                  ? 'bg-[#0e2a1a] text-[#4ade80] px-3 py-0.5 flex items-start gap-2'
                  : part.removed
                  ? 'bg-[#2a0e0e] text-[#f87171] px-3 py-0.5 flex items-start gap-2'
                  : 'text-[#7a9bb8] px-3 py-0.5 flex items-start gap-2'
              }
            >
              <span className="select-none w-3 flex-shrink-0">
                {part.added ? '+' : part.removed ? '-' : ' '}
              </span>
              <pre className="whitespace-pre-wrap break-all">{line || ' '}</pre>
            </div>
          ));
        })}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[#1e2d42]">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded border border-[#2a3f5a] text-[#7a9bb8] hover:text-[#c8daea] hover:border-[#7a9bb8] transition-colors"
        >
          取消
        </button>
        <button
          onClick={onApply}
          className="text-xs px-3 py-1 rounded bg-[#00c9a7] text-white hover:bg-[#00a98f] transition-colors flex items-center gap-1"
        >
          <Check size={12} />
          应用
        </button>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: 验证类型无误**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Assistant/DiffPanel.tsx package.json package-lock.json
git commit -m "feat(assistant): add DiffPanel with LCS-based line diff"
```

---

### Task 7: 将 DiffPanel 集成进 Assistant

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: 在 `src/components/Assistant/index.tsx` 顶部添加 import**

在现有 import 区末尾追加：

```typescript
import { DiffPanel } from './DiffPanel';
import { useQueryStore } from '../../store/queryStore';
```

- [ ] **Step 2: 在 Assistant 组件函数体内添加 pendingDiff 订阅**

在 `const [chatInput, setChatInput] = useState('');` 前添加：

```typescript
  const { pendingDiff, applyDiff, cancelDiff } = useQueryStore();
```

- [ ] **Step 3: 在 Input Area 上方插入 DiffPanel 渲染**

找到 `{/* Input Area */}` 注释，在其正上方插入：

```typescript
      {/* SQL Diff 确认面板 */}
      {pendingDiff && (
        <DiffPanel
          proposal={pendingDiff}
          onApply={applyDiff}
          onCancel={cancelDiff}
        />
      )}
```

- [ ] **Step 4: 在 dev 模式验证 DiffPanel 渲染**

```bash
npm run dev
```

在浏览器 DevTools Console 中执行以下代码触发假数据：

```javascript
// 粘贴到 DevTools Console 运行
const store = window.__zustand_queryStore;
// 如果无法直接访问，通过以下方式：
// 在 src/store/queryStore.ts 中临时加 window.__qs = useQueryStore
// 然后在 console 运行：
__qs.getState().proposeSqlDiff({
  original: 'SELECT * FROM users',
  modified: 'SELECT * FROM users\nORDER BY created_at DESC',
  reason: '测试：添加排序',
  tabId: __qs.getState().activeTabId,
  startOffset: 0,
  endOffset: 19
})
```

期望：Assistant 面板底部出现 DiffPanel，显示红绿 diff 和"应用"/"取消"按钮。

- [ ] **Step 5: 验证"应用"和"取消"功能**

- 点击"应用"：Monaco 编辑器内容更新，DiffPanel 消失
- 点击"取消"：DiffPanel 消失，编辑器内容不变

- [ ] **Step 6: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(assistant): integrate DiffPanel for pending SQL diff display"
```

---

## Chunk 3: Page Agent 真实集成

### 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| Create | `src/hooks/usePageAgent.ts` | Page Agent 初始化与工具注册 |
| Modify | `src/components/Assistant/index.tsx` | 调用 usePageAgent |

---

### Task 8: 安装 page-agent

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 page-agent 及其 peer dependency**

```bash
npm install page-agent zod
```

- [ ] **Step 2: 验证安装**

```bash
npm ls page-agent zod
```

期望输出包含 `page-agent@1.5.6`（或最新版）

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install page-agent and zod"
```

---

### Task 9: 创建 usePageAgent Hook（真实 API）

**Files:**
- Create: `src/hooks/usePageAgent.ts`

> page-agent API：`new PageAgent({ llm, customTools, instructions, ... })`，工具通过 `tool()` + zod schema 注册。文档：https://alibaba.github.io/page-agent/

- [ ] **Step 1: 创建 `src/hooks/usePageAgent.ts`**

```typescript
import { useEffect, useRef } from 'react';
import { PageAgent, tool } from 'page-agent';
import * as z from 'zod';
import { useAiStore } from '../store/aiStore';
import { useToolBridge } from './useToolBridge';

/**
 * 初始化 Page Agent 并注册 Tool Bridge 工具。
 *
 * Page Agent 负责：
 * 1. DOM 感知（自动分析页面结构）
 * 2. 自然语言 → 意图识别 → 调用注册的 Tool
 *
 * Tool Bridge 工具：
 * - get_current_sql：获取编辑器状态（含消歧信息）
 * - propose_sql_diff：提出修改方案（展示 diff）
 * - list_tabs：列出所有 Tab
 * - switch_tab：切换 Tab
 *
 * 安全：interactiveBlacklist 排除密码/API Key 字段。
 */
export function usePageAgent() {
  const { configs, activeConfigId } = useAiStore();
  const toolBridge = useToolBridge();
  const agentRef = useRef<PageAgent | null>(null);

  // 切换模型配置时重置，以便 effect 重新初始化
  useEffect(() => { agentRef.current = null; }, [activeConfigId]);

  useEffect(() => {
    // 已初始化则跳过（避免重复创建）
    if (agentRef.current) return;

    const activeConfig =
      configs.find(c => c.id === activeConfigId) ??
      configs.find(c => c.is_default) ??
      configs[0];

    // 无 LLM 配置时静默跳过（用户未配置模型）
    if (!activeConfig) return;

    const agent = new PageAgent({
      // LLM 配置（复用现有 LLM 设置，支持所有 OpenAI 兼容接口）
      baseURL: activeConfig.base_url,
      apiKey:  activeConfig.api_key,
      model:   activeConfig.model,

      // 知识库：告知 AI 这是一个数据库 IDE
      instructions: {
        system: [
          '你是一个数据库 IDE 助手，运行在 open-db-studio 桌面应用中。',
          '修改 SQL 时，必须先调用 get_current_sql 获取当前内容，再调用 propose_sql_diff 展示修改方案，不得直接写入编辑器。',
          '所有修改必须通过 propose_sql_diff，等待用户确认后才生效。',
          '严禁读取、显示或操作密码、API Key 等安全敏感字段。',
        ].join('\n'),
      },

      // 安全边界：排除密码和 API Key 相关输入
      interactiveBlacklist: [
        '[type="password"]',
        '.api-key-field',
        '[data-sensitive="true"]',
      ],

      // 自定义工具：Tool Bridge
      customTools: {
        get_current_sql: tool({
          description: '获取当前 SQL 编辑器的内容、光标位置、选中文本和已解析的语句列表。在修改 SQL 前必须先调用此工具以确定要修改的语句。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridge.getCurrentSql());
          },
        }),

        propose_sql_diff: tool({
          description: '提出 SQL 修改方案。展示 diff 对比（原始 vs 修改后），等待用户点击"应用"确认。original 必须与 get_current_sql 返回的某条 statements 文本完全一致。',
          inputSchema: z.object({
            original: z.string().describe('要修改的原始 SQL 语句（必须与 statements 中的文本完全一致）'),
            modified: z.string().describe('修改后的 SQL 语句'),
            reason:   z.string().describe('修改原因的简短说明（中文，一句话）'),
          }),
          execute: async function({ original, modified, reason }) {
            const result = toolBridge.proposeSqlDiff(original, modified, reason);
            return JSON.stringify(result);
          },
        }),

        list_tabs: tool({
          description: '列出所有打开的查询 Tab，返回 id、title、type 列表。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridge.listTabs());
          },
        }),

        switch_tab: tool({
          description: '切换到指定的查询 Tab。',
          inputSchema: z.object({
            tabId: z.string().describe('目标 Tab 的 id（从 list_tabs 获取）'),
          }),
          execute: async function({ tabId }) {
            return JSON.stringify(toolBridge.switchTab(tabId));
          },
        }),
      },
    });

    agentRef.current = agent;
  // 注意：toolBridge 每次渲染重建，但 agentRef 的 early-return 保证只初始化一次。
  // 若 activeConfigId 变更（用户切换模型），通过重置 agentRef.current = null 触发重建。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigId]);

  return agentRef.current;
}
```

- [ ] **Step 2: 验证类型无误**

```bash
npx tsc --noEmit
```

如果 page-agent 缺少类型声明，在 `src/types/index.ts` 末尾添加：

```typescript
declare module 'page-agent' {
  export class PageAgent { constructor(config: Record<string, unknown>); }
  export function tool<T>(def: {
    description: string;
    inputSchema: import('zod').ZodType<T>;
    execute: (this: PageAgent, args: T) => Promise<string>;
  }): unknown;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePageAgent.ts src/types/index.ts
git commit -m "feat(hooks): add usePageAgent with real page-agent API and Tool Bridge wiring"
```

---

### Task 10: 在 Assistant 中初始化 Page Agent

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: 导入 usePageAgent**

在 `src/components/Assistant/index.tsx` import 区追加：

```typescript
import { usePageAgent } from '../../hooks/usePageAgent';
```

- [ ] **Step 2: 在 Assistant 函数体中调用 hook**

在现有 `const { chatHistory, ... }` 下方添加：

```typescript
  // 初始化 Page Agent（DOM 感知 + Tool Bridge 工具注册）
  usePageAgent();
```

- [ ] **Step 3: 在 `npm run tauri:dev` 中完整验证**

```bash
npm run tauri:dev
```

测试场景 A（单条语句）：
```
SQL 编辑器输入：
  SELECT * FROM orders WHERE status = 'active'

Assistant 面板输入：
  "帮我加上按 created_at 倒序排列"

期望：
  1. DiffPanel 出现，显示 + ORDER BY created_at DESC
  2. 点击"应用"→ Monaco 编辑器更新
  3. 点击"取消"→ 编辑器不变，DiffPanel 消失
```

测试场景 B（多条语句消歧 - 光标定位）：
```
SQL 编辑器输入：
  SELECT * FROM users;
  SELECT * FROM orders

将光标放在第二条语句中，Assistant 输入：
  "帮我加 LIMIT 100"

期望：AI 只修改 SELECT * FROM orders，不影响第一条
```

测试场景 C（多条语句消歧 - 选中文本）：
```
鼠标选中 "SELECT * FROM users"，Assistant 输入：
  "帮我只查询活跃用户"

期望：AI 修改选中的语句
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(assistant): initialize Page Agent for DOM-aware SQL chat"
```

---

## 验收标准

- [ ] `npm test` — sqlParser 单元测试全部通过
- [ ] `npx tsc --noEmit` — 无 TypeScript 错误
- [ ] DiffPanel 展示正确的红/绿 diff 行（LCS 算法，重复行正常）
- [ ] 点击"应用"只替换目标语句，其他语句保持不变
- [ ] 点击"取消"无任何副作用
- [ ] 多条语句时：选中文本 → 优先使用选中；无选中 → 使用光标所在语句
- [ ] 无 LLM 配置时 Page Agent 静默跳过，不影响现有聊天功能

---

## 下一步

完成本计划后，进行 **Plan 2: ER 图聊天设计 + virtual_relations**：
- App SQLite 新增 `virtual_relations` + `er_designs` 表
- ER 画布预览态（虚线节点/连线）
- `generate_ddl` Tool + `@virtual-relations` 注释块
- 详见 `docs/superpowers/specs/2026-03-12-ai-agent-page-interaction-design.md`
