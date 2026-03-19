use rusqlite::{Connection, Error as RusqliteError};
use std::collections::HashSet;
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
        "ALTER TABLE task_records ADD COLUMN connection_id INTEGER",
        "ALTER TABLE task_records ADD COLUMN scope_database TEXT",
        "ALTER TABLE task_records ADD COLUMN scope_schema TEXT",
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

    // V5: llm_configs 新增 opencode_provider_id 和 config_mode
    let llm_alter_stmts = [
        "ALTER TABLE llm_configs ADD COLUMN opencode_provider_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE llm_configs ADD COLUMN config_mode TEXT NOT NULL DEFAULT 'custom'",
    ];
    for stmt in &llm_alter_stmts {
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

    // V6: llm_configs 新增 opencode_display_name / opencode_model_options / opencode_provider_name
    let llm_v6_stmts = [
        "ALTER TABLE llm_configs ADD COLUMN opencode_display_name  TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE llm_configs ADD COLUMN opencode_model_options TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE llm_configs ADD COLUMN opencode_provider_name TEXT NOT NULL DEFAULT ''",
    ];
    for stmt in &llm_v6_stmts {
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
    // 预填 alicloud 预设的 provider 名称
    let _ = conn.execute(
        "UPDATE llm_configs SET opencode_provider_name = 'Model Studio Coding Plan'
         WHERE preset = 'alicloud' AND opencode_provider_name = ''",
        [],
    );

    // V5: graph_nodes 新增 source / aliases 列（存量数据库迁移）
    // SQLite 不支持 ALTER TABLE ... ADD COLUMN IF NOT EXISTS，
    // 故用 PRAGMA table_info 检查列是否存在后再执行，保证幂等性。
    // 新安装时 init.sql 的 CREATE TABLE 已包含这两列，此处仅处理存量数据库。
    let graph_nodes_columns: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM pragma_table_info('graph_nodes')",
        )?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    if !graph_nodes_columns.contains("source") {
        conn.execute_batch(
            "ALTER TABLE graph_nodes ADD COLUMN source TEXT DEFAULT 'schema'",
        )?;
        log::info!("Migrated graph_nodes: added source column");
    }
    if !graph_nodes_columns.contains("aliases") {
        conn.execute_batch(
            "ALTER TABLE graph_nodes ADD COLUMN aliases TEXT",
        )?;
        log::info!("Migrated graph_nodes: added aliases column");
    }
    if !graph_nodes_columns.contains("is_deleted") {
        conn.execute_batch(
            "ALTER TABLE graph_nodes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        )?;
        log::info!("Migrated graph_nodes: added is_deleted column");
    }

    // V4: agent_sessions 表（opencode HTTP Serve 模式）
    // init.sql 使用 IF NOT EXISTS，新安装自动创建；存量数据库通过此处幂等建表
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_sessions (
          id          TEXT PRIMARY KEY,
          title       TEXT,
          config_id   INTEGER,
          is_temp     INTEGER DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );"
    );

    // V7: 扩展 task_records.type CHECK 约束，增加 'ai_generate_metrics'
    // SQLite 不支持 ALTER TABLE 修改约束，需重建表
    let old_schema: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_records'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();
    let needs_rebuild = old_schema.contains("'seatunnel')")
        && !old_schema.contains("'ai_generate_metrics'");
    if needs_rebuild {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             BEGIN;
             CREATE TABLE task_records_new (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL CHECK(type IN ('export', 'import', 'migration', 'seatunnel', 'ai_generate_metrics')),
                 status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
                 title TEXT NOT NULL,
                 params TEXT,
                 progress INTEGER DEFAULT 0,
                 processed_rows INTEGER DEFAULT 0,
                 total_rows INTEGER,
                 current_target TEXT,
                 error TEXT,
                 error_details TEXT,
                 output_path TEXT,
                 description TEXT,
                 connection_id INTEGER,
                 scope_database TEXT,
                 scope_schema TEXT,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                 completed_at TEXT
             );
             INSERT INTO task_records_new SELECT
                 id, type, status, title, params, progress, processed_rows, total_rows,
                 current_target, error, error_details, output_path, description,
                 connection_id, scope_database, scope_schema, created_at, updated_at, completed_at
             FROM task_records;
             DROP TABLE task_records;
             ALTER TABLE task_records_new RENAME TO task_records;
             CREATE INDEX IF NOT EXISTS idx_task_records_created ON task_records(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_task_records_status ON task_records(status);
             COMMIT;
             PRAGMA foreign_keys = ON;",
        )?;
        log::info!("Migrated task_records: expanded type CHECK to include ai_generate_metrics");
    }

    log::info!("Database migrations completed");
    Ok(())
}
