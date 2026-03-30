# AI 变更高亮特效设计

## 概述

当 AI（通过 MCP ui_patch）修改了 SeaTunnel Job 或其他编辑器的内容时，在 UI 上对变更区域施加脉冲动画，让用户一眼看到什么地方被改了。脉冲结束后保留淡色残留标记，直到用户手动编辑该字段时才消失。

本系统设计为**通用组件**，不绑定特定业务，任何表单字段或 Monaco 编辑器均可接入。

## 需求决策

| 决策点 | 选择 |
|---|---|
| 生效模式 | Visual + Script 两种模式都要 |
| 动画风格 | 脉冲动画（Pulse）：3 次呼吸灯闪烁，2.4s |
| 多字段触发 | 同时触发，所有被修改字段一起脉冲 |
| 动画结束后 | 保留淡色残留（极淡背景 + 左侧青色竖线），用户编辑后清除 |
| Script 模式行定位 | 混合方案：JSON diff 精确定位变更行，失败则 fallback 整体闪烁 |
| 组件化 | 抽取为通用组件，任何输入框/文本编辑器都可复用 |

## 架构

### 实现方案：Store 驱动高亮

在 `patchDirect()` 应用 patch 后，将变更路径写入全局 `highlightStore`，UI 组件订阅该 store 渲染脉冲动画。

数据流：

```
AI Agent → ui_patch → SeaTunnelJobAdapter.patchDirect()
  → applyPatch(current, ops)
  → diffJsonPaths(oldConfigJson, newConfigJson) → changedPaths
  → highlightStore.addHighlights(scopeId, changedPaths)
  → UI 组件订阅 → 脉冲动画 → 残留标记
  → 用户编辑字段 → clearHighlight()
```

### 通用层模块

| 模块 | 位置 | 职责 |
|---|---|---|
| highlightStore | `src/store/highlightStore.ts` | 按 scopeId 管理高亮条目，不关心业务类型 |
| useFieldHighlight | `src/hooks/useFieldHighlight.ts` | 通用表单字段高亮 hook |
| useMonacoHighlight | `src/hooks/useMonacoHighlight.ts` | 通用 Monaco 编辑器高亮 hook |
| diffJsonPaths | `src/utils/jsonDiff.ts` | 通用 JSON 树 diff 工具 |
| ai-highlight.css | `src/styles/ai-highlight.css` | 通用脉冲 + 残留 CSS 动画 |

## 详细设计

### 1. highlightStore

```typescript
interface HighlightEntry {
  path: string           // 变更路径，如 "env.parallelism", "source.0.url"
  phase: 'pulse' | 'residual'
  timestamp: number
}

interface HighlightState {
  highlights: Map<string, HighlightEntry[]>  // key = scopeId
  addHighlights(scopeId: string, paths: string[]): void
  promoteToResidual(scopeId: string, paths: string[]): void
  clearHighlight(scopeId: string, path: string): void
  clearAll(scopeId: string): void
}
```

- `addHighlights`：写入 phase='pulse' 条目
- `promoteToResidual`：脉冲结束后（2.4s）批量切换为 residual
- `clearHighlight`：用户编辑某字段时清除该条目
- `clearAll`：tab 关闭时清理

### 2. useFieldHighlight hook

```typescript
function useFieldHighlight(scopeId: string, path: string): {
  phase: 'pulse' | 'residual' | null
  className: string        // '' | 'ai-highlight-pulse' | 'ai-highlight-residual'
  onUserEdit: () => void   // 绑定到 onChange，编辑后清除残留
}
```

使用方式（任意表单字段）：

```tsx
const { className, onUserEdit } = useFieldHighlight(tabId, 'env.parallelism')
<div className={className}>
  <input onChange={(e) => { onUserEdit(); originalOnChange(e) }} />
</div>
```

### 3. useMonacoHighlight hook

```typescript
function useMonacoHighlight(
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor>,
  scopeId: string,
  options?: { diffMode?: 'line' | 'json-tree' }
): {
  notifyContentChange: (oldValue: string, newValue: string) => void
}
```

内部实现：
1. 调用 `notifyContentChange(old, new)` 时，逐行比较 old vs new，收集变更行号
2. 如果行数差异超过 50%，fallback 整体闪烁
3. 调用 `editor.deltaDecorations()` 添加脉冲装饰
4. 2.4s 后切换为残留装饰（淡色背景 + gutter 竖线）
5. 监听 `onDidChangeModelContent`，用户编辑的行清除对应 decoration

### 4. diffJsonPaths

```typescript
function diffJsonPaths(oldObj: any, newObj: any, prefix?: string): string[]
```

递归对比两棵 JSON 树，返回叶子节点变更路径列表。

示例：
- `oldObj = { env: { parallelism: 6 } }`, `newObj = { env: { parallelism: 2 } }`
- 返回 `['env.parallelism']`

容错：parse 失败或类型不同时返回 `['*']` 通配符，触发全局闪烁。

### 5. CSS 动画

```css
@keyframes ai-pulse {
  0%   { background-color: transparent; box-shadow: none; }
  15%  { background-color: rgba(0,201,167,0.35); box-shadow: 0 0 12px rgba(0,201,167,0.25); }
  30%  { background-color: rgba(0,201,167,0.08); box-shadow: none; }
  45%  { background-color: rgba(0,201,167,0.30); box-shadow: 0 0 10px rgba(0,201,167,0.2); }
  60%  { background-color: rgba(0,201,167,0.05); box-shadow: none; }
  75%  { background-color: rgba(0,201,167,0.20); box-shadow: 0 0 6px rgba(0,201,167,0.15); }
  100% { background-color: rgba(0,201,167,0.06); box-shadow: none; }
}

.ai-highlight-pulse {
  animation: ai-pulse 2.4s ease-in-out forwards;
  border-radius: 4px;
}

.ai-highlight-residual {
  background-color: rgba(0,201,167,0.06);
  border-left: 2px solid rgba(0,201,167,0.4);
  border-radius: 4px;
}
```

脉冲最后一帧停在 `rgba(0,201,167,0.06)`，与 residual 背景色一致，实现无缝过渡。

### 6. Visual 模式字段路径映射

| BuilderState 字段 | Highlight Path |
|---|---|
| `env.parallelism` | `env.parallelism` |
| `env.jobName` | `env.job.name` |
| `source.fields.url` | `source.0.url` |
| `source.type` | `source.0.plugin_name` |
| `transforms[i].fields.xxx` | `transform.{i}.xxx` |
| `sink.fields.url` | `sink.0.url` |

### 7. 触发入口

`SeaTunnelJobAdapter.patchDirect()` 修改：

```
patchDirect(ops) {
  const current = getForm(this.objectId)
  const oldConfigJson = current.configJson
  const patched = applyPatch(current, ops)
  setForm(this.objectId, patched)

  // 提取变更路径并触发高亮
  const changedPaths = extractChangedPaths(ops, oldConfigJson, patched.configJson)
  highlightStore.addHighlights(this.objectId, changedPaths)

  // 同步到 seaTunnelStore...
}
```

路径提取逻辑：
- `op.path === '/jobName'` → 直接映射 `['jobName']`
- `op.path === '/configJson'` → `diffJsonPaths(JSON.parse(old), JSON.parse(new))`
- parse 失败 → `['*']` fallback

## 文件变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/store/highlightStore.ts` | 新建 | 通用高亮状态管理 |
| `src/utils/jsonDiff.ts` | 新建 | 通用 JSON 树 diff |
| `src/styles/ai-highlight.css` | 新建 | 通用脉冲 + 残留动画 |
| `src/hooks/useFieldHighlight.ts` | 新建 | 通用表单字段高亮 hook |
| `src/hooks/useMonacoHighlight.ts` | 新建 | 通用 Monaco 编辑器高亮 hook |
| `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts` | 修改 | patchDirect 中触发高亮 |
| `src/components/SeaTunnelJobTab/VisualBuilder.tsx` | 修改 | 使用 useFieldHighlight |
| `src/components/SeaTunnelJobTab/JsonEditor.tsx` | 修改 | 使用 useMonacoHighlight |
| `src/components/SeaTunnelJobTab/index.tsx` | 修改 | tab 关闭清理、传递 tabId/scopeId |
| `src/main.tsx` | 修改 | import ai-highlight.css |

## 复用指南

未来其他编辑器接入：

1. **表单场景**：在字段外层使用 `useFieldHighlight(scopeId, path)`，绑定 className 和 onUserEdit
2. **Monaco 场景**：使用 `useMonacoHighlight(editorRef, scopeId)`，在外部内容变更时调用 `notifyContentChange`
3. **触发侧**：任何 UIObject adapter 的 patchDirect 中调用 `highlightStore.addHighlights(scopeId, paths)`
