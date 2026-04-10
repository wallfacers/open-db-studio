# Migration Parallel Pipeline Design

## Problem

1. `parallelism` config field exists but is completely unused — pipeline is always single-reader + single-writer
2. `errorLimit` not enforced in flush remainder path
3. Batch write failure marks entire batch as dirty (already fixed with row-by-row retry)

## Design: Adaptive Parallel Pipeline

### Decision Flow

```
detect_pk_columns(source_table)
  |
  +-- has integer PK --> Shard Mode: N independent reader+writer pipelines
  |                      each shard: SELECT ... WHERE MOD(pk, N) = i
  |
  +-- no PK / non-integer PK --> Semaphore Mode: 1 reader + N concurrent write tasks
```

When `parallelism = 1`, both modes collapse to the current single-reader + single-writer behavior. No behavioral change for existing configs.

### Multi-table concurrency

`execute_pipeline` replaces the sequential `for` loop over `table_mappings` with `futures::stream::buffer_unordered(parallelism)`, so multiple mappings run concurrently.

---

## Mode A: Shard Mode (integer PK detected)

### PK Detection

Call `src_ds.get_columns(source_table, None)` to get `ColumnMeta` list. Find the first column where `is_primary_key == true` AND data type is integer-compatible.

Integer type detection by pattern matching on `data_type` (case-insensitive):
- Match: `int`, `integer`, `bigint`, `smallint`, `tinyint`, `mediumint`, `serial`, `bigserial`, `smallserial`, `int2`, `int4`, `int8`, `number` (Oracle)
- Non-match (fallback to Semaphore): `varchar`, `uuid`, `text`, `char`, anything else

For composite PKs (e.g. `PRIMARY KEY(a, b)`): use the first integer PK column for MOD sharding.

### Shard SQL Generation

Each shard `i` (0..N) gets a modified source query:

| Database | Shard condition appended |
|----------|--------------------------|
| MySQL / TiDB / Doris | `MOD(\`pk\`, N) = i` |
| PostgreSQL / GaussDB | `MOD("pk", N) = i` |
| SQLite | `("pk" % N) = i` |
| SQL Server | `([pk] % N) = i` |
| ClickHouse | `modulo(\`pk\`, N) = i` |
| DB2 | `MOD("pk", N) = i` |

The shard condition is injected into the existing `build_source_query` output by wrapping:
```sql
SELECT * FROM ({original_query}) AS _mig_shard_ WHERE {shard_condition}
```

### Shard Execution

```rust
let mut handles = Vec::new();
for shard_id in 0..parallelism {
    let shard_query = build_shard_query(&source_query, &pk_col, shard_id, parallelism, driver);
    let handle = tokio::spawn(async move {
        // independent reader -> channel -> writer sub-pipeline
        run_shard_pipeline(shard_id, shard_query, dst_ds.clone(), ...).await
    });
    handles.push(handle);
}
// await all shards, aggregate stats
```

Each shard has its own:
- Reader task (paginated reads with shard filter)
- mpsc channel
- Writer task (with row-by-row retry on failure)

All shards share:
- `Arc<PipelineStats>` (global_stats) — atomic counters, safe for concurrent updates
- `Arc<dyn DataSource>` (dst_ds) — sqlx Pool handles concurrent connections
- `Arc<AtomicBool>` (cancel) — single cancel flag

### Connection Pool Consideration

With N shards, up to N+1 connections active simultaneously (N writers + 1 stats monitor). Default `pool_max_connections = 5`. If `parallelism > pool_max_connections`, sqlx will queue — no crash, just slower. Log a warning when `parallelism > pool_max_connections`.

---

## Mode B: Semaphore Mode (no integer PK)

### Architecture

```
Reader -> channel -> Writer main loop:
                      batch ready -> semaphore.acquire(N)
                                  -> tokio::spawn(write_task)
                                     (release permit on completion)
                      collect results via oneshot channels
```

### Implementation

```rust
let semaphore = Arc::new(Semaphore::new(parallelism));
let mut pending_writes: FuturesUnordered<JoinHandle<(u64, u64)>> = FuturesUnordered::new();

// In writer loop, instead of synchronous write_batch:
let permit = semaphore.clone().acquire_owned().await.unwrap();
let handle = tokio::spawn(async move {
    let result = write_batch(&*dst_ds, ...).await;
    drop(permit); // release semaphore
    match result {
        Ok(n) => (n as u64, 0u64),
        Err(_) => {
            // row-by-row retry, return (ok_count, fail_count)
        }
    }
});
pending_writes.push(handle);

// Drain completed writes to update stats
while let Some(result) = pending_writes.try_next() { ... }
```

### Ordering

Row write order is NOT guaranteed in Semaphore mode. This is acceptable for migration — the data is complete, just not ordered by source read sequence.

---

## Multi-Table Concurrency

### Current: Sequential

```rust
for (idx, mapping) in config.table_mappings.iter().enumerate() {
    execute_single_mapping(...).await;
}
```

### New: Concurrent with buffer_unordered

```rust
use futures::stream::{self, StreamExt};

let parallelism = config.pipeline.parallelism.max(1);
let results: Vec<_> = stream::iter(config.table_mappings.iter().enumerate())
    .map(|(idx, mapping)| {
        let config = &config;
        let app = app.clone();
        // ...clone shared state...
        async move {
            execute_single_mapping(job_id, &run_id, config, mapping, &app, &cancel, &stats, idx, total_mappings, logs.clone()).await
        }
    })
    .buffer_unordered(parallelism)
    .collect()
    .await;

// Process results: count completed / failed
```

When only 1 mapping exists (like `all_types -> all_types`), this is equivalent to sequential. The intra-table parallelism (Shard or Semaphore) handles concurrency within that single mapping.

---

## errorLimit Fix

### Current Bug

`errorLimit` is NOT checked after flush remainder row-by-row retry. The writer returns `Ok(())` even if thousands of rows failed in the final flush.

### Fix

Add error_limit check after final flush row-by-row retry, matching the main loop pattern:

```rust
// After final flush row-by-row retry
if error_limit > 0 && error_count >= error_limit {
    return Err(AppError::Other(format!(
        "Error limit ({}) exceeded: {} errors", error_limit, error_count
    )));
}
```

---

## Config Limits (already implemented)

| Parameter | Min | Max | Default |
|-----------|-----|-----|---------|
| readBatchSize | 1 | 50,000 | 10,000 |
| writeBatchSize | 1 | 5,000 | 1,000 |
| parallelism | 1 | 16 | 1 |
| errorLimit | 0 | 100,000 | 0 (unlimited) |

Backend clamps via `.max(min).min(max)`. Frontend enforces via `<input min max>` + onChange clamp.

---

## Stats & Progress

All shards / concurrent writers share the same `Arc<PipelineStats>` with `AtomicU64` counters. The existing stats monitor task (`stats_handle`) continues to emit `migration_stats` events every 1 second — no changes needed since it reads from the shared atomic counters.

Progress percentage calculation uses the already-fixed `total_rows` (which counts all rows regardless of sharding). Each shard/writer increments `rows_read` and `rows_written` atomically, so the global percentage remains accurate.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src-tauri/src/migration/pipeline.rs` | Main changes: shard detection, shard query builder, semaphore writer, multi-table buffer_unordered, errorLimit fix |
| `src-tauri/src/migration/task_mgr.rs` | No changes (PipelineConfig already has parallelism field) |
| `src/components/MigrationJobTab/ConfigTab.tsx` | Already done (min/max limits) |
| `src/components/MigrationJobTab/LogTab.tsx` | No changes (reads from shared stats) |

---

## Edge Cases

1. **parallelism=1**: Both modes collapse to single reader+writer. Zero overhead.
2. **Custom query mode**: `build_source_query` may return complex SQL. Shard wrapping (`SELECT * FROM (custom_sql) WHERE MOD(pk, N) = i`) still works as subquery.
3. **Incremental sync**: Shard condition is AND-ed with the incremental `WHERE` clause. Both conditions applied.
4. **Cancel**: Shared `AtomicBool` flag. All shards/writers check and exit.
5. **Overwrite (truncate)**: Truncate happens once before any shard starts. No conflict.
6. **Oracle**: `get_columns` not implemented → PK detection returns empty → always Semaphore mode.
7. **Pool exhaustion**: If parallelism > pool max_connections, log warning. sqlx queues internally, no crash.
