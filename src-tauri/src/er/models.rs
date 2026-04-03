use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErProject {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub connection_id: Option<i64>,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub viewport_x: f64,
    pub viewport_y: f64,
    pub viewport_zoom: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErTable {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub comment: Option<String>,
    pub position_x: f64,
    pub position_y: f64,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErColumn {
    pub id: i64,
    pub table_id: i64,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    pub comment: Option<String>,
    // ── 新增字段 ──
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: bool,
    pub unsigned: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,  // JSON 数组字符串
    // ──────────────
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErRelation {
    pub id: i64,
    pub project_id: i64,
    pub name: Option<String>,
    pub source_table_id: i64,
    pub source_column_id: i64,
    pub target_table_id: i64,
    pub target_column_id: i64,
    pub relation_type: String,
    pub on_delete: String,
    pub on_update: String,
    pub source: String,
    pub comment_marker: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErIndex {
    pub id: i64,
    pub table_id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub index_type: String,
    pub columns: String, // JSON array of column names
    pub created_at: String,
}

/// Full project with all related data (single load)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErProjectFull {
    pub project: ErProject,
    pub tables: Vec<ErTableFull>,
    pub relations: Vec<ErRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErTableFull {
    pub table: ErTable,
    pub columns: Vec<ErColumn>,
    pub indexes: Vec<ErIndex>,
}

// Request types for CRUD operations

#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub viewport_x: Option<f64>,
    pub viewport_y: Option<f64>,
    pub viewport_zoom: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateTableRequest {
    pub project_id: i64,
    pub name: String,
    pub comment: Option<String>,
    pub position_x: Option<f64>,
    pub position_y: Option<f64>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTableRequest {
    pub name: Option<String>,
    pub comment: Option<String>,
    pub position_x: Option<f64>,
    pub position_y: Option<f64>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateColumnRequest {
    pub table_id: i64,
    pub name: String,
    pub data_type: String,
    pub nullable: Option<bool>,
    pub default_value: Option<String>,
    pub is_primary_key: Option<bool>,
    pub is_auto_increment: Option<bool>,
    pub comment: Option<String>,
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: Option<bool>,
    pub unsigned: Option<bool>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateColumnRequest {
    pub name: Option<String>,
    pub data_type: Option<String>,
    pub nullable: Option<bool>,
    pub default_value: Option<String>,
    pub is_primary_key: Option<bool>,
    pub is_auto_increment: Option<bool>,
    pub comment: Option<String>,
    pub length: Option<i64>,
    pub scale: Option<i64>,
    pub is_unique: Option<bool>,
    pub unsigned: Option<bool>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub on_update: Option<String>,
    pub enum_values: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRelationRequest {
    pub project_id: i64,
    pub name: Option<String>,
    pub source_table_id: i64,
    pub source_column_id: i64,
    pub target_table_id: i64,
    pub target_column_id: i64,
    pub relation_type: Option<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
    pub source: Option<String>,
    pub comment_marker: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateRelationRequest {
    pub name: Option<String>,
    pub relation_type: Option<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
    pub source: Option<String>,
    pub comment_marker: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateIndexRequest {
    pub table_id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub index_type: Option<String>,
    pub columns: String, // JSON array of column names
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateIndexRequest {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub index_type: Option<String>,
    pub columns: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BindConnectionRequest {
    pub connection_id: i64,
    pub database_name: String,
    pub schema_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DdlOptions {
    pub dialect: String,
    pub include_indexes: Option<bool>,
    pub include_comments: Option<bool>,
    pub include_foreign_keys: Option<bool>,
}

// ─── Import types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub project_name: String,
    pub table_count: usize,
    pub new_tables: Vec<String>,
    pub conflict_tables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConflictResolution {
    pub table_name: String,
    pub action: ConflictAction,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictAction {
    Skip,
    Overwrite,
    Rename,
}
