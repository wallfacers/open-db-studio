use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::AppResult;

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

    /// 通用对话
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
}
