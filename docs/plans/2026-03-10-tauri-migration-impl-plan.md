<!-- STATUS: ✅ 已实现 -->
# open-db-studio Tauri 迁移 + 文档记录系统 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有 React 原型迁移至 Tauri 2.x 桌面架构，建立 Rust 后端骨架（多数据源 + AI 代理），同步建立完整的文档记录系统（CLAUDE.md + docs/）。

**Architecture:** 前端 React 18 + Vite 通过 Tauri invoke() 调用 Rust 后端；Rust 层统一管理内置 SQLite（应用配置）、外部数据源连接（MySQL/PG/Oracle/SqlServer）、AI 请求代理；CLAUDE.md ≈100 行作为地图，docs/ 作为结构化知识库。

**Tech Stack:** Tauri 2.x, React 18, TypeScript, Vite, Zustand, Rust, rusqlite, sqlx (MySQL/PG), reqwest (LLM HTTP), thiserror, async-trait, tokio

---

## 前置准备

### 环境检查
确认以下工具已安装，否则先安装：
- Rust + Cargo: `rustc --version` （需 >= 1.77）
- Node.js: `node --version` （需 >= 18）
- Tauri CLI v2: `npx @tauri-apps/cli --version`
- Visual Studio C++ Build Tools（Windows 必须）

---

## Task 1: 初始化 Tauri 2.x 脚手架

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`

### Step 1: 安装 Tauri CLI 和前端依赖

```bash
cd D:\project\java\source\open-db-studio
npm install --save-dev @tauri-apps/cli@^2
npm install @tauri-apps/api@^2
```

### Step 2: 运行 Tauri 初始化向导

```bash
npx tauri init
```

向导中填入：
- App name: `open-db-studio`
- Window title: `Open DB Studio`
- Web assets location: `../dist`（Vite 默认输出目录）
- Dev server URL: `http://localhost:1420`
- Dev command: `npm run dev`
- Build command: `npm run build`

### Step 3: 更新 package.json

将 `name` 改为 `open-db-studio`，删除 Node.js 相关依赖（express、better-sqlite3），添加 Tauri 脚本：

```json
{
  "name": "open-db-studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port=1420",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@xyflow/react": "^12.10.1",
    "lucide-react": "^0.546.0",
    "motion": "^12.23.24",
    "prismjs": "^1.30.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "react-simple-code-editor": "^0.14.1",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/node": "^22.14.0",
    "@types/prismjs": "^1.26.6",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^5.0.4",
    "@tailwindcss/vite": "^4.1.14",
    "autoprefixer": "^10.4.21",
    "tailwindcss": "^4.1.14",
    "typescript": "~5.8.2",
    "vite": "^6.2.0"
  }
}
```

### Step 4: 更新 vite.config.ts 适配 Tauri

```typescript
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri 要求固定端口
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tauri 会监听文件变化，忽略 src-tauri 目录
      ignored: ['**/src-tauri/**'],
    },
  },
  // Tauri 生产构建使用相对路径
  base: process.env.TAURI_ENV_DEBUG ? '/' : './',
});
```

### Step 5: 验证脚手架可以编译

```bash
cd D:\project\java\source\open-db-studio
npm install
npx tauri dev
```

预期结果：Tauri 窗口弹出，显示 React 前端（可能有报错，属正常，因为还未删除旧依赖引用）。

### Step 6: 提交

```bash
git add package.json vite.config.ts src-tauri/
git commit -m "feat: 初始化 Tauri 2.x 脚手架"
```

---

## Task 2: 更新 Rust Cargo.toml 添加项目依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`

### Step 1: 替换 Cargo.toml 内容

```toml
[package]
name = "open-db-studio"
version = "0.1.0"
description = "AI-Native Database Client"
authors = []
edition = "2021"
rust-version = "1.77"

[lib]
name = "open_db_studio_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[[bin]]
name = "open-db-studio"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"

serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }

# 内置 SQLite
rusqlite = { version = "0.32", features = ["bundled"] }

# 外部数据源（MySQL + PostgreSQL）
sqlx = { version = "0.8", features = [
  "runtime-tokio-native-tls",
  "mysql",
  "postgres",
  "json",
  "chrono",
] }

# HTTP 客户端（LLM 代理）
reqwest = { version = "0.12", features = ["json", "stream"] }

# 错误处理
thiserror = "1"
anyhow = "1"

# 异步 trait
async-trait = "0.1"

# 日志
log = "0.4"
env_logger = "0.11"

# 加密（连接密码）
aes-gcm = "0.10"
base64 = "0.22"
rand = "0.8"

# 时间
chrono = { version = "0.4", features = ["serde"] }

# 其他
once_cell = "1"
uuid = { version = "1", features = ["v4"] }

[features]
custom-protocol = ["tauri/custom-protocol"]
```

### Step 2: 验证依赖可以解析

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo fetch
```

预期结果：`Fetch [===>...] 依赖下载中`，无 error。

### Step 3: 提交

```bash
git add src-tauri/Cargo.toml
git commit -m "feat: 添加 Rust 后端依赖（sqlx、rusqlite、reqwest、aes-gcm）"
```

---

## Task 3: 创建 Rust 错误类型和基础结构

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/error.rs`

### Step 1: 写 main.rs

```rust
// src-tauri/src/main.rs
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    open_db_studio_lib::run();
}
```

### Step 2: 写 error.rs

```rust
// src-tauri/src/error.rs
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("SQL error: {0}")]
    Sql(#[from] sqlx::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Datasource error: {0}")]
    Datasource(String),

    #[error("LLM error: {0}")]
    Llm(String),

    #[error("Encryption error: {0}")]
    Encryption(String),

    #[error("{0}")]
    Other(String),
}

// Tauri 命令要求错误类型实现 Serialize
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

### Step 3: 写 lib.rs 骨架

```rust
// src-tauri/src/lib.rs
mod commands;
mod db;
mod datasource;
mod error;
mod llm;

pub use error::{AppError, AppResult};

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // 连接管理
            commands::list_connections,
            commands::create_connection,
            commands::test_connection,
            commands::delete_connection,
            // 查询执行
            commands::execute_query,
            commands::get_tables,
            commands::get_schema,
            // AI 代理
            commands::ai_chat,
            commands::ai_generate_sql,
            // 历史 & 收藏
            commands::get_query_history,
            commands::save_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Step 4: 验证编译

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期结果：错误仅为"找不到模块 commands/db/datasource/llm"，说明基础结构正确。

### Step 5: 提交

```bash
git add src-tauri/src/
git commit -m "feat: 创建 Rust 基础结构（main.rs、lib.rs、error.rs）"
```

---

## Task 4: 创建内置 SQLite 模块（db/）

**Files:**
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/models.rs`
- Create: `src-tauri/src/db/migrations.rs`
- Create: `schema/init.sql`

### Step 1: 写 schema/init.sql

```sql
-- schema/init.sql
-- open-db-studio 内置 SQLite schema
-- 用途：存储应用配置（连接信息、分组、查询历史等）

CREATE TABLE IF NOT EXISTS connection_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES connection_groups(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_id INTEGER REFERENCES connection_groups(id),
    driver TEXT NOT NULL CHECK(driver IN ('mysql','postgres','oracle','sqlserver','sqlite')),
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    password_enc TEXT,
    extra_params TEXT,  -- JSON 存储额外连接参数
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
```

### Step 2: 写 db/models.rs

```rust
// src-tauri/src/db/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub extra_params: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub group_id: Option<i64>,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,  // 明文，存储时加密
    pub extra_params: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionGroup {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryHistory {
    pub id: i64,
    pub connection_id: Option<i64>,
    pub sql: String,
    pub executed_at: String,
    pub duration_ms: Option<i64>,
    pub row_count: Option<i64>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedQuery {
    pub id: i64,
    pub name: String,
    pub connection_id: Option<i64>,
    pub sql: String,
    pub created_at: String,
}
```

### Step 3: 写 db/migrations.rs

```rust
// src-tauri/src/db/migrations.rs
use rusqlite::Connection;
use crate::AppResult;

pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    let schema = include_str!("../../../schema/init.sql");
    conn.execute_batch(schema)?;
    log::info!("Database migrations completed");
    Ok(())
}
```

### Step 4: 写 db/mod.rs

```rust
// src-tauri/src/db/mod.rs
pub mod migrations;
pub mod models;

use once_cell::sync::OnceCell;
use rusqlite::Connection;
use std::sync::Mutex;
use crate::AppResult;

pub use models::*;

static DB: OnceCell<Mutex<Connection>> = OnceCell::new();

pub fn init(app_data_dir: &str) -> AppResult<()> {
    let db_path = format!("{}/open-db-studio.db", app_data_dir);
    let conn = Connection::open(&db_path)?;

    // 开启 WAL 模式提升并发性能
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    migrations::run_migrations(&conn)?;

    DB.set(Mutex::new(conn))
        .map_err(|_| crate::AppError::Other("DB already initialized".into()))?;

    log::info!("SQLite initialized at {}", db_path);
    Ok(())
}

pub fn get() -> &'static Mutex<Connection> {
    DB.get().expect("DB not initialized")
}

// 列出所有连接
pub fn list_connections() -> AppResult<Vec<Connection_>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, created_at, updated_at
         FROM connections ORDER BY name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(models::Connection {
            id: row.get(0)?,
            name: row.get(1)?,
            group_id: row.get(2)?,
            driver: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database_name: row.get(6)?,
            username: row.get(7)?,
            extra_params: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}
```

**注意**：上方 `Connection_` 是占位符，实际编译时用 `models::Connection`。

### Step 5: 验证编译

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期：db 模块相关错误消除（仍有 commands/datasource/llm 模块缺失的错误）。

### Step 6: 提交

```bash
git add src-tauri/src/db/ schema/
git commit -m "feat: 创建内置 SQLite 模块（db/ + schema/init.sql）"
```

---

## Task 5: 创建多数据源模块骨架（datasource/）

**Files:**
- Create: `src-tauri/src/datasource/mod.rs`
- Create: `src-tauri/src/datasource/mysql.rs`
- Create: `src-tauri/src/datasource/postgres.rs`
- Create: `src-tauri/src/datasource/oracle.rs`
- Create: `src-tauri/src/datasource/sqlserver.rs`

### Step 1: 写 datasource/mod.rs（定义 trait 和共享类型）

```rust
// src-tauri/src/datasource/mod.rs
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod sqlserver;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use crate::AppResult;

/// 查询结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub duration_ms: u64,
}

/// 表元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableMeta {
    pub schema: Option<String>,
    pub name: String,
    pub table_type: String,  // "TABLE" | "VIEW"
}

/// 列元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

/// 数据库 schema 信息（表 + 列）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SchemaInfo {
    pub tables: Vec<TableMeta>,
}

/// 连接配置（来自前端 invoke 调用）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionConfig {
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub extra_params: Option<String>,
}

/// 数据源统一抽象 trait
#[async_trait]
pub trait DataSource: Send + Sync {
    /// 测试连接是否可用
    async fn test_connection(&self) -> AppResult<()>;
    /// 执行 SQL，返回结果集
    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;
    /// 获取所有表列表
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>>;
    /// 获取数据库 schema（表结构摘要，用于 AI Prompt 注入）
    async fn get_schema(&self) -> AppResult<SchemaInfo>;
}

/// 根据配置创建对应数据源实例
pub async fn create_datasource(
    config: &ConnectionConfig,
) -> AppResult<Box<dyn DataSource>> {
    match config.driver.as_str() {
        "mysql" => Ok(Box::new(mysql::MySqlDataSource::new(config).await?)),
        "postgres" => Ok(Box::new(postgres::PostgresDataSource::new(config).await?)),
        "oracle" => Ok(Box::new(oracle::OracleDataSource::new(config).await?)),
        "sqlserver" => Ok(Box::new(sqlserver::SqlServerDataSource::new(config).await?)),
        d => Err(crate::AppError::Datasource(format!("Unsupported driver: {}", d))),
    }
}
```

### Step 2: 写 datasource/mysql.rs（MVP 实现）

```rust
// src-tauri/src/datasource/mysql.rs
use async_trait::async_trait;
use sqlx::mysql::MySqlPool;
use std::time::Instant;

use super::{ColumnMeta, ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::AppResult;

pub struct MySqlDataSource {
    pool: MySqlPool,
}

impl MySqlDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let url = format!(
            "mysql://{}:{}@{}:{}/{}",
            config.username, config.password, config.host, config.port, config.database
        );
        let pool = MySqlPool::connect(&url).await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl DataSource for MySqlDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let start = Instant::now();
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
        let duration_ms = start.elapsed().as_millis() as u64;

        // 提取列名和数据
        let columns: Vec<String> = if let Some(first) = rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                use sqlx::Row;
                (0..columns.len())
                    .map(|i| {
                        row.try_get::<Option<String>, _>(i)
                            .ok()
                            .flatten()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|(name, table_type)| TableMeta {
            schema: None,
            name,
            table_type,
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }
}
```

### Step 3: 写 datasource/postgres.rs（MVP 实现）

```rust
// src-tauri/src/datasource/postgres.rs
use async_trait::async_trait;
use sqlx::postgres::PgPool;
use std::time::Instant;

use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::AppResult;

pub struct PostgresDataSource {
    pool: PgPool,
}

impl PostgresDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        let url = format!(
            "postgresql://{}:{}@{}:{}/{}",
            config.username, config.password, config.host, config.port, config.database
        );
        let pool = PgPool::connect(&url).await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl DataSource for PostgresDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let start = Instant::now();
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
        let duration_ms = start.elapsed().as_millis() as u64;

        let columns: Vec<String> = if let Some(first) = rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                use sqlx::Row;
                (0..columns.len())
                    .map(|i| {
                        row.try_get::<Option<String>, _>(i)
                            .ok()
                            .flatten()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT table_name, table_type, table_schema
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|(name, table_type, schema)| TableMeta {
            schema: Some(schema),
            name,
            table_type,
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }
}
```

### Step 4: 写 datasource/oracle.rs（占位骨架）

```rust
// src-tauri/src/datasource/oracle.rs
// TODO: Oracle 支持，当前为占位实现
// 依赖: oracle crate (sibyl) 或 ODBC 桥接
use async_trait::async_trait;
use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::{AppError, AppResult};

pub struct OracleDataSource;

impl OracleDataSource {
    pub async fn new(_config: &ConnectionConfig) -> AppResult<Self> {
        Err(AppError::Datasource("Oracle support not yet implemented".into()))
    }
}

#[async_trait]
impl DataSource for OracleDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        Err(AppError::Datasource("Oracle support not yet implemented".into()))
    }
    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Datasource("Oracle support not yet implemented".into()))
    }
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        Err(AppError::Datasource("Oracle support not yet implemented".into()))
    }
    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        Err(AppError::Datasource("Oracle support not yet implemented".into()))
    }
}
```

### Step 5: 写 datasource/sqlserver.rs（占位骨架）

```rust
// src-tauri/src/datasource/sqlserver.rs
// TODO: SQL Server 支持，当前为占位实现
// 依赖: tiberius crate
use async_trait::async_trait;
use super::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::{AppError, AppResult};

pub struct SqlServerDataSource;

impl SqlServerDataSource {
    pub async fn new(_config: &ConnectionConfig) -> AppResult<Self> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
}

#[async_trait]
impl DataSource for SqlServerDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        Err(AppError::Datasource("SQL Server support not yet implemented".into()))
    }
}
```

### Step 6: 验证编译

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期：datasource 模块相关错误消除。

### Step 7: 提交

```bash
git add src-tauri/src/datasource/
git commit -m "feat: 创建多数据源模块骨架（MySQL/PG 实现，Oracle/SqlServer 占位）"
```

---

## Task 6: 创建 LLM 代理模块（llm/）

**Files:**
- Create: `src-tauri/src/llm/mod.rs`
- Create: `src-tauri/src/llm/client.rs`

### Step 1: 写 llm/mod.rs

```rust
// src-tauri/src/llm/mod.rs
pub mod client;
pub use client::*;
```

### Step 2: 写 llm/client.rs

```rust
// src-tauri/src/llm/client.rs
use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::AppResult;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,   // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatContext {
    pub history: Vec<ChatMessage>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: ChatMessage,
}

pub struct LlmClient {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
}

impl LlmClient {
    pub fn new(api_key: String, base_url: Option<String>, model: Option<String>) -> Self {
        Self {
            client: Client::new(),
            api_key,
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com".to_string()),
            model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
        }
    }

    /// 通用对话（AI 助手聊天）
    pub async fn chat(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
        let req = OpenAIRequest {
            model: self.model.clone(),
            messages,
            stream: false,
        };

        let resp: OpenAIResponse = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&req)
            .send()
            .await?
            .json()
            .await?;

        resp.choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| crate::AppError::Llm("Empty response from LLM".into()))
    }

    /// 自然语言 → SQL（注入 schema 上下文）
    pub async fn generate_sql(
        &self,
        user_prompt: &str,
        schema_context: &str,
        sql_dialect: &str,
    ) -> AppResult<String> {
        // 从 prompts/ 目录加载模板
        let system_prompt = include_str!("../../../prompts/sql_generate.txt")
            .replace("{{DIALECT}}", sql_dialect)
            .replace("{{SCHEMA}}", schema_context);

        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: user_prompt.to_string() },
        ];

        self.chat(messages).await
    }
}
```

### Step 3: 验证编译

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期：llm 模块相关错误消除。

### Step 4: 提交

```bash
git add src-tauri/src/llm/
git commit -m "feat: 创建 LLM 代理模块（OpenAI 兼容接口）"
```

---

## Task 7: 创建 Tauri 命令层（commands.rs）

**Files:**
- Create: `src-tauri/src/commands.rs`

### Step 1: 写 commands.rs 骨架

```rust
// src-tauri/src/commands.rs
use crate::datasource::{ConnectionConfig, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory, SavedQuery};
use crate::llm::{ChatContext, LlmClient};
use crate::{AppError, AppResult};
use once_cell::sync::OnceCell;
use std::sync::Mutex;

// LLM 客户端单例（从 app_settings 读取配置后初始化）
static LLM_CLIENT: OnceCell<Mutex<LlmClient>> = OnceCell::new();

// ============ 连接管理 ============

#[tauri::command]
pub async fn list_connections() -> AppResult<Vec<Connection>> {
    crate::db::list_connections()
}

#[tauri::command]
pub async fn create_connection(req: CreateConnectionRequest) -> AppResult<Connection> {
    // TODO: 加密密码后存储
    // 1. 加密 req.password
    // 2. 插入 connections 表
    // 3. 返回创建的 Connection
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<bool> {
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.test_connection().await?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_connection(id: i64) -> AppResult<()> {
    // TODO: 从 connections 表删除
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ 查询执行 ============

#[tauri::command]
pub async fn execute_query(connection_id: i64, sql: String) -> AppResult<QueryResult> {
    // TODO: 1. 从 db 读取 connection 配置; 2. 解密密码; 3. 创建 datasource; 4. 执行; 5. 记录历史
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn get_tables(connection_id: i64) -> AppResult<Vec<TableMeta>> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn get_schema(connection_id: i64) -> AppResult<SchemaInfo> {
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ AI 代理 ============

#[tauri::command]
pub async fn ai_chat(message: String, context: ChatContext) -> AppResult<String> {
    // TODO: 从 app_settings 读取 API Key，初始化 LlmClient
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn ai_generate_sql(prompt: String, connection_id: i64) -> AppResult<String> {
    // TODO: get_schema(connection_id) → generate_sql(prompt, schema)
    Err(AppError::Other("Not implemented yet".into()))
}

// ============ 历史 & 收藏 ============

#[tauri::command]
pub async fn get_query_history(connection_id: i64) -> AppResult<Vec<QueryHistory>> {
    Err(AppError::Other("Not implemented yet".into()))
}

#[tauri::command]
pub async fn save_query(name: String, connection_id: i64, sql: String) -> AppResult<SavedQuery> {
    Err(AppError::Other("Not implemented yet".into()))
}
```

### Step 2: 验证全量编译

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期：**0 个 error**（warning 可以存在）。

### Step 3: 运行 clippy 检查

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo clippy
```

记录 warning，但不要求此时全部清零（骨架阶段）。

### Step 4: 提交

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: 创建 Tauri 命令层骨架（commands.rs），Rust 后端骨架完成"
```

---

## Task 8: 创建 Prompt 模板文件

**Files:**
- Create: `prompts/sql_generate.txt`
- Create: `prompts/sql_explain.txt`
- Create: `prompts/sql_optimize.txt`

### Step 1: 写 prompts/sql_generate.txt

```
You are an expert SQL assistant. Generate a SQL query for the {{DIALECT}} database dialect.

Database Schema:
{{SCHEMA}}

Rules:
- Return ONLY the SQL query, no explanation
- Use proper {{DIALECT}} syntax
- Prefer readable formatting with proper indentation
- Do not use SELECT * unless explicitly requested
- Always add appropriate WHERE clauses to avoid full table scans
```

### Step 2: 写 prompts/sql_explain.txt

```
You are an expert SQL assistant. Explain the following SQL query in simple, clear language.

Database Dialect: {{DIALECT}}

Database Schema:
{{SCHEMA}}

Explain:
1. What this query does (in plain English)
2. Which tables are involved and how they are joined
3. Any performance considerations

Be concise and focus on what a developer needs to know.
```

### Step 3: 写 prompts/sql_optimize.txt

```
You are an expert SQL performance engineer. Analyze and optimize the following SQL query.

Database Dialect: {{DIALECT}}

Database Schema:
{{SCHEMA}}

Provide:
1. Identified performance issues
2. Optimized SQL query
3. Brief explanation of changes made

Return format:
ISSUES: [list issues]
OPTIMIZED SQL:
[sql here]
CHANGES: [brief explanation]
```

### Step 4: 提交

```bash
git add prompts/
git commit -m "feat: 创建 SQL Prompt 模板（生成/解释/优化）"
```

---

## Task 9: 创建 CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

### Step 1: 写 CLAUDE.md（严格控制 ≈100 行）

```markdown
# CLAUDE.md — open-db-studio 智能体上下文工程文件

本文件是 Claude Code 的核心上下文入口。每次开始任务前先阅读本文件，
再根据任务类型查阅对应子文档。

## 项目概述

**open-db-studio** 是一款本地优先的 AI 数据库 IDE 桌面应用，复刻 chat2db 核心功能。

核心价值：连接多数据源 → 自然语言转 SQL → 执行查询 → 可视化结果，**全程本地运行**。

产品定位：**AI-Native Database Client**

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript + Vite |
| 状态管理 | Zustand |
| 路由 | React Router v6 |
| 后端 | Rust |
| 内置数据库 | SQLite（via rusqlite）— 存储应用配置 |
| 外部数据源 | MySQL、PostgreSQL、Oracle（占位）、SQL Server（占位） |
| AI 接入 | Rust 层统一代理（OpenAI 兼容接口） |

## 目录结构

```
open-db-studio/
├── CLAUDE.md              # 本文件（智能体上下文入口）
├── ARCHITECTURE.md        # 系统架构详述
├── src/                   # React 前端
├── src-tauri/             # Rust 后端
│   └── src/
│       ├── commands.rs    # 所有 Tauri invoke 命令注册
│       ├── db/            # 内置 SQLite（配置存储）
│       ├── datasource/    # 多数据源连接管理
│       └── llm/           # AI 请求统一代理
├── prompts/               # SQL 生成/解释/优化 Prompt 模板
├── schema/                # 内置 SQLite DDL（init.sql）
└── docs/                  # 文档记录系统（见下方导航）
```

## 文档导航

| 文档 | 用途 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构、模块说明、数据流 |
| [docs/DESIGN.md](./docs/DESIGN.md) | UI/UX 设计规范 |
| [docs/FRONTEND.md](./docs/FRONTEND.md) | 前端开发规范与组件说明 |
| [docs/PLANS.md](./docs/PLANS.md) | 当前开发计划与路线图 |
| [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md) | 代码质量标准 |
| [docs/SECURITY.md](./docs/SECURITY.md) | 安全策略（API Key、连接凭证） |
| [docs/design-docs/datasource-arch.md](./docs/design-docs/datasource-arch.md) | 多数据源架构设计 |
| [docs/design-docs/ai-pipeline.md](./docs/design-docs/ai-pipeline.md) | AI SQL 生成流程 |
| [docs/adr/](./docs/adr/) | 架构决策记录（ADR） |

## 开发命令

```bash
npm run dev          # 仅前端（端口 1420）
npm run tauri:dev    # Tauri 前后端联调
npm run tauri:build  # 打包
npx tsc --noEmit     # TypeScript 类型检查
cd src-tauri && cargo check  # Rust 编译检查
```

## 前后端通信约定

前端通过 Tauri `invoke()` 调用 Rust 命令（定义在 `src-tauri/src/commands.rs`）：

```typescript
import { invoke } from '@tauri-apps/api/core'
await invoke('test_connection', { config: { driver: 'mysql', ... } })
await invoke('execute_query', { connectionId: 1, sql: 'SELECT 1' })
await invoke('ai_generate_sql', { prompt: '查询用户表', connectionId: 1 })
```

## 关键约定

- 数据库操作（内置 SQLite + 外部数据源）全部在 Rust 层，前端不直接访问
- 所有 AI 请求走 `src-tauri/src/llm/client.rs` 统一代理
- 连接密码必须 AES-256 加密存储，见 [docs/SECURITY.md](./docs/SECURITY.md)
- 时间戳使用 ISO 8601 字符串（`datetime('now')` 返回格式）
- Rust 新增命令必须在 `lib.rs` 的 `generate_handler![]` 中注册
- 修改代码后检查文档新鲜度（见 docs/PLANS.md 中的触发表）

## 任务开始前检查清单

1. 阅读 CLAUDE.md（本文件）
2. 根据任务类型查阅对应文档（见文档导航）
3. 了解相关模块现有代码再修改
4. 遵循 [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md) 中的质量标准
```

### Step 2: 验证行数不超过 110 行

```bash
# Windows PowerShell
(Get-Content CLAUDE.md).Count
```

预期：< 110

### Step 3: 提交

```bash
git add CLAUDE.md
git commit -m "docs: 创建 CLAUDE.md（智能体上下文入口，≈100行地图文件）"
```

---

## Task 10: 创建 ARCHITECTURE.md

**Files:**
- Create: `ARCHITECTURE.md`

### Step 1: 写 ARCHITECTURE.md

```markdown
# ARCHITECTURE.md — open-db-studio 系统架构

## 系统概览

```
[用户] → [Tauri 窗口]
              ↓
    [React 前端 (src/)]
    - ActivityBar / Explorer / MainContent / Assistant
    - Zustand store 管理状态
              ↓ invoke()
    [Rust 后端 (src-tauri/src/)]
              ├── commands.rs  ← 统一入口
              ├── db/          ← 内置 SQLite（应用配置）
              ├── datasource/  ← 外部数据源连接
              └── llm/         ← AI 请求代理
              ↓
    [外部服务]
    ├── MySQL / PostgreSQL / Oracle / SQL Server
    └── OpenAI API（或兼容接口）
```

## 模块说明

### src/ — React 前端

| 目录 | 说明 |
|------|------|
| `components/ActivityBar/` | 左侧图标导航栏（VSCode 风格） |
| `components/Explorer/` | 数据库/表树形浏览器 |
| `components/MainContent/` | SQL 编辑器 + 结果集展示 |
| `components/Assistant/` | AI 对话面板 |
| `store/` | Zustand 全局状态（connections、tabs、queryResults） |
| `hooks/` | 自定义 hooks（useInvoke、useConnection 等） |
| `types/` | TypeScript 类型定义（与 Rust 数据结构对齐） |

### src-tauri/src/ — Rust 后端

| 文件/目录 | 说明 |
|-----------|------|
| `commands.rs` | 所有 `#[tauri::command]` 注册，前后端通信唯一入口 |
| `error.rs` | 统一错误类型 `AppError`，实现 `Serialize` 供前端消费 |
| `db/` | 内置 SQLite，管理连接配置、查询历史、收藏查询 |
| `datasource/` | DataSource trait + MySQL/PG 实现 + Oracle/SqlServer 占位 |
| `llm/` | OpenAI 兼容接口，统一代理所有 AI 请求 |

## 数据流

### 用户执行 SQL 查询

```
前端输入 SQL
→ invoke('execute_query', { connectionId, sql })
→ commands::execute_query()
→ db::get_connection(connectionId)  // 读取连接配置
→ decrypt(password_enc)             // 解密密码
→ datasource::create_datasource()   // 创建数据源实例
→ datasource.execute(sql)           // 执行查询
→ db::record_history()              // 记录到 query_history
→ QueryResult                       // 返回前端
→ 渲染结果表格
```

### AI 生成 SQL

```
用户输入自然语言
→ invoke('ai_generate_sql', { prompt, connectionId })
→ commands::ai_generate_sql()
→ get_schema(connectionId)          // 获取数据库结构
→ llm::generate_sql(prompt, schema) // 注入 schema 到 Prompt
→ OpenAI API 调用
→ SQL 字符串
→ 填充到编辑器
```

## 状态管理（Zustand）

```typescript
// 核心 store 结构
{
  connections: Connection[],      // 连接列表（从 Rust 同步）
  activeConnectionId: number,     // 当前激活连接
  tabs: Tab[],                    // 打开的查询标签页
  activeTabId: string,
  queryResults: Map<string, QueryResult>,  // 各 tab 的查询结果
  chatMessages: ChatMessage[],    // AI 对话历史
}
```

## 安全边界

详见 [docs/SECURITY.md](./docs/SECURITY.md)。核心原则：
- 连接密码永远不离开 Rust 层（AES-256 加密存储）
- AI API Key 通过 Tauri secure storage 存储，不写入 SQLite 明文
- 前端只能通过 `invoke()` 获取脱敏后的连接信息（无密码字段）
```

### Step 2: 提交

```bash
git add ARCHITECTURE.md
git commit -m "docs: 创建 ARCHITECTURE.md（系统架构详述）"
```

---

## Task 11: 创建 docs/ 规范文档骨架

**Files:**
- Create: `docs/DESIGN.md`
- Create: `docs/FRONTEND.md`
- Create: `docs/QUALITY_SCORE.md`
- Create: `docs/SECURITY.md`
- Create: `docs/PLANS.md`

### Step 1: 写 docs/QUALITY_SCORE.md

```markdown
# QUALITY_SCORE.md — 代码质量标准

## TypeScript 规范

- `strict: true` 必须开启（见 tsconfig.json）
- 禁止 `any` 类型（使用 `unknown` + 类型守卫）
- 所有 `invoke()` 调用必须有明确的返回类型标注
- 组件 props 必须定义 interface，不使用内联类型

## Rust 规范

- `cargo clippy` 必须 0 个 warning（CI 门控）
- 禁止 `.unwrap()`，使用 `?` 运算符或显式错误处理
- 所有公开函数必须有 doc comment (`///`)
- 异步函数统一使用 `async/await`，不使用 `block_on`

## 通用规范

- 函数长度：单函数不超过 50 行
- 注释：逻辑不自明时才写注释，注释解释"为什么"而非"是什么"
- 提交信息：遵循 Conventional Commits（feat/fix/docs/refactor）
```

### Step 2: 写 docs/SECURITY.md

```markdown
# SECURITY.md — 安全策略

## 连接凭证安全

- 密码存储：AES-256-GCM 加密，密钥从 OS keychain 读取
- 密码传输：前端 → Rust 通过 invoke() 传明文（TLS 保护 IPC），Rust 加密后存储
- 密码读取：Rust 解密后直接用于建立连接，**永远不返回明文给前端**
- 前端可见字段：连接配置中 `password` 字段始终为 `null` 或 `"***"`

## API Key 安全

- 存储：使用 `tauri-plugin-store` 加密存储，不写入 SQLite 明文
- 使用：仅在 Rust llm/client.rs 中读取，不通过 invoke 返回给前端
- 日志：禁止在任何日志中输出 API Key（包括 debug 级别）

## 禁止事项

- 禁止在前端代码中硬编码任何凭证
- 禁止将 .env 文件提交到 git
- 禁止通过 invoke 返回包含密码的数据结构
```

### Step 3: 写 docs/DESIGN.md

```markdown
# DESIGN.md — UI/UX 设计规范

## 主题

- 基础主题：VSCode Dark（`#141414` 背景，`#cccccc` 文字）
- 禁止使用内联 style，所有样式通过 Tailwind 类名

## 颜色 Token

| 用途 | 值 |
|------|-----|
| 背景主色 | `#141414` |
| 面板背景 | `#1e1e1e` |
| 边框 | `#2b2b2b` |
| 文字主色 | `#cccccc` |
| 文字次色 | `#888888` |
| 强调色（蓝） | `#569cd6` |
| 成功色（绿） | `#4ec9b0` |
| 错误色（红） | `#f44747` |

## 布局

- 应用采用 VSCode 三栏布局：ActivityBar（48px）+ Explorer（可调宽）+ 主内容 + Assistant（可调宽）
- 所有面板宽度可拖拽调整，最小宽度不得低于 150px
- 字体大小统一使用 13px（`text-[13px]`）

## 组件约定

- 图标库：lucide-react
- 动画：motion（仅用于必要的 UX 反馈动画）
- 禁止使用外部 UI 组件库（shadcn/antd 等），保持轻量
```

### Step 4: 写 docs/FRONTEND.md

```markdown
# FRONTEND.md — 前端开发规范

## 组件结构

- 每个组件一个目录，入口文件为 `index.tsx`
- 复杂组件的子组件放在同目录下（如 `Explorer/TreeItem.tsx`）
- 组件命名：PascalCase，目录与组件名一致

## Zustand Store

- 每个业务领域一个 store 文件（`store/connections.ts`、`store/tabs.ts` 等）
- Store 只存 UI 状态和从 Rust 同步的数据，不存派生数据
- 异步操作（invoke 调用）放在 store 的 action 中，不放在组件里

## Tauri invoke 封装规范

- 所有 invoke 调用封装在 `src/hooks/` 或 `src/utils/tauri.ts` 中
- 不在组件内直接调用 `invoke()`，通过封装函数调用
- 封装函数命名：`use<Feature>` (hook) 或 `<action><Resource>` (util)

```typescript
// 正确示例（封装在 hooks/useConnections.ts）
export function useConnections() {
  const setConnections = useConnectionStore(s => s.setConnections);
  const fetchConnections = async () => {
    const list = await invoke<Connection[]>('list_connections');
    setConnections(list);
  };
  return { fetchConnections };
}

// 错误示例（直接在组件里调用）
// const data = await invoke('list_connections'); // ❌
```

## 类型定义

- Rust 数据结构在 `src/types/` 中对应定义 TypeScript 接口
- 字段名约定：Rust snake_case → TypeScript camelCase（由 serde rename 或手动对齐）
```

### Step 5: 写 docs/PLANS.md

```markdown
# PLANS.md — 开发计划与路线图

## 当前阶段：MVP（2026 Q1）

### 已完成
- [x] Tauri 2.x 脚手架初始化
- [x] Rust 后端骨架（db/、datasource/、llm/）
- [x] 内置 SQLite schema（connections、history、saved_queries）
- [x] MySQL + PostgreSQL DataSource 实现（骨架）
- [x] LLM 代理模块（OpenAI 兼容）
- [x] CLAUDE.md + docs/ 文档记录系统

### 进行中
- [ ] 连接管理 UI（新建/编辑/删除连接）
- [ ] execute_query 命令完整实现
- [ ] 密码加密存储（AES-256-GCM）

### 待开始
- [ ] SQL 编辑器与 Rust 后端联调
- [ ] AI 生成 SQL 功能完整实现
- [ ] 查询历史 UI
- [ ] Oracle、SQL Server 真实驱动实现

## 文档新鲜度触发表

| 触发事件 | 需更新的文档 |
|----------|------------|
| 新增 Tauri 命令 | ARCHITECTURE.md + CLAUDE.md 命令示例 |
| 新增数据源驱动 | docs/design-docs/datasource-arch.md + PLANS.md |
| 修改 SQLite schema | docs/design-docs/schema-design.md + schema/init.sql |
| 修改 Prompt 模板 | docs/design-docs/ai-pipeline.md |
| 重大架构决策 | 新建 docs/adr/XXX.md |
```

### Step 6: 提交

```bash
git add docs/DESIGN.md docs/FRONTEND.md docs/QUALITY_SCORE.md docs/SECURITY.md docs/PLANS.md
git commit -m "docs: 创建 docs/ 规范文档骨架（DESIGN/FRONTEND/QUALITY/SECURITY/PLANS）"
```

---

## Task 12: 创建 ADR 文件和 design-docs 骨架

**Files:**
- Create: `docs/adr/001-tauri-vs-electron.md`
- Create: `docs/adr/002-rust-datasource-layer.md`
- Create: `docs/adr/003-llm-proxy-backend.md`
- Create: `docs/design-docs/datasource-arch.md`
- Create: `docs/design-docs/ai-pipeline.md`
- Create: `docs/design-docs/schema-design.md`

### Step 1: 写 ADR-001

```markdown
# ADR-001: 选择 Tauri 而非 Electron

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

需要为 open-db-studio 选择桌面应用框架。主要候选方案为 Tauri 2.x 和 Electron。

## 决策

选择 **Tauri 2.x**。

## 后果

### 优点
- 安装包体积：Tauri ≈ 5-10MB vs Electron ≈ 80-150MB
- 内存占用：Tauri 使用系统 WebView，无捆绑 Chromium
- Rust 后端原生支持多数据库驱动（sqlx、rusqlite）
- 安全模型更严格（CSP、allowlist）

### 缺点
- Rust 学习成本高于 Node.js
- 跨平台 WebView 渲染一致性需要额外测试
- 生态成熟度低于 Electron

### 风险
- WebView2（Windows）版本依赖：需确保目标用户 Windows 10 1803+ 已安装 WebView2
```

### Step 2: 写 ADR-002

```markdown
# ADR-002: 数据源连接层放在 Rust 而非前端

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

多数据源连接管理可以放在前端（通过 Node.js 桥接）或 Rust 后端。

## 决策

所有数据源连接管理放在 **Rust 层（src-tauri/src/datasource/）**。

## 后果

### 优点
- 连接凭证（密码）不经过前端，安全边界清晰
- sqlx 连接池可跨标签页复用，避免重复建连
- Rust 原生多线程处理并发查询性能更好
- DataSource trait 提供统一抽象，新增数据源只需实现 trait

### 缺点
- 前端无法直接调试数据源连接
- Rust 编译时间增加（sqlx 编译较慢）

### 风险
- sqlx 的 Oracle/SQL Server 支持有限，后续可能需要 ODBC 桥接
```

### Step 3: 写 ADR-003

```markdown
# ADR-003: LLM 请求通过 Rust 后端统一代理

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

AI 对话和 SQL 生成请求可以从前端直接调用 OpenAI API，也可以通过 Rust 后端代理。

## 决策

所有 LLM 请求走 **Rust 层（src-tauri/src/llm/client.rs）统一代理**。

## 后果

### 优点
- API Key 不暴露在前端代码和网络请求中
- 可在 Rust 层统一做限流、重试、错误处理
- schema 注入（将数据库结构注入 Prompt）在 Rust 层完成，减少前端 IPC 数据量
- 未来可切换 LLM 提供商，前端无需改动

### 缺点
- 流式响应（streaming）实现更复杂（需要 Tauri event 机制）
- 调试链路比前端直调更长

### 风险
- streaming 响应目前使用轮询模拟，后续需改造为 Tauri emit/listen 事件流
```

### Step 4: 写 docs/design-docs/datasource-arch.md 骨架

```markdown
# 多数据源架构设计

## DataSource Trait

见 `src-tauri/src/datasource/mod.rs`。

所有数据源实现 `DataSource` trait，提供统一接口：`test_connection`、`execute`、`get_tables`、`get_schema`。

## 连接池策略

当前：每次查询创建新连接（MVP 阶段）
计划：使用 sqlx 连接池，按 connection_id 缓存 pool 实例

## 支持状态

| 数据源 | 状态 | 依赖 |
|--------|------|------|
| MySQL | MVP 实现 | sqlx mysql feature |
| PostgreSQL | MVP 实现 | sqlx postgres feature |
| Oracle | 占位 | TBD（sibyl 或 ODBC） |
| SQL Server | 占位 | TBD（tiberius） |
| SQLite（外部） | 待实现 | rusqlite |

## 并发隔离

每个 connection_id 对应独立连接池，不同连接的查询互不影响。
```

### Step 5: 写 docs/design-docs/ai-pipeline.md 骨架

```markdown
# AI SQL 生成流程

## 流程图

```
用户输入自然语言
→ invoke('ai_generate_sql', { prompt, connectionId })
→ commands::ai_generate_sql()
→ get_schema(connectionId)          // 获取表结构摘要
→ 加载 prompts/sql_generate.txt      // 读取 Prompt 模板
→ 替换 {{DIALECT}} 和 {{SCHEMA}}    // 注入上下文
→ llm::client.chat(messages)        // 调用 OpenAI API
→ 返回 SQL 字符串
→ 前端填充到编辑器
```

## Prompt 模板

位于 `prompts/` 目录，通过 `include_str!()` 在编译时嵌入二进制：
- `sql_generate.txt`：自然语言 → SQL
- `sql_explain.txt`：SQL 解释
- `sql_optimize.txt`：SQL 优化建议

## Schema 注入

`get_schema()` 返回表名列表（MVP 阶段），注入到 Prompt 的 `{{SCHEMA}}` 占位符。
后续增强：包含列名、类型、主外键关系。
```

### Step 6: 写 docs/design-docs/schema-design.md 骨架

```markdown
# 内置 SQLite Schema 设计

## 表结构

见 `schema/init.sql`（权威来源）。

## 核心表说明

| 表 | 用途 |
|----|------|
| `connections` | 数据库连接配置，密码 AES-256 加密 |
| `connection_groups` | 连接分组（树形结构，支持嵌套） |
| `query_history` | 查询历史记录，关联 connection |
| `saved_queries` | 用户收藏的查询语句 |
| `app_settings` | key-value 应用设置（AI 模型、主题等） |

## 迁移策略

当前：`execute_batch(include_str!("../../../schema/init.sql"))` 启动时执行（幂等 CREATE IF NOT EXISTS）。

后续：引入版本化迁移（参考 refinery crate），支持 schema 升级。
```

### Step 7: 提交

```bash
git add docs/adr/ docs/design-docs/
git commit -m "docs: 创建 ADR 文件（3个）和 design-docs 骨架"
```

---

## Task 13: 最终验证

### Step 1: 验证目录结构符合设计

检查以下目录和文件均存在：

```
CLAUDE.md
ARCHITECTURE.md
src-tauri/src/main.rs
src-tauri/src/lib.rs
src-tauri/src/error.rs
src-tauri/src/commands.rs
src-tauri/src/db/mod.rs
src-tauri/src/db/models.rs
src-tauri/src/db/migrations.rs
src-tauri/src/datasource/mod.rs
src-tauri/src/datasource/mysql.rs
src-tauri/src/datasource/postgres.rs
src-tauri/src/datasource/oracle.rs
src-tauri/src/datasource/sqlserver.rs
src-tauri/src/llm/mod.rs
src-tauri/src/llm/client.rs
schema/init.sql
prompts/sql_generate.txt
prompts/sql_explain.txt
prompts/sql_optimize.txt
docs/DESIGN.md
docs/FRONTEND.md
docs/QUALITY_SCORE.md
docs/SECURITY.md
docs/PLANS.md
docs/adr/001-tauri-vs-electron.md
docs/adr/002-rust-datasource-layer.md
docs/adr/003-llm-proxy-backend.md
docs/design-docs/datasource-arch.md
docs/design-docs/ai-pipeline.md
docs/design-docs/schema-design.md
```

### Step 2: Rust 全量编译验证

```bash
cd D:\project\java\source\open-db-studio\src-tauri
cargo check
```

预期：**0 个 error**

### Step 3: TypeScript 类型检查

```bash
cd D:\project\java\source\open-db-studio
npx tsc --noEmit
```

### Step 4: 验证 CLAUDE.md 行数

```powershell
(Get-Content CLAUDE.md).Count
```

预期：< 110

### Step 5: 最终提交

```bash
git add .
git commit -m "chore: Tauri 迁移 + 文档记录系统 MVP 完成"
```

---

## 注意事项

1. **sqlx 编译时间**：首次 `cargo check` 可能需要 5-10 分钟（sqlx 依赖较大）
2. **Tauri 初始化**：`npx tauri init` 会交互式提问，按 Task 1 Step 2 中的答案填写
3. **Windows 依赖**：需要安装 Visual Studio C++ Build Tools，若未安装会在 `cargo check` 时报错
4. **React 版本**：从 19 降回 18 以匹配目标技术栈，同时添加 Zustand 和 React Router
5. **Oracle/SqlServer**：当前骨架返回 `unimplemented` 错误，这是预期行为
