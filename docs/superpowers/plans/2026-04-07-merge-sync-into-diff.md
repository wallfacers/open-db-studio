# Merge Sync Button Into Diff Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除工具栏独立的 Sync 按钮，将全量同步能力合并到 Diff 对话框，消除功能歧义，提升用户体验。

**Architecture:** 工具栏只保留 Diff 入口；Diff 对话框在"无差异"状态下增加"全量从数据库刷新"按钮，让用户仍能一步完成全量同步；有差异时现有"从数据库同步"按钮不变（默认全选即等同于原 Sync 行为）。

**Tech Stack:** React 18 + TypeScript，react-i18next，Zustand，Tauri invoke

---

## 文件变更总览

| 文件 | 操作 |
|------|------|
| `src/components/ERDesigner/ERCanvas/ERToolbar.tsx` | 删除 Sync 按钮、`onSync` prop、`isSyncing` state、`handleSync`、`RefreshCw` import |
| `src/components/ERDesigner/dialogs/DiffReportDialog.tsx` | 新增 `onFullSync` prop；"无差异"区域增加全量刷新按钮 |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 移除 `onSync` 传入；为 DiffReportDialog 传入 `onFullSync` |
| `src/i18n/locales/zh.json` | 删除 `syncDB`/`syncing`/`sync`，新增 `fullRefreshFromDb` |
| `src/i18n/locales/en.json` | 同上 |

---

## Task 1: 更新 i18n，删除废弃 key，新增全量刷新 key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: 删除 zh.json 中的 syncDB / syncing / sync，新增 fullRefreshFromDb**

在 `src/i18n/locales/zh.json` 中找到 erDesigner 节点，做以下改动：

删除：
```json
"syncDB": "同步数据库",
"syncing": "同步中...",
"sync": "同步",
```

新增（在 `noDiff` 行之后）：
```json
"fullRefreshFromDb": "全量从数据库刷新",
```

- [ ] **Step 2: 删除 en.json 中的 syncDB / syncing / sync，新增 fullRefreshFromDb**

在 `src/i18n/locales/en.json` 中找到 erDesigner 节点，做以下改动：

删除：
```json
"syncDB": "Sync DB",
"syncing": "Syncing...",
"sync": "Sync",
```

新增（在 `noDiff` 行之后）：
```json
"fullRefreshFromDb": "Full Refresh from DB",
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

期望：无 i18n key 相关报错（i18n key 为字符串，不会报类型错）

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "i18n: remove unused sync keys, add fullRefreshFromDb"
```

---

## Task 2: ERToolbar — 删除 Sync 按钮

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/ERToolbar.tsx`

- [ ] **Step 1: 从 import 中移除 RefreshCw**

将：
```typescript
import {
  Plus,
  LayoutGrid,
  Database,
  Download,
  Upload,
  FileCode,
  GitCompare,
  RefreshCw,
  Link2,
  Unlink,
  Settings,
} from 'lucide-react';
```

改为：
```typescript
import {
  Plus,
  LayoutGrid,
  Database,
  Download,
  Upload,
  FileCode,
  GitCompare,
  Link2,
  Unlink,
  Settings,
} from 'lucide-react';
```

- [ ] **Step 2: 从 ERToolbarProps 接口删除 onSync**

将：
```typescript
export interface ERToolbarProps {
  projectId: number;
  onOpenDDL: () => void;
  onOpenDiff: () => void;
  onOpenImport: () => void;
  setNodes?: (nodes: Node[]) => void;
  tables?: Array<{ id: number; position_x: number; position_y: number }>;
  nodes?: Node[];
  edges?: Edge[];
  onTableAdded?: (table: ErTable) => void;
  onOpenBind?: () => void;
  onAutoLayout?: () => void;
  hasConnection?: boolean;
  databaseName?: string | null;
  onOpenSettings?: () => void;
  onSync?: () => Promise<void>;
}
```

改为（删除最后一行 `onSync`）：
```typescript
export interface ERToolbarProps {
  projectId: number;
  onOpenDDL: () => void;
  onOpenDiff: () => void;
  onOpenImport: () => void;
  setNodes?: (nodes: Node[]) => void;
  tables?: Array<{ id: number; position_x: number; position_y: number }>;
  nodes?: Node[];
  edges?: Edge[];
  onTableAdded?: (table: ErTable) => void;
  onOpenBind?: () => void;
  onAutoLayout?: () => void;
  hasConnection?: boolean;
  databaseName?: string | null;
  onOpenSettings?: () => void;
}
```

- [ ] **Step 3: 从函数参数解构中删除 onSync**

将：
```typescript
export default function ERToolbar({
  projectId,
  onOpenDDL,
  onOpenDiff,
  onOpenImport,
  setNodes,
  tables = [],
  nodes = [],
  edges = [],
  onTableAdded,
  onOpenBind,
  onAutoLayout,
  hasConnection = false,
  databaseName,
  onOpenSettings,
  onSync,
}: ERToolbarProps) {
```

改为（删除 `onSync,`）：
```typescript
export default function ERToolbar({
  projectId,
  onOpenDDL,
  onOpenDiff,
  onOpenImport,
  setNodes,
  tables = [],
  nodes = [],
  edges = [],
  onTableAdded,
  onOpenBind,
  onAutoLayout,
  hasConnection = false,
  databaseName,
  onOpenSettings,
}: ERToolbarProps) {
```

- [ ] **Step 4: 删除 isSyncing state 和 handleSync 函数**

删除以下代码（约第 76-151 行中涉及 sync 的部分）：

删除 state 声明：
```typescript
const [isSyncing, setIsSyncing] = useState(false);
```

删除 handleSync 函数：
```typescript
// 同步数据库
const handleSync = async () => {
  if (!onSync) return;
  setIsSyncing(true);
  try {
    await onSync();
    showToast('同步成功', 'success');
  } catch (e) {
    console.error('Sync failed:', e);
    showError(`同步失败: ${e}`);
  } finally {
    setIsSyncing(false);
  }
};
```

- [ ] **Step 5: 删除 JSX 中的 Sync 按钮**

删除以下整段 JSX（约在 DDL/Diff/Sync 组内）：
```tsx
<Tooltip content={hasConnection ? t('erDesigner.syncDB') : t('erDesigner.noConnectionTip')} className="flex items-center">
  <button
    onClick={handleSync}
    disabled={!hasConnection || isSyncing}
    className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
  >
    <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
    <span>{isSyncing ? t('erDesigner.syncing') : t('erDesigner.sync')}</span>
  </button>
</Tooltip>
```

- [ ] **Step 6: 类型检查**

```bash
npx tsc --noEmit
```

期望：0 errors

- [ ] **Step 7: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/ERToolbar.tsx
git commit -m "feat(er-designer): remove redundant Sync button from toolbar"
```

---

## Task 3: DiffReportDialog — 无差异时新增全量刷新按钮

**Files:**
- Modify: `src/components/ERDesigner/dialogs/DiffReportDialog.tsx`

- [ ] **Step 1: 新增 RefreshCw import 和 onFullSync prop**

在文件顶部 import 中，将：
```typescript
import { CheckCircle2, AlertTriangle, Trash2 } from 'lucide-react';
```
改为：
```typescript
import { CheckCircle2, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
```

将 DiffReportDialogProps 接口中：
```typescript
export interface DiffReportDialogProps {
  visible: boolean;
  projectId: number;
  connectionInfo: { name: string; database: string } | null;
  onClose: () => void;
  onSyncToDb: (diff: DiffResult) => void;
  onSyncFromDb: (selectedChanges: SelectedChange[]) => void;
}
```
改为：
```typescript
export interface DiffReportDialogProps {
  visible: boolean;
  projectId: number;
  connectionInfo: { name: string; database: string } | null;
  onClose: () => void;
  onSyncToDb: (diff: DiffResult) => void;
  onSyncFromDb: (selectedChanges: SelectedChange[]) => void;
  onFullSync: () => void;
}
```

- [ ] **Step 2: 在函数参数中解构 onFullSync，新增 isFullSyncing state**

将函数签名：
```typescript
export const DiffReportDialog: React.FC<DiffReportDialogProps> = ({
  visible,
  projectId,
  connectionInfo,
  onClose,
  onSyncToDb,
  onSyncFromDb,
}) => {
```
改为：
```typescript
export const DiffReportDialog: React.FC<DiffReportDialogProps> = ({
  visible,
  projectId,
  connectionInfo,
  onClose,
  onSyncToDb,
  onSyncFromDb,
  onFullSync,
}) => {
```

在 `const [loading, setLoading] = useState(false);` 之后新增：
```typescript
const [isFullSyncing, setIsFullSyncing] = useState(false);
```

- [ ] **Step 3: 新增 handleFullSync 函数**

在 `handleSyncFromDb` 函数之后，新增：
```typescript
const handleFullSync = async () => {
  setIsFullSyncing(true);
  try {
    await onFullSync();
    onClose();
  } finally {
    setIsFullSyncing(false);
  }
};
```

- [ ] **Step 4: 替换"无差异"区域的 JSX，加入全量刷新按钮**

将：
```tsx
{/* 无差异 */}
{diffResult.added_tables.length === 0 &&
  diffResult.removed_tables.length === 0 &&
  diffResult.modified_tables.length === 0 && (
    <div className="text-center py-4 text-xs text-accent">{t('erDesigner.noDiff')}</div>
  )}
```

改为：
```tsx
{/* 无差异 */}
{diffResult.added_tables.length === 0 &&
  diffResult.removed_tables.length === 0 &&
  diffResult.modified_tables.length === 0 && (
    <div className="flex flex-col items-center gap-3 py-6">
      <div className="text-xs text-accent">{t('erDesigner.noDiff')}</div>
      <button
        onClick={handleFullSync}
        disabled={isFullSyncing}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-strong text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <RefreshCw size={12} className={isFullSyncing ? 'animate-spin' : ''} />
        <span>{isFullSyncing ? t('common.loading') : t('erDesigner.fullRefreshFromDb')}</span>
      </button>
    </div>
  )}
```

> 注意：`t('common.loading')` 需要确认存在，若无则直接用 `'加载中...'`。先检查：

```bash
grep -n '"loading"' src/i18n/locales/zh.json | head -5
```

若不存在 `common.loading`，将按钮文字改为直接字符串：
```tsx
<span>{isFullSyncing ? '刷新中...' : t('erDesigner.fullRefreshFromDb')}</span>
```

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit
```

期望：0 errors

- [ ] **Step 6: Commit**

```bash
git add src/components/ERDesigner/dialogs/DiffReportDialog.tsx
git commit -m "feat(er-designer): add full refresh button in diff dialog when no diff"
```

---

## Task 4: ERCanvas — 移除 onSync，传入 onFullSync

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`

- [ ] **Step 1: 移除 ERToolbar 的 onSync prop**

找到 ERToolbar 的 JSX（约第 490-513 行），将：
```tsx
onSync={async () => {
  await syncFromDatabase(projectId);
  reloadCanvas(true);
}}
```
整段删除。

- [ ] **Step 2: 为 DiffReportDialog 传入 onFullSync**

找到 DiffReportDialog 的 JSX（约第 607 行起），在现有 props 之后，`onSyncFromDb` 之后新增：
```tsx
onFullSync={async () => {
  await syncFromDatabase(projectId);
  reloadCanvas(true);
  showToast('全量刷新成功', 'success');
}}
```

完整 DiffReportDialog 调用应如下：
```tsx
<DiffReportDialog
  visible={showDiff}
  projectId={projectId}
  connectionInfo={connectionInfo}
  onClose={() => setShowDiff(false)}
  onSyncToDb={async (filteredDiff) => {
    try {
      const statements = await generateSyncDdl(projectId, filteredDiff)
      setSyncStatements(statements)
    } catch (e) {
      console.error('Generate sync DDL failed:', e);
      showError(`生成同步 DDL 失败: ${e}`)
    }
  }}
  onSyncFromDb={async (changes) => {
    const tableNames = [...new Set(changes.map(c => c.table))]
    try {
      await syncFromDatabase(projectId, tableNames.length > 0 ? tableNames : undefined);
      reloadCanvas(true);
      showToast('从数据库同步成功', 'success');
    } catch (e) {
      console.error('Sync from database failed:', e);
      showError(`同步失败: ${e}`)
    }
  }}
  onFullSync={async () => {
    await syncFromDatabase(projectId);
    reloadCanvas(true);
    showToast('全量刷新成功', 'success');
  }}
/>
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```

期望：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx
git commit -m "feat(er-designer): wire onFullSync to diff dialog, remove onSync from toolbar"
```

---

## Task 5: 前端冒烟验证

- [ ] **Step 1: 启动前端开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 验证工具栏**

打开 ER 设计器，确认：
- 工具栏中不再有 "同步" / "Sync" 按钮
- 仍有 "Diff" 按钮，且在未绑定连接时禁用

- [ ] **Step 3: 验证 Diff 对话框 — 有差异场景**

绑定一个数据库连接，在 ER 中修改一个表结构（不同步到 DB），点击 Diff：
- 对话框显示差异列表
- "数据库 → ER" 和 "ER → 数据库" 按钮按原逻辑工作
- 无"全量刷新"按钮

- [ ] **Step 4: 验证 Diff 对话框 — 无差异场景**

保持 ER 与数据库完全一致，点击 Diff：
- 显示"没有检测到差异"文字
- 同时显示"全量从数据库刷新"按钮
- 点击按钮后：加载状态正常，完成后 canvas 刷新，toast 显示"全量刷新成功"，对话框关闭
