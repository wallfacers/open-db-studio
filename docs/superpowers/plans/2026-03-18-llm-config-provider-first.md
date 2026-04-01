<!-- STATUS: ✅ 已实现 -->
# LLM 配置供应商优先重设计 实现计划

> **状态: ✅ 已实现**
> `opencode_provider_id` + `config_mode` 已写入 DB 模型和迁移；`agent_list_providers` 命令已注册；前端 `LlmSettings.tsx` 已调用 `invoke('agent_list_providers')` 动态加载供应商列表。

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重设计 LLM 配置页面，支持从 opencode `/config/providers` 动态加载供应商和模型，修复 `ProviderModelNotFoundError`，支持自定义供应商。

**Architecture:** DB 新增 `opencode_provider_id` + `config_mode` 两列，Rust 层新增 `agent_list_providers` / `test_llm_config_inline` 命令并更新 provider 路由逻辑，前端 `LlmSettings.tsx` 重设计为供应商下拉 + 模型 Combobox 双联动表单。

**Tech Stack:** Rust + rusqlite + Tauri 2.x commands，React 18 + TypeScript + Tailwind CSS（Abyss Cyan 主题），Zustand，`@tauri-apps/api/core` invoke。

**Spec:** `docs/superpowers/specs/2026-03-18-llm-config-provider-first-design.md`

---

## Chunk 1: DB 层变更

**涉及文件：**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/models.rs`
- Modify: `src-tauri/src/db/mod.rs`

### Task 1: migrations.rs — 新增两列迁移

**Files:**
- Modify: `src-tauri/src/db/migrations.rs:56-74`（在 metrics 迁移块之后，V4 agent_sessions 之前添加）

- [ ] **Step 1.1：在 migrations.rs 末尾的 agent_sessions 创建语句之前，新增 llm_configs 两列的 ALTER 迁移**

在 `run_migrations` 函数中，在 `// V4: agent_sessions` 注释块之前，插入以下代码块：

```rust
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
```

- [ ] **Step 1.2：运行 cargo check 验证编译**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```
期望：无 error（warnings 可忽略）

- [ ] **Step 1.3：提交**

```bash
git add src-tauri/src/db/migrations.rs
git commit -m "feat(db): add opencode_provider_id and config_mode columns to llm_configs"
```

---

### Task 2: models.rs — 扩展 LlmConfig 及输入类型

**Files:**
- Modify: `src-tauri/src/db/models.rs:59-92`

- [ ] **Step 2.1：LlmConfig struct 新增两字段**

在 `pub created_at: String,` 之后（行 72），追加：
```rust
    pub opencode_provider_id: String,
    pub config_mode: String,
```

- [ ] **Step 2.2：CreateLlmConfigInput 新增两字段**

在 `pub preset: Option<String>,` 之后（行 82），追加：
```rust
    pub opencode_provider_id: String,  // opencode 模式传实际 providerID；自定义模式传用户自定义 ID
    pub config_mode: String,           // "opencode" | "custom"
```

- [ ] **Step 2.3：UpdateLlmConfigInput 新增两字段**

在 `pub preset: Option<String>,` 之后（行 92），追加：
```rust
    pub opencode_provider_id: Option<String>,
    pub config_mode: Option<String>,
```

- [ ] **Step 2.4：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```
期望：0 个 error（会有关于 models 字段未初始化的 error，将在 Task 3 修复）

- [ ] **Step 2.5：提交**

```bash
git add src-tauri/src/db/models.rs
git commit -m "feat(db): extend LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput with provider fields"
```

---

### Task 3: db/mod.rs — 同步 CRUD 实现

**Files:**
- Modify: `src-tauri/src/db/mod.rs:440-624`

- [ ] **Step 3.1：扩展 `row_to_llm_config_raw` 返回类型为 14-tuple**

将第 440 行的函数签名和实现替换为：

```rust
fn row_to_llm_config_raw(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String, String, String)> {
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
        row.get(12)?,  // opencode_provider_id
        row.get(13)?,  // config_mode
    ))
}
```

- [ ] **Step 3.2：扩展 `decrypt_llm_config` 映射新字段**

将第 457 行函数签名和 `Ok(models::LlmConfig { ... })` 块替换为：

```rust
fn decrypt_llm_config(raw: (i64, String, String, String, String, String, Option<String>, bool, String, Option<String>, Option<String>, String, String, String)) -> AppResult<models::LlmConfig> {
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
        opencode_provider_id: raw.12,
        config_mode: raw.13,
    })
}
```

- [ ] **Step 3.3：更新 `LLM_CONFIG_SELECT` 常量（行 479）**

```rust
const LLM_CONFIG_SELECT: &str =
    "SELECT id, name, api_key_enc, base_url, model, api_type, preset, is_default,
            test_status, test_error, tested_at, created_at,
            opencode_provider_id, config_mode
     FROM llm_configs";
```

- [ ] **Step 3.4：更新 `create_llm_config` INSERT 语句和名称 fallback（行 498-523）**

将 `create_llm_config` 函数体中的 name 构造和 `conn.execute` 调用替换为：

```rust
    let provider_hint = if !input.opencode_provider_id.is_empty() {
        input.opencode_provider_id.clone()
    } else {
        input.api_type.clone()
    };
    let name = input.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        format!("{} · {}", input.model, provider_hint)
    });
    conn.execute(
        "INSERT INTO llm_configs (name, api_key_enc, base_url, model, api_type, preset, is_default,
                                  opencode_provider_id, config_mode, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            name, api_key_enc, input.base_url, input.model, input.api_type, input.preset,
            is_default, input.opencode_provider_id, input.config_mode, now
        ],
    )?;
```

- [ ] **Step 3.5：更新 `update_llm_config` 支持新字段（行 525-554）**

在 `update_llm_config` 中，在 `let new_preset = ...` 之后追加两行：

```rust
    let new_opencode_provider_id = input.opencode_provider_id.clone().unwrap_or(current.12.clone());
    let new_config_mode = input.config_mode.clone().unwrap_or(current.13.clone());
```

将 `conn.execute` 的 UPDATE 语句替换为：

```rust
    conn.execute(
        "UPDATE llm_configs SET name=?1, api_key_enc=?2, base_url=?3, model=?4, api_type=?5,
                preset=?6, opencode_provider_id=?7, config_mode=?8 WHERE id=?9",
        rusqlite::params![
            new_name, new_api_key_enc, new_base_url, new_model, new_api_type,
            new_preset, new_opencode_provider_id, new_config_mode, id
        ],
    )?;
```

- [ ] **Step 3.6：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -30
```
期望：0 个 error

- [ ] **Step 3.7：提交**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): update LLM config CRUD for opencode_provider_id and config_mode"
```

---

## Chunk 2: Rust 命令层变更

**涉及文件：**
- Modify: `src-tauri/src/agent/config.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### Task 4: agent/config.rs — 新增 `upsert_custom_provider`

**Files:**
- Modify: `src-tauri/src/agent/config.rs`（在文件末尾追加函数）

- [ ] **Step 4.1：在 `write_agent_prompts` 函数之后追加 `upsert_custom_provider`**

```rust
/// 将自定义供应商合并写入 agent/opencode.json，不覆盖其他已有 provider。
/// 使用 tmp 文件 + rename 保证原子性。
/// `npm_pkg`：`"openai"` → `"@ai-sdk/openai"`；`"anthropic"` → `"@ai-sdk/anthropic"`
pub fn upsert_custom_provider(
    agent_dir: &std::path::Path,
    provider_id: &str,
    api_type: &str,
    base_url: &str,
    api_key: &str,
) -> AppResult<()> {
    std::fs::create_dir_all(agent_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    let path = agent_dir.join("opencode.json");

    // 读取已有 JSON（不存在则从空对象开始）
    let mut root: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| crate::AppError::Other(format!("Failed to read opencode.json: {}", e)))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // 确保 provider 字段存在
    if !root.get("provider").map(|v| v.is_object()).unwrap_or(false) {
        root["provider"] = serde_json::json!({});
    }

    let npm_pkg = match api_type {
        "anthropic" => "@ai-sdk/anthropic",
        _ => "@ai-sdk/openai",
    };

    let provider_entry = serde_json::json!({
        "npm": npm_pkg,
        "options": {
            "apiKey": api_key,
            "baseURL": base_url
        }
    });

    root["provider"][provider_id] = provider_entry;

    // 原子写入：先写 tmp 文件，再 rename
    let tmp_path = agent_dir.join("opencode.json.tmp");
    let json_str = serde_json::to_string_pretty(&root)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))?;
    std::fs::write(&tmp_path, &json_str)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json.tmp: {}", e)))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::AppError::Other(format!("Failed to rename opencode.json.tmp: {}", e)))?;

    log::info!("Upserted custom provider '{}' in opencode.json", provider_id);
    Ok(())
}
```

- [ ] **Step 4.2：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 4.3：提交**

```bash
git add src-tauri/src/agent/config.rs
git commit -m "feat(agent): add upsert_custom_provider for atomic opencode.json update"
```

---

### Task 5: commands.rs — 新增命令 `agent_list_providers`

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `agent_apply_config` 之后添加新命令）

- [ ] **Step 5.1：在文件顶部或现有 use 块中确认 `Serialize/Deserialize` 可用**（已有 `use serde::{Deserialize, Serialize};`，无需变更）

- [ ] **Step 5.2：在 `agent_apply_config` 函数定义之前，插入两个新的数据类型**

在 `commands.rs` 文件靠近顶部的结构体定义区域（或者直接在 `agent_list_providers` 函数之前）添加：

```rust
// ── OpenCode Provider 类型（用于 agent_list_providers 命令）──────────────
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProviderModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProvider {
    pub id: String,
    pub name: String,
    pub source: String,
    pub models: Vec<OpenCodeProviderModel>,
}
```

- [ ] **Step 5.3：在 `agent_apply_config` 之后添加 `agent_list_providers` 命令**

```rust
/// 从 opencode serve 获取可用供应商和模型列表。
/// 失败时返回空列表（opencode 未运行时降级）。
#[tauri::command]
pub async fn agent_list_providers(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<OpenCodeProvider>> {
    let port = state.serve_port;
    let url = format!("http://127.0.0.1:{}/config/providers", port);
    let client = reqwest::Client::new();
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[agent_list_providers] Request failed (opencode not running?): {}", e);
            return Ok(vec![]);
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[agent_list_providers] Failed to parse response: {}", e);
            return Ok(vec![]);
        }
    };
    let arr = match json["providers"].as_array() {
        Some(a) => a.clone(),
        None => {
            log::warn!("[agent_list_providers] Unexpected response format (no 'providers' array)");
            return Ok(vec![]);
        }
    };
    let providers = arr.into_iter().filter_map(|p| {
        let id = p["id"].as_str()?.to_string();
        let name = p["name"].as_str().unwrap_or(&id).to_string();
        let source = p["source"].as_str().unwrap_or("").to_string();
        let models = p["models"].as_object()
            .map(|m| m.iter().map(|(k, v)| OpenCodeProviderModel {
                id: k.clone(),
                name: v["name"].as_str().unwrap_or(k).to_string(),
            }).collect::<Vec<_>>())
            .unwrap_or_default();
        Some(OpenCodeProvider { id, name, source, models })
    }).collect();
    Ok(providers)
}
```

- [ ] **Step 5.4：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 5.5：提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): add agent_list_providers command"
```

---

### Task 6: commands.rs — 新增 `test_llm_config_inline`

**Files:**
- Modify: `src-tauri/src/commands.rs`（紧接 `agent_list_providers` 之后）

- [ ] **Step 6.1：添加 `test_llm_config_inline` 命令**

```rust
/// 无状态连接测试，直接接收配置参数，不写 DB。
/// 仅适用于自定义模式（opencode 模式无需 api_key，opencode 自行管理认证）。
#[tauri::command]
pub async fn test_llm_config_inline(
    model: String,
    api_type: String,
    base_url: String,
    api_key: String,
) -> AppResult<()> {
    let parsed_api_type = parse_api_type(&api_type);
    let client = crate::llm::client::LlmClient::new(
        api_key,
        Some(base_url),
        Some(model),
        Some(parsed_api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    client.chat(messages).await.map(|_| ())
}
```

- [ ] **Step 6.2：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 6.3：提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): add test_llm_config_inline stateless connection test"
```

---

### Task 7: commands.rs — 更新 provider_str 来源（3处）

**Files:**
- Modify: `src-tauri/src/commands.rs` — `agent_chat_inner`（行 2514-2526）、`agent_explain_sql_inner`（行 2708-2709）、`agent_optimize_sql_inner`（对应位置）

- [ ] **Step 7.1：更新 `agent_chat_inner` 使用 `opencode_provider_id`**

将行 2514-2526 的代码修改为：

```rust
    let (model_str, provider_str) = match config_id {
        Some(id) => {
            let cfg = crate::db::get_llm_config_by_id(id)?
                .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
            (cfg.model, cfg.opencode_provider_id)
        }
        None => {
            match crate::db::get_default_llm_config()? {
                Some(cfg) => (cfg.model, cfg.opencode_provider_id),
                None => (String::new(), String::new()),
            }
        }
    };
```

- [ ] **Step 7.2：更新 `agent_explain_sql_inner` 使用 `opencode_provider_id`**

将行 2708-2709 修改为：

```rust
    let model_opt = if config.model.is_empty() { None } else { Some(config.model.as_str()) };
    let provider_opt = if config.opencode_provider_id.is_empty() { None } else { Some(config.opencode_provider_id.as_str()) };
```

- [ ] **Step 7.3：更新 `agent_optimize_sql_inner` 使用 `opencode_provider_id`**

在 `agent_optimize_sql_inner` 中，找到 `let model_opt` / `let provider_opt` 两行（位于"获取当前 LLM 配置"之后），替换为：

```rust
    let model_opt = if config.model.is_empty() { None } else { Some(config.model.as_str()) };
    let provider_opt = if config.opencode_provider_id.is_empty() { None } else { Some(config.opencode_provider_id.as_str()) };
```

- [ ] **Step 7.4：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 7.5：提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "fix(commands): use opencode_provider_id instead of api_type for LLM routing"
```

---

### Task 8: commands.rs — 更新 `agent_apply_config` 和 `agent_create_session`

**Files:**
- Modify: `src-tauri/src/commands.rs` — `agent_apply_config`（行 2609-2630）、`agent_create_session`（行 2320-2346）

- [ ] **Step 8.1：更新 `agent_apply_config`**

将整个 `agent_apply_config` 函数体替换为：

```rust
#[tauri::command]
pub async fn agent_apply_config(
    config_id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let cfg = crate::db::get_llm_config_by_id(config_id)?
        .ok_or_else(|| AppError::Other(format!("LLM config {} not found", config_id)))?;

    let agent_dir = state.app_data_dir.join("agent");

    // 自定义模式：先写入 opencode.json 的 provider 配置
    if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
        if let Err(e) = crate::agent::config::upsert_custom_provider(
            &agent_dir,
            &cfg.opencode_provider_id,
            &cfg.api_type,
            &cfg.base_url,
            &cfg.api_key,
        ) {
            log::warn!("[agent_apply_config] upsert_custom_provider failed: {}", e);
        }
    }

    // 两种模式统一用 opencode_provider_id 热更新
    if let Err(e) = crate::agent::client::patch_config(
        state.serve_port, &cfg.model, &cfg.opencode_provider_id,
    ).await {
        log::warn!("[agent_apply_config] patch_config failed (ignored): {}", e);
    }

    Ok(())
}
```

- [ ] **Step 8.2：更新 `agent_create_session`**

将 `agent_create_session` 中的 `if let Some(id) = config_id { ... }` 块替换为：

```rust
    if let Some(id) = config_id {
        let cfg = crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
        let agent_dir = state.app_data_dir.join("agent");
        // 自定义模式：写入 provider 配置
        if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
            if let Err(e) = crate::agent::config::upsert_custom_provider(
                &agent_dir,
                &cfg.opencode_provider_id,
                &cfg.api_type,
                &cfg.base_url,
                &cfg.api_key,
            ) {
                log::warn!("[agent_create_session] upsert_custom_provider failed: {}", e);
            }
        }
        if let Err(e) = crate::agent::client::patch_config(
            state.serve_port, &cfg.model, &cfg.opencode_provider_id,
        ).await {
            log::warn!("[agent_create_session] patch_config failed: {}", e);
        }
    }
```

- [ ] **Step 8.3：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 8.4：提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): update apply_config and create_session to handle custom providers"
```

---

### Task 9: lib.rs — 注册新命令

**Files:**
- Modify: `src-tauri/src/lib.rs:229-231`（在 `cancel_optimize_sql` 之前插入）

- [ ] **Step 9.1：在 `generate_handler![]` 末尾的 `cancel_optimize_sql` 之前插入两行**

```rust
            commands::agent_list_providers,
            commands::test_llm_config_inline,
```

- [ ] **Step 9.2：cargo check 验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 9.3：提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): register agent_list_providers and test_llm_config_inline commands"
```

---

## Chunk 3: 前端变更

**涉及文件：**
- Modify: `src/types/index.ts`
- Modify: `src/components/Settings/LlmSettings.tsx`

### Task 10: types/index.ts — 扩展类型

**Files:**
- Modify: `src/types/index.ts:55-89`

- [ ] **Step 10.1：新增 `ConfigMode` 类型**

在 `export type ApiType = ...` 之后（行 55）插入：

```typescript
export type ConfigMode = 'opencode' | 'custom';
```

- [ ] **Step 10.2：LlmConfig 新增两字段**

在 `export interface LlmConfig` 的 `created_at: string;` 之后追加：

```typescript
  opencode_provider_id: string;
  config_mode: ConfigMode;
```

- [ ] **Step 10.3：CreateLlmConfigInput 新增两字段**

在 `export interface CreateLlmConfigInput` 的 `preset?: string | null;` 之后追加：

```typescript
  opencode_provider_id: string;
  config_mode: ConfigMode;
```

- [ ] **Step 10.4：UpdateLlmConfigInput 新增两字段**

在 `export interface UpdateLlmConfigInput` 的 `preset?: string | null;` 之后追加：

```typescript
  opencode_provider_id?: string;
  config_mode?: ConfigMode;
```

- [ ] **Step 10.5：文件末尾追加 OpenCodeProvider 相关类型**

```typescript
export interface OpenCodeProviderModel {
  id: string;
  name: string;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  source: string;  // "api" | "config" | "custom"
  models: OpenCodeProviderModel[];
}
```

- [ ] **Step 10.6：运行 TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```
期望：报出 LlmSettings.tsx 等文件中使用旧类型的错误（将在下一任务修复），但 types/index.ts 本身无错误。

- [ ] **Step 10.7：提交**

```bash
git add src/types/index.ts
git commit -m "feat(types): add ConfigMode, OpenCodeProvider types and extend LLM config interfaces"
```

---

### Task 11: LlmSettings.tsx — 完整重设计

**Files:**
- Modify: `src/components/Settings/LlmSettings.tsx`（完整替换文件内容）

这是本次改动最大的任务。重设计后的组件实现以下功能：
1. 弹框打开时加载供应商列表（`agent_list_providers`）
2. 供应商下拉 + 末尾"⚙ 自定义供应商"选项
3. opencode 模式：模型 Combobox（供应商模型列表 + 自定义输入框）
4. 自定义模式：展开框（Provider ID / API 兼容类型 / Base URL / API Key）+ 测试连接按钮
5. 配置名称自动填充（用户手动修改后锁定）
6. 配置卡片显示更新

- [ ] **Step 11.1：替换 LlmSettings.tsx 文件**

完整内容如下（使用 Write 工具）：

```typescript
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle, XCircle, Loader2, Star, Plus, Pencil, Trash2, X, ChevronDown,
} from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type {
  LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput,
  OpenCodeProvider, OpenCodeProviderModel, ConfigMode,
} from '../../types';
import { useEscClose } from '../../hooks/useEscClose';

// ──────────────── 共用类名 ────────────────
const inputCls = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-[#c8daea] focus:outline-none focus:border-[#009e84]';
const labelCls = 'block text-xs text-[#7a9bb8] mb-1 uppercase tracking-wide';

// ──────────────── TestStatusBadge ────────────────
function TestStatusBadge({ status, error, testedAt }: {
  status: string; error: string | null; testedAt: string | null;
}) {
  const { t } = useTranslation();
  const ago = (() => {
    if (!testedAt) return '';
    const diff = Date.now() - new Date(testedAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('llmSettings.justNow');
    if (mins < 60) return t('llmSettings.minutesAgo', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('llmSettings.hoursAgo', { n: hours });
    return t('llmSettings.daysAgo', { n: Math.floor(hours / 24) });
  })();
  if (status === 'untested') return <span className="text-xs text-[#4a6480]">○ {t('llmSettings.untested')}</span>;
  if (status === 'testing') return (
    <span className="text-xs text-yellow-400 flex items-center gap-1">
      <Loader2 size={11} className="animate-spin" />{t('llmSettings.testing')}
    </span>
  );
  if (status === 'success') return (
    <span className="text-xs text-[#4ade80] flex items-center gap-1">
      <CheckCircle size={11} />{t('llmSettings.connected')} {ago}
    </span>
  );
  return (
    <span className="text-xs text-red-400 flex items-center gap-1" title={error ?? ''}>
      <XCircle size={11} />{t('llmSettings.failed')}
    </span>
  );
}

// ──────────────── ModelCombobox ────────────────
// 供应商模型列表 + 底部自定义输入框
function ModelCombobox({
  models, value, onChange,
}: {
  models: OpenCodeProviderModel[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full bg-[#1a2639] border rounded px-3 py-1.5 text-sm text-[#c8daea] focus:outline-none flex justify-between items-center ${open ? 'border-[#009e84] rounded-b-none' : 'border-[#253347]'}`}
      >
        <span>{value || '选择模型…'}</span>
        <ChevronDown size={13} className="text-[#4a6480]" />
      </button>
      {open && (
        <div className="absolute z-10 w-full bg-[#0d1117] border border-[#1e2d42] border-t-0 rounded-b-md max-h-52 overflow-y-auto">
          {models.length > 0 && (
            <div className="px-3 pt-2 pb-1 text-[10px] text-[#4a6480] uppercase tracking-wide">供应商模型</div>
          )}
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#1a2639] ${value === m.id ? 'text-[#00c9a7] bg-[#003d2f]/20' : 'text-[#7a9bb8]'}`}
            >
              {value === m.id && '✓ '}{m.name || m.id}
            </button>
          ))}
          <div className="border-t border-[#1e2d42] mx-2 my-1" />
          <div className="px-2 pb-2">
            <input
              className="w-full bg-[#0d1117] border border-dashed border-[#253347] rounded px-2 py-1 text-xs text-[#4a6480] focus:outline-none focus:border-[#009e84] focus:text-[#c8daea]"
              placeholder="输入自定义模型 ID…"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customInput.trim()) {
                  onChange(customInput.trim());
                  setCustomInput('');
                  setOpen(false);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────── ProviderDropdown ────────────────
function ProviderDropdown({
  providers, value, onChange,
}: {
  providers: OpenCodeProvider[];
  value: string;       // provider id 或 'custom'
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedProvider = providers.find((p) => p.id === value);
  const displayLabel = value === 'custom'
    ? '⚙ 自定义供应商'
    : (selectedProvider?.name ?? value || '选择供应商…');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full bg-[#1a2639] border rounded px-3 py-1.5 text-sm text-[#c8daea] focus:outline-none flex justify-between items-center ${open ? 'border-[#009e84] rounded-b-none' : 'border-[#253347]'}`}
      >
        <span className="flex items-center gap-2">
          {value && value !== 'custom' && (
            <span className="w-2 h-2 rounded-full bg-[#00c9a7] flex-shrink-0 inline-block" />
          )}
          {value === 'custom' && (
            <span className="w-2 h-2 rounded-full bg-[#7a9bb8] flex-shrink-0 inline-block" />
          )}
          {displayLabel}
        </span>
        <ChevronDown size={13} className="text-[#4a6480]" />
      </button>
      {open && (
        <div className="absolute z-10 w-full bg-[#0d1117] border border-[#1e2d42] border-t-0 rounded-b-md max-h-64 overflow-y-auto">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { onChange(p.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-[#1a2639] flex items-center gap-2 ${value === p.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`}
            >
              <span className="w-2 h-2 rounded-full bg-[#00c9a7] flex-shrink-0 inline-block" />
              {p.name || p.id}
            </button>
          ))}
          <div className="border-t border-[#1e2d42] mx-2 my-1" />
          <button
            type="button"
            onClick={() => { onChange('custom'); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-xs hover:bg-[#1a2639] flex items-center gap-2 ${value === 'custom' ? 'text-[#00c9a7]' : 'text-[#4a6480]'}`}
          >
            <span className="w-2 h-2 rounded-full bg-[#7a9bb8] flex-shrink-0 inline-block" />
            ⚙ 自定义供应商…
          </button>
        </div>
      )}
    </div>
  );
}

// ──────────────── ConfigFormDialog ────────────────
interface ConfigFormDialogProps {
  title: string;
  initial: CreateLlmConfigInput;
  editId?: number;
  providers: OpenCodeProvider[];
  providersLoading: boolean;
  onSave: (input: CreateLlmConfigInput, testPassed: boolean) => Promise<void>;
  onCancel: () => void;
}

function ConfigFormDialog({
  title, initial, editId, providers, providersLoading, onSave, onCancel,
}: ConfigFormDialogProps) {
  const [form, setForm] = useState<CreateLlmConfigInput>(initial);
  const [nameTouched, setNameTouched] = useState(!!initial.name);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  useEscClose(onCancel);

  // 当前选中的供应商对象
  const selectedProvider = providers.find((p) => p.id === form.opencode_provider_id);

  // 自动填充配置名称（用户未手动修改时）
  useEffect(() => {
    if (nameTouched) return;
    let autoName = '';
    if (form.config_mode === 'opencode' && form.model && form.opencode_provider_id) {
      const pName = selectedProvider?.name ?? form.opencode_provider_id;
      autoName = `${form.model} · ${pName}`;
    } else if (form.config_mode === 'custom' && form.model && form.opencode_provider_id) {
      autoName = `${form.opencode_provider_id} · ${form.model}`;
    }
    if (autoName) setForm((f) => ({ ...f, name: autoName }));
  }, [form.model, form.opencode_provider_id, form.config_mode, nameTouched]);

  // 切换供应商时，重置模型
  const handleProviderChange = (pid: string) => {
    const isCustom = pid === 'custom';
    setForm((f) => ({
      ...f,
      opencode_provider_id: isCustom ? '' : pid,
      config_mode: isCustom ? 'custom' : 'opencode',
      model: '',
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    let effectiveApiKey = form.api_key;
    if (editId && !apiKeyDirty) {
      try { effectiveApiKey = await invoke<string>('get_llm_config_key', { id: editId }); } catch {}
    }
    try {
      await invoke('test_llm_config_inline', {
        model: form.model,
        apiType: form.api_type,
        baseUrl: form.base_url,
        apiKey: effectiveApiKey,
      });
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form, testResult?.ok === true);
    } finally {
      setSaving(false);
    }
  };

  const isCustomMode = form.config_mode === 'custom';
  const dropdownValue = isCustomMode ? 'custom' : form.opencode_provider_id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <h3 className="text-[#e8f4ff] font-semibold text-sm">{title}</h3>
          <button onClick={onCancel} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16} /></button>
        </div>

        {/* 配置名称 */}
        <div>
          <label className={labelCls}>配置名称</label>
          <input
            className={inputCls}
            value={form.name ?? ''}
            onChange={(e) => {
              setNameTouched(true);
              setForm((f) => ({ ...f, name: e.target.value }));
            }}
            placeholder="自动填充…"
          />
        </div>

        {/* 供应商下拉 */}
        <div>
          <label className={labelCls}>
            供应商
            {providersLoading && <span className="ml-2 text-[#4a6480] normal-case">加载中…</span>}
          </label>
          <ProviderDropdown
            providers={providers}
            value={dropdownValue}
            onChange={handleProviderChange}
          />
        </div>

        {/* 自定义模式展开框 */}
        {isCustomMode && (
          <div className="bg-[#111922] border border-[#1e2d42] rounded-lg p-4 space-y-3">
            <div className="text-[10px] text-[#4a6480] uppercase tracking-wide">自定义供应商配置</div>

            <div>
              <label className={labelCls}>Provider ID</label>
              <input
                className={inputCls}
                value={form.opencode_provider_id}
                onChange={(e) => setForm((f) => ({ ...f, opencode_provider_id: e.target.value }))}
                placeholder="my-azure-gpt"
              />
              <p className="text-[10px] text-[#4a6480] mt-1">opencode 中的唯一标识</p>
            </div>

            <div>
              <label className={labelCls}>API 兼容类型</label>
              <div className="flex gap-4">
                {(['openai', 'anthropic'] as const).map((type) => (
                  <label key={type} className="flex items-center gap-1.5 text-xs text-[#c8daea] cursor-pointer">
                    <input
                      type="radio"
                      name="api_type"
                      value={type}
                      checked={form.api_type === type}
                      onChange={() => setForm((f) => ({ ...f, api_type: type }))}
                      className="accent-[#009e84]"
                    />
                    {type === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>Base URL</label>
              <input
                className={inputCls}
                value={form.base_url}
                onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div>
              <label className={labelCls}>API Key</label>
              <PasswordInput
                className={inputCls}
                value={form.api_key}
                onChange={(v) => {
                  setForm((f) => ({ ...f, api_key: v }));
                  setApiKeyDirty(true);
                }}
                placeholder={editId ? '不修改则留空' : 'sk-…'}
              />
            </div>
          </div>
        )}

        {/* 模型选择 */}
        <div>
          <label className={labelCls}>模型</label>
          {isCustomMode ? (
            <>
              <input
                className={inputCls}
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="直接输入模型 ID"
              />
              <p className="text-[10px] text-[#4a6480] mt-1">直接输入模型 ID</p>
            </>
          ) : (
            <ModelCombobox
              models={selectedProvider?.models ?? []}
              value={form.model}
              onChange={(v) => setForm((f) => ({ ...f, model: v }))}
            />
          )}
        </div>

        {/* 测试结果（仅自定义模式） */}
        {isCustomMode && testResult && (
          <div className={`flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-[#4ade80]' : 'text-red-400'}`}>
            {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
            {testResult.ok ? '连接成功' : testResult.msg}
          </div>
        )}

        {/* 操作按钮 */}
        <div className={`flex items-center pt-2 ${isCustomMode ? 'justify-between' : 'justify-end gap-2'}`}>
          {isCustomMode && (
            <button
              onClick={handleTest}
              disabled={testing || !form.model || !form.base_url}
              className="px-3 py-1.5 text-xs border border-[#1e2d42] text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1.5"
            >
              {testing && <Loader2 size={12} className="animate-spin" />}
              {testing ? '测试中…' : '测试连接'}
            </button>
          )}
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.model || (!isCustomMode && !form.opencode_provider_id)}
              className="px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────── 主组件 ────────────────
const EMPTY_FORM: CreateLlmConfigInput = {
  name: '',
  api_key: '',
  base_url: '',
  model: '',
  api_type: 'openai',
  opencode_provider_id: '',
  config_mode: 'opencode',
  preset: null,
};

export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { configs, loadConfigs, deleteConfig, setDefaultConfig, testConfig } = useAiStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<LlmConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LlmConfig | null>(null);
  const [providers, setProviders] = useState<OpenCodeProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);

  useEffect(() => { loadConfigs(); }, []);

  useEscClose(() => setDeleteConfirm(null), !!deleteConfirm && !showCreate && !editTarget);

  // 打开弹框时加载供应商列表
  const loadProviders = async () => {
    setProvidersLoading(true);
    try {
      const list = await invoke<OpenCodeProvider[]>('agent_list_providers');
      setProviders(list);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  };

  const handleOpenCreate = () => {
    loadProviders();
    setShowCreate(true);
  };

  const handleOpenEdit = (config: LlmConfig) => {
    loadProviders();
    setEditTarget(config);
  };

  const handleCreate = async (input: CreateLlmConfigInput, testPassed: boolean) => {
    const created = await invoke<LlmConfig>('create_llm_config', { input });
    if (testPassed) {
      await invoke('set_llm_config_test_status', { id: created.id, status: 'success', error: null });
    }
    await loadConfigs();
    setShowCreate(false);
  };

  const handleUpdate = async (input: CreateLlmConfigInput, testPassed: boolean) => {
    if (!editTarget) return;
    const updateInput: UpdateLlmConfigInput = {
      name: input.name,
      api_key: input.api_key || undefined,
      base_url: input.base_url,
      model: input.model,
      api_type: input.api_type,
      preset: input.preset,
      opencode_provider_id: input.opencode_provider_id,
      config_mode: input.config_mode,
    };
    await invoke('update_llm_config', { id: editTarget.id, input: updateInput });
    if (testPassed) {
      await invoke('set_llm_config_test_status', { id: editTarget.id, status: 'success', error: null });
    }
    await loadConfigs();
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfig(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  // 供应商标签（卡片显示用）
  const providerLabel = (config: LlmConfig) => {
    if (config.config_mode === 'custom') {
      return `⚙ 自定义 · ${config.opencode_provider_id || config.api_type}`;
    }
    return providers.find((p) => p.id === config.opencode_provider_id)?.name
      ?? config.opencode_provider_id
      || config.api_type;
  };

  return (
    <div className="w-full max-w-2xl p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-[#e8f4ff] font-semibold text-sm">{t('llmSettings.aiModelConfig')}</h3>
        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded"
        >
          <Plus size={13} />{t('llmSettings.addConfig')}
        </button>
      </div>

      {/* 配置卡片网格 */}
      {configs.length === 0 ? (
        <div className="text-center py-16 text-[#7a9bb8]">
          <p className="text-sm">{t('llmSettings.noConfigs')}</p>
          <p className="text-xs mt-1 opacity-60">{t('llmSettings.noConfigsHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {configs.map((config) => (
            <div
              key={config.id}
              className={`bg-[#111922] border rounded-lg p-4 flex flex-col gap-2 ${config.is_default ? 'border-[#00c9a7]' : 'border-[#1e2d42]'}`}
            >
              {/* 标题行 */}
              <div className="flex items-start justify-between gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  {config.is_default && <Star size={13} className="text-[#009e84] fill-[#009e84] flex-shrink-0" />}
                  <span className="text-sm text-[#e8f4ff] font-medium truncate">{config.name}</span>
                </div>
                {config.is_default && (
                  <span className="text-[10px] bg-[#003d2f] text-[#00c9a7] px-1.5 py-0.5 rounded flex-shrink-0">默认</span>
                )}
              </div>
              {/* 供应商 + 模型 */}
              <div className="text-xs text-[#7a9bb8] space-y-0.5">
                <div className="truncate">{providerLabel(config)}</div>
                <div className="text-[#c8daea] truncate">{config.model}</div>
              </div>
              {/* 测试状态 */}
              <TestStatusBadge status={config.test_status} error={config.test_error} testedAt={config.tested_at} />
              {/* 操作 */}
              <div className="flex items-center gap-1.5 mt-1 pt-2 border-t border-[#1e2d42] flex-wrap">
                {!config.is_default && (
                  <button
                    onClick={() => setDefaultConfig(config.id)}
                    className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded"
                  >
                    {t('llmSettings.setDefault')}
                  </button>
                )}
                {config.config_mode === 'custom' && (
                  <button
                    onClick={() => testConfig(config.id)}
                    disabled={config.test_status === 'testing'}
                    className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    {config.test_status === 'testing' && <Loader2 size={10} className="animate-spin" />}
                    {t('llmSettings.test')}
                  </button>
                )}
                <button
                  onClick={() => handleOpenEdit(config)}
                  className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1"
                >
                  <Pencil size={11} />{t('llmSettings.edit')}
                </button>
                <button
                  onClick={() => setDeleteConfirm(config)}
                  className="text-xs px-2 py-1 border border-red-900 text-red-400 hover:bg-red-950 rounded flex items-center gap-1"
                >
                  <Trash2 size={11} />{t('llmSettings.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建弹框 */}
      {showCreate && (
        <ConfigFormDialog
          title={t('llmSettings.addConfigTitle')}
          initial={EMPTY_FORM}
          providers={providers}
          providersLoading={providersLoading}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* 编辑弹框 */}
      {editTarget && (
        <ConfigFormDialog
          title={t('llmSettings.editConfigTitle')}
          initial={{
            name: editTarget.name,
            api_key: '',
            base_url: editTarget.base_url,
            model: editTarget.model,
            api_type: editTarget.api_type,
            opencode_provider_id: editTarget.opencode_provider_id,
            config_mode: editTarget.config_mode,
            preset: editTarget.preset,
          }}
          editId={editTarget.id}
          providers={providers}
          providersLoading={providersLoading}
          onSave={handleUpdate}
          onCancel={() => setEditTarget(null)}
        />
      )}

      {/* 删除确认 */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}
        >
          <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[#e8f4ff] font-semibold text-sm">{t('llmSettings.confirmDelete')}</h3>
              <button onClick={() => setDeleteConfirm(null)} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16} /></button>
            </div>
            <p className="text-xs text-[#c8daea]">
              {t('llmSettings.confirmDeleteMsg', { name: deleteConfirm.name })}
              {deleteConfirm.is_default && (
                <span className="text-yellow-400 block mt-1">{t('llmSettings.defaultDeleteWarning')}</span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded">
                {t('llmSettings.cancel')}
              </button>
              <button onClick={handleDelete} className="px-4 py-1.5 text-xs bg-red-700 hover:bg-red-800 text-white rounded">
                {t('llmSettings.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11.2：运行 TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```
期望：0 个 error

- [ ] **Step 11.3：提交**

```bash
git add src/types/index.ts src/components/Settings/LlmSettings.tsx
git commit -m "feat(frontend): redesign LlmSettings with provider-first dual-dropdown UI"
```

---

## Chunk 4: 集成验证

### Task 12: 端到端验证

- [ ] **Step 12.1：全量 cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```
期望：0 个 error

- [ ] **Step 12.2：TypeScript 全量类型检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```
期望：0 个 error

- [ ] **Step 12.3：启动 opencode serve（确认端口），然后 tauri:dev 冒烟测试**

```bash
npm run tauri:dev
```

冒烟测试步骤：
1. 打开"AI 模型配置"设置页
2. 点击"新增配置"按钮 → 验证供应商列表已从 opencode 加载（应显示如 `Model Studio Coding Plan` 等）
3. 选择一个供应商 → 验证模型下拉刷新
4. 选择模型，点击保存 → 验证 card 显示供应商名称
5. 再次新增，选"⚙ 自定义供应商" → 验证展开框出现
6. 填写自定义 provider_id / base_url / api_key，点击"测试连接"
7. 在 AI 聊天中发送消息 → 验证 `ProviderModelNotFoundError` 不再出现

- [ ] **Step 12.4：提交**

```bash
git add -u
git commit -m "chore: llm config provider-first redesign complete"
```
