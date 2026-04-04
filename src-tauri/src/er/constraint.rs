use super::models::{ErProject, ErRelation, ErTable};

// ── 继承解析 ──────────────────────────────────────────────────────────

/// 解析生效的约束方式：relation → table → project → 'database_fk'
pub fn resolve_constraint_method<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    if let Some(ref m) = relation.constraint_method {
        if !m.is_empty() { return m; }
    }
    if let Some(t) = table {
        if let Some(ref m) = t.constraint_method {
            if !m.is_empty() { return m; }
        }
    }
    if let Some(p) = project {
        if !p.default_constraint_method.is_empty() {
            return &p.default_constraint_method;
        }
    }
    "database_fk"
}

/// 解析生效的注释格式：relation → table → project → '@ref'
pub fn resolve_comment_format<'a>(
    relation: &'a ErRelation,
    table: Option<&'a ErTable>,
    project: Option<&'a ErProject>,
) -> &'a str {
    if let Some(ref f) = relation.comment_format {
        if !f.is_empty() { return f; }
    }
    if let Some(t) = table {
        if let Some(ref f) = t.comment_format {
            if !f.is_empty() { return f; }
        }
    }
    if let Some(p) = project {
        if !p.default_comment_format.is_empty() {
            return &p.default_comment_format;
        }
    }
    "@ref"
}

// ── 注释标记构建 ──────────────────────────────────────────────────────

/// 根据格式构建注释标记字符串。
/// format: "@ref" | "@fk" | "[ref]" | "$$ref$$"
pub fn build_comment_marker(
    target_table: &str,
    target_col: &str,
    relation_type: &str,
    format: &str,
) -> String {
    match format {
        "@fk"     => format!("@fk(table={},col={},type={})", target_table, target_col, relation_type),
        "[ref]"   => format!("[ref:{}.{}]", target_table, target_col),
        "$$ref$$" => format!("$$ref({}.{})$$", target_table, target_col),
        _         => format!("@ref:{}.{}", target_table, target_col),
    }
}

/// 幂等地在已有注释后追加标记（空格分隔，已存在则不重复）。
pub fn append_marker_to_comment(existing: Option<&str>, marker: &str) -> String {
    let base = existing.unwrap_or("").trim();
    if base.is_empty() {
        marker.to_string()
    } else if base.contains(marker) {
        base.to_string()
    } else {
        format!("{} {}", base, marker)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_project(default_method: &str, default_format: &str) -> ErProject {
        ErProject {
            id: 1,
            name: "test".to_string(),
            description: None,
            connection_id: None,
            database_name: None,
            schema_name: None,
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_zoom: 1.0,
            default_constraint_method: default_method.to_string(),
            default_comment_format: default_format.to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_table(cm: Option<&str>, cf: Option<&str>) -> ErTable {
        ErTable {
            id: 1,
            project_id: 1,
            name: "orders".to_string(),
            comment: None,
            position_x: 0.0,
            position_y: 0.0,
            color: None,
            constraint_method: cm.map(str::to_string),
            comment_format: cf.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_relation(cm: Option<&str>, cf: Option<&str>) -> ErRelation {
        ErRelation {
            id: 1,
            project_id: 1,
            name: None,
            source_table_id: 1,
            source_column_id: 10,
            target_table_id: 2,
            target_column_id: 20,
            relation_type: "one_to_many".to_string(),
            on_delete: "NO ACTION".to_string(),
            on_update: "NO ACTION".to_string(),
            source: "designer".to_string(),
            comment_marker: None,
            constraint_method: cm.map(str::to_string),
            comment_format: cf.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    // ── resolve_constraint_method ─────────────────────────────────────

    #[test]
    fn test_relation_overrides_all() {
        let project = make_project("database_fk", "@ref");
        let table = make_table(Some("database_fk"), None);
        let relation = make_relation(Some("comment_ref"), None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_table_overrides_project() {
        let project = make_project("database_fk", "@ref");
        let table = make_table(Some("comment_ref"), None);
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_falls_back_to_project() {
        let project = make_project("comment_ref", "@ref");
        let table = make_table(None, None);
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, Some(&table), Some(&project)), "comment_ref");
    }

    #[test]
    fn test_falls_back_to_default_when_no_project() {
        let relation = make_relation(None, None);
        assert_eq!(resolve_constraint_method(&relation, None, None), "database_fk");
    }

    // ── build_comment_marker ──────────────────────────────────────────

    #[test]
    fn test_build_marker_at_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "@ref"),
            "@ref:users.id"
        );
    }

    #[test]
    fn test_build_marker_at_fk() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "@fk"),
            "@fk(table=users,col=id,type=one_to_many)"
        );
    }

    #[test]
    fn test_build_marker_bracket_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "[ref]"),
            "[ref:users.id]"
        );
    }

    #[test]
    fn test_build_marker_dollar_ref() {
        assert_eq!(
            build_comment_marker("users", "id", "one_to_many", "$$ref$$"),
            "$$ref(users.id)$$"
        );
    }

    // ── append_marker_to_comment ──────────────────────────────────────

    #[test]
    fn test_append_to_empty_comment() {
        assert_eq!(
            append_marker_to_comment(None, "@ref:users.id"),
            "@ref:users.id"
        );
    }

    #[test]
    fn test_append_to_existing_comment() {
        assert_eq!(
            append_marker_to_comment(Some("用户ID"), "@ref:users.id"),
            "用户ID @ref:users.id"
        );
    }

    #[test]
    fn test_append_is_idempotent() {
        assert_eq!(
            append_marker_to_comment(Some("用户ID @ref:users.id"), "@ref:users.id"),
            "用户ID @ref:users.id"
        );
    }
}
