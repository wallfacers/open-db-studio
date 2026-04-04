# ER Canvas Viewport 持久化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 ERCanvas 在 Activity 切换（MainContent unmount/remount）后 viewport 被 `fitView` 重置的问题，使用户拖拽和缩放位置在组件销毁重建后仍能恢复。

**Architecture:** 两步改动：(1) 在 `erDesignerStore` 中新增 `viewports: Record<number, Viewport>` 内存状态和 `setViewport` action，以 `projectId` 为 key 保存每个画布的视口；(2) 在 `ERCanvas` 中 `onMoveEnd` 时写入 store，`onInit` 时读取恢复，`fitView` 改为仅首次打开（无 saved viewport）时触发。场景 A（同 Activity 内 Tab 切换导致 display:none 尺寸坍塌）已在 `MainContent/index.tsx:987` 以绝对定位方案修复，本计划只处理场景 B。

**Tech Stack:** React 18 · TypeScript · Zustand · @xyflow/react · Vitest

---

## 文件变更总览

| 文件 | 动作 |
|------|------|
| `src/store/erDesignerStore.ts` | 修改：新增 `viewports` 状态和 `setViewport` action |
| `src/store/erDesignerStore.test.ts` | 修改：追加 `setViewport` 单元测试 |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 修改：import `Viewport`，读取/保存 viewport，条件 `fitView` |

---

### Task 1：erDesignerStore 新增 viewport 状态

**Files:**
- Modify: `src/store/erDesignerStore.ts`
- Modify: `src/store/erDesignerStore.test.ts`

- [ ] **Step 1：写失败测试**

在 `src/store/erDesignerStore.test.ts` 末尾、最外层 `describe` 闭合括号之前追加：

```typescript
  describe('setViewport', () => {
    it('按 projectId 存储 viewport，不影响其他项目', () => {
      useErDesignerStore.setState({ viewports: {} })

      useErDesignerStore.getState().setViewport(1, { x: 100, y: 200, zoom: 1.5 })
      useErDesignerStore.getState().setViewport(2, { x: 0, y: 0, zoom: 0.8 })

      const { viewports } = useErDesignerStore.getState()
      expect(viewports[1]).toEqual({ x: 100, y: 200, zoom: 1.5 })
      expect(viewports[2]).toEqual({ x: 0, y: 0, zoom: 0.8 })
    })

    it('重复调用覆盖同一 projectId 的旧值', () => {
      useErDesignerStore.setState({ viewports: { 5: { x: 10, y: 20, zoom: 1 } } })

      useErDesignerStore.getState().setViewport(5, { x: 99, y: 88, zoom: 2 })

      expect(useErDesignerStore.getState().viewports[5]).toEqual({ x: 99, y: 88, zoom: 2 })
    })
  })
```

- [ ] **Step 2：运行测试，确认失败**

```bash
cd /home/wallfacers/project/open-db-studio && npx vitest run src/store/erDesignerStore.test.ts
```

预期：`TypeError: useErDesignerStore.getState().setViewport is not a function`

- [ ] **Step 3：在 `ErDesignerState` 接口中新增两行**

编辑 `src/store/erDesignerStore.ts`，在 `clearDialectWarnings: () => void;` 行（接口末尾闭合括号前）插入：

```typescript
  // Canvas viewport persistence (in-memory, per projectId)
  viewports: Record<number, { x: number; y: number; zoom: number }>;
  setViewport: (projectId: number, viewport: { x: number; y: number; zoom: number }) => void;
```

- [ ] **Step 4：在 store 初始值中新增 viewports**

编辑 `src/store/erDesignerStore.ts`，在初始化区块（`undoStack: [],` 附近，约 226-228 行）追加：

```typescript
  viewports: {},
```

- [ ] **Step 5：新增 setViewport 实现**

在 store 末尾（`clearDialectWarnings` 实现之后，`}))` 闭合之前）插入：

```typescript
  // ── Viewport persistence ─────────────────────────────────────────────
  setViewport: (projectId, viewport) => set((s) => ({
    viewports: { ...s.viewports, [projectId]: viewport },
  })),
```

- [ ] **Step 6：运行测试，确认通过**

```bash
npx vitest run src/store/erDesignerStore.test.ts
```

预期：所有测试 PASS（含新增 2 个）

- [ ] **Step 7：TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | grep erDesignerStore || echo "no errors"
```

预期：无输出（无错误）

- [ ] **Step 8：Commit**

```bash
git add src/store/erDesignerStore.ts src/store/erDesignerStore.test.ts
git commit -m "feat(er-store): add viewports state and setViewport action for canvas persistence"
```

---

### Task 2：ERCanvas 保存并恢复 viewport

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`

- [ ] **Step 1：补充 `Viewport` 类型导入**

编辑 `src/components/ERDesigner/ERCanvas/index.tsx`，在现有 `@xyflow/react` 导入块中追加 `type Viewport`：

```typescript
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type EdgeChange,
  type ReactFlowInstance,
  type Viewport,
  ReactFlowProvider,
} from '@xyflow/react'
```

- [ ] **Step 2：在 ERCanvasInner 中读取 savedViewport 和 setViewport**

在 `ERCanvasInner` 函数体内，`rfInstance` ref 定义（约第 74 行）之后，紧接着追加：

```typescript
  const savedViewport = useErDesignerStore(s => s.viewports[projectId] ?? null)
  const storeSetViewport = useErDesignerStore(s => s.setViewport)
```

- [ ] **Step 3：新增 onMoveEnd 回调**

在 `reloadCanvas` 定义（约第 148 行）之后、`useEffect(() => { reloadCanvas() }...` 之前，追加：

```typescript
  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
    storeSetViewport(projectId, viewport)
  }, [projectId, storeSetViewport])
```

- [ ] **Step 4：更新 onInit，恢复 savedViewport**

将现有的 `onInit={(i) => { rfInstance.current = i }}` 替换为：

```typescript
  onInit={(i) => {
    rfInstance.current = i
    if (savedViewport) {
      i.setViewport(savedViewport)
    }
  }}
```

- [ ] **Step 5：让 fitView 仅首次触发，并绑定 onMoveEnd**

将 `<ReactFlow>` 组件中现有的：

```typescript
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
```

替换为：

```typescript
          fitView={savedViewport === null}
          fitViewOptions={savedViewport === null ? { maxZoom: 1, padding: 0.2 } : undefined}
          onMoveEnd={onMoveEnd}
```

- [ ] **Step 6：TypeScript 全量检查**

```bash
npx tsc --noEmit 2>&1
```

预期：无任何输出（零错误）

- [ ] **Step 7：手动验证行为**

启动应用：
```bash
npm run dev
```

验证步骤：
1. 打开 ER 设计器，将画布拖拽到明显位置并缩放
2. 点击左侧 "我的任务" Activity → 切回 ER 设计器：图应停在原位
3. 新建第二个 ER Tab（不同 project）：两个 Tab 的视口互不干扰
4. 首次打开 ER Tab（未保存过 viewport）：应触发 fitView 自动适配

- [ ] **Step 8：Commit**

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx
git commit -m "fix(er-canvas): persist viewport in store, restore on remount, skip fitView when saved"
```

---

## 验收标准核对

| 验收条件 | 覆盖 Task |
|----------|-----------|
| 切换到 tasks Activity 再切回，ER 图留在原位 | Task 2 |
| 同 Activity 内切换 Tab，ER 图留在原位（已由 display:none→绝对定位修复） | 已修复 |
| 多个 ER Tab 的视口互相独立 | Task 2（`projectId` 为 key） |
| 首次打开 ER Tab 仍然触发 fitView | Task 2（`savedViewport === null` 条件） |
| TypeScript 零新增错误 | Task 1 Step 7 + Task 2 Step 6 |
| 全量测试通过 | Task 1 Step 6 |
