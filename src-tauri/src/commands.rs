use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory};
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
pub async fn update_llm_config(
    id: i64,
    input: crate::db::models::UpdateLlmConfigInput,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::update_llm_config(id, &input)?;
    config.api_key = String::new();
    // 若被修改的 config 正在使用中，清空 session 使下次请求重建
    invalidate_session_if_matches(id, &state).await;
    Ok(config)
}

#[tauri::command]
pub async fn delete_llm_config(
    id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::db::delete_llm_config(id)?;
    invalidate_session_if_matches(id, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn set_default_llm_config(
    id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::db::set_default_llm_config(id)?;
    // 默认配置变更，直接清空 session（前端若选中"默认"时需要重建）
    *state.acp_session.lock().await = None;
    Ok(())
}

/// 若当前活跃 session 使用的是 config_id，则清空它（下次请求自动重建）
async fn invalidate_session_if_matches(config_id: i64, state: &tauri::State<'_, crate::AppState>) {
    let mut guard = state.acp_session.lock().await;
    if guard.as_ref().map(|s| s.config_id == config_id).unwrap_or(false) {
        *guard = None;
        log::info!("[acp] Session invalidated because config {} was modified/deleted", config_id);
    }
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

// ============ ACP Agent 模式 ============

/// 外层 wrapper：保证无论 inner 成功还是失败，都向前端发送 Done 事件。
#[tauri::command]
pub async fn ai_chat_acp(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = ai_chat_acp_inner(prompt, tab_sql, connection_id, config_id, &channel, &state).await;
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
async fn ai_chat_acp_inner(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    use crate::state::AcpRequest;
    use crate::llm::StreamEvent;

    // 写入当前编辑器 SQL 到共享状态（供 MCP get_editor_sql 工具读取）
    // 必须在 opencode session 启动前写入
    *state.current_editor_sql.lock().await = tab_sql.clone();

    // 1. 获取指定配置（未指定则用默认）
    let config = match config_id {
        Some(id) => crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?,
        None => crate::db::get_default_llm_config()?
            .ok_or_else(|| AppError::Other("No default LLM config found".into()))?,
    };

    // 2. 构建 prompt 文本（注入连接 ID + SQL 上下文）
    let mut prompt_text = prompt;
    // 注入当前连接 ID，让 AI 知道调用数据库工具时用哪个连接
    if let Some(conn_id) = connection_id {
        prompt_text = format!("当前数据库连接 ID: {}\n\n{}", conn_id, prompt_text);
    }
    if let Some(sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!(
                "当前编辑器 SQL：\n```sql\n{}\n```\n\n{}",
                sql, prompt_text
            );
        }
    }

    // 3. 工作目录
    let cwd = std::path::PathBuf::from(
        std::env::var("APPDATA").unwrap_or_else(|_| ".".into()),
    )
    .join("open-db-studio");
    std::fs::create_dir_all(&cwd).ok();

    // 4. 提前创建事件转发通道（使 session 建立阶段也能发送进度通知给前端）
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let channel_clone = channel.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = channel_clone.send(event);
        }
    });

    // 5. 获取或创建 persistent session（首次建立时通过 event_tx 发送进度通知）
    let request_tx = get_or_create_session(&config, state.mcp_port, &cwd, state, &event_tx).await?;

    // 6. 创建完成信号 channel
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

    // 7. 发送请求给 session 线程
    request_tx
        .send(AcpRequest { prompt_text, event_tx, done_tx })
        .map_err(|_| AppError::Other("ACP session closed unexpectedly".into()))?;

    // 8. 等待 session 线程完成 prompt
    done_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread dropped before responding".into()))?
}

/// 计算配置内容指纹，用于检测同 ID 配置被修改的情况
fn config_fingerprint(config: &crate::db::models::LlmConfig) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        config.api_key,
        config.base_url,
        config.model,
        config.api_type,
        config.preset.as_deref().unwrap_or("")
    )
}

/// 获取当前 session（配置未变）或创建新 session（首次 / 配置变更 / session 已关闭）
async fn get_or_create_session(
    config: &crate::db::models::LlmConfig,
    mcp_port: u16,
    cwd: &std::path::Path,
    state: &tauri::State<'_, crate::AppState>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<crate::llm::StreamEvent>,
) -> AppResult<tokio::sync::mpsc::UnboundedSender<crate::state::AcpRequest>> {
    let mut session_guard = state.acp_session.lock().await;
    let fingerprint = config_fingerprint(config);

    // 检查现有 session 是否可复用（config_id 相同且内容未变且连接未断）
    if let Some(ref session) = *session_guard {
        if session.config_id == config.id
            && session.config_fingerprint == fingerprint
            && !session.request_tx.is_closed()
        {
            log::debug!("[acp] Reusing existing session (config_id={})", config.id);
            return Ok(session.request_tx.clone());
        }
        log::info!("[acp] Session invalid (config changed or closed), rebuilding");
    }

    // 创建新 session（通过 event_tx 向前端发送进度通知）
    log::info!(
        "[acp] Creating new session for config_id={} model={}",
        config.id,
        config.model
    );
    let new_session = crate::acp::session::spawn_acp_session_thread(
        config.api_key.clone(),
        config.base_url.clone(),
        config.model.clone(),
        config.api_type.clone(),
        config.preset.clone(),
        config.id,
        mcp_port,
        cwd.to_path_buf(),
        Some(event_tx.clone()),
    )
    .await?;

    let tx = new_session.request_tx.clone();
    *session_guard = Some(crate::state::PersistentAcpSession {
        config_id: new_session.config_id,
        config_fingerprint: fingerprint,
        request_tx: new_session.request_tx,
    });
    Ok(tx)
}

#[tauri::command]
pub async fn cancel_acp_session(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let mut session_guard = state.acp_session.lock().await;
    if session_guard.is_some() {
        // Drop PersistentAcpSession → request_tx 被 drop →
        // session 线程 request_rx.recv() 返回 None → 线程退出 → kill 子进程
        *session_guard = None;
        log::info!("[acp] Session cancelled, thread will exit on next idle");
    }
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
