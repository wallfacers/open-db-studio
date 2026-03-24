# ER 图设计器 — 设计规格文档

> 日期: 2026-03-25
> 状态: Draft

## 1. 概述

在 open-db-studio 中新增独立的 **ER 图设计器**模块，作为 ActivityBar 的一级导航项。支持可视化表结构设计、多方言 DDL 生成、数据库双向 Diff 同步、AI 对话式建模，以及与知识图谱注释标记系统的深度集成。

### 1.1 核心价值

- 可视化设计数据库表结构，降低建模门槛
- 多方言 DDL 生成，一份设计适配多种数据库
- 双向 Diff + 选择性同步，ER 图与真实数据库保持一致
- AI 对话式批量建模，自然语言快速生成完整数据模型
- 注释标记关系管理，适配企业级项目（业务代码维护关系，不依赖外键约束）

### 1.2 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 模块独立性 | 独立 ActivityBar 项 + 独立 Store | 功能复杂度高，避免污染现有模块 |
| 项目组织 | 混合模式（独立项目 + 绑定连接） | 兼顾离线设计和在线同步场景 |
| 持久化 | SQLite 主存储 + JSON 导出 | 统一管理 + 便于分享备份 |
| AI 交互 | 复用现有 Assistant 面板 | 一致的交互体验，减少学习成本 |
| 导入粒度 | 全量 + 选择性导入 | 灵活应对不同场景 |
| Diff 同步 | 双向 + Diff 报告 + 选择性同步 | 最完整的同步能力 |
| DDL 方言 | 先行支持 5 种（含未实现连接的方言） | DDL 生成不依赖实际连接 |
| 关系策略 | 注释标记优先，外键约束可选 | 适配企业级项目性能需求 |

## 2. 整体布局

```
┌─────────────────────────────────────────────────────────────┐
│ TitleBar                                                     │
├────┬──────────┬──────────────────────────────┬───────────────┤
│    │          │ [ER项目A] [ER项目B] [×]      │               │
│ A  │  ER      │──────────────────────────────│   Assistant   │
│ c  │  Sidebar │  工具栏: [+表][布局][DDL]    │   (复用)      │
│ t  │          │  [Diff][同步][导入][导出]     │               │
│ i  │ 📁项目1  │                              │               │
│ v  │  └─users │   ReactFlow 画布             │               │
│ i  │  └─orders│   ┌─────┐    ┌─────┐        │               │
│ t  │ 📁项目2  │   │users │───│orders│        │               │
│ y  │  └─...   │   └─────┘    └─────┘        │               │
│    │          │                              │               │
│ B  │──────────│                              │               │
│ a  │ 🔗绑定   │                              │               │
│ r  │ MySQL-dev│                              │               │
├────┴──────────┴──────────────────────────────┴───────────────┤
│ StatusBar                                                     │
└─────────────────────────────────────────────────────────────┘
```

**关键设计点：**

- ActivityBar 新增"ER 设计器"图标，位于 Database Explorer 之后
- ERSidebar：独立目录树，结构为 `ER项目 → 表 → 列`，底部显示绑定的数据库连接
- Tab 复用现有 Tab 系统，新增 `er_design` TabType，每个 ER 项目打开一个 Tab
- 画布基于 ReactFlow，节点风格参考现有 ERDiagram.tsx
- Assistant 联动：活跃 Tab 为 `er_design` 时自动切换 ER 图上下文

### 2.1 UI 一致性约束

所有组件严格遵循项目 Abyss 深色主题：

| 元素 | 样式 |
|------|------|
| 主题色 | `#00c9a7`（cyan accent） |
| 背景层级 | `#080d12` → `#0d1117` → `#111922` → `#151d28` |
| 下拉弹框 | 复用 `DropdownSelect` 组件（Portal, `z-[200]`, `bg-[#151d28] border-[#2a3f5a]`） |
| 弹窗 | 复用 `BaseModal`（`bg-[#111922] border-[#253347]`） |
| 确认框 | 复用 `ConfirmDialog`（全局 Zustand store） |
| 右键菜单 | 遵循 ContextMenu 样式（`bg-[#0d1117] border-[#1e2d42]`, `px-3 py-1.5 text-xs`） |
| 输入框 | `bg-[#1a2639] border-[#253347]`，focus: `border-[#009e84]` |
| 图标 | 统一 `lucide-react` |
| 浮动层 | `createPortal` 到 `document.body` |

## 3. 数据模型

### 3.1 SQLite 表结构

```sql
-- ER 项目
CREATE TABLE er_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT,
    connection_id   INTEGER NULL,           -- 绑定的数据库连接（NULL=离线项目）
    database_name   TEXT NULL,
    schema_name     TEXT NULL,
    viewport_x      REAL DEFAULT 0,
    viewport_y      REAL DEFAULT 0,
    viewport_zoom   REAL DEFAULT 1,
    created_at      TEXT NOT NULL,           -- ISO 8601
    updated_at      TEXT NOT NULL
);

-- ER 表
CREATE TABLE er_tables (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES er_projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    comment         TEXT,
    position_x      REAL DEFAULT 0,
    position_y      REAL DEFAULT 0,
    color           TEXT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- ER 列
CREATE TABLE er_columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id        INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    data_type       TEXT NOT NULL,
    nullable        INTEGER DEFAULT 1,
    default_value   TEXT NULL,
    is_primary_key  INTEGER DEFAULT 0,
    is_auto_increment INTEGER DEFAULT 0,
    comment         TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- ER 关系
CREATE TABLE er_relations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES er_projects(id) ON DELETE CASCADE,
    name            TEXT NULL,
    source_table_id INTEGER NOT NULL REFERENCES er_tables(id),
    source_column_id INTEGER NOT NULL REFERENCES er_columns(id),
    target_table_id INTEGER NOT NULL REFERENCES er_tables(id),
    target_column_id INTEGER NOT NULL REFERENCES er_columns(id),
    relation_type   TEXT DEFAULT 'one_to_many',
    on_delete       TEXT DEFAULT 'NO ACTION',
    on_update       TEXT DEFAULT 'NO ACTION',
    source          TEXT DEFAULT 'designer',  -- schema / comment / designer
    comment_marker  TEXT NULL,                 -- 原始注释标记文本
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- ER 索引
CREATE TABLE er_indexes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id        INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT DEFAULT 'INDEX',      -- INDEX / UNIQUE / FULLTEXT
    columns         TEXT NOT NULL,             -- JSON array of column_ids
    created_at      TEXT NOT NULL
);
```

### 3.2 JSON 导出格式

```json
{
  "version": "1.0",
  "project": {
    "name": "电商系统",
    "description": "...",
    "tables": [
      {
        "name": "users",
        "comment": "用户表",
        "position": { "x": 100, "y": 200 },
        "columns": [
          {
            "name": "id",
            "data_type": "BIGINT",
            "nullable": false,
            "is_primary_key": true,
            "is_auto_increment": true
          },
          {
            "name": "email",
            "data_type": "VARCHAR(255)",
            "nullable": false
          }
        ],
        "indexes": [
          { "name": "idx_email", "type": "UNIQUE", "columns": ["email"] }
        ]
      }
    ],
    "relations": [
      {
        "name": "fk_order_user",
        "source": { "table": "orders", "column": "user_id" },
        "target": { "table": "users", "column": "id" },
        "type": "one_to_many",
        "on_delete": "CASCADE",
        "source_type": "comment",
        "comment_marker": "@ref:users.id"
      }
    ]
  }
}
```

## 4. Rust 后端

### 4.1 模块结构

```
src-tauri/src/er/
├── mod.rs              -- 模块入口
├── models.rs           -- 数据结构体
├── repository.rs       -- SQLite CRUD
├── ddl_generator.rs    -- 多方言 DDL 生成引擎
├── diff_engine.rs      -- 双向 Diff 对比引擎
├── export.rs           -- JSON 导出/导入
```

### 4.2 Tauri 命令

```
-- 项目 CRUD
er_create_project / er_update_project / er_delete_project / er_list_projects

-- 表 CRUD
er_create_table / er_update_table / er_delete_table

-- 列 CRUD
er_create_column / er_update_column / er_delete_column / er_reorder_columns

-- 关系 CRUD
er_create_relation / er_update_relation / er_delete_relation

-- 索引 CRUD
er_create_index / er_update_index / er_delete_index

-- DDL 生成
er_generate_ddl(project_id, dialect, options)
  options: { include_indexes: bool, include_comments: bool, include_foreign_keys: bool }

-- Diff 与同步
er_diff_with_database(project_id)
er_sync_from_database(project_id, table_names?)
er_sync_to_database(project_id, changes)

-- 导入导出
er_export_json(project_id)
er_import_json(json)
```

### 4.3 DDL 多方言生成引擎

支持方言：MySQL、PostgreSQL、Oracle、SQL Server、SQLite

```rust
trait DdlDialect {
    fn create_table(table, columns, indexes) -> String;
    fn map_type(generic_type: &str) -> String;
    fn primary_key_syntax(columns) -> String;
    fn foreign_key_syntax(relation) -> String;
    fn auto_increment_syntax() -> String;
    fn index_syntax(index) -> String;
    fn comment_syntax(table, column, comment) -> String;
}
```

**类型映射表：**

| 通用类型 | MySQL | PostgreSQL | Oracle | SQL Server | SQLite |
|---------|-------|------------|--------|------------|--------|
| BIGINT | BIGINT | BIGINT | NUMBER(19) | BIGINT | INTEGER |
| VARCHAR(n) | VARCHAR(n) | VARCHAR(n) | VARCHAR2(n) | NVARCHAR(n) | TEXT |
| TEXT | TEXT | TEXT | CLOB | NVARCHAR(MAX) | TEXT |
| DATETIME | DATETIME | TIMESTAMP | TIMESTAMP | DATETIME2 | TEXT |
| BOOLEAN | TINYINT(1) | BOOLEAN | NUMBER(1) | BIT | INTEGER |
| DECIMAL(p,s) | DECIMAL(p,s) | NUMERIC(p,s) | NUMBER(p,s) | DECIMAL(p,s) | REAL |

**DDL 生成默认选项：**

- `include_indexes`: true
- `include_comments`: true（含关系标记）
- `include_foreign_keys`: **false**（企业级默认不生成外键约束）

### 4.4 Diff 引擎

```rust
struct DiffResult {
    added_tables:    Vec<TableDiff>,      // ER 有、数据库没有
    removed_tables:  Vec<TableDiff>,      // 数据库有、ER 没有
    modified_tables: Vec<TableModDiff>,   // 两边都有但有差异
}

struct TableModDiff {
    table_name: String,
    added_columns:    Vec<ColumnDiff>,
    removed_columns:  Vec<ColumnDiff>,
    modified_columns: Vec<ColumnModDiff>,  // 类型变更、nullable 变更等
    added_indexes:    Vec<IndexDiff>,
    removed_indexes:  Vec<IndexDiff>,
    added_relations:  Vec<RelationDiff>,
    removed_relations: Vec<RelationDiff>,
}
```

## 5. 前端架构

### 5.1 Zustand Store: `erDesignerStore`

```typescript
interface ErDesignerStore {
  // 项目列表
  projects: ErProject[]
  loadProjects: () => Promise<void>
  createProject: (name: string, description?: string) => Promise<ErProject>
  updateProject: (id: number, updates: Partial<ErProject>) => Promise<void>
  deleteProject: (id: number) => Promise<void>

  // 当前活跃项目状态
  activeProjectId: number | null
  tables: ErTable[]
  columns: Record<number, ErColumn[]>
  relations: ErRelation[]
  indexes: Record<number, ErIndex[]>

  // 数据加载
  loadProject: (projectId: number) => Promise<void>

  // 表操作
  addTable: (name: string, position: {x: number, y: number}) => Promise<ErTable>
  updateTable: (id: number, updates: Partial<ErTable>) => Promise<void>
  deleteTable: (id: number) => Promise<void>

  // 列操作
  addColumn: (tableId: number, column: Partial<ErColumn>) => Promise<void>
  updateColumn: (id: number, updates: Partial<ErColumn>) => Promise<void>
  deleteColumn: (id: number, tableId: number) => Promise<void>
  reorderColumns: (tableId: number, columnIds: number[]) => Promise<void>

  // 关系操作
  addRelation: (rel: Partial<ErRelation>) => Promise<void>
  updateRelation: (id: number, updates: Partial<ErRelation>) => Promise<void>
  deleteRelation: (id: number) => Promise<void>

  // 索引操作
  addIndex: (tableId: number, index: Partial<ErIndex>) => Promise<void>
  updateIndex: (id: number, updates: Partial<ErIndex>) => Promise<void>
  deleteIndex: (id: number, tableId: number) => Promise<void>

  // 连接绑定
  bindConnection: (projectId: number, connectionId: number, db: string, schema?: string) => Promise<void>
  unbindConnection: (projectId: number) => Promise<void>

  // DDL / Diff / Sync
  generateDDL: (projectId: number, dialect: string) => Promise<string>
  diffWithDatabase: (projectId: number) => Promise<DiffResult>
  syncFromDatabase: (projectId: number, tableNames?: string[]) => Promise<void>

  // 导入导出
  exportJson: (projectId: number) => Promise<string>
  importJson: (json: string) => Promise<ErProject>

  // 撤销/重做
  undo: () => void
  redo: () => void
  operationHistory: OperationRecord[]
}
```

### 5.2 组件树

```
src/components/ERDesigner/
├── index.tsx                     -- 入口组件
├── ERSidebar/
│   ├── index.tsx                 -- 侧边栏主组件
│   ├── ProjectTree.tsx           -- 项目目录树
│   ├── ProjectTreeNode.tsx       -- 单个树节点渲染
│   └── ProjectContextMenu.tsx    -- 右键菜单
├── ERCanvas/
│   ├── index.tsx                 -- ReactFlow 画布容器
│   ├── ERToolbar.tsx             -- 画布工具栏
│   ├── ERTableNode.tsx           -- 表节点组件
│   └── EREdge.tsx                -- 关系连线（自定义样式）
├── dialogs/
│   ├── CreateProjectDialog.tsx   -- 新建项目（BaseModal）
│   ├── BindConnectionDialog.tsx  -- 绑定数据库连接（DropdownSelect）
│   ├── ImportTableDialog.tsx     -- 从数据库导入表
│   ├── DDLPreviewDialog.tsx      -- DDL 预览（方言选择+代码高亮+复制/执行）
│   └── DiffReportDialog.tsx      -- Diff 报告（变更列表+同步方向选择）
└── hooks/
    ├── useERCanvas.ts            -- ReactFlow 节点/边与 store 同步
    └── useERKeyboard.ts          -- 画布快捷键
```

### 5.3 ERSidebar 目录树结构

```
ER 设计器
├── 📁 电商系统              (右键: 重命名/删除/绑定连接/导出)
│   ├── 📋 users             (右键: 编辑/删除/添加列)
│   │   ├── 🔑 id            (PK 图标)
│   │   ├──    email
│   │   └──    name
│   ├── 📋 orders
│   │   ├── 🔑 id
│   │   ├── 🔗 user_id       (FK/关系 图标)
│   │   └──    amount
│   └── [+ 新建表]
├── 📁 支付系统
│   └── ...
└── [+ 新建项目]
```

### 5.4 Tab 集成

- `TabType` 新增 `'er_design'`
- `Tab` 接口新增 `erProjectId?: number`
- `queryStore` 新增 `openERDesignTab(projectId, projectName)` 方法，按 `erProjectId` 去重
- `MainContent` 新增渲染分支：`activeTab.type === 'er_design'` → `<ERCanvas />`

## 6. 核心功能流程

### 6.1 DDL 预览弹窗

```
┌─────────────────────────────────────────┐
│ 生成 DDL                          [×]   │
│─────────────────────────────────────────│
│ 方言: [MySQL ▼]                         │
│ ☑ 索引  ☑ 列注释(含标记)  ☐ 外键约束    │
│─────────────────────────────────────────│
│ CREATE TABLE `users` (                  │
│   `id` BIGINT NOT NULL AUTO_INCREMENT,  │
│   `email` VARCHAR(255) NOT NULL,        │
│   PRIMARY KEY (`id`)                    │
│ ) ENGINE=InnoDB;                        │
│─────────────────────────────────────────│
│              [复制]  [执行到数据库]       │
└─────────────────────────────────────────┘
```

- 方言切换用 `DropdownSelect`，实时重新生成
- 代码高亮复用 `prismjs` SQL 语法
- "执行到数据库"仅当项目已绑定连接时可用
- 外键约束默认关闭

### 6.2 Diff 报告弹窗

```
┌───────────────────────────────────────────────────┐
│ 结构差异对比                                 [×]   │
│───────────────────────────────────────────────────│
│ ER 图 vs MySQL-dev / ecommerce                    │
│───────────────────────────────────────────────────│
│ ✅ 新增（仅 ER 图有）                              │
│   ☑ 表 payments (4列)                             │
│   ☑ 列 users.avatar_url VARCHAR(500)              │
│ ⚠️ 变更                                           │
│   ☑ 列 orders.amount DECIMAL(10,2)→DECIMAL(12,2)  │
│ 🗑️ 删除（仅数据库有）                              │
│   ☐ 列 users.legacy_field TEXT                    │
│───────────────────────────────────────────────────│
│ [ER → 数据库 (生成 ALTER)]  [数据库 → ER (更新设计)]│
└───────────────────────────────────────────────────┘
```

- 每项可勾选，选择性同步
- ER → 数据库：生成 ALTER/CREATE/DROP DDL，预览后执行
- 数据库 → ER：将勾选的变更同步回 ER 图

### 6.3 数据库导入流程

```
用户点击"从数据库导入"
  → 项目已绑定连接？ ─否→ 弹出 BindConnectionDialog
  → 是 → 选择: [全量导入] / [选择导入]
    → 全量: invoke get_full_schema → 转换为 ER 数据
    → 选择: 弹出表列表（含搜索过滤）→ 勾选 → 导入
  → 解析真实 FK → er_relation (source="schema")
  → 解析列注释标记 → er_relation (source="comment")
  → Dagre 自动布局 → 画布渲染
```

### 6.4 AI 助手集成

当活跃 Tab 为 `er_design` 时，Assistant 上下文自动切换：

- 系统 prompt 注入当前 ER 项目的表/列/关系摘要
- AI 返回结构化操作指令，前端解析后调用 `erDesignerStore` 方法
- 支持的 AI 操作：
  - `create_table` / `drop_table` / `rename_table`
  - `add_column` / `drop_column` / `modify_column`
  - `add_relation` / `drop_relation`
  - `add_index` / `drop_index`
  - `generate_ddl` / `diff_database`
  - `batch`（批量建模："设计一个电商系统"→ 一次性生成多表+关系）

### 6.5 关系管理与注释标记集成

#### 关系来源三层模型

| source | 含义 | 视觉样式 | 可编辑性 |
|--------|------|----------|----------|
| `schema` | 真实 FK 约束 | 实线蓝色 `#3794ff`，2px | 不可删除（由 DB 管理） |
| `comment` | 注释标记推断 | 虚线琥珀色 `#f59e0b`，1.5px | 可编辑标记 |
| `designer` | ER 设计器创建 | 点线紫色 `#a855f7`，1.5px | 可自由编辑 |

#### 创建关系时的同步选项

```
同步选项（创建/编辑关系时显示）:
  ☑ 写入注释标记 (@ref:table.column)    ← 默认勾选
  ☐ 生成真实外键 (ALTER TABLE)           ← 默认不勾选
```

#### 注释标记维护规则

- 创建关系 + 勾选标记同步：在列 comment 中追加 `@ref:table.column`，不破坏原有注释
- 编辑关系（source="comment"）：替换列 comment 中的旧标记为新标记
- 删除关系（source="comment"）：从列 comment 中移除对应标记
- 删除关系（source="schema"）：提示需生成 DROP FOREIGN KEY DDL

#### 知识图谱联动

项目已绑定连接 + 变更涉及注释标记时：
→ invoke 更新数据库列注释
→ 触发知识图谱增量重建（event_processor）
→ 知识图谱自动拾取新的注释标记关系

支持的标记格式（与知识图谱 `comment_parser.rs` 一致）：
- `@ref:table.column`
- `@fk(table=T,col=C,type=REL_TYPE)`
- `[ref:table.column]`
- `$$ref(table.column)$$`

## 7. 画布交互

### 7.1 ERTableNode 节点

```
┌──────────────────────────────┐
│ 📋 users            [⋯] [×] │  表头：双击重命名，[⋯]更多操作，[×]删除
│──────────────────────────────│
│ 🔑 id       BIGINT     ≡    │  PK图标 | 列名(双击编辑) | 类型(点击DropdownSelect) | 拖拽排序
│    email     VARCHAR(255) ≡  │
│    name      VARCHAR(100) ≡  │
│──────────────────────────────│
│ [+ 添加列]                   │
└──────────────────────────────┘
```

- 每列左侧 target handle，右侧 source handle
- hover 时显示 handle，连接时高亮 `#00c9a7`
- 类型选择使用 `DropdownSelect` 组件

### 7.2 关系连线

```
实线蓝色 ━━━ FK ━━━▶  source="schema"
虚线琥珀 ╌╌╌ 注释 ╌╌▶  source="comment"
点线紫色 ‥‥‥ 设计 ‥‥▶  source="designer"
```

连线上居中显示关系类型标签（`1:N` / `1:1` / `N:N`），`bg-[#151d28]` 小气泡。
Hover 显示完整信息。

### 7.3 工具栏

```
┌─────────────────────────────────────────────────────────────┐
│ [+ 新建表] [⊞ 自动布局] [⬇ 导入] │ [DDL] [Diff] [↔ 同步] │ [📥 导出] [📤 导入JSON] │
└─────────────────────────────────────────────────────────────┘
```

样式：`bg-[#111922]/90 backdrop-blur border-[#1e2d42] rounded-lg shadow-lg`
按钮：`px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded`

### 7.4 快捷键

| 快捷键 | 操作 |
|--------|------|
| Delete / Backspace | 删除选中节点或连线 |
| Ctrl+A | 全选 |
| Ctrl+Z | 撤销 |
| Ctrl+Shift+Z | 重做 |
| Ctrl+D | 复制选中表 |
| Ctrl+L | 自动布局 |
| Ctrl+E | 导出 DDL |

### 7.5 撤销/重做

基于操作历史栈：

```typescript
interface OperationRecord {
  type: 'add_table' | 'delete_table' | 'add_column' | 'update_column'
        | 'add_relation' | 'delete_relation' | 'move_node' | 'batch'
  before: snapshot
  after: snapshot
  timestamp: number
}
```

撤销 = 恢复 before 状态 + 同步 SQLite，重做 = 恢复 after 状态 + 同步 SQLite。

## 8. 技术依赖

### 前端

- `@xyflow/react`（已有）— ReactFlow 画布
- `dagre`（已有）— 自动布局
- `prismjs`（已有）— DDL 代码高亮
- `lucide-react`（已有）— 图标

### 后端（Rust）

- `rusqlite`（已有）— SQLite 操作
- `serde_json`（已有）— JSON 序列化
- 无需新增外部依赖
