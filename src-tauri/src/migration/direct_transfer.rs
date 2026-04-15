use crate::datasource::DataSource;
use crate::datasource::utils::quote_identifier_for_driver;
use crate::error::AppResult;
use crate::migration::splitter::PkSplit;
use crate::migration::task_mgr::ColumnMapping;
use tokio_util::sync::CancellationToken;

/// Configuration for direct transfer execution.
pub struct DirectTransferConfig {
    pub src_db: String,
    pub src_table: String,
    pub dst_db: String,
    pub dst_table: String,
    pub column_mappings: Vec<ColumnMapping>,
    pub where_clause: Option<String>,
}

/// Result of direct transfer execution.
#[derive(Debug)]
pub struct DirectTransferResult {
    pub rows_written: u64,
    /// For the single-SQL path this is the full statement. For batched runs this
    /// is chunk 0's SQL plus a `" -- batched x N chunks"` annotation so log lines
    /// and error messages stay truncation-friendly.
    pub sql_executed: String,
    pub elapsed_ms: u64,
    /// 1 for single-SQL path, N for batched path (one per PK range chunk).
    pub chunk_count: u32,
    /// `true` when the caller-supplied `on_chunk_done` callback has already
    /// accumulated progress into the pipeline stats — the caller must NOT
    /// double-count by adding `rows_written` again after Ok.
    pub already_accounted: bool,
}

/// Error returned from a batched direct transfer run.
///
/// Carries enough information for the caller to decide whether to abort
/// the mapping (committed chunks cannot be re-driven by the reader/writer
/// fallback without double-inserting) or fall back safely (chunk 0 failure
/// means the server never committed anything).
#[derive(Debug)]
pub enum BatchedError {
    SqlFailure {
        chunk_index: usize,
        message: String,
        rows_written_so_far: u64,
    },
    Cancelled {
        completed_chunks: usize,
        rows_written_so_far: u64,
    },
}

/// Direct transfer executor: `INSERT INTO ... SELECT` for same-instance migrations.
pub struct DirectTransferExecutor;

impl DirectTransferExecutor {
    /// Build the direct transfer SQL.
    fn build_direct_transfer_sql(
        src_db: &str,
        src_table: &str,
        dst_db: &str,
        dst_table: &str,
        column_mappings: &[ColumnMapping],
        where_clause: Option<&str>,
        driver: &str,
    ) -> String {
        // Wildcard forms that degrade to `SELECT *` (no explicit column list):
        //   1) empty slice — compiler emits this for `MAPPING (*)`
        //   2) an explicit entry with `source_expr == "*"` — legacy/test form
        // Servers handle column-count/order matching themselves when the target has identical shape.
        let is_wildcard = column_mappings.is_empty()
            || column_mappings.iter().any(|m| m.source_expr.trim() == "*");

        // Build INSERT target columns
        let insert_cols: Vec<String> = if is_wildcard {
            Vec::new()
        } else {
            column_mappings
                .iter()
                .map(|m| quote_identifier_for_driver(&m.target_col, driver))
                .collect()
        };

        // Build SELECT column expressions (supports pass-through expressions like UPPER(col_a))
        let select_exprs: Vec<String> = if is_wildcard {
            vec!["*".to_string()]
        } else {
            column_mappings
                .iter()
                .map(|m| m.source_expr.clone())
                .collect()
        };

        let mut sql = if insert_cols.is_empty() {
            format!(
                "INSERT INTO {}.{}\nSELECT {}\nFROM {}.{}",
                quote_identifier_for_driver(dst_db, driver),
                quote_identifier_for_driver(dst_table, driver),
                select_exprs.join(", "),
                quote_identifier_for_driver(src_db, driver),
                quote_identifier_for_driver(src_table, driver),
            )
        } else {
            format!(
                "INSERT INTO {}.{} ({})\nSELECT {}\nFROM {}.{}",
                quote_identifier_for_driver(dst_db, driver),
                quote_identifier_for_driver(dst_table, driver),
                insert_cols.join(", "),
                select_exprs.join(", "),
                quote_identifier_for_driver(src_db, driver),
                quote_identifier_for_driver(src_table, driver),
            )
        };

        // WHERE clause
        if let Some(where_cond) = where_clause {
            let trimmed = where_cond.trim();
            let cond = trimmed
                .strip_prefix("WHERE ")
                .or_else(|| trimmed.strip_prefix("where "))
                .unwrap_or(trimmed);
            sql.push_str(&format!("\nWHERE {}", cond));
        }

        sql
    }

    /// Combine an optional user-supplied filter with the PK range predicate for
    /// a single batched chunk. Returned as a bare expression (no `WHERE `
    /// prefix) so it can be passed directly as the `where_clause` argument of
    /// `build_direct_transfer_sql` — which does its own `WHERE ` normalization.
    ///
    /// - `None` end  → `pk >= start`          (last chunk, open upper bound)
    /// - `Some(e)`   → `pk >= start AND pk < e`
    ///
    /// The user filter is wrapped in parens to protect `OR` precedence from
    /// silently binding to the PK range clause.
    fn build_chunk_predicate(
        user_filter: Option<&str>,
        pk_col_quoted: &str,
        split: &PkSplit,
    ) -> String {
        let pk_range = match split.end {
            Some(end) => format!(
                "{pk} >= {start} AND {pk} < {end}",
                pk = pk_col_quoted,
                start = split.start,
                end = end,
            ),
            None => format!(
                "{pk} >= {start}",
                pk = pk_col_quoted,
                start = split.start,
            ),
        };

        match user_filter {
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    pk_range
                } else {
                    let stripped = trimmed
                        .strip_prefix("WHERE ")
                        .or_else(|| trimmed.strip_prefix("where "))
                        .unwrap_or(trimmed);
                    format!("({}) AND ({})", stripped, pk_range)
                }
            }
            None => pk_range,
        }
    }

    /// Execute direct transfer as a single server-side INSERT INTO ... SELECT.
    ///
    /// Used as the fallback when no integer PK is available for batching.
    /// The caller is expected to update `rows_read` / `rows_written` stats
    /// from the returned `DirectTransferResult` because `already_accounted`
    /// is `false` for this path.
    pub async fn execute(
        dst_ds: &dyn DataSource,
        config: &DirectTransferConfig,
        driver: &str,
    ) -> AppResult<DirectTransferResult> {
        let sql = Self::build_direct_transfer_sql(
            &config.src_db,
            &config.src_table,
            &config.dst_db,
            &config.dst_table,
            &config.column_mappings,
            config.where_clause.as_deref(),
            driver,
        );

        let start = std::time::Instant::now();

        let result = dst_ds.execute(&sql).await?;
        // For DML (INSERT...SELECT), drivers fill `row_count` with rows_affected.
        let rows_written = result.row_count as u64;

        let elapsed_ms = start.elapsed().as_millis() as u64;

        Ok(DirectTransferResult {
            rows_written,
            sql_executed: sql,
            elapsed_ms,
            chunk_count: 1,
            already_accounted: false,
        })
    }

    /// Execute direct transfer split into sequential PK-range chunks.
    ///
    /// Each chunk is an independent `INSERT INTO dst ... SELECT ... FROM src
    /// WHERE pk ∈ [s,e)` running in its own server-side transaction. After
    /// every successful chunk the `on_chunk_done` callback fires so the
    /// caller can drive pipeline stats — this is how the UI gets live
    /// progress instead of 0% → 100% on completion.
    ///
    /// Cancellation is checked both before each chunk and *during* each chunk
    /// via `tokio::select!`. A user cancel mid-chunk stops polling the exec
    /// future but does NOT cancel the server statement — callers should still
    /// treat the completed chunks as committed.
    ///
    /// Sets `already_accounted = true` on success so callers know the
    /// callback has already populated stats and a second accumulation would
    /// double-count.
    pub async fn execute_batched<F>(
        dst_ds: &dyn DataSource,
        config: &DirectTransferConfig,
        driver: &str,
        pk_col: &str,
        splits: &[PkSplit],
        cancel: &CancellationToken,
        on_chunk_done: F,
    ) -> Result<DirectTransferResult, BatchedError>
    where
        F: Fn(usize, u64),
    {
        let pk_col_quoted = quote_identifier_for_driver(pk_col, driver);
        let start = std::time::Instant::now();
        let mut rows_written: u64 = 0;
        let mut first_sql: Option<String> = None;

        for (i, split) in splits.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(BatchedError::Cancelled {
                    completed_chunks: i,
                    rows_written_so_far: rows_written,
                });
            }

            let predicate = Self::build_chunk_predicate(
                config.where_clause.as_deref(),
                &pk_col_quoted,
                split,
            );

            let sql = Self::build_direct_transfer_sql(
                &config.src_db,
                &config.src_table,
                &config.dst_db,
                &config.dst_table,
                &config.column_mappings,
                Some(&predicate),
                driver,
            );

            if first_sql.is_none() {
                first_sql = Some(sql.clone());
            }

            let exec_fut = dst_ds.execute(&sql);
            tokio::pin!(exec_fut);

            let res = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(BatchedError::Cancelled {
                        completed_chunks: i,
                        rows_written_so_far: rows_written,
                    });
                }
                r = &mut exec_fut => r,
            };

            match res {
                Ok(result) => {
                    let chunk_rows = result.row_count as u64;
                    rows_written = rows_written.saturating_add(chunk_rows);
                    on_chunk_done(i, chunk_rows);
                }
                Err(e) => {
                    return Err(BatchedError::SqlFailure {
                        chunk_index: i,
                        message: e.to_string(),
                        rows_written_so_far: rows_written,
                    });
                }
            }
        }

        let elapsed_ms = start.elapsed().as_millis() as u64;
        let sql_executed = match first_sql {
            Some(s) => format!("{} -- batched x {} chunks", s, splits.len()),
            None => String::new(),
        };

        Ok(DirectTransferResult {
            rows_written,
            sql_executed,
            elapsed_ms,
            chunk_count: splits.len() as u32,
            already_accounted: true,
        })
    }

    /// Exposed for unit tests only.
    #[cfg(test)]
    fn build_sql_for_test(
        src_db: &str,
        src_table: &str,
        dst_db: &str,
        dst_table: &str,
        column_mappings: &[ColumnMapping],
        where_clause: Option<&str>,
        driver: &str,
    ) -> String {
        Self::build_direct_transfer_sql(
            src_db, src_table, dst_db, dst_table,
            column_mappings, where_clause, driver,
        )
    }

    /// Exposed for unit tests only.
    #[cfg(test)]
    fn build_chunk_predicate_for_test(
        user_filter: Option<&str>,
        pk_col_quoted: &str,
        split: &PkSplit,
    ) -> String {
        Self::build_chunk_predicate(user_filter, pk_col_quoted, split)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cm(source_expr: &str, target_col: &str) -> ColumnMapping {
        ColumnMapping {
            source_expr: source_expr.into(),
            target_col: target_col.into(),
            target_type: "BIGINT".into(),
        }
    }

    fn build_batched_sql(
        user_filter: Option<&str>,
        pk_col: &str,
        split: &PkSplit,
        driver: &str,
    ) -> String {
        let pk_q = quote_identifier_for_driver(pk_col, driver);
        let predicate =
            DirectTransferExecutor::build_chunk_predicate_for_test(user_filter, &pk_q, split);
        let cols = vec![cm("*", "*")];
        DirectTransferExecutor::build_sql_for_test(
            "src_db", "src_t", "dst_db", "dst_t",
            &cols, Some(&predicate), driver,
        )
    }

    #[test]
    fn wildcard_mapping_produces_select_star() {
        let cols = vec![cm("*", "*")];
        let sql = DirectTransferExecutor::build_sql_for_test(
            "src_db", "src_t", "dst_db", "dst_t",
            &cols, None, "mysql",
        );
        assert!(sql.contains("INSERT INTO `dst_db`.`dst_t`\nSELECT *"));
        assert!(sql.contains("FROM `src_db`.`src_t`"));
        assert!(!sql.contains("WHERE"));
    }

    /// Regression: the compiler emits `column_mappings = []` for `MAPPING(*)`.
    /// Empty slice must also produce `SELECT *`, otherwise we generate an
    /// invalid `SELECT  FROM ...`.
    #[test]
    fn empty_column_mappings_produces_select_star() {
        let cols: Vec<ColumnMapping> = vec![];
        let sql = DirectTransferExecutor::build_sql_for_test(
            "src_db", "src_t", "dst_db", "dst_t",
            &cols, None, "mysql",
        );
        assert!(
            sql.contains("INSERT INTO `dst_db`.`dst_t`\nSELECT *"),
            "expected SELECT *, got: {sql}"
        );
        assert!(sql.contains("FROM `src_db`.`src_t`"));
    }

    #[test]
    fn simple_column_rename_emits_explicit_list() {
        let cols = vec![cm("a_src", "a_dst"), cm("b_src", "b_dst")];
        let sql = DirectTransferExecutor::build_sql_for_test(
            "src_db", "src_t", "dst_db", "dst_t",
            &cols, None, "mysql",
        );
        assert!(sql.contains("INSERT INTO `dst_db`.`dst_t` (`a_dst`, `b_dst`)"));
        assert!(sql.contains("SELECT a_src, b_src"));
    }

    #[test]
    fn expression_mapping_passes_through_source_expr() {
        let cols = vec![cm("UPPER(name)", "name_upper")];
        let sql = DirectTransferExecutor::build_sql_for_test(
            "src_db", "src_t", "dst_db", "dst_t",
            &cols, None, "mysql",
        );
        assert!(sql.contains("(`name_upper`)"));
        assert!(sql.contains("SELECT UPPER(name)"));
    }

    #[test]
    fn where_clause_prefix_is_stripped() {
        let cols = vec![cm("id", "id")];
        let with_prefix = DirectTransferExecutor::build_sql_for_test(
            "s", "t1", "d", "t2",
            &cols, Some("WHERE id > 100"), "mysql",
        );
        let without_prefix = DirectTransferExecutor::build_sql_for_test(
            "s", "t1", "d", "t2",
            &cols, Some("id > 100"), "mysql",
        );
        assert!(with_prefix.ends_with("\nWHERE id > 100"));
        assert!(without_prefix.ends_with("\nWHERE id > 100"));
    }

    #[test]
    fn postgres_driver_uses_double_quotes() {
        let cols = vec![cm("id", "id")];
        let sql = DirectTransferExecutor::build_sql_for_test(
            "src", "t", "dst", "t", &cols, None, "postgres",
        );
        assert!(sql.contains("\"dst\".\"t\""));
        assert!(sql.contains("\"src\".\"t\""));
    }

    // ── Batched SQL tests (tests 1-4 from plan) ───────────────────────────

    /// Plan test 1: splits `[(0, Some(100)), (100, None)]`, no filter.
    /// Middle chunk uses bounded range, last chunk uses open upper bound.
    #[test]
    fn batched_sql_no_user_filter_middle_chunk() {
        let chunk0 = build_batched_sql(
            None, "id",
            &PkSplit { start: 0, end: Some(100) },
            "mysql",
        );
        assert!(
            chunk0.ends_with("\nWHERE `id` >= 0 AND `id` < 100"),
            "chunk 0 should have bounded PK range, got: {chunk0}"
        );

        let chunk1 = build_batched_sql(
            None, "id",
            &PkSplit { start: 100, end: None },
            "mysql",
        );
        assert!(
            chunk1.ends_with("\nWHERE `id` >= 100"),
            "chunk 1 should have open upper bound, got: {chunk1}"
        );
    }

    /// Plan test 2: filter `"status = 'ACTIVE'"` + range `(0, Some(50))` produces
    /// `WHERE (status = 'ACTIVE') AND (`id` >= 0 AND `id` < 50)`.
    #[test]
    fn batched_sql_with_user_filter() {
        let sql = build_batched_sql(
            Some("status = 'ACTIVE'"),
            "id",
            &PkSplit { start: 0, end: Some(50) },
            "mysql",
        );
        assert!(
            sql.ends_with("\nWHERE (status = 'ACTIVE') AND (`id` >= 0 AND `id` < 50)"),
            "got: {sql}"
        );
    }

    /// Plan test 3: filter `"WHERE status=1"` still produces a single `WHERE`
    /// and preserves parens wrapping.
    #[test]
    fn batched_sql_strips_user_where_prefix() {
        let sql = build_batched_sql(
            Some("WHERE status=1"),
            "id",
            &PkSplit { start: 0, end: Some(10) },
            "mysql",
        );
        // Exactly one `WHERE` in the generated SQL.
        assert_eq!(sql.matches("WHERE").count(), 1, "got: {sql}");
        assert!(
            sql.ends_with("\nWHERE (status=1) AND (`id` >= 0 AND `id` < 10)"),
            "got: {sql}"
        );
    }

    /// Plan test 4: driver `"postgres"` quotes `pk_col` with double quotes.
    #[test]
    fn batched_sql_postgres_quotes_pk_col() {
        let sql = build_batched_sql(
            None, "id",
            &PkSplit { start: 0, end: Some(10) },
            "postgres",
        );
        assert!(
            sql.ends_with("\nWHERE \"id\" >= 0 AND \"id\" < 10"),
            "postgres should use double quotes, got: {sql}"
        );
    }
}
