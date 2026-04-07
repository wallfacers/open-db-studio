use std::collections::{HashMap, HashSet};

use crate::AppResult;
use crate::error::AppError;
use super::models::{ErColumn, ErIndex, ErProject, ErRelation, ErTable};
use super::constraint::{
    append_marker_to_comment, build_comment_marker,
    resolve_comment_format, resolve_constraint_method,
};
use super::table_sorter::sort_tables_by_dependency;

// ---------------------------------------------------------------------------
// GenerateOptions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub include_indexes: bool,
    pub include_comments: bool,
    pub include_foreign_keys: bool,
    pub include_comment_refs: bool,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            include_indexes: true,
            include_comments: true,
            include_foreign_keys: false,
            include_comment_refs: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Resolved FK info passed into dialect helpers
// ---------------------------------------------------------------------------

struct ResolvedFk<'a> {
    relation: &'a ErRelation,
    source_col_name: String,
    target_table_name: String,
    target_col_name: String,
}

// ---------------------------------------------------------------------------
// DdlDialect trait
// ---------------------------------------------------------------------------

pub trait DdlDialect {
    fn create_table(
        &self,
        table: &ErTable,
        columns: &[ErColumn],
        indexes: &[ErIndex],
        relations: &[ErRelation],
        all_tables: &[ErTable],
        all_columns_map: &HashMap<i64, Vec<ErColumn>>,
        options: &GenerateOptions,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();
        let quoted_table = self.quote_identifier(&table.name);

        // --- Column definitions ---
        let mut col_defs: Vec<String> = Vec::new();
        for col in columns {
            let mut def = format!("  {} {}", self.quote_identifier(&col.name), self.map_column_type(col));
            if col.unsigned {
                def.push_str(" UNSIGNED");
            }
            if !col.nullable {
                def.push_str(" NOT NULL");
            }
            if col.is_auto_increment {
                let ai = self.auto_increment_syntax();
                if !ai.is_empty() {
                    def.push_str(" ");
                    def.push_str(ai);
                }
            }
            if col.is_unique {
                def.push_str(" UNIQUE");
            }
            if let Some(ref dv) = col.default_value {
                if !dv.is_empty() {
                    def.push_str(&format!(" DEFAULT {}", dv));
                }
            }
            if let Some(ref ou) = col.on_update {
                if !ou.is_empty() {
                    def.push_str(&format!(" ON UPDATE {}", ou));
                }
            }
            // Inline column comment for MySQL
            if options.include_comments {
                if let Some(extra) = self.inline_column_comment(col) {
                    def.push_str(&extra);
                }
            }
            col_defs.push(def);
        }

        // --- PRIMARY KEY constraint ---
        let pk_cols: Vec<&ErColumn> = columns.iter().filter(|c| c.is_primary_key).collect();
        if !pk_cols.is_empty() {
            col_defs.push(self.primary_key_syntax(&pk_cols));
        }

        // --- FOREIGN KEY constraints ---
        if options.include_foreign_keys {
            let fks = resolve_fks(table, relations, all_tables, all_columns_map);
            for fk in &fks {
                col_defs.push(self.foreign_key_syntax(
                    fk.relation,
                    &fk.source_col_name,
                    &fk.target_table_name,
                    &fk.target_col_name,
                ));
            }
        }

        // --- CREATE TABLE ---
        let stmt = format!("CREATE TABLE {} (\n{}\n){};",
            quoted_table,
            col_defs.join(",\n"),
            self.table_suffix(table),
        );
        parts.push(stmt);

        // --- Indexes ---
        if options.include_indexes {
            for idx in indexes {
                let idx_stmt = self.index_syntax(&table.name, idx);
                if !idx_stmt.is_empty() {
                    parts.push(idx_stmt);
                }
            }
        }

        // --- Comments (post-table) ---
        if options.include_comments {
            if let Some(ref comment) = table.comment {
                if !comment.is_empty() {
                    let stmts = self.comment_syntax(&table.name, None, comment);
                    parts.extend(stmts);
                }
            }
            for col in columns {
                if let Some(ref comment) = col.comment {
                    if !comment.is_empty() {
                        let stmts = self.comment_syntax(&table.name, Some(&col.name), comment);
                        parts.extend(stmts);
                    }
                }
            }
        }

        parts.join("\n\n")
    }

    fn map_type(&self, generic_type: &str) -> String;

    /// Map a column to its dialect-specific type, considering length/scale.
    fn map_column_type(&self, col: &ErColumn) -> String {
        let base = self.map_type(&col.data_type);
        match (col.length, col.scale) {
            (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
            (Some(l), None)    => format!("{}({})", base, l),
            _                  => base,
        }
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String;
    fn auto_increment_syntax(&self) -> &str;
    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String;
    fn foreign_key_syntax(
        &self,
        relation: &ErRelation,
        source_col: &str,
        target_table: &str,
        target_col: &str,
    ) -> String;
    fn comment_syntax(
        &self,
        table_name: &str,
        column_name: Option<&str>,
        comment: &str,
    ) -> Vec<String>;
    fn quote_identifier(&self, name: &str) -> String;

    /// Optional inline column comment (used by MySQL).
    fn inline_column_comment(&self, _col: &ErColumn) -> Option<String> {
        None
    }

    /// Optional table suffix (e.g. MySQL ENGINE clause).
    fn table_suffix(&self, _table: &ErTable) -> String {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Helper: parse generic type like "VARCHAR(255)" or "DECIMAL(10,2)"
// ---------------------------------------------------------------------------

fn map_type_with(generic_type: &str, mapper: &dyn Fn(&str) -> &str) -> String {
    let upper = generic_type.to_uppercase();
    mapper(&upper).to_string()
}

// ---------------------------------------------------------------------------
// Helper: resolve foreign keys
// ---------------------------------------------------------------------------

fn resolve_fks<'a>(
    table: &ErTable,
    relations: &'a [ErRelation],
    all_tables: &[ErTable],
    all_columns_map: &HashMap<i64, Vec<ErColumn>>,
) -> Vec<ResolvedFk<'a>> {
    let mut out = Vec::new();
    for rel in relations {
        if rel.source_table_id != table.id {
            continue;
        }
        // Find source column name
        let src_col_name = all_columns_map
            .get(&rel.source_table_id)
            .and_then(|cols| cols.iter().find(|c| c.id == rel.source_column_id))
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("col_{}", rel.source_column_id));
        // Find target table name
        let tgt_table_name = all_tables
            .iter()
            .find(|t| t.id == rel.target_table_id)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| format!("table_{}", rel.target_table_id));
        // Find target column name
        let tgt_col_name = all_columns_map
            .get(&rel.target_table_id)
            .and_then(|cols| cols.iter().find(|c| c.id == rel.target_column_id))
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("col_{}", rel.target_column_id));

        out.push(ResolvedFk {
            relation: rel,
            source_col_name: src_col_name,
            target_table_name: tgt_table_name,
            target_col_name: tgt_col_name,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Helper: parse index columns JSON
// ---------------------------------------------------------------------------

fn parse_index_columns(json_str: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json_str).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Helper: escape single quotes in comments
// ---------------------------------------------------------------------------

fn escape_comment(s: &str) -> String {
    s.replace('\'', "''")
}

// ===========================================================================
// MySQL Dialect
// ===========================================================================

pub struct MySqlDialect;

impl DdlDialect for MySqlDialect {
    fn map_type(&self, generic_type: &str) -> String {
        map_type_with(generic_type, &|base| match base {
            "BIGINT" => "BIGINT",
            "VARCHAR" => "VARCHAR",
            "TEXT" => "TEXT",
            "DATETIME" => "DATETIME",
            "BOOLEAN" => "TINYINT(1)",
            "DECIMAL" => "DECIMAL",
            "INT" | "INTEGER" => "INT",
            "SMALLINT" => "SMALLINT",
            "TINYINT" => "TINYINT",
            "FLOAT" => "FLOAT",
            "DOUBLE" => "DOUBLE",
            "DATE" => "DATE",
            "TIME" => "TIME",
            "TIMESTAMP" => "TIMESTAMP",
            "BLOB" => "BLOB",
            "JSON" => "JSON",
            other => other,
        })
    }

    fn map_column_type(&self, col: &ErColumn) -> String {
        let upper = col.data_type.to_uppercase();
        if upper == "ENUM" || upper == "SET" {
            if let Some(ref ev) = col.enum_values {
                if let Ok(vals) = serde_json::from_str::<Vec<String>>(ev) {
                    let quoted: Vec<String> = vals.iter().map(|v| format!("'{}'", v)).collect();
                    return format!("{}({})", upper, quoted.join(","));
                }
            }
            return upper;
        }
        let base = self.map_type(&col.data_type);
        match (col.length, col.scale) {
            (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
            (Some(l), None)    => format!("{}({})", base, l),
            _                  => base,
        }
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String {
        let cols: Vec<String> = pk_columns.iter().map(|c| self.quote_identifier(&c.name)).collect();
        format!("  PRIMARY KEY ({})", cols.join(", "))
    }

    fn auto_increment_syntax(&self) -> &str { "AUTO_INCREMENT" }

    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String {
        let cols = parse_index_columns(&index.columns);
        if cols.is_empty() { return String::new(); }
        let quoted_cols: Vec<String> = cols.iter().map(|c| self.quote_identifier(c)).collect();
        let unique = if index.index_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX {} ON {} ({});",
            unique,
            self.quote_identifier(&index.name),
            self.quote_identifier(table_name),
            quoted_cols.join(", "),
        )
    }

    fn foreign_key_syntax(&self, relation: &ErRelation, source_col: &str, target_table: &str, target_col: &str) -> String {
        let name = relation.name.as_deref().unwrap_or("fk");
        format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            self.quote_identifier(name),
            self.quote_identifier(source_col),
            self.quote_identifier(target_table),
            self.quote_identifier(target_col),
            relation.on_delete,
            relation.on_update,
        )
    }

    fn comment_syntax(&self, table_name: &str, column_name: Option<&str>, comment: &str) -> Vec<String> {
        match column_name {
            // Column comments handled inline; no post-table statement needed.
            Some(_) => vec![],
            None => vec![format!(
                "ALTER TABLE {} COMMENT = '{}';",
                self.quote_identifier(table_name),
                escape_comment(comment),
            )],
        }
    }

    fn quote_identifier(&self, name: &str) -> String {
        format!("`{}`", name)
    }

    fn inline_column_comment(&self, col: &ErColumn) -> Option<String> {
        col.comment.as_ref().filter(|c| !c.is_empty()).map(|c| format!(" COMMENT '{}'", escape_comment(c)))
    }

    fn table_suffix(&self, _table: &ErTable) -> String {
        " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4".to_string()
    }
}

// ===========================================================================
// PostgreSQL Dialect
// ===========================================================================

pub struct PostgresDialect;

impl DdlDialect for PostgresDialect {
    fn map_type(&self, generic_type: &str) -> String {
        map_type_with(generic_type, &|base| match base {
            "BIGINT" => "BIGINT",
            "VARCHAR" => "VARCHAR",
            "TEXT" => "TEXT",
            "DATETIME" => "TIMESTAMP",
            "BOOLEAN" => "BOOLEAN",
            "DECIMAL" => "NUMERIC",
            "INT" | "INTEGER" => "INTEGER",
            "SMALLINT" => "SMALLINT",
            "TINYINT" => "SMALLINT",
            "FLOAT" => "REAL",
            "DOUBLE" => "DOUBLE PRECISION",
            "DATE" => "DATE",
            "TIME" => "TIME",
            "TIMESTAMP" => "TIMESTAMP",
            "BLOB" => "BYTEA",
            "JSON" => "JSONB",
            other => other,
        })
    }

    fn map_column_type(&self, col: &ErColumn) -> String {
        if col.is_auto_increment {
            let upper = col.data_type.to_uppercase();
            return match upper.as_str() {
                "BIGINT" => "BIGSERIAL".to_string(),
                "INT" | "INTEGER" => "SERIAL".to_string(),
                "SMALLINT" => "SMALLSERIAL".to_string(),
                _ => {
                    let base = self.map_type(&col.data_type);
                    match (col.length, col.scale) {
                        (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
                        (Some(l), None)    => format!("{}({})", base, l),
                        _                  => base,
                    }
                }
            };
        }
        let base = self.map_type(&col.data_type);
        match (col.length, col.scale) {
            (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
            (Some(l), None)    => format!("{}({})", base, l),
            _                  => base,
        }
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String {
        let cols: Vec<String> = pk_columns.iter().map(|c| self.quote_identifier(&c.name)).collect();
        format!("  PRIMARY KEY ({})", cols.join(", "))
    }

    fn auto_increment_syntax(&self) -> &str {
        // Postgres uses SERIAL types instead
        ""
    }

    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String {
        let cols = parse_index_columns(&index.columns);
        if cols.is_empty() { return String::new(); }
        let quoted_cols: Vec<String> = cols.iter().map(|c| self.quote_identifier(c)).collect();
        let unique = if index.index_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX {} ON {} ({});",
            unique,
            self.quote_identifier(&index.name),
            self.quote_identifier(table_name),
            quoted_cols.join(", "),
        )
    }

    fn foreign_key_syntax(&self, relation: &ErRelation, source_col: &str, target_table: &str, target_col: &str) -> String {
        let name = relation.name.as_deref().unwrap_or("fk");
        format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            self.quote_identifier(name),
            self.quote_identifier(source_col),
            self.quote_identifier(target_table),
            self.quote_identifier(target_col),
            relation.on_delete,
            relation.on_update,
        )
    }

    fn comment_syntax(&self, table_name: &str, column_name: Option<&str>, comment: &str) -> Vec<String> {
        match column_name {
            Some(col) => vec![format!(
                "COMMENT ON COLUMN {}.{} IS '{}';",
                self.quote_identifier(table_name),
                self.quote_identifier(col),
                escape_comment(comment),
            )],
            None => vec![format!(
                "COMMENT ON TABLE {} IS '{}';",
                self.quote_identifier(table_name),
                escape_comment(comment),
            )],
        }
    }

    fn quote_identifier(&self, name: &str) -> String {
        format!("\"{}\"", name)
    }
}

// ===========================================================================
// Oracle Dialect
// ===========================================================================

pub struct OracleDialect;

impl DdlDialect for OracleDialect {
    fn map_type(&self, generic_type: &str) -> String {
        map_type_with(generic_type, &|base| match base {
            "BIGINT" => "NUMBER(19)",
            "VARCHAR" => "VARCHAR2",
            "TEXT" => "CLOB",
            "DATETIME" => "TIMESTAMP",
            "BOOLEAN" => "NUMBER(1)",
            "DECIMAL" => "NUMBER",
            "INT" | "INTEGER" => "NUMBER(10)",
            "SMALLINT" => "NUMBER(5)",
            "TINYINT" => "NUMBER(3)",
            "FLOAT" => "BINARY_FLOAT",
            "DOUBLE" => "BINARY_DOUBLE",
            "DATE" => "DATE",
            "TIME" => "TIMESTAMP",
            "TIMESTAMP" => "TIMESTAMP",
            "BLOB" => "BLOB",
            "JSON" => "CLOB",
            other => other,
        })
    }

    fn map_column_type(&self, col: &ErColumn) -> String {
        let base = self.map_type(&col.data_type);
        let typed = match (col.length, col.scale) {
            (Some(l), Some(s)) => format!("{}({},{})", base, l, s),
            (Some(l), None)    => format!("{}({})", base, l),
            _                  => base,
        };
        if col.is_auto_increment {
            format!("{} GENERATED ALWAYS AS IDENTITY", typed)
        } else {
            typed
        }
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String {
        let cols: Vec<String> = pk_columns.iter().map(|c| self.quote_identifier(&c.name)).collect();
        format!("  PRIMARY KEY ({})", cols.join(", "))
    }

    fn auto_increment_syntax(&self) -> &str {
        // Handled in map_column_type
        ""
    }

    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String {
        let cols = parse_index_columns(&index.columns);
        if cols.is_empty() { return String::new(); }
        let quoted_cols: Vec<String> = cols.iter().map(|c| self.quote_identifier(c)).collect();
        let unique = if index.index_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX {} ON {} ({});",
            unique,
            self.quote_identifier(&index.name),
            self.quote_identifier(table_name),
            quoted_cols.join(", "),
        )
    }

    fn foreign_key_syntax(&self, relation: &ErRelation, source_col: &str, target_table: &str, target_col: &str) -> String {
        let name = relation.name.as_deref().unwrap_or("fk");
        format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {}",
            self.quote_identifier(name),
            self.quote_identifier(source_col),
            self.quote_identifier(target_table),
            self.quote_identifier(target_col),
            relation.on_delete,
        )
    }

    fn comment_syntax(&self, table_name: &str, column_name: Option<&str>, comment: &str) -> Vec<String> {
        match column_name {
            Some(col) => vec![format!(
                "COMMENT ON COLUMN {}.{} IS '{}';",
                self.quote_identifier(table_name),
                self.quote_identifier(col),
                escape_comment(comment),
            )],
            None => vec![format!(
                "COMMENT ON TABLE {} IS '{}';",
                self.quote_identifier(table_name),
                escape_comment(comment),
            )],
        }
    }

    fn quote_identifier(&self, name: &str) -> String {
        format!("\"{}\"", name)
    }
}

// ===========================================================================
// SQL Server Dialect
// ===========================================================================

pub struct SqlServerDialect;

impl DdlDialect for SqlServerDialect {
    fn map_type(&self, generic_type: &str) -> String {
        map_type_with(generic_type, &|base| match base {
            "BIGINT" => "BIGINT",
            "VARCHAR" => "NVARCHAR",
            "TEXT" => "NVARCHAR(MAX)",
            "DATETIME" => "DATETIME2",
            "BOOLEAN" => "BIT",
            "DECIMAL" => "DECIMAL",
            "INT" | "INTEGER" => "INT",
            "SMALLINT" => "SMALLINT",
            "TINYINT" => "TINYINT",
            "FLOAT" => "FLOAT",
            "DOUBLE" => "FLOAT(53)",
            "DATE" => "DATE",
            "TIME" => "TIME",
            "TIMESTAMP" => "DATETIME2",
            "BLOB" => "VARBINARY(MAX)",
            "JSON" => "NVARCHAR(MAX)",
            other => other,
        })
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String {
        let cols: Vec<String> = pk_columns.iter().map(|c| self.quote_identifier(&c.name)).collect();
        format!("  PRIMARY KEY ({})", cols.join(", "))
    }

    fn auto_increment_syntax(&self) -> &str { "IDENTITY(1,1)" }

    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String {
        let cols = parse_index_columns(&index.columns);
        if cols.is_empty() { return String::new(); }
        let quoted_cols: Vec<String> = cols.iter().map(|c| self.quote_identifier(c)).collect();
        let unique = if index.index_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX {} ON {} ({});",
            unique,
            self.quote_identifier(&index.name),
            self.quote_identifier(table_name),
            quoted_cols.join(", "),
        )
    }

    fn foreign_key_syntax(&self, relation: &ErRelation, source_col: &str, target_table: &str, target_col: &str) -> String {
        let name = relation.name.as_deref().unwrap_or("fk");
        format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            self.quote_identifier(name),
            self.quote_identifier(source_col),
            self.quote_identifier(target_table),
            self.quote_identifier(target_col),
            relation.on_delete,
            relation.on_update,
        )
    }

    fn comment_syntax(&self, table_name: &str, column_name: Option<&str>, comment: &str) -> Vec<String> {
        let escaped = escape_comment(comment);
        match column_name {
            Some(col) => vec![format!(
                "EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'{}', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'{}', @level2type = N'COLUMN', @level2name = N'{}';",
                escaped, table_name, col,
            )],
            None => vec![format!(
                "EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'{}', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'{}';",
                escaped, table_name,
            )],
        }
    }

    fn quote_identifier(&self, name: &str) -> String {
        format!("[{}]", name)
    }
}

// ===========================================================================
// SQLite Dialect
// ===========================================================================

pub struct SqliteDialect;

impl DdlDialect for SqliteDialect {
    fn map_type(&self, generic_type: &str) -> String {
        map_type_with(generic_type, &|base| match base {
            "BIGINT" => "INTEGER",
            "VARCHAR" => "TEXT",
            "TEXT" => "TEXT",
            "DATETIME" => "TEXT",
            "BOOLEAN" => "INTEGER",
            "DECIMAL" => "REAL",
            "INT" | "INTEGER" => "INTEGER",
            "SMALLINT" => "INTEGER",
            "TINYINT" => "INTEGER",
            "FLOAT" => "REAL",
            "DOUBLE" => "REAL",
            "DATE" => "TEXT",
            "TIME" => "TEXT",
            "TIMESTAMP" => "TEXT",
            "BLOB" => "BLOB",
            "JSON" => "TEXT",
            other => other,
        })
    }

    fn map_column_type(&self, col: &ErColumn) -> String {
        // SQLite: AUTOINCREMENT only works with INTEGER PRIMARY KEY
        // The type itself is always just the mapped type
        self.map_type(&col.data_type)
    }

    fn primary_key_syntax(&self, pk_columns: &[&ErColumn]) -> String {
        let cols: Vec<String> = pk_columns.iter().map(|c| {
            let quoted = self.quote_identifier(&c.name);
            if c.is_auto_increment {
                format!("{} AUTOINCREMENT", quoted)
            } else {
                quoted
            }
        }).collect();
        format!("  PRIMARY KEY ({})", cols.join(", "))
    }

    fn auto_increment_syntax(&self) -> &str {
        // Handled in primary_key_syntax
        ""
    }

    fn index_syntax(&self, table_name: &str, index: &ErIndex) -> String {
        let cols = parse_index_columns(&index.columns);
        if cols.is_empty() { return String::new(); }
        let quoted_cols: Vec<String> = cols.iter().map(|c| self.quote_identifier(c)).collect();
        let unique = if index.index_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX {} ON {} ({});",
            unique,
            self.quote_identifier(&index.name),
            self.quote_identifier(table_name),
            quoted_cols.join(", "),
        )
    }

    fn foreign_key_syntax(&self, relation: &ErRelation, source_col: &str, target_table: &str, target_col: &str) -> String {
        format!(
            "  FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            self.quote_identifier(source_col),
            self.quote_identifier(target_table),
            self.quote_identifier(target_col),
            relation.on_delete,
            relation.on_update,
        )
    }

    fn comment_syntax(&self, table_name: &str, column_name: Option<&str>, comment: &str) -> Vec<String> {
        // SQLite doesn't support comments natively; emit SQL line comments
        match column_name {
            Some(col) => vec![format!("-- Column {}.{}: {}", table_name, col, comment)],
            None => vec![format!("-- Table {}: {}", table_name, comment)],
        }
    }

    fn quote_identifier(&self, name: &str) -> String {
        format!("\"{}\"", name)
    }
}

// ---------------------------------------------------------------------------
// Helper: generate delayed FK constraints via ALTER TABLE
// ---------------------------------------------------------------------------

/// Generate ALTER TABLE statements for delayed foreign key constraints.
/// Used for self-referencing or circular dependency scenarios where FK cannot be inline.
fn generate_delayed_fks(
    relations: &[ErRelation],
    delayed_ids: &HashSet<i64>,
    tables_by_id: &HashMap<i64, &ErTable>,
    columns_map: &HashMap<i64, Vec<ErColumn>>,
    dialect: &dyn DdlDialect,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    for rel in relations.iter().filter(|r| delayed_ids.contains(&r.id)) {
        let source_table_name = tables_by_id
            .get(&rel.source_table_id)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| format!("table_{}", rel.source_table_id));
        let source_col_name = columns_map
            .get(&rel.source_table_id)
            .and_then(|cols| cols.iter().find(|c| c.id == rel.source_column_id))
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("col_{}", rel.source_column_id));
        let target_table_name = tables_by_id
            .get(&rel.target_table_id)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| format!("table_{}", rel.target_table_id));
        let target_col_name = columns_map
            .get(&rel.target_table_id)
            .and_then(|cols| cols.iter().find(|c| c.id == rel.target_column_id))
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("col_{}", rel.target_column_id));

        let fk_name = rel.name.as_deref().unwrap_or("fk");

        parts.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {};",
            dialect.quote_identifier(&source_table_name),
            dialect.quote_identifier(fk_name),
            dialect.quote_identifier(&source_col_name),
            dialect.quote_identifier(&target_table_name),
            dialect.quote_identifier(&target_col_name),
            rel.on_delete,
            rel.on_update,
        ));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(
            "-- Delayed foreign key constraints (for self-referencing or circular dependencies)\n{}",
            parts.join("\n")
        )
    }
}

// ===========================================================================
// Main entry point
// ===========================================================================

pub fn generate_ddl(
    tables: &[ErTable],
    columns_map: &HashMap<i64, Vec<ErColumn>>,
    indexes_map: &HashMap<i64, Vec<ErIndex>>,
    relations: &[ErRelation],
    dialect: &str,
    options: &GenerateOptions,
    project: &ErProject,
) -> AppResult<String> {
    let dialect_impl: Box<dyn DdlDialect> = match dialect.to_lowercase().as_str() {
        "mysql" => Box::new(MySqlDialect),
        "postgres" | "postgresql" => Box::new(PostgresDialect),
        "oracle" => Box::new(OracleDialect),
        "sqlserver" | "mssql" => Box::new(SqlServerDialect),
        "sqlite" => Box::new(SqliteDialect),
        other => return Err(AppError::Other(format!("Unsupported DDL dialect: {}", other))),
    };

    let tables_by_id: HashMap<i64, &ErTable> = tables.iter().map(|t| (t.id, t)).collect();

    // Classify relations: database_fk relations are used for FK constraints;
    // comment_ref relations are injected into column comments.
    // Built once as owned values to avoid N×K clones inside the table loop.
    let db_fk_relations: Vec<ErRelation> = relations.iter().filter(|rel| {
        let src_table = tables_by_id.get(&rel.source_table_id).copied();
        resolve_constraint_method(rel, src_table, Some(project)) == "database_fk"
    }).cloned().collect();

    // --- Topological sort for table creation order ---
    // Tables referenced by foreign keys must be created first.
    let sort_result = sort_tables_by_dependency(tables, relations, None);

    let delayed_fk_ids: HashSet<i64> = if options.include_foreign_keys {
        sort_result.delayed_relation_ids(relations)
    } else {
        HashSet::new()
    };

    let mut ddl_parts: Vec<String> = Vec::new();

    // Sort tables by dependency order
    let sorted_tables: Vec<&ErTable> = sort_result.sorted_table_ids
        .iter()
        .filter_map(|id| tables_by_id.get(id))
        .copied()
        .collect();

    for table in sorted_tables {
        let empty_cols: Vec<ErColumn> = Vec::new();
        let empty_idxs: Vec<ErIndex> = Vec::new();
        let columns = columns_map.get(&table.id).unwrap_or(&empty_cols);
        let indexes = indexes_map.get(&table.id).unwrap_or(&empty_idxs);

        // Inject comment_ref markers into columns when enabled
        let processed_columns: Vec<ErColumn> = if options.include_comment_refs {
            let mut cols = columns.clone();
            for rel in relations.iter().filter(|r| r.source_table_id == table.id) {
                let src_table = tables_by_id.get(&rel.source_table_id).copied();
                if resolve_constraint_method(rel, src_table, Some(project)) != "comment_ref" {
                    continue;
                }
                let format = resolve_comment_format(rel, src_table, Some(project));
                let target_table_name = tables_by_id
                    .get(&rel.target_table_id)
                    .map(|t| t.name.as_str())
                    .unwrap_or("unknown");
                let target_col_name = columns_map
                    .get(&rel.target_table_id)
                    .and_then(|tcols| tcols.iter().find(|c| c.id == rel.target_column_id))
                    .map(|c| c.name.as_str())
                    .unwrap_or("id");
                let marker = build_comment_marker(
                    target_table_name, target_col_name, &rel.relation_type, format,
                );
                if let Some(col) = cols.iter_mut().find(|c| c.id == rel.source_column_id) {
                    col.comment = Some(append_marker_to_comment(col.comment.as_deref(), &marker));
                }
            }
            cols
        } else {
            columns.to_vec()
        };

        // Filter out delayed FK constraints for this table
        let inline_fks: Vec<ErRelation> = if options.include_foreign_keys {
            db_fk_relations.iter()
                .filter(|r| r.source_table_id == table.id && !delayed_fk_ids.contains(&r.id))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };

        let stmt = dialect_impl.create_table(
            table,
            &processed_columns,
            indexes,
            &inline_fks,
            tables,
            columns_map,
            options,
        );
        ddl_parts.push(stmt);
    }

    // --- Add delayed foreign key constraints (ALTER TABLE) ---
    if options.include_foreign_keys && !delayed_fk_ids.is_empty() {
        let delayed_fks_ddl = generate_delayed_fks(
            &db_fk_relations,
            &delayed_fk_ids,
            &tables_by_id,
            columns_map,
            dialect_impl.as_ref(),
        );
        if !delayed_fks_ddl.is_empty() {
            ddl_parts.push(delayed_fks_ddl);
        }
    }

    Ok(ddl_parts.join("\n\n"))
}

// ---------------------------------------------------------------------------
// Public helpers for sync DDL generation (used by er/commands.rs)
// ---------------------------------------------------------------------------

fn make_dialect_impl(dialect: &str) -> AppResult<Box<dyn DdlDialect>> {
    Ok(match dialect.to_lowercase().as_str() {
        "mysql" => Box::new(MySqlDialect),
        "postgres" | "postgresql" => Box::new(PostgresDialect),
        "oracle" => Box::new(OracleDialect),
        "sqlserver" | "mssql" => Box::new(SqlServerDialect),
        "sqlite" => Box::new(SqliteDialect),
        other => {
            return Err(AppError::Other(format!(
                "Unsupported DDL dialect: {}",
                other
            )))
        }
    })
}

/// Quote a SQL identifier using the appropriate dialect style.
/// MySQL uses backticks, SQL Server uses brackets, others use double quotes.
pub fn quote_identifier(name: &str, dialect: &str) -> String {
    match dialect.to_lowercase().as_str() {
        "mysql" => format!("`{}`", name.replace('`', "``")),
        "sqlserver" | "mssql" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Format a column definition for use in ALTER TABLE ADD COLUMN or MODIFY COLUMN.
/// Returns `quoted_name TYPE [UNSIGNED] [NOT NULL] [AUTO_INCREMENT] [UNIQUE] [DEFAULT ...]`
pub fn format_column_for_alter(col: &ErColumn, dialect: &str) -> AppResult<String> {
    let d = make_dialect_impl(dialect)?;
    let mut def = format!(
        "{} {}",
        d.quote_identifier(&col.name),
        d.map_column_type(col)
    );
    if col.unsigned {
        def.push_str(" UNSIGNED");
    }
    if !col.nullable {
        def.push_str(" NOT NULL");
    }
    if col.is_auto_increment {
        let ai = d.auto_increment_syntax();
        if !ai.is_empty() {
            def.push_str(&format!(" {}", ai));
        }
    }
    if col.is_unique {
        def.push_str(" UNIQUE");
    }
    if let Some(ref dv) = col.default_value {
        if !dv.is_empty() {
            def.push_str(&format!(" DEFAULT {}", dv));
        }
    }
    Ok(def)
}

/// Generate dialect-specific ALTER TABLE MODIFY COLUMN statements.
/// PostgreSQL returns two statements (TYPE change + NOT NULL change);
/// SQL Server uses ALTER COLUMN syntax;
/// MySQL/Oracle/SQLite use MODIFY COLUMN syntax.
pub fn generate_modify_column_ddl(
    col: &ErColumn,
    table_name: &str,
    dialect: &str,
) -> AppResult<Vec<String>> {
    let d = make_dialect_impl(dialect)?;
    let q_table = d.quote_identifier(table_name);
    let col_def = format_column_for_alter(col, dialect)?;

    Ok(match dialect.to_lowercase().as_str() {
        "postgres" | "postgresql" => {
            let q_col = d.quote_identifier(&col.name);
            let col_type = d.map_column_type(col);
            let mut stmts = vec![format!(
                "ALTER TABLE {} ALTER COLUMN {} TYPE {};",
                q_table, q_col, col_type
            )];
            if col.nullable {
                stmts.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} DROP NOT NULL;",
                    q_table, q_col
                ));
            } else {
                stmts.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} SET NOT NULL;",
                    q_table, q_col
                ));
            }
            stmts
        }
        "sqlserver" | "mssql" => {
            vec![format!("ALTER TABLE {} ALTER COLUMN {};", q_table, col_def)]
        }
        "sqlite" => {
            // SQLite does not support MODIFY COLUMN; table recreation is required.
            vec![format!(
                "-- SQLite does not support MODIFY COLUMN (table recreation required): ALTER TABLE {} MODIFY {};",
                q_table, col_def
            )]
        }
        _ => {
            // MySQL, Oracle
            vec![format!("ALTER TABLE {} MODIFY COLUMN {};", q_table, col_def)]
        }
    })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_project() -> ErProject {
        ErProject {
            id: 1,
            name: "test".to_string(),
            description: None,
            connection_id: None,
            database_name: None,
            schema_name: None,
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_zoom: 1.0,
            default_constraint_method: "database_fk".to_string(),
            default_comment_format: "@ref".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_table(id: i64, name: &str) -> ErTable {
        ErTable {
            id,
            project_id: 1,
            name: name.to_string(),
            comment: Some("Users table".to_string()),
            position_x: 0.0,
            position_y: 0.0,
            color: None,
            constraint_method: None,
            comment_format: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_column(id: i64, table_id: i64, name: &str, data_type: &str, pk: bool, ai: bool) -> ErColumn {
        ErColumn {
            id,
            table_id,
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: !pk,
            default_value: None,
            is_primary_key: pk,
            is_auto_increment: ai,
            comment: Some(format!("{} column", name)),
            length: None,
            scale: None,
            is_unique: false,
            unsigned: false,
            charset: None,
            collation: None,
            on_update: None,
            enum_values: None,
            sort_order: id,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_column_with_length(id: i64, table_id: i64, name: &str, data_type: &str, length: Option<i64>, scale: Option<i64>, pk: bool, ai: bool) -> ErColumn {
        let mut col = make_column(id, table_id, name, data_type, pk, ai);
        col.length = length;
        col.scale = scale;
        col
    }

    #[test]
    fn test_mysql_basic() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "BIGINT", true, true),
            make_column_with_length(2, 1, "name", "VARCHAR", Some(255), None, false, false),
            make_column(3, 1, "active", "BOOLEAN", false, false),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let im = HashMap::new();
        let opts = GenerateOptions::default();

        let ddl = generate_ddl(&tables, &cm, &im, &[], "mysql", &opts, &make_project()).unwrap();
        assert!(ddl.contains("CREATE TABLE `users`"));
        assert!(ddl.contains("AUTO_INCREMENT"));
        assert!(ddl.contains("TINYINT(1)"));
        assert!(ddl.contains("VARCHAR(255)"));
        assert!(ddl.contains("ENGINE=InnoDB"));
        assert!(ddl.contains("PRIMARY KEY"));
    }

    #[test]
    fn test_postgres_serial() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "BIGINT", true, true),
            make_column_with_length(2, 1, "name", "VARCHAR", Some(100), None, false, false),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let im = HashMap::new();
        let opts = GenerateOptions::default();

        let ddl = generate_ddl(&tables, &cm, &im, &[], "postgres", &opts, &make_project()).unwrap();
        assert!(ddl.contains("BIGSERIAL"));
        assert!(ddl.contains("VARCHAR(100)"));
        assert!(ddl.contains("COMMENT ON TABLE"));
    }

    #[test]
    fn test_sqlite_basic() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "INT", true, true),
            make_column_with_length(2, 1, "email", "VARCHAR", Some(255), None, false, false),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let im = HashMap::new();
        let opts = GenerateOptions::default();

        let ddl = generate_ddl(&tables, &cm, &im, &[], "sqlite", &opts, &make_project()).unwrap();
        assert!(ddl.contains("INTEGER"));
        assert!(ddl.contains("AUTOINCREMENT"));
        assert!(ddl.contains("TEXT")); // VARCHAR -> TEXT
    }

    #[test]
    fn test_oracle_identity() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "BIGINT", true, true),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let im = HashMap::new();
        let opts = GenerateOptions { include_comments: false, ..Default::default() };

        let ddl = generate_ddl(&tables, &cm, &im, &[], "oracle", &opts, &make_project()).unwrap();
        assert!(ddl.contains("GENERATED ALWAYS AS IDENTITY"));
        assert!(ddl.contains("NUMBER(19)"));
    }

    #[test]
    fn test_sqlserver_identity() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "INT", true, true),
            make_column_with_length(2, 1, "name", "VARCHAR", Some(50), None, false, false),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let im = HashMap::new();
        let opts = GenerateOptions { include_comments: false, ..Default::default() };

        let ddl = generate_ddl(&tables, &cm, &im, &[], "sqlserver", &opts, &make_project()).unwrap();
        assert!(ddl.contains("IDENTITY(1,1)"));
        assert!(ddl.contains("NVARCHAR(50)"));
    }

    #[test]
    fn test_unsupported_dialect() {
        let result = generate_ddl(&[], &HashMap::new(), &HashMap::new(), &[], "mongo", &GenerateOptions::default(), &make_project());
        assert!(result.is_err());
    }

    #[test]
    fn test_index_generation() {
        let tables = vec![make_table(1, "users")];
        let columns = vec![
            make_column(1, 1, "id", "INT", true, false),
            make_column_with_length(2, 1, "email", "VARCHAR", Some(255), None, false, false),
        ];
        let indexes = vec![ErIndex {
            id: 1,
            table_id: 1,
            name: "idx_email".to_string(),
            index_type: "UNIQUE".to_string(),
            columns: r#"["email"]"#.to_string(),
            created_at: String::new(),
        }];
        let mut cm = HashMap::new();
        cm.insert(1, columns);
        let mut im = HashMap::new();
        im.insert(1, indexes);
        let opts = GenerateOptions::default();

        let ddl = generate_ddl(&tables, &cm, &im, &[], "mysql", &opts, &make_project()).unwrap();
        assert!(ddl.contains("CREATE UNIQUE INDEX"));
        assert!(ddl.contains("idx_email"));
    }

    #[test]
    fn test_foreign_key() {
        let tables = vec![
            make_table(1, "orders"),
            make_table(2, "users"),
        ];
        let order_cols = vec![
            make_column(1, 1, "id", "INT", true, true),
            make_column(2, 1, "user_id", "INT", false, false),
        ];
        let user_cols = vec![
            make_column(3, 2, "id", "INT", true, true),
        ];
        let mut cm = HashMap::new();
        cm.insert(1, order_cols);
        cm.insert(2, user_cols);
        let im = HashMap::new();
        let relations = vec![ErRelation {
            id: 1,
            project_id: 1,
            name: Some("fk_order_user".to_string()),
            source_table_id: 1,
            source_column_id: 2,
            target_table_id: 2,
            target_column_id: 3,
            relation_type: "many-to-one".to_string(),
            on_delete: "CASCADE".to_string(),
            on_update: "NO ACTION".to_string(),
            source: "manual".to_string(),
            comment_marker: None,
            constraint_method: None,
            comment_format: None,
            created_at: String::new(),
            updated_at: String::new(),
        }];
        let opts = GenerateOptions {
            include_foreign_keys: true,
            ..Default::default()
        };

        let ddl = generate_ddl(&tables, &cm, &im, &relations, "postgres", &opts, &make_project()).unwrap();
        assert!(ddl.contains("FOREIGN KEY"));
        assert!(ddl.contains("fk_order_user"));
        assert!(ddl.contains("CASCADE"));
    }
}
