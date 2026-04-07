use std::collections::{HashMap, HashSet};
use rand::seq::SliceRandom;

use serde::{Deserialize, Serialize};

use crate::AppResult;
use crate::error::AppError;
use super::models::*;
use super::diff_engine::{DatabaseSchema, DbTableInfo, DbColumnInfo, DbIndexInfo, DiffResult};
use super::table_sorter::sort_tables_by_dependency;
use super::ddl_generator::{generate_ddl, GenerateOptions};

// ---------------------------------------------------------------------------
// Sync execution result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncExecutionResult {
    pub statement: String,
    pub success: bool,
    pub error: Option<String>,
}

// ─── Project CRUD ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_create_project(req: CreateProjectRequest) -> AppResult<ErProject> {
    crate::er::repository::create_project(&req)
}

#[tauri::command]
pub async fn er_update_project(id: i64, req: UpdateProjectRequest) -> AppResult<ErProject> {
    crate::er::repository::update_project(id, &req)
}

#[tauri::command]
pub async fn er_delete_project(id: i64) -> AppResult<()> {
    crate::er::repository::delete_project(id)
}

#[tauri::command]
pub async fn er_list_projects() -> AppResult<Vec<ErProject>> {
    crate::er::repository::list_projects()
}

#[tauri::command]
pub async fn er_get_project(project_id: i64) -> AppResult<ErProjectFull> {
    crate::er::repository::get_project_full(project_id)
}

// ─── Table CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_create_table(req: CreateTableRequest) -> AppResult<ErTable> {
    crate::er::repository::create_table(&req)
}

#[tauri::command]
pub async fn er_update_table(id: i64, req: UpdateTableRequest) -> AppResult<ErTable> {
    crate::er::repository::update_table(id, &req)
}

#[tauri::command]
pub async fn er_delete_table(id: i64) -> AppResult<()> {
    crate::er::repository::delete_table(id)
}

// ─── Column CRUD ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_create_column(req: CreateColumnRequest) -> AppResult<ErColumn> {
    crate::er::repository::create_column(&req)
}

#[tauri::command]
pub async fn er_update_column(id: i64, req: UpdateColumnRequest) -> AppResult<ErColumn> {
    crate::er::repository::update_column(id, &req)
}

#[tauri::command]
pub async fn er_delete_column(id: i64) -> AppResult<()> {
    crate::er::repository::delete_column(id)
}

#[tauri::command]
pub async fn er_reorder_columns(table_id: i64, column_ids: Vec<i64>) -> AppResult<()> {
    crate::er::repository::reorder_columns(table_id, &column_ids)
}

// ─── Relation CRUD ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_create_relation(req: CreateRelationRequest) -> AppResult<ErRelation> {
    crate::er::repository::create_relation(&req)
}

#[tauri::command]
pub async fn er_update_relation(id: i64, req: UpdateRelationRequest) -> AppResult<ErRelation> {
    crate::er::repository::update_relation(id, &req)
}

#[tauri::command]
pub async fn er_delete_relation(id: i64) -> AppResult<()> {
    crate::er::repository::delete_relation(id)
}

// ─── Index CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_create_index(req: CreateIndexRequest) -> AppResult<ErIndex> {
    crate::er::repository::create_index(&req)
}

#[tauri::command]
pub async fn er_update_index(id: i64, req: UpdateIndexRequest) -> AppResult<ErIndex> {
    crate::er::repository::update_index(id, &req)
}

#[tauri::command]
pub async fn er_delete_index(id: i64) -> AppResult<()> {
    crate::er::repository::delete_index(id)
}

// ─── Connection Binding ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_bind_connection(project_id: i64, req: BindConnectionRequest) -> AppResult<()> {
    crate::er::repository::bind_connection(project_id, &req)
}

#[tauri::command]
pub async fn er_unbind_connection(project_id: i64) -> AppResult<()> {
    crate::er::repository::unbind_connection(project_id)
}

// ─── DDL Generation ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_generate_ddl(project_id: i64, options: DdlOptions) -> AppResult<String> {
    let full = crate::er::repository::get_project_full(project_id)?;

    // Build columns_map and indexes_map from ErProjectFull
    let mut columns_map: HashMap<i64, Vec<ErColumn>> = HashMap::new();
    let mut indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();
    let mut tables: Vec<ErTable> = Vec::new();

    for tf in &full.tables {
        tables.push(tf.table.clone());
        columns_map.insert(tf.table.id, tf.columns.clone());
        indexes_map.insert(tf.table.id, tf.indexes.clone());
    }

    let gen_options = super::ddl_generator::GenerateOptions {
        include_indexes: options.include_indexes.unwrap_or(true),
        include_comments: options.include_comments.unwrap_or(true),
        include_foreign_keys: options.include_foreign_keys.unwrap_or(false),
        include_comment_refs: options.include_comment_refs.unwrap_or(true),
    };

    super::ddl_generator::generate_ddl(
        &tables,
        &columns_map,
        &indexes_map,
        &full.relations,
        &options.dialect,
        &gen_options,
        &full.project,
    )
}

// ─── Relationship Import Helpers ────────────────────────────────────────────

/// Strip schema prefix from a potentially schema-qualified table name.
/// "public.orders" → "orders", "orders" → "orders"
fn strip_schema_prefix(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, table)| table).unwrap_or(name)
}

/// Detect which comment marker format was used for a given ref target.
fn detect_comment_format(comment: &str, target_table: &str, target_column: &str) -> String {
    let at_fk_pattern = format!("@fk(table={},col={}", target_table, target_column);
    if comment.contains(&at_fk_pattern) {
        return "@fk".to_string();
    }
    let bracket_pattern = format!("[ref:{}.{}]", target_table, target_column);
    if comment.contains(&bracket_pattern) {
        return "[ref]".to_string();
    }
    let dollar_pattern = format!("$$ref({}.{})$$", target_table, target_column);
    if comment.contains(&dollar_pattern) {
        return "$$ref$$".to_string();
    }
    "@ref".to_string()
}

// ─── Type Parsing ──────────────────────────────────────────────────────────

/// Parse a database type string into (base_type, length, scale).
/// E.g. "VARCHAR(255)" -> ("VARCHAR", Some(255), None)
///      "DECIMAL(10,2)" -> ("DECIMAL", Some(10), Some(2))
///      "INT4" -> ("INTEGER", None, None)
fn parse_db_type(raw: &str) -> (String, Option<i64>, Option<i64>) {
    let normalized = raw.trim().to_uppercase();
    if let Some(paren_start) = normalized.find('(') {
        let base = normalized[..paren_start].trim().to_string();
        let inner = &normalized[paren_start + 1..normalized.len().saturating_sub(1)];
        let parts: Vec<&str> = inner.split(',').collect();
        let length = parts.first().and_then(|s| s.trim().parse::<i64>().ok());
        let scale = parts.get(1).and_then(|s| s.trim().parse::<i64>().ok());
        let base = match base.as_str() {
            "CHARACTER VARYING" => "VARCHAR".to_string(),
            "CHARACTER" => "CHAR".to_string(),
            "INT4" => "INTEGER".to_string(),
            "INT8" => "BIGINT".to_string(),
            _ => base,
        };
        (base, length, scale)
    } else {
        let base = match normalized.as_str() {
            "CHARACTER VARYING" => "VARCHAR".to_string(),
            "CHARACTER" => "CHAR".to_string(),
            "INT4" | "INT" => "INTEGER".to_string(),
            "INT8" => "BIGINT".to_string(),
            "DOUBLE PRECISION" => "DOUBLE".to_string(),
            _ => normalized,
        };
        (base, None, None)
    }
}

// ─── Diff & Sync ────────────────────────────────────────────────────────────

/// Helper: load project and build maps for diff/sync operations.
fn load_project_maps(project_id: i64) -> AppResult<(
    ErProjectFull,
    Vec<ErTable>,
    HashMap<i64, Vec<ErColumn>>,
    HashMap<i64, Vec<ErIndex>>,
)> {
    let full = crate::er::repository::get_project_full(project_id)?;
    let mut columns_map: HashMap<i64, Vec<ErColumn>> = HashMap::new();
    let mut indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();
    let mut tables: Vec<ErTable> = Vec::new();

    for tf in &full.tables {
        tables.push(tf.table.clone());
        columns_map.insert(tf.table.id, tf.columns.clone());
        indexes_map.insert(tf.table.id, tf.indexes.clone());
    }

    Ok((full, tables, columns_map, indexes_map))
}

/// Helper: get a datasource for the bound connection of a project.
async fn get_bound_datasource(
    project: &ErProject,
) -> AppResult<Box<dyn crate::datasource::DataSource>> {
    let connection_id = project.connection_id.ok_or_else(|| {
        AppError::Other("No connection bound to this ER project".to_string())
    })?;

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        project.database_name.as_deref(),
        project.schema_name.as_deref(),
    )
    .await?;

    Ok(ds)
}

/// Convert datasource FullSchemaInfo to diff_engine DatabaseSchema format.
fn schema_to_db_schema(schema: &crate::datasource::FullSchemaInfo) -> DatabaseSchema {
    DatabaseSchema {
        tables: schema
            .tables
            .iter()
            .map(|t| DbTableInfo {
                name: t.name.clone(),
                columns: t
                    .columns
                    .iter()
                    .map(|c| DbColumnInfo {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        nullable: c.is_nullable,
                        is_primary_key: c.is_primary_key,
                    })
                    .collect(),
                indexes: t
                    .indexes
                    .iter()
                    .map(|i| DbIndexInfo {
                        name: i.index_name.clone(),
                        index_type: if i.is_unique {
                            "UNIQUE".to_string()
                        } else {
                            "INDEX".to_string()
                        },
                        columns: i.columns.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn er_diff_with_database(project_id: i64) -> AppResult<DiffResult> {
    let (full, tables, columns_map, indexes_map) = load_project_maps(project_id)?;

    let ds = get_bound_datasource(&full.project).await?;
    let db_full_schema = ds.get_full_schema().await?;
    let db_schema = schema_to_db_schema(&db_full_schema);

    let diff = super::diff_engine::compute_diff(&tables, &columns_map, &indexes_map, &db_schema);
    Ok(diff)
}

#[tauri::command]
pub async fn er_sync_from_database(
    project_id: i64,
    table_names: Option<Vec<String>>,
) -> AppResult<()> {
    let full = crate::er::repository::get_project_full(project_id)?;
    let ds = get_bound_datasource(&full.project).await?;
    let db_full_schema = ds.get_full_schema().await?;

    // Build a set of existing ER table names (lowercase) for lookup
    let existing_tables: HashMap<String, &ErTableFull> = full
        .tables
        .iter()
        .map(|tf| (tf.table.name.to_lowercase(), tf))
        .collect();

    for db_table in &db_full_schema.tables {
        // Filter by table_names if provided
        if let Some(ref filter) = table_names {
            let lower = db_table.name.to_lowercase();
            if !filter.iter().any(|n| n.to_lowercase() == lower) {
                continue;
            }
        }

        let lower_name = db_table.name.to_lowercase();

        if let Some(er_tf) = existing_tables.get(&lower_name) {
            // Table exists in ER -- update columns
            // Build existing column name map
            let existing_cols: HashMap<String, &ErColumn> = er_tf
                .columns
                .iter()
                .map(|c| (c.name.to_lowercase(), c))
                .collect();

            for (i, db_col) in db_table.columns.iter().enumerate() {
                let col_lower = db_col.name.to_lowercase();
                if let Some(er_col) = existing_cols.get(&col_lower) {
                    // Update existing column
                    let (parsed_type, parsed_len, parsed_scale) = parse_db_type(&db_col.data_type);
                    let req = UpdateColumnRequest {
                        name: Some(db_col.name.clone()),
                        data_type: Some(parsed_type),
                        nullable: Some(db_col.is_nullable),
                        default_value: db_col.column_default.clone(),
                        is_primary_key: Some(db_col.is_primary_key),
                        is_auto_increment: None, // preserve existing
                        comment: db_col.comment.clone(),
                        length: parsed_len,
                        scale: parsed_scale,
                        is_unique: None,
                        unsigned: None,
                        charset: None,
                        collation: None,
                        on_update: None,
                        enum_values: None,
                        sort_order: Some(i as i64),
                    };
                    crate::er::repository::update_column(er_col.id, &req)?;
                } else {
                    // Create new column
                    let (parsed_type, parsed_len, parsed_scale) = parse_db_type(&db_col.data_type);
                    let req = CreateColumnRequest {
                        table_id: er_tf.table.id,
                        name: db_col.name.clone(),
                        data_type: parsed_type,
                        nullable: Some(db_col.is_nullable),
                        default_value: db_col.column_default.clone(),
                        is_primary_key: Some(db_col.is_primary_key),
                        is_auto_increment: Some(
                            db_col
                                .extra
                                .as_deref()
                                .map(|e| e.contains("auto_increment"))
                                .unwrap_or(false),
                        ),
                        comment: db_col.comment.clone(),
                        length: parsed_len,
                        scale: parsed_scale,
                        is_unique: None,
                        unsigned: None,
                        charset: None,
                        collation: None,
                        on_update: None,
                        enum_values: None,
                        sort_order: Some(i as i64),
                    };
                    crate::er::repository::create_column(&req)?;
                }
            }

            // Sync indexes: remove existing, re-create from DB
            for er_idx in &er_tf.indexes {
                crate::er::repository::delete_index(er_idx.id)?;
            }
            for db_idx in &db_table.indexes {
                let columns_json =
                    serde_json::to_string(&db_idx.columns).unwrap_or_else(|_| "[]".to_string());
                let req = CreateIndexRequest {
                    table_id: er_tf.table.id,
                    name: db_idx.index_name.clone(),
                    index_type: Some(if db_idx.is_unique {
                        "UNIQUE".to_string()
                    } else {
                        "INDEX".to_string()
                    }),
                    columns: columns_json,
                };
                crate::er::repository::create_index(&req)?;
            }
        } else {
            // Table does not exist in ER -- create it
            const TABLE_COLORS: &[&str] = &[
                "var(--accent)", "var(--info)", "var(--warning)",
                "var(--error)", "var(--node-alias)", "var(--success)",
            ];
            let color = TABLE_COLORS.choose(&mut rand::thread_rng()).copied();
            let table_req = CreateTableRequest {
                project_id,
                name: db_table.name.clone(),
                comment: None,
                position_x: None,
                position_y: None,
                color: color.map(|s| s.to_string()),
            };
            let new_table = crate::er::repository::create_table(&table_req)?;

            // Create columns
            for (i, db_col) in db_table.columns.iter().enumerate() {
                let (parsed_type, parsed_len, parsed_scale) = parse_db_type(&db_col.data_type);
                let col_req = CreateColumnRequest {
                    table_id: new_table.id,
                    name: db_col.name.clone(),
                    data_type: parsed_type,
                    nullable: Some(db_col.is_nullable),
                    default_value: db_col.column_default.clone(),
                    is_primary_key: Some(db_col.is_primary_key),
                    is_auto_increment: Some(
                        db_col
                            .extra
                            .as_deref()
                            .map(|e| e.contains("auto_increment"))
                            .unwrap_or(false),
                    ),
                    comment: db_col.comment.clone(),
                    length: parsed_len,
                    scale: parsed_scale,
                    is_unique: None,
                    unsigned: None,
                    charset: None,
                    collation: None,
                    on_update: None,
                    enum_values: None,
                    sort_order: Some(i as i64),
                };
                crate::er::repository::create_column(&col_req)?;
            }

            // Create indexes
            for db_idx in &db_table.indexes {
                let columns_json =
                    serde_json::to_string(&db_idx.columns).unwrap_or_else(|_| "[]".to_string());
                let idx_req = CreateIndexRequest {
                    table_id: new_table.id,
                    name: db_idx.index_name.clone(),
                    index_type: Some(if db_idx.is_unique {
                        "UNIQUE".to_string()
                    } else {
                        "INDEX".to_string()
                    }),
                    columns: columns_json,
                };
                crate::er::repository::create_index(&idx_req)?;
            }
        }
    }

    let fresh = crate::er::repository::get_project_full(project_id)?;

    let table_name_to_id: HashMap<String, i64> = fresh
        .tables
        .iter()
        .map(|tf| (tf.table.name.to_lowercase(), tf.table.id))
        .collect();

    let column_lookup: HashMap<(i64, String), i64> = fresh
        .tables
        .iter()
        .flat_map(|tf| {
            tf.columns
                .iter()
                .map(move |c| ((tf.table.id, c.name.to_lowercase()), c.id))
        })
        .collect();

    // Pre-compute normalized filter set to avoid repeated lowercase conversions
    let filter_set: Option<HashSet<String>> = table_names.as_ref().map(|names| {
        names.iter().map(|n| n.to_lowercase()).collect()
    });

    // 删除需要重建的关系：
    // - 全量同步（无过滤）：删除整个项目的所有 schema/comment 关系
    // - 部分同步（有过滤）：仅删除被选中表作为来源的关系，保留其他表的关系不变
    match &filter_set {
        None => {
            crate::er::repository::delete_relations_by_source(project_id, &["schema", "comment"])?;
        }
        Some(filter) => {
            let filtered_table_ids: Vec<i64> = filter
                .iter()
                .filter_map(|name| table_name_to_id.get(name).copied())
                .collect();
            crate::er::repository::delete_relations_by_source_and_tables(
                project_id,
                &["schema", "comment"],
                &filtered_table_ids,
            )?;
        }
    }

    // 记录已建立的 FK 列对，用于后续跳过重复的注释关系
    let mut fk_pairs: HashSet<(i64, i64)> = HashSet::new();

    // ── Import native FK relations ──
    for db_table in &db_full_schema.tables {
        let source_table_lower = db_table.name.to_lowercase();
        if let Some(ref filter) = filter_set {
            if !filter.contains(&source_table_lower) {
                continue;
            }
        }

        let source_table_id = match table_name_to_id.get(&source_table_lower) {
            Some(id) => *id,
            None => continue,
        };

        for fk in &db_table.foreign_keys {
            let ref_table_bare = strip_schema_prefix(&fk.referenced_table).to_lowercase();

            let target_table_id = match table_name_to_id.get(&ref_table_bare) {
                Some(id) => *id,
                None => continue,
            };

            let source_column_id =
                match column_lookup.get(&(source_table_id, fk.column.to_lowercase())) {
                    Some(id) => *id,
                    None => continue,
                };

            let target_column_id = match column_lookup
                .get(&(target_table_id, fk.referenced_column.to_lowercase()))
            {
                Some(id) => *id,
                None => continue,
            };

            crate::er::repository::create_relation(&CreateRelationRequest {
                project_id,
                name: Some(fk.constraint_name.clone()),
                source_table_id,
                source_column_id,
                target_table_id,
                target_column_id,
                relation_type: Some("many_to_one".to_string()),
                on_delete: fk.on_delete.clone(),
                on_update: fk.on_update.clone(),
                source: Some("schema".to_string()),
                comment_marker: None,
                constraint_method: Some("database_fk".to_string()),
                comment_format: None,
            })?;
            fk_pairs.insert((source_column_id, target_column_id));
        }
    }

    // ── Import comment-based virtual relations ──
    for db_table in &db_full_schema.tables {
        let source_table_lower = db_table.name.to_lowercase();
        if let Some(ref filter) = filter_set {
            if !filter.contains(&source_table_lower) {
                continue;
            }
        }

        let source_table_id = match table_name_to_id.get(&source_table_lower) {
            Some(id) => *id,
            None => continue,
        };

        for db_col in &db_table.columns {
            let comment = match &db_col.comment {
                Some(c) if !c.is_empty() => c.as_str(),
                _ => continue,
            };

            let refs = crate::graph::comment_parser::parse_comment_refs(comment);
            if refs.is_empty() {
                continue;
            }

            let source_column_id =
                match column_lookup.get(&(source_table_id, db_col.name.to_lowercase())) {
                    Some(id) => *id,
                    None => continue,
                };

            for r in &refs {
                let target_table_lower = r.target_table.to_lowercase();
                let target_table_id = match table_name_to_id.get(&target_table_lower) {
                    Some(id) => *id,
                    None => continue,
                };

                let target_column_id = match column_lookup
                    .get(&(target_table_id, r.target_column.to_lowercase()))
                {
                    Some(id) => *id,
                    None => continue,
                };

                // 若该列对已有真实 FK，注释关系为冗余，跳过
                if fk_pairs.contains(&(source_column_id, target_column_id)) {
                    continue;
                }

                let relation_type = match r.relation_type.as_str() {
                    "one_to_many" => "one_to_many",
                    "many_to_one" => "many_to_one",
                    "one_to_one" => "one_to_one",
                    "many_to_many" => "many_to_many",
                    _ => "many_to_one",
                };

                let format = detect_comment_format(comment, &r.target_table, &r.target_column);
                let marker = crate::er::constraint::build_comment_marker(
                    &r.target_table,
                    &r.target_column,
                    relation_type,
                    &format,
                );

                crate::er::repository::create_relation(&CreateRelationRequest {
                    project_id,
                    name: None,
                    source_table_id,
                    source_column_id,
                    target_table_id,
                    target_column_id,
                    relation_type: Some(relation_type.to_string()),
                    on_delete: None,
                    on_update: None,
                    source: Some("comment".to_string()),
                    comment_marker: Some(marker),
                    constraint_method: Some("comment_ref".to_string()),
                    comment_format: Some(format),
                })?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn er_generate_sync_ddl(
    project_id: i64,
    changes: serde_json::Value,
) -> AppResult<Vec<String>> {
    let full = crate::er::repository::get_project_full(project_id)?;

    // Determine SQL dialect from the project's bound connection.
    // Fall back to "mysql" if no connection is bound or driver is unknown.
    let dialect = if let Some(conn_id) = full.project.connection_id {
        crate::db::get_connection_by_id(conn_id)?
            .map(|c| c.driver.to_lowercase())
            .unwrap_or_else(|| "mysql".to_string())
    } else {
        "mysql".to_string()
    };

    // Build lookup maps: lowercase table_name → ErTableFull
    let tables_map: HashMap<String, &crate::er::models::ErTableFull> = full
        .tables
        .iter()
        .map(|tf| (tf.table.name.to_lowercase(), tf))
        .collect();

    let columns_map: HashMap<i64, Vec<crate::er::models::ErColumn>> = full
        .tables
        .iter()
        .map(|tf| (tf.table.id, tf.columns.clone()))
        .collect();

    let indexes_map: HashMap<i64, Vec<crate::er::models::ErIndex>> = full
        .tables
        .iter()
        .map(|tf| (tf.table.id, tf.indexes.clone()))
        .collect();

    let mut statements: Vec<String> = Vec::new();

    // ── 1. Added tables → CREATE TABLE DDL (topologically sorted) ────────
    if let Some(added_tables) = changes.get("added_tables").and_then(|v| v.as_array()) {
        let added_table_ids: HashSet<i64> = added_tables
            .iter()
            .filter_map(|t| {
                t.get("table_name")
                    .and_then(|n| n.as_str())
                    .and_then(|name| tables_map.get(&name.to_lowercase()))
                    .map(|tf| tf.table.id)
            })
            .collect();

        if !added_table_ids.is_empty() {
            let all_tables: Vec<crate::er::models::ErTable> =
                full.tables.iter().map(|tf| tf.table.clone()).collect();

            let sort_result = sort_tables_by_dependency(
                &all_tables,
                &full.relations,
                Some(&added_table_ids),
            );

            let id_to_name: HashMap<i64, String> = full
                .tables
                .iter()
                .map(|tf| (tf.table.id, tf.table.name.to_lowercase()))
                .collect();

            let options = GenerateOptions::default();

            for table_id in &sort_result.sorted_table_ids {
                if let Some(table_name) = id_to_name.get(table_id) {
                    if let Some(tf) = tables_map.get(table_name) {
                        let ddl = generate_ddl(
                            std::slice::from_ref(&tf.table),
                            &columns_map,
                            &indexes_map,
                            &full.relations,
                            &dialect,
                            &options,
                            &full.project,
                        )?;
                        statements.push(ddl);
                    }
                }
            }
        }
    }

    // ── 2. Modified tables ───────────────────────────────────────────────
    if let Some(modified_tables) = changes.get("modified_tables").and_then(|v| v.as_array()) {
        for table_val in modified_tables {
            let Some(table_name) = table_val.get("table_name").and_then(|v| v.as_str()) else {
                continue;
            };
            let tf_opt = tables_map.get(&table_name.to_lowercase());
            let q_table = crate::er::ddl_generator::quote_identifier(table_name, &dialect);

            // 2a. Added columns
            if let Some(added_cols) =
                table_val.get("added_columns").and_then(|v| v.as_array())
            {
                for col_val in added_cols {
                    let col_name =
                        col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(tf) = tf_opt {
                        if let Some(er_col) = tf
                            .columns
                            .iter()
                            .find(|c| c.name.to_lowercase() == col_name.to_lowercase())
                        {
                            let col_def = crate::er::ddl_generator::format_column_for_alter(
                                er_col, &dialect,
                            )?;
                            statements.push(format!(
                                "ALTER TABLE {} ADD COLUMN {};",
                                q_table, col_def
                            ));
                        }
                    }
                }
            }

            // 2b. Removed columns
            if let Some(removed_cols) =
                table_val.get("removed_columns").and_then(|v| v.as_array())
            {
                for col_val in removed_cols {
                    let col_name =
                        col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let q_col =
                        crate::er::ddl_generator::quote_identifier(col_name, &dialect);
                    statements.push(format!(
                        "ALTER TABLE {} DROP COLUMN {};",
                        q_table, q_col
                    ));
                }
            }

            // 2c. Modified columns (type or nullability change)
            if let Some(modified_cols) =
                table_val.get("modified_columns").and_then(|v| v.as_array())
            {
                for col_val in modified_cols {
                    let col_name =
                        col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(tf) = tf_opt {
                        if let Some(er_col) = tf
                            .columns
                            .iter()
                            .find(|c| c.name.to_lowercase() == col_name.to_lowercase())
                        {
                            let stmts =
                                crate::er::ddl_generator::generate_modify_column_ddl(
                                    er_col, table_name, &dialect,
                                )?;
                            statements.extend(stmts);
                        }
                    }
                }
            }

            // 2d. Added indexes
            if let Some(added_idxs) =
                table_val.get("added_indexes").and_then(|v| v.as_array())
            {
                for idx_val in added_idxs {
                    let idx_name =
                        idx_val.get("name").and_then(|v| v.as_str()).unwrap_or("idx");
                    let idx_type = idx_val
                        .get("index_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("INDEX");
                    let cols: Vec<String> = idx_val
                        .get("columns")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|c| c.as_str())
                                .map(|s| {
                                    crate::er::ddl_generator::quote_identifier(s, &dialect)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let unique_kw =
                        if idx_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
                    let q_idx =
                        crate::er::ddl_generator::quote_identifier(idx_name, &dialect);
                    statements.push(format!(
                        "CREATE {}INDEX {} ON {} ({});",
                        unique_kw,
                        q_idx,
                        q_table,
                        cols.join(", ")
                    ));
                }
            }

            // 2e. Removed indexes
            if let Some(removed_idxs) =
                table_val.get("removed_indexes").and_then(|v| v.as_array())
            {
                for idx_val in removed_idxs {
                    let idx_name =
                        idx_val.get("name").and_then(|v| v.as_str()).unwrap_or("idx");
                    let q_idx =
                        crate::er::ddl_generator::quote_identifier(idx_name, &dialect);
                    let stmt = match dialect.to_lowercase().as_str() {
                        "mysql" => format!("DROP INDEX {} ON {};", q_idx, q_table),
                        _ => format!("DROP INDEX IF EXISTS {};", q_idx),
                    };
                    statements.push(stmt);
                }
            }
        }
    }

    Ok(statements)
}

#[tauri::command]
pub async fn er_execute_sync_ddl(
    project_id: i64,
    ddl_statements: Vec<String>,
) -> AppResult<Vec<SyncExecutionResult>> {
    let full = crate::er::repository::get_project_full(project_id)?;
    let ds = get_bound_datasource(&full.project).await?;

    let mut results = Vec::with_capacity(ddl_statements.len());

    for stmt in &ddl_statements {
        match ds.execute(stmt).await {
            Ok(_) => {
                results.push(SyncExecutionResult {
                    statement: stmt.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                results.push(SyncExecutionResult {
                    statement: stmt.clone(),
                    success: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(results)
}

// ─── Export/Import ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn er_export_json(project_id: i64) -> AppResult<String> {
    let full = crate::er::repository::get_project_full(project_id)?;

    let mut columns_map: HashMap<i64, Vec<ErColumn>> = HashMap::new();
    let mut indexes_map: HashMap<i64, Vec<ErIndex>> = HashMap::new();
    let mut tables: Vec<ErTable> = Vec::new();

    for tf in &full.tables {
        tables.push(tf.table.clone());
        columns_map.insert(tf.table.id, tf.columns.clone());
        indexes_map.insert(tf.table.id, tf.indexes.clone());
    }

    super::export::export_project(
        &full.project,
        &tables,
        &columns_map,
        &indexes_map,
        &full.relations,
    )
}

#[tauri::command]
pub async fn er_import_json(json: String) -> AppResult<ErProject> {
    let data = super::export::parse_import(&json)?;

    // Create the project with a unique name (auto-rename if duplicate)
    let unique_name = crate::er::repository::generate_unique_project_name(&data.project.name)?;
    let project = crate::er::repository::create_project(&CreateProjectRequest {
        name: unique_name,
        description: data.project.description.clone(),
    })?;

    // Track table name → id for relation resolution
    let mut table_name_to_id: HashMap<String, i64> = HashMap::new();
    // Track (table_name, column_name) → column_id for relation resolution
    let mut column_key_to_id: HashMap<(String, String), i64> = HashMap::new();

    for export_table in &data.project.tables {
        let table = create_import_table(project.id, &export_table.name, export_table)?;
        table_name_to_id.insert(export_table.name.clone(), table.id);
        create_import_columns(table.id, &export_table.name, export_table, &mut column_key_to_id)?;
        create_import_indexes(table.id, export_table)?;
    }

    // Create relations
    for export_rel in &data.project.relations {
        let src_table_id = table_name_to_id
            .get(&export_rel.source.table)
            .copied()
            .ok_or_else(|| {
                AppError::Other(format!(
                    "Source table '{}' not found in import",
                    export_rel.source.table
                ))
            })?;
        let src_col_id = column_key_to_id
            .get(&(
                export_rel.source.table.clone(),
                export_rel.source.column.clone(),
            ))
            .copied()
            .ok_or_else(|| {
                AppError::Other(format!(
                    "Source column '{}.{}' not found in import",
                    export_rel.source.table, export_rel.source.column
                ))
            })?;
        let tgt_table_id = table_name_to_id
            .get(&export_rel.target.table)
            .copied()
            .ok_or_else(|| {
                AppError::Other(format!(
                    "Target table '{}' not found in import",
                    export_rel.target.table
                ))
            })?;
        let tgt_col_id = column_key_to_id
            .get(&(
                export_rel.target.table.clone(),
                export_rel.target.column.clone(),
            ))
            .copied()
            .ok_or_else(|| {
                AppError::Other(format!(
                    "Target column '{}.{}' not found in import",
                    export_rel.target.table, export_rel.target.column
                ))
            })?;

        crate::er::repository::create_relation(&CreateRelationRequest {
            project_id: project.id,
            name: export_rel.name.clone(),
            source_table_id: src_table_id,
            source_column_id: src_col_id,
            target_table_id: tgt_table_id,
            target_column_id: tgt_col_id,
            relation_type: Some(export_rel.relation_type.clone()),
            on_delete: Some(export_rel.on_delete.clone()),
            on_update: None,
            source: export_rel.source_type.clone(),
            comment_marker: export_rel.comment_marker.clone(),
            constraint_method: None,
            comment_format: None,
        })?;
    }

    Ok(project)
}

#[tauri::command]
pub async fn er_preview_import(
    json: String,
    project_id: Option<i64>,
) -> AppResult<ImportPreview> {
    let data = super::export::parse_import(&json)?;

    match project_id {
        None => {
            // New project mode: generate unique name
            let unique_name =
                crate::er::repository::generate_unique_project_name(&data.project.name)?;
            let table_names: Vec<String> =
                data.project.tables.iter().map(|t| t.name.clone()).collect();
            Ok(ImportPreview {
                project_name: unique_name,
                table_count: table_names.len(),
                new_tables: table_names,
                conflict_tables: vec![],
            })
        }
        Some(pid) => {
            // Import into existing project: detect conflicts
            let full = crate::er::repository::get_project_full(pid)?;
            let existing_names: std::collections::HashSet<String> = full
                .tables
                .iter()
                .map(|tf| tf.table.name.clone())
                .collect();

            let mut new_tables = vec![];
            let mut conflict_tables = vec![];
            for et in &data.project.tables {
                if existing_names.contains(&et.name) {
                    conflict_tables.push(et.name.clone());
                } else {
                    new_tables.push(et.name.clone());
                }
            }

            Ok(ImportPreview {
                project_name: full.project.name.clone(),
                table_count: data.project.tables.len(),
                new_tables,
                conflict_tables,
            })
        }
    }
}

#[tauri::command]
pub async fn er_execute_import(
    json: String,
    project_id: Option<i64>,
    conflicts: Vec<ConflictResolution>,
) -> AppResult<ErProject> {
    let data = super::export::parse_import(&json)?;

    // Build conflict action map: table_name -> action
    let conflict_map: std::collections::HashMap<String, &ConflictAction> = conflicts
        .iter()
        .map(|c| (c.table_name.clone(), &c.action))
        .collect();

    // Determine target project and load existing data in one query
    let (project, existing_full) = match project_id {
        None => {
            let unique_name =
                crate::er::repository::generate_unique_project_name(&data.project.name)?;
            let proj = crate::er::repository::create_project(&CreateProjectRequest {
                name: unique_name,
                description: data.project.description.clone(),
            })?;
            (proj, None)
        }
        Some(pid) => {
            let full = crate::er::repository::get_project_full(pid)?;
            let proj = full.project.clone();
            (proj, Some(full))
        }
    };

    // If importing into existing project, build existing table name -> id map
    let existing_tables: std::collections::HashMap<String, i64> = if let Some(ref full) = existing_full {
        full.tables
            .iter()
            .map(|tf| (tf.table.name.clone(), tf.table.id))
            .collect()
    } else {
        std::collections::HashMap::new()
    };

    // Track table name -> new id, and (table_name, col_name) -> col_id for relations
    let mut table_name_to_id: HashMap<String, i64> = HashMap::new();
    let mut column_key_to_id: HashMap<(String, String), i64> = HashMap::new();

    // Pre-populate with existing tables (for relations that reference non-imported tables)
    if let Some(ref full) = existing_full {
        for tf in &full.tables {
            table_name_to_id.insert(tf.table.name.clone(), tf.table.id);
            for col in &tf.columns {
                column_key_to_id.insert(
                    (tf.table.name.clone(), col.name.clone()),
                    col.id,
                );
            }
        }
    }

    for export_table in &data.project.tables {
        let is_conflict = existing_tables.contains_key(&export_table.name);

        if is_conflict {
            let action = conflict_map
                .get(&export_table.name)
                .copied()
                .unwrap_or(&ConflictAction::Skip);

            match action {
                ConflictAction::Skip => {
                    // Keep existing table, no changes
                    continue;
                }
                ConflictAction::Overwrite => {
                    // Delete existing table, then create new one
                    let old_id = existing_tables[&export_table.name];
                    crate::er::repository::delete_table(old_id)?;
                    // Remove from tracking maps
                    table_name_to_id.remove(&export_table.name);
                    // Fall through to create
                }
                ConflictAction::Rename => {
                    // Generate a renamed table name with _1, _2, etc.
                    let mut all_names: std::collections::HashSet<String> = existing_tables
                        .keys()
                        .cloned()
                        .collect();
                    // Also include names of tables we've already imported in this batch
                    for name in table_name_to_id.keys() {
                        all_names.insert(name.clone());
                    }
                    let base = &export_table.name;
                    let mut suffix = 1;
                    let renamed = loop {
                        let candidate = format!("{}_{}", base, suffix);
                        if !all_names.contains(&candidate) {
                            break candidate;
                        }
                        suffix += 1;
                    };

                    let table = create_import_table(
                        project.id,
                        &renamed,
                        export_table,
                    )?;
                    table_name_to_id.insert(renamed.clone(), table.id);
                    create_import_columns(
                        table.id,
                        &renamed,
                        export_table,
                        &mut column_key_to_id,
                    )?;
                    create_import_indexes(table.id, export_table)?;
                    continue;
                }
            }
        }

        // Create table (new or after overwrite-delete)
        let table = create_import_table(
            project.id,
            &export_table.name,
            export_table,
        )?;
        table_name_to_id.insert(export_table.name.clone(), table.id);
        create_import_columns(
            table.id,
            &export_table.name,
            export_table,
            &mut column_key_to_id,
        )?;
        create_import_indexes(table.id, export_table)?;
    }

    // Create relations
    for export_rel in &data.project.relations {
        let src_table_id = match table_name_to_id.get(&export_rel.source.table) {
            Some(id) => *id,
            None => continue, // Source table was skipped
        };
        let src_col_id = match column_key_to_id.get(&(
            export_rel.source.table.clone(),
            export_rel.source.column.clone(),
        )) {
            Some(id) => *id,
            None => continue,
        };
        let tgt_table_id = match table_name_to_id.get(&export_rel.target.table) {
            Some(id) => *id,
            None => continue,
        };
        let tgt_col_id = match column_key_to_id.get(&(
            export_rel.target.table.clone(),
            export_rel.target.column.clone(),
        )) {
            Some(id) => *id,
            None => continue,
        };

        crate::er::repository::create_relation(&CreateRelationRequest {
            project_id: project.id,
            name: export_rel.name.clone(),
            source_table_id: src_table_id,
            source_column_id: src_col_id,
            target_table_id: tgt_table_id,
            target_column_id: tgt_col_id,
            relation_type: Some(export_rel.relation_type.clone()),
            on_delete: Some(export_rel.on_delete.clone()),
            on_update: None,
            source: export_rel.source_type.clone(),
            comment_marker: export_rel.comment_marker.clone(),
            constraint_method: None,
            comment_format: None,
        })?;
    }

    Ok(project)
}

// ─── Import helpers ─────────────────────────────────────────────────────────

fn create_import_table(
    project_id: i64,
    name: &str,
    export_table: &super::export::ExportTable,
) -> AppResult<ErTable> {
    crate::er::repository::create_table(&CreateTableRequest {
        project_id,
        name: name.to_string(),
        comment: export_table.comment.clone(),
        position_x: Some(export_table.position.x),
        position_y: Some(export_table.position.y),
        color: export_table.color.clone(),
    })
}

fn create_import_columns(
    table_id: i64,
    table_name: &str,
    export_table: &super::export::ExportTable,
    column_key_to_id: &mut HashMap<(String, String), i64>,
) -> AppResult<()> {
    for (i, export_col) in export_table.columns.iter().enumerate() {
        let col = crate::er::repository::create_column(&CreateColumnRequest {
            table_id,
            name: export_col.name.clone(),
            data_type: export_col.data_type.clone(),
            nullable: Some(export_col.nullable),
            default_value: export_col.default_value.clone(),
            is_primary_key: Some(export_col.is_primary_key),
            is_auto_increment: Some(export_col.is_auto_increment),
            comment: export_col.comment.clone(),
            length: None,
            scale: None,
            is_unique: None,
            unsigned: None,
            charset: None,
            collation: None,
            on_update: None,
            enum_values: None,
            sort_order: Some(i as i64),
        })?;
        column_key_to_id.insert(
            (table_name.to_string(), export_col.name.clone()),
            col.id,
        );
    }
    Ok(())
}

fn create_import_indexes(
    table_id: i64,
    export_table: &super::export::ExportTable,
) -> AppResult<()> {
    for export_idx in &export_table.indexes {
        let columns_json =
            serde_json::to_string(&export_idx.columns).unwrap_or_else(|_| "[]".to_string());
        crate::er::repository::create_index(&CreateIndexRequest {
            table_id,
            name: export_idx.name.clone(),
            index_type: Some(export_idx.index_type.clone()),
            columns: columns_json,
        })?;
    }
    Ok(())
}
