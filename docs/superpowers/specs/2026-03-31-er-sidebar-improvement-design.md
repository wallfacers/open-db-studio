# ER 设计器侧边栏改进设计

## 概述

改进 ER 设计器侧边栏的视觉效果和交互功能，使其与数据库列表树保持一致，并实现侧边栏与画布节点的双向字段联动编辑。

## 需求

1. **图标统一**：ER 侧边栏表图标改用数据库列表的 `TableProperties` 图标
2. **动画效果**：展开项目时表图标变绿色，收起时灰色（与 TreeNode 行为一致）
3. **双向联动**：侧边栏和画布节点的字段增删改操作互相同步

## 设计细节

### 1. 图标替换

**位置**：`src/components/ERDesigner/ERSidebar/index.tsx`

**改动**：
- 导入 `TableProperties` 图标（替换 `Table2`）
- 表图标颜色根据项目展开状态动态切换

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

### 2. 动画效果统一

**参考**：`src/components/Explorer/TreeNode.tsx` 的颜色切换逻辑（第 64 行）

**规则**：
- 项目展开时：FolderOpen + ChevronDown → 绿色 `text-[#00c9a7]`
- 项目收起时：Folder + ChevronRight → 灰色 `text-[#7a9bb8]`
- 表节点：跟随项目展开状态，展开时表图标变绿，收起时灰色

**改动位置**：
- 项目节点图标颜色（第 147-149 行）：`Folder/FolderOpen` 颜色统一为展开绿色、收起灰色
- Chevron 图标颜色（第 142-145 行）：统一为 `text-[#7a9bb8]`（保持灰色，不随展开变化）
- 表图标颜色（第 181 行）：动态切换

### 3. 侧边栏字段编辑 UI

**新增功能**：

#### 3.1 字段行内联编辑

- **双击字段名** → 进入编辑模式，显示输入框
- **输入框**：自动聚焦，Enter 保存，Esc/Blur 取消
- **参考**：ERTableNode.tsx 的 ColumnRow 内部组件编辑逻辑

**字段行组件结构**：

```tsx
// 新增字段行组件，封装编辑状态
const ColumnRow = ({ column, tableId }: { column: ErColumn; tableId: number }) => {
  const { updateColumn, deleteColumn } = useErDesignerStore();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(column.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  // 保存处理
  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== column.name) {
      updateColumn(column.id, { name: editName.trim() });
    } else {
      setEditName(column.name); // 取消时恢复原值
    }
  };

  // 主键切换
  const handleTogglePrimaryKey = () => {
    updateColumn(column.id, { is_primary_key: !column.is_primary_key });
  };

  return (
    <div className="flex items-center px-2 py-0.5 ml-4 group hover:bg-[#151d28]">
      {/* 主键图标 */}
      <Key
        size={10}
        className={`mr-2 flex-shrink-0 cursor-pointer ${
          column.is_primary_key ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'
        }`}
        onClick={handleTogglePrimaryKey}
      />
      {/* 字段名 - 可编辑 */}
      {isEditingName ? (
        <input
          ref={nameInputRef}
          className="bg-[#151d28] text-[#c8daea] text-[11px] px-1 rounded outline-none border border-[#00c9a7]"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleNameSave();
            if (e.key === 'Escape') { setEditName(column.name); setIsEditingName(false); }
          }}
        />
      ) : (
        <span
          className="text-[11px] text-[#7a9bb8] truncate cursor-text"
          onDoubleClick={() => setIsEditingName(true)}
        >
          {column.name}
        </span>
      )}
      {/* 类型 */}
      <span className="text-[10px] text-[#5a6a7a] ml-1 truncate">{column.data_type}</span>
      {/* 删除按钮 - hover 显示 */}
      <X
        size={12}
        className="ml-1 cursor-pointer text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100"
        onClick={() => deleteColumn(column.id, tableId)}
      />
    </div>
  );
};
```

#### 3.2 字段类型下拉选择

- **复用组件**：`DropdownSelect`（已在 ERTableNode 使用）
- **类型列表**：复用 `ERTableNode.tsx` 的 `SQL_TYPES` 常量
- **导入方式**：在 ERSidebar 中重新定义 `SQL_TYPES` 常量（避免跨组件导入复杂化）
- **下拉定位**：注意侧边栏宽度较窄，DropdownSelect 可能需要 portal 渲染避免溢出

#### 3.3 字段删除按钮

- **hover 显示**：使用 CSS `opacity-0 group-hover:opacity-100` 模式（侧边栏空间有限，hover 显示更简洁）
- **样式参考**：ERTableNode 第 197-201 行，但改为 hover 显示
- **实现**：字段行使用 `group` class，X 按钮使用 `opacity-0 group-hover:opacity-100`

#### 3.4 主键切换

- **点击 Key 图标**：切换字段主键状态
- **颜色统一**：主键时绿色 `text-[#00c9a7]`，非主键时灰色 `text-gray-500 hover:text-gray-300`
- **注意**：当前 ERSidebar 使用 amber `text-[#f59e0b]`，需改为绿色以保持与 ERTableNode 一致

### 4. 表节点操作入口

**改动位置**：`src/components/ERDesigner/ERSidebar/TableContextMenu.tsx`

**现有功能**：
- 「新增字段」菜单项**已存在**（第 87 行 `handleAddColumn`），无需新增
- 侧边栏字段行编辑 UI 将复用此功能

**修改内容**：
- 完善字段删除子菜单（可选优化：改为对话框方式，避免多字段时子菜单过长）

### 5. 数据流与双向联动

**现有机制**：
- `useErDesignerStore` 已有完整的 `addColumn/updateColumn/deleteColumn` 方法
- ERCanvas 通过 `useEffect` 监听 `columns` 状态变化自动同步到画布节点（第 155-220 行）

**联动路径**：

```
侧边栏编辑字段
    → addColumn/updateColumn/deleteColumn(colId, updates)
    → Store.columns 更新
    → ERCanvas useEffect 监听 columns 变化
    → 画布节点刷新

画布节点编辑字段
    → updateColumn(colId, updates)
    → Store.columns 更新
    → ERSidebar 组件订阅 columns 状态重新渲染
    → 侧边栏字段行刷新
```

**无需新增同步逻辑**：现有 Zustand 状态订阅机制已支持双向联动。

## 改动文件清单

| 文件 | 改动内容 | 影响范围 |
|------|----------|----------|
| `ERSidebar/index.tsx` | 1. 导入 `TableProperties` 替换 `Table2`<br>2. 图标颜色动态切换逻辑<br>3. 新增 `ColumnRow` 内部组件（字段编辑 UI）<br>4. 主键图标颜色统一为绿色 | 仅 ER 侧边栏 |
| `TableContextMenu.tsx` | 无需修改（新增字段功能已存在） | 无改动 |
| `ERCanvas/index.tsx` | 无改动 | 已有同步机制 |
| `ERTableNode.tsx` | 无改动 | 已有字段编辑功能 |
| `erDesignerStore.ts` | 无改动 | 已有完整操作方法 |

## 不影响的外部组件

- `Explorer/TreeNode.tsx` - 仅参考动画逻辑
- `Explorer/DBTree.tsx` - 数据库列表树，无改动
- `Explorer/index.tsx` - Explorer 容器，无改动

## 实现步骤

1. **图标替换**：修改 `ERSidebar/index.tsx` 导入，将 `Table2` 替换为 `TableProperties`
2. **动画效果**：添加展开状态颜色切换逻辑（项目展开时表图标变绿，收起时灰色）
3. **字段编辑组件**：在 `ERSidebar/index.tsx` 内部新增 `ColumnRow` 组件，封装编辑状态
4. **主键颜色统一**：将 Key 图标颜色从 amber 改为绿色，与 ERTableNode 一致
5. **删除按钮**：使用 `opacity-0 group-hover:opacity-100` 模式，hover 时显示 X 按钮
6. **测试双向联动**：侧边栏编辑 → 画布刷新，画布编辑 → 侧边栏刷新

## 测试要点

1. **图标颜色**：展开项目时表图标变绿，收起时灰色
2. **字段编辑**：双击字段名可编辑，Enter 保存，Esc 取消
3. **字段类型**：下拉选择生效，切换后两边同步
4. **主键切换**：点击 Key 图标切换主键状态
5. **字段删除**：hover 显示 X 按钮，点击删除后两边同步
6. **右键菜单**：新增字段菜单项可用
7. **双向联动**：侧边栏操作后画布节点立即刷新，反之亦然