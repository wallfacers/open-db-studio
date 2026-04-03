# ER 设计器约束方式（Constraint Method）设计文档

**日期**：2026-04-04  
**状态**：已确认，待实现

---

## 背景

部分系统为提升数据库写入性能，不在数据库层面添加外键约束，改由业务代码保证引用完整性。ER 设计器需要支持这类场景：用户可以选择约束方式为"注释引用"，DDL 生成时将关系信息写入列注释而非生成真实 FK 约束。

`comment_parser.rs` 已实现从列注释中解析 4 种格式的引用标记，本功能与之形成完整闭环：

- **设计阶段**：ER 设计器中设置约束方式 → DDL 生成时写入注释标记
- **逆向阶段**：从已有 schema 导入时，`comment_parser.rs` 解析注释标记 → 在知识图谱/ER 图中显示关系

---

## 核心概念

### 约束方式（Constraint Method）

每条关系有且仅有两种约束方式：

| 值 | 含义 | DDL 输出 |
|----|------|----------|
| `database_fk` | 真实数据库外键 | `CONSTRAINT ... FOREIGN KEY ...` |
| `comment_ref` | 注释引用 | 在源列 comment 末尾追加引用标记 |

视觉连线始终可见，与约束方式无关。

### 注释格式（Comment Format）

当约束方式为 `comment_ref` 时，从 4 种格式中选一种：

| 值 | 示例 |
|----|------|
| `@ref` | `@ref:users.id` |
| `@fk` | `@fk(table=users,col=id,type=one_to_many)` |
| `[ref]` | `[ref:users.id]` |
| `$$ref$$` | `$$ref(users.id)$$` |

### 三级继承

```
项目级默认值
  └─ 表级（NULL = 继承项目）
       └─ 关系级（NULL = 继承表 → 项目）
```

解析函数（Rust）：

```rust
fn effective_constraint_method(relation, table, project) -> &str {
    relation.constraint_method
        .or(table.constraint_method)
        .or(project.default_constraint_method)
        .unwrap_or("database_fk")
}
```

---

## 数据模型

### `er_projects` 表（新增字段）

```sql
default_constraint_method  TEXT NOT NULL DEFAULT 'database_fk',
default_comment_format     TEXT NOT NULL DEFAULT '@ref'
```

### `er_tables` 表（新增字段）

```sql
constraint_method  TEXT NULL,   -- NULL 表示继承项目级
comment_format     TEXT NULL    -- NULL 表示继承项目级
```

### `er_relations` 表（新增字段）

```sql
constraint_method  TEXT NULL,   -- NULL 表示继承表级
comment_format     TEXT NULL    -- NULL 表示继承
```

> 现有 `comment_marker` 字段保留，用于记录从注释解析的原始标记（只读来源信息）。

---

## UI 设计

### 视觉指示器

**连线样式**：

| 生效约束方式 | 线型 | 徽章图标 |
|------------|------|---------|
| `database_fk` | 实线 | 🔒 锁形 |
| `comment_ref` | 虚线（dashed） | 💬 注释形 |

**继承状态标签**（编辑面板内，选择器旁）：

- 灰色小标签 = "继承自项目默认" / "继承自表默认"
- 橙色小标签 = "已覆盖"，点击可一键重置为 NULL（恢复继承）

**表节点**：右上角小圆点，颜色对应该表所有关系的多数派约束方式，悬浮显示 tooltip。

---

### 项目级入口

位置：ER 设计器顶部工具栏 → "项目设置" → 新增"约束方式"区块

```
┌─ 约束方式默认值 ──────────────────────────────┐
│  约束方式  ○ 数据库外键  ● 注释引用           │
│  注释格式  [ @ref:table.col        ▼ ]        │
└──────────────────────────────────────────────┘
```

### 表级入口

位置：选中表节点 → ERPropertyDrawer → 新增第 4 个标签"关系"

布局：
1. 顶部：表级约束方式覆盖设置（含继承/覆盖切换 + 来源标注）
2. 下方：该表所有关系列表，显示每条关系的生效约束方式和来源层级，点击行可跳转高亮连线

```
表级默认约束方式：
  ○ 继承项目（当前：数据库外键）
  ● 覆盖为：[ 注释引用 ▼ ]
  注释格式：[ @fk(table,col,type) ▼ ]  ← 继承自项目

该表的关系列表：
  连线              约束方式        来源
  user_id → users   注释引用 💬     继承自表
  dept_id → depts   数据库外键 🔒   已覆盖
```

### 关系级入口

位置：点击连线 → EREdge 弹出菜单，在现有 relation_type 下方追加

```
┌──────────────────────────────────────┐
│  关系类型   [ 1:N ▼ ]               │
│  ─────────────────────────────────  │
│  约束方式   [ 注释引用 ▼ ]  继承自表 │
│  注释格式   [ @ref:table.col ▼ ]    │
│                        [重置为继承]  │
└──────────────────────────────────────┘
```

"重置为继承"仅当该关系的 `constraint_method` 不为 NULL 时显示。

---

## DDL 生成行为

### database_fk（无变化）

```sql
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

### comment_ref

不生成 FK 约束，在源列 comment 末尾追加引用标记：

```sql
-- @ref 格式
ALTER TABLE orders MODIFY COLUMN user_id INT COMMENT '用户ID @ref:users.id';

-- @fk 格式
ALTER TABLE orders MODIFY COLUMN user_id INT
  COMMENT '用户ID @fk(table=users,col=id,type=one_to_many)';
```

**追加规则（幂等）**：

- 若列已有 comment，空格分隔后追加标记
- 若标记已存在（精确匹配），不重复写入
- 空 comment 直接写标记

### DDL 选项面板

现有 `include_foreign_keys` 拆分为两个独立开关：

```
[ ✓ ] 生成外键约束（对约束方式=database_fk 的关系生效）
[ ✓ ] 在列注释中生成引用标记（对约束方式=comment_ref 的关系生效）
```

---

## 实现范围

### Rust 后端
- `schema/init.sql`：三张表新增字段
- `er/models.rs`：`ErProject`、`ErTable`、`ErRelation` 结构体新增字段
- `er/repository.rs`：CRUD 更新，查询时带出新字段
- `er/ddl_generator.rs`：
  - 新增 `resolve_constraint_method()` 继承解析函数
  - `generate_ddl()` 根据生效约束方式分支处理
  - 注释追加逻辑（幂等）
- `er/commands.rs`：更新/创建命令接受新字段

### 前端
- `src/types/index.ts`：`ErProject`、`ErTable`、`ErRelation` 新增字段
- `src/store/erDesignerStore.ts`：更新状态和 invoke 调用
- `EREdge.tsx`：弹出菜单扩展（约束方式 + 格式选择 + 重置）
- `ERPropertyDrawer/`：新增 `RelationsTab.tsx`
- `ERPropertyDrawer/TablePropertiesTab.tsx`：表级约束方式设置区块
- 项目设置面板：新增约束方式默认值区块
- 连线样式：实线/虚线 + 徽章图标
- 表节点：右上角圆点指示器

---

## 不在本次范围内

- 从已有 schema 逆向导入时的 `constraint_method` 自动推断（`comment_parser.rs` 已解析，但自动映射到新字段是单独任务）
- 多条关系批量修改约束方式
- `many_to_many` 中间表的注释引用策略
