use super::ast::*;
use crate::migration::task_mgr::*;

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
                    "shard_count" => {
                        if let SetValue::Int(v) = &a.value {
                            pipeline.shard_count = Some(*v as usize);
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
}
