pub mod context_builder;
pub mod entity_extract;
pub mod sql_validator;

pub use entity_extract::extract_entities;
pub use context_builder::build_sql_context;
pub use sql_validator::validate_sql;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlContext {
    pub relevant_tables: Vec<String>,
    pub join_paths: Vec<String>,
    pub metrics: Vec<String>,
    pub schema_ddl: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextToSqlResult {
    pub sql: String,
    pub context: SqlContext,
    pub validation_ok: bool,
    pub validation_warning: Option<String>,
}

pub async fn generate_sql_v2(
    question: &str,
    connection_id: i64,
    history: &[crate::llm::ChatMessage],
) -> crate::AppResult<TextToSqlResult> {
    // 1. LLM 提取实体（降级安全：失败时返回空）
    let entities = extract_entities(question, connection_id).await
        .unwrap_or_default();

    // 2. 组装上下文
    let context = build_sql_context(connection_id, &entities).await?;

    // 3. 构建高质量 Prompt
    let system_prompt = build_system_prompt(&context);

    // 4. 获取 LLM client
    let config_db = crate::db::get_default_llm_config()?
        .ok_or_else(|| crate::AppError::Other("No AI model configured".into()))?;
    let api_type = match config_db.api_type.as_str() {
        "anthropic" => crate::llm::ApiType::Anthropic,
        _ => crate::llm::ApiType::Openai,
    };
    let client = crate::llm::LlmClient::new(
        config_db.api_key,
        Some(config_db.base_url),
        Some(config_db.model),
        Some(api_type),
    );

    let mut messages = vec![
        crate::llm::ChatMessage { role: "system".into(), content: system_prompt }
    ];
    messages.extend_from_slice(history);
    messages.push(crate::llm::ChatMessage {
        role: "user".into(),
        content: question.to_string(),
    });

    let response = client.chat(messages).await?;

    // 5. 提取 SQL
    let sql = extract_sql_from_response(&response);

    // 6. 语法校验
    let conn_config = crate::db::get_connection_config(connection_id)?;
    let warning = validate_sql(&sql, &conn_config.driver).unwrap_or(None);

    Ok(TextToSqlResult {
        validation_ok: warning.is_none(),
        validation_warning: warning,
        sql,
        context,
    })
}

fn build_system_prompt(ctx: &SqlContext) -> String {
    let mut prompt = "你是一个 SQL 专家。根据用户问题生成精准的 SQL 查询。\n\n".to_string();
    if !ctx.schema_ddl.is_empty() {
        prompt.push_str("## 相关表结构\n");
        prompt.push_str(&ctx.schema_ddl);
        prompt.push('\n');
    }
    if !ctx.join_paths.is_empty() {
        prompt.push_str("## 推断的 JOIN 路径\n");
        for p in &ctx.join_paths { prompt.push_str(&format!("- {}\n", p)); }
        prompt.push('\n');
    }
    if !ctx.metrics.is_empty() {
        prompt.push_str("## 业务指标定义\n");
        for m in &ctx.metrics { prompt.push_str(&format!("- {}\n", m)); }
        prompt.push('\n');
    }
    prompt.push_str("只返回 SQL，不要解释。用 ```sql ``` 包裹。");
    prompt
}

fn extract_sql_from_response(response: &str) -> String {
    if let Some(s) = response.find("```sql") {
        if let Some(e) = response[s + 6..].find("```") {
            return response[s + 6..s + 6 + e].trim().to_string();
        }
    }
    if let Some(s) = response.find("```") {
        if let Some(e) = response[s + 3..].find("```") {
            return response[s + 3..s + 3 + e].trim().to_string();
        }
    }
    response.trim().to_string()
}
