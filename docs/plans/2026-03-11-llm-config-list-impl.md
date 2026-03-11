# LLM 多配置列表 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 AI 模型配置从单条 key-value 改造为支持 CRUD 的多配置列表，带默认标记、持久化连通性测试状态，及 AI 面板内模型选择器。

**Architecture:** 新增 SQLite 表 `llm_configs`，Rust 层增加 7 个 CRUD 命令替换旧 3 个命令，前端 aiStore 重构为列表管理，Settings 页改为卡片网格 UI，AI 面板输入框旁增加模型选择下拉。

**Tech Stack:** Rust + rusqlite + Tauri commands, React + TypeScript + Zustand, Tailwind CSS, lucide-react

---

## Task 1: 新增 SQLite 表 DDL

**Files:**
- Modify: `schema/init.sql`

**Step 1: 在 init.sql 末尾追加新表 DDL**

```sql
CREATE TABLE IF NOT EXISTS llm_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',
  base_url    TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  model       TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  api_type    TEXT NOT NULL DEFAULT 'openai',
  preset      TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  test_status TEXT NOT NULL DEFAULT 'untested',
  test_error  TEXT,
  tested_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 2: 验证 DDL 语法**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过（schema 在 migration 时 include_str! 读取）

**Step 3: Commit**

```bash
git add schema/init.sql
git commit -m "feat(db): add llm_configs table to schema"
```

---

## Task 2: Rust 数据模型与 DB 层

**Files:**
- Modify: `src-tauri/src/db/models.rs`
- Modify: `src-tauri/src/db/mod.rs`

**Step 1: 在 models.rs 添加 LlmConfig 结构体**

在文件末尾追加：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmConfig {
    pub id: i64,
    pub name: String,
    pub api_key: String,   // 解密后的明文，仅在内存中
    pub base_url: String,
    pub model: String,
    pub api_type: String,
    pub preset: Option<String>,
    pub is_default: bool,
    pub test_status: String,
    pub test_error: Option<String>,
    pub tested_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateLlmConfigInput {
    pub name: Option<String>,   // 为空时调用者自动填充
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: String,
    pub preset: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateLlmConfigInput {
    pub name: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_type: Option<String>,
    pub preset: Option<String>,
}
```

**Step 2: 在 mod.rs 添加 DB 层函数**

在文件末尾追加（`set_setting` 函数之后）：

```rust
// ============ LLM 配置 CRUD ============

/// 从数据行映射 LlmConfig（api_key 为加密值，需外部解密）
fn row_to_llm_config(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String)> {
    Ok((
        row.get(0)?,   // id
        row.get(1)?,   // name
        row.get(2)?,   // api_key_enc
        row.get(3)?,   // base_url
        row.get(4)?,   // model
        row.get(5)?,   // api_type
        row.get(6)?,   // preset
        row.get::<_, i64>(7)? != 0, // is_default
        row.get(8)?,   // test_status
        row.get(9)?,   // test_error
        row.get(10)?,  // tested_at
        row.get(11)?,  // created_at
    ))
}

fn decrypt_config(raw: (i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String)) -> AppResult<models::LlmConfig> {
    let api_key = if raw.2.is_empty() {
        String::new()
    } else {
        crate::crypto::decrypt(&raw.2)?
    };
    Ok(models::LlmConfig {
        id: raw.0,
        name: raw.1,
        api_key,
        base_url: raw.3,
        model: raw.4,
        api_type: raw.5,
        preset: raw.6,
        is_default: raw.7,
        test_status: raw.8,
        test_error: raw.9,
        tested_at: raw.10,
        created_at: raw.11,
    })
}

pub fn list_llm_configs() -> AppResult<Vec<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, api_key, base_url, model, api_type, preset, is_default,
                test_status, test_error, tested_at, created_at
         FROM llm_configs ORDER BY is_default DESC, created_at ASC"
    )?;
    let rows = stmt.query_map([], |row| row_to_llm_config(row))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(decrypt_config(row?)?);
    }
    Ok(results)
}

pub fn create_llm_config(input: &models::CreateLlmConfigInput) -> AppResult<models::LlmConfig> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let api_key_enc = if input.api_key.is_empty() {
        String::new()
    } else {
        crate::crypto::encrypt(&input.api_key)?
    };
    // 若是第一条，自动设为 default
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM llm_configs", [], |r| r.get(0))?;
    let is_default = if count == 0 { 1i64 } else { 0i64 };

    let name = input.name.clone().unwrap_or_else(|| {
        format!("{} · {}", input.model, input.api_type)
    });

    conn.execute(
        "INSERT INTO llm_configs (name, api_key, base_url, model, api_type, preset, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![name, api_key_enc, input.base_url, input.model, input.api_type, input.preset, is_default, now],
    )?;
    let id = conn.last_insert_rowid();
    let raw = conn.query_row(
        "SELECT id, name, api_key, base_url, model, api_type, preset, is_default,
                test_status, test_error, tested_at, created_at
         FROM llm_configs WHERE id = ?1",
        [id],
        |row| row_to_llm_config(row),
    )?;
    decrypt_config(raw)
}

pub fn update_llm_config(id: i64, input: &models::UpdateLlmConfigInput) -> AppResult<models::LlmConfig> {
    let conn = get().lock().unwrap();
    // 读取当前值
    let current = conn.query_row(
        "SELECT id, name, api_key, base_url, model, api_type, preset, is_default,
                test_status, test_error, tested_at, created_at
         FROM llm_configs WHERE id = ?1",
        [id],
        |row| row_to_llm_config(row),
    ).optional()?.ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;

    let new_name = input.name.clone().unwrap_or(current.1.clone());
    let new_api_key_enc = match &input.api_key {
        Some(k) if !k.is_empty() => crate::crypto::encrypt(k)?,
        Some(_) => String::new(),
        None => current.2.clone(),
    };
    let new_base_url = input.base_url.clone().unwrap_or(current.3.clone());
    let new_model = input.model.clone().unwrap_or(current.4.clone());
    let new_api_type = input.api_type.clone().unwrap_or(current.5.clone());
    let new_preset: Option<String> = match &input.preset {
        Some(p) => Some(p.clone()),
        None => current.6.clone(),
    };

    conn.execute(
        "UPDATE llm_configs SET name=?1, api_key=?2, base_url=?3, model=?4, api_type=?5, preset=?6 WHERE id=?7",
        rusqlite::params![new_name, new_api_key_enc, new_base_url, new_model, new_api_type, new_preset, id],
    )?;
    let raw = conn.query_row(
        "SELECT id, name, api_key, base_url, model, api_type, preset, is_default,
                test_status, test_error, tested_at, created_at
         FROM llm_configs WHERE id = ?1",
        [id],
        |row| row_to_llm_config(row),
    )?;
    decrypt_config(raw)
}

pub fn delete_llm_config(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    // 检查是否是 default
    let is_default: i64 = conn.query_row(
        "SELECT is_default FROM llm_configs WHERE id = ?1",
        [id],
        |r| r.get(0),
    ).optional()?.ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;

    conn.execute("DELETE FROM llm_configs WHERE id = ?1", [id])?;

    // 若删除的是 default，将最早创建的另一条设为 default
    if is_default != 0 {
        conn.execute(
            "UPDATE llm_configs SET is_default = 1 WHERE id = (SELECT id FROM llm_configs ORDER BY created_at ASC LIMIT 1)",
            [],
        )?;
    }
    Ok(())
}

pub fn set_default_llm_config(id: i64) -> AppResult<()> {
    let conn = get().lock().unwrap();
    // 验证 id 存在
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM llm_configs WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Err(crate::AppError::Other(format!("LlmConfig {} not found", id)));
    }
    conn.execute("UPDATE llm_configs SET is_default = 0", [])?;
    conn.execute("UPDATE llm_configs SET is_default = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn update_llm_config_test_status(id: i64, status: &str, error: Option<&str>) -> AppResult<()> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE llm_configs SET test_status=?1, test_error=?2, tested_at=?3 WHERE id=?4",
        rusqlite::params![status, error, now, id],
    )?;
    Ok(())
}

pub fn get_default_llm_config() -> AppResult<Option<models::LlmConfig>> {
    let conn = get().lock().unwrap();
    let raw = conn.query_row(
        "SELECT id, name, api_key, base_url, model, api_type, preset, is_default,
                test_status, test_error, tested_at, created_at
         FROM llm_configs WHERE is_default = 1 LIMIT 1",
        [],
        |row| row_to_llm_config(row),
    ).optional()?;
    match raw {
        Some(r) => Ok(Some(decrypt_config(r)?)),
        None => Ok(None),
    }
}

/// 迁移旧 key-value LLM 配置到 llm_configs 表（仅当表为空时执行）
pub fn migrate_legacy_llm_settings() -> AppResult<()> {
    let conn = get().lock().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM llm_configs", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(()); // 已有数据，跳过迁移
    }
    let api_key_enc = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.api_key'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_default();
    let base_url = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.base_url'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let model = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.model'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "gpt-4o-mini".to_string());
    let api_type = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'llm.api_type'",
        [],
        |r| r.get::<_, String>(0),
    ).optional()?.unwrap_or_else(|| "openai".to_string());

    if api_key_enc.is_empty() && base_url == "https://api.openai.com/v1" {
        return Ok(()); // 旧配置也为空，不迁移
    }

    let now = Utc::now().to_rfc3339();
    let name = format!("{} · {}", model, api_type);
    conn.execute(
        "INSERT INTO llm_configs (name, api_key, base_url, model, api_type, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        rusqlite::params![name, api_key_enc, base_url, model, api_type, now],
    )?;
    // 删除旧 key-value
    conn.execute("DELETE FROM app_settings WHERE key LIKE 'llm.%'", [])?;
    log::info!("Migrated legacy LLM settings to llm_configs table");
    Ok(())
}
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过，无错误

**Step 4: Commit**

```bash
git add src-tauri/src/db/models.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add llm_configs CRUD functions"
```

---

## Task 3: Rust Commands 层替换

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 删除旧 LLM 命令，新增新命令**

找到 `commands.rs` 中 `// ============ LLM 设置 ============` 到 `test_llm_connection` 结尾（约第134-196行），全部替换为：

```rust
// ============ LLM 配置管理 ============

use crate::db::models::{LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput};

#[tauri::command]
pub async fn list_llm_configs() -> AppResult<Vec<LlmConfig>> {
    crate::db::list_llm_configs()
}

#[tauri::command]
pub async fn create_llm_config(input: CreateLlmConfigInput) -> AppResult<LlmConfig> {
    crate::db::create_llm_config(&input)
}

#[tauri::command]
pub async fn update_llm_config(id: i64, input: UpdateLlmConfigInput) -> AppResult<LlmConfig> {
    crate::db::update_llm_config(id, &input)
}

#[tauri::command]
pub async fn delete_llm_config(id: i64) -> AppResult<()> {
    crate::db::delete_llm_config(id)
}

#[tauri::command]
pub async fn set_default_llm_config(id: i64) -> AppResult<()> {
    crate::db::set_default_llm_config(id)
}

#[tauri::command]
pub async fn get_default_llm_config() -> AppResult<Option<LlmConfig>> {
    crate::db::get_default_llm_config()
}

#[tauri::command]
pub async fn test_llm_config(id: i64) -> AppResult<()> {
    // 先写 testing 状态
    crate::db::update_llm_config_test_status(id, "testing", None)?;

    // 读取配置
    let configs = crate::db::list_llm_configs()?;
    let config = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;

    let api_type = parse_api_type(&config.api_type);
    let client = crate::llm::client::LlmClient::new(
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    match client.chat(messages).await {
        Ok(_) => {
            crate::db::update_llm_config_test_status(id, "success", None)?;
        }
        Err(e) => {
            let err_msg = e.to_string();
            crate::db::update_llm_config_test_status(id, "fail", Some(&err_msg))?;
            return Err(e);
        }
    }
    Ok(())
}
```

注意：`parse_api_type` 函数已存在于 commands.rs，无需重复定义。

**Step 2: 更新 lib.rs handler 注册**

在 `lib.rs` 中，将 `invoke_handler` 里的三行旧命令：
```rust
commands::get_llm_settings,
commands::set_llm_settings,
commands::test_llm_connection,
```

替换为七行新命令：
```rust
commands::list_llm_configs,
commands::create_llm_config,
commands::update_llm_config,
commands::delete_llm_config,
commands::set_default_llm_config,
commands::get_default_llm_config,
commands::test_llm_config,
```

**Step 3: 在 lib.rs 的 setup 中调用迁移函数**

在 `crate::db::init(&app_data_dir)?;` 下一行添加：
```rust
crate::db::migrate_legacy_llm_settings()?;
```

**Step 4: 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过

**Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): replace LLM settings commands with CRUD list commands"
```

---

## Task 4: AI 功能命令适配（ai_generate_sql 等）

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Step 1: 找到所有读取 LLM 配置的 AI 命令**

搜索 `commands.rs` 中使用 `get_llm_settings` 或构造 `LlmClient` 的地方（ai_generate_sql、ai_explain_sql、ai_optimize_sql、ai_create_table、ai_diagnose_error、ai_chat）。

每个命令开头通常有类似：
```rust
let settings = get_llm_settings().await?;
let client = crate::llm::client::LlmClient::new(settings.api_key, ...);
```

**Step 2: 替换为读取默认配置**

将每处改为：
```rust
let config = crate::db::get_default_llm_config()?
    .ok_or_else(|| crate::AppError::Other("No LLM config found. Please add one in Settings.".into()))?;
let api_type = parse_api_type(&config.api_type);
let client = crate::llm::client::LlmClient::new(
    config.api_key,
    Some(config.base_url),
    Some(config.model),
    Some(api_type),
);
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过，无未使用变量警告

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(commands): AI commands use default llm_config instead of legacy settings"
```

---

## Task 5: TypeScript 类型更新

**Files:**
- Modify: `src/types/index.ts`

**Step 1: 删除旧 LlmSettings，新增 LlmConfig 类型**

找到并删除（约第49-57行）：
```typescript
export type ApiType = 'openai' | 'anthropic';

export interface LlmSettings {
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset: string | null;
}
```

替换为：
```typescript
export type ApiType = 'openai' | 'anthropic';
export type TestStatus = 'untested' | 'testing' | 'success' | 'fail';

export interface LlmConfig {
  id: number;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset: string | null;
  is_default: boolean;
  test_status: TestStatus;
  test_error: string | null;
  tested_at: string | null;
  created_at: string;
}

export interface CreateLlmConfigInput {
  name?: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset?: string | null;
}

export interface UpdateLlmConfigInput {
  name?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  api_type?: ApiType;
  preset?: string | null;
}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 报错（因为 aiStore.ts 还引用 LlmSettings），这是正常的，下一个 Task 修复

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): replace LlmSettings with LlmConfig multi-config types"
```

---

## Task 6: aiStore 重构

**Files:**
- Modify: `src/store/aiStore.ts`

**Step 1: 完整替换 aiStore.ts**

```typescript
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage } from '../types';

interface AiState {
  // 配置列表
  configs: LlmConfig[];
  loadConfigs: () => Promise<void>;
  createConfig: (input: CreateLlmConfigInput) => Promise<void>;
  updateConfig: (id: number, input: UpdateLlmConfigInput) => Promise<void>;
  deleteConfig: (id: number) => Promise<void>;
  setDefaultConfig: (id: number) => Promise<void>;
  testConfig: (id: number) => Promise<void>;

  // AI 面板当前选中的配置（null = 使用 default）
  activeConfigId: number | null;
  setActiveConfigId: (id: number | null) => void;

  // 多轮对话
  chatHistory: ChatMessage[];
  isChatting: boolean;
  sendChat: (message: string, connectionId: number | null) => Promise<string>;
  clearHistory: () => void;

  // AI 功能
  isGenerating: boolean;
  isExplaining: boolean;
  isOptimizing: boolean;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  generateSql: (prompt: string, connectionId: number) => Promise<string>;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
  optimizeSql: (sql: string, connectionId: number) => Promise<string>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}

export const useAiStore = create<AiState>((set, get) => ({
  configs: [],
  activeConfigId: null,
  chatHistory: [],
  isChatting: false,
  isGenerating: false,
  isExplaining: false,
  isOptimizing: false,
  isDiagnosing: false,
  isCreatingTable: false,
  error: null,

  setActiveConfigId: (id) => set({ activeConfigId: id }),

  loadConfigs: async () => {
    const configs = await invoke<LlmConfig[]>('list_llm_configs');
    set({ configs });
  },

  createConfig: async (input) => {
    await invoke('create_llm_config', { input });
    await get().loadConfigs();
  },

  updateConfig: async (id, input) => {
    await invoke('update_llm_config', { id, input });
    await get().loadConfigs();
  },

  deleteConfig: async (id) => {
    await invoke('delete_llm_config', { id });
    set((s) => ({
      configs: s.configs.filter((c) => c.id !== id),
      activeConfigId: s.activeConfigId === id ? null : s.activeConfigId,
    }));
    await get().loadConfigs();
  },

  setDefaultConfig: async (id) => {
    await invoke('set_default_llm_config', { id });
    await get().loadConfigs();
  },

  testConfig: async (id) => {
    // 乐观更新
    set((s) => ({
      configs: s.configs.map((c) =>
        c.id === id ? { ...c, test_status: 'testing' as const } : c
      ),
    }));
    try {
      await invoke('test_llm_config', { id });
    } finally {
      await get().loadConfigs();
    }
  },

  clearHistory: () => set({ chatHistory: [] }),

  sendChat: async (message, connectionId) => {
    set((s) => ({
      isChatting: true,
      chatHistory: [...s.chatHistory, { role: 'user', content: message }],
    }));
    try {
      const reply = await invoke<string>('ai_generate_sql', {
        prompt: message,
        connectionId: connectionId ?? 0,
      });
      set((s) => ({
        chatHistory: [...s.chatHistory, { role: 'assistant', content: reply }],
        isChatting: false,
      }));
      return reply;
    } catch (e) {
      set((s) => ({
        chatHistory: [...s.chatHistory, { role: 'assistant', content: `Error: ${String(e)}` }],
        isChatting: false,
      }));
      throw e;
    }
  },

  generateSql: async (prompt, connectionId) => {
    set({ isGenerating: true, error: null });
    try {
      return await invoke<string>('ai_generate_sql', { prompt, connectionId });
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
      return await invoke<string>('ai_explain_sql', { sql, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isExplaining: false });
    }
  },

  optimizeSql: async (sql, connectionId) => {
    set({ isOptimizing: true, error: null });
    try {
      return await invoke<string>('ai_optimize_sql', { sql, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isOptimizing: false });
    }
  },

  createTable: async (description, connectionId) => {
    set({ isCreatingTable: true, error: null });
    try {
      return await invoke<string>('ai_create_table', { description, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isCreatingTable: false });
    }
  },

  diagnoseError: async (sql, errorMsg, connectionId) => {
    set({ isDiagnosing: true, error: null });
    try {
      return await invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isDiagnosing: false });
    }
  },
}));
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 只有 LlmSettings.tsx 报错（因为它还引用旧 API），其他模块通过

**Step 3: Commit**

```bash
git add src/store/aiStore.ts
git commit -m "refactor(store): replace LlmSettings with LlmConfig list management"
```

---

## Task 7: LlmSettings 页面重构为卡片列表

**Files:**
- Modify: `src/components/Settings/LlmSettings.tsx`

**Step 1: 完整替换 LlmSettings.tsx**

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Loader2, Star, Plus, Pencil, Trash2 } from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type { LlmConfig, CreateLlmConfigInput, ApiType } from '../../types';

// -------- 厂商预设 --------
interface ProviderPreset {
  id: string;
  label: string;
  base_url: string;
  api_type: ApiType;
  default_model: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'alicloud',
    label: '阿里云百炼',
    base_url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    api_type: 'anthropic',
    default_model: 'qwen3.5-plus',
  },
];

// -------- 空表单初始值 --------
const EMPTY_FORM: CreateLlmConfigInput = {
  name: '',
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  api_type: 'openai',
  preset: null,
};

// -------- 连通性状态指示 --------
function TestStatusBadge({ status, error, testedAt }: { status: string; error: string | null; testedAt: string | null }) {
  if (status === 'untested') return <span className="text-xs text-gray-500">○ 未测试</span>;
  if (status === 'testing') return <span className="text-xs text-yellow-400 flex items-center gap-1"><Loader2 size={11} className="animate-spin" />测试中…</span>;
  if (status === 'success') {
    const ago = testedAt ? getRelativeTime(testedAt) : '';
    return <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle size={11} />连通 {ago}</span>;
  }
  return (
    <span className="text-xs text-red-400 flex items-center gap-1" title={error ?? ''}>
      <XCircle size={11} />失败
    </span>
  );
}

function getRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

// -------- 编辑/新建 模态对话框 --------
interface ConfigFormDialogProps {
  initial: CreateLlmConfigInput;
  onSave: (input: CreateLlmConfigInput) => Promise<void>;
  onCancel: () => void;
  title: string;
}

function ConfigFormDialog({ initial, onSave, onCancel, title }: ConfigFormDialogProps) {
  const [form, setForm] = useState<CreateLlmConfigInput>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg?: string } | null>(null);

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const handlePreset = (preset: ProviderPreset | null) => {
    if (!preset) {
      setForm((f) => ({ ...f, preset: null }));
    } else {
      setForm((f) => ({
        ...f,
        preset: preset.id,
        base_url: preset.base_url,
        api_type: preset.api_type,
        model: preset.default_model,
      }));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const tempConfig: CreateLlmConfigInput = { ...form, name: form.name || `${form.model} · ${form.api_type}` };
    try {
      // 临时创建 → 测试 → 删除（或直接复用 invoke test_llm_connection 逻辑）
      // 这里通过 Rust 创建临时配置来测试
      const created = await invoke<LlmConfig>('create_llm_config', { input: tempConfig });
      try {
        await invoke('test_llm_config', { id: created.id });
        setTestResult({ ok: true });
      } catch (e) {
        setTestResult({ ok: false, msg: String(e) });
      } finally {
        await invoke('delete_llm_config', { id: created.id });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-md p-6 space-y-4">
        <h3 className="text-white font-semibold text-sm">{title}</h3>

        {/* 厂商预设 */}
        <div>
          <label className={labelClass}>厂商预设</label>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handlePreset(null)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${form.preset === null ? 'bg-[#009e84] border-[#009e84] text-white' : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'}`}
            >自定义</button>
            {PROVIDER_PRESETS.map((p) => (
              <button key={p.id} onClick={() => handlePreset(p)}
                className={`px-3 py-1 text-xs rounded border transition-colors ${form.preset === p.id ? 'bg-[#009e84] border-[#009e84] text-white' : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'}`}
              >{p.label}</button>
            ))}
          </div>
        </div>

        {/* 名称 */}
        <div>
          <label className={labelClass}>名称（可选，留空自动生成）</label>
          <input className={inputClass} value={form.name ?? ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={`${form.model} · ${form.api_type}`} />
        </div>

        {/* API 协议 */}
        <div>
          <label className={labelClass}>API 协议{form.preset && <span className="ml-2 text-[#5b8ab0]">(预设锁定)</span>}</label>
          <div className="flex gap-4">
            {(['openai', 'anthropic'] as ApiType[]).map((t) => (
              <label key={t} className={`flex items-center gap-1.5 text-sm ${form.preset ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer text-[#c8daea]'}`}>
                <input type="radio" name="api_type" value={t} checked={form.api_type === t}
                  onChange={() => setForm((f) => ({ ...f, api_type: t, preset: null }))}
                  disabled={!!form.preset} className="accent-[#009e84]" />
                {t === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}
              </label>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className={labelClass}>API Key</label>
          <PasswordInput className={inputClass} value={form.api_key} onChange={(v) => setForm((f) => ({ ...f, api_key: v }))} placeholder="sk-..." />
        </div>

        {/* Base URL */}
        <div>
          <label className={labelClass}>Base URL</label>
          <input className={inputClass} value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value, preset: null }))}
            placeholder="https://api.openai.com/v1" />
        </div>

        {/* 模型 */}
        <div>
          <label className={labelClass}>模型</label>
          <input className={inputClass} value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="gpt-4o-mini" />
        </div>

        {/* 测试结果 */}
        {testResult && (
          <p className={`text-xs flex items-center gap-1 ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
            {testResult.ok ? '连通性测试通过' : testResult.msg}
          </p>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-between pt-2">
          <button onClick={handleTest} disabled={testing || !form.api_key}
            className="px-3 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1.5">
            {testing && <Loader2 size={12} className="animate-spin" />}
            {testing ? '测试中…' : '测试连通性'}
          </button>
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded">取消</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------- 主组件 --------
export function LlmSettingsPanel() {
  const { configs, loadConfigs, createConfig, updateConfig, deleteConfig, setDefaultConfig, testConfig } = useAiStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<LlmConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LlmConfig | null>(null);

  useEffect(() => { loadConfigs(); }, []);

  const handleCreate = async (input: CreateLlmConfigInput) => {
    await createConfig(input);
    setShowCreate(false);
  };

  const handleUpdate = async (input: CreateLlmConfigInput) => {
    if (!editTarget) return;
    await updateConfig(editTarget.id, input);
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfig(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  return (
    <div className="w-full max-w-2xl p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-white font-semibold text-sm">AI 模型配置</h3>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded">
          <Plus size={13} />新增配置
        </button>
      </div>

      {/* 卡片网格 */}
      {configs.length === 0 ? (
        <div className="text-center py-16 text-[#7a9bb8]">
          <p className="text-sm">暂无模型配置</p>
          <p className="text-xs mt-1 opacity-60">点击右上角"新增配置"开始添加</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {configs.map((config) => (
            <div key={config.id}
              className={`bg-[#0d1a26] border rounded-lg p-4 flex flex-col gap-2 ${config.is_default ? 'border-[#009e84]' : 'border-[#1e2d42]'}`}>
              {/* 标题行 */}
              <div className="flex items-center gap-1.5">
                {config.is_default && <Star size={13} className="text-[#009e84] fill-[#009e84] flex-shrink-0" />}
                <span className="text-sm text-white font-medium truncate">{config.name}</span>
              </div>
              {/* 配置信息 */}
              <div className="text-xs text-[#7a9bb8] space-y-0.5">
                <div className="truncate">{config.model}</div>
                <div>{config.api_type === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}</div>
              </div>
              {/* 连通性状态 */}
              <TestStatusBadge status={config.test_status} error={config.test_error} testedAt={config.tested_at} />
              {/* 操作按钮 */}
              <div className="flex items-center gap-1.5 mt-1 pt-2 border-t border-[#1e2d42] flex-wrap">
                {!config.is_default && (
                  <button onClick={() => setDefaultConfig(config.id)}
                    className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded">
                    设为默认
                  </button>
                )}
                <button onClick={() => testConfig(config.id)}
                  disabled={config.test_status === 'testing'}
                  className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1">
                  {config.test_status === 'testing' && <Loader2 size={10} className="animate-spin" />}
                  测试
                </button>
                <button onClick={() => setEditTarget(config)}
                  className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1">
                  <Pencil size={11} />编辑
                </button>
                <button onClick={() => setDeleteConfirm(config)}
                  className="text-xs px-2 py-1 border border-red-900 text-red-400 hover:bg-red-950 rounded flex items-center gap-1">
                  <Trash2 size={11} />删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建对话框 */}
      {showCreate && (
        <ConfigFormDialog title="新增 AI 模型配置" initial={EMPTY_FORM} onSave={handleCreate} onCancel={() => setShowCreate(false)} />
      )}

      {/* 编辑对话框 */}
      {editTarget && (
        <ConfigFormDialog
          title="编辑 AI 模型配置"
          initial={{ name: editTarget.name, api_key: editTarget.api_key, base_url: editTarget.base_url, model: editTarget.model, api_type: editTarget.api_type, preset: editTarget.preset }}
          onSave={handleUpdate}
          onCancel={() => setEditTarget(null)}
        />
      )}

      {/* 删除确认 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-sm p-6 space-y-4">
            <h3 className="text-white font-semibold text-sm">确认删除</h3>
            <p className="text-xs text-[#c8daea]">
              确定要删除「{deleteConfirm.name}」吗？
              {deleteConfirm.is_default && <span className="text-yellow-400 block mt-1">这是默认配置，删除后将自动选择最早创建的配置作为默认。</span>}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded">取消</button>
              <button onClick={handleDelete} className="px-4 py-1.5 text-xs bg-red-700 hover:bg-red-800 text-white rounded">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 通过或只剩 Assistant 相关的小错误

**Step 3: Commit**

```bash
git add src/components/Settings/LlmSettings.tsx
git commit -m "feat(ui): redesign LLM settings as CRUD card grid with test status"
```

---

## Task 8: AI 面板模型选择器

**Files:**
- Modify: `src/components/Assistant/index.tsx`

**Step 1: 在 Assistant 组件中引入 configs 和 activeConfigId**

在 `useAiStore` 解构处添加：
```typescript
const { chatHistory, isChatting, sendChat, clearHistory, configs, activeConfigId, setActiveConfigId, loadConfigs } = useAiStore();
```

**Step 2: 在 useEffect 中加载配置**

在现有 `useEffect` 下方添加：
```typescript
useEffect(() => {
  loadConfigs();
}, []);
```

**Step 3: 替换现有模型菜单区域**

找到（约第143-156行）：
```tsx
<div
  className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]"
  onClick={(e) => { e.stopPropagation(); setIsModelMenuOpen(!isModelMenuOpen); }}
>
  <span>{t('assistant.aiGenerateSql')}</span>
  <ChevronDown size={12} className="ml-1" />
</div>

{isModelMenuOpen && (
  <div className="absolute left-0 bottom-full mb-1 w-48 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
    <div className="px-3 py-1.5 hover:bg-[#1e2d42] cursor-pointer text-[#c8daea]" onClick={() => setIsModelMenuOpen(false)}>{t('assistant.generateSql')}</div>
  </div>
)}
```

替换为：
```tsx
{/* AI 生成 SQL 标签 */}
<div className="flex items-center text-xs text-[#7a9bb8] cursor-default bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]">
  <span>{t('assistant.aiGenerateSql')}</span>
</div>

{/* 模型选择器 */}
<div className="relative">
  <div
    className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a] ml-1"
    onClick={(e) => { e.stopPropagation(); setIsModelMenuOpen(!isModelMenuOpen); }}
  >
    <span className="max-w-[100px] truncate">
      {configs.length === 0
        ? '未配置'
        : (() => {
            const active = configs.find((c) => c.id === activeConfigId) ?? configs.find((c) => c.is_default) ?? configs[0];
            return active?.name ?? '选择模型';
          })()
      }
    </span>
    <ChevronDown size={12} className="ml-1 flex-shrink-0" />
  </div>

  {isModelMenuOpen && (
    <div className="absolute left-0 bottom-full mb-1 w-52 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
      {configs.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[#7a9bb8]">
          暂无配置，
          <span className="text-[#009e84] cursor-pointer underline" onClick={() => setIsModelMenuOpen(false)}>
            去设置
          </span>
        </div>
      ) : (
        configs.map((c) => (
          <div
            key={c.id}
            className={`px-3 py-1.5 hover:bg-[#1e2d42] cursor-pointer flex items-center justify-between ${
              (activeConfigId === c.id || (!activeConfigId && c.is_default)) ? 'text-[#009e84]' : 'text-[#c8daea]'
            }`}
            onClick={() => { setActiveConfigId(c.id); setIsModelMenuOpen(false); }}
          >
            <span className="text-xs truncate flex-1">{c.is_default ? `★ ${c.name}` : c.name}</span>
            <span className={`ml-2 w-2 h-2 rounded-full flex-shrink-0 ${
              c.test_status === 'success' ? 'bg-green-400' :
              c.test_status === 'fail' ? 'bg-red-400' : 'bg-gray-600'
            }`} />
          </div>
        ))
      )}
    </div>
  )}
</div>
```

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 通过，0 errors

**Step 5: Commit**

```bash
git add src/components/Assistant/index.tsx
git commit -m "feat(assistant): add model selector dropdown next to AI generate SQL"
```

---

## Task 9: 全局初始化 & 收尾

**Files:**
- Modify: `src/main.tsx` 或 `src/App.tsx`（检查应用启动时加载配置的位置）

**Step 1: 确保应用启动时加载 LLM 配置**

在应用顶层组件的 `useEffect` 或初始化逻辑中确认调用 `loadConfigs()`。
如果 Settings 页已经调用 `loadConfigs()`，AI 面板也会调用，则不需要额外处理。

**Step 2: 最终 TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 3: Rust 最终编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 0 errors, 0 warnings（或只有无害 warning）

**Step 4: 更新 PLANS.md**

在 PLANS.md 的"进行中"或已完成部分添加：
```markdown
- [x] AI 模型配置多配置列表（CRUD + 默认标记 + 持久化测试状态 + AI 面板选择器）
```

**Step 5: 最终 Commit**

```bash
git add docs/PLANS.md
git commit -m "docs: mark LLM config list feature as complete"
```

---

## 验证清单

- [ ] `cargo check` 通过
- [ ] `tsc --noEmit` 通过
- [ ] Settings 页可新增配置（名称自动填充）
- [ ] Settings 页卡片显示正确（★ 标记默认配置）
- [ ] 测试按钮触发 → 卡片状态变为"测试中" → 最终显示成功/失败
- [ ] 删除默认配置后，另一条自动变为默认
- [ ] AI 面板模型选择器显示默认配置名称
- [ ] 下拉可切换配置，指示灯反映 test_status
- [ ] 旧配置数据自动迁移（首次启动）
