use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory};
use crate::llm::{ChatContext, ChatMessage, AgentMessage, ToolDefinition};
use crate::{AppError, AppResult};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

// ============ 连接管理 ============

#[tauri::command]
pub async fn list_connections() -> AppResult<Vec<Connection>> {
    crate::db::list_connections()
}

#[tauri::command]
pub async fn create_connection(req: CreateConnectionRequest) -> AppResult<Connection> {
    crate::db::create_connection(&req)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<bool> {
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.test_connection().await?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_connection(id: i64) -> AppResult<()> {
    crate::db::delete_connection(id)
}

#[tauri::command]
pub async fn update_connection(id: i64, req: crate::db::UpdateConnectionRequest) -> AppResult<crate::db::models::Connection> {
    crate::db::update_connection(id, &req)
}

/// 返回指定连接的明文密码（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_connection_password(id: i64) -> AppResult<String> {
    crate::db::get_connection_password(id)
}

// ============ 查询执行 ============

#[tauri::command]
pub async fn execute_query(
    connection_id: i64,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<QueryResult> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    ).await?;

    let result = ds.execute(&sql).await;

    // 无论成功失败，都记录历史
    match &result {
        Ok(qr) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                qr.duration_ms as i64,
                Some(qr.row_count as i64),
                None,
            );
        }
        Err(e) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                0,
                None,
                Some(&e.to_string()),
            );
        }
    }

    result
}

#[tauri::command]
pub async fn get_tables(connection_id: i64) -> AppResult<Vec<TableMeta>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_tables().await
}

#[tauri::command]
pub async fn get_schema(connection_id: i64) -> AppResult<SchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_schema().await
}

// ============ AI 代理 ============

fn parse_api_type(s: &str) -> crate::llm::ApiType {
    match s {
        "anthropic" => crate::llm::ApiType::Anthropic,
        _ => crate::llm::ApiType::Openai,
    }
}

fn build_llm_client() -> AppResult<crate::llm::client::LlmClient> {
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| crate::AppError::Other(
            "No AI model configured. Please add one in Settings → AI Model.".into()
        ))?;
    let api_type = parse_api_type(&config.api_type);
    Ok(crate::llm::client::LlmClient::new(
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    ))
}

#[tauri::command]
pub async fn ai_chat(message: String, context: ChatContext) -> AppResult<String> {
    let client = build_llm_client()?;
    let system_prompt = include_str!("../../prompts/chat_assistant.txt");
    let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt.to_string() }];
    messages.extend(context.history.clone());
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat(messages).await
}

#[tauri::command]
pub async fn ai_chat_stream(
    message: String,
    context: ChatContext,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_prompt = include_str!("../../prompts/chat_assistant.txt");
    let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt.to_string() }];
    messages.extend(context.history.clone());
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat_stream(messages, &channel).await
}

#[tauri::command]
pub async fn ai_generate_sql(prompt: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;

    let (schema_context, driver) = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let schema = ds.get_schema().await?;
            let ctx = schema.tables.iter()
                .map(|t| format!("Table: {}", t.name))
                .collect::<Vec<_>>()
                .join("\n");
            (ctx, config.driver)
        }
        _ => {
            // 无连接时，使用空 schema 上下文和默认 driver
            ("".to_string(), "mysql".to_string())
        }
    };

    client.generate_sql(&prompt, &schema_context, &driver).await
}

#[tauri::command]
pub async fn ai_explain_sql(sql: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;
    let driver = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            config.driver
        }
        _ => "mysql".to_string(), // 默认使用 mysql 方言
    };
    client.explain_sql(&sql, &driver).await
}

// ============ LLM 配置管理 ============

#[tauri::command]
pub async fn list_llm_configs() -> AppResult<Vec<crate::db::models::LlmConfig>> {
    let configs = crate::db::list_llm_configs()?;
    // api_key 仅在 Rust 内部使用，永不暴露到前端
    Ok(configs.into_iter().map(|mut c| { c.api_key = String::new(); c }).collect())
}

/// 返回指定 LLM 配置的明文 API Key（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_llm_config_key(id: i64) -> AppResult<String> {
    crate::db::get_llm_config_by_id(id)?
        .map(|c| c.api_key)
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))
}

#[tauri::command]
pub async fn create_llm_config(input: crate::db::models::CreateLlmConfigInput) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::create_llm_config(&input)?;
    config.api_key = String::new();
    Ok(config)
}

#[tauri::command]
pub async fn update_llm_config(
    id: i64,
    input: crate::db::models::UpdateLlmConfigInput,
) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::update_llm_config(id, &input)?;
    config.api_key = String::new();
    Ok(config)
}

#[tauri::command]
pub async fn delete_llm_config(
    id: i64,
) -> AppResult<()> {
    crate::db::delete_llm_config(id)?;
    Ok(())
}

#[tauri::command]
pub async fn set_default_llm_config(
    id: i64,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::db::set_default_llm_config(id)?;
    Ok(())
}


#[tauri::command]
pub async fn get_default_llm_config() -> AppResult<Option<crate::db::models::LlmConfig>> {
    let config = crate::db::get_default_llm_config()?;
    Ok(config.map(|mut c| { c.api_key = String::new(); c }))
}

#[tauri::command]
pub async fn set_llm_config_test_status(id: i64, status: String, error: Option<String>) -> AppResult<()> {
    crate::db::update_llm_config_test_status(id, &status, error.as_deref())
}

#[tauri::command]
pub async fn test_llm_config(id: i64) -> AppResult<()> {
    crate::db::update_llm_config_test_status(id, "testing", None)?;
    let config = crate::db::get_llm_config_by_id(id)?
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;
    let api_type = parse_api_type(&config.api_type);
    let client = crate::llm::client::LlmClient::new(
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    match client.chat(messages).await {
        Ok(_) => {
            crate::db::update_llm_config_test_status(id, "success", None)?;
        }
        Err(e) => {
            let err_msg = e.to_string();
            crate::db::update_llm_config_test_status(id, "fail", Some(&err_msg))?;
            return Err(e);
        }
    }
    Ok(())
}

// ============ 历史 & 收藏 ============

#[tauri::command]
pub async fn get_query_history(connection_id: i64) -> AppResult<Vec<QueryHistory>> {
    crate::db::list_query_history(connection_id)
}

// ============ DB 管理 ============

#[tauri::command]
pub async fn get_table_detail(connection_id: i64, database: Option<String>, schema: Option<String>, table: String) -> AppResult<crate::datasource::TableDetail> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    let columns = ds.get_columns(&table, schema_ref).await?;
    let indexes = ds.get_indexes(&table, schema_ref).await?;
    let foreign_keys = ds.get_foreign_keys(&table, schema_ref).await?;
    Ok(crate::datasource::TableDetail { name: table, columns, indexes, foreign_keys })
}

#[tauri::command]
pub async fn get_full_schema(connection_id: i64) -> AppResult<crate::datasource::FullSchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_full_schema().await
}

#[tauri::command]
pub async fn get_table_ddl(connection_id: i64, table: String, database: Option<String>, schema: Option<String>) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    ds.get_table_ddl_with_schema(&table, schema_ref).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,
    pub order_clause: Option<String>,
}

/// 构建带 schema 前缀的表名（PG/Oracle 用）
fn qualified_table_pg(schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("\"{}\".\"{}\"", s.replace('"', "\"\""), table.replace('"', "\"\"")),
        None => format!("\"{}\"", table.replace('"', "\"\"")),
    }
}

fn qualified_table_mysql(table: &str) -> String {
    format!("`{}`", table.replace('`', "``"))
}

fn qualified_table(driver: &str, schema: Option<&str>, table: &str) -> String {
    if driver == "mysql" {
        qualified_table_mysql(table)
    } else {
        qualified_table_pg(schema, table)
    }
}

#[tauri::command]
pub async fn get_table_data(params: TableDataParams) -> AppResult<crate::datasource::QueryResult> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    // 限制最大页面大小，防止大量数据查询耗尽内存
    if params.page_size > 10_000 {
        return Err(crate::AppError::Other(
            format!("page_size exceeds maximum allowed value (10000), got {}", params.page_size)
        ));
    }

    let offset = params.page.saturating_sub(1) * params.page_size;
    // 安全说明：where_clause 和 order_clause 是前端传入的自由文本，直接嵌入 SQL。
    // 这是设计决策：本应用为本地桌面工具，Tauri IPC 仅限本机访问，信任边界为本地用户。
    // 在实现网络化部署时必须改用参数绑定或 AST 白名单。
    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();
    let order_part = params.order_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" ORDER BY {}", s))
        .unwrap_or_default();

    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let sql = format!("SELECT * FROM {}{}{} LIMIT {} OFFSET {}", tbl, where_part, order_part, params.page_size, offset);

    ds.execute(&sql).await
}

#[tauri::command]
pub async fn update_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    pk_column: String,
    pk_value: String,
    column: String,
    new_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "UPDATE {} SET `{}` = '{}' WHERE `{}` = '{}'",
            tbl,
            column.replace('`', "``"),
            new_value.replace('\'', "\\'"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "UPDATE {} SET \"{}\" = '{}' WHERE \"{}\" = '{}'",
            tbl,
            column.replace('"', "\"\""),
            new_value.replace('\'', "''"),
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("No rows updated: pk_column='{}', pk_value='{}' not found in table '{}'", pk_column, pk_value, table)
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    pk_column: String,
    pk_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "DELETE FROM {} WHERE `{}` = '{}'",
            tbl,
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "DELETE FROM {} WHERE \"{}\" = '{}'",
            tbl,
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("No rows deleted: pk_column='{}', pk_value='{}' not found in table '{}'", pk_column, pk_value, table)
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn insert_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    columns: Vec<String>,
    values: Vec<Option<String>>,
) -> AppResult<()> {
    if columns.is_empty() {
        return Err(crate::AppError::Other("columns must not be empty".to_string()));
    }
    if columns.len() != values.len() {
        return Err(crate::AppError::Other(
            format!("columns({}) and values({}) length mismatch", columns.len(), values.len())
        ));
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let (col_list, val_list): (Vec<String>, Vec<String>) = columns
        .iter()
        .zip(values.iter())
        .map(|(col, val)| {
            let quoted_col = match config.driver.as_str() {
                "mysql" => format!("`{}`", col.replace('`', "``")),
                _ => format!("\"{}\"", col.replace('"', "\"\"")),
            };
            let quoted_val = match val {
                None => "NULL".to_string(),
                Some(v) => match config.driver.as_str() {
                    "mysql" => format!("'{}'", v.replace('\'', "\\'")),
                    _ => format!("'{}'", v.replace('\'', "''")),
                },
            };
            (quoted_col, quoted_val)
        })
        .unzip();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        tbl,
        col_list.join(", "),
        val_list.join(", ")
    );
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("Insert into table '{}' affected 0 rows", table)
        ));
    }
    Ok(())
}

// ============ 数据导出 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub format: String, // "csv" | "json" | "sql"
    pub where_clause: Option<String>,
    pub output_path: String,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default)]
    pub include_ddl: bool,
}

fn default_true() -> bool { true }

#[tauri::command]
pub async fn export_table_data(params: ExportParams) -> AppResult<String> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();

    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let sql = format!("SELECT * FROM {}{}", tbl, where_part);

    let result = ds.execute(&sql).await?;

    let quote_csv_field = |s: &str| -> String {
        if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };

    let content = match params.format.as_str() {
        "json" => serde_json::to_string_pretty(&result.rows)
            .map_err(|e| crate::AppError::Other(e.to_string()))?,
        "csv" => {
            let mut out = String::new();
            if params.include_header {
                out += &(result.columns.iter().map(|c| quote_csv_field(c)).collect::<Vec<_>>().join(",") + "\n");
            }
            for row in &result.rows {
                let line: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => String::new(),
                    serde_json::Value::String(s) => quote_csv_field(s),
                    other => other.to_string(),
                }).collect();
                out += &(line.join(",") + "\n");
            }
            out
        }
        "sql" => {
            let quoted_table = match config.driver.as_str() {
                "mysql" => format!("`{}`", params.table.replace('`', "``")),
                _ => format!("\"{}\"", params.table.replace('"', "\"\"")),
            };
            let col_list = result.columns.iter().map(|c| {
                match config.driver.as_str() {
                    "mysql" => format!("`{}`", c.replace('`', "``")),
                    _ => format!("\"{}\"", c.replace('"', "\"\"")),
                }
            }).collect::<Vec<_>>().join(", ");

            let mut out = String::new();

            // 包含 DDL：先写建表语句
            if params.include_ddl {
                match ds.get_table_ddl(&params.table).await {
                    Ok(ddl) => {
                        out += &format!("-- Table structure for `{}`\n", params.table);
                        out += "DROP TABLE IF EXISTS ";
                        out += &quoted_table;
                        out += ";\n";
                        out += &ddl;
                        out += ";\n\n";
                    }
                    Err(e) => {
                        out += &format!("-- Could not retrieve DDL: {}\n\n", e);
                    }
                }
            }

            out += &format!("-- Data for `{}`\n", params.table);
            for row in &result.rows {
                let values: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => "NULL".into(),
                    serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => if *b { "1".into() } else { "0".into() },
                    other => format!("'{}'", other.to_string().replace('\'', "''")),
                }).collect();
                out += &format!("INSERT INTO {} ({}) VALUES ({});\n", quoted_table, col_list, values.join(", "));
            }
            out
        }
        _ => return Err(crate::AppError::Other(format!("Unsupported format: {}", params.format))),
    };

    tokio::fs::write(&params.output_path, &content).await
        .map_err(|e| crate::AppError::Other(format!("Failed to write file: {}", e)))?;

    Ok(params.output_path)
}

// ============ 连接分组管理 ============

#[tauri::command]
pub async fn list_groups() -> AppResult<Vec<crate::db::models::ConnectionGroup>> {
    crate::db::list_groups()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn create_group(req: CreateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::create_group(&req.name, req.color.as_deref())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct UpdateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn update_group(id: i64, req: UpdateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::update_group(id, &req.name, req.color.as_deref())
}

#[tauri::command]
pub async fn delete_group(id: i64) -> AppResult<()> {
    crate::db::delete_group(id)
}

#[tauri::command]
pub async fn move_connection_to_group(connection_id: i64, group_id: Option<i64>) -> AppResult<()> {
    crate::db::move_connection_to_group(connection_id, group_id)
}

#[tauri::command]
pub async fn reorder_connections(items: Vec<crate::db::models::ReorderItem>) -> AppResult<()> {
    crate::db::reorder_connections(&items)
}

#[tauri::command]
pub async fn reorder_groups(items: Vec<crate::db::models::ReorderItem>) -> AppResult<()> {
    crate::db::reorder_groups(&items)
}

// ============ AI 高级命令 ============

/// SQL 优化（旧 ACP 版本）：已迁移到 agent_optimize_sql，此桩函数保留兼容性。
#[tauri::command]
pub async fn ai_optimize_sql(
    _sql: String,
    _connection_id: Option<i64>,
    _database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let _ = channel.send(crate::llm::StreamEvent::Error {
        message: "ACP mode is deprecated. Please use serve mode (agent_optimize_sql).".into(),
    });
    let _ = channel.send(crate::llm::StreamEvent::Done);
    Ok(())
}

/// 取消 SQL 优化 ACP session（旧版，已废弃）
#[tauri::command]
pub async fn cancel_optimize_acp_session(
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    Ok(())
}

/// SQL 解释（旧 ACP 版本）：已迁移到 agent_explain_sql，此桩函数保留兼容性。
#[tauri::command]
pub async fn ai_explain_sql_acp(
    _sql: String,
    _connection_id: Option<i64>,
    _database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let _ = channel.send(crate::llm::StreamEvent::Error {
        message: "ACP mode is deprecated. Please use serve mode (agent_explain_sql).".into(),
    });
    let _ = channel.send(crate::llm::StreamEvent::Done);
    Ok(())
}

/// 取消 SQL 解释 ACP session（旧版，已废弃）
#[tauri::command]
pub async fn cancel_explain_acp_session(
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub async fn ai_create_table(description: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;
    let driver = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            config.driver
        }
        _ => "mysql".to_string(),
    };
    client.create_table_ddl(&description, &driver).await
}

#[tauri::command]
pub async fn ai_generate_table_schema(
    description: String,
    connection_id: i64,
) -> AppResult<crate::llm::client::TableSchemaResult> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let driver = &config.driver;

    let result = client.generate_table_schema(&description, driver).await?;

    // 校验返回的 column_type 是否在合法枚举内（仅记录警告，不阻断）
    let valid_types: &[&str] = match driver.as_str() {
        "postgres" | "postgresql" => &[
            "INTEGER", "BIGINT", "SMALLINT", "VARCHAR", "TEXT", "TIMESTAMP",
            "DATE", "NUMERIC", "BOOLEAN", "BYTEA", "UUID", "JSONB", "SERIAL",
        ],
        _ => &[
            "INT", "BIGINT", "TINYINT", "SMALLINT", "VARCHAR", "TEXT", "LONGTEXT",
            "DATETIME", "DATE", "TIMESTAMP", "DECIMAL", "FLOAT", "DOUBLE", "BOOLEAN", "BLOB",
        ],
    };
    for col in &result.columns {
        if !valid_types.iter().any(|t| t.eq_ignore_ascii_case(&col.column_type)) {
            log::warn!(
                "[ai_generate_table_schema] column '{}' has non-standard type '{}', keeping as-is",
                col.name,
                col.column_type
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn ai_diagnose_error(sql: String, error_msg: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;

    let (schema_context, driver) = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let schema = ds.get_schema().await?;
            let ctx = schema.tables.iter()
                .map(|t| format!("Table: {}", t.name))
                .collect::<Vec<_>>().join("\n");
            (ctx, config.driver)
        }
        _ => ("".to_string(), "mysql".to_string()),
    };

    client.diagnose_error(&sql, &error_msg, &schema_context, &driver).await
}

// ============ 导航树查询命令 ============

#[tauri::command]
pub async fn list_databases(connection_id: i64) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.list_databases().await
}

#[tauri::command]
pub async fn list_schemas(connection_id: i64, database: String) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_schemas(&database).await
}

const SYSTEM_SCHEMAS: &[&str] = &[
    "information_schema", "pg_catalog",
    "performance_schema", "sys", "mysql",
];

#[tauri::command]
pub async fn list_databases_for_metrics(connection_id: i64) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let dbs = ds.list_databases().await?;
    Ok(dbs.into_iter().filter(|d| !SYSTEM_SCHEMAS.contains(&d.as_str())).collect())
}

#[tauri::command]
pub async fn list_schemas_for_metrics(
    connection_id: i64,
    database: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    let schemas = ds.list_schemas(&database).await?;
    Ok(schemas.into_iter().filter(|s| !SYSTEM_SCHEMAS.contains(&s.as_str())).collect())
}

#[tauri::command]
pub async fn get_metric(id: i64) -> AppResult<crate::metrics::Metric> {
    crate::metrics::crud::get_metric_pub(id)
}

#[tauri::command]
pub async fn list_metrics_by_node(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::crud::list_metrics_by_node(
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        status.as_deref(),
    )
}

#[tauri::command]
pub async fn count_metrics_batch(
    connection_id: i64,
    database: Option<String>,
) -> AppResult<std::collections::HashMap<String, i64>> {
    crate::metrics::crud::count_metrics_batch(connection_id, database.as_deref())
}

#[tauri::command]
pub async fn list_objects(
    connection_id: i64,
    database: String,
    schema: Option<String>,
    category: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_objects(&database, schema.as_deref(), &category).await
}

#[tauri::command]
pub async fn list_tables_with_stats(
    connection_id: i64,
    database: String,
    schema: Option<String>,
) -> AppResult<Vec<crate::datasource::TableStatInfo>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_tables_with_stats(&database, schema.as_deref()).await
}

#[tauri::command]
pub async fn ai_chat_stream_with_tools(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_msg = AgentMessage {
        role: "system".into(),
        content: Some(include_str!("../../prompts/chat_assistant.txt").to_string()),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    };
    let mut all_messages = vec![system_msg];
    all_messages.extend(messages);
    client.chat_stream_with_tools(all_messages, tools, &channel).await
}

#[tauri::command]
pub async fn ai_chat_continue(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    // ai_chat_continue: messages already include system prompt from the loop
    client.chat_stream_with_tools(messages, tools, &channel).await
}

// ============ Agent 工具命令 ============

/// Agent 工具：获取表样本数据（最多 20 行）
#[tauri::command]
pub async fn agent_get_table_sample(
    connection_id: i64,
    table: String,
    schema: Option<String>,
    limit: Option<usize>,
) -> AppResult<QueryResult> {
    let safe_limit = limit.unwrap_or(5).min(20);
    let sql = match schema {
        Some(ref s) if !s.is_empty() => format!("SELECT * FROM \"{}\".\"{}\" LIMIT {}", s, table, safe_limit),
        _ => format!("SELECT * FROM \"{}\" LIMIT {}", table, safe_limit),
    };
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.execute(&sql).await
}

/// Agent 工具：执行只读 SQL（仅 SELECT/WITH/SHOW，最多 100 行）
#[tauri::command]
pub async fn agent_execute_sql(
    connection_id: i64,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<QueryResult> {
    let trimmed = sql.trim().to_uppercase();
    if !trimmed.starts_with("SELECT") && !trimmed.starts_with("WITH") && !trimmed.starts_with("SHOW") {
        return Err(crate::AppError::Other("agent_execute_sql only allows SELECT/WITH/SHOW queries".into()));
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    ).await?;
    let mut result = ds.execute(&sql).await?;
    if result.rows.len() > 100 {
        result.rows.truncate(100);
        result.row_count = 100;
    }
    Ok(result)
}

// ============ ACP Agent 模式（旧版，已废弃，桩函数保留兼容性）============

/// AI 聊天 ACP 版本（旧版，已迁移到 agent_chat）
#[tauri::command]
pub async fn ai_chat_acp(
    _prompt: String,
    _tab_sql: Option<String>,
    _connection_id: Option<i64>,
    _config_id: Option<i64>,
    _session_id: String,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let _ = channel.send(crate::llm::StreamEvent::Error {
        message: "ACP mode is deprecated. Please use serve mode (agent_chat).".into(),
    });
    Ok(())
}

/// 取消 ACP session（旧版，已废弃）
#[tauri::command]
pub async fn cancel_acp_session(
    _session_id: String,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    Ok(())
}

// ============ 任务管理命令 ============

#[tauri::command]
pub async fn get_task_list(limit: Option<i32>) -> AppResult<Vec<crate::db::models::TaskRecord>> {
    let limit = limit.unwrap_or(100).min(100);
    crate::db::list_tasks(limit)
}

#[tauri::command]
pub async fn create_task(task: crate::db::models::CreateTaskInput) -> AppResult<crate::db::models::TaskRecord> {
    crate::db::create_task(&task)
}

#[tauri::command]
pub async fn update_task(id: String, updates: crate::db::models::UpdateTaskInput) -> AppResult<()> {
    crate::db::update_task(&id, &updates)
}

#[tauri::command]
pub async fn delete_task(id: String) -> AppResult<()> {
    crate::db::delete_task(&id)
}

#[tauri::command]
pub async fn get_task_by_id(id: String) -> AppResult<Option<crate::db::models::TaskRecord>> {
    crate::db::get_task_by_id(&id)
}

// ============ 任务取消与重试 ============

#[tauri::command]
pub async fn cancel_task(task_id: String) -> AppResult<()> {
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("cancelled".to_string()),
        completed_at: Some(chrono::Utc::now().to_rfc3339()),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn retry_task(task_id: String) -> AppResult<()> {
    // MVP: 仅重置状态，实际重新执行留待后续版本
    // error: Some("".to_string()) 将 error 字段更新为空字符串 ——
    // update_task 的 SQL 逻辑对 Some(v) 一律 SET error = v，
    // 前端 `task.error && ...` 判断中，空字符串为 falsy，等同于无错误，行为正确。
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("pending".to_string()),
        progress: Some(0),
        error: Some("".to_string()),  // 清空错误文字
        completed_at: None,
        ..Default::default()
    })
}

// ============ 数据库管理 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateDatabaseOptions {
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub default_schema: Option<String>,
    pub tablespace: Option<String>,
}

#[tauri::command]
pub async fn create_database(
    connection_id: i64,
    name: String,
    options: CreateDatabaseOptions,
) -> AppResult<()> {
    // 验证名称安全（只允许 ASCII 字母、数字、下划线）
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => {
            let charset = options.charset.as_deref().unwrap_or("utf8mb4");
            let collation = options.collation.as_deref().unwrap_or("utf8mb4_general_ci");
            // 白名单验证：charset 和 collation 只允许 ASCII 字母数字和下划线
            let valid_charset = charset.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let valid_collation = collation.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !valid_charset || !valid_collation {
                return Err(crate::AppError::Other(
                    "Invalid charset or collation: only alphanumeric and underscore allowed".to_string()
                ));
            }
            format!(
                "CREATE DATABASE `{}` CHARACTER SET {} COLLATE {}",
                name, charset, collation
            )
        }
        "postgres" => format!("CREATE DATABASE \"{}\"", name),
        _ => format!("CREATE DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn drop_database(
    connection_id: i64,
    name: String,
) -> AppResult<()> {
    // 验证名称安全（只允许 ASCII 字母、数字、下划线）
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => format!("DROP DATABASE `{}`", name),
        _ => format!("DROP DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}

// ============ 多表导出（流式进度） ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiExportOptions {
    pub include_header: bool,
    pub include_ddl: bool,
    pub where_clause: Option<String>,
    pub encoding: String,
    pub delimiter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub tables: Vec<String>,
    pub format: String,
    pub output_dir: String,
    pub options: MultiExportOptions,
    #[serde(default)]
    pub file_name: String,    // 输出文件名（不含后缀），Rust 侧拼接后缀
    #[serde(default)]
    pub export_all: bool,     // true 时忽略 tables，自动查全量表
}

#[derive(Clone, Serialize)]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub status: String,
    pub progress: u8,
    pub processed_rows: u64,
    pub total_rows: Option<u64>,
    pub current_target: String,
    pub error: Option<String>,
    pub output_path: Option<String>,
}

#[tauri::command]
pub async fn export_tables(
    params: MultiExportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    use tauri::Emitter;

    // Early return if no tables specified
    if !params.export_all && params.tables.is_empty() {
        return Err(crate::AppError::Other("No tables specified for export".to_string()));
    }

    // 解析最终要导出的表名列表
    let tables_to_export: Vec<String> = if params.export_all {
        // 查询数据库全量表名
        let config = crate::db::get_connection_config(params.connection_id)?;
        let db_name = params.database.as_deref().unwrap_or("");
        let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
            Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
            None => crate::datasource::create_datasource(&config).await?,
        };
        ds.list_objects(db_name, params.schema.as_deref(), "tables").await
            .map_err(|e| crate::AppError::Other(format!("Failed to list tables: {}", e)))?
    } else {
        params.tables.clone()
    };

    // 1. 创建任务记录
    let title = if tables_to_export.len() == 1 {
        format!("导出 {} 表", tables_to_export[0])
    } else {
        format!("导出 {} 个表", tables_to_export.len())
    };

    // 生成 Markdown 描述（供 LLM/MCP 读取）
    let description = {
        let conn_info = crate::db::get_connection_by_id(params.connection_id)
            .ok()
            .flatten();
        let conn_line = if let Some(ref c) = conn_info {
            let host_part = match (&c.host, &c.port) {
                (Some(h), Some(p)) => format!(" · {}:{}", h, p),
                (Some(h), None) => format!(" · {}", h),
                _ => String::new(),
            };
            format!("**连接**: {} (ID: {} · {}{})", c.name, c.id, c.driver.to_uppercase(), host_part)
        } else {
            format!("**连接 ID**: {}", params.connection_id)
        };

        let db_line = params.database.as_deref()
            .map(|db| {
                let schema_part = params.schema.as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(".{}", s))
                    .unwrap_or_default();
                format!("\n**数据库**: `{}{}`", db, schema_part)
            })
            .unwrap_or_default();

        let format_detail = {
            let mut parts = vec![params.format.to_uppercase()];
            if params.format == "csv" {
                parts.push(params.options.encoding.clone());
                parts.push(format!("分隔符 `{}`", params.options.delimiter));
                if params.options.include_header { parts.push("含表头".into()); }
            }
            if params.format == "sql" && params.options.include_ddl {
                parts.push("含 DDL".into());
            }
            parts.join(" · ")
        };

        let where_line = params.options.where_clause.as_deref()
            .filter(|s| !s.is_empty())
            .map(|w| format!("\n**筛选条件**: `{}`", w))
            .unwrap_or_default();

        let table_list = tables_to_export.iter()
            .map(|t| format!("- `{}`", t))
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            "## 导出任务\n\n{}{}\n**格式**: {}{}\n**输出目录**: `{}`\n\n### 导出表（{} 个）\n{}",
            conn_line, db_line,
            format_detail, where_line,
            params.output_dir,
            tables_to_export.len(), table_list
        )
    };

    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "export".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(tables_to_export.first().cloned().unwrap_or_default()),
        error: None,
        error_details: None,
        output_path: Some(params.output_dir.clone()),
        description: Some(description),
    })?;

    let task_id = task.id.clone();

    let is_zip = tables_to_export.len() > 1 || params.export_all;
    let file_name = if params.file_name.is_empty() {
        tables_to_export.first().cloned().unwrap_or_else(|| "export".to_string())
    } else {
        params.file_name.clone()
    };

    let total = tables_to_export.len() as u64;

    // 克隆供 async move 使用
    let tables_for_task = tables_to_export.clone();
    let params_clone = params.clone();

    // 2. 后台执行（不阻塞前端）
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        use std::path::Path;
        use std::fs::File;
        use std::io::Write;

        if is_zip {
            // ---- ZIP 分支 ----
            let zip_path = Path::new(&params_clone.output_dir)
                .join(format!("{}.zip", file_name));

            let zip_file = match File::create(&zip_path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                        status: Some("failed".to_string()),
                        error: Some(e.to_string()),
                        completed_at: Some(chrono::Utc::now().to_rfc3339()),
                        ..Default::default()
                    });
                    return;
                }
            };
            let mut zip = zip::ZipWriter::new(zip_file);
            let zip_options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            let mut processed = 0u64;
            for (i, table_name) in tables_for_task.iter().enumerate() {
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone.clone(),
                    status: "running".to_string(),
                    progress: ((i as f64 / total as f64) * 100.0) as u8,
                    processed_rows: processed,
                    total_rows: Some(total),
                    current_target: table_name.clone(),
                    error: None,
                    output_path: Some(zip_path.to_string_lossy().to_string()),
                });

                // 导出单表到临时文件
                let tmp_path = Path::new(&params_clone.output_dir)
                    .join(format!("_tmp_{}.{}", table_name, &params_clone.format));
                let single_params = ExportParams {
                    connection_id: params_clone.connection_id,
                    database: params_clone.database.clone(),
                    table: table_name.clone(),
                    schema: params_clone.schema.clone(),
                    format: params_clone.format.clone(),
                    where_clause: None,
                    output_path: tmp_path.to_string_lossy().to_string(),
                    include_header: params_clone.options.include_header,
                    include_ddl: params_clone.options.include_ddl,
                };

                if let Err(e) = export_table_data(single_params).await {
                    let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                        status: Some("failed".to_string()),
                        error: Some(e.to_string()),
                        completed_at: Some(chrono::Utc::now().to_rfc3339()),
                        ..Default::default()
                    });
                    let _ = app_handle.emit("task-progress", TaskProgressPayload {
                        task_id: task_id_clone.clone(),
                        status: "failed".to_string(),
                        progress: 0,
                        processed_rows: processed,
                        total_rows: Some(total),
                        current_target: table_name.clone(),
                        error: Some(e.to_string()),
                        output_path: None,
                    });
                    // 清理临时文件
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }

                // 将临时文件内容写入 ZIP
                let entry_name = format!("{}.{}", table_name, &params_clone.format);
                if zip.start_file(&entry_name, zip_options).is_ok() {
                    if let Ok(content) = std::fs::read(&tmp_path) {
                        let _ = zip.write_all(&content);
                    }
                }
                let _ = std::fs::remove_file(&tmp_path);
                processed += 1;
            }

            let _ = zip.finish();

            let out_path_str = zip_path.to_string_lossy().to_string();
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                processed_rows: Some(processed as i64),
                total_rows: Some(total as i64),
                output_path: Some(out_path_str.clone()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone,
                status: "completed".to_string(),
                progress: 100,
                processed_rows: processed,
                total_rows: Some(total),
                current_target: String::new(),
                error: None,
                output_path: Some(out_path_str),
            });

        } else {
            // ---- 单文件分支（保持原逻辑，但使用 file_name） ----
            let table_name = tables_for_task.first().cloned().unwrap_or_default();
            let output_file = Path::new(&params_clone.output_dir)
                .join(format!("{}.{}", file_name, &params_clone.format));

            let single_params = ExportParams {
                connection_id: params_clone.connection_id,
                database: params_clone.database.clone(),
                table: table_name.clone(),
                schema: params_clone.schema.clone(),
                format: params_clone.format.clone(),
                where_clause: params_clone.options.where_clause.clone(),
                output_path: output_file.to_string_lossy().to_string(),
                include_header: params_clone.options.include_header,
                include_ddl: params_clone.options.include_ddl,
            };

            if let Err(e) = export_table_data(single_params).await {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: 0,
                    total_rows: Some(1),
                    current_target: table_name,
                    error: Some(e.to_string()),
                    output_path: None,
                });
                return;
            }

            let out_path_str = output_file.to_string_lossy().to_string();
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                processed_rows: Some(1),
                total_rows: Some(1),
                output_path: Some(out_path_str.clone()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone,
                status: "completed".to_string(),
                progress: 100,
                processed_rows: 1,
                total_rows: Some(1),
                current_target: String::new(),
                error: None,
                output_path: Some(out_path_str),
            });
        }
    });

    Ok(task_id)
}

// ============ 数据导入 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub file_path: String,
    pub file_type: String,   // csv/json/excel/sql
    pub field_mapping: std::collections::HashMap<String, String>,
    pub error_strategy: String,  // "StopOnError" | "SkipAndContinue"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnInfoForImport {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub is_pk: bool,
    pub nullable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableColumnsResponse {
    pub columns: Vec<ColumnInfoForImport>,
}

/// 获取表列信息用于导入字段映射
#[tauri::command]
pub async fn get_table_columns_for_import(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> AppResult<TableColumnsResponse> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    let cols = ds.get_columns(&table, schema_ref).await?;
    let columns = cols.into_iter().map(|c| ColumnInfoForImport {
        type_: c.data_type.clone(),
        is_pk: c.is_primary_key,
        nullable: c.is_nullable,
        name: c.name,
    }).collect();
    Ok(TableColumnsResponse { columns })
}

/// 预览导入文件（返回前5行的文本预览 + 列名）
#[tauri::command]
pub async fn preview_import_file(
    file_path: String,
    file_type: String,
) -> AppResult<serde_json::Value> {
    let content = tokio::fs::read_to_string(&file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    match file_type.as_str() {
        "csv" => {
            let lines: Vec<&str> = content.lines().take(6).collect();
            let columns = lines.first()
                .map(|h| h.split(',').map(|s| s.trim().trim_matches('"').to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            let preview_rows: Vec<String> = lines.iter().take(6).map(|s| s.to_string()).collect();
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            let (columns, preview_rows) = if let Some(arr) = parsed.as_array() {
                let cols = arr.first()
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let rows = arr.iter().take(5)
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>();
                (cols, rows)
            } else {
                (vec![], vec![parsed.to_string()])
            };
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        _ => Ok(serde_json::json!({
            "columns": [],
            "preview_rows": [format!("预览不支持 {} 格式，请直接导入", file_type)]
        })),
    }
}

/// 导入文件到表（异步后台执行，通过 task-progress 事件推进度）
#[tauri::command]
pub async fn import_to_table(
    params: ImportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    use tauri::Emitter;
    let title = format!("导入到 {} 表", params.table);

    // 生成 Markdown 描述（供 LLM/MCP 读取）
    let description = {
        let conn_info = crate::db::get_connection_by_id(params.connection_id)
            .ok()
            .flatten();
        let conn_line = if let Some(ref c) = conn_info {
            let host_part = match (&c.host, &c.port) {
                (Some(h), Some(p)) => format!(" · {}:{}", h, p),
                (Some(h), None) => format!(" · {}", h),
                _ => String::new(),
            };
            format!("**连接**: {} (ID: {} · {}{})", c.name, c.id, c.driver.to_uppercase(), host_part)
        } else {
            format!("**连接 ID**: {}", params.connection_id)
        };

        let db_line = params.database.as_deref()
            .map(|db| {
                let schema_part = params.schema.as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(".{}", s))
                    .unwrap_or_default();
                format!("\n**数据库**: `{}{}`", db, schema_part)
            })
            .unwrap_or_default();

        let mapping_lines = params.field_mapping.iter()
            .map(|(src, dst)| format!("- `{}` → `{}`", src, dst))
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            "## 导入任务\n\n{}{}\n**目标表**: `{}`\n**文件**: `{}`\n**格式**: {}\n**错误策略**: {}\n\n### 字段映射\n{}",
            conn_line, db_line,
            params.table,
            params.file_path,
            params.file_type.to_uppercase(),
            if params.error_strategy == "StopOnError" { "遇错停止" } else { "跳过错误行继续" },
            if mapping_lines.is_empty() { "（自动匹配）".to_string() } else { mapping_lines }
        )
    };

    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "import".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(params.table.clone()),
        error: None,
        error_details: None,
        output_path: Some(params.file_path.clone()),
        description: Some(description),
    })?;
    let task_id = task.id.clone();
    let task_id_clone = task_id.clone();

    tokio::spawn(async move {
        let result = run_import(&params, &task_id_clone, &app_handle).await;
        match result {
            Ok(count) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("completed".to_string()),
                    progress: Some(100),
                    processed_rows: Some(count as i64),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "completed".to_string(),
                    progress: 100,
                    processed_rows: count,
                    total_rows: None,
                    current_target: String::new(),
                    error: None,
                    output_path: None,
                });
            }
            Err(e) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: 0,
                    total_rows: None,
                    current_target: String::new(),
                    error: Some(e.to_string()),
                    output_path: None,
                });
            }
        }
    });

    Ok(task_id)
}

async fn run_import(
    params: &ImportParams,
    task_id: &str,
    app_handle: &tauri::AppHandle,
) -> AppResult<u64> {
    use tauri::Emitter;
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    let content = tokio::fs::read_to_string(&params.file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    let rows: Vec<std::collections::HashMap<String, serde_json::Value>> = match params.file_type.as_str() {
        "csv" => {
            // MVP 限制：简单 split(',') 解析，不支持字段内包含逗号（RFC 4180）
            // 如有需要，后续可引入 csv crate 进行完整解析
            let mut lines = content.lines();
            let headers: Vec<String> = lines.next()
                .ok_or_else(|| crate::AppError::Other("Empty CSV file".into()))?
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .collect();
            lines.map(|line| {
                let vals: Vec<&str> = line.split(',').collect();
                headers.iter().enumerate().map(|(i, h)| {
                    let v = vals.get(i).copied().unwrap_or("").trim().trim_matches('"');
                    (h.clone(), serde_json::Value::String(v.to_string()))
                }).collect()
            }).collect()
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            parsed.as_array()
                .ok_or_else(|| crate::AppError::Other("JSON must be an array".into()))?
                .iter()
                .filter_map(|v| v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
                .collect()
        }
        _ => return Err(crate::AppError::Other(format!("Import format '{}' not yet supported", params.file_type))),
    };

    let total = rows.len() as u64;
    let batch_size = 100;
    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let mut success_count = 0u64;
    let stop_on_error = params.error_strategy == "StopOnError";

    for (batch_idx, chunk) in rows.chunks(batch_size).enumerate() {
        let progress = if total > 0 { ((batch_idx * batch_size) as f64 / total as f64 * 100.0) as u8 } else { 0 };
        let _ = app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "running".to_string(),
            progress,
            processed_rows: success_count,
            total_rows: Some(total),
            current_target: params.table.clone(),
            error: None,
            output_path: None,
        });

        for row in chunk {
            let mapped: Vec<(String, Option<String>)> = params.field_mapping.iter()
                .filter_map(|(src, dst)| {
                    row.get(src).map(|v| {
                        let val = match v {
                            serde_json::Value::Null => None,
                            serde_json::Value::String(s) => Some(s.clone()),
                            other => Some(other.to_string()),
                        };
                        (dst.clone(), val)
                    })
                })
                .collect();

            if mapped.is_empty() { continue; }

            let (col_list, val_list): (Vec<String>, Vec<String>) = mapped.iter()
                .map(|(col, val)| {
                    let qcol = match config.driver.as_str() {
                        "mysql" => format!("`{}`", col.replace('`', "``")),
                        _ => format!("\"{}\"", col.replace('"', "\"\"")),
                    };
                    let qval = match val {
                        None => "NULL".to_string(),
                        Some(v) => match config.driver.as_str() {
                            "mysql" => format!("'{}'", v.replace('\'', "''")),
                            _ => format!("'{}'", v.replace('\'', "''")),
                        },
                    };
                    (qcol, qval)
                })
                .unzip();

            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                tbl, col_list.join(", "), val_list.join(", ")
            );

            match ds.execute(&sql).await {
                Ok(_) => success_count += 1,
                Err(e) => {
                    if stop_on_error {
                        return Err(e);
                    }
                }
            }
        }
    }

    Ok(success_count)
}

// ============ 数据库备份 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupParams {
    pub connection_id: i64,
    pub database: String,
    pub output_path: String,      // 完整文件路径（含文件名和后缀）
    pub include_schema: bool,
    pub include_data: bool,
    pub compress: bool,           // MySQL: -C
    pub custom_format: bool,      // PG only: --format=c → 输出 .dump
}

#[tauri::command]
pub async fn backup_database(params: BackupParams) -> Result<(), String> {
    use std::process::Command;

    let config = crate::db::get_connection_config(params.connection_id)
        .map_err(|e| e.to_string())?;

    let host = &config.host;
    let port = config.port;
    let user = &config.username;
    let password = &config.password;

    let driver = config.driver.to_lowercase();

    let mut cmd = if driver == "mysql" {
        let mut c = Command::new("mysqldump");
        c.arg(format!("-h{}", host))
         .arg(format!("-P{}", port))
         .arg(format!("-u{}", user))
         .arg(format!("-p{}", password));
        if params.compress { c.arg("-C"); }
        if !params.include_data { c.arg("--no-data"); }
        if !params.include_schema { c.arg("--no-create-info"); }
        c.arg("--databases").arg(&params.database);
        c
    } else {
        // PostgreSQL
        let mut c = Command::new("pg_dump");
        c.arg("-h").arg(host)
         .arg("-p").arg(port.to_string())
         .arg("-U").arg(user)
         .arg("-d").arg(&params.database);
        if !params.include_schema { c.arg("--data-only"); }
        if !params.include_data { c.arg("--schema-only"); }
        if params.custom_format { c.arg("--format=c"); }
        c.env("PGPASSWORD", password);
        c
    };

    // 将 stdout 重定向到输出文件
    let output_file = std::fs::File::create(&params.output_path)
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    cmd.stdout(output_file);

    let status = cmd.status().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            let tool = if driver == "mysql" { "mysqldump" } else { "pg_dump" };
            format!("未找到 {}，请确认已安装并添加到 PATH", tool)
        } else {
            e.to_string()
        }
    })?;

    if !status.success() {
        return Err(format!("备份命令退出码非零：{:?}", status.code()));
    }

    Ok(())
}

/// 获取数据库版本字符串（供前端缓存，失败时返回空字符串）
#[tauri::command]
pub async fn get_db_version(connection_id: i64) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await
        .map_err(|_| crate::AppError::Other("connect failed".into()))?;
    let result = ds.execute("SELECT VERSION()").await
        .unwrap_or_else(|_| crate::datasource::QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms: 0,
        });
    let version = result.rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(version)
}

/// 在系统文件管理器中打开指定路径（文件或目录）
#[tauri::command]
pub async fn show_in_folder(path: String) -> AppResult<()> {
    let p = std::path::Path::new(&path);
    let is_dir = p.is_dir();

    #[cfg(target_os = "windows")]
    {
        if is_dir {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path))
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if is_dir {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let open_path = if is_dir {
            path.clone()
        } else {
            p.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(&open_path)
            .spawn()
            .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
    }
    Ok(())
}

// ============ 指标管理 ============

#[tauri::command]
pub async fn list_metrics(
    connection_id: i64,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::list_metrics(connection_id, status.as_deref())
}

#[tauri::command]
pub async fn save_metric(
    input: crate::metrics::CreateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::save_metric(&input)
}

#[tauri::command]
pub async fn update_metric(
    id: i64,
    input: crate::metrics::UpdateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::crud::update_metric(id, &input)
}

#[tauri::command]
pub async fn delete_metric(id: i64) -> AppResult<()> {
    crate::metrics::delete_metric(id)
}

#[tauri::command]
pub async fn approve_metric(id: i64, status: String) -> AppResult<crate::metrics::Metric> {
    if status != "approved" && status != "rejected" {
        return Err(crate::AppError::Other("status must be 'approved' or 'rejected'".into()));
    }
    crate::metrics::set_metric_status(id, &status)
}

// ============ 知识图谱 ============

#[tauri::command]
pub async fn build_schema_graph(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    crate::graph::build_schema_graph(connection_id, app_handle).await
}

#[tauri::command]
pub async fn get_graph_nodes(
    connection_id: i64,
    node_type: Option<String>,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::query::get_nodes(connection_id, node_type.as_deref())
}

#[tauri::command]
pub async fn search_graph(
    connection_id: i64,
    keyword: String,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::search_graph(connection_id, &keyword)
}

// ============ 跨数据源迁移 ============

#[tauri::command]
pub async fn create_migration_task(
    name: String,
    src_connection_id: i64,
    dst_connection_id: i64,
    config: crate::migration::MigrationConfig,
) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::create_task(&name, src_connection_id, dst_connection_id, &config)
}

#[tauri::command]
pub async fn list_migration_tasks() -> AppResult<Vec<crate::migration::MigrationTask>> {
    crate::migration::list_tasks()
}

#[tauri::command]
pub async fn run_migration_precheck(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::run_precheck(task_id).await
}

#[tauri::command]
pub async fn get_precheck_report(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::get_precheck_result(task_id)
}

#[tauri::command]
pub async fn pause_migration(task_id: i64) -> AppResult<()> {
    crate::migration::pause_migration(task_id)
}

#[tauri::command]
pub async fn get_migration_progress(
    task_id: i64,
) -> AppResult<Option<crate::migration::task_mgr::MigrationProgress>> {
    let task = crate::migration::get_task(task_id)?;
    Ok(task.progress)
}

// ============ AI 指标草稿 + Text-to-SQL v2 ============

#[tauri::command]
pub async fn ai_generate_metrics(
    connection_id: i64,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::ai_draft::generate_metric_drafts(connection_id).await
}

#[tauri::command]
pub async fn ai_generate_sql_v2(
    question: String,
    connection_id: i64,
    history: Option<Vec<crate::llm::ChatMessage>>,
) -> AppResult<crate::pipeline::TextToSqlResult> {
    let hist = history.unwrap_or_default();
    crate::pipeline::generate_sql_v2(&question, connection_id, &hist).await
}

// ============ 数据迁移 — 启动 & 查询 ============

#[tauri::command]
pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    crate::migration::start_migration(task_id, app_handle).await
}

#[tauri::command]
pub fn get_migration_task(task_id: i64) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::get_task(task_id)
}

// ============ ACP Elicitation — 权限确认回传（旧版，已废弃，桩函数保留兼容性）============

/// ACP 权限确认回传（旧版，已迁移到 agent_permission_respond）
#[tauri::command]
pub async fn acp_permission_respond(
    _session_id: String,
    _permission_id: String,
    _selected_option_id: String,
    _cancelled: bool,
    _state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    Ok(())
}

/// ACP Elicitation 回传（旧版，已废弃）
#[tauri::command]
pub async fn acp_elicitation_respond(
    _session_id: String,
    _elicitation_id: String,
    _action: String,
    _content: Option<serde_json::Value>,
    _state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    Ok(())
}

/// 前端 DiffPanel 用户点击"应用"或"取消"后调用，解除 propose_sql_diff 的阻塞等待。
/// confirmed=true 表示用户应用了修改，confirmed=false 表示用户取消。
#[tauri::command]
pub async fn mcp_diff_respond(
    confirmed: bool,
    state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    if let Some(tx) = state.pending_diff_response.lock().await.take() {
        let _ = tx.send(confirmed);
    }
    Ok(())
}

// ============ UI 状态持久化 ============

#[tauri::command]
pub async fn get_ui_state(key: String) -> AppResult<Option<String>> {
    let conn = crate::db::get().lock().unwrap();
    let result = conn
        .query_row(
            "SELECT value FROM ui_state WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(result)
}

#[tauri::command]
pub async fn set_ui_state(key: String, value: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO ui_state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value],
    )
    .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_ui_state(key: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "DELETE FROM ui_state WHERE key = ?1",
        rusqlite::params![key],
    )
    .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(())
}

/// 通过连接 ID 测试连接是否可用（从 SQLite 读取配置并解密密码），3 秒超时。
#[tauri::command]
pub async fn test_connection_by_id(connection_id: i64) -> AppResult<bool> {
    let config = crate::db::get_connection_config(connection_id)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        async {
            let ds = crate::datasource::create_datasource(&config).await?;
            ds.test_connection().await?;
            Ok::<bool, crate::AppError>(true)
        },
    )
    .await;
    match result {
        Ok(Ok(_)) => Ok(true),
        _ => Ok(false),
    }
}

// ============ Tab SQL 文件管理 ============

fn tabs_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let dir = data_dir.join("tabs");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn read_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<Option<String>, String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn write_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
    content: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tab_files(
    app_handle: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let dir = tabs_dir(&app_handle)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".sql").map(|s| s.to_string())
        })
        .collect();
    Ok(ids)
}

// ============ Auto 模式 ============

#[tauri::command]
pub async fn get_auto_mode(state: tauri::State<'_, crate::AppState>) -> AppResult<bool> {
    let mode = state.auto_mode.lock().await;
    Ok(*mode)
}

#[tauri::command]
pub async fn set_auto_mode(
    state: tauri::State<'_, crate::AppState>,
    enabled: bool,
) -> AppResult<()> {
    {
        let mut mode = state.auto_mode.lock().await;
        *mode = enabled;
    }
    // 持久化到 app_settings
    crate::db::set_app_setting("auto_mode", if enabled { "true" } else { "false" })?;
    Ok(())
}

// ============ MCP 双向桥接回调 ============

#[tauri::command]
pub async fn mcp_ui_action_respond(
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
    success: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
) -> AppResult<()> {
    let tx = {
        let mut pending = state.pending_ui_actions.lock().await;
        pending.remove(&request_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(crate::state::UiActionResponse { success, data, error });
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_query_respond(
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
    data: serde_json::Value,
) -> AppResult<()> {
    let tx = {
        let mut pending = state.pending_queries.lock().await;
        pending.remove(&request_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(data);
    }
    Ok(())
}

// ============ Agent Serve 模式命令 ============

/// Agent session 记录（从 SQLite agent_sessions 表返回）
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    pub id: String,
    pub title: Option<String>,
    pub config_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建 agent session
/// 1. 如果 config_id 指定，获取 LLM 配置并调用 patch_config
/// 2. POST /session → 获取 session_id
/// 3. 写入 SQLite agent_sessions 表（is_temp=0）
/// 4. 返回 session_id
#[tauri::command]
pub async fn agent_create_session(
    config_id: Option<i64>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    // 如果指定了 config_id，写入 opencode.json 并热更新
    if let Some(id) = config_id {
        let cfg = crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
        let opencode_dir = state.app_data_dir.join("opencode");
        // 自定义模式：写入 provider 配置
        if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
            if let Err(e) = crate::agent::config::upsert_custom_provider(
                &opencode_dir,
                &cfg.opencode_provider_id,
                &cfg.api_type,
                &cfg.base_url,
                &cfg.api_key,
            ) {
                log::warn!("[agent_create_session] upsert_custom_provider failed: {}", e);
            }
        }
        if let Err(e) = crate::agent::client::patch_config(
            state.serve_port, &cfg.model, &cfg.opencode_provider_id,
        ).await {
            log::warn!("[agent_create_session] patch_config failed: {}", e);
        }
    }

    let session_id = crate::agent::client::create_session(state.serve_port, None).await?;
    crate::db::insert_agent_session(&session_id, None, config_id, false)?;
    Ok(session_id)
}

/// 删除 agent session
/// DELETE /session/:id + 从 agent_sessions 表删除
#[tauri::command]
pub async fn agent_delete_session(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &session_id).await {
        log::warn!("[agent_delete_session] HTTP delete failed (ignored): {}", e);
    }
    crate::db::delete_agent_session(&session_id)?;
    Ok(())
}

/// 删除所有 agent sessions（包括临时 session）
/// 逐一调用 DELETE /session/:id（忽略个别失败），清空 agent_sessions 表
#[tauri::command]
pub async fn agent_delete_all_sessions(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let records = crate::db::list_agent_sessions(true)?;
    for record in &records {
        if let Err(e) = crate::agent::client::delete_session(state.serve_port, &record.id).await {
            log::warn!("[agent_delete_all_sessions] Failed to delete session {}: {}", record.id, e);
        }
    }
    crate::db::delete_all_agent_sessions()?;
    Ok(())
}

/// 列出所有 agent sessions（is_temp=0）
#[tauri::command]
pub async fn agent_list_sessions(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<AgentSessionRecord>> {
    let _ = state; // state not needed but kept for consistency
    crate::db::list_agent_sessions(false)
}

/// 获取 session 消息历史
/// GET /session/:id/message
#[tauri::command]
pub async fn agent_get_session_messages(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<serde_json::Value> {
    crate::agent::client::get_messages(state.serve_port, &session_id).await
}

/// 清除 session 历史（删除旧 session 并创建新 session）
/// 1. DELETE /session/:id + 从 agent_sessions 表删除
/// 2. POST /session → 获取新 session_id
/// 3. 写入 agent_sessions 表
/// 4. 返回新 session_id
#[tauri::command]
pub async fn agent_clear_session_history(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    // 先获取旧 session 的 config_id，以便新 session 继承
    let old_records = crate::db::list_agent_sessions(true)?;
    let old_config_id = old_records.iter()
        .find(|r| r.id == session_id)
        .and_then(|r| r.config_id);

    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &session_id).await {
        log::warn!("[agent_clear_session_history] HTTP delete failed (ignored): {}", e);
    }
    crate::db::delete_agent_session(&session_id)?;

    let new_id = crate::agent::client::create_session(state.serve_port, None).await?;
    crate::db::insert_agent_session(&new_id, None, old_config_id, false)?;
    Ok(new_id)
}

/// 取消（abort）agent session
/// POST /session/:id/abort
#[tauri::command]
pub async fn agent_cancel_session(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::abort_session(state.serve_port, &session_id).await
}

/// 权限请求回复
/// POST /session/:id/permissions/:permissionID { response, remember? }
#[tauri::command]
pub async fn agent_permission_respond(
    session_id: String,
    permission_id: String,
    response: String,
    remember: Option<bool>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::permission_respond(
        state.serve_port,
        &session_id,
        &permission_id,
        &response,
        remember,
    )
    .await
}

/// Agent 对话（Serve 模式）
/// 1. 写入 editor_sql_map 和 last_active_session_id
/// 2. 构建 prompt_text
/// 3. 获取 model 字段
/// 4. POST /session/:id/message 并解析 SSE 流 → channel
#[tauri::command]
pub async fn agent_chat(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_chat_inner(
        prompt, tab_sql, connection_id, config_id, session_id, &channel, &state,
    )
    .await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error {
            message: e.to_string(),
        });
    }
    result
}

/// 将 LLM 配置应用到 opencode（写入自定义供应商文件 + 热更新模型/供应商）。
/// 返回 (model, effective_provider_id)。
/// 当 opencode_provider_id 为空时降级到 api_type，保持对旧配置的向后兼容。
async fn apply_llm_config_to_opencode(
    cfg: &crate::db::models::LlmConfig,
    state: &tauri::State<'_, crate::AppState>,
) -> (String, String) {
    let effective_provider = if cfg.opencode_provider_id.is_empty() {
        cfg.api_type.clone()
    } else {
        cfg.opencode_provider_id.clone()
    };

    if cfg.config_mode == "custom" && !effective_provider.is_empty() {
        let opencode_dir = state.app_data_dir.join("opencode");
        if let Err(e) = crate::agent::config::upsert_custom_provider(
            &opencode_dir,
            &effective_provider,
            &cfg.api_type,
            &cfg.base_url,
            &cfg.api_key,
        ) {
            log::warn!("[apply_llm_config] upsert_custom_provider failed: {}", e);
        }
    }

    if !cfg.model.is_empty() && !effective_provider.is_empty() {
        if let Err(e) = crate::agent::client::patch_config(
            state.serve_port, &cfg.model, &effective_provider,
        ).await {
            log::warn!("[apply_llm_config] patch_config failed: {}", e);
        }
    }

    (cfg.model.clone(), effective_provider)
}

async fn agent_chat_inner(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    // 1. 写入编辑器 SQL 到 per-session map，并更新 last_active_session_id
    {
        let mut map = state.editor_sql_map.lock().await;
        map.insert(session_id.clone(), tab_sql.clone());
    }
    {
        let mut last = state.last_active_session_id.lock().await;
        *last = Some(session_id.clone());
    }

    // 2. 构建 prompt 文本（复用现有逻辑）
    let mut prompt_text = prompt;
    if let Some(conn_id) = connection_id {
        prompt_text = format!("当前数据库连接 ID: {}\n\n{}", conn_id, prompt_text);
    }
    if let Some(ref sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!(
                "当前编辑器 SQL：\n```sql\n{}\n```\n\n{}",
                sql, prompt_text
            );
        }
    }

    // 3. 获取 model/provider 字段，并确保 opencode 配置正确（含 API Key 热写入）
    let (model_str, provider_str) = match config_id {
        Some(id) => {
            let cfg = crate::db::get_llm_config_by_id(id)?
                .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
            apply_llm_config_to_opencode(&cfg, state).await
        }
        None => {
            match crate::db::get_default_llm_config()? {
                Some(cfg) => apply_llm_config_to_opencode(&cfg, state).await,
                None => (String::new(), String::new()),
            }
        }
    };

    // 4. 通过 /event SSE 实现真正流式（先订阅 SSE，再后台发消息）
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    crate::agent::stream::stream_global_events(
        state.serve_port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        None,
        channel,
    )
    .await
}

/// 请求 AI 生成标题（使用临时 session）
/// 1. POST /session { title: "temp-title" } → 临时 session_id，is_temp=1
/// 2. 发送单条消息（根据 context 生成标题）
/// 3. 收集 SSE 流的所有 ContentChunk 合并为完整文本
/// 4. DELETE /session/:id（finally 路径）
/// 5. 返回标题文本
#[tauri::command]
pub async fn agent_request_ai_title(
    session_id: String,
    context: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    let _ = session_id; // 仅用于上下文，不直接使用

    // 1. 创建临时 session
    let temp_id = crate::agent::client::create_session(state.serve_port, Some("temp-title")).await?;
    crate::db::insert_agent_session(&temp_id, Some("temp-title"), None, true)?;

    // 2. 发送消息
    let prompt = format!(
        "请根据以下内容，生成一个简洁的对话标题，不超过20个字，只返回标题文本，不要解释：\n\n{}",
        context
    );

    // 3. 通过 /event SSE 收集完整回复（标题生成，无需流式显示）
    let title = crate::agent::stream::collect_text_via_global_events(
        state.serve_port,
        &temp_id,
        &prompt,
        None,
        None,
    )
    .await
    .unwrap_or_default();

    // 4. 清理临时 session（finally 路径）
    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &temp_id).await {
        log::warn!("[agent_request_ai_title] Failed to delete temp session: {}", e);
    }
    let _ = crate::db::delete_agent_session(&temp_id);

    // 5. 返回标题
    Ok(title.trim().to_string())
}


/// 应用 LLM 配置到 opencode serve（写盘 + 热更新）
#[tauri::command]
pub async fn agent_apply_config(
    config_id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let cfg = crate::db::get_llm_config_by_id(config_id)?
        .ok_or_else(|| AppError::Other(format!("LLM config {} not found", config_id)))?;

    let opencode_dir = state.app_data_dir.join("opencode");

    // 自定义模式：先写入 opencode.json 的 provider 配置
    if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
        if let Err(e) = crate::agent::config::upsert_custom_provider(
            &opencode_dir,
            &cfg.opencode_provider_id,
            &cfg.api_type,
            &cfg.base_url,
            &cfg.api_key,
        ) {
            log::warn!("[agent_apply_config] upsert_custom_provider failed: {}", e);
        }
    }

    // 两种模式统一用 opencode_provider_id 热更新
    if let Err(e) = crate::agent::client::patch_config(
        state.serve_port, &cfg.model, &cfg.opencode_provider_id,
    ).await {
        log::warn!("[agent_apply_config] patch_config failed (ignored): {}", e);
    }

    Ok(())
}

// ── OpenCode Provider 类型（用于 agent_list_providers 命令）──────────────
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProviderModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProvider {
    pub id: String,
    pub name: String,
    pub source: String,
    pub models: Vec<OpenCodeProviderModel>,
}

/// 从 opencode serve 获取可用供应商和模型列表。
/// 失败时返回空列表（opencode 未运行时降级）。
#[tauri::command]
pub async fn agent_list_providers(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<OpenCodeProvider>> {
    let port = state.serve_port;
    let url = format!("http://127.0.0.1:{}/config/providers", port);
    let client = reqwest::Client::new();
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[agent_list_providers] Request failed (opencode not running?): {}", e);
            return Ok(vec![]);
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[agent_list_providers] Failed to parse response: {}", e);
            return Ok(vec![]);
        }
    };
    let arr = match json["providers"].as_array() {
        Some(a) => a.clone(),
        None => {
            log::warn!("[agent_list_providers] Unexpected response format (no 'providers' array)");
            return Ok(vec![]);
        }
    };
    let providers = arr.into_iter().filter_map(|p| {
        let id = p["id"].as_str()?.to_string();
        let name = p["name"].as_str().unwrap_or(&id).to_string();
        let source = p["source"].as_str().unwrap_or("").to_string();
        let models = p["models"].as_object()
            .map(|m| m.iter().map(|(k, v)| OpenCodeProviderModel {
                id: k.clone(),
                name: v["name"].as_str().unwrap_or(k).to_string(),
            }).collect::<Vec<_>>())
            .unwrap_or_default();
        Some(OpenCodeProvider { id, name, source, models })
    }).collect();
    Ok(providers)
}

/// 无状态连接测试，直接接收配置参数，不写 DB。
/// 仅适用于自定义模式（opencode 模式无需 api_key，opencode 自行管理认证）。
#[tauri::command]
pub async fn test_llm_config_inline(
    model: String,
    api_type: String,
    base_url: String,
    api_key: String,
) -> AppResult<()> {
    let parsed_api_type = parse_api_type(&api_type);
    let client = crate::llm::client::LlmClient::new(
        api_key,
        Some(base_url),
        Some(model),
        Some(parsed_api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    client.chat(messages).await.map(|_| ())
}


// === SQL 解释/优化（新版，使用 serve 模式临时 session）===

/// 辅助函数：清理临时 explain/optimize session（abort + delete HTTP + delete DB）
async fn cleanup_temp_sql_session(port: u16, session_id: &str) {
    let _ = crate::agent::client::abort_session(port, session_id).await;
    let _ = crate::agent::client::delete_session(port, session_id).await;
    let _ = crate::db::delete_agent_session(session_id);
}

#[tauri::command]
pub async fn agent_explain_sql(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_explain_sql_inner(sql, connection_id, database, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    result
}

async fn agent_explain_sql_inner(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let port = state.serve_port;

    // 1. 并发处理：若上次请求仍在进行，先 abort 旧 session
    {
        let mut guard = state.current_explain_session_id.lock().await;
        if let Some(old_id) = guard.take() {
            log::info!("[agent_explain_sql] Aborting previous explain session: {}", old_id);
            cleanup_temp_sql_session(port, &old_id).await;
        }
    }

    // 2. 获取当前 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    // 3. 构建 prompt_text（与旧版格式相同）
    let conn_context = if let Some(conn_id) = connection_id {
        let driver = crate::db::get_connection_config(conn_id)
            .map(|c| c.driver)
            .unwrap_or_else(|_| "mysql".to_string());
        let db_line = match &database {
            Some(db) if !db.is_empty() => format!("当前数据库: {}\n", db),
            _ => String::new(),
        };
        format!("当前数据库连接 ID: {}\n数据库类型: {}\n{}\n", conn_id, driver, db_line)
    } else {
        String::new()
    };
    let prompt_text = format!("{}请分析以下 SQL：\n\n{}", conn_context, sql);

    // 4. 创建临时 session，写入 agent_sessions(is_temp=1)
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let title = format!("sql-explain-{}", ts);
    let session_id = crate::agent::client::create_session(port, Some(&title)).await?;
    crate::db::insert_agent_session(&session_id, Some(&title), None, true)?;

    // 5. 存入 AppState
    {
        let mut guard = state.current_explain_session_id.lock().await;
        *guard = Some(session_id.clone());
    }

    // 6. 通过 /event SSE 流式输出（先订阅 SSE，再后台发消息）
    let (model_str, provider_str) = apply_llm_config_to_opencode(&config, state).await;
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    let stream_result = crate::agent::stream::stream_global_events(
        port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        Some("sql-explain"),
        channel,
    )
    .await;

    // 8. finally 路径：无论成功/失败，清理 session
    cleanup_temp_sql_session(port, &session_id).await;
    {
        let mut guard = state.current_explain_session_id.lock().await;
        if guard.as_deref() == Some(&session_id) {
            *guard = None;
        }
    }

    stream_result
}

#[tauri::command]
pub async fn agent_optimize_sql(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_optimize_sql_inner(sql, connection_id, database, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    result
}

async fn agent_optimize_sql_inner(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let port = state.serve_port;

    // 1. 并发处理：若上次请求仍在进行，先 abort 旧 session
    {
        let mut guard = state.current_optimize_session_id.lock().await;
        if let Some(old_id) = guard.take() {
            log::info!("[agent_optimize_sql] Aborting previous optimize session: {}", old_id);
            cleanup_temp_sql_session(port, &old_id).await;
        }
    }

    // 2. 获取当前 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    // 3. 构建 prompt_text（与旧版格式相同）
    let conn_context = if let Some(conn_id) = connection_id {
        let driver = crate::db::get_connection_config(conn_id)
            .map(|c| c.driver)
            .unwrap_or_else(|_| "mysql".to_string());
        let db_line = match &database {
            Some(db) if !db.is_empty() => format!("当前数据库: {}\n", db),
            _ => String::new(),
        };
        format!("当前数据库连接 ID: {}\n数据库类型: {}\n{}\n", conn_id, driver, db_line)
    } else {
        String::new()
    };
    let prompt_text = format!("{}优化以下 SQL：\n\n{}", conn_context, sql);

    // 4. 创建临时 session，写入 agent_sessions(is_temp=1)
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let title = format!("sql-optimize-{}", ts);
    let session_id = crate::agent::client::create_session(port, Some(&title)).await?;
    crate::db::insert_agent_session(&session_id, Some(&title), None, true)?;

    // 5. 存入 AppState
    {
        let mut guard = state.current_optimize_session_id.lock().await;
        *guard = Some(session_id.clone());
    }

    // 6. 通过 /event SSE 流式输出（先订阅 SSE，再后台发消息）
    let (model_str, provider_str) = apply_llm_config_to_opencode(&config, state).await;
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    let stream_result = crate::agent::stream::stream_global_events(
        port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        Some("sql-optimize"),
        channel,
    )
    .await;

    // 8. finally 路径：无论成功/失败，清理 session
    cleanup_temp_sql_session(port, &session_id).await;
    {
        let mut guard = state.current_optimize_session_id.lock().await;
        if guard.as_deref() == Some(&session_id) {
            *guard = None;
        }
    }

    stream_result
}

#[tauri::command]
pub async fn cancel_explain_sql(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let session_id = {
        let mut guard = state.current_explain_session_id.lock().await;
        guard.take()
    };
    if let Some(id) = session_id {
        log::info!("[cancel_explain_sql] Cancelling explain session: {}", id);
        // 忽略错误：取消操作失败不影响后续使用
        cleanup_temp_sql_session(state.serve_port, &id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_optimize_sql(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let session_id = {
        let mut guard = state.current_optimize_session_id.lock().await;
        guard.take()
    };
    if let Some(id) = session_id {
        log::info!("[cancel_optimize_sql] Cancelling optimize session: {}", id);
        // 忽略错误：取消操作失败不影响后续使用
        cleanup_temp_sql_session(state.serve_port, &id).await;
    }
    Ok(())
}
