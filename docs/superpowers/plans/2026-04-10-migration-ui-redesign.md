# Migration UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 迁移中心引入顶部工具栏、日志面板对齐 SQL 编辑器结果集风格、移除全局同步模式、每张表始终显示冲突键配置。

**Architecture:** 四个独立任务依次完成：(1) 删除 SyncModeSection 并清理 ConfigTab；(2) 将 Run/Stop/Precheck 移至顶部工具栏，通过 ref 暴露 ConfigTab 的 save 方法；(3) 日志面板 tab-bar 视觉对齐 + viewMode 状态上移；(4) ColumnMappingPanel 冲突键始终可见。每个任务独立可提交。

**Tech Stack:** React 18 + TypeScript，Tauri invoke，Lucide icons，Tailwind CSS（项目自定义 token）

---

## 文件改动总览

| 操作 | 文件 |
|------|------|
| 删除 | `src/components/MigrationJobTab/SyncModeSection.tsx` |
| 修改 | `src/components/MigrationJobTab/ConfigTab.tsx` |
| 修改 | `src/components/MigrationJobTab/index.tsx` |
| 修改 | `src/components/MigrationJobTab/LogTab.tsx` |
| 修改 | `src/components/MigrationJobTab/ColumnMappingPanel.tsx` |

---

## Task 1: 删除 SyncModeSection，清理 ConfigTab 类型与渲染

**Files:**
- Delete: `src/components/MigrationJobTab/SyncModeSection.tsx`
- Modify: `src/components/MigrationJobTab/ConfigTab.tsx`

- [ ] **Step 1.1: 删除 SyncModeSection.tsx 文件**

```bash
rm src/components/MigrationJobTab/SyncModeSection.tsx
```

- [ ] **Step 1.2: 移除 ConfigTab 中的 IncrementalConfig interface 和 JobConfig 中的两个字段**

在 `src/components/MigrationJobTab/ConfigTab.tsx` 中，找到并删除以下代码块（约第 19-22 行）：

```typescript
// 删除整个 IncrementalConfig interface
interface IncrementalConfig {
  field: string; fieldType: 'timestamp' | 'numeric'; lastValue?: string
}
```

在 `JobConfig` interface 中删除这两行：

```typescript
// 删除
syncMode: 'full' | 'incremental'
incrementalConfig?: IncrementalConfig
```

- [ ] **Step 1.3: 清理 defaultConfig() 中的 syncMode 字段**

找到 `defaultConfig()` 函数，删除其中的 `syncMode: 'full',` 一行：

```typescript
// 删除前
function defaultConfig(): JobConfig {
  return {
    syncMode: 'full',
    defaultTargetConnId: 0,
    // ...
  }
}

// 删除后
function defaultConfig(): JobConfig {
  return {
    defaultTargetConnId: 0,
    defaultTargetDb: '',
    source: { connectionId: 0, database: '', queryMode: 'auto', tables: [] },
    tableMappings: [],
    pipeline: {
      readBatchSize: 10000,
      writeBatchSize: 1000,
      parallelism: 1,
      channelCapacity: 16,
      speedLimitRps: null,
      errorLimit: 0,
      shardCount: null,
    },
  }
}
```

- [ ] **Step 1.4: 删除 SyncModeSection 的 import 及 JSX**

删除文件顶部的 import：
```typescript
// 删除这行
import { SyncModeSection } from './SyncModeSection'
```

在 render 区域找到并删除 `<SyncModeSection .../>` 整块（约第 263-269 行）：
```tsx
// 删除以下块
<SyncModeSection
  syncMode={config.syncMode}
  incrementalConfig={config.incrementalConfig}
  onChange={(syncMode, incrementalConfig) => update({ syncMode, incrementalConfig })}
/>
```

- [ ] **Step 1.5: 类型检查确认无报错**

```bash
npx tsc --noEmit
```

预期：0 errors。若出现 `syncMode` 相关的类型错误，检查是否有遗漏的 `update({ syncMode, ... })` 调用。

- [ ] **Step 1.6: 提交**

```bash
git add src/components/MigrationJobTab/ConfigTab.tsx
git rm src/components/MigrationJobTab/SyncModeSection.tsx
git commit -m "feat(migration): remove global sync mode section and incremental config"
```

---

## Task 2: 顶部工具栏 — Run / Stop / Precheck

**Files:**
- Modify: `src/components/MigrationJobTab/ConfigTab.tsx`（暴露 save ref，移除 Action Bar 和 onRun/onPrecheck prop）
- Modify: `src/components/MigrationJobTab/index.tsx`（引入工具栏，使用 ConfigTabHandle ref）

### ConfigTab 改动

- [ ] **Step 2.1: 在 ConfigTab 中添加 forwardRef 和 useImperativeHandle**

在 ConfigTab.tsx 顶部，将 React import 修改为包含 `forwardRef` 和 `useImperativeHandle`：

```typescript
import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
```

在 Props interface **之前**插入 ConfigTabHandle 导出：

```typescript
export interface ConfigTabHandle {
  save: () => Promise<void>
}
```

- [ ] **Step 2.2: 从 Props 移除 onRun 和 onPrecheck，将函数签名改为 forwardRef**

将 Props interface 修改为：

```typescript
interface Props {
  jobId: number
  configJson: string
  onSave: (configJson: string, silent?: boolean) => Promise<void>
}
```

将函数声明从：
```typescript
export function ConfigTab({ jobId: _jobId, configJson, onSave, onRun, onPrecheck }: Props) {
```

改为：
```typescript
export const ConfigTab = forwardRef<ConfigTabHandle, Props>(function ConfigTab(
  { jobId: _jobId, configJson, onSave },
  ref
) {
```

并在函数体**最末尾**（return 语句之前）加上闭合括号：
```typescript
  // ... 现有代码 ...
  return (
    // ... JSX ...
  )
}) // forwardRef 闭合
```

- [ ] **Step 2.3: 在 ConfigTab 函数体中注册 useImperativeHandle**

在 `dirtyRef` 声明之后（约第 100 行），添加：

```typescript
useImperativeHandle(ref, () => ({
  save: async () => {
    if (dirtyRef.current) {
      await onSave(JSON.stringify(config, null, 2))
      setDirty(false)
    }
  },
}), [config, onSave])
```

- [ ] **Step 2.4: 删除 ConfigTab 内的 handleRun、handlePrecheck 函数及 Action Bar**

删除这两个函数（约第 254-261 行）：
```typescript
// 删除
const handleRun = async () => {
  await autoSaveIfDirty()
  await onRun()
}

// 删除
const handlePrecheck = async () => { ... }
```

删除 lucide-react import 中的 `Play, ShieldCheck`（它们将移至 index.tsx）：
```typescript
// 删除前
import { Play, ShieldCheck } from 'lucide-react'
// 如该行只有这两个 icon，直接删除整行
```

删除 render 末尾的 Action Bar 整块：
```tsx
// 删除以下块（约第 393-407 行）
{/* Action Bar */}
<div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3 mt-auto">
  <button
    onClick={onPrecheck}
    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors"
  >
    <ShieldCheck size={13} />{t('migration.precheck')}
  </button>
  <button
    onClick={handleRun}
    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors"
  >
    <Play size={13} />{t('migration.run')}
  </button>
</div>
```

> 注意：`autoSaveIfDirty` 函数保留，因为 `handleAiRecommend` 内部仍在使用它。

- [ ] **Step 2.5: 类型检查**

```bash
npx tsc --noEmit
```

预期：0 errors。

### index.tsx 改动

- [ ] **Step 2.6: 在 index.tsx 中更新 ConfigTab import，添加图标 import 和 ref**

将 ConfigTab import 修改为：
```typescript
import { ConfigTab, ConfigTabHandle } from './ConfigTab'
```

在 lucide-react import 行（若无此行则新增）中加入 `Play, Square, ShieldCheck`：
```typescript
import { Play, Square, ShieldCheck } from 'lucide-react'
```

在组件函数体内，在现有 state 声明之后添加 ref：
```typescript
const configTabRef = useRef<ConfigTabHandle>(null)
```

- [ ] **Step 2.7: 更新 handleRun，通过 ref 先保存再运行**

找到现有的 `handleRun`：
```typescript
const handleRun = async () => {
  await store.runJob(jobId)
}
```

替换为：
```typescript
const handleRun = async () => {
  await configTabRef.current?.save()
  await store.runJob(jobId)
}
```

- [ ] **Step 2.8: 在 JSX 中添加工具栏，更新 ConfigTab 调用**

在 `{/* Sub-tab bar */}` 之前插入工具栏：

```tsx
{/* Toolbar */}
<div className="flex-shrink-0 h-10 flex items-center px-3 gap-1 bg-background-void border-b border-border-default">
  <Tooltip content={isRunning ? t('migration.stop') : t('migration.run')}>
    <button
      className={`p-1.5 rounded transition-colors ${
        isRunning
          ? 'text-error hover:bg-border-default'
          : 'text-accent hover:bg-border-default'
      }`}
      onClick={isRunning ? handleStop : handleRun}
    >
      {isRunning ? <Square size={16} /> : <Play size={16} />}
    </button>
  </Tooltip>
  <div className="w-[1px] h-4 bg-border-strong mx-1" />
  <Tooltip content={t('migration.precheck')}>
    <button
      className="p-1.5 rounded transition-colors text-foreground-muted hover:bg-border-default"
      onClick={handlePrecheck}
    >
      <ShieldCheck size={16} />
    </button>
  </Tooltip>
</div>
```

将 ConfigTab 的 JSX 调用从：
```tsx
<ConfigTab
  jobId={jobId}
  configJson={configJson}
  onSave={handleSave}
  onRun={handleRun}
  onPrecheck={handlePrecheck}
/>
```

改为：
```tsx
<ConfigTab
  ref={configTabRef}
  jobId={jobId}
  configJson={configJson}
  onSave={handleSave}
/>
```

> `Tooltip` 组件在 index.tsx 已有 import（`import { Tooltip } from '../common/Tooltip'`）。

- [ ] **Step 2.9: 类型检查**

```bash
npx tsc --noEmit
```

预期：0 errors。

- [ ] **Step 2.10: 提交**

```bash
git add src/components/MigrationJobTab/ConfigTab.tsx src/components/MigrationJobTab/index.tsx
git commit -m "feat(migration): move run/stop/precheck to top toolbar"
```

---

## Task 3: 日志面板 tab-bar 对齐 SQL 编辑器 + viewMode 状态上移

**Files:**
- Modify: `src/components/MigrationJobTab/index.tsx`
- Modify: `src/components/MigrationJobTab/LogTab.tsx`

### LogTab 改动

- [ ] **Step 3.1: 更新 LogTab Props，移除 onStop，新增 viewMode/onViewModeChange**

将 LogTab.tsx 顶部的 `useState` import 移除（viewMode 状态上移后不再需要）；将 `LogViewToggle` import 删除：

```typescript
// 删除这行
import { LogViewToggle } from './LogViewToggle'
```

将 Props interface 修改为：

```typescript
interface Props {
  jobId: number
  stats: MigrationStatsEvent | null
  logs: MigrationLogEvent[]
  isRunning: boolean
  viewMode: LogViewMode
  onViewModeChange: (mode: LogViewMode) => void
}
```

将函数签名从：
```typescript
export function LogTab({ stats, logs, isRunning, onStop }: Props) {
```

改为：
```typescript
export function LogTab({ stats, logs, isRunning, viewMode, onViewModeChange }: Props) {
```

- [ ] **Step 3.2: 删除 LogTab 内部的 viewMode state，更新 useEffect 依赖**

删除：
```typescript
// 删除
const [viewMode, setViewMode] = useState<LogViewMode>('structured')
```

`useEffect` 的逻辑不变（依赖 `viewMode` 仍可工作，因为 prop 变化会触发重渲染）。

- [ ] **Step 3.3: 删除 Stats bar 内的 Stop 按钮**

在 Stats bar 区域找到并删除以下块（约 `isRunning &&` 部分）：

```tsx
// 删除
{isRunning && (
  <button
    onClick={onStop}
    className="flex items-center gap-1 px-2 py-1 text-[11px] border border-error text-error rounded hover:bg-error-subtle transition-colors duration-150"
  >
    <Square size={10} fill="currentColor" />{t('migration.stop')}
  </button>
)}
```

- [ ] **Step 3.4: 删除 LogViewToggle 渲染行**

找到并删除 `{/* View toggle */}` 区域：

```tsx
// 删除
{/* View toggle */}
<LogViewToggle mode={viewMode} onChange={setViewMode} />
```

- [ ] **Step 3.5: 更新 LogTab 的 viewMode 切换回调引用**

在 content area，`onChange` 用 `onViewModeChange` 替代（若有 inline 改法则替换之）。

检查 JSX 中所有 `setViewMode` 调用（应已在上一步全部删除），确认无遗留。

- [ ] **Step 3.6: 删除不再需要的 Square import（若已随 Stop 按钮删除后无其他用途）**

检查 LogTab.tsx 顶部 import：

```typescript
// 如果 Square 只用于 Stop 按钮，则从 lucide-react import 中删除 Square
import { Download } from 'lucide-react'
// Square 删掉
```

### index.tsx 改动

- [ ] **Step 3.7: 在 index.tsx 添加 viewMode 状态和相关 icon import**

在 `migrationStore` import 中添加 `LogViewMode`：

```typescript
import { useMigrationStore, MigrationJob, LogViewMode } from '../../store/migrationStore'
```

在 lucide-react import 行中添加 `ListTree, Code`（tab-bar 切换图标）：
```typescript
import { Play, Square, ShieldCheck, ListTree, Code } from 'lucide-react'
```

在 `logHeight` state 声明之后添加：
```typescript
const [viewMode, setViewMode] = useState<LogViewMode>('structured')
```

> 注意：不需要 import LogViewToggle，切换按钮直接内联在 tab-bar 中（见下方 Step 3.8），避免 LogViewToggle 外层 `border-b` 样式在 tab-bar 中产生干扰。

- [ ] **Step 3.8: 替换日志面板 header 为 SQL 编辑器结果集 tab-bar 风格**

找到现有 Panel header 区域：
```tsx
{/* Panel header */}
<div className="flex items-center bg-background-base border-b border-border-default px-3 h-[38px] flex-shrink-0">
  <span className="text-xs text-foreground-muted flex items-center">
    {t('migration.logTab')}
    {isRunning && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />}
  </span>
  <button
    className="ml-auto p-0.5 rounded text-foreground-muted hover:text-foreground-default hover:bg-border-default transition-colors leading-none text-xs"
    onClick={() => setLogHeight(0)}
  >✕</button>
</div>
```

替换为：
```tsx
{/* Log tab-bar — SQL editor result pane style */}
<div className="flex items-center bg-background-base border-b border-border-default flex-shrink-0 overflow-x-auto">
  <div className="px-3 h-[38px] flex items-center gap-1.5 text-xs border-t-2 border-accent bg-background-void text-accent border-r border-r-border-default flex-shrink-0">
    <span>{t('migration.logTab')}</span>
    {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
  </div>
  <div className="ml-auto flex items-center gap-1 px-2 flex-shrink-0">
    {/* 结构化/原始切换 — 直接内联，不用 LogViewToggle 避免其外层 border-b 干扰 */}
    <div className="flex items-center bg-background-elevated rounded-md p-0.5">
      <Tooltip content={t('migration.structuredView')}>
        <button
          onClick={() => setViewMode('structured')}
          className={`p-1 rounded transition-colors ${viewMode === 'structured' ? 'bg-accent text-white' : 'text-foreground-muted hover:text-foreground-default'}`}
        >
          <ListTree size={12} />
        </button>
      </Tooltip>
      <Tooltip content={t('migration.rawLog')}>
        <button
          onClick={() => setViewMode('raw')}
          className={`p-1 rounded transition-colors ${viewMode === 'raw' ? 'bg-accent text-white' : 'text-foreground-muted hover:text-foreground-default'}`}
        >
          <Code size={12} />
        </button>
      </Tooltip>
    </div>
    <button
      className="p-0.5 rounded text-foreground-muted hover:text-foreground-default hover:bg-border-default transition-colors leading-none text-xs ml-1"
      onClick={() => setLogHeight(0)}
    >✕</button>
  </div>
</div>
```

- [ ] **Step 3.9: 更新 LogTab JSX 调用，传入 viewMode/onViewModeChange，移除 onStop**

将：
```tsx
<LogTab
  jobId={jobId}
  stats={run?.stats ?? null}
  logs={run?.logs ?? []}
  isRunning={isRunning}
  onStop={handleStop}
/>
```

改为：
```tsx
<LogTab
  jobId={jobId}
  stats={run?.stats ?? null}
  logs={run?.logs ?? []}
  isRunning={isRunning}
  viewMode={viewMode}
  onViewModeChange={setViewMode}
/>
```

- [ ] **Step 3.10: 类型检查**

```bash
npx tsc --noEmit
```

预期：0 errors。

- [ ] **Step 3.11: 提交**

```bash
git add src/components/MigrationJobTab/index.tsx src/components/MigrationJobTab/LogTab.tsx
git commit -m "feat(migration): align log panel to SQL editor result pane style"
```

---

## Task 4: ColumnMappingPanel — 冲突键始终可见

**Files:**
- Modify: `src/components/MigrationJobTab/ColumnMappingPanel.tsx`

- [ ] **Step 4.1: 修改冲突键渲染逻辑**

在 `ColumnMappingPanel.tsx` 中找到 Target options 区域，将原来的条件渲染：

```tsx
{mapping.target.conflictStrategy === 'UPSERT' && (
  <div className="flex items-center gap-1.5">
    <span className="text-foreground-subtle">{t('migration.upsertKeys')}:</span>
    <input
      value={mapping.target.upsertKeys.join(', ')}
      onChange={e => onUpdateTarget({ upsertKeys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
      className={inputCls + " w-32"}
      placeholder="id"
    />
  </div>
)}
```

替换为始终渲染（非 UPSERT 时禁用）：

```tsx
<div className="flex items-center gap-1.5">
  <span className="text-foreground-subtle">{t('migration.upsertKeys')}:</span>
  <input
    value={mapping.target.upsertKeys.join(', ')}
    onChange={e => onUpdateTarget({ upsertKeys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
    disabled={mapping.target.conflictStrategy !== 'UPSERT'}
    className={
      inputCls + ' w-32 ' +
      (mapping.target.conflictStrategy !== 'UPSERT' ? 'opacity-50 cursor-not-allowed' : '')
    }
    placeholder="id"
  />
</div>
```

- [ ] **Step 4.2: 类型检查**

```bash
npx tsc --noEmit
```

预期：0 errors。

- [ ] **Step 4.3: 提交**

```bash
git add src/components/MigrationJobTab/ColumnMappingPanel.tsx
git commit -m "feat(migration): always show upsert keys input, disabled when not UPSERT strategy"
```

---

## 验收检查

完成所有任务后，在 Tauri 开发环境中人工验证：

```bash
npm run dev
```

- [ ] 迁移任务 tab 顶部出现工具栏（Play/Stop 图标 + 分隔线 + ShieldCheck 图标）
- [ ] 工具栏 Run 按钮点击后启动任务，图标切换为 Stop（红色）
- [ ] 工具栏 Precheck 按钮可正常触发预检查对话框
- [ ] ConfigTab 顶部不再出现"同步模式"下拉
- [ ] ConfigTab 底部不再出现 Run / Precheck 按钮
- [ ] 日志面板 header 变为 SQL 编辑器结果集风格（顶部 accent 线 + tab 外观）
- [ ] 日志面板右侧有结构化/原始切换按钮，功能正常
- [ ] 每张表展开后，冲突键输入框始终可见；策略非 UPSERT 时输入框灰色禁用
