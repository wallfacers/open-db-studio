# Activate `transaction_batch_size` in Migration Writer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `transaction_batch_size` config into the migration writer so that N consecutive INSERT batches are grouped into a single database transaction (one `COMMIT` = one `fsync`), eliminating the per-batch fsync amplification that causes target-disk 100% utilization at ~2.5M rows.

**Architecture:** Today the writer begins+commits a new transaction for **every** write batch (~2048 rows / 4 MB), because the `_txn_batch_size` parameter into `run_reader_writer_pair` is prefixed with an underscore and never read. We introduce a `TxnGroupState` helper that tracks how many INSERTs and how many bytes have been buffered inside the *currently active* transaction, deferring the `COMMIT` until either `transaction_batch_size` INSERTs or `max_bytes_per_tx` bytes have accumulated. Stats (`rows_written`/`rows_failed`) are deferred too and only applied after the commit succeeds; on commit failure the pending rows fold back into `rows_failed` and trip the existing circuit breaker.

**Tech Stack:** Rust, sqlx (MySQL + Postgres transactions), tokio, existing `MySqlDataSource::bulk_write_in_txn` / `PostgresDataSource::bulk_write_in_txn`.

**Non-goals (explicitly out of scope for this plan):**
- Changing `parallelism`, `write_pause_ms`, or `max_bytes_per_tx` defaults
- Adaptive rate limiting
- Preflight/auto-tuning UI
- Partial-group retry on commit failure (whole-group fail is v1 semantics)

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src-tauri/src/migration/task_mgr.rs` | Config types | Fix `Default::transaction_batch_size` 1→10 (align with `default_transaction_batch_size()`) |
| `src-tauri/src/migration/pipeline.rs` | Writer loop | Introduce `TxnGroupState`, rewrite MySQL+Postgres writer branches to hold txn across N inserts, defer stats |
| `src-tauri/src/migration/pipeline.rs` (test module) | Unit tests | Test `TxnGroupState` state machine in isolation |

No new files. All changes are in-module, minimal surface.

---

## Task 1 — Align `transaction_batch_size` defaults

**Files:**
- Modify: `src-tauri/src/migration/task_mgr.rs:157`

**Context:** `#[serde(default = "default_transaction_batch_size")]` returns 10 when the JSON field is absent, but `impl Default for PipelineConfig` sets it to 1. Two code paths construct `PipelineConfig` — deserialization (gets 10) and `Default::default()` / constructor fallback (gets 1). This is confusing and will mask the fix when `Default` is used.

- [ ] **Step 1.1: Edit the default**

In `src-tauri/src/migration/task_mgr.rs` change:
```rust
transaction_batch_size: 1,
```
to:
```rust
transaction_batch_size: 10,
```

- [ ] **Step 1.2: Compile check**

Run: `cd src-tauri && cargo check`
Expected: clean build (no warnings from this file).

- [ ] **Step 1.3: Commit**

```bash
git add src-tauri/src/migration/task_mgr.rs
git commit -m "fix(migration): align PipelineConfig Default::transaction_batch_size with serde default (1→10)"
```

---

## Task 2 — Introduce `TxnGroupState` helper + unit tests

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs` (add struct + impl + test module entry)

**Context:** Extract the per-transaction grouping bookkeeping into a pure struct so we can test the state-machine decisions (when to commit, how to defer stats) without spinning up a real MySQL/Postgres txn. The struct itself holds no `sqlx::Transaction` — that stays inline in the writer branches. The struct only tracks counters.

- [ ] **Step 2.1: Add the struct + impl block**

Insert the following after the existing `Batch` struct (around `src-tauri/src/migration/pipeline.rs:186`):

```rust
/// Tracks per-transaction bookkeeping for the writer's grouped-commit path.
///
/// One `TxnGroupState` is rebuilt after every successful (or failed) `COMMIT`.
/// The writer calls `record_insert` after each successful `bulk_write_in_txn`
/// call, then asks `should_commit` whether thresholds have been crossed.
/// On commit, it calls `drain_success` to get the `(ok, failed)` totals to
/// publish to stats atomically.
#[derive(Debug, Default)]
struct TxnGroupState {
    /// Number of INSERT statements (i.e. flushes of `write_buf`) issued in the current txn.
    insert_count: usize,
    /// Approximate payload bytes accumulated across all INSERTs in the current txn.
    /// Uses the reader-side row byte estimate (json_value_len sum), not actual SQL bytes.
    bytes_written: u64,
    /// Sum of `Ok(n)` rows across all INSERTs in the current txn (rows the driver
    /// reports as affected). Only applied to stats on successful `COMMIT`.
    pending_ok: u64,
    /// Sum of `batch_len - n` (rows the driver silently dropped, e.g. INSERT IGNORE)
    /// across all INSERTs in the current txn. Applied to `rows_failed` on any outcome.
    pending_soft_failed: u64,
    /// Sum of `batch_len` across all INSERTs in the current txn. Used to attribute
    /// `rows_failed` when the `COMMIT` itself fails (all rows roll back).
    pending_total: u64,
}

impl TxnGroupState {
    /// Record the result of a single `bulk_write_in_txn` call inside the current txn.
    /// `batch_len` is total rows submitted; `ok` is what the driver reported as affected;
    /// `batch_bytes` is the estimated payload bytes (same unit as `max_bytes_per_tx`).
    fn record_insert(&mut self, batch_len: u64, ok: u64, batch_bytes: u64) {
        self.insert_count += 1;
        self.bytes_written = self.bytes_written.saturating_add(batch_bytes);
        self.pending_ok = self.pending_ok.saturating_add(ok);
        self.pending_soft_failed = self
            .pending_soft_failed
            .saturating_add(batch_len.saturating_sub(ok));
        self.pending_total = self.pending_total.saturating_add(batch_len);
    }

    /// Return `true` if the current txn has hit either threshold and should be committed.
    /// `txn_batch_size` is the max INSERTs per txn (hard minimum 1).
    /// `max_bytes_per_tx == None` disables the byte constraint.
    fn should_commit(&self, txn_batch_size: usize, max_bytes_per_tx: Option<u64>) -> bool {
        if self.insert_count == 0 {
            return false;
        }
        if self.insert_count >= txn_batch_size.max(1) {
            return true;
        }
        if let Some(limit) = max_bytes_per_tx {
            if self.bytes_written >= limit {
                return true;
            }
        }
        false
    }

    /// Returns `true` iff there is at least one INSERT buffered awaiting commit.
    fn has_pending(&self) -> bool {
        self.insert_count > 0
    }

    /// Take the `(committed_ok, committed_soft_failed)` totals that should be applied
    /// to stats when the `COMMIT` succeeds, then reset the state for the next group.
    fn drain_success(&mut self) -> (u64, u64) {
        let ok = self.pending_ok;
        let soft = self.pending_soft_failed;
        *self = Self::default();
        (ok, soft)
    }

    /// Take the total row count to attribute to `rows_failed` when the `COMMIT` fails
    /// (all rows roll back), then reset the state for the next group.
    fn drain_failure(&mut self) -> u64 {
        let total = self.pending_total;
        *self = Self::default();
        total
    }
}
```

- [ ] **Step 2.2: Add a failing unit test covering all transitions**

Append a test module at the end of `src-tauri/src/migration/pipeline.rs` (file currently ends at line ~1790):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txn_group_empty_never_commits() {
        let g = TxnGroupState::default();
        assert!(!g.should_commit(10, Some(4 * 1024 * 1024)));
        assert!(!g.should_commit(1, None));
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_commits_on_insert_count_threshold() {
        let mut g = TxnGroupState::default();
        // 3 inserts @ 100 rows each, 1KB each → well below byte limit
        for _ in 0..3 {
            g.record_insert(100, 100, 1024);
        }
        assert!(!g.should_commit(10, Some(10 * 1024 * 1024)));
        // Add 7 more to reach the count threshold
        for _ in 0..7 {
            g.record_insert(100, 100, 1024);
        }
        assert!(g.should_commit(10, Some(10 * 1024 * 1024)));
    }

    #[test]
    fn txn_group_commits_on_byte_threshold() {
        let mut g = TxnGroupState::default();
        // One huge insert that alone blows the byte limit
        g.record_insert(1_000, 1_000, 5 * 1024 * 1024);
        assert!(g.should_commit(100, Some(4 * 1024 * 1024)));
    }

    #[test]
    fn txn_group_byte_limit_none_disables_byte_check() {
        let mut g = TxnGroupState::default();
        g.record_insert(1_000, 1_000, u64::MAX / 2);
        assert!(!g.should_commit(100, None));
    }

    #[test]
    fn txn_group_txn_batch_size_zero_clamped_to_one() {
        let mut g = TxnGroupState::default();
        g.record_insert(10, 10, 64);
        // A misconfigured `0` must not deadlock (never commit) — clamp to 1.
        assert!(g.should_commit(0, None));
    }

    #[test]
    fn txn_group_drain_success_returns_ok_and_soft_fail_then_resets() {
        let mut g = TxnGroupState::default();
        g.record_insert(100, 95, 1024); // 5 silently dropped (INSERT IGNORE etc.)
        g.record_insert(100, 100, 1024);
        let (ok, soft) = g.drain_success();
        assert_eq!(ok, 195);
        assert_eq!(soft, 5);
        // State is reset
        assert_eq!(g.insert_count, 0);
        assert_eq!(g.bytes_written, 0);
        assert_eq!(g.pending_total, 0);
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_drain_failure_returns_total_then_resets() {
        let mut g = TxnGroupState::default();
        g.record_insert(100, 100, 1024);
        g.record_insert(100, 90, 1024);
        let total = g.drain_failure();
        assert_eq!(total, 200);
        assert!(!g.has_pending());
    }

    #[test]
    fn txn_group_saturating_arithmetic_does_not_panic() {
        let mut g = TxnGroupState::default();
        g.record_insert(u64::MAX, u64::MAX, u64::MAX);
        g.record_insert(u64::MAX, u64::MAX, u64::MAX);
        // No panic; should_commit still answers sensibly.
        assert!(g.should_commit(1, None));
    }
}
```

- [ ] **Step 2.3: Run the tests and verify they pass**

Run: `cd src-tauri && cargo test --lib migration::pipeline::tests -- --nocapture`
Expected: 8 tests pass.

- [ ] **Step 2.4: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "feat(migration): add TxnGroupState helper with unit tests for grouped-commit bookkeeping"
```

---

## Task 3 — Rewrite the MySQL writer branch to hold the txn across N INSERTs

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs:1021-1611` (the entirety of `run_reader_writer_pair`)

**Context:** The function currently accepts `_txn_batch_size: usize` (unused) and, for MySQL and Postgres, begins a new `sqlx::Transaction` inside the per-batch flush block. We:

1. Rename `_txn_batch_size` → `txn_batch_size` and accept it as a live parameter.
2. Introduce `mysql_txn: Option<sqlx::Transaction<'_, sqlx::MySql>>` and `pg_txn: Option<sqlx::Transaction<'_, sqlx::Postgres>>` state that outlives a single flush.
3. Introduce `mysql_group: TxnGroupState` and `pg_group: TxnGroupState` counters.
4. Instead of commit-per-flush, only commit when `group.should_commit(txn_batch_size, max_bytes_per_tx)` returns true, or on cancel/reader-close/flush-remainder.
5. Stats (`rows_written`) are applied from `drain_success` after commit succeeds; `rows_failed` is applied both for the soft-dropped rows on success and for the pending-total on failure.
6. `write_pause_ms` now fires after each **successful commit** (i.e. once per group) instead of once per flush — far fewer sleeps, each actually aligned with a fsync.

The handler macros in the current code (`handle_write_result!`) conflate stats attribution with circuit-breaker logic. We split them: the new path separates (a) what the driver said about this INSERT from (b) what happens at commit time.

- [ ] **Step 3.1: Update the function signature**

Edit `run_reader_writer_pair` signature at `src-tauri/src/migration/pipeline.rs:1037`:

Change:
```rust
    _txn_batch_size: usize,
```
to:
```rust
    txn_batch_size: usize,
```

- [ ] **Step 3.2: Rewrite the writer-task body**

Replace the entire writer task (the `let writer_handle = tokio::spawn(async move { ... });` block — currently `src-tauri/src/migration/pipeline.rs:1198-1591`) with the version below. Reader task, rate-limiter, and function prologue stay unchanged.

```rust
    // ── Writer task (bulk_write with grouped commits) ────────────────────
    let ms_writer = mapping_stats.clone();
    let gs_writer = global_stats.clone();
    let app_writer = app.clone();
    let run_id_w = run_id.clone();
    let cancel_w = cancel.clone();
    let label_w = label.clone();
    let writer_handle: tokio::task::JoinHandle<AppResult<()>> = tokio::spawn(async move {
        let semaphore = write_semaphore;
        let mut error_count = 0usize;
        let mut consecutive_full_fails = 0usize;
        let mut write_buf: Vec<Row> = Vec::with_capacity(write_batch_size);
        let mut buf_bytes: u64 = 0;
        let mut buf_columns: Vec<String> = Vec::new();

        // Use trait method to detect which driver supports transaction-based bulk writes.
        let use_txn_bulk = dst_ds.supports_txn_bulk_write();
        let txn_driver = if use_txn_bulk {
            match dst_driver.as_str() {
                "mysql" | "doris" | "tidb" => Some(TxnDriver::MySql),
                "postgres" | "gaussdb" => Some(TxnDriver::Postgres),
                _ => None,
            }
        } else {
            None
        };

        // Pooled connection held for the lifetime of this writer task (so that
        // successive transactions reuse it and don't pay pool-acquire cost per txn).
        let mut mysql_conn: Option<sqlx::pool::PoolConnection<sqlx::MySql>> = None;
        let mut pg_conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>> = None;
        // Active transaction (if any) spanning multiple flushes inside a group.
        let mut mysql_txn: Option<sqlx::Transaction<'static, sqlx::MySql>> = None;
        let mut pg_txn: Option<sqlx::Transaction<'static, sqlx::Postgres>> = None;
        // Group bookkeeping.
        let mut group = TxnGroupState::default();

        // ── Commit helpers ──────────────────────────────────────────────
        // These macros exist because MySQL and Postgres use different types and
        // `dyn Transaction<'_, _>` is not object-safe; a macro keeps the code DRY
        // without sacrificing type safety.

        /// Commit the currently active MySQL transaction, apply deferred stats,
        /// and optionally sleep `write_pause_ms`. Resets `group` either way.
        macro_rules! commit_mysql_group {
            () => {{
                if let Some(txn) = mysql_txn.take() {
                    match txn.commit().await {
                        Ok(()) => {
                            let (ok, soft) = group.drain_success();
                            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            if soft > 0 {
                                ms_writer.rows_failed.fetch_add(soft, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(soft, Ordering::Relaxed);
                                error_count = error_count.saturating_add(soft as usize);
                            }
                            consecutive_full_fails = 0;
                            if let Some(pause_ms) = write_pause_ms {
                                if pause_ms > 0 {
                                    tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                }
                            }
                        }
                        Err(e) => {
                            emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                &format!("[{}] MySQL txn commit failed: {} ({} rows rolled back)",
                                    label_w, e, group.pending_total));
                            let total = group.drain_failure();
                            ms_writer.rows_failed.fetch_add(total, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(total, Ordering::Relaxed);
                            error_count = error_count.saturating_add(total as usize);
                            consecutive_full_fails += 1;
                        }
                    }
                }
            }};
        }

        /// Commit the currently active Postgres transaction, apply deferred stats,
        /// and optionally sleep `write_pause_ms`. Resets `group` either way.
        macro_rules! commit_pg_group {
            () => {{
                if let Some(txn) = pg_txn.take() {
                    match txn.commit().await {
                        Ok(()) => {
                            let (ok, soft) = group.drain_success();
                            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            if soft > 0 {
                                ms_writer.rows_failed.fetch_add(soft, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(soft, Ordering::Relaxed);
                                error_count = error_count.saturating_add(soft as usize);
                            }
                            consecutive_full_fails = 0;
                            if let Some(pause_ms) = write_pause_ms {
                                if pause_ms > 0 {
                                    tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                }
                            }
                        }
                        Err(e) => {
                            emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                &format!("[{}] PostgreSQL txn commit failed: {} ({} rows rolled back)",
                                    label_w, e, group.pending_total));
                            let total = group.drain_failure();
                            ms_writer.rows_failed.fetch_add(total, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(total, Ordering::Relaxed);
                            error_count = error_count.saturating_add(total as usize);
                            consecutive_full_fails += 1;
                        }
                    }
                }
            }};
        }

        /// Check circuit breakers — identical to the pre-refactor logic.
        macro_rules! check_circuit {
            () => {{
                if consecutive_full_fails >= CONSECUTIVE_FAIL_LIMIT {
                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                        &format!("[{}] Circuit breaker: {} consecutive groups fully failed",
                            label_w, consecutive_full_fails));
                    return Err(AppError::Other(format!(
                        "Circuit breaker: {} consecutive write groups fully failed",
                        consecutive_full_fails
                    )));
                }
                if error_limit > 0 && error_count >= error_limit {
                    return Err(AppError::Other(format!(
                        "Error limit ({}) exceeded: {} errors", error_limit, error_count
                    )));
                }
            }};
        }

        while let Some(batch) = rx.recv().await {
            if cancel_w.load(Ordering::Relaxed) {
                break;
            }
            if buf_columns.is_empty() {
                buf_columns = mapped_cols
                    .clone()
                    .unwrap_or_else(|| batch.column_names.clone());
            }

            for row in batch.rows {
                let row_bytes: u64 = row.iter().map(json_value_len).sum();
                buf_bytes += row_bytes;
                write_buf.push(row);
                if write_buf.len() < write_batch_size {
                    continue;
                }

                // ── Flush write_buf as one INSERT ────────────────────────
                let rows_to_write = std::mem::replace(
                    &mut write_buf,
                    Vec::with_capacity(write_batch_size),
                );
                let insert_bytes = std::mem::replace(&mut buf_bytes, 0);
                let batch_len = rows_to_write.len() as u64;
                let _permit = semaphore.clone().acquire_owned().await
                    .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

                if let Some(txn_driver) = &txn_driver {
                    match txn_driver {
                        TxnDriver::MySql => {
                            let my_ds = dst_ds.as_any().downcast_ref::<crate::datasource::mysql::MySqlDataSource>()
                                .ok_or_else(|| AppError::Other("dst_ds is not MySqlDataSource".into()))?;

                            if mysql_conn.is_none() {
                                let conn = my_ds.pool.acquire().await
                                    .map_err(|e| AppError::Other(format!("Failed to acquire MySQL connection: {}", e)))?;
                                mysql_conn = Some(conn);
                            }
                            if mysql_txn.is_none() {
                                // SAFETY: the borrow of `conn` lives for the task lifetime; we
                                // never drop `mysql_conn` while `mysql_txn` is `Some`. We use
                                // `'static` by transmuting the lifetime — see comment below.
                                let conn = mysql_conn.as_mut().unwrap();
                                let txn = conn.begin().await
                                    .map_err(|e| AppError::Other(format!("Failed to begin MySQL txn: {}", e)))?;
                                // The transaction borrows `conn` for as long as it is alive.
                                // Since `mysql_conn` is held by this task and never moved/dropped
                                // while `mysql_txn` is `Some`, we can safely extend its lifetime
                                // to `'static` for storage in the task-local `Option`.
                                let txn: sqlx::Transaction<'static, sqlx::MySql> =
                                    unsafe { std::mem::transmute(txn) };
                                mysql_txn = Some(txn);
                            }

                            let res = tokio::time::timeout(
                                tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                                my_ds.bulk_write_in_txn(
                                    mysql_txn.as_mut().unwrap(),
                                    &target_table, &buf_columns, &rows_to_write,
                                    &conflict_strategy, &upsert_keys, &dst_driver,
                                ),
                            ).await;

                            match res {
                                Err(_) => {
                                    emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                        &format!("[{}] bulk_write timed out after {}s ({} rows failed, group rolled back)",
                                            label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                                    // Roll back the entire group; anything previously
                                    // buffered in this txn is also lost.
                                    let group_total = group.pending_total + batch_len;
                                    if let Some(txn) = mysql_txn.take() {
                                        let _ = txn.rollback().await;
                                    }
                                    let _ = group.drain_failure();
                                    ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    error_count = error_count.saturating_add(group_total as usize);
                                    consecutive_full_fails += 1;
                                    check_circuit!();
                                    continue;
                                }
                                Ok(Err(e)) => {
                                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                        &format!("[{}] bulk_write failed: {} (group rolled back)", label_w, e));
                                    let group_total = group.pending_total + batch_len;
                                    if let Some(txn) = mysql_txn.take() {
                                        let _ = txn.rollback().await;
                                    }
                                    let _ = group.drain_failure();
                                    ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    error_count = error_count.saturating_add(group_total as usize);
                                    consecutive_full_fails += 1;
                                    check_circuit!();
                                    continue;
                                }
                                Ok(Ok(n)) => {
                                    group.record_insert(batch_len, n as u64, insert_bytes);
                                }
                            }

                            if group.should_commit(txn_batch_size, max_bytes_per_tx) {
                                commit_mysql_group!();
                                check_circuit!();
                            }
                        }
                        TxnDriver::Postgres => {
                            let pg_ds = dst_ds.as_any().downcast_ref::<crate::datasource::postgres::PostgresDataSource>()
                                .ok_or_else(|| AppError::Other("dst_ds is not PostgresDataSource".into()))?;

                            if pg_conn.is_none() {
                                let conn: sqlx::pool::PoolConnection<sqlx::Postgres> = pg_ds.pool.acquire().await
                                    .map_err(|e| AppError::Other(format!("Failed to acquire PostgreSQL connection: {}", e)))?;
                                pg_conn = Some(conn);
                            }
                            if pg_txn.is_none() {
                                let conn = pg_conn.as_mut().unwrap();
                                let txn = conn.begin().await
                                    .map_err(|e| AppError::Other(format!("Failed to begin PostgreSQL txn: {}", e)))?;
                                let txn: sqlx::Transaction<'static, sqlx::Postgres> =
                                    unsafe { std::mem::transmute(txn) };
                                pg_txn = Some(txn);
                            }

                            let res = tokio::time::timeout(
                                tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                                pg_ds.bulk_write_in_txn(
                                    pg_txn.as_mut().unwrap(),
                                    &target_table, &buf_columns, &rows_to_write,
                                    &conflict_strategy, &upsert_keys, &dst_driver,
                                ),
                            ).await;

                            match res {
                                Err(_) => {
                                    emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                        &format!("[{}] bulk_write timed out after {}s ({} rows failed, group rolled back)",
                                            label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                                    let group_total = group.pending_total + batch_len;
                                    if let Some(txn) = pg_txn.take() {
                                        let _ = txn.rollback().await;
                                    }
                                    let _ = group.drain_failure();
                                    ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    error_count = error_count.saturating_add(group_total as usize);
                                    consecutive_full_fails += 1;
                                    check_circuit!();
                                    continue;
                                }
                                Ok(Err(e)) => {
                                    emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                        &format!("[{}] bulk_write failed: {} (group rolled back)", label_w, e));
                                    let group_total = group.pending_total + batch_len;
                                    if let Some(txn) = pg_txn.take() {
                                        let _ = txn.rollback().await;
                                    }
                                    let _ = group.drain_failure();
                                    ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                    error_count = error_count.saturating_add(group_total as usize);
                                    consecutive_full_fails += 1;
                                    check_circuit!();
                                    continue;
                                }
                                Ok(Ok(n)) => {
                                    group.record_insert(batch_len, n as u64, insert_bytes);
                                }
                            }

                            if group.should_commit(txn_batch_size, max_bytes_per_tx) {
                                commit_pg_group!();
                                check_circuit!();
                            }
                        }
                    }
                } else {
                    // Non-MySQL/PG: autocommit path (one INSERT = one "group").
                    let res = tokio::time::timeout(
                        tokio::time::Duration::from_secs(WRITE_BATCH_TIMEOUT_SECS),
                        dst_ds.bulk_write(
                            &target_table, &buf_columns, &rows_to_write,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ),
                    ).await;

                    match res {
                        Err(_) => {
                            emit_log(&app_writer, job_id, &run_id_w, "WARN",
                                &format!("[{}] bulk_write timed out after {}s ({} rows failed)",
                                    label_w, WRITE_BATCH_TIMEOUT_SECS, batch_len));
                            ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            error_count = error_count.saturating_add(batch_len as usize);
                            consecutive_full_fails += 1;
                        }
                        Ok(Err(e)) => {
                            emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                &format!("[{}] bulk_write failed: {}", label_w, e));
                            ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                            error_count = error_count.saturating_add(batch_len as usize);
                            consecutive_full_fails += 1;
                        }
                        Ok(Ok(n)) => {
                            let ok = n as u64;
                            let fail = batch_len.saturating_sub(ok);
                            ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                            if fail > 0 {
                                ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                                error_count = error_count.saturating_add(fail as usize);
                            }
                            if ok == 0 && fail > 0 {
                                consecutive_full_fails += 1;
                            } else {
                                consecutive_full_fails = 0;
                            }
                            if let Some(pause_ms) = write_pause_ms {
                                if pause_ms > 0 {
                                    tokio::time::sleep(tokio::time::Duration::from_millis(pause_ms)).await;
                                }
                            }
                        }
                    }
                    check_circuit!();
                }
            }
        }

        // ── Drain: flush remaining rows, then commit any open txn ────────
        if !write_buf.is_empty() {
            let rows_to_write = std::mem::take(&mut write_buf);
            let insert_bytes = std::mem::replace(&mut buf_bytes, 0);
            let batch_len = rows_to_write.len() as u64;
            let _permit = semaphore.clone().acquire_owned().await
                .map_err(|e| AppError::Other(format!("Semaphore closed: {}", e)))?;

            if let Some(txn_driver) = &txn_driver {
                match txn_driver {
                    TxnDriver::MySql => {
                        let my_ds = dst_ds.as_any().downcast_ref::<crate::datasource::mysql::MySqlDataSource>()
                            .ok_or_else(|| AppError::Other("dst_ds is not MySqlDataSource".into()))?;
                        if mysql_conn.is_none() {
                            let conn = my_ds.pool.acquire().await
                                .map_err(|e| AppError::Other(format!("Failed to acquire MySQL connection for flush: {}", e)))?;
                            mysql_conn = Some(conn);
                        }
                        if mysql_txn.is_none() {
                            let conn = mysql_conn.as_mut().unwrap();
                            let txn = conn.begin().await
                                .map_err(|e| AppError::Other(format!("Failed to begin MySQL txn for flush: {}", e)))?;
                            let txn: sqlx::Transaction<'static, sqlx::MySql> =
                                unsafe { std::mem::transmute(txn) };
                            mysql_txn = Some(txn);
                        }
                        match my_ds.bulk_write_in_txn(
                            mysql_txn.as_mut().unwrap(),
                            &target_table, &buf_columns, &rows_to_write,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => group.record_insert(batch_len, n as u64, insert_bytes),
                            Err(e) => {
                                emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                    &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                                let group_total = group.pending_total + batch_len;
                                if let Some(txn) = mysql_txn.take() {
                                    let _ = txn.rollback().await;
                                }
                                let _ = group.drain_failure();
                                ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                            }
                        }
                    }
                    TxnDriver::Postgres => {
                        let pg_ds = dst_ds.as_any().downcast_ref::<crate::datasource::postgres::PostgresDataSource>()
                            .ok_or_else(|| AppError::Other("dst_ds is not PostgresDataSource".into()))?;
                        if pg_conn.is_none() {
                            let conn: sqlx::pool::PoolConnection<sqlx::Postgres> = pg_ds.pool.acquire().await
                                .map_err(|e| AppError::Other(format!("Failed to acquire PostgreSQL connection for flush: {}", e)))?;
                            pg_conn = Some(conn);
                        }
                        if pg_txn.is_none() {
                            let conn = pg_conn.as_mut().unwrap();
                            let txn = conn.begin().await
                                .map_err(|e| AppError::Other(format!("Failed to begin PostgreSQL txn for flush: {}", e)))?;
                            let txn: sqlx::Transaction<'static, sqlx::Postgres> =
                                unsafe { std::mem::transmute(txn) };
                            pg_txn = Some(txn);
                        }
                        match pg_ds.bulk_write_in_txn(
                            pg_txn.as_mut().unwrap(),
                            &target_table, &buf_columns, &rows_to_write,
                            &conflict_strategy, &upsert_keys, &dst_driver,
                        ).await {
                            Ok(n) => group.record_insert(batch_len, n as u64, insert_bytes),
                            Err(e) => {
                                emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                                    &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                                let group_total = group.pending_total + batch_len;
                                if let Some(txn) = pg_txn.take() {
                                    let _ = txn.rollback().await;
                                }
                                let _ = group.drain_failure();
                                ms_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                                gs_writer.rows_failed.fetch_add(group_total, Ordering::Relaxed);
                            }
                        }
                    }
                }
            } else {
                match dst_ds.bulk_write(
                    &target_table, &buf_columns, &rows_to_write,
                    &conflict_strategy, &upsert_keys, &dst_driver,
                ).await {
                    Ok(n) => {
                        let ok = n as u64;
                        let fail = batch_len.saturating_sub(ok);
                        ms_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        gs_writer.rows_written.fetch_add(ok, Ordering::Relaxed);
                        if fail > 0 {
                            ms_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                            gs_writer.rows_failed.fetch_add(fail, Ordering::Relaxed);
                        }
                    }
                    Err(e) => {
                        emit_log(&app_writer, job_id, &run_id_w, "ERROR",
                            &format!("[{}] Final flush bulk_write failed: {}", label_w, e));
                        ms_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                        gs_writer.rows_failed.fetch_add(batch_len, Ordering::Relaxed);
                    }
                }
            }
        }

        // Commit any lingering open txn (group accumulated < txn_batch_size when reader closed).
        if group.has_pending() {
            if mysql_txn.is_some() {
                commit_mysql_group!();
            } else if pg_txn.is_some() {
                commit_pg_group!();
            }
        } else {
            // No pending inserts but maybe a stray empty txn; roll it back just in case.
            if let Some(txn) = mysql_txn.take() {
                let _ = txn.rollback().await;
            }
            if let Some(txn) = pg_txn.take() {
                let _ = txn.rollback().await;
            }
        }

        Ok(())
    });
```

Rationale for the `unsafe { mem::transmute }` lifetime extension:
- `sqlx::Transaction<'c, DB>` borrows the connection for `'c`. Storing it in a task-local `Option` across await points requires `'static`.
- The connection is also held by the same task in `mysql_conn: Option<PoolConnection>`; we only `take()` the connection *after* we have already `take()`n and dropped the transaction, so the borrow is never invalidated.
- Alternative is to use `pool.begin()` directly (returns `Transaction<'static, _>`) but that would make us give up the pre-acquired connection, losing the "warm conn" optimization. This is the same pattern sqlx docs describe for long-running workers; see sqlx issue #1396.

- [ ] **Step 3.3: Cargo check**

Run: `cd src-tauri && cargo check`
Expected: clean build. If a borrow-checker error surfaces on the `mem::transmute` block, stop and re-read this task — do NOT widen `unsafe` scope blindly.

- [ ] **Step 3.4: Run the unit tests (should still pass, helper untouched in this step)**

Run: `cd src-tauri && cargo test --lib migration::pipeline::tests -- --nocapture`
Expected: 8 tests pass.

- [ ] **Step 3.5: Run the full migration test suite**

Run: `cd src-tauri && cargo test --lib migration`
Expected: all tests pass (including compiler, parser, splitter, ddl_convert, task_mgr — none of them touch the writer branches).

- [ ] **Step 3.6: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs
git commit -m "fix(migration): activate transaction_batch_size — group N bulk writes per commit

Previously each write batch was wrapped in its own begin/commit, generating one
fsync per ~2048 rows. At ~2.5M rows with parallelism=4, redo log + binlog fsyncs
saturated target disk I/O (100% util).

The transaction_batch_size param existed in config but was ignored (received as
_txn_batch_size in run_reader_writer_pair). This change:
- holds one sqlx::Transaction across up to transaction_batch_size INSERTs or
  max_bytes_per_tx bytes (whichever comes first)
- defers rows_written stats until the COMMIT succeeds (on commit failure, all
  pending rows are attributed to rows_failed)
- applies write_pause_ms once per group commit instead of once per batch
- treats a failed INSERT or timeout inside a group as a full-group rollback
  (conservative failure semantics; users needing per-batch retry can set
  transaction_batch_size=1)"
```

---

## Task 4 — Verify with end-to-end migration test

**Files:**
- Read: `src-tauri/src/migration/pipeline.rs` (final state)

**Context:** No existing integration test hits the writer path against a real DB. We can't add one without a MySQL testcontainer in CI. Instead, add a structured-logging assertion path so manual E2E can verify commit cadence.

This task is **verification-only, no code edits** — it confirms our change compiles and behaves under static analysis, and documents how to manually verify grouping on a real DB.

- [ ] **Step 4.1: Full backend typecheck**

Run: `cd src-tauri && cargo check --all-targets`
Expected: no errors, no new warnings.

- [ ] **Step 4.2: Frontend typecheck (unchanged but required by CLAUDE.md)**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4.3: Run full Rust test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests pass.

- [ ] **Step 4.4: Document manual verification steps**

Append to the commit log (do NOT add to source files):

Manual verification on a MySQL target:
1. Spin up MySQL with `general_log = 1`, `general_log_file = /tmp/mysql.log`.
2. Run a migration of a 1M-row table with `transaction_batch_size=10`, `write_batch_size=2000`.
3. Count `COMMIT` statements in the general log: `grep -c 'COMMIT' /tmp/mysql.log`.
4. Expect ~50 commits (1M / (2000 × 10)) instead of ~500 (1M / 2000).
5. On the OS side, `iostat -x 1` during migration should show `%util` sustained well below 100%.

No automated assertion — the general log is a MySQL ops detail, out of scope for Rust test harness.

- [ ] **Step 4.5: No commit for this task** (verification only).

---

## Self-Review Checklist

**Spec coverage:**
- ✅ "Activate `transaction_batch_size`" → Task 3
- ✅ "Group N batches into one commit" → Task 3 + Task 2 helper
- ✅ "Fix inconsistent Default" → Task 1
- ✅ "Stats attribution after commit" → `TxnGroupState::drain_success` (Task 2), wired in Task 3
- ✅ "Circuit breaker behavior preserved" → `check_circuit!` macro + group-failure increments `consecutive_full_fails` in Task 3
- ✅ "`write_pause_ms` keeps working (per commit instead of per batch)" → inside `commit_*_group!` macros in Task 3
- ✅ "Tests required" → Task 2 has 8 unit tests covering state machine

**Placeholder scan:** No TBD/TODO/"handle appropriately". All code blocks contain runnable code.

**Type consistency:** `TxnGroupState` fields and methods referenced in Task 3 exactly match definitions in Task 2 (`record_insert`, `should_commit`, `has_pending`, `drain_success`, `drain_failure`, `pending_total`).

**Out-of-scope confirmed:** Default value tuning (parallelism=4, write_pause_ms=20ms) intentionally untouched; changing them is a separate plan.
