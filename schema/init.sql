-- schema/init.sql
-- open-db-studio 内置 SQLite schema
-- 用途：存储应用配置（连接信息、分组、查询历史等）
-- 注意：所有语句使用 IF NOT EXISTS，保证幂等性

CREATE TABLE IF NOT EXISTS connection_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_id INTEGER REFERENCES connection_groups(id) ON DELETE SET NULL,
    driver TEXT NOT NULL CHECK(driver IN ('mysql','postgres','oracle','sqlserver','sqlite')),
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    password_enc TEXT,
    extra_params TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS query_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
    sql TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_ms INTEGER,
    row_count INTEGER,
    error_msg TEXT
);

CREATE TABLE IF NOT EXISTS saved_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    sql TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_configs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    api_key_enc TEXT NOT NULL DEFAULT '',               -- AES-256 encrypted
    base_url    TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    model       TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    api_type    TEXT NOT NULL DEFAULT 'openai',
    preset      TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    test_status TEXT NOT NULL DEFAULT 'untested' CHECK(test_status IN ('untested','testing','success','fail')),
    test_error  TEXT,
    tested_at   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 任务记录表（导入导出、迁移等后台任务）
CREATE TABLE IF NOT EXISTS task_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('export', 'import', 'migration', 'seatunnel')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    title TEXT NOT NULL,
    params TEXT,                  -- JSON 序列化参数（用于重试）
    progress INTEGER DEFAULT 0,
    processed_rows INTEGER DEFAULT 0,
    total_rows INTEGER,
    current_target TEXT,
    error TEXT,
    error_details TEXT,           -- JSON 数组，错误行详情
    output_path TEXT,
    description TEXT,             -- Markdown 格式的任务描述（连接信息、表清单等，供 LLM/MCP 读取）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- 任务记录索引（按时间倒序，支持快速查询最近 100 条）
CREATE INDEX IF NOT EXISTS idx_task_records_created ON task_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_records_status ON task_records(status);

-- ============ V2: 知识图谱 ============

-- 图谱节点（三层统一建模）
CREATE TABLE IF NOT EXISTS graph_nodes (
    id            TEXT PRIMARY KEY,
    node_type     TEXT NOT NULL CHECK(node_type IN ('table','column','fk','index','metric','alias')),
    connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    display_name  TEXT,
    metadata      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_conn ON graph_nodes(connection_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);

-- 图谱边
CREATE TABLE IF NOT EXISTS graph_edges (
    id         TEXT PRIMARY KEY,
    from_node  TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    to_node    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    edge_type  TEXT NOT NULL CHECK(edge_type IN ('has_column','foreign_key','metric_ref','alias_of','join_path')),
    weight     REAL NOT NULL DEFAULT 1.0,
    metadata   TEXT
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);

-- ============ V2: 业务指标 ============

CREATE TABLE IF NOT EXISTS metrics (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id        INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    table_name           TEXT NOT NULL DEFAULT '',
    column_name          TEXT,
    aggregation          TEXT CHECK(aggregation IN ('SUM','COUNT','AVG','MAX','MIN','CUSTOM')),
    filter_sql           TEXT,
    description          TEXT,
    status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
    source               TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),
    metric_type          TEXT NOT NULL DEFAULT 'atomic' CHECK(metric_type IN ('atomic','composite')),
    composite_components TEXT,
    composite_formula    TEXT,
    category             TEXT,
    data_caliber         TEXT,
    version              TEXT,
    scope_database       TEXT,
    scope_schema         TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_conn ON metrics(connection_id);
CREATE INDEX IF NOT EXISTS idx_metrics_status ON metrics(status);
-- idx_metrics_node 在 migrations.rs 中创建（需等 scope_database/scope_schema 列迁移完成后）

-- 业务语义别名
CREATE TABLE IF NOT EXISTS semantic_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    alias         TEXT NOT NULL,
    node_id       TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    confidence    REAL NOT NULL DEFAULT 1.0,
    source        TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_semantic_aliases_conn ON semantic_aliases(connection_id);

-- ============ V2: 跨数据源迁移 ============

CREATE TABLE IF NOT EXISTS migration_tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    src_connection_id INTEGER NOT NULL REFERENCES connections(id),
    dst_connection_id INTEGER NOT NULL REFERENCES connections(id),
    config            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed')),
    progress          TEXT,
    error_report      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS migration_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES migration_tasks(id) ON DELETE CASCADE,
    check_type  TEXT NOT NULL CHECK(check_type IN ('type_compat','null_constraint','pk_conflict','other')),
    table_name  TEXT NOT NULL,
    column_name TEXT,
    severity    TEXT NOT NULL CHECK(severity IN ('error','warning','info')),
    message     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_checks_task ON migration_checks(task_id);
