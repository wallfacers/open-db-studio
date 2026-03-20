# Auto 模式直接应用 SQL Diff 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto 模式开启时，AI 提议的 SQL Diff 跳过 DiffPanel 确认，直接写入编辑器并显示短暂闪现状态条。

**Architecture:** 纯前端修改，入口在 `useToolBridge.ts` 的 `sql-diff-proposal` 事件处理器。在匹配循环之前检查 `autoMode`，按四个分支（auto+匹配、auto+不匹配、非auto+匹配、非auto+不匹配）分别处理。新增 `autoApplyBanner` 状态到 `queryStore`，新建 `AutoApplyBanner.tsx` 展示组件。

**Tech Stack:** React 18, TypeScript, Zustand, Tauri `invoke`/`listen`, Vitest + @testing-library/react

---

## 文件映射

| 文件 | 变更类型 | 责任 |
|------|---------|------|
| `src/store/queryStore.ts` | 修改 | 新增 `autoApplyBanner` 状态及 `setAutoApplyBanner` setter |
| `src/store/queryStore.test.ts` | 修改 | 测试 `autoApplyBanner` 状态变更 |
| `src/components/Assistant/AutoApplyBanner.tsx` | 新建 | 绿色闪现状态条组件（无交互） |
| `src/hooks/useToolBridge.ts` | 修改 | 核心逻辑：autoMode 四分支 + Timer 管理 + Bug 修复 |
| `src/hooks/useToolBridge.test.ts` | 新建 | 测试 autoMode 四个分支行为 |
| `src/components/Assistant/index.tsx` | 修改 | 在对话状态和空状态路径中渲染 AutoApplyBanner |

---

## Chunk 1: queryStore — autoApplyBanner 状态

### Task 1: 为 queryStore 新增 autoApplyBanner 状态

**Files:**
- Modify: `src/store/queryStore.ts`
- Modify: `src/store/queryStore.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/store/queryStore.test.ts` 末尾追加：

```ts
describe('autoApplyBanner', () => {
  it('初始值为 null', () => {
    // 重置 store 到干净状态
    useQueryStore.setState({ autoApplyBanner: null });
    expect(useQueryStore.getState().autoApplyBanner).toBeNull();
  });

  it('setAutoApplyBanner 写入 banner', () => {
    useQueryStore.getState().setAutoApplyBanner({ reason: '修复语法错误' });
    expect(useQueryStore.getState().autoApplyBanner).toEqual({ reason: '修复语法错误' });
  });

  it('setAutoApplyBanner(null) 清除 banner', () => {
    useQueryStore.getState().setAutoApplyBanner({ reason: '修复语法错误' });
    useQueryStore.getState().setAutoApplyBanner(null);
    expect(useQueryStore.getState().autoApplyBanner).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run src/store/queryStore.test.ts
```

预期：`FAIL` — `autoApplyBanner is not a function` 或 `Cannot read properties of undefined`

- [ ] **Step 3: 在 queryStore.ts 中新增类型和实现**

在 `src/store/queryStore.ts` 的 `QueryState` interface 末尾，`startExplanation: (tabId: string) => void;`（约第 94 行）之后、interface 闭括号 `}` 之前，新增：

```ts
  // Auto 模式自动应用 Banner（短暂显示后清除）
  autoApplyBanner: { reason: string } | null;
  setAutoApplyBanner: (banner: { reason: string } | null) => void;
```

在 `create<QueryState>` 的实现对象中，`pendingDiff: null,`（约第 170 行）之后紧接新增（与 `pendingDiff: null,` 同一块）：

```ts
  autoApplyBanner: null,
  setAutoApplyBanner: (banner) => set({ autoApplyBanner: banner }),
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run src/store/queryStore.test.ts
```

预期：全部 `PASS`

- [ ] **Step 5: Commit**

```bash
cd /d/project/java/source/open-db-studio
git add src/store/queryStore.ts src/store/queryStore.test.ts
git commit -m "feat(store): 新增 autoApplyBanner 状态及 setter"
```

---

## Chunk 2: AutoApplyBanner 组件

### Task 2: 创建 AutoApplyBanner.tsx 展示组件

**Files:**
- Create: `src/components/Assistant/AutoApplyBanner.tsx`

> 注意：此组件无需单元测试，属纯展示组件（无逻辑）。视觉验证在 Task 4 的手动测试中完成。

- [ ] **Step 1: 创建组件文件**

创建 `src/components/Assistant/AutoApplyBanner.tsx`：

```tsx
import React from 'react';
import { Check } from 'lucide-react';

interface AutoApplyBannerProps {
  reason: string;
}

export const AutoApplyBanner: React.FC<AutoApplyBannerProps> = ({ reason }) => (
  <div className="border-t border-[#1e2d42] bg-[#0d1117]">
    <div className="flex items-center gap-2 px-3 py-2.5">
      <Check size={14} className="text-[#00c9a7] flex-shrink-0" />
      <div className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-[#00c9a7]">AI 已自动应用修改</span>
        {reason && (
          <span className="text-[11px] text-[#5b8ab0] mt-0.5 break-words">{reason}</span>
        )}
      </div>
    </div>
  </div>
);
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd /d/project/java/source/open-db-studio && npx tsc --noEmit
```

预期：无错误输出

- [ ] **Step 3: Commit**

```bash
cd /d/project/java/source/open-db-studio
git add src/components/Assistant/AutoApplyBanner.tsx
git commit -m "feat(ui): 新增 AutoApplyBanner 展示组件"
```

---

## Chunk 3: useToolBridge — 核心逻辑

### Task 3: 修改 useToolBridge.ts 实现 Auto 四分支逻辑

**Files:**
- Modify: `src/hooks/useToolBridge.ts`
- Create: `src/hooks/useToolBridge.test.ts`

背景知识：
- `useAppStore` 提供 `autoMode: boolean` 和 `setAssistantOpen`
- `useQueryStore` 提供 `setSql`, `proposeSqlDiff`, `setAutoApplyBanner`
- Tauri `invoke('mcp_diff_respond', { confirmed: boolean })` 解除 Rust 阻塞
- `parseStatements` 返回 `{ text, startOffset, endOffset }[]`，`endOffset` 不含分号
- 分号消费：`full[match.endOffset] === ';' ? match.endOffset + 1 : match.endOffset`

- [ ] **Step 1: 写失败测试**

创建 `src/hooks/useToolBridge.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type ListenCb<T> = (event: { payload: T }) => void | Promise<void>;
const capturedListeners: Record<string, ListenCb<unknown>> = {};

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, cb: ListenCb<unknown>) => {
    capturedListeners[eventName] = cb;
    return Promise.resolve(() => { delete capturedListeners[eventName]; });
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { renderHook } from '@testing-library/react';
import { useQueryStore } from '../store/queryStore';
import { useAppStore } from '../store/appStore';
import { useToolBridge } from './useToolBridge';

const mockInvoke = vi.mocked(invoke);

// ─── 辅助：触发 sql-diff-proposal 事件 ──────────────────────────────────────
async function emitDiffProposal(payload: { original: string; modified: string; reason: string }) {
  const handler = capturedListeners['sql-diff-proposal'];
  if (!handler) throw new Error('sql-diff-proposal listener not registered');
  await handler({ payload });
}

function mountBridge() {
  return renderHook(() => useToolBridge());
}

// 使用假定时器，防止 setSql 内部的 persistSqlContent 防抖（500ms）跨用例残留
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  // 默认关闭 Auto 模式
  useAppStore.setState({ autoMode: false, isAssistantOpen: false });
  // 初始化 store：tab-1 包含可匹配的 SQL
  useQueryStore.setState({
    tabs: [{ id: 'tab-1', type: 'query', title: 'Q1' }],
    activeTabId: 'tab-1',
    sqlContent: { 'tab-1': 'SELECT 1;' },
    pendingDiff: null,
    autoApplyBanner: null,
  });
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 1: autoMode=false + 找到匹配 → DiffPanel 流程
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=false + 找到匹配', () => {
  it('设置 pendingDiff，不调用 mcp_diff_respond，打开助手面板', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2', reason: '优化' });

    const { pendingDiff, autoApplyBanner } = useQueryStore.getState();
    expect(pendingDiff).not.toBeNull();
    expect(pendingDiff?.original).toBe('SELECT 1');
    expect(autoApplyBanner).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith('mcp_diff_respond', expect.anything());
    // 回归断言：非 Auto 找到匹配时同样打开助手面板（原有行为）
    expect(useAppStore.getState().isAssistantOpen).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 2: autoMode=false + 未找到匹配 → mcp_diff_respond(false)
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=false + 未找到匹配', () => {
  it('调用 mcp_diff_respond(false)，不设 pendingDiff', async () => {
    mountBridge();
    // 'NOT IN EDITOR' 在编辑器 SQL 中找不到
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().pendingDiff).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 3: autoMode=true + 找到匹配 → 直接写 SQL
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=true + 找到匹配', () => {
  beforeEach(() => {
    useAppStore.setState({ autoMode: true, isAssistantOpen: false });
  });

  it('直接更新 sqlContent，不设 pendingDiff', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化' });

    const { sqlContent, pendingDiff } = useQueryStore.getState();
    expect(sqlContent['tab-1']).toBe('SELECT 2;');
    expect(pendingDiff).toBeNull();
  });

  it('调用 mcp_diff_respond(true)', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化' });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: true });
  });

  it('设置 autoApplyBanner', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化查询' });

    expect(useQueryStore.getState().autoApplyBanner).toEqual({ reason: '优化查询' });
  });

  it('打开助手面板', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '' });

    expect(useAppStore.getState().isAssistantOpen).toBe(true);
  });

  it('分号消费：modified 带分号不产生双分号', async () => {
    // full = 'SELECT 1;'，endOffset=8（'SELECT 1' 末尾），full[8]=';'
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '' });

    expect(useQueryStore.getState().sqlContent['tab-1']).toBe('SELECT 2;');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 4: autoMode=true + 未找到匹配 → mcp_diff_respond(false)
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=true + 未找到匹配', () => {
  beforeEach(() => {
    useAppStore.setState({ autoMode: true });
  });

  it('调用 mcp_diff_respond(false)，不修改 sqlContent', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().sqlContent['tab-1']).toBe('SELECT 1;');
    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: false });
  });

  it('不设置 autoApplyBanner', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().autoApplyBanner).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run src/hooks/useToolBridge.test.ts
```

预期：`FAIL` — 当前 `useToolBridge` 没有 autoMode 分支，测试中期望 `mcp_diff_respond` 被调用的用例应失败

- [ ] **Step 3: 改写 useToolBridge.ts**

将 `src/hooks/useToolBridge.ts` 完整替换为：

```ts
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../store/queryStore';
import { useAppStore } from '../store/appStore';
import { parseStatements } from '../utils/sqlParser';

interface DiffProposalPayload {
  original: string;
  modified: string;
  reason: string;
}

/**
 * 挂载全局 Tauri 事件监听器：
 * - 监听 'sql-diff-proposal' 事件（由 MCP server propose_sql_diff 工具触发）
 * - Auto 模式：直接写入 SQL + 触发 Banner + mcp_diff_respond(true)
 * - 非 Auto 模式：调用 proposeSqlDiff 展示 DiffPanel
 * - 任意模式下 original 未找到：mcp_diff_respond(false)（防止 Rust 侧永久阻塞）
 *
 * 需在 App.tsx 根组件中调用，确保全局唯一且生命周期与应用一致。
 * autoApplyTimerRef 依赖本 hook 的全局唯一生命周期。
 */
export function useToolBridge() {
  const autoApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<DiffProposalPayload>('sql-diff-proposal', (event) => {
      const { original, modified, reason } = event.payload;
      const { sqlContent, proposeSqlDiff, setSql, setAutoApplyBanner } = useQueryStore.getState();
      const { autoMode, setAssistantOpen } = useAppStore.getState();

      const normalizeStmt = (s: string) => s.trim().replace(/;+$/, '');
      const originalNorm = normalizeStmt(original);

      // 全量扫描所有 Tab，找到第一个包含 original 文本的 Tab
      for (const [tabId, full] of Object.entries(sqlContent)) {
        const stmts = parseStatements(full);
        const match = stmts.find(s => normalizeStmt(s.text) === originalNorm);
        if (!match) continue;

        if (autoMode) {
          // ── Auto 模式：直接应用，不显示 DiffPanel ──
          // 分号消费：避免 modified 自带分号时产生双分号
          const endOffset = full[match.endOffset] === ';' ? match.endOffset + 1 : match.endOffset;
          const newSql = full.slice(0, match.startOffset) + modified + full.slice(endOffset);

          setSql(tabId, newSql);

          // 触发 Banner（清除旧定时器，防止快速连续触发时旧定时器残留）
          if (autoApplyTimerRef.current) clearTimeout(autoApplyTimerRef.current);
          setAutoApplyBanner({ reason });
          autoApplyTimerRef.current = setTimeout(() => {
            setAutoApplyBanner(null);
            autoApplyTimerRef.current = null;
          }, 1500);

          invoke('mcp_diff_respond', { confirmed: true }).catch(() => {});
          setAssistantOpen(true);
        } else {
          // ── 普通模式：展示 DiffPanel 等待用户确认 ──
          proposeSqlDiff({
            original,
            modified,
            reason,
            tabId,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
          });
          setAssistantOpen(true);
        }
        return;
      }

      // original 在任何 Tab 中均未找到：通知 Rust 失败，防止 oneshot channel 永久阻塞
      console.warn(
        '[useToolBridge] propose_sql_diff: original not found in any tab.',
        'original:', original.slice(0, 80)
      );
      invoke('mcp_diff_respond', { confirmed: false }).catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
      // 清理定时器，防止组件卸载后写入 store
      if (autoApplyTimerRef.current) clearTimeout(autoApplyTimerRef.current);
    };
  }, []); // 仅挂载一次，无依赖
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run src/hooks/useToolBridge.test.ts
```

预期：全部 `PASS`（共 9 个测试用例）

- [ ] **Step 5: 运行全部测试，确认无回归**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run
```

预期：全部已有测试 `PASS`

- [ ] **Step 6: 类型检查**

```bash
cd /d/project/java/source/open-db-studio && npx tsc --noEmit
```

预期：无错误

- [ ] **Step 7: Commit**

```bash
cd /d/project/java/source/open-db-studio
git add src/hooks/useToolBridge.ts src/hooks/useToolBridge.test.ts
git commit -m "feat(bridge): Auto 模式下直接应用 SQL Diff，修复非 Auto 模式未匹配时的 Rust 阻塞 Bug"
```

---

## Chunk 4: Assistant/index.tsx — 渲染 AutoApplyBanner

### Task 4: 在 Assistant 两个状态路径中渲染 AutoApplyBanner

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: 在 Assistant/index.tsx 中引入 AutoApplyBanner**

在 `src/components/Assistant/index.tsx` 文件顶部 import 区域（约第 7 行 DiffPanel 引入之后）新增：

```ts
import { AutoApplyBanner } from './AutoApplyBanner';
```

- [ ] **Step 2: 在 store 中读取 autoApplyBanner**

在 `index.tsx` 中，找到 `const { pendingDiff, applyDiff, cancelDiff } = useQueryStore();` 这一行（约第 138 行），
修改为：

```ts
const { pendingDiff, applyDiff, cancelDiff, autoApplyBanner } = useQueryStore();
```

- [ ] **Step 3: 在对话状态路径中渲染 Banner**

找到 DiffPanel 渲染区域（约第 693–700 行）：

```tsx
{/* SQL Diff 确认面板 */}
{pendingDiff && (
  <DiffPanel
    proposal={pendingDiff}
    onApply={() => { applyDiff(); invoke('mcp_diff_respond', { confirmed: true }).catch(() => {}); }}
    onCancel={() => { cancelDiff(); invoke('mcp_diff_respond', { confirmed: false }).catch(() => {}); }}
  />
)}
```

在其**正下方**新增：

```tsx
{/* Auto 模式自动应用 Banner */}
{autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
```

- [ ] **Step 4: 在空状态路径中渲染 Banner**

找到空状态路径（约第 622 行 `isEmpty ? ...`），在 `<div className="w-full">{renderInputBox()}</div>` 的**上方**新增：

```tsx
{autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
```

**注意**：只需插入一行，不要替换整块代码。原有注释 `{/* 输入框紧跟在提示文字下方 */}` 应保留。修改后局部如下：

```tsx
  {autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
  {/* 输入框紧跟在提示文字下方 */}
  <div className="w-full">{renderInputBox()}</div>
```

- [ ] **Step 5: 类型检查**

```bash
cd /d/project/java/source/open-db-studio && npx tsc --noEmit
```

预期：无错误

- [ ] **Step 6: 运行全部测试**

```bash
cd /d/project/java/source/open-db-studio && npx vitest run
```

预期：全部 `PASS`

- [ ] **Step 7: Commit**

```bash
cd /d/project/java/source/open-db-studio
git add src/components/Assistant/index.tsx
git commit -m "feat(ui): 在 Assistant 面板渲染 AutoApplyBanner（对话状态和空状态路径）"
```

---

## 执行依赖关系

```
Chunk 1 (queryStore)    ──┐
Chunk 2 (AutoApplyBanner) ─┤→ Chunk 3 (useToolBridge) → Chunk 4 (Assistant/index)
```

**可并发执行**：Chunk 1 与 Chunk 2 互相独立，可同时启动。
**Chunk 3** 依赖 Chunk 1（需要 `setAutoApplyBanner`）。
**Chunk 4** 依赖 Chunk 1（`autoApplyBanner` 状态）和 Chunk 2（`AutoApplyBanner` 组件）。
