use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::models::{ErColumn, ErIndex, ErTable};

// ---------------------------------------------------------------------------
// Database schema representation (input from actual database)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseSchema {
    pub tables: Vec<DbTableInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbTableInfo {
    pub name: String,
    pub columns: Vec<DbColumnInfo>,
    pub indexes: Vec<DbIndexInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbIndexInfo {
    pub name: String,
    pub index_type: String, // "INDEX", "UNIQUE", "FULLTEXT"
    pub columns: Vec<String>,
}

// ---------------------------------------------------------------------------
// Diff result structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffResult {
    pub added_tables: Vec<TableDiff>,       // ER has, DB doesn't
    pub removed_tables: Vec<TableDiff>,     // DB has, ER doesn't
    pub modified_tables: Vec<TableModDiff>, // Both have but different
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDiff {
    pub table_name: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableModDiff {
    pub table_name: String,
    pub added_columns: Vec<ColumnDiff>,
    pub removed_columns: Vec<ColumnDiff>,
    pub modified_columns: Vec<ColumnModDiff>,
    pub added_indexes: Vec<IndexDiff>,
    pub removed_indexes: Vec<IndexDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDiff {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnModDiff {
    pub name: String,
    pub er_type: String,
    pub db_type: String,
    pub er_nullable: bool,
    pub db_nullable: bool,
    pub type_changed: bool,
    pub nullable_changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDiff {
    pub name: String,
    pub index_type: String,
    pub columns: Vec<String>,
}

// ---------------------------------------------------------------------------
// Type normalization
// ---------------------------------------------------------------------------

/// Normalize a SQL type string for comparison.
///
/// - Lowercases everything
/// - Strips leading/trailing whitespace
/// - Replaces known aliases (`int4` → `int`, `character varying` → `varchar`, etc.)
/// - Normalises whitespace inside parenthesised parameters: `VARCHAR( 255 )` → `varchar(255)`
fn normalize_type(t: &str) -> String {
    let mut s = t.trim().to_lowercase();

    // Normalize whitespace inside parentheses: remove spaces after '(' and before ')'
    // and collapse multiple spaces around commas.
    if let Some(paren_start) = s.find('(') {
        let prefix = &s[..paren_start];
        let rest = &s[paren_start..];
        // Remove spaces inside parens
        let cleaned: String = rest
            .chars()
            .fold((String::new(), false), |(mut acc, prev_space), ch| {
                if ch == ' ' {
                    (acc, true)
                } else {
                    if prev_space && ch != ')' && ch != ',' && !acc.ends_with('(') && !acc.ends_with(',') {
                        acc.push(' ');
                    }
                    acc.push(ch);
                    (acc, false)
                }
            })
            .0;
        s = format!("{}{}", prefix, cleaned);
    }

    // Alias map – apply longest-match-first by checking multi-word aliases before single-word.
    let aliases: &[(&str, &str)] = &[
        ("character varying", "varchar"),
        ("double precision", "double"),
        ("timestamp without time zone", "timestamp"),
        ("timestamp with time zone", "timestamp"),
        ("time without time zone", "time"),
        ("time with time zone", "time"),
        ("timestamptz", "timestamp"),
        ("timetz", "time"),
        ("int2", "smallint"),
        ("int4", "int"),
        ("int8", "bigint"),
        ("integer", "int"),
        ("float4", "float"),
        ("float8", "double"),
        ("bool", "boolean"),
        ("serial", "int"),
        ("bigserial", "bigint"),
        ("smallserial", "smallint"),
    ];

    // Extract base type (before any parenthesis) for alias matching, preserve params.
    let (base, params) = if let Some(idx) = s.find('(') {
        (&s[..idx], &s[idx..])
    } else {
        (s.as_str(), "")
    };

    let base_trimmed = base.trim();
    let mut matched_base = base_trimmed.to_string();
    for &(alias, canonical) in aliases {
        if base_trimmed == alias {
            matched_base = canonical.to_string();
            break;
        }
    }

    format!("{}{}", matched_base, params)
}

// ---------------------------------------------------------------------------
// Core diff computation
// ---------------------------------------------------------------------------

/// Compare ER project data with actual database schema.
///
/// - `er_tables`: tables from the ER project
/// - `er_columns_map`: table_id → columns
/// - `er_indexes_map`: table_id → indexes
/// - `db_schema`: simplified representation of the actual database
pub fn compute_diff(
    er_tables: &[ErTable],
    er_columns_map: &HashMap<i64, Vec<ErColumn>>,
    er_indexes_map: &HashMap<i64, Vec<ErIndex>>,
    db_schema: &DatabaseSchema,
) -> DiffResult {
    // Build name → data lookups (case-insensitive keys)
    let er_by_name: HashMap<String, &ErTable> = er_tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();

    let db_by_name: HashMap<String, &DbTableInfo> = db_schema
        .tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();

    let mut added_tables = Vec::new();
    let mut removed_tables = Vec::new();
    let mut modified_tables = Vec::new();

    // Tables in ER but not in DB → added
    for er_table in er_tables {
        let key = er_table.name.to_lowercase();
        if !db_by_name.contains_key(&key) {
            let cols = er_columns_map
                .get(&er_table.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            added_tables.push(TableDiff {
                table_name: er_table.name.clone(),
                columns: cols
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        nullable: c.nullable,
                        is_primary_key: c.is_primary_key,
                    })
                    .collect(),
            });
        }
    }

    // Tables in DB but not in ER → removed
    for db_table in &db_schema.tables {
        let key = db_table.name.to_lowercase();
        if !er_by_name.contains_key(&key) {
            removed_tables.push(TableDiff {
                table_name: db_table.name.clone(),
                columns: db_table
                    .columns
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        nullable: c.nullable,
                        is_primary_key: c.is_primary_key,
                    })
                    .collect(),
            });
        }
    }

    // Tables in both → compare columns & indexes
    for er_table in er_tables {
        let key = er_table.name.to_lowercase();
        if let Some(db_table) = db_by_name.get(&key) {
            let er_cols = er_columns_map
                .get(&er_table.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let er_idxs = er_indexes_map
                .get(&er_table.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);

            let mod_diff = compare_table(er_cols, er_idxs, db_table);
            if let Some(diff) = mod_diff {
                modified_tables.push(TableModDiff {
                    table_name: er_table.name.clone(),
                    ..diff
                });
            }
        }
    }

    DiffResult {
        added_tables,
        removed_tables,
        modified_tables,
    }
}

/// Compare columns and indexes for a single table. Returns `None` if identical.
fn compare_table(
    er_cols: &[ErColumn],
    er_idxs: &[ErIndex],
    db_table: &DbTableInfo,
) -> Option<TableModDiff> {
    let (added_columns, removed_columns, modified_columns) =
        compare_columns(er_cols, &db_table.columns);
    let (added_indexes, removed_indexes) = compare_indexes(er_idxs, &db_table.indexes);

    if added_columns.is_empty()
        && removed_columns.is_empty()
        && modified_columns.is_empty()
        && added_indexes.is_empty()
        && removed_indexes.is_empty()
    {
        return None;
    }

    Some(TableModDiff {
        table_name: String::new(), // filled by caller
        added_columns,
        removed_columns,
        modified_columns,
        added_indexes,
        removed_indexes,
    })
}

fn compare_columns(
    er_cols: &[ErColumn],
    db_cols: &[DbColumnInfo],
) -> (Vec<ColumnDiff>, Vec<ColumnDiff>, Vec<ColumnModDiff>) {
    let er_by_name: HashMap<String, &ErColumn> = er_cols
        .iter()
        .map(|c| (c.name.to_lowercase(), c))
        .collect();
    let db_by_name: HashMap<String, &DbColumnInfo> = db_cols
        .iter()
        .map(|c| (c.name.to_lowercase(), c))
        .collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();

    // Columns in ER but not DB
    for col in er_cols {
        let key = col.name.to_lowercase();
        if !db_by_name.contains_key(&key) {
            added.push(ColumnDiff {
                name: col.name.clone(),
                data_type: col.data_type.clone(),
                nullable: col.nullable,
            });
        }
    }

    // Columns in DB but not ER
    for col in db_cols {
        let key = col.name.to_lowercase();
        if !er_by_name.contains_key(&key) {
            removed.push(ColumnDiff {
                name: col.name.clone(),
                data_type: col.data_type.clone(),
                nullable: col.nullable,
            });
        }
    }

    // Columns in both → check type & nullable
    for er_col in er_cols {
        let key = er_col.name.to_lowercase();
        if let Some(db_col) = db_by_name.get(&key) {
            let er_norm = normalize_type(&er_col.data_type);
            let db_norm = normalize_type(&db_col.data_type);
            let type_changed = er_norm != db_norm;
            let nullable_changed = er_col.nullable != db_col.nullable;

            if type_changed || nullable_changed {
                modified.push(ColumnModDiff {
                    name: er_col.name.clone(),
                    er_type: er_col.data_type.clone(),
                    db_type: db_col.data_type.clone(),
                    er_nullable: er_col.nullable,
                    db_nullable: db_col.nullable,
                    type_changed,
                    nullable_changed,
                });
            }
        }
    }

    (added, removed, modified)
}

fn compare_indexes(
    er_idxs: &[ErIndex],
    db_idxs: &[DbIndexInfo],
) -> (Vec<IndexDiff>, Vec<IndexDiff>) {
    let er_by_name: HashMap<String, &ErIndex> = er_idxs
        .iter()
        .map(|i| (i.name.to_lowercase(), i))
        .collect();
    let db_by_name: HashMap<String, &DbIndexInfo> = db_idxs
        .iter()
        .map(|i| (i.name.to_lowercase(), i))
        .collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();

    // Indexes in ER but not DB
    for idx in er_idxs {
        let key = idx.name.to_lowercase();
        let er_columns = parse_index_columns(&idx.columns);
        if let Some(db_idx) = db_by_name.get(&key) {
            // Both exist – check if different
            let db_columns: Vec<String> = db_idx.columns.iter().map(|s| s.to_lowercase()).collect();
            let er_cols_lower: Vec<String> = er_columns.iter().map(|s| s.to_lowercase()).collect();
            let type_differs =
                idx.index_type.to_lowercase() != db_idx.index_type.to_lowercase();
            if type_differs || er_cols_lower != db_columns {
                // Treat as removed (old) + added (new)
                removed.push(IndexDiff {
                    name: db_idx.name.clone(),
                    index_type: db_idx.index_type.clone(),
                    columns: db_idx.columns.clone(),
                });
                added.push(IndexDiff {
                    name: idx.name.clone(),
                    index_type: idx.index_type.clone(),
                    columns: er_columns,
                });
            }
        } else {
            added.push(IndexDiff {
                name: idx.name.clone(),
                index_type: idx.index_type.clone(),
                columns: er_columns,
            });
        }
    }

    // Indexes in DB but not ER
    for idx in db_idxs {
        let key = idx.name.to_lowercase();
        if !er_by_name.contains_key(&key) {
            removed.push(IndexDiff {
                name: idx.name.clone(),
                index_type: idx.index_type.clone(),
                columns: idx.columns.clone(),
            });
        }
    }

    (added, removed)
}

/// Parse the JSON array string stored in `ErIndex.columns` into a Vec<String>.
fn parse_index_columns(json_str: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json_str).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_type_basic() {
        assert_eq!(normalize_type("VARCHAR(255)"), "varchar(255)");
        assert_eq!(normalize_type("  INT  "), "int");
        assert_eq!(normalize_type("int4"), "int");
        assert_eq!(normalize_type("int8"), "bigint");
        assert_eq!(normalize_type("bool"), "boolean");
        assert_eq!(normalize_type("BOOLEAN"), "boolean");
        assert_eq!(normalize_type("character varying"), "varchar");
        assert_eq!(normalize_type("character varying(100)"), "varchar(100)");
        assert_eq!(normalize_type("timestamptz"), "timestamp");
        assert_eq!(normalize_type("float8"), "double");
        assert_eq!(normalize_type("float4"), "float");
    }

    #[test]
    fn test_normalize_type_whitespace_in_params() {
        assert_eq!(normalize_type("VARCHAR( 255 )"), "varchar(255)");
        assert_eq!(normalize_type("DECIMAL( 10 , 2 )"), "decimal(10,2)");
    }

    #[test]
    fn test_compute_diff_added_table() {
        let er_tables = vec![er_table(1, "users"), er_table(2, "orders")];
        let er_columns_map = HashMap::from([
            (1, vec![er_col(1, 1, "id", "INT")]),
            (2, vec![er_col(2, 2, "id", "INT")]),
        ]);
        let er_indexes_map = HashMap::new();
        let db_schema = DatabaseSchema {
            tables: vec![db_table("users", vec![db_col("id", "int", false, true)], vec![])],
        };

        let diff = compute_diff(&er_tables, &er_columns_map, &er_indexes_map, &db_schema);

        assert_eq!(diff.added_tables.len(), 1);
        assert_eq!(diff.added_tables[0].table_name, "orders");
        assert_eq!(diff.removed_tables.len(), 0);
    }

    #[test]
    fn test_compute_diff_removed_table() {
        let er_tables = vec![er_table(1, "users")];
        let er_columns_map = HashMap::from([(1, vec![er_col(1, 1, "id", "INT")])]);
        let er_indexes_map = HashMap::new();
        let db_schema = DatabaseSchema {
            tables: vec![
                db_table("users", vec![db_col("id", "int", false, true)], vec![]),
                db_table("orders", vec![db_col("id", "int", false, true)], vec![]),
            ],
        };

        let diff = compute_diff(&er_tables, &er_columns_map, &er_indexes_map, &db_schema);

        assert_eq!(diff.removed_tables.len(), 1);
        assert_eq!(diff.removed_tables[0].table_name, "orders");
    }

    #[test]
    fn test_compute_diff_modified_column_type() {
        let er_tables = vec![er_table(1, "users")];
        let er_columns_map = HashMap::from([(
            1,
            vec![er_col(1, 1, "name", "VARCHAR(255)")],
        )]);
        let er_indexes_map = HashMap::new();
        let db_schema = DatabaseSchema {
            tables: vec![db_table(
                "users",
                vec![db_col("name", "character varying(100)", true, false)],
                vec![],
            )],
        };

        let diff = compute_diff(&er_tables, &er_columns_map, &er_indexes_map, &db_schema);

        assert_eq!(diff.modified_tables.len(), 1);
        let mt = &diff.modified_tables[0];
        assert_eq!(mt.modified_columns.len(), 1);
        assert!(mt.modified_columns[0].type_changed);
    }

    #[test]
    fn test_compute_diff_no_changes() {
        let er_tables = vec![er_table(1, "users")];
        let er_columns_map =
            HashMap::from([(1, vec![er_col(1, 1, "id", "int4")])]);
        let er_indexes_map = HashMap::new();
        let db_schema = DatabaseSchema {
            tables: vec![db_table(
                "users",
                vec![db_col("id", "INT", false, true)],
                vec![],
            )],
        };

        let diff = compute_diff(&er_tables, &er_columns_map, &er_indexes_map, &db_schema);

        assert!(diff.added_tables.is_empty());
        assert!(diff.removed_tables.is_empty());
        assert!(diff.modified_tables.is_empty());
    }

    // ---- helpers ----

    fn er_table(id: i64, name: &str) -> ErTable {
        ErTable {
            id,
            project_id: 1,
            name: name.to_string(),
            comment: None,
            position_x: 0.0,
            position_y: 0.0,
            color: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn er_col(id: i64, table_id: i64, name: &str, dtype: &str) -> ErColumn {
        ErColumn {
            id,
            table_id,
            name: name.to_string(),
            data_type: dtype.to_string(),
            nullable: false,
            default_value: None,
            is_primary_key: false,
            is_auto_increment: false,
            comment: None,
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn db_table(name: &str, columns: Vec<DbColumnInfo>, indexes: Vec<DbIndexInfo>) -> DbTableInfo {
        DbTableInfo {
            name: name.to_string(),
            columns,
            indexes,
        }
    }

    fn db_col(name: &str, dtype: &str, nullable: bool, pk: bool) -> DbColumnInfo {
        DbColumnInfo {
            name: name.to_string(),
            data_type: dtype.to_string(),
            nullable,
            is_primary_key: pk,
        }
    }
}
