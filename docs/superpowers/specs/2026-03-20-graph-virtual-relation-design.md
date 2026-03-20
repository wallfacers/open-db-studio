# 图谱虚拟关系层设计文档

**日期**：2026-03-20
**状态**：已批准
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

现有 `graph_nodes` 和 `graph_edges` 表无需改动，扩展 `source` 字段的合法值语义：

| source 值 | 含义 | 重建图谱时行为 |
|-----------|------|--------------|
| `schema` | 自动构建（数据库真实外键约束） | 覆盖更新 |
| `comment` | 列注释解析出的虚拟关系 | 重建时先清除旧 comment 数据，再重新解析生成 |
| `user` | 手动编辑（用户自定义节点/边） | **永不覆盖**，重建时跳过 |

### 2.2 ColumnMeta 扩展

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

- **MySQL**：从 `information_schema.COLUMNS.COLUMN_COMMENT` 读取
- **PostgreSQL**：从 `pg_description` JOIN `pg_attribute` 读取

### 2.3 新增 Rust 命令（手动编辑接口）

| 命令 | 参数 | 说明 |
|------|------|------|
| `add_user_node` | `connection_id, name, display_name, node_type` | 添加用户自定义节点（source='user'） |
| `delete_graph_node` | `node_id` | 软删除节点（is_deleted=1），仅限 source='user' |
| `add_user_edge` | `from_node, to_node, edge_type, weight` | 添加用户自定义边（source='user'） |
| `delete_graph_edge` | `edge_id` | 删除边，仅限 source='user' 或 source='comment' |
| `update_graph_edge` | `edge_id, edge_type, weight` | 修改边属性 |

---

## 三、解析层（注释标记）

### 3.1 支持的标记格式

在列注释原文中，以下三种格式均可触发虚拟关系解析：

| 格式 | 示例 | 说明 |
|------|------|------|
| 简洁引用式 | `@ref:orders.id` | 最简写法，关系类型默认 fk |
| 显式键值式 | `@fk(table=orders,col=id,type=one_to_many)` | 可指定关系类型和方向 |
| 方括号式 | `[ref:orders.id]` | 对第三方工具友好，碰撞风险极低 |
| 双美元式 | `$$ref(orders.id)$$` | 唯一性最强，适合严格规范的团队 |

同一列注释中可包含多个标记（例如 `用户ID @ref:users.id [ref:accounts.uid]`），解析器全部提取。

### 3.2 解析函数

```rust
struct CommentRef {
    target_table: String,
    target_column: String,
    relation_type: String,  // 默认 "fk"
}

fn parse_comment_refs(comment: &str) -> Vec<CommentRef>
```

使用正则多模式匹配，单次扫描注释字符串，返回所有命中的关系引用。

### 3.3 在构建流程中的位置

在 `run_graph_build`（`src-tauri/src/graph/mod.rs`）第3步（拉取列信息）之后，新增第 3.5 步：

```
步骤 3.5：注释关系解析
  1. 清除 connection_id 下所有 source='comment' 的节点和边（幂等保证）
  2. for each table:
       for each column where comment is not null:
         refs = parse_comment_refs(column.comment)
         for each ref:
           生成 Link Node（source='comment'）
           生成两条 Edge：table → link_node，link_node → ref_target_table
```

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
| 编辑边属性 | 点击边 → NodeDetail 面板显示 edge_type / weight 可编辑 | 调用 `update_graph_edge` |
| 隐藏 schema 节点 | 右键"在此图谱中隐藏"→ 前端过滤（不写库） | 仅本次会话有效 |

### 4.4 NodeDetail 面板扩展

选中节点时，详情面板顶部新增来源徽章行：

```
┌──────────────────────────────────┐
│ [schema] 数据库外键               │  ← 蓝色徽章，无操作按钮
│  或
│ [comment] 注释推断               │  ← 琥珀色徽章
│  或
│ [✏️ 用户自定义]                  │  ← 紫色徽章 + [删除此节点] 危险按钮
└──────────────────────────────────┘
```

`schema` 来源节点不显示删除按钮（数据库真实结构不允许在图谱层删除）。

---

## 五、关键约束

- 删除/覆盖操作仅限对应 source，杜绝跨来源误删
- 注释解析在 Rust 层完成，前端不做二次解析
- 重建图谱时 `source='user'` 数据在 `change_detector` 和 `event_processor` 中通过 `WHERE source != 'user'` 过滤保护
- 新增 Rust 命令必须在 `lib.rs` 的 `generate_handler![]` 中注册

---

## 六、文件改动范围

| 文件 | 改动类型 |
|------|---------|
| `src-tauri/src/datasource/mod.rs` | ColumnMeta 新增 comment 字段 |
| `src-tauri/src/datasource/mysql.rs` | get_columns 读取 COLUMN_COMMENT |
| `src-tauri/src/datasource/postgres.rs` | get_columns 读取 pg_description |
| `src-tauri/src/graph/mod.rs` | run_graph_build 新增步骤 3.5 |
| `src-tauri/src/graph/comment_parser.rs` | 新建：parse_comment_refs 实现 |
| `src-tauri/src/graph/event_processor.rs` | 重建前清除 source='comment' 数据 |
| `src-tauri/src/commands.rs` | 新增 5 个手动编辑命令 |
| `src-tauri/src/lib.rs` | generate_handler![] 注册新命令 |
| `src/components/GraphExplorer/index.tsx` | 编辑模式开关、视觉区分、手动连线 |
| `src/components/GraphExplorer/NodeDetail.tsx` | 来源徽章、删除按钮 |
| `src/components/GraphExplorer/useGraphData.ts` | GraphEdge 新增 source 字段 |
