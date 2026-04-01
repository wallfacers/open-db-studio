<!-- STATUS: ✅ 已实现 -->
# TableDataView 行操作增强设计

**日期：** 2026-03-11
**状态：** 已批准
**范围：** `src/components/MainContent/`

## 背景

当前 `TableDataView.tsx` 仅支持基础分页查看和单行删除（hover 按钮）。
本次增强目标：实现类 Excel 的行操作体验，包括右键菜单、内联编辑、批量提交。

---

## 文件结构

```
src/components/MainContent/
├── TableDataView.tsx          # 协调层（精简）
├── RowContextMenu.tsx         # 新建：右键菜单组件
├── usePendingChanges.ts       # 新建：本地编辑状态 Hook
└── EditableCell.tsx           # 新建：可编辑单元格组件
```

---

## 架构与数据流

```
TableDataView
  ├── usePendingChanges()  ← 管理 pending edits / 提交 / 撤销
  ├── <EditableCell>       ← 双击进入编辑，值写回 pendingChanges
  └── <RowContextMenu>     ← 接收选中行/单元格，执行操作
```

### 状态设计（usePendingChanges）

```ts
type CellEdit = { rowIdx: number; colIdx: number; newValue: string | null }
type PendingState = {
  edits: CellEdit[]        // 待提交的单元格修改（UPDATE）
  clonedRows: RowData[]    // 克隆的新行（INSERT）
  deletedRows: number[]    // 待删除行索引（DELETE）
}
```

---

## 右键菜单（RowContextMenu）

右键目标分两类，菜单内容不同：

### 右键点击「行号列（#）」

```
┌─────────────────────────┐
│ 复制行                   │  → Tab分隔整行数据到剪贴板
│ 粘贴                     │  → 剪贴板内容写入当前选中单元格
│ ─────────────────────── │
│ 克隆行                   │  → 复制为新行（pending 绿色）
│ 删除行                   │  → 标记待删除（pending 红色）
│ ─────────────────────── │
│ 复制为 SQL          ▶    │
│   INSERT SQL             │
│   UPDATE SQL             │
│   DELETE SQL             │
└─────────────────────────┘
```

### 右键点击「数据单元格」

```
┌─────────────────────────┐
│ 复制单元格               │  → 单元格值到剪贴板
│ 复制行                   │  → Tab分隔整行数据到剪贴板
│ 粘贴                     │  → 剪贴板内容写入当前单元格
│ ─────────────────────── │
│ 设置为 NULL              │  → 当前单元格写入 null（进入 pending）
│ 克隆行                   │  → 复制为新行（pending 绿色）
│ 删除行                   │  → 标记待删除（pending 红色）
│ ─────────────────────── │
│ 复制为 SQL          ▶    │
│   INSERT SQL             │
│   UPDATE SQL             │
│   DELETE SQL             │
└─────────────────────────┘
```

### 实现细节

- `clickTarget: 'row' | 'cell'` 区分右键位置，条件渲染菜单项
- 点击菜单外任意区域关闭菜单
- 「粘贴」灰显条件：剪贴板为空或非文本
- UPDATE SQL 和 DELETE SQL 以 `pkColumn` 作为 WHERE 条件
- 「复制为 SQL」结果写入系统剪贴板，Toast 提示"已复制"
- 菜单样式：`bg-[#0d1117]` + `border-[#1e2d42]`，与现有暗色主题一致

---

## 内联单元格编辑（EditableCell）

- 双击单元格 → 显示 `<input>`，宽高 = 单元格尺寸 - 4px，自动 focus 并全选
- `Enter` / 失焦 → 确认，写入 pendingChanges
- `Escape` → 取消，恢复原值
- NULL 值显示为空输入框；需设为 NULL 时通过右键「设置为NULL」操作

### 待提交行视觉状态

| 状态 | 行背景色 | 说明 |
|------|---------|------|
| 已编辑（UPDATE） | `bg-yellow-900/30` | 单元格有修改 |
| 新增（INSERT） | `bg-green-900/30` | 克隆行待插入 |
| 待删除（DELETE） | `bg-red-900/30` + 删除线 | 待删除 |

---

## 工具栏变化

有 pending 变更时，顶部工具栏显示：

```
[|<] [<] 页码 [>]  刷新  |  提交(N)  撤销   |  导出
                         ↑ N = 待提交变更数，按钮蓝色高亮
```

### 提交顺序

1. DELETE（删除行）
2. UPDATE（编辑行）
3. INSERT（克隆新行）

全部成功 → 清空 pendingChanges，刷新表数据，Toast 成功提示。
任意失败 → 回滚（不清空 pendingChanges），Toast 报错，保留用户改动。

---

## 不在范围内（本次不实现）

- 键盘多单元格选择（Shift+方向键）
- 跨行粘贴（多行剪贴板内容）
- 撤销/重做历史（Ctrl+Z）
