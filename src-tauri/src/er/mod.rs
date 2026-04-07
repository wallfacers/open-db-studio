pub mod models;
pub mod repository;
pub mod ddl_generator;
pub mod diff_engine;
pub mod export;
pub mod commands;
pub mod constraint;
pub mod table_sorter;

/// Strip the UNSIGNED qualifier from a SQL type string (case-insensitive).
/// Returns the cleaned string and whether UNSIGNED was present.
pub(crate) fn strip_unsigned(s: &str) -> (String, bool) {
    let has_unsigned = s.split_whitespace().any(|w| w.eq_ignore_ascii_case("UNSIGNED"));
    if !has_unsigned {
        return (s.to_string(), false);
    }
    let cleaned = s
        .split_whitespace()
        .filter(|w| !w.eq_ignore_ascii_case("UNSIGNED"))
        .collect::<Vec<_>>()
        .join(" ");
    (cleaned, true)
}
