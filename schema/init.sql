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
