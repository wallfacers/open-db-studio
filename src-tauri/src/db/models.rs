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
    pub opencode_provider_id: String,
    pub config_mode: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateLlmConfigInput {
    pub name: Option<String>,   // None 时调用者自动填充为 "{model} · {api_type}"
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: String,
    pub preset: Option<String>,
    pub opencode_provider_id: String,  // opencode 模式传实际 providerID；自定义模式传用户自定义 ID
    pub config_mode: String,           // "opencode" | "custom"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateLlmConfigInput {
    pub name: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_type: Option<String>,
    pub preset: Option<String>,
    pub opencode_provider_id: Option<String>,
    pub config_mode: Option<String>,
}

// ============ 任务记录模型 ============

/// 任务记录（存储在 SQLite 中）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub title: String,
    pub params: Option<String>,
    pub progress: i32,
    pub processed_rows: i64,
    pub total_rows: Option<i64>,
    pub current_target: Option<String>,
    pub error: Option<String>,
    pub error_details: Option<String>,
    pub output_path: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// 创建任务输入
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTaskInput {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub title: String,
    pub params: Option<String>,
    pub progress: Option<i32>,
    pub processed_rows: Option<i64>,
    pub total_rows: Option<i64>,
    pub current_target: Option<String>,
    pub error: Option<String>,
    pub error_details: Option<String>,
    pub output_path: Option<String>,
    pub description: Option<String>,
}

/// 更新任务输入
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct UpdateTaskInput {
    pub status: Option<String>,
    pub progress: Option<i32>,
    pub processed_rows: Option<i64>,
    pub total_rows: Option<i64>,
    pub current_target: Option<String>,
    pub error: Option<String>,
    pub error_details: Option<String>,
    pub output_path: Option<String>,
    pub completed_at: Option<String>,
}
