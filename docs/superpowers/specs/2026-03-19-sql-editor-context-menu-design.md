# SQL 编辑器右键菜单扩展 — 设计文档

**日期：** 2026-03-19
**状态：** 已批准

---

## 背景

SQL 编辑器当前右键菜单仅有 6 个基础操作（剪切/复制/粘贴/全选/格式化），
缺少执行、编辑辅助、AI 智能操作等常用功能，用户需频繁移动到工具栏操作。

---

## 目标

在编辑器右键菜单中增加 **综合分组式** 快捷操作，涵盖：
- SQL 执行控制
- 编辑辅助
- AI 智能操作（智能感知选中/当前语句）

---

## 菜单结构

```
┌─────────────────────────────────────┐
│  ✂  剪切              Ctrl+X        │  ← 图标色 #7a9bb8
│  ⎘  复制              Ctrl+C        │
│  ⎗  粘贴              Ctrl+V        │
├─────────────────────────────────────┤
│  ▶  执行全部           F5           │  ← 图标色 #00c9a7（主题执行绿）
│  ▶  执行选中  [无选中时置灰]         │  ← 图标色 #00c9a7
├─────────────────────────────────────┤
│  ↩  撤销              Ctrl+Z        │  ← 图标色 #7a9bb8
│  ↪  重做              Ctrl+Y        │
│  ⬚  全选              Ctrl+A        │
│  /  注释/取消注释      Ctrl+/        │
│  🔍  查找/替换         Ctrl+H        │
├─────────────────────────────────────┤
│  ⬡  格式化 SQL                      │  ← 图标色 #7a9bb8
│  🔦  解释 SQL  [智能感知]            │  ← 图标色 #5eb2f7（主题蓝）
│  ⚡  优化 SQL  [智能感知]            │  ← 图标色 #5eb2f7
└─────────────────────────────────────┘
```

> **注：** "停止执行"不纳入本版本——queryStore 无取消查询机制（AI 操作有 cancel，SQL 执行无），
> 强行添加会产生无效按钮。如需支持，需先在 Rust 层实现 `cancel_query` 命令。

---

## 主题色规范

沿用项目现有 `#111922` 系列深色主题：

| 用途 | 颜色 |
|------|------|
| 菜单背景 | `#151d28` |
| 边框 / 分割线 | `#2a3f5a` |
| 菜单文字 | `#c8daea` |
| 悬停背景 | `#1a2639` |
| 悬停文字 | `#ffffff` |
| 剪贴板 / 编辑图标 | `#7a9bb8` |
| 执行图标 | `#00c9a7` |
| AI 操作图标 | `#5eb2f7` |
| 置灰 disabled 文字 | `#3a5070` |
| 置灰 disabled 图标 | `#3a5070` |

---

## 智能感知逻辑（解释/优化）

```
1. 有文本选中 → 使用选中内容
2. 无文本选中 → 按分号切割整个 SQL 编辑器内容，
               取光标所在位置对应的完整语句
               若切割结果为空 → 回退到整个 currentSql
```

新增辅助函数 `getSqlAtCursor(sql: string, cursorOffset: number): string`：
- 将 sql 按 `;` 拆分为语句列表，逐段累计字符偏移
- 返回包含 cursorOffset 的语句（trim 后）
- 若结果为空字符串则返回 `sql.trim()`

该函数仅在右键菜单的解释/优化入口使用，不改动工具栏按钮的现有逻辑。

---

## 执行全部 vs 执行选中 — 实现方案

现有 `handleExecute()` 内部已做判断：有选中则执行选中，否则执行全部。
右键菜单两个按钮的差异处理方式：

| 按钮 | 实现 |
|------|------|
| **执行全部** | 先调用 `editor.setPosition(editor.getPosition())` 收缩选区，再调用 `handleExecute()` |
| **执行选中** | 仅在 `selectedSql.trim() !== ''` 时可点击，直接调用 `handleExecute()`（内部会取选中内容） |

---

## 动态状态规则

| 菜单项 | disabled 条件 |
|--------|--------------|
| 执行全部 | 无 disabled（点击后由 `handleExecute` 内部 toast 提示缺少连接） |
| 执行选中 | `selectedSql.trim() === ''` |
| 撤销/重做/全选/注释/查找 | 无 disabled（编辑器始终可编辑） |
| 格式化 SQL | 无 disabled |
| 解释 SQL | `!activeTabObj?.queryContext?.connectionId` |
| 优化 SQL | `!activeTabObj?.queryContext?.connectionId` |

> **智能感知边界说明：** `getSqlAtCursor` 按字面量分号切割，不处理字符串内部分号（MVP 阶段接受此限制）。光标恰好在分号上时归属前一条语句。末尾空段自动跳过，最终结果为空时回退到 `currentSql`。

---

## 实现范围

**修改文件（共 3 个）：**

### 1. `src/components/MainContent/index.tsx`
- 新增 `getSqlAtCursor(sql, cursorOffset)` 辅助函数（组件外，纯函数）
- 在 `editorContextMenu && (` 块内替换现有菜单 JSX，扩展为 4 组完整菜单
- 新增图标导入：`Scissors, Play, CirclePlay, Undo2, Redo2, TextSelect, MessageSquare, Search, FileEdit, Lightbulb, Zap`（部分已导入）

### 2. `src/i18n/locales/zh.json`
在 `editorContextMenu` 对象中新增：
```json
"executeAll": "执行全部",
"executeSelected": "执行选中",
"undo": "撤销",
"redo": "重做",
"toggleComment": "注释/取消注释",
"findReplace": "查找/替换",
"explainSql": "解释 SQL",
"optimizeSql": "优化 SQL"
```

### 3. `src/i18n/locales/en.json`
在 `editorContextMenu` 对象中新增：
```json
"executeAll": "Execute All",
"executeSelected": "Execute Selected",
"undo": "Undo",
"redo": "Redo",
"toggleComment": "Toggle Comment",
"findReplace": "Find & Replace",
"explainSql": "Explain SQL",
"optimizeSql": "Optimize SQL"
```

---

## Lucide 图标映射

| 菜单项 | 图标组件 | 颜色 |
|--------|---------|------|
| 剪切 | `Scissors` | `#7a9bb8` |
| 复制 | `Copy` | `#7a9bb8` |
| 粘贴 | `Clipboard` | `#7a9bb8` |
| 执行全部 | `Play` | `#00c9a7` |
| 执行选中 | `CirclePlay` | `#00c9a7` |
| 撤销 | `Undo2` | `#7a9bb8` |
| 重做 | `Redo2` | `#7a9bb8` |
| 全选 | `TextSelect` | `#7a9bb8` |
| 注释/取消注释 | `MessageSquare` | `#7a9bb8` |
| 查找/替换 | `Search` | `#7a9bb8` |
| 格式化 | `FileEdit` | `#7a9bb8` |
| 解释 SQL | `Lightbulb` | `#5eb2f7` |
| 优化 SQL | `Zap` | `#5eb2f7` |
