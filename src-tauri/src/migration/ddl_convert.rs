use crate::datasource::ColumnMeta;

/// 将 src_driver 的类型名转换为 dst_driver 的类型名
#[allow(dead_code)]
pub fn convert_type(src_driver: &str, dst_driver: &str, src_type: &str) -> String {
    let normalized = src_type.to_uppercase();
    let base = normalized.split('(').next().unwrap_or(&normalized).trim();

    match (src_driver, dst_driver, base) {
        // ⚠️ TINYINT(1) 必须在 TINYINT 之前
        ("mysql", "postgres", "TINYINT") if src_type.to_uppercase().contains("(1)") => "BOOLEAN".into(),
        // MySQL → PostgreSQL
        ("mysql", "postgres", "INT") | ("mysql", "postgres", "INTEGER") => "INTEGER".into(),
        ("mysql", "postgres", "TINYINT") => "SMALLINT".into(),
        ("mysql", "postgres", "BIGINT") => "BIGINT".into(),
        ("mysql", "postgres", "FLOAT") => "REAL".into(),
        ("mysql", "postgres", "DOUBLE") => "DOUBLE PRECISION".into(),
        ("mysql", "postgres", "DECIMAL") | ("mysql", "postgres", "NUMERIC") => src_type.to_uppercase(),
        ("mysql", "postgres", "TEXT") | ("mysql", "postgres", "LONGTEXT")
        | ("mysql", "postgres", "MEDIUMTEXT") | ("mysql", "postgres", "TINYTEXT") => "TEXT".into(),
        ("mysql", "postgres", "DATETIME") => "TIMESTAMP".into(),
        ("mysql", "postgres", "TIMESTAMP") => "TIMESTAMPTZ".into(),
        ("mysql", "postgres", "DATE") => "DATE".into(),
        ("mysql", "postgres", "TIME") => "TIME".into(),
        ("mysql", "postgres", "BLOB") | ("mysql", "postgres", "LONGBLOB")
        | ("mysql", "postgres", "MEDIUMBLOB") | ("mysql", "postgres", "TINYBLOB") => "BYTEA".into(),
        ("mysql", "postgres", "JSON") => "JSONB".into(),
        ("mysql", "postgres", "ENUM") | ("mysql", "postgres", "SET") => "TEXT".into(),
        // PostgreSQL → MySQL
        ("postgres", "mysql", "INTEGER") | ("postgres", "mysql", "INT4") => "INT".into(),
        ("postgres", "mysql", "BIGINT") | ("postgres", "mysql", "INT8") => "BIGINT".into(),
        ("postgres", "mysql", "SMALLINT") | ("postgres", "mysql", "INT2") => "SMALLINT".into(),
        ("postgres", "mysql", "REAL") | ("postgres", "mysql", "FLOAT4") => "FLOAT".into(),
        ("postgres", "mysql", "DOUBLE PRECISION") | ("postgres", "mysql", "FLOAT8") => "DOUBLE".into(),
        ("postgres", "mysql", "BOOLEAN") | ("postgres", "mysql", "BOOL") => "TINYINT(1)".into(),
        ("postgres", "mysql", "TEXT") => "LONGTEXT".into(),
        ("postgres", "mysql", "BYTEA") => "LONGBLOB".into(),
        ("postgres", "mysql", "JSONB") | ("postgres", "mysql", "JSON") => "JSON".into(),
        ("postgres", "mysql", "TIMESTAMP") | ("postgres", "mysql", "TIMESTAMPTZ") => "DATETIME".into(),
        ("postgres", "mysql", "UUID") => "CHAR(36)".into(),
        ("postgres", "mysql", "SERIAL") => "INT AUTO_INCREMENT".into(),
        ("postgres", "mysql", "BIGSERIAL") => "BIGINT AUTO_INCREMENT".into(),
        // MySQL → SQLServer
        ("mysql", "sqlserver", "INT") | ("mysql", "sqlserver", "INTEGER") => "INT".into(),
        ("mysql", "sqlserver", "BIGINT") => "BIGINT".into(),
        ("mysql", "sqlserver", "TINYINT") => "TINYINT".into(),
        ("mysql", "sqlserver", "FLOAT") | ("mysql", "sqlserver", "DOUBLE") => "FLOAT".into(),
        ("mysql", "sqlserver", "DATETIME") | ("mysql", "sqlserver", "TIMESTAMP") => "DATETIME2".into(),
        ("mysql", "sqlserver", "TEXT") | ("mysql", "sqlserver", "LONGTEXT") => "NVARCHAR(MAX)".into(),
        ("mysql", "sqlserver", "JSON") => "NVARCHAR(MAX)".into(),
        ("mysql", "sqlserver", "BLOB") | ("mysql", "sqlserver", "LONGBLOB") => "VARBINARY(MAX)".into(),
        // PostgreSQL → SQLServer
        ("postgres", "sqlserver", "INTEGER") | ("postgres", "sqlserver", "INT4") => "INT".into(),
        ("postgres", "sqlserver", "BIGINT") => "BIGINT".into(),
        ("postgres", "sqlserver", "BOOLEAN") | ("postgres", "sqlserver", "BOOL") => "BIT".into(),
        ("postgres", "sqlserver", "TEXT") => "NVARCHAR(MAX)".into(),
        ("postgres", "sqlserver", "BYTEA") => "VARBINARY(MAX)".into(),
        ("postgres", "sqlserver", "TIMESTAMP") | ("postgres", "sqlserver", "TIMESTAMPTZ") => "DATETIME2".into(),
        ("postgres", "sqlserver", "JSONB") | ("postgres", "sqlserver", "JSON") => "NVARCHAR(MAX)".into(),
        // 同构或未知：原样保留
        _ => src_type.to_uppercase(),
    }
}

/// 生成目标表的 CREATE TABLE DDL
#[allow(dead_code)]
pub fn generate_create_table_ddl(
    src_driver: &str,
    dst_driver: &str,
    table_name: &str,
    columns: &[ColumnMeta],
    type_overrides: &std::collections::HashMap<String, String>,
) -> String {
    let mut lines = Vec::new();
    let mut pk_cols = Vec::new();

    for col in columns {
        let dst_type = if let Some(override_type) = type_overrides.get(&col.name) {
            override_type.clone()
        } else {
            convert_type(src_driver, dst_driver, &col.data_type)
        };
        let nullable = if col.is_nullable { "" } else { " NOT NULL" };
        let default = col.column_default.as_deref()
            .map(|d| format!(" DEFAULT {}", d))
            .unwrap_or_default();
        lines.push(format!("    {} {}{}{}", col.name, dst_type, nullable, default));
        if col.is_primary_key {
            pk_cols.push(col.name.clone());
        }
    }
    if !pk_cols.is_empty() {
        lines.push(format!("    PRIMARY KEY ({})", pk_cols.join(", ")));
    }
    format!("CREATE TABLE IF NOT EXISTS {} (\n{}\n);", table_name, lines.join(",\n"))
}

/// 检测类型映射兼容性问题（供 precheck 调用）
pub fn check_type_compatibility(
    src_driver: &str,
    dst_driver: &str,
    table_name: &str,
    columns: &[ColumnMeta],
) -> Vec<super::precheck::CheckItem> {
    let problematic = [
        ("mysql",    "postgres",  "ENUM",  "warning", "ENUM 将转换为 TEXT，丢失约束"),
        ("mysql",    "postgres",  "SET",   "warning", "SET 将转换为 TEXT，丢失约束"),
        ("mysql",    "postgres",  "TINYINT","info",   "TINYINT 转为 SMALLINT，注意范围差异"),
        ("postgres", "mysql",     "UUID",  "warning", "UUID 转为 CHAR(36)，性能可能下降"),
        ("postgres", "mysql",     "ARRAY", "error",   "MySQL 不支持 ARRAY 类型"),
        ("postgres", "mysql",     "JSONB", "warning", "JSONB 转为 JSON，丢失 GIN 索引特性"),
    ];
    let mut issues = Vec::new();
    for col in columns {
        let base = col.data_type.to_uppercase();
        let base = base.split('(').next().unwrap_or(&base).trim();
        for (src, dst, t, severity, msg) in &problematic {
            if src_driver == *src && dst_driver == *dst && base == *t {
                issues.push(super::precheck::CheckItem {
                    check_type: "type_compat".into(),
                    table_name: table_name.into(),
                    column_name: Some(col.name.clone()),
                    severity: severity.to_string(),
                    message: msg.to_string(),
                });
            }
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mysql_to_pg_int() {
        assert_eq!(convert_type("mysql", "postgres", "INT"), "INTEGER");
    }

    #[test]
    fn test_mysql_to_pg_datetime() {
        assert_eq!(convert_type("mysql", "postgres", "DATETIME"), "TIMESTAMP");
    }

    #[test]
    fn test_pg_to_mysql_boolean() {
        assert_eq!(convert_type("postgres", "mysql", "BOOLEAN"), "TINYINT(1)");
    }

    #[test]
    fn test_unknown_type_passthrough() {
        assert_eq!(convert_type("mysql", "postgres", "JSONB"), "JSONB");
    }

    #[test]
    fn test_generate_ddl_basic() {
        use crate::datasource::ColumnMeta;
        let cols = vec![
            ColumnMeta { name: "id".into(), data_type: "INT".into(), is_nullable: false,
                         column_default: None, is_primary_key: true, extra: None },
            ColumnMeta { name: "name".into(), data_type: "VARCHAR(255)".into(), is_nullable: true,
                         column_default: None, is_primary_key: false, extra: None },
        ];
        let ddl = generate_create_table_ddl(
            "mysql", "postgres", "users", &cols, &Default::default()
        );
        assert!(ddl.contains("CREATE TABLE IF NOT EXISTS users"));
        assert!(ddl.contains("PRIMARY KEY"));
    }
}
