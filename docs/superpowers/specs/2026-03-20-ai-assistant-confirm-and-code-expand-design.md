# AI 助手：确认框接入 & 代码块放大弹框 设计文档

**日期**：2026-03-20
**状态**：已批准

## 背景

AI 助手目前存在两个体验问题：

1. 清空历史、删除会话等破坏性操作缺少确认步骤，误操作后无法恢复。
2. AI 回答中的代码块尺寸受限于助手面板宽度，较长代码可读性差，缺少放大查看能力。

## 功能1：删除/清空操作接入通用确认框

### 目标

三处破坏性操作全部使用项目现有的全局 `ConfirmDialog`（`useConfirmStore().confirm()`），保证行为一致、主题色统一。

### 涉及操作

| 操作 | 位置 | 变体 |
|------|------|------|
| 清空当前会话消息（Trash2 图标） | 主面板 Header | `danger` |
| 删除单个历史会话（列表 hover Trash2） | 历史面板会话列表 | `danger` |
| 删除全部会话（底部按钮） | 历史面板底部 | `danger` |

### 改动说明

- 三处 `onClick` 改为 `async` 函数，调用 `await confirm({...})`，返回 `true` 才执行操作。
- 删除全部会话：移除现有的 `confirmDeleteAll` state 及内联二次确认 UI，替换为 `ConfirmDialog`。
- 确认框文案：
  - 清空当前对话：标题「清空对话」，消息「确定清空当前对话记录？此操作不可恢复。」
  - 删除单个会话：标题「删除会话」，消息「确定删除该会话？此操作不可恢复。」
  - 删除全部会话：标题「删除所有会话」，消息「确定删除全部会话记录？此操作不可恢复。」

### 文件变更

- `src/components/Assistant/index.tsx`：接入 `useConfirmStore`，改写三处事件处理器。

---

## 功能2：代码块放大弹框

### 目标

在 AI 回答的代码块头部工具栏增加放大按钮，点击后弹出全屏 Modal，完整展示代码内容，方便阅读与复制。

### 弹框 UI 规格

| 属性 | 值 |
|------|----|
| 层级 | `z-[300]`（高于 ConfirmDialog 的 `z-[200]`） |
| 遮罩 | `bg-black/70`，点击遮罩关闭 |
| 主体宽高 | `w-[90vw] max-w-5xl max-h-[85vh]` |
| 背景/边框 | `bg-[#111922] border border-[#253347] rounded-lg` |
| 头部 | 语言标签（左）+ 复制按钮 + X 关闭按钮（右） |
| 代码区 | 纵向滚动，使用相同 `SyntaxHighlighter`，`fontSize: 13px` |
| 键盘 | Escape 键关闭 |

### 组件实现方式

- 在 `CodeBlock` 组件内部新增本地 state `expanded`。
- `expanded = true` 时在组件末尾渲染 Portal 弹框（`ReactDOM.createPortal` 挂到 `document.body`），避免被父容器 `overflow: hidden` 裁剪。
- 弹框内复用相同的 `SyntaxHighlighter` 和复制逻辑，不引入额外 Store。

### 文件变更

- `src/components/shared/MarkdownContent.tsx`：
  - `CodeBlock` 新增 `expanded` state。
  - 头部工具栏新增 `Maximize2` 图标按钮。
  - 新增弹框渲染逻辑（`ReactDOM.createPortal`）。

---

## 不在本次范围内

- 流式输出中的代码块放大（弹框内容为快照，不跟随流式更新）。
- 代码块弹框内的编辑功能。
- 国际化（i18n）扩展，本次直接使用中文硬编码文案。
