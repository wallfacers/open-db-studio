# ER Constraint Method 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ER 设计器的每条关系添加"约束方式"（数据库外键 vs 注释引用），支持项目→表→关系三级继承，DDL 生成时按约束方式分别输出。

**Architecture:** 后端新增 `constraint.rs` 模块封装继承解析逻辑（纯函数），DDL 生成器读取解析结果决定输出。前端通过三个入口（连线弹窗、表属性抽屉 Relations 标签、项目设置弹窗）编辑各级默认值；连线用实线/虚线+徽章图标可视化生效的约束方式。

**Tech Stack:** Rust (rusqlite, tauri), React 18, TypeScript, Zustand, ReactFlow (@xyflow/react)

---

## 文件映射

| 操作 | 文件 |
|------|------|
| Modify | `schema/init.sql` |
| Modify | `src-tauri/src/db/migrations.rs` |
| Modify | `src-tauri/src/er/models.rs` |
| Modify | `src-tauri/src/er/repository.rs` |
| **Create** | `src-tauri/src/er/constraint.rs` |
| Modify | `src-tauri/src/er/mod.rs` |
| Modify | `src-tauri/src/er/ddl_generator.rs` |
| Modify | `src-tauri/src/er/commands.rs` |
| Modify | `src/types/index.ts` |
| Modify | `src/store/erDesignerStore.ts` |
| Modify | `src/components/ERDesigner/ERCanvas/index.tsx` |
| Modify | `src/components/ERDesigner/ERCanvas/EREdge.tsx` |
| **Create** | `src/components/ERDesigner/ERPropertyDrawer/RelationsTab.tsx` |
| Modify | `src/components/ERDesigner/ERPropertyDrawer/index.tsx` |
| Modify | `src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx` |
| **Create** | `src/components/ERDesigner/dialogs/ProjectSettingsDialog.tsx` |
| Modify | `src/components/ERDesigner/ERCanvas/ERToolbar.tsx` |
| Modify | `src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx` |

---

## Task 1: 数据库 Schema、迁移和 Rust 数据模型

**Files:**
- Modify: `schema/init.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/er/models.rs`

### Step 1.1: 更新 schema/init.sql 新增字段

在 `schema/init.sql` 中，找到 `er_projects` 表的 `CREATE TABLE IF NOT EXISTS` 语句，在 `viewport_zoom` 后添加两列：

```sql
    viewport_zoom   REAL DEFAULT 1,
    default_constraint_method TEXT NOT NULL DEFAULT 'database_fk',
    default_comment_format    TEXT NOT NULL DEFAULT '@ref',
```

找到 `er_tables` 表，在 `color` 后添加：

```sql
    color           TEXT NULL,
    constraint_method  TEXT NULL,
    comment_format     TEXT NULL,
```

找到 `er_relations` 表，在 `comment_marker` 后添加：

```sql
    comment_marker  TEXT NULL,
    constraint_method  TEXT NULL,
    comment_format     TEXT NULL,
```

### Step 1.2: 在 migrations.rs 末尾添加 V19 迁移

在 `src-tauri/src/db/migrations.rs` 中，在 `log::info!("Database migrations completed");` 之前添加：

```rust
    // V19: ER 关系约束方式（三级继承：项目→表→关系）
    {
        // er_projects 新增 default_constraint_method / default_comment_format
        let project_cols: Vec<String> = {
            let mut s = conn.prepare("SELECT name FROM pragma_table_info('er_projects')")?;
            s.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
        };
        let project_new_cols = [
            ("default_constraint_method", "TEXT NOT NULL DEFAULT 'database_fk'"),
            ("default_comment_format",    "TEXT NOT NULL DEFAULT '@ref'"),
        ];
        for (col_name, col_type) in &project_new_cols {
            if !project_cols.contains(&col_name.to_string()) {
                conn.execute_batch(&format!("ALTER TABLE er_projects ADD COLUMN {} {}", col_name, col_type))?;
                log::info!("V19: added er_projects.{}", col_name);
            }
        }

        // er_tables 新增 constraint_method / comment_format
        let table_cols: Vec<String> = {
            let mut s = conn.prepare("SELECT name FROM pragma_table_info('er_tables')")?;
            s.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
        };
        let table_new_cols = [
            ("constraint_method", "TEXT NULL"),
            ("comment_format",    "TEXT NULL"),
        ];
        for (col_name, col_type) in &table_new_cols {
            if !table_cols.contains(&col_name.to_string()) {
                conn.execute_batch(&format!("ALTER TABLE er_tables ADD COLUMN {} {}", col_name, col_type))?;
                log::info!("V19: added er_tables.{}", col_name);
            }
        }

        // er_relations 新增 constraint_method / comment_format
        let rel_cols: Vec<String> = {
            let mut s = conn.prepare("SELECT name FROM pragma_table_info('er_relations')")?;
            s.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
        };
        let rel_new_cols = [
            ("constraint_method", "TEXT NULL"),
            ("comment_format",    "TEXT NULL"),
        ];
        for (col_name, col_type) in &rel_new_cols {
            if !rel_cols.contains(&col_name.to_string()) {
                conn.execute_batch(&format!("ALTER TABLE er_relations ADD COLUMN {} {}", col_name, col_type))?;
                log::info!("V19: added er_relations.{}", col_name);
            }
        }
    }
```

### Step 1.3: 更新 models.rs 结构体

在 `src-tauri/src/er/models.rs` 中：

**`ErProject` 结构体**，在 `viewport_zoom` 后添加：
```rust
    pub viewport_zoom: f64,
    pub default_constraint_method: String,
    pub default_comment_format: String,
```

**`UpdateProjectRequest` 结构体**，添加字段：
```rust
    pub default_constraint_method: Option<String>,
    pub default_comment_format: Option<String>,
```

**`ErTable` 结构体**，在 `color` 后添加：
```rust
    pub color: Option<String>,
    pub constraint_method: Option<String>,
    pub comment_format: Option<String>,
```

**`UpdateTableRequest` 结构体**，添加字段：
```rust
    pub constraint_method: Option<String>,
    pub comment_format: Option<String>,
```

**`ErRelation` 结构体**，在 `comment_marker` 后添加：
```rust
    pub comment_marker: Option<String>,
    pub constraint_method: Option<String>,
    pub comment_format: Option<String>,
```

**`UpdateRelationRequest` 结构体**，添加字段：
```rust
    pub constraint_method: Option<String>,
    pub comment_format: Option<String>,
```

**`CreateRelationRequest` 结构体**，添加字段：
```rust
    pub constraint_method: Option<String>,
    pub comment_format: Option<String>,
```

### Step 1.4: 编译检查

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo check 2>&1 | head -40
```

期望：编译错误仅来自 repository.rs（下一步修复），models.rs 本身无错误。

- [ ] Step 1.1: 更新 init.sql
- [ ] Step 1.2: 添加 V19 migration
- [ ] Step 1.3: 更新 models.rs
- [ ] Step 1.4: 运行 cargo check 确认 models.rs 编译通过（忽略 repository.rs 的错误）

```bash
git add schema/init.sql src-tauri/src/db/migrations.rs src-tauri/src/er/models.rs
git commit -m "feat(er): add constraint_method and comment_format fields to schema and models"
```

- [ ] Commit

---

## Task 2: Repository SQL 更新

**Files:**
- Modify: `src-tauri/src/er/repository.rs`

### Step 2.1: 更新 PROJECT_COLS 常量

找到：
```rust
const PROJECT_COLS: &str =
    "id, name, description, connection_id, database_name, schema_name, viewport_x, viewport_y, viewport_zoom, created_at, updated_at";
```

改为：
```rust
const PROJECT_COLS: &str =
    "id, name, description, connection_id, database_name, schema_name, viewport_x, viewport_y, viewport_zoom, default_constraint_method, default_comment_format, created_at, updated_at";
```

### Step 2.2: 更新 project 的 row_to_project 映射函数

找到将 SQL row 映射到 `ErProject` 的闭包（通常为 `|row|` 形式），在 `viewport_zoom` 后追加：

```rust
default_constraint_method: row.get(9)?,
default_comment_format: row.get(10)?,
created_at: row.get(11)?,
updated_at: row.get(12)?,
```

（注意：需同时更新后面所有列的索引号，原来 `created_at` 对应 index 9，现在变成 11）

### Step 2.3: 更新 create_project 和 update_project 的 SQL 语句

**create_project** - INSERT 不需要改动（新列有 DEFAULT，不需要插入）。

**update_project** - 在 SET 子句中追加可选字段。找到 `update_project` 函数，在已有的更新字段列表末尾添加：

```rust
if let Some(ref v) = req.default_constraint_method {
    set_parts.push(format!("default_constraint_method = '{}'", v));
}
if let Some(ref v) = req.default_comment_format {
    set_parts.push(format!("default_comment_format = '{}'", v));
}
```

（如果 repository 已有通用 set_parts 模式，沿用它；否则用参数绑定方式）

### Step 2.4: 更新 TABLE_COLS 常量

找到：
```rust
const TABLE_COLS: &str =
    "id, project_id, name, comment, position_x, position_y, color, created_at, updated_at";
```

改为：
```rust
const TABLE_COLS: &str =
    "id, project_id, name, comment, position_x, position_y, color, constraint_method, comment_format, created_at, updated_at";
```

### Step 2.5: 更新 table 的 row 映射，在 color 后追加新字段：

```rust
color: row.get(6)?,
constraint_method: row.get(7)?,
comment_format: row.get(8)?,
created_at: row.get(9)?,
updated_at: row.get(10)?,
```

### Step 2.6: 更新 update_table SQL，追加字段：

```rust
if let Some(ref v) = req.constraint_method {
    set_parts.push(format!("constraint_method = '{}'", v));
}
if let Some(ref v) = req.comment_format {
    set_parts.push(format!("comment_format = '{}'", v));
}
```

支持将 `constraint_method` 重置为 NULL（继承）：如果 req 中有特殊标志（或用空字符串表示 NULL），则：
```rust
// 将空字符串视为 NULL（重置为继承）
if let Some(ref v) = req.constraint_method {
    if v.is_empty() {
        set_parts.push("constraint_method = NULL".to_string());
    } else {
        set_parts.push(format!("constraint_method = '{}'", v));
    }
}
```

### Step 2.7: 更新 RELATION_COLS 常量

找到：
```rust
const RELATION_COLS: &str =
    "id, project_id, name, source_table_id, source_column_id, target_table_id, target_column_id, relation_type, on_delete, on_update, source, comment_marker, created_at, updated_at";
```

改为：
```rust
const RELATION_COLS: &str =
    "id, project_id, name, source_table_id, source_column_id, target_table_id, target_column_id, relation_type, on_delete, on_update, source, comment_marker, constraint_method, comment_format, created_at, updated_at";
```

### Step 2.8: 更新 relation 的 row 映射，在 comment_marker 后追加：

```rust
comment_marker: row.get(11)?,
constraint_method: row.get(12)?,
comment_format: row.get(13)?,
created_at: row.get(14)?,
updated_at: row.get(15)?,
```

### Step 2.9: 更新 update_relation SQL，追加字段（同样支持空字符串=NULL）：

```rust
if let Some(ref v) = req.constraint_method {
    if v.is_empty() {
        set_parts.push("constraint_method = NULL".to_string());
    } else {
        set_parts.push(format!("constraint_method = '{}'", v));
    }
}
if let Some(ref v) = req.comment_format {
    if v.is_empty() {
        set_parts.push("comment_format = NULL".to_string());
    } else {
        set_parts.push(format!("comment_format = '{}'", v));
    }
}
```

### Step 2.10: 编译检查

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo check 2>&1 | head -40
```

期望：repository.rs 编译通过，0 errors。

- [ ] Step 2.1–2.9: 完成所有 SQL 更新
- [ ] Step 2.10: cargo check 通过

```bash
git add src-tauri/src/er/repository.rs
git commit -m "feat(er): update repository SQL for constraint_method and comment_format fields"
```

- [ ] Commit

---

## Task 3: Constraint 解析模块（纯函数 + 测试）

**Files:**
- Create: `src-tauri/src/er/constraint.rs`
- Modify: `src-tauri/src/er/mod.rs`

### Step 3.1: 写失败测试

在 `src-tauri/src/er/constraint.rs` 中先写：

```rust
use super::models::{ErProject, ErRelation, ErTable};

// ── 继承解析 ──────────────────────────────────────────────────────────

/// 解析生效的约束方式：relation → table → project → 'database_fk'
pub fn resolve_constraint_method<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    todo!()
}

/// 解析生效的注释格式：relation → table → project → '@ref'
pub fn resolve_comment_format<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    todo!()
}

// ── 注释标记构建 ──────────────────────────────────────────────────────

/// 根据格式构建注释标记字符串。
/// format: "@ref" | "@fk" | "[ref]" | "$$ref$$"
pub fn build_comment_marker(
    target_table: &str,
    target_col: &str,
    relation_type: &str,
    format: &str,
) -> String {
    todo!()
}

/// 幂等地在已有注释后追加标记（空格分隔，已存在则不重复）。
pub fn append_marker_to_comment(existing: Option<&str>, marker: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_project(default_method: &str, default_format: &str) -> ErProject {
        ErProject {
            id: 1,
            name: "test".to_string(),
            description: None,
            connection_id: None,
            database_name: None,
            schema_name: None,
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_zoom: 1.0,
            default_constraint_method: default_method.to_string(),
            default_comment_format: default_format.to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_table(cm: Option<&str>, cf: Option<&str>) -> ErTable {
        ErTable {
            id: 1,
            project_id: 1,
            name: "orders".to_string(),
            comment: None,
            position_x: 0.0,
            position_y: 0.0,
            color: None,
            constraint_method: cm.map(str::to_string),
            comment_format: cf.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_relation(cm: Option<&str>, cf: Option<&str>) -> ErRelation {
        ErRelation {
            id: 1,
            project_id: 1,
            name: None,
            source_table_id: 1,
            source_column_id: 10,
            target_table_id: 2,
            target_column_id: 20,
            relation_type: "one_to_many".to_string(),
            on_delete: "NO ACTION".to_string(),
            on_update: "NO ACTION".to_string(),
            source: "designer".to_string(),
            comment_marker: None,
            constraint_method: cm.map(str::to_string),
            comment_format: cf.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    // ── resolve_constraint_method ─────────────────────────────────────

    #[test]
    fn test_relation_overrides_all() {
        let project = make_project("database_fk", "@ref");
        let table = make_table(Some("database_fk"), None);
        let relation = make_relation(Some("comment_ref"), None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_table_overrides_project() {
        let project = make_project("database_fk", "@ref");
        let table = make_table(Some("comment_ref"), None);
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_falls_back_to_project() {
        let project = make_project("comment_ref", "@ref");
        let table = make_table(None, None);
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_falls_back_to_default_when_no_project() {
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, None, None), "database_fk");
    }

    // ── build_comment_marker ──────────────────────────────────────────

    #[test]
    fn test_build_marker_at_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "@ref"),
            "@ref:users.id"
        );
    }

    #[test]
    fn test_build_marker_at_fk() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "@fk"),
            "@fk(table=users,col=id,type=one_to_many)"
        );
    }

    #[test]
    fn test_build_marker_bracket_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "[ref]"),
            "[ref:users.id]"
        );
    }

    #[test]
    fn test_build_marker_dollar_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "$$ref$$"),
            "$$ref(users.id)$$"
        );
    }

    // ── append_marker_to_comment ──────────────────────────────────────

    #[test]
    fn test_append_to_empty_comment() {
        assert_eq!(
            append_marker_to_comment(None, "@ref:users.id"),
            "@ref:users.id"
        );
    }

    #[test]
    fn test_append_to_existing_comment() {
        assert_eq!(
            append_marker_to_comment(Some("用户ID"), "@ref:users.id"),
            "用户ID @ref:users.id"
        );
    }

    #[test]
    fn test_append_is_idempotent() {
        assert_eq!(
            append_marker_to_comment(Some("用户ID @ref:users.id"), "@ref:users.id"),
            "用户ID @ref:users.id"
        );
    }
}
```

### Step 3.2: 运行测试确认失败

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo test er::constraint 2>&1 | tail -20
```

期望：所有测试 FAIL（todo!() panics）。

### Step 3.3: 实现四个函数

将 `constraint.rs` 中的 `todo!()` 替换为真实实现：

```rust
pub fn resolve_constraint_method<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    if let Some(ref m) = relation.constraint_method {
        if !m.is_empty() { return m; }
    }
    if let Some(t) = table {
        if let Some(ref m) = t.constraint_method {
            if !m.is_empty() { return m; }
        }
    }
    if let Some(p) = project {
        if !p.default_constraint_method.is_empty() {
            return &p.default_constraint_method;
        }
    }
    "database_fk"
}

pub fn resolve_comment_format<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    if let Some(ref f) = relation.comment_format {
        if !f.is_empty() { return f; }
    }
    if let Some(t) = table {
        if let Some(ref f) = t.comment_format {
            if !f.is_empty() { return f; }
        }
    }
    if let Some(p) = project {
        if !p.default_comment_format.is_empty() {
            return &p.default_comment_format;
        }
    }
    "@ref"
}

pub fn build_comment_marker(
    target_table: &str,
    target_col: &str,
    relation_type: &str,
    format: &str,
) -> String {
    match format {
        "@fk"    => format!("@fk(table={},col={},type={})", target_table, target_col, relation_type),
        "[ref]"  => format!("[ref:{}.{}]", target_table, target_col),
        "$$ref$$" => format!("$$ref({}.{})$$", target_table, target_col),
        _        => format!("@ref:{}.{}", target_table, target_col),
    }
}

pub fn append_marker_to_comment(existing: Option<&str>, marker: &str) -> String {
    let base = existing.unwrap_or("").trim();
    if base.is_empty() {
        marker.to_string()
    } else if base.contains(marker) {
        base.to_string()
    } else {
        format!("{} {}", base, marker)
    }
}
```

### Step 3.4: 在 mod.rs 中注册模块

在 `src-tauri/src/er/mod.rs` 末尾追加：

```rust
pub mod constraint;
```

### Step 3.5: 运行测试确认通过

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo test er::constraint 2>&1 | tail -20
```

期望：所有测试 PASS。

- [ ] Step 3.1: 写测试
- [ ] Step 3.2: 确认失败
- [ ] Step 3.3: 实现函数
- [ ] Step 3.4: 注册模块
- [ ] Step 3.5: 确认通过

```bash
git add src-tauri/src/er/constraint.rs src-tauri/src/er/mod.rs
git commit -m "feat(er): add constraint resolution module with pure functions and tests"
```

- [ ] Commit

---

## Task 4: DDL 生成器集成 + Commands 更新

**Files:**
- Modify: `src-tauri/src/er/ddl_generator.rs`
- Modify: `src-tauri/src/er/commands.rs`

### Step 4.1: 写 DDL 生成测试（comment_ref 场景）

在 `ddl_generator.rs` 的 `#[cfg(test)] mod tests` 中添加：

```rust
    fn make_project_default() -> super::super::models::ErProject {
        super::super::models::ErProject {
            id: 1,
            name: "test".into(),
            description: None,
            connection_id: None,
            database_name: None,
            schema_name: None,
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_zoom: 1.0,
            default_constraint_method: "database_fk".into(),
            default_comment_format: "@ref".into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_table_with_cm(id: i64, name: &str, cm: Option<&str>) -> ErTable {
        let mut t = make_table(id, name);
        t.constraint_method = cm.map(str::to_string);
        t.comment_format = None;
        t
    }

    fn make_relation_comment_ref(
        source_table_id: i64,
        source_column_id: i64,
        target_table_id: i64,
        target_column_id: i64,
    ) -> ErRelation {
        ErRelation {
            id: 1,
            project_id: 1,
            name: None,
            source_table_id,
            source_column_id,
            target_table_id,
            target_column_id,
            relation_type: "one_to_many".to_string(),
            on_delete: "NO ACTION".to_string(),
            on_update: "NO ACTION".to_string(),
            source: "designer".to_string(),
            comment_marker: None,
            constraint_method: Some("comment_ref".to_string()),
            comment_format: Some("@ref".to_string()),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn test_comment_ref_appends_to_column_comment() {
        let project = make_project_default();
        let orders_table = make_table(1, "orders");
        let users_table = make_table(2, "users");
        let tables = vec![orders_table.clone(), users_table.clone()];

        // orders.user_id → users.id (comment_ref)
        let user_id_col = make_column(10, 1, "user_id", "INT", false, false);
        let users_id_col = make_column(20, 2, "id", "BIGINT", true, true);

        let mut columns_map = HashMap::new();
        columns_map.insert(1i64, vec![user_id_col]);
        columns_map.insert(2i64, vec![users_id_col]);
        let indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();

        let relation = make_relation_comment_ref(1, 10, 2, 20);
        let relations = vec![relation];

        let options = GenerateOptions {
            include_indexes: false,
            include_comments: true,
            include_foreign_keys: false,
            include_comment_refs: true,
        };

        let ddl = generate_ddl(
            &tables,
            &columns_map,
            &indexes_map,
            &relations,
            "mysql",
            &options,
            &project,
        ).unwrap();

        // Column comment should contain the @ref marker
        assert!(ddl.contains("@ref:users.id"), "DDL should contain @ref:users.id, got:\n{}", ddl);
        // No FOREIGN KEY constraint should be generated
        assert!(!ddl.contains("FOREIGN KEY"), "DDL should not contain FOREIGN KEY for comment_ref");
    }

    #[test]
    fn test_database_fk_generates_constraint() {
        let project = make_project_default();
        let orders_table = make_table(1, "orders");
        let users_table = make_table(2, "users");
        let tables = vec![orders_table.clone(), users_table.clone()];

        let user_id_col = make_column(10, 1, "user_id", "INT", false, false);
        let users_id_col = make_column(20, 2, "id", "BIGINT", true, true);

        let mut columns_map = HashMap::new();
        columns_map.insert(1i64, vec![user_id_col]);
        columns_map.insert(2i64, vec![users_id_col]);
        let indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();

        // database_fk relation (default)
        let mut relation = make_relation_comment_ref(1, 10, 2, 20);
        relation.constraint_method = Some("database_fk".to_string());
        let relations = vec![relation];

        let options = GenerateOptions {
            include_indexes: false,
            include_comments: false,
            include_foreign_keys: true,
            include_comment_refs: false,
        };

        let ddl = generate_ddl(
            &tables,
            &columns_map,
            &indexes_map,
            &relations,
            "mysql",
            &options,
            &project,
        ).unwrap();

        assert!(ddl.contains("FOREIGN KEY"), "DDL should contain FOREIGN KEY for database_fk");
        assert!(!ddl.contains("@ref:"), "DDL should not contain @ref marker for database_fk");
    }
```

### Step 4.2: 运行测试确认失败

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo test er::ddl_generator 2>&1 | tail -20
```

期望：编译失败（`include_comment_refs` 字段不存在，`generate_ddl` 签名不匹配）。

### Step 4.3: 更新 GenerateOptions 和 generate_ddl 签名

在 `ddl_generator.rs` 中：

**更新 `GenerateOptions`**，追加字段：
```rust
#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub include_indexes: bool,
    pub include_comments: bool,
    pub include_foreign_keys: bool,
    pub include_comment_refs: bool,   // ← 新增
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            include_indexes: true,
            include_comments: true,
            include_foreign_keys: false,
            include_comment_refs: true,   // ← 新增
        }
    }
}
```

**更新 `generate_ddl` 签名**，追加 `project` 参数：
```rust
use super::models::{ErColumn, ErIndex, ErProject, ErRelation, ErTable};
use super::constraint::{
    append_marker_to_comment, build_comment_marker,
    resolve_comment_format, resolve_constraint_method,
};

pub fn generate_ddl(
    tables: &[ErTable],
    columns_map: &HashMap<i64, Vec<ErColumn>>,
    indexes_map: &HashMap<i64, Vec<ErIndex>>,
    relations: &[ErRelation],
    dialect: &str,
    options: &GenerateOptions,
    project: &ErProject,              // ← 新增
) -> AppResult<String> {
```

### Step 4.4: 在 generate_ddl 中实现 comment_ref 逻辑

在 `generate_ddl` 函数体内，替换原有的 for 循环：

```rust
    let dialect_impl: Box<dyn DdlDialect> = match dialect.to_lowercase().as_str() {
        // ... 保持原有匹配逻辑不变 ...
    };

    // Build a table lookup for constraint resolution
    let tables_by_id: HashMap<i64, &ErTable> = tables.iter().map(|t| (t.id, t)).collect();
    // Build a columns lookup for resolving relation column names
    // (all_columns_map is the same as columns_map here)
    
    // Pre-compute: for each relation, resolve effective constraint method
    // Separate into db_fk_relations (for FK constraints) and comment_ref_relations (for column comments)
    let db_fk_relations: Vec<ErRelation> = relations.iter().filter(|rel| {
        let src_table = tables_by_id.get(&rel.source_table_id).copied();
        resolve_constraint_method(rel, src_table, Some(project)) == "database_fk"
    }).cloned().collect();

    let mut ddl_parts: Vec<String> = Vec::new();

    for table in tables {
        let empty_cols: Vec<ErColumn> = Vec::new();
        let empty_idxs: Vec<ErIndex> = Vec::new();
        let columns = columns_map.get(&table.id).unwrap_or(&empty_cols);
        let indexes = indexes_map.get(&table.id).unwrap_or(&empty_idxs);

        // Pre-process: clone columns and append comment_ref markers
        let processed_columns: Vec<ErColumn> = if options.include_comment_refs {
            let mut cols = columns.clone();
            for rel in relations.iter().filter(|r| r.source_table_id == table.id) {
                let src_table = tables_by_id.get(&rel.source_table_id).copied();
                let effective_method = resolve_constraint_method(rel, src_table, Some(project));
                if effective_method != "comment_ref" {
                    continue;
                }
                let format = resolve_comment_format(rel, src_table, Some(project));
                // Find target table/column names
                let target_table_name = tables_by_id
                    .get(&rel.target_table_id)
                    .map(|t| t.name.as_str())
                    .unwrap_or("unknown");
                let target_col_name = columns_map
                    .get(&rel.target_table_id)
                    .and_then(|tcols| tcols.iter().find(|c| c.id == rel.target_column_id))
                    .map(|c| c.name.as_str())
                    .unwrap_or("id");
                let marker = build_comment_marker(
                    target_table_name, target_col_name, &rel.relation_type, format,
                );
                // Append marker to the source column's comment
                if let Some(col) = cols.iter_mut().find(|c| c.id == rel.source_column_id) {
                    col.comment = Some(append_marker_to_comment(col.comment.as_deref(), &marker));
                }
            }
            cols
        } else {
            columns.to_vec()
        };

        let stmt = dialect_impl.create_table(
            table,
            &processed_columns,
            indexes,
            &db_fk_relations,   // ← 仅传 database_fk 类型的关系，用于 FK 约束生成
            tables,
            columns_map,
            options,
        );
        ddl_parts.push(stmt);
    }

    Ok(ddl_parts.join("\n\n"))
```

### Step 4.5: 更新 commands.rs

在 `src-tauri/src/er/commands.rs` 中：

**更新 `DdlOptions` 结构体**，追加字段：
```rust
pub struct DdlOptions {
    pub dialect: String,
    pub include_indexes: Option<bool>,
    pub include_comments: Option<bool>,
    pub include_foreign_keys: Option<bool>,
    pub include_comment_refs: Option<bool>,   // ← 新增
}
```

**更新 `er_generate_ddl` 命令**，在构建 `GenerateOptions` 时传入新字段，并获取 project：

找到 `er_generate_ddl` 命令函数体。`options` 参数是 `DdlOptions`（包含 `dialect` 字段），内部构建的 `GenerateOptions` 改用 `gen_options` 命名，避免冲突。更新如下：

```rust
#[tauri::command]
pub async fn er_generate_ddl(project_id: i64, options: DdlOptions) -> AppResult<String> {
    let project_full = repository::get_project_full(project_id)?;

    let gen_options = GenerateOptions {
        include_indexes:      options.include_indexes.unwrap_or(true),
        include_comments:     options.include_comments.unwrap_or(true),
        include_foreign_keys: options.include_foreign_keys.unwrap_or(false),
        include_comment_refs: options.include_comment_refs.unwrap_or(true),   // ← 新增
    };

    // 构建 columns_map 和 indexes_map（保持原有逻辑）
    // ...

    let ddl = ddl_generator::generate_ddl(
        &tables,
        &columns_map,
        &indexes_map,
        &project_full.relations,
        &options.dialect,           // DdlOptions 的 dialect 字段
        &gen_options,
        &project_full.project,      // ← 新增
    )?;

    Ok(ddl)
}
```

（若现有代码中已有 `GenerateOptions` 的构建块，直接追加 `include_comment_refs` 字段，并在 `generate_ddl` 调用末尾追加 `&project_full.project`）

### Step 4.6: 运行所有 ER 测试

```bash
cd /home/wallfacers/project/open-db-studio/src-tauri && cargo test er:: 2>&1 | tail -30
```

期望：所有测试 PASS，包括 Task 3 的 constraint 测试和 Task 4 的 DDL 测试。

- [ ] Step 4.1: 写 DDL 测试
- [ ] Step 4.2: 确认编译失败
- [ ] Step 4.3: 更新 GenerateOptions 和签名
- [ ] Step 4.4: 实现 comment_ref 逻辑
- [ ] Step 4.5: 更新 commands.rs
- [ ] Step 4.6: 所有测试 PASS

```bash
git add src-tauri/src/er/ddl_generator.rs src-tauri/src/er/commands.rs
git commit -m "feat(er): integrate constraint resolution into DDL generator, add include_comment_refs option"
```

- [ ] Commit

---

## Task 5: 前端 TypeScript 类型和 Store 更新

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/store/erDesignerStore.ts`

### Step 5.1: 更新 src/types/index.ts

**`ErProject` 接口**，追加字段：
```typescript
export interface ErProject {
  // ...已有字段不变...
  viewport_zoom: number;
  default_constraint_method: string;   // 'database_fk' | 'comment_ref'
  default_comment_format: string;      // '@ref' | '@fk' | '[ref]' | '$$ref$$'
  created_at: string;
  updated_at: string;
}
```

**`ErTable` 接口**，追加字段：
```typescript
export interface ErTable {
  // ...已有字段不变...
  color: string | null;
  constraint_method: string | null;    // null = 继承项目级
  comment_format: string | null;       // null = 继承项目级
  created_at: string;
  updated_at: string;
}
```

**`ErRelation` 接口**，追加字段：
```typescript
export interface ErRelation {
  // ...已有字段不变...
  comment_marker: string | null;
  constraint_method: string | null;    // null = 继承表级
  comment_format: string | null;       // null = 继承
  created_at: string;
  updated_at: string;
}
```

### Step 5.2: 更新 erDesignerStore.ts 中 generateDDL 调用

找到 store 中的 `generateDDL` 方法，更新 invoke 参数增加 `include_comment_refs`：

```typescript
generateDDL: async (
  projectId: number,
  dialect: string,
  options?: {
    includeIndexes?: boolean;
    includeComments?: boolean;
    includeForeignKeys?: boolean;
    includeCommentRefs?: boolean;      // ← 新增
  }
) => {
  return await invoke<string>('er_generate_ddl', {
    projectId,
    options: {
      dialect,
      include_indexes: options?.includeIndexes ?? true,
      include_comments: options?.includeComments ?? true,
      include_foreign_keys: options?.includeForeignKeys ?? false,
      include_comment_refs: options?.includeCommentRefs ?? true,   // ← 新增
    },
  });
},
```

### Step 5.3: 在 store 中添加 updateProject 支持新字段

确认 `updateProject` 调用时，`Partial<ErProject>` 已能传递 `default_constraint_method` 和 `default_comment_format`（TypeScript 类型更新后自动生效）。

Store 中 `updateProject` 的 invoke 调用需要将 camelCase 映射回 snake_case（如果 store 有这样的转换）。找到 `er_update_project` invoke，确认 `req` 参数会包含新字段：

```typescript
await invoke('er_update_project', {
  id,
  req: {
    name: updates.name,
    description: updates.description,
    viewport_x: updates.viewport_x,
    viewport_y: updates.viewport_y,
    viewport_zoom: updates.viewport_zoom,
    default_constraint_method: updates.default_constraint_method,   // ← 新增
    default_comment_format: updates.default_comment_format,         // ← 新增
  },
});
```

### Step 5.4: 在 store 中添加 updateTable 支持新字段

找到 `er_update_table` invoke，确认传入：

```typescript
await invoke('er_update_table', {
  id,
  req: {
    // ...已有字段...
    constraint_method: updates.constraint_method,
    comment_format: updates.comment_format,
  },
});
```

注意：**要支持重置为 NULL**，当 `constraint_method` 为 `null` 时，传 `''`（空字符串）给 Rust，Rust 端判断空字符串置为 NULL：

```typescript
constraint_method: updates.constraint_method !== undefined
  ? (updates.constraint_method ?? '')
  : undefined,
comment_format: updates.comment_format !== undefined
  ? (updates.comment_format ?? '')
  : undefined,
```

### Step 5.5: 在 store 中添加 updateRelation 支持新字段

```typescript
await invoke('er_update_relation', {
  id,
  req: {
    // ...已有字段...
    constraint_method: updates.constraint_method !== undefined
      ? (updates.constraint_method ?? '')
      : undefined,
    comment_format: updates.comment_format !== undefined
      ? (updates.comment_format ?? '')
      : undefined,
  },
});
```

### Step 5.6: TypeScript 类型检查

```bash
cd /home/wallfacers/project/open-db-studio && npx tsc --noEmit 2>&1 | head -40
```

期望：0 errors（或仅有与本次修改无关的已有 errors）。

- [ ] Step 5.1: 更新 types/index.ts
- [ ] Step 5.2–5.5: 更新 store
- [ ] Step 5.6: tsc --noEmit 通过

```bash
git add src/types/index.ts src/store/erDesignerStore.ts
git commit -m "feat(er): update frontend types and store for constraint_method fields"
```

- [ ] Commit

---

## Task 6: EREdge 视觉更新和弹出菜单扩展

**Files:**
- Modify: `src/components/ERDesigner/ERCanvas/index.tsx`
- Modify: `src/components/ERDesigner/ERCanvas/EREdge.tsx`

### Step 6.1: 更新 ERCanvas/index.tsx — 边数据携带新字段并修复更新逻辑

在构建边数据的两处（reloadCanvas 和 setEdges 更新）中，将 `data` 改为携带新字段：

```typescript
// 修改 edge data 构建函数（提取为 helper，避免重复）
const buildEdgeData = (rel: ErRelation) => ({
  relation_type: rel.relation_type,
  source_type: rel.source,
  constraint_method: rel.constraint_method,       // null = 继承
  comment_format: rel.comment_format,             // null = 继承
});
```

在 `reloadCanvas` 中：
```typescript
const newEdges = state.relations.map((rel) => ({
  id: erEdgeNodeId(rel.id),
  source: erTableNodeId(rel.source_table_id),
  sourceHandle: `${rel.source_column_id}-source`,
  target: erTableNodeId(rel.target_table_id),
  targetHandle: `${rel.target_column_id}-target`,
  type: 'erEdge',
  data: buildEdgeData(rel),
}))
```

在 `setEdges(eds => {...})` 的更新逻辑中，**同时更新已有边的数据**（修复 data 不同步的问题）：

```typescript
setEdges(eds => {
  const currentRelIds = new Set(relations.map(r => r.id))
  const currentTableIds = new Set(tables.map(t => t.id))
  // Remove stale edges
  const filtered = eds.filter(e => {
    // ...原有删除逻辑不变...
  })
  // Update existing + add new
  const existingById = new Map(filtered.map(e => [e.id, e]))
  return relations
    .filter(r => currentTableIds.has(r.source_table_id) && currentTableIds.has(r.target_table_id))
    .map(rel => {
      const existing = existingById.get(erEdgeNodeId(rel.id))
      return {
        id: erEdgeNodeId(rel.id),
        source: erTableNodeId(rel.source_table_id),
        sourceHandle: `${rel.source_column_id}-source`,
        target: erTableNodeId(rel.target_table_id),
        targetHandle: `${rel.target_column_id}-target`,
        type: 'erEdge',
        ...(existing ? { selected: existing.selected, zIndex: existing.zIndex } : {}),
        data: buildEdgeData(rel),
      }
    })
})
```

同样更新 `onConnect` 中新连线的 data：
```typescript
data: { relation_type: 'one_to_many', source_type: 'designer', constraint_method: null, comment_format: null }
```

### Step 6.2: 更新 EREdge.tsx — 有效约束方式计算

在 `EREdge` 组件顶部，从 store 读取解析所需的数据：

```typescript
const relations = useErDesignerStore(s => s.relations);
const tables = useErDesignerStore(s => s.tables);
const activeProjectId = useErDesignerStore(s => s.activeProjectId);
const projects = useErDesignerStore(s => s.projects);
```

在组件内（`sourceType` 定义附近）添加：

```typescript
const rid = parseErEdgeNodeId(id);
const storeRelation = rid != null ? relations.find(r => r.id === rid) : undefined;
const sourceTable = storeRelation
  ? tables.find(t => t.id === storeRelation.source_table_id)
  : undefined;
const project = projects.find(p => p.id === activeProjectId);

// 三级继承：relation → table → project → 'database_fk'
const effectiveConstraintMethod =
  storeRelation?.constraint_method
  ?? sourceTable?.constraint_method
  ?? project?.default_constraint_method
  ?? 'database_fk';

const effectiveCommentFormat =
  storeRelation?.comment_format
  ?? sourceTable?.comment_format
  ?? project?.default_comment_format
  ?? '@ref';
```

### Step 6.3: 更新 EREdge.tsx — 连线样式

将原有的 `strokeDasharray` 逻辑从依赖 `sourceType` 改为依赖 `effectiveConstraintMethod`：

```typescript
const edgeStyle: React.CSSProperties = {
  stroke: strokeColor,
  strokeWidth: selected ? 2.5 : 2,
  // database_fk = 实线，comment_ref = 虚线
  strokeDasharray: effectiveConstraintMethod === 'comment_ref' ? '6 3' : undefined,
  ...(selected ? { filter: `drop-shadow(0 0 6px ${SELECTED_COLOR})` } : {}),
};
```

### Step 6.4: 更新 EREdge.tsx — 标签徽章图标

在标签按钮内显示约束图标：

```typescript
// 在 RELATION_LABEL_MAP 下方添加常量
const CONSTRAINT_BADGE: Record<string, string> = {
  database_fk: '🔒',
  comment_ref: '💬',
};
```

修改标签按钮，在 relation type label 前加图标：

```typescript
<button ref={labelBtnRef} ... >
  <span className="opacity-70 mr-0.5">{CONSTRAINT_BADGE[effectiveConstraintMethod] ?? ''}</span>
  {displayLabel}
</button>
```

### Step 6.5: 更新 EREdge.tsx — 弹出菜单扩展

在 `RELATION_TYPES` 常量下方添加约束方式和格式的选项：

```typescript
const CONSTRAINT_METHOD_OPTIONS = [
  { value: '', label: '继承默认' },
  { value: 'database_fk', label: '数据库外键 🔒' },
  { value: 'comment_ref', label: '注释引用 💬' },
] as const;

const COMMENT_FORMAT_OPTIONS = [
  { value: '', label: '继承默认' },
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
] as const;
```

添加 handler：

```typescript
const handleChangeConstraintMethod = (newMethod: string) => {
  if (rid == null) return;
  // 空字符串 = 重置为继承（null）
  updateRelation(rid, { constraint_method: newMethod || null });
};

const handleChangeCommentFormat = (newFormat: string) => {
  if (rid == null) return;
  updateRelation(rid, { comment_format: newFormat || null });
};
```

在 portal dropdown 中，在 `RELATION_TYPES` 选项列表之后，添加分隔线和约束方式区块：

```typescript
{menuOpen && createPortal(
  <div ref={dropdownRef} style={{ position: 'fixed', left: dropdownPos.left, top: dropdownPos.top, zIndex: 9999 }}
    className="bg-background-panel border border-border-strong rounded shadow-lg min-w-[160px]"
    onMouseDown={(e) => e.stopPropagation()}>
    
    {/* 关系类型 */}
    <div className="px-2 pt-1 pb-0.5 text-[10px] text-foreground-muted">关系类型</div>
    {RELATION_TYPES.map(rt => (
      <button key={rt.value} type="button"
        onClick={(e) => { e.stopPropagation(); handleChangeType(rt.value); }}
        className={`block w-full px-3 py-1 text-xs font-mono text-left transition-colors
          ${rt.value === relationType ? 'text-accent bg-border-strong' : 'text-foreground-default hover:bg-border-strong hover:text-foreground'}`}>
        {rt.label}
      </button>
    ))}

    {/* 约束方式 */}
    <div className="border-t border-border-strong my-1" />
    <div className="px-2 pt-0.5 pb-0.5 text-[10px] text-foreground-muted flex items-center justify-between">
      <span>约束方式</span>
      {storeRelation?.constraint_method && (
        <button type="button" onClick={() => handleChangeConstraintMethod('')}
          className="text-[9px] text-warning hover:text-foreground-default">重置</button>
      )}
    </div>
    {CONSTRAINT_METHOD_OPTIONS.map(opt => (
      <button key={opt.value} type="button"
        onClick={(e) => { e.stopPropagation(); handleChangeConstraintMethod(opt.value); }}
        className={`block w-full px-3 py-1 text-xs text-left transition-colors
          ${(storeRelation?.constraint_method ?? '') === opt.value ? 'text-accent bg-border-strong' : 'text-foreground-default hover:bg-border-strong hover:text-foreground'}`}>
        {opt.label}
      </button>
    ))}

    {/* 注释格式（仅 comment_ref 时显示） */}
    {effectiveConstraintMethod === 'comment_ref' && (
      <>
        <div className="border-t border-border-strong my-1" />
        <div className="px-2 pt-0.5 pb-0.5 text-[10px] text-foreground-muted flex items-center justify-between">
          <span>注释格式</span>
          {storeRelation?.comment_format && (
            <button type="button" onClick={() => handleChangeCommentFormat('')}
              className="text-[9px] text-warning hover:text-foreground-default">重置</button>
          )}
        </div>
        {COMMENT_FORMAT_OPTIONS.map(opt => (
          <button key={opt.value} type="button"
            onClick={(e) => { e.stopPropagation(); handleChangeCommentFormat(opt.value); }}
            className={`block w-full px-3 py-1 text-xs text-left font-mono transition-colors
              ${(storeRelation?.comment_format ?? '') === opt.value ? 'text-accent bg-border-strong' : 'text-foreground-default hover:bg-border-strong hover:text-foreground'}`}>
            {opt.label}
          </button>
        ))}
      </>
    )}
  </div>,
  document.body,
)}
```

### Step 6.6: 手动验证

```bash
cd /home/wallfacers/project/open-db-studio && npm run dev
```

- 在 ER 画布上创建两张表并连线
- 点击连线，确认弹出菜单显示"关系类型"和"约束方式"两块
- 将约束方式改为"注释引用"，确认连线变为虚线，标签显示 💬 图标
- 改回"数据库外键"，确认变为实线，显示 🔒 图标
- 点"重置"，确认图标变为对应继承来的约束方式

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] Step 6.1: 更新 ERCanvas/index.tsx
- [ ] Step 6.2–6.4: 更新 EREdge.tsx 视觉
- [ ] Step 6.5: 更新 EREdge.tsx 弹出菜单
- [ ] Step 6.6: 手动验证

```bash
git add src/components/ERDesigner/ERCanvas/index.tsx src/components/ERDesigner/ERCanvas/EREdge.tsx
git commit -m "feat(er): add constraint_method visual indicators and edge popup controls"
```

- [ ] Commit

---

## Task 7: RelationsTab 组件 + 集成到 ERPropertyDrawer

**Files:**
- Create: `src/components/ERDesigner/ERPropertyDrawer/RelationsTab.tsx`
- Modify: `src/components/ERDesigner/ERPropertyDrawer/index.tsx`

### Step 7.1: 创建 RelationsTab.tsx

```typescript
import { useErDesignerStore } from '@/store/erDesignerStore';

const CONSTRAINT_METHOD_LABELS: Record<string, string> = {
  database_fk: '数据库外键 🔒',
  comment_ref: '注释引用 💬',
};

const COMMENT_FORMAT_OPTIONS = [
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
];

interface Props { tableId: number }

export default function RelationsTab({ tableId }: Props) {
  const {
    tables, relations, columns, projects, activeProjectId,
    updateTable, updateRelation,
  } = useErDesignerStore();

  const table = tables.find(t => t.id === tableId);
  const project = projects.find(p => p.id === activeProjectId);

  // 该表涉及的所有关系（作为 source 或 target）
  const tableRelations = relations.filter(
    r => r.source_table_id === tableId || r.target_table_id === tableId
  );

  // 项目级生效值
  const projectMethod = project?.default_constraint_method ?? 'database_fk';
  const projectFormat = project?.default_comment_format ?? '@ref';

  // 该表级别的生效值（用于显示继承来源）
  const tableEffectiveMethod = table?.constraint_method ?? projectMethod;
  const tableEffectiveFormat = table?.comment_format ?? projectFormat;

  const handleTableConstraintMethod = (value: string) => {
    // 空字符串 = 重置为 null（继承项目）
    updateTable(tableId, { constraint_method: value === '' ? null : value });
  };

  const handleTableCommentFormat = (value: string) => {
    updateTable(tableId, { comment_format: value === '' ? null : value });
  };

  const handleRelationConstraintMethod = (relId: number, value: string) => {
    updateRelation(relId, { constraint_method: value === '' ? null : value });
  };

  const handleRelationCommentFormat = (relId: number, value: string) => {
    updateRelation(relId, { comment_format: value === '' ? null : value });
  };

  const getRelationLabel = (rel: typeof tableRelations[number]) => {
    const srcTable = tables.find(t => t.id === rel.source_table_id);
    const tgtTable = tables.find(t => t.id === rel.target_table_id);
    const srcCol = columns[rel.source_table_id]?.find(c => c.id === rel.source_column_id);
    const tgtCol = columns[rel.target_table_id]?.find(c => c.id === rel.target_column_id);
    return `${srcTable?.name ?? '?'}.${srcCol?.name ?? '?'} → ${tgtTable?.name ?? '?'}.${tgtCol?.name ?? '?'}`;
  };

  const getRelationEffectiveMethod = (rel: typeof tableRelations[number]) => {
    return rel.constraint_method ?? table?.constraint_method ?? projectMethod;
  };

  const getRelationEffectiveFormat = (rel: typeof tableRelations[number]) => {
    return rel.comment_format ?? table?.comment_format ?? projectFormat;
  };

  return (
    <div className="p-3 space-y-4">
      {/* ── 表级默认设置 ── */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
          表级默认（覆盖项目设置）
        </div>

        {/* constraint_method */}
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-foreground-default w-20 shrink-0">约束方式</label>
          <select
            value={table?.constraint_method ?? ''}
            onChange={e => handleTableConstraintMethod(e.target.value)}
            className="flex-1 bg-background-base border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default"
          >
            <option value="">继承项目（{CONSTRAINT_METHOD_LABELS[projectMethod]}）</option>
            <option value="database_fk">数据库外键 🔒</option>
            <option value="comment_ref">注释引用 💬</option>
          </select>
        </div>

        {/* comment_format（仅 comment_ref 时显示）*/}
        {tableEffectiveMethod === 'comment_ref' && (
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-foreground-default w-20 shrink-0">注释格式</label>
            <select
              value={table?.comment_format ?? ''}
              onChange={e => handleTableCommentFormat(e.target.value)}
              className="flex-1 bg-background-base border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default font-mono"
            >
              <option value="">继承项目（{projectFormat}）</option>
              {COMMENT_FORMAT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── 关系列表 ── */}
      {tableRelations.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
            涉及的关系（{tableRelations.length}）
          </div>
          <div className="space-y-1">
            {tableRelations.map(rel => {
              const effMethod = getRelationEffectiveMethod(rel);
              const effFormat = getRelationEffectiveFormat(rel);
              const isOverriding = rel.constraint_method !== null;
              return (
                <div key={rel.id} className="border border-border-strong rounded p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-foreground-default font-mono truncate">
                      {getRelationLabel(rel)}
                    </span>
                    <span className="text-[10px] shrink-0 ml-1 px-1 rounded"
                      style={{ color: isOverriding ? 'var(--warning)' : 'var(--foreground-muted)' }}>
                      {isOverriding ? '已覆盖' : '继承'}
                    </span>
                  </div>
                  {/* 关系级约束方式 */}
                  <div className="flex items-center gap-2">
                    <select
                      value={rel.constraint_method ?? ''}
                      onChange={e => handleRelationConstraintMethod(rel.id, e.target.value)}
                      className="flex-1 bg-background-base border border-border-strong rounded px-2 py-0.5 text-[11px] text-foreground-default"
                    >
                      <option value="">继承（{CONSTRAINT_METHOD_LABELS[tableEffectiveMethod]}）</option>
                      <option value="database_fk">数据库外键 🔒</option>
                      <option value="comment_ref">注释引用 💬</option>
                    </select>
                  </div>
                  {/* 注释格式（仅 comment_ref 时显示）*/}
                  {effMethod === 'comment_ref' && (
                    <div className="flex items-center gap-2">
                      <select
                        value={rel.comment_format ?? ''}
                        onChange={e => handleRelationCommentFormat(rel.id, e.target.value)}
                        className="flex-1 bg-background-base border border-border-strong rounded px-2 py-0.5 text-[11px] text-foreground-default font-mono"
                      >
                        <option value="">继承（{effFormat}）</option>
                        {COMMENT_FORMAT_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tableRelations.length === 0 && (
        <div className="text-[12px] text-foreground-muted text-center py-4">
          该表暂无关系
        </div>
      )}
    </div>
  );
}
```

### Step 7.2: 更新 ERPropertyDrawer/index.tsx

**添加 'relations' 到 TabType**：

```typescript
type TabType = 'columns' | 'indexes' | 'properties' | 'relations';
```

**在标签栏渲染中添加 'relations'**：

```typescript
{(['columns', 'indexes', 'properties', 'relations'] as TabType[]).map(tab => (
  <button key={tab} ...>
    {tab === 'columns' ? '列'
      : tab === 'indexes' ? '索引'
      : tab === 'properties' ? '表属性'
      : '关系'}
  </button>
))}
```

**在 Tab content 中添加 RelationsTab**：

```typescript
import RelationsTab from './RelationsTab';

// 在 tab content 区域添加：
{activeTab === 'relations' && <RelationsTab tableId={drawerTableId} />}
```

### Step 7.3: 验证

```bash
npx tsc --noEmit 2>&1 | head -20
```

运行 dev，选中一张表，打开属性抽屉，确认有"关系"标签页，能看到关系列表，能切换约束方式。

- [ ] Step 7.1: 创建 RelationsTab.tsx
- [ ] Step 7.2: 更新 ERPropertyDrawer/index.tsx
- [ ] Step 7.3: 验证

```bash
git add src/components/ERDesigner/ERPropertyDrawer/RelationsTab.tsx src/components/ERDesigner/ERPropertyDrawer/index.tsx
git commit -m "feat(er): add RelationsTab to ERPropertyDrawer for table-level constraint settings"
```

- [ ] Commit

---

## Task 8: 表属性面板 + 项目设置 + DDL 弹窗更新

**Files:**
- Modify: `src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx`
- Create: `src/components/ERDesigner/dialogs/ProjectSettingsDialog.tsx`
- Modify: `src/components/ERDesigner/ERCanvas/ERToolbar.tsx`
- Modify: `src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx`

### Step 8.1: TablePropertiesTab — 仅在表级面板显示继承来源说明

在 `TablePropertiesTab.tsx` 中（原有表名、注释、颜色之后），添加约束方式快捷状态说明（只读，引导用户去"关系"标签页）：

```typescript
// 在 imports 中添加
import { useErDesignerStore } from '@/store/erDesignerStore';

// 在组件内，现有 JSX 末尾（颜色选择之后）添加
const { tables, projects, activeProjectId } = useErDesignerStore();
const table = tables.find(t => t.id === tableId);
const project = projects.find(p => p.id === activeProjectId);
const projectMethod = project?.default_constraint_method ?? 'database_fk';
const effectiveMethod = table?.constraint_method ?? projectMethod;
```

在 JSX 末尾追加：

```tsx
{/* 约束方式摘要 */}
<div className="mt-3 pt-3 border-t border-border-strong">
  <div className="text-[11px] text-foreground-muted mb-1">默认约束方式</div>
  <div className="flex items-center gap-2">
    <span className="text-[12px]">
      {effectiveMethod === 'database_fk' ? '数据库外键 🔒' : '注释引用 💬'}
    </span>
    {table?.constraint_method
      ? <span className="text-[10px] text-warning">已覆盖</span>
      : <span className="text-[10px] text-foreground-muted">继承项目默认</span>
    }
  </div>
  <div className="text-[10px] text-foreground-muted mt-0.5">
    在"关系"标签页可按表或按关系单独配置
  </div>
</div>
```

### Step 8.2: 创建 ProjectSettingsDialog.tsx

```typescript
import React from 'react';
import { BaseModal } from '../../common/BaseModal';
import { useErDesignerStore } from '@/store/erDesignerStore';

interface Props {
  visible: boolean;
  projectId: number;
  onClose: () => void;
}

const COMMENT_FORMAT_OPTIONS = [
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
];

export const ProjectSettingsDialog: React.FC<Props> = ({ visible, projectId, onClose }) => {
  const { projects, updateProject } = useErDesignerStore();
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  const handleConstraintMethod = (value: string) => {
    updateProject(projectId, { default_constraint_method: value });
  };

  const handleCommentFormat = (value: string) => {
    updateProject(projectId, { default_comment_format: value });
  };

  return (
    <BaseModal visible={visible} onClose={onClose} title="项目设置" width={400}>
      <div className="p-4 space-y-4">
        {/* 约束方式默认值 */}
        <div>
          <div className="text-[12px] font-medium text-foreground-default mb-2">
            约束方式默认值
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="constraint_method"
                value="database_fk"
                checked={project.default_constraint_method === 'database_fk'}
                onChange={() => handleConstraintMethod('database_fk')}
                className="accent-accent"
              />
              <span className="text-[12px] text-foreground-default">数据库外键 🔒</span>
              <span className="text-[11px] text-foreground-muted">（DDL 生成 FOREIGN KEY 约束）</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="constraint_method"
                value="comment_ref"
                checked={project.default_constraint_method === 'comment_ref'}
                onChange={() => handleConstraintMethod('comment_ref')}
                className="accent-accent"
              />
              <span className="text-[12px] text-foreground-default">注释引用 💬</span>
              <span className="text-[11px] text-foreground-muted">（在列注释中写入引用标记）</span>
            </label>
          </div>
        </div>

        {/* 注释格式（仅 comment_ref 时显示）*/}
        {project.default_constraint_method === 'comment_ref' && (
          <div>
            <div className="text-[12px] font-medium text-foreground-default mb-2">
              注释格式
            </div>
            <select
              value={project.default_comment_format}
              onChange={e => handleCommentFormat(e.target.value)}
              className="w-full bg-background-base border border-border-strong rounded px-2 py-1.5 text-[12px] text-foreground-default font-mono"
            >
              {COMMENT_FORMAT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="text-[11px] text-foreground-muted pt-1 border-t border-border-strong">
          表级和关系级可单独覆盖这里的默认值。
        </div>
      </div>
    </BaseModal>
  );
};
```

### Step 8.3: 更新 ERToolbar.tsx — 添加项目设置按钮

在 `ERToolbar` 组件接口和实现中添加 `onOpenSettings` 回调：

```typescript
export interface ERToolbarProps {
  // ...已有字段...
  onOpenSettings?: () => void;   // ← 新增
}
```

在工具栏按钮列表中（`Link2` 绑定连接按钮附近），追加设置按钮：

```typescript
import { Settings } from 'lucide-react';

// 在返回的 JSX 中，工具栏按钮区域末尾追加：
{onOpenSettings && (
  <button
    type="button"
    onClick={onOpenSettings}
    title="项目设置"
    className="p-1.5 rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors"
  >
    <Settings size={15} />
  </button>
)}
```

### Step 8.4: 在 ERCanvas/index.tsx 中集成 ProjectSettingsDialog

在 `ERCanvasInner` 组件中，添加 settings 对话框状态并渲染：

```typescript
import { ProjectSettingsDialog } from '../dialogs/ProjectSettingsDialog';

// 在 state 中添加：
const [showSettings, setShowSettings] = useState(false);

// 在 ERToolbar 中传入回调：
<ERToolbar
  // ...已有 props...
  onOpenSettings={() => setShowSettings(true)}
/>

// 在组件末尾添加对话框：
<ProjectSettingsDialog
  visible={showSettings}
  projectId={projectId}
  onClose={() => setShowSettings(false)}
/>
```

### Step 8.5: 更新 DDLPreviewDialog.tsx — 拆分 FK 开关

将 `includeForeignKeys` 开关拆分为两个独立开关：

```typescript
const [includeForeignKeys, setIncludeForeignKeys] = useState(false);
const [includeCommentRefs, setIncludeCommentRefs] = useState(true);   // ← 新增
```

更新 `generateDDL` 调用，传入新参数：

```typescript
generateDDL(projectId, dialect, {
  includeIndexes,
  includeComments,
  includeForeignKeys,
  includeCommentRefs,   // ← 新增
})
```

在 JSX 中找到 `includeForeignKeys` 的 checkbox，其后追加新 checkbox：

```tsx
{/* 在已有"生成外键约束"复选框下方添加 */}
<label className="flex items-center gap-2 cursor-pointer">
  <input
    type="checkbox"
    checked={includeCommentRefs}
    onChange={e => setIncludeCommentRefs(e.target.checked)}
    className="accent-accent"
  />
  <span className="text-[12px] text-foreground-default">在列注释中生成引用标记 💬</span>
</label>
```

### Step 8.6: 完整验证

```bash
npx tsc --noEmit 2>&1 | head -20
npm run dev
```

验证路径：
1. 工具栏 → Settings 按钮 → 项目设置弹窗 → 切换约束方式和格式 → 关闭
2. 选中表 → 属性抽屉 → "表属性"标签页 → 查看约束方式摘要
3. DDL 弹窗 → 确认有"在列注释中生成引用标记"选项
4. 创建两表连线，将连线设为 `comment_ref` → 打开 DDL → 确认生成 `@ref:xxx.xxx` 注释而非 FK 约束

- [ ] Step 8.1: 更新 TablePropertiesTab.tsx
- [ ] Step 8.2: 创建 ProjectSettingsDialog.tsx
- [ ] Step 8.3: 更新 ERToolbar.tsx
- [ ] Step 8.4: 集成到 ERCanvas/index.tsx
- [ ] Step 8.5: 更新 DDLPreviewDialog.tsx
- [ ] Step 8.6: 完整验证

```bash
git add src/components/ERDesigner/ERPropertyDrawer/TablePropertiesTab.tsx \
  src/components/ERDesigner/dialogs/ProjectSettingsDialog.tsx \
  src/components/ERDesigner/ERCanvas/ERToolbar.tsx \
  src/components/ERDesigner/ERCanvas/index.tsx \
  src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx
git commit -m "feat(er): add project settings dialog, constraint summary in table properties, split DDL options"
```

- [ ] Commit

---

## 完成验收标准

- [ ] 所有 Rust 单元测试通过：`cargo test er::`
- [ ] TypeScript 无编译错误：`npx tsc --noEmit`
- [ ] 新连线默认约束方式继承项目设置（实线 🔒）
- [ ] 切换为 comment_ref 后连线变虚线 💬
- [ ] DDL 生成：comment_ref 关系在源列注释末尾加入标记，不生成 FK 约束
- [ ] DDL 生成：database_fk 关系正常生成 FOREIGN KEY 约束
- [ ] 三级继承：项目 → 表 → 关系，低层级覆盖高层级，"重置"可恢复继承
- [ ] 现有 ER 项目迁移后正常运行（默认 `database_fk`，行为与旧版一致）
