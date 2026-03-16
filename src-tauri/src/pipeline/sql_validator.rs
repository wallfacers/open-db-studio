use crate::AppResult;

pub fn validate_sql(sql: &str, driver: &str) -> AppResult<Option<String>> {
    let _ = (sql, driver);
    Ok(None)
}
