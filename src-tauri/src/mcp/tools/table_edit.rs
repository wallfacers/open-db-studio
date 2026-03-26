use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

// ─── 共享：标识符引用 ───────────────────────────────────────────────────────
fn q(name: &str, is_pg: bool) -> String {
    if is_pg { format!("\"{}\"", name) } else { format!("`{}`", name) }
}

fn validate_ident(name: &str, label: &str) -> crate::AppResult<()> {
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(format!("Invalid {}: {}", label, name)));
    }
    Ok(())
}

fn esc(s: &str) -> String { s.replace('\'', "''") }

// ─── 共享：从 JSON 解析列定义 ───────────────────────────────────────────────
struct ColInput {
    name: String,
    data_type: String,
    length: String,
    is_nullable: bool,
    default_value: String,
    is_primary_key: bool,
    extra: String,
    comment: String,
}

impl ColInput {
    fn from_json(v: &Value) -> crate::AppResult<Self> {
        let name = v["name"].as_str()
            .ok_or_else(|| crate::AppError::Other("column missing 'name'".into()))?
            .to_string();
        validate_ident(&name, "column name")?;
        Ok(Self {
            name,
            data_type: v["data_type"].as_str().unwrap_or("VARCHAR").to_uppercase(),
            length: v["length"].as_str().unwrap_or("").to_string(),
            is_nullable: v["is_nullable"].as_bool().unwrap_or(true),
            default_value: v["default_value"].as_str().unwrap_or("").to_string(),
            is_primary_key: v["is_primary_key"].as_bool().unwrap_or(false),
            extra: v["extra"].as_str().unwrap_or("").to_string(),
            comment: v["comment"].as_str().unwrap_or("").to_string(),
        })
    }

    /// MySQL 列定义：`name` TYPE(len) [NOT] NULL [DEFAULT x] [EXTRA] [COMMENT 'c']
    fn def_mysql(&self) -> String {
        let typ = if self.length.is_empty() {
            self.data_type.clone()
        } else {
            format!("{}({})", self.data_type, self.length)
        };
        let nullable = if self.is_nullable { "NULL" } else { "NOT NULL" };
        let def = if self.default_value.is_empty() { String::new() } else { format!("DEFAULT {}", self.default_value) };
        let extra = if self.extra.is_empty() { String::new() } else { self.extra.to_uppercase() };
        let comment = if self.comment.is_empty() { String::new() } else { format!("COMMENT '{}'", esc(&self.comment)) };
        [q(&self.name, false), typ, nullable.into(), def, extra, comment]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }

    /// PostgreSQL 列定义：`"name"` TYPE(len) [NOT] NULL [DEFAULT x]
    fn def_pg(&self) -> String {
        let typ = if self.length.is_empty() {
            self.data_type.clone()
        } else {
            format!("{}({})", self.data_type, self.length)
        };
        let nullable = if self.is_nullable { "NULL" } else { "NOT NULL" };
        let def = if self.default_value.is_empty() { String::new() } else { format!("DEFAULT {}", self.default_value) };
        [q(&self.name, true), typ, nullable.into(), def]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

// ─── 共享：auto_mode 检查 + datasource 创建 ────────────────────────────────
async fn require_auto_and_ds(
    handle: &Arc<tauri::AppHandle>,
    conn_id: i64,
    database: &str,
) -> crate::AppResult<(crate::datasource::ConnectionConfig, Box<dyn crate::datasource::DataSource>)> {
    let auto_mode = {
        let app_state = handle.state::<crate::AppState>();
        let x = *app_state.auto_mode.lock().await; x
    };
    if !auto_mode {
        return Err(crate::AppError::Other("Auto 模式已关闭，请开启 Auto 模式后重试".into()));
    }
    let config = crate::db::get_connection_config(conn_id)?;
    let ds = if database.is_empty() {
        crate::datasource::create_datasource(&config).await?
    } else {
        crate::datasource::create_datasource_with_db(&config, database).await?
    };
    Ok((config, ds))
}

/// 逐条执行 SQL 语句列表，遇到第一个错误即停止
async fn execute_statements(ds: &dyn crate::datasource::DataSource, stmts: &[String]) -> crate::AppResult<()> {
    for sql in stmts {
        ds.execute(sql).await?;
    }
    Ok(())
}

pub async fn get_column_meta(_handle: Arc<tauri::AppHandle>, args: Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    if !table_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid table name".into()));
    }
    let database = args["database"].as_str();
    let config = crate::db::get_connection_config(conn_id)?;
    let ds = match database.filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let columns = ds.get_columns(table_name, None).await?;
    Ok(serde_json::to_string_pretty(&columns).unwrap_or_default())
}

pub async fn update_column_comment(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    // 检查 auto_mode
    let auto_mode = {
        let app_state = handle.state::<crate::AppState>();
        let x = *app_state.auto_mode.lock().await; x
    };

    if !auto_mode {
        return Err(crate::AppError::Other(
            "Auto 模式已关闭，请通过 ACP 确认后执行写操作".into()
        ));
    }

    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    let comment = args["comment"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing comment".into()))?;
    let database = args["database"].as_str().unwrap_or("");

    // 验证表名和列名安全性
    if !table_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid table name".into()));
    }
    if !column_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other("Invalid column name".into()));
    }

    let config = crate::db::get_connection_config(conn_id)?;
    let ds = if database.is_empty() {
        crate::datasource::create_datasource(&config).await?
    } else {
        crate::datasource::create_datasource_with_db(&config, database).await?
    };

    // 读取当前列信息
    let columns = ds.get_columns(table_name, None).await?;
    let col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;
    let old_value = serde_json::to_string(col).unwrap_or_default();

    let target_id = format!("{}:{}.{}", conn_id, table_name, column_name);
    let history_id = crate::db::insert_change_history(
        &session_id,
        "update_column_comment",
        "column",
        &target_id,
        &old_value,
    )?;

    // 执行 ALTER TABLE
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "ALTER TABLE `{}` MODIFY COLUMN `{}` {} COMMENT '{}'",
            table_name,
            column_name,
            col.data_type,
            comment.replace('\'', "''")
        ),
        "postgres" => format!(
            "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}'",
            table_name,
            column_name,
            comment.replace('\'', "''")
        ),
        _ => return Err(crate::AppError::Other("update_column_comment only supports mysql/postgres".into())),
    };

    let result = ds.execute(&sql).await;

    match result {
        Ok(_) => {
            let new_value = json!({ "comment": comment }).to_string();
            crate::db::complete_change_history(history_id, Some(&new_value), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("{}.{} 注释已更新为「{}」，可输入「撤销」回滚", table_name, column_name, comment)
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE TABLE
// ═══════════════════════════════════════════════════════════════════════════
/// args: { connection_id, table_name, database?, columns: [{name, data_type, length?, is_nullable?, default_value?, is_primary_key?, extra?, comment?}] }
pub async fn create_table(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    validate_ident(table_name, "table name")?;
    let database = args["database"].as_str().unwrap_or("");

    let cols_arr = args["columns"].as_array()
        .ok_or_else(|| crate::AppError::Other("missing columns array".into()))?;
    if cols_arr.is_empty() {
        return Err(crate::AppError::Other("columns array is empty".into()));
    }

    let cols: Vec<ColInput> = cols_arr.iter().map(ColInput::from_json).collect::<Result<_, _>>()?;

    let (config, ds) = require_auto_and_ds(&handle, conn_id, database).await?;
    let is_pg = config.driver == "postgres";

    // 生成 DDL
    let pk_cols: Vec<String> = cols.iter().filter(|c| c.is_primary_key).map(|c| q(&c.name, is_pg)).collect();
    let col_lines: Vec<String> = cols.iter().map(|c| {
        format!("  {}", if is_pg { c.def_pg() } else { c.def_mysql() })
    }).collect();
    let mut lines = col_lines;
    if !pk_cols.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    let create_sql = format!("CREATE TABLE {} (\n{}\n)", q(table_name, is_pg), lines.join(",\n"));

    // PostgreSQL 列注释单独执行
    let mut stmts = vec![create_sql];
    if is_pg {
        for c in &cols {
            if !c.comment.is_empty() {
                stmts.push(format!(
                    "COMMENT ON COLUMN {}.{} IS '{}'",
                    q(table_name, true), q(&c.name, true), esc(&c.comment)
                ));
            }
        }
    }

    let history_id = crate::db::insert_change_history(
        &session_id, "create_table", "table",
        &format!("{}:{}", conn_id, table_name), "",
    )?;

    match execute_statements(ds.as_ref(), &stmts).await {
        Ok(()) => {
            let new_val = serde_json::to_string(&args["columns"]).unwrap_or_default();
            crate::db::complete_change_history(history_id, Some(&new_val), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("表 {} 创建成功", table_name),
                "sql": stmts.join(";\n")
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADD COLUMN
// ═══════════════════════════════════════════════════════════════════════════
/// args: { connection_id, table_name, database?, column: {name, data_type, ...}, after_column? }
pub async fn add_column(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    validate_ident(table_name, "table name")?;
    let database = args["database"].as_str().unwrap_or("");

    let col = ColInput::from_json(&args["column"])?;
    let after_col = args["after_column"].as_str().unwrap_or("");

    let (config, ds) = require_auto_and_ds(&handle, conn_id, database).await?;
    let is_pg = config.driver == "postgres";

    let mut stmts = Vec::new();
    if is_pg {
        stmts.push(format!("ALTER TABLE {} ADD COLUMN {}", q(table_name, true), col.def_pg()));
        if !col.comment.is_empty() {
            stmts.push(format!(
                "COMMENT ON COLUMN {}.{} IS '{}'",
                q(table_name, true), q(&col.name, true), esc(&col.comment)
            ));
        }
    } else {
        let pos = if after_col.is_empty() { String::new() } else { format!(" AFTER {}", q(after_col, false)) };
        stmts.push(format!("ALTER TABLE {} ADD COLUMN {}{}", q(table_name, false), col.def_mysql(), pos));
    }

    let target_id = format!("{}:{}.{}", conn_id, table_name, col.name);
    let history_id = crate::db::insert_change_history(
        &session_id, "add_column", "column", &target_id, "",
    )?;

    match execute_statements(ds.as_ref(), &stmts).await {
        Ok(()) => {
            crate::db::complete_change_history(history_id, Some(&serde_json::to_string(&args["column"]).unwrap_or_default()), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("{}.{} 列已添加", table_name, col.name),
                "sql": stmts.join(";\n")
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DROP COLUMN
// ═══════════════════════════════════════════════════════════════════════════
/// args: { connection_id, table_name, database?, column_name }
pub async fn drop_column(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    validate_ident(table_name, "table name")?;
    validate_ident(column_name, "column name")?;
    let database = args["database"].as_str().unwrap_or("");

    let (config, ds) = require_auto_and_ds(&handle, conn_id, database).await?;
    let is_pg = config.driver == "postgres";

    // 记录旧值
    let columns = ds.get_columns(table_name, None).await?;
    let old_col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;
    let old_value = serde_json::to_string(old_col).unwrap_or_default();

    let sql = format!("ALTER TABLE {} DROP COLUMN {}", q(table_name, is_pg), q(column_name, is_pg));

    let target_id = format!("{}:{}.{}", conn_id, table_name, column_name);
    let history_id = crate::db::insert_change_history(
        &session_id, "drop_column", "column", &target_id, &old_value,
    )?;

    match ds.execute(&sql).await {
        Ok(_) => {
            crate::db::complete_change_history(history_id, None, "success")?;
            Ok(json!({
                "success": true,
                "message": format!("{}.{} 列已删除", table_name, column_name),
                "sql": sql
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MODIFY COLUMN
// ═══════════════════════════════════════════════════════════════════════════
/// args: { connection_id, table_name, database?, column_name, changes: {name?, data_type?, length?, is_nullable?, default_value?, extra?, comment?} }
pub async fn modify_column(handle: Arc<tauri::AppHandle>, args: Value, session_id: String) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    validate_ident(table_name, "table name")?;
    validate_ident(column_name, "column name")?;
    let database = args["database"].as_str().unwrap_or("");
    let changes = &args["changes"];

    let (config, ds) = require_auto_and_ds(&handle, conn_id, database).await?;
    let is_pg = config.driver == "postgres";

    // 读取当前列
    let columns = ds.get_columns(table_name, None).await?;
    let old_col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;
    let old_value = serde_json::to_string(old_col).unwrap_or_default();

    // 合并 changes 到当前值
    let new_name = changes["name"].as_str().unwrap_or(column_name);
    if new_name != column_name { validate_ident(new_name, "new column name")?; }
    let new_type = changes["data_type"].as_str().map(|s| s.to_uppercase())
        .unwrap_or_else(|| old_col.data_type.to_uppercase().split('(').next().unwrap_or("VARCHAR").to_string());
    let new_length = changes["length"].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // 从旧 data_type 提取 length，如 VARCHAR(255) → 255
            old_col.data_type.split('(').nth(1).and_then(|s| s.strip_suffix(')')).unwrap_or("").to_string()
        });
    let new_nullable = changes["is_nullable"].as_bool().unwrap_or(old_col.is_nullable);
    let new_default = changes["default_value"].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| old_col.column_default.clone().unwrap_or_default());
    let new_extra = changes["extra"].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| old_col.extra.clone().unwrap_or_default());
    let new_comment = changes["comment"].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| old_col.comment.clone().unwrap_or_default());

    let merged = ColInput {
        name: new_name.to_string(),
        data_type: new_type.clone(),
        length: new_length.clone(),
        is_nullable: new_nullable,
        default_value: new_default.clone(),
        is_primary_key: false, // MODIFY 不改 PK
        extra: new_extra,
        comment: new_comment.clone(),
    };

    let mut stmts = Vec::new();
    if is_pg {
        let tbl = q(table_name, true);
        let col_q = q(column_name, true);
        // TYPE
        let old_type_upper = old_col.data_type.to_uppercase();
        let full_new_type = if new_length.is_empty() { new_type.clone() } else { format!("{}({})", new_type, new_length) };
        if old_type_upper != full_new_type {
            stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} TYPE {}", tbl, col_q, full_new_type));
        }
        // NULLABLE
        if old_col.is_nullable != new_nullable {
            stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} {}", tbl, col_q,
                if new_nullable { "DROP NOT NULL" } else { "SET NOT NULL" }));
        }
        // DEFAULT
        let old_def = old_col.column_default.as_deref().unwrap_or("");
        if old_def != new_default {
            if new_default.is_empty() {
                stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT", tbl, col_q));
            } else {
                stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}", tbl, col_q, new_default));
            }
        }
        // COMMENT
        let old_comment = old_col.comment.as_deref().unwrap_or("");
        if old_comment != new_comment {
            let col_ref = if new_name != column_name { q(new_name, true) } else { col_q.clone() };
            if new_comment.is_empty() {
                stmts.push(format!("COMMENT ON COLUMN {}.{} IS NULL", tbl, col_ref));
            } else {
                stmts.push(format!("COMMENT ON COLUMN {}.{} IS '{}'", tbl, col_ref, esc(&new_comment)));
            }
        }
        // RENAME (last)
        if new_name != column_name {
            stmts.push(format!("ALTER TABLE {} RENAME COLUMN {} TO {}", tbl, col_q, q(new_name, true)));
        }
    } else {
        // MySQL: MODIFY COLUMN (or CHANGE COLUMN if renaming)
        if new_name != column_name {
            stmts.push(format!("ALTER TABLE {} CHANGE COLUMN {} {}",
                q(table_name, false), q(column_name, false), merged.def_mysql()));
        } else {
            stmts.push(format!("ALTER TABLE {} MODIFY COLUMN {}",
                q(table_name, false), merged.def_mysql()));
        }
    }

    if stmts.is_empty() {
        return Ok(json!({"success": true, "message": "无变更"}).to_string());
    }

    let target_id = format!("{}:{}.{}", conn_id, table_name, column_name);
    let history_id = crate::db::insert_change_history(
        &session_id, "modify_column", "column", &target_id, &old_value,
    )?;

    match execute_statements(ds.as_ref(), &stmts).await {
        Ok(()) => {
            let new_val = serde_json::to_string(&merged_to_json(&merged)).unwrap_or_default();
            crate::db::complete_change_history(history_id, Some(&new_val), "success")?;
            Ok(json!({
                "success": true,
                "message": format!("{}.{} 列已修改", table_name, column_name),
                "sql": stmts.join(";\n")
            }).to_string())
        }
        Err(e) => {
            crate::db::complete_change_history(history_id, None, "failed")?;
            Err(e)
        }
    }
}

fn merged_to_json(c: &ColInput) -> Value {
    json!({
        "name": c.name, "data_type": c.data_type, "length": c.length,
        "is_nullable": c.is_nullable, "default_value": c.default_value,
        "extra": c.extra, "comment": c.comment
    })
}
