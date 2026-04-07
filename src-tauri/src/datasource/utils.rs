use crate::datasource::StringEscapeStyle;

/// 将 serde_json::Value 安全转换为 SQL 字面量字符串。
/// 根据目标驱动的 StringEscapeStyle 选择正确的转义规则，避免 SQL 注入和数据损坏。
pub fn value_to_sql_safe(v: &serde_json::Value, style: &StringEscapeStyle) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => escape_string_literal(s, style),
        _ => escape_string_literal(&v.to_string(), style),
    }
}

fn escape_string_literal(s: &str, style: &StringEscapeStyle) -> String {
    match style {
        StringEscapeStyle::Standard => {
            let escaped = single_pass_escape(s, |c, out| match c {
                '\\' => out.push_str("\\\\"),
                '\'' => out.push_str("\\'"),
                _ => out.push(c),
            });
            format!("'{}'", escaped)
        }
        StringEscapeStyle::PostgresLiteral => {
            if s.contains('\\') {
                let escaped = single_pass_escape(s, |c, out| match c {
                    '\\' => out.push_str("\\\\"),
                    '\'' => out.push_str("\\'"),
                    _ => out.push(c),
                });
                format!("E'{}'", escaped)
            } else {
                let escaped = single_pass_escape(s, |c, out| match c {
                    '\'' => out.push_str("''"),
                    _ => out.push(c),
                });
                format!("'{}'", escaped)
            }
        }
        StringEscapeStyle::TSql | StringEscapeStyle::SQLiteLiteral => {
            let escaped = single_pass_escape(s, |c, out| match c {
                '\'' => out.push_str("''"),
                _ => out.push(c),
            });
            format!("'{}'", escaped)
        }
    }
}

fn single_pass_escape(s: &str, mut escape_char: impl FnMut(char, &mut String)) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        escape_char(c, &mut out);
    }
    out
}

/// 将字节数格式化为人类可读的文件大小字符串。
/// 各数据源驱动共享此函数，避免重复实现。
pub fn format_size(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// 转义 SQL 标识符（用于不支持参数化查询的场景，如 DB2 ODBC）。
/// 使用双引号包裹并转义内部双引号，防止 SQL 注入。
pub fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 去掉 SQL 开头的行注释（--）和块注释（/* */），
/// 返回第一个实际 SQL 关键字开始的内容（用于判断语句类型）。
pub fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if s.starts_with("--") {
            // 跳过到行尾
            match s.find('\n') {
                Some(pos) => s = s[pos + 1..].trim_start(),
                None => return "", // 整条都是注释
            }
        } else if s.starts_with("/*") {
            // 跳过到 */
            match s.find("*/") {
                Some(pos) => s = s[pos + 2..].trim_start(),
                None => return "", // 未闭合的块注释
            }
        } else {
            return s;
        }
    }
}

/// 将可能包含多条语句的 SQL 字符串按分号拆分，正确跳过单引号字符串内的分号。
/// 返回的每个元素均已 trim，空语句被过滤。
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut chars = sql.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_single_quote => {
                in_single_quote = true;
                current.push(c);
            }
            '\'' if in_single_quote => {
                current.push(c);
                // '' 是 SQL 标准的单引号转义，不结束字符串
                if chars.peek() == Some(&'\'') {
                    current.push(chars.next().unwrap());
                } else {
                    in_single_quote = false;
                }
            }
            ';' if !in_single_quote => {
                let stmt = current.trim().to_string();
                if !stmt.is_empty() {
                    statements.push(stmt);
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }

    let remaining = current.trim().to_string();
    if !remaining.is_empty() {
        statements.push(remaining);
    }

    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mysql_backslash_escape() {
        let v = serde_json::Value::String(r"path\to\file".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, r"'path\\to\\file'");
    }

    #[test]
    fn test_mysql_quote_and_backslash() {
        let v = serde_json::Value::String(r"it\'s".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        // \ → \\, ' → \'
        assert_eq!(result, r"'it\\\'s'");
    }

    #[test]
    fn test_pg_no_backslash_uses_standard_quote() {
        let v = serde_json::Value::String("it's a test".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::PostgresLiteral);
        assert_eq!(result, "'it''s a test'");
    }

    #[test]
    fn test_pg_backslash_uses_e_prefix() {
        let v = serde_json::Value::String(r"C:\data".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::PostgresLiteral);
        assert!(result.starts_with("E'"), "Expected E' prefix, got: {}", result);
        assert!(result.contains("\\\\"), "Expected escaped backslash");
    }

    #[test]
    fn test_sqlserver_backslash_not_escaped() {
        let v = serde_json::Value::String(r"it's a \backslash".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::TSql);
        // \ 不转义，' 转义为 ''
        assert_eq!(result, r"'it''s a \backslash'");
    }

    #[test]
    fn test_sqlite_single_quote_escape() {
        let v = serde_json::Value::String("O'Brien".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::SQLiteLiteral);
        assert_eq!(result, "'O''Brien'");
    }

    #[test]
    fn test_null_value() {
        let result = value_to_sql_safe(&serde_json::Value::Null, &StringEscapeStyle::Standard);
        assert_eq!(result, "NULL");
    }

    #[test]
    fn test_bool_values() {
        assert_eq!(value_to_sql_safe(&serde_json::Value::Bool(true), &StringEscapeStyle::Standard), "1");
        assert_eq!(value_to_sql_safe(&serde_json::Value::Bool(false), &StringEscapeStyle::Standard), "0");
    }

    #[test]
    fn test_number_value() {
        let v = serde_json::json!(42);
        assert_eq!(value_to_sql_safe(&v, &StringEscapeStyle::Standard), "42");
    }
}
