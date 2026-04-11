//! Shared bulk-write utilities: TSV serialization for LOAD DATA / COPY,
//! and an optimized multi-row INSERT builder used as universal fallback.

use std::io::Write as IoWrite;
use crate::datasource::StringEscapeStyle;
use crate::datasource::utils::is_hex_binary;
use crate::migration::task_mgr::ConflictStrategy;

type Row = Vec<serde_json::Value>;

// ── TSV serialization (MySQL LOAD DATA / PostgreSQL COPY) ─────────────────

/// Escape a string value for TSV format.
pub fn tsv_escape_into(s: &str, buf: &mut Vec<u8>) {
    for b in s.bytes() {
        match b {
            b'\t' => buf.extend_from_slice(b"\\t"),
            b'\n' => buf.extend_from_slice(b"\\n"),
            b'\r' => buf.extend_from_slice(b"\\r"),
            b'\\' => buf.extend_from_slice(b"\\\\"),
            b'\0' => buf.extend_from_slice(b"\\0"),
            _ => buf.push(b),
        }
    }
}

/// Convert a single row to a TSV line (for MySQL LOAD DATA LOCAL INFILE).
pub fn row_to_tsv_line(row: &[serde_json::Value], buf: &mut Vec<u8>) {
    for (i, val) in row.iter().enumerate() {
        if i > 0 {
            buf.push(b'\t');
        }
        match val {
            serde_json::Value::Null => buf.extend_from_slice(b"\\N"),
            serde_json::Value::Bool(b) => buf.extend_from_slice(if *b { b"1" } else { b"0" }),
            serde_json::Value::Number(n) => {
                let _ = write!(buf, "{}", n);
            }
            serde_json::Value::String(s) => {
                if is_hex_binary(s) {
                    let hex_part = &s[2..]; // both 0x and \x have 2-char prefix
                    if let Ok(bytes) = hex::decode(hex_part) {
                        for &b in &bytes {
                            match b {
                                b'\t' => buf.extend_from_slice(b"\\t"),
                                b'\n' => buf.extend_from_slice(b"\\n"),
                                b'\r' => buf.extend_from_slice(b"\\r"),
                                b'\\' => buf.extend_from_slice(b"\\\\"),
                                b'\0' => buf.extend_from_slice(b"\\0"),
                                _ => buf.push(b),
                            }
                        }
                    } else {
                        tsv_escape_into(s, buf);
                    }
                } else {
                    tsv_escape_into(s, buf);
                }
            }
            other => {
                tsv_escape_into(&other.to_string(), buf);
            }
        }
    }
    buf.push(b'\n');
}

/// Serialize multiple rows into a TSV byte buffer.
pub fn rows_to_tsv(rows: &[Row]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(rows.len() * 100);
    for row in rows {
        row_to_tsv_line(row, &mut buf);
    }
    buf
}

// ── PostgreSQL COPY CSV serialization ─────────────────────────────────────

fn csv_escape_into(s: &str, buf: &mut Vec<u8>) {
    let needs_quoting = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if needs_quoting {
        buf.push(b'"');
        for b in s.bytes() {
            if b == b'"' {
                buf.extend_from_slice(b"\"\"");
            } else {
                buf.push(b);
            }
        }
        buf.push(b'"');
    } else {
        buf.extend_from_slice(s.as_bytes());
    }
}

/// Convert a single row to a CSV line (for PostgreSQL COPY FROM STDIN CSV).
pub fn row_to_csv_line(row: &[serde_json::Value], buf: &mut Vec<u8>) {
    for (i, val) in row.iter().enumerate() {
        if i > 0 {
            buf.push(b',');
        }
        match val {
            serde_json::Value::Null => {
                // PostgreSQL COPY CSV: empty unquoted field = NULL with FORCE_NULL
            }
            serde_json::Value::Bool(b) => buf.extend_from_slice(if *b { b"true" } else { b"false" }),
            serde_json::Value::Number(n) => {
                let _ = write!(buf, "{}", n);
            }
            serde_json::Value::String(s) => {
                if is_hex_binary(s) {
                    let hex_part = &s[2..];
                    buf.extend_from_slice(b"\"\\\\x");
                    buf.extend_from_slice(hex_part.as_bytes());
                    buf.push(b'"');
                } else {
                    csv_escape_into(s, buf);
                }
            }
            other => {
                csv_escape_into(&other.to_string(), buf);
            }
        }
    }
    buf.push(b'\n');
}

/// Serialize multiple rows into a CSV byte buffer for PostgreSQL COPY.
pub fn rows_to_csv(rows: &[Row]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(rows.len() * 100);
    for row in rows {
        row_to_csv_line(row, &mut buf);
    }
    buf
}

// ── Optimized multi-row INSERT (universal fallback) ───────────────────────

/// Build a multi-row INSERT statement using a pre-allocated String buffer.
pub fn build_insert_sql_optimized(
    escape_style: &StringEscapeStyle,
    table: &str,
    columns: &[String],
    rows: &[Row],
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> String {
    let quote_col = |c: &str| crate::datasource::utils::quote_identifier_for_driver(c, driver);

    let key_set: std::collections::HashSet<&str> =
        upsert_keys.iter().map(|s| s.as_str()).collect();

    let (keyword, suffix) = build_conflict_clause(conflict_strategy, driver, columns, &key_set, upsert_keys, &quote_col);

    let col_list = columns.iter().map(|c| quote_col(c)).collect::<Vec<_>>().join(", ");
    let quoted_table = quote_col(table);

    let estimated_size = rows.len() * columns.len() * 80 + 200;
    let mut sql = String::with_capacity(estimated_size);

    sql.push_str(keyword);
    sql.push(' ');
    sql.push_str(&quoted_table);
    sql.push_str(" (");
    sql.push_str(&col_list);
    sql.push_str(") VALUES ");

    for (row_idx, row) in rows.iter().enumerate() {
        if row_idx > 0 {
            sql.push_str(", ");
        }
        sql.push('(');
        for (col_idx, v) in row.iter().enumerate() {
            if col_idx > 0 {
                sql.push_str(", ");
            }
            crate::datasource::utils::value_to_sql_safe_into(v, escape_style, &mut sql);
        }
        sql.push(')');
    }

    sql.push_str(&suffix);
    sql
}

/// Build conflict clause — extracted for reuse by drivers (e.g., PostgreSQL temp table merge).
pub fn build_conflict_clause(
    conflict_strategy: &ConflictStrategy,
    driver: &str,
    columns: &[String],
    key_set: &std::collections::HashSet<&str>,
    upsert_keys: &[String],
    quote_col: &dyn Fn(&str) -> String,
) -> (&'static str, String) {
    match (conflict_strategy, driver) {
        (ConflictStrategy::Skip, "sqlite") => ("INSERT OR IGNORE INTO", String::new()),
        (ConflictStrategy::Replace, "sqlite") => ("INSERT OR REPLACE INTO", String::new()),
        (ConflictStrategy::Skip, "mysql" | "doris" | "tidb") => ("INSERT IGNORE INTO", String::new()),
        (ConflictStrategy::Replace, "mysql" | "doris" | "tidb") => ("REPLACE INTO", String::new()),
        (ConflictStrategy::Skip, "postgres" | "gaussdb") => ("INSERT INTO", " ON CONFLICT DO NOTHING".to_string()),
        (ConflictStrategy::Upsert, "mysql" | "doris" | "tidb") => {
            let update_parts: Vec<String> = columns.iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=VALUES({})", quote_col(c), quote_col(c)))
                .collect();
            if update_parts.is_empty() {
                ("INSERT IGNORE INTO", String::new())
            } else {
                ("INSERT INTO", format!(" ON DUPLICATE KEY UPDATE {}", update_parts.join(", ")))
            }
        }
        (ConflictStrategy::Upsert, "postgres" | "gaussdb") => {
            let update_parts: Vec<String> = columns.iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=EXCLUDED.{}", quote_col(c), quote_col(c)))
                .collect();
            if upsert_keys.is_empty() || update_parts.is_empty() {
                ("INSERT INTO", " ON CONFLICT DO NOTHING".to_string())
            } else {
                let key_cols = upsert_keys.iter().map(|k| quote_col(k)).collect::<Vec<_>>().join(", ");
                ("INSERT INTO", format!(" ON CONFLICT ({}) DO UPDATE SET {}", key_cols, update_parts.join(", ")))
            }
        }
        (ConflictStrategy::Upsert, "sqlite") => {
            let update_parts: Vec<String> = columns.iter()
                .filter(|c| !key_set.contains(c.as_str()))
                .map(|c| format!("{}=excluded.{}", quote_col(c), quote_col(c)))
                .collect();
            if upsert_keys.is_empty() || update_parts.is_empty() {
                ("INSERT OR REPLACE INTO", String::new())
            } else {
                let key_cols = upsert_keys.iter().map(|k| quote_col(k)).collect::<Vec<_>>().join(", ");
                ("INSERT INTO", format!(" ON CONFLICT ({}) DO UPDATE SET {}", key_cols, update_parts.join(", ")))
            }
        }
        (ConflictStrategy::Replace, "postgres" | "gaussdb") => {
            if upsert_keys.is_empty() {
                ("INSERT INTO", " ON CONFLICT DO NOTHING".to_string())
            } else {
                let update_parts: Vec<String> = columns.iter()
                    .map(|c| format!("{}=EXCLUDED.{}", quote_col(c), quote_col(c)))
                    .collect();
                let key_cols = upsert_keys.iter().map(|k| quote_col(k)).collect::<Vec<_>>().join(", ");
                ("INSERT INTO", format!(" ON CONFLICT ({}) DO UPDATE SET {}", key_cols, update_parts.join(", ")))
            }
        }
        _ => ("INSERT INTO", String::new()),
    }
}
