use crate::datasource::StringEscapeStyle;

/// 判断字符串是否为十六进制编码的二进制数据。
/// MySQL 读取阶段将非 UTF-8 的二进制转为 "0x<hex>"，PostgreSQL 转为 "\\x<hex>"。
fn is_hex_binary(s: &str) -> bool {
    if s.len() >= 2 && s.starts_with("0x") {
        s[2..].chars().all(|c| c.is_ascii_hexdigit())
    } else if s.len() >= 2 && s.starts_with("\\x") {
        s[2..].chars().all(|c| c.is_ascii_hexdigit())
    } else {
        false
    }
}

/// 将十六进制二进制字符串转为目标驱动正确的 SQL 二进制字面量。
fn hex_to_binary_literal(hex_str: &str, style: &StringEscapeStyle) -> String {
    let hex_data = if hex_str.starts_with("0x") {
        &hex_str[2..]
    } else if hex_str.starts_with("\\x") {
        &hex_str[2..]
    } else {
        return escape_string_literal(hex_str, style);
    };

    match style {
        // MySQL / ClickHouse / TiDB / Doris: 使用 X'<hex>' 语法
        StringEscapeStyle::Standard => {
            format!("X'{}'", hex_data)
        }
        // PostgreSQL: 使用 E'\\x<hex>' 语法
        StringEscapeStyle::PostgresLiteral => {
            format!("E'\\\\x{}'", hex_data)
        }
        // SQL Server: 使用 0x<hex>（无引号）
        StringEscapeStyle::TSql => {
            format!("0x{}", hex_data)
        }
        // SQLite: 使用 X'<hex>' 语法
        StringEscapeStyle::SQLiteLiteral => {
            format!("X'{}'", hex_data)
        }
    }
}

/// 判断字符串是否为可直接作为 SQL 整数字面量写入的纯十进制整数。
/// 条件：全为数字、无前导零（单个 "0" 除外）、长度 ≤ 20（涵盖 u64::MAX）。
///
/// 用途：BIT(n) 列读取后以十进制字符串存储，若带引号写入 MySQL 会按字节串处理，
/// 引发 "Data too long"（如 '255' 为 3 字节 > BIT(8) 的 1 字节上限）。
/// 不带引号的整数字面量则被正确解析为数值。
fn is_pure_integer(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 20
        && s.chars().all(|c| c.is_ascii_digit())
        && (s.len() == 1 || !s.starts_with('0'))
}

/// 将 serde_json::Value 安全转换为 SQL 字面量字符串。
/// 根据目标驱动的 StringEscapeStyle 选择正确的转义规则，避免 SQL 注入和数据损坏。
/// 特殊处理：
///   - "0x<hex>" / "\\x<hex>" 二进制编码 → 目标驱动的二进制字面量（防止 "Data too long"）
///   - 纯十进制整数字符串（BIT/BIGINT 读取结果）→ 不带引号的整数字面量
///     （BIT 列若带引号写入，MySQL 按字节串计算宽度会超出位宽限制）
pub fn value_to_sql_safe(v: &serde_json::Value, style: &StringEscapeStyle) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            if is_hex_binary(s) {
                hex_to_binary_literal(s, style)
            } else if is_pure_integer(s) {
                s.clone()
            } else {
                escape_string_literal(s, style)
            }
        }
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

    #[test]
    fn test_mysql_hex_binary_literal() {
        // MySQL 读取阶段产生的 0x 前缀 hex 字符串应转为 X'<hex>' 语法
        let v = serde_json::Value::String("0x0102030405060708090a0b0c0d0e0f10".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "X'0102030405060708090a0b0c0d0e0f10'");
    }

    #[test]
    fn test_pg_hex_binary_literal() {
        // PostgreSQL 读取阶段产生的 \x 前缀 hex 字符串应转为 E'\\x<hex>' 语法
        let v = serde_json::Value::String("\\x0102030405060708090a0b0c0d0e0f10".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::PostgresLiteral);
        assert_eq!(result, "E'\\\\x0102030405060708090a0b0c0d0e0f10'");
    }

    #[test]
    fn test_sqlite_hex_binary_literal() {
        let v = serde_json::Value::String("0x0102030405060708".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::SQLiteLiteral);
        assert_eq!(result, "X'0102030405060708'");
    }

    #[test]
    fn test_tsql_hex_binary_literal() {
        let v = serde_json::Value::String("0x0102030405060708".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::TSql);
        assert_eq!(result, "0x0102030405060708");
    }

    #[test]
    fn test_non_hex_string_not_converted() {
        // 普通字符串即使以 "0x" 开头但后面不是纯 hex，应作为普通字符串处理
        let v = serde_json::Value::String("0xGGGG".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "'0xGGGG'");
    }

    #[test]
    fn test_short_hex_binary() {
        // 短 hex 也应正确处理
        let v = serde_json::Value::String("0x01".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "X'01'");
    }

    // ── BIT(n) / 纯整数字符串测试 ─────────────────────────────────────────────

    #[test]
    fn test_bit_single_digit_unquoted() {
        // BIT(8) 单位数值：应写为不带引号的整数字面量
        let v = serde_json::Value::String("5".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "5");
    }

    #[test]
    fn test_bit_multi_digit_unquoted() {
        // BIT(8) 多位数值（如 255）：若带引号写入会引发 "Data too long"，应不带引号
        let v = serde_json::Value::String("255".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "255");
    }

    #[test]
    fn test_bigint_large_value_unquoted() {
        // BIGINT UNSIGNED 大值：应写为不带引号的整数字面量
        let v = serde_json::Value::String("18446744073709551615".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "18446744073709551615");
    }

    #[test]
    fn test_leading_zero_string_stays_quoted() {
        // 前导零字符串（如 "007"）不是整数字面量，保留引号以防数据截断
        let v = serde_json::Value::String("007".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "'007'");
    }

    #[test]
    fn test_zero_value_unquoted() {
        // 单个 "0" 应写为不带引号的整数字面量
        let v = serde_json::Value::String("0".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "0");
    }

    #[test]
    fn test_negative_integer_string_stays_quoted() {
        // 负数字符串（含 '-'）不符合纯整数条件，保留引号
        let v = serde_json::Value::String("-123".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "'-123'");
    }

    #[test]
    fn test_decimal_string_stays_quoted() {
        // DECIMAL 值（含 '.'）保留引号
        let v = serde_json::Value::String("10.9000".to_string());
        let result = value_to_sql_safe(&v, &StringEscapeStyle::Standard);
        assert_eq!(result, "'10.9000'");
    }

    #[test]
    fn test_pure_integer_all_drivers() {
        // 纯整数写入对所有驱动均不带引号
        let v = serde_json::Value::String("42".to_string());
        assert_eq!(value_to_sql_safe(&v, &StringEscapeStyle::Standard), "42");
        assert_eq!(value_to_sql_safe(&v, &StringEscapeStyle::PostgresLiteral), "42");
        assert_eq!(value_to_sql_safe(&v, &StringEscapeStyle::TSql), "42");
        assert_eq!(value_to_sql_safe(&v, &StringEscapeStyle::SQLiteLiteral), "42");
    }
}
