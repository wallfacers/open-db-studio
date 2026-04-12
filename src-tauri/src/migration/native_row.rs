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
}
