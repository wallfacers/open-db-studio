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
