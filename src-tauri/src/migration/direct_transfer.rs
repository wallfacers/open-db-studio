use crate::datasource::DataSource;
use crate::datasource::utils::quote_identifier_for_driver;
use crate::error::AppResult;
use crate::migration::task_mgr::ColumnMapping;

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
    pub sql_executed: String,
    pub elapsed_ms: u64,
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
        // If any mapping is a wildcard `*`, degrade to `SELECT *` + no explicit column list.
        // Servers handle column-count/order matching themselves when the target has identical shape.
        let is_wildcard = column_mappings
            .iter()
            .any(|m| m.source_expr.trim() == "*");

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

    /// Execute direct transfer.
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
}
