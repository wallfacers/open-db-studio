//! Shared bulk-write utilities: TSV serialization for LOAD DATA / COPY,
//! and an optimized multi-row INSERT builder used as universal fallback.

use std::io::Write as IoWrite;
use crate::datasource::StringEscapeStyle;
use crate::datasource::utils::is_hex_binary;
use crate::migration::task_mgr::ConflictStrategy;

type Row = Vec<serde_json::Value>;

// -- TSV serialization (MySQL LOAD DATA LOCAL INFILE) --

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

pub fn csv_escape_into(s: &str, buf: &mut Vec<u8>) {
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

/// Pre-computed INSERT prefix/suffix that is invariant across chunks.
/// Built once per batch, reused for every chunk within that batch.
pub struct InsertTemplate {
    /// "INSERT [IGNORE] INTO `table` (`col1`, `col2`, ...) VALUES "
    pub prefix: String,
    /// Suffix (e.g., " ON DUPLICATE KEY UPDATE ...") — may be empty.
    pub suffix: String,
}

impl InsertTemplate {
    pub fn new(
        table: &str,
        columns: &[String],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> Self {
        use crate::datasource::utils::quote_identifier_for_driver_into;

        let key_set: std::collections::HashSet<&str> =
            upsert_keys.iter().map(|s| s.as_str()).collect();

        let quote_col = |c: &str, buf: &mut String| {
            quote_identifier_for_driver_into(c, driver, buf);
        };

        let (keyword, suffix) = build_conflict_clause(conflict_strategy, driver, columns, &key_set, upsert_keys, &|c: &str| {
            let mut buf = String::new();
            quote_col(c, &mut buf);
            buf
        });

        let mut prefix = String::with_capacity(keyword.len() + table.len() + columns.len() * 32 + 20);
        prefix.push_str(keyword);
        prefix.push(' ');
        quote_identifier_for_driver_into(table, driver, &mut prefix);
        prefix.push_str(" (");
        for (i, col) in columns.iter().enumerate() {
            if i > 0 {
                prefix.push_str(", ");
            }
            quote_identifier_for_driver_into(col, driver, &mut prefix);
        }
        prefix.push_str(") VALUES ");

        Self { prefix, suffix }
    }

    /// Build the full INSERT SQL for a chunk of rows using this template.
    pub fn build_chunk_sql(
        &self,
        rows: &[Row],
        escape_style: &StringEscapeStyle,
        cols: usize,
    ) -> String {
        let estimated_size = self.prefix.len() + rows.len() * cols * 40 + self.suffix.len();
        let mut sql = String::with_capacity(estimated_size);
        sql.push_str(&self.prefix);

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

        sql.push_str(&self.suffix);
        sql
    }
}

/// Build a multi-row INSERT statement using a pre-allocated String buffer.
/// Convenience wrapper for callers that don't need chunk-level reuse.
pub fn build_insert_sql_optimized(
    escape_style: &StringEscapeStyle,
    table: &str,
    columns: &[String],
    rows: &[Row],
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> String {
    let tmpl = InsertTemplate::new(table, columns, conflict_strategy, upsert_keys, driver);
    tmpl.build_chunk_sql(rows, escape_style, columns.len())
}

/// Build multi-row INSERT SQL from native MigrationRows using an InsertTemplate.
/// Shared between MySQL and PostgreSQL to avoid byte-for-byte duplication.
pub fn build_native_chunk_sql(
    tmpl: &InsertTemplate,
    rows: &[crate::migration::native_row::MigrationRow],
    escape_style: &crate::datasource::StringEscapeStyle,
) -> String {
    let num_cols = rows.first().map(|r| r.values.len()).unwrap_or(0);
    let estimated_size = tmpl.prefix.len() + rows.len() * num_cols * 30 + tmpl.suffix.len();
    let mut sql = String::with_capacity(estimated_size);
    sql.push_str(&tmpl.prefix);

    for (row_idx, row) in rows.iter().enumerate() {
        if row_idx > 0 {
            sql.push_str(", ");
        }
        sql.push('(');
        for (col_idx, v) in row.values.iter().enumerate() {
            if col_idx > 0 {
                sql.push_str(", ");
            }
            v.to_sql_literal_into(escape_style, &mut sql);
        }
        sql.push(')');
    }

    sql.push_str(&tmpl.suffix);
    sql
}

/// Estimate the SQL size for a single row (used for chunk pre-computation).
/// Lightweight O(cols) estimation — no SQL string construction, no heap allocations.
/// Uses the more accurate Postgres strategy: actually computes number display length
/// rather than MySQL's fixed 25-byte assumption.
pub fn estimate_row_sql_size(
    row: &[serde_json::Value],
    num_cols: usize,
) -> usize {
    let mut size = num_cols * 3;
    for val in row {
        size += match val {
            serde_json::Value::Null => 4,
            serde_json::Value::Bool(b) => if *b { 4 } else { 5 },
            serde_json::Value::Number(n) => n.to_string().len() + 1,
            serde_json::Value::String(s) => 6 + s.len().min(64),
            _ => 70,
        };
    }
    size
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

// ── Tests ────────────────────────────────────────────────────────────────────
//
// These exercise the multi-row INSERT path that the migration writer hits for
// every non-LOAD-DATA flush. A regression here resurfaces the "1 INSERT per
// row" bug that capped MySQL write throughput at ~3k rows/s.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::native_row::{MigrationRow, MigrationValue};

    fn row(values: Vec<MigrationValue>) -> MigrationRow {
        MigrationRow { values }
    }

    fn cols() -> Vec<String> {
        vec!["id".to_string(), "name".to_string()]
    }

    fn rows() -> Vec<MigrationRow> {
        vec![
            row(vec![MigrationValue::Int(1), MigrationValue::Text("a".into())]),
            row(vec![MigrationValue::Int(2), MigrationValue::Text("b".into())]),
            row(vec![MigrationValue::Int(3), MigrationValue::Text("c".into())]),
        ]
    }

    fn build_for(strategy: ConflictStrategy, driver: &str, upsert_keys: &[String]) -> String {
        let columns = cols();
        let tmpl = InsertTemplate::new("t", &columns, &strategy, upsert_keys, driver);
        build_native_chunk_sql(&tmpl, &rows(), &StringEscapeStyle::Standard)
    }

    /// Default strategy — the user's case: one round-trip flushes all 3 rows.
    #[test]
    fn insert_default_emits_single_multi_row_statement() {
        let sql = build_for(ConflictStrategy::Insert, "mysql", &[]);
        assert!(sql.starts_with("INSERT INTO `t` (`id`, `name`) VALUES "), "sql={}", sql);
        assert!(sql.contains("(1, 'a')"), "missing row 1: {}", sql);
        assert!(sql.contains("(2, 'b')"), "missing row 2: {}", sql);
        assert!(sql.contains("(3, 'c')"), "missing row 3: {}", sql);
        // Exactly one VALUES keyword — proves we did NOT regress to 1 INSERT per row.
        assert_eq!(sql.matches(" VALUES ").count(), 1, "should be a single multi-row INSERT: {}", sql);
        assert!(!sql.contains("ON DUPLICATE KEY UPDATE"), "no upsert clause: {}", sql);
    }

    #[test]
    fn skip_mysql_uses_insert_ignore_multirow() {
        let sql = build_for(ConflictStrategy::Skip, "mysql", &[]);
        assert!(sql.starts_with("INSERT IGNORE INTO `t` (`id`, `name`) VALUES "), "sql={}", sql);
        assert_eq!(sql.matches(" VALUES ").count(), 1);
    }

    #[test]
    fn replace_mysql_uses_replace_into_multirow() {
        let sql = build_for(ConflictStrategy::Replace, "mysql", &[]);
        assert!(sql.starts_with("REPLACE INTO `t` (`id`, `name`) VALUES "), "sql={}", sql);
        assert_eq!(sql.matches(" VALUES ").count(), 1);
    }

    #[test]
    fn upsert_mysql_emits_on_duplicate_key_update() {
        let keys = vec!["id".to_string()];
        let sql = build_for(ConflictStrategy::Upsert, "mysql", &keys);
        assert!(sql.starts_with("INSERT INTO `t` (`id`, `name`) VALUES "), "sql={}", sql);
        assert!(sql.contains(" ON DUPLICATE KEY UPDATE `name`=VALUES(`name`)"), "sql={}", sql);
        // `id` is the conflict key, so it must NOT appear in the UPDATE list.
        assert!(!sql.contains("`id`=VALUES(`id`)"), "key column must not self-update: {}", sql);
    }

    #[test]
    fn skip_postgres_uses_on_conflict_do_nothing() {
        let sql = build_for(ConflictStrategy::Skip, "postgres", &[]);
        assert!(sql.starts_with("INSERT INTO \"t\" (\"id\", \"name\") VALUES "), "sql={}", sql);
        assert!(sql.ends_with(" ON CONFLICT DO NOTHING"), "sql={}", sql);
    }

    #[test]
    fn upsert_postgres_with_keys_emits_on_conflict_do_update() {
        let keys = vec!["id".to_string()];
        let sql = build_for(ConflictStrategy::Upsert, "postgres", &keys);
        assert!(sql.contains(" ON CONFLICT (\"id\") DO UPDATE SET \"name\"=EXCLUDED.\"name\""), "sql={}", sql);
    }

    #[test]
    fn null_values_render_as_sql_null() {
        let columns = cols();
        let tmpl = InsertTemplate::new("t", &columns, &ConflictStrategy::Insert, &[], "mysql");
        let mixed = vec![row(vec![MigrationValue::Int(1), MigrationValue::Null])];
        let sql = build_native_chunk_sql(&tmpl, &mixed, &StringEscapeStyle::Standard);
        assert!(sql.contains("(1, NULL)"), "sql={}", sql);
    }

    #[test]
    fn empty_rows_yields_prefix_only_no_panic() {
        let columns = cols();
        let tmpl = InsertTemplate::new("t", &columns, &ConflictStrategy::Insert, &[], "mysql");
        let sql = build_native_chunk_sql(&tmpl, &[], &StringEscapeStyle::Standard);
        assert_eq!(sql, "INSERT INTO `t` (`id`, `name`) VALUES ");
    }
}
