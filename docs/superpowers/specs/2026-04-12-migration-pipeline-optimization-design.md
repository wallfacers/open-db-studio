# Migration Pipeline Optimization Design

Date: 2026-04-12

## Problem

Migration of an 8.7GB table (10M rows, 50 columns) requires ~16GB memory and ~308s, vs DataX's 2GB / 180s.

Root causes:
1. All numeric values stringified via `serde_json::Value::String` in `execute()` (8x memory bloat)
2. `fetch_all` holds MySqlRow + Vec<Value> simultaneously (2x peak memory)
3. `write_pause_ms` default 20ms adds ~25s pure sleep per split
4. Row-level channel (10M sends) creates massive scheduling overhead
5. INSERT values string-interpolated (no prepared statement / binary protocol benefit)

## Solution: 4-Layer Optimization

Each layer is independently verifiable and can be tested separately.

### L1: Parameter Adjustment

**Files**: `src-tauri/src/migration/task_mgr.rs`

Changes:
- `write_pause_ms` default: `Some(20)` → `None`
- `write_batch_size` default: keep 2048

No code in pipeline.rs changes — the writer loop already handles `write_pause_ms = None`.

### L2: Batch-Level Channel

**Files**: `src-tauri/src/migration/pipeline.rs`

Current:
```rust
enum ChannelMsg {
    Columns(Vec<String>),
    Row(Row),  // sent 10M times
}
```

Target:
```rust
enum ChannelMsg {
    Columns(Vec<String>),
    Batch(Vec<Row>),  // sent ~5000 times (10M / read_batch_size)
}
```

Reader accumulates `read_batch_size` rows, sends one `ChannelMsg::Batch`.
Writer extends batch rows into `write_buf`, triggers `bulk_write` at `write_batch_size`.

### L3: Upsert Parameterized Queries

**Files**: `src-tauri/src/datasource/mysql.rs`, `src-tauri/src/datasource/bulk_write.rs`

For Upsert path only (LOAD DATA remains for Insert/Replace/Skip):

New method `build_chunk_sql_parameterized()`:
- Generates `INSERT INTO t (a,b) VALUES (?,?),(?,?)` with `?` placeholders
- Uses `sqlx::mysql::MySqlArguments` to bind values via binary protocol
- `MigValue` (from L4) maps directly: `I64(v) → args.add(v)`, `Str(s) → args.add(s.as_str())`

Execution: `sqlx::query_with(sql, args).execute(pool).await`

### L4: MigValue Strongly-Typed Read Path

This is the largest change. Goal: eliminate `serde_json::Value::String` for numeric types.

#### New file: `src-tauri/src/datasource/mig_value.rs`

```rust
/// Migration-optimized value: preserves native types.
/// Avoids serde_json::Value::String bloat (66 bytes per INT vs 8 bytes).
#[derive(Debug, Clone)]
pub enum MigValue {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    Decimal(rust_decimal::Decimal),
    Str(String),
    Bytes(Vec<u8>),
    DateTime(chrono::NaiveDateTime),
    Date(chrono::NaiveDate),
    Time(chrono::NaiveTime),
}
```

Each variant provides:
- `write_tsv(&self, buf: &mut Vec<u8>)` — direct TSV serialization
- `write_sql(&self, buf: &mut String, escape_style: &StringEscapeStyle)` — direct SQL serialization
- `push_to_args(&self, args: &mut MySqlArguments)` — parameterized bind (L3)

#### Trait extension: `src-tauri/src/datasource/mod.rs`

```rust
/// Migration-optimized query: returns strongly-typed rows.
/// Default impl falls back to execute() with conversion.
async fn execute_for_migration(
    &self, sql: &str,
) -> AppResult<(Vec<String>, Vec<Vec<MigValue>>)> {
    // Default: execute() → convert serde_json::Value to MigValue
    let result = self.execute(sql).await?;
    let rows = result.rows.into_iter()
        .map(|r| r.into_iter().map(json_value_to_mig_value).collect())
        .collect();
    Ok((result.columns, rows))
}
```

#### MySQL implementation: `src-tauri/src/datasource/mysql.rs`

```rust
async fn execute_for_migration(&self, sql: &str) -> AppResult<(Vec<String>, Vec<Vec<MigValue>>)> {
    let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
    // Map each column to native MigValue — no String intermediary
    let columns = ...;
    let mig_rows = rows.iter().map(|row| {
        (0..columns.len()).map(|i| {
            // Try i64, u64, f64, Decimal, Bool, NaiveDateTime, etc. directly
            if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
                v.map(MigValue::I64).unwrap_or(MigValue::Null)
            } else if ... { ... }
        }).collect()
    }).collect();
    Ok((columns, mig_rows))
}
```

#### Pipeline reader: `src-tauri/src/migration/pipeline.rs`

Replace `src_ds.execute(&page_sql)` with `src_ds.execute_for_migration(&page_sql)`.
The reader now produces `Vec<Vec<MigValue>>` instead of `Vec<Vec<serde_json::Value>>`.

#### Write path updates: `src-tauri/src/datasource/bulk_write.rs`

- `rows_to_tsv()` accepts `&[Vec<MigValue>]` — `MigValue::write_tsv()` directly formats
- `InsertTemplate::build_chunk_sql()` accepts `&[Vec<MigValue>]` — `MigValue::write_sql()` directly formats
- For parameterized path: `MigValue::push_to_args()` binds natively

#### DataSource trait: `bulk_write` signature

The trait method and all implementations change from `Vec<serde_json::Value>` to `Vec<MigValue>`:

```rust
async fn bulk_write(
    &self,
    table: &str,
    columns: &[String],
    rows: &[Vec<MigValue>],  // was Vec<serde_json::Value>
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
    driver: &str,
) -> AppResult<usize>;
```

All datasource implementations (MySQL, PostgreSQL, SQLite, Oracle, SQL Server, ClickHouse) update their `bulk_write` to accept `MigValue` rows. The `MigValue::write_sql()` and `MigValue::write_tsv()` methods handle serialization.

## Memory Impact Estimate

| Component | Before (serde_json) | After (MigValue) | Reduction |
|---|---|---|---|
| INT column (per value) | ~66 bytes | ~10 bytes (enum + i64) | 6.6x |
| DECIMAL column | ~64 bytes | ~32 bytes (enum + Decimal) | 2x |
| DATETIME column | ~75 bytes | ~44 bytes (enum + NaiveDateTime) | 1.7x |
| Total (50 cols × 10M rows) | ~16 GB | ~3 GB | ~5x |

## Performance Impact Estimate

| Layer | Before | After | Improvement |
|---|---|---|---|
| L1: write_pause | ~25s sleep/split | 0s | -25s |
| L2: channel overhead | 10M sends | ~5000 sends | -99.95% |
| L3: upsert binary proto | text SQL + escape | binary bind | -20~30% |
| L4: memory | 16 GB | ~3 GB | -80% |

## Implementation Order

1. L1 (parameter adjustment) — 1 file, ~2 lines
2. L4 (MigValue + execute_for_migration) — the foundational type change
3. L2 (batch channel) — pipeline.rs reader/writer rework on top of MigValue
4. L3 (upsert parameterized) — uses MigValue::push_to_args

L4 before L2 because the channel and writer need to work with MigValue types.
L3 last because it builds on MigValue's push_to_args.

## Testing Strategy

- **L1**: Integration test with write_pause_ms=None, verify no sleep in logs
- **L4**: Unit tests for MigValue → TSV, MigValue → SQL, MigValue → Args conversions
- **L4**: Integration test comparing memory usage (valgrind/heaptrack) before/after
- **L2**: Unit test for batch channel message flow
- **L3**: Integration test verifying parameterized upsert correctness + comparing speed
