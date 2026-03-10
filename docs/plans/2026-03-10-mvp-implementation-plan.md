# MVP 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 open-db-studio MVP 阶段所有功能：连接管理 + SQL 执行 + Schema 树 + 查询历史 + 基础 AI SQL 生成/解释 + Oracle/MSSQL 驱动。

**Architecture:** Rust 后端先行，每个命令完整实现后再做前端联调。前端从 App.tsx 大组件重构为 Zustand store + 组件拆分，再逐步接入 Tauri invoke()。

**Tech Stack:** Tauri 2.x · React 18 + TypeScript · Zustand · Rust · rusqlite · sqlx (mysql/postgres) · aes-gcm · reqwest

---

## 依赖与顺序说明

```
Task 1 (加密模块)
  → Task 2 (连接 CRUD)
    → Task 3 (execute_query)
      → Task 4 (查询历史)
    → Task 5 (get_tables/schema)
Task 6 (LLM settings 命令)
  → Task 7 (ai_generate_sql + ai_explain_sql)
Task 8 (Oracle 驱动)
Task 9 (SQL Server 驱动)
Task 10 (Zustand stores) — 前端可并行开始
  → Task 11 (连接管理 UI)
  → Task 12 (Explorer 联调)
  → Task 13 (SQL 编辑器执行联调)
  → Task 14 (查询历史 UI)
  → Task 15 (AI 生成 SQL UI)
  → Task 16 (AI SQL 解释 UI)
  → Task 17 (LLM 设置 UI)
```

---

## Task 1：AES-256-GCM 加密模块

**Files:**
- Create: `src-tauri/src/crypto.rs`
- Modify: `src-tauri/src/lib.rs` (添加 `pub mod crypto;`)

**Step 1: 创建加密模块**

```rust
// src-tauri/src/crypto.rs
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use crate::AppResult;

const KEY_ENV: &str = "ODB_MASTER_KEY";

/// 派生或生成主密钥（32 字节）
fn get_key() -> [u8; 32] {
    // 优先从环境变量读取（生产可注入）
    // MVP 阶段使用固定派生密钥（后续迁移到 OS Keychain）
    let raw = std::env::var(KEY_ENV)
        .unwrap_or_else(|_| "open-db-studio-default-key-2026!".to_string());
    let mut key = [0u8; 32];
    let bytes = raw.as_bytes();
    let len = bytes.len().min(32);
    key[..len].copy_from_slice(&bytes[..len]);
    key
}

/// 加密明文密码 → Base64 编码的 nonce(12字节) + ciphertext
pub fn encrypt(plaintext: &str) -> AppResult<String> {
    let key = Key::<Aes256Gcm>::from_slice(&get_key());
    let cipher = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    // 格式：base64(nonce) + ":" + base64(ciphertext)
    let encoded = format!(
        "{}:{}",
        BASE64.encode(nonce_bytes),
        BASE64.encode(ciphertext)
    );
    Ok(encoded)
}

/// 解密 Base64 编码的密文 → 明文密码
pub fn decrypt(encoded: &str) -> AppResult<String> {
    let parts: Vec<&str> = encoded.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(crate::AppError::Encryption("Invalid encrypted format".into()));
    }

    let nonce_bytes = BASE64
        .decode(parts[0])
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;
    let ciphertext = BASE64
        .decode(parts[1])
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    let key = Key::<Aes256Gcm>::from_slice(&get_key());
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| crate::AppError::Encryption(e.to_string()))?;

    String::from_utf8(plaintext)
        .map_err(|e| crate::AppError::Encryption(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let password = "my_secret_password_123!";
        let encrypted = encrypt(password).unwrap();
        assert_ne!(encrypted, password);
        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, password);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertext_each_time() {
        let password = "same_password";
        let enc1 = encrypt(password).unwrap();
        let enc2 = encrypt(password).unwrap();
        // 每次加密 nonce 不同，结果应不同
        assert_ne!(enc1, enc2);
    }

    #[test]
    fn test_decrypt_invalid_input() {
        let result = decrypt("not_valid_base64_format");
        assert!(result.is_err());
    }
}
```

**Step 2: 在 lib.rs 注册模块**

在 `src-tauri/src/lib.rs` 中找到 `pub mod error;` 行，在其后添加：

```rust
pub mod crypto;
```

**Step 3: 运行测试**

```bash
cd src-tauri && cargo test crypto
```

Expected: 3 tests pass

**Step 4: Commit**

```bash
git add src-tauri/src/crypto.rs src-tauri/src/lib.rs
git commit -m "feat(crypto): add AES-256-GCM encrypt/decrypt module"
```

---

## Task 2：连接管理 Rust 后端（CRUD + 加密存储）

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (添加 create/delete/update_connection)
- Modify: `src-tauri/src/commands.rs` (实现 create_connection, delete_connection)

**Step 1: 在 db/mod.rs 添加 create_connection**

在文件末尾追加：

```rust
use chrono::Utc;

/// 创建连接，密码加密存储
pub fn create_connection(req: &models::CreateConnectionRequest) -> AppResult<models::Connection> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();

    let password_enc = match &req.password {
        Some(pwd) if !pwd.is_empty() => Some(crate::crypto::encrypt(pwd)?),
        _ => None,
    };

    conn.execute(
        "INSERT INTO connections (name, group_id, driver, host, port, database_name, username, password_enc, extra_params, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            req.name, req.group_id, req.driver, req.host, req.port,
            req.database_name, req.username, password_enc,
            req.extra_params, now
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, created_at, updated_at
         FROM connections WHERE id = ?1",
        [id],
        |row| Ok(models::Connection {
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
        }),
    )?;
    Ok(result)
}

/// 删除连接（CASCADE 删除关联历史）
pub fn delete_connection(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let affected = conn.execute("DELETE FROM connections WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("Connection {} not found", id)));
    }
    Ok(())
}

/// 获取连接的加密密码（用于执行查询）
pub fn get_connection_password(id: i64) -> AppResult<Option<String>> {
    let conn = get().lock().unwrap();
    let result: Option<Option<String>> = conn
        .query_row(
            "SELECT password_enc FROM connections WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;

    match result {
        None => Err(crate::AppError::Other(format!("Connection {} not found", id))),
        Some(None) => Ok(None),
        Some(Some(enc)) => Ok(Some(crate::crypto::decrypt(&enc)?)),
    }
}

/// 通过 ID 获取连接配置（含解密密码）
pub fn get_connection_config(id: i64) -> AppResult<crate::datasource::ConnectionConfig> {
    let conn = get().lock().unwrap();
    let row = conn.query_row(
        "SELECT driver, host, port, database_name, username, password_enc, extra_params
         FROM connections WHERE id = ?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
        )),
    ).optional()?
    .ok_or_else(|| crate::AppError::Other(format!("Connection {} not found", id)))?;

    let password = match row.5 {
        Some(enc) => crate::crypto::decrypt(&enc)?,
        None => String::new(),
    };

    Ok(crate::datasource::ConnectionConfig {
        driver: row.0,
        host: row.1.unwrap_or_default(),
        port: row.2.unwrap_or(3306) as u16,
        database: row.3.unwrap_or_default(),
        username: row.4.unwrap_or_default(),
        password,
        extra_params: row.6,
    })
}
```

**Step 2: 在 db/mod.rs 添加 rusqlite::OptionalExtension 导入**

在文件顶部的 use 语句中添加：

```rust
use rusqlite::OptionalExtension;
```

**Step 3: 实现 commands.rs 中的 create_connection 和 delete_connection**

```rust
#[tauri::command]
pub async fn create_connection(req: CreateConnectionRequest) -> AppResult<Connection> {
    crate::db::create_connection(&req)
}

#[tauri::command]
pub async fn delete_connection(id: i64) -> AppResult<()> {
    crate::db::delete_connection(id)
}
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无编译错误

**Step 5: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/commands.rs
git commit -m "feat(db): implement connection CRUD with AES-256-GCM password encryption"
```

---

## Task 3：execute_query 完整实现

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db/mod.rs` (添加 save_query_history)

**Step 1: 在 db/mod.rs 添加 save_query_history**

```rust
/// 保存查询历史
pub fn save_query_history(
    connection_id: i64,
    sql: &str,
    duration_ms: i64,
    row_count: Option<i64>,
    error_msg: Option<&str>,
) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO query_history (connection_id, sql, executed_at, duration_ms, row_count, error_msg)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![connection_id, sql, now, duration_ms, row_count, error_msg],
    )?;
    Ok(())
}

/// 查询历史列表（最近 500 条）
pub fn list_query_history(connection_id: i64) -> AppResult<Vec<models::QueryHistory>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, sql, executed_at, duration_ms, row_count, error_msg
         FROM query_history
         WHERE connection_id = ?1
         ORDER BY executed_at DESC
         LIMIT 500"
    )?;
    let rows = stmt.query_map([connection_id], |row| {
        Ok(models::QueryHistory {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            sql: row.get(2)?,
            executed_at: row.get(3)?,
            duration_ms: row.get(4)?,
            row_count: row.get(5)?,
            error_msg: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows { results.push(row?); }
    Ok(results)
}
```

**Step 2: 实现 execute_query 命令**

```rust
#[tauri::command]
pub async fn execute_query(connection_id: i64, sql: String) -> AppResult<QueryResult> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let result = ds.execute(&sql).await;

    // 无论成功失败，都记录历史
    match &result {
        Ok(qr) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                qr.duration_ms as i64,
                Some(qr.row_count as i64),
                None,
            );
        }
        Err(e) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                0,
                None,
                Some(&e.to_string()),
            );
        }
    }

    result
}
```

**Step 3: 实现 get_query_history 命令**

```rust
#[tauri::command]
pub async fn get_query_history(connection_id: i64) -> AppResult<Vec<QueryHistory>> {
    crate::db::list_query_history(connection_id)
}
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无编译错误

**Step 5: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/commands.rs
git commit -m "feat(query): implement execute_query with auto history recording"
```

---

## Task 4：get_tables + get_schema 完整实现

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Step 1: 实现两个命令**

```rust
#[tauri::command]
pub async fn get_tables(connection_id: i64) -> AppResult<Vec<TableMeta>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_tables().await
}

#[tauri::command]
pub async fn get_schema(connection_id: i64) -> AppResult<SchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_schema().await
}
```

**Step 2: 编译检查**

```bash
cd src-tauri && cargo check
```

**Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(schema): implement get_tables and get_schema commands"
```

---

## Task 5：LLM 设置命令（API Key 持久化）

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (添加 app_settings CRUD)
- Modify: `src-tauri/src/commands.rs` (添加 get/set LLM settings 命令)
- Modify: `src-tauri/src/lib.rs` (注册新命令)

**Step 1: 在 db/mod.rs 添加 app_settings 操作**

```rust
/// 读取配置项
pub fn get_setting(key: &str) -> AppResult<Option<String>> {
    let conn = get().lock().unwrap();
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// 写入配置项（upsert）
pub fn set_setting(key: &str, value: &str) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    Ok(())
}
```

**Step 2: 定义 LLM 设置结构体并添加命令**

在 `src-tauri/src/commands.rs` 中添加：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[tauri::command]
pub async fn get_llm_settings() -> AppResult<LlmSettings> {
    Ok(LlmSettings {
        api_key: crate::db::get_setting("llm.api_key")?.unwrap_or_default(),
        base_url: crate::db::get_setting("llm.base_url")?
            .unwrap_or_else(|| "https://api.openai.com".to_string()),
        model: crate::db::get_setting("llm.model")?
            .unwrap_or_else(|| "gpt-4o-mini".to_string()),
    })
}

#[tauri::command]
pub async fn set_llm_settings(settings: LlmSettings) -> AppResult<()> {
    // API Key 加密存储
    let enc_key = crate::crypto::encrypt(&settings.api_key)?;
    crate::db::set_setting("llm.api_key", &enc_key)?;
    crate::db::set_setting("llm.base_url", &settings.base_url)?;
    crate::db::set_setting("llm.model", &settings.model)?;
    Ok(())
}
```

**Step 3: 在 lib.rs 的 generate_handler![] 中注册**

找到 `generate_handler![` 数组，添加：
```rust
commands::get_llm_settings,
commands::set_llm_settings,
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check
```

**Step 5: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(llm): add LLM settings persistence (API key encrypted)"
```

---

## Task 6：AI 命令完整实现（generate_sql + explain_sql + ai_chat）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/llm/mod.rs` (或 client.rs，添加 explain_sql)
- Modify: `src-tauri/src/lib.rs` (注册 ai_explain_sql)

**Step 1: 在 llm/client.rs 中添加 explain_sql 方法**

在 `LlmClient` impl 块末尾添加：

```rust
/// SQL 解释
pub async fn explain_sql(
    &self,
    sql: &str,
    sql_dialect: &str,
) -> AppResult<String> {
    let system_prompt = include_str!("../../../prompts/sql_explain.txt")
        .replace("{{DIALECT}}", sql_dialect);

    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: sql.to_string() },
    ];
    self.chat(messages).await
}
```

**Step 2: 在 commands.rs 添加构建 LlmClient 的辅助函数**

```rust
fn build_llm_client() -> AppResult<crate::llm::client::LlmClient> {
    let api_key_enc = crate::db::get_setting("llm.api_key")?
        .ok_or_else(|| AppError::Llm("LLM API Key not configured. Please set it in Settings.".into()))?;
    let api_key = crate::crypto::decrypt(&api_key_enc)?;
    let base_url = crate::db::get_setting("llm.base_url")?;
    let model = crate::db::get_setting("llm.model")?;
    Ok(crate::llm::client::LlmClient::new(api_key, base_url, model))
}
```

**Step 3: 实现 ai_generate_sql**

```rust
#[tauri::command]
pub async fn ai_generate_sql(prompt: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    // 构建 schema 上下文字符串
    let schema_context = schema.tables.iter()
        .map(|t| format!("Table: {}", t.name))
        .collect::<Vec<_>>()
        .join("\n");

    client.generate_sql(&prompt, &schema_context, &config.driver).await
}
```

**Step 4: 实现 ai_explain_sql**

```rust
#[tauri::command]
pub async fn ai_explain_sql(sql: String, connection_id: i64) -> AppResult<String> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    client.explain_sql(&sql, &config.driver).await
}
```

**Step 5: 实现 ai_chat**

```rust
#[tauri::command]
pub async fn ai_chat(message: String, context: ChatContext) -> AppResult<String> {
    let client = build_llm_client()?;
    let mut messages = context.history.clone();
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat(messages).await
}
```

**Step 6: 在 lib.rs 注册 ai_explain_sql**

```rust
commands::ai_explain_sql,
```

**Step 7: 编译检查**

```bash
cd src-tauri && cargo check
```

**Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/llm/client.rs src-tauri/src/lib.rs
git commit -m "feat(ai): implement ai_generate_sql, ai_explain_sql, ai_chat commands"
```

---

## Task 7：Oracle 驱动实现

**Files:**
- Modify: `src-tauri/Cargo.toml` (添加 oracle 依赖)
- Modify: `src-tauri/src/datasource/oracle.rs`

**Step 1: 评估 oracle crate 可行性**

运行以下命令检查 oracle crate 是否可用（需要 OCI 库）：

```bash
cd src-tauri && cargo add oracle
```

**注意：** `oracle` crate 依赖 Oracle Instant Client（OCI 动态库）。如果目标机器没有安装 Oracle Client，此方案不可行。

**替代方案（推荐用于 MVP）：** 使用 JDBC over ODBC 桥接，或改用 `sibyl` crate。

**Step 2: 实现 Oracle 驱动（以 oracle crate 为例）**

```rust
// src-tauri/src/datasource/oracle.rs
use crate::datasource::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::AppResult;
use async_trait::async_trait;

pub struct OracleDataSource {
    connection_string: String,
    username: String,
    password: String,
}

impl OracleDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> {
        Ok(Self {
            connection_string: format!("//{}:{}/{}", config.host, config.port, config.database),
            username: config.username.clone(),
            password: config.password.clone(),
        })
    }
}

#[async_trait]
impl DataSource for OracleDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        // oracle::Connection::connect 是同步的，用 spawn_blocking
        let conn_str = self.connection_string.clone();
        let user = self.username.clone();
        let pass = self.password.clone();
        tokio::task::spawn_blocking(move || {
            oracle::Connection::connect(&user, &pass, &conn_str)
                .map(|_| ())
                .map_err(|e| crate::AppError::Datasource(e.to_string()))
        })
        .await
        .map_err(|e| crate::AppError::Datasource(e.to_string()))?
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let conn_str = self.connection_string.clone();
        let user = self.username.clone();
        let pass = self.password.clone();
        let sql = sql.to_string();
        let start = std::time::Instant::now();

        tokio::task::spawn_blocking(move || {
            let conn = oracle::Connection::connect(&user, &pass, &conn_str)
                .map_err(|e| crate::AppError::Datasource(e.to_string()))?;
            let mut stmt = conn.statement(&sql).build()
                .map_err(|e| crate::AppError::Datasource(e.to_string()))?;
            let rows = stmt.query(&[])
                .map_err(|e| crate::AppError::Datasource(e.to_string()))?;

            let column_info = rows.column_info();
            let columns: Vec<String> = column_info.iter().map(|c| c.name().to_string()).collect();
            let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();

            for row_result in rows {
                let row = row_result.map_err(|e| crate::AppError::Datasource(e.to_string()))?;
                let values: Vec<serde_json::Value> = (0..columns.len())
                    .map(|i| {
                        let val: Option<String> = row.get(i).ok().flatten();
                        match val {
                            Some(s) => serde_json::Value::String(s),
                            None => serde_json::Value::Null,
                        }
                    })
                    .collect();
                result_rows.push(values);
            }

            let duration_ms = start.elapsed().as_millis() as u64;
            let row_count = result_rows.len();
            Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
        })
        .await
        .map_err(|e| crate::AppError::Datasource(e.to_string()))?
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let result = self.execute(
            "SELECT owner, table_name, 'TABLE' as table_type FROM all_tables \
             WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY table_name"
        ).await?;

        Ok(result.rows.into_iter().map(|row| TableMeta {
            schema: row.get(0).and_then(|v| v.as_str().map(String::from)),
            name: row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            table_type: "TABLE".to_string(),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }
}
```

**Step 3: 在 Cargo.toml 添加 oracle 依赖（条件编译）**

```toml
[target.'cfg(target_os = "windows")'.dependencies]
oracle = { version = "0.6", optional = true }

[features]
oracle-driver = ["oracle"]
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check
```

**Step 5: Commit**

```bash
git add src-tauri/src/datasource/oracle.rs src-tauri/Cargo.toml
git commit -m "feat(datasource): implement Oracle driver (requires OCI client)"
```

---

## Task 8：SQL Server 驱动实现

**Files:**
- Modify: `src-tauri/Cargo.toml` (添加 tiberius + tokio-util 依赖)
- Modify: `src-tauri/src/datasource/sqlserver.rs`

**Step 1: 在 Cargo.toml 添加 tiberius 依赖**

```toml
tiberius = { version = "0.12", features = ["tds73", "winauth"] }
tokio-util = { version = "0.7", features = ["compat"] }
```

**Step 2: 实现 SQL Server 驱动**

```rust
// src-tauri/src/datasource/sqlserver.rs
use crate::datasource::{ConnectionConfig, DataSource, QueryResult, SchemaInfo, TableMeta};
use crate::AppResult;
use async_trait::async_trait;
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

pub struct SqlServerDataSource {
    config: tiberius::Config,
}

impl SqlServerDataSource {
    pub async fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let mut config = Config::new();
        config.host(&cfg.host);
        config.port(cfg.port);
        config.database(&cfg.database);
        config.authentication(AuthMethod::sql_server(&cfg.username, &cfg.password));
        config.trust_cert(); // MVP 阶段跳过证书验证
        Ok(Self { config })
    }

    async fn connect(&self) -> AppResult<Client<tokio_util::compat::Compat<TcpStream>>> {
        let tcp = TcpStream::connect(self.config.get_addr())
            .await
            .map_err(|e| crate::AppError::Datasource(e.to_string()))?;
        tcp.set_nodelay(true)
            .map_err(|e| crate::AppError::Datasource(e.to_string()))?;
        Client::connect(self.config.clone(), tcp.compat_write())
            .await
            .map_err(|e| crate::AppError::Datasource(e.to_string()))
    }
}

#[async_trait]
impl DataSource for SqlServerDataSource {
    async fn test_connection(&self) -> AppResult<()> {
        self.connect().await?;
        Ok(())
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let mut client = self.connect().await?;
        let start = std::time::Instant::now();

        let stream = client.query(sql, &[])
            .await
            .map_err(|e| crate::AppError::Datasource(e.to_string()))?;

        let rows = stream.into_results()
            .await
            .map_err(|e| crate::AppError::Datasource(e.to_string()))?;

        let duration_ms = start.elapsed().as_millis() as u64;

        if rows.is_empty() {
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0, duration_ms });
        }

        let first_set = &rows[0];
        let columns: Vec<String> = if let Some(first_row) = first_set.first() {
            first_row.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let result_rows: Vec<Vec<serde_json::Value>> = first_set.iter().map(|row| {
            (0..columns.len()).map(|i| {
                let val: Option<&str> = row.try_get(i).ok().flatten();
                match val {
                    Some(s) => serde_json::Value::String(s.to_string()),
                    None => serde_json::Value::Null,
                }
            }).collect()
        }).collect();

        let row_count = result_rows.len();
        Ok(QueryResult { columns, rows: result_rows, row_count, duration_ms })
    }

    async fn get_tables(&self) -> AppResult<Vec<TableMeta>> {
        let result = self.execute(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME"
        ).await?;

        Ok(result.rows.into_iter().map(|row| TableMeta {
            schema: row.get(0).and_then(|v| v.as_str().map(String::from)),
            name: row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            table_type: row.get(2).and_then(|v| v.as_str()).unwrap_or("TABLE").to_string(),
        }).collect())
    }

    async fn get_schema(&self) -> AppResult<SchemaInfo> {
        let tables = self.get_tables().await?;
        Ok(SchemaInfo { tables })
    }
}
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add src-tauri/src/datasource/sqlserver.rs src-tauri/Cargo.toml
git commit -m "feat(datasource): implement SQL Server driver using tiberius"
```

---

## Task 9：前端 Zustand Stores

**Files:**
- Create: `src/store/connectionStore.ts`
- Create: `src/store/queryStore.ts`
- Create: `src/store/index.ts`

**Step 1: 定义类型（与 Rust 命令返回值对应）**

创建 `src/types/index.ts`：

```typescript
export interface Connection {
  id: number;
  name: string;
  group_id: number | null;
  driver: string;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  extra_params: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionRequest {
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database_name?: string;
  username?: string;
  password?: string;
  extra_params?: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
}

export interface TableMeta {
  schema: string | null;
  name: string;
  table_type: string;
}

export interface QueryHistory {
  id: number;
  connection_id: number | null;
  sql: string;
  executed_at: string;
  duration_ms: number | null;
  row_count: number | null;
  error_msg: string | null;
}

export interface LlmSettings {
  api_key: string;
  base_url: string;
  model: string;
}

export type TabType = 'query' | 'table' | 'er_diagram';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
}
```

**Step 2: 创建 connectionStore**

```typescript
// src/store/connectionStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Connection, CreateConnectionRequest, TableMeta } from '../types';

interface ConnectionState {
  connections: Connection[];
  activeConnectionId: number | null;
  tables: TableMeta[];
  isLoading: boolean;
  error: string | null;

  loadConnections: () => Promise<void>;
  createConnection: (req: CreateConnectionRequest) => Promise<Connection>;
  deleteConnection: (id: number) => Promise<void>;
  testConnection: (req: CreateConnectionRequest) => Promise<boolean>;
  setActiveConnection: (id: number | null) => void;
  loadTables: (connectionId: number) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  tables: [],
  isLoading: false,
  error: null,

  loadConnections: async () => {
    set({ isLoading: true, error: null });
    try {
      const connections = await invoke<Connection[]>('list_connections');
      set({ connections, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  createConnection: async (req) => {
    const conn = await invoke<Connection>('create_connection', { req });
    set((s) => ({ connections: [...s.connections, conn] }));
    return conn;
  },

  deleteConnection: async (id) => {
    await invoke('delete_connection', { id });
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
    }));
  },

  testConnection: async (req) => {
    return await invoke<boolean>('test_connection', {
      config: {
        driver: req.driver,
        host: req.host ?? '',
        port: req.port ?? 3306,
        database: req.database_name ?? '',
        username: req.username ?? '',
        password: req.password ?? '',
        extra_params: req.extra_params,
      },
    });
  },

  setActiveConnection: (id) => set({ activeConnectionId: id }),

  loadTables: async (connectionId) => {
    try {
      const tables = await invoke<TableMeta[]>('get_tables', { connectionId });
      set({ tables });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
```

**Step 3: 创建 queryStore**

```typescript
// src/store/queryStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, QueryHistory, Tab } from '../types';

interface QueryState {
  tabs: Tab[];
  activeTabId: string;
  sqlContent: Record<string, string>;  // tabId → sql
  results: Record<string, QueryResult | null>;
  isExecuting: boolean;
  queryHistory: QueryHistory[];
  error: string | null;

  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setSql: (tabId: string, sql: string) => void;

  executeQuery: (connectionId: number, tabId: string) => Promise<void>;
  loadHistory: (connectionId: number) => Promise<void>;
}

const DEFAULT_TAB: Tab = { id: 'query-1', type: 'query', title: 'Query 1' };

export const useQueryStore = create<QueryState>((set, get) => ({
  tabs: [DEFAULT_TAB],
  activeTabId: DEFAULT_TAB.id,
  sqlContent: { [DEFAULT_TAB.id]: '' },
  results: {},
  isExecuting: false,
  queryHistory: [],
  error: null,

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      sqlContent: { ...s.sqlContent, [tab.id]: '' },
    })),

  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId: s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? '') : s.activeTabId,
      };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setSql: (tabId, sql) =>
    set((s) => ({ sqlContent: { ...s.sqlContent, [tabId]: sql } })),

  executeQuery: async (connectionId, tabId) => {
    const sql = get().sqlContent[tabId] ?? '';
    if (!sql.trim()) return;

    set({ isExecuting: true, error: null });
    try {
      const result = await invoke<QueryResult>('execute_query', { connectionId, sql });
      set((s) => ({ results: { ...s.results, [tabId]: result }, isExecuting: false }));
    } catch (e) {
      set({ error: String(e), isExecuting: false });
    }
  },

  loadHistory: async (connectionId) => {
    try {
      const queryHistory = await invoke<QueryHistory[]>('get_query_history', { connectionId });
      set({ queryHistory });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
```

**Step 4: 创建 store/index.ts 统一导出**

```typescript
// src/store/index.ts
export { useConnectionStore } from './connectionStore';
export { useQueryStore } from './queryStore';
```

**Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

**Step 6: Commit**

```bash
git add src/types/index.ts src/store/
git commit -m "feat(store): add Zustand stores for connections and queries"
```

---

## Task 10：连接管理 UI

**Files:**
- Create: `src/components/ConnectionModal/index.tsx`
- Modify: `src/components/Explorer/index.tsx`

**Step 1: 创建连接表单 Modal**

```tsx
// src/components/ConnectionModal/index.tsx
import React, { useState } from 'react';
import { useConnectionStore } from '../../store';
import type { CreateConnectionRequest } from '../../types';

const DRIVERS = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'oracle', label: 'Oracle', defaultPort: 1521 },
  { value: 'sqlserver', label: 'SQL Server', defaultPort: 1433 },
];

interface Props {
  onClose: () => void;
}

export function ConnectionModal({ onClose }: Props) {
  const { createConnection, testConnection } = useConnectionStore();
  const [form, setForm] = useState<CreateConnectionRequest>({
    name: '',
    driver: 'mysql',
    host: 'localhost',
    port: 3306,
    database_name: '',
    username: '',
    password: '',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleDriverChange = (driver: string) => {
    const d = DRIVERS.find((x) => x.value === driver);
    setForm((f) => ({ ...f, driver, port: d?.defaultPort ?? f.port }));
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await testConnection(form);
      setTestResult('✓ 连接成功');
    } catch (e) {
      setTestResult(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await createConnection(form);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full bg-[#2a2a2a] border border-[#3a3a3a] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#0078d4]";
  const labelClass = "block text-xs text-gray-400 mb-1";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3a3a3a] rounded-lg w-[480px] p-6">
        <h2 className="text-white font-semibold mb-4">新建连接</h2>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>连接名称 *</label>
            <input className={inputClass} value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="我的 MySQL 数据库" />
          </div>

          <div>
            <label className={labelClass}>数据库类型</label>
            <select className={inputClass} value={form.driver}
              onChange={(e) => handleDriverChange(e.target.value)}>
              {DRIVERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>主机</label>
              <input className={inputClass} value={form.host ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>端口</label>
              <input className={inputClass} type="number" value={form.port ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))} />
            </div>
          </div>

          <div>
            <label className={labelClass}>数据库名</label>
            <input className={inputClass} value={form.database_name ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, database_name: e.target.value }))} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>用户名</label>
              <input className={inputClass} value={form.username ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>密码</label>
              <input className={inputClass} type="password" value={form.password ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
          </div>
        </div>

        {testResult && (
          <p className={`mt-3 text-xs ${testResult.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
            {testResult}
          </p>
        )}

        <div className="flex justify-between mt-5">
          <button onClick={handleTest} disabled={testing}
            className="px-3 py-1.5 text-sm bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded disabled:opacity-50">
            {testing ? '测试中...' : '测试连接'}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-sm bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded">
              取消
            </button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()}
              className="px-3 py-1.5 text-sm bg-[#0078d4] hover:bg-[#006bc2] text-white rounded disabled:opacity-50">
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: 更新 Explorer 组件接入真实连接数据**

修改 `src/components/Explorer/index.tsx`，在顶部添加 store 接入：

```tsx
import { useEffect, useState } from 'react';
import { useConnectionStore } from '../../store';
import { ConnectionModal } from '../ConnectionModal';

// 在组件内：
const { connections, activeConnectionId, tables, loadConnections, setActiveConnection, loadTables, deleteConnection } = useConnectionStore();

useEffect(() => {
  loadConnections();
}, []);

const handleConnectionClick = (id: number) => {
  setActiveConnection(id);
  loadTables(id);
};
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/components/ConnectionModal/ src/components/Explorer/index.tsx
git commit -m "feat(ui): connection management modal + Explorer wired to real data"
```

---

## Task 11：SQL 编辑器执行联调

**Files:**
- Modify: `src/components/MainContent/index.tsx`

**Step 1: 接入 queryStore**

在 MainContent 组件中添加：

```tsx
import { useQueryStore, useConnectionStore } from '../../store';

const { sqlContent, setSql, executeQuery, isExecuting, results, activeTabId } = useQueryStore();
const { activeConnectionId } = useConnectionStore();

const handleExecute = () => {
  if (!activeConnectionId) {
    // 提示用户先选择连接
    return;
  }
  executeQuery(activeConnectionId, activeTabId);
};

// 编辑器绑定
<Editor
  value={sqlContent[activeTabId] ?? ''}
  onValueChange={(code) => setSql(activeTabId, code)}
  // ...
/>

// 执行按钮
<button onClick={handleExecute} disabled={isExecuting || !activeConnectionId}>
  {isExecuting ? '执行中...' : '▶ 执行 (F5)'}
</button>
```

**Step 2: F5 快捷键支持**

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'F5') {
      e.preventDefault();
      handleExecute();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [activeConnectionId, activeTabId]);
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(ui): wire SQL editor execute to Rust execute_query command"
```

---

## Task 12：查询结果展示联调

**Files:**
- Modify: `src/components/MainContent/TableDataView.tsx`

**Step 1: 接入真实查询结果**

```tsx
import { useQueryStore } from '../../store';

const { results, activeTabId, isExecuting } = useQueryStore();
const result = results[activeTabId];

if (isExecuting) return <div className="p-4 text-gray-400 text-sm">执行中...</div>;
if (!result) return <div className="p-4 text-gray-500 text-sm">执行 SQL 后结果将显示在这里</div>;
if (result.columns.length === 0) return <div className="p-4 text-green-400 text-sm">✓ 执行成功，{result.row_count} 行受影响（{result.duration_ms}ms）</div>;

// 渲染表格
return (
  <div className="overflow-auto h-full">
    <div className="text-xs text-gray-500 px-3 py-1 border-b border-[#2a2a2a]">
      {result.row_count} 行 · {result.duration_ms}ms
    </div>
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="bg-[#1a1a1a] sticky top-0">
          {result.columns.map((col) => (
            <th key={col} className="px-3 py-2 text-left text-gray-400 border-r border-b border-[#2a2a2a] font-medium">
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, ri) => (
          <tr key={ri} className="hover:bg-[#2a2a2a] border-b border-[#1e1e1e]">
            {row.map((cell, ci) => (
              <td key={ci} className="px-3 py-1.5 text-gray-300 border-r border-[#2a2a2a] max-w-[300px] truncate">
                {cell === null ? <span className="text-gray-600">NULL</span> : String(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/MainContent/TableDataView.tsx
git commit -m "feat(ui): wire query results table to real QueryResult data"
```

---

## Task 13：查询历史 UI

**Files:**
- Create: `src/components/QueryHistory/index.tsx`
- Modify: `src/components/MainContent/index.tsx` (添加历史面板 Tab)

**Step 1: 创建查询历史组件**

```tsx
// src/components/QueryHistory/index.tsx
import React, { useEffect } from 'react';
import { useQueryStore, useConnectionStore } from '../../store';

export function QueryHistory() {
  const { queryHistory, loadHistory, setSql, activeTabId } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();

  useEffect(() => {
    if (activeConnectionId) loadHistory(activeConnectionId);
  }, [activeConnectionId]);

  if (!activeConnectionId) {
    return <div className="p-4 text-gray-500 text-sm">请先选择一个连接</div>;
  }

  return (
    <div className="h-full overflow-auto">
      {queryHistory.length === 0 ? (
        <div className="p-4 text-gray-500 text-sm">暂无查询历史</div>
      ) : (
        queryHistory.map((h) => (
          <div key={h.id}
            className="px-3 py-2 border-b border-[#2a2a2a] hover:bg-[#2a2a2a] cursor-pointer group"
            onClick={() => setSql(activeTabId, h.sql)}>
            <div className="font-mono text-xs text-gray-300 truncate">{h.sql}</div>
            <div className="flex gap-2 mt-1 text-xs text-gray-600">
              <span>{h.executed_at.slice(0, 19).replace('T', ' ')}</span>
              {h.duration_ms && <span>{h.duration_ms}ms</span>}
              {h.row_count !== null && <span>{h.row_count} 行</span>}
              {h.error_msg && <span className="text-red-500 truncate">{h.error_msg}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/QueryHistory/
git commit -m "feat(ui): add query history panel"
```

---

## Task 14：AI 生成 SQL UI 联调

**Files:**
- Create: `src/store/aiStore.ts`
- Modify: `src/components/Assistant/index.tsx`

**Step 1: 创建 aiStore**

```typescript
// src/store/aiStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { LlmSettings } from '../types';

interface AiState {
  isGenerating: boolean;
  isExplaining: boolean;
  settings: LlmSettings | null;
  error: string | null;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: LlmSettings) => Promise<void>;
  generateSql: (prompt: string, connectionId: number) => Promise<string>;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
}

export const useAiStore = create<AiState>((set) => ({
  isGenerating: false,
  isExplaining: false,
  settings: null,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await invoke<LlmSettings>('get_llm_settings');
      set({ settings });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveSettings: async (settings) => {
    await invoke('set_llm_settings', { settings });
    set({ settings });
  },

  generateSql: async (prompt, connectionId) => {
    set({ isGenerating: true, error: null });
    try {
      const sql = await invoke<string>('ai_generate_sql', { prompt, connectionId });
      return sql;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isGenerating: false });
    }
  },

  explainSql: async (sql, connectionId) => {
    set({ isExplaining: true, error: null });
    try {
      const explanation = await invoke<string>('ai_explain_sql', { sql, connectionId });
      return explanation;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isExplaining: false });
    }
  },
}));
```

**Step 2: 更新 store/index.ts**

```typescript
export { useAiStore } from './aiStore';
```

**Step 3: 在 Assistant 组件接入真实 AI 调用**

在 `src/components/Assistant/index.tsx` 中：

```tsx
import { useAiStore, useConnectionStore, useQueryStore } from '../../store';

const { generateSql, isGenerating, error } = useAiStore();
const { activeConnectionId } = useConnectionStore();
const { setSql, activeTabId } = useQueryStore();

const handleGenerate = async (prompt: string) => {
  if (!activeConnectionId) return;
  try {
    const sql = await generateSql(prompt, activeConnectionId);
    setSql(activeTabId, sql);
  } catch {}
};
```

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/store/aiStore.ts src/store/index.ts src/components/Assistant/index.tsx
git commit -m "feat(ui): wire AI generate SQL to Rust ai_generate_sql command"
```

---

## Task 15：AI SQL 解释 UI

**Files:**
- Modify: `src/components/MainContent/index.tsx` (添加"解释 SQL"按钮)

**Step 1: 在编辑器工具栏添加解释按钮**

```tsx
import { useAiStore, useConnectionStore, useQueryStore } from '../../store';

const { explainSql, isExplaining } = useAiStore();
const { activeConnectionId } = useConnectionStore();
const { sqlContent, activeTabId } = useQueryStore();
const [explanation, setExplanation] = useState<string | null>(null);

const handleExplain = async () => {
  const sql = sqlContent[activeTabId] ?? '';
  if (!sql.trim() || !activeConnectionId) return;
  try {
    const result = await explainSql(sql, activeConnectionId);
    setExplanation(result);
  } catch {}
};

// 在工具栏按钮组添加：
<button onClick={handleExplain} disabled={isExplaining || !activeConnectionId}
  className="px-2 py-1 text-xs bg-[#2a2a2a] hover:bg-[#3a3a3a] text-gray-300 rounded">
  {isExplaining ? '解释中...' : '💡 解释 SQL'}
</button>

// 在结果区下方显示解释：
{explanation && (
  <div className="border-t border-[#2a2a2a] p-4 bg-[#181818]">
    <div className="flex justify-between items-center mb-2">
      <span className="text-xs text-gray-400 font-medium">AI 解释</span>
      <button onClick={() => setExplanation(null)} className="text-xs text-gray-600 hover:text-gray-400">✕</button>
    </div>
    <p className="text-sm text-gray-300 whitespace-pre-wrap">{explanation}</p>
  </div>
)}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(ui): add AI explain SQL button and result panel"
```

---

## Task 16：LLM 设置 UI

**Files:**
- Create: `src/components/Settings/LlmSettings.tsx`
- Modify: `src/components/ActivityBar/index.tsx` (添加设置入口)

**Step 1: 创建 LLM 设置面板**

```tsx
// src/components/Settings/LlmSettings.tsx
import React, { useEffect, useState } from 'react';
import { useAiStore } from '../../store';
import type { LlmSettings } from '../../types';

export function LlmSettingsPanel() {
  const { settings, loadSettings, saveSettings } = useAiStore();
  const [form, setForm] = useState<LlmSettings>({
    api_key: '',
    base_url: 'https://api.openai.com',
    model: 'gpt-4o-mini',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full bg-[#2a2a2a] border border-[#3a3a3a] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#0078d4]";
  const labelClass = "block text-xs text-gray-400 mb-1";

  return (
    <div className="p-4 space-y-4 max-w-lg">
      <h3 className="text-white font-semibold text-sm">AI 模型配置</h3>

      <div>
        <label className={labelClass}>API Key</label>
        <input className={inputClass} type="password"
          value={form.api_key}
          onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
          placeholder="sk-..." />
      </div>

      <div>
        <label className={labelClass}>Base URL（OpenAI 兼容接口）</label>
        <input className={inputClass}
          value={form.base_url}
          onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
          placeholder="https://api.openai.com" />
      </div>

      <div>
        <label className={labelClass}>模型</label>
        <input className={inputClass}
          value={form.model}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          placeholder="gpt-4o-mini" />
      </div>

      <button onClick={handleSave} disabled={saving}
        className="px-4 py-1.5 text-sm bg-[#0078d4] hover:bg-[#006bc2] text-white rounded disabled:opacity-50">
        {saved ? '✓ 已保存' : saving ? '保存中...' : '保存'}
      </button>
    </div>
  );
}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 3: 完整构建验证**

```bash
npm run tauri:dev
```

Expected: 应用启动无报错，各功能可用

**Step 4: Commit**

```bash
git add src/components/Settings/
git commit -m "feat(ui): add LLM settings panel for API key, base URL, model"
```

---

## 最终验收清单

运行 `npm run tauri:dev` 后逐项手动验证：

- [ ] 新建数据库连接（MySQL/PostgreSQL），测试连接成功
- [ ] 连接列表显示正确，删除连接有效
- [ ] 点击连接 → 左侧树展开显示表列表
- [ ] 输入 SQL → F5 执行 → 结果表格正确展示
- [ ] DDL/DML 执行返回影响行数
- [ ] 查询历史面板显示最近执行记录，点击可回填 SQL
- [ ] AI 生成 SQL（需要配置 API Key）
- [ ] AI SQL 解释功能正常
- [ ] LLM 设置可保存 API Key（重启后仍有效）
- [ ] Rust 编译无警告：`cd src-tauri && cargo check`
- [ ] TypeScript 无错误：`npx tsc --noEmit`
