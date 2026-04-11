use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Span {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Script {
    pub statements: Vec<Statement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum Statement {
    Use(UseStmt),
    Set(SetStmt),
    Migrate(MigrateStmt),
}

#[derive(Debug, Clone, Serialize)]
pub struct UseStmt {
    pub alias: String,
    pub connection_name: String,
    pub span: Span,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetStmt {
    pub assignments: Vec<SetAssignment>,
    pub span: Span,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetAssignment {
    pub key: String,
    pub value: SetValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SetValue {
    Int(u64),
    Str(String),
    Ident(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrateStmt {
    pub source: TableRef,
    pub target: TableRef,
    pub mapping: Option<MappingClause>,
    pub filter: Option<String>,
    pub conflict: Option<ConflictClause>,
    pub incremental_on: Option<String>,
    pub create_if_not_exists: bool,
    pub span: Span,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableRef {
    pub parts: Vec<String>,
    pub span: Span,
}

impl TableRef {
    /// Returns (connection, database, table) if 3 parts,
    /// or (connection_or_db, None, table) if 2 parts.
    pub fn resolve(&self) -> (&str, Option<&str>, &str) {
        match self.parts.as_slice() {
            [a, b, c] => (a.as_str(), Some(b.as_str()), c.as_str()),
            [a, b] => (a.as_str(), None, b.as_str()),
            _ => unreachable!("table_ref always has 2 or 3 parts"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MappingClause {
    pub auto_all: bool,
    pub entries: Vec<MappingEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MappingEntry {
    pub source_expr: String,
    pub target_col: String,
    pub target_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictClause {
    pub strategy: String,
    pub keys: Vec<String>,
}
