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
    pub created_at: String,
    pub updated_at: String,
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
    pub parent_id: Option<i64>,
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
pub struct SavedQuery {
    pub id: i64,
    pub name: String,
    pub connection_id: Option<i64>,
    pub sql: String,
    pub created_at: String,
}
