# Migration Range-Split Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace O(n²) OFFSET-based pagination with DataX/SeaTunnel-style PK range splitting, enabling 10M+ row MySQL→MySQL migrations at O(n) cost.

**Architecture:** Pre-compute `[MIN(pk), MAX(pk)]` via index scan, divide into N non-overlapping pk ranges (splits), each split uses cursor-based inner pagination (`WHERE pk >= cursor AND pk < split_end ORDER BY pk LIMIT batch_size`). For parallel mode, N splits map 1:1 to reader+writer pairs instead of the current MOD sharding. For single mode, one split covers the full table with cursor advancing through all rows.

**Tech Stack:** Rust, tokio async, `serde_json::Value`, existing `DataSource` trait (`execute()` + `execute_paginated()`)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/src/migration/splitter.rs` | **Create** | `PkSplit` struct, `compute_pk_splits()`, `quote_col_for_driver()`, `parse_i64_from_json()` |
| `src-tauri/src/migration/mod.rs` | **Modify** | Add `pub mod splitter;` |
| `src-tauri/src/migration/pipeline.rs` | **Modify** | Cursor reader, range-split parallelism, fix `pending_writes` abort bug |

---

## Task 1: Create `splitter.rs` — PK Range Computation

**Files:**
- Create: `src-tauri/src/migration/splitter.rs`
- Modify: `src-tauri/src/migration/mod.rs`

### Background

DataX splits a table by computing `[MIN(pk), MAX(pk)]` then dividing the pk-value range into N equal segments. Each segment is a bounded SQL condition (`WHERE pk >= start AND pk < end`). Crucially, reads inside each segment use cursor pagination (not OFFSET), so total row scans = O(n).

`PkSplit` represents one such segment. `compute_pk_splits` queries the real database to get min/max, then produces the split list. `quote_col_for_driver` is a helper extracted from the duplicated quoting logic in `write_batch` and `build_shard_query`.

### Step-by-step

- [ ] **Step 1: Write unit tests for `compute_range_splits` (pure logic, no DB)**

Create `src-tauri/src/migration/splitter.rs` with the test module only first:

```rust
use serde_json::Value;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PkSplit {
    /// Inclusive start of pk range.
    pub start: i64,
    /// Exclusive end of pk range. `None` means unbounded (last split).
    pub end: Option<i64>,
}

// ── Pure helper (tested below) ────────────────────────────────────────────────

/// Divide `[min_pk, max_pk]` into at most `split_count` non-overlapping segments.
/// Returns at least 1 split even if split_count == 0.
/// Public so pipeline.rs can call it after getting min/max from the DB.
pub fn compute_range_splits(min_pk: i64, max_pk: i64, split_count: usize) -> Vec<PkSplit> {
    if min_pk > max_pk {
        return vec![];
    }
    let n = split_count.max(1) as i64;
    let range = max_pk - min_pk + 1;
    // ceil division so we don't produce more splits than needed
    let split_size = (range + n - 1) / n;

    let mut splits = Vec::new();
    let mut start = min_pk;
    while start <= max_pk {
        let next = start + split_size;
        let end = if next > max_pk { None } else { Some(next) };
        splits.push(PkSplit { start, end });
        match end {
            None => break,
            Some(e) => start = e,
        }
    }
    splits
}

/// Parse an i64 from a `serde_json::Value` (Number or String).
pub fn parse_i64_from_json(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

/// Quote a column identifier for the given driver.
pub fn quote_col_for_driver(col: &str, driver: &str) -> String {
    match driver {
        "mysql" | "doris" | "tidb" | "clickhouse" => {
            format!("`{}`", col.replace('`', "``"))
        }
        "sqlserver" => format!("[{}]", col.replace(']', "]]")),
        _ => format!("\"{}\"", col.replace('"', "\"\"")),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_single_row_table() {
        let splits = compute_range_splits(42, 42, 4);
        assert_eq!(splits.len(), 1);
        assert_eq!(splits[0], PkSplit { start: 42, end: None });
    }

    #[test]
    fn splits_even_range() {
        // range [0, 99] split into 4 → each covers 25 pk values
        let splits = compute_range_splits(0, 99, 4);
        assert_eq!(splits.len(), 4);
        assert_eq!(splits[0], PkSplit { start: 0,  end: Some(25) });
        assert_eq!(splits[1], PkSplit { start: 25, end: Some(50) });
        assert_eq!(splits[2], PkSplit { start: 50, end: Some(75) });
        assert_eq!(splits[3], PkSplit { start: 75, end: None     });
    }

    #[test]
    fn splits_more_shards_than_range() {
        // range [0, 2] split into 10 → at most 3 splits (1 pk value each)
        let splits = compute_range_splits(0, 2, 10);
        assert_eq!(splits.len(), 3);
        assert_eq!(splits[0], PkSplit { start: 0, end: Some(1) });
        assert_eq!(splits[1], PkSplit { start: 1, end: Some(2) });
        assert_eq!(splits[2], PkSplit { start: 2, end: None    });
    }

    #[test]
    fn splits_negative_pks() {
        let splits = compute_range_splits(-100, -1, 2);
        assert_eq!(splits.len(), 2);
        assert_eq!(splits[0].start, -100);
        assert_eq!(splits[0].end, Some(-50));
        assert_eq!(splits[1].start, -50);
        assert_eq!(splits[1].end, None);
    }

    #[test]
    fn parse_i64_from_various_json_types() {
        assert_eq!(parse_i64_from_json(&Value::from(42_i64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from(42_u64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from(42.9_f64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from("99")), Some(99));
        assert_eq!(parse_i64_from_json(&Value::from(" -5 ")), Some(-5));
        assert_eq!(parse_i64_from_json(&Value::Null), None);
        assert_eq!(parse_i64_from_json(&Value::from("abc")), None);
    }

    #[test]
    fn quote_col_variants() {
        assert_eq!(quote_col_for_driver("id", "mysql"), "`id`");
        assert_eq!(quote_col_for_driver("id", "tidb"), "`id`");
        assert_eq!(quote_col_for_driver("id", "postgres"), "\"id\"");
        assert_eq!(quote_col_for_driver("id", "sqlserver"), "[id]");
        // injection prevention
        assert_eq!(quote_col_for_driver("a`b", "mysql"), "`a``b`");
        assert_eq!(quote_col_for_driver("a]b", "sqlserver"), "[a]]b]");
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd src-tauri && cargo test migration::splitter 2>&1
```

Expected: all 6 tests PASS.

- [ ] **Step 3: Add `pub mod splitter;` to `mod.rs`**

In `src-tauri/src/migration/mod.rs`, add after the existing `pub mod pipeline;` line:

```rust
pub mod splitter;
```

Full file after edit:
```rust
pub mod ddl_convert;
pub mod lang;
pub mod lsp;
pub mod mig_commands;
pub mod pipeline;
pub mod precheck;
pub mod repository;
pub mod splitter;
pub mod task_mgr;

pub use task_mgr::{MigrationJob, MigrationJobConfig};
```

- [ ] **Step 4: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`.

- [ ] **Step 5: Commit**

```bash
cd /home/wallfacers/project/open-db-studio
git add src-tauri/src/migration/splitter.rs src-tauri/src/migration/mod.rs
git commit -m "feat(migration): add splitter module with PK range split computation"
```

---

## Task 2: Add `compute_pk_splits` — DB-Backed Split Computation

**Files:**
- Modify: `src-tauri/src/migration/splitter.rs`

### Background

`compute_range_splits` (Task 1) is pure logic. This task adds `compute_pk_splits`, which actually queries the database to get `MIN(pk)` and `MAX(pk)`, then delegates to `compute_range_splits`. It returns `None` when the DB query fails or the table is empty, so callers fall back to OFFSET pagination.

The MIN/MAX query is O(log n) via B-tree index — effectively free for any table size.

- [ ] **Step 1: Add `compute_pk_splits` to `splitter.rs`**

Append after the `quote_col_for_driver` function (before `#[cfg(test)]`):

```rust
use crate::datasource::DataSource;

/// Query MIN and MAX of `pk_col` over `source_query`, then return PK range splits.
///
/// Returns `None` when:
/// - The MIN/MAX query fails (e.g. no index, permission denied)
/// - The table is empty (MIN/MAX returns NULL)
/// - `pk_col` cannot be parsed as i64
///
/// `split_count` controls how many splits to produce. Pass `parallelism` for
/// parallel mode or `1` for single-reader cursor mode (one split = full table).
pub async fn compute_pk_splits(
    ds: &dyn DataSource,
    source_query: &str,
    pk_col: &str,
    driver: &str,
    split_count: usize,
) -> Option<Vec<PkSplit>> {
    let pk_q = quote_col_for_driver(pk_col, driver);
    let sql = format!(
        "SELECT MIN({pk}), MAX({pk}) FROM ({src}) AS _mig_minmax_",
        pk = pk_q,
        src = source_query,
    );
    let result = ds.execute(&sql).await.ok()?;
    let row = result.rows.first()?;
    let min_val = parse_i64_from_json(row.first()?)?;
    let max_val = parse_i64_from_json(row.get(1)?)?;
    if min_val > max_val {
        return None;
    }
    let splits = compute_range_splits(min_val, max_val, split_count);
    if splits.is_empty() { None } else { Some(splits) }
}
```

Also add the `use` import at the top of the file (before `use serde_json::Value;`):

```rust
use crate::datasource::DataSource;
use serde_json::Value;
```

- [ ] **Step 2: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/migration/splitter.rs
git commit -m "feat(migration): add compute_pk_splits with MIN/MAX DB query"
```

---

## Task 3: Fix `pending_writes` Abort Bug in Writer Loop

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs` (lines ~904–1071)

### Background

**Current bug:** After the reader channel closes, the writer loop calls `handle.abort()` on every in-flight write task (`pending_writes`). Aborted tasks never send their `(ok, fail)` result via `result_tx`, so the final row counts are wrong and some writes are silently lost.

**Why `pending_writes` exists at all:** The code tracks handles only to abort them. The `result_rx` channel naturally drains when all `result_tx` clones are dropped (each spawned task holds one clone and drops it on completion). Once we `drop(result_tx)` and `await result_rx.recv()` in a loop, it automatically waits for every in-flight write task to finish.

**Fix:** Delete `pending_writes` entirely. The semaphore already limits concurrency. Result collection already works via the channel.

- [ ] **Step 1: Remove `pending_writes` declaration and all usages**

In `run_reader_writer_pair`, the writer task (starts at `let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {`):

**Delete** line:
```rust
let mut pending_writes: Vec<tokio::task::JoinHandle<()>> = Vec::new();
```

**Delete** line:
```rust
pending_writes.push(handle);
```

**Replace** the abort block (currently after the flush remainder section):
```rust
// Abort any in-flight write tasks that are still holding connections.
for handle in pending_writes.drain(..) {
    handle.abort();
}
```
with nothing (delete it entirely).

The `drop(result_tx)` and the `while let Some(...)` drain loop that follow are **correct and must be kept**:
```rust
drop(result_tx);
while let Some((ok, fail)) = result_rx.recv().await {
    ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
    gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
    ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
    gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
    error_count += fail as usize;
}
```

The full writer task after the edit (the relevant section at the end of `while let Some(batch) = rx.recv().await` and after):

```rust
        // Flush remainder
        if !write_buf.is_empty() {
            let _permit = semaphore.clone().acquire_owned().await
                .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;
            match write_batch(
                &*dst_ds, &target_table, &buf_columns, &write_buf,
                &conflict_strategy, &upsert_keys, &dst_driver,
            ).await {
                Ok(n) => {
                    ms_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    emit_log(&app_writer, job_id, &run_id_w, "WARN",
                        &format!("[{}] Final flush failed ({}), retrying row-by-row…", label_w, e));
                    let mut row_ok = 0u64;
                    let mut row_fail = 0u64;
                    for single_row in &write_buf {
                        match write_batch(
                            &*dst_ds, &target_table, &buf_columns,
                            std::slice::from_ref(single_row),
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => row_ok += n as u64,
                            Err(e) => {
                                emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                    &format!("[{}] Row write failed: {}", label_w, e));
                                row_fail += 1;
                            }
                        }
                    }
                    ms_writer.rows_written.fetch_add(row_ok, Ordering::Relaxed);
                    gs_writer.rows_written.fetch_add(row_ok, Ordering::Relaxed);
                    ms_writer.rows_failed.fetch_add(row_fail, Ordering::Relaxed);
                    gs_writer.rows_failed.fetch_add(row_fail, Ordering::Relaxed);
                    error_count += row_fail as usize;
                    if row_fail > 0 {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] Final flush row-by-row: {} succeeded, {} failed", label_w, row_ok, row_fail));
                    }
                }
            }
        }

        // Wait for all in-flight write tasks to complete and collect their results.
        // Dropping result_tx signals to result_rx that no more senders exist;
        // result_rx.recv() returns None once all spawned tasks have finished and
        // sent their (ok, fail) tuples.
        drop(result_tx);
        while let Some((ok, fail)) = result_rx.recv().await {
            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
            error_count += fail as usize;
        }

        // Final error limit check (covers flush remainder + all pending writes)
        if error_limit > 0 && error_count >= error_limit {
            return Err(AppError::Other(format!(
                "Error limit ({}) exceeded: {} errors", error_limit, error_count
            )));
        }

        Ok(())
    });
```

- [ ] **Step 2: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "fix(migration): remove pending_writes abort — was silently dropping in-flight writes"
```

---

## Task 4: Cursor-Based Reader Inside `run_reader_writer_pair`

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs`

### Background

The reader task currently uses `execute_paginated` (OFFSET-based, O(n²)). We replace it with a cursor reader when a `PkSplit` is provided. When no split is given, we keep the OFFSET fallback for tables without an integer PK.

The cursor reader:
1. Starts cursor at `split.start`
2. Executes: `SELECT * FROM (source) AS _mig_s_ WHERE pk >= cursor [AND pk < split.end] ORDER BY pk LIMIT batch_size`
3. Extracts the last PK value from the result to advance the cursor
4. Stops when result is empty or `< batch_size` (last page of the split)

**Column index for PK:** The result from a cursor query contains all columns in `page.columns`. We find the PK column index once after the first page (the column list is stable across pages).

- [ ] **Step 1: Add `pk_split` parameter to `run_reader_writer_pair` signature**

Change the function signature from:

```rust
async fn run_reader_writer_pair(
    source_query: String,
    src_ds: Arc<dyn crate::datasource::DataSource>,
    dst_ds: Arc<dyn crate::datasource::DataSource>,
    target_table: String,
    dst_driver: String,
    mapped_cols: Option<Vec<String>>,
    conflict_strategy: ConflictStrategy,
    upsert_keys: Vec<String>,
    read_batch_size: usize,
    write_batch_size: usize,
    channel_cap: usize,
    error_limit: usize,
    writer_parallelism: usize,
    cancel: Arc<AtomicBool>,
    mapping_stats: Arc<PipelineStats>,
    global_stats: Arc<PipelineStats>,
    app: AppHandle,
    job_id: i64,
    run_id: String,
    label: String,
) -> AppResult<()> {
```

to:

```rust
async fn run_reader_writer_pair(
    source_query: String,
    pk_split: Option<(String, crate::migration::splitter::PkSplit)>, // (pk_col, split)
    src_driver: String,
    src_ds: Arc<dyn crate::datasource::DataSource>,
    dst_ds: Arc<dyn crate::datasource::DataSource>,
    target_table: String,
    dst_driver: String,
    mapped_cols: Option<Vec<String>>,
    conflict_strategy: ConflictStrategy,
    upsert_keys: Vec<String>,
    read_batch_size: usize,
    write_batch_size: usize,
    channel_cap: usize,
    error_limit: usize,
    writer_parallelism: usize,
    cancel: Arc<AtomicBool>,
    mapping_stats: Arc<PipelineStats>,
    global_stats: Arc<PipelineStats>,
    app: AppHandle,
    job_id: i64,
    run_id: String,
    label: String,
) -> AppResult<()> {
```

- [ ] **Step 2: Replace the reader task body**

The current reader task body (inside `let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move { ... });`) is:

```rust
let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
    let mut offset = 0usize;
    let mut columns_opt: Option<Vec<String>> = None;
    loop {
        if cancel_r.load(Ordering::Relaxed) {
            break;
        }
        let page = src_ds.execute_paginated(&source_query, read_batch_size, offset).await?;
        if page.rows.is_empty() {
            break;
        }
        let fetched = page.rows.len();
        if columns_opt.is_none() {
            columns_opt = Some(page.columns.clone());
        }
        for row in &page.rows {
            let row_bytes: u64 = row.iter().map(json_value_len).sum();
            ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
            gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
        }
        ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
        gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
        let batch = Batch {
            rows: page.rows,
            column_names: columns_opt.as_ref().unwrap().clone(),
        };
        if tx.send(batch).await.is_err() {
            break;
        }
        if fetched < read_batch_size {
            break;
        }
        offset += fetched;
    }
    Ok(())
});
```

Replace the entire reader task with:

```rust
let reader_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
    use crate::migration::splitter::{parse_i64_from_json, quote_col_for_driver};

    if let Some((pk_col, split)) = pk_split {
        // ── Cursor-based split reader (O(n)) ──────────────────────────────
        // Executes: SELECT * FROM (source) AS _s_
        //           WHERE pk >= cursor [AND pk < split.end]
        //           ORDER BY pk LIMIT batch_size
        let pk_q = quote_col_for_driver(&pk_col, &src_driver);
        let mut cursor = split.start;
        let mut pk_col_idx: Option<usize> = None;
        let mut columns_opt: Option<Vec<String>> = None;

        loop {
            if cancel_r.load(Ordering::Relaxed) {
                break;
            }
            let range_cond = match split.end {
                Some(end) => format!("{pk} >= {cursor} AND {pk} < {end}", pk = pk_q, cursor = cursor, end = end),
                None      => format!("{pk} >= {cursor}", pk = pk_q, cursor = cursor),
            };
            let page_sql = format!(
                "SELECT * FROM ({src}) AS _mig_s_ WHERE {cond} ORDER BY {pk} LIMIT {limit}",
                src = source_query, cond = range_cond, pk = pk_q, limit = read_batch_size,
            );
            let page = src_ds.execute(&page_sql).await?;
            if page.rows.is_empty() {
                break;
            }
            let fetched = page.rows.len();

            // Resolve column list and pk column index on first page.
            if columns_opt.is_none() {
                pk_col_idx = page.columns.iter().position(|c| c.eq_ignore_ascii_case(&pk_col));
                columns_opt = Some(page.columns.clone());
            }

            // Advance cursor past the last seen PK value.
            let last_pk = page.rows.last()
                .and_then(|r| pk_col_idx.and_then(|i| r.get(i)))
                .and_then(parse_i64_from_json)
                .unwrap_or(i64::MAX);
            cursor = last_pk.saturating_add(1);

            for row in &page.rows {
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
            }
            ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);

            let batch = Batch {
                rows: page.rows,
                column_names: columns_opt.as_ref().unwrap().clone(),
            };
            if tx.send(batch).await.is_err() {
                break;
            }
            if fetched < read_batch_size {
                break; // Last page of this split — done.
            }
        }
    } else {
        // ── Fallback: OFFSET-based reader (tables without integer PK) ────
        let mut offset = 0usize;
        let mut columns_opt: Option<Vec<String>> = None;
        loop {
            if cancel_r.load(Ordering::Relaxed) {
                break;
            }
            let page = src_ds.execute_paginated(&source_query, read_batch_size, offset).await?;
            if page.rows.is_empty() {
                break;
            }
            let fetched = page.rows.len();
            if columns_opt.is_none() {
                columns_opt = Some(page.columns.clone());
            }
            for row in &page.rows {
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                ms_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
                gs_reader.bytes_transferred.fetch_add(row_bytes, Ordering::Relaxed);
            }
            ms_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            gs_reader.rows_read.fetch_add(fetched as u64, Ordering::Relaxed);
            let batch = Batch {
                rows: page.rows,
                column_names: columns_opt.as_ref().unwrap().clone(),
            };
            if tx.send(batch).await.is_err() {
                break;
            }
            if fetched < read_batch_size {
                break;
            }
            offset += fetched;
        }
    }
    Ok(())
});
```

- [ ] **Step 3: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: compile errors because call sites of `run_reader_writer_pair` don't pass the new params yet. Note the call sites — they will be fixed in Task 5 and 6. For now, check that the function body itself is syntactically correct by fixing the call site temporarily:

The two call sites are in `execute_single_mapping`:
1. Shard mode: inside `tokio::spawn(run_reader_writer_pair(...))` (line ~700)
2. Single mode: direct `run_reader_writer_pair(...)` call (line ~745)

Add `None, src_cfg.driver.clone(),` as the second and third args after `source_query` / `shard_query` in both call sites temporarily:

```rust
// temporary — will be replaced in Task 5 and 6
handle = tokio::spawn(run_reader_writer_pair(
    shard_query,
    None,                    // pk_split: will be range split in Task 6
    src_cfg.driver.clone(),  // src_driver
    src_ds.clone(),
    // ... rest unchanged
));
```

```rust
// temporary — will be replaced in Task 5
run_reader_writer_pair(
    source_query,
    None,                    // pk_split: will be cursor split in Task 5
    src_cfg.driver.clone(),  // src_driver
    src_ds,
    // ... rest unchanged
).await
```

After fixing, cargo check must pass:

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): add cursor-based split reader to run_reader_writer_pair"
```

---

## Task 5: Wire Single-Mode to Cursor Reading

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs` (inside `execute_single_mapping`, the `else` branch that calls `run_reader_writer_pair` directly)

### Background

When `parallelism == 1` and no shard PK is found (current `else` branch), the pipeline calls `run_reader_writer_pair` with OFFSET. This task changes it to:
1. Detect integer PK (same `detect_integer_pk` function)
2. Query MIN/MAX to get the full table range as a single split: `PkSplit { start: min, end: None }`  
3. Pass the split + pk_col to `run_reader_writer_pair`
4. Fall back to OFFSET (pass `None`) if no integer PK or MIN/MAX fails

The result: for any table with an integer PK, single-mode reads now use the cursor reader. For tables with composite or non-integer PKs, OFFSET is the fallback with a logged warning.

- [ ] **Step 1: Replace the single-mode call site**

Locate the `else` branch in `execute_single_mapping` that begins:

```rust
    } else {
        // ── Semaphore Mode: 1 reader + N concurrent writers ──────────────
        if parallelism > 1 {
            logs.lock().unwrap().emit_and_record(...)
        }
        run_reader_writer_pair(
            source_query,
            src_ds,
            dst_ds,
            ...
        ).await
    };
```

Replace it with:

```rust
    } else {
        // ── Single reader (parallelism == 1 or no integer PK found) ─────
        //
        // Attempt cursor-based reading (O(n)) via PK range split.
        // Falls back to OFFSET if no integer PK is detected.
        let pk_cursor = if let Some(pk_col) = detect_integer_pk_from_ds(&*src_ds, &mapping.source_table).await {
            match crate::migration::splitter::compute_pk_splits(
                &*src_ds, &source_query, &pk_col, &src_cfg.driver, 1,
            ).await {
                Some(splits) => {
                    // 1 split = full table range; cursor reader handles all pages
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "SYSTEM",
                        &format!("[{}] Cursor mode on '{}': range [{}, {})",
                            mapping_label, pk_col,
                            splits[0].start,
                            splits[0].end.map(|e| e.to_string()).unwrap_or_else(|| "∞".into())),
                    );
                    Some((pk_col, splits.into_iter().next().unwrap()))
                }
                None => {
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "WARN",
                        &format!("[{}] MIN/MAX query failed; falling back to OFFSET pagination", mapping_label),
                    );
                    None
                }
            }
        } else {
            logs.lock().unwrap().emit_and_record(
                app, job_id, run_id, "WARN",
                &format!("[{}] No integer PK found; using OFFSET pagination (may be slow for large tables)", mapping_label),
            );
            None
        };

        run_reader_writer_pair(
            source_query,
            pk_cursor,
            src_cfg.driver.clone(),
            src_ds,
            dst_ds,
            target_table.clone(),
            dst_driver.clone(),
            mapped_cols,
            conflict_strategy.clone(),
            upsert_keys.clone(),
            read_batch_size,
            write_batch_size,
            channel_cap,
            error_limit,
            parallelism,
            cancel.clone(),
            mapping_stats.clone(),
            global_stats.clone(),
            app.clone(),
            job_id,
            run_id.to_string(),
            mapping_label.clone(),
        ).await
    };
```

- [ ] **Step 2: Add `detect_integer_pk_from_ds` helper**

The current `detect_integer_pk(columns)` is a pure function operating on pre-fetched columns. We need an async wrapper that fetches columns from the datasource. Add this function after `detect_integer_pk`:

```rust
/// Fetch columns for `table` from `ds` and return the integer PK column name, if any.
async fn detect_integer_pk_from_ds(
    ds: &dyn crate::datasource::DataSource,
    table: &str,
) -> Option<String> {
    ds.get_columns(table, None).await.ok().as_deref().and_then(detect_integer_pk)
}
```

- [ ] **Step 3: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): single-mode uses cursor reader when integer PK available"
```

---

## Task 6: Replace MOD Sharding with Range Splits in Parallel Mode

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs` (inside `execute_single_mapping`, the `if let Some(pk_col) = shard_pk` block)

### Background

The current parallel mode uses `MOD(pk, N) = shard_id` to split work across N readers. Each shard still uses OFFSET within its rows → still O(n²) per shard.

DataX/SeaTunnel use range splits instead: `[min, max]` is divided into N equal pk-value segments. Each segment is handled by one reader+writer pair. Within each segment, the cursor reader is O(n_segment). Total: O(n).

This task replaces the MOD shard logic with N range splits.

- [ ] **Step 1: Replace the shard block**

Locate the `if let Some(pk_col) = shard_pk { ... }` block. Currently it builds N `shard_query` strings with MOD conditions, spawns N reader+writer pairs, awaits them all.

Replace the entire block:

```rust
    let pipeline_result = if let Some(pk_col) = shard_pk {
        // ── Range-Split Mode: N independent cursor reader+writer pairs ───
        // DataX/SeaTunnel style: divide [MIN(pk), MAX(pk)] into `parallelism`
        // non-overlapping ranges. Each range spawns its own reader+writer.
        // No MOD, no OFFSET — O(n) total.
        logs.lock().unwrap().emit_and_record(
            app, job_id, run_id, "SYSTEM",
            &format!("[{}] Range-split mode: {} shards on column '{}'", mapping_label, parallelism, pk_col),
        );

        let splits_opt = crate::migration::splitter::compute_pk_splits(
            &*src_ds, &source_query, &pk_col, &src_cfg.driver, parallelism,
        ).await;

        match splits_opt {
            None => {
                // MIN/MAX failed (empty table or error) → fall back to single cursor reader
                logs.lock().unwrap().emit_and_record(
                    app, job_id, run_id, "WARN",
                    &format!("[{}] Range-split: MIN/MAX failed; running single cursor reader", mapping_label),
                );
                // Attempt single cursor mode
                let single_split = crate::migration::splitter::PkSplit { start: i64::MIN, end: None };
                run_reader_writer_pair(
                    source_query,
                    Some((pk_col, single_split)),
                    src_cfg.driver.clone(),
                    src_ds,
                    dst_ds,
                    target_table.clone(),
                    dst_driver.clone(),
                    mapped_cols,
                    conflict_strategy.clone(),
                    upsert_keys.clone(),
                    read_batch_size,
                    write_batch_size,
                    channel_cap,
                    error_limit,
                    1,
                    cancel.clone(),
                    mapping_stats.clone(),
                    global_stats.clone(),
                    app.clone(),
                    job_id,
                    run_id.to_string(),
                    mapping_label.clone(),
                ).await
            }
            Some(splits) => {
                // Scale channel_cap per split to prevent O(parallelism * channel_cap) memory
                let split_channel_cap = (channel_cap / parallelism).max(2);
                let actual_splits = splits.len();

                logs.lock().unwrap().emit_and_record(
                    app, job_id, run_id, "SYSTEM",
                    &format!("[{}] {} range splits created (requested {})", mapping_label, actual_splits, parallelism),
                );

                let mut split_handles = Vec::new();
                for (i, split) in splits.into_iter().enumerate() {
                    let split_label = format!("{}[split:{}/{}]", mapping_label, i + 1, actual_splits);
                    logs.lock().unwrap().emit_and_record(
                        app, job_id, run_id, "SYSTEM",
                        &format!("[{}] pk range [{}, {})",
                            split_label,
                            split.start,
                            split.end.map(|e| e.to_string()).unwrap_or_else(|| "∞".into())),
                    );
                    let handle = tokio::spawn(run_reader_writer_pair(
                        source_query.clone(),
                        Some((pk_col.clone(), split)),
                        src_cfg.driver.clone(),
                        src_ds.clone(),
                        dst_ds.clone(),
                        target_table.clone(),
                        dst_driver.clone(),
                        mapped_cols.clone(),
                        conflict_strategy.clone(),
                        upsert_keys.clone(),
                        read_batch_size,
                        write_batch_size,
                        split_channel_cap,
                        error_limit,
                        1, // each split is single-writer
                        cancel.clone(),
                        mapping_stats.clone(),
                        global_stats.clone(),
                        app.clone(),
                        job_id,
                        run_id.to_string(),
                        split_label,
                    ));
                    split_handles.push(handle);
                }

                let mut split_errors = Vec::new();
                for (i, handle) in split_handles.into_iter().enumerate() {
                    match handle.await {
                        Err(e) => split_errors.push(format!("split {} panicked: {}", i + 1, e)),
                        Ok(Err(e)) => split_errors.push(format!("split {} failed: {}", i + 1, e)),
                        Ok(Ok(())) => {}
                    }
                }
                if split_errors.is_empty() {
                    Ok(())
                } else {
                    Err(AppError::Other(format!("Split errors: {}", split_errors.join("; "))))
                }
            }
        }
```

Also remove the old `build_shard_query` function (lines ~797–826) since it's no longer used:

```rust
// DELETE this entire function:
fn build_shard_query(
    original_query: &str,
    pk_col: &str,
    shard_id: usize,
    total_shards: usize,
    driver: &str,
) -> String { ... }
```

- [ ] **Step 2: Cargo check**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: `Finished dev profile`. If `build_shard_query` is still referenced somewhere, check with:

```bash
cd src-tauri && cargo check 2>&1 | grep build_shard_query
```

- [ ] **Step 3: Remove the temporary `None` placeholders from Task 4 Step 3**

The shard call site was temporarily given `None` for `pk_split` in Task 4. Verify this no longer exists (the block was fully replaced in Step 1 above).

- [ ] **Step 4: Final cargo check + existing tests**

```bash
cd src-tauri && cargo test 2>&1
```

Expected: all existing tests in `task_mgr.rs` and `splitter.rs` pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): replace MOD sharding with DataX-style range splits for parallel mode"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Full cargo check + tests**

```bash
cd src-tauri && cargo test 2>&1
```

Expected: all tests pass, no warnings about unused functions.

- [ ] **Step 2: TypeScript type check (unchanged, but verify no regressions)**

```bash
cd /home/wallfacers/project/open-db-studio && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Verify log output for a 10M table migration**

Start the app and run a migration. Confirm log lines contain:
- `Cursor mode on 'id': range [1, ∞)` (single mode)  
  OR `Range-split mode: 4 shards on column 'id'` (parallel mode)
- `[split:1/4] pk range [1, 2500001)` etc.
- **No more `126167m40s` style ETAs** (fixed in earlier session)
- Progress percentage advances steadily at high RPS

- [ ] **Step 4: Commit summary**

```bash
git log --oneline -7
```

Expected:
```
feat(migration): replace MOD sharding with DataX-style range splits for parallel mode
feat(migration): single-mode uses cursor reader when integer PK available
feat(migration): add cursor-based split reader to run_reader_writer_pair
fix(migration): remove pending_writes abort — was silently dropping in-flight writes
feat(migration): add compute_pk_splits with MIN/MAX DB query
feat(migration): add splitter module with PK range split computation
fix(migration): use cumulative avg RPS for ETA to avoid 126167m40s style values
```

---

## Self-Review

### Spec Coverage
| Requirement | Task |
|---|---|
| O(n) total row scans (no OFFSET for large tables) | Task 4 cursor reader |
| MIN/MAX based range splitting (DataX style) | Task 2 `compute_pk_splits` |
| Range splits for parallel mode (replace MOD) | Task 6 |
| Single-mode cursor reading | Task 5 |
| Fix `pending_writes` abort bug (silent write loss) | Task 3 |
| Fallback to OFFSET when no integer PK | Task 4 (else branch) |
| `build_shard_query` cleanup (dead code) | Task 6 Step 1 |

### Type Consistency
- `PkSplit` defined in Task 1, used in Tasks 4/5/6 — consistent
- `compute_pk_splits` returns `Option<Vec<PkSplit>>` — Task 5 and 6 both handle `None` case
- `parse_i64_from_json` defined in Task 1, imported in Task 4 — consistent
- `run_reader_writer_pair` new signature (Tasks 4/5/6) matches at all call sites

### No Placeholders
All code blocks are complete. No TBD.
