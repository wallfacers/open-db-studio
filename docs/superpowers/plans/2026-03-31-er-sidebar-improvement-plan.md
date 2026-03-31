# ER 侧边栏改进实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改进 ER 设计器侧边栏的图标、动画效果和字段编辑功能，实现与画布节点的双向联动。

**Architecture:** 仅修改 `ERSidebar/index.tsx`，替换图标、添加颜色切换逻辑、新增 `ColumnRow` 内部组件。复用现有 Zustand 同步机制实现双向联动。

**Tech Stack:** React 18, TypeScript, Zustand, Lucide React Icons, Tailwind CSS

---

## 文件结构

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/components/ERDesigner/ERSidebar/index.tsx` | Modify | 图标替换、动画效果、ColumnRow 组件 |

---

## Chunk 1: 图标替换与动画效果

### Task 1: 替换图标导入

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx:3`

- [ ] **Step 1: 修改导入语句**

将 `Table2` 替换为 `TableProperties`，同时添加 `Hash` 和 `X` 图标：

```tsx
// 修改前
import { Folder, FolderOpen, Plus, Database, Table2, Key, Link2, MoreVertical, Trash2, Edit3, Download, Upload, ChevronRight, ChevronDown } from 'lucide-react';

// 修改后
import { Folder, FolderOpen, Plus, Database, TableProperties, Key, Hash, Link2, MoreVertical, Trash2, Edit3, Download, Upload, ChevronRight, ChevronDown, X } from 'lucide-react';
```

说明：
- `TableProperties`：替换 `Table2` 用于表节点图标
- `Hash`：用于自动递增标识（参考 ERTableNode）
- `X`：用于字段删除按钮

---

### Task 2: 项目节点图标颜色切换

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx:141-150`

- [ ] **Step 1: 修改项目节点 Folder/FolderOpen 图标颜色**

统一为展开时绿色、收起时灰色：

```tsx
// 修改前（第 146-149 行）
{expandedProjects.has(project.id) ? (
  <FolderOpen size={14} className="mr-2 text-[#00c9a7] flex-shrink-0" />
) : (
  <Folder size={14} className="mr-2 text-[#7a9bb8] flex-shrink-0" />
)}

// 修改后 - 保持不变，颜色已正确
// 无需修改，Folder/FolderOpen 颜色逻辑已正确
```

实际上，当前代码中 FolderOpen 已经是绿色 `text-[#00c9a7]`，Folder 是灰色 `text-[#7a9bb8]`，**无需修改**。

- [ ] **Step 2: 确认 Chevron 图标颜色**

Chevron 图标保持灰色 `text-[#7a9bb8]`，当前代码已正确：

```tsx
// 第 141-145 行 - 无需修改
{expandedProjects.has(project.id) ? (
  <ChevronDown size={14} className="mr-1 text-[#7a9bb8] flex-shrink-0" />
) : (
  <ChevronRight size={14} className="mr-1 text-[#7a9bb8] flex-shrink-0" />
)}
```

---

### Task 3: 表节点图标替换与颜色切换

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx:181`

- [ ] **Step 1: 替换表图标并添加颜色切换**

```tsx
// 修改前（第 181 行）
<Table2 size={12} className="mr-2 text-[#3794ff] flex-shrink-0" />

// 修改后
<TableProperties
  size={12}
  className={`mr-2 flex-shrink-0 ${
    expandedProjects.has(project.id) ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'
  }`}
/>
```

- [ ] **Step 2: 手动验证图标颜色变化**

1. 运行 `npm run tauri:dev`
2. 打开 ER 设计器侧边栏
3. 点击项目节点展开 → 表图标应为绿色 `#00c9a7`
4. 点击项目节点收起 → 表图标应为灰色 `#7a9bb8`

---

### Task 4: 提交图标替换改动

- [ ] **Step 1: 提交代码**

```bash
git add src/components/ERDesigner/ERSidebar/index.tsx
git commit -m "feat(er-sidebar): replace Table2 icon with TableProperties and add color animation"
```

---

## Chunk 2: 字段编辑 UI

### Task 5: 添加 SQL_TYPES 常量

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx`（在导入语句后添加）

- [ ] **Step 1: 在文件顶部添加 SQL_TYPES 常量**

```tsx
// 在第 11 行（import 语句后）添加
const SQL_TYPES = [
  { value: 'INT', label: 'INT' },
  { value: 'BIGINT', label: 'BIGINT' },
  { value: 'VARCHAR', label: 'VARCHAR' },
  { value: 'TEXT', label: 'TEXT' },
  { value: 'CHAR', label: 'CHAR' },
  { value: 'DATETIME', label: 'DATETIME' },
  { value: 'DATE', label: 'DATE' },
  { value: 'TIMESTAMP', label: 'TIMESTAMP' },
  { value: 'BOOLEAN', label: 'BOOLEAN' },
  { value: 'DECIMAL', label: 'DECIMAL' },
  { value: 'FLOAT', label: 'FLOAT' },
  { value: 'DOUBLE', label: 'DOUBLE' },
];
```

---

### Task 6: 添加 ColumnRow 内部组件

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx`（在 `ERSidebarProps` 接口定义前添加）

- [ ] **Step 1: 添加 ColumnRow 组件定义**

在 `ERSidebarProps` 接口前（约第 13 行）添加完整组件：

**导入说明：**
- 文件已在第 1 行导入 `useState, useEffect`，仅需添加 `useRef`
- `DropdownSelect` 已在第 9 行导入，无需修改
- `Hash` 图标已在 Task 1 导入

修改 React 导入：
```tsx
// 修改前（第 1 行）
import React, { useEffect, useState } from 'react';

// 修改后
import React, { useEffect, useState, useRef } from 'react';
```

添加 ColumnRow 组件定义：

```tsx
import { useRef, useEffect, useState } from 'react';

// SQL_TYPES 常量（已在 Task 5 添加）

// ColumnRow 组件 - 字段行编辑 UI
interface ColumnRowProps {
  column: ErColumn;
  tableId: number;
}

const ColumnRow = ({ column, tableId }: ColumnRowProps) => {
  const { updateColumn, deleteColumn } = useErDesignerStore();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(column.name);
  const [isEditingType, setIsEditingType] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦字段名输入框
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  // 保存字段名
  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== column.name) {
      updateColumn(column.id, { name: editName.trim() });
    } else {
      setEditName(column.name);
    }
  };

  // 主键切换
  const handleTogglePrimaryKey = () => {
    updateColumn(column.id, { is_primary_key: !column.is_primary_key });
  };

  // 自动递增切换（仅主键可用）
  const handleToggleAutoIncrement = () => {
    if (!column.is_primary_key) return;
    updateColumn(column.id, { is_auto_increment: !column.is_auto_increment });
  };

  return (
    <div
      className="flex items-center px-2 py-0.5 ml-4 group hover:bg-[#151d28] cursor-default"
      onContextMenu={(e) => {
        e.preventDefault();
        // 可选：触发字段右键菜单
      }}
    >
      {/* 主键图标 */}
      <Key
        size={10}
        className={`mr-1 flex-shrink-0 cursor-pointer ${
          column.is_primary_key ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'
        }`}
        onClick={handleTogglePrimaryKey}
        title={column.is_primary_key ? '主键' : '点击设置为主键'}
      />

      {/* 自动递增图标（仅主键显示） */}
      {column.is_primary_key && (
        <span title={column.is_auto_increment ? '自动递增' : '点击设置自动递增'}>
          <Hash
            size={10}
            className={`mr-1 flex-shrink-0 cursor-pointer ${
              column.is_auto_increment ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'
            }`}
            onClick={handleToggleAutoIncrement}
          />
        </span>
      )}

      {/* 字段名 - 可编辑 */}
      {isEditingName ? (
        <input
          ref={nameInputRef}
          className="bg-[#151d28] text-[#c8daea] text-[11px] px-1 rounded outline-none border border-[#00c9a7] min-w-[40px]"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleNameSave();
            if (e.key === 'Escape') {
              setEditName(column.name);
              setIsEditingName(false);
            }
          }}
          style={{ width: `${Math.max(editName.length * 7, 40)}px` }}
        />
      ) : (
        <span
          className="text-[11px] text-[#7a9bb8] truncate cursor-text hover:bg-[#253347] px-0.5 rounded"
          onDoubleClick={() => setIsEditingName(true)}
          title="双击编辑"
        >
          {column.name}
        </span>
      )}

      {/* 类型 */}
      <div className="ml-1 shrink-0">
        <DropdownSelect
          value={column.data_type}
          options={SQL_TYPES}
          onChange={(value) => updateColumn(column.id, { data_type: value })}
          plain
        />
      </div>

      {/* 删除按钮 - hover 显示 */}
      <X
        size={12}
        className="ml-1 cursor-pointer text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
        onClick={() => deleteColumn(column.id, tableId)}
        title="删除字段"
      />
    </div>
  );
};
```

---

### Task 7: 替换字段行渲染

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx:194-213`

- [ ] **Step 1: 替换现有字段行渲染逻辑**

找到现有的字段行渲染代码（第 194-213 行），替换为使用 `ColumnRow` 组件：

```tsx
// 修改前（第 194-213 行）
{/* Column Nodes */}
{getTableColumns(table.id).slice(0, 5).map(column => (
  <div
    key={column.id}
    className="flex items-center px-2 py-0.5 ml-4 cursor-default hover:bg-[#151d28]"
    onContextMenu={(e) => handleContextMenu(e, 'column', { projectId: project.id, tableId: table.id, columnId: column.id })}
  >
    {column.is_primary_key ? (
      <Key size={10} className="mr-2 text-[#f59e0b] flex-shrink-0" />
    ) : (
      <div className="w-2.5 mr-2 flex-shrink-0" />
    )}
    <span className="text-[11px] text-[#7a9bb8] truncate">{column.name}</span>
    <span className="text-[10px] text-[#5a6a7a] ml-1 truncate">{column.data_type}</span>
  </div>
))}
{getTableColumns(table.id).length > 5 && (
  <div className="px-2 py-0.5 ml-4 text-[10px] text-[#5a6a7a]">
    {t('erDesigner.moreColumns', { count: getTableColumns(table.id).length - 5 })}
  </div>
)}

// 修改后
{/* Column Nodes */}
{getTableColumns(table.id).map(column => (
  <ColumnRow
    key={column.id}
    column={column}
    tableId={table.id}
  />
))}
```

变更说明：
1. 使用 `ColumnRow` 组件替代内联渲染
2. 移除 `.slice(0, 5)` 限制，显示所有字段
3. 移除 "更多字段" 提示

---

### Task 8: 提交字段编辑 UI 改动

- [ ] **Step 1: 提交代码**

```bash
git add src/components/ERDesigner/ERSidebar/index.tsx
git commit -m "feat(er-sidebar): add ColumnRow component with inline editing, type dropdown, and delete button"
```

---

## Chunk 3: 测试与验证

### Task 9: 手动功能测试

- [ ] **Step 1: 启动应用**

```bash
npm run tauri:dev
```

- [ ] **Step 2: 测试图标颜色**

| 测试项 | 操作 | 预期结果 |
|--------|------|----------|
| 项目展开 | 点击项目节点展开 | FolderOpen 图标绿色，表图标绿色 |
| 项目收起 | 点击项目节点收起 | Folder 图标灰色，表图标灰色 |
| 表图标 | 展开/收起切换 | TableProperties 图标颜色随项目状态变化 |

- [ ] **Step 3: 测试字段编辑**

| 测试项 | 操作 | 预期结果 |
|--------|------|----------|
| 字段名编辑 | 双击字段名 | 进入编辑模式，显示输入框 |
| 保存字段名 | Enter 或点击外部 | 保存新名称，画布节点同步更新 |
| 取消编辑 | Esc 键 | 恢复原名称，退出编辑模式 |
| 类型选择 | 点击类型下拉 | 显示 SQL_TYPES 列表，可选择 |
| 类型同步 | 选择新类型 | 画布节点类型同步更新 |

- [ ] **Step 4: 测试主键与删除**

| 测试项 | 操作 | 预期结果 |
|--------|------|----------|
| 主键切换 | 点击 Key 图标 | 切换主键状态，图标颜色变化 |
| 主键同步 | 侧边栏切换主键 | 画布节点主键状态同步 |
| 删除按钮显示 | hover 字段行 | X 按钮显示 |
| 删除字段 | 点击 X 按钮 | 字段删除，画布节点同步 |

- [ ] **Step 5: 测试双向联动**

| 测试项 | 操作 | 预期结果 |
|--------|------|----------|
| 侧边栏→画布 | 在侧边栏编辑字段名 | 画布节点字段名立即更新 |
| 画布→侧边栏 | 在画布节点编辑字段名 | 侧边栏字段名立即更新 |
| 侧边栏删除 | 在侧边栏删除字段 | 画布节点字段消失 |
| 画布删除 | 在画布节点删除字段 | 侧边栏字段消失 |

---

### Task 10: TypeScript 类型检查

- [ ] **Step 1: 运行类型检查**

```bash
npx tsc --noEmit
```

预期：无类型错误。

---

### Task 11: 最终提交

- [ ] **Step 1: 确认所有改动**

```bash
git status
git diff
```

- [ ] **Step 2: 提交完整功能**

```bash
git add -A
git commit -m "feat(er-sidebar): complete sidebar improvement with icon animation and bidirectional field editing"
```

---

## 完成标准

1. ✅ 图标替换：`TableProperties` 图标生效
2. ✅ 动画效果：展开时绿色，收起时灰色
3. ✅ 字段编辑：双击编辑、类型下拉、主键切换
4. ✅ 字段删除：hover 显示 X 按钮，点击删除
5. ✅ 双向联动：侧边栏↔画布节点同步
6. ✅ TypeScript：无类型错误
7. ✅ 手动测试：所有功能正常