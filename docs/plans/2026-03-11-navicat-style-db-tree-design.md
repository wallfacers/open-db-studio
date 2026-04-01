<!-- STATUS: ✅ 已实现 -->
# Navicat 风格数据库资源导航树 — 设计文档

**日期**：2026-03-11
**状态**：已批准
**范围**：`src/components/Explorer/`、`src/store/treeStore.ts`、`src-tauri/src/`、`schema/init.sql`

---

## 一、背景与目标

将现有扁平的"连接 → 表列表"树，改造为类 Navicat 的多层级数据库资源导航树，支持：

- 顶层分组（Group）管理多个连接
- 多数据库方言的不同层级深度（MySQL / PostgreSQL / Oracle）
- 虚拟分类节点（Tables / Views / Functions 等）
- 逐层懒加载（连接预加载到 Category 层，表/列按需加载）
- 前端搜索（扁平索引，O(n) 无递归）
- 各节点类型独立的右键菜单操作

---

## 二、节点类型系统

### 2.1 NodeType 枚举

```typescript
type NodeType =
  | 'group'       // 根级分组（可选，非必选）
  | 'connection'  // 数据库连接
  | 'database'    // 数据库（MySQL: Schema | PG/Oracle: Database）
  | 'schema'      // Schema（PG: Schema | Oracle: Schema/User）MySQL 无此层
  | 'category'    // 虚拟分类节点（Tables / Views / Functions / …）
  | 'table'       // 数据表
  | 'view'        // 视图
  | 'function'    // 函数
  | 'procedure'   // 存储过程
  | 'trigger'     // 触发器
  | 'event'       // MySQL Events
  | 'sequence'    // PostgreSQL / Oracle Sequences
  | 'column'      // 列（表/视图的叶子节点）
```

### 2.2 TreeNode 接口

```typescript
interface TreeNode {
  id: string            // 路径式唯一 ID
                        // 示例: "conn_1/db_mydb/schema_public/cat_tables/table_users"
  nodeType: NodeType
  label: string
  parentId: string | null
  hasChildren: boolean
  loaded: boolean       // 子节点是否已从后端加载
  meta: {
    connectionId?: number
    database?: string
    schema?: string
    objectName?: string
    driver?: 'mysql' | 'postgres' | 'oracle' | 'sqlserver'
  }
}
```

---

## 三、各数据库层级路径

| 数据库 | 层级路径 |
|--------|---------|
| MySQL | Connection → Database → Category → Table/View/… → Column |
| PostgreSQL | Connection → Database → Schema → Category → Table/View/… → Column |
| Oracle | Connection → Database → Schema(User) → Category → Table/View/… → Column |

### Category 节点（按数据库方言）

| Category | MySQL | PostgreSQL | Oracle |
|----------|-------|-----------|--------|
| Tables | ✅ | ✅ | ✅ |
| Views | ✅ | ✅ | ✅ |
| Functions | ✅ | ✅ | ✅ |
| Procedures | ✅ | ✅ | ✅ |
| Triggers | ✅ | ✅ | ✅ |
| Events | ✅ | ❌ | ❌ |
| Sequences | ❌ | ✅ | ✅ |

### 视图子节点

视图展开后只展示列列表（与表一致），不展示视图 SQL 定义。

---

## 四、状态管理

### 4.1 Zustand Tree Store（`src/store/treeStore.ts`）

```typescript
interface TreeStore {
  // 状态
  nodes: Map<string, TreeNode>        // 全量节点 Map（渲染用）
  searchIndex: Map<string, TreeNode>  // 并行搜索索引（搜索用，O(n) 无递归）
  expandedIds: Set<string>            // 展开节点集合
  selectedId: string | null           // 当前选中节点
  loadingIds: Set<string>             // 正在加载子节点的节点集合

  // 操作
  initGroups(): Promise<void>                  // 启动时加载 Groups + Connections
  loadChildren(nodeId: string): Promise<void>  // 懒加载子节点
  toggleExpand(nodeId: string): void
  selectNode(nodeId: string): void
  refreshNode(nodeId: string): Promise<void>   // 刷新某节点的子节点
  search(query: string): TreeNode[]            // 前端搜索
}
```

### 4.2 加载策略

```
打开连接（双击 connection 节点）
  → invoke list_databases()
  → 每个 database 下直接创建对应 Category 节点（不发请求）
  → connection.loaded = true

展开 Category（如 Tables）
  → invoke list_objects(connId, database, schema?, 'tables')
  → 创建具体 table 节点

展开 Table / View
  → invoke get_table_detail(connId, table)
  → 创建 column 叶子节点

MySQL：跳过 schema 层，database 直接展开到 Category
PostgreSQL：展开 database → invoke list_schemas() → 创建 schema 节点
            展开 schema → 直接创建 Category 节点（无请求）
```

### 4.3 前端搜索

```typescript
search(query: string): TreeNode[] {
  return Array.from(searchIndex.values())
    .filter(n => n.label.toLowerCase().includes(query.toLowerCase()))
}
// 搜索结果高亮时，通过 node.parentId 链向上展开所有祖先节点
```

---

## 五、右键菜单操作

| 节点类型 | 操作列表 |
|---------|---------|
| **Group** | 新建连接（到此分组）、重命名分组、删除分组 |
| **Connection** | 打开连接 / 关闭连接（状态互斥）、新建查询、刷新、编辑连接、删除连接 |
| **Database** | 新建查询（使用此库）、刷新 |
| **Schema** | 新建查询（使用此 Schema）、刷新 |
| **Category(Tables)** | 新建表、AI 建表、刷新 |
| **Category(Views)** | 新建视图、刷新 |
| **Category(其他)** | 刷新 |
| **Table** | 打开表数据、新建查询、编辑表结构、管理索引、导出数据、删除表 |
| **View** | 打开视图数据、新建查询、删除视图 |
| **Column** | 复制列名 |

右键菜单由统一的 `ContextMenu.tsx` 处理，根据 `node.nodeType` 动态渲染操作列表。

---

## 六、SQLite Schema 变更

### 6.1 新增表 `connection_groups`

```sql
CREATE TABLE connection_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  color       TEXT,                          -- 分组颜色标识（可选）
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT    DEFAULT (datetime('now'))
);
```

### 6.2 修改 `connections` 表

```sql
ALTER TABLE connections ADD COLUMN group_id   INTEGER REFERENCES connection_groups(id) ON DELETE SET NULL;
ALTER TABLE connections ADD COLUMN sort_order INTEGER DEFAULT 0;
```

---

## 七、新增 Rust 命令

| 命令 | 参数 | 用途 |
|------|------|------|
| `list_databases` | `connection_id` | 加载数据库列表 |
| `list_schemas` | `connection_id, database` | 加载 Schema 列表（PG/Oracle） |
| `list_objects` | `connection_id, database, schema?, category` | 加载表/视图/函数等对象列表 |
| `list_groups` | — | 加载所有分组 |
| `create_group` | `name, color?` | 新建分组 |
| `update_group` | `id, name, color?` | 重命名/改色分组 |
| `delete_group` | `id` | 删除分组（连接移至未分组） |
| `move_connection_to_group` | `connection_id, group_id?` | 分配连接到分组 |

所有新命令需在 `src-tauri/src/lib.rs` 的 `generate_handler![]` 中注册。

---

## 八、前端组件结构

```
src/components/Explorer/
├── index.tsx          # 主容器（搜索栏、顶部操作栏、组装子组件）
├── DBTree.tsx         # 树渲染引擎（根据 expandedIds + nodes 计算可见节点列表）
├── TreeNode.tsx       # 单节点渲染（图标/缩进/展开箭头/加载 spinner/选中高亮）
├── ContextMenu.tsx    # 统一右键菜单（按 nodeType 分发操作）
└── nodeActions.ts     # 各节点类型 action 定义（与渲染解耦）

src/store/
└── treeStore.ts       # 新建 Zustand Tree Store
```

### 组件关系

```
Explorer/index.tsx
  ├── 搜索栏（前端过滤 searchIndex）
  ├── 顶部操作：[新建连接] [刷新]
  └── DBTree.tsx
        └── TreeNode.tsx × N
              └── ContextMenu.tsx（右键触发，按 nodeType 渲染菜单项）
```

---

## 九、SQL 编辑器上下文选择器

新建查询时，编辑器顶部显示上下文选择栏：

```
[连接 ▼] › [数据库 ▼] › [Schema ▼]（仅 PG/Oracle）
```

| 规则 | 说明 |
|------|------|
| 从树节点右键"新建查询" | 自动预填当前节点的连接+库+Schema |
| 从 Tab 栏"+"打开 | 全部空白，用户手动选择 |
| PostgreSQL Schema | 未选时默认填入 `public` |
| 执行 SQL 前校验 | 连接和数据库必填，否则提示"请先选择数据库" |

双击树节点 = 展开/折叠（不打开 SQL 编辑器）。

---

## 十、不在本次范围内

- 连接拖拽排序（sort_order 字段预留，UI 后续 sprint）
- 分组折叠/排序 UI
- Oracle / SQL Server 驱动实现（占位）
- 触发器 / 函数 / 存储过程的详情面板
