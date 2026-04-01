<!-- STATUS: ✅ 已实现 -->
# 设计文档：AI 模型配置增强 — 多协议 + 厂商预设

**日期：** 2026-03-11
**状态：** 已批准
**背景：** 阿里云等国内厂商为 Claude Code 等 AI 编程客户端提供兼容 Anthropic 原生 API 的中转服务，现有 LLM 设置仅支持 OpenAI 格式，无法接入此类服务。

---

## 目标

在 open-db-studio 的 AI 模型设置页中，支持：
1. **Anthropic 原生 API 协议**（区别于现有 OpenAI 兼容格式）
2. **厂商预设**（一键填充 base_url / api_type / 推荐模型）

典型用例：用户选择「阿里云百炼」预设，填入 API Key，即可使用 qwen3.5-plus 等模型。

---

## §1 数据模型

### 前端类型（`src/types.ts`）

```typescript
export interface LlmSettings {
  api_key: string;
  base_url: string;
  model: string;
  api_type: 'openai' | 'anthropic';  // 新增
  preset: string | null;             // 新增，null 表示自定义
}
```

默认值：`api_type: 'openai'`，`preset: null`

### Rust 结构体（`src-tauri/src/llm/client.rs`）

```rust
pub enum ApiType { OpenAI, Anthropic }

pub struct LlmClient {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
    api_type: ApiType,  // 新增
}
```

### 厂商预设表（前端硬编码，不入数据库）

| 预设名 | base_url | api_type | 默认模型 |
|--------|----------|----------|----------|
| 阿里云百炼 | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | anthropic | qwen3.5-plus |
| 自定义 | 用户填写 | 用户选择 | 用户填写 |

后续可按需追加其他厂商。

---

## §2 UI 界面

`LlmSettingsPanel` 组件新增布局（从上到下）：

```
厂商预设
  [自定义] [阿里云百炼] ...   ← 点击自动填充下方字段

API 协议
  ● OpenAI 兼容   ○ Anthropic 兼容   ← 预设时自动切换

API Key      [••••••••]
Base URL     [https://...]
模型         [qwen3.5-plus]

[测试连接]  [保存]
```

**交互规则：**
- 选择预设 → 自动填充 `base_url`、`api_type`、`model`，用户可手动覆盖
- 手动修改任意字段 → `preset` 自动重置为 `null`（显示「自定义」）
- `api_type` 切换仅影响 Rust 层请求格式，前端透明

---

## §3 Rust 后端

### 新增 Anthropic 协议实现

```
POST {base_url}/v1/messages
Headers:
  x-api-key: {api_key}
  anthropic-version: 2023-06-01
  content-type: application/json
Body:
  { model, messages, max_tokens: 8192 }
Response:
  content[0].text
```

### chat() 分发逻辑

```rust
pub async fn chat(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
    match self.api_type {
        ApiType::OpenAI    => self.chat_openai(messages).await,
        ApiType::Anthropic => self.chat_anthropic(messages).await,
    }
}
```

`generate_sql()` / `explain_sql()` 无需改动，透明复用 `chat()`。

---

## §4 i18n 新增 Key

| Key | 中文 | English |
|-----|------|---------|
| `llmSettings.preset` | 厂商预设 | Provider Preset |
| `llmSettings.custom` | 自定义 | Custom |
| `llmSettings.alicloud` | 阿里云百炼 | Alibaba Cloud Bailian |
| `llmSettings.apiType` | API 协议 | API Protocol |
| `llmSettings.openaiCompat` | OpenAI 兼容 | OpenAI Compatible |
| `llmSettings.anthropicCompat` | Anthropic 兼容 | Anthropic Compatible |

---

## 不在范围内（YAGNI）

- 其他厂商预设（可后续追加）
- 流式响应（streaming）
- 自动检测 API 格式
- 插件化协议层
