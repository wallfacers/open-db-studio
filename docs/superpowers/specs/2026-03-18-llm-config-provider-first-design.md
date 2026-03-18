# LLM 模型配置 — 供应商优先重设计

**日期：** 2026-03-18
**状态：** 待实现
**范围：** 重设计 LLM 配置页面，支持从 opencode `/config/providers` 动态加载供应商和模型列表，修复 `send_message` providerID 错误，支持自定义供应商。

---

## 背景与动机

当前 `llm_configs` 表使用 `api_type`（值为 `"openai"` / `"anthropic"`）作为内部类型枚举。迁移到 opencode serve 模式后，`send_message` 需要传入真实的 opencode `providerID`（如 `"bailian-coding-plan"`）。两者语义不同，导致：

- `send_message` 发送 `{ "modelID": "glm-5", "providerID": "anthropic" }` → opencode 找不到 `providers["anthropic"]` → `ProviderModelNotFoundError`
- 用户无法选择自己在 opencode 配置中定义的自定义供应商

目标：配置表单改为"先选供应商，再选模型"，供应商列表从 opencode serve 动态拉取，存储真实 `opencode_provider_id`。

---

## 交互设计

### 表单布局（方案 B：双下拉联动）

1. **供应商下拉**：从 `GET /config/providers` 获取列表，末尾追加"⚙ 自定义供应商"选项
2. **模型 Combobox**：选中供应商后，展示该供应商下的模型列表；底部有自定义输入框，允许手填任意模型 ID
3. **自定义模式**：选"自定义供应商"后，供应商下拉下方展开额外字段：Provider ID、API 兼容类型、Base URL、API Key；底部加"测试连接"按钮
4. **配置名称**：默认自动填充为 `<model> · <provider_name>`，用户可覆盖

### 配置卡片

- 默认配置：青色边框（`border-[#00c9a7]`）+ "默认"角标
- Provider 行显示供应商名称（opencode 模式）或 `⚙ 自定义 · <provider_id>`（自定义模式）
- 测试状态徽标（已验证 / 未测试 / 失败）

### 主题色约束

全部使用项目 Abyss Cyan 主题：
- 背景：`bg-[#0d1a26]` / `bg-[#111922]` / `bg-[#1a2639]`
- 边框：`border-[#1e2d42]` / `border-[#253347]`，focus：`border-[#009e84]`
- 主色按钮：`bg-[#009e84] hover:bg-[#007a62]`
- 强调色：`text-[#00c9a7]`，激活背景：`bg-[#003d2f]`
- 文本：`text-[#c8daea]`（默认）/ `text-[#7a9bb8]`（次要）/ `text-[#e8f4ff]`（标题）
- 禁止 `style=""` 内联样式，全部用 Tailwind 类

---

## Part 1：DB Schema 变更

### 1.1 新增两列（migrations.rs）

```sql
-- Migration（db/migrations.rs 新增一次迁移）
ALTER TABLE llm_configs ADD COLUMN opencode_provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_configs ADD COLUMN config_mode TEXT NOT NULL DEFAULT 'custom'
  CHECK(config_mode IN ('opencode', 'custom'));
```

**字段语义：**

| 字段 | opencode 模式 | 自定义模式 |
|------|--------------|-----------|
| `opencode_provider_id` | 真实 providerID，如 `"bailian-coding-plan"` | 用户自定义，如 `"my-azure-gpt"`，写入 `agent/opencode.json` |
| `config_mode` | `"opencode"` | `"custom"` |
| `api_type` | 不再使用（保留列，不删除） | `"openai"` 或 `"anthropic"`，决定 npm 包 |
| `api_key_enc` | 空字符串 | AES-256 加密存储 |
| `base_url` | 空字符串 | 用户填写 |

**迁移兼容：** 现有记录 `DEFAULT 'custom'`，`opencode_provider_id` 默认 `''`，行为不变（`provider_str` 为空 → `send_message` 不传 model 字段 → opencode 用自身默认配置）。

### 1.2 db/mod.rs 完整改动清单

以下 6 处必须同步修改：

1. **`models::LlmConfig` struct** — 新增两字段：
   ```rust
   pub opencode_provider_id: String,
   pub config_mode: String,
   ```

2. **`LLM_CONFIG_SELECT` 常量** — SELECT 语句末尾追加两列：
   ```rust
   "SELECT id, name, api_key_enc, base_url, model, api_type, preset, is_default,
           test_status, test_error, tested_at, created_at,
           opencode_provider_id, config_mode   -- 新增
    FROM llm_configs"
   ```

3. **`row_to_llm_config_raw`** — 返回类型从 12-tuple 扩展为 14-tuple，位置 12=`opencode_provider_id`，位置 13=`config_mode`。

4. **`decrypt_llm_config`** — 映射 `raw.12` → `opencode_provider_id`，`raw.13` → `config_mode`。

5. **`create_llm_config` INSERT** — 语句加入两列并绑定 `input.opencode_provider_id` 和 `input.config_mode`。

6. **`update_llm_config` UPDATE** — 支持 `UpdateLlmConfigInput` 中的两个新 `Option<String>` 字段，逻辑与现有字段相同（`None` 时不更新）。

---

## Part 2：Rust 变更

### 2.1 新增命令：`agent_list_providers`

**`/config/providers` 实际响应格式**（已验证，opencode serve 6687 端口）：

```json
{
  "providers": [
    {
      "id": "bailian-coding-plan",
      "source": "config",
      "name": "Model Studio Coding Plan",
      "models": {
        "glm-5":          { "id": "glm-5",          "name": "GLM-5" },
        "qwen3.5-plus":   { "id": "qwen3.5-plus",   "name": "Qwen3.5 Plus" }
      }
    },
    {
      "id": "zai-coding-plan",
      "source": "api",
      "name": "Z.AI Coding Plan",
      "models": { ... }
    }
  ]
}
```

关键字段：`providers` 是**数组**（非 map），每个 provider 有 `id`、`name`、`models`（map，key 为 model ID，value 含 `id`、`name`）。`source` 可为 `"api"` / `"config"` / `"custom"`。

**Rust 类型：**

```rust
// 在 commands.rs 或单独的 agent/types.rs 中定义
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProviderModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProvider {
    pub id: String,
    pub name: String,
    pub source: String,                    // "api" | "config" | "custom"
    pub models: Vec<OpenCodeProviderModel>, // 保持原始顺序
}

#[tauri::command]
pub async fn agent_list_providers(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<OpenCodeProvider>>
```

**解析逻辑：**

```rust
let json: serde_json::Value = resp.json().await?;
let arr = json["providers"].as_array().cloned().unwrap_or_default();
arr.into_iter().filter_map(|p| {
    let id = p["id"].as_str()?.to_string();
    let name = p["name"].as_str().unwrap_or(&id).to_string();
    let source = p["source"].as_str().unwrap_or("").to_string();
    let models = p["models"].as_object()
        .map(|m| m.iter().map(|(k, v)| OpenCodeProviderModel {
            id: k.clone(),
            name: v["name"].as_str().unwrap_or(k).to_string(),
        }).collect())
        .unwrap_or_default();
    Some(OpenCodeProvider { id, name, source, models })
}).collect()
```

**失败处理：** 返回空 `Vec`（不报错），并记录 `warn` 日志，前端降级显示提示。

### 2.2 更新输入类型

```rust
pub struct CreateLlmConfigInput {
    pub name: Option<String>,            // None 时 Rust 自动填充（见 2.6）
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: String,                // 自定义模式用；opencode 模式传 ""
    pub opencode_provider_id: String,   // 新增
    pub config_mode: String,            // 新增："opencode" | "custom"
    pub preset: Option<String>,
}
// UpdateLlmConfigInput 同步新增两个 Option<String> 字段；is_default 不在此结构体中
```

### 2.3 更新 `agent_chat_inner` / `agent_explain_sql_inner` / `agent_optimize_sql_inner`

三处均改为使用 `opencode_provider_id`（原为 `api_type`）：

```rust
// agent_chat_inner（lines ~2514-2526）
let (model_str, provider_str) = match config_id {
    Some(id) => {
        let cfg = crate::db::get_llm_config_by_id(id)?...;
        (cfg.model, cfg.opencode_provider_id)   // ← 原 cfg.api_type
    }
    None => {
        match crate::db::get_default_llm_config()? {
            Some(cfg) => (cfg.model, cfg.opencode_provider_id),   // ← 原 cfg.api_type
            None => (String::new(), String::new()),
        }
    }
};

// agent_explain_sql_inner / agent_optimize_sql_inner：
// 原: let model_opt = ... Some(config.api_type.as_str()) ...
// 新: let provider_opt = if config.opencode_provider_id.is_empty() { None }
//                        else { Some(config.opencode_provider_id.as_str()) };
```

### 2.4 新增 `upsert_custom_provider`（agent/config.rs）

```rust
/// 将自定义供应商合并写入 agent/opencode.json，不覆盖其他已有 provider。
/// 写入使用 tmp 文件 + rename 保证原子性。
pub fn upsert_custom_provider(
    agent_dir: &std::path::Path,
    provider_id: &str,
    api_type: &str,   // "openai" → @ai-sdk/openai；"anthropic" → @ai-sdk/anthropic
    base_url: &str,
    api_key: &str,
) -> AppResult<()>
```

逻辑：
1. 读取 `agent/opencode.json`（不存在则 `{}`）
2. 在 `provider.<provider_id>` 写入：
   ```json
   {
     "npm": "@ai-sdk/openai",
     "options": { "apiKey": "...", "baseURL": "..." }
   }
   ```
3. 序列化写入临时文件 `opencode.json.tmp`，然后 `std::fs::rename` 到 `opencode.json`（原子写入）

在 `create_llm_config` / `update_llm_config` 命令中，当 `config_mode == "custom"` 时调用，再调用 `patch_config(port, &model, &provider_id)` 热更新。

### 2.5 更新 `agent_apply_config` 和 `agent_create_session`

两处均有相同的 `write_opencode_json + patch_config` 模式，都需要改为：

```rust
// config_mode == "custom" 时写入自定义 provider
if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
    if let Err(e) = crate::agent::config::upsert_custom_provider(
        &agent_dir, &cfg.opencode_provider_id, &cfg.api_type, &cfg.base_url, &cfg.api_key,
    ) {
        log::warn!("upsert_custom_provider failed: {}", e);
    }
}
// 两种模式统一用 opencode_provider_id
if let Err(e) = crate::agent::client::patch_config(
    port, &cfg.model, &cfg.opencode_provider_id,
).await {
    log::warn!("patch_config failed: {}", e);
}
```

### 2.6 修复 `create_llm_config` Rust 名称自动填充

当前 fallback 使用 `api_type`，opencode 模式下为空会产生 `"glm-5 · "` 这样的名称。修改为：

```rust
let provider_hint = if !input.opencode_provider_id.is_empty() {
    input.opencode_provider_id.clone()
} else {
    input.api_type.clone()
};
let name = input.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
    format!("{} · {}", input.model, provider_hint)
});
```

前端始终显式传 `name`（自动填充在前端完成），Rust fallback 仅作保底。

### 2.7 注册新命令

在 `lib.rs` 的 `generate_handler![]` 中添加 `commands::agent_list_providers`。

---

## Part 3：前端变更

### 3.1 类型更新（`src/types/index.ts`）

```typescript
export type ConfigMode = 'opencode' | 'custom';

export interface LlmConfig {
  // 现有字段保留，新增：
  opencode_provider_id: string;
  config_mode: ConfigMode;
}

export interface CreateLlmConfigInput {
  name?: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: string;
  opencode_provider_id: string;  // 新增
  config_mode: ConfigMode;       // 新增
  preset?: string | null;
}

// UpdateLlmConfigInput 同步新增两个 optional 字段；is_default 不在此类型中（有单独命令）

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

### 3.2 LlmSettings.tsx 重设计

**新增状态：**
```typescript
const [providers, setProviders] = useState<OpenCodeProvider[]>([]);
const [providersLoading, setProvidersLoading] = useState(false);
const [selectedProviderId, setSelectedProviderId] = useState<string | 'custom'>('');
```

**加载时机：** 弹框打开时调用 `invoke('agent_list_providers')`，失败静默（供应商下拉仅显示"自定义"选项）。

**表单字段顺序（opencode 模式）：**
1. 配置名称（自动填充 `${selectedModel} · ${provider.name}`，用户修改后锁定）
2. 供应商下拉（providers 列表 + "⚙ 自定义供应商" 末尾项）
3. 模型 Combobox（供应商模型列表 + 底部自定义输入框）

**表单字段顺序（自定义模式）：**
1. 配置名称
2. 供应商下拉（显示"⚙ 自定义供应商"已选中）
3. 展开框（Provider ID / API 兼容类型 / Base URL / API Key）
4. 模型文本输入

**测试连接（仅自定义模式）：**
- 无需临时创建 DB 行，新增无状态测试命令 `test_llm_config_inline`
- 接收 `{ model, api_type, base_url, api_key }` 直接测试，不写 DB
- 测试结果仅在表单内显示（badge），保存后写入 DB 的 test_status

**配置名自动填充：**
- opencode 模式：`${selectedModel} · ${provider.name}`
- 自定义模式：`${customProviderId} · ${model}`
- 用户手动修改（`nameTouched = true`）后停止自动覆盖

### 3.3 配置卡片更新

```typescript
const providerLabel = config.config_mode === 'opencode'
  ? (providers.find(p => p.id === config.opencode_provider_id)?.name ?? config.opencode_provider_id)
  : `⚙ 自定义 · ${config.opencode_provider_id || config.api_type}`;
```

---

## Part 4：数据流

### OpenCode 供应商模式

```
用户打开"新建配置"弹框
  └─ invoke('agent_list_providers')
      └─ GET /config/providers → { "providers": [...] }

用户选 "bailian-coding-plan" → 选 "glm-5" → 保存
  └─ invoke('create_llm_config', {
       name: 'glm-5 · Model Studio Coding Plan',
       config_mode: 'opencode',
       opencode_provider_id: 'bailian-coding-plan',
       model: 'glm-5',
       api_key: '', base_url: '', api_type: '',
     })
     → INSERT INTO llm_configs

用户发消息 → agent_chat_inner
  └─ cfg.opencode_provider_id = "bailian-coding-plan", cfg.model = "glm-5"
     → send_message(model_id="glm-5", provider_id="bailian-coding-plan")
     → POST: { model: { modelID: "glm-5", providerID: "bailian-coding-plan" } }
     ✅ opencode 正确路由
```

### 自定义模式

```
用户选"自定义" → 填 provider_id="my-llm", api_type="openai",
  base_url="https://...", api_key="sk-..." → 测试通过 → 保存
  └─ invoke('create_llm_config', { config_mode: 'custom', ... })
     → INSERT INTO llm_configs
     → upsert_custom_provider("my-llm", "openai", ...)
         → opencode.json: { "provider": { "my-llm": { "npm": "@ai-sdk/openai", ... } } }
     → patch_config("gpt-4o", "my-llm")

用户发消息
  └─ send_message(model_id="gpt-4o", provider_id="my-llm")
     ✅ opencode 从 agent/opencode.json 找到 "my-llm"
```

---

## Part 5：错误处理

| 场景 | 处理方式 |
|------|---------|
| `agent_list_providers` opencode 未运行 | 返回空列表 + warn 日志，前端显示"无法获取供应商列表"，只显示"自定义"选项 |
| `upsert_custom_provider` 写文件失败 | warn 日志，不阻塞保存，下次 `agent_apply_config` 时重试 |
| `patch_config` 热更新失败 | warn 日志，配置已入库，重启 opencode serve 后生效 |
| 旧配置（`opencode_provider_id = ""`）发消息 | `provider_opt = None` → `send_message` 不传 model 字段 → opencode 用自身默认配置 |
| `test_llm_config_inline` 连接失败 | 表单内显示红色 badge，不阻止保存 |

---

## Part 6：新增命令汇总

| 命令 | 说明 |
|------|------|
| `agent_list_providers` | GET /config/providers，返回 `Vec<OpenCodeProvider>` |
| `test_llm_config_inline` | 无状态连接测试，接收 `{model, api_type, base_url, api_key}`，不写 DB |

---

## 范围外

- opencode 供应商模式的"测试连接"（无 api_key）
- 供应商列表本地缓存（每次打开弹框实时拉取）
- `api_type` 列的删除（本次保留）
- opencode.json 中 provider `models` 字段配置
- 供应商 `source` 字段的 UI 分组（如"内置供应商" vs "用户配置"）
