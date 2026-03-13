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
