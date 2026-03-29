<!-- STATUS: ✅ 已实现 -->
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
2. 自动应用后，在 Assistant 面板的 DiffPanel 区域短暂闪现"已自动应用"状态条（约 1.5 秒后消失）
3. 若 Auto 模式下 `original` 在编辑器中找不到匹配，直接回复 AI 失败，不做任何修改
4. **同时修复现有 Bug**：Auto 关闭且未找到匹配时，Rust 侧 oneshot channel 也应收到 `confirmed: false`，防止永久阻塞

---

## 非目标

- 不修改 Auto 模式的开关逻辑
- 不修改 Rust 侧任何代码
- 不影响 Auto 关闭 + 找到匹配时的现有 DiffPanel 流程

---

## 方案：纯前端处理

### 核心变更 — `useToolBridge.ts`

`sql-diff-proposal` 事件处理器覆盖全部四个分支：

| autoMode | 匹配结果 | 行为 |
|----------|---------|------|
| true | 找到匹配 | 直接写 SQL + 触发 Banner + `mcp_diff_respond(true)` |
| true | 未找到匹配 | `mcp_diff_respond(false)`，无 UI 变更 |
| false | 找到匹配 | `proposeSqlDiff(proposal)` — 现有 DiffPanel 流程 |
| false | 未找到匹配 | `mcp_diff_respond(false)`（**修复现有永久阻塞 Bug**） |

**Auto=true + 找到匹配的执行顺序：**

1. 计算 `newSql`（见下方"分号消费"说明）
2. `setSql(tabId, newSql)` — 写入编辑器
3. `setAutoApplyBanner({ reason })` — 触发 Banner，同时清除旧定时器（见下方 Timer 管理）
4. 启动 1500ms 定时器，到期后 `setAutoApplyBanner(null)`，并记录 `timerId` 到 `useRef`
5. `invoke('mcp_diff_respond', { confirmed: true })` — 解除 Rust 阻塞
6. `setAssistantOpen(true)` — 打开助手面板（确保用户能看到 Banner）

### 分号消费逻辑（重要）

复用 `applyDiff`（`queryStore.ts:466-485`）中相同的分号检测：

```ts
const full = sqlContent[tabId];
const endOffset =
  full[match.endOffset] === ';'
    ? match.endOffset + 1
    : match.endOffset;
const newSql =
  full.slice(0, match.startOffset) +
  modified +
  full.slice(endOffset);
```

此逻辑防止 `modified` 自带分号时出现双分号。

### Timer 管理（防止快速连续触发时旧定时器残留）

在 `useToolBridge` 内维护一个 `autoApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)`。

每次触发 Auto 应用时：
```ts
if (autoApplyTimerRef.current) clearTimeout(autoApplyTimerRef.current);
setAutoApplyBanner({ reason });
autoApplyTimerRef.current = setTimeout(() => {
  setAutoApplyBanner(null);
  autoApplyTimerRef.current = null;
}, 1500);
```

`useEffect` cleanup 中同样 `clearTimeout(autoApplyTimerRef.current)`，防止组件卸载后写入。

---

### 状态扩展 — `queryStore.ts`

新增两个字段/方法：

```ts
autoApplyBanner: { reason: string } | null;
setAutoApplyBanner: (banner: { reason: string } | null) => void;
```

Store 只持有状态，定时器生命周期由 `useToolBridge.ts` 管理。

### 新组件 — `AutoApplyBanner.tsx`

位置：`src/components/Assistant/AutoApplyBanner.tsx`

职责：
- 显示 `✓ AI 已自动应用修改`，附带完整 `reason` 文字（不截断，与 DiffPanel 保持一致）
- 样式与 DiffPanel 同区域，使用绿色调（`#00c9a7`），无交互按钮

### 渲染位置 — `Assistant/index.tsx`

Banner 需在**两个状态路径**中都渲染（对话状态 + 空状态），因为 Auto 模式下第一条 AI 消息即可触发 diff：

**对话状态路径**（`isEmpty=false`）：在 DiffPanel 同级位置添加：
```tsx
{pendingDiff && <DiffPanel ... />}
{autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
```

**空状态路径**（`isEmpty=true`）：在输入框上方添加同样的渲染：
```tsx
{autoApplyBanner && <AutoApplyBanner reason={autoApplyBanner.reason} />}
<div className="w-full">{renderInputBox()}</div>
```

两者不会同时出现（Auto 开启时不产生 `pendingDiff`）。

---

## 完整状态流

```
sql-diff-proposal 事件到达 useToolBridge
  ├─ autoMode=true
  │    ├─ 找到匹配
  │    │    ├─ 计算 newSql（含分号消费）
  │    │    ├─ setSql(tabId, newSql)
  │    │    ├─ clearTimeout(autoApplyTimerRef) [清除旧定时器]
  │    │    ├─ setAutoApplyBanner({ reason })
  │    │    ├─ autoApplyTimerRef = setTimeout(1500ms → setAutoApplyBanner(null))
  │    │    ├─ invoke('mcp_diff_respond', { confirmed: true })
  │    │    └─ setAssistantOpen(true)
  │    └─ 未找到匹配
  │         └─ invoke('mcp_diff_respond', { confirmed: false })
  └─ autoMode=false
       ├─ 找到匹配
       │    └─ proposeSqlDiff(proposal)  ← 现有 DiffPanel 流程
       └─ 未找到匹配（Bug 修复）
            └─ invoke('mcp_diff_respond', { confirmed: false })
```

---

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/hooks/useToolBridge.ts` | 修改 | 主逻辑：autoMode 分支 + Bug 修复 + Timer 管理 |
| `src/store/queryStore.ts` | 修改 | 新增 `autoApplyBanner` 状态及 setter |
| `src/components/Assistant/AutoApplyBanner.tsx` | 新建 | ~25 行展示组件 |
| `src/components/Assistant/index.tsx` | 修改 | 在对话状态和空状态路径中均渲染 AutoApplyBanner |

**Rust 侧：零改动**

---

## 边界情况

| 情况 | 处理方式 |
|------|---------|
| Auto=true + original 不匹配 | `mcp_diff_respond(false)`，无 UI，AI 收到失败信息 |
| Auto=false + original 不匹配 | `mcp_diff_respond(false)`（修复原有永久阻塞） |
| 1.5 秒内再次触发自动应用 | 先 `clearTimeout` 旧定时器，再写入新 Banner + 新定时器 |
| `useToolBridge` 组件卸载（当前不会，但防御性处理） | cleanup 中 `clearTimeout`，不会写入 null |
| Auto=true 且助手面板已关闭 | 强制打开面板（`setAssistantOpen(true)`），确保 Banner 可见 |
| `modified` 末尾自带分号 | 分号消费逻辑处理，不产生双分号 |
