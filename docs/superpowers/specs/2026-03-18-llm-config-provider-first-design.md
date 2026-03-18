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

---

## Part 1：DB Schema 变更

### 新增两列

```sql
-- Migration（db/migrations.rs 新增一次迁移）
ALTER TABLE llm_configs ADD COLUMN opencode_provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_configs ADD COLUMN config_mode TEXT NOT NULL DEFAULT 'custom'
  CHECK(config_mode IN ('opencode', 'custom'));
```

**字段语义：**

| 字段 | opencode 模式 | 自定义模式 |
|------|--------------|-----------|
| `opencode_provider_id` | opencode 中的真实 providerID，如 `"bailian-coding-plan"` | 用户自定义，如 `"my-azure-gpt"`，会写入 `agent/opencode.json` |
| `config_mode` | `"opencode"` | `"custom"` |
| `api_type` | 不再使用（保留列，不删除） | 保留：`"openai"` 或 `"anthropic"`，决定写入 opencode.json 时用哪个 npm 包 |
| `api_key_enc` | 空字符串 | AES-256 加密存储 |
| `base_url` | 空字符串 | 用户填写 |

**迁移兼容：** 现有记录 `DEFAULT 'custom'`，`opencode_provider_id` 默认空字符串，行为不变（继续走旧路径）。

---

## Part 2：Rust 变更

### 2.1 新增命令：`agent_list_providers`

```rust
// 返回类型
pub struct OpenCodeProviderModel {
    pub id: String,    // 模型 ID，如 "glm-5"
    pub name: String,  // 显示名称，如 "GLM-5"
}

pub struct OpenCodeProvider {
    pub id: String,       // providerID，如 "bailian-coding-plan"
    pub name: String,     // 显示名，如 "Model Studio Coding Plan"
    pub models: Vec<OpenCodeProviderModel>,
}

#[tauri::command]
pub async fn agent_list_providers(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<OpenCodeProvider>>
```

调用 `GET http://127.0.0.1:{port}/config/providers`，将响应映射为 `Vec<OpenCodeProvider>`。

opencode `/config/providers` 响应格式（基于 `/config` 推断）：
```json
{
  "bailian-coding-plan": {
    "name": "Model Studio Coding Plan",
    "models": {
      "glm-5": { "name": "GLM-5" },
      "qwen3.5-plus": { "name": "Qwen3.5 Plus" }
    }
  }
}
```

Rust 将 map 转为有序 `Vec<OpenCodeProvider>`，model 列表保持原始顺序。

**失败处理：** opencode serve 未运行时返回空列表（不报错），前端降级显示"无法连接到 opencode"提示。

### 2.2 更新 `CreateLlmConfigInput` / `UpdateLlmConfigInput`

```rust
pub struct CreateLlmConfigInput {
    pub name: Option<String>,
    pub api_key: String,              // 自定义模式填写，opencode 模式传空字符串
    pub base_url: String,             // 同上
    pub model: String,
    pub api_type: String,             // 自定义模式：openai | anthropic；opencode 模式：空
    pub opencode_provider_id: String, // 新增
    pub config_mode: String,          // 新增："opencode" | "custom"
    pub preset: Option<String>,
}
// UpdateLlmConfigInput 对应字段改为 Option<String>
```

### 2.3 更新 `agent_chat_inner`：使用 `opencode_provider_id`

```rust
let (model_str, provider_str) = match config_id {
    Some(id) => {
        let cfg = crate::db::get_llm_config_by_id(id)?...;
        (cfg.model, cfg.opencode_provider_id)  // 原: cfg.api_type → 新: cfg.opencode_provider_id
    }
    None => {
        match crate::db::get_default_llm_config()? {
            Some(cfg) => (cfg.model, cfg.opencode_provider_id),
            None => (String::new(), String::new()),
        }
    }
};
```

同样修改 `agent_explain_sql_inner` 和 `agent_optimize_sql_inner`。

### 2.4 自定义供应商写入 `agent/opencode.json`

在 `agent/config.rs` 新增函数：

```rust
/// 将自定义供应商合并写入 agent/opencode.json（不覆盖其他 provider）
pub fn upsert_custom_provider(
    agent_dir: &std::path::Path,
    provider_id: &str,
    api_type: &str,       // "openai" | "anthropic"
    base_url: &str,
    api_key: &str,
) -> AppResult<()>
```

逻辑：
1. 读取现有 `agent/opencode.json`（若不存在则从空对象开始）
2. 在 `provider.<provider_id>` 节点写入：
   ```json
   {
     "npm": "@ai-sdk/openai",         // api_type="openai" → @ai-sdk/openai，"anthropic" → @ai-sdk/anthropic
     "options": {
       "apiKey": "<api_key>",
       "baseURL": "<base_url>"
     }
   }
   ```
3. 写回文件

在 `create_llm_config` / `update_llm_config` 命令中，当 `config_mode == "custom"` 时调用此函数，然后调用 `patch_config(port, &model, &provider_id)` 热更新。

### 2.5 更新 `agent_apply_config`

```rust
// 原：patch_config(port, &cfg.model, &cfg.api_type)
// 新：
if cfg.config_mode == "custom" {
    upsert_custom_provider(&agent_dir, &cfg.opencode_provider_id, &cfg.api_type, &cfg.base_url, &cfg.api_key)?;
}
patch_config(state.serve_port, &cfg.model, &cfg.opencode_provider_id).await?;
```

### 2.6 注册新命令

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
  // 新增：
  opencode_provider_id: string;
  config_mode: ConfigMode;
}

export interface OpenCodeProviderModel {
  id: string;
  name: string;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeProviderModel[];
}
```

### 3.2 LlmSettings.tsx 重设计

**新增状态：**
```typescript
const [providers, setProviders] = useState<OpenCodeProvider[]>([]);
const [providersLoading, setProvidersLoading] = useState(false);
```

**加载时机：** 弹框打开时调用 `invoke('agent_list_providers')`，失败静默（显示"无法获取供应商列表"提示，仍可手动输入）。

**表单字段顺序：**
1. 配置名称（文本输入，自动填充 `<model> · <provider_name>`）
2. 供应商下拉（`OpenCodeProvider[]` + "⚙ 自定义供应商"选项）
3. **若选 opencode 供应商：** 模型 Combobox（供应商模型列表 + 底部自定义输入）
4. **若选自定义：** 展开框（Provider ID / API 兼容类型 / Base URL / API Key）+ 模型文本输入

**配置名自动填充规则：**
- opencode 模式：`${selectedModel} · ${provider.name}`
- 自定义模式：`${customProviderId} · ${model}`
- 用户手动修改后不再自动覆盖

**测试连接：** 仅自定义模式显示，调用现有 `test_llm_config`（需在保存前临时创建配置）。

### 3.3 配置卡片更新

```typescript
// 供应商显示
const providerLabel = config.config_mode === 'opencode'
  ? providerName  // 从 providers 列表查找 opencode_provider_id 对应的 name
  : `⚙ 自定义 · ${config.opencode_provider_id}`;
```

---

## Part 4：数据流

### OpenCode 供应商模式（完整流程）

```
用户打开"新建配置"弹框
  └─ invoke('agent_list_providers')
      └─ GET /config/providers → 返回 providers 列表

用户选择 "bailian-coding-plan" → 选择 "glm-5" → 填写名称 → 保存
  └─ invoke('create_llm_config', {
       config_mode: 'opencode',
       opencode_provider_id: 'bailian-coding-plan',
       model: 'glm-5',
       api_key: '',
       base_url: '',
       api_type: '',
     })
     → INSERT INTO llm_configs ...

用户发送消息（ai_chat → agent_chat_inner）
  └─ 读取 cfg.opencode_provider_id = "bailian-coding-plan"
     读取 cfg.model = "glm-5"
     → send_message(..., model_id="glm-5", provider_id="bailian-coding-plan")
     → POST body: { model: { "modelID": "glm-5", "providerID": "bailian-coding-plan" } }
     ✅ opencode 正确路由到对应 provider
```

### 自定义模式（完整流程）

```
用户选"自定义" → 填写 provider_id="my-azure-gpt", api_type="openai",
  base_url="https://...", api_key="sk-...", model="gpt-4o" → 保存
  └─ invoke('create_llm_config', { config_mode: 'custom', ... })
     → INSERT INTO llm_configs ...
     → upsert_custom_provider("my-azure-gpt", "openai", ...)
         → 写入 agent/opencode.json:
           { "provider": { "my-azure-gpt": { "npm": "@ai-sdk/openai", "options": {...} } } }
     → patch_config("gpt-4o", "my-azure-gpt")

用户发送消息
  └─ send_message(..., model_id="gpt-4o", provider_id="my-azure-gpt")
     ✅ opencode 在 agent/opencode.json 中找到 "my-azure-gpt" provider
```

---

## Part 5：错误处理

| 场景 | 处理方式 |
|------|---------|
| `agent_list_providers` opencode 未运行 | 返回空列表，前端显示提示，供应商下拉仅显示"自定义"选项 |
| 自定义模式写入 `opencode.json` 失败 | `warn` 日志，不阻塞保存，下次 `agent_apply_config` 时重试 |
| `patch_config` 热更新失败 | `warn` 日志，配置已入库，重启 opencode serve 后生效 |
| 现有旧配置（`opencode_provider_id = ""`）发送消息 | `send_message` 的 `provider_opt = None`，不传 model 字段，opencode 使用其默认配置 |

---

## 范围外

- opencode 供应商模式的"测试连接"（无 api_key，测试意义有限）
- 供应商列表缓存/刷新（每次打开弹框实时拉取即可）
- `api_type` 列的删除（本次保留，未来清理）
- opencode.json 中 provider `models` 字段的配置（仅配置 options，模型名直接传）
