use std::collections::HashSet;
use std::sync::OnceLock;
use regex::Regex;

static RE1: OnceLock<Regex> = OnceLock::new();
static RE2: OnceLock<Regex> = OnceLock::new();
static RE3: OnceLock<Regex> = OnceLock::new();
static RE4: OnceLock<Regex> = OnceLock::new();

/// 列注释中提取的虚拟关系引用
#[derive(Debug, PartialEq, Clone)]
pub struct CommentRef {
    pub target_table: String,
    pub target_column: String,
    pub relation_type: String,  // 默认 "fk"
}

/// 解析列注释中的关系标记，返回去重后的引用列表
/// 支持格式：
///   @ref:table.col
///   @fk(table=orders,col=id,type=one_to_many)
///   [ref:table.col]
///   $$ref(table.col)$$
pub fn parse_comment_refs(comment: &str) -> Vec<CommentRef> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut result = Vec::new();

    let re1 = RE1.get_or_init(|| Regex::new(r"@ref:([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)").unwrap());
    let re2 = RE2.get_or_init(|| Regex::new(r"@fk\(([^)]+)\)").unwrap());
    let re3 = RE3.get_or_init(|| Regex::new(r"\[ref:([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\]").unwrap());
    let re4 = RE4.get_or_init(|| Regex::new(r"\$\$ref\(([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\)\$\$").unwrap());

    // 模式1: @ref:table.col
    for cap in re1.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    // 模式2: @fk(table=X,col=Y,type=Z) — type 可选
    for cap in re2.captures_iter(comment) {
        let inner = &cap[1];
        let mut table = String::new();
        let mut col = String::new();
        let mut rel_type = "fk".to_string();
        for part in inner.split(',') {
            let kv: Vec<&str> = part.splitn(2, '=').collect();
            if kv.len() == 2 {
                match kv[0].trim() {
                    "table" => table = kv[1].trim().to_string(),
                    "col"   => col   = kv[1].trim().to_string(),
                    "type"  => rel_type = kv[1].trim().to_string(),
                    _ => {}
                }
            }
        }
        if !table.is_empty() && !col.is_empty() && seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: rel_type });
        }
    }

    // 模式3: [ref:table.col]
    for cap in re3.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    // 模式4: $$ref(table.col)$$
    for cap in re4.captures_iter(comment) {
        let table = cap[1].to_string();
        let col = cap[2].to_string();
        if seen.insert((table.clone(), col.clone())) {
            result.push(CommentRef { target_table: table, target_column: col, relation_type: "fk".to_string() });
        }
    }

    result
}

// ── parse_comment: 仅测试使用 ────────────────────────────────────────────

#[cfg(test)]
static RE_S1: OnceLock<Regex> = OnceLock::new();
#[cfg(test)]
static RE_S2: OnceLock<Regex> = OnceLock::new();
#[cfg(test)]
static RE_S3: OnceLock<Regex> = OnceLock::new();
#[cfg(test)]
static RE_S4: OnceLock<Regex> = OnceLock::new();

/// 解析列注释的完整结果：引用列表 + 去除标记后的干净描述
#[cfg(test)]
#[derive(Debug, PartialEq, Clone)]
struct ParsedComment {
    refs: Vec<CommentRef>,
    clean_text: String,
}

/// 解析列注释，返回引用列表和去除所有标记后的干净描述文本。
#[cfg(test)]
fn parse_comment(comment: &str) -> ParsedComment {
    let refs = parse_comment_refs(comment);

    let s1 = RE_S1.get_or_init(|| Regex::new(r"@ref:[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*").unwrap());
    let s2 = RE_S2.get_or_init(|| Regex::new(r"@fk\([^)]+\)").unwrap());
    let s3 = RE_S3.get_or_init(|| Regex::new(r"\[ref:[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\]").unwrap());
    let s4 = RE_S4.get_or_init(|| Regex::new(r"\$\$ref\([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\)\$\$").unwrap());

    let t = s1.replace_all(comment, "");
    let t = s2.replace_all(&t, "");
    let t = s3.replace_all(&t, "");
    let t = s4.replace_all(&t, "");
    let clean_text = t.split_whitespace().collect::<Vec<_>>().join(" ");

    ParsedComment { refs, clean_text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_at_ref_simple() {
        let refs = parse_comment_refs("关联用户 @ref:users.id");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "users");
        assert_eq!(refs[0].target_column, "id");
        assert_eq!(refs[0].relation_type, "fk");
    }

    #[test]
    fn test_at_fk_explicit() {
        let refs = parse_comment_refs("@fk(table=orders,col=order_id,type=one_to_many)");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "orders");
        assert_eq!(refs[0].target_column, "order_id");
        assert_eq!(refs[0].relation_type, "one_to_many");
    }

    #[test]
    fn test_bracket_ref() {
        let refs = parse_comment_refs("外键 [ref:products.id] 备注");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "products");
        assert_eq!(refs[0].target_column, "id");
    }

    #[test]
    fn test_dollar_ref() {
        let refs = parse_comment_refs("$$ref(orders.id)$$ 订单外键");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].target_table, "orders");
        assert_eq!(refs[0].target_column, "id");
    }

    #[test]
    fn test_multiple_refs_dedup() {
        let refs = parse_comment_refs("@ref:users.id [ref:users.id]");
        assert_eq!(refs.len(), 1, "同目标去重");
    }

    #[test]
    fn test_multiple_different_refs() {
        let refs = parse_comment_refs("@ref:users.id @ref:orders.order_id");
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn test_no_marker_returns_empty() {
        let refs = parse_comment_refs("普通注释，无标记");
        assert!(refs.is_empty());
    }

    #[test]
    fn test_empty_comment() {
        let refs = parse_comment_refs("");
        assert!(refs.is_empty());
    }

    #[test]
    fn test_at_fk_default_type() {
        let refs = parse_comment_refs("@fk(table=users,col=id)");
        assert_eq!(refs[0].relation_type, "fk");
    }

    #[test]
    fn test_mixed_formats() {
        let refs = parse_comment_refs("@ref:users.id @fk(table=orders,col=order_id) [ref:products.sku]");
        assert_eq!(refs.len(), 3, "混合格式应正确解析");
        let tables: Vec<&str> = refs.iter().map(|r| r.target_table.as_str()).collect();
        assert!(tables.contains(&"users"));
        assert!(tables.contains(&"orders"));
        assert!(tables.contains(&"products"));
    }

    #[test]
    fn test_parse_comment_format_then_desc() {
        let p = parse_comment("@ref:users.id 用户主键");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.refs[0].target_table, "users");
        assert_eq!(p.clean_text, "用户主键");
    }

    #[test]
    fn test_parse_comment_desc_then_format() {
        let p = parse_comment("用户ID @ref:users.id");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.clean_text, "用户ID");
    }

    #[test]
    fn test_parse_comment_fk_explicit_with_desc() {
        let p = parse_comment("@fk(table=orders,col=id,type=one_to_many) 订单编号");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.refs[0].target_table, "orders");
        assert_eq!(p.refs[0].relation_type, "one_to_many");
        assert_eq!(p.clean_text, "订单编号");
    }

    #[test]
    fn test_parse_comment_no_marker_returns_original() {
        let p = parse_comment("普通备注无标记");
        assert!(p.refs.is_empty());
        assert_eq!(p.clean_text, "普通备注无标记");
    }

    #[test]
    fn test_parse_comment_only_marker_clean_empty() {
        let p = parse_comment("@ref:users.id");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.clean_text, "");
    }

    #[test]
    fn test_parse_comment_mixed_markers_stripped() {
        let p = parse_comment("@ref:users.id [ref:orders.id] 复合描述");
        assert_eq!(p.refs.len(), 2);
        assert_eq!(p.clean_text, "复合描述");
    }
}
