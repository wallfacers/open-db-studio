<!-- STATUS: ✅ 已实现 -->
# AI 模型多协议 + 厂商预设 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 LLM 设置中支持 Anthropic 原生 API 协议，并新增厂商预设（阿里云百炼等），让用户一键接入国内 coding plan 服务。

**Architecture:** Rust 层 `LlmClient` 新增 `ApiType` 枚举和 `chat_anthropic()` 方法，`chat()` 按协议分发；前端 `LlmSettings` 类型新增 `api_type` / `preset` 字段；设置页新增厂商预设按钮组 + API 协议单选。

**Tech Stack:** Rust (reqwest), React 18 + TypeScript, Tauri invoke, i18next

---

### Task 1: Rust — 扩展 LlmClient 支持 Anthropic 协议

**Files:**
- Modify: `src-tauri/src/llm/client.rs`

**Step 1: 在文件顶部新增 ApiType 枚举和 Anthropic 响应结构体**

在 `src-tauri/src/llm/client.rs` 第 1 行之后，在现有结构体前添加：

```rust
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiType {
    #[default]
    Openai,
    Anthropic,
}

#[derive(Debug, serde::Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContentBlock>,
}
```

**Step 2: 给 LlmClient 结构体新增 api_type 字段**

将现有：
```rust
pub struct LlmClient {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
}
```
改为：
```rust
pub struct LlmClient {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
    pub api_type: ApiType,
}
```

**Step 3: 更新 new() 构造函数签名，增加 api_type 参数**

将：
```rust
pub fn new(api_key: String, base_url: Option<String>, model: Option<String>) -> Self {
    Self {
        client: Client::new(),
        api_key,
        base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
    }
}
```
改为：
```rust
pub fn new(
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
    api_type: Option<ApiType>,
) -> Self {
    Self {
        client: Client::new(),
        api_key,
        base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
        api_type: api_type.unwrap_or_default(),
    }
}
```

**Step 4: 将现有 chat() 方法重命名为 chat_openai()，并新增 chat_anthropic() 和新的 chat() 分发方法**

将现有 `pub async fn chat(...)` 方法名改为 `chat_openai`（保持方法体不变），然后在其下方添加：

```rust
async fn chat_anthropic(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
    #[derive(serde::Serialize)]
    struct AnthropicRequest {
        model: String,
        messages: Vec<ChatMessage>,
        max_tokens: u32,
    }

    let req = AnthropicRequest {
        model: self.model.clone(),
        messages,
        max_tokens: 8192,
    };

    let base = self.base_url.trim_end_matches('/');
    let http_resp = self
        .client
        .post(format!("{}/v1/messages", base))
        .header("x-api-key", &self.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&req)
        .send()
        .await?;

    if !http_resp.status().is_success() {
        let status = http_resp.status();
        let body = http_resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Llm(format!("HTTP {}: {}", status, body)));
    }

    let resp: AnthropicResponse = http_resp
        .json()
        .await
        .map_err(|e| crate::AppError::Llm(format!("Failed to parse Anthropic response: {}", e)))?;

    resp.content
        .into_iter()
        .find(|b| b.block_type == "text")
        .and_then(|b| b.text)
        .ok_or_else(|| crate::AppError::Llm("Empty response from Anthropic LLM".into()))
}

pub async fn chat(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
    match self.api_type {
        ApiType::Openai => self.chat_openai(messages).await,
        ApiType::Anthropic => self.chat_anthropic(messages).await,
    }
}
```

**Step 5: Rust 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过，无 error

**Step 6: 提交**

```bash
git add src-tauri/src/llm/client.rs
git commit -m "feat(llm): add Anthropic API protocol support to LlmClient"
```

---

### Task 2: Rust — 更新 commands.rs 传递 api_type

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Step 1: 更新 LlmSettings 结构体新增 api_type 字段**

找到（约第 127 行）：
```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct LlmSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}
```
改为：
```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct LlmSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_type: crate::llm::ApiType,
}
```

**Step 2: 更新 build_llm_client() 读取 api_type 并传给 LlmClient::new()**

找到（约第 86 行）：
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
改为：
```rust
fn build_llm_client() -> AppResult<crate::llm::client::LlmClient> {
    let api_key_enc = crate::db::get_setting("llm.api_key")?
        .ok_or_else(|| AppError::Llm("LLM API Key not configured. Please set it in Settings.".into()))?;
    let api_key = crate::crypto::decrypt(&api_key_enc)?;
    let base_url = crate::db::get_setting("llm.base_url")?;
    let model = crate::db::get_setting("llm.model")?;
    let api_type = crate::db::get_setting("llm.api_type")?
        .and_then(|v| serde_json::from_str::<crate::llm::ApiType>(&format!("\"{}\"", v)).ok());
    Ok(crate::llm::client::LlmClient::new(api_key, base_url, model, api_type))
}
```

**Step 3: 更新 get_llm_settings() 返回 api_type**

找到 `get_llm_settings` 函数，将返回块改为：
```rust
Ok(LlmSettings {
    api_key,
    base_url: crate::db::get_setting("llm.base_url")?
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
    model: crate::db::get_setting("llm.model")?
        .unwrap_or_else(|| "gpt-4o-mini".to_string()),
    api_type: crate::db::get_setting("llm.api_type")?
        .and_then(|v| serde_json::from_str::<crate::llm::ApiType>(&format!("\"{}\"", v)).ok())
        .unwrap_or_default(),
})
```

**Step 4: 更新 set_llm_settings() 持久化 api_type**

在 `set_llm_settings` 函数末尾的 `Ok(())` 前添加：
```rust
let api_type_str = match settings.api_type {
    crate::llm::ApiType::Openai => "openai",
    crate::llm::ApiType::Anthropic => "anthropic",
};
crate::db::set_setting("llm.api_type", api_type_str)?;
```

**Step 5: 更新 test_llm_connection() 传入 api_type**

将：
```rust
let client = crate::llm::client::LlmClient::new(
    settings.api_key,
    Some(settings.base_url),
    Some(settings.model),
);
```
改为：
```rust
let client = crate::llm::client::LlmClient::new(
    settings.api_key,
    Some(settings.base_url),
    Some(settings.model),
    Some(settings.api_type),
);
```

**Step 6: Rust 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: 编译通过，无 error

**Step 7: 提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): propagate api_type through LLM settings and client creation"
```

---

### Task 3: 前端 — 更新类型定义

**Files:**
- Modify: `src/types/index.ts`

**Step 1: 在 LlmSettings 接口新增两个字段**

找到：
```typescript
export interface LlmSettings {
  api_key: string;
  base_url: string;
  model: string;
}
```
改为：
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

**Step 2: 更新 aiStore.ts 中默认设置的初始值**

打开 `src/store/aiStore.ts`，找到 `LlmSettings` form 初始状态使用处（组件里），不需要改 store，store 只透传类型。

检查 TypeScript 编译：
```bash
npx tsc --noEmit
```
Expected: 可能有报错（LlmSettings 使用处缺 api_type 字段），记录错误位置，Task 4 解决。

**Step 3: 提交**

```bash
git add src/types/index.ts
git commit -m "feat(types): add api_type and preset fields to LlmSettings"
```

---

### Task 4: 前端 — 重写 LlmSettingsPanel 组件

**Files:**
- Modify: `src/components/Settings/LlmSettings.tsx`

**Step 1: 在文件顶部添加预设厂商配置表**

在 import 语句后、组件函数前添加：

```typescript
import type { ApiType } from '../../types';

interface ProviderPreset {
  id: string;
  labelKey: string;
  base_url: string;
  api_type: ApiType;
  default_model: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'alicloud',
    labelKey: 'llmSettings.alicloud',
    base_url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    api_type: 'anthropic',
    default_model: 'qwen3.5-plus',
  },
];
```

**Step 2: 更新组件 form 默认值，加入新字段**

将：
```typescript
const [form, setForm] = useState<LlmSettings>({
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
});
```
改为：
```typescript
const [form, setForm] = useState<LlmSettings>({
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  api_type: 'openai',
  preset: null,
});
```

**Step 3: 在 useEffect 同步 settings 时兼容旧数据（没有 api_type 的情况）**

将：
```typescript
useEffect(() => {
  if (settings) setForm(settings);
}, [settings]);
```
改为：
```typescript
useEffect(() => {
  if (settings) {
    setForm({
      ...settings,
      api_type: settings.api_type ?? 'openai',
      preset: settings.preset ?? null,
    });
  }
}, [settings]);
```

**Step 4: 添加预设选择处理函数**

在 `handleTest` 函数之后添加：

```typescript
const handlePresetSelect = (preset: ProviderPreset | null) => {
  if (preset === null) {
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

const handleFieldChange = <K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) => {
  setForm((f) => ({ ...f, [key]: value, preset: null }));
};
```

**Step 5: 替换 JSX 返回内容**

将整个 `return (...)` 块替换为：

```tsx
return (
  <div className="w-full max-w-lg">
    <div className="p-8 space-y-4">
      <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">
        {t('llmSettings.aiModelConfig')}
      </h3>

      {/* 厂商预设 */}
      <div>
        <label className={labelClass}>{t('llmSettings.preset')}</label>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handlePresetSelect(null)}
            className={`px-3 py-1 text-xs rounded border transition-colors ${
              form.preset === null
                ? 'bg-[#009e84] border-[#009e84] text-white'
                : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'
            }`}
          >
            {t('llmSettings.custom')}
          </button>
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => handlePresetSelect(p)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                form.preset === p.id
                  ? 'bg-[#009e84] border-[#009e84] text-white'
                  : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'
              }`}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* API 协议 */}
      <div>
        <label className={labelClass}>{t('llmSettings.apiType')}</label>
        <div className="flex gap-4">
          {(['openai', 'anthropic'] as ApiType[]).map((type) => (
            <label key={type} className="flex items-center gap-1.5 cursor-pointer text-sm text-[#c8daea]">
              <input
                type="radio"
                name="api_type"
                value={type}
                checked={form.api_type === type}
                onChange={() => handleFieldChange('api_type', type)}
                className="accent-[#009e84]"
              />
              {type === 'openai' ? t('llmSettings.openaiCompat') : t('llmSettings.anthropicCompat')}
            </label>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div>
        <label className={labelClass}>{t('llmSettings.apiKey')}</label>
        <PasswordInput
          className={inputClass}
          value={form.api_key}
          onChange={(v) => handleFieldChange('api_key', v)}
          placeholder="sk-..."
        />
      </div>

      {/* Base URL */}
      <div>
        <label className={labelClass}>{t('llmSettings.baseUrl')}</label>
        <input
          className={inputClass}
          value={form.base_url}
          onChange={(e) => handleFieldChange('base_url', e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </div>

      {/* 模型 */}
      <div>
        <label className={labelClass}>{t('llmSettings.model')}</label>
        <input
          className={inputClass}
          value={form.model}
          onChange={(e) => handleFieldChange('model', e.target.value)}
          placeholder="gpt-4o-mini"
        />
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleTest}
          disabled={testStatus === 'testing' || !form.api_key}
          className="px-4 py-1.5 text-sm border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1.5"
        >
          {testStatus === 'testing' && <Loader2 size={13} className="animate-spin" />}
          {testStatus === 'success' && <CheckCircle size={13} className="text-green-400" />}
          {testStatus === 'fail' && <XCircle size={13} className="text-red-400" />}
          {testStatus === 'testing' ? t('llmSettings.testing') : t('llmSettings.testConnection')}
        </button>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50"
        >
          {saved ? t('llmSettings.saved') : saving ? t('llmSettings.saving') : t('llmSettings.save')}
        </button>
      </div>

      {testStatus === 'success' && (
        <p className="text-xs text-green-400 flex items-center gap-1">
          <CheckCircle size={12} /> {t('llmSettings.testSuccess')}
        </p>
      )}
      {testStatus === 'fail' && testError && (
        <p className="text-xs text-red-400 flex items-center gap-1 break-all">
          <XCircle size={12} className="flex-shrink-0" /> {testError}
        </p>
      )}

      <p className="text-xs text-[#7a9bb8] pt-2">{t('llmSettings.supportInfo')}</p>
    </div>
  </div>
);
```

**Step 6: TypeScript 类型检查**

```bash
npx tsc --noEmit
```
Expected: 无报错

**Step 7: 提交**

```bash
git add src/components/Settings/LlmSettings.tsx
git commit -m "feat(ui): add provider presets and api_type selector to LLM settings"
```

---

### Task 5: i18n — 新增中英文翻译 Key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

**Step 1: 更新 zh.json — 在 llmSettings 节点新增 key**

在 `llmSettings` 对象（约第 134 行）末尾，`"supportInfo"` 行之后添加：

```json
"preset": "厂商预设",
"custom": "自定义",
"alicloud": "阿里云百炼",
"apiType": "API 协议",
"openaiCompat": "OpenAI 兼容",
"anthropicCompat": "Anthropic 兼容"
```

同时将 `supportInfo` 更新为：
```json
"supportInfo": "支持 OpenAI 兼容接口及 Anthropic 原生接口（阿里云百炼、Claude 代理等）。API Key 使用 AES-256-GCM 加密存储在本地。"
```

**Step 2: 更新 en.json — 在 llmSettings 节点新增 key**

打开 `src/i18n/locales/en.json`，在 `llmSettings` 对象 `supportInfo` 之后添加：

```json
"preset": "Provider Preset",
"custom": "Custom",
"alicloud": "Alibaba Cloud Bailian",
"apiType": "API Protocol",
"openaiCompat": "OpenAI Compatible",
"anthropicCompat": "Anthropic Compatible"
```

同时将英文 `supportInfo` 更新为：
```json
"supportInfo": "Supports OpenAI-compatible and Anthropic native API (Alibaba Cloud Bailian, Claude proxies, etc.). API Key is encrypted with AES-256-GCM locally."
```

**Step 3: 验证 JSON 格式正确**

```bash
node -e "require('./src/i18n/locales/zh.json'); require('./src/i18n/locales/en.json'); console.log('JSON valid')"
```
Expected: `JSON valid`

**Step 4: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 无报错

**Step 5: 提交**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(i18n): add translations for provider presets and api_type selector"
```

---

### Task 6: 手动验证

**Step 1: 启动前端开发服务器**

```bash
npm run dev
```

在浏览器打开 `http://localhost:1420`，导航到「设置 → AI 模型」。

**验证清单：**
- [ ] 页面显示「厂商预设」按钮组：「自定义」和「阿里云百炼」
- [ ] 点击「阿里云百炼」→ base_url 自动填充为 `https://coding.dashscope.aliyuncs.com/apps/anthropic`，api_type 切换为「Anthropic 兼容」，model 填充为 `qwen3.5-plus`
- [ ] 点击「自定义」→ 预设高亮切回「自定义」
- [ ] 手动修改 base_url → 预设自动切回「自定义」
- [ ] 点击「保存」→ 刷新页面，设置持久化正确

**Step 2: 如有阿里云 API Key，测试真实连接**

填入阿里云百炼 API Key，点击「测试连接」，Expected: 显示「连接成功」绿色提示。

**Step 3: 全量 Rust + TS 检查**

```bash
npx tsc --noEmit && cd src-tauri && cargo check
```
Expected: 均通过

**Step 4: 最终提交（如有未提交内容）**

```bash
git status
# 确认干净后无需操作
```
