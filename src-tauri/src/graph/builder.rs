use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BuildProgress {
    pub step: String,
    pub done: usize,
    pub total: usize,
}

pub async fn build_schema_graph(
    connection_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<usize> {
    let _ = (connection_id, app_handle);
    Ok(0)
}
