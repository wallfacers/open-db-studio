use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Metric {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMetricInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
}

pub fn list_metrics(connection_id: i64, status: Option<&str>) -> AppResult<Vec<Metric>> {
    let _ = (connection_id, status);
    Ok(vec![])
}

pub fn save_metric(input: &CreateMetricInput) -> AppResult<Metric> {
    let _ = input;
    Err(crate::AppError::Other("not implemented".into()))
}

pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let _ = (id, input);
    Err(crate::AppError::Other("not implemented".into()))
}

pub fn delete_metric(id: i64) -> AppResult<()> {
    let _ = id;
    Ok(())
}

pub fn set_metric_status(id: i64, status: &str) -> AppResult<Metric> {
    let _ = (id, status);
    Err(crate::AppError::Other("not implemented".into()))
}

pub fn search_metrics(connection_id: i64, keywords: &[String]) -> AppResult<Vec<Metric>> {
    let _ = (connection_id, keywords);
    Ok(vec![])
}
