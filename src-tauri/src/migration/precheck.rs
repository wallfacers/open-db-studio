use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum CheckSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckItem {
    pub check_type: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub severity: CheckSeverity,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PreCheckResult {
    pub task_id: i64,
    pub items: Vec<CheckItem>,
    pub has_error: bool,
}

/// 运行迁移预检：类型兼容性、NULL 约束、PK 冲突等
pub async fn run_precheck(task_id: i64) -> AppResult<PreCheckResult> {
    // B2 Task 实现
    let _ = task_id;
    Ok(PreCheckResult { task_id, items: vec![], has_error: false })
}

/// 将预检结果持久化到 migration_checks 表
pub fn save_precheck_results(task_id: i64, items: &[CheckItem]) -> AppResult<()> {
    // B2 Task 实现
    let _ = (task_id, items);
    Ok(())
}
