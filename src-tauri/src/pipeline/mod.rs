pub mod context_builder;
pub mod entity_extract;
pub mod sql_validator;

pub use entity_extract::extract_entities;
pub use context_builder::build_sql_context;
pub use sql_validator::validate_sql;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlContext {
    pub relevant_tables: Vec<String>,
    pub join_paths: Vec<String>,
    pub metrics: Vec<String>,
    pub schema_ddl: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextToSqlResult {
    pub sql: String,
    pub context: SqlContext,
    pub validation_ok: bool,
    pub validation_warning: Option<String>,
}
