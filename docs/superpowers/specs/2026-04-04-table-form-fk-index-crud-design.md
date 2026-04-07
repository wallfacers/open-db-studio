# 设计文档：TableForm 外键与索引 AI CRUD 支持

**日期**：2026-04-04  
**状态**：已确认，待实现  
**关联功能**：TableStructureView 外键 Tab、MCP `ui_exec` / `init_table_form`

---

## 背景与动机

近期新增了两处外键管理 UI：

1. **TableStructureView**（表单模式）— 新增外键 Tab，支持完整 CRUD
2. **ER 设计器**（ERPropertyDrawer）— 编辑表抽屉中可管理关系/外键

当前 AI（通过 MCP 工具）在 ER 模式下已能完整操作外键（`er_batch` + `add_relation` 等），但在**表单模式**下存在两个缺口：

- `init_table_form` 初始化时无法传入外键参数
- `TableFormAdapter` 缺少外键和索引的语义化 `ui_exec` 动作（只有 JSON Patch 路径）

---

## 范围

### 本次做

1. `init_table_form` 扩展 `foreignKeys` 可选初始化参数
2. `TableFormAdapter` 新增 6 个 `ui_exec` 命名动作（外键 3 个 + 索引 3 个）
3. 补全对应的 MCP schema 描述，确保 AI 可发现

### 不做（后续）

- `table_batch` 多表批量操作工具
- Rust 侧独立 FK SQL 生成工具（`generate_add_fk_sql` 等）
- ER 模式改动（已完整，不动）

---

## 约束

- AI 只改表单状态，**不触发 SQL 执行**；用户点"执行"按钮才提交
- `ui_exec` 风格与 ER 模式保持一致（语义化动作名，参数扁平）
- 自动生成命名（约束名、索引名）逻辑复用现有前端逻辑

---

## 设计详情

### 1. `init_table_form` 参数扩展

在现有参数基础上增加可选的 `foreignKeys` 数组：

```typescript
init_table_form({
  connection_id: number,
  database: string,
  table_name: string,
  columns?: ColumnDef[],
  indexes?: IndexDef[],
  foreignKeys?: ForeignKeyInit[]   // ← 新增
})

interface ForeignKeyInit {
  constraintName?: string     // 不传时自动生成：fk_{tableName}_{column}
  column: string              // 本表列名（必填）
  referencedTable: string     // 引用目标表名（必填）
  referencedColumn: string    // 引用目标列名（必填）
  onDelete?: string           // 默认 'NO ACTION'
  onUpdate?: string           // 默认 'NO ACTION'
}
```

**实现**：`TableFormAdapter.ts` 初始化逻辑中，将 `foreignKeys` 注入 store 初始状态，每条记录补充 `_isNew: true` 标记。

---

### 2. `ui_exec` 命名动作

#### 外键动作

| 动作名 | 描述 | 必填参数 | 可选参数 |
|-------|------|---------|---------|
| `add_foreign_key` | 新增一条外键约束 | `column`, `referencedTable`, `referencedColumn` | `constraintName`, `onDelete`, `onUpdate` |
| `update_foreign_key` | 修改已有外键的属性 | `constraintName`（定位） | `column`, `referencedTable`, `referencedColumn`, `onDelete`, `onUpdate` |
| `remove_foreign_key` | 删除指定外键约束 | `constraintName` | — |

**级联选项枚举**（`onDelete` / `onUpdate`）：
```
NO ACTION | CASCADE | SET NULL | RESTRICT | SET DEFAULT
```

#### 索引动作

| 动作名 | 描述 | 必填参数 | 可选参数 |
|-------|------|---------|---------|
| `add_index` | 新增一条索引 | `columns`（string[]） | `name`（不传自动生成）, `type` |
| `update_index` | 修改已有索引属性 | `name`（定位） | `columns`, `type` |
| `remove_index` | 删除指定索引 | `name` | — |

**索引类型枚举**（`type`）：
```
NORMAL | UNIQUE | FULLTEXT | SPATIAL
```

#### AI 调用示例

```jsonc
// 添加外键
{
  "object": "table_form",
  "action": "add_foreign_key",
  "params": {
    "column": "user_id",
    "referencedTable": "users",
    "referencedColumn": "id",
    "onDelete": "CASCADE"
  }
}

// 修改外键级联选项
{
  "object": "table_form",
  "action": "update_foreign_key",
  "params": {
    "constraintName": "fk_orders_user_id",
    "onDelete": "SET NULL"
  }
}

// 删除外键
{
  "object": "table_form",
  "action": "remove_foreign_key",
  "params": { "constraintName": "fk_orders_user_id" }
}

// 添加唯一索引
{
  "object": "table_form",
  "action": "add_index",
  "params": {
    "name": "idx_email_unique",
    "columns": ["email"],
    "type": "UNIQUE"
  }
}

// 删除索引
{
  "object": "table_form",
  "action": "remove_index",
  "params": { "name": "idx_status" }
}
```

---

### 3. MCP Schema 描述更新

#### `TableFormAdapter.getSchema()` — actions 节

新增 6 个 action 的完整 `paramsSchema`（JSON Schema），包含：
- 每个字段的 `description`
- `onDelete` / `onUpdate` 的 `enum` 约束
- `type`（索引类型）的 `enum` 约束
- `columns` 的 `type: array, items: { type: string }` 定义

#### `init_table_form` 工具描述（`mcp/mod.rs`）

`foreignKeys` 字段描述中注明：
- 可在初始化时传入，也可事后通过 `ui_exec` 的 `add_foreign_key` 追加
- `constraintName` 不传时自动生成为 `fk_{tableName}_{column}`

#### `ui_read` actions 模式响应

`mode: "actions"` 的响应中新增这 6 个 exec 动作的描述条目，AI 读完即知可用操作。

---

## 改动文件汇总

| 文件 | 改动内容 |
|-----|---------|
| `src/mcp/ui/adapters/TableFormAdapter.ts` | 新增 6 个 exec actions 处理逻辑 + 补全 schema 描述 + 初始化注入 `foreignKeys` |
| `src-tauri/src/mcp/mod.rs` | `init_table_form` 参数 schema 增加 `foreignKeys` 字段及描述 |

**仅改两个文件，不动 Rust 业务逻辑。**

---

## ER 模式现状（参考，不改动）

ER 模式已通过 `ERCanvasAdapter` 完整支持外键（关系）操作：

| 动作 | 工具 |
|-----|-----|
| 新增关系 | `ui_exec` → `add_relation` 或 `er_batch` |
| 修改关系 | `ui_exec` → `update_relation` |
| 删除关系 | `ui_exec` → `delete_relation` |

本次改动后，两种模式的 AI 操作体验将趋于一致。

---

## 验收标准

1. AI 可通过 `init_table_form` 一步创建带外键的表单
2. AI 可通过 `ui_exec` 对已打开的 table_form 单独增删改外键
3. AI 可通过 `ui_exec` 对已打开的 table_form 单独增删改索引
4. 所有动作执行后，TableStructureView UI 立即反映最新状态
5. 用户点执行后，生成的 SQL 包含正确的外键约束和索引定义
6. `ui_read mode=actions` 能返回这 6 个新动作的描述
