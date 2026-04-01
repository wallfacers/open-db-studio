use serde_json::Value;

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

// ─── 共享：获取 driver + datasource（仅读取，不检查 auto_mode）────────────
async fn get_ds(
    conn_id: i64,
    database: &str,
) -> crate::AppResult<(crate::datasource::ConnectionConfig, Box<dyn crate::datasource::DataSource>)> {
    let config = crate::db::get_connection_config(conn_id)?;
    let ds = if database.is_empty() {
        crate::datasource::create_datasource(&config).await?
    } else {
        crate::datasource::create_datasource_with_db(&config, database).await?
    };
    Ok((config, ds))
}

/// 仅获取 driver 名称（不创建连接），用于纯 SQL 生成
fn get_driver(conn_id: i64) -> crate::AppResult<String> {
    let config = crate::db::get_connection_config(conn_id)?;
    Ok(config.driver)
}

// ═══════════════════════════════════════════════════════════════════════════
// 纯 SQL 生成函数（不执行，不记录 change_history）
// ═══════════════════════════════════════════════════════════════════════════

/// 生成 CREATE TABLE DDL
/// args: { connection_id, table_name, database?, columns: [{name, data_type, ...}] }
pub fn generate_create_table_sql(args: &Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    validate_ident(table_name, "table name")?;

    let cols_arr = args["columns"].as_array()
        .ok_or_else(|| crate::AppError::Other("missing columns array".into()))?;
    if cols_arr.is_empty() {
        return Err(crate::AppError::Other("columns array is empty".into()));
    }
    let cols: Vec<ColInput> = cols_arr.iter().map(ColInput::from_json).collect::<Result<_, _>>()?;

    let driver = get_driver(conn_id)?;
    let is_pg = crate::graph::is_pg_driver(&driver);

    let pk_cols: Vec<String> = cols.iter().filter(|c| c.is_primary_key).map(|c| q(&c.name, is_pg)).collect();
    let col_lines: Vec<String> = cols.iter().map(|c| {
        format!("  {}", if is_pg { c.def_pg() } else { c.def_mysql() })
    }).collect();
    let mut lines = col_lines;
    if !pk_cols.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    let mut stmts = vec![format!("CREATE TABLE {} (\n{}\n)", q(table_name, is_pg), lines.join(",\n"))];
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
    Ok(stmts.join(";\n"))
}

/// 生成 ALTER TABLE ADD COLUMN DDL
/// args: { connection_id, table_name, database?, column: {...}, after_column? }
pub fn generate_add_column_sql(args: &Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    validate_ident(table_name, "table name")?;

    let col = ColInput::from_json(&args["column"])?;
    let after_col = args["after_column"].as_str().unwrap_or("");

    let driver = get_driver(conn_id)?;
    let is_pg = crate::graph::is_pg_driver(&driver);

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
    Ok(stmts.join(";\n"))
}

/// 生成 ALTER TABLE DROP COLUMN DDL
/// args: { connection_id, table_name, database?, column_name }
pub fn generate_drop_column_sql(args: &Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    validate_ident(table_name, "table name")?;
    validate_ident(column_name, "column name")?;

    let driver = get_driver(conn_id)?;
    let is_pg = crate::graph::is_pg_driver(&driver);

    Ok(format!("ALTER TABLE {} DROP COLUMN {}", q(table_name, is_pg), q(column_name, is_pg)))
}

/// 生成 MODIFY/ALTER COLUMN DDL（需读取当前列信息）
/// args: { connection_id, table_name, database?, column_name, changes: {...} }
pub async fn generate_modify_column_sql(args: &Value) -> crate::AppResult<String> {
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

    let (config, ds) = get_ds(conn_id, database).await?;
    let is_pg = crate::graph::is_pg_driver(&config.driver);

    let columns = ds.get_columns(table_name, None).await?;
    let old_col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;

    let new_name = changes["name"].as_str().unwrap_or(column_name);
    if new_name != column_name { validate_ident(new_name, "new column name")?; }
    let new_type = changes["data_type"].as_str().map(|s| s.to_uppercase())
        .unwrap_or_else(|| old_col.data_type.to_uppercase().split('(').next().unwrap_or("VARCHAR").to_string());
    let new_length = changes["length"].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| old_col.data_type.split('(').nth(1).and_then(|s| s.strip_suffix(')')).unwrap_or("").to_string());
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
        name: new_name.to_string(), data_type: new_type.clone(), length: new_length.clone(),
        is_nullable: new_nullable, default_value: new_default.clone(),
        is_primary_key: false, extra: new_extra, comment: new_comment.clone(),
    };

    let mut stmts = Vec::new();
    if is_pg {
        let tbl = q(table_name, true);
        let col_q = q(column_name, true);
        let old_type_upper = old_col.data_type.to_uppercase();
        let full_new_type = if new_length.is_empty() { new_type.clone() } else { format!("{}({})", new_type, new_length) };
        if old_type_upper != full_new_type {
            stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} TYPE {}", tbl, col_q, full_new_type));
        }
        if old_col.is_nullable != new_nullable {
            stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} {}", tbl, col_q,
                if new_nullable { "DROP NOT NULL" } else { "SET NOT NULL" }));
        }
        let old_def = old_col.column_default.as_deref().unwrap_or("");
        if old_def != new_default {
            if new_default.is_empty() {
                stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT", tbl, col_q));
            } else {
                stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}", tbl, col_q, new_default));
            }
        }
        let old_comment = old_col.comment.as_deref().unwrap_or("");
        if old_comment != new_comment {
            let col_ref = if new_name != column_name { q(new_name, true) } else { col_q.clone() };
            if new_comment.is_empty() {
                stmts.push(format!("COMMENT ON COLUMN {}.{} IS NULL", tbl, col_ref));
            } else {
                stmts.push(format!("COMMENT ON COLUMN {}.{} IS '{}'", tbl, col_ref, esc(&new_comment)));
            }
        }
        if new_name != column_name {
            stmts.push(format!("ALTER TABLE {} RENAME COLUMN {} TO {}", tbl, col_q, q(new_name, true)));
        }
    } else {
        if new_name != column_name {
            stmts.push(format!("ALTER TABLE {} CHANGE COLUMN {} {}",
                q(table_name, false), q(column_name, false), merged.def_mysql()));
        } else {
            stmts.push(format!("ALTER TABLE {} MODIFY COLUMN {}",
                q(table_name, false), merged.def_mysql()));
        }
    }

    if stmts.is_empty() {
        return Ok("-- 无变更".into());
    }
    Ok(stmts.join(";\n"))
}

/// 生成 UPDATE COLUMN COMMENT DDL（需读取当前列信息）
/// args: { connection_id, table_name, database?, column_name, comment }
pub async fn generate_update_comment_sql(args: &Value) -> crate::AppResult<String> {
    let conn_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
    let table_name = args["table_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing table_name".into()))?;
    let column_name = args["column_name"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing column_name".into()))?;
    let comment = args["comment"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing comment".into()))?;
    validate_ident(table_name, "table name")?;
    validate_ident(column_name, "column name")?;
    let database = args["database"].as_str().unwrap_or("");

    let (config, ds) = get_ds(conn_id, database).await?;

    let columns = ds.get_columns(table_name, None).await?;
    let col = columns.iter().find(|c| c.name == column_name)
        .ok_or_else(|| crate::AppError::Other(format!("column {} not found", column_name)))?;

    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "ALTER TABLE `{}` MODIFY COLUMN `{}` {} COMMENT '{}'",
            table_name, column_name, col.data_type, comment.replace('\'', "''")
        ),
        "postgres" => format!(
            "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}'",
            table_name, column_name, comment.replace('\'', "''")
        ),
        _ => return Err(crate::AppError::Other("update_column_comment only supports mysql/postgres".into())),
    };
    Ok(sql)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri command wrappers
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub fn cmd_generate_create_table_sql(params: serde_json::Value) -> Result<String, String> {
    generate_create_table_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_generate_add_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_add_column_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_generate_drop_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_drop_column_sql(&params).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_generate_modify_column_sql(params: serde_json::Value) -> Result<String, String> {
    generate_modify_column_sql(&params).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_generate_update_comment_sql(params: serde_json::Value) -> Result<String, String> {
    generate_update_comment_sql(&params).await.map_err(|e| e.to_string())
}


