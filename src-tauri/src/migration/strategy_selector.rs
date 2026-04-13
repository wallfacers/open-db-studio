use crate::datasource::{ConnectionConfig, DataSource};
use crate::error::{AppError, AppResult};
use crate::migration::task_mgr::{ConflictStrategy, TableMapping};

/// Migration execution strategy, chosen by the strategy selector.
#[derive(Debug, Clone, PartialEq)]
pub enum MigrationStrategy {
    /// Same-instance direct transfer: `INSERT INTO ... SELECT`
    DirectTransfer,
    /// Cross-instance batch merge: multi-value INSERT optimization
    BatchOptimized,
    /// LOAD DATA stream: MySQL-specific streaming write
    LoadDataStream,
    /// Legacy pipeline: reader→channel→writer for Upsert/complex scenarios
    LegacyPipeline,
}

impl std::fmt::Display for MigrationStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationStrategy::DirectTransfer => write!(f, "DirectTransfer"),
            MigrationStrategy::BatchOptimized => write!(f, "BatchOptimized"),
            MigrationStrategy::LoadDataStream => write!(f, "LoadDataStream"),
            MigrationStrategy::LegacyPipeline => write!(f, "LegacyPipeline"),
        }
    }
}

/// Decision result from the strategy selector.
///
/// `src_server_uuid`, `dst_server_uuid`, `can_direct_transfer`, and
/// `fallback_reason` are carried for observability/future slow-path usage —
/// the pipeline currently only consumes `strategy` and `same_instance`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct StrategyDecision {
    pub strategy: MigrationStrategy,
    pub same_instance: bool,
    pub src_server_uuid: Option<String>,
    pub dst_server_uuid: Option<String>,
    pub can_direct_transfer: bool,
    pub fallback_reason: Option<String>,
}

/// Fast-path detection: compares host+port (driver match is a pre-condition).
pub fn is_same_instance_by_config(
    src_driver: &str,
    src_host: &str,
    src_port: u16,
    dst_driver: &str,
    dst_host: &str,
    dst_port: u16,
) -> bool {
    src_driver == dst_driver && src_host == dst_host && src_port == dst_port
}

/// Slow-path detection: queries `@@server_uuid` from both data sources.
/// Returns `(src_uuid, dst_uuid, same)`. `same` is `true` only when both UUIDs
/// are present and equal. Any query failure is treated as "different instance".
///
/// Reserved for the cross-host same-cluster case (different hostnames that
/// resolve to the same MySQL instance). Not currently invoked by the pipeline.
#[allow(dead_code)]
pub async fn verify_same_instance_by_uuid(
    src_ds: &dyn DataSource,
    dst_ds: &dyn DataSource,
) -> AppResult<(Option<String>, Option<String>, bool)> {
    let src_uuid = query_server_uuid(src_ds).await.ok();
    let dst_uuid = query_server_uuid(dst_ds).await.ok();
    let same = src_uuid.is_some() && src_uuid == dst_uuid;
    Ok((src_uuid, dst_uuid, same))
}

/// Query `@@server_uuid` from a data source (MySQL family only).
async fn query_server_uuid(ds: &dyn DataSource) -> AppResult<String> {
    let result = ds.execute("SELECT @@server_uuid").await?;
    result
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or_else(|| AppError::Datasource("Failed to read @@server_uuid result".into()))
}

/// Check if the column mappings are compatible with direct transfer.
///
/// Direct transfer supports:
/// - `MAPPING (*)` — all columns (degrades to `SELECT *`)
/// - `MAPPING (col_a = col_b)` — simple column mapping/renaming
/// - `MAPPING (col_c = UPPER(col_d))` — expression mapping (server-side execution)
///
/// Conflict strategies that require the reader/writer pipeline (upsert, and
/// replace with explicit upsert keys) disable this fast path — even when the
/// source and target live on the same instance.
pub fn can_use_direct_transfer(mapping: &TableMapping) -> bool {
    if mapping.column_mappings.is_empty() {
        return false;
    }
    match mapping.target.conflict_strategy {
        ConflictStrategy::Upsert => false,
        ConflictStrategy::Replace if !mapping.target.upsert_keys.is_empty() => false,
        _ => true,
    }
}

/// Check if LOAD DATA is supported for this migration (MySQL target, no upsert).
pub fn supports_load_data(dst_driver: &str, conflict_strategy: &ConflictStrategy) -> bool {
    dst_driver == "mysql"
        && !matches!(conflict_strategy, ConflictStrategy::Upsert)
}

/// Check if the migration needs Upsert handling that only the legacy pipeline supports.
pub fn needs_upsert(mapping: &TableMapping) -> bool {
    matches!(mapping.target.conflict_strategy, ConflictStrategy::Upsert)
        && !mapping.target.upsert_keys.is_empty()
}

/// Main strategy selection function.
///
/// Called at the start of `execute_single_mapping` with the (already resolved)
/// source and target `ConnectionConfig`s plus the current table mapping.
/// The caller can follow up with `verify_same_instance_by_uuid` for the slow
/// path when host+port differ but the operator believes it's the same cluster.
pub fn select_strategy(
    src_config: &ConnectionConfig,
    dst_config: &ConnectionConfig,
    mapping: &TableMapping,
) -> StrategyDecision {
    let src_host = src_config.host.clone().unwrap_or_default();
    let dst_host = dst_config.host.clone().unwrap_or_default();
    let src_port = src_config.port.unwrap_or(0);
    let dst_port = dst_config.port.unwrap_or(0);

    // 1. Fast-path: driver + host + port all match.
    //    Ports must be non-zero so that two "unknown" endpoints don't collide.
    let same_instance_by_config = src_port != 0
        && is_same_instance_by_config(
            &src_config.driver,
            &src_host,
            src_port,
            &dst_config.driver,
            &dst_host,
            dst_port,
        );

    // 2. Direct transfer feasibility
    let can_direct = same_instance_by_config && can_use_direct_transfer(mapping);

    // 3. Direct transfer wins when applicable
    if can_direct {
        return StrategyDecision {
            strategy: MigrationStrategy::DirectTransfer,
            same_instance: true,
            src_server_uuid: None,
            dst_server_uuid: None,
            can_direct_transfer: true,
            fallback_reason: None,
        };
    }

    // 4. Upsert forces the legacy pipeline regardless of driver
    if needs_upsert(mapping) {
        return StrategyDecision {
            strategy: MigrationStrategy::LegacyPipeline,
            same_instance: same_instance_by_config,
            src_server_uuid: None,
            dst_server_uuid: None,
            can_direct_transfer: false,
            fallback_reason: Some("Upsert requires legacy pipeline".into()),
        };
    }

    // 5. Cross-instance strategy selection
    if supports_load_data(&dst_config.driver, &mapping.target.conflict_strategy) {
        return StrategyDecision {
            strategy: MigrationStrategy::LoadDataStream,
            same_instance: false,
            src_server_uuid: None,
            dst_server_uuid: None,
            can_direct_transfer: false,
            fallback_reason: None,
        };
    }

    StrategyDecision {
        strategy: MigrationStrategy::BatchOptimized,
        same_instance: same_instance_by_config,
        src_server_uuid: None,
        dst_server_uuid: None,
        can_direct_transfer: false,
        fallback_reason: None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::task_mgr::{ColumnMapping, TargetConfig};

    fn cfg(driver: &str, host: &str, port: u16) -> ConnectionConfig {
        ConnectionConfig {
            driver: driver.to_string(),
            host: Some(host.to_string()),
            port: Some(port),
            database: None,
            username: None,
            password: None,
            extra_params: None,
            file_path: None,
            auth_type: None,
            token: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_cert_path: None,
            ssl_key_path: None,
            connect_timeout_secs: None,
            read_timeout_secs: None,
            pool_max_connections: None,
            pool_idle_timeout_secs: None,
        }
    }

    fn mapping_with(column: &str, conflict: ConflictStrategy, upsert_keys: Vec<String>) -> TableMapping {
        TableMapping {
            source_table: "src".into(),
            target: TargetConfig {
                connection_id: 0,
                database: String::new(),
                table: "dst".into(),
                conflict_strategy: conflict,
                create_if_not_exists: false,
                upsert_keys,
            },
            filter_condition: None,
            column_mappings: vec![ColumnMapping {
                source_expr: column.into(),
                target_col: column.into(),
                target_type: "BIGINT".into(),
            }],
        }
    }

    #[test]
    fn same_host_port_driver_is_same_instance() {
        assert!(is_same_instance_by_config("mysql", "h1", 3306, "mysql", "h1", 3306));
    }

    #[test]
    fn different_driver_never_same_instance() {
        assert!(!is_same_instance_by_config(
            "mysql", "h1", 3306, "postgres", "h1", 3306
        ));
    }

    #[test]
    fn direct_transfer_when_same_instance() {
        let src = cfg("mysql", "db.local", 3306);
        let dst = cfg("mysql", "db.local", 3306);
        let m = mapping_with("id", ConflictStrategy::Insert, vec![]);
        let d = select_strategy(&src, &dst, &m);
        assert_eq!(d.strategy, MigrationStrategy::DirectTransfer);
        assert!(d.same_instance);
        assert!(d.can_direct_transfer);
    }

    #[test]
    fn load_data_stream_for_mysql_cross_instance() {
        let src = cfg("mysql", "a.local", 3306);
        let dst = cfg("mysql", "b.local", 3306);
        let m = mapping_with("id", ConflictStrategy::Insert, vec![]);
        let d = select_strategy(&src, &dst, &m);
        assert_eq!(d.strategy, MigrationStrategy::LoadDataStream);
        assert!(!d.same_instance);
    }

    #[test]
    fn batch_optimized_for_non_mysql_cross_instance() {
        let src = cfg("postgres", "a.local", 5432);
        let dst = cfg("postgres", "b.local", 5432);
        let m = mapping_with("id", ConflictStrategy::Insert, vec![]);
        let d = select_strategy(&src, &dst, &m);
        assert_eq!(d.strategy, MigrationStrategy::BatchOptimized);
    }

    #[test]
    fn upsert_forces_legacy_pipeline_even_for_same_instance() {
        let src = cfg("mysql", "db.local", 3306);
        let dst = cfg("mysql", "db.local", 3306);
        let m = mapping_with("id", ConflictStrategy::Upsert, vec!["id".into()]);
        let d = select_strategy(&src, &dst, &m);
        assert_eq!(d.strategy, MigrationStrategy::LegacyPipeline);
        assert!(d.fallback_reason.is_some());
    }

    #[test]
    fn unknown_port_never_direct() {
        // Both configs missing port → cannot confidently claim same instance
        let src = cfg("mysql", "h", 3306);
        let mut dst = cfg("mysql", "h", 3306);
        dst.port = None;
        let m = mapping_with("id", ConflictStrategy::Insert, vec![]);
        let d = select_strategy(&src, &dst, &m);
        assert_ne!(d.strategy, MigrationStrategy::DirectTransfer);
    }
}
