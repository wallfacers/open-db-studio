use crate::AppResult;
use super::crud::Metric;

pub async fn generate_metric_drafts(connection_id: i64) -> AppResult<Vec<Metric>> {
    let _ = connection_id;
    Ok(vec![])
}
