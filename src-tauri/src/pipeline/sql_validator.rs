use crate::AppResult;

pub fn validate_sql(sql: &str, _driver: &str) -> AppResult<Option<String>> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Ok(Some("SQL 为空".to_string()));
    }
    let open = sql.chars().filter(|&c| c == '(').count();
    let close = sql.chars().filter(|&c| c == ')').count();
    if open != close {
        return Ok(Some(format!("括号不匹配：{} 个左括号，{} 个右括号", open, close)));
    }
    let upper = sql.to_uppercase();
    let valid_starts = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE",
                        "ALTER", "DROP", "WITH", "EXPLAIN"];
    let starts_valid = valid_starts.iter().any(|kw| upper.starts_with(kw));
    if !starts_valid {
        return Ok(Some(format!("SQL 不以有效关键字开头: {}", &sql[..sql.len().min(20)])));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_select_ok() {
        let result = validate_sql("SELECT id FROM users", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_empty_sql_warning() {
        let result = validate_sql("", "mysql");
        assert!(result.is_ok());
        assert!(result.unwrap().is_some());
    }

    #[test]
    fn test_unmatched_parens_warning() {
        let result = validate_sql("SELECT (id FROM users", "mysql");
        assert!(result.unwrap().is_some());
    }
}
