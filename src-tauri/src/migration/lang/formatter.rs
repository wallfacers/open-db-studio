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
