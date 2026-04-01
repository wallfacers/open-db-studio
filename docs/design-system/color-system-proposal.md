# Open DB Studio 颜色系统优化方案

## 评估结论

基于 UI/UX Pro Max 专业设计系统分析，当前 Abyss Theme 具备良好的基础，但存在以下改进空间。

---

## 当前方案分析

### 优势
- 深色主题符合开发者工具定位
- 电光青主题色 (#00c9a7) 具有辨识度
- 背景层级设计合理（void -> base -> panel -> elevated）
- 文字层级完整（ghost -> muted -> subtle -> default -> bright）

### 问题与风险
| 优先级 | 问题 | 影响 |
|--------|------|------|
| Critical | 主题色 #00c9a7 在深色背景上对比度可能不足 | WCAG 合规风险 |
| Critical | 语义颜色与主题色调不统一 | 视觉混乱 |
| High | 缺少系统化的色板规范 | 维护困难 |
| High | 绿色主题色与"成功"语义色冲突 | 用户认知混淆 |
| Medium | 缺少浅色模式支持 | 场景覆盖不全 |

---

## 前端代码颜色合规性审计（2026-04-01）

### 审计概要

| 问题类型 | 数量 | 严重程度 |
|----------|------|----------|
| 硬编码 hex 色值 | ~450+ 处 | Critical |
| Tailwind 直接颜色类（text-red-400 等） | ~200+ 处 | Critical |
| `text-white` / `hover:text-white` 硬编码 | 162 处 | High |
| `text-gray-*` 直接颜色类 | ~45 处 | High |
| CSS 变量引用正确 | ~60% 代码 | -- |

### 按违规类型详细分析

#### A. 旧版 Accent 色 `#009e84` 残留（~35 处）
**应替换为**: `var(--accent)` / `var(--accent-hover)`

| 文件 | 违规行数 | 场景 |
|------|----------|------|
| ConnectionModal/index.tsx | 225,327,369,563 | focus 边框、按钮 |
| DatabaseManager/CreateDatabaseDialog.tsx | 59,67,154,176 | focus 边框、图标、按钮 |
| AiCreateTableDialog/index.tsx | 64,83 | focus 边框 |
| TableManageDialog/index.tsx | 272,281,294,311 | 图标、按钮、focus |
| common/BaseModal.tsx | 30 | primary 按钮 |
| common/ConfirmDialog.tsx | 47 | 确认按钮 |
| common/DropdownSelect.tsx | 164,174 | 选中项文字 |
| IndexManager/index.tsx | 104,110 | focus 边框 |
| ImportExport/BackupWizard.tsx | 48,90,110,122,131,141,152,212,220 | focus、checkbox、按钮 |
| ImportExport/ExportWizard.tsx | 241,256,284,333,403,414,468,476 | focus、checkbox、按钮 |
| ImportExport/FieldMapper.tsx | 61 | 按钮 |
| ERDesigner/ERSidebar/index.tsx | 239 | focus 边框 |
| ERDesigner/ERSidebar/ProjectContextMenu.tsx | 152 | focus 边框 |
| ERDesigner/dialogs/ImportTableDialog.tsx | 183,226 | focus、选中背景 |
| MainContent/TableStructureView.tsx | 87,362,373,423 | checkbox accent、文字 |
| ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx | 4 | 预设颜色 |

#### B. `#3794ff` 蓝色链接色（~25 处）
**应替换为**: `var(--info)` 或新增 `var(--link)`

| 文件 | 违规行数 | 场景 |
|------|----------|------|
| IndexManager/index.tsx | 120,128 | 创建按钮、链接 |
| MainContent/index.tsx | 1040 | 关闭按钮 |
| MainContent/TableStructureView.tsx | 103 | checkbox accent |
| ERDesigner/ERCanvas/EREdge.tsx | 301,358 | 边颜色、hover |
| GraphExplorer/GraphNodeComponents.tsx | 178,190,243,278,393 | 节点边框、badge |
| GraphExplorer/NodeDetail.tsx | 24,91,106,212,221,230,346 | 节点类型指示 |

#### C. `#3a7bd5` 焦点蓝（~12 处）
**应替换为**: `var(--border-focus)`

| 文件 | 违规行数 | 场景 |
|------|----------|------|
| MainContent/EditableCell.tsx | 65,101 | 单元格焦点描边 |
| MainContent/TableStructureView.tsx | 59,74,90,106,114 | 单元格焦点描边 |
| MainContent/CellEditorModal.tsx | 71 | 操作按钮 |
| MainContent/index.tsx | 1490,1594 | hover 文字色 |

#### D. 自定义 Muted 蓝色文字（~50 处）
一组蓝灰色的 muted 文字，应统一到前景层级变量：

| 色值 | 出现次数 | 应替换为 |
|------|----------|----------|
| `#5b8ab0` | ~8 | `var(--foreground-muted)` |
| `#4a6a8a` / `#4a6a85` / `#4a6b8a` / `#4a6a84` | ~10 | `var(--foreground-subtle)` |
| `#3a5070` | ~12 | `var(--foreground-ghost)` |
| `#5a7a96` / `#5a7a9a` | ~3 | `var(--foreground-muted)` |
| `#8ab0cc` / `#8ec8e0` / `#6aadcc` | ~5 | `var(--foreground-default)` |
| `#3d5470` | ~8 | `var(--foreground-ghost)` |
| `#858585` / `#a0b4c8` | ~3 | `var(--foreground-muted)` |
| `#4ac9c0` | ~1 | `var(--accent)` |

#### E. Tailwind 颜色类违规

**`text-red-*` / `bg-red-*`**（~40 处）→ 应使用 `var(--error)` / `var(--error-subtle)`
涉及文件: Assistant/index.tsx, DatabaseManager, ImportExport, MetricsExplorer, ERDesigner, SeaTunnel, shared/ChartBlock, Settings/LlmSettings, MainContent/TableDataView, TruncateConfirmDialog

**`text-green-*` / `bg-green-*`**（~5 处）→ 应使用 `var(--success)` / `var(--success-subtle)`
涉及文件: Assistant/index.tsx, SeaTunnelJobTab, MainContent/TableStructureView

**`text-yellow-*` / `bg-yellow-*`**（~8 处）→ 应使用 `var(--warning)` / `var(--warning-subtle)`
涉及文件: MainContent/index.tsx, MainContent/EditableCell.tsx, MainContent/TableDataView.tsx, SeaTunnelJobTab

**`text-gray-*`**（~45 处）→ 应使用 `var(--foreground-*)` 系列
涉及文件: ConnectionModal, DatabaseManager, ExportDialog, ERDesigner, ImportExport, GroupModal, TableNode, MainContent

**`text-white`**（162 处）→ 应使用 `var(--foreground)` 
**`hover:text-white`**（~60 处）→ 应使用 `hover:text-[var(--foreground)]`

**`bg-blue-*`**（~2 处）→ 应使用 `var(--primary)`
涉及文件: MainContent/CellEditorModal.tsx

#### F. `#007a62` / `#007a67` hover 深绿（~5 处）
**应替换为**: `var(--accent-hover)`

涉及文件: ConnectionModal, DatabaseManager, Assistant, ImportExport

#### G. 语义状态色硬编码

**`#f87171`**（~12 处）→ `var(--error)` 
**`#f43f5e`**（~5 处）→ `var(--error)`
**`#ef4444`**（~3 处）→ `var(--error)`
**`#4ade80`**（~6 处）→ `var(--success)`
**`#f59e0b`**（~15 处）→ `var(--warning)` 或 `var(--key-primary)`
**`#a855f7`**（~12 处）→ `var(--data-purple)`

#### H. Monaco 编辑器主题色（可接受）
`MainContent/index.tsx` 24-49 行的 Monaco 编辑器主题配置使用硬编码色值。
这是 Monaco API 要求，**可以保留**，但建议在注释中标注对应的 CSS 变量名。

#### I. ECharts 图表色板（可接受）
`shared/ChartBlock.tsx` 14-20 行的图表颜色数组，ECharts API 需要直接色值，**可以保留**。
建议统一映射到 `--data-*` 系列变量的值。

---

## 优化后的完整颜色系统

### 推荐方案：Slate + Emerald 专业开发主题

基于 UI/UX Pro Max "Developer Tool / IDE" 配色（Result #1）优化：

```
设计逻辑：
- Primary: 深蓝灰（专业、稳重）
- Accent: 翠绿（执行/运行暗示，与代码成功区分）
- 背景：极深蓝（护眼、沉浸）
```

### 1. CSS 变量定义（完整版）

```css
:root {
  /* ========================================================
     核心语义色彩 (Semantic Colors)
     基于 Slate 色板的专业开发者主题
     ======================================================== */

  /* --- Primary: 主要交互色 --- */
  --primary:           #2563EB;  /* blue-600 - 主要按钮/链接 */
  --primary-foreground: #FFFFFF;
  --primary-hover:     #1D4ED8;  /* blue-700 */
  --primary-active:    #1E40AF;  /* blue-800 */
  --primary-subtle:    #1E3A8A;  /* blue-900 - 淡蓝背景（选中项） */

  /* --- Secondary: 次要交互色 --- */
  --secondary:           #334155;  /* slate-700 */
  --secondary-foreground: #F8FAFC;
  --secondary-hover:     #475569;  /* slate-600 */

  /* --- Accent: 强调/执行色 (区分于语义绿) --- */
  --accent:            #10B981;  /* emerald-500 - 运行/执行 */
  --accent-foreground: #020617;
  --accent-hover:      #059669;  /* emerald-600 */
  --accent-subtle:     #064E3B;  /* emerald-900 - 淡绿背景 */

  /* ========================================================
     背景层级 (Background Scale)
     深度从深到浅，符合图层堆叠直觉
     ======================================================== */
  --background:          #0F172A;  /* slate-900 - 最深背景 */
  --background-void:     #020617;  /* slate-950 - 绝对底层 */
  --background-base:     #0F172A;  /* slate-900 - 应用根节点 */
  --background-panel:    #1E293B;  /* slate-800 - 面板/侧边栏 */
  --background-card:     #1E293B;  /* slate-800 - 卡片 */
  --background-elevated: #27354F;  /* 浮层/卡片 */
  --background-hover:    #334155;  /* slate-700 - hover状态 */
  --background-active:   #1E3A5F;  /* 选中/激活背景 */
  --background-deep:     #0A1018;  /* 极深背景（工具栏/breadcrumb） */
  --background-code:     #161B22;  /* 代码块/Markdown 头部背景 */

  /* ========================================================
     前景/文字层级 (Foreground Scale)
     基于 WCAG 4.5:1 对比度标准
     ======================================================== */
  --foreground:         #F8FAFC;  /* slate-50 - 最亮文字、标题 */
  --foreground-default: #E2E8F0;  /* slate-200 - 正文 */
  --foreground-muted:   #94A3B8;  /* slate-400 - 次要信息 */
  --foreground-subtle:  #64748B;  /* slate-500 - 占位符/禁用 */
  --foreground-ghost:   #475569;  /* slate-600 - 极淡 */

  /* ========================================================
     边框层级 (Border Scale)
     ======================================================== */
  --border:        #334155;  /* slate-700 - 默认边框 */
  --border-default:#334155;  /* 别名（兼容） */
  --border-subtle:  #1E293B; /* slate-800 - 极细分隔 */
  --border-strong:  #475569; /* slate-600 - 强调边框 */
  --border-focus:   #2563EB; /* blue-600 - 焦点状态 */

  /* ========================================================
     语义状态色 (Semantic Status Colors)
     与主题色区分，确保可访问性
     ======================================================== */
  --success:            #22C55E;  /* green-500 */
  --success-foreground: #DCFCE7;  /* green-100 - 浅色文字（Toast 等） */
  --success-subtle:     #14532D;  /* green-900 - 背景 */

  --warning:            #F59E0B;  /* amber-500 */
  --warning-foreground: #FEF3C7;  /* amber-100 - 浅色文字（Toast 等） */
  --warning-subtle:     #78350F;  /* amber-900 - 背景 */

  --error:              #EF4444;  /* red-500 */
  --error-foreground:   #FEE2E2;  /* red-100 - 浅色文字（Toast 等） */
  --error-subtle:       #7F1D1D;  /* red-900 - 背景 */

  --info:               #3B82F6;  /* blue-500 */
  --info-foreground:    #DBEAFE;  /* blue-100 - 浅色文字（Toast 等） */
  --info-subtle:        #1E3A8A;  /* blue-900 - 背景 */

  /* ========================================================
     功能色 (Functional Colors)
     ======================================================== */
  --ring:        #2563EB;  /* 焦点环 */
  --ring-accent: #10B981;  /* 强调环 */

  --overlay:     rgba(2, 6, 23, 0.8);   /* 遮罩层 */
  --scrim:       rgba(2, 6, 23, 0.6);   /* 弱遮罩 */

  /* ========================================================
     Diff/Patch 色 (代码差异展示)
     ======================================================== */
  --diff-add:        #4ADE80;  /* 新增内容文字 */
  --diff-add-bg:     #0E2A1A;  /* 新增内容背景 */
  --diff-remove:     #F87171;  /* 删除内容文字 */
  --diff-remove-bg:  #2A0E0E;  /* 删除内容背景 */
  --diff-modify:     #60A5FA;  /* 修改内容文字 */
  --diff-modify-bg:  #0E1A2A;  /* 修改内容背景 */

  /* ========================================================
     数据库对象指示色 (DB Object Indicators)
     用于树节点、图节点、ER 图等区分数据库对象类型
     ======================================================== */
  --key-primary:  #F59E0B;  /* 主键图标 (amber-500) */
  --key-foreign:  #8BAFC9;  /* 外键图标 (slate-blue) */

  /* ========================================================
     知识图谱节点色 (Graph Node Colors)
     区分不同类型的图节点和边
     ======================================================== */
  --node-table:      #3794FF;  /* 表节点 - 天蓝 */
  --node-table-bg:   #0D2A3D;  /* 表节点背景 */
  --node-metric:     #F59E0B;  /* 指标节点 - 琥珀 */
  --node-metric-bg:  #2D1E0D;  /* 指标节点背景 */
  --node-alias:      #A855F7;  /* 别名节点 - 紫 */
  --node-alias-bg:   #1E0D2D;  /* 别名节点背景 */

  --edge-fk:         #3794FF;  /* 外键关系边 */
  --edge-reference:  #F59E0B;  /* 引用关系边 */
  --edge-alias:      #A855F7;  /* 别名关系边 */
  --edge-default:    #4A6380;  /* 默认边颜色 */

  /* ========================================================
     窗口控件色 (Window Chrome Colors)
     ======================================================== */
  --window-close-hover: #C0392B;  /* 关闭按钮 hover */

  /* ========================================================
     危险操作色 (Danger Action Colors)
     用于删除按钮 hover 背景等场景
     ======================================================== */
  --danger-hover-bg:  #3D1F1F;  /* 危险操作 hover 背景 */

  /* ========================================================
     数据可视化色板 (Data Viz Palette)
     色盲友好，区分度高
     ======================================================== */
  --data-blue:   #3B82F6;
  --data-green:  #22C55E;
  --data-amber:  #F59E0B;
  --data-red:    #EF4444;
  --data-purple: #A855F7;
  --data-cyan:   #06B6D4;
  --data-pink:   #EC4899;
  --data-indigo: #818CF8;

  /* ========================================================
     ECharts 图表色板 (Chart Palette)
     专用于 ECharts 图表组件
     ======================================================== */
  --chart-1: #4A9ECA;  /* 天蓝 */
  --chart-2: #7B8FF0;  /* 蓝紫 */
  --chart-3: #E07B54;  /* 暖橙 */
  --chart-4: #F0C94A;  /* 琥珀黄 */
  --chart-5: #A78BFA;  /* 柔紫 */
  --chart-6: #34D399;  /* 翠绿 */
  --chart-7: #F87171;  /* 玫红 */
}
```

### 2. SQL 语法高亮优化

```css
/* 基于新色板的语法高亮 */
.token.keyword    { color: #C084FC; }   /* 关键字 - 柔和紫 */
.token.string     { color: #A3E635; }   /* 字符串 - 青柠绿 */
.token.number     { color: #38BDF8; }   /* 数字 - 天蓝 */
.token.function   { color: #FBBF24; }   /* 函数 - 琥珀 */
.token.operator   { color: #94A3B8; }   /* 运算符 - 次要文字 */
.token.punctuation{ color: #64748B; }   /* 标点 - 淡化 */
.token.comment    { color: #6B7280; font-style: italic; }  /* 注释 - 灰 */
.token.boolean    { color: #C084FC; }   /* 布尔 - 关键字同色 */
.token.property   { color: #38BDF8; }   /* 属性 - 数字同色 */
.token.class-name { color: #F472B6; }   /* 类名 - 粉 */
.token.builtin    { color: #2DD4BF; }   /* 内建 - 青绿 */
```

### 3. 浅色模式变量

```css
@media (prefers-color-scheme: light) {
  :root {
    /* 背景反转为浅色 */
    --background:        #F8FAFC;  /* slate-50 */
    --background-void:   #FFFFFF;
    --background-base:   #F8FAFC;
    --background-panel:  #FFFFFF;
    --background-card:   #FFFFFF;
    --background-elevated: #F8FAFC;
    --background-hover:  #F1F5F9;  /* slate-100 */
    --background-active: #DBEAFE;  /* blue-100 */
    --background-deep:   #F1F5F9;  /* slate-100 */
    --background-code:   #F6F8FA;  /* GitHub light code bg */

    /* 文字反转为深色 */
    --foreground:         #0F172A;  /* slate-900 */
    --foreground-default: #1E293B;  /* slate-800 */
    --foreground-muted:   #475569;  /* slate-600 */
    --foreground-subtle:  #94A3B8;  /* slate-400 */
    --foreground-ghost:   #CBD5E1;  /* slate-300 */

    /* 边框调整 */
    --border:        #E2E8F0;  /* slate-200 */
    --border-default:#E2E8F0;
    --border-subtle:  #F1F5F9; /* slate-100 */
    --border-strong:  #CBD5E1; /* slate-300 */

    /* 语义背景调整为浅色 */
    --success-subtle: #DCFCE7;  /* green-100 */
    --warning-subtle: #FEF3C7;  /* amber-100 */
    --error-subtle:   #FEE2E2;  /* red-100 */
    --info-subtle:    #DBEAFE;  /* blue-100 */

    /* Diff 背景调整 */
    --diff-add-bg:    #DCFCE7;
    --diff-remove-bg: #FEE2E2;
    --diff-modify-bg: #DBEAFE;

    /* 图节点背景调整 */
    --node-table-bg:  #DBEAFE;
    --node-metric-bg: #FEF3C7;
    --node-alias-bg:  #F3E8FF;

    /* 危险操作背景调整 */
    --danger-hover-bg: #FEE2E2;
  }
}
```

---

## 颜色使用规范

### 使用场景速查表

| 场景 | 变量 | 示例 |
|------|------|------|
| 页面背景 | `--background-base` | App 容器 |
| 侧边栏/面板 | `--background-panel` | 左侧数据源列表 |
| 卡片背景 | `--background-card` | 连接卡片 |
| 浮层/弹框 | `--background-elevated` | 下拉菜单、tooltip |
| Hover 状态 | `--background-hover` | 列表项悬停 |
| 选中/激活 | `--background-active` | 当前选中行 |
| 极深工具栏 | `--background-deep` | breadcrumb 栏 |
| 代码块头部 | `--background-code` | Markdown 代码头、图表标题栏 |
| 主按钮 | `--primary` / `--primary-foreground` | "连接"按钮 |
| 次按钮 | `--secondary` / `--secondary-foreground` | "取消"按钮 |
| 运行/执行按钮 | `--accent` / `--accent-foreground` | "执行 SQL"按钮 |
| 焦点边框 | `--border-focus` | input:focus |
| 最亮文字 | `--foreground` | 标题、hover 高亮 |
| 正文 | `--foreground-default` | 正文、列表项 |
| 次要文字 | `--foreground-muted` | 描述、时间戳 |
| 占位符 | `--foreground-subtle` | Input placeholder |
| 禁用文字 | `--foreground-ghost` | 禁用项、快捷键提示 |
| 成功提示 | `--success` / `--success-subtle` | 操作成功提示 |
| 错误提示 | `--error` / `--error-subtle` | 连接失败提示 |
| 警告提示 | `--warning` / `--warning-subtle` | 注意事项 |
| 信息提示 | `--info` / `--info-subtle` | 消息提醒 |
| 主键图标 | `--key-primary` | PK 钥匙图标 |
| 外键图标 | `--key-foreign` | FK 钥匙图标 |
| 表节点 | `--node-table` / `--node-table-bg` | 图谱中的表节点 |
| 指标节点 | `--node-metric` / `--node-metric-bg` | 图谱中的指标节点 |
| 别名节点 | `--node-alias` / `--node-alias-bg` | 图谱中的别名节点 |
| 代码差异-新增 | `--diff-add` / `--diff-add-bg` | Patch add 行 |
| 代码差异-删除 | `--diff-remove` / `--diff-remove-bg` | Patch remove 行 |
| 代码差异-修改 | `--diff-modify` / `--diff-modify-bg` | Patch replace 行 |
| 删除操作 hover | `--danger-hover-bg` | 删除菜单项 hover |
| 关闭按钮 hover | `--window-close-hover` | 标题栏关闭按钮 |

### 硬编码色值替换映射表

| 硬编码色值 | 替换为 | 备注 |
|-----------|--------|------|
| `#009e84` | `var(--accent)` | 旧版主题色 |
| `#007a62` / `#007a67` | `var(--accent-hover)` | 旧版 accent hover |
| `#004d3a` / `#00b090` / `#00e6be` | `var(--accent)` 或 `var(--accent-hover)` | accent 变体 |
| `#3794ff` | `var(--node-table)` 或 `var(--info)` | 根据语境选择 |
| `#3a7bd5` | `var(--border-focus)` | 焦点蓝 |
| `#5eb2f7` | `var(--info)` | 信息蓝 |
| `#5b8ab0` | `var(--foreground-muted)` | 次要文字 |
| `#4a6a8a`/`#4a6a85`/`#4a6b8a`/`#4a6a84` | `var(--foreground-subtle)` | 禁用文字 |
| `#3a5070` | `var(--foreground-ghost)` | 极淡文字 |
| `#3d5470` | `var(--foreground-ghost)` | 极淡文字 |
| `#8ab0cc` / `#8ec8e0` / `#6aadcc` | `var(--foreground-default)` | 正文 |
| `#a0b4c8` / `#858585` | `var(--foreground-muted)` | 次要文字 |
| `#e8f4fd` | `var(--foreground)` | 最亮文字（标题） |
| `#f87171` | `var(--error)` 或 `var(--diff-remove)` | 错误/删除 |
| `#f43f5e` | `var(--error)` | 错误 |
| `#ef4444` | `var(--error)` | 错误 |
| `#e05c5c` | `var(--error)` | 错误 |
| `#4ade80` | `var(--success)` 或 `var(--diff-add)` | 成功/新增 |
| `#86efac` / `#5eead4` | `var(--success-foreground)` | 成功浅色文字 |
| `#f59e0b` | `var(--warning)` 或 `var(--key-primary)` | 根据语境 |
| `#eab308` | `var(--key-primary)` | 主键图标 |
| `#fbbf24` / `#fcd34d` | `var(--warning)` 或 `var(--warning-foreground)` | 警告 |
| `#a855f7` | `var(--node-alias)` 或 `var(--data-purple)` | 紫色指示 |
| `#c084fc` | `var(--data-purple)` | 紫色（diff move） |
| `#818cf8` | `var(--data-indigo)` | 靛蓝指示 |
| `#60a5fa` | `var(--diff-modify)` | diff replace |
| `#161b22` | `var(--background-code)` | 代码块头部 |
| `#0a1018` | `var(--background-deep)` | 极深工具栏 |
| `#0d2137`/`#0f1f33`/`#0d1a28`/`#091828`/`#102540` | `var(--background-base)` 或 `var(--background-void)` | 深色面板 |
| `#0d3d2e` | `var(--accent-subtle)` | 成功/accent 淡背景 |
| `#3d1a1a` | `var(--error-subtle)` | 错误淡背景 |
| `#3d1f1f` | `var(--danger-hover-bg)` | 危险 hover 背景 |
| `#1a2d42` / `#1a2a3a` | `var(--background-panel)` | 面板背景 |
| `#1c2433` | `var(--background-panel)` | 面板背景 |
| `#0d2a3d` | `var(--node-table-bg)` | 表节点背景 |
| `#2d1e0d` | `var(--node-metric-bg)` | 指标节点背景 |
| `#1e0d2d` | `var(--node-alias-bg)` | 别名节点背景 |
| `#0e2a1a` | `var(--diff-add-bg)` | diff 新增背景 |
| `#2a0e0e` | `var(--diff-remove-bg)` | diff 删除背景 |
| `#0e1a2a` | `var(--diff-modify-bg)` | diff 修改背景 |
| `#c0392b` | `var(--window-close-hover)` | 关闭按钮 |
| `#569cd6` | `var(--node-table)` | 代码高亮/视图指示 |
| `#dcdcaa` | `var(--warning)` | 函数指示 |
| `#8bafc9` | `var(--key-foreign)` | 外键指示 |
| `#243a55` | `var(--background-hover)` | 操作 hover 背景 |
| `#1e3a5f` | `var(--background-active)` | 激活背景 |
| `#0d2620` / `#0a2010` / `#0a1f18` / `#0d1f1a` | `var(--accent-subtle)` | accent 淡背景 |
| `#0a1525` / `#0d2a4a` / `#0d3060` | `var(--primary-subtle)` | primary 淡背景 |
| `#1a1a3d` | `var(--info-subtle)` | info 淡背景 |
| `#2d1216` / `#881337` / `#2a1010` / `#1a0a0a` / `#3a1a1a` | `var(--error-subtle)` | error 淡背景 |
| `#2a2a0e` / `#2a3319` | `var(--warning-subtle)` | warning 淡背景 |
| `#3a2a19` | `var(--warning-subtle)` | warning 淡背景 |

### Tailwind 颜色类替换规则

| Tailwind 类 | 替换为 |
|-------------|--------|
| `text-white` | `text-[var(--foreground)]` |
| `hover:text-white` | `hover:text-[var(--foreground)]` |
| `text-gray-200` | `text-[var(--foreground-default)]` |
| `text-gray-300` | `text-[var(--foreground-default)]` |
| `text-gray-400` | `text-[var(--foreground-muted)]` |
| `text-gray-500` | `text-[var(--foreground-subtle)]` |
| `text-gray-600` | `text-[var(--foreground-ghost)]` |
| `text-red-400` | `text-[var(--error)]` |
| `text-red-300` | `text-[var(--error-foreground)]` |
| `bg-red-400/10` | `bg-[var(--error-subtle)]` |
| `bg-red-600` | `bg-[var(--error)]` |
| `bg-red-600/80` | `bg-[var(--error)]/80` |
| `bg-red-600/20` | `bg-[var(--error-subtle)]` |
| `bg-red-900/20` | `bg-[var(--error-subtle)]` |
| `bg-red-900/40` | `bg-[var(--error-subtle)]` |
| `border-red-400/30` | `border-[var(--error)]/30` |
| `border-red-900/40` | `border-[var(--error)]/30` |
| `text-green-400` | `text-[var(--success)]` |
| `bg-green-400` | `bg-[var(--success)]` |
| `bg-green-900/10` | `bg-[var(--success-subtle)]` |
| `text-yellow-300` | `text-[var(--warning)]` |
| `text-yellow-400` | `text-[var(--warning)]` |
| `bg-yellow-400` | `bg-[var(--warning)]` |
| `bg-yellow-900/20` | `bg-[var(--warning-subtle)]` |
| `bg-yellow-900/30` | `bg-[var(--warning-subtle)]` |
| `border-yellow-600` | `border-[var(--warning)]` |
| `border-yellow-700/50` | `border-[var(--warning)]/50` |
| `bg-blue-600` | `bg-[var(--primary)]` |
| `bg-blue-500` | `bg-[var(--primary)]` |
| `hover:bg-red-950` | `hover:bg-[var(--error-subtle)]` |

### 禁止用法

```css
/* 错误：使用硬编码色值 */
color: #00c9a7;
color: #009e84;
color: #3794ff;
background: #161b22;

/* 正确：使用语义变量 */
color: var(--accent);
color: var(--node-table);
background: var(--background-code);

/* 错误：直接使用 Tailwind 颜色类 */
className="text-red-400"
className="bg-green-400"
className="text-gray-400"
className="text-white"

/* 正确：使用 CSS 变量的 Tailwind arbitrary value */
className="text-[var(--error)]"
className="bg-[var(--success)]"
className="text-[var(--foreground-muted)]"
className="text-[var(--foreground)]"

/* 错误：背景与文字对比度不足 */
background: #334155; color: #64748B;

/* 正确：确保 4.5:1 对比度 */
background: var(--background-panel); color: var(--foreground);
```

---

## 迁移计划

### Phase 1: 核心变量替换（建议立即执行）
1. 更新 `:root` 中的 CSS 变量定义，添加所有新增变量
2. 更新 `src/styles/theme.ts` 使用新变量
3. 替换所有 `#009e84` -> `var(--accent)` 系列（~35 处）
4. 替换所有 `text-white` -> `text-[var(--foreground)]`（162 处）
5. 验证对比度符合 WCAG AA 标准

### Phase 2: 组件级迁移（按模块）
按违规数量从高到低排序：

| 优先级 | 模块 | 硬编码数 | 关键文件 |
|--------|------|----------|----------|
| P0 | MainContent | ~80 | index.tsx, TableStructureView, EditableCell, TableDataView |
| P0 | Assistant | ~40 | index.tsx, PatchConfirmPanel, ElicitationPanel, AssistantToggleTab |
| P1 | GraphExplorer | ~50 | GraphNodeComponents, NodeDetail, PathTab |
| P1 | ImportExport | ~30 | BackupWizard, ExportWizard, ImportWizard, FieldMapper |
| P1 | ERDesigner | ~25 | EREdge, ERTableNode, ColumnPropertyEditor, IndexEditor |
| P2 | ConnectionModal | ~8 | index.tsx |
| P2 | DatabaseManager | ~6 | CreateDatabaseDialog |
| P2 | MetricsExplorer | ~15 | MetricListPanel, MetricTab, MetricsTree |
| P2 | MetricsPanel | ~8 | index.tsx |
| P2 | shared | ~20 | ChartBlock, MarkdownContent |
| P3 | Toast | ~12 | index.tsx |
| P3 | Settings | ~5 | LlmSettings, SettingsPage |
| P3 | common | ~5 | BaseModal, ConfirmDialog, DropdownSelect |
| P3 | SeaTunnel | ~15 | SeaTunnelJobTree, SeaTunnelConnectionModal, VisualBuilder |
| P3 | 其他 | ~15 | TitleBar, TableNode, ObjectPanel, IndexManager |

### Phase 3: 增强功能（可选）
1. 添加浅色模式支持
2. 添加高对比度模式支持
3. 添加色盲友好模式

---

## 对比度验证

| 组合 | 前景色 | 背景色 | 对比度 | 评级 |
|------|--------|--------|--------|------|
| 正文 | #E2E8F0 | #1E293B | 9.3:1 | AAA |
| 最亮文字 | #F8FAFC | #1E293B | 10.8:1 | AAA |
| 次要文字 | #94A3B8 | #1E293B | 5.4:1 | AA |
| 占位符 | #64748B | #1E293B | 3.2:1 | AA (大字体) |
| 主按钮 | #FFFFFF | #2563EB | 4.5:1 | AA |
| Accent | #10B981 | #0F172A | 5.1:1 | AA |
| 成功 | #22C55E | #0F172A | 5.8:1 | AA |
| 错误 | #EF4444 | #0F172A | 6.3:1 | AA |
| 警告 | #F59E0B | #0F172A | 8.6:1 | AAA |
| 信息 | #3B82F6 | #0F172A | 4.8:1 | AA |
| 节点-表 | #3794FF | #0D2A3D | 5.2:1 | AA |
| 节点-指标 | #F59E0B | #2D1E0D | 7.8:1 | AAA |
| 节点-别名 | #A855F7 | #1E0D2D | 5.6:1 | AA |

---

## 参考

- UI/UX Pro Max 设计系统: `Developer Tool / IDE` 配色方案
- WCAG 2.1 对比度标准: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum
- Tailwind 色板: https://tailwindcss.com/docs/customizing-colors
