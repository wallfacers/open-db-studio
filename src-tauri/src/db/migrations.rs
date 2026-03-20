use rusqlite::{Connection, Error as RusqliteError};
use std::collections::HashSet;
use crate::AppResult;

pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    // ── 前置修复：init.sql 包含 CREATE INDEX idx_graph_edges_source ON graph_edges(source)，
    // 而存量数据库的 graph_edges 可能没有 source 列（V10 migration 添加该列）。
    // 若 execute_batch(schema) 先执行，会因列不存在而失败，且 V10 永远无法运行。
    // 解决：在 execute_batch 之前先检查并补充 source 列，打破鸡蛋循环。
    let graph_edges_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='graph_edges'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if graph_edges_exists {
        let has_source: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('graph_edges') WHERE name='source'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_source {
            // 先加列（允许 NULL 以兼容现有行），V10 之后会通过重建表转为 NOT NULL DEFAULT 'schema'
            let _ = conn.execute_batch(
                "ALTER TABLE graph_edges ADD COLUMN source TEXT NOT NULL DEFAULT 'schema'",
            );
            log::info!("Pre-migration: added graph_edges.source column before execute_batch(schema)");
        }
    }

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
        let cols: HashSet<String> = stmt.query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        cols
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

    // 查询 task_records 当前实际存在的列（用于 V7/V8 重建时兼容老数据库）
    let tr_existing_cols: HashSet<String> = {
        let mut s = conn.prepare(
            "SELECT name FROM pragma_table_info('task_records')",
        )?;
        let cols: HashSet<String> = s.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        cols
    };
    // 对于老数据库中可能缺失的列，INSERT SELECT 时用 NULL 填充，保证兼容性
    macro_rules! col_or_null {
        ($name:expr) => {
            if tr_existing_cols.contains($name) { $name } else { "NULL" }
        };
    }
    let tr_insert_select_v7 = format!(
        "INSERT INTO task_records_new SELECT \
             id, type, status, title, params, progress, processed_rows, total_rows, \
             current_target, error, {ed}, {op}, {desc}, {cid}, {sd}, {ss}, \
             created_at, updated_at, {ca} \
         FROM task_records;",
        ed   = col_or_null!("error_details"),
        op   = col_or_null!("output_path"),
        desc = col_or_null!("description"),
        cid  = col_or_null!("connection_id"),
        sd   = col_or_null!("scope_database"),
        ss   = col_or_null!("scope_schema"),
        ca   = col_or_null!("completed_at"),
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
        conn.execute_batch(&format!(
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
             {insert}
             DROP TABLE task_records;
             ALTER TABLE task_records_new RENAME TO task_records;
             CREATE INDEX IF NOT EXISTS idx_task_records_created ON task_records(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_task_records_status ON task_records(status);
             COMMIT;
             PRAGMA foreign_keys = ON;",
            insert = tr_insert_select_v7,
        ))?;
        log::info!("Migrated task_records: expanded type CHECK to include ai_generate_metrics");
    }

    // V8: 扩展 task_records.type CHECK 约束，增加 'build_schema_graph'
    // 重新查询 schema（V7 可能刚重建了表）
    let old_schema: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_records'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();
    if !old_schema.contains("'build_schema_graph'") {
        // V8 在 V7 之后运行，task_records 的完整列集已由 V7 保证；
        // 但若 V7 未触发（old_schema 里没有 'seatunnel'），仍需兼容老列
        let tr_cols_v8: HashSet<String> = {
            let mut s = conn.prepare(
                "SELECT name FROM pragma_table_info('task_records')",
            )?;
            let cols: HashSet<String> = s.query_map([], |r| r.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect();
            cols
        };
        let tr_insert_select_v8 = format!(
            "INSERT INTO task_records_new SELECT \
                 id, type, status, title, params, progress, processed_rows, total_rows, \
                 current_target, error, {ed}, {op}, {desc}, {cid}, {sd}, {ss}, \
                 created_at, updated_at, {ca} \
             FROM task_records;",
            ed   = if tr_cols_v8.contains("error_details") { "error_details" } else { "NULL" },
            op   = if tr_cols_v8.contains("output_path")   { "output_path"   } else { "NULL" },
            desc = if tr_cols_v8.contains("description")   { "description"   } else { "NULL" },
            cid  = if tr_cols_v8.contains("connection_id") { "connection_id" } else { "NULL" },
            sd   = if tr_cols_v8.contains("scope_database"){ "scope_database"} else { "NULL" },
            ss   = if tr_cols_v8.contains("scope_schema")  { "scope_schema"  } else { "NULL" },
            ca   = if tr_cols_v8.contains("completed_at")  { "completed_at"  } else { "NULL" },
        );
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys = OFF;
             BEGIN;
             CREATE TABLE task_records_new (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL CHECK(type IN ('export', 'import', 'migration', 'seatunnel', 'ai_generate_metrics', 'build_schema_graph')),
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
             {insert}
             DROP TABLE task_records;
             ALTER TABLE task_records_new RENAME TO task_records;
             CREATE INDEX IF NOT EXISTS idx_task_records_created ON task_records(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_task_records_status ON task_records(status);
             COMMIT;
             PRAGMA foreign_keys = ON;",
            insert = tr_insert_select_v8,
        ))?;
        log::info!("Migrated task_records: expanded type CHECK to include build_schema_graph");
    }

    // V9: 修复 graph_nodes_fts 列名（node_id → id）
    // FTS5 content 模式要求列名与 content 表一致，旧表用 node_id 导致 DELETE 报错。
    // 同时处理 FTS5 影子表损坏的情况：逐一强制删除影子表后再重建虚拟表。
    let fts_needs_rebuild: bool = {
        let fts_sql: String = conn
            .query_row(
                "SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='table' AND name='graph_nodes_fts'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default();
        fts_sql.contains("node_id")
    };
    if fts_needs_rebuild {
        // 先强制删除 FTS5 影子表（损坏时虚拟表 DROP 可能失败）
        for suffix in &["_data", "_idx", "_content", "_docsize", "_config"] {
            let _ = conn.execute(
                &format!("DROP TABLE IF EXISTS graph_nodes_fts{}", suffix),
                [],
            );
        }
        let _ = conn.execute_batch("DROP TABLE IF EXISTS graph_nodes_fts;");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE graph_nodes_fts
             USING fts5(
               id         UNINDEXED,
               name,
               display_name,
               aliases,
               content='graph_nodes',
               content_rowid='rowid'
             );",
        )?;
        log::info!("Migrated graph_nodes_fts: renamed node_id -> id");
    }

    // V10: graph_edges 新增 source 列 + 重建表移除 edge_type CHECK 约束
    // SQLite 不支持 ALTER TABLE DROP CONSTRAINT，需重建表
    let graph_edges_sql: String = conn
        .query_row(
            "SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='table' AND name='graph_edges'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();

    let needs_edge_rebuild = graph_edges_sql.contains("CHECK(edge_type IN")
        || !graph_edges_sql.contains("source");

    if needs_edge_rebuild {
        // 检查旧表是否有 metadata 列
        let has_metadata: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('graph_edges') WHERE name='metadata'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        let insert_select = if has_metadata {
            "INSERT INTO graph_edges_new (id, from_node, to_node, edge_type, weight, metadata, source)
             SELECT id, from_node, to_node, edge_type, weight, metadata, 'schema' FROM graph_edges;"
        } else {
            "INSERT INTO graph_edges_new (id, from_node, to_node, edge_type, weight, metadata, source)
             SELECT id, from_node, to_node, edge_type, weight, NULL, 'schema' FROM graph_edges;"
        };

        // 先关外键约束
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");

        let rebuild_sql = format!(
            "BEGIN;
             CREATE TABLE graph_edges_new (
                 id        TEXT PRIMARY KEY,
                 from_node TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                 to_node   TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
                 edge_type TEXT NOT NULL,
                 weight    REAL NOT NULL DEFAULT 1.0,
                 metadata  TEXT,
                 source    TEXT NOT NULL DEFAULT 'schema'
             );
             {}
             DROP TABLE graph_edges;
             ALTER TABLE graph_edges_new RENAME TO graph_edges;
             CREATE INDEX IF NOT EXISTS idx_graph_edges_from   ON graph_edges(from_node);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_to     ON graph_edges(to_node);
             CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
             COMMIT;",
            insert_select
        );

        let rebuild_result = conn.execute_batch(&rebuild_sql);

        // 无论是否成功，都恢复外键约束
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");

        rebuild_result?;
        log::info!("Migrated graph_edges: added source column, removed edge_type CHECK constraint");
    }

    log::info!("Database migrations completed");
    Ok(())
}
