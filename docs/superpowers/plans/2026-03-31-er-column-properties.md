# ER 设计器字段属性完整编辑系统 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ER 设计器实现字段级/表级/索引级属性的完整编辑能力，包含画布类型长度显示、侧边栏全量编辑表格、右侧抽屉面板。

**Architecture:** 模块化重构 — 抽取 `shared/` 共享组件层（类型注册表、ColumnPropertyEditor、IndexEditor），三层 UI（画布/侧边栏/抽屉）复用同一套编辑原语。Rust 层扩展 ErColumn 模型 8 个新字段，data_type 改为只存基础类型名，length/scale 独立存储。

**Tech Stack:** React 18, TypeScript, Zustand, React Flow, Tailwind CSS, Rust (rusqlite), Tauri 2.x IPC

**Spec:** `docs/superpowers/specs/2026-03-31-er-column-properties-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/components/ERDesigner/shared/dataTypes.ts` | 按方言分组的数据类型注册表 + formatTypeDisplay 工具函数 |
| `src/components/ERDesigner/shared/TypeLengthDisplay.tsx` | 类型+长度 展示/编辑组件 |
| `src/components/ERDesigner/shared/ColumnPropertyEditor.tsx` | 字段属性编辑器 (compact/full 双模式) |
| `src/components/ERDesigner/shared/IndexEditor.tsx` | 索引列表+展开编辑组件 |
| `src/components/ERDesigner/shared/CompatibilityWarning.tsx` | 方言兼容性警告图标 |
| `src/components/ERDesigner/ERPropertyDrawer/index.tsx` | 抽屉容器（滑入动画、Tab 切换） |
| `src/components/ERDesigner/ERPropertyDrawer/ColumnsTab.tsx` | 抽屉「列」Tab |
| `src/components/ERDesigner/ERPropertyDrawer/IndexesTab.tsx` | 抽屉「索引」Tab |
| `src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx` | 抽屉「表属性」Tab |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/er/models.rs` | ErColumn struct +8 字段, CreateColumnRequest +8, UpdateColumnRequest +8 |
| `src-tauri/src/er/repository.rs` | COLUMN_COLS, row_to_column, create_column, update_column SQL |
| `src-tauri/src/er/ddl_generator.rs` | 移除 parse_type(), 更新 map_column_type() 用 length/scale |
| `src-tauri/src/db/migrations.rs` | 新增 er_columns 8 列迁移 + data_type 数据清洗 |
| `schema/init.sql` | er_columns 表 +8 列 |
| `src/types/index.ts` | ErColumn 接口 +8 字段 |
| `src/store/erDesignerStore.ts` | 新增 drawer state/actions, dialect state, compatibility actions |
| `src/components/ERDesigner/ERCanvas/ERTableNode.tsx` | 类型显示改用 formatTypeDisplay, 下拉改用注册表 |
| `src/components/ERDesigner/ERSidebar/index.tsx` | 列区域重写为表格布局 |
| `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx` | addColumn 默认值扩展 |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 画布区域 flex 适配抽屉 |

---

## Chunk 1: Rust 层数据模型与迁移

### Task 1: SQLite schema 扩展

**Files:**
- Modify: `schema/init.sql:349-363`

- [ ] **Step 1: 在 er_columns 表定义中添加新列**

在 `sort_order` 行之后、`created_at` 行之前插入：

```sql
    length          INTEGER,
    scale           INTEGER,
    is_unique       INTEGER DEFAULT 0,
    unsigned        INTEGER DEFAULT 0,
    charset         TEXT,
    collation       TEXT,
    on_update       TEXT,
    enum_values     TEXT,
```

- [ ] **Step 2: 验证 SQL 语法**

Run: `cd src-tauri && cargo check 2>&1 | head -5`
Expected: 编译通过（init.sql 是 include_str! 引入的文本，不做编译检查，但确保格式正确）

- [ ] **Step 3: Commit**

```bash
git add schema/init.sql
git commit -m "schema: add 8 new columns to er_columns table"
```

---

### Task 2: 数据库迁移逻辑

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`

- [ ] **Step 1: 在 run_migrations() 末尾追加 er_columns 迁移**

在现有迁移代码之后（文件末尾 `Ok(())` 之前）追加：

```rust
    // ── V8: ER column extended properties ──
    {
        let new_cols = [
            ("length",      "INTEGER"),
            ("scale",       "INTEGER"),
            ("is_unique",   "INTEGER NOT NULL DEFAULT 0"),
            ("unsigned",    "INTEGER NOT NULL DEFAULT 0"),
            ("charset",     "TEXT"),
            ("collation",   "TEXT"),
            ("on_update",   "TEXT"),
            ("enum_values", "TEXT"),
        ];
        for (col_name, col_type) in &new_cols {
            let sql = format!("ALTER TABLE er_columns ADD COLUMN {} {}", col_name, col_type);
            match conn.execute(&sql, []) {
                Ok(_) => log::info!("Migration V8: added er_columns.{}", col_name),
                Err(e) if e.to_string().contains("duplicate column name") => {}
                Err(e) => log::warn!("Migration V8: failed to add er_columns.{}: {}", col_name, e),
            }
        }

        // 数据清洗：解析已有 data_type 中的括号部分，拆分到 length/scale
        let _ = conn.execute_batch("
            UPDATE er_columns
            SET length = CAST(SUBSTR(data_type, INSTR(data_type, '(') + 1,
                    CASE WHEN INSTR(data_type, ',') > 0
                         THEN INSTR(data_type, ',') - INSTR(data_type, '(') - 1
                         ELSE INSTR(data_type, ')') - INSTR(data_type, '(') - 1
                    END) AS INTEGER),
                scale = CASE WHEN INSTR(data_type, ',') > 0
                    THEN CAST(SUBSTR(data_type, INSTR(data_type, ',') + 1,
                              INSTR(data_type, ')') - INSTR(data_type, ',') - 1) AS INTEGER)
                    ELSE NULL END,
                data_type = SUBSTR(data_type, 1, INSTR(data_type, '(') - 1)
            WHERE INSTR(data_type, '(') > 0 AND length IS NULL;
        ");
        log::info!("Migration V8: data_type cleanup completed");
    }
```

- [ ] **Step 2: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/migrations.rs
git commit -m "feat(er): add V8 migration for column extended properties"
```

---

### Task 3: Rust ErColumn 模型扩展

**Files:**
- Modify: `src-tauri/src/er/models.rs:32-45` (ErColumn)
- Modify: `src-tauri/src/er/models.rs:128-138` (CreateColumnRequest)
- Modify: `src-tauri/src/er/models.rs:141-150` (UpdateColumnRequest)

- [ ] **Step 1: 扩展 ErColumn struct**

在 `comment` 和 `sort_order` 之间添加 8 个新字段：

```rust
pub struct ErColumn {
    pub id: i64,
    pub table_id: i64,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    pub comment: Option<String>,
    // ── 新增字段 ──
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: bool,
    pub unsigned: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,  // JSON 数组字符串
    // ──────────────
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: 扩展 CreateColumnRequest**

在现有字段后追加：

```rust
pub struct CreateColumnRequest {
    // ... 现有字段 ...
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: Option<bool>,
    pub unsigned: Option<bool>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,
}
```

- [ ] **Step 3: 扩展 UpdateColumnRequest**

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateColumnRequest {
    pub name: Option<String>,
    pub data_type: Option<String>,
    pub nullable: Option<bool>,
    pub default_value: Option<String>,
    pub is_primary_key: Option<bool>,
    pub is_auto_increment: Option<bool>,
    pub comment: Option<String>,
    pub sort_order: Option<i64>,
    // 新增
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: Option<bool>,
    pub unsigned: Option<bool>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,
}
```

- [ ] **Step 4: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译报错（repository.rs 尚未更新），记录需修复的位置

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/er/models.rs
git commit -m "feat(er): extend ErColumn model with 8 new properties"
```

---

### Task 4: Repository 层更新

**Files:**
- Modify: `src-tauri/src/er/repository.rs:59-60` (COLUMN_COLS)
- Modify: `src-tauri/src/er/repository.rs:42-57` (row_to_column)
- Modify: `src-tauri/src/er/repository.rs:334-377` (create_column)
- Modify: `src-tauri/src/er/repository.rs:379-425` (update_column)

- [ ] **Step 1: 更新 COLUMN_COLS 常量**

```rust
const COLUMN_COLS: &str =
    "id, table_id, name, data_type, nullable, default_value, is_primary_key, is_auto_increment, comment, length, scale, is_unique, unsigned, charset, collation, on_update, enum_values, sort_order, created_at, updated_at";
```

- [ ] **Step 2: 更新 row_to_column 映射**

新字段在 comment(index=8) 之后，sort_order 之前：

```rust
fn row_to_column(row: &rusqlite::Row) -> rusqlite::Result<ErColumn> {
    Ok(ErColumn {
        id: row.get(0)?,
        table_id: row.get(1)?,
        name: row.get(2)?,
        data_type: row.get(3)?,
        nullable: row.get(4)?,
        default_value: row.get(5)?,
        is_primary_key: row.get(6)?,
        is_auto_increment: row.get(7)?,
        comment: row.get(8)?,
        length: row.get(9)?,
        scale: row.get(10)?,
        is_unique: row.get(11)?,
        unsigned: row.get(12)?,
        charset: row.get(13)?,
        collation: row.get(14)?,
        on_update: row.get(15)?,
        enum_values: row.get(16)?,
        sort_order: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}
```

- [ ] **Step 3: 更新 create_column INSERT**

INSERT 语句扩展新列和参数：

```rust
conn.execute(
    "INSERT INTO er_columns (table_id, name, data_type, nullable, default_value, is_primary_key, is_auto_increment, comment, length, scale, is_unique, unsigned, charset, collation, on_update, enum_values, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
    rusqlite::params![
        req.table_id,
        req.name,
        req.data_type,
        req.nullable.unwrap_or(true),
        req.default_value,
        req.is_primary_key.unwrap_or(false),
        req.is_auto_increment.unwrap_or(false),
        req.comment,
        req.length,
        req.scale,
        req.is_unique.unwrap_or(false),
        req.unsigned.unwrap_or(false),
        req.charset,
        req.collation,
        req.on_update,
        req.enum_values,
        sort_order,
        &now,
        &now,
    ],
)?;
```

- [ ] **Step 4: 更新 update_column 的 maybe_set! 宏调用**

在现有 `maybe_set!(req.comment, "comment")` 之后追加：

```rust
maybe_set!(req.length, "length");
maybe_set!(req.scale, "scale");
maybe_set!(req.is_unique, "is_unique");
maybe_set!(req.unsigned, "unsigned");
maybe_set!(req.charset, "charset");
maybe_set!(req.collation, "collation");
maybe_set!(req.on_update, "on_update");
maybe_set!(req.enum_values, "enum_values");
```

- [ ] **Step 5: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/er/repository.rs
git commit -m "feat(er): update repository SQL for 8 new column properties"
```

---

### Task 5: DDL 生成器更新

**Files:**
- Modify: `src-tauri/src/er/ddl_generator.rs`

- [ ] **Step 1: 移除 parse_type() 函数**

删除 `ddl_generator.rs:183-189` 的 `parse_type()` 函数。

- [ ] **Step 2: 更新 DdlDialect trait 的 map_column_type 默认实现**

将默认 `map_column_type` 改为使用 length/scale 字段：

```rust
fn map_column_type(&self, col: &ErColumn) -> String {
    let base = self.map_type(&col.data_type);
    match (col.length, col.scale) {
        (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
        (Some(l), None)    => format!("{}({})", base, l),
        _                  => base,
    }
}
```

- [ ] **Step 3: 更新各方言 map_type() 中的 map_type_with 调用**

当前 `map_type_with()` 辅助函数内部调用了 `parse_type()`。重写 `map_type_with` 为只做基础类型名映射（不再处理括号）：

```rust
fn map_type_with(generic_type: &str, mapper: &dyn Fn(&str) -> &str) -> String {
    let upper = generic_type.to_uppercase();
    mapper(&upper).to_string()
}
```

- [ ] **Step 4: 更新 PostgreSQL map_column_type 特殊处理**

PostgreSQL 的 `map_column_type` 有自增特殊逻辑（INT→SERIAL），保留该逻辑但改用 length/scale：

```rust
fn map_column_type(&self, col: &ErColumn) -> String {
    if col.is_auto_increment {
        return match col.data_type.to_uppercase().as_str() {
            "INT" | "INTEGER" => "SERIAL".to_string(),
            "BIGINT" => "BIGSERIAL".to_string(),
            "SMALLINT" => "SMALLSERIAL".to_string(),
            _ => {
                let base = self.map_type(&col.data_type);
                match (col.length, col.scale) {
                    (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
                    (Some(l), None)    => format!("{}({})", base, l),
                    _                  => base,
                }
            }
        };
    }
    let base = self.map_type(&col.data_type);
    match (col.length, col.scale) {
        (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
        (Some(l), None)    => format!("{}({})", base, l),
        _                  => base,
    }
}
```

- [ ] **Step 5: 在 create_table 默认实现中添加 UNIQUE/UNSIGNED/DEFAULT/COMMENT 输出**

在 `DdlDialect::create_table` 方法的列定义拼接部分（当前只拼接 `col_type` 和 `NOT NULL`），追加：

```rust
// 在 NOT NULL 之后追加
if col.unsigned {
    col_def.push_str(" UNSIGNED");
}
if col.is_unique && !col.is_primary_key {
    col_def.push_str(" UNIQUE");
}
if let Some(ref dv) = col.default_value {
    col_def.push_str(&format!(" DEFAULT {}", dv));
}
if let Some(ref ou) = col.on_update {
    col_def.push_str(&format!(" ON UPDATE {}", ou));
}
// ENUM 值列表（MySQL）
if let Some(ref ev) = col.enum_values {
    if let Ok(vals) = serde_json::from_str::<Vec<String>>(ev) {
        if !vals.is_empty() && col.data_type.to_uppercase() == "ENUM" {
            let quoted: Vec<String> = vals.iter().map(|v| format!("'{}'", v)).collect();
            // 替换类型定义为 ENUM('a','b','c')
            // 注意：这段逻辑需在 map_column_type 返回前处理
        }
    }
}
```

同时在各方言的 `inline_column_comment()` 方法中（当前 MySQL 已实现，返回 `COMMENT 'xxx'`），确保 `col.comment` 能正确输出。当前实现已读取 `col.comment`，无需额外修改。

对于 ENUM 类型的 DDL 输出，更精确的做法是在 MySQL 方言的 `map_column_type()` 中处理：

```rust
// 在 MySqlDialect 中覆盖 map_column_type
fn map_column_type(&self, col: &ErColumn) -> String {
    let upper = col.data_type.to_uppercase();
    if upper == "ENUM" || upper == "SET" {
        if let Some(ref ev) = col.enum_values {
            if let Ok(vals) = serde_json::from_str::<Vec<String>>(ev) {
                let quoted: Vec<String> = vals.iter().map(|v| format!("'{}'", v)).collect();
                return format!("{}({})", upper, quoted.join(","));
            }
        }
        return upper;
    }
    let base = self.map_type(&col.data_type);
    match (col.length, col.scale) {
        (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
        (Some(l), None)    => format!("{}({})", base, l),
        _                  => base,
    }
}
```

- [ ] **Step 6: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/er/ddl_generator.rs
git commit -m "feat(er): update DDL generator to use structured length/scale fields"
```

---

### Task 6: TypeScript 类型与 Store 基础扩展

**Files:**
- Modify: `src/types/index.ts:461-474`
- Modify: `src/store/erDesignerStore.ts:41-110`
- Modify: `src/components/ERDesigner/ERSidebar/TableContextMenu.tsx:60-73`

- [ ] **Step 1: 扩展 ErColumn 接口**

在 `comment` 之后、`sort_order` 之前添加：

```typescript
export interface ErColumn {
  // ... 现有字段 ...
  comment: string | null;
  // 新增
  length: number | null;
  scale: number | null;
  is_unique: boolean;
  unsigned: boolean;
  charset: string | null;
  collation: string | null;
  on_update: string | null;
  enum_values: string[] | null;  // 前端用数组，Rust 传 JSON 字符串
  // ──
  sort_order: number;
  created_at: string;
  updated_at: string;
}
```

注意：`enum_values` 在前端是 `string[]`，传给 Rust 时需 `JSON.stringify()`，从 Rust 接收时需 `JSON.parse()`。

- [ ] **Step 2: 更新 Store addColumn 调用处**

在 `erDesignerStore.ts` 的 `addColumn` action 中，invoke 传递数据时处理 `enum_values` 序列化：

```typescript
addColumn: async (tableId, column) => {
  try {
    const req = { table_id: tableId, ...column };
    if (req.enum_values) {
      (req as any).enum_values = JSON.stringify(req.enum_values);
    }
    const created = await invoke<any>('er_create_column', { req });
    // 反序列化 enum_values
    if (created.enum_values && typeof created.enum_values === 'string') {
      created.enum_values = JSON.parse(created.enum_values);
    }
    set((s) => ({
      columns: {
        ...s.columns,
        [tableId]: [...(s.columns[tableId] ?? []), created as ErColumn],
      },
    }));
    return created as ErColumn;
  } catch (e) {
    console.error('Failed to add ER column:', e);
    throw e;
  }
},
```

对 `updateColumn` 做同样的序列化/反序列化处理：

```typescript
updateColumn: async (id, updates) => {
  try {
    const req = { ...updates };
    if (req.enum_values && Array.isArray(req.enum_values)) {
      (req as any).enum_values = JSON.stringify(req.enum_values);
    }
    await invoke('er_update_column', { id, req });
    set((s) => {
      const newColumns = { ...s.columns };
      for (const tableId of Object.keys(newColumns)) {
        const tid = Number(tableId);
        newColumns[tid] = newColumns[tid].map((c) =>
          c.id === id ? { ...c, ...updates } : c
        );
      }
      return { columns: newColumns };
    });
  } catch (e) {
    console.error('Failed to update ER column:', e);
  }
},
```

对 `loadProject` 中接收的列数据做批量反序列化：

```typescript
// 在 loadProject action 中，从 Rust 获取 full 数据后
for (const tf of full.tables) {
  tf.columns = tf.columns.map((col: any) => ({
    ...col,
    enum_values: col.enum_values ? JSON.parse(col.enum_values) : null,
  }));
}
```

- [ ] **Step 3: 更新 Store state 接口添加 drawer 和兼容性状态**

在 ErDesignerState 接口中追加：

```typescript
// 抽屉面板状态
drawerOpen: boolean;
drawerTableId: number | null;
drawerFocusColumnId: number | null;
openDrawer: (tableId: number, focusColumnId?: number) => void;
closeDrawer: () => void;

// 方言兼容性
boundDialect: string | null;
dialectWarnings: Record<number, string>;
checkDialectCompatibility: () => void;
checkColumnCompatibility: (columnId: number) => void;
clearDialectWarnings: () => void;
```

- [ ] **Step 4: 实现 drawer actions**

```typescript
drawerOpen: false,
drawerTableId: null,
drawerFocusColumnId: null,
openDrawer: (tableId, focusColumnId) => set({
  drawerOpen: true,
  drawerTableId: tableId,
  drawerFocusColumnId: focusColumnId ?? null,
}),
closeDrawer: () => set({
  drawerOpen: false,
  drawerTableId: null,
  drawerFocusColumnId: null,
}),
```

- [ ] **Step 5: 更新 TableContextMenu addColumn 默认值**

```typescript
await addColumn(tableId, {
  name: `column_${cols.length + 1}`,
  data_type: 'VARCHAR',
  nullable: true,
  default_value: null,
  is_primary_key: false,
  is_auto_increment: false,
  comment: null,
  length: null,
  scale: null,
  is_unique: false,
  unsigned: false,
  charset: null,
  collation: null,
  on_update: null,
  enum_values: null,
  sort_order: cols.length,
});
```

- [ ] **Step 6: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误（可能有一些现有的，记录新增的错误数为 0）

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/store/erDesignerStore.ts src/components/ERDesigner/ERSidebar/TableContextMenu.tsx
git commit -m "feat(er): extend TypeScript types and store for column properties"
```

---

## Chunk 2: 数据类型注册表与共享组件

### Task 7: 数据类型注册表

**Files:**
- Create: `src/components/ERDesigner/shared/dataTypes.ts`

- [ ] **Step 1: 创建类型定义和注册表**

```typescript
export interface DataTypeDefinition {
  name: string;
  category: 'numeric' | 'string' | 'datetime' | 'binary' | 'json' | 'spatial' | 'other';
  hasLength: boolean;
  hasScale: boolean;
  hasUnsigned: boolean;
  hasEnumValues: boolean;
  defaultLength: number | null;
  defaultScale: number | null;
}

export type DialectName = 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite';

export const DIALECT_TYPES: Record<DialectName, DataTypeDefinition[]> = {
  mysql: [
    // numeric
    { name: 'TINYINT',   category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: true,  hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'SMALLINT',  category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: true,  hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'MEDIUMINT', category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: true,  hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'INT',       category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: true,  hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BIGINT',    category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: true,  hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DECIMAL',   category: 'numeric',  hasLength: true,  hasScale: true,  hasUnsigned: true,  hasEnumValues: false, defaultLength: 10,   defaultScale: 2 },
    { name: 'FLOAT',     category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DOUBLE',    category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // string
    { name: 'CHAR',      category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'VARCHAR',   category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'TINYTEXT',  category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TEXT',       category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'MEDIUMTEXT',category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'LONGTEXT',  category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'ENUM',      category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: true,  defaultLength: null, defaultScale: null },
    { name: 'SET',       category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: true,  defaultLength: null, defaultScale: null },
    // datetime
    { name: 'DATE',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DATETIME',  category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIMESTAMP', category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIME',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // binary
    { name: 'BINARY',    category: 'binary',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'VARBINARY', category: 'binary',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'BLOB',      category: 'binary',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // json
    { name: 'JSON',      category: 'json',     hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // other
    { name: 'BOOLEAN',   category: 'other',    hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
  ],
  postgresql: [
    // numeric
    { name: 'SMALLINT',  category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'INTEGER',   category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BIGINT',    category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'SERIAL',    category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BIGSERIAL', category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'NUMERIC',   category: 'numeric',  hasLength: true,  hasScale: true,  hasUnsigned: false, hasEnumValues: false, defaultLength: 10,   defaultScale: 2 },
    { name: 'REAL',      category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DOUBLE PRECISION', category: 'numeric', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'MONEY',     category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // string
    { name: 'CHAR',      category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'VARCHAR',   category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'TEXT',       category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // datetime
    { name: 'DATE',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIMESTAMP', category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIME',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'INTERVAL',  category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // binary
    { name: 'BYTEA',     category: 'binary',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // json
    { name: 'JSON',      category: 'json',     hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'JSONB',     category: 'json',     hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    // other
    { name: 'BOOLEAN',   category: 'other',    hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'UUID',      category: 'other',    hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
  ],
  oracle: [
    { name: 'NUMBER',    category: 'numeric',  hasLength: true,  hasScale: true,  hasUnsigned: false, hasEnumValues: false, defaultLength: 10,   defaultScale: 0 },
    { name: 'FLOAT',     category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'CHAR',      category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'VARCHAR2',  category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'NVARCHAR2', category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'CLOB',      category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'NCLOB',     category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DATE',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIMESTAMP', category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BLOB',      category: 'binary',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'RAW',       category: 'binary',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 2000, defaultScale: null },
  ],
  sqlserver: [
    { name: 'TINYINT',   category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'SMALLINT',  category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'INT',       category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BIGINT',    category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DECIMAL',   category: 'numeric',  hasLength: true,  hasScale: true,  hasUnsigned: false, hasEnumValues: false, defaultLength: 18,   defaultScale: 0 },
    { name: 'MONEY',     category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'FLOAT',     category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BIT',       category: 'other',    hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'CHAR',      category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'VARCHAR',   category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'NCHAR',     category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 1,    defaultScale: null },
    { name: 'NVARCHAR',  category: 'string',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: 255,  defaultScale: null },
    { name: 'TEXT',       category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'NTEXT',     category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DATE',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'DATETIME2', category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TIME',      category: 'datetime', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'VARBINARY', category: 'binary',   hasLength: true,  hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'UNIQUEIDENTIFIER', category: 'other', hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
  ],
  sqlite: [
    { name: 'INTEGER',   category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'REAL',      category: 'numeric',  hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'TEXT',       category: 'string',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'BLOB',      category: 'binary',   hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
    { name: 'NUMERIC',   category: 'numeric',  hasLength: true,  hasScale: true,  hasUnsigned: false, hasEnumValues: false, defaultLength: 10,   defaultScale: 2 },
    { name: 'BOOLEAN',   category: 'other',    hasLength: false, hasScale: false, hasUnsigned: false, hasEnumValues: false, defaultLength: null, defaultScale: null },
  ],
};
```

- [ ] **Step 2: 添加工具函数**

```typescript
import type { ErColumn } from '@/types';

/** 获取指定方言的类型列表，未绑定时返回所有方言的并集 */
export function getTypeOptions(dialect: DialectName | null): { value: string; label: string; category: string }[] {
  if (dialect) {
    return (DIALECT_TYPES[dialect] || []).map(t => ({
      value: t.name, label: t.name, category: t.category,
    }));
  }
  // 并集去重
  const seen = new Set<string>();
  const result: { value: string; label: string; category: string }[] = [];
  for (const types of Object.values(DIALECT_TYPES)) {
    for (const t of types) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        result.push({ value: t.name, label: t.name, category: t.category });
      }
    }
  }
  return result;
}

/** 查找类型定义（在指定方言或全部中查找） */
export function findTypeDef(typeName: string, dialect: DialectName | null): DataTypeDefinition | undefined {
  const upper = typeName.toUpperCase();
  if (dialect) {
    return DIALECT_TYPES[dialect]?.find(t => t.name === upper);
  }
  for (const types of Object.values(DIALECT_TYPES)) {
    const found = types.find(t => t.name === upper);
    if (found) return found;
  }
  return undefined;
}

/** 拼接类型显示文本：VARCHAR(255)、DECIMAL(10,2)、INT */
export function formatTypeDisplay(column: Pick<ErColumn, 'data_type' | 'length' | 'scale'>): string {
  const { data_type, length, scale } = column;
  if (length != null && scale != null) return `${data_type}(${length},${scale})`;
  if (length != null) return `${data_type}(${length})`;
  return data_type;
}

/** 检查类型是否兼容指定方言 */
export function checkTypeCompatibility(typeName: string, dialect: DialectName): string | null {
  const upper = typeName.toUpperCase();
  const types = DIALECT_TYPES[dialect];
  if (!types) return null;
  if (types.some(t => t.name === upper)) return null;
  // 查找建议替代
  const suggestions: Record<string, Record<string, string>> = {
    mysql: { JSONB: 'JSON', SERIAL: 'INT + AUTO_INCREMENT', UUID: 'CHAR(36)', BYTEA: 'BLOB' },
    postgresql: { TINYINT: 'SMALLINT', MEDIUMINT: 'INTEGER', DOUBLE: 'DOUBLE PRECISION', DATETIME: 'TIMESTAMP', ENUM: 'TEXT + CHECK' },
    oracle: { BOOLEAN: 'NUMBER(1)', VARCHAR: 'VARCHAR2', TEXT: 'CLOB', JSON: 'CLOB', BIGINT: 'NUMBER(19)' },
    sqlserver: { BOOLEAN: 'BIT', TEXT: 'NVARCHAR(MAX)', TIMESTAMP: 'DATETIME2', SERIAL: 'INT IDENTITY' },
    sqlite: { VARCHAR: 'TEXT', DATETIME: 'TEXT', BOOLEAN: 'INTEGER' },
  };
  const suggestion = suggestions[dialect]?.[upper];
  if (suggestion) return `${typeName} 不是 ${dialect} 支持的类型，建议改为 ${suggestion}`;
  return `${typeName} 不是 ${dialect} 支持的类型`;
}
```

- [ ] **Step 3: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/ERDesigner/shared/dataTypes.ts
git commit -m "feat(er): add dialect-aware data type registry"
```

---

### Task 8: TypeLengthDisplay 组件

**Files:**
- Create: `src/components/ERDesigner/shared/TypeLengthDisplay.tsx`

- [ ] **Step 1: 创建组件**

组件接收 column 数据 + 方言信息 + mode（display/edit）：

```typescript
import { useState, useRef, useEffect } from 'react';
import { formatTypeDisplay, getTypeOptions, findTypeDef, type DialectName } from './dataTypes';
import DropdownSelect from '@/components/common/DropdownSelect';
import type { ErColumn } from '@/types';

interface TypeLengthDisplayProps {
  column: ErColumn;
  dialect: DialectName | null;
  mode: 'display' | 'edit';
  onChange: (updates: Partial<ErColumn>) => void;
}
```

- **display 模式**：只渲染 `formatTypeDisplay(column)` 文本
- **edit 模式**：类型下拉 + 条件渲染长度/精度输入框。类型切换时根据 `findTypeDef()` 自动填入 defaultLength/defaultScale 或清空。长度/精度输入用 `<input type="number">` 带 `bg-[#151d28] border-[#2a3f5a]` 样式。ENUM 类型显示「编辑值列表...」按钮。

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/shared/TypeLengthDisplay.tsx
git commit -m "feat(er): add TypeLengthDisplay shared component"
```

---

### Task 9: CompatibilityWarning 组件

**Files:**
- Create: `src/components/ERDesigner/shared/CompatibilityWarning.tsx`

- [ ] **Step 1: 创建组件**

```typescript
import { AlertTriangle } from 'lucide-react';
import { checkTypeCompatibility, type DialectName } from './dataTypes';

interface CompatibilityWarningProps {
  typeName: string;
  dialect: DialectName | null;
}

export default function CompatibilityWarning({ typeName, dialect }: CompatibilityWarningProps) {
  if (!dialect) return null;
  const warning = checkTypeCompatibility(typeName, dialect);
  if (!warning) return null;
  return (
    <span className="relative group" title={warning}>
      <AlertTriangle size={12} className="text-[#f59e0b]" />
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ERDesigner/shared/CompatibilityWarning.tsx
git commit -m "feat(er): add CompatibilityWarning component"
```

---

### Task 10: ColumnPropertyEditor 组件

**Files:**
- Create: `src/components/ERDesigner/shared/ColumnPropertyEditor.tsx`

- [ ] **Step 1: 创建 compact 模式**

compact 模式渲染单行：PK 图标、AI 图标、字段名（双击编辑）、TypeLengthDisplay（edit 模式）、NN checkbox、UQ checkbox、默认值（双击编辑）、注释图标、⋮ 菜单。

所有控件样式使用 Abyss 主题色：
- checkbox 选中态 `accent-color: #00c9a7`
- 行 hover `bg-[#1a2639]`
- 文字 `text-[13px] text-[#b5cfe8]`

- [ ] **Step 2: 创建 full 模式**

full 模式渲染多行表单：字段名输入、类型+长度、NOT NULL/UNIQUE/UNSIGNED checkboxes、默认值输入、ENUM 值编辑器（条件显示）、字符集/排序规则下拉、ON UPDATE 输入、注释 textarea、收起按钮。

输入框样式：`bg-[#151d28] border border-[#2a3f5a] rounded text-[#b5cfe8] text-[13px]`，focus 时 `border-[#00c9a7]`。

- [ ] **Step 3: 组合 props 接口**

```typescript
interface ColumnPropertyEditorProps {
  column: ErColumn;
  tableId: number;
  dialect: DialectName | null;
  mode: 'compact' | 'full';
  onUpdate: (id: number, updates: Partial<ErColumn>) => void;
  onDelete?: (id: number, tableId: number) => void;
  onOpenDrawer?: (tableId: number, columnId: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  visibleColumns?: { defaultValue: boolean; comment: boolean; unique: boolean };
}
```

`visibleColumns` 用于侧边栏响应式列隐藏。

- [ ] **Step 4: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/components/ERDesigner/shared/ColumnPropertyEditor.tsx
git commit -m "feat(er): add ColumnPropertyEditor with compact/full modes"
```

---

### Task 11: IndexEditor 组件

**Files:**
- Create: `src/components/ERDesigner/shared/IndexEditor.tsx`

- [ ] **Step 1: 创建组件**

折叠/展开列表，每行显示索引名、类型、列名列表、删除按钮。展开后显示编辑表单：索引名输入、类型下拉（INDEX/UNIQUE/FULLTEXT）、列 checkbox 列表（带 ASC/DESC 切换）。

```typescript
interface IndexEditorProps {
  indexes: ErIndex[];
  columns: ErColumn[];  // 当前表的所有列，用于 checkbox 勾选
  tableId: number;
  tableName: string;
  onAdd: (tableId: number, index: Partial<ErIndex>) => void;
  onUpdate: (id: number, updates: Partial<ErIndex>) => void;
  onDelete: (id: number, tableId: number) => void;
}
```

注意：ErIndex.columns 目前是 JSON 字符串 `'["col1","col2"]'`，组件内需 `JSON.parse`/`JSON.stringify` 处理。

新建时自动生成索引名 `idx_<tableName>_<firstColName>`。

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/shared/IndexEditor.tsx
git commit -m "feat(er): add IndexEditor shared component"
```

---

## Chunk 3: 画布增强与侧边栏重写

### Task 12: 画布节点类型长度显示

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/ERTableNode.tsx:8-21` (删除 SQL_TYPES)
- Modify: `src/components/ERDesigner/ERCanvas/ERTableNode.tsx:187-194` (类型下拉)

- [ ] **Step 1: 替换 SQL_TYPES 为类型注册表**

删除 `ERTableNode.tsx:8-21` 的 `SQL_TYPES` 数组。改为导入：

```typescript
import { getTypeOptions, formatTypeDisplay } from '../shared/dataTypes';
import { useErDesignerStore } from '@/store/erDesignerStore';
```

在组件内获取方言：

```typescript
const { boundDialect } = useErDesignerStore();
const typeOptions = getTypeOptions(boundDialect);
```

- [ ] **Step 2: 更新类型下拉显示**

ColumnRow 中的 DropdownSelect，将 `options={SQL_TYPES}` 改为 `options={typeOptions}`。

下拉的显示值（当前选中项文本）改为 `formatTypeDisplay(col)`：

```typescript
<DropdownSelect
  value={col.data_type}
  options={typeOptions}
  onChange={(value) => {
    const typeDef = findTypeDef(value, boundDialect);
    onUpdateColumn(col.id, {
      data_type: value,
      length: typeDef?.defaultLength ?? null,
      scale: typeDef?.defaultScale ?? null,
    });
  }}
  plain
  displayValue={formatTypeDisplay(col)}
/>
```

注意：`DropdownSelect` 当前不支持 `displayValue` prop。需在 Step 3 中扩展。

- [ ] **Step 3: 扩展 DropdownSelect 支持 displayValue**

Modify: `src/components/common/DropdownSelect.tsx`

在 Props 中添加 `displayValue?: string`，在渲染触发器文本时优先使用 `displayValue`：

```typescript
const displayLabel = props.displayValue
  ?? options.find(o => o.value === value)?.label
  ?? placeholder ?? '';
```

- [ ] **Step 4: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 5: 手动验证**

Run: `npm run dev`
Expected: 画布表节点中的类型显示为 `VARCHAR(255)` 格式（如果 column 有 length 值），下拉选项按方言显示

- [ ] **Step 6: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/ERTableNode.tsx src/components/common/DropdownSelect.tsx
git commit -m "feat(er-canvas): show type(length) in table nodes"
```

---

### Task 13: 侧边栏列区域重写

**Files:**
- Modify: `src/components/ERDesigner/ERSidebar/index.tsx`

这是对侧边栏列区域的完整重写，从当前单行 ColumnRow 改为 DataGrip 式表格布局。项目树结构保持不变。

- [ ] **Step 1: 删除旧 ColumnRow 组件和 SQL_TYPES**

删除 `index.tsx:12-25`（SQL_TYPES）和 `index.tsx:33-152`（旧 ColumnRow 组件及其接口定义）。

- [ ] **Step 2: 添加导入和响应式 hook**

```typescript
import ColumnPropertyEditor from '../shared/ColumnPropertyEditor';
import { getTypeOptions } from '../shared/dataTypes';
import type { DialectName } from '../shared/dataTypes';
```

在组件中添加 `ResizeObserver` 监听侧边栏宽度：

```typescript
const sidebarRef = useRef<HTMLDivElement>(null);
const [sidebarWidth, setSidebarWidth] = useState(450);

useEffect(() => {
  if (!sidebarRef.current) return;
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      setSidebarWidth(entry.contentRect.width);
    }
  });
  observer.observe(sidebarRef.current);
  return () => observer.disconnect();
}, []);

const visibleColumns = {
  comment: sidebarWidth >= 450,
  defaultValue: sidebarWidth >= 380,
  unique: sidebarWidth >= 300,
};
```

- [ ] **Step 3: 添加表头行组件**

在表展开区域顶部渲染固定表头：

```tsx
<div className="flex items-center px-2 h-[20px] text-[11px] text-[#4a6480] select-none">
  <span className="w-[40px]"></span>{/* PK/AI 图标空间 */}
  <span className="flex-1 min-w-0">列名</span>
  <span className="w-[130px] shrink-0">类型</span>
  <span className="w-[28px] shrink-0 text-center">NN</span>
  {visibleColumns.unique && <span className="w-[28px] shrink-0 text-center">UQ</span>}
  {visibleColumns.defaultValue && <span className="w-[80px] shrink-0">默认值</span>}
  {visibleColumns.comment && <span className="w-[60px] shrink-0">注释</span>}
  <span className="w-[24px] shrink-0"></span>{/* 菜单 */}
</div>
```

- [ ] **Step 4: 替换列列表渲染**

将旧的 `{columns[table.id]?.map(col => <ColumnRow ... />)}` 替换为：

```tsx
{columns[table.id]?.map(col => (
  <ColumnPropertyEditor
    key={col.id}
    column={col}
    tableId={table.id}
    dialect={boundDialect}
    mode="compact"
    onUpdate={updateColumn}
    onDelete={deleteColumn}
    onOpenDrawer={openDrawer}
    visibleColumns={visibleColumns}
  />
))}
```

- [ ] **Step 5: 在表名旁添加抽屉编辑按钮**

在表名行中添加编辑图标：

```tsx
<button
  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-[#00c9a7] transition-all"
  onClick={(e) => { e.stopPropagation(); openDrawer(table.id); }}
  title="在属性面板中编辑"
>
  <Edit3 size={12} />
</button>
```

- [ ] **Step 6: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 7: 手动验证**

Run: `npm run dev`
Expected: 侧边栏展开表时显示表头 + 表格式列列表，支持 NN/UQ checkbox、类型下拉含长度、拖窄时列响应式隐藏

- [ ] **Step 8: Commit**

```bash
git add src/components/ERDesigner/ERSidebar/index.tsx
git commit -m "feat(er-sidebar): rewrite column area as DataGrip-style table"
```

---

## Chunk 4: 右侧抽屉面板

### Task 14: 抽屉容器组件

**Files:**
- Create: `src/components/ERDesigner/ERPropertyDrawer/index.tsx`

- [ ] **Step 1: 创建抽屉容器**

```typescript
import { useState } from 'react';
import { X } from 'lucide-react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import ColumnsTab from './ColumnsTab';
import IndexesTab from './IndexesTab';
import TablePropertiesTab from './TablePropertiesTab';

type TabType = 'columns' | 'indexes' | 'properties';

export default function ERPropertyDrawer() {
  const { drawerOpen, drawerTableId, closeDrawer, tables } = useErDesignerStore();
  const [activeTab, setActiveTab] = useState<TabType>('columns');

  if (!drawerOpen || drawerTableId == null) return null;

  const table = tables.find(t => t.id === drawerTableId);
  if (!table) return null;

  return (
    <div className="w-[420px] shrink-0 bg-[#111922] border-l border-[#253347] flex flex-col h-full">
      {/* 标题栏 */}
      <div className="bg-[#1a2639] px-3 py-2 flex items-center justify-between border-b border-[#253347]">
        <span className="text-[13px] text-[#c8daea] font-medium truncate">{table.name}</span>
        <button onClick={closeDrawer} className="text-[#7a9bb8] hover:text-[#c8daea]">
          <X size={14} />
        </button>
      </div>
      {/* Tab 栏 */}
      <div className="flex border-b border-[#253347]">
        {(['columns', 'indexes', 'properties'] as TabType[]).map(tab => (
          <button
            key={tab}
            className={`px-4 py-2 text-[12px] transition-colors ${
              activeTab === tab
                ? 'text-[#00c9a7] border-b-2 border-[#00c9a7]'
                : 'text-[#4a6480] hover:text-[#7a9bb8]'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'columns' ? '列' : tab === 'indexes' ? '索引' : '表属性'}
          </button>
        ))}
      </div>
      {/* Tab 内容 */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'columns' && <ColumnsTab tableId={drawerTableId} />}
        {activeTab === 'indexes' && <IndexesTab tableId={drawerTableId} tableName={table.name} />}
        {activeTab === 'properties' && <TablePropertiesTab tableId={drawerTableId} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ERDesigner/ERPropertyDrawer/index.tsx
git commit -m "feat(er-drawer): add property drawer container with tabs"
```

---

### Task 15: ColumnsTab

**Files:**
- Create: `src/components/ERDesigner/ERPropertyDrawer/ColumnsTab.tsx`

- [ ] **Step 1: 创建组件**

列表模式：每行用 `ColumnPropertyEditor mode="compact"`，前面加 ▶/▼ 展开按钮。展开后渲染 `ColumnPropertyEditor mode="full"`。

```typescript
import { useState, useEffect, useRef } from 'react';
import { Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import ColumnPropertyEditor from '../shared/ColumnPropertyEditor';

interface ColumnsTabProps {
  tableId: number;
}

export default function ColumnsTab({ tableId }: ColumnsTabProps) {
  const { columns, addColumn, updateColumn, deleteColumn, drawerFocusColumnId, boundDialect } = useErDesignerStore();
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动展开 focusColumnId
  useEffect(() => {
    if (drawerFocusColumnId != null) {
      setExpandedIds(prev => new Set(prev).add(drawerFocusColumnId));
      // scrollIntoView 在下一帧
      requestAnimationFrame(() => {
        const el = document.getElementById(`drawer-col-${drawerFocusColumnId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      // 清除 focus
      useErDesignerStore.setState({ drawerFocusColumnId: null });
    }
  }, [drawerFocusColumnId]);

  const cols = columns[tableId] ?? [];
  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div ref={scrollRef} className="p-2">
      {cols.map(col => (
        <div key={col.id} id={`drawer-col-${col.id}`}>
          <div className="flex items-center">
            <button onClick={() => toggleExpand(col.id)} className="p-0.5 text-[#4a6480] hover:text-[#7a9bb8]">
              {expandedIds.has(col.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <div className="flex-1 min-w-0">
              <ColumnPropertyEditor column={col} tableId={tableId} dialect={boundDialect} mode="compact" onUpdate={updateColumn} onDelete={deleteColumn} />
            </div>
          </div>
          {expandedIds.has(col.id) && (
            <div className="ml-4 mb-2 p-2 bg-[#0d1117] rounded border border-[#1e2d42]">
              <ColumnPropertyEditor column={col} tableId={tableId} dialect={boundDialect} mode="full" onUpdate={updateColumn} />
            </div>
          )}
        </div>
      ))}
      {/* 添加列按钮 */}
      <button
        onClick={() => addColumn(tableId, { name: `column_${cols.length + 1}`, data_type: 'VARCHAR', nullable: true, default_value: null, is_primary_key: false, is_auto_increment: false, comment: null, length: null, scale: null, is_unique: false, unsigned: false, charset: null, collation: null, on_update: null, enum_values: null, sort_order: cols.length })}
        className="mt-2 w-full py-1 text-[12px] text-[#4a6480] hover:text-[#00c9a7] hover:bg-[#1a2639] rounded transition-colors flex items-center justify-center gap-1"
      >
        <Plus size={12} /> 添加列
      </button>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/ERDesigner/ERPropertyDrawer/ColumnsTab.tsx
git commit -m "feat(er-drawer): add ColumnsTab with expand/collapse"
```

---

### Task 16: IndexesTab

**Files:**
- Create: `src/components/ERDesigner/ERPropertyDrawer/IndexesTab.tsx`

- [ ] **Step 1: 创建组件**

包装 `IndexEditor` 共享组件，从 store 获取数据并传入：

```typescript
import { useErDesignerStore } from '@/store/erDesignerStore';
import IndexEditor from '../shared/IndexEditor';

interface IndexesTabProps {
  tableId: number;
  tableName: string;
}

export default function IndexesTab({ tableId, tableName }: IndexesTabProps) {
  const { indexes, columns, addIndex, updateIndex, deleteIndex } = useErDesignerStore();
  return (
    <div className="p-2">
      <IndexEditor
        indexes={indexes[tableId] ?? []}
        columns={columns[tableId] ?? []}
        tableId={tableId}
        tableName={tableName}
        onAdd={addIndex}
        onUpdate={updateIndex}
        onDelete={deleteIndex}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ERDesigner/ERPropertyDrawer/IndexesTab.tsx
git commit -m "feat(er-drawer): add IndexesTab"
```

---

### Task 17: TablePropertiesTab

**Files:**
- Create: `src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx`

- [ ] **Step 1: 创建组件**

表名、注释、颜色选择器、数据库选项（绑定后显示）：

```typescript
import { useState, useEffect } from 'react';
import { useErDesignerStore } from '@/store/erDesignerStore';

const PRESET_COLORS = ['#00c9a7', '#5eb2f7', '#f59e0b', '#f43f5e', '#a855f7', '#4ade80'];

interface TablePropertiesTabProps {
  tableId: number;
}

export default function TablePropertiesTab({ tableId }: TablePropertiesTabProps) {
  const { tables, updateTable, boundDialect } = useErDesignerStore();
  const table = tables.find(t => t.id === tableId);
  if (!table) return null;

  const [name, setName] = useState(table.name);
  const [comment, setComment] = useState(table.comment ?? '');

  useEffect(() => {
    setName(table.name);
    setComment(table.comment ?? '');
  }, [table.id, table.name, table.comment]);

  const saveName = () => { if (name.trim() && name !== table.name) updateTable(table.id, { name: name.trim() }); };
  const saveComment = () => { updateTable(table.id, { comment: comment || null }); };

  return (
    <div className="p-3 space-y-4">
      {/* 表名 */}
      <div>
        <label className="text-[11px] text-[#4a6480] block mb-1">表名</label>
        <input value={name} onChange={e => setName(e.target.value)} onBlur={saveName}
          className="w-full bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 text-[13px] text-[#b5cfe8] focus:border-[#00c9a7] outline-none" />
      </div>
      {/* 注释 */}
      <div>
        <label className="text-[11px] text-[#4a6480] block mb-1">注释</label>
        <textarea value={comment} onChange={e => setComment(e.target.value)} onBlur={saveComment} rows={3}
          className="w-full bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 text-[13px] text-[#b5cfe8] focus:border-[#00c9a7] outline-none resize-none" />
      </div>
      {/* 颜色 */}
      <div>
        <label className="text-[11px] text-[#4a6480] block mb-1">颜色</label>
        <div className="flex gap-2 items-center">
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => updateTable(table.id, { color: c })}
              className={`w-5 h-5 rounded-full border-2 transition-all ${table.color === c ? 'border-white scale-110' : 'border-transparent hover:scale-110'}`}
              style={{ backgroundColor: c }} />
          ))}
          <button onClick={() => updateTable(table.id, { color: null })}
            className={`px-2 py-0.5 text-[11px] rounded ${!table.color ? 'text-[#00c9a7] bg-[#003d2f]' : 'text-[#4a6480] hover:text-[#7a9bb8]'}`}>
            无
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx
git commit -m "feat(er-drawer): add TablePropertiesTab with color picker"
```

---

### Task 18: 集成抽屉到画布布局

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`（或 ER 设计器主布局文件）
- Modify: `src/components/ERDesigner/ERCanvas/ERTableNode.tsx`

- [ ] **Step 1: 找到 ER 设计器主布局，添加抽屉面板**

在画布区域旁边用 flex 布局添加抽屉：

```tsx
import ERPropertyDrawer from '../ERPropertyDrawer';

// 在 JSX 中：
<div className="flex h-full">
  <div className="flex-1 min-w-0">
    {/* 现有 ReactFlow 画布 */}
  </div>
  <ERPropertyDrawer />
</div>
```

- [ ] **Step 2: 在 ERTableNode 头部添加编辑按钮**

在表名行（`ERTableNode.tsx` 约行 240-243）右侧添加编辑图标：

```tsx
<button
  className="opacity-0 group-hover:opacity-100 p-0.5 text-[#7a9bb8] hover:text-[#00c9a7] transition-all"
  onClick={(e) => { e.stopPropagation(); openDrawer(tableData.id); }}
>
  <Edit3 size={12} />
</button>
```

需从 store 获取 `openDrawer`：
```typescript
const { openDrawer } = useErDesignerStore();
```

- [ ] **Step 3: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 4: 手动验证**

Run: `npm run dev`
Expected:
- 点击表节点头部编辑按钮 → 右侧滑出抽屉面板
- 三个 Tab 可切换（列/索引/表属性）
- 列 Tab 支持展开/折叠编辑
- 画布区域自动缩窄
- 点击关闭按钮 → 抽屉收起

- [ ] **Step 5: Commit**

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx src/components/ERDesigner/ERCanvas/ERTableNode.tsx
git commit -m "feat(er): integrate property drawer into canvas layout"
```

---

### Task 19: 方言兼容性检查集成

**Files:**
- Modify: `src/store/erDesignerStore.ts`

- [ ] **Step 1: 实现兼容性检查 actions**

```typescript
boundDialect: null,
dialectWarnings: {},

checkDialectCompatibility: () => {
  const { boundDialect, columns } = get();
  if (!boundDialect) {
    set({ dialectWarnings: {} });
    return;
  }
  const warnings: Record<number, string> = {};
  for (const cols of Object.values(columns)) {
    for (const col of cols) {
      const w = checkTypeCompatibility(col.data_type, boundDialect as DialectName);
      if (w) warnings[col.id] = w;
    }
  }
  set({ dialectWarnings: warnings });
},

checkColumnCompatibility: (columnId: number) => {
  const { boundDialect, columns, dialectWarnings } = get();
  if (!boundDialect) return;
  for (const cols of Object.values(columns)) {
    const col = cols.find(c => c.id === columnId);
    if (col) {
      const w = checkTypeCompatibility(col.data_type, boundDialect as DialectName);
      const next = { ...dialectWarnings };
      if (w) next[columnId] = w; else delete next[columnId];
      set({ dialectWarnings: next });
      break;
    }
  }
},

clearDialectWarnings: () => set({ dialectWarnings: {} }),
```

- [ ] **Step 2: 在 bindConnection 中触发检查**

在现有 `bindConnection` action 中，`await get().loadProject(projectId)` 之后追加方言推导。从 `connectionStore` 获取连接的 `driver` 字段（值为 `'mysql'`、`'postgres'`、`'oracle'`、`'sqlserver'`、`'sqlite'` 等）：

```typescript
// 在 bindConnection action 中，loadProject 之后追加
import { useConnectionStore } from '@/store/connectionStore';
// ...
const conn = useConnectionStore.getState().connections.find(c => c.id === connectionId);
const driverToDialect: Record<string, string> = {
  mysql: 'mysql', postgres: 'postgresql', oracle: 'oracle',
  sqlserver: 'sqlserver', sqlite: 'sqlite',
};
const dialect = conn ? (driverToDialect[conn.driver] ?? null) : null;
set({ boundDialect: dialect });
get().checkDialectCompatibility();
```

在 `unbindConnection` action 中，`set(...)` 之后追加清除：

```typescript
set({ boundDialect: null });
get().clearDialectWarnings();
```

- [ ] **Step 3: 在 updateColumn 和 deleteColumn 中触发兼容性更新**

在 `updateColumn` action 的 set() 之后追加：

```typescript
get().checkColumnCompatibility(id);
```

在 `deleteColumn` action 的 set() 之后追加移除该列的警告：

```typescript
set((s) => {
  const next = { ...s.dialectWarnings };
  delete next[id];
  return { dialectWarnings: next };
});
```

- [ ] **Step 4: TypeScript 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/store/erDesignerStore.ts
git commit -m "feat(er): integrate dialect compatibility checking"
```

---

### Task 20: syncFromDatabase 类型解析更新

**Files:**
- Modify: `src-tauri/src/er/repository.rs`（或 `src-tauri/src/er/commands.rs` 中 sync 相关函数）

- [ ] **Step 1: 更新数据库同步时的类型拆分逻辑**

当 `syncFromDatabase` 从真实数据库导入列信息时，数据库返回的类型格式包含长度（如 MySQL 返回 `varchar(255)`、PostgreSQL 返回 `character varying(255)`）。需在导入时拆分为 `data_type` + `length` + `scale`。

在 Rust 层的同步逻辑中，添加类型解析函数：

```rust
/// 解析数据库返回的类型字符串，拆分为 (base_type, length, scale)
fn parse_db_type(raw: &str) -> (String, Option<i64>, Option<i64>) {
    let normalized = raw.trim().to_uppercase();
    // 处理括号内的长度/精度
    if let Some(paren_start) = normalized.find('(') {
        let base = normalized[..paren_start].trim().to_string();
        let params = &normalized[paren_start + 1..normalized.len() - 1];
        let parts: Vec<&str> = params.split(',').collect();
        let length = parts.first().and_then(|s| s.trim().parse::<i64>().ok());
        let scale = parts.get(1).and_then(|s| s.trim().parse::<i64>().ok());
        // 标准化 PostgreSQL 别名
        let base = match base.as_str() {
            "CHARACTER VARYING" => "VARCHAR".to_string(),
            "CHARACTER" => "CHAR".to_string(),
            "INT4" => "INTEGER".to_string(),
            "INT8" => "BIGINT".to_string(),
            _ => base,
        };
        (base, length, scale)
    } else {
        let base = match normalized.as_str() {
            "CHARACTER VARYING" => "VARCHAR".to_string(),
            "CHARACTER" => "CHAR".to_string(),
            "INT4" | "INT" => "INTEGER".to_string(),
            "INT8" => "BIGINT".to_string(),
            "DOUBLE PRECISION" => "DOUBLE".to_string(),
            _ => normalized,
        };
        (base, None, None)
    }
}
```

在同步创建列时，调用 `parse_db_type()` 设置 `data_type`、`length`、`scale` 字段。

- [ ] **Step 2: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/er/
git commit -m "feat(er): parse type length/scale during database sync"
```

---

### Task 21: 全量编译验证与端到端测试

**Files:** 无新文件

- [ ] **Step 1: Rust 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 0 errors

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 new errors

- [ ] **Step 3: 前端启动验证**

Run: `npm run dev`
验证以下功能：
1. 画布表节点显示 `VARCHAR(255)` 格式
2. 侧边栏显示表格式列编辑（表头 + 数据行）
3. NN/UQ checkbox 可切换
4. 类型下拉显示完整类型列表
5. 抽屉面板可从画布/侧边栏按钮打开
6. 抽屉列 Tab 支持展开完整编辑
7. 抽屉索引 Tab 可创建/编辑索引
8. 抽屉表属性 Tab 可编辑注释和颜色
9. 侧边栏拖窄时列响应式隐藏

- [ ] **Step 4: Commit 最终状态**

如有遗漏修复，统一提交：

```bash
git add -A
git commit -m "feat(er): complete column properties editing system"
```
