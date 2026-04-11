# Migration Bulk Write Performance Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-SQL migration writes with per-driver bulk write methods (MySQL LOAD DATA, PG COPY, MSSQL BulkLoad, etc.) and add streaming reads + session tuning, bringing throughput from stuck-at-3M to DataX-level 50K rows/s.

**Architecture:** Add 3 new default methods to the `DataSource` trait (`setup_migration_session`, `teardown_migration_session`, `bulk_write`), override per-driver with optimal bulk strategy. Rewire `pipeline.rs` reader to use streaming `sqlx::query().fetch()`, writer to call `bulk_write`. Universal fallback: optimized multi-row INSERT with pre-allocated string buffer.

**Tech Stack:** Rust, sqlx 0.8, mysql_async (new), tiberius, tokio-gaussdb, rusqlite

**Spec:** `docs/superpowers/specs/2026-04-12-migration-bulk-write-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/Cargo.toml` | Modify | Add `mysql_async` dependency |
| `src-tauri/src/datasource/mod.rs` | Modify:488-511 | Add 3 new trait methods with defaults |
| `src-tauri/src/datasource/bulk_write.rs` | Create | Shared TSV/CSV serialization + optimized INSERT fallback |
| `src-tauri/src/datasource/mysql.rs` | Modify | Add `mig_pool` field, implement session tuning + LOAD DATA + streaming read |
| `src-tauri/src/datasource/postgres.rs` | Modify | Session tuning + COPY FROM STDIN |
| `src-tauri/src/datasource/sqlserver.rs` | Modify | Session tuning + BulkLoadRequest |
| `src-tauri/src/datasource/sqlite.rs` | Modify | Session tuning + prepared batch bind |
| `src-tauri/src/datasource/clickhouse.rs` | Modify | INSERT FORMAT JSONEachRow |
| `src-tauri/src/datasource/gaussdb.rs` | Modify | Session tuning + COPY attempt |
| `src-tauri/src/migration/pipeline.rs` | Modify:986-1342,1546-1867 | Rewire reader to streaming, writer to bulk_write |
| `src-tauri/src/migration/task_mgr.rs` | Modify:129-144 | Update default PipelineConfig values |

---

## Task 1: Add `mysql_async` Dependency

**Files:**
- Modify: `src-tauri/Cargo.toml:42`

- [ ] **Step 1: Add mysql_async to Cargo.toml**

After the `sqlx` entry (line 42), add:

```toml
# MySQL bulk write (LOAD DATA LOCAL INFILE) for migration pipeline
mysql_async = "0.34"
```

- [ ] **Step 2: Verify dependency resolves**

Run: `cd src-tauri && cargo check --message-format=short 2>&1 | head -5`
Expected: No dependency resolution errors (compilation errors from later tasks are fine)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "feat(migration): add mysql_async dependency for LOAD DATA bulk write"
```

---

## Task 2: Add Trait Methods to DataSource

**Files:**
- Modify: `src-tauri/src/datasource/mod.rs:485-511`

- [ ] **Step 1: Add ConflictStrategy import at top of mod.rs**

At the top of mod.rs (imports section), add:

```rust
use crate::migration::task_mgr::ConflictStrategy;
```

- [ ] **Step 2: Add 3 new trait methods before the closing brace of DataSource**

Insert after `execute_paginated` (line 510) and before the trait closing brace (line 511):

```rust
    // ── Migration-specific methods ──────────────────────────────────────────

    /// Set session-level parameters to optimize bulk write throughput.
    /// Called once on the **write-side** datasource before the migration pipeline starts.
    /// Override per driver; default is a no-op.
    async fn setup_migration_session(&self) -> AppResult<()> {
        Ok(())
    }

    /// Restore session-level parameters after migration completes.
    /// Guaranteed to run even if the pipeline fails or is cancelled.
    async fn teardown_migration_session(&self) -> AppResult<()> {
        Ok(())
    }

    /// Bulk write rows to `table` using the most efficient method available for this driver.
    /// Default implementation: optimized multi-row INSERT with pre-allocated string buffer.
    /// Each driver should override this with its native bulk-load mechanism.
    /// Returns the number of rows successfully written.
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        let escape_style = self.string_escape_style();
        let sql = crate::datasource::bulk_write::build_insert_sql_optimized(
            &escape_style, table, columns, rows, conflict_strategy, upsert_keys, driver,
        );
        let result = self.execute(&sql).await?;
        Ok(result.row_count.min(rows.len()))
    }
```

- [ ] **Step 3: Verify compiles (will fail — bulk_write module doesn't exist yet)**

Run: `cd src-tauri && cargo check 2>&1 | head -10`
Expected: Error about `crate::datasource::bulk_write` not found (will be fixed in Task 6)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/datasource/mod.rs
git commit -m "feat(datasource): add migration session tuning and bulk_write trait methods"
```

---

## Task 3: Create bulk_write.rs — Shared Utilities + Optimized INSERT Fallback

**Files:**
- Create: `src-tauri/src/datasource/bulk_write.rs`
- Modify: `src-tauri/src/datasource/mod.rs` (add `pub mod bulk_write;`)

- [ ] **Step 1: Register the module in mod.rs**

In `src-tauri/src/datasource/mod.rs`, at the top where other modules are declared, add:

```rust
pub mod bulk_write;
```

- [ ] **Step 2: Create bulk_write.rs with TSV serialization + optimized INSERT builder**

```rust
//! Shared bulk-write utilities: TSV serialization for LOAD DATA / COPY,
//! and an optimized multi-row INSERT builder used as universal fallback.

use std::fmt::Write as FmtWrite;
use crate::datasource::StringEscapeStyle;
use crate::migration::task_mgr::ConflictStrategy;

type Row = Vec<serde_json::Value>;

// ── TSV serialization (MySQL LOAD DATA / PostgreSQL COPY) ─────────────────

/// Escape a string value for TSV format (tab-separated, used by LOAD DATA and COPY).
/// Escapes: tab → \t, newline → \n, carriage return → \r, backslash → \\, null byte → \0
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
/// - NULL → \N
/// - Bool → 1/0
/// - Number → decimal string (no quotes)
/// - String → TSV-escaped
/// - Hex binary (0x... / \x...) → raw bytes
pub fn row_to_tsv_line(row: &[serde_json::Value], buf: &mut Vec<u8>) {
    for (i, val) in row.iter().enumerate() {
        if i > 0 {
            buf.push(b'\t');
        }
        match val {
            serde_json::Value::Null => buf.extend_from_slice(b"\\N"),
            serde_json::Value::Bool(b) => buf.extend_from_slice(if *b { b"1" } else { b"0" }),
            serde_json::Value::Number(n) => {
                // Write number directly to Vec<u8> without String allocation
                let _ = write!(buf, "{}", n);
            }
            serde_json::Value::String(s) => {
                if is_hex_binary(s) {
                    // LOAD DATA expects raw binary bytes, not hex-encoded strings.
                    let hex_part = if s.starts_with("0x") { &s[2..] } else { &s[2..] }; // both 0x and \x have 2-char prefix
                    if let Ok(bytes) = hex::decode(hex_part) {
                        // Write raw bytes but still escape control chars
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

/// Serialize multiple rows into a TSV byte buffer for LOAD DATA LOCAL INFILE.
/// Returns the buffer and total byte count.
pub fn rows_to_tsv(rows: &[Row]) -> Vec<u8> {
    // Estimate: ~100 bytes per row as starting capacity
    let mut buf = Vec::with_capacity(rows.len() * 100);
    for row in rows {
        row_to_tsv_line(row, &mut buf);
    }
    buf
}

// ── PostgreSQL COPY CSV serialization ─────────────────────────────────────

/// Escape a string value for PostgreSQL COPY CSV format.
/// In CSV mode: fields containing comma/quote/newline are quoted, quotes are doubled.
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
                // PostgreSQL COPY CSV uses empty unquoted field or \N for NULL
                // With CSV FORMAT + FORCE_NULL, empty = NULL
            }
            serde_json::Value::Bool(b) => buf.extend_from_slice(if *b { b"true" } else { b"false" }),
            serde_json::Value::Number(n) => {
                let _ = write!(buf, "{}", n);
            }
            serde_json::Value::String(s) => {
                if is_hex_binary(s) {
                    // PostgreSQL bytea: send as \x hex format
                    let hex_part = if s.starts_with("0x") { &s[2..] } else { &s[2..] };
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
/// This replaces the old `build_insert_sql` in pipeline.rs with 3 key optimizations:
/// 1. Pre-compute capacity and allocate once
/// 2. Write directly to buffer — no intermediate Vec<String> for values or rows
/// 3. Inline byte counting eliminated (caller tracks bytes from row data directly)
pub fn build_insert_sql_optimized(
    escape_style: &StringEscapeStyle,
    table: &str,
    columns: &[String],
    rows: &[Row],
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> String {
    let quote_col: fn(&str) -> String = match driver {
        "mysql" | "doris" | "tidb" | "clickhouse" => |c| format!("`{}`", c.replace('`', "``")),
        "sqlserver" => |c| format!("[{}]", c.replace(']', "]]")),
        _ => |c| format!("\"{}\"", c.replace('"', "\"\"")),
    };

    let key_set: std::collections::HashSet<&str> =
        upsert_keys.iter().map(|s| s.as_str()).collect();

    // Build keyword + suffix based on conflict strategy (same logic as before)
    let (keyword, suffix) = build_conflict_clause(conflict_strategy, driver, columns, &key_set, upsert_keys, &quote_col);

    let col_list = columns.iter().map(|c| quote_col(c)).collect::<Vec<_>>().join(", ");
    let quoted_table = quote_col(table);

    // Pre-allocate: estimate ~80 bytes per value, plus overhead
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
            // Write value directly to sql buffer
            crate::datasource::utils::value_to_sql_safe_into(v, escape_style, &mut sql);
        }
        sql.push(')');
    }

    sql.push_str(&suffix);
    sql
}

/// Build conflict clause — extracted from old build_insert_sql for reuse.
fn build_conflict_clause(
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

fn is_hex_binary(s: &str) -> bool {
    s.len() >= 4
        && (s.starts_with("0x") || s.starts_with("\\x"))
        && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}
```

- [ ] **Step 3: Add `value_to_sql_safe_into` to utils.rs**

In `src-tauri/src/datasource/utils.rs`, add a new function that writes directly to a `String` buffer instead of allocating a new String:

```rust
/// Like `value_to_sql_safe` but writes directly into an existing String buffer
/// to avoid per-value String allocation in the hot path.
pub fn value_to_sql_safe_into(v: &serde_json::Value, style: &StringEscapeStyle, buf: &mut String) {
    match v {
        serde_json::Value::Null => buf.push_str("NULL"),
        serde_json::Value::Bool(b) => buf.push_str(if *b { "1" } else { "0" }),
        serde_json::Value::Number(n) => {
            use std::fmt::Write;
            let _ = write!(buf, "{}", n);
        }
        serde_json::Value::String(s) => {
            if is_hex_binary(s) {
                buf.push_str(&hex_to_binary_literal(s, style));
            } else if is_pure_integer(s) {
                buf.push_str(s);
            } else {
                escape_string_literal_into(s, style, buf);
            }
        }
        _ => {
            let s = v.to_string();
            escape_string_literal_into(&s, style, buf);
        }
    }
}

/// Like `escape_string_literal` but appends directly to an existing String buffer.
fn escape_string_literal_into(s: &str, style: &StringEscapeStyle, buf: &mut String) {
    match style {
        StringEscapeStyle::Standard => {
            buf.push('\'');
            for c in s.chars() {
                match c {
                    '\0' => buf.push_str("\\0"),
                    '\\' => buf.push_str("\\\\"),
                    '\'' => buf.push_str("\\'"),
                    _ => buf.push(c),
                }
            }
            buf.push('\'');
        }
        StringEscapeStyle::PostgresLiteral => {
            if s.contains('\\') || s.contains('\0') {
                buf.push_str("E'");
                for c in s.chars() {
                    match c {
                        '\0' => buf.push_str("\\0"),
                        '\\' => buf.push_str("\\\\"),
                        '\'' => buf.push_str("\\'"),
                        _ => buf.push(c),
                    }
                }
                buf.push('\'');
            } else {
                buf.push('\'');
                for c in s.chars() {
                    match c {
                        '\'' => buf.push_str("''"),
                        _ => buf.push(c),
                    }
                }
                buf.push('\'');
            }
        }
        StringEscapeStyle::TSql | StringEscapeStyle::SQLiteLiteral => {
            buf.push('\'');
            for c in s.chars() {
                match c {
                    '\'' => buf.push_str("''"),
                    _ => buf.push(c),
                }
            }
            buf.push('\'');
        }
    }
}
```

- [ ] **Step 4: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles successfully (or only unrelated warnings)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/datasource/bulk_write.rs src-tauri/src/datasource/mod.rs src-tauri/src/datasource/utils.rs
git commit -m "feat(datasource): add bulk_write utilities — TSV/CSV serialization + optimized INSERT builder"
```

---

## Task 4: MySQL Session Tuning

**Files:**
- Modify: `src-tauri/src/datasource/mysql.rs:42-110`

- [ ] **Step 1: Add `mig_session_active` field to MySqlDataSource**

Change the struct at line 42:

```rust
pub struct MySqlDataSource {
    pool: MySqlPool,
    dialect: Dialect,
    /// Track whether migration session is active (for teardown)
    mig_session_active: std::sync::atomic::AtomicBool,
}
```

- [ ] **Step 2: Update constructor to initialize the new field**

In `new_with_dialect` (line 109), change the return to:

```rust
        Ok(Self { pool, dialect, mig_session_active: std::sync::atomic::AtomicBool::new(false) })
```

- [ ] **Step 3: Implement `setup_migration_session` for MySQL**

In the `impl DataSource for MySqlDataSource` block, add:

```rust
    async fn setup_migration_session(&self) -> AppResult<()> {
        // Acquire a dedicated connection and set session-level optimizations.
        // These settings only affect THIS connection — other pool connections are untouched.
        let mut conn = self.pool.acquire().await?;
        
        // Disable unique index checks — massive speedup for bulk inserts
        sqlx::query("SET unique_checks = 0").execute(&mut *conn).await?;
        // Disable foreign key checks
        sqlx::query("SET foreign_key_checks = 0").execute(&mut *conn).await?;
        
        // Try to disable binlog for this session (requires SUPER or BINLOG_ADMIN privilege).
        // Silently skip if permission denied — this is an optional optimization.
        if let Err(e) = sqlx::query("SET sql_log_bin = 0").execute(&mut *conn).await {
            log::info!("Migration: SET sql_log_bin=0 skipped ({}), binlog will remain active", e);
        }
        
        // Increase bulk insert buffer
        let _ = sqlx::query("SET SESSION bulk_insert_buffer_size = 268435456").execute(&mut *conn).await;
        
        self.mig_session_active.store(true, std::sync::atomic::Ordering::Relaxed);
        log::info!("Migration session optimizations applied (driver={})", 
            match self.dialect { Dialect::MySQL => "mysql", Dialect::Doris => "doris", Dialect::TiDB => "tidb" });
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        if !self.mig_session_active.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let mut conn = self.pool.acquire().await?;
        let _ = sqlx::query("SET unique_checks = 1").execute(&mut *conn).await;
        let _ = sqlx::query("SET foreign_key_checks = 1").execute(&mut *conn).await;
        self.mig_session_active.store(false, std::sync::atomic::Ordering::Relaxed);
        log::info!("Migration session optimizations reverted");
        Ok(())
    }
```

- [ ] **Step 4: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/datasource/mysql.rs
git commit -m "feat(mysql): migration session tuning — disable unique/FK checks, optional binlog off"
```

---

## Task 5: MySQL LOAD DATA LOCAL INFILE Bulk Write

**Files:**
- Modify: `src-tauri/src/datasource/mysql.rs`

- [ ] **Step 1: Add mysql_async pool field and imports**

At the top of `mysql.rs`, add:

```rust
use std::sync::Arc;
use tokio::sync::OnceCell;
```

Update the struct:

```rust
pub struct MySqlDataSource {
    pool: MySqlPool,
    dialect: Dialect,
    mig_session_active: std::sync::atomic::AtomicBool,
    /// Dedicated mysql_async pool for LOAD DATA LOCAL INFILE (migration only).
    /// Initialized lazily on first bulk_write call.
    mig_async_pool: OnceCell<mysql_async::Pool>,
    /// Connection config stored for building mysql_async pool on demand.
    conn_url: String,
}
```

- [ ] **Step 2: Update constructor to build conn_url and initialize mig_async_pool**

In `new_with_dialect`, build the URL and store it:

```rust
        let conn_url = format!(
            "mysql://{}:{}@{}:{}/{}",
            urlencoding::encode(username),
            urlencoding::encode(password),
            host,
            port,
            urlencoding::encode(database),
        );
        Ok(Self {
            pool,
            dialect,
            mig_session_active: std::sync::atomic::AtomicBool::new(false),
            mig_async_pool: OnceCell::new(),
            conn_url,
        })
```

Note: Add `urlencoding = "2"` to Cargo.toml dependencies if not present. Alternatively, hand-build the URL without special chars in user/pass — but urlencoding is safer. Check if it's already a dependency; if not, add it.

- [ ] **Step 3: Add helper to get-or-create mysql_async pool**

```rust
    /// Get or create the mysql_async pool for LOAD DATA operations.
    async fn get_mig_pool(&self) -> AppResult<&mysql_async::Pool> {
        self.mig_async_pool.get_or_try_init(|| async {
            let opts = mysql_async::Opts::from_url(&self.conn_url)
                .map_err(|e| AppError::Datasource(format!("mysql_async URL parse: {}", e)))?;
            let pool_opts = mysql_async::PoolOpts::default()
                .with_constraints(
                    mysql_async::PoolConstraints::new(1, 4).unwrap()
                );
            let opts = mysql_async::OptsBuilder::from_opts(opts)
                .pool_opts(pool_opts)
                .local_infile_handler(Some(mysql_async::LocalInfileHandler::new(|_| {
                    // This is a placeholder — actual data is provided per-query via conn.set_infile_handler()
                    Box::pin(async { Ok(Box::new(std::io::empty()) as Box<dyn std::io::Read + Send>) })
                })));
            Ok(mysql_async::Pool::new(opts))
        }).await
    }
```

- [ ] **Step 4: Implement `bulk_write` for MySQL**

```rust
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        use crate::datasource::bulk_write;
        
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }

        // LOAD DATA doesn't support ON DUPLICATE KEY UPDATE (upsert) — fall back to INSERT
        if matches!(conflict_strategy, ConflictStrategy::Upsert) {
            let escape_style = self.string_escape_style();
            let sql = bulk_write::build_insert_sql_optimized(
                &escape_style, table, columns, rows, conflict_strategy, upsert_keys, driver,
            );
            let result = self.execute(&sql).await?;
            return Ok(result.row_count.min(rows.len()));
        }

        // Try LOAD DATA LOCAL INFILE
        match self.bulk_write_load_data(table, columns, rows, conflict_strategy).await {
            Ok(n) => Ok(n),
            Err(e) => {
                log::warn!("LOAD DATA failed ({}), falling back to optimized INSERT", e);
                let escape_style = self.string_escape_style();
                let sql = bulk_write::build_insert_sql_optimized(
                    &escape_style, table, columns, rows, conflict_strategy, upsert_keys, driver,
                );
                let result = self.execute(&sql).await?;
                Ok(result.row_count.min(rows.len()))
            }
        }
    }
```

- [ ] **Step 5: Implement the LOAD DATA core logic**

```rust
impl MySqlDataSource {
    /// Execute LOAD DATA LOCAL INFILE with in-memory TSV data.
    async fn bulk_write_load_data(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
    ) -> AppResult<usize> {
        use mysql_async::prelude::*;
        use crate::datasource::bulk_write::rows_to_tsv;

        let pool = self.get_mig_pool().await?;
        let mut conn = pool.get_conn().await
            .map_err(|e| AppError::Datasource(format!("mysql_async get_conn: {}", e)))?;

        // Build TSV data in memory
        let tsv_data = rows_to_tsv(rows);
        let tsv_data = Arc::new(tsv_data);

        // Set up local infile handler to serve our in-memory TSV data
        let data_clone = tsv_data.clone();
        conn.set_infile_handler(Some(
            mysql_async::LocalInfileHandler::new(move |_file_name| {
                let data = data_clone.clone();
                Box::pin(async move {
                    Ok(Box::new(std::io::Cursor::new(data.as_ref().clone())) as Box<dyn std::io::Read + Send>)
                })
            })
        ));

        // Build LOAD DATA statement
        let quote = |c: &str| format!("`{}`", c.replace('`', "``"));
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let replace_keyword = match conflict_strategy {
            ConflictStrategy::Replace => " REPLACE",
            ConflictStrategy::Skip => " IGNORE",
            _ => "",
        };

        let load_sql = format!(
            "LOAD DATA LOCAL INFILE 'migration_batch.tsv'{} INTO TABLE {} \
             FIELDS TERMINATED BY '\\t' \
             LINES TERMINATED BY '\\n' \
             ({})",
            replace_keyword,
            quote(table),
            col_list,
        );

        let result = conn.query_drop(&load_sql).await
            .map_err(|e| AppError::Datasource(format!("LOAD DATA: {}", e)))?;

        // Get affected rows from the connection info
        let affected = conn.affected_rows();
        Ok(affected as usize)
    }
}
```

- [ ] **Step 6: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

Note: May need to adjust `mysql_async` API calls based on actual crate version. Fix any type errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/datasource/mysql.rs src-tauri/Cargo.toml
git commit -m "feat(mysql): LOAD DATA LOCAL INFILE bulk write with TSV serialization"
```

---

## Task 6: Rewire Pipeline — Writer Uses `bulk_write`

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs:497-500,986-1342`

This is the most critical pipeline change. The writer task switches from `build_insert_sql + execute` to `dst_ds.bulk_write()`.

- [ ] **Step 1: Add `setup_migration_session` / `teardown_migration_session` calls in `execute_single_mapping`**

In `execute_single_mapping` (pipeline.rs), after `dst_ds` is created (~line 575) and before `auto_create_target_table`, add:

```rust
    // ── Setup migration session on target datasource ─────────────────────
    if let Err(e) = dst_ds.setup_migration_session().await {
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "WARN",
            &format!("[{}] Migration session setup failed: {} (continuing with defaults)", mapping_label, e),
        );
    }
```

And wrap the entire mapping execution in a scope that guarantees teardown:

After the pipeline result is collected (before the final `Ok(format!(...))` return), add:

```rust
    // ── Teardown migration session on target datasource ──────────────────
    if let Err(e) = dst_ds.teardown_migration_session().await {
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "WARN",
            &format!("[{}] Migration session teardown failed: {}", mapping_label, e),
        );
    }
```

- [ ] **Step 2: Simplify the writer task in `run_reader_writer_pair`**

Replace the complex writer logic (lines ~1154-1340) — the transaction batching, write_batch_group, semaphore-controlled spawn — with a simpler loop that calls `bulk_write`:

```rust
    // ── Writer task (bulk_write, semaphore-controlled) ───────────────────
    let ms_writer = mapping_stats.clone();
    let gs_writer = global_stats.clone();
    let app_writer = app.clone();
    let run_id_w = run_id.clone();
    let cancel_w = cancel.clone();
    let label_w = label.clone();
    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let mut error_count = 0usize;
        let mut consecutive_full_fails = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_columns: Vec<String> = Vec::new();

        while let Some(batch) = rx.recv().await {
            if cancel_w.load(Ordering::Relaxed) {
                break;
            }
            if buf_columns.is_empty() {
                buf_columns = mapped_cols.clone().unwrap_or_else(|| batch.column_names.clone());
            }

            for row in batch.rows {
                write_buf.push(row);
                if write_buf.len() >= write_batch_size {
                    let rows_to_write = std::mem::replace(&mut write_buf, Vec::with_capacity(write_batch_size));
                    let batch_len = rows_to_write.len() as u64;

                    // Acquire semaphore to limit concurrent writes
                    let _permit = write_semaphore.clone().acquire_owned().await
                        .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

                    match tokio::time::timeout(
                        tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                        dst_ds.bulk_write(
                            &target_table, &buf_columns, &rows_to_write,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        )
                    ).await {
                        Ok(Ok(n)) => {
                            let ok = n as u64;
                            let fail = batch_len.saturating_sub(ok);
                            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            error_count += fail as usize;
                            if ok == 0 && fail > 0 {
                                consecutive_full_fails += 1;
                            } else {
                                consecutive_full_fails = 0;
                            }
                        }
                        Ok(Err(e)) => {
                            emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                &format!("[{}] bulk_write failed: {}", label_w, e));
                            ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            error_count += batch_len as usize;
                            consecutive_full_fails += 1;
                        }
                        Err(_) => {
                            emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                &format!("[{}] bulk_write timed out after {}s ({} rows failed)",
                                    label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                            ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            error_count += batch_len as usize;
                            consecutive_full_fails += 1;
                        }
                    }

                    // Circuit breaker
                    if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] Circuit breaker: {} consecutive batches fully failed", label_w, consecutive_full_fails));
                        return Err(AppError::Other(format!(
                            "Circuit breaker: {} consecutive write batches fully failed", consecutive_full_fails
                        )));
                    }
                    if error_limit > 0 && error_count >= error_limit {
                        return Err(AppError::Other(format!(
                            "Error limit ({}) exceeded: {} errors", error_limit, error_count
                        )));
                    }
                }
            }
        }

        // Flush remainder
        if !write_buf.is_empty() {
            let batch_len = write_buf.len() as u64;
            let _permit = write_semaphore.clone().acquire_owned().await
                .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
            match dst_ds.bulk_write(
                &target_table, &buf_columns, &write_buf,
                &conflict_strategy, &upsert_keys, &dst_driver,
            ).await {
                Ok(n) => {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    let fail = batch_len.saturating_sub(n as u64);
                    ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                }
                Err(e) => {
                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                        &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                    ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                }
            }
        }

        Ok(())
    });
```

- [ ] **Step 3: Remove the now-unused `transaction_batch_size` and `write_pause_ms` parameters from `run_reader_writer_pair` signature**

Since `bulk_write` handles batching internally, these params are no longer needed. Remove them from the function signature and all call sites.

- [ ] **Step 4: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

Fix any type errors from the signature change.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): rewire pipeline writer to use bulk_write, add session setup/teardown"
```

---

## Task 7: Update PipelineConfig Defaults

**Files:**
- Modify: `src-tauri/src/migration/task_mgr.rs:129-144`

- [ ] **Step 1: Update defaults**

Change the `Default` impl and the default function:

```rust
fn default_transaction_batch_size() -> usize {
    1  // bulk_write handles batching internally; 1 = one bulk_write call per accumulated batch
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            read_batch_size: 5_000,       // was 10_000 — streaming reads don't need large batches
            write_batch_size: 2_048,      // was 1_000 — align with DataX default
            channel_capacity: 32,         // was 16 — larger buffer for throughput
            parallelism: 4,              // was 1 — utilize multi-core + mask I/O latency
            speed_limit_rps: None,
            error_limit: 0,
            shard_count: None,
            transaction_batch_size: 1,   // was 10 — bulk_write is already batched
            write_pause_ms: None,
        }
    }
}
```

- [ ] **Step 2: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/migration/task_mgr.rs
git commit -m "feat(migration): update PipelineConfig defaults — parallelism=4, write_batch=2048"
```

---

## Task 8: PostgreSQL Session Tuning + COPY FROM STDIN

**Files:**
- Modify: `src-tauri/src/datasource/postgres.rs`

- [ ] **Step 1: Add mig_session_active field**

Add `mig_session_active: std::sync::atomic::AtomicBool` to `PostgresDataSource` struct. Initialize as `AtomicBool::new(false)` in constructor.

- [ ] **Step 2: Implement session tuning**

```rust
    async fn setup_migration_session(&self) -> AppResult<()> {
        let mut conn = self.pool.acquire().await?;
        // Disable triggers and FK checks
        let _ = sqlx::query("SET session_replication_role = 'replica'").execute(&mut *conn).await;
        // Async commit — reduces fsync
        let _ = sqlx::query("SET synchronous_commit = 'off'").execute(&mut *conn).await;
        // Increase work_mem for sort/hash operations
        let _ = sqlx::query("SET work_mem = '256MB'").execute(&mut *conn).await;
        self.mig_session_active.store(true, std::sync::atomic::Ordering::Relaxed);
        log::info!("PostgreSQL migration session optimizations applied");
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        if !self.mig_session_active.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let mut conn = self.pool.acquire().await?;
        let _ = sqlx::query("SET session_replication_role = 'origin'").execute(&mut *conn).await;
        let _ = sqlx::query("SET synchronous_commit = 'on'").execute(&mut *conn).await;
        let _ = sqlx::query("RESET work_mem").execute(&mut *conn).await;
        self.mig_session_active.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
```

- [ ] **Step 3: Implement bulk_write with COPY FROM STDIN**

```rust
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        use crate::datasource::bulk_write;
        
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }

        // COPY doesn't support ON CONFLICT — for upsert/skip/replace, use temp table approach
        if !matches!(conflict_strategy, ConflictStrategy::Insert | ConflictStrategy::Overwrite) {
            // For conflict strategies: COPY to temp table, then INSERT ... ON CONFLICT
            return self.bulk_write_via_temp_table(table, columns, rows, conflict_strategy, upsert_keys, driver).await;
        }

        // Direct COPY for simple INSERT
        match self.bulk_write_copy(table, columns, rows).await {
            Ok(n) => Ok(n),
            Err(e) => {
                log::warn!("PostgreSQL COPY failed ({}), falling back to INSERT", e);
                let escape_style = self.string_escape_style();
                let sql = bulk_write::build_insert_sql_optimized(
                    &escape_style, table, columns, rows, conflict_strategy, upsert_keys, driver,
                );
                let result = self.execute(&sql).await?;
                Ok(result.row_count.min(rows.len()))
            }
        }
    }
```

- [ ] **Step 4: Implement COPY core + temp table helper**

```rust
impl PostgresDataSource {
    async fn bulk_write_copy(&self, table: &str, columns: &[String], rows: &[Vec<serde_json::Value>]) -> AppResult<usize> {
        let quote = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let copy_sql = format!("COPY {} ({}) FROM STDIN WITH (FORMAT csv, NULL '')", quote(table), col_list);
        
        let csv_data = crate::datasource::bulk_write::rows_to_csv(rows);
        
        // Use sqlx raw COPY — acquire connection and use the pg-specific copy API
        use sqlx::postgres::PgCopyIn;
        let mut conn = self.pool.acquire().await?;
        let mut copy_in = conn.copy_in_raw(&copy_sql).await
            .map_err(|e| AppError::Datasource(format!("COPY FROM STDIN: {}", e)))?;
        copy_in.send(&csv_data).await
            .map_err(|e| AppError::Datasource(format!("COPY send: {}", e)))?;
        let rows_copied = copy_in.finish().await
            .map_err(|e| AppError::Datasource(format!("COPY finish: {}", e)))?;
        
        Ok(rows_copied as usize)
    }

    async fn bulk_write_via_temp_table(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        let quote = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
        let temp_table = format!("_mig_tmp_{}", uuid::Uuid::new_v4().to_string().replace('-', ""));
        
        // Create temp table with same structure
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let create_sql = format!("CREATE TEMP TABLE {} AS SELECT {} FROM {} WHERE false", quote(&temp_table), col_list, quote(table));
        self.execute(&create_sql).await?;

        // COPY data into temp table
        match self.bulk_write_copy(&temp_table, columns, rows).await {
            Ok(_) => {}
            Err(e) => {
                let _ = self.execute(&format!("DROP TABLE IF EXISTS {}", quote(&temp_table))).await;
                return Err(e);
            }
        }

        // Merge from temp to target with conflict strategy
        let escape_style = self.string_escape_style();
        let (_, suffix) = crate::datasource::bulk_write::build_conflict_clause(
            conflict_strategy, driver, columns,
            &upsert_keys.iter().map(|s| s.as_str()).collect(),
            upsert_keys, &|c: &str| quote(c),
        );
        let merge_sql = format!(
            "INSERT INTO {} ({}) SELECT {} FROM {}{}",
            quote(table), col_list, col_list, quote(&temp_table), suffix
        );
        let result = self.execute(&merge_sql).await?;
        let _ = self.execute(&format!("DROP TABLE IF EXISTS {}", quote(&temp_table))).await;
        
        Ok(result.row_count.min(rows.len()))
    }
}
```

Note: The `copy_in_raw` API may differ in sqlx 0.8. If it doesn't exist, fall back to executing COPY via `\\copy` or using the default `build_insert_sql_optimized` fallback. Check actual sqlx API during implementation and adapt accordingly.

- [ ] **Step 5: Verify compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/datasource/postgres.rs
git commit -m "feat(postgres): COPY FROM STDIN bulk write + session tuning"
```

---

## Task 9: SQL Server BulkLoadRequest

**Files:**
- Modify: `src-tauri/src/datasource/sqlserver.rs`

- [ ] **Step 1: Implement session tuning**

```rust
    async fn setup_migration_session(&self) -> AppResult<()> {
        self.execute("SET NOCOUNT ON").await?;
        Ok(())
    }
```

- [ ] **Step 2: Implement bulk_write using tiberius BulkLoadRequest**

Note: tiberius `bulk_insert` API requires a `Client<TcpStream>` connection. Since our SQL Server driver creates per-query connections, adapt the existing connection pattern. If tiberius bulk API is too complex to wire in, fall back to optimized INSERT with the default `bulk_write` implementation (no override needed).

Check tiberius docs during implementation. If feasible:

```rust
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        driver: &str,
    ) -> AppResult<usize> {
        // For SQL Server, the default optimized INSERT is sufficient for now.
        // tiberius BulkLoadRequest requires careful type mapping per column
        // which we'll implement in a follow-up.
        // The session SET NOCOUNT ON already improves performance.
        let escape_style = self.string_escape_style();
        let sql = crate::datasource::bulk_write::build_insert_sql_optimized(
            &escape_style, table, columns, rows, conflict_strategy, upsert_keys, driver,
        );
        let result = self.execute(&sql).await?;
        Ok(result.row_count.min(rows.len()))
    }
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/datasource/sqlserver.rs
git commit -m "feat(sqlserver): session tuning + optimized INSERT bulk write"
```

---

## Task 10: SQLite Prepared Batch Bind

**Files:**
- Modify: `src-tauri/src/datasource/sqlite.rs`

- [ ] **Step 1: Implement session tuning**

```rust
    async fn setup_migration_session(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA synchronous = OFF; PRAGMA cache_size = -64000;")?;
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA synchronous = FULL; PRAGMA cache_size = -2000;")?;
        Ok(())
    }
```

- [ ] **Step 2: Implement bulk_write with prepared statement**

```rust
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
        _driver: &str,
    ) -> AppResult<usize> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let quote = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let placeholders = (1..=columns.len()).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(", ");

        let keyword = match conflict_strategy {
            ConflictStrategy::Skip => "INSERT OR IGNORE INTO",
            ConflictStrategy::Replace => "INSERT OR REPLACE INTO",
            _ => "INSERT INTO",
        };
        let sql = format!("{} {} ({}) VALUES ({})", keyword, quote(table), col_list, placeholders);

        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(&sql)?;
            for row in rows {
                let params: Vec<rusqlite::types::Value> = row.iter().map(|v| match v {
                    serde_json::Value::Null => rusqlite::types::Value::Null,
                    serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() { rusqlite::types::Value::Integer(i) }
                        else if let Some(f) = n.as_f64() { rusqlite::types::Value::Real(f) }
                        else { rusqlite::types::Value::Text(n.to_string()) }
                    }
                    serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                    other => rusqlite::types::Value::Text(other.to_string()),
                }).collect();
                let params_ref: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                stmt.execute(params_ref.as_slice())?;
            }
        }
        tx.commit()?;
        Ok(rows.len())
    }
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/datasource/sqlite.rs
git commit -m "feat(sqlite): prepared statement batch bind + session tuning for migration"
```

---

## Task 11: ClickHouse INSERT FORMAT JSONEachRow

**Files:**
- Modify: `src-tauri/src/datasource/clickhouse.rs`

- [ ] **Step 1: Implement bulk_write**

```rust
    async fn bulk_write(
        &self,
        table: &str,
        columns: &[String],
        rows: &[Vec<serde_json::Value>],
        _conflict_strategy: &ConflictStrategy,
        _upsert_keys: &[String],
        _driver: &str,
    ) -> AppResult<usize> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        // Build JSONEachRow format: one JSON object per line
        let mut body = String::with_capacity(rows.len() * 200);
        for row in rows {
            let mut obj = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                if let Some(val) = row.get(i) {
                    obj.insert(col.clone(), val.clone());
                }
            }
            body.push_str(&serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default());
            body.push('\n');
        }

        let quote = |c: &str| format!("`{}`", c.replace('`', "``"));
        let col_list = columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
        let insert_sql = format!("INSERT INTO {} ({}) FORMAT JSONEachRow", quote(table), col_list);

        // Send via HTTP POST with body
        // This depends on the ClickHouse HTTP interface implementation in this driver.
        // If the current execute() method supports it, use it.
        // Otherwise, use reqwest directly to POST to the ClickHouse HTTP endpoint.
        let sql_with_data = format!("{}\n{}", insert_sql, body);
        self.execute(&sql_with_data).await?;
        Ok(rows.len())
    }
```

Note: Adapt to the actual ClickHouse driver implementation. The HTTP interface accepts `INSERT ... FORMAT JSONEachRow` followed by data.

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/datasource/clickhouse.rs
git commit -m "feat(clickhouse): INSERT FORMAT JSONEachRow bulk write"
```

---

## Task 12: GaussDB Session Tuning

**Files:**
- Modify: `src-tauri/src/datasource/gaussdb.rs`

- [ ] **Step 1: Implement session tuning (PG-compatible)**

```rust
    async fn setup_migration_session(&self) -> AppResult<()> {
        let _ = self.execute("SET synchronous_commit = 'off'").await;
        let _ = self.execute("SET work_mem = '256MB'").await;
        log::info!("GaussDB migration session optimizations applied");
        Ok(())
    }

    async fn teardown_migration_session(&self) -> AppResult<()> {
        let _ = self.execute("SET synchronous_commit = 'on'").await;
        let _ = self.execute("RESET work_mem").await;
        Ok(())
    }
```

Note: `session_replication_role` may not be available on GaussDB. Test and skip if unsupported.

GaussDB `bulk_write`: use the default optimized INSERT for now. COPY FROM STDIN support depends on `tokio-gaussdb` capabilities — evaluate during implementation.

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/datasource/gaussdb.rs
git commit -m "feat(gaussdb): session tuning for migration"
```

---

## Task 13: Clean Up Old Pipeline Code

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs`

- [ ] **Step 1: Remove `build_insert_sql` from pipeline.rs**

The function at line 1546 is now replaced by `bulk_write::build_insert_sql_optimized`. Delete the old function.

- [ ] **Step 2: Remove `write_batch` and `write_batch_group` from pipeline.rs**

These functions (lines 1696-1867) are now replaced by `bulk_write` in the trait. Delete them.

- [ ] **Step 3: Remove unused imports**

Clean up any imports that are no longer needed after removing the old write functions.

- [ ] **Step 4: Verify compiles and no dead code warnings**

Run: `cd src-tauri && cargo check 2>&1 | grep -E "warning|error" | head -20`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "refactor(migration): remove old build_insert_sql/write_batch — replaced by bulk_write"
```

---

## Task 14: Full Compile Check + Type Check

**Files:** All modified files

- [ ] **Step 1: Rust compile check**

Run: `cd src-tauri && cargo check 2>&1`
Expected: No errors. Fix any remaining issues.

- [ ] **Step 2: Frontend TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors (frontend unchanged, but verify no Tauri invoke signature breaks).

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(migration): resolve compile errors from bulk write integration"
```

---

## Task 15: Manual Performance Test

- [ ] **Step 1: Test MySQL 10M row migration**

Use the same `all_types` table and config as the DataX benchmark:
- Source: `localhost:3306/test_migration` (source DB)
- Target: `localhost:3306/test_migration_target` (target DB)
- Table: `all_types`, 10M rows
- Expected: Complete without hanging, disk usage manageable, speed approaching 30-50K rows/s

- [ ] **Step 2: Compare metrics with DataX baseline**

| Metric | DataX | Our Target |
|--------|-------|-----------|
| Total time | 190s | < 300s |
| Rows/sec | 52,631 | > 30,000 |
| MB/s | 40.52 | > 25 |
| Errors | 0 | 0 |
| Disk 100% | No | No |

- [ ] **Step 3: Document results and adjust if needed**

If targets not met, profile with `cargo flamegraph` to find remaining bottlenecks.
