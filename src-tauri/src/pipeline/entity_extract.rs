use crate::AppResult;

pub async fn extract_entities(question: &str, connection_id: i64) -> AppResult<Vec<String>> {
    let _ = (question, connection_id);
    Ok(vec![])
}
