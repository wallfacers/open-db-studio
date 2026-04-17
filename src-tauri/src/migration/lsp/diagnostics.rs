use serde::Serialize;
use crate::migration::lang::parser;

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

pub async fn diagnose(text: &str, _app: &tauri::AppHandle) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

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

    if let Some(script) = ast {
        semantic_check(&script, &mut diagnostics).await;
    }

    diagnostics
}

async fn semantic_check(
    script: &crate::migration::lang::ast::Script,
    diagnostics: &mut Vec<Diagnostic>,
) {
    use crate::migration::lang::ast::*;

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
