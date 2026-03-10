use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory, SavedQuery};
use crate::llm::{ChatContext, ChatMessage};
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

// ============ 查询执行 ============

#[tauri::command]
pub async fn execute_query(connection_id: i64, sql: String) -> AppResult<QueryResult> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

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
    let api_key_enc = crate::db::get_setting("llm.api_key")?
        .ok_or_else(|| AppError::Llm("LLM API Key not configured. Please set it in Settings.".into()))?;
    let api_key = crate::crypto::decrypt(&api_key_enc)?;
    let base_url = crate::db::get_setting("llm.base_url")?;
    let model = crate::db::get_setting("llm.model")?;
    let api_type = crate::db::get_setting("llm.api_type")?
        .map(|v| parse_api_type(&v));
    Ok(crate::llm::client::LlmClient::new(api_key, base_url, model, api_type))
}

#[tauri::command]
pub async fn ai_chat(message: String, context: ChatContext) -> AppResult<String> {
    let client = build_llm_client()?;
    let mut messages = context.history.clone();
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat(messages).await
}

#[tauri::command]
pub async fn ai_generate_sql(prompt: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>()
        .join("\n");

    client.generate_sql(&prompt, &schema_context, &config.driver).await
}

#[tauri::command]
pub async fn ai_explain_sql(sql: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    client.explain_sql(&sql, &config.driver).await
}

// ============ LLM 设置 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: crate::llm::ApiType,
}

#[tauri::command]
pub async fn get_llm_settings() -> AppResult<LlmSettings> {
    let api_key = match crate::db::get_setting("llm.api_key")? {
        Some(enc) if !enc.is_empty() => crate::crypto::decrypt(&enc)?,
        _ => String::new(),
    };
    Ok(LlmSettings {
        api_key,
        base_url: crate::db::get_setting("llm.base_url")?
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        model: crate::db::get_setting("llm.model")?
            .unwrap_or_else(|| "gpt-4o-mini".to_string()),
        api_type: crate::db::get_setting("llm.api_type")?
            .map(|v| parse_api_type(&v))
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn set_llm_settings(settings: LlmSettings) -> AppResult<()> {
    // API Key 加密存储
    let enc_key = crate::crypto::encrypt(&settings.api_key)?;
    crate::db::set_setting("llm.api_key", &enc_key)?;
    crate::db::set_setting("llm.base_url", &settings.base_url)?;
    crate::db::set_setting("llm.model", &settings.model)?;
    let api_type_str = match settings.api_type {
        crate::llm::ApiType::Openai => "openai",
        crate::llm::ApiType::Anthropic => "anthropic",
    };
    crate::db::set_setting("llm.api_type", api_type_str)?;
    Ok(())
}

#[tauri::command]
pub async fn test_llm_connection(settings: LlmSettings) -> AppResult<()> {
    let client = crate::llm::client::LlmClient::new(
        settings.api_key,
        Some(settings.base_url),
        Some(settings.model),
        Some(settings.api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    client.chat(messages).await?;
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
pub async fn get_table_detail(connection_id: i64, table: String) -> AppResult<crate::datasource::TableDetail> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let columns = ds.get_columns(&table).await?;
    let indexes = ds.get_indexes(&table).await?;
    let foreign_keys = ds.get_foreign_keys(&table).await?;
    Ok(crate::datasource::TableDetail { name: table, columns, indexes, foreign_keys })
}

#[tauri::command]
pub async fn get_full_schema(connection_id: i64) -> AppResult<crate::datasource::FullSchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_full_schema().await
}

#[tauri::command]
pub async fn get_table_ddl(connection_id: i64, table: String) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_table_ddl(&table).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    pub connection_id: i64,
    pub table: String,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,
    pub order_clause: Option<String>,
}

#[tauri::command]
pub async fn get_table_data(params: TableDataParams) -> AppResult<crate::datasource::QueryResult> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

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

    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "SELECT * FROM `{}`{}{} LIMIT {} OFFSET {}",
            params.table.replace('`', "``"), where_part, order_part, params.page_size, offset
        ),
        _ => format!(
            "SELECT * FROM \"{}\"{}{} LIMIT {} OFFSET {}",
            params.table.replace('"', "\"\""), where_part, order_part, params.page_size, offset
        ),
    };

    ds.execute(&sql).await
}

#[tauri::command]
pub async fn update_row(
    connection_id: i64,
    table: String,
    pk_column: String,
    pk_value: String,
    column: String,
    new_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "UPDATE `{}` SET `{}` = '{}' WHERE `{}` = '{}'",
            table.replace('`', "``"),
            column.replace('`', "``"),
            new_value.replace('\'', "\\'"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "UPDATE \"{}\" SET \"{}\" = '{}' WHERE \"{}\" = '{}'",
            table.replace('"', "\"\""),
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
    table: String,
    pk_column: String,
    pk_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "DELETE FROM `{}` WHERE `{}` = '{}'",
            table.replace('`', "``"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "DELETE FROM \"{}\" WHERE \"{}\" = '{}'",
            table.replace('"', "\"\""),
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

// ============ 数据导出 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportParams {
    pub connection_id: i64,
    pub table: String,
    pub format: String, // "csv" | "json" | "sql"
    pub where_clause: Option<String>,
    pub output_path: String,
}

#[tauri::command]
pub async fn export_table_data(params: ExportParams) -> AppResult<String> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();

    let sql = match config.driver.as_str() {
        "mysql" => format!("SELECT * FROM `{}`{}", params.table.replace('`', "``"), where_part),
        _ => format!("SELECT * FROM \"{}\"{}", params.table.replace('"', "\"\""), where_part),
    };

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

// ============ AI 高级命令 ============

#[tauri::command]
pub async fn ai_optimize_sql(sql: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;
    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>().join("\n");
    client.optimize_sql(&sql, &schema_context, &config.driver).await
}

#[tauri::command]
pub async fn ai_create_table(description: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    client.create_table_ddl(&description, &config.driver).await
}

#[tauri::command]
pub async fn ai_diagnose_error(sql: String, error_msg: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;
    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>().join("\n");
    client.diagnose_error(&sql, &error_msg, &schema_context, &config.driver).await
}
