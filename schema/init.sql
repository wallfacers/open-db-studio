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
    driver TEXT NOT NULL CHECK(driver IN ('mysql','postgres','oracle','sqlserver','sqlite','doris','tidb','clickhouse','gaussdb','db2')),
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    password_enc TEXT,
    extra_params TEXT,
    file_path TEXT,
    auth_type TEXT,
    token_enc TEXT,
    ssl_mode TEXT,
    ssl_ca_path TEXT,
    ssl_cert_path TEXT,
    ssl_key_path TEXT,
    connect_timeout_secs INTEGER DEFAULT 30,
    read_timeout_secs INTEGER DEFAULT 60,
    pool_max_connections INTEGER DEFAULT 5,
    pool_idle_timeout_secs INTEGER DEFAULT 300,
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
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    opencode_display_name  TEXT NOT NULL DEFAULT '',  -- opencode 侧模型展示名（如 "Kimi K2.5"），空则回退到 name
    opencode_model_options TEXT NOT NULL DEFAULT '',  -- JSON：modalities + options.thinking 等模型级配置
    opencode_provider_name TEXT NOT NULL DEFAULT ''   -- opencode provider 展示名（如 "Model Studio Coding Plan"）
);

-- 任务记录表（导入导出、迁移等后台任务）
CREATE TABLE IF NOT EXISTS task_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('export', 'import', 'migration', 'seatunnel', 'ai_generate_metrics')),
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
    metric_count INTEGER,         -- ai_generate_metrics：新增指标数
    skipped_count INTEGER,        -- ai_generate_metrics：跳过（重复）指标数
    logs TEXT,                    -- JSON 数组，任务运行日志（{level,message,timestamp_ms}[]）
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
    node_type     TEXT NOT NULL CHECK(node_type IN ('table','column','fk','index','metric','alias','link')),
    connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
    database      TEXT,
    schema_name   TEXT,
    name          TEXT NOT NULL,
    display_name  TEXT,
    aliases       TEXT,
    source        TEXT DEFAULT 'schema',
    is_deleted    INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT,
    position_x    REAL,
    position_y    REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_conn ON graph_nodes(connection_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_db   ON graph_nodes(connection_id, database);

-- 图谱边
CREATE TABLE IF NOT EXISTS graph_edges (
    id         TEXT PRIMARY KEY,
    from_node  TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    to_node    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    edge_type  TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0,
    metadata   TEXT,
    source     TEXT NOT NULL DEFAULT 'schema'
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from   ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to     ON graph_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);

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
    source               TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
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

-- UI 状态持久化（树展开、标签页、已打开连接等）
CREATE TABLE IF NOT EXISTS ui_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ V3: MCP Tab 联动变更历史 ============

CREATE TABLE IF NOT EXISTS change_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  old_value   TEXT NOT NULL,
  new_value   TEXT,
  status      TEXT NOT NULL CHECK(status IN ('pending','success','failed','undone')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_change_history_session ON change_history(session_id, id DESC);

-- ============ V4: Agent Sessions (opencode HTTP Serve 模式) ============

CREATE TABLE IF NOT EXISTS agent_sessions (
  id          TEXT PRIMARY KEY,   -- opencode session UUID
  title       TEXT,
  config_id   INTEGER,            -- 关联 llm_configs 表
  is_temp     INTEGER DEFAULT 0,  -- 1 = SQL解释/优化临时session，不显示在历史
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ============ V5: 知识图谱增量更新 ============

-- 注意：graph_nodes 的 source / aliases 列迁移语句（ALTER TABLE）
-- 不在此处执行，而是在 src-tauri/src/db/migrations.rs 中用 PRAGMA table_info
-- 检查列是否存在后再执行，以保证幂等性（SQLite 不支持 ALTER TABLE IF NOT EXISTS）。

-- Schema 变更日志（用于增量更新知识图谱）
CREATE TABLE IF NOT EXISTS schema_change_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  -- 'ADD_TABLE' | 'DROP_TABLE' | 'ADD_COLUMN' | 'DROP_COLUMN' | 'ADD_FK'
  database      TEXT,
  schema        TEXT,
  table_name    TEXT NOT NULL,
  column_name   TEXT,
  metadata      TEXT,
  processed     INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  processed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_pending
  ON schema_change_log(connection_id, processed);

-- FTS5 全文搜索虚拟表（对 graph_nodes 做内容表索引）
CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts
USING fts5(
  id         UNINDEXED,
  name,
  display_name,
  aliases,
  content='graph_nodes',
  content_rowid='rowid'
);

-- ============ V6: SeaTunnel 迁移中心 ============

-- SeaTunnel 集群连接
CREATE TABLE IF NOT EXISTS seatunnel_connections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,        -- REST API base URL, e.g. http://host:5801
  auth_token_enc TEXT,             -- AES-256-GCM 加密存储（_enc 后缀对齐现有 password_enc/api_key_enc 命名规范）
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 用户自定义分类（支持无限嵌套；根目录必须有 connection_id 归属集群）
CREATE TABLE IF NOT EXISTS seatunnel_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  parent_id     INTEGER REFERENCES seatunnel_categories(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- SeaTunnel Job 定义
CREATE TABLE IF NOT EXISTS seatunnel_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES seatunnel_categories(id) ON DELETE SET NULL,
  connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE SET NULL,
  config_json   TEXT NOT NULL DEFAULT '{}',
  last_job_id   TEXT,              -- SeaTunnel 返回的 jobId（字符串）
  last_status   TEXT,              -- RUNNING / FINISHED / FAILED / CANCELLED
  submitted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============ V7: ER 设计器 ============

-- ER 项目
CREATE TABLE IF NOT EXISTS er_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT,
    connection_id   INTEGER NULL,
    database_name   TEXT NULL,
    schema_name     TEXT NULL,
    viewport_x      REAL DEFAULT 0,
    viewport_y      REAL DEFAULT 0,
    viewport_zoom   REAL DEFAULT 1,
    default_constraint_method TEXT NOT NULL DEFAULT 'database_fk',
    default_comment_format    TEXT NOT NULL DEFAULT '@ref',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ER 表
CREATE TABLE IF NOT EXISTS er_tables (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES er_projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    comment         TEXT,
    position_x      REAL DEFAULT 0,
    position_y      REAL DEFAULT 0,
    color           TEXT NULL,
    constraint_method  TEXT NULL,
    comment_format     TEXT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ER 列
CREATE TABLE IF NOT EXISTS er_columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id        INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    data_type       TEXT NOT NULL,
    nullable        INTEGER DEFAULT 1,
    default_value   TEXT NULL,
    is_primary_key  INTEGER DEFAULT 0,
    is_auto_increment INTEGER DEFAULT 0,
    comment         TEXT,
    length          INTEGER,
    scale           INTEGER,
    is_unique       INTEGER DEFAULT 0,
    unsigned        INTEGER DEFAULT 0,
    charset         TEXT,
    collation       TEXT,
    on_update       TEXT,
    enum_values     TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ER 关系
CREATE TABLE IF NOT EXISTS er_relations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES er_projects(id) ON DELETE CASCADE,
    name            TEXT NULL,
    source_table_id INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    source_column_id INTEGER NOT NULL REFERENCES er_columns(id) ON DELETE CASCADE,
    target_table_id INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    target_column_id INTEGER NOT NULL REFERENCES er_columns(id) ON DELETE CASCADE,
    relation_type   TEXT DEFAULT 'one_to_many',
    on_delete       TEXT DEFAULT 'NO ACTION',
    on_update       TEXT DEFAULT 'NO ACTION',
    source          TEXT DEFAULT 'designer',
    comment_marker  TEXT NULL,
    constraint_method  TEXT NULL,
    comment_format     TEXT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ER 索引
CREATE TABLE IF NOT EXISTS er_indexes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id        INTEGER NOT NULL REFERENCES er_tables(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT DEFAULT 'INDEX',
    columns         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 唯一约束：同一项目内表名不重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_er_tables_project_name ON er_tables(project_id, name);

-- ============================================================
-- Migration Center (native Rust ETL, replaces SeaTunnel)
-- ============================================================

CREATE TABLE IF NOT EXISTS migration_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES migration_categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES migration_categories(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_status TEXT CHECK(last_status IN ('RUNNING','FINISHED','FAILED','STOPPED')),
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_dirty_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL,
  row_index  INTEGER,
  field_name TEXT,
  raw_value  TEXT,
  error_msg  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_run_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  rows_read         INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  rows_failed       INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);