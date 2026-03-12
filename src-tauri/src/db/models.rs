use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub extra_params: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct ReorderItem {
    pub id: i64,
    pub sort_order: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub group_id: Option<i64>,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub extra_params: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionGroup {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryHistory {
    pub id: i64,
    pub connection_id: Option<i64>,
    pub sql: String,
    pub executed_at: String,
    pub duration_ms: Option<i64>,
    pub row_count: Option<i64>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmConfig {
    pub id: i64,
    pub name: String,
    pub api_key: String,   // 已解密的明文，仅在内存中使用
    pub base_url: String,
    pub model: String,
    pub api_type: String,
    pub preset: Option<String>,
    pub is_default: bool,
    pub test_status: String,
    pub test_error: Option<String>,
    pub tested_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateLlmConfigInput {
    pub name: Option<String>,   // None 时调用者自动填充为 "{model} · {api_type}"
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: String,
    pub preset: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateLlmConfigInput {
    pub name: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_type: Option<String>,
    pub preset: Option<String>,
}
