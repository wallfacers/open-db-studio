# 图谱虚拟关系层设计文档

**日期**：2026-03-20
**状态**：设计已批准，待实现（本文档为实现规范，不描述已完成的代码状态）
**背景**：企业级开发中数据库表之间的业务关联关系往往不会通过显式外键约束维护，导致图谱只能展示真实 FK，遗漏大量隐性关系。本文档设计"虚拟关系层"方案，通过列注释解析和手动编辑两条路径补全关系图谱。

---

## 一、目标

1. **注释解析**：在列注释中嵌入特定标记，构建图谱时自动解析为虚拟关系边
2. **手动编辑**：在图谱画布上支持手动连线、添加虚拟节点、删除/编辑边属性
3. **视觉区分**：三种来源（schema / comment / user）在画布上有清晰的颜色和样式区分
4. **持久化**：所有数据存入内置 SQLite，重建图谱时用户数据不被覆盖

---

## 二、数据层

### 2.1 source 字段语义扩展

`graph_nodes` 表已有 `source TEXT DEFAULT 'schema'` 列。`graph_edges` 表**当前没有** `source` 列，需要通过 DDL 迁移新增。

**迁移动作**：
- `schema/init.sql`：`graph_edges` 建表语句新增 `source TEXT NOT NULL DEFAULT 'schema'`
- `src-tauri/src/db/migrations.rs`：新增迁移步骤，对存量数据库执行 `ALTER TABLE graph_edges ADD COLUMN source TEXT NOT NULL DEFAULT 'schema'`

扩展后 `source` 字段三个合法值语义：

| source 值 | 含义 | 重建图谱时行为 |
|-----------|------|--------------|
| `schema` | 自动构建（数据库真实外键约束） | 覆盖更新 |
| `comment` | 列注释解析出的虚拟关系 | 重建时先清除旧 comment 数据，再重新解析生成 |
| `user` | 手动编辑（用户自定义节点/边） | **永不覆盖**，重建时跳过 |

### 2.2 edge_type 约束放宽

`graph_edges` 表当前有 CHECK 约束：

```sql
CHECK(edge_type IN ('has_column','foreign_key','metric_ref','alias_of','join_path','to_link','from_link'))
```

为支持用户自定义边类型，需将此约束放宽，新增 `'user_defined'` 枚举值，或移除 CHECK 改为应用层校验。推荐方案：**移除 CHECK 约束，改为 Rust 命令层校验合法值**，避免后续扩展再改 DDL。

**迁移动作**：SQLite 不支持 `ALTER TABLE DROP CONSTRAINT`，需重建表（在迁移脚本中先 CREATE new table → INSERT SELECT → DROP old → RENAME）。

`add_user_edge` 命令的 `edge_type` 合法值由 Rust 层校验，当前允许值：
`'foreign_key' | 'join_path' | 'user_defined'`（可扩展）。

### 2.3 ColumnMeta 扩展

在 `src-tauri/src/datasource/mod.rs` 的 `ColumnMeta` 新增 `comment` 字段：

```rust
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,  // 新增：列注释原文
}
```

| 数据库 | 来源 | 说明 |
|--------|------|------|
| MySQL | `information_schema.COLUMNS.COLUMN_COMMENT` | 已有 get_columns，扩展 SQL |
| PostgreSQL | `pg_description` JOIN `pg_attribute` | 已有 get_columns，扩展 SQL |
| Oracle | 暂不支持 | oracle.rs 为占位实现，列注释解析留待后续 |
| SQL Server | 暂不支持 | sqlserver.rs 为占位实现，列注释解析留待后续 |

### 2.4 新增 Rust 命令（手动编辑接口）

| 命令 | 参数 | source 校验 | 说明 |
|------|------|------------|------|
| `add_user_node` | `connection_id, name, display_name, node_type` | 写入 source='user' | 添加用户自定义节点 |
| `delete_graph_node` | `node_id` | 仅允许 source='user' | 软删除节点（is_deleted=1） |
| `add_user_edge` | `from_node, to_node, edge_type, weight` | 写入 source='user' | 添加用户自定义边 |
| `delete_graph_edge` | `edge_id` | 仅允许 source='user' 或 'comment' | 删除边 |
| `update_graph_edge` | `edge_id, edge_type, weight` | 仅允许 source='user' 或 'comment' | 修改边属性；schema 边不允许修改 |

---

## 三、解析层（注释标记）

### 3.1 支持的标记格式

在列注释原文中，以下格式均可触发虚拟关系解析：

| 格式 | 示例 | 说明 |
|------|------|------|
| 简洁引用式 | `@ref:orders.id` | 最简写法，关系类型默认 fk |
| 显式键值式 | `@fk(table=orders,col=id,type=one_to_many)` | 可指定关系类型和方向 |
| 方括号式 | `[ref:orders.id]` | 对第三方工具友好，碰撞风险极低 |
| 双美元式 | `$$ref(orders.id)$$` | 唯一性最强，适合严格规范的团队 |

同一列注释中可包含多个标记。解析后按 `(from_table, target_table, target_column)` 去重，防止同一列注释中多种格式指向同一目标时重复建边。

### 3.2 解析函数

```rust
struct CommentRef {
    target_table: String,
    target_column: String,
    relation_type: String,  // 默认 "fk"
}

fn parse_comment_refs(comment: &str) -> Vec<CommentRef>
```

使用正则多模式匹配，单次扫描注释字符串，返回去重后的关系引用列表。

### 3.3 在构建流程中的位置

在 `run_graph_build`（`src-tauri/src/graph/mod.rs`）第3步（拉取列信息）之后，新增第 3.5 步：

步骤 3.5 在 `run_graph_build`（`mod.rs`）中作为独立调用实现，**早于**步骤 5（event_processor）执行，不放入 event_processor 内部：

```
步骤 3.5：注释关系解析（在 mod.rs 中直接调用，先于步骤 4/5）
  1. 清除 connection_id 下所有 source='comment' 的节点和边（幂等保证）
  2. for each table:
       for each column where comment is not null:
         refs = parse_comment_refs(column.comment)（已去重）
         for each ref:
           若同一对表已有 source='schema' 的边 → 跳过
           生成 Link Node（source='comment'）
           生成两条 Edge：table → link_node，link_node → ref_target_table（source='comment'）
```

**与 change_detector 的兼容性**：`change_detector.rs` 中读取现有节点的过滤条件为 `source IS NULL OR source != 'user'`，这对 `comment` 来源节点天然兼容（comment 节点在步骤 3.5 先于 change_detector 清除重建，不会进入对比基线），**change_detector.rs 无需修改**。

### 3.4 容错原则

- 目标表不存在于当前 Schema → 跳过，记录 WARN 日志，不中断构建
- 注释格式解析失败 → 跳过该列，继续处理其他列
- 同一对表已有 `source='schema'` 的外键关系 → 跳过，不重复创建 Link Node

---

## 四、前端编辑层

### 4.1 视觉区分

三种来源复用现有主题色板，不引入新颜色：

| 来源 | 节点/边颜色 | 边线型 | 徽章图标 |
|------|------------|--------|---------|
| `schema` | `#3794ff`（蓝色，现有 table 色） | 实线 | 无 |
| `comment` | `#f59e0b`（琥珀黄，现有 metric 色） | 虚线 | `"` 引号图标 |
| `user` | `#a855f7`（紫色，现有 alias 色） | 点划线 | ✏️ 铅笔图标 |

背景色、字体色、border 颜色均沿用现有深色主题（`#0d1117` / `#1e2d42` / `#c8daea`）。

### 4.2 编辑模式开关

工具栏新增"编辑模式"切换按钮（默认关闭，防止误操作）：

- **关闭状态**：画布只读，用户节点/边有视觉徽章但不可交互编辑
- **开启状态**：工具栏出现琥珀色边框提示，解锁以下编辑能力

### 4.3 编辑操作清单

| 操作 | 交互方式 | 说明 |
|------|---------|------|
| 手动连线 | 拖拽节点 handle → 目标节点，松手弹出边类型选择框 | 调用 `add_user_edge` |
| 添加虚拟节点 | 工具栏"+ 节点"→ 输入名称 → 放置到画布 | 调用 `add_user_node` |
| 删除用户节点/边 | 选中后 Delete 键，或右键菜单"删除" | 调用 `delete_graph_node` / `delete_graph_edge` |
| 编辑边属性 | 点击边 → NodeDetail 面板显示 edge_type / weight 可编辑 | 调用 `update_graph_edge`（仅 user/comment 边） |
| 隐藏 schema 节点 | 右键"在此图谱中隐藏"→ 前端状态过滤，不写库 | 仅本次会话有效；重建图谱后隐藏状态重置，被隐藏节点重新出现，这是预期行为 |

### 4.4 NodeDetail 面板扩展

选中节点时，详情面板顶部新增来源徽章行，并按来源决定操作权限：

| 来源 | 徽章 | 删除按钮 | 边属性编辑 |
|------|------|---------|-----------|
| `schema` | 蓝色"数据库外键" | ❌ 不显示 | ❌ 不允许 |
| `comment` | 琥珀色"注释推断" | ✅ 显示（删除该注释来源的边） | ✅ 允许修改 weight |
| `user` | 紫色"✏️ 用户自定义" | ✅ 显示（删除节点） | ✅ 允许修改 edge_type + weight |

示例（user 节点）：
```
┌──────────────────────────────────┐
│ ✏️ 用户自定义节点                 │  ← 紫色徽章
│ orders_virtual                   │
│ ...属性...                       │
│ [删除此节点]                      │  ← 危险操作，二次确认
└──────────────────────────────────┘
```

---

## 五、关键约束

- 删除/修改操作仅限对应 source，命令层强制校验，杜绝跨来源误操作
- `schema` 来源节点/边只读，前端不显示编辑/删除入口，后端命令层也拒绝修改
- 注释解析在 Rust 层完成，前端不做二次解析
- 重建图谱时 `source='user'` 数据通过 `WHERE source != 'user'` 在 `change_detector` 和 `event_processor` 中保护（`change_detector.rs` 现有过滤逻辑已兼容，无需修改）
- `source='comment'` 数据在每次重建的步骤 3.5 开始前清除重建，保证幂等
- 解析结果按 `(from_table, target_table, target_column)` 去重，防止多标记重复建边
- 隐藏 schema 节点为会话级前端过滤，重建后重置，不持久化

---

## 六、文件改动范围

| 文件 | 改动类型 |
|------|---------|
| `schema/init.sql` | graph_edges 新增 source 列；放宽 edge_type CHECK 约束 |
| `src-tauri/src/db/migrations.rs` | 新增迁移：ALTER TABLE graph_edges ADD COLUMN source；重建 graph_edges 表移除 CHECK 约束 |
| `src-tauri/src/datasource/mod.rs` | ColumnMeta 新增 comment 字段 |
| `src-tauri/src/datasource/mysql.rs` | get_columns 读取 COLUMN_COMMENT |
| `src-tauri/src/datasource/postgres.rs` | get_columns 读取 pg_description |
| `src-tauri/src/graph/mod.rs` | run_graph_build 新增步骤 3.5 |
| `src-tauri/src/graph/comment_parser.rs` | 新建：parse_comment_refs 实现 |
| `src-tauri/src/graph/event_processor.rs` | 重建前清除 source='comment' 节点和边 |
| `src-tauri/src/commands.rs` | 新增 5 个手动编辑命令 |
| `src-tauri/src/lib.rs` | generate_handler![] 注册新命令 |
| `src/components/GraphExplorer/index.tsx` | 编辑模式开关、视觉区分、手动连线、隐藏节点 |
| `src/components/GraphExplorer/NodeDetail.tsx` | 来源徽章、按 source 控制删除/编辑权限 |
| `src/components/GraphExplorer/useGraphData.ts` | GraphEdge 接口新增 `source: string` 字段 |
| `src-tauri/src/graph/query.rs` | `GraphEdge` 结构体新增 `source: Option<String>` 字段；查询 SQL SELECT 中新增 `source` 列 |
| `src-tauri/src/graph/change_detector.rs` | 无需修改（现有 source != 'user' 过滤已兼容 comment 来源） |
