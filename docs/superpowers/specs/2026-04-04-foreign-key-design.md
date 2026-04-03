# 外键约束创建 & comment_parser 增强设计

**日期：** 2026-04-04  
**状态：** 已批准  
**范围：** TableManageDialog 新建/编辑表页面、comment_parser.rs、tableFormStore、TableFormAdapter

---

## 背景

`TableManageDialog` 目前仅支持列管理（名称、类型、长度、Null、默认值、PK、Extra），缺少：
1. 原生数据库外键约束的创建 UI
2. 索引管理 UI（`TableFormIndex` 数据结构已存在但 UI 为空）
3. 列注释字段的 UI 展示

`comment_parser.rs` 已支持 4 种注释格式提取关系引用，但不返回去除标记后的干净描述文本。

---

## 目标

1. **comment_parser.rs**：新增 `parse_comment()` 函数，同时返回引用列表和干净描述文本
2. **tableFormStore.ts**：新增 `TableFormForeignKey` 接口，`TableFormState` 加 `foreignKeys`
3. **TableFormAdapter.ts**：`generateCreateSql` / `generateAlterSql` 支持 FK CONSTRAINT 生成
4. **TableManageDialog**：改为 Tab 布局（字段 / 外键 / 索引），字段 tab 加 Comment 列

---

## §1 — comment_parser.rs 增强

### 新增数据结构

```rust
pub struct ParsedComment {
    pub refs: Vec<CommentRef>,   // 解析出的关系引用（去重）
    pub clean_text: String,      // 去掉所有标记后 trim 的剩余描述
}
```

### 标记剥离规则

剥离时依次将以下模式替换为空串，最后 trim 空白：

| 格式 | 正则 |
|------|------|
| `@ref:table.col` | `@ref:[A-Za-z_]\w*\.[A-Za-z_]\w*` |
| `@fk(...)` | `@fk\([^)]+\)` |
| `[ref:table.col]` | `\[ref:[A-Za-z_]\w*\.[A-Za-z_]\w*\]` |
| `$$ref(table.col)$$` | `\$\$ref\([A-Za-z_]\w*\.[A-Za-z_]\w*\)\$\$` |

### 解析示例

```
"用户ID @ref:users.id"               → refs: [users.id/fk],   clean_text: "用户ID"
"@ref:users.id 用户主键"             → refs: [users.id/fk],   clean_text: "用户主键"
"@fk(table=orders,col=id) 订单编号"  → refs: [orders.id/fk],  clean_text: "订单编号"
"普通备注，无标记"                    → refs: [],              clean_text: "普通备注，无标记"
"@ref:users.id"                      → refs: [users.id/fk],   clean_text: ""
```

### 向后兼容

`parse_comment_refs(comment)` 保持不变，内部改为调用 `parse_comment(comment).refs`。

### 新增测试（6 条）

- 格式在前、描述在后
- 描述在前、格式在后
- 无标记返回原文
- 纯标记无描述返回空 clean_text
- 混合多标记只剥离标记部分
- 空字符串

---

## §2 — tableFormStore.ts 数据结构

### 新增接口

```typescript
export interface TableFormForeignKey {
  id: string
  constraintName: string        // e.g. fk_orders_user_id
  column: string                // 当前表的列名
  referencedTable: string       // 引用目标表
  referencedColumn: string      // 引用目标列
  onDelete: string              // NO ACTION | CASCADE | SET NULL | RESTRICT | SET DEFAULT
  onUpdate: string
  _isNew?: boolean
  _isDeleted?: boolean
  _originalName?: string        // 用于 ALTER 时追踪约束名变化
}
```

### TableFormState 新增字段

```typescript
export interface TableFormState {
  // 现有字段不变
  tableName: string
  engine: string
  charset: string
  comment: string
  columns: TableFormColumn[]
  originalColumns?: TableFormColumn[]
  indexes: TableFormIndex[]
  originalIndexes?: TableFormIndex[]
  // 新增
  foreignKeys: TableFormForeignKey[]
  originalForeignKeys?: TableFormForeignKey[]
}
```

**持久化：** `foreignKeys` 随现有 `persistFormState` 自动序列化，无额外改动。  
**初始值：** `foreignKeys: []`，编辑已有表时从 `get_table_detail` 的 `foreign_keys` 映射填充。

---

## §3 — TableFormAdapter.ts SQL 生成

### CREATE TABLE（新建）

在 PRIMARY KEY 行之后追加 FK CONSTRAINT：

```sql
-- MySQL
CREATE TABLE `orders` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_orders_user_id` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- PostgreSQL（双引号，语法相同）
CREATE TABLE "orders" (
  "id" SERIAL,
  "user_id" INT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
```

### ALTER TABLE（编辑已有表）diff 逻辑

| 情况 | 生成 SQL |
|------|---------|
| `_isNew && !_isDeleted` | `ALTER TABLE t ADD CONSTRAINT fk_name FOREIGN KEY (col) REFERENCES ref_table (ref_col) ON DELETE ... ON UPDATE ...;` |
| `_isDeleted && !_isNew` | MySQL: `ALTER TABLE t DROP FOREIGN KEY fk_name;` / PG: `ALTER TABLE t DROP CONSTRAINT fk_name;` |
| 属性变化（非 new/deleted） | DROP 旧约束 + ADD 新约束（两条语句） |
| 无变化 | 不生成 |

### 新增辅助函数（文件内私有）

```typescript
function fkConstraintLine(fk: TableFormForeignKey, isPg: boolean): string
function generateFkAddSql(tableName: string, fk: TableFormForeignKey, isPg: boolean): string
function generateFkDropSql(tableName: string, constraintName: string, isPg: boolean): string
```

### MCP patch capabilities 追加

```typescript
{ pathPattern: '/foreignKeys/-',                   ops: ['add'],     description: 'Add a new FK constraint' },
{ pathPattern: '/foreignKeys[name=<s>]',           ops: ['remove'],  description: 'Remove an FK by constraintName' },
{ pathPattern: '/foreignKeys[name=<s>]/<field>',   ops: ['replace'], description: 'Modify FK properties' },
```

---

## §4 — TableManageDialog UI 改造

### 整体布局

```
┌─ header: 创建/编辑表 ──────────────────────────────────────┐
│  [AI 建表面板] (仅新建时，折叠)                              │
│  [表名输入]    (仅新建时)                                    │
│                                                            │
│  ┌─ Tab 导航 ─────────────────────────────────────────┐    │
│  │  [字段]  [外键]  [索引]                             │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌─ Tab 内容区（可滚动）─────────────────────────────┐    │
│  │  (当前激活 tab 内容)                               │    │
│  └───────────────────────────────────────────────────┘    │
│  SQL 预览（只读 textarea）                                  │
│  [取消]  [执行]                                            │
└────────────────────────────────────────────────────────────┘
```

对话框宽度从 800px 扩展至 **950px**（容纳 Comment 列）。

### 字段 Tab

在现有列表格末尾加 Comment 列（宽约 130px）：

```
列名    | 类型   | 长度 | Null | 默认值 | PK | Extra | Comment | 操作
--------|--------|------|------|--------|----|-------|---------|-----
id      | INT    |      | □    |        | ✓  | auto… |         | ↑↓🗑
user_id | INT    |      | □    |        | □  |       | 用户ID   | ↑↓🗑
```

### 外键 Tab

```
约束名              | 当前列(下拉)  | 引用表    | 引用列 | ON DELETE   | ON UPDATE   | 操作
--------------------|--------------|-----------|--------|-------------|-------------|-----
fk_orders_user_id   | [user_id ▼]  | users     | id     | [NO ACTION] | [NO ACTION] | 🗑

[+ 添加外键]
```

**交互细节：**
- 点击"+ 添加外键"插入新行，`onDelete/onUpdate` 默认 `NO ACTION`
- 选定 column 后自动建议约束名 `fk_<tableName>_<column>`（用户可覆盖）
- 当前列下拉选项 = 当前 `columns` 中非 deleted 的列名列表
- 引用表/列为自由文本输入（不依赖当前连接 schema）
- ON DELETE/ON UPDATE 使用 `DropdownSelect`，固定选项：`NO ACTION / CASCADE / SET NULL / RESTRICT / SET DEFAULT`

### 索引 Tab

```
索引名         | 类型       | 列（JSON）                        | 操作
---------------|------------|-----------------------------------|-----
idx_user_email | [UNIQUE ▼] | [{"name":"email","order":"ASC"}]  | 🗑

[+ 添加索引]
```

复用已有 `TableFormIndex` 类型和 `generateIndexCreateSql` 逻辑。列字段为自由文本 JSON，与 `TableFormAdapter` 现有解析一致。

### 新增本地 state

```typescript
const [activeTab, setActiveTab] = useState<'columns' | 'foreignKeys' | 'indexes'>('columns')
const [foreignKeys, setForeignKeys] = useState<TableFormForeignKey[]>([])
const [originalForeignKeys, setOriginalForeignKeys] = useState<TableFormForeignKey[]>([])
const [indexes, setIndexes] = useState<TableFormIndex[]>([])
const [originalIndexes, setOriginalIndexes] = useState<TableFormIndex[]>([])
```

加载已有表时，从 `get_table_detail` 返回结果同时映射 `foreign_keys` → `foreignKeys`，`indexes`（若有）→ `indexes`。

> **已知限制：** 现有 `ForeignKeyMeta` 类型（`get_table_detail` 返回值）不含 `onDelete`/`onUpdate` 字段，加载已有表的 FK 时这两项默认填 `NO ACTION`。用户若需要修改 ON DELETE/ON UPDATE，需在外键 tab 手动调整后执行 ALTER。

---

## 改动文件清单

| 文件 | 改动性质 |
|------|---------|
| `src-tauri/src/graph/comment_parser.rs` | 新增 `ParsedComment` 结构体、`parse_comment()` 函数、6 条测试 |
| `src/store/tableFormStore.ts` | 新增 `TableFormForeignKey` 接口，`TableFormState` 加 `foreignKeys` / `originalForeignKeys` |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | 新增 FK SQL 生成辅助函数，扩展 `generateCreateSql` / `generateAlterSql`，追加 MCP patch capabilities |
| `src/components/TableManageDialog/index.tsx` | Tab 布局、字段 tab 加 Comment 列、外键 tab 新增、索引 tab 激活 |

---

## 不在本次范围内

- 引用表/列的联想补全（依赖当前连接 schema，留给后续迭代）
- comment 标记自动联动 FK 列表（用户选择了方案 C：两者分离）
- ER Designer 与 TableManageDialog 的 FK 数据共享
