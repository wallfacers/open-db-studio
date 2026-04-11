use serde_json::Value;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PkSplit {
    /// Inclusive start of pk range.
    pub start: i64,
    /// Exclusive end of pk range. `None` means unbounded (last split).
    pub end: Option<i64>,
}

// ── Pure helper (tested below) ────────────────────────────────────────────────

/// Divide `[min_pk, max_pk]` into at most `split_count` non-overlapping segments.
/// Returns at least 1 split even if split_count == 0.
/// Public so pipeline.rs can call it after getting min/max from the DB.
pub fn compute_range_splits(min_pk: i64, max_pk: i64, split_count: usize) -> Vec<PkSplit> {
    if min_pk > max_pk {
        return vec![];
    }
    let n = split_count.max(1) as i64;
    let range = max_pk - min_pk + 1;
    // ceil division so we don't produce more splits than needed
    let split_size = (range + n - 1) / n;

    let mut splits = Vec::new();
    let mut start = min_pk;
    while start <= max_pk {
        let next = start + split_size;
        let end = if next > max_pk { None } else { Some(next) };
        splits.push(PkSplit { start, end });
        match end {
            None => break,
            Some(e) => start = e,
        }
    }
    splits
}

/// Parse an i64 from a `serde_json::Value` (Number or String).
pub fn parse_i64_from_json(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

/// Quote a column identifier for the given driver.
pub fn quote_col_for_driver(col: &str, driver: &str) -> String {
    match driver {
        "mysql" | "doris" | "tidb" | "clickhouse" => {
            format!("`{}`", col.replace('`', "``"))
        }
        "sqlserver" => format!("[{}]", col.replace(']', "]]")),
        _ => format!("\"{}\"", col.replace('"', "\"\"")),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_single_row_table() {
        let splits = compute_range_splits(42, 42, 4);
        assert_eq!(splits.len(), 1);
        assert_eq!(splits[0], PkSplit { start: 42, end: None });
    }

    #[test]
    fn splits_even_range() {
        // range [0, 99] split into 4 → each covers 25 pk values
        let splits = compute_range_splits(0, 99, 4);
        assert_eq!(splits.len(), 4);
        assert_eq!(splits[0], PkSplit { start: 0,  end: Some(25) });
        assert_eq!(splits[1], PkSplit { start: 25, end: Some(50) });
        assert_eq!(splits[2], PkSplit { start: 50, end: Some(75) });
        assert_eq!(splits[3], PkSplit { start: 75, end: None     });
    }

    #[test]
    fn splits_more_shards_than_range() {
        // range [0, 2] split into 10 → at most 3 splits (1 pk value each)
        let splits = compute_range_splits(0, 2, 10);
        assert_eq!(splits.len(), 3);
        assert_eq!(splits[0], PkSplit { start: 0, end: Some(1) });
        assert_eq!(splits[1], PkSplit { start: 1, end: Some(2) });
        assert_eq!(splits[2], PkSplit { start: 2, end: None    });
    }

    #[test]
    fn splits_negative_pks() {
        let splits = compute_range_splits(-100, -1, 2);
        assert_eq!(splits.len(), 2);
        assert_eq!(splits[0].start, -100);
        assert_eq!(splits[0].end, Some(-50));
        assert_eq!(splits[1].start, -50);
        assert_eq!(splits[1].end, None);
    }

    #[test]
    fn parse_i64_from_various_json_types() {
        assert_eq!(parse_i64_from_json(&Value::from(42_i64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from(42_u64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from(42.9_f64)), Some(42));
        assert_eq!(parse_i64_from_json(&Value::from("99")), Some(99));
        assert_eq!(parse_i64_from_json(&Value::from(" -5 ")), Some(-5));
        assert_eq!(parse_i64_from_json(&Value::Null), None);
        assert_eq!(parse_i64_from_json(&Value::from("abc")), None);
    }

    #[test]
    fn quote_col_variants() {
        assert_eq!(quote_col_for_driver("id", "mysql"), "`id`");
        assert_eq!(quote_col_for_driver("id", "tidb"), "`id`");
        assert_eq!(quote_col_for_driver("id", "postgres"), "\"id\"");
        assert_eq!(quote_col_for_driver("id", "sqlserver"), "[id]");
        // injection prevention
        assert_eq!(quote_col_for_driver("a`b", "mysql"), "`a``b`");
        assert_eq!(quote_col_for_driver("a]b", "sqlserver"), "[a]]b]");
    }
}
