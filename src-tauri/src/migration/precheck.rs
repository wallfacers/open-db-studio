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
    pub task_id: i64,
    pub items: Vec<CheckItem>,
    pub has_errors: bool,
    pub has_warnings: bool,
}

fn save_check_items(task_id: i64, items: &[CheckItem]) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute("DELETE FROM migration_checks WHERE task_id=?1", [task_id])?;
    for item in items {
        conn.execute(
            "INSERT INTO migration_checks (task_id,check_type,table_name,column_name,severity,message)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                task_id, item.check_type, item.table_name,
                item.column_name, item.severity, item.message
            ],
        )?;
    }
    Ok(())
}

pub async fn run_precheck(task_id: i64) -> AppResult<PreCheckResult> {
    let task = super::task_mgr::get_task(task_id)?;
    let src_config = crate::db::get_connection_config(task.src_connection_id)?;
    let dst_config = crate::db::get_connection_config(task.dst_connection_id)?;
    let src_ds = crate::datasource::create_datasource(&src_config).await?;

    let mut all_items = Vec::new();

    for table_cfg in &task.config.tables {
        // 注意：get_columns 签名是 (&self, table: &str, schema: Option<&str>)
        let src_cols = src_ds.get_columns(&table_cfg.src_table, None).await
            .unwrap_or_default();

        if src_cols.is_empty() {
            all_items.push(CheckItem {
                check_type: "other".into(),
                table_name: table_cfg.src_table.clone(),
                column_name: None,
                severity: "error".into(),
                message: format!("源表 {} 不存在或无字段", table_cfg.src_table),
            });
            continue;
        }

        // 1. 类型兼容性检查
        let type_issues = super::ddl_convert::check_type_compatibility(
            &src_config.driver, &dst_config.driver,
            &table_cfg.src_table, &src_cols,
        );
        all_items.extend(type_issues);

        // 2. NOT NULL 约束检查
        for col in &src_cols {
            if !col.is_nullable && col.column_default.is_none() && !col.is_primary_key {
                all_items.push(CheckItem {
                    check_type: "null_constraint".into(),
                    table_name: table_cfg.src_table.clone(),
                    column_name: Some(col.name.clone()),
                    severity: "info".into(),
                    message: format!("字段 {} 为 NOT NULL 且无默认值，请确保源数据无空值", col.name),
                });
            }
        }

        // 3. 主键检查
        let has_pk = src_cols.iter().any(|c| c.is_primary_key);
        if !has_pk {
            all_items.push(CheckItem {
                check_type: "pk_conflict".into(),
                table_name: table_cfg.src_table.clone(),
                column_name: None,
                severity: "warning".into(),
                message: "源表无主键，迁移时可能产生重复数据".into(),
            });
        }
    }

    save_check_items(task_id, &all_items)?;

    let has_errors = all_items.iter().any(|i| i.severity == "error");
    let has_warnings = all_items.iter().any(|i| i.severity == "warning");
    Ok(PreCheckResult { task_id, items: all_items, has_errors, has_warnings })
}

pub fn get_precheck_result(task_id: i64) -> AppResult<PreCheckResult> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT check_type,table_name,column_name,severity,message
         FROM migration_checks WHERE task_id=?1 ORDER BY severity DESC, table_name"
    )?;
    let items: Vec<CheckItem> = stmt.query_map([task_id], |row| {
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
    Ok(PreCheckResult { task_id, items, has_errors, has_warnings })
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
