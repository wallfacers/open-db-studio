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
