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
    // pest wraps everything in a top-level `script` pair
    let script_pair = pairs.into_iter().next().unwrap();
    for pair in script_pair.into_inner() {
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
            let script_pair = pairs.into_iter().next().unwrap();
            for pair in script_pair.into_inner() {
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
        Rule::byte_literal => SetValue::Ident(inner.as_str().to_string()),
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
