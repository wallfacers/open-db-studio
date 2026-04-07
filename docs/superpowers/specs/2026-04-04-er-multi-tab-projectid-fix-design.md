# ER 多 Tab 场景 activeProjectId 修复设计

**日期**：2026-04-04  
**状态**：待实现  
**范围**：Canvas 同步守卫、写入操作 projectId 显式传递、键盘快捷键作用域

---

## 背景

`erDesignerStore` 中存在全局单例 `activeProjectId`，在单 Tab 场景下正确。多 ER Tab 场景下：

1. `loadProject(B)` 会将 `activeProjectId` 覆盖为 B，导致 Canvas A 的同步 useEffect 被 `activeProjectId !== projectId` 守卫阻断，AI 修改项目 A 数据后 Canvas A 不刷新。
2. `addTable` / `addRelation` 内部读 `get().activeProjectId`，若最后加载的是项目 B，通过项目 A 的 Adapter 调用 `add_table` 时新表会创建到项目 B。
3. `useERKeyboard` 从全局 store 读 `activeProjectId`，键盘快捷键始终作用于最后加载的项目而非当前聚焦的 Tab。

---

## 修复原则

消除对 `activeProjectId` 的隐式依赖，改为在调用链上**显式传递 `projectId`**。`activeProjectId` 字段保留（undo/redo 仍依赖，后续专项处理），但不再作为写入操作的上下文来源。

---

## 三条独立改动

### 改动 1：移除 Canvas 同步守卫

**文件**：`src/components/ERDesigner/ERCanvas/index.tsx`

删除 sync useEffect（约第 163 行）中的两行：

```typescript
// 删除
const state = useErDesignerStore.getState()
if (state.activeProjectId !== projectId) return
```

**原因**：`tables`、`relations`、`columns` 已在 Zustand 订阅层按 `projectId` 过滤，进入 useEffect 时数据已是当前项目的，守卫多余。删除后每个 Canvas 实例独立响应各自订阅的数据变化，互不干扰。

---

### 改动 2：addTable / addRelation 增加显式 projectId 参数

**文件**：`src/store/erDesignerStore.ts`

**接口变更**（`ErDesignerState`）：

```typescript
// 改前
addTable: (name: string, position: { x: number; y: number }) => Promise<ErTable>
addRelation: (rel: Partial<ErRelation>) => Promise<ErRelation>

// 改后
addTable: (projectId: number, name: string, position: { x: number; y: number }) => Promise<ErTable>
addRelation: (projectId: number, rel: Partial<ErRelation>) => Promise<ErRelation>
```

**实现**：将方法内的 `get().activeProjectId` 替换为参数 `projectId`。

**8 个调用点更新**：

| 文件 | projectId 来源 |
|------|----------------|
| `src/mcp/ui/adapters/ERCanvasAdapter.ts` | `this._projectId` |
| `src/components/ERDesigner/ERCanvas/index.tsx`（addRelation） | `projectId` prop |
| `src/components/ERDesigner/ERCanvas/ERToolbar.tsx` | `projectId` prop（已通过 props 传入） |
| `src/components/ERDesigner/ERCanvas/ERTableContextMenu.tsx` | `activeProjectId`（该组件始终在活跃 Canvas 内，单 Canvas 场景安全） |
| `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx` | `table.project_id` |
| `src/components/ERDesigner/ERSidebar/ProjectContextMenu.tsx` | 右键项目已有 `projectId` |
| `src/components/ERDesigner/hooks/useERKeyboard.ts` | 见改动 3 |

---

### 改动 3：useERKeyboard 接受 projectId 参数

**文件**：`src/components/ERDesigner/hooks/useERKeyboard.ts`

```typescript
// 改前
export function useERKeyboard() {
  const { ..., activeProjectId, addTable } = useErDesignerStore()
  // 内部：addTable(name, pos)  ← 使用 activeProjectId

// 改后
export function useERKeyboard(projectId: number) {
  const { ..., addTable } = useErDesignerStore()
  // 内部：addTable(projectId, name, pos)  ← 使用参数
```

移除 hook 对 `activeProjectId` 的订阅（从 deps 中删除）。

**调用处**（`src/components/ERDesigner/ERCanvas/index.tsx`）：

```typescript
// 改前
useERKeyboard()

// 改后
useERKeyboard(projectId)
```

`ERCanvas` 已有 `projectId` prop，直接透传。

---

## 不在本次范围内

- **undo/redo 多项目隔离**：`undoStack` / `redoStack` 仍为全局，后续专项处理
- **withReload 全量刷新兜底**：当前 store 操作已通过 Zustand 订阅自动触发 re-render，足够用
- **per-project store 实例化**：长期架构演进，不在本次范围

---

## 验证标准

1. 打开项目 A 和项目 B 的 ER Tab，AI 修改项目 A → Canvas A 节点实时更新，Canvas B 不受影响
2. 通过项目 A 的 MCP Adapter 调用 `add_table` → 新表属于项目 A（`project_id = A`）
3. 聚焦 Canvas A，按 `Ctrl+D` 复制表 → 新表出现在项目 A，不影响项目 B
4. TypeScript 编译无新增错误
