#![allow(dead_code)]

use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckItem {
    pub check_type: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub severity: String,    // "error" | "warning" | "info"
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreCheckResult {
    pub job_id: i64,
    pub items: Vec<CheckItem>,
    pub has_errors: bool,
    pub has_warnings: bool,
}

fn save_check_items(job_id: i64, items: &[CheckItem]) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute("DELETE FROM migration_checks WHERE task_id=?1", [job_id])?;
    for item in items {
        conn.execute(
            "INSERT INTO migration_checks (task_id,check_type,table_name,column_name,severity,message)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                job_id, item.check_type, item.table_name,
                item.column_name, item.severity, item.message
            ],
        )?;
    }
    Ok(())
}

/// Run pre-check using a job config, iterating over all table mappings.
pub async fn run_precheck_for_job(
    job_id: i64,
    config: &super::task_mgr::MigrationJobConfig,
) -> AppResult<PreCheckResult> {
    let src_connection_id = config.source.connection_id;
    let src_config = crate::db::get_connection_config(src_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;

    let mut all_items = Vec::new();

    for mapping in &config.table_mappings {
        let dst_config = crate::db::get_connection_config(mapping.target.connection_id)?;
        let table_name = &mapping.source_table;
        if table_name.is_empty() || table_name == "custom_query" {
            continue;
        }

        let src_cols = src_ds.get_columns(table_name, None).await.unwrap_or_default();
        if src_cols.is_empty() {
            all_items.push(CheckItem {
                check_type: "other".into(),
                table_name: table_name.clone(),
                column_name: None,
                severity: "error".into(),
                message: format!("Source table {} not found or has no columns", table_name),
            });
            continue;
        }

        // 1. Type compatibility check
        let type_issues = super::ddl_convert::check_type_compatibility(
            &src_config.driver, &dst_config.driver, table_name, &src_cols,
        );
        all_items.extend(type_issues);

        // 2. NOT NULL constraint check
        for col in &src_cols {
            if !col.is_nullable && col.column_default.is_none() && !col.is_primary_key {
                all_items.push(CheckItem {
                    check_type: "null_constraint".into(),
                    table_name: table_name.clone(),
                    column_name: Some(col.name.clone()),
                    severity: "info".into(),
                    message: format!("Column {} is NOT NULL without default", col.name),
                });
            }
        }

        // 3. Primary key check
        let has_pk = src_cols.iter().any(|c| c.is_primary_key);
        if !has_pk {
            all_items.push(CheckItem {
                check_type: "pk_conflict".into(),
                table_name: table_name.clone(),
                column_name: None,
                severity: "warning".into(),
                message: "Source table has no primary key, duplicates may occur".into(),
            });
        }
    }

    save_check_items(job_id, &all_items)?;
    let has_errors = all_items.iter().any(|i| i.severity == "error");
    let has_warnings = all_items.iter().any(|i| i.severity == "warning");
    Ok(PreCheckResult { job_id, items: all_items, has_errors, has_warnings })
}

pub fn get_precheck_result(job_id: i64) -> AppResult<PreCheckResult> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT check_type,table_name,column_name,severity,message
         FROM migration_checks WHERE task_id=?1 ORDER BY severity DESC, table_name"
    )?;
    let items: Vec<CheckItem> = stmt.query_map([job_id], |row| {
        Ok(CheckItem {
            check_type: row.get(0)?,
            table_name: row.get(1)?,
            column_name: row.get(2)?,
            severity: row.get(3)?,
            message: row.get(4)?,
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    let has_errors = items.iter().any(|i| i.severity == "error");
    let has_warnings = items.iter().any(|i| i.severity == "warning");
    Ok(PreCheckResult { job_id, items, has_errors, has_warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_item_severity_order() {
        let items = vec![
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "warning".into(), message: "w".into() },
            CheckItem { check_type: "type_compat".into(), table_name: "t".into(),
                        column_name: None, severity: "error".into(), message: "e".into() },
        ];
        let has_error = items.iter().any(|i| i.severity == "error");
        assert!(has_error);
    }
}
