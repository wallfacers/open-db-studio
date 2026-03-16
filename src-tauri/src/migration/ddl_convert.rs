use crate::datasource::ColumnMeta;
use serde::{Deserialize, Serialize};

/// 类型覆盖条目（用户手动设置的优先级最高）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeOverride {
    pub column: String,
    pub target_type: String,
}

/// 把源方言的单列类型转换为目标方言的等效类型
/// src_dialect / dst_dialect: "mysql" | "postgres" | "oracle" | "sqlserver"
pub fn convert_type(src_dialect: &str, dst_dialect: &str, src_type: &str) -> String {
    // B2 Task 实现
    let _ = (src_dialect, dst_dialect);
    src_type.to_string()
}

/// 将源列列表转换为目标方言的建表 DDL 片段
pub fn convert_columns(
    src_dialect: &str,
    dst_dialect: &str,
    columns: &[ColumnMeta],
    overrides: &[TypeOverride],
) -> String {
    // B2 Task 实现
    let _ = (src_dialect, dst_dialect, columns, overrides);
    String::new()
}
