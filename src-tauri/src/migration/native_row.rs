//! Native-typed migration rows that avoid serde_json::Value stringification.
//!
//! The standard `DataSource::execute()` converts ALL numeric types to
//! `serde_json::Value::String` to prevent JS Number precision loss. This is
//! correct for the UI-facing API but introduces 5-8x memory overhead for
//! migration (where data never leaves Rust).
//!
//! `MigrationValue` holds native Rust types, reducing per-field memory from
//! ~52 bytes (Value::String) to ~16 bytes (native i64/f64).

use crate::datasource::StringEscapeStyle;
use crate::datasource::utils::escape_string_literal_into;
use std::fmt::Write;
use std::io::Write as IoWrite;

// ── Value types ───────────────────────────────────────────────────────────────

/// Native database value that avoids serde_json::Value stringification.
#[derive(Debug, Clone)]
pub enum MigrationValue {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    /// Exact decimal string representation (preserves trailing zeros).
    Decimal(String),
    Text(String),
    Blob(Vec<u8>),
}

/// A single row from a migration read with native-typed values.
#[derive(Debug, Clone)]
pub struct MigrationRow {
    pub values: Vec<MigrationValue>,
}

// ── MySQL decoder ─────────────────────────────────────────────────────────────

/// Decode a single column from a MySQL row into a MigrationValue.
/// Uses the same try-get cascade as execute(), but preserves native types
/// instead of stringifying numerics.
pub fn decode_mysql_column(
    row: &sqlx::mysql::MySqlRow,
    col_idx: usize,
) -> MigrationValue {
    use sqlx::Row;

    // String types
    if let Ok(val) = row.try_get::<Option<String>, _>(col_idx) {
        return val.map(MigrationValue::Text).unwrap_or(MigrationValue::Null);
    }
    // Date/Time types
    if let Ok(val) = row.try_get::<Option<chrono::NaiveDateTime>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    if let Ok(val) = row.try_get::<Option<chrono::NaiveDate>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    if let Ok(val) = row.try_get::<Option<chrono::NaiveTime>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // Decimal → keep as string (exact representation)
    if let Ok(val) = row.try_get::<Option<rust_decimal::Decimal>, _>(col_idx) {
        return val.map(|v| MigrationValue::Decimal(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // BIGINT UNSIGNED
    if let Ok(val) = row.try_get::<Option<u64>, _>(col_idx) {
        return val.map(MigrationValue::UInt).unwrap_or(MigrationValue::Null);
    }
    // BIGINT SIGNED / INT / SMALLINT / TINYINT
    if let Ok(val) = row.try_get::<Option<i64>, _>(col_idx) {
        return val.map(MigrationValue::Int).unwrap_or(MigrationValue::Null);
    }
    // YEAR (u16)
    if let Ok(val) = row.try_get::<Option<u16>, _>(col_idx) {
        return val.map(|v| MigrationValue::Int(v as i64)).unwrap_or(MigrationValue::Null);
    }
    // FLOAT / DOUBLE
    if let Ok(val) = row.try_get::<Option<f64>, _>(col_idx) {
        return val.map(MigrationValue::Float).unwrap_or(MigrationValue::Null);
    }
    // TINYINT(1) as bool
    if let Ok(val) = row.try_get::<Option<bool>, _>(col_idx) {
        return val.map(MigrationValue::Bool).unwrap_or(MigrationValue::Null);
    }
    // JSON column
    if let Ok(val) = row.try_get::<Option<serde_json::Value>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // BLOB / VARBINARY / BINARY
    if let Ok(val) = row.try_get::<Option<Vec<u8>>, _>(col_idx) {
        return val.map(MigrationValue::Blob).unwrap_or(MigrationValue::Null);
    }
    MigrationValue::Null
}

// ── PostgreSQL decoder ────────────────────────────────────────────────────────

/// Decode a single column from a PostgreSQL row into a MigrationValue.
/// Uses the same try-get cascade as execute(), but preserves native types.
pub fn decode_postgres_column(
    row: &sqlx::postgres::PgRow,
    col_idx: usize,
) -> MigrationValue {
    use sqlx::Row;

    // Integer types (check widest first)
    if let Ok(val) = row.try_get::<Option<i64>, _>(col_idx) {
        return val.map(MigrationValue::Int).unwrap_or(MigrationValue::Null);
    }
    if let Ok(val) = row.try_get::<Option<i32>, _>(col_idx) {
        return val.map(|v| MigrationValue::Int(v as i64)).unwrap_or(MigrationValue::Null);
    }
    if let Ok(val) = row.try_get::<Option<i16>, _>(col_idx) {
        return val.map(|v| MigrationValue::Int(v as i64)).unwrap_or(MigrationValue::Null);
    }
    // Float types
    if let Ok(val) = row.try_get::<Option<f64>, _>(col_idx) {
        return val.map(MigrationValue::Float).unwrap_or(MigrationValue::Null);
    }
    if let Ok(val) = row.try_get::<Option<f32>, _>(col_idx) {
        return val.map(|v| MigrationValue::Float(v as f64)).unwrap_or(MigrationValue::Null);
    }
    // Numeric/Decimal
    if let Ok(val) = row.try_get::<Option<rust_decimal::Decimal>, _>(col_idx) {
        return val.map(|v| MigrationValue::Decimal(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // Bool
    if let Ok(val) = row.try_get::<Option<bool>, _>(col_idx) {
        return val.map(MigrationValue::Bool).unwrap_or(MigrationValue::Null);
    }
    // UUID
    if let Ok(val) = row.try_get::<Option<uuid::Uuid>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // JSON/JSONB
    if let Ok(val) = row.try_get::<Option<serde_json::Value>, _>(col_idx) {
        return val.map(|v| MigrationValue::Text(v.to_string())).unwrap_or(MigrationValue::Null);
    }
    // Bytea
    if let Ok(val) = row.try_get::<Option<Vec<u8>>, _>(col_idx) {
        return val.map(MigrationValue::Blob).unwrap_or(MigrationValue::Null);
    }
    // Text / varchar / bpchar / timestamp / date / time / inet / etc.
    if let Ok(val) = row.try_get::<Option<String>, _>(col_idx) {
        return val.map(MigrationValue::Text).unwrap_or(MigrationValue::Null);
    }
    MigrationValue::Null
}

// ── SQL literal generation ────────────────────────────────────────────────────

impl MigrationValue {
    /// Extract i64 for cursor-based pagination (used by range-split reader).
    pub fn as_i64_for_cursor(&self) -> Option<i64> {
        match self {
            MigrationValue::Int(v) => Some(*v),
            MigrationValue::UInt(v) => (*v).try_into().ok(),
            _ => None,
        }
    }

    /// Write this value as a SQL literal into the buffer.
    pub fn to_sql_literal_into(&self, style: &StringEscapeStyle, buf: &mut String) {
        match self {
            MigrationValue::Null => buf.push_str("NULL"),
            MigrationValue::Bool(b) => buf.push_str(if *b { "1" } else { "0" }),
            MigrationValue::Int(i) => {
                let _ = write!(buf, "{}", i);
            }
            MigrationValue::UInt(u) => {
                let _ = write!(buf, "{}", u);
            }
            MigrationValue::Float(f) => {
                let _ = write!(buf, "{}", f);
            }
            MigrationValue::Decimal(d) => {
                buf.push_str(d);
            }
            MigrationValue::Text(s) => {
                if crate::datasource::utils::is_hex_binary(s) {
                    // Binary data encoded as 0x... or \x... hex
                    let hex_data = &s[2..];
                    match style {
                        StringEscapeStyle::Standard | StringEscapeStyle::SQLiteLiteral => {
                            buf.push_str("X'");
                            buf.push_str(hex_data);
                            buf.push('\'');
                        }
                        StringEscapeStyle::PostgresLiteral => {
                            buf.push_str("E'\\\\x");
                            buf.push_str(hex_data);
                            buf.push('\'');
                        }
                        StringEscapeStyle::TSql => {
                            buf.push_str("0x");
                            buf.push_str(hex_data);
                        }
                    }
                } else {
                    escape_string_literal_into(s, style, buf);
                }
            }
            MigrationValue::Blob(bytes) => {
                let hex = hex::encode(bytes);
                match style {
                    StringEscapeStyle::Standard | StringEscapeStyle::SQLiteLiteral => {
                        buf.push_str("X'");
                        buf.push_str(&hex);
                        buf.push('\'');
                    }
                    StringEscapeStyle::PostgresLiteral => {
                        buf.push_str("E'\\\\x");
                        buf.push_str(&hex);
                        buf.push('\'');
                    }
                    StringEscapeStyle::TSql => {
                        buf.push_str("0x");
                        buf.push_str(&hex);
                    }
                }
            }
        }
    }

    /// Estimate SQL size for `max_bytes_per_tx` chunk sizing.
    pub fn estimated_sql_size(&self) -> usize {
        match self {
            MigrationValue::Null => 4,
            MigrationValue::Bool(_) => 1,
            MigrationValue::Int(_) => 21,   // i64::MIN length
            MigrationValue::UInt(_) => 20,  // u64::MAX length
            MigrationValue::Float(_) => 25,
            MigrationValue::Decimal(d) => d.len(),
            MigrationValue::Text(s) => 3 + s.len() + (s.len() / 16),
            MigrationValue::Blob(b) => 4 + b.len() * 2,  // X'...' with hex encoding
        }
    }

    // ── TSV serialization (MySQL LOAD DATA LOCAL INFILE) ──────────────────────

    /// Write this value in TSV format into the buffer.
    pub fn write_tsv_into(&self, buf: &mut Vec<u8>) {
        match self {
            MigrationValue::Null => buf.extend_from_slice(b"\\N"),
            MigrationValue::Bool(b) => buf.extend_from_slice(if *b { b"1" } else { b"0" }),
            MigrationValue::Int(i) => { let _ = write!(buf, "{}", i); }
            MigrationValue::UInt(u) => { let _ = write!(buf, "{}", u); }
            MigrationValue::Float(f) => { let _ = write!(buf, "{}", f); }
            MigrationValue::Decimal(d) => buf.extend_from_slice(d.as_bytes()),
            MigrationValue::Text(s) => tsv_escape_into(s, buf),
            MigrationValue::Blob(bytes) => {
                // Binary → raw bytes with TSV escaping
                for &b in bytes {
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
        }
    }

    // ── CSV serialization (PostgreSQL COPY FROM STDIN) ───────────────────────

    /// Write this value in CSV format into the buffer (for PostgreSQL COPY).
    pub fn write_csv_into(&self, buf: &mut Vec<u8>) {
        match self {
            MigrationValue::Null => { /* empty field = NULL with FORCE_NULL */ }
            MigrationValue::Bool(b) => buf.extend_from_slice(if *b { b"t" } else { b"f" }),
            MigrationValue::Int(i) => { let _ = write!(buf, "{}", i); }
            MigrationValue::UInt(u) => { let _ = write!(buf, "{}", u); }
            MigrationValue::Float(f) => { let _ = write!(buf, "{}", f); }
            MigrationValue::Decimal(d) => buf.extend_from_slice(d.as_bytes()),
            MigrationValue::Text(s) => csv_escape_into(s, buf),
            MigrationValue::Blob(bytes) => {
                // PostgreSQL COPY expects \x hex format for bytea
                buf.extend_from_slice(b"\\\\x");
                for &b in bytes {
                    let _ = write!(buf, "{:02x}", b);
                }
            }
        }
    }

    /// Convert to serde_json::Value for fallback to existing bulk_write implementations.
    pub fn to_json_value(&self) -> serde_json::Value {
        match self {
            MigrationValue::Null => serde_json::Value::Null,
            MigrationValue::Bool(b) => serde_json::Value::Bool(*b),
            MigrationValue::Int(i) => serde_json::json!(*i),
            MigrationValue::UInt(u) => {
                // Preserve as String for u64 > 2^53 (JS Number safe range)
                if *u > (1u64 << 53) {
                    serde_json::Value::String(u.to_string())
                } else {
                    serde_json::json!(*u)
                }
            }
            MigrationValue::Float(f) => serde_json::json!(*f),
            MigrationValue::Decimal(d) => serde_json::Value::String(d.clone()),
            MigrationValue::Text(s) => serde_json::Value::String(s.clone()),
            MigrationValue::Blob(bytes) => {
                serde_json::Value::String(format!("0x{}", hex::encode(bytes)))
            }
        }
    }
}

// ── TSV/CSV helpers ──────────────────────────────────────────────────────────

/// Escape a string for TSV format (shared with bulk_write.rs).
fn tsv_escape_into(s: &str, buf: &mut Vec<u8>) {
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

/// Escape a string for CSV format (PostgreSQL COPY).
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

// ── Row-level serialization ──────────────────────────────────────────────────

impl MigrationRow {
    /// Serialize a single row to TSV bytes (MySQL LOAD DATA).
    pub fn to_tsv_line(&self, buf: &mut Vec<u8>) {
        for (i, val) in self.values.iter().enumerate() {
            if i > 0 {
                buf.push(b'\t');
            }
            val.write_tsv_into(buf);
        }
        buf.push(b'\n');
    }

    /// Serialize a single row to CSV bytes (PostgreSQL COPY).
    pub fn to_csv_line(&self, buf: &mut Vec<u8>) {
        for (i, val) in self.values.iter().enumerate() {
            if i > 0 {
                buf.push(b',');
            }
            val.write_csv_into(buf);
        }
        buf.push(b'\n');
    }

    /// Convert to a serde_json::Value row.
    pub fn to_json_row(&self) -> Vec<serde_json::Value> {
        self.values.iter().map(|v| v.to_json_value()).collect()
    }
}

/// Serialize multiple MigrationRows into a TSV byte buffer (MySQL LOAD DATA).
pub fn migration_rows_to_tsv(rows: &[MigrationRow]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(rows.len() * 100);
    for row in rows {
        row.to_tsv_line(&mut buf);
    }
    buf
}

/// Serialize multiple MigrationRows into a CSV byte buffer (PostgreSQL COPY).
pub fn migration_rows_to_csv(rows: &[MigrationRow]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(rows.len() * 100);
    for row in rows {
        row.to_csv_line(&mut buf);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_row(values: Vec<MigrationValue>) -> MigrationRow {
        MigrationRow { values }
    }

    // ── TSV serialization tests ─────────────────────────────────────────────

    #[test]
    fn tsv_null() {
        let row = make_row(vec![MigrationValue::Null]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"\\N\n");
    }

    #[test]
    fn tsv_int() {
        let row = make_row(vec![MigrationValue::Int(-42)]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"-42\n");
    }

    #[test]
    fn tsv_uint() {
        let row = make_row(vec![MigrationValue::UInt(12345)]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"12345\n");
    }

    #[test]
    fn tsv_float() {
        let row = make_row(vec![MigrationValue::Float(3.14)]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert!(buf.starts_with(b"3.14"));
    }

    #[test]
    fn tsv_decimal() {
        let row = make_row(vec![MigrationValue::Decimal("10.90".into())]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"10.90\n");
    }

    #[test]
    fn tsv_text_escapes() {
        let row = make_row(vec![MigrationValue::Text("a\tb\nc\\d\0e".into())]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"a\\tb\\nc\\\\d\\0e\n");
    }

    #[test]
    fn tsv_blob() {
        let row = make_row(vec![MigrationValue::Blob(vec![0x00, b'\t', 0xFF])]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"\\0\\t\xff\n");
    }

    #[test]
    fn tsv_multi_column() {
        let row = make_row(vec![MigrationValue::Int(1), MigrationValue::Text("hello".into())]);
        let mut buf = Vec::new();
        row.to_tsv_line(&mut buf);
        assert_eq!(buf, b"1\thello\n");
    }

    #[test]
    fn tsv_batch() {
        let rows = vec![
            make_row(vec![MigrationValue::Int(1), MigrationValue::Null]),
            make_row(vec![MigrationValue::Int(2), MigrationValue::Text("x".into())]),
        ];
        let tsv = migration_rows_to_tsv(&rows);
        assert_eq!(tsv, b"1\t\\N\n2\tx\n");
    }

    // ── CSV serialization tests ─────────────────────────────────────────────

    #[test]
    fn csv_null_empty_field() {
        let row = make_row(vec![MigrationValue::Null]);
        let mut buf = Vec::new();
        row.to_csv_line(&mut buf);
        assert_eq!(buf, b"\n"); // empty field = NULL with FORCE_NULL
    }

    #[test]
    fn csv_text_no_quoting() {
        let row = make_row(vec![MigrationValue::Text("hello".into())]);
        let mut buf = Vec::new();
        row.to_csv_line(&mut buf);
        assert_eq!(buf, b"hello\n");
    }

    #[test]
    fn csv_text_with_comma() {
        let row = make_row(vec![MigrationValue::Text("a,b".into())]);
        let mut buf = Vec::new();
        row.to_csv_line(&mut buf);
        assert_eq!(buf, b"\"a,b\"\n");
    }

    #[test]
    fn csv_blob_hex() {
        let row = make_row(vec![MigrationValue::Blob(vec![0xAB, 0xCD])]);
        let mut buf = Vec::new();
        row.to_csv_line(&mut buf);
        assert_eq!(buf, b"\\\\xabcd\n");
    }

    #[test]
    fn csv_batch() {
        let rows = vec![
            make_row(vec![MigrationValue::Int(1), MigrationValue::Null]),
            make_row(vec![MigrationValue::Int(2), MigrationValue::Text("y".into())]),
        ];
        let csv = migration_rows_to_csv(&rows);
        assert_eq!(csv, b"1,\n2,y\n");
    }

    // ── SQL literal tests ───────────────────────────────────────────────────

    #[test]
    fn sql_literal_int() {
        let v = MigrationValue::Int(-99);
        let mut buf = String::new();
        v.to_sql_literal_into(&StringEscapeStyle::Standard, &mut buf);
        assert_eq!(buf, "-99");
    }

    #[test]
    fn sql_literal_text() {
        let v = MigrationValue::Text("it's a \"test\"".into());
        let mut buf = String::new();
        v.to_sql_literal_into(&StringEscapeStyle::Standard, &mut buf);
        assert!(buf.contains("it\\'s"));
    }

    #[test]
    fn sql_literal_blob() {
        let v = MigrationValue::Blob(vec![0xFF, 0x00]);
        let mut buf = String::new();
        v.to_sql_literal_into(&StringEscapeStyle::Standard, &mut buf);
        assert_eq!(buf, "X'ff00'");
    }

    // ── JSON conversion roundtrip tests ─────────────────────────────────────

    #[test]
    fn to_json_int() {
        let v = MigrationValue::Int(42);
        let j = v.to_json_value();
        assert_eq!(j, serde_json::json!(42));
    }

    #[test]
    fn to_json_large_uint_as_string() {
        let v = MigrationValue::UInt(1u64 << 54); // > 2^53
        let j = v.to_json_value();
        assert!(j.is_string()); // preserves precision
    }

    #[test]
    fn to_json_small_uint_as_number() {
        let v = MigrationValue::UInt(100);
        let j = v.to_json_value();
        assert!(j.is_number());
    }

    #[test]
    fn to_json_blob() {
        let v = MigrationValue::Blob(vec![0xAB]);
        let j = v.to_json_value();
        assert_eq!(j, serde_json::Value::String("0xab".into()));
    }

    #[test]
    fn to_json_decimal() {
        let v = MigrationValue::Decimal("10.90".into());
        let j = v.to_json_value();
        assert_eq!(j, serde_json::Value::String("10.90".into()));
    }

    // ── Size estimation tests ───────────────────────────────────────────────

    #[test]
    fn estimated_sql_size_reasonable() {
        assert_eq!(MigrationValue::Null.estimated_sql_size(), 4);
        assert!(MigrationValue::Int(0).estimated_sql_size() > 0);
        assert!(MigrationValue::Text("hello".into()).estimated_sql_size() >= 8);
    }
}
