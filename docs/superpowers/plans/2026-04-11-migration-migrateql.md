# MigrateQL Migration Center Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GUI form-driven migration configuration with a MigrateQL DSL code editor, parsed by a Rust PEG parser, with embedded LSP for real-time feedback.

**Architecture:** MigrateQL scripts are stored as plain text in `migration_jobs.script_text`. A pest PEG parser in Rust produces an AST, which a compiler transforms into the existing `MigrationJobConfig` IR. The unchanged `pipeline.rs` ETL engine executes it. An embedded LSP (via Tauri invoke) provides diagnostics, completion, and hover. The frontend uses Monaco Editor with a Monarch tokenizer for lexical highlighting and an LSP adapter for semantic features.

**Tech Stack:** Rust (pest parser, serde_json), TypeScript (React, Monaco Editor, Zustand), Tauri 2.x invoke

**Spec:** `docs/superpowers/specs/2026-04-11-migration-migrateql-redesign.md`

---

## File Structure

### Rust — New Files
| File | Responsibility |
|------|---------------|
| `src-tauri/src/migration/lang/mod.rs` | Module exports for lang submodule |
| `src-tauri/src/migration/lang/migrateql.pest` | PEG grammar definition |
| `src-tauri/src/migration/lang/ast.rs` | AST node type definitions |
| `src-tauri/src/migration/lang/parser.rs` | pest parser → AST conversion |
| `src-tauri/src/migration/lang/compiler.rs` | AST → MigrationJobConfig IR |
| `src-tauri/src/migration/lang/formatter.rs` | AST → formatted text output |
| `src-tauri/src/migration/lsp/mod.rs` | Module exports for lsp submodule |
| `src-tauri/src/migration/lsp/handler.rs` | LSP request dispatch |
| `src-tauri/src/migration/lsp/diagnostics.rs` | Syntax + semantic diagnostics |
| `src-tauri/src/migration/lsp/completion.rs` | Context-aware code completion |
| `src-tauri/src/migration/lsp/hover.rs` | Hover information provider |
| `prompts/migration_ghost_text.md` | Ghost Text AI prompt template |

### Rust — Modified Files
| File | Changes |
|------|---------|
| `src-tauri/Cargo.toml` | Add `pest`, `pest_derive` dependencies |
| `src-tauri/src/migration/mod.rs` | Add `pub mod lang;` and `pub mod lsp;` |
| `src-tauri/src/migration/repository.rs` | Rename `config_json` → `script_text` in all SQL and struct fields |
| `src-tauri/src/migration/task_mgr.rs` | Rename `MigrationJob.config_json` → `script_text`, remove `from_row` config_json parsing |
| `src-tauri/src/migration/mig_commands.rs` | Replace `update_migration_job_config` with `update_migration_job_script`, remove `ai_recommend_column_mappings`, add `lsp_request` command |
| `src-tauri/src/migration/pipeline.rs` | Change job config loading to: read script_text → parse → compile → execute |
| `src-tauri/src/lib.rs` | Update `generate_handler![]` registration (lines 374-390) |
| `schema/init.sql` | Rename `config_json` → `script_text` in migration_jobs DDL (line 424) |

### Frontend — New Files
| File | Responsibility |
|------|---------------|
| `src/components/MigrationJobTab/MonarchTokenizer.ts` | MigrateQL lexical highlighting rules |
| `src/components/MigrationJobTab/LspAdapter.ts` | Tauri invoke-based LSP client adapter |
| `src/components/MigrationJobTab/MigrationEditor.tsx` | Monaco Editor wrapper for MigrateQL |
| `src/components/MigrationJobTab/MigrationToolbar.tsx` | Toolbar: run/stop/format/ghost-text toggle |
| `src/components/MigrationJobTab/ResultPanel/index.tsx` | Result panel with tab switching |
| `src/components/MigrationJobTab/ResultPanel/HistoryTab.tsx` | Historical run records list |

### Frontend — Modified Files
| File | Changes |
|------|---------|
| `src/components/MigrationJobTab/index.tsx` | Complete rewrite: SQL-editor-style layout |
| `src/store/migrationStore.ts` | Replace `updateJobConfig` with `updateJobScript`, remove config editing state |

### Frontend — Deleted Files
| File | Reason |
|------|--------|
| `src/components/MigrationJobTab/ConfigTab.tsx` | GUI config replaced by code editor |
| `src/components/MigrationJobTab/TableMappingPanel.tsx` | GUI config replaced by code editor |
| `src/components/MigrationJobTab/ColumnMappingPanel.tsx` | GUI config replaced by code editor |

---

## Task 1: Add pest Dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add pest and pest_derive to Cargo.toml**

In the `[dependencies]` section of `src-tauri/Cargo.toml`, add:

```toml
pest = "2.7"
pest_derive = "2.7"
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully (pest downloaded and linked)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add pest parser dependencies"
```

---

## Task 2: PEG Grammar File

**Files:**
- Create: `src-tauri/src/migration/lang/migrateql.pest`

- [ ] **Step 1: Write the PEG grammar**

Create `src-tauri/src/migration/lang/migrateql.pest`:

```pest
script = { SOI ~ (statement ~ ";")* ~ EOI }
statement = { use_stmt | set_stmt | migrate_stmt }

use_stmt = { ^"USE" ~ ident ~ "=" ~ ^"CONNECTION" ~ "(" ~ string ~ ")" }

set_stmt = { ^"SET" ~ assignment ~ ("," ~ assignment)* }
assignment = { ident ~ "=" ~ value }
value = { number | string | ident }

migrate_stmt = {
    ^"MIGRATE" ~ ^"FROM" ~ table_ref ~ ^"INTO" ~ table_ref
    ~ mapping_clause?
    ~ where_clause?
    ~ conflict_clause?
    ~ incremental_clause?
    ~ create_clause?
}

table_ref = { ident ~ "." ~ ident ~ ("." ~ ident)? }

mapping_clause = { ^"MAPPING" ~ "(" ~ (star_mapping | mapping_list) ~ ")" }
star_mapping = { "*" }
mapping_list = { mapping_entry ~ ("," ~ mapping_entry)* }
mapping_entry = { expr ~ "->" ~ ident ~ type_cast? }
type_cast = { "::" ~ type_name }
type_name = { ident ~ ("(" ~ number ~ ("," ~ number)? ~ ")")? }

expr = { function_call | dotted_ident | string | ident }
function_call = { ident ~ "(" ~ (expr ~ ("," ~ expr)*)? ~ ")" }
dotted_ident = { ident ~ ("." ~ ident)+ }

where_clause = { ^"WHERE" ~ condition }
condition = { (!(^"ON" | ^"INCREMENTAL" | ^"CREATE" | ";") ~ ANY)+ }

conflict_clause = { ^"ON" ~ ^"CONFLICT" ~ strategy ~ (^"BY" ~ "(" ~ col_list ~ ")")? }
strategy = { ^"UPSERT" | ^"REPLACE" | ^"SKIP" | ^"INSERT" | ^"OVERWRITE" }
col_list = { ident ~ ("," ~ ident)* }

incremental_clause = { ^"INCREMENTAL" ~ ^"ON" ~ ident }
create_clause = { ^"CREATE" ~ ^"IF" ~ ^"NOT" ~ ^"EXISTS" }

ident = @{ (ASCII_ALPHA | "_") ~ (ASCII_ALPHANUMERIC | "_")* }
string = @{ "'" ~ (!"'" ~ ANY)* ~ "'" }
number = @{ ASCII_DIGIT+ }

WHITESPACE = _{ " " | "\t" | "\r" | "\n" }
COMMENT = _{ line_comment | block_comment }
line_comment = { "--" ~ (!"\n" ~ ANY)* }
block_comment = { "/*" ~ (!"*/" ~ ANY)* ~ "*/" }
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/migration/lang/migrateql.pest
git commit -m "feat(migration): add MigrateQL PEG grammar"
```

---

## Task 3: AST Definitions

**Files:**
- Create: `src-tauri/src/migration/lang/ast.rs`

- [ ] **Step 1: Define AST types**

Create `src-tauri/src/migration/lang/ast.rs`:

```rust
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
```

- [ ] **Step 2: Verify it compiles**

The file is standalone types — it will be compiled in the next task when `mod.rs` wires it up.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/migration/lang/ast.rs
git commit -m "feat(migration): define MigrateQL AST types"
```

---

## Task 4: Parser (pest → AST)

**Files:**
- Create: `src-tauri/src/migration/lang/parser.rs`
- Create: `src-tauri/src/migration/lang/mod.rs`
- Modify: `src-tauri/src/migration/mod.rs`

- [ ] **Step 1: Write parser tests first**

Create `src-tauri/src/migration/lang/parser.rs` with the test module at the bottom:

```rust
use pest::Parser;
use pest_derive::Parser;
use anyhow::{anyhow, Result};
use super::ast::*;

#[derive(Parser)]
#[grammar = "migration/lang/migrateql.pest"]
struct MigrateQlParser;

/// Parse a MigrateQL script into an AST.
pub fn parse(input: &str) -> Result<Script> {
    let pairs = MigrateQlParser::parse(Rule::script, input)
        .map_err(|e| anyhow!("{e}"))?;
    let mut statements = Vec::new();
    for pair in pairs {
        match pair.as_rule() {
            Rule::statement => {
                let inner = pair.into_inner().next().unwrap();
                statements.push(parse_statement(inner, input)?);
            }
            Rule::EOI => {}
            _ => {}
        }
    }
    Ok(Script { statements })
}

/// Parse a partial script (for LSP — returns AST of whatever succeeded).
pub fn parse_partial(input: &str) -> Script {
    parse(input).unwrap_or_else(|_| Script { statements: Vec::new() })
}

/// Parse and return errors with span info for diagnostics.
pub fn parse_with_errors(input: &str) -> (Option<Script>, Vec<ParseError>) {
    match MigrateQlParser::parse(Rule::script, input) {
        Ok(pairs) => {
            let mut statements = Vec::new();
            let mut errors = Vec::new();
            for pair in pairs {
                match pair.as_rule() {
                    Rule::statement => {
                        let inner = pair.into_inner().next().unwrap();
                        match parse_statement(inner, input) {
                            Ok(stmt) => statements.push(stmt),
                            Err(e) => errors.push(ParseError {
                                message: e.to_string(),
                                span: Span {
                                    start: Position { line: 0, column: 0 },
                                    end: Position { line: 0, column: 0 },
                                },
                            }),
                        }
                    }
                    Rule::EOI => {}
                    _ => {}
                }
            }
            (Some(Script { statements }), errors)
        }
        Err(e) => {
            let (line, col) = match e.line_col {
                pest::error::LineColLocation::Pos((l, c)) => (l as u32 - 1, c as u32 - 1),
                pest::error::LineColLocation::Span((l, c), _) => (l as u32 - 1, c as u32 - 1),
            };
            (
                None,
                vec![ParseError {
                    message: e.variant.message().to_string(),
                    span: Span {
                        start: Position { line, column: col },
                        end: Position { line, column: col + 1 },
                    },
                }],
            )
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParseError {
    pub message: String,
    pub span: Span,
}

// ── Internal helpers ──

fn span_from_pest(pair: &pest::iterators::Pair<Rule>, input: &str) -> Span {
    let start_pos = pair.as_span().start();
    let end_pos = pair.as_span().end();
    Span {
        start: offset_to_position(start_pos, input),
        end: offset_to_position(end_pos, input),
    }
}

fn offset_to_position(offset: usize, input: &str) -> Position {
    let mut line = 0u32;
    let mut col = 0u32;
    for (i, ch) in input.char_indices() {
        if i >= offset { break; }
        if ch == '\n' { line += 1; col = 0; } else { col += 1; }
    }
    Position { line, column: col }
}

fn parse_statement(pair: pest::iterators::Pair<Rule>, input: &str) -> Result<Statement> {
    match pair.as_rule() {
        Rule::use_stmt => parse_use(pair, input),
        Rule::set_stmt => parse_set(pair, input),
        Rule::migrate_stmt => parse_migrate(pair, input),
        _ => Err(anyhow!("unexpected rule: {:?}", pair.as_rule())),
    }
}

fn parse_use(pair: pest::iterators::Pair<Rule>, input: &str) -> Result<Statement> {
    let span = span_from_pest(&pair, input);
    let mut inner = pair.into_inner();
    let alias = inner.next().unwrap().as_str().to_string();
    let connection_name = {
        let s = inner.next().unwrap().as_str();
        s[1..s.len()-1].to_string() // strip quotes
    };
    Ok(Statement::Use(UseStmt { alias, connection_name, span }))
}

fn parse_set(pair: pest::iterators::Pair<Rule>, input: &str) -> Result<Statement> {
    let span = span_from_pest(&pair, input);
    let mut assignments = Vec::new();
    for assign_pair in pair.into_inner() {
        if assign_pair.as_rule() == Rule::assignment {
            let mut parts = assign_pair.into_inner();
            let key = parts.next().unwrap().as_str().to_string();
            let val_pair = parts.next().unwrap();
            let value = parse_set_value(val_pair);
            assignments.push(SetAssignment { key, value });
        }
    }
    Ok(Statement::Set(SetStmt { assignments, span }))
}

fn parse_set_value(pair: pest::iterators::Pair<Rule>) -> SetValue {
    let inner = pair.into_inner().next().unwrap();
    match inner.as_rule() {
        Rule::number => SetValue::Int(inner.as_str().parse().unwrap()),
        Rule::string => {
            let s = inner.as_str();
            SetValue::Str(s[1..s.len()-1].to_string())
        }
        Rule::ident => SetValue::Ident(inner.as_str().to_string()),
        _ => SetValue::Ident(inner.as_str().to_string()),
    }
}

fn parse_migrate(pair: pest::iterators::Pair<Rule>, input: &str) -> Result<Statement> {
    let span = span_from_pest(&pair, input);
    let mut inner = pair.into_inner();

    let source = parse_table_ref(inner.next().unwrap(), input);
    let target = parse_table_ref(inner.next().unwrap(), input);

    let mut mapping = None;
    let mut filter = None;
    let mut conflict = None;
    let mut incremental_on = None;
    let mut create_if_not_exists = false;

    for clause in inner {
        match clause.as_rule() {
            Rule::mapping_clause => mapping = Some(parse_mapping(clause)?),
            Rule::where_clause => {
                let cond = clause.into_inner().next().unwrap();
                filter = Some(cond.as_str().trim().to_string());
            }
            Rule::conflict_clause => conflict = Some(parse_conflict(clause)),
            Rule::incremental_clause => {
                let col = clause.into_inner().next().unwrap();
                incremental_on = Some(col.as_str().to_string());
            }
            Rule::create_clause => create_if_not_exists = true,
            _ => {}
        }
    }

    Ok(Statement::Migrate(MigrateStmt {
        source, target, mapping, filter, conflict,
        incremental_on, create_if_not_exists, span,
    }))
}

fn parse_table_ref(pair: pest::iterators::Pair<Rule>, input: &str) -> TableRef {
    let span = span_from_pest(&pair, input);
    let parts: Vec<String> = pair.into_inner()
        .filter(|p| p.as_rule() == Rule::ident)
        .map(|p| p.as_str().to_string())
        .collect();
    TableRef { parts, span }
}

fn parse_mapping(pair: pest::iterators::Pair<Rule>) -> Result<MappingClause> {
    let inner = pair.into_inner().next().unwrap();
    match inner.as_rule() {
        Rule::star_mapping => Ok(MappingClause { auto_all: true, entries: Vec::new() }),
        Rule::mapping_list => {
            let entries = inner.into_inner()
                .filter(|p| p.as_rule() == Rule::mapping_entry)
                .map(|entry| {
                    let mut parts = entry.into_inner();
                    let source_expr = parts.next().unwrap().as_str().to_string();
                    let target_col = parts.next().unwrap().as_str().to_string();
                    let target_type = parts.next().map(|tc| {
                        tc.into_inner().next().unwrap().as_str().to_string()
                    });
                    MappingEntry { source_expr, target_col, target_type }
                })
                .collect();
            Ok(MappingClause { auto_all: false, entries })
        }
        _ => Err(anyhow!("unexpected mapping rule")),
    }
}

fn parse_conflict(pair: pest::iterators::Pair<Rule>) -> ConflictClause {
    let mut inner = pair.into_inner();
    let strategy = inner.next().unwrap().as_str().to_uppercase();
    let keys: Vec<String> = inner
        .filter(|p| p.as_rule() == Rule::col_list)
        .flat_map(|cl| cl.into_inner())
        .filter(|p| p.as_rule() == Rule::ident)
        .map(|p| p.as_str().to_string())
        .collect();
    ConflictClause { strategy, keys }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_migrate() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f;";
        let script = parse(input).unwrap();
        assert_eq!(script.statements.len(), 1);
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert_eq!(m.source.parts, vec!["a", "b", "c"]);
                assert_eq!(m.target.parts, vec!["d", "e", "f"]);
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_mapping_star() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f MAPPING (*);";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert!(m.mapping.as_ref().unwrap().auto_all);
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_mapping_explicit() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f MAPPING (id -> id, name -> full_name :: VARCHAR);";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                let mapping = m.mapping.as_ref().unwrap();
                assert!(!mapping.auto_all);
                assert_eq!(mapping.entries.len(), 2);
                assert_eq!(mapping.entries[0].source_expr, "id");
                assert_eq!(mapping.entries[0].target_col, "id");
                assert!(mapping.entries[0].target_type.is_none());
                assert_eq!(mapping.entries[1].source_expr, "name");
                assert_eq!(mapping.entries[1].target_col, "full_name");
                assert_eq!(mapping.entries[1].target_type.as_deref(), Some("VARCHAR"));
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_where_clause() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f WHERE status = 'active';";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert_eq!(m.filter.as_deref(), Some("status = 'active'"));
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_conflict_upsert() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f ON CONFLICT UPSERT BY (id, name);";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                let c = m.conflict.as_ref().unwrap();
                assert_eq!(c.strategy, "UPSERT");
                assert_eq!(c.keys, vec!["id", "name"]);
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_incremental() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f INCREMENTAL ON updated_at;";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert_eq!(m.incremental_on.as_deref(), Some("updated_at"));
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_create_if_not_exists() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f CREATE IF NOT EXISTS;";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert!(m.create_if_not_exists);
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_use_stmt() {
        let input = "USE src = CONNECTION('my_mysql');";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Use(u) => {
                assert_eq!(u.alias, "src");
                assert_eq!(u.connection_name, "my_mysql");
            }
            _ => panic!("expected Use"),
        }
    }

    #[test]
    fn test_parse_set_stmt() {
        let input = "SET parallelism = 4, read_batch = 5000;";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Set(s) => {
                assert_eq!(s.assignments.len(), 2);
                assert_eq!(s.assignments[0].key, "parallelism");
                matches!(&s.assignments[0].value, SetValue::Int(4));
                assert_eq!(s.assignments[1].key, "read_batch");
                matches!(&s.assignments[1].value, SetValue::Int(5000));
            }
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn test_parse_multi_statement() {
        let input = r#"
            USE src = CONNECTION('mysql');
            SET parallelism = 2;
            MIGRATE FROM src.db.t1 INTO tgt.db.t2 MAPPING (*);
            MIGRATE FROM src.db.t3 INTO tgt.db.t4;
        "#;
        let script = parse(input).unwrap();
        assert_eq!(script.statements.len(), 4);
        assert!(matches!(&script.statements[0], Statement::Use(_)));
        assert!(matches!(&script.statements[1], Statement::Set(_)));
        assert!(matches!(&script.statements[2], Statement::Migrate(_)));
        assert!(matches!(&script.statements[3], Statement::Migrate(_)));
    }

    #[test]
    fn test_parse_comments() {
        let input = r#"
            -- this is a comment
            /* block comment */
            MIGRATE FROM a.b.c INTO d.e.f;
        "#;
        let script = parse(input).unwrap();
        assert_eq!(script.statements.len(), 1);
    }

    #[test]
    fn test_parse_type_cast_with_params() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f MAPPING (amount -> amount :: NUMERIC(12,2));";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                let entry = &m.mapping.as_ref().unwrap().entries[0];
                assert!(entry.target_type.as_ref().unwrap().contains("NUMERIC"));
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_parse_function_expr() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f MAPPING (CONCAT(first, last) -> name);";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                let entry = &m.mapping.as_ref().unwrap().entries[0];
                assert!(entry.source_expr.contains("CONCAT"));
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_error_missing_semicolon() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f";
        assert!(parse(input).is_err());
    }

    #[test]
    fn test_error_missing_into() {
        let input = "MIGRATE FROM a.b.c;";
        assert!(parse(input).is_err());
    }

    #[test]
    fn test_parse_two_segment_table_ref() {
        let input = "MIGRATE FROM conn.table INTO conn2.table2;";
        let script = parse(input).unwrap();
        match &script.statements[0] {
            Statement::Migrate(m) => {
                assert_eq!(m.source.parts, vec!["conn", "table"]);
                assert_eq!(m.target.parts, vec!["conn2", "table2"]);
            }
            _ => panic!("expected Migrate"),
        }
    }

    #[test]
    fn test_error_span_accuracy() {
        let (_, errors) = parse_with_errors("MIGRATE INVALID;");
        assert!(!errors.is_empty());
        assert_eq!(errors[0].span.start.line, 0);
    }
}
```

- [ ] **Step 2: Create lang/mod.rs and wire up**

Create `src-tauri/src/migration/lang/mod.rs`:

```rust
pub mod ast;
pub mod parser;
```

Add to `src-tauri/src/migration/mod.rs` (after existing module declarations):

```rust
pub mod lang;
```

- [ ] **Step 3: Run parser tests**

Run: `cd src-tauri && cargo test migration::lang::parser::tests -- --nocapture`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/lang/
git add src-tauri/src/migration/mod.rs
git commit -m "feat(migration): implement MigrateQL parser with pest PEG"
```

---

## Task 5: Compiler (AST → MigrationJobConfig)

**Files:**
- Create: `src-tauri/src/migration/lang/compiler.rs`
- Modify: `src-tauri/src/migration/lang/mod.rs`

- [ ] **Step 1: Write compiler with tests**

Create `src-tauri/src/migration/lang/compiler.rs`:

```rust
use anyhow::{anyhow, Result};
use super::ast::*;
use crate::migration::task_mgr::*;

#[derive(Debug, Clone)]
pub struct CompileError {
    pub message: String,
    pub span: Span,
}

/// Compile a MigrateQL AST into the engine's MigrationJobConfig IR.
///
/// `resolve_connection` maps a connection name (or USE alias) to a connection ID.
/// Returns the config or a list of compile errors.
pub fn compile(
    script: &Script,
    resolve_connection: &dyn Fn(&str) -> Option<i64>,
) -> std::result::Result<MigrationJobConfig, Vec<CompileError>> {
    let mut errors = Vec::new();

    // 1. Collect USE aliases
    let mut alias_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for stmt in &script.statements {
        if let Statement::Use(u) = stmt {
            alias_map.insert(u.alias.clone(), u.connection_name.clone());
        }
    }

    // 2. Collect SET parameters
    let mut pipeline = PipelineConfig::default();
    for stmt in &script.statements {
        if let Statement::Set(s) = stmt {
            for a in &s.assignments {
                match a.key.as_str() {
                    "read_batch" | "read_batch_size" => {
                        if let SetValue::Int(v) = &a.value { pipeline.read_batch_size = *v as usize; }
                    }
                    "write_batch" | "write_batch_size" => {
                        if let SetValue::Int(v) = &a.value { pipeline.write_batch_size = *v as usize; }
                    }
                    "parallelism" => {
                        if let SetValue::Int(v) = &a.value { pipeline.parallelism = *v as usize; }
                    }
                    "error_limit" => {
                        if let SetValue::Int(v) = &a.value { pipeline.error_limit = *v as usize; }
                    }
                    "speed_limit_rps" => {
                        if let SetValue::Int(v) = &a.value { pipeline.speed_limit_rps = Some(*v); }
                    }
                    "channel_capacity" => {
                        if let SetValue::Int(v) = &a.value { pipeline.channel_capacity = *v as usize; }
                    }
                    "shard_count" => {
                        if let SetValue::Int(v) = &a.value { pipeline.shard_count = Some(*v as usize); }
                    }
                    other => {
                        errors.push(CompileError {
                            message: format!("unknown SET parameter: {other}"),
                            span: s.span.clone(),
                        });
                    }
                }
            }
        }
    }

    // 3. Process MIGRATE statements into table_mappings
    let mut table_mappings = Vec::new();
    let mut source_connection_id: Option<i64> = None;
    let mut source_database: Option<String> = None;

    for stmt in &script.statements {
        if let Statement::Migrate(m) = stmt {
            // Resolve source
            let (src_conn, src_db, src_table) = m.source.resolve();
            let src_conn_name = alias_map.get(src_conn).map(|s| s.as_str()).unwrap_or(src_conn);
            let src_conn_id = match resolve_connection(src_conn_name) {
                Some(id) => id,
                None => {
                    errors.push(CompileError {
                        message: format!("unknown connection: '{src_conn_name}'"),
                        span: m.source.span.clone(),
                    });
                    continue;
                }
            };

            // Track first source connection as the job's source
            if source_connection_id.is_none() {
                source_connection_id = Some(src_conn_id);
                source_database = src_db.map(|s| s.to_string());
            }

            // Resolve target
            let (tgt_conn, tgt_db, tgt_table) = m.target.resolve();
            let tgt_conn_name = alias_map.get(tgt_conn).map(|s| s.as_str()).unwrap_or(tgt_conn);
            let tgt_conn_id = match resolve_connection(tgt_conn_name) {
                Some(id) => id,
                None => {
                    errors.push(CompileError {
                        message: format!("unknown connection: '{tgt_conn_name}'"),
                        span: m.target.span.clone(),
                    });
                    continue;
                }
            };

            // Build column mappings
            let column_mappings = match &m.mapping {
                Some(mc) if mc.auto_all => Vec::new(), // deferred to runtime
                Some(mc) => mc.entries.iter().map(|e| ColumnMapping {
                    source_expr: e.source_expr.clone(),
                    target_col: e.target_col.clone(),
                    target_type: e.target_type.clone().unwrap_or_default(),
                }).collect(),
                None => Vec::new(),
            };

            // Build conflict strategy
            let (conflict_strategy, upsert_keys) = match &m.conflict {
                Some(c) => {
                    let strat = match c.strategy.as_str() {
                        "UPSERT" => ConflictStrategy::Upsert,
                        "REPLACE" => ConflictStrategy::Replace,
                        "SKIP" => ConflictStrategy::Skip,
                        "INSERT" => ConflictStrategy::Insert,
                        "OVERWRITE" => ConflictStrategy::Overwrite,
                        _ => ConflictStrategy::Insert,
                    };
                    (strat, c.keys.clone())
                }
                None => (ConflictStrategy::Insert, Vec::new()),
            };

            let mapping = TableMapping {
                source_table: src_table.to_string(),
                target: TargetConfig {
                    connection_id: tgt_conn_id,
                    database: tgt_db.unwrap_or("").to_string(),
                    table: tgt_table.to_string(),
                    conflict_strategy,
                    create_if_not_exists: m.create_if_not_exists,
                    upsert_keys,
                },
                filter_condition: m.filter.clone(),
                column_mappings,
            };

            table_mappings.push(mapping);
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    // Build incremental config from first MIGRATE with INCREMENTAL ON
    let incremental_config = script.statements.iter().find_map(|s| {
        if let Statement::Migrate(m) = s {
            m.incremental_on.as_ref().map(|col| IncrementalConfig {
                column: col.clone(),
                last_value: None,
            })
        } else {
            None
        }
    });

    let sync_mode = if incremental_config.is_some() {
        SyncMode::Incremental
    } else {
        SyncMode::Full
    };

    Ok(MigrationJobConfig {
        sync_mode,
        incremental_config,
        source: SourceConfig {
            connection_id: source_connection_id.unwrap_or(0),
            database: source_database.unwrap_or_default(),
            query_mode: QueryMode::Auto,
            tables: table_mappings.iter().map(|m| m.source_table.clone()).collect(),
            custom_query: None,
        },
        table_mappings,
        pipeline,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::lang::parser;

    fn mock_resolve(name: &str) -> Option<i64> {
        match name {
            "mysql_prod" => Some(1),
            "pg_warehouse" => Some(2),
            "my_mysql" => Some(3),
            "my_pg" => Some(4),
            _ => None,
        }
    }

    #[test]
    fn test_compile_simple() {
        let script = parser::parse(
            "MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;"
        ).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.table_mappings.len(), 1);
        assert_eq!(config.source.connection_id, 1);
        assert_eq!(config.table_mappings[0].source_table, "users");
        assert_eq!(config.table_mappings[0].target.connection_id, 2);
        assert_eq!(config.table_mappings[0].target.table, "users");
    }

    #[test]
    fn test_compile_use_alias() {
        let script = parser::parse(r#"
            USE src = CONNECTION('mysql_prod');
            USE tgt = CONNECTION('pg_warehouse');
            MIGRATE FROM src.shop.users INTO tgt.public.users;
        "#).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.source.connection_id, 1);
        assert_eq!(config.table_mappings[0].target.connection_id, 2);
    }

    #[test]
    fn test_compile_use_and_direct() {
        let script = parser::parse(r#"
            USE src = CONNECTION('mysql_prod');
            MIGRATE FROM src.shop.users INTO pg_warehouse.public.users;
        "#).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.source.connection_id, 1);
        assert_eq!(config.table_mappings[0].target.connection_id, 2);
    }

    #[test]
    fn test_compile_multi_migrate() {
        let script = parser::parse(r#"
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
            MIGRATE FROM mysql_prod.shop.orders INTO pg_warehouse.public.orders;
        "#).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.table_mappings.len(), 2);
    }

    #[test]
    fn test_compile_set_pipeline() {
        let script = parser::parse(r#"
            SET parallelism = 4, read_batch = 5000;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.pipeline.parallelism, 4);
        assert_eq!(config.pipeline.read_batch_size, 5000);
    }

    #[test]
    fn test_compile_mapping_star() {
        let script = parser::parse(
            "MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users MAPPING (*);"
        ).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        // auto_all → empty column_mappings, deferred to runtime
        assert!(config.table_mappings[0].column_mappings.is_empty());
    }

    #[test]
    fn test_compile_incremental() {
        let script = parser::parse(
            "MIGRATE FROM mysql_prod.shop.orders INTO pg_warehouse.public.orders INCREMENTAL ON updated_at;"
        ).unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.sync_mode, SyncMode::Incremental);
        assert_eq!(config.incremental_config.as_ref().unwrap().column, "updated_at");
    }

    #[test]
    fn test_compile_unknown_connection() {
        let script = parser::parse(
            "MIGRATE FROM unknown.shop.users INTO pg_warehouse.public.users;"
        ).unwrap();
        let result = compile(&script, &mock_resolve);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert!(errors[0].message.contains("unknown"));
    }
}
```

- [ ] **Step 2: Add compiler to lang/mod.rs**

Update `src-tauri/src/migration/lang/mod.rs`:

```rust
pub mod ast;
pub mod compiler;
pub mod parser;
```

- [ ] **Step 3: Run compiler tests**

Run: `cd src-tauri && cargo test migration::lang::compiler::tests -- --nocapture`
Expected: All tests pass.

Note: If `SyncMode`, `IncrementalConfig`, `SourceConfig`, `QueryMode`, `TableMapping`, `TargetConfig`, `ColumnMapping`, `PipelineConfig`, or `ConflictStrategy` are not public or are missing `Default`/`PartialEq` derives, add them to `task_mgr.rs` as needed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/lang/
git commit -m "feat(migration): implement MigrateQL compiler (AST → JobConfig)"
```

---

## Task 6: Formatter (AST → formatted text)

**Files:**
- Create: `src-tauri/src/migration/lang/formatter.rs`
- Modify: `src-tauri/src/migration/lang/mod.rs`

- [ ] **Step 1: Write formatter with tests**

Create `src-tauri/src/migration/lang/formatter.rs`:

```rust
use super::ast::*;

/// Format a MigrateQL script into canonical pretty-printed text.
pub fn format(script: &Script) -> String {
    let mut out = String::new();
    for (i, stmt) in script.statements.iter().enumerate() {
        if i > 0 { out.push('\n'); }
        match stmt {
            Statement::Use(u) => format_use(&mut out, u),
            Statement::Set(s) => format_set(&mut out, s),
            Statement::Migrate(m) => format_migrate(&mut out, m),
        }
    }
    out
}

fn format_use(out: &mut String, u: &UseStmt) {
    out.push_str(&format!("USE {} = CONNECTION('{}');\n", u.alias, u.connection_name));
}

fn format_set(out: &mut String, s: &SetStmt) {
    out.push_str("SET ");
    for (i, a) in s.assignments.iter().enumerate() {
        if i > 0 { out.push_str(",\n    "); }
        let val = match &a.value {
            SetValue::Int(n) => n.to_string(),
            SetValue::Str(s) => format!("'{s}'"),
            SetValue::Ident(s) => s.clone(),
        };
        out.push_str(&format!("{} = {}", a.key, val));
    }
    out.push_str(";\n");
}

fn format_migrate(out: &mut String, m: &MigrateStmt) {
    out.push_str(&format!("MIGRATE FROM {}\n        INTO {}\n",
        format_table_ref(&m.source),
        format_table_ref(&m.target),
    ));

    if let Some(mapping) = &m.mapping {
        if mapping.auto_all {
            out.push_str("MAPPING (*)\n");
        } else {
            out.push_str("MAPPING (\n");
            for (i, e) in mapping.entries.iter().enumerate() {
                let arrow = format!("{} -> {}", e.source_expr, e.target_col);
                let cast = e.target_type.as_ref().map(|t| format!(" :: {t}")).unwrap_or_default();
                let comma = if i + 1 < mapping.entries.len() { "," } else { "" };
                out.push_str(&format!("    {arrow}{cast}{comma}\n"));
            }
            out.push_str(")\n");
        }
    }

    if let Some(filter) = &m.filter {
        out.push_str(&format!("WHERE {filter}\n"));
    }

    if let Some(c) = &m.conflict {
        out.push_str(&format!("ON CONFLICT {}", c.strategy));
        if !c.keys.is_empty() {
            out.push_str(&format!(" BY ({})", c.keys.join(", ")));
        }
        out.push('\n');
    }

    if let Some(col) = &m.incremental_on {
        out.push_str(&format!("INCREMENTAL ON {col}\n"));
    }

    if m.create_if_not_exists {
        out.push_str("CREATE IF NOT EXISTS\n");
    }

    // Replace trailing newline with semicolon
    let len = out.len();
    out.truncate(len - 1);
    out.push_str(";\n");
}

fn format_table_ref(t: &TableRef) -> String {
    t.parts.join(".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::lang::parser;

    #[test]
    fn test_format_roundtrip() {
        let input = r#"USE src = CONNECTION('my_mysql');

SET parallelism = 4, read_batch = 5000;

MIGRATE FROM src.shop.users
        INTO tgt.public.users
MAPPING (
    id -> user_id,
    name -> full_name :: VARCHAR
)
WHERE is_deleted = 0
ON CONFLICT UPSERT BY (user_id)
CREATE IF NOT EXISTS;"#;

        let script = parser::parse(input).unwrap();
        let formatted = format(&script);

        // Re-parse the formatted output to verify it's valid
        let reparsed = parser::parse(&formatted);
        assert!(reparsed.is_ok(), "formatted output should be valid MigrateQL: {formatted}");
    }

    #[test]
    fn test_format_star_mapping() {
        let input = "MIGRATE FROM a.b.c INTO d.e.f MAPPING (*);";
        let script = parser::parse(input).unwrap();
        let formatted = format(&script);
        assert!(formatted.contains("MAPPING (*)"));
    }
}
```

- [ ] **Step 2: Update lang/mod.rs**

```rust
pub mod ast;
pub mod compiler;
pub mod formatter;
pub mod parser;
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test migration::lang::formatter::tests -- --nocapture`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/lang/
git commit -m "feat(migration): implement MigrateQL formatter"
```

---

## Task 7: Schema & Repository Changes

**Files:**
- Modify: `schema/init.sql` (line 424)
- Modify: `src-tauri/src/migration/task_mgr.rs` (lines 234-258)
- Modify: `src-tauri/src/migration/repository.rs`

- [ ] **Step 1: Rename config_json → script_text in schema/init.sql**

In `schema/init.sql`, find the `migration_jobs` CREATE TABLE (around line 424) and rename `config_json` to `script_text`:

```sql
-- old: config_json TEXT NOT NULL,
-- new:
script_text TEXT NOT NULL DEFAULT '',
```

- [ ] **Step 2: Update MigrationJob struct in task_mgr.rs**

In `src-tauri/src/migration/task_mgr.rs`, rename `config_json` to `script_text` in the `MigrationJob` struct (around line 237) and its `from_row` implementation (around line 250):

```rust
// In MigrationJob struct:
pub script_text: String,    // was: config_json

// In from_row:
script_text: row.get::<_, String>("script_text")?,  // was: config_json
```

- [ ] **Step 3: Update repository.rs**

In `src-tauri/src/migration/repository.rs`, replace all `config_json` references with `script_text`:

1. SELECT queries: change column name from `config_json` to `script_text`
2. `update_job_config` function → rename to `update_job_script(id: i64, script_text: &str)`
3. Remove the `serde_json::from_str::<MigrationJobConfig>` validation — script_text is plain text, not JSON
4. UPDATE statement: `SET script_text = ?1`
5. Remove `migrate_legacy_configs()` function (no longer needed)

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compilation errors in `mig_commands.rs` and `pipeline.rs` where they reference `config_json`. These will be fixed in the next tasks.

- [ ] **Step 5: Commit**

```bash
git add schema/init.sql src-tauri/src/migration/task_mgr.rs src-tauri/src/migration/repository.rs
git commit -m "refactor(migration): rename config_json to script_text"
```

---

## Task 8: Update mig_commands.rs

**Files:**
- Modify: `src-tauri/src/migration/mig_commands.rs`

- [ ] **Step 1: Replace update_migration_job_config with update_migration_job_script**

In `mig_commands.rs` (around line 64):

```rust
// Old:
// pub async fn update_migration_job_config(id: i64, config_json: String) -> ...

// New:
#[tauri::command]
pub async fn update_migration_job_script(id: i64, script_text: String) -> AppResult<()> {
    super::repository::update_job_script(id, &script_text)
}
```

- [ ] **Step 2: Delete ai_recommend_column_mappings command**

Remove the entire `ai_recommend_column_mappings` function (lines 135-184).

- [ ] **Step 3: Add lsp_request command**

Add at the end of `mig_commands.rs`:

```rust
#[tauri::command]
pub async fn lsp_request(
    method: String,
    params: serde_json::Value,
    app: tauri::AppHandle,
) -> AppResult<serde_json::Value> {
    super::lsp::handler::handle_request(&method, params, &app).await
}
```

- [ ] **Step 4: Update run_migration_job to use parser + compiler**

In the `run_migration_job` function, the pipeline still reads config from DB. The pipeline itself will be updated in the next task to parse script_text. No change needed here — `run_migration_job` just delegates to `pipeline::run_pipeline(job_id, app)`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migration/mig_commands.rs
git commit -m "refactor(migration): update commands for MigrateQL"
```

---

## Task 9: Update pipeline.rs to Parse Script

**Files:**
- Modify: `src-tauri/src/migration/pipeline.rs`

- [ ] **Step 1: Change job config loading at pipeline entry**

In `pipeline.rs`, find where `run_pipeline` reads the job config from DB (the line that deserializes `config_json` into `MigrationJobConfig`). Replace it with:

```rust
// Old:
// let config: MigrationJobConfig = serde_json::from_str(&job.config_json)?;

// New:
let script = &job.script_text;
let ast = crate::migration::lang::parser::parse(script)
    .map_err(|e| anyhow::anyhow!("MigrateQL parse error: {e}"))?;

// Build connection resolver from datasource
let resolve_connection = |name: &str| -> Option<i64> {
    // Look up connection by name from the connections table
    crate::db::find_connection_id_by_name(name).ok().flatten()
};

let config = crate::migration::lang::compiler::compile(&ast, &resolve_connection)
    .map_err(|errs| {
        let msgs: Vec<String> = errs.iter().map(|e| e.message.clone()).collect();
        anyhow::anyhow!("MigrateQL compile errors: {}", msgs.join("; "))
    })?;
```

- [ ] **Step 2: Add find_connection_id_by_name helper**

In `src-tauri/src/db/` (the built-in SQLite module), add a helper function:

```rust
pub fn find_connection_id_by_name(name: &str) -> AppResult<Option<i64>> {
    let db = get_db();
    let mut stmt = db.prepare("SELECT id FROM connections WHERE name = ?1")?;
    let result = stmt.query_row(params![name], |row| row.get::<_, i64>(0)).optional()?;
    Ok(result)
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles. Some warnings about unused imports from old config code are acceptable.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migration/pipeline.rs src-tauri/src/db/
git commit -m "feat(migration): pipeline reads MigrateQL script instead of JSON config"
```

---

## Task 10: Update lib.rs Command Registration

**Files:**
- Modify: `src-tauri/src/lib.rs` (lines 374-390)

- [ ] **Step 1: Update generate_handler**

In `src-tauri/src/lib.rs`, update the migration command registrations (lines 374-390):

```rust
// Remove:
migration::mig_commands::update_migration_job_config,
migration::mig_commands::ai_recommend_column_mappings,

// Add:
migration::mig_commands::update_migration_job_script,
migration::mig_commands::lsp_request,
```

Also remove the `migration::repository::migrate_legacy_configs().ok();` call (around line 61).

- [ ] **Step 2: Verify full compilation**

Run: `cd src-tauri && cargo check`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(migration): update Tauri command registration for MigrateQL"
```

---

## Task 11: LSP Handler + Diagnostics

**Files:**
- Create: `src-tauri/src/migration/lsp/mod.rs`
- Create: `src-tauri/src/migration/lsp/handler.rs`
- Create: `src-tauri/src/migration/lsp/diagnostics.rs`
- Modify: `src-tauri/src/migration/mod.rs`

- [ ] **Step 1: Create lsp/mod.rs**

```rust
pub mod handler;
pub mod diagnostics;
```

- [ ] **Step 2: Create handler.rs**

```rust
use anyhow::anyhow;
use serde_json::Value;
use crate::error::AppResult;

pub async fn handle_request(
    method: &str,
    params: Value,
    app: &tauri::AppHandle,
) -> AppResult<Value> {
    match method {
        "textDocument/diagnostic" => {
            let text = params["text"].as_str()
                .ok_or_else(|| anyhow!("missing 'text' param"))?;
            let diagnostics = super::diagnostics::diagnose(text, app).await;
            Ok(serde_json::to_value(diagnostics)?)
        }
        "textDocument/formatting" => {
            let text = params["text"].as_str()
                .ok_or_else(|| anyhow!("missing 'text' param"))?;
            let formatted = format_script(text);
            Ok(serde_json::to_value(formatted)?)
        }
        _ => Err(anyhow!("unknown LSP method: {method}").into()),
    }
}

fn format_script(text: &str) -> Option<String> {
    let script = crate::migration::lang::parser::parse(text).ok()?;
    Some(crate::migration::lang::formatter::format(&script))
}
```

- [ ] **Step 3: Create diagnostics.rs**

```rust
use serde::Serialize;
use crate::migration::lang::parser;

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: String, // "error" | "warning" | "info"
    pub message: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

pub async fn diagnose(text: &str, app: &tauri::AppHandle) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    // 1. Syntax check
    let (ast, parse_errors) = parser::parse_with_errors(text);
    for err in parse_errors {
        diagnostics.push(Diagnostic {
            severity: "error".into(),
            message: err.message,
            start_line: err.span.start.line,
            start_col: err.span.start.column,
            end_line: err.span.end.line,
            end_col: err.span.end.column,
        });
    }

    // 2. Semantic checks (only if parsing succeeded)
    if let Some(script) = ast {
        semantic_check(&script, &mut diagnostics, app).await;
    }

    diagnostics
}

async fn semantic_check(
    script: &crate::migration::lang::ast::Script,
    diagnostics: &mut Vec<Diagnostic>,
    _app: &tauri::AppHandle,
) {
    use crate::migration::lang::ast::*;

    // Check USE declarations reference existing connections
    for stmt in &script.statements {
        if let Statement::Use(u) = stmt {
            let exists = crate::db::find_connection_id_by_name(&u.connection_name)
                .ok()
                .flatten()
                .is_some();
            if !exists {
                diagnostics.push(Diagnostic {
                    severity: "error".into(),
                    message: format!("connection '{}' not found", u.connection_name),
                    start_line: u.span.start.line,
                    start_col: u.span.start.column,
                    end_line: u.span.end.line,
                    end_col: u.span.end.column,
                });
            }
        }

        // Validate SET parameter ranges
        if let Statement::Set(s) = stmt {
            for a in &s.assignments {
                if let SetValue::Int(v) = &a.value {
                    let (valid, msg) = validate_set_param(&a.key, *v);
                    if !valid {
                        diagnostics.push(Diagnostic {
                            severity: "warning".into(),
                            message: msg,
                            start_line: s.span.start.line,
                            start_col: s.span.start.column,
                            end_line: s.span.end.line,
                            end_col: s.span.end.column,
                        });
                    }
                }
            }
        }
    }
}

fn validate_set_param(key: &str, value: u64) -> (bool, String) {
    match key {
        "read_batch" | "read_batch_size" if value > 50000 =>
            (false, format!("{key} max is 50000, got {value}")),
        "write_batch" | "write_batch_size" if value > 5000 =>
            (false, format!("{key} max is 5000, got {value}")),
        "parallelism" if value > 16 =>
            (false, format!("parallelism max is 16, got {value}")),
        _ => (true, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diag_syntax_error() {
        // parse_with_errors doesn't need AppHandle for syntax-only check
        let (_, errors) = parser::parse_with_errors("MIGRATE INVALID;");
        assert!(!errors.is_empty());
    }

    #[test]
    fn test_diag_clean_script() {
        let (ast, errors) = parser::parse_with_errors(
            "MIGRATE FROM a.b.c INTO d.e.f;"
        );
        assert!(ast.is_some());
        assert!(errors.is_empty());
    }
}
```

- [ ] **Step 4: Add lsp module to migration/mod.rs**

Add to `src-tauri/src/migration/mod.rs`:

```rust
pub mod lsp;
```

- [ ] **Step 5: Run tests and verify compilation**

Run: `cd src-tauri && cargo check && cargo test migration::lsp -- --nocapture`
Expected: Compiles, tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/migration/lsp/ src-tauri/src/migration/mod.rs
git commit -m "feat(migration): implement LSP handler and diagnostics"
```

---

## Task 12: LSP Completion

**Files:**
- Create: `src-tauri/src/migration/lsp/completion.rs`
- Modify: `src-tauri/src/migration/lsp/mod.rs`
- Modify: `src-tauri/src/migration/lsp/handler.rs`

- [ ] **Step 1: Create completion.rs**

```rust
use serde::Serialize;
use serde_json::Value;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,        // "keyword" | "connection" | "database" | "table" | "column" | "type" | "parameter"
    pub detail: Option<String>,
    pub insert_text: Option<String>,
}

pub async fn complete(
    params: &Value,
    app: &tauri::AppHandle,
) -> AppResult<Vec<CompletionItem>> {
    let text = params["text"].as_str().unwrap_or("");
    let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
    let col = params["position"]["column"].as_u64().unwrap_or(0) as usize;

    let context = analyze_cursor_context(text, line, col);
    let items = match context {
        CursorContext::AfterFrom | CursorContext::AfterInto => {
            connection_completions().await
        }
        CursorContext::AfterConnDot(conn) => {
            database_completions(&conn, app).await
        }
        CursorContext::AfterDbDot(conn, db) => {
            table_completions(&conn, &db, app).await
        }
        CursorContext::InMapping => {
            // Would need source table context — return empty for now
            Vec::new()
        }
        CursorContext::AfterConflict => {
            strategy_completions()
        }
        CursorContext::AfterSet => {
            parameter_completions()
        }
        CursorContext::LineStart => {
            keyword_completions()
        }
        CursorContext::AfterTypeCast => {
            type_completions()
        }
        CursorContext::Unknown => {
            keyword_completions()
        }
    };

    Ok(items)
}

#[derive(Debug)]
enum CursorContext {
    AfterFrom,
    AfterInto,
    AfterConnDot(String),
    AfterDbDot(String, String),
    InMapping,
    AfterConflict,
    AfterSet,
    AfterTypeCast,
    LineStart,
    Unknown,
}

fn analyze_cursor_context(text: &str, line: usize, col: usize) -> CursorContext {
    let lines: Vec<&str> = text.lines().collect();
    if line >= lines.len() {
        return CursorContext::LineStart;
    }

    let current_line = lines[line];
    let before_cursor = if col <= current_line.len() {
        &current_line[..col]
    } else {
        current_line
    };

    let trimmed = before_cursor.trim();
    let upper = trimmed.to_uppercase();

    // Check for dot completion: "conn." or "conn.db."
    if trimmed.ends_with('.') {
        let parts: Vec<&str> = trimmed.trim_end_matches('.').split('.').collect();
        let last_word = parts.last().map(|s| s.split_whitespace().last().unwrap_or(s)).unwrap_or("");
        match parts.len() {
            1 => {
                let conn = last_word.split_whitespace().last().unwrap_or(last_word);
                return CursorContext::AfterConnDot(conn.to_string());
            }
            2 => {
                let first = parts[0].split_whitespace().last().unwrap_or(parts[0]);
                return CursorContext::AfterDbDot(first.to_string(), parts[1].to_string());
            }
            _ => {}
        }
    }

    if upper.ends_with("FROM ") || upper.ends_with("FROM") {
        return CursorContext::AfterFrom;
    }
    if upper.ends_with("INTO ") || upper.ends_with("INTO") {
        return CursorContext::AfterInto;
    }
    if upper.ends_with("CONFLICT ") || upper.ends_with("CONFLICT") {
        return CursorContext::AfterConflict;
    }
    if upper.ends_with("SET ") || upper.ends_with("SET") || trimmed.ends_with(',') {
        // Check if we're inside a SET statement
        if text[..text.lines().take(line + 1).map(|l| l.len() + 1).sum::<usize>().saturating_sub(1)]
            .to_uppercase().contains("SET ") {
            return CursorContext::AfterSet;
        }
    }
    if trimmed.ends_with("::") || trimmed.ends_with(":: ") {
        return CursorContext::AfterTypeCast;
    }
    if trimmed.is_empty() {
        return CursorContext::LineStart;
    }

    // Check if inside MAPPING block
    let text_before: String = lines[..=line].join("\n");
    let open_parens = text_before.matches("MAPPING").count();
    if open_parens > 0 {
        let after_mapping = text_before.rsplit("MAPPING").next().unwrap_or("");
        let opens = after_mapping.matches('(').count();
        let closes = after_mapping.matches(')').count();
        if opens > closes {
            return CursorContext::InMapping;
        }
    }

    CursorContext::Unknown
}

async fn connection_completions() -> Vec<CompletionItem> {
    let conns = crate::db::list_all_connections().unwrap_or_default();
    conns.into_iter().map(|(id, name, driver)| CompletionItem {
        label: name.clone(),
        kind: "connection".into(),
        detail: Some(format!("{driver} (id: {id})")),
        insert_text: Some(name),
    }).collect()
}

async fn database_completions(conn_name: &str, app: &tauri::AppHandle) -> Vec<CompletionItem> {
    // Look up connection, list databases
    let conn_id = crate::db::find_connection_id_by_name(conn_name)
        .ok().flatten();
    if let Some(id) = conn_id {
        if let Ok(dbs) = crate::datasource::list_databases_for_connection(id, app).await {
            return dbs.into_iter().map(|db| CompletionItem {
                label: db.clone(),
                kind: "database".into(),
                detail: None,
                insert_text: Some(db),
            }).collect();
        }
    }
    Vec::new()
}

async fn table_completions(conn_name: &str, db: &str, app: &tauri::AppHandle) -> Vec<CompletionItem> {
    let conn_id = crate::db::find_connection_id_by_name(conn_name)
        .ok().flatten();
    if let Some(id) = conn_id {
        if let Ok(tables) = crate::datasource::list_tables_for_connection(id, db, app).await {
            return tables.into_iter().map(|t| CompletionItem {
                label: t.clone(),
                kind: "table".into(),
                detail: None,
                insert_text: Some(t),
            }).collect();
        }
    }
    Vec::new()
}

fn strategy_completions() -> Vec<CompletionItem> {
    ["UPSERT", "REPLACE", "SKIP", "INSERT", "OVERWRITE"].iter().map(|s| CompletionItem {
        label: s.to_string(),
        kind: "keyword".into(),
        detail: Some(match *s {
            "UPSERT" => "Insert or update on conflict",
            "REPLACE" => "Delete and re-insert on conflict",
            "SKIP" => "Skip rows that conflict",
            "INSERT" => "Insert only, error on conflict",
            "OVERWRITE" => "Truncate target, then insert",
            _ => "",
        }.into()),
        insert_text: Some(s.to_string()),
    }).collect()
}

fn parameter_completions() -> Vec<CompletionItem> {
    vec![
        ("parallelism", "Concurrent workers (1-16)"),
        ("read_batch", "Rows per read batch (1-50000)"),
        ("write_batch", "Rows per write batch (1-5000)"),
        ("error_limit", "Max dirty rows before abort (0=unlimited)"),
        ("speed_limit_rps", "Max rows/sec (empty=unlimited)"),
        ("channel_capacity", "Pipeline buffer size (default 16)"),
        ("shard_count", "Number of shards for parallel read"),
    ].into_iter().map(|(name, desc)| CompletionItem {
        label: name.into(),
        kind: "parameter".into(),
        detail: Some(desc.into()),
        insert_text: Some(format!("{name} = ")),
    }).collect()
}

fn type_completions() -> Vec<CompletionItem> {
    ["INT", "BIGINT", "SMALLINT", "BOOLEAN", "VARCHAR", "TEXT",
     "NUMERIC", "DECIMAL", "FLOAT", "DOUBLE", "DATE", "TIME",
     "TIMESTAMP", "TIMESTAMPTZ", "JSON", "JSONB", "BYTEA", "BLOB",
     "UUID"].iter().map(|t| CompletionItem {
        label: t.to_string(),
        kind: "type".into(),
        detail: None,
        insert_text: Some(t.to_string()),
    }).collect()
}

fn keyword_completions() -> Vec<CompletionItem> {
    vec![
        ("MIGRATE FROM", "Start a migration statement"),
        ("USE", "Declare a connection alias"),
        ("SET", "Configure pipeline parameters"),
        ("--", "Single-line comment"),
    ].into_iter().map(|(kw, desc)| CompletionItem {
        label: kw.into(),
        kind: "keyword".into(),
        detail: Some(desc.into()),
        insert_text: Some(if kw == "MIGRATE FROM" { "MIGRATE FROM ".into() } else { format!("{kw} ") }),
    }).collect()
}
```

- [ ] **Step 2: Update lsp/mod.rs**

```rust
pub mod handler;
pub mod completion;
pub mod diagnostics;
```

- [ ] **Step 3: Add completion route to handler.rs**

In `handler.rs`, add the completion match arm:

```rust
"textDocument/completion" => {
    let items = super::completion::complete(&params, app).await?;
    Ok(serde_json::to_value(items)?)
}
```

- [ ] **Step 4: Add db helper functions**

In the db module, add `list_all_connections()` if not already present:

```rust
pub fn list_all_connections() -> AppResult<Vec<(i64, String, String)>> {
    let db = get_db();
    let mut stmt = db.prepare("SELECT id, name, driver FROM connections")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

Also add stubs for `datasource::list_databases_for_connection` and `datasource::list_tables_for_connection` if they don't exist (they likely exist as `get_databases` / `get_tables` — adapt the function names to match existing code).

- [ ] **Step 5: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/migration/lsp/ src-tauri/src/db/
git commit -m "feat(migration): implement LSP completion provider"
```

---

## Task 13: LSP Hover

**Files:**
- Create: `src-tauri/src/migration/lsp/hover.rs`
- Modify: `src-tauri/src/migration/lsp/mod.rs`
- Modify: `src-tauri/src/migration/lsp/handler.rs`

- [ ] **Step 1: Create hover.rs**

```rust
use serde::Serialize;
use serde_json::Value;
use crate::error::AppResult;
use crate::migration::lang::{ast::*, parser};

#[derive(Debug, Clone, Serialize)]
pub struct HoverInfo {
    pub contents: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

pub async fn hover(
    params: &Value,
    app: &tauri::AppHandle,
) -> AppResult<Option<HoverInfo>> {
    let text = params["text"].as_str().unwrap_or("");
    let line = params["position"]["line"].as_u64().unwrap_or(0) as u32;
    let col = params["position"]["column"].as_u64().unwrap_or(0) as u32;

    let script = parser::parse_partial(text);

    // Find the word at cursor position
    let word = word_at_position(text, line, col);
    if word.is_empty() {
        return Ok(None);
    }

    // Check if it's a known SET parameter
    if let Some(info) = hover_set_param(&word) {
        return Ok(Some(info));
    }

    // Check if it's $LAST_VALUE
    if word == "$LAST_VALUE" {
        return Ok(Some(HoverInfo {
            contents: "**$LAST_VALUE**\n\nBuilt-in variable: the checkpoint value from the last incremental sync run.".into(),
            start_line: line, start_col: col,
            end_line: line, end_col: col + word.len() as u32,
        }));
    }

    // Check if it's a connection name or alias
    for stmt in &script.statements {
        if let Statement::Use(u) = stmt {
            if u.alias == word {
                return Ok(Some(HoverInfo {
                    contents: format!("**Alias** `{}` → connection `{}`", u.alias, u.connection_name),
                    start_line: line, start_col: col,
                    end_line: line, end_col: col + word.len() as u32,
                }));
            }
        }
    }

    // Check if word matches a connection name
    if let Ok(Some(id)) = crate::db::find_connection_id_by_name(&word) {
        return Ok(Some(HoverInfo {
            contents: format!("**Connection** `{word}` (id: {id})"),
            start_line: line, start_col: col,
            end_line: line, end_col: col + word.len() as u32,
        }));
    }

    Ok(None)
}

fn word_at_position(text: &str, line: u32, col: u32) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if line as usize >= lines.len() { return String::new(); }
    let line_text = lines[line as usize];
    let col = col as usize;
    if col >= line_text.len() { return String::new(); }

    let start = line_text[..col].rfind(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .map(|i| i + 1).unwrap_or(0);
    let end = line_text[col..].find(|c: char| !c.is_alphanumeric() && c != '_')
        .map(|i| col + i).unwrap_or(line_text.len());

    line_text[start..end].to_string()
}

fn hover_set_param(word: &str) -> Option<HoverInfo> {
    let desc = match word {
        "parallelism" => "**parallelism** `1-16`\n\nNumber of concurrent read/write workers.",
        "read_batch" | "read_batch_size" => "**read_batch** `1-50000` (default: 10000)\n\nRows fetched per read batch from source.",
        "write_batch" | "write_batch_size" => "**write_batch** `1-5000` (default: 1000)\n\nRows written per batch to target.",
        "error_limit" => "**error_limit** `0+` (default: 0)\n\nMax dirty rows before aborting. 0 = unlimited.",
        "speed_limit_rps" => "**speed_limit_rps** (optional)\n\nMax rows per second. Omit for unlimited.",
        "channel_capacity" => "**channel_capacity** (default: 16)\n\nPipeline backpressure buffer size in batches.",
        "shard_count" => "**shard_count** (optional)\n\nForce N shards for parallel reads (auto-detected by default).",
        _ => return None,
    };
    Some(HoverInfo {
        contents: desc.into(),
        start_line: 0, start_col: 0, end_line: 0, end_col: 0,
    })
}
```

- [ ] **Step 2: Update lsp/mod.rs**

```rust
pub mod handler;
pub mod completion;
pub mod diagnostics;
pub mod hover;
```

- [ ] **Step 3: Add hover route to handler.rs**

```rust
"textDocument/hover" => {
    let result = super::hover::hover(&params, app).await?;
    Ok(serde_json::to_value(result)?)
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd src-tauri && cargo check`

```bash
git add src-tauri/src/migration/lsp/
git commit -m "feat(migration): implement LSP hover provider"
```

---

## Task 14: Delete Old Frontend Components

**Files:**
- Delete: `src/components/MigrationJobTab/ConfigTab.tsx`
- Delete: `src/components/MigrationJobTab/TableMappingPanel.tsx`
- Delete: `src/components/MigrationJobTab/ColumnMappingPanel.tsx`
- Modify: `src/components/MigrationJobTab/index.tsx` (remove imports)
- Modify: `src/store/migrationStore.ts` (remove old methods)

- [ ] **Step 1: Delete files**

```bash
rm src/components/MigrationJobTab/ConfigTab.tsx
rm src/components/MigrationJobTab/TableMappingPanel.tsx
rm src/components/MigrationJobTab/ColumnMappingPanel.tsx
```

- [ ] **Step 2: Update migrationStore.ts**

In `src/store/migrationStore.ts`:
- Remove the `invoke('update_migration_job_config', ...)` call (around line 48) and replace with:

```typescript
updateJobScript: async (jobId: number, scriptText: string) => {
    await invoke('update_migration_job_script', { id: jobId, scriptText });
},
```

- Remove any temporary config editing state (source/target connection selectors, column mapping drafts, etc.)

- [ ] **Step 3: Clean up index.tsx imports**

In `src/components/MigrationJobTab/index.tsx`, remove:

```typescript
// Remove these imports:
import { ConfigTab, ConfigTabHandle } from './ConfigTab'
```

Leave the file with just enough to not crash — it will be fully rewritten in a later task.

- [ ] **Step 4: TypeScript type check**

Run: `npx tsc --noEmit`
Expected: May have errors in index.tsx since ConfigTab is removed but still referenced. That's OK — it will be fully rewritten in Task 18.

- [ ] **Step 5: Commit**

```bash
git add -A src/components/MigrationJobTab/ src/store/migrationStore.ts
git commit -m "refactor(migration): delete old GUI config components"
```

---

## Task 15: Monarch Tokenizer

**Files:**
- Create: `src/components/MigrationJobTab/MonarchTokenizer.ts`

- [ ] **Step 1: Create the tokenizer**

```typescript
import * as monaco from 'monaco-editor';

export const MIGRATEQL_LANGUAGE_ID = 'migrateql';

export const migrateqlLanguageConfig: monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '--',
    blockComment: ['/*', '*/'],
  },
  brackets: [['(', ')']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" },
    { open: '/*', close: '*/' },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" },
  ],
};

export const migrateqlMonarchTokens: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: [
    'MIGRATE', 'FROM', 'INTO', 'MAPPING', 'WHERE', 'SET', 'USE',
    'CONNECTION', 'ON', 'CONFLICT', 'UPSERT', 'REPLACE', 'SKIP',
    'INSERT', 'OVERWRITE', 'BY', 'INCREMENTAL', 'CREATE', 'IF',
    'NOT', 'EXISTS',
  ],
  tokenizer: {
    root: [
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/'[^']*'/, 'string'],
      [/\$[A-Z_]+/, 'variable'],
      [/::/, 'operator'],
      [/->/, 'operator'],
      [/[(),;.]/, 'delimiter'],
      [/=/, 'operator'],
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],
      [/\d+/, 'number'],
      [/\s+/, 'white'],
    ],
    comment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment'],
    ],
  },
};

let registered = false;

export function registerMigrateQLLanguage() {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: MIGRATEQL_LANGUAGE_ID });
  monaco.languages.setLanguageConfiguration(MIGRATEQL_LANGUAGE_ID, migrateqlLanguageConfig);
  monaco.languages.setMonarchTokensProvider(MIGRATEQL_LANGUAGE_ID, migrateqlMonarchTokens);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/MonarchTokenizer.ts
git commit -m "feat(migration): add MigrateQL Monarch tokenizer for Monaco"
```

---

## Task 16: LSP Adapter

**Files:**
- Create: `src/components/MigrationJobTab/LspAdapter.ts`

- [ ] **Step 1: Create the adapter**

```typescript
import { invoke } from '@tauri-apps/api/core';
import * as monaco from 'monaco-editor';

export interface LspDiagnostic {
  severity: string;
  message: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export interface LspCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  insert_text?: string;
}

export interface LspHoverInfo {
  contents: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export class MigrateQLLspAdapter {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private editor: monaco.editor.IStandaloneCodeEditor;
  private disposables: monaco.IDisposable[] = [];

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
  }

  start() {
    // Listen for content changes → debounced diagnostics
    this.disposables.push(
      this.editor.onDidChangeModelContent(() => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.requestDiagnostics();
        }, 300);
      })
    );
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private async requestDiagnostics() {
    const model = this.editor.getModel();
    if (!model) return;

    try {
      const diagnostics = await invoke<LspDiagnostic[]>('lsp_request', {
        method: 'textDocument/diagnostic',
        params: { text: model.getValue() },
      });

      const markers: monaco.editor.IMarkerData[] = diagnostics.map(d => ({
        severity: d.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.start_line + 1,
        startColumn: d.start_col + 1,
        endLineNumber: d.end_line + 1,
        endColumn: d.end_col + 2,
      }));

      monaco.editor.setModelMarkers(model, 'migrateql', markers);
    } catch (e) {
      console.error('LSP diagnostics error:', e);
    }
  }

  static registerCompletionProvider() {
    return monaco.languages.registerCompletionItemProvider('migrateql', {
      triggerCharacters: ['.', ' ', ':', ','],
      provideCompletionItems: async (model, position) => {
        try {
          const items = await invoke<LspCompletionItem[]>('lsp_request', {
            method: 'textDocument/completion',
            params: {
              text: model.getValue(),
              position: {
                line: position.lineNumber - 1,
                column: position.column - 1,
              },
            },
          });

          const kindMap: Record<string, monaco.languages.CompletionItemKind> = {
            keyword: monaco.languages.CompletionItemKind.Keyword,
            connection: monaco.languages.CompletionItemKind.Reference,
            database: monaco.languages.CompletionItemKind.Module,
            table: monaco.languages.CompletionItemKind.Struct,
            column: monaco.languages.CompletionItemKind.Field,
            type: monaco.languages.CompletionItemKind.TypeParameter,
            parameter: monaco.languages.CompletionItemKind.Property,
          };

          return {
            suggestions: items.map((item, i) => ({
              label: item.label,
              kind: kindMap[item.kind] || monaco.languages.CompletionItemKind.Text,
              detail: item.detail,
              insertText: item.insert_text || item.label,
              sortText: String(i).padStart(4, '0'),
              range: undefined as any,
            })),
          };
        } catch {
          return { suggestions: [] };
        }
      },
    });
  }

  static registerHoverProvider() {
    return monaco.languages.registerHoverProvider('migrateql', {
      provideHover: async (model, position) => {
        try {
          const result = await invoke<LspHoverInfo | null>('lsp_request', {
            method: 'textDocument/hover',
            params: {
              text: model.getValue(),
              position: {
                line: position.lineNumber - 1,
                column: position.column - 1,
              },
            },
          });

          if (!result) return null;

          return {
            contents: [{ value: result.contents }],
            range: new monaco.Range(
              result.start_line + 1, result.start_col + 1,
              result.end_line + 1, result.end_col + 2,
            ),
          };
        } catch {
          return null;
        }
      },
    });
  }

  async format(): Promise<string | null> {
    const model = this.editor.getModel();
    if (!model) return null;

    try {
      const result = await invoke<string | null>('lsp_request', {
        method: 'textDocument/formatting',
        params: { text: model.getValue() },
      });
      return result;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/LspAdapter.ts
git commit -m "feat(migration): add MigrateQL LSP adapter for Monaco"
```

---

## Task 17: MigrationEditor Component

**Files:**
- Create: `src/components/MigrationJobTab/MigrationEditor.tsx`

- [ ] **Step 1: Create the editor component**

```tsx
import { useEffect, useRef, useCallback } from 'react';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { registerMigrateQLLanguage, MIGRATEQL_LANGUAGE_ID } from './MonarchTokenizer';
import { MigrateQLLspAdapter } from './LspAdapter';

interface MigrationEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export function MigrationEditor({ value, onChange, onSave }: MigrationEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const lspRef = useRef<MigrateQLLspAdapter | null>(null);

  useEffect(() => {
    registerMigrateQLLanguage();
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    // Start LSP adapter
    const lsp = new MigrateQLLspAdapter(editor);
    lsp.start();
    lspRef.current = lsp;

    // Register providers (once globally)
    MigrateQLLspAdapter.registerCompletionProvider();
    MigrateQLLspAdapter.registerHoverProvider();

    // Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSave?.();
    });
  }, [onSave]);

  useEffect(() => {
    return () => {
      lspRef.current?.dispose();
    };
  }, []);

  return (
    <div className="flex-1 relative bg-background-panel min-h-0">
      <MonacoEditor
        language={MIGRATEQL_LANGUAGE_ID}
        theme="odb-dark"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={handleEditorMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          renderWhitespace: 'selection',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MigrationJobTab/MigrationEditor.tsx
git commit -m "feat(migration): add MigrationEditor component"
```

---

## Task 18: MigrationToolbar + ResultPanel + index.tsx Rewrite

**Files:**
- Create: `src/components/MigrationJobTab/MigrationToolbar.tsx`
- Create: `src/components/MigrationJobTab/ResultPanel/index.tsx`
- Create: `src/components/MigrationJobTab/ResultPanel/HistoryTab.tsx`
- Rewrite: `src/components/MigrationJobTab/index.tsx`

- [ ] **Step 1: Create MigrationToolbar**

```tsx
import { Play, Square, FileEdit, Sparkles } from 'lucide-react';

interface MigrationToolbarProps {
  onRun: () => void;
  onStop: () => void;
  onFormat: () => void;
  isRunning: boolean;
  ghostTextEnabled: boolean;
  onToggleGhostText: () => void;
}

export function MigrationToolbar({
  onRun, onStop, onFormat, isRunning,
  ghostTextEnabled, onToggleGhostText,
}: MigrationToolbarProps) {
  return (
    <div className="h-10 flex items-center gap-1 px-2 bg-background-panel border-b border-border-default flex-shrink-0">
      {!isRunning ? (
        <button
          onClick={onRun}
          className="h-7 w-7 flex items-center justify-center rounded text-foreground-muted hover:text-success hover:bg-background-hover transition-colors duration-150"
          title="Run (Ctrl+Enter)"
        >
          <Play size={14} />
        </button>
      ) : (
        <button
          onClick={onStop}
          className="h-7 w-7 flex items-center justify-center rounded text-foreground-muted hover:text-error hover:bg-background-hover transition-colors duration-150"
          title="Stop"
        >
          <Square size={14} />
        </button>
      )}

      <button
        onClick={onFormat}
        className="h-7 w-7 flex items-center justify-center rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors duration-150"
        title="Format"
      >
        <FileEdit size={14} />
      </button>

      <button
        onClick={onToggleGhostText}
        className={`h-7 w-7 flex items-center justify-center rounded transition-colors duration-150 ${
          ghostTextEnabled
            ? 'text-accent'
            : 'text-foreground-muted hover:text-foreground-default hover:bg-background-hover'
        }`}
        title="Ghost Text AI Completion"
      >
        <Sparkles size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create ResultPanel/index.tsx**

```tsx
import { useState } from 'react';
import { LogTab } from '../LogTab';
import { StatsTab } from '../StatsTab';
import { HistoryTab } from './HistoryTab';

interface ResultPanelProps {
  jobId: number;
}

type PanelTab = 'logs' | 'stats' | 'history';

export function ResultPanel({ jobId }: ResultPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('logs');

  const tabs: { key: PanelTab; label: string }[] = [
    { key: 'logs', label: 'Logs' },
    { key: 'stats', label: 'Stats' },
    { key: 'history', label: 'History' },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-background-void">
      {/* Tab bar */}
      <div className="flex items-start bg-background-base border-t border-border-default flex-shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer transition-colors duration-150 ${
              activeTab === tab.key
                ? 'bg-background-void text-accent border-t-[3px] border-t-accent'
                : 'bg-background-hover text-foreground-muted border-t-[3px] border-t-transparent hover:bg-background-elevated'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'logs' && <LogTab jobId={jobId} />}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
        {activeTab === 'history' && <HistoryTab jobId={jobId} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create ResultPanel/HistoryTab.tsx**

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Clock, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

interface RunRecord {
  id: number;
  run_id: string;
  status: string;
  rows_read: number;
  rows_written: number;
  rows_failed: number;
  bytes_transferred: number;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}

interface HistoryTabProps {
  jobId: number;
}

export function HistoryTab({ jobId }: HistoryTabProps) {
  const [records, setRecords] = useState<RunRecord[]>([]);

  useEffect(() => {
    loadHistory();
  }, [jobId]);

  const loadHistory = async () => {
    try {
      const data = await invoke<RunRecord[]>('get_migration_run_history', { jobId });
      setRecords(data);
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'FINISHED': return <CheckCircle size={12} className="text-success" />;
      case 'FAILED': return <XCircle size={12} className="text-error" />;
      case 'PARTIAL_FAILED': return <AlertTriangle size={12} className="text-warning" />;
      default: return <Clock size={12} className="text-foreground-muted" />;
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (records.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-foreground-muted text-xs">
        No run history
      </div>
    );
  }

  return (
    <div className="p-2 space-y-1">
      {records.map(r => (
        <div
          key={r.run_id}
          className="flex items-center gap-3 px-3 py-2 bg-background-elevated rounded text-xs hover:bg-background-hover transition-colors duration-150 cursor-pointer"
        >
          {statusIcon(r.status)}
          <span className="text-foreground-default font-medium">{r.status}</span>
          <span className="text-foreground-muted">{r.started_at}</span>
          <span className="text-foreground-muted">{formatDuration(r.duration_ms)}</span>
          <span className="text-foreground-muted ml-auto">
            R:{r.rows_read} W:{r.rows_written} F:{r.rows_failed} | {formatBytes(r.bytes_transferred)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite index.tsx**

Rewrite `src/components/MigrationJobTab/index.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MigrationEditor } from './MigrationEditor';
import { MigrationToolbar } from './MigrationToolbar';
import { ResultPanel } from './ResultPanel';
import { useMigrationStore } from '../../store/migrationStore';

interface MigrationJobTabProps {
  jobId: number;
}

export default function MigrationJobTab({ jobId }: MigrationJobTabProps) {
  const [scriptText, setScriptText] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [ghostTextEnabled, setGhostTextEnabled] = useState(false);
  const [resultsHeight, setResultsHeight] = useState(250);
  const [loaded, setLoaded] = useState(false);
  const splitterRef = useRef<HTMLDivElement>(null);

  const { runJob, activeRuns } = useMigrationStore();

  // Load script text from DB
  useEffect(() => {
    const loadScript = async () => {
      try {
        const jobs = await invoke<any[]>('list_migration_jobs');
        const job = jobs.find((j: any) => j.id === jobId);
        if (job) {
          setScriptText(job.script_text || '');
        }
        setLoaded(true);
      } catch (e) {
        console.error('Failed to load migration job:', e);
        setLoaded(true);
      }
    };
    loadScript();
  }, [jobId]);

  // Track running state
  useEffect(() => {
    const run = activeRuns.get(jobId);
    setIsRunning(!!run);
  }, [activeRuns, jobId]);

  // Auto-save on change (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback((value: string) => {
    setScriptText(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await invoke('update_migration_job_script', { id: jobId, scriptText: value });
      } catch (e) {
        console.error('Auto-save failed:', e);
      }
    }, 1000);
  }, [jobId]);

  const handleRun = useCallback(async () => {
    // Save before run
    await invoke('update_migration_job_script', { id: jobId, scriptText });
    await runJob(jobId);
  }, [jobId, scriptText, runJob]);

  const handleStop = useCallback(async () => {
    await invoke('stop_migration_job', { jobId });
  }, [jobId]);

  const handleFormat = useCallback(async () => {
    try {
      const result = await invoke<string | null>('lsp_request', {
        method: 'textDocument/formatting',
        params: { text: scriptText },
      });
      if (result) {
        setScriptText(result);
        await invoke('update_migration_job_script', { id: jobId, scriptText: result });
      }
    } catch (e) {
      console.error('Format failed:', e);
    }
  }, [jobId, scriptText]);

  const handleSave = useCallback(async () => {
    await invoke('update_migration_job_script', { id: jobId, scriptText });
  }, [jobId, scriptText]);

  // Splitter drag
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = resultsHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setResultsHeight(Math.max(100, Math.min(600, startHeight + delta)));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [resultsHeight]);

  if (!loaded) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <MigrationToolbar
        onRun={handleRun}
        onStop={handleStop}
        onFormat={handleFormat}
        isRunning={isRunning}
        ghostTextEnabled={ghostTextEnabled}
        onToggleGhostText={() => setGhostTextEnabled(!ghostTextEnabled)}
      />

      {/* Editor */}
      <MigrationEditor
        value={scriptText}
        onChange={handleChange}
        onSave={handleSave}
      />

      {/* Splitter */}
      <div
        ref={splitterRef}
        className="h-[4.5px] cursor-row-resize bg-transparent hover:bg-accent/30 transition-colors flex-shrink-0"
        onMouseDown={handleSplitterMouseDown}
      />

      {/* Result Panel */}
      <div style={{ height: resultsHeight }} className="flex-shrink-0">
        <ResultPanel jobId={jobId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: TypeScript type check**

Run: `npx tsc --noEmit`
Expected: Clean or only unrelated warnings. Fix any type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/MigrationJobTab/
git commit -m "feat(migration): rewrite MigrationJobTab with code editor layout"
```

---

## Task 19: Ghost Text AI Integration

**Files:**
- Create: `prompts/migration_ghost_text.md`
- Modify: `src-tauri/src/migration/lsp/completion.rs` (add inline trigger)
- Modify: `src/components/MigrationJobTab/MigrationEditor.tsx`

- [ ] **Step 1: Create prompt template**

Create `prompts/migration_ghost_text.md`:

```markdown
You are a MigrateQL code completion assistant. Based on the user's existing script and cursor position, continue writing subsequent code.

## MigrateQL Syntax Reference
- MIGRATE FROM <conn.db.table> INTO <conn.db.table>
- MAPPING (source_col -> target_col :: TYPE, ...)
- MAPPING (*) for auto-mapping same-name columns
- WHERE <condition>
- ON CONFLICT UPSERT|REPLACE|SKIP|INSERT|OVERWRITE BY (col, ...)
- INCREMENTAL ON <column>
- CREATE IF NOT EXISTS
- USE <alias> = CONNECTION('<name>');
- SET parallelism=N, read_batch=N, write_batch=N, error_limit=N;

## Available Database Schemas
{{schemas}}

## Current Script
{{current_script}}

## Cursor Position
End of line {{cursor_line}}

## Requirements
- Only output continuation code, do not repeat existing content
- Infer user intent from context
- Generate accurate column names and types based on available table schemas
```

- [ ] **Step 2: Add Ghost Text handler to completion.rs**

Add to the bottom of `completion.rs`:

```rust
pub async fn complete_inline(
    params: &Value,
    app: &tauri::AppHandle,
) -> AppResult<Option<String>> {
    let text = params["text"].as_str().unwrap_or("");
    let cursor_line = params["position"]["line"].as_u64().unwrap_or(0) as u32;

    // Build context with referenced connection schemas
    let partial_ast = crate::migration::lang::parser::parse_partial(text);
    let mut schema_info = String::new();

    for stmt in &partial_ast.statements {
        if let crate::migration::lang::ast::Statement::Use(u) = stmt {
            if let Ok(Some(id)) = crate::db::find_connection_id_by_name(&u.connection_name) {
                schema_info.push_str(&format!("Connection '{}' (id: {id})\n", u.connection_name));
                // Would load table schemas here in full implementation
            }
        }
    }

    // Call LLM for ghost text
    let prompt = format!(
        include_str!("../../../prompts/migration_ghost_text.md"),
    )
    .replace("{{schemas}}", &schema_info)
    .replace("{{current_script}}", text)
    .replace("{{cursor_line}}", &cursor_line.to_string());

    match crate::llm::client::llm_request_simple(&prompt, 500, 0.1).await {
        Ok(suggestion) => Ok(Some(suggestion.trim().to_string())),
        Err(_) => Ok(None),
    }
}
```

- [ ] **Step 3: Add inline completion route to handler.rs**

```rust
"textDocument/inlineCompletion" => {
    let result = super::completion::complete_inline(&params, app).await?;
    Ok(serde_json::to_value(result)?)
}
```

- [ ] **Step 4: Register inline completion provider in MigrationEditor.tsx**

Add to `handleEditorMount` in `MigrationEditor.tsx`:

```typescript
// Ghost Text inline completion
monaco.languages.registerInlineCompletionsProvider(MIGRATEQL_LANGUAGE_ID, {
  provideInlineCompletions: async (model, position) => {
    if (!ghostTextEnabled) return { items: [] };
    try {
      const result = await invoke<string | null>('lsp_request', {
        method: 'textDocument/inlineCompletion',
        params: {
          text: model.getValue(),
          position: {
            line: position.lineNumber - 1,
            column: position.column - 1,
          },
        },
      });
      if (!result) return { items: [] };
      return {
        items: [{
          insertText: result,
          range: new monaco.Range(
            position.lineNumber, position.column,
            position.lineNumber, position.column,
          ),
        }],
      };
    } catch {
      return { items: [] };
    }
  },
  freeInlineCompletions: () => {},
});
```

Note: `ghostTextEnabled` needs to be passed into the editor as a prop and used via a ref to avoid stale closures.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit && cd src-tauri && cargo check`
Expected: Both pass.

- [ ] **Step 6: Commit**

```bash
git add prompts/migration_ghost_text.md src-tauri/src/migration/lsp/ src/components/MigrationJobTab/MigrationEditor.tsx
git commit -m "feat(migration): add Ghost Text AI completion for MigrateQL"
```

---

## Task 20: Final Verification & Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 2: Full Rust check**

Run: `cd src-tauri && cargo check`
Expected: Clean.

- [ ] **Step 3: Run all Rust tests**

Run: `cd src-tauri && cargo test migration:: -- --nocapture`
Expected: All parser, compiler, formatter, diagnostics tests pass.

- [ ] **Step 4: Verify no dead imports**

Search for any remaining references to deleted components (`ConfigTab`, `TableMappingPanel`, `ColumnMappingPanel`, `config_json`, `update_migration_job_config`, `ai_recommend_column_mappings`):

```bash
grep -r "ConfigTab\|TableMappingPanel\|ColumnMappingPanel\|config_json\|update_migration_job_config\|ai_recommend_column_mappings" src/ src-tauri/src/ --include="*.ts" --include="*.tsx" --include="*.rs"
```

Expected: No matches (or only in comments/docs).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(migration): final cleanup for MigrateQL migration"
```
