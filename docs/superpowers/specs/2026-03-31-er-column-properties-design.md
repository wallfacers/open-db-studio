# ER 设计器字段属性完整编辑系统

**日期**: 2026-03-31
**状态**: 已批准

## 目标

为 ER 设计器补齐字段级、表级、索引级属性的完整编辑能力，实现三层 UI 策略：画布紧凑显示、侧边栏全量编辑、右侧抽屉面板深度编辑。

## 背景

当前 ErColumn 模型已有 nullable、default_value、comment 字段但无 UI 编辑入口。缺少 length/scale/unique 等专业 ER 设计器必备属性。数据类型硬编码 12 种，无方言区分。ErIndex 模型完整但完全无 UI。

## 架构决策

**方案 B：模块化重构** — 抽取共享模块，三层 UI 复用同一套编辑原语。

理由：侧边栏全量编辑 + 混合模式抽屉需要大量重复编辑逻辑（nullable 切换、类型+长度选择、默认值输入等），抽共享组件一次编写三层一致。

---

## 1. 数据模型扩展

### ErColumn 新增字段

```typescript
interface ErColumn {
  // 现有字段（不变）
  id: number
  table_id: number
  name: string
  data_type: string
  nullable: boolean
  default_value: string | null
  is_primary_key: boolean
  is_auto_increment: boolean
  comment: string | null
  sort_order: number
  created_at: string
  updated_at: string

  // 新增字段
  length: number | null         // VARCHAR(255) 的 255
  scale: number | null          // DECIMAL(10,2) 的 2
  is_unique: boolean            // UNIQUE 约束
  unsigned: boolean             // MySQL UNSIGNED
  charset: string | null        // 字段级字符集
  collation: string | null      // 字段级排序规则
  on_update: string | null      // ON UPDATE CURRENT_TIMESTAMP
  enum_values: string[] | null  // ENUM('a','b','c') 的值列表
}
```

### ErTable / ErIndex 不变

ErTable 的 comment、color 已在模型中，只需加 UI。ErIndex 已有 id、table_id、name、type、columns、created_at，够用。

### 新增列默认值

```typescript
{
  length: null, scale: null, is_unique: false,
  unsigned: false, charset: null, collation: null,
  on_update: null, enum_values: null
}
```

---

## 2. 数据类型注册表

### 文件位置

`src/components/ERDesigner/shared/dataTypes.ts`

### 核心结构

```typescript
interface DataTypeDefinition {
  name: string
  category: 'numeric' | 'string' | 'datetime' | 'binary' | 'json' | 'spatial' | 'other'
  hasLength: boolean
  hasScale: boolean
  hasUnsigned: boolean
  hasEnumValues: boolean
  defaultLength: number | null
  defaultScale: number | null
}

interface DialectTypeRegistry {
  dialect: string  // 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite'
  types: DataTypeDefinition[]
}
```

### 方言覆盖

| 方言 | 特有类型举例 |
|------|------------|
| MySQL | TINYINT, MEDIUMINT, ENUM, SET, MEDIUMTEXT, LONGTEXT, UNSIGNED 支持 |
| PostgreSQL | SERIAL, BIGSERIAL, JSONB, UUID, MONEY |
| Oracle | NUMBER, VARCHAR2, CLOB, NVARCHAR2 |
| SQL Server | NVARCHAR, NTEXT, UNIQUEIDENTIFIER, MONEY, BIT |
| SQLite | INTEGER, REAL, TEXT, BLOB |

### 未绑定连接

类型下拉展示所有方言的并集，按 category 分组。

### 绑定连接后

类型下拉只展示绑定方言的类型列表。已有字段如果用了不兼容类型，显示黄色 ⚠ 图标，hover tooltip 提示建议替代类型。不阻止操作，只做提示。

### 工具函数

`formatTypeDisplay(column)` — 拼接类型显示文本：
- 有 length 无 scale → `VARCHAR(255)`
- 有 length 有 scale → `DECIMAL(10,2)`
- 无 length → `INT`

---

## 3. 共享组件体系

### 文件结构

```
src/components/ERDesigner/shared/
├── dataTypes.ts                 // 类型注册表
├── TypeLengthDisplay.tsx        // 类型+长度 展示/编辑
├── ColumnPropertyEditor.tsx     // 字段属性编辑器（核心复用组件）
├── IndexEditor.tsx              // 索引编辑器
└── CompatibilityWarning.tsx     // 方言兼容性警告图标
```

### TypeLengthDisplay

- **display 模式**（画布用）：只读渲染 `VARCHAR(255)` 文本
- **edit 模式**（侧边栏/抽屉用）：类型下拉 + 长度输入 + 精度输入，按 DataTypeDefinition 动态显示隐藏

选择类型时，如果新类型的 hasLength 与旧类型不同，自动填入 defaultLength 或清空。

### ColumnPropertyEditor

通过 `mode` prop 控制密度：

**mode="compact"**（侧边栏/抽屉折叠行）：

```
🔑⚡ │ name │ VARCHAR(255) ▾ │ ☑NN │ ☑UQ │ default │ 📝 │ ⋮
```

PK 图标、AI 图标、字段名、类型(长度)、NOT NULL 复选、UNIQUE 复选、默认值简要、注释图标（有注释时高亮）、更多操作菜单。

**mode="full"**（抽屉展开行）：

```
字段名: [name        ]
类型:   [VARCHAR ▾] 长度: [255]
☑ NOT NULL   ☐ UNIQUE   ☐ UNSIGNED
默认值: [____________]
字符集: [_______ ▾]  排序: [_______ ▾]
ON UPDATE: [________________]
注释:   [________________________]
                         [收起 ▴]
```

### IndexEditor

索引列表 + 展开编辑。折叠行显示索引名、类型、包含列、删除按钮。展开后编辑索引名、类型下拉（INDEX/UNIQUE/FULLTEXT）、checkbox 勾选列（每列可选 ASC/DESC）。新建时索引名自动生成 `idx_<表名>_<首列名>`。

### CompatibilityWarning

接收字段类型和绑定方言，查注册表判断兼容性，不兼容时渲染 ⚠ 图标 + tooltip。

---

## 4. 画布节点增强

### 改动范围

仅 `ERTableNode.tsx`，改动极小。

### 变化

类型显示从 `VARCHAR` 变为 `VARCHAR(255)`。下拉选项从硬编码数组改为引用类型注册表。

### 不做的事

不加 NOT NULL、UNIQUE、DEFAULT 等标记。不改变节点布局结构和交互方式。节点宽度保持 `w-[360px]`。

---

## 5. 侧边栏全量编辑改造

### 改造为 DataGrip 式紧凑表格

表头行：

```
列名 │ 类型 │ NN │ UQ │ 默认值 │ 注释 │ ⋮
```

表头 `text-[#4a6480]` `text-[11px]`，不可点击。

数据行使用 `ColumnPropertyEditor mode="compact"`，行高 `h-[24px]`，hover `bg-[#1a2639]`，选中行 `bg-[#003d2f]`。

### 各列宽度

| 列 | 宽度 | 交互 |
|---|------|------|
| 列名 | flex 自适应 | 双击内联编辑，前缀 PK/AI 图标 |
| 类型 | ~130px | 点击弹出类型下拉（含长度/精度） |
| NN | 28px | checkbox |
| UQ | 28px | checkbox |
| 默认值 | ~80px | 双击内联编辑 |
| 注释 | ~60px | 双击内联编辑 |
| ⋮ | 24px | 菜单（删除、上移、下移、打开抽屉） |

### 响应式

侧边栏拖窄时：注释列先隐藏 → 默认值列再隐藏 → 最小保留列名 + 类型 + NN + ⋮。

---

## 6. 右侧抽屉面板

### 组件结构

```
ERPropertyDrawer/
├── index.tsx              // 抽屉容器
├── ColumnsTab.tsx         // 列 Tab
├── IndexesTab.tsx         // 索引 Tab
└── TablePropertiesTab.tsx // 表属性 Tab
```

### 抽屉容器

- 固定宽度 `w-[420px]`，右侧滑入
- 打开时画布区域自动缩窄（flex 布局，非 overlay）
- 背景 `bg-[#111922]`，左边框 `border-l border-[#253347]`
- 标题栏 `bg-[#1a2639]`，显示表名 + 关闭按钮
- Tab 栏默认 `text-[#4a6480]`，选中 `text-[#00c9a7] border-b-2 border-[#00c9a7]`

### 触发方式

| 入口 | 触发 |
|------|------|
| 画布表节点头部编辑图标 | 点击打开 |
| 侧边栏表名旁编辑图标 | 点击打开 |
| 侧边栏列行 ⋮ 菜单 | 「在抽屉中编辑」，打开并定位该列 |

点击另一个表的编辑按钮直接切换内容，不需先关闭。

### 列 Tab

默认紧凑列表（`ColumnPropertyEditor mode="compact"`），点击 ▶ 箭头展开为完整表单（`ColumnPropertyEditor mode="full"`）。从侧边栏 ⋮ 菜单进入时自动展开对应列。

### 索引 Tab

使用 `IndexEditor` 组件。折叠行显示索引概要，展开编辑索引属性和列选择。

### 表属性 Tab

- 表名编辑
- 注释编辑
- 颜色选择器：6 个预设色圆点 + 无色选项
  - 预设色：`#00c9a7`、`#5eb2f7`、`#f59e0b`、`#f43f5e`、`#a855f7`、`#4ade80`
- 数据库选项（绑定连接后显示）：存储引擎、字符集、排序规则

### Store 扩展

```typescript
drawerOpen: boolean
drawerTableId: number | null
openDrawer(tableId: number): void
closeDrawer(): void
```

---

## 7. 方言兼容性检查

### 检查时机

- 绑定连接时：全量扫描
- 切换字段类型时：单字段检查
- DDL 预览时：全量检查，顶部汇总

### Store 扩展

```typescript
dialectWarnings: Record<number, string>  // columnId → 警告信息
boundDialect: string | null
```

### 展示位置

| 位置 | 方式 |
|------|------|
| 侧边栏列行 | ⚠ 图标 + tooltip |
| 抽屉列行 | ⚠ 图标 + tooltip |
| 画布 | 不显示 |
| DDL 预览顶部 | 黄色警告条 |

---

## 8. 主题色约束

所有新组件严格复用项目 Abyss 主题配色，不引入新色值：

| 元素 | 颜色 |
|------|------|
| 按钮 primary | `bg-[#009e84]` hover `bg-[#00c9a7]` |
| 按钮 danger | `bg-red-600/20` text `text-red-400` |
| 下拉容器 | `bg-[#151d28] border-[#2a3f5a]` |
| 下拉项 hover | `bg-[#1e2d42]` |
| 输入框 | `bg-[#151d28] border-[#00c9a7]` text `text-[#b5cfe8]` |
| 面板 | `bg-[#111922] border-[#253347]` |
| 表头 | `bg-[#1a2639]` |
| 行 hover | `bg-[#1a2639]` |
| 选中行 | `bg-[#003d2f]` |
| 强调色 | `text-[#00c9a7]` |
| 警告色 | `#f59e0b` |
| checkbox 选中 | `#00c9a7` |
| 字号 | `text-[13px]`（数据），`text-[11px]`（表头标签） |

---

## 9. Rust 层同步

### SQLite 迁移

`er_columns` 表新增列：

```sql
length        INTEGER,
scale         INTEGER,
is_unique     INTEGER NOT NULL DEFAULT 0,
unsigned      INTEGER NOT NULL DEFAULT 0,
charset       TEXT,
collation     TEXT,
on_update     TEXT,
enum_values   TEXT  -- JSON 数组 '["active","inactive"]'
```

### 向后兼容

启动时检测缺少的列，自动 ALTER TABLE 添加。所有新列有安全默认值，不影响已有数据。`enum_values` 存 JSON 字符串，Rust 层 serde 序列化/反序列化为 `Vec<String>`。

### DDL 生成

利用新字段生成完整 DDL：`VARCHAR(255)`、`DECIMAL(10,2)`、`NOT NULL`、`UNIQUE`、`DEFAULT`、`UNSIGNED`、`COMMENT`、`ENUM()`。

---

## 10. 数据流

```
用户操作（画布/侧边栏/抽屉）
       │
       ▼
  erDesignerStore action
       │
       ├──▶ Rust 层持久化（invoke）
       ▼
  Zustand state 更新
       │
       ├──▶ 画布节点重渲染
       ├──▶ 侧边栏重渲染
       └──▶ 抽屉面板重渲染
```

三层 UI 共享同一 store，任一处编辑通过 action → state → 三处同时响应。
