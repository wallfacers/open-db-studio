use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory, SavedQuery};
use crate::llm::{ChatContext, ChatMessage, AgentMessage, ToolDefinition};
use crate::{AppError, AppResult};
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
pub async fn update_llm_config(id: i64, input: crate::db::models::UpdateLlmConfigInput) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::update_llm_config(id, &input)?;
    config.api_key = String::new();
    Ok(config)
}

#[tauri::command]
pub async fn delete_llm_config(id: i64) -> AppResult<()> {
    crate::db::delete_llm_config(id)
}

#[tauri::command]
pub async fn set_default_llm_config(id: i64) -> AppResult<()> {
    crate::db::set_default_llm_config(id)
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

#[tauri::command]
pub async fn save_query(
    _name: String,
    _connection_id: i64,
    _sql: String,
) -> AppResult<SavedQuery> {
    Err(AppError::Other("Not implemented yet".into()))
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
}

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
            let mut out = result.columns.iter().map(|c| quote_csv_field(c)).collect::<Vec<_>>().join(",") + "\n";
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
            let mut out = format!("-- Export: {}\n", params.table);
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

#[tauri::command]
pub async fn ai_optimize_sql(sql: String, connection_id: Option<i64>) -> AppResult<String> {
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

    client.optimize_sql(&sql, &schema_context, &driver).await
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

// ============ ACP Agent 模式 ============

/// 外层 wrapper：保证无论 inner 成功还是失败，都向前端发送 Done 事件。
#[tauri::command]
pub async fn ai_chat_acp(
    prompt: String,
    _connection_id: Option<i64>,
    tab_sql: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = ai_chat_acp_inner(prompt, tab_sql, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error {
            message: e.to_string(),
        });
    }
    // Done 事件总是发送，无论成功或失败
    let _ = channel.send(crate::llm::StreamEvent::Done);
    result
}

/// 内层实现：可以自由使用 `?`，错误由外层 wrapper 统一处理。
///
/// 修复内容：
/// - 问题1：Done 事件由 wrapper 统一发送，覆盖所有错误路径
/// - 问题2：prompt 失败时 kill 子进程，避免孤儿进程泄漏
/// - 问题3：放弃 session 复用，每次新建独立 session + local 运行时，
///           避免跨运行时调用 !Send 类型导致的 panic
async fn ai_chat_acp_inner(
    prompt: String,
    tab_sql: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    // 获取活跃 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;
    let api_key = config.api_key.clone();

    // 工作目录：app data dir（通过 APPDATA 环境变量）
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into())
    ).join("open-db-studio");
    std::fs::create_dir_all(&cwd).ok();

    // 写 opencode.json
    crate::acp::config::write_opencode_config(
        &api_key,
        Some(&config.base_url),
        &config.model,
        &config.api_type,
        &cwd,
    )?;

    // 清除旧 session（kill 旧进程），每次对话都用干净的 session 避免跨运行时问题
    {
        let mut guard = state.acp_session.lock().await;
        if let Some(mut old_sess) = guard.take() {
            let _ = old_sess.child_handle.kill().await;
        }
    }

    // 创建流事件 channel（转发 ACP 通知 → Tauri Channel）
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::llm::StreamEvent>();

    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 构建 prompt 文本
    let mut prompt_text = prompt;
    if let Some(sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!("当前编辑器 SQL：\n```sql\n{}\n```\n\n{}", sql, prompt_text);
        }
    }

    let mcp_port = state.mcp_port;
    let active_acp_pid = std::sync::Arc::clone(&state.active_acp_pid);

    // 使用同步 channel 把 !Send 的 ACP 调用结果传回 Send 上下文
    let (result_tx, result_rx) = std::sync::mpsc::channel::<AppResult<()>>();

    // 所有 !Send 的 ACP 调用都在独立的 current-thread 运行时上执行，
    // 与 start_acp_session 内部的 I/O loop 处于同一 LocalSet，避免跨运行时问题
    std::thread::spawn(move || {
        use agent_client_protocol::{Agent, PromptRequest, ContentBlock, TextContent};

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("acp command local runtime");
        let local = tokio::task::LocalSet::new();

        let outcome = local.block_on(&rt, async move {
            // 新建 ACP session（进程 + 握手）
            let (connection, session_id, mut child) =
                crate::acp::client::start_acp_session(mcp_port, &cwd, tx).await?;

            // 存储 PID 到 AppState，以便 cancel_acp_session 可以 kill 进程
            {
                let pid = child.id();
                let mut guard = active_acp_pid.lock().unwrap();
                *guard = pid;
            }

            // 发送 prompt
            let content_blocks = vec![
                ContentBlock::Text(TextContent::new(prompt_text))
            ];
            let conn = connection.lock().await;
            let prompt_result = conn
                .prompt(PromptRequest::new(session_id.clone(), content_blocks))
                .await;
            drop(conn);

            // 无论 prompt 成功还是失败，都 kill 子进程
            let _ = child.kill().await;

            // 清除 PID
            {
                let mut guard = active_acp_pid.lock().unwrap();
                *guard = None;
            }

            // 清理 opencode.json（含明文 API key）
            let config_path = cwd.join("opencode.json");
            if let Err(e) = std::fs::remove_file(&config_path) {
                log::warn!("[acp] Failed to delete opencode.json: {}", e);
            } else {
                log::info!("[acp] Cleaned up opencode.json");
            }

            match prompt_result {
                Ok(resp) => {
                    log::info!("ACP prompt done, stop_reason: {:?}", resp.stop_reason);
                    Ok(())
                }
                Err(e) => Err(AppError::Other(format!("ACP prompt failed: {}", e))),
            }
        });

        let _ = result_tx.send(outcome);
    });

    // 等待本地线程结果（以 tokio blocking 友好方式）
    tokio::task::spawn_blocking(move || result_rx.recv())
        .await
        .map_err(|e| AppError::Other(format!("Join error: {}", e)))?
        .map_err(|e| AppError::Other(format!("Channel recv error: {}", e)))?
}

#[tauri::command]
pub async fn cancel_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let pid_opt = {
        let guard = state.active_acp_pid.lock().unwrap();
        *guard
    };
    if let Some(pid) = pid_opt {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .status();
        }
    }
    Ok(())
}
