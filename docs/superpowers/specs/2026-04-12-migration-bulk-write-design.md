# Migration Bulk Write Performance Optimization

## Problem

Current migration pipeline builds SQL text strings for INSERT, causing:
1. **SQL text explosion** — 800-byte rows expand to ~2400 bytes in SQL, 3M rows = ~7GB SQL text → fills disk (binlog)
2. **No session-level write optimizations** — no UNIQUE_CHECKS=0, no FK_CHECKS=0
3. **Double conversion overhead** — MySQL binary → serde_json::Value → SQL string → MySQL re-parse
4. **fetch_all buffers entire batch** — 10K rows × 800 bytes = 8MB per read call in memory
5. **Massive string allocation in hot path** — N rows × M columns individual String allocations

DataX comparison: 10M rows in 190s (52K rows/s, 40MB/s) vs our implementation stuck at 3M rows with 100% disk.

## Design

### Architecture: Three-Layer Optimization

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Session Tuning (all datasources)               │
│ Set session params before migration, restore after      │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Streaming Reader (all datasources)             │
│ Streaming fetch replaces fetch_all, lower memory peaks  │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Pluggable Bulk Writer (per-driver optimized)   │
│ MySQL: LOAD DATA │ PG: COPY │ MSSQL: BulkLoad │ ...   │
│ Universal fallback: optimized multi-row INSERT          │
└─────────────────────────────────────────────────────────┘
```

### DataSource Trait Changes

Three new methods added to `DataSource` trait, all with default implementations (backward compatible):

```rust
/// Migration session setup (called on write-side connection before migration starts)
async fn setup_migration_session(&self) -> AppResult<()> { Ok(()) }

/// Migration session teardown (restore settings after migration completes)
async fn teardown_migration_session(&self) -> AppResult<()> { Ok(()) }

/// Bulk write rows using the most efficient method available for this driver.
/// Default: optimized multi-row INSERT with pre-allocated buffer.
async fn bulk_write(
    &self,
    table: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    conflict_strategy: &ConflictStrategy,
    upsert_keys: &[String],
) -> AppResult<usize> { /* default impl */ }

/// Streaming read — sends row batches through channel as they're fetched.
/// Default: falls back to execute_paginated.
async fn execute_streaming(
    &self,
    sql: &str,
    batch_size: usize,
    sender: tokio::sync::mpsc::Sender<Vec<Vec<serde_json::Value>>>,
) -> AppResult<u64> { /* default impl */ }
```

### Pipeline Changes

```
Before: Reader → fetch_all → serde_json::Value → channel → build_insert_sql → execute(sql_string)
After:  Reader → execute_streaming → channel → bulk_write(rows)
```

`build_insert_sql` and `write_batch` retained only as fallback path, with optimized string building.

---

## Per-Driver Strategy

### MySQL / TiDB / Doris

**Session tuning:**
```sql
SET unique_checks = 0;
SET foreign_key_checks = 0;
SET sql_log_bin = 0;                              -- optional, requires SUPER, skip on failure
SET SESSION bulk_insert_buffer_size = 268435456;   -- 256MB
SET SESSION max_allowed_packet = 1073741824;       -- 1GB
```

**Bulk write: LOAD DATA LOCAL INFILE** via `mysql_async` crate.
- Dedicated migration write connection (separate from sqlx main pool)
- Each write batch serialized to in-memory TSV (Tab-Separated Values)
- Fed to MySQL through `local_infile_handler` callback
- Bypasses SQL parser entirely, writes directly to storage engine
- Conflict strategy mapping: `LOAD DATA ... REPLACE` / `LOAD DATA ... IGNORE`
- Upsert (ON DUPLICATE KEY UPDATE) not supported by LOAD DATA → auto fallback to optimized INSERT

**Streaming read:** `sqlx::query().fetch()` stream.

**Teardown:**
```sql
SET unique_checks = 1;
SET foreign_key_checks = 1;
```

### PostgreSQL

**Session tuning:**
```sql
SET session_replication_role = 'replica';  -- disable triggers and FK checks
SET synchronous_commit = 'off';           -- async commit, reduce fsync
SET work_mem = '256MB';
```

**Bulk write: COPY FROM STDIN.**
- First check sqlx 0.8 for native `PgCopyIn` support
- If unavailable, evaluate `tokio-postgres` `copy_in` interface
- Data format: CSV
- Conflict strategy: COPY doesn't support ON CONFLICT → COPY to temp table first, then `INSERT INTO target SELECT * FROM tmp ON CONFLICT ...`

**Streaming read:** `sqlx::query().fetch()` stream.

**Teardown:**
```sql
SET session_replication_role = 'origin';
SET synchronous_commit = 'on';
RESET work_mem;
```

### GaussDB

**Session tuning:** Same as PostgreSQL (GaussDB is PG-compatible).

**Bulk write: COPY FROM STDIN** via `tokio-gaussdb` if supported, otherwise fallback to optimized INSERT.

**Streaming read:** Verify `tokio-gaussdb` streaming support; fallback to paginated.

### SQL Server

**Session tuning:**
```sql
SET NOCOUNT ON;
ALTER TABLE <target> NOCHECK CONSTRAINT ALL;
```

**Bulk write: BulkLoadRequest** via tiberius native API.
- `conn.bulk_insert(table)` → row-by-row `send()` → `finalize()` commit
- Fastest SQL Server bulk write (equivalent to bcp utility)

**Streaming read:** `tiberius::Query::query().into_stream()`.

**Teardown:**
```sql
ALTER TABLE <target> CHECK CONSTRAINT ALL;
```

### SQLite

**Session tuning:**
```sql
PRAGMA synchronous = OFF;       -- disable fsync during migration
PRAGMA cache_size = -64000;     -- 64MB cache
```

**Bulk write: Prepared statement batch bind.**
- Compile `INSERT INTO t (c1,c2,...) VALUES (?1,?2,...)` once
- Loop `stmt.execute(params)` binding each row
- Wrapped in single transaction
- rusqlite is already efficient for local writes

**Streaming read:** `stmt.query_map()` iterator wrapped in `spawn_blocking`.

**Teardown:**
```sql
PRAGMA synchronous = FULL;
PRAGMA cache_size = -2000;  -- restore default
```

### ClickHouse

**Session tuning:** None needed (HTTP stateless).

**Bulk write: INSERT FORMAT JSONEachRow.**
- Serialize rows to JSONEachRow format (one JSON object per line)
- Send as HTTP POST body in single request
- ClickHouse is optimized for batch writes natively

**Streaming read:** HTTP streaming response via reqwest.

### Oracle / DB2 (optional features)

**Oracle:** `execute_many()` array bind — batch parameters for prepared statement.
**DB2:** ODBC parameterized batch INSERT.
Lower priority — implement in P2 phase.

---

## Optimized Multi-Row INSERT (Universal Fallback)

All drivers fall back to this when bulk write fails or is unsupported:

1. **Pre-allocate buffer:** `String::with_capacity(rows.len() * estimated_row_bytes)`
2. **Direct write:** Write INSERT prefix once, then for each row write `(val1, val2, ...)` directly to buffer — no intermediate `Vec<String>` collection
3. **Inline byte counting:** Compute transferred bytes during SQL building (remove separate `json_value_len` pass)
4. **Auto-tune batch size:** Based on first-batch average row size, target ~1MB per INSERT statement

---

## Streaming Reader Detail

Each driver implements `execute_streaming` using its native streaming mechanism:

| Driver | Streaming Method |
|--------|-----------------|
| MySQL (sqlx) | `query().fetch()` → async Stream |
| PostgreSQL (sqlx) | `query().fetch()` → async Stream |
| SQL Server (tiberius) | `query().into_stream()` |
| SQLite (rusqlite) | `stmt.query_map()` → spawn_blocking |
| ClickHouse | HTTP streaming response body |
| GaussDB | Verify tokio-gaussdb streaming; fallback to paginated |
| Oracle/DB2 | Row-by-row fetch (already streaming by nature) |

Drivers without streaming support use default implementation (paginated reads via `execute_paginated`).

---

## Pipeline Flow Control

### Dynamic Channel Capacity

```rust
let estimated_row_bytes = first_batch_avg_row_size;
let batch_bytes = estimated_row_bytes * write_batch_size;
let channel_cap = (64 * 1024 * 1024 / batch_bytes).clamp(4, 64);  // target 64MB buffer
```

### Default Parameter Changes

| Parameter | Current | New Default | Rationale |
|-----------|---------|-------------|-----------|
| `read_batch_size` | 10,000 | 5,000 | Streaming reads don't need large batches |
| `write_batch_size` | 1,000 | 2,048 | Align with DataX default |
| `transaction_batch_size` | 10 | 1 | bulk_write is already batched, no need for multi-batch transactions |
| `parallelism` | 1 | 4 | Utilize multi-core + mask I/O latency |
| `channel_cap` | 16 | Dynamic | Adapt to row size |

### Error Recovery (unchanged)

- bulk_write failure → fallback to optimized INSERT
- Optimized INSERT failure → canary + row-by-row retry
- 5 consecutive full failures → circuit breaker abort

---

## New Dependencies

| Crate | Purpose | Impact |
|-------|---------|--------|
| `mysql_async` | MySQL/TiDB/Doris LOAD DATA LOCAL INFILE | Compile +15s, binary +~2MB |

PostgreSQL COPY: first attempt with sqlx 0.8 native support. If insufficient, evaluate adding `tokio-postgres`.

---

## Compatibility

- All new trait methods have default implementations → no breakage for existing drivers
- `mysql_async` used only for migration write path → does not affect main connection pool (sqlx)
- Pipeline parameter defaults only affect new tasks → existing MigrateQL scripts with explicit parameters unchanged
- Fallback chain guarantees availability → graceful degradation when bulk methods fail

---

## Testing Strategy

| Level | Coverage |
|-------|---------|
| Unit tests | Optimized `build_insert_sql` output consistency, TSV/CSV serialization correctness, NULL/binary/escape handling |
| Integration tests | Per-driver `bulk_write` + `execute_streaming` end-to-end |
| Performance benchmark | MySQL 10M rows `all_types` table, target: match DataX 190s / 52K rows/s |
| Regression tests | Existing migration features (incremental sync, conflict strategies, circuit breaker) |
| Boundary tests | NULL values, BLOB/binary columns, extra-wide rows, empty tables, single-row tables |

---

## Implementation Priority

```
P0 (must): MySQL LOAD DATA + session tuning + streaming reads + optimized INSERT fallback
P1 (important): PostgreSQL COPY + SQL Server BulkLoad + SQLite prepared batch bind
P2 (later): ClickHouse FORMAT + GaussDB COPY + Oracle/DB2 batch bind
```
