use crate::AppResult;
use super::SqlContext;

pub async fn build_sql_context(
    connection_id: i64,
    entities: &[String],
) -> AppResult<SqlContext> {
    let _ = (connection_id, entities);
    Ok(SqlContext {
        relevant_tables: vec![],
        join_paths: vec![],
        metrics: vec![],
        schema_ddl: String::new(),
    })
}
