# Auto 模式直接应用 SQL Diff 设计文档

**日期**：2026-03-20
**状态**：已批准
**作者**：Claude Code（与用户协作）

---

## 背景

当前 AI 助手提议 SQL 修改时，始终通过 `DiffPanel` 展示差异并等待用户手动点击"应用"。
在 Auto 模式下，用户希望框架**跳过确认，直接写入编辑器**，不打断工作流。

---

## 目标

1. Auto 模式开启时，`propose_sql_diff` 触发后自动应用修改到 SQL 编辑器，无需用户点击
2. 自动应用后，在 DiffPanel 位置短暂闪现"已自动应用"状态条（约 1.5 秒后消失）
3. 若 Auto 模式下 `original` 在编辑器中找不到匹配，直接回复 AI 失败，不做任何修改

---

## 非目标

- 不修改 Auto 模式的开关逻辑
- 不修改 Rust 侧任何代码
- 不影响 Auto 关闭时的现有 DiffPanel 流程

---

## 方案：纯前端处理

### 核心变更 — `useToolBridge.ts`

`sql-diff-proposal` 事件处理器在匹配循环前读取 `autoMode`，按以下分支处理：

| 情形 | 行为 |
|------|------|
| Auto=true + 找到匹配 | 直接 `setSql` 写入新 SQL，触发 Banner，`mcp_diff_respond(true)` |
| Auto=true + 未找到匹配 | `mcp_diff_respond(false)`，不做 UI 变更 |
| Auto=false（任何情形） | 现有 DiffPanel 流程，不变 |

**Auto=true + 找到匹配的执行顺序：**

1. 计算 `newSql`（复用 `applyDiff` 中相同的拼接逻辑）
2. `setSql(tabId, newSql)` — 写入编辑器
3. `setAutoApplyBanner({ reason })` — 触发 Banner 显示
4. `invoke('mcp_diff_respond', { confirmed: true })` — 解除 Rust 阻塞
5. `setAssistantOpen(true)` — 确保助手面板可见（与原有行为一致）

### 状态扩展 — `queryStore.ts`

新增两个字段/方法：

```ts
autoApplyBanner: { reason: string } | null;
setAutoApplyBanner: (banner: { reason: string } | null) => void;
```

Banner 的自动消失逻辑（1.5 秒 setTimeout）放在 `useToolBridge.ts` 的调用侧，
不放入 store，保持 store 的纯状态职责。

### 新组件 — `AutoApplyBanner.tsx`

位置：`src/components/Assistant/AutoApplyBanner.tsx`

职责：
- 显示 `✓ AI 已自动应用修改`，附带 `reason` 前 60 字
- 样式与 DiffPanel 同区域，使用绿色调（`#00c9a7`）
- 无交互按钮，纯展示

### 渲染位置 — `Assistant/index.tsx`

在 DiffPanel 同级位置（`{pendingDiff && <DiffPanel ... />}` 下方）添加：

```tsx
{autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
```

两者不会同时显示（Auto 开启时不会产生 `pendingDiff`）。

---

## 状态流

```
sql-diff-proposal 事件到达 useToolBridge
  ├─ autoMode=true
  │    ├─ 找到匹配
  │    │    ├─ setSql(tabId, newSql)
  │    │    ├─ setAutoApplyBanner({ reason })
  │    │    ├─ setTimeout(1500ms) → setAutoApplyBanner(null)
  │    │    ├─ invoke('mcp_diff_respond', { confirmed: true })
  │    │    └─ setAssistantOpen(true)
  │    └─ 未找到匹配
  │         └─ invoke('mcp_diff_respond', { confirmed: false })
  └─ autoMode=false
       └─ proposeSqlDiff(proposal)  ← 现有流程不变
```

---

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/hooks/useToolBridge.ts` | 修改 | 主逻辑：autoMode 分支 |
| `src/store/queryStore.ts` | 修改 | 新增 `autoApplyBanner` 状态 |
| `src/components/Assistant/AutoApplyBanner.tsx` | 新建 | ~30 行展示组件 |
| `src/components/Assistant/index.tsx` | 修改 | 渲染 AutoApplyBanner |

**Rust 侧：零改动**

---

## 边界情况

| 情况 | 处理方式 |
|------|---------|
| Auto 模式下 original 不匹配 | `mcp_diff_respond(false)` 返回失败给 AI，无 UI 变化 |
| Auto 模式下同时有 pendingDiff（理论不可能，但防御性处理） | `autoMode=true` 分支优先执行，`pendingDiff` 不会被设置 |
| 1.5 秒内再次触发自动应用 | `setAutoApplyBanner` 覆盖旧 Banner，setTimeout 重置 |
| 用户在 Banner 显示期间关闭助手面板 | Banner 状态在下次开启时已清除（1.5s 已过），无影响 |
