use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::models::{ErColumn, ErIndex, ErProject, ErRelation, ErTable};

// ---------------------------------------------------------------------------
// Export data structures (JSON format v1.0)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportData {
    pub version: String, // "1.0"
    pub project: ExportProject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportProject {
    pub name: String,
    pub description: Option<String>,
    pub tables: Vec<ExportTable>,
    pub relations: Vec<ExportRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTable {
    pub name: String,
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub position: ExportPosition,
    pub columns: Vec<ExportColumn>,
    pub indexes: Vec<ExportIndex>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportIndex {
    pub name: String,
    #[serde(rename = "type")]
    pub index_type: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRelation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub source: ExportRelationEnd,
    pub target: ExportRelationEnd,
    #[serde(rename = "type")]
    pub relation_type: String,
    pub on_delete: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_marker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRelationEnd {
    pub table: String,
    pub column: String,
}

// ---------------------------------------------------------------------------
// Export function
// ---------------------------------------------------------------------------

/// Convert internal ER models into a portable JSON string.
///
/// Relations reference tables/columns by ID internally; this function resolves
/// them to human-readable names so the export file is self-contained.
pub fn export_project(
    project: &ErProject,
    tables: &[ErTable],
    columns_map: &HashMap<i64, Vec<ErColumn>>,
    indexes_map: &HashMap<i64, Vec<ErIndex>>,
    relations: &[ErRelation],
) -> crate::AppResult<String> {
    // Build lookup maps: table_id → name, column_id → (table_id, column_name)
    let table_name_by_id: HashMap<i64, &str> = tables
        .iter()
        .map(|t| (t.id, t.name.as_str()))
        .collect();

    let column_name_by_id: HashMap<i64, &str> = columns_map
        .values()
        .flat_map(|cols| cols.iter())
        .map(|c| (c.id, c.name.as_str()))
        .collect();

    // Convert tables
    let export_tables: Vec<ExportTable> = tables
        .iter()
        .map(|t| {
            let cols = columns_map
                .get(&t.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let idxs = indexes_map
                .get(&t.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);

            ExportTable {
                name: t.name.clone(),
                comment: t.comment.clone(),
                color: t.color.clone(),
                position: ExportPosition {
                    x: t.position_x,
                    y: t.position_y,
                },
                columns: cols
                    .iter()
                    .map(|c| ExportColumn {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        nullable: c.nullable,
                        default_value: c.default_value.clone(),
                        is_primary_key: c.is_primary_key,
                        is_auto_increment: c.is_auto_increment,
                        comment: c.comment.clone(),
                    })
                    .collect(),
                indexes: idxs
                    .iter()
                    .map(|i| ExportIndex {
                        name: i.name.clone(),
                        index_type: i.index_type.clone(),
                        columns: parse_index_columns(&i.columns),
                    })
                    .collect(),
            }
        })
        .collect();

    // Convert relations – resolve IDs to names
    let export_relations: Vec<ExportRelation> = relations
        .iter()
        .map(|r| {
            let src_table = table_name_by_id
                .get(&r.source_table_id)
                .copied()
                .unwrap_or("unknown");
            let src_col = column_name_by_id
                .get(&r.source_column_id)
                .copied()
                .unwrap_or("unknown");
            let tgt_table = table_name_by_id
                .get(&r.target_table_id)
                .copied()
                .unwrap_or("unknown");
            let tgt_col = column_name_by_id
                .get(&r.target_column_id)
                .copied()
                .unwrap_or("unknown");

            ExportRelation {
                name: r.name.clone(),
                source: ExportRelationEnd {
                    table: src_table.to_string(),
                    column: src_col.to_string(),
                },
                target: ExportRelationEnd {
                    table: tgt_table.to_string(),
                    column: tgt_col.to_string(),
                },
                relation_type: r.relation_type.clone(),
                on_delete: r.on_delete.clone(),
                source_type: Some(r.source.clone()),
                comment_marker: r.comment_marker.clone(),
            }
        })
        .collect();

    let data = ExportData {
        version: "1.0".to_string(),
        project: ExportProject {
            name: project.name.clone(),
            description: project.description.clone(),
            tables: export_tables,
            relations: export_relations,
        },
    };

    let json = serde_json::to_string_pretty(&data)?;
    Ok(json)
}

// ---------------------------------------------------------------------------
// Import function
// ---------------------------------------------------------------------------

/// Parse a JSON string into an `ExportData` structure.
///
/// This only performs deserialization and validation of the JSON format.
/// The actual insertion into the database is handled by the Tauri command layer.
pub fn parse_import(json: &str) -> crate::AppResult<ExportData> {
    let data: ExportData = serde_json::from_str(json)?;
    Ok(data)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse the JSON array string stored in `ErIndex.columns` into a `Vec<String>`.
fn parse_index_columns(json_str: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json_str).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::models::*;

    #[test]
    fn test_export_and_reimport() {
        let project = ErProject {
            id: 1,
            name: "test_project".to_string(),
            description: Some("A test".to_string()),
            connection_id: None,
            database_name: None,
            schema_name: None,
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_zoom: 1.0,
            default_constraint_method: "database_fk".to_string(),
            default_comment_format: "@ref".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let tables = vec![ErTable {
            id: 1,
            project_id: 1,
            name: "users".to_string(),
            comment: None,
            position_x: 100.0,
            position_y: 200.0,
            color: Some("#ff0000".to_string()),
            constraint_method: None,
            comment_format: None,
            created_at: String::new(),
            updated_at: String::new(),
        }];

        let columns_map = HashMap::from([(
            1i64,
            vec![ErColumn {
                id: 10,
                table_id: 1,
                name: "id".to_string(),
                data_type: "INT".to_string(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_auto_increment: true,
                comment: None,
                length: None,
                scale: None,
                is_unique: false,
                unsigned: false,
                charset: None,
                collation: None,
                on_update: None,
                enum_values: None,
                sort_order: 0,
                created_at: String::new(),
                updated_at: String::new(),
            }],
        )]);

        let indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();
        let relations: Vec<ErRelation> = Vec::new();

        let json = export_project(&project, &tables, &columns_map, &indexes_map, &relations)
            .expect("export should succeed");

        let imported = parse_import(&json).expect("import should succeed");
        assert_eq!(imported.version, "1.0");
        assert_eq!(imported.project.name, "test_project");
        assert_eq!(imported.project.tables.len(), 1);
        assert_eq!(imported.project.tables[0].name, "users");
        assert_eq!(imported.project.tables[0].columns.len(), 1);
        assert_eq!(imported.project.tables[0].columns[0].name, "id");
        assert!(imported.project.tables[0].columns[0].is_primary_key);
        assert_eq!(imported.project.tables[0].color, Some("#ff0000".to_string()));
    }

    #[test]
    fn test_export_resolves_relation_ids() {
        let project = ErProject {
            id: 1,
            name: "rel_test".to_string(),
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
        };

        let tables = vec![
            ErTable {
                id: 1,
                project_id: 1,
                name: "orders".to_string(),
                comment: None,
                position_x: 0.0,
                position_y: 0.0,
                color: None,
                constraint_method: None,
                comment_format: None,
                created_at: String::new(),
                updated_at: String::new(),
            },
            ErTable {
                id: 2,
                project_id: 1,
                name: "users".to_string(),
                comment: None,
                position_x: 0.0,
                position_y: 0.0,
                color: None,
                constraint_method: None,
                comment_format: None,
                created_at: String::new(),
                updated_at: String::new(),
            },
        ];

        let columns_map = HashMap::from([
            (
                1i64,
                vec![ErColumn {
                    id: 10,
                    table_id: 1,
                    name: "user_id".to_string(),
                    data_type: "INT".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    comment: None,
                    length: None,
                    scale: None,
                    is_unique: false,
                    unsigned: false,
                    charset: None,
                    collation: None,
                    on_update: None,
                    enum_values: None,
                    sort_order: 0,
                    created_at: String::new(),
                    updated_at: String::new(),
                }],
            ),
            (
                2i64,
                vec![ErColumn {
                    id: 20,
                    table_id: 2,
                    name: "id".to_string(),
                    data_type: "INT".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_auto_increment: true,
                    comment: None,
                    length: None,
                    scale: None,
                    is_unique: false,
                    unsigned: false,
                    charset: None,
                    collation: None,
                    on_update: None,
                    enum_values: None,
                    sort_order: 0,
                    created_at: String::new(),
                    updated_at: String::new(),
                }],
            ),
        ]);

        let indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();

        let relations = vec![ErRelation {
            id: 1,
            project_id: 1,
            name: Some("fk_orders_user".to_string()),
            source_table_id: 1,
            source_column_id: 10,
            target_table_id: 2,
            target_column_id: 20,
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

        let json = export_project(&project, &tables, &columns_map, &indexes_map, &relations)
            .expect("export should succeed");

        let imported = parse_import(&json).expect("import should succeed");
        let rel = &imported.project.relations[0];
        assert_eq!(rel.source.table, "orders");
        assert_eq!(rel.source.column, "user_id");
        assert_eq!(rel.target.table, "users");
        assert_eq!(rel.target.column, "id");
        assert_eq!(rel.relation_type, "many-to-one");
    }

    #[test]
    fn test_parse_import_invalid_json() {
        let result = parse_import("not valid json");
        assert!(result.is_err());
    }
}
