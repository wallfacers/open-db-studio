use super::ast::*;
use crate::migration::task_mgr::*;

/// Maximum allowed byte_capacity (4GB).
const BYTE_CAPACITY_MAX: u64 = 4 * 1024 * 1024 * 1024;

/// Standard byte capacity values (powers of 2 in MB).
/// 1M, 2M, 4M, 8M, 16M, 32M, 64M, 128M, 256M, 512M, 1G, 2G, 4G
const BYTE_CAPACITY_STANDARDS: [u64; 13] = [
    1 * 1024 * 1024,           // 1M
    2 * 1024 * 1024,           // 2M
    4 * 1024 * 1024,           // 4M
    8 * 1024 * 1024,           // 8M
    16 * 1024 * 1024,          // 16M
    32 * 1024 * 1024,          // 32M
    64 * 1024 * 1024,          // 64M
    128 * 1024 * 1024,         // 128M
    256 * 1024 * 1024,         // 256M
    512 * 1024 * 1024,         // 512M
    1024 * 1024 * 1024,        // 1G
    2 * 1024 * 1024 * 1024,    // 2G
    4 * 1024 * 1024 * 1024,    // 4G (max)
];

/// Parse a byte literal like "16M", "1K", "2G" into bytes.
/// Supports K (kilobytes), M (megabytes), G (gigabytes).
/// Returns None if the format is invalid.
fn parse_byte_literal(s: &str) -> Option<u64> {
    let s = s.trim().to_uppercase();
    let (num_part, multiplier) = if s.ends_with('K') {
        (&s[..s.len()-1], 1024)
    } else if s.ends_with('M') {
        (&s[..s.len()-1], 1024 * 1024)
    } else if s.ends_with('G') {
        (&s[..s.len()-1], 1024 * 1024 * 1024)
    } else {
        (s.as_str(), 1)  // no suffix = bytes
    };
    let num: u64 = num_part.parse().ok()?;
    Some(num * multiplier)
}

/// Normalize a byte value to the nearest standard capacity.
/// Rounds down to the nearest power-of-2 MB value, capped at 4GB.
fn normalize_byte_capacity(value: u64) -> u64 {
    // Cap at maximum
    let capped = value.min(BYTE_CAPACITY_MAX);

    // Find the nearest standard value (prefer lower to avoid over-allocation)
    // Strategy: find the closest standard value, preferring the lower one if tied
    let mut best = BYTE_CAPACITY_STANDARDS[0];
    let mut best_diff = (capped as i64 - best as i64).abs();

    for std_val in BYTE_CAPACITY_STANDARDS.iter() {
        let diff = (capped as i64 - *std_val as i64).abs();
        // Prefer lower value when tied (safer for memory)
        if diff < best_diff || (diff == best_diff && *std_val < best) {
            best = *std_val;
            best_diff = diff;
        }
    }

    best
}

#[derive(Debug, Clone)]
pub struct CompileError {
    pub message: String,
    #[allow(dead_code)]
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
    let mut alias_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
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
                        if let SetValue::Int(v) = &a.value {
                            pipeline.read_batch_size = *v as usize;
                        }
                    }
                    "write_batch" | "write_batch_size" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.write_batch_size = *v as usize;
                        }
                    }
                    "parallelism" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.parallelism = *v as usize;
                        }
                    }
                    "error_limit" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.error_limit = *v as usize;
                        }
                    }
                    "speed_limit_rps" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.speed_limit_rps = Some(*v);
                        }
                    }
                    "channel_capacity" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.channel_capacity = *v as usize;
                        }
                    }
                    "byte_capacity" => {
                        // Support both raw integers and byte literals (16M, 1K, 2G)
                        let raw_bytes = match &a.value {
                            SetValue::Int(v) => Some(*v),
                            SetValue::Ident(s) => parse_byte_literal(s),
                            _ => None,
                        };
                        if let Some(bytes) = raw_bytes {
                            let normalized = normalize_byte_capacity(bytes);
                            pipeline.byte_capacity = Some(normalized);
                        }
                    }
                    "max_bytes_per_tx" => {
                        // Support both raw integers and byte literals (8M, 4M)
                        let raw_bytes = match &a.value {
                            SetValue::Int(v) => Some(*v),
                            SetValue::Ident(s) => parse_byte_literal(s),
                            _ => None,
                        };
                        if let Some(bytes) = raw_bytes {
                            let normalized = normalize_byte_capacity(bytes);
                            pipeline.max_bytes_per_tx = Some(normalized);
                        }
                    }
                    "shard_count" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.shard_count = Some(*v as usize);
                        }
                    }
                    "transaction_batch" | "txn_batch" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.transaction_batch_size = (*v as usize).max(1).min(100);
                        }
                    }
                    "write_pause_ms" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.write_pause_ms = Some(*v as u64);
                        }
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
            let (src_conn, src_db, src_table) = m.source.resolve();
            let src_conn_name = alias_map
                .get(src_conn)
                .map(|s| s.as_str())
                .unwrap_or(src_conn);
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

            if source_connection_id.is_none() {
                source_connection_id = Some(src_conn_id);
                source_database = src_db.map(|s| s.to_string());
            }

            let (tgt_conn, tgt_db, tgt_table) = m.target.resolve();
            let tgt_conn_name = alias_map
                .get(tgt_conn)
                .map(|s| s.as_str())
                .unwrap_or(tgt_conn);
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

            let column_mappings = match &m.mapping {
                Some(mc) if mc.auto_all => Vec::new(),
                Some(mc) => mc
                    .entries
                    .iter()
                    .map(|e| ColumnMapping {
                        source_expr: e.source_expr.clone(),
                        target_col: e.target_col.clone(),
                        target_type: e.target_type.clone().unwrap_or_default(),
                    })
                    .collect(),
                None => Vec::new(),
            };

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
                field: col.clone(),
                field_type: IncrementalFieldType::Timestamp,
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
            tables: table_mappings
                .iter()
                .map(|m| m.source_table.clone())
                .collect(),
            custom_query: None,
            query: None,
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
        let script =
            parser::parse("MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;")
                .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.table_mappings.len(), 1);
        assert_eq!(config.source.connection_id, 1);
        assert_eq!(config.table_mappings[0].source_table, "users");
        assert_eq!(config.table_mappings[0].target.connection_id, 2);
        assert_eq!(config.table_mappings[0].target.table, "users");
    }

    #[test]
    fn test_compile_use_alias() {
        let script = parser::parse(
            r#"
            USE src = CONNECTION('mysql_prod');
            USE tgt = CONNECTION('pg_warehouse');
            MIGRATE FROM src.shop.users INTO tgt.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.source.connection_id, 1);
        assert_eq!(config.table_mappings[0].target.connection_id, 2);
    }

    #[test]
    fn test_compile_multi_migrate() {
        let script = parser::parse(
            r#"
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
            MIGRATE FROM mysql_prod.shop.orders INTO pg_warehouse.public.orders;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.table_mappings.len(), 2);
    }

    #[test]
    fn test_compile_set_pipeline() {
        let script = parser::parse(
            r#"
            SET parallelism = 4, read_batch = 5000;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.pipeline.parallelism, 4);
        assert_eq!(config.pipeline.read_batch_size, 5000);
    }

    #[test]
    fn test_compile_mapping_star() {
        let script = parser::parse(
            "MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users MAPPING (*);",
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert!(config.table_mappings[0].column_mappings.is_empty());
    }

    #[test]
    fn test_compile_incremental() {
        let script = parser::parse(
            "MIGRATE FROM mysql_prod.shop.orders INTO pg_warehouse.public.orders INCREMENTAL ON updated_at;",
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.sync_mode, SyncMode::Incremental);
        assert_eq!(
            config.incremental_config.as_ref().unwrap().field,
            "updated_at"
        );
    }

    #[test]
    fn test_compile_unknown_connection() {
        let script = parser::parse(
            "MIGRATE FROM unknown.shop.users INTO pg_warehouse.public.users;",
        )
        .unwrap();
        let result = compile(&script, &mock_resolve);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert!(errors[0].message.contains("unknown"));
    }

    // ── Byte literal parsing tests ──

    #[test]
    fn test_parse_byte_literal_simple() {
        assert_eq!(parse_byte_literal("16M"), Some(16 * 1024 * 1024));
        assert_eq!(parse_byte_literal("1K"), Some(1024));
        assert_eq!(parse_byte_literal("2G"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_byte_literal("33554432"), Some(33554432)); // no suffix = bytes
    }

    #[test]
    fn test_parse_byte_literal_case_insensitive() {
        assert_eq!(parse_byte_literal("16m"), Some(16 * 1024 * 1024));
        assert_eq!(parse_byte_literal("16M"), Some(16 * 1024 * 1024));
        assert_eq!(parse_byte_literal("1k"), Some(1024));
        assert_eq!(parse_byte_literal("1K"), Some(1024));
    }

    #[test]
    fn test_parse_byte_literal_invalid() {
        assert_eq!(parse_byte_literal("abc"), None);
        assert_eq!(parse_byte_literal("16X"), None); // invalid suffix
        assert_eq!(parse_byte_literal(""), None);
    }

    // ── Byte capacity normalization tests ──

    #[test]
    fn test_normalize_standard_values() {
        // Standard values should remain unchanged
        assert_eq!(normalize_byte_capacity(1 * 1024 * 1024), 1 * 1024 * 1024);    // 1M
        assert_eq!(normalize_byte_capacity(8 * 1024 * 1024), 8 * 1024 * 1024);    // 8M
        assert_eq!(normalize_byte_capacity(16 * 1024 * 1024), 16 * 1024 * 1024);  // 16M
        assert_eq!(normalize_byte_capacity(32 * 1024 * 1024), 32 * 1024 * 1024);  // 32M
        assert_eq!(normalize_byte_capacity(4 * 1024 * 1024 * 1024), 4 * 1024 * 1024 * 1024); // 4G (max)
    }

    #[test]
    fn test_normalize_round_down() {
        // Values closer to lower standard should round down
        // 9M = 9437184, distance to 8M = 1048576, distance to 16M = 7340032 -> 8M
        assert_eq!(normalize_byte_capacity(9437184), 8 * 1024 * 1024); // 9M -> 8M

        // 6M = 6291456, closer to 8M = 8388608 than to 4M = 4194304
        // distance to 4M = 2097152, distance to 8M = 2097152 (tie, prefer lower = 4M)
        assert_eq!(normalize_byte_capacity(6291456), 4 * 1024 * 1024); // 6M -> 4M (tie, prefer lower)
    }

    #[test]
    fn test_normalize_round_up() {
        // Values closer to higher standard should round up
        // 15M = 15728640, distance to 8M = 7340032, distance to 16M = 2097152 -> 16M
        assert_eq!(normalize_byte_capacity(15728640), 16 * 1024 * 1024); // 15M -> 16M

        // 14M = 14680064, distance to 8M = 6291456, distance to 16M = 2097152 -> 16M
        assert_eq!(normalize_byte_capacity(14680064), 16 * 1024 * 1024);

        // 30M = 31457280, closer to 32M = 33554432
        assert_eq!(normalize_byte_capacity(31457280), 32 * 1024 * 1024);
    }

    #[test]
    fn test_normalize_cap_at_max() {
        // Values over 4GB should be capped
        assert_eq!(normalize_byte_capacity(5 * 1024 * 1024 * 1024), 4 * 1024 * 1024 * 1024);
        assert_eq!(normalize_byte_capacity(10 * 1024 * 1024 * 1024), 4 * 1024 * 1024 * 1024);
    }

    #[test]
    fn test_normalize_small_values() {
        // Values below 1M should round to 1M (minimum standard)
        assert_eq!(normalize_byte_capacity(100), 1 * 1024 * 1024);
        assert_eq!(normalize_byte_capacity(512), 1 * 1024 * 1024);
        assert_eq!(normalize_byte_capacity(1024), 1 * 1024 * 1024); // 1K -> 1M
    }

    // ── Integration tests with SET byte_capacity ──

    #[test]
    fn test_compile_byte_capacity_literal() {
        let script = parser::parse(
            r#"
            SET byte_capacity = 16M;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.pipeline.byte_capacity, Some(16 * 1024 * 1024));
    }

    #[test]
    fn test_compile_byte_capacity_integer() {
        let script = parser::parse(
            r#"
            SET byte_capacity = 33554432;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        // 33554432 = 32M (exact standard)
        assert_eq!(config.pipeline.byte_capacity, Some(32 * 1024 * 1024));
    }

    #[test]
    fn test_compile_byte_capacity_normalized() {
        let script = parser::parse(
            r#"
            SET byte_capacity = 15728640;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        // 15728640 (15M) -> normalized to 16M (closest standard)
        assert_eq!(config.pipeline.byte_capacity, Some(16 * 1024 * 1024));
    }

    #[test]
    fn test_compile_byte_capacity_capped() {
        let script = parser::parse(
            r#"
            SET byte_capacity = 5G;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        // 5G capped to 4G
        assert_eq!(config.pipeline.byte_capacity, Some(4 * 1024 * 1024 * 1024));
    }

    #[test]
    fn test_compile_max_bytes_per_tx_literal() {
        let script = parser::parse(
            r#"
            SET max_bytes_per_tx = 8M;
            MIGRATE FROM mysql_prod.shop.users INTO pg_warehouse.public.users;
        "#,
        )
        .unwrap();
        let config = compile(&script, &mock_resolve).unwrap();
        assert_eq!(config.pipeline.max_bytes_per_tx, Some(8 * 1024 * 1024));
    }
}
