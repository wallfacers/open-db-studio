use rusqlite::{Connection, Error as RusqliteError};
use crate::AppResult;

pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    let schema = include_str!("../../../schema/init.sql");
    conn.execute_batch(schema)?;

    // 处理已有数据库的字段迁移（忽略"duplicate column name"，SQLite error code 1）
    let alter_stmts = [
        "ALTER TABLE connection_groups ADD COLUMN color TEXT",
        "ALTER TABLE connection_groups ADD COLUMN sort_order INTEGER DEFAULT 0",
        "ALTER TABLE connections ADD COLUMN sort_order INTEGER DEFAULT 0",
        "ALTER TABLE task_records ADD COLUMN description TEXT",
    ];
    for stmt in &alter_stmts {
        if let Err(e) = conn.execute_batch(stmt) {
            let is_duplicate = matches!(
                &e,
                RusqliteError::SqliteFailure(err, _) if err.extended_code == 1
            );
            if !is_duplicate {
                return Err(crate::AppError::Other(format!("Migration failed: {}", e)));
            }
        }
    }

    // 清理旧的 parent_id 孤儿列（SQLite 3.35.0+ 支持 DROP COLUMN）
    let has_parent_id: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('connection_groups') WHERE name = 'parent_id'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if has_parent_id {
        conn.execute_batch("ALTER TABLE connection_groups DROP COLUMN parent_id")?;
        log::info!("Dropped legacy parent_id column from connection_groups");
    }

    // 将 llm_configs.api_key 重命名为 api_key_enc（SQLite 3.25+ RENAME COLUMN）
    let has_old_col: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('llm_configs') WHERE name = 'api_key'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if has_old_col {
        conn.execute_batch("ALTER TABLE llm_configs RENAME COLUMN api_key TO api_key_enc;")?;
        log::info!("Migrated llm_configs.api_key -> api_key_enc");
    }

    // 存量数据库迁移 — metrics 表新增字段（忽略重复列错误）
    let migration_stmts = [
        "ALTER TABLE metrics ADD COLUMN metric_type TEXT DEFAULT 'atomic'",
        "ALTER TABLE metrics ADD COLUMN composite_components TEXT",
        "ALTER TABLE metrics ADD COLUMN composite_formula TEXT",
        "ALTER TABLE metrics ADD COLUMN category TEXT",
        "ALTER TABLE metrics ADD COLUMN data_caliber TEXT",
        "ALTER TABLE metrics ADD COLUMN version TEXT",
        "ALTER TABLE metrics ADD COLUMN scope_database TEXT",
        "ALTER TABLE metrics ADD COLUMN scope_schema TEXT",
    ];
    for stmt in &migration_stmts {
        let _ = conn.execute(stmt, []);
    }
    let _ = conn.execute("UPDATE metrics SET source='manual' WHERE source='user'", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(connection_id, scope_database, scope_schema)",
        [],
    );

    log::info!("Database migrations completed");
    Ok(())
}
