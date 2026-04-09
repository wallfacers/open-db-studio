# 迁移中心 UI 改造设计文档

**日期**: 2026-04-10  
**状态**: 已批准

## 目标

1. 引入与 SQL 编辑器一致的顶部工具栏，将运行/停止/预检操作移至工具栏
2. 日志面板视觉样式对齐 SQL 编辑器结果集面板
3. 移除全局同步模式（SyncModeSection），改为每张表独立配置冲突策略
4. 冲突键字段对所有表始终可见（不再根据策略条件隐藏）

---

## 整体布局结构

```
MigrationJobTab
├── [工具栏] h-10, bg-background-void, border-b border-border-default
│   ├── 左：Run(Play) / Stop(Square) 按钮 + 分隔线 + Precheck(ShieldCheck) 按钮
│   └── 右：dirty 状态指示（"· 未保存" 文字）
├── [Sub-tab bar] config / stats（不变）
├── [内容区] flex-1 min-h-0 overflow-hidden
│   └── ConfigTab 或 StatsTab
├── [拖动 handle] h-1, cursor-row-resize（仅 logHeight > 0 时显示）
└── [日志面板] 底部可折叠/可拖动调高
    ├── [tab-bar] h-[38px], bg-background-base, border-b border-border-default
    │   ├── "运行日志" tab（激活态 border-t-2 border-accent，运行中显示 animate-pulse 圆点）
    │   ├── 右侧：结构化/原始 切换（icon-only + Tooltip，viewMode 状态上移至 index.tsx）
    │   └── 右侧：✕ 关闭按钮
    └── [内容区] LogTab 现有 Stats bar + 视图区（移除原有 footer 的 stop 按钮和工具栏，stop 已移至顶部工具栏）
```

---

## 模块改动清单

### 1. `MigrationJobTab/index.tsx`

- 新增工具栏（`h-10 flex items-center px-3 gap-1 bg-background-void border-b border-border-default`）
  - Run/Stop 按钮：`text-accent` / `text-error`，`hover:bg-border-default`，带 Tooltip
  - 分隔线：`w-[1px] h-4 bg-border-strong mx-1`
  - Precheck 按钮：`text-foreground-muted hover:bg-border-default`，带 Tooltip
- `onStop` 逻辑从 LogTab 上移至此处（已有 `handleStop`，直接用）
- `viewMode` 状态从 LogTab **上移到 index.tsx**，通过 props 传给 LogTab，这样 tab-bar 中的切换图标可在 index.tsx 直接控制
- 日志面板 tab-bar 重写（见下方 §3）
- 移除：ConfigTab 的 `onPrecheck` prop 传递（Precheck 移至工具栏）

### 2. `MigrationJobTab/ConfigTab.tsx`

- 删除 `SyncModeSection` 的 import 和渲染
- 删除 `JobConfig` 中的 `syncMode: 'full' | 'incremental'` 和 `incrementalConfig` 字段
- 删除 `defaultConfig()` 中对应字段
- 删除底部 Action Bar（`flex items-center justify-end gap-2 border-t ...`）整块
- 删除 `onPrecheck` prop（Props interface 和使用处）
- `onRun` prop 保留（工具栏调用）
- `dirty` 状态保持在 ConfigTab 内部，工具栏不显示 dirty 指示（auto-save 已覆盖大部分场景）

### 3. 日志面板 tab-bar（`MigrationJobTab/index.tsx` 内联）

当前 panel header 替换为 SQL 编辑器结果集风格：

```tsx
<div className="flex items-center bg-background-base border-b border-border-default overflow-x-auto flex-shrink-0">
  {/* 运行日志 tab */}
  <div className="px-3 h-[38px] flex items-center gap-1.5 text-xs
                  border-t-2 border-accent bg-background-void text-accent
                  border-r border-r-border-default flex-shrink-0">
    <span>{t('migration.logTab')}</span>
    {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
  </div>
  {/* 右侧工具 */}
  <div className="ml-auto flex items-center gap-1 px-2">
    {/* 结构化/原始 切换 icon */}
    {/* ✕ 关闭按钮 */}
  </div>
</div>
```

### 4. `MigrationJobTab/LogTab.tsx`

- 移除 Stats bar 内的 Stop 按钮（`onStop` prop 不再需要，stop 已移至顶部工具栏）
- 移除 `onStop` prop
- 底部 footer（Export 按钮）保留
- `LogViewToggle` 组件移至日志面板 tab-bar 右侧（由 index.tsx 传入或直接内联）

### 5. `MigrationJobTab/LogViewToggle.tsx`

- 保持逻辑不变
- 样式可按需改为 icon-only（`List` / `AlignLeft` 图标 + Tooltip）

### 6. `MigrationJobTab/ColumnMappingPanel.tsx`

- 冲突键（upsertKeys）输入框**始终渲染**，不再受 `conflictStrategy === 'UPSERT'` 条件控制
- 当 `conflictStrategy !== 'UPSERT'` 时，输入框添加 `disabled` + `opacity-50 cursor-not-allowed` 样式
- 布局：冲突策略下拉 + 冲突键输入框排在同一行，间距 `gap-2`

### 7. `MigrationJobTab/SyncModeSection.tsx`

- **删除文件**

---

## 数据结构变更

```typescript
// 删除前
interface JobConfig {
  syncMode: 'full' | 'incremental'
  incrementalConfig?: IncrementalConfig
  // ...
}

// 删除后
interface JobConfig {
  // syncMode 和 incrementalConfig 字段移除
  defaultTargetConnId: number
  defaultTargetDb: string
  source: { ... }
  tableMappings: TableMapping[]
  pipeline: PipelineConfig
}
```

已有 JSON 配置中若存在 `syncMode` / `incrementalConfig` 字段，解析时自动忽略（无需迁移脚本）。

---

## 不改动范围

- `StatsTab`、`TimelineView`、`MappingCard`、`MigrationExplorer` 不涉及
- `TableMappingPanel` 主行布局不变（冲突策略仍在展开的 ColumnMappingPanel 中，不上移到主行）
- 拖动调整日志面板高度的逻辑（`handleLogResize`）保持不变
- 运行时自动展开日志面板逻辑保持不变
