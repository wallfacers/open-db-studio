use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::AppResult;

const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 8192;

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatContext {
    pub history: Vec<ChatMessage>,
    pub model: Option<String>,
}

#[derive(serde::Serialize)]
struct AnthropicRequest {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
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
    pub api_type: ApiType,
}

impl LlmClient {
    pub fn new(
        api_key: String,
        base_url: Option<String>,
        model: Option<String>,
        api_type: Option<ApiType>,
    ) -> Self {
        let resolved_type = api_type.unwrap_or_default();
        let default_base = match resolved_type {
            ApiType::Anthropic => "https://api.anthropic.com",
            ApiType::Openai => "https://api.openai.com/v1",
        };
        Self {
            client: Client::new(),
            api_key,
            base_url: base_url.unwrap_or_else(|| default_base.to_string()),
            model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
            api_type: resolved_type,
        }
    }

    /// 通用对话（OpenAI 协议）
    async fn chat_openai(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
        let req = OpenAIRequest {
            model: self.model.clone(),
            messages,
            stream: false,
        };

        let base = self.base_url.trim_end_matches('/');
        let http_resp = self
            .client
            .post(format!("{}/chat/completions", base))
            .bearer_auth(&self.api_key)
            .json(&req)
            .send()
            .await?;

        if !http_resp.status().is_success() {
            let status = http_resp.status();
            let body = http_resp.text().await.unwrap_or_default();
            return Err(crate::AppError::Llm(format!("HTTP {}: {}", status, body)));
        }

        let resp: OpenAIResponse = http_resp.json().await
            .map_err(|e| crate::AppError::Llm(format!("Failed to parse response: {}", e)))?;

        resp.choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| crate::AppError::Llm("Empty response from LLM".into()))
    }

    async fn chat_anthropic(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
        let mut user_messages: Vec<ChatMessage> = Vec::new();
        let mut system_content: Option<String> = None;
        for msg in messages {
            if msg.role == "system" {
                system_content = Some(msg.content);
            } else {
                user_messages.push(msg);
            }
        }
        let req = AnthropicRequest {
            model: self.model.clone(),
            system: system_content,
            messages: user_messages,
            max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
        };

        let base = self.base_url.trim_end_matches('/');
        let http_resp = self
            .client
            .post(format!("{}/v1/messages", base))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("user-agent", "claude-code/1.0.0")
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

    /// 自然语言 → SQL
    pub async fn generate_sql(
        &self,
        user_prompt: &str,
        schema_context: &str,
        sql_dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/sql_generate.txt")
            .replace("{{DIALECT}}", sql_dialect)
            .replace("{{SCHEMA}}", schema_context);

        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: user_prompt.to_string() },
        ];

        self.chat(messages).await
    }

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

    /// AI 优化 SQL（已有 prompt 文件）
    pub async fn optimize_sql(
        &self,
        sql: &str,
        schema_context: &str,
        dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/sql_optimize.txt")
            .replace("{{DIALECT}}", dialect)
            .replace("{{SCHEMA}}", schema_context);
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: sql.to_string() },
        ];
        self.chat(messages).await
    }

    /// AI 建表
    pub async fn create_table_ddl(
        &self,
        description: &str,
        dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/sql_create_table.txt")
            .replace("{{DIALECT}}", dialect);
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: description.to_string() },
        ];
        self.chat(messages).await
    }

    /// AI 错误诊断
    pub async fn diagnose_error(
        &self,
        sql: &str,
        error_msg: &str,
        schema_context: &str,
        dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/sql_diagnose.txt")
            .replace("{{DIALECT}}", dialect)
            .replace("{{SCHEMA}}", schema_context)
            .replace("{{SQL}}", sql)
            .replace("{{ERROR}}", error_msg);
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: "请诊断此错误".to_string() },
        ];
        self.chat(messages).await
    }
}
