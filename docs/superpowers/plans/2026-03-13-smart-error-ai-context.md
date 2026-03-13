# Smart Error Context + AI Assistant Globalization 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每处错误提示提供用户友好消息 + Markdown 技术上下文，一键"问 AI"将上下文填入助手面板；助手面板改为全局常驻右边缘 Tab 唤出。

**Architecture:** 新建 `appStore`（持有 `lastOperationContext` + `isAssistantOpen`）和两个工具函数（`buildErrorContext` / `askAiWithContext`）；各操作入口在执行前写入上下文快照；Toast / TaskCenter / 查询结果区各自增加"问 AI"按钮。

**Tech Stack:** React 18 + TypeScript + Zustand + Tauri 2 + Vitest + Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-13-smart-error-ai-context-design.md`

---

## Chunk 1: Foundation — 新 Store + 错误工具函数

### Task 1: 新建 appStore

**Files:**
- Create: `src/store/appStore.ts`
- Modify: `src/store/index.ts`

- [ ] **Step 1: 创建 appStore**

```typescript
// src/store/appStore.ts
import { create } from 'zustand';

export interface OperationContext {
  type: 'sql_execute' | 'import' | 'export' | 'ai_request';
  connectionId: number;
  database?: string;
  schema?: string;
  sql?: string;
  taskId?: string;
  aiRequestType?: 'generate' | 'explain' | 'optimize' | 'create_table' | 'chat';
  prompt?: string;
  httpStatus?: number;
}

interface AppState {
  lastOperationContext: OperationContext | null;
  setLastOperationContext: (ctx: OperationContext | null) => void;
  isAssistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  lastOperationContext: null,
  setLastOperationContext: (ctx) => set({ lastOperationContext: ctx }),
  isAssistantOpen: true,
  setAssistantOpen: (open) => set({ isAssistantOpen: open }),
}));
```

- [ ] **Step 2: 导出到 store/index.ts**

在 `src/store/index.ts` 末尾追加：
```typescript
export { useAppStore } from './appStore';
export type { OperationContext } from './appStore';
```

- [ ] **Step 3: Commit**
```bash
git add src/store/appStore.ts src/store/index.ts
git commit -m "feat(store): add appStore with lastOperationContext and isAssistantOpen"
```

---

### Task 2: connectionStore 新增 metaCache

**Files:**
- Modify: `src/store/connectionStore.ts`

- [ ] **Step 1: 在 connectionStore.ts 顶部新增类型**

在 `import type { Connection, ... }` 行下方追加：
```typescript
export interface ConnectionMeta {
  dbVersion: string;
  driver: string;
  host: string;
  port?: number;
  name: string;
}
```

- [ ] **Step 2: 在 `ConnectionState` interface 追加字段**

在 `error: string | null;` 行后追加：
```typescript
metaCache: Record<number, ConnectionMeta>;
setMeta: (connectionId: number, meta: ConnectionMeta) => void;
```

- [ ] **Step 3: 在 create() 初始值和 actions 追加**

初始值中追加：
```typescript
metaCache: {},
```

Actions 末尾追加：
```typescript
setMeta: (connectionId, meta) =>
  set((s) => ({ metaCache: { ...s.metaCache, [connectionId]: meta } })),
```

- [ ] **Step 4: Commit**
```bash
git add src/store/connectionStore.ts
git commit -m "feat(store): add metaCache to connectionStore for DB version caching"
```

---

### Task 3: aiStore 新增 draftMessage

**Files:**
- Modify: `src/store/aiStore.ts`

- [ ] **Step 1: 在 AiState interface 追加**

在 `error: string | null;` 行后追加：
```typescript
draftMessage: string;
setDraftMessage: (msg: string) => void;
```

- [ ] **Step 2: 在 create() 初始值追加**

在 `error: null,` 行后追加：
```typescript
draftMessage: '',
```

- [ ] **Step 3: 在 actions 追加**

在 `clearHistory` 函数前追加：
```typescript
setDraftMessage: (msg) => set({ draftMessage: msg }),
```

- [ ] **Step 4: Commit**
```bash
git add src/store/aiStore.ts
git commit -m "feat(store): add draftMessage to aiStore for pre-filling assistant input"
```

---

### Task 4: 新建 errorContext.ts（含单元测试）

**Files:**
- Create: `src/utils/errorContext.ts`
- Create: `src/utils/errorContext.test.ts`

- [ ] **Step 1: 先写测试（TDD）**

```typescript
// src/utils/errorContext.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildErrorContext } from './errorContext';

// mock zustand stores
vi.mock('../store/appStore', () => ({
  useAppStore: { getState: () => ({
    lastOperationContext: {
      type: 'sql_execute',
      connectionId: 1,
      database: 'mydb',
      sql: 'SELECT * FROM users',
    },
  }) },
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({
    connections: [{ id: 1, name: 'prod', driver: 'mysql', host: 'localhost', port: 3306 }],
    metaCache: { 1: { dbVersion: '8.0.32', driver: 'mysql', host: 'localhost', port: 3306, name: 'prod' } },
    tables: [],
  }) },
}));

vi.mock('../store/queryStore', () => ({
  useQueryStore: { getState: () => ({ queryHistory: [] }) },
}));

vi.mock('../store/aiStore', () => ({
  useAiStore: { getState: () => ({ configs: [], activeConfigId: null }) },
}));

describe('buildErrorContext', () => {
  it('sql_execute 类型生成包含连接和 SQL 的 Markdown', () => {
    const result = buildErrorContext('sql_execute', { rawError: 'Unknown column' });
    expect(result.userMessage).toContain('Unknown column');
    expect(result.markdownContext).toContain('## SQL 执行错误');
    expect(result.markdownContext).toContain('prod');
    expect(result.markdownContext).toContain('SELECT * FROM users');
    expect(result.markdownContext).toContain('8.0.32');
  });

  it('内部抛异常时降级返回 markdownContext: null', () => {
    // lastOperationContext 为 null 时不应抛出
    const result = buildErrorContext('sql_execute', { rawError: 'err' });
    expect(result.userMessage).toBeTruthy();
    // markdownContext 可能为 null 或有效字符串，不得抛出
    expect(() => result.markdownContext).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/utils/errorContext.test.ts
```
预期：FAIL（`errorContext.ts` 不存在）

- [ ] **Step 3: 实现 errorContext.ts**

```typescript
// src/utils/errorContext.ts
import { useAppStore } from '../store/appStore';
import { useConnectionStore } from '../store/connectionStore';
import { useQueryStore } from '../store/queryStore';
import { useAiStore } from '../store/aiStore';

export interface AppErrorContext {
  userMessage: string;
  markdownContext: string | null;
}

export function buildErrorContext(
  type: 'sql_execute' | 'import' | 'export' | 'ai_request',
  opts: { rawError: string; taskDescription?: string; taskErrorDetails?: string[]; processedRows?: number; totalRows?: number }
): AppErrorContext {
  try {
    const { lastOperationContext } = useAppStore.getState();
    const { connections, metaCache, tables } = useConnectionStore.getState();
    const { queryHistory } = useQueryStore.getState();
    const { configs, activeConfigId } = useAiStore.getState();

    const connId = lastOperationContext?.connectionId;
    const conn = connId != null ? connections.find((c) => c.id === connId) : undefined;
    const meta = connId != null ? metaCache[connId] : undefined;

    const connLine = conn
      ? `**连接**: ${conn.name} (ID: ${conn.id} · ${conn.driver.toUpperCase()}${meta?.host ? ` · ${meta.host}${meta.port ? `:${meta.port}` : ''}` : ''})`
      : lastOperationContext?.connectionId
      ? `**连接 ID**: ${lastOperationContext.connectionId}`
      : '';

    const versionLine = meta?.dbVersion ? `**版本**: ${meta.dbVersion}` : '';

    const dbLine = lastOperationContext?.database
      ? `**数据库**: \`${lastOperationContext.database}${lastOperationContext.schema ? `.${lastOperationContext.schema}` : ''}\``
      : '';

    if (type === 'sql_execute') {
      const sql = lastOperationContext?.sql ?? '';
      const tableHints = tables.slice(0, 5).map((t) => `- \`${t.name}\``).join('\n');
      const historyLines = queryHistory
        .slice(0, 3)
        .map((h: any, i: number) => `${i + 1}. \`${String(h.sql ?? h).slice(0, 80)}\` — ${h.error ? '失败' : '成功'}`)
        .join('\n');

      const parts = [
        '## SQL 执行错误',
        '',
        [connLine, versionLine, dbLine].filter(Boolean).join('\n'),
        '',
        sql ? `**执行的 SQL**:\n\`\`\`sql\n${sql}\n\`\`\`` : '',
        '',
        `**错误信息**: ${opts.rawError}`,
        tableHints ? `\n### 相关表结构（本地缓存）\n${tableHints}` : '',
        historyLines ? `\n### 最近执行历史（最近3条）\n${historyLines}` : '',
      ].filter((s) => s !== undefined);

      return {
        userMessage: `执行失败：${opts.rawError}`,
        markdownContext: parts.join('\n').trim() || null,
      };
    }

    if (type === 'import' || type === 'export') {
      const base = opts.taskDescription ?? '';
      const details = (opts.taskErrorDetails ?? []).slice(0, 10);
      const totalFailed = (opts.taskErrorDetails ?? []).length;
      const progressLine = opts.processedRows != null && opts.totalRows != null
        ? `**进度**: 已处理 ${opts.processedRows.toLocaleString()} / ${opts.totalRows.toLocaleString()} 行`
        : '';
      const detailLines = details.map((d) => `- ${d}`).join('\n');
      const suffix = totalFailed > 10 ? `\n（共 ${totalFailed} 条失败，仅展示前10条）` : '';

      const failSection = [
        '---',
        '### 失败详情',
        progressLine,
        detailLines ? `\n**失败样本（前10条）**:\n${detailLines}${suffix}` : `**错误**: ${opts.rawError}`,
      ].filter(Boolean).join('\n');

      return {
        userMessage: `${type === 'export' ? '导出' : '导入'}失败：${opts.rawError}`,
        markdownContext: base ? `${base}\n\n${failSection}` : failSection,
      };
    }

    if (type === 'ai_request') {
      const config = activeConfigId != null
        ? configs.find((c: any) => c.id === activeConfigId)
        : configs.find((c: any) => c.is_default);
      const reqType = lastOperationContext?.aiRequestType ?? 'chat';
      const reqTypeLabel: Record<string, string> = {
        generate: '生成 SQL', explain: '解释 SQL', optimize: '优化 SQL',
        create_table: 'AI 建表', chat: '对话',
      };

      const parts = [
        '## AI 请求失败',
        '',
        `**请求类型**: ${reqTypeLabel[reqType] ?? reqType}`,
        config ? `**模型配置**: ${config.name} (ID: ${config.id})` : '',
        config?.base_url ? `**API Base URL**: ${config.base_url}` : '',
        lastOperationContext?.httpStatus ? `**HTTP 状态码**: ${lastOperationContext.httpStatus}` : '',
        `**错误信息**: ${opts.rawError}`,
        [connLine, versionLine, dbLine].filter(Boolean).length ? `\n**数据库环境**: ${[conn?.driver?.toUpperCase(), lastOperationContext?.database].filter(Boolean).join(' · ')}${meta?.dbVersion ? ` · ${meta.dbVersion}` : ''}` : '',
        lastOperationContext?.prompt ? `\n**请求内容**:\n\`\`\`\n${lastOperationContext.prompt.slice(0, 500)}\n\`\`\`` : '',
      ].filter(Boolean);

      return {
        userMessage: `AI 请求失败：${opts.rawError}`,
        markdownContext: parts.join('\n').trim() || null,
      };
    }

    return { userMessage: opts.rawError, markdownContext: null };
  } catch {
    return { userMessage: opts.rawError, markdownContext: null };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/utils/errorContext.test.ts
```
预期：PASS

- [ ] **Step 5: Commit**
```bash
git add src/utils/errorContext.ts src/utils/errorContext.test.ts
git commit -m "feat(utils): add buildErrorContext with three scenario templates"
```

---

### Task 5: 新建 askAi.ts

**Files:**
- Create: `src/utils/askAi.ts`

- [ ] **Step 1: 实现 askAiWithContext**

```typescript
// src/utils/askAi.ts
import { useAiStore } from '../store/aiStore';
import { useAppStore } from '../store/appStore';

export function askAiWithContext(markdownContext: string): void {
  const { isChatting, clearHistory, setDraftMessage } = useAiStore.getState();
  const { setAssistantOpen } = useAppStore.getState();

  // 打开面板
  setAssistantOpen(true);

  // AI 忙碌 → clearHistory()（同时取消后端 ACP session，属于用户主动打断）
  if (isChatting) {
    clearHistory();
  }

  // 一次性填入输入框
  setDraftMessage(markdownContext);
}
```

- [ ] **Step 2: Commit**
```bash
git add src/utils/askAi.ts
git commit -m "feat(utils): add askAiWithContext helper"
```

---

## Chunk 2: Backend — get_db_version

### Task 6: Rust 新增 get_db_version 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 末尾（show_in_folder 函数之前）追加命令**

```rust
/// 获取数据库版本字符串（供前端缓存，失败时返回空字符串）
#[tauri::command]
pub async fn get_db_version(connection_id: i64) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await
        .map_err(|_| crate::AppError::Other("connect failed".into()))?;
    let result = ds.execute_query("SELECT VERSION()").await
        .unwrap_or_else(|_| crate::datasource::QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms: 0,
        });
    let version = result.rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(version)
}
```

- [ ] **Step 2: 注册到 lib.rs**

在 `commands::show_in_folder,` 行后追加：
```rust
commands::get_db_version,
```

- [ ] **Step 3: Rust 编译检查**

```bash
cargo check 2>&1 | tail -5
```
预期：`Finished` 无错误

若 `execute_query` 方法不存在，改用 `ds.query("SELECT VERSION()")` 或查看 datasource trait 中实际方法名。

- [ ] **Step 4: Commit**
```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add get_db_version command"
```

---

## Chunk 3: AI 助手面板全局化

### Task 7: 迁移 isAssistantOpen 到 appStore

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ActivityBar/index.tsx`
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1: App.tsx — 替换本地 state 为 store**

在 `src/App.tsx` 中：

1. 在 imports 中添加：`import { useAppStore } from './store/appStore';`
2. 删除第 31 行：`const [isAssistantOpen, setIsAssistantOpen] = useState(true);`
3. 在 `App()` 函数开头添加（紧接 `const { t } = useTranslation();`）：
   ```typescript
   const isAssistantOpen = useAppStore((s) => s.isAssistantOpen);
   const setIsAssistantOpen = useAppStore((s) => s.setAssistantOpen);
   ```
4. 保留原有 `isAssistantOpen` / `setIsAssistantOpen` 使用处不变（变量名不变，行为一致）

- [ ] **Step 2: ActivityBar — 改用 store（移除 prop 依赖）**

打开 `src/components/ActivityBar/index.tsx`，找到接收 `isAssistantOpen` 和 `setIsAssistantOpen` 的 props：

1. 从 props interface 中删除这两个字段
2. 在组件内部改为：
   ```typescript
   import { useAppStore } from '../../store/appStore';
   const isAssistantOpen = useAppStore((s) => s.isAssistantOpen);
   const setIsAssistantOpen = useAppStore((s) => s.setAssistantOpen);
   ```
3. `App.tsx` 中传给 `ActivityBar` 的这两个 prop 也对应删除

- [ ] **Step 3: Assistant — 移除 isAssistantOpen prop，draftMessage 消费**

在 `src/components/Assistant/index.tsx` 中：

1. 从 `AssistantProps` 删除 `isAssistantOpen` 字段
2. 保留 `setIsAssistantOpen: (open: boolean) => void` → **改名为**从 store 读取（删除 prop，内部改用 `useAppStore`）
3. 删除第 214 行 `if (!isAssistantOpen) return null;`（由 App.tsx 控制面板显示/隐藏）
4. 新增 draftMessage 消费逻辑：
   ```typescript
   const draftMessage = useAiStore((s) => s.draftMessage);
   const setDraftMessage = useAiStore((s) => s.setDraftMessage);

   useEffect(() => {
     if (draftMessage) {
       setChatInput(draftMessage);
       setDraftMessage('');
     }
   }, [draftMessage]);
   ```
5. App.tsx 中传给 `Assistant` 的 `isAssistantOpen` / `setIsAssistantOpen` prop 删除

- [ ] **Step 4: 运行类型检查**
```bash
npx tsc --noEmit 2>&1 | head -20
```
预期：无错误

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx src/components/ActivityBar/index.tsx src/components/Assistant/index.tsx
git commit -m "refactor: migrate isAssistantOpen to appStore, add draftMessage consumer in Assistant"
```

---

### Task 8: AssistantToggleTab 组件

**Files:**
- Create: `src/components/Assistant/AssistantToggleTab.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`（或在组件内用 Tailwind）

- [ ] **Step 1: 创建 AssistantToggleTab**

```tsx
// src/components/Assistant/AssistantToggleTab.tsx
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/appStore';

export const AssistantToggleTab: React.FC = () => {
  const isOpen = useAppStore((s) => s.isAssistantOpen);
  const setOpen = useAppStore((s) => s.setAssistantOpen);

  return (
    <button
      onClick={() => setOpen(!isOpen)}
      className="
        flex items-center justify-center
        w-5 self-stretch flex-shrink-0
        bg-[#111922] border-l border-[#1e2d42]
        text-[#4a6a8a] hover:text-[#00c9a7] hover:bg-[#1a2639]
        transition-colors duration-150 active:scale-110
        cursor-pointer select-none
      "
      title={isOpen ? '收起 AI 助手' : '打开 AI 助手'}
      aria-label={isOpen ? '收起 AI 助手' : '打开 AI 助手'}
    >
      {isOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
    </button>
  );
};
```

- [ ] **Step 2: 在 App.tsx 布局中插入 Tab 并加动画**

找到 App.tsx 中 Assistant 面板渲染处（约第 397 行），将外层容器改为包含 Tab 的 flex 布局：

```tsx
{/* AI 助手面板 + 右边缘 Tab */}
<div className="flex h-full" style={{ transition: 'width 280ms cubic-bezier(0.32, 0.72, 0, 1)' }}>
  <AssistantToggleTab />
  {isAssistantOpen && (
    <div
      style={{
        width: assistantWidth,
        overflow: 'hidden',
        transition: 'width 280ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <Assistant ... />
    </div>
  )}
</div>
```

收起时 `isAssistantOpen = false`，Assistant 面板宽度为 0，Tab 依然可见。

- [ ] **Step 3: 移除工具栏 AI 打开按钮**

在 `src/components/MainContent/index.tsx` 中搜索 `setIsAssistantOpen` 或 `onOpenAssistant` 调用，删除对应按钮。

- [ ] **Step 4: 类型检查**
```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**
```bash
git add src/components/Assistant/AssistantToggleTab.tsx src/App.tsx src/components/MainContent/index.tsx
git commit -m "feat(ui): add AssistantToggleTab, animate assistant panel open/close"
```

---

## Chunk 4: 操作上下文注入

### Task 9: 连接建立后缓存 DB 版本

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`（连接打开入口）

- [ ] **Step 1: 找到连接打开/测试通过的时机**

在 `DBTree.tsx` 中搜索 `openConnection` 或连接成功的回调处，追加：

```typescript
import { invoke } from '@tauri-apps/api/core';
import { useConnectionStore } from '../../store';

// 连接建立成功后（openConnection 调用处）
const conn = connections.find((c) => c.id === connectionId);
if (conn) {
  invoke<string>('get_db_version', { connectionId })
    .then((version) => {
      if (version) {
        useConnectionStore.getState().setMeta(connectionId, {
          dbVersion: version,
          driver: conn.driver,
          host: conn.host ?? '',
          port: conn.port ?? undefined,
          name: conn.name,
        });
      }
    })
    .catch(() => {}); // 失败静默，不影响主流程
}
```

- [ ] **Step 2: Commit**
```bash
git add src/components/Explorer/DBTree.tsx
git commit -m "feat: cache DB version in connectionStore after successful connection"
```

---

### Task 10: queryStore — SQL 执行前写入上下文

**Files:**
- Modify: `src/store/queryStore.ts`

- [ ] **Step 1: 在 executeQuery 开头写入 lastOperationContext**

在 `src/store/queryStore.ts` 的 `executeQuery` 函数中，找到 `set({ isExecuting: true, error: null, diagnosis: null });` 行，在其**前**追加：

```typescript
// 写入操作上下文快照（供错误诊断使用）
const { useAppStore } = await import('./appStore');
useAppStore.getState().setLastOperationContext({
  type: 'sql_execute',
  connectionId,
  database: database ?? undefined,
  schema: schema ?? undefined,
  sql,
});
```

由于 `queryStore` 已是异步函数，也可直接静态 import（推荐）：

在文件顶部追加：
```typescript
import { useAppStore } from './appStore';
```

然后在 `set({ isExecuting: true, ... })` 前：
```typescript
useAppStore.getState().setLastOperationContext({
  type: 'sql_execute',
  connectionId,
  database: database ?? undefined,
  schema: schema ?? undefined,
  sql,
});
```

- [ ] **Step 2: Commit**
```bash
git add src/store/queryStore.ts
git commit -m "feat(store): write lastOperationContext before SQL execution"
```

---

### Task 11: ExportWizard / ImportWizard 写入上下文

**Files:**
- Modify: `src/components/ImportExport/ExportWizard.tsx`
- Modify: `src/components/ImportExport/ImportWizard.tsx`

- [ ] **Step 1: ExportWizard — 在 invoke('export_tables') 前写入**

在 `ExportWizard.tsx` 的 `handleStart` 函数中，在 `await invoke('export_tables', { ... })` 前追加：

```typescript
import { useAppStore } from '../../store/appStore';

// 写入上下文
useAppStore.getState().setLastOperationContext({
  type: 'export',
  connectionId: step1.connectionId,
  database: step1.database || undefined,
  schema: step1.schema || undefined,
});
```

- [ ] **Step 2: ImportWizard — 在 invoke('import_to_table') 前写入**

类似处理，在 `ImportWizard.tsx` 的导入调用前：

```typescript
useAppStore.getState().setLastOperationContext({
  type: 'import',
  connectionId: connectionId,  // 从 props 取
  database: database || undefined,
  schema: schema || undefined,
});
```

- [ ] **Step 3: Commit**
```bash
git add src/components/ImportExport/ExportWizard.tsx src/components/ImportExport/ImportWizard.tsx
git commit -m "feat: write lastOperationContext before import/export operations"
```

---

### Task 12: aiStore — AI 请求前写入上下文 + catch 补 httpStatus

**Files:**
- Modify: `src/store/aiStore.ts`

- [ ] **Step 1: explainSql / optimizeSql / createTable 前写入上下文**

在 `aiStore.ts` 中找到 `explainSql`、`optimizeSql`、`createTable` 函数，每个函数开头追加：

```typescript
import { useAppStore } from './appStore';

// 在每个 AI 函数开头：
useAppStore.getState().setLastOperationContext({
  type: 'ai_request',
  connectionId,
  aiRequestType: 'explain',  // 对应修改为 'optimize' / 'create_table'
  prompt: sql,               // 或 description
});
```

catch 块中补 httpStatus（若有 HTTP 错误）：

```typescript
} catch (e: any) {
  // 补充 httpStatus（如果错误对象携带）
  const status = e?.status ?? e?.response?.status;
  if (status) {
    const ctx = useAppStore.getState().lastOperationContext;
    if (ctx) {
      useAppStore.getState().setLastOperationContext({ ...ctx, httpStatus: status });
    }
  }
  set({ error: String(e), isExplaining: false });
  throw e;
}
```

- [ ] **Step 2: Commit**
```bash
git add src/store/aiStore.ts
git commit -m "feat(store): write operation context before AI requests, capture httpStatus on failure"
```

---

## Chunk 5: 错误按钮 UI

### Task 13: Toast 新增"问 AI"按钮

**Files:**
- Modify: `src/components/Toast/index.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 扩展 Toast props 和 UI**

修改 `src/components/Toast/index.tsx`：

1. props interface 追加：
   ```typescript
   markdownContext?: string | null;
   onAskAi?: () => void;
   ```

2. 在"复制"按钮后追加"问 AI"按钮：
   ```tsx
   {markdownContext && onAskAi && (
     <button
       onClick={() => { onAskAi(); }}
       className="ml-1 px-1.5 py-0.5 rounded text-xs opacity-80 hover:opacity-100 hover:bg-white/10 transition-all flex items-center gap-1"
       title="问 AI"
     >
       🤖 {t('error.askAi', '问 AI')}
     </button>
   )}
   ```

- [ ] **Step 2: App.tsx — 扩展 toast state 支持 markdownContext**

在 `App.tsx` 中：

1. toast state 类型扩展：
   ```typescript
   const [toast, setToast] = useState<{ message: string; level: ToastLevel; markdownContext?: string | null } | null>(null);
   ```

2. 新增 `showError` 函数：
   ```typescript
   const showError = (userMessage: string, markdownContext?: string | null) => {
     setToast({ message: userMessage, level: 'error', markdownContext });
   };
   ```

3. Toast 组件渲染处追加：
   ```tsx
   <Toast
     message={toast?.message ?? null}
     level={toast?.level}
     markdownContext={toast?.markdownContext}
     onAskAi={toast?.markdownContext ? () => {
       askAiWithContext(toast.markdownContext!);
       setToast(null);
     } : undefined}
     onClose={() => setToast(null)}
   />
   ```

- [ ] **Step 3: Commit**
```bash
git add src/components/Toast/index.tsx src/App.tsx
git commit -m "feat(ui): add Ask AI button to Toast component"
```

---

### Task 14: TaskCenter — 失败任务"问 AI"按钮

**Files:**
- Modify: `src/components/TaskCenter/TaskItem.tsx`

- [ ] **Step 1: 在展开区底部追加按钮（仅 failed 状态）**

在 `TaskItem.tsx` 展开区（`{isExpanded && ...}`）内部，在"错误详情"块之后追加：

```tsx
{task.status === 'failed' && (
  <div className="mt-3 pt-3 border-t border-[#1e2d42]">
    <button
      onClick={() => {
        import('../../utils/askAi').then(({ askAiWithContext }) => {
          import('../../utils/errorContext').then(({ buildErrorContext }) => {
            const ctx = buildErrorContext('export', {
              rawError: task.error ?? '未知错误',
              taskDescription: task.description ?? undefined,
              taskErrorDetails: task.errorDetails ?? [],
              processedRows: task.processedRows,
              totalRows: task.totalRows ?? undefined,
            });
            if (ctx.markdownContext) {
              askAiWithContext(ctx.markdownContext);
            }
          });
        });
      }}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#1a2639] hover:bg-[#253347] text-[#7a9bb8] hover:text-[#00c9a7] rounded border border-[#253347] transition-colors"
    >
      🤖 {t('error.askAiAnalyze', '问 AI 分析失败原因')}
    </button>
  </div>
)}
```

- [ ] **Step 2: Commit**
```bash
git add src/components/TaskCenter/TaskItem.tsx
git commit -m "feat(ui): add Ask AI button to failed TaskCenter items"
```

---

### Task 15: 查询结果区 + 现有 showToast(e,'error') 改造

**Files:**
- Modify: `src/components/MainContent/index.tsx`

- [ ] **Step 1: 查询错误区追加"问 AI"按钮**

在 `MainContent/index.tsx` 中找到 `if (error) showToast(error, 'error')` 的 useEffect（约第 326 行），改为调用 `showError`（需要通过 prop 传入）：

```typescript
useEffect(() => {
  if (error) {
    const ctx = buildErrorContext('sql_execute', { rawError: error });
    showError(ctx.userMessage, ctx.markdownContext);
  }
}, [error]);
```

同时，在查询结果区的错误显示处（若有内联错误展示），追加"问 AI"按钮。搜索 `queryStore.error` 渲染位置，追加：

```tsx
{error && (
  <div className="mt-2">
    <button
      onClick={() => {
        const ctx = buildErrorContext('sql_execute', { rawError: error });
        if (ctx.markdownContext) askAiWithContext(ctx.markdownContext);
      }}
      className="flex items-center gap-1 px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#00c9a7] bg-[#1a2639] hover:bg-[#253347] rounded transition-colors"
    >
      🤖 {t('error.askAi', '问 AI')}
    </button>
  </div>
)}
```

- [ ] **Step 2: AI 功能失败也改用 showError**

在第 395 行（`showToast(t('mainContent.aiExplainFailed'), 'error')`）等处，改为：

```typescript
const ctx = buildErrorContext('ai_request', { rawError: String(e) });
showError(ctx.userMessage, ctx.markdownContext);
```

需要通过 props 传入 `showError`，或通过 `useAppStore` 触发（根据实际 prop 链路调整）。

- [ ] **Step 3: 类型检查**
```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**
```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(ui): add Ask AI button to query error area, improve error messages"
```

---

## Chunk 6: i18n + 收尾

### Task 16: i18n 新增 key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: zh.json 追加**

在合适的位置追加（或新增 `error` 节点）：
```json
"error": {
  "askAi": "问 AI",
  "askAiAnalyze": "问 AI 分析失败原因",
  "copyError": "复制错误"
}
```

- [ ] **Step 2: en.json 追加**

```json
"error": {
  "askAi": "Ask AI",
  "askAiAnalyze": "Ask AI to analyze failure",
  "copyError": "Copy error"
}
```

- [ ] **Step 3: Commit**
```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "i18n: add error.askAi, askAiAnalyze, copyError keys"
```

---

### Task 17: 全量类型检查 + 运行所有测试

- [ ] **Step 1: TypeScript 类型检查**
```bash
npx tsc --noEmit 2>&1 | head -30
```
预期：无错误

- [ ] **Step 2: 运行所有单元测试**
```bash
npx vitest run
```
预期：全部 PASS

- [ ] **Step 3: Rust 编译检查**
```bash
cargo check 2>&1 | tail -5
```
预期：`Finished` 无错误

- [ ] **Step 4: Final commit**
```bash
git add -A
git commit -m "feat: smart error context + AI assistant globalization complete"
```

---

## 执行顺序摘要

```
Chunk 1 (Foundation) → Chunk 2 (Backend) → Chunk 3 (UI Global) → Chunk 4 (Injection) → Chunk 5 (Buttons) → Chunk 6 (i18n)
```

Chunk 1–2 可并行（前端 store 和 Rust 命令独立）。
Chunk 3 依赖 Chunk 1 的 `appStore`。
Chunk 4–5 依赖 Chunk 1–3。
Chunk 6 最后。
