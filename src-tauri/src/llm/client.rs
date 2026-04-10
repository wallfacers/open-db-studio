use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::AppResult;
use futures_util::StreamExt;
use tauri::ipc::Channel;
use once_cell::sync::Lazy;

/// 全局共享 HTTP 客户端，避免每次请求重新初始化 TLS
static SHARED_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|e| {
            log::warn!("[llm] Failed to build HTTP client: {}, falling back to default", e);
            Client::new()
        })
});

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamEvent {
    ThinkingChunk { delta: String },
    ContentChunk   { delta: String },
    ToolCallRequest { call_id: String, name: String, arguments: String },
    QuestionRequest {
        question_id: String,
        session_id: String,
        questions: serde_json::Value,
    },
    Done,
    Error { message: String },
}

/// OpenAI tool definition（从前端传入）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Agent 对话消息（支持 tool_calls / tool result）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AgentToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: AgentToolCallFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolCallFunction {
    pub name: String,
    pub arguments: String,
}

/// AI 建表返回的单列定义
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiColumnDef {
    pub name: String,
    pub column_type: String,
    pub length: Option<u32>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: String,
}

/// AI 建表返回的完整表结构
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableSchemaResult {
    pub table_name: String,
    pub columns: Vec<AiColumnDef>,
}

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

/// Parameter overrides for LLM calls (used by inline completion)
#[derive(Default)]
pub struct ChatParams {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// OpenAI: maps to "stop" field. Anthropic: maps to "stop_sequences" field.
    pub stop: Option<Vec<String>>,
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
        let raw_base = base_url.filter(|b| !b.is_empty()).unwrap_or_else(|| default_base.to_string());
        // 规范化 base_url：去掉末尾斜杠，Anthropic 类型去掉末尾 /v1 防止拼出 /v1/v1/messages
        let base_url = {
            let trimmed = raw_base.trim_end_matches('/');
            match resolved_type {
                ApiType::Anthropic if trimmed.ends_with("/v1") => {
                    trimmed[..trimmed.len() - 3].to_string()
                }
                _ => raw_base,
            }
        };
        Self {
            client: SHARED_CLIENT.clone(),
            api_key,
            base_url,
            model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
            api_type: resolved_type,
        }
    }

    /// OpenAI 协议对话，支持可选参数覆盖
    async fn chat_openai(&self, messages: Vec<ChatMessage>, params: Option<ChatParams>) -> AppResult<String> {
        let base = self.base_url.trim_end_matches('/');

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
        });

        if let Some(p) = params {
            if let Some(temp) = p.temperature {
                body["temperature"] = serde_json::json!(temp);
            }
            if let Some(max_tok) = p.max_tokens {
                body["max_tokens"] = serde_json::json!(max_tok);
            }
            if let Some(stop) = p.stop {
                body["stop"] = serde_json::json!(stop);
            }
        }

        let url = format!("{}/chat/completions", base);
        log::debug!("[llm] POST {} model={}", url, self.model);
        let t0 = std::time::Instant::now();

        let http_resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("x-agent", "true")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                log::warn!("[llm] request failed after {:?}: {}", t0.elapsed(), e);
                e
            })?;

        log::debug!("[llm] response {} in {:?}", http_resp.status(), t0.elapsed());

        if !http_resp.status().is_success() {
            let status = http_resp.status();
            let body_text = http_resp.text().await.unwrap_or_default();
            return Err(crate::AppError::Llm(format!("HTTP {}: {}", status, body_text)));
        }

        let resp: OpenAIResponse = http_resp.json().await
            .map_err(|e| crate::AppError::Llm(format!("Failed to parse response: {}", e)))?;

        resp.choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| crate::AppError::Llm("Empty response from LLM".into()))
    }

    /// Anthropic 协议对话，支持可选参数覆盖
    async fn chat_anthropic(&self, messages: Vec<ChatMessage>, params: Option<ChatParams>) -> AppResult<String> {
        let mut user_messages: Vec<ChatMessage> = Vec::new();
        let mut system_content: Option<String> = None;
        for msg in messages {
            if msg.role == "system" {
                system_content = Some(msg.content);
            } else {
                user_messages.push(msg);
            }
        }

        let max_tokens = params.as_ref()
            .and_then(|p| p.max_tokens)
            .unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS);

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": user_messages,
            "max_tokens": max_tokens,
        });

        if let Some(system) = system_content {
            body["system"] = serde_json::json!(system);
        }
        if let Some(p) = params {
            if let Some(temp) = p.temperature {
                body["temperature"] = serde_json::json!(temp);
            }
            if let Some(stop_seqs) = p.stop {
                body["stop_sequences"] = serde_json::json!(stop_seqs);
            }
            // 当 max_tokens 较小时（inline complete 等轻量场景），
            // 显式禁用深度思考以加速响应
            if p.max_tokens.map_or(false, |t| t <= 200) {
                body["thinking"] = serde_json::json!({"type": "disabled"});
            }
        }

        let base = self.base_url.trim_end_matches('/');
        let url = format!("{}/v1/messages", base);
        log::debug!("[llm] POST {} model={}", url, self.model);
        let t0 = std::time::Instant::now();

        let http_resp = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("user-agent", "claude-code/1.0.0")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                log::warn!("[llm] request failed after {:?}: {}", t0.elapsed(), e);
                e
            })?;

        log::debug!("[llm] response {} in {:?}", http_resp.status(), t0.elapsed());

        if !http_resp.status().is_success() {
            let status = http_resp.status();
            let body_text = http_resp.text().await.unwrap_or_default();
            return Err(crate::AppError::Llm(format!("HTTP {}: {}", status, body_text)));
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
            ApiType::Openai => self.chat_openai(messages, None).await,
            ApiType::Anthropic => self.chat_anthropic(messages, None).await,
        }
    }

    pub async fn chat_with_params(&self, messages: Vec<ChatMessage>, params: ChatParams) -> AppResult<String> {
        match self.api_type {
            ApiType::Openai => self.chat_openai(messages, Some(params)).await,
            ApiType::Anthropic => self.chat_anthropic(messages, Some(params)).await,
        }
    }

    pub async fn inline_complete(&self, prompt: String, hint: &str) -> AppResult<String> {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: prompt,
        }];
        let max_tokens = match hint {
            "single_line" => 60,
            _ => 200,
        };
        // NOTE: 部分兼容接口（如 DashScope）不支持 stop/stop_sequences，
        // 改用 prompt 指令 + max_tokens 控制生成长度
        self.chat_with_params(messages, ChatParams {
            temperature: Some(0.1),
            max_tokens: Some(max_tokens),
            stop: None,
        }).await
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
        let system_prompt = include_str!("../../../prompts/sql_analyze.txt")
            .replace("{{DIALECT}}", sql_dialect)
            .replace("{{SCHEMA}}", "(not provided)")
            .replace("{{SQL}}", sql)
            .replace("{{ERROR}}", "(none)")
            .replace("{{MODE}}", "explain");

        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: "Please explain.".to_string() },
        ];
        self.chat(messages).await
    }

    /// AI 建表
    pub async fn create_table_ddl(
        &self,
        description: &str,
        dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/generate_table_schema.txt")
            .replace("{{DRIVER}}", dialect)
            .replace("{{OUTPUT}}", "sql")
            .replace("{{TYPE_ENUM}}", "")
            .replace("{{DESCRIPTION}}", description);
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: "Generate the CREATE TABLE DDL.".to_string() },
        ];
        self.chat(messages).await
    }

    /// AI 建表 — 返回结构化字段数组（供 TableManageDialog 填充）
    pub async fn generate_table_schema(
        &self,
        description: &str,
        driver: &str,
    ) -> AppResult<TableSchemaResult> {
        let type_enum = match driver {
            "postgres" | "postgresql" => {
                "INTEGER, BIGINT, SMALLINT, VARCHAR, TEXT, TIMESTAMP, DATE, NUMERIC, BOOLEAN, BYTEA, UUID, JSONB, SERIAL"
            }
            _ => {
                "INT, BIGINT, TINYINT, SMALLINT, VARCHAR, TEXT, LONGTEXT, DATETIME, DATE, TIMESTAMP, DECIMAL, FLOAT, DOUBLE, BOOLEAN, BLOB"
            }
        };

        let system_prompt = include_str!("../../../prompts/generate_table_schema.txt")
            .replace("{{DRIVER}}", driver)
            .replace("{{TYPE_ENUM}}", type_enum)
            .replace("{{DESCRIPTION}}", description);

        // description 已嵌入 system_prompt，user 消息使用固定触发语避免重复
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: "Generate table schema.".to_string() },
        ];

        // 第一次尝试
        let raw = self.chat(messages.clone()).await?;
        if let Ok(result) = serde_json::from_str::<TableSchemaResult>(&raw) {
            if !result.columns.is_empty() {
                return Ok(result);
            }
        }

        // 自动重试一次
        log::warn!("[generate_table_schema] First attempt returned invalid JSON, retrying...");
        let raw2 = self.chat(messages).await?;
        serde_json::from_str::<TableSchemaResult>(&raw2)
            .map_err(|e| crate::AppError::Other(
                format!("AI returned invalid JSON format, please try again. Detail: {e}")
            ))
    }

    /// AI 错误诊断
    pub async fn diagnose_error(
        &self,
        sql: &str,
        error_msg: &str,
        schema_context: &str,
        dialect: &str,
    ) -> AppResult<String> {
        let system_prompt = include_str!("../../../prompts/sql_analyze.txt")
            .replace("{{DIALECT}}", dialect)
            .replace("{{SCHEMA}}", schema_context)
            .replace("{{SQL}}", sql)
            .replace("{{ERROR}}", error_msg)
            .replace("{{MODE}}", "diagnose");
        let messages = vec![
            ChatMessage { role: "system".into(), content: system_prompt },
            ChatMessage { role: "user".into(), content: "请诊断此错误".to_string() },
        ];
        self.chat(messages).await
    }

    pub async fn chat_stream_openai(
        &self,
        messages: Vec<ChatMessage>,
        channel: &Channel<StreamEvent>,
    ) -> AppResult<()> {
        #[derive(serde::Serialize)]
        struct StreamReq {
            model: String,
            messages: Vec<ChatMessage>,
            stream: bool,
        }
        #[derive(serde::Deserialize, Default)]
        struct Delta {
            content: Option<String>,
            reasoning_content: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Choice { delta: Delta }
        #[derive(serde::Deserialize)]
        struct Chunk { choices: Vec<Choice> }

        let req = StreamReq { model: self.model.clone(), messages, stream: true };
        let base = self.base_url.trim_end_matches('/');
        let resp = self.client
            .post(format!("{}/chat/completions", base))
            .bearer_auth(&self.api_key)
            .json(&req)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let _ = channel.send(StreamEvent::Error { message: format!("HTTP {}: {}", status, body) });
            return Ok(());
        }

        let mut in_thinking = false;
        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(b) => b,
                Err(e) => {
                    let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                    return Ok(());
                }
            };

            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let line = line.trim();
                if !line.starts_with("data:") { continue; }
                let json_str = line["data:".len()..].trim();
                if json_str == "[DONE]" {
                    let _ = channel.send(StreamEvent::Done);
                    return Ok(());
                }
                let chunk: Chunk = match serde_json::from_str(json_str) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                for choice in chunk.choices {
                    if let Some(rc) = choice.delta.reasoning_content {
                        if !rc.is_empty() {
                            let _ = channel.send(StreamEvent::ThinkingChunk { delta: rc });
                        }
                    }
                    if let Some(content) = choice.delta.content {
                        if content.is_empty() { continue; }
                        let mut remaining = content.as_str();
                        loop {
                            if in_thinking {
                                if let Some(pos) = remaining.find("</think>") {
                                    let thinking_part = &remaining[..pos];
                                    if !thinking_part.is_empty() {
                                        let _ = channel.send(StreamEvent::ThinkingChunk { delta: thinking_part.to_string() });
                                    }
                                    in_thinking = false;
                                    remaining = &remaining[pos + "</think>".len()..];
                                } else {
                                    let _ = channel.send(StreamEvent::ThinkingChunk { delta: remaining.to_string() });
                                    break;
                                }
                            } else {
                                if let Some(pos) = remaining.find("<think>") {
                                    let normal_part = &remaining[..pos];
                                    if !normal_part.is_empty() {
                                        let _ = channel.send(StreamEvent::ContentChunk { delta: normal_part.to_string() });
                                    }
                                    in_thinking = true;
                                    remaining = &remaining[pos + "<think>".len()..];
                                } else {
                                    let _ = channel.send(StreamEvent::ContentChunk { delta: remaining.to_string() });
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = channel.send(StreamEvent::Done);
        Ok(())
    }

    pub async fn chat_stream_anthropic(
        &self,
        messages: Vec<ChatMessage>,
        channel: &Channel<StreamEvent>,
    ) -> AppResult<()> {
        let mut user_messages: Vec<ChatMessage> = Vec::new();
        let mut system_content: Option<String> = None;
        for msg in messages {
            if msg.role == "system" { system_content = Some(msg.content); }
            else { user_messages.push(msg); }
        }

        #[derive(serde::Serialize)]
        struct Req {
            model: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            system: Option<String>,
            messages: Vec<ChatMessage>,
            max_tokens: u32,
            stream: bool,
        }

        let req = Req {
            model: self.model.clone(),
            system: system_content,
            messages: user_messages,
            max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
            stream: true,
        };

        let base = self.base_url.trim_end_matches('/');
        let resp = self.client
            .post(format!("{}/v1/messages", base))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("user-agent", "open-db-studio/1.0")
            .json(&req)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let _ = channel.send(StreamEvent::Error { message: format!("HTTP {}: {}", status, body) });
            return Ok(());
        }

        let mut current_block_type = String::new();
        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(b) => b,
                Err(e) => {
                    let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                    return Ok(());
                }
            };

            let text = String::from_utf8_lossy(&bytes);
            let mut event_type = String::new();

            for line in text.lines() {
                let line = line.trim();
                if line.starts_with("event:") {
                    event_type = line["event:".len()..].trim().to_string();
                } else if line.starts_with("data:") {
                    let json_str = line["data:".len()..].trim();
                    let v: serde_json::Value = match serde_json::from_str(json_str) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    match event_type.as_str() {
                        "content_block_start" => {
                            current_block_type = v["content_block"]["type"]
                                .as_str().unwrap_or("").to_string();
                        }
                        "content_block_delta" => {
                            let delta_type = v["delta"]["type"].as_str().unwrap_or("");
                            let text_val = match delta_type {
                                "thinking_delta" => v["delta"]["thinking"].as_str().unwrap_or(""),
                                "text_delta"     => v["delta"]["text"].as_str().unwrap_or(""),
                                _ => "",
                            };
                            if !text_val.is_empty() {
                                let evt = if current_block_type == "thinking" {
                                    StreamEvent::ThinkingChunk { delta: text_val.to_string() }
                                } else {
                                    StreamEvent::ContentChunk { delta: text_val.to_string() }
                                };
                                let _ = channel.send(evt);
                            }
                        }
                        "message_stop" => {
                            let _ = channel.send(StreamEvent::Done);
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
        let _ = channel.send(StreamEvent::Done);
        Ok(())
    }

    pub async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        channel: &Channel<StreamEvent>,
    ) -> AppResult<()> {
        match self.api_type {
            ApiType::Openai    => self.chat_stream_openai(messages, channel).await,
            ApiType::Anthropic => self.chat_stream_anthropic(messages, channel).await,
        }
    }

    pub async fn chat_stream_with_tools_openai(
        &self,
        messages: Vec<AgentMessage>,
        tools: Vec<ToolDefinition>,
        channel: &Channel<StreamEvent>,
    ) -> AppResult<()> {
        #[derive(serde::Serialize)]
        struct FunctionDef<'a> {
            name: &'a str,
            description: &'a str,
            parameters: &'a serde_json::Value,
        }
        #[derive(serde::Serialize)]
        struct OpenAITool<'a> {
            #[serde(rename = "type")]
            tool_type: &'static str,
            function: FunctionDef<'a>,
        }
        #[derive(serde::Serialize)]
        struct StreamReq<'a> {
            model: String,
            messages: &'a Vec<AgentMessage>,
            tools: Vec<OpenAITool<'a>>,
            stream: bool,
        }

        let openai_tools: Vec<OpenAITool> = tools.iter().map(|t| OpenAITool {
            tool_type: "function",
            function: FunctionDef {
                name: &t.name,
                description: &t.description,
                parameters: &t.parameters,
            },
        }).collect();

        // 将 system 消息提取并强制置顶，防止历史截断时丢失系统提示词
        let mut system_msgs: Vec<AgentMessage> = Vec::new();
        let mut other_msgs: Vec<AgentMessage> = Vec::new();
        for msg in messages {
            if msg.role == "system" { system_msgs.push(msg); }
            else { other_msgs.push(msg); }
        }
        let ordered_messages: Vec<AgentMessage> = system_msgs.into_iter().chain(other_msgs).collect();

        let req = StreamReq {
            model: self.model.clone(),
            messages: &ordered_messages,
            tools: openai_tools,
            stream: true,
        };

        let base = self.base_url.trim_end_matches('/');
        let resp = self.client
            .post(format!("{}/chat/completions", base))
            .bearer_auth(&self.api_key)
            .json(&req)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let _ = channel.send(StreamEvent::Error { message: format!("HTTP {}: {}", status, body) });
            return Ok(());
        }

        // Accumulate tool_calls (may span multiple chunks)
        let mut tool_calls_acc: Vec<(String, String, String)> = Vec::new(); // (id, name, arguments)
        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(b) => b,
                Err(e) => {
                    let _ = channel.send(StreamEvent::Error { message: e.to_string() });
                    return Ok(());
                }
            };

            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let line = line.trim();
                if !line.starts_with("data:") { continue; }
                let json_str = line["data:".len()..].trim();
                if json_str == "[DONE]" {
                    // Send accumulated tool calls then Done
                    for (id, name, args) in &tool_calls_acc {
                        if !name.is_empty() {
                            let _ = channel.send(StreamEvent::ToolCallRequest {
                                call_id: id.clone(),
                                name: name.clone(),
                                arguments: args.clone(),
                            });
                        }
                    }
                    let _ = channel.send(StreamEvent::Done);
                    return Ok(());
                }
                let v: serde_json::Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Accumulate tool_calls delta
                if let Some(tool_calls) = v["choices"][0]["delta"]["tool_calls"].as_array() {
                    for tc in tool_calls {
                        let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                        while tool_calls_acc.len() <= idx {
                            tool_calls_acc.push((String::new(), String::new(), String::new()));
                        }
                        if let Some(id) = tc["id"].as_str() {
                            tool_calls_acc[idx].0 = id.to_string();
                        }
                        if let Some(name) = tc["function"]["name"].as_str() {
                            tool_calls_acc[idx].1 = name.to_string();
                        }
                        if let Some(args) = tc["function"]["arguments"].as_str() {
                            tool_calls_acc[idx].2.push_str(args);
                        }
                    }
                }

                // Handle normal content delta (text response, no tool calls)
                if let Some(content) = v["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        let _ = channel.send(StreamEvent::ContentChunk { delta: content.to_string() });
                    }
                }
            }
        }

        // Stream ended without [DONE], send any accumulated tool calls
        for (id, name, args) in &tool_calls_acc {
            if !name.is_empty() {
                let _ = channel.send(StreamEvent::ToolCallRequest {
                    call_id: id.clone(),
                    name: name.clone(),
                    arguments: args.clone(),
                });
            }
        }
        let _ = channel.send(StreamEvent::Done);
        Ok(())
    }

    pub async fn chat_stream_with_tools(
        &self,
        messages: Vec<AgentMessage>,
        tools: Vec<ToolDefinition>,
        channel: &Channel<StreamEvent>,
    ) -> AppResult<()> {
        match self.api_type {
            ApiType::Openai => self.chat_stream_with_tools_openai(messages, tools, channel).await,
            // Anthropic doesn't support tool calling in this version — fall back to regular streaming
            ApiType::Anthropic => {
                let msgs: Vec<ChatMessage> = messages.into_iter().filter_map(|m| {
                    m.content.map(|c| ChatMessage { role: m.role, content: c })
                }).collect();
                self.chat_stream_anthropic(msgs, channel).await
            }
        }
    }
}
