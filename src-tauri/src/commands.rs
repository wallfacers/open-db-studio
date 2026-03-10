use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory, SavedQuery};
use crate::llm::{ChatContext, ChatMessage, LlmClient};
use crate::{AppError, AppResult};

// ============ 连接管理 ============

#[tauri::command]
pub async fn list_connections() -> AppResult<Vec<Connection>> {
    crate::db::list_connections()
}

#[tauri::command]
pub async fn create_connection(_req: CreateConnectionRequest) -> AppResult<Connection> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<bool> {
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.test_connection().await?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_connection(_id: i64) -> AppResult<()> {
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ 查询执行 ============

#[tauri::command]
pub async fn execute_query(_connection_id: i64, _sql: String) -> AppResult<QueryResult> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn get_tables(_connection_id: i64) -> AppResult<Vec<TableMeta>> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn get_schema(_connection_id: i64) -> AppResult<SchemaInfo> {
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ AI 代理 ============

#[tauri::command]
pub async fn ai_chat(_message: String, _context: ChatContext) -> AppResult<String> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn ai_generate_sql(_prompt: String, _connection_id: i64) -> AppResult<String> {
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ 历史 & 收藏 ============

#[tauri::command]
pub async fn get_query_history(_connection_id: i64) -> AppResult<Vec<QueryHistory>> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn save_query(
    _name: String,
    _connection_id: i64,
    _sql: String,
) -> AppResult<SavedQuery> {
    Err(AppError::Other("Not implemented yet".into()))
}
